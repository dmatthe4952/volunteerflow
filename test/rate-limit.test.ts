import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe.skipIf(!DATABASE_URL)('route-specific unauthenticated rate limits', () => {
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

  test('POST /add-event is limited to 5/hour/IP', async () => {
    const payload = formEncode({
      title: 'Community Cleanup',
      date: '2026-05-01',
      time: '10:00',
      description: 'Help clean up the park',
      organization: 'Neighborhood Org',
      organizer: 'Alex'
    });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/add-event',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '198.51.100.40'
        },
        payload
      });
      statuses.push(res.statusCode);
    }

    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  test('POST /my/request is limited to 5/hour/IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/my/request',
        headers: {
          'x-forwarded-for': '198.51.100.41'
        },
        payload: { email: 'ada@example.com' }
      });
      statuses.push(res.statusCode);
    }

    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  test('POST /login is limited to 10 attempts per 15 minutes per IP', async () => {
    const payload = formEncode({ email: 'nope@example.com', password: 'wrong-password', role: 'admin' });
    const statuses: number[] = [];

    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '198.51.100.42'
        },
        payload
      });
      statuses.push(res.statusCode);
    }

    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
