import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb, seedBasicEvent } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('ops email', () => {
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
      ADMIN_TOKEN: 'test-ops-change-me',
      SMTP_HOST: '',
      SMTP_FROM_EMAIL: ''
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

  afterEach(async () => {
    await app?.close();
    await db?.destroy();
  });

  test('requires admin token and sends test email', async () => {
    await seedBasicEvent(db);

    const resForbidden = await app.inject({ method: 'POST', url: '/ops/email/test', payload: { to: 'volunteer@example.com' } });
    expect(resForbidden.statusCode).toBe(403);

    const resOk = await app.inject({
      method: 'POST',
      url: '/ops/email/test',
      headers: { 'x-admin-token': 'test-ops-change-me' },
      payload: { to: 'volunteer@example.com', subject: 'Test', text: 'Hello' }
    });
    expect(resOk.statusCode).toBe(200);
    expect(resOk.json()).toEqual({ ok: true });
  });
});
