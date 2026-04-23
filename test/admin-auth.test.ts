import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'kysely';
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_INACTIVITY_TIMEOUT_MS } from '../src/auth.js';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function getSetCookieLines(setCookieHeader: string | string[] | undefined): string[] {
  if (!setCookieHeader) return [];
  return Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
}

async function setupAdminAndLogin(app: any, db: any) {
  const setupRes = await app.inject({
    method: 'POST',
    url: '/admin/setup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: formEncode({ email: 'admin@example.com', displayName: 'Admin', password: 'correct-horse-battery-staple' })
  });
  expect(setupRes.statusCode).toBe(303);

  const loginRes = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: formEncode({ email: 'admin@example.com', password: 'correct-horse-battery-staple', role: 'admin' })
  });
  expect(loginRes.statusCode).toBe(303);

  const setCookies = getSetCookieLines(loginRes.headers['set-cookie'] as any);
  const sessionCookieLine = setCookies.find((line) => line.startsWith('vf_sess='));
  expect(sessionCookieLine).toBeTruthy();
  const sessionCookie = String(sessionCookieLine).split(';')[0];

  const user = await db.selectFrom('users').select(['id']).where('email', '=', 'admin@example.com').executeTakeFirstOrThrow();
  const session = await db
    .selectFrom('sessions')
    .select(['id', 'expires_at', 'data'])
    .where('user_id', '=', user.id)
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow();

  return { loginRes, setCookies, sessionCookie, sessionId: session.id, sessionRow: session };
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
    const { setCookies, sessionCookie } = await setupAdminAndLogin(app, db);
    const sessionCookieLine = setCookies.find((line) => line.startsWith('vf_sess=')) ?? '';
    expect(sessionCookieLine).toContain('SameSite=Strict');
    expect(sessionCookieLine).toContain(`Max-Age=${Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)}`);

    const dashRes = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: sessionCookie }
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
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', password: 'wrong-password', role: 'manager' })
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

  test('session expires after inactivity timeout', async () => {
    const { sessionCookie, sessionId } = await setupAdminAndLogin(app, db);
    const now = Date.now();
    const staleData = {
      created_at_ms: now - 60 * 60 * 1000,
      last_seen_at_ms: now - SESSION_INACTIVITY_TIMEOUT_MS - 60 * 1000
    };

    await db
      .updateTable('sessions')
      .set({
        data: sql`${JSON.stringify(staleData)}::jsonb`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString()
      })
      .where('id', '=', sessionId)
      .execute();

    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: { cookie: sessionCookie } });
    expect(res.statusCode).toBe(403);
  });

  test('session expires at absolute timeout even with recent activity', async () => {
    const { sessionCookie, sessionId } = await setupAdminAndLogin(app, db);
    const now = Date.now();
    const expiredData = {
      created_at_ms: now - SESSION_ABSOLUTE_TIMEOUT_MS - 60 * 1000,
      last_seen_at_ms: now
    };

    await db
      .updateTable('sessions')
      .set({
        data: sql`${JSON.stringify(expiredData)}::jsonb`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString()
      })
      .where('id', '=', sessionId)
      .execute();

    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: { cookie: sessionCookie } });
    expect(res.statusCode).toBe(403);
  });

  test('active sessions renew inactivity window without exceeding absolute timeout', async () => {
    const { sessionCookie, sessionId } = await setupAdminAndLogin(app, db);
    const now = Date.now();
    const startingData = {
      created_at_ms: now - 2 * 60 * 60 * 1000,
      last_seen_at_ms: now - 10 * 60 * 1000
    };
    const oldExpiresAt = new Date(now + 5 * 60 * 1000).toISOString();

    await db
      .updateTable('sessions')
      .set({
        data: sql`${JSON.stringify(startingData)}::jsonb`,
        expires_at: oldExpiresAt
      })
      .where('id', '=', sessionId)
      .execute();

    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: { cookie: sessionCookie } });
    expect(res.statusCode).toBe(200);

    const sessionAfter = await db
      .selectFrom('sessions')
      .select(['expires_at', 'data'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    const dataAfter = (sessionAfter.data ?? {}) as Record<string, unknown>;
    const renewedLastSeenMs = Number(dataAfter.last_seen_at_ms ?? 0);

    expect(Date.parse(sessionAfter.expires_at)).toBeGreaterThan(Date.parse(oldExpiresAt));
    expect(renewedLastSeenMs).toBeGreaterThan(startingData.last_seen_at_ms);
    expect(Date.parse(sessionAfter.expires_at)).toBeLessThanOrEqual(startingData.created_at_ms + SESSION_ABSOLUTE_TIMEOUT_MS);
  });

  test('legacy role-specific login routes are removed', async () => {
    const adminGet = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(adminGet.statusCode).toBe(404);

    const adminPost = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', password: 'x' })
    });
    expect(adminPost.statusCode).toBe(404);

    const managerGet = await app.inject({ method: 'GET', url: '/manager/login' });
    expect(managerGet.statusCode).toBe(404);

    const managerPost = await app.inject({
      method: 'POST',
      url: '/manager/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', password: 'x' })
    });
    expect(managerPost.statusCode).toBe(404);
  });
});
