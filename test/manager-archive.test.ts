import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe.skipIf(!DATABASE_URL)('manager archive', () => {
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

  test('manager can archive and unarchive events', async () => {
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
        title: 'Archived Event',
        organizationId: org.id,
        date: '2026-04-01',
        description: 'Hello',
        locationName: 'Somewhere',
        locationMapUrl: 'https://maps.example.com'
      })
    });
    expect(eventRes.statusCode).toBe(303);
    const eventId = String(eventRes.headers.location).split('/')[3];

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

    const pubRes = await app.inject({ method: 'POST', url: `/manager/events/${eventId}/publish`, headers: { cookie: mgrCookie } });
    expect(pubRes.statusCode).toBe(303);

    const publicList1 = await app.inject({ method: 'GET', url: '/' });
    expect(publicList1.statusCode).toBe(200);
    expect(publicList1.body).toContain('Archived Event');

    const archiveRes = await app.inject({ method: 'POST', url: `/manager/events/${eventId}/archive`, headers: { cookie: mgrCookie } });
    expect(archiveRes.statusCode).toBe(303);

    const row = await db
      .selectFrom('events')
      .select(['is_archived', 'is_published'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(row.is_archived).toBe(true);
    expect(row.is_published).toBe(false);

    const publicList2 = await app.inject({ method: 'GET', url: '/' });
    expect(publicList2.statusCode).toBe(200);
    expect(publicList2.body).not.toContain('Archived Event');

    const dashboard = await app.inject({ method: 'GET', url: '/manager/dashboard', headers: { cookie: mgrCookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).not.toContain('Archived Event');

    const publishWhileArchived = await app.inject({ method: 'POST', url: `/manager/events/${eventId}/publish`, headers: { cookie: mgrCookie } });
    expect(publishWhileArchived.statusCode).toBe(303);
    expect(String(publishWhileArchived.headers.location)).toContain('err=');

    const eventsPageArchived = await app.inject({ method: 'GET', url: '/manager/events', headers: { cookie: mgrCookie } });
    expect(eventsPageArchived.statusCode).toBe(200);
    expect(eventsPageArchived.body).toContain('Archived');
    expect(eventsPageArchived.body).toContain('Archived Event');

    const unarchiveRes = await app.inject({ method: 'POST', url: `/manager/events/${eventId}/unarchive`, headers: { cookie: mgrCookie } });
    expect(unarchiveRes.statusCode).toBe(303);

    const eventsPageUnarchived = await app.inject({ method: 'GET', url: '/manager/events', headers: { cookie: mgrCookie } });
    expect(eventsPageUnarchived.statusCode).toBe(200);
    expect(eventsPageUnarchived.body).toContain('Archived Event');
  });
});
