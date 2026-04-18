import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function parseLocation(location: string) {
  const url = new URL(location, 'http://localhost');
  return { path: url.pathname, hash: url.hash, ok: url.searchParams.get('ok'), err: url.searchParams.get('err'), shift: url.searchParams.get('shift') };
}

describe.skipIf(!DATABASE_URL)('public concurrency', () => {
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

  test('two concurrent signups for last slot: one succeeds, one sees friendly full message', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', displayName: 'Admin', password: 'correct-horse-battery-staple' })
    });

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', password: 'correct-horse-battery-staple' })
    });
    const adminCookieHeader = adminLogin.headers['set-cookie'];
    const adminCookie = (Array.isArray(adminCookieHeader) ? adminCookieHeader[0] : String(adminCookieHeader ?? '')).split(';')[0];

    await app.inject({
      method: 'POST',
      url: '/admin/organizations',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: 'Test Org', slug: 'test-org', primaryColor: '#4DD4AC', contactEmail: 'contact@example.com' })
    });

    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', displayName: 'Manager', password: 'correct-horse-battery-staple' })
    });

    const adminUser = await db.selectFrom('users').select(['id']).where('email', '=', 'admin@example.com').executeTakeFirstOrThrow();
    const managerUser = await db.selectFrom('users').select(['id']).where('email', '=', 'manager@example.com').executeTakeFirstOrThrow();
    const orgRow = await db.selectFrom('organizations').select(['id']).where('slug', '=', 'test-org').executeTakeFirstOrThrow();
    await db
      .insertInto('manager_organizations')
      .values({ manager_id: managerUser.id, organization_id: orgRow.id, assigned_by: adminUser.id })
      .execute();

    const mgrLogin = await app.inject({
      method: 'POST',
      url: '/manager/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', password: 'correct-horse-battery-staple' })
    });
    const mgrCookieHeader = mgrLogin.headers['set-cookie'];
    const mgrCookie = (Array.isArray(mgrCookieHeader) ? mgrCookieHeader[0] : String(mgrCookieHeader ?? '')).split(';')[0];

    const org = await db.selectFrom('organizations').select(['id']).where('slug', '=', 'test-org').executeTakeFirstOrThrow();

    const eventRes = await app.inject({
      method: 'POST',
      url: '/manager/events/new',
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Concurrency Event',
        organizationId: org.id,
        date: '2026-04-01',
        description: '',
        locationName: '',
        locationMapUrl: ''
      })
    });
    expect(eventRes.statusCode).toBe(303);
    const eventId = String(eventRes.headers.location).split('/')[3];

    const shiftRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/shifts`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        roleName: 'Packing',
        shiftDate: '2026-04-01',
        roleDescription: '',
        startTime: '10:00',
        durationMinutes: '60',
        minVolunteers: '0',
        maxVolunteers: '1'
      })
    });
    expect(shiftRes.statusCode).toBe(303);

    const pubRes = await app.inject({ method: 'POST', url: `/manager/events/${eventId}/publish`, headers: { cookie: mgrCookie } });
    expect(pubRes.statusCode).toBe(303);

    const eventRow = await db.selectFrom('events').select(['slug']).where('id', '=', eventId).executeTakeFirstOrThrow();
    const slugOrId = eventRow.slug ?? eventId;
    const shiftRow = await db.selectFrom('shifts').select(['id']).where('event_id', '=', eventId).executeTakeFirstOrThrow();

    const signupUrl = `/events/${encodeURIComponent(slugOrId)}/shifts/${encodeURIComponent(shiftRow.id)}/signup`;

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: signupUrl,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: formEncode({ firstName: 'Alice', lastName: 'O', email: 'alice@example.com' })
      }),
      app.inject({
        method: 'POST',
        url: signupUrl,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: formEncode({ firstName: 'Bob', lastName: 'T', email: 'bob@example.com' })
      })
    ]);

    expect(a.statusCode).toBe(303);
    expect(b.statusCode).toBe(303);

    const locA = parseLocation(String(a.headers.location));
    const locB = parseLocation(String(b.headers.location));

    const okCount = [locA, locB].filter((l) => l.ok === 'signup').length;
    expect(okCount).toBe(1);

    const errLoc = [locA, locB].find((l) => l.err);
    expect(errLoc?.err).toBe('That shift just filled up. Please choose another shift.');
    expect(errLoc?.shift).toBe(shiftRow.id);
    expect(errLoc?.hash).toBe(`#shift-${shiftRow.id}`);

    const activeCount = await db
      .selectFrom('signups')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('shift_id', '=', shiftRow.id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    expect(Number(activeCount?.c ?? 0)).toBe(1);
  });
});
