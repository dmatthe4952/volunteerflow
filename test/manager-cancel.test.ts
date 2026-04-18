import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe.skipIf(!DATABASE_URL)('manager cancel event', () => {
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
  let mgrCookie: string;
  let eventId: string;
  let shiftId: string;

  beforeEach(async () => {
    db = createDb();
    await resetDb(db);
    app = await buildApp({ db, runMigrations: false, logger: false });

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
    mgrCookie = (Array.isArray(mgrCookieHeader) ? mgrCookieHeader[0] : String(mgrCookieHeader ?? '')).split(';')[0];

    const org = await db.selectFrom('organizations').select(['id']).where('slug', '=', 'test-org').executeTakeFirstOrThrow();
    const eventRes = await app.inject({
      method: 'POST',
      url: '/manager/events/new',
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'My Test Event',
        organizationId: org.id,
        date: '2026-04-01',
        description: 'Hello',
        locationName: 'Somewhere',
        locationMapUrl: 'https://maps.example.com'
      })
    });
    eventId = String(eventRes.headers.location).split('/')[3];

    await app.inject({
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
        maxVolunteers: '2'
      })
    });

    const shift = await db.selectFrom('shifts').select(['id']).where('event_id', '=', eventId).executeTakeFirstOrThrow();
    shiftId = shift.id;

    await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/publish`,
      headers: { cookie: mgrCookie }
    });
  });

  test('manager cancels with message and blocks further signups', async () => {
    // Create a signup
    const signupRes = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/shifts/${shiftId}/signup`,
      payload: { firstName: 'Ada', lastName: 'L', email: 'ada@example.com' }
    });
    expect(signupRes.statusCode).toBe(303);

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/cancel`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ message: 'Weather cancellation.' })
    });
    expect(cancelRes.statusCode).toBe(303);

    const ev = await db
      .selectFrom('events')
      .select(['cancelled_at', 'cancellation_message'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(ev.cancelled_at).toBeTruthy();
    expect(ev.cancellation_message).toBe('Weather cancellation.');

    // Further signups blocked
    const signupRes2 = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/shifts/${shiftId}/signup`,
      payload: { firstName: 'Grace', lastName: 'H', email: 'grace@example.com' }
    });
    expect(signupRes2.statusCode).toBe(303);
    expect(String(signupRes2.headers.location)).toContain('err=');

    // Notification send audit row created once
    const sends = await db
      .selectFrom('notification_sends')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .executeTakeFirst();
    expect(Number(sends?.c ?? 0)).toBe(2);
  });
});
