import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe.skipIf(!DATABASE_URL)('manager CRUD', () => {
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

  test('manager can create event, add shift, and publish', async () => {
    // Create super admin via setup route
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

    // Create org
    const orgRes = await app.inject({
      method: 'POST',
      url: '/admin/organizations',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: 'Test Org', slug: 'test-org', primaryColor: '#4DD4AC', contactEmail: 'contact@example.com' })
    });
    expect(orgRes.statusCode).toBe(303);

    // Create manager user
    const mgrRes = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', displayName: 'Manager', password: 'correct-horse-battery-staple' })
    });
    expect(mgrRes.statusCode).toBe(303);

    const adminUser = await db.selectFrom('users').select(['id']).where('email', '=', 'admin@example.com').executeTakeFirstOrThrow();
    const managerUser = await db.selectFrom('users').select(['id']).where('email', '=', 'manager@example.com').executeTakeFirstOrThrow();
    const orgRow = await db.selectFrom('organizations').select(['id']).where('slug', '=', 'test-org').executeTakeFirstOrThrow();
    await db
      .insertInto('manager_organizations')
      .values({ manager_id: managerUser.id, organization_id: orgRow.id, assigned_by: adminUser.id })
      .execute();

    // Login manager
    const mgrLogin = await app.inject({
      method: 'POST',
      url: '/manager/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', password: 'correct-horse-battery-staple' })
    });
    expect(mgrLogin.statusCode).toBe(303);
    const mgrCookieHeader = mgrLogin.headers['set-cookie'];
    const mgrCookie = (Array.isArray(mgrCookieHeader) ? mgrCookieHeader[0] : String(mgrCookieHeader ?? '')).split(';')[0];

    const org = await db.selectFrom('organizations').select(['id']).where('slug', '=', 'test-org').executeTakeFirstOrThrow();

    // Create event
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
    expect(eventRes.statusCode).toBe(303);
    const loc = String(eventRes.headers.location);
    expect(loc).toMatch(/\/manager\/events\/.+\/edit/);
    const eventId = loc.split('/')[3];

    // Add shift
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
        maxVolunteers: '2'
      })
    });
    expect(shiftRes.statusCode).toBe(303);

    // Publish
    const pubRes = await app.inject({ method: 'POST', url: `/manager/events/${eventId}/publish`, headers: { cookie: mgrCookie } });
    expect(pubRes.statusCode).toBe(303);

    // Public listing shows it
    const publicList = await app.inject({ method: 'GET', url: '/' });
    expect(publicList.statusCode).toBe(200);
    expect(publicList.body).toContain('My Test Event');

    // Event is published
    const row = await db.selectFrom('events').select(['is_published']).where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(row.is_published).toBe(true);

    // Shift exists
    const count = await db
      .selectFrom('shifts')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    expect(Number(count?.c ?? 0)).toBe(1);
  });
});
