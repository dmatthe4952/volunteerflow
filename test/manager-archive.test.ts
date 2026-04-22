import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';
import { cookieHeaderFromSetCookie, fetchCsrfToken } from './helpers/csrf.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function ymdOffset(days: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
    const eventDate = ymdOffset(7);
    await app.inject({
      method: 'POST',
      url: '/admin/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', displayName: 'Admin', password: 'correct-horse-battery-staple' })
    });

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'admin@example.com', password: 'correct-horse-battery-staple', role: 'admin' })
    });
    const adminCookieHeader = adminLogin.headers['set-cookie'];
    const adminCookie = cookieHeaderFromSetCookie(adminCookieHeader as any);
    const adminCsrfToken = await fetchCsrfToken(app, '/admin/organizations', adminCookie);

    await app.inject({
      method: 'POST',
      url: '/admin/organizations',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        name: 'Test Org',
        slug: 'test-org',
        primaryColor: '#4DD4AC',
        contactEmail: 'contact@example.com',
        csrfToken: adminCsrfToken
      })
    });

    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        email: 'manager@example.com',
        displayName: 'Manager',
        password: 'correct-horse-battery-staple',
        csrfToken: adminCsrfToken
      })
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
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', password: 'correct-horse-battery-staple', role: 'manager' })
    });
    const mgrCookieHeader = mgrLogin.headers['set-cookie'];
    const mgrCookie = cookieHeaderFromSetCookie(mgrCookieHeader as any);
    const managerCsrfToken = await fetchCsrfToken(app, '/manager/events/new', mgrCookie);

    const org = await db.selectFrom('organizations').select(['id']).where('slug', '=', 'test-org').executeTakeFirstOrThrow();

    const eventRes = await app.inject({
      method: 'POST',
      url: '/manager/events/new',
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Archived Event',
        organizationId: org.id,
        date: eventDate,
        description: 'Hello',
        locationName: 'Somewhere',
        locationMapUrl: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        csrfToken: managerCsrfToken
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
        shiftDate: eventDate,
        roleDescription: '',
        startTime: '10:00',
        durationMinutes: '60',
        minVolunteers: '0',
        maxVolunteers: '2',
        csrfToken: managerCsrfToken
      })
    });

    const pubRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/publish`,
      headers: { cookie: mgrCookie, 'x-csrf-token': managerCsrfToken }
    });
    expect(pubRes.statusCode).toBe(303);

    const publicList1 = await app.inject({ method: 'GET', url: '/' });
    expect(publicList1.statusCode).toBe(200);
    expect(publicList1.body).toContain('Archived Event');

    const archiveRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/archive`,
      headers: { cookie: mgrCookie, 'x-csrf-token': managerCsrfToken }
    });
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

    const dashboard = await app.inject({ method: 'GET', url: '/manager/events/new', headers: { cookie: mgrCookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).not.toContain('Archived Event');

    const publishWhileArchived = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/publish`,
      headers: { cookie: mgrCookie, 'x-csrf-token': managerCsrfToken }
    });
    expect(publishWhileArchived.statusCode).toBe(303);
    expect(String(publishWhileArchived.headers.location)).toContain('err=');

    const eventsPageArchived = await app.inject({ method: 'GET', url: '/manager/events', headers: { cookie: mgrCookie } });
    expect(eventsPageArchived.statusCode).toBe(200);
    expect(eventsPageArchived.body).toContain('Archived');
    expect(eventsPageArchived.body).toContain('Archived Event');

    const unarchiveRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/unarchive`,
      headers: { cookie: mgrCookie, 'x-csrf-token': managerCsrfToken }
    });
    expect(unarchiveRes.statusCode).toBe(303);

    const eventsPageUnarchived = await app.inject({ method: 'GET', url: '/manager/events', headers: { cookie: mgrCookie } });
    expect(eventsPageUnarchived.statusCode).toBe(200);
    expect(eventsPageUnarchived.body).toContain('Archived Event');
  });
});
