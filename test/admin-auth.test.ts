import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe.skipIf(!DATABASE_URL)('admin auth', () => {
  let createDb: any;
  let buildApp: any;
  let runMigrations: any;

  beforeAll(async () => {
    ({ createDb, buildApp, runMigrations } = await loadAppForTest({
      APP_ENV: 'test',
      APP_PORT: '3000',
      APP_URL: 'http://localhost:3000',
      APP_TIMEZONE: 'America/New_York',
      DATABASE_URL: DATABASE_URL!,
      SESSION_SECRET: 'test-only-change-me',
      ADMIN_TOKEN: 'test-ops-change-me'
    }));

    await runMigrations({
      databaseUrl: DATABASE_URL!,
      migrationsDir: migrationsDirFromRepoRoot()
    });
  });

  let db: any;
  let app: any;

  beforeEach(async () => {
    db = createDb();
    await resetDb(db);
    app = await buildApp({ db, runMigrations: false, logger: false });
  });

  test('setup then login allows access to admin dashboard', async () => {
    const setupRes = await app.inject({
      method: 'POST',
      url: '/admin/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', displayName: 'Admin', password: 'correct-horse-battery-staple' })
    });
    expect(setupRes.statusCode).toBe(303);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', password: 'correct-horse-battery-staple' })
    });
    expect(loginRes.statusCode).toBe(303);
    const setCookieHeader = loginRes.headers['set-cookie'];
    const setCookie = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader ?? '');
    expect(setCookie).toContain('vf_sess=');

    const dashRes = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: setCookie.split(';')[0] }
    });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.body).toContain('Admin Dashboard');
    expect(dashRes.body).toContain('Recent login audit');

    const loginAuditRows = await db
      .selectFrom('login_audit')
      .select(['email', 'attempted_role', 'user_id', 'success'])
      .orderBy('created_at', 'desc')
      .execute();
    expect(loginAuditRows).toHaveLength(1);
    expect(loginAuditRows[0]?.email).toBe('admin@example.com');
    expect(loginAuditRows[0]?.attempted_role).toBe('super_admin');
    expect(loginAuditRows[0]?.success).toBe(true);
  });

  test('failed login attempts are audited', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', displayName: 'Admin', password: 'correct-horse-battery-staple' })
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/manager/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', password: 'wrong-password' })
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body).toContain('Invalid email or password.');

    const loginAuditRows = await db
      .selectFrom('login_audit')
      .select(['email', 'attempted_role', 'user_id', 'success'])
      .orderBy('created_at', 'desc')
      .execute();
    expect(loginAuditRows).toHaveLength(1);
    expect(loginAuditRows[0]?.email).toBe('admin@example.com');
    expect(loginAuditRows[0]?.attempted_role).toBe('event_manager');
    expect(loginAuditRows[0]?.user_id).toBeNull();
    expect(loginAuditRows[0]?.success).toBe(false);
  });
});
