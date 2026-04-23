import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb, seedBasicEvent } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('public volunteer flows', () => {
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

  test('signup persists and shows cancel link for viewer email cookie', async () => {
    const { eventSlug, shiftId } = await seedBasicEvent(db);

    const resSignup = await app.inject({
      method: 'POST',
      url: `/events/${eventSlug}/shifts/${shiftId}/signup`,
      payload: { firstName: 'Ada', lastName: 'L', email: 'ada@example.com' }
    });
    expect(resSignup.statusCode).toBe(303);
    const setCookieHeader = resSignup.headers['set-cookie'];
    const setCookie = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader ?? '');
    expect(setCookie).toContain('vf_email=');

    const resEvent = await app.inject({
      method: 'GET',
      url: `/events/${eventSlug}`,
      headers: { cookie: setCookie.split(';')[0] }
    });
    expect(resEvent.statusCode).toBe(200);
    expect(resEvent.body.toLowerCase()).toContain('signed up');
    expect(resEvent.body).toMatch(/\/cancel\/[a-f0-9]{64}/);

    const sends = await db
      .selectFrom('notification_sends')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('kind', '=', 'signup_confirmation')
      .executeTakeFirst();
    expect(Number(sends?.c ?? 0)).toBe(1);
  });

  test('my-signups token is one-time (second use fails)', async () => {
    const { eventSlug, shiftId } = await seedBasicEvent(db);
    await app.inject({
      method: 'POST',
      url: `/events/${eventSlug}/shifts/${shiftId}/signup`,
      payload: { firstName: 'Ada', lastName: 'L', email: 'ada@example.com' }
    });

    const resReq = await app.inject({
      method: 'POST',
      url: '/my/request',
      payload: { email: 'ada@example.com' }
    });
    expect(resReq.statusCode).toBe(200);

    const match = resReq.body.match(/\/my\/verify\/([a-f0-9]{64})\?remember=0/);
    expect(match?.[1]).toBeTruthy();
    const token = match![1];

    const resView1 = await app.inject({ method: 'GET', url: `/my/verify/${token}?remember=0` });
    expect(resView1.statusCode).toBe(200);
    expect(resView1.body).toContain('My Signups (One-Time)');
    expect(resView1.body).toContain('Packing');

    const resView2 = await app.inject({ method: 'GET', url: `/my/verify/${token}?remember=0` });
    expect(resView2.statusCode).toBe(410);
  });

  test('my-signups token expiry is one hour from issuance', async () => {
    const reqTime = Date.now();
    const resReq = await app.inject({
      method: 'POST',
      url: '/my/request',
      payload: { email: 'ada@example.com' }
    });
    expect(resReq.statusCode).toBe(200);

    const row = await db
      .selectFrom('volunteer_email_tokens')
      .select(['expires_at', 'created_at'])
      .where('email', '=', 'ada@example.com')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    const expiresAtMs = Date.parse(String(row.expires_at));
    const createdAtMs = Date.parse(String(row.created_at));
    expect(expiresAtMs - createdAtMs).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(expiresAtMs - createdAtMs).toBeLessThanOrEqual(61 * 60 * 1000);
    expect(expiresAtMs).toBeGreaterThan(reqTime + 59 * 60 * 1000);
  });

  test('clearing device removes cookie but user can paste link and view (no re-signup needed)', async () => {
    const { eventSlug, shiftId } = await seedBasicEvent(db);
    const resSignup = await app.inject({
      method: 'POST',
      url: `/events/${eventSlug}/shifts/${shiftId}/signup`,
      payload: { firstName: 'Ada', lastName: 'L', email: 'ada@example.com' }
    });
    const setCookieHeader = resSignup.headers['set-cookie'];
    const setCookie = (Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader ?? '')).split(';')[0];

    const resClear = await app.inject({ method: 'POST', url: '/my/clear', headers: { cookie: setCookie } });
    expect(resClear.statusCode).toBe(303);

    const resReq = await app.inject({ method: 'POST', url: '/my/request', payload: { email: 'ada@example.com' } });
    const match = resReq.body.match(/\/my\/verify\/([a-f0-9]{64})\?remember=0/);
    const token = match![1];

    const resPaste = await app.inject({
      method: 'POST',
      url: '/my/verify',
      payload: { token: `http://localhost:3000/my/verify/${token}?remember=0` }
    });
    expect(resPaste.statusCode).toBe(303);
    expect(resPaste.headers.location).toContain(`/my/verify/${token}`);
  });
});
