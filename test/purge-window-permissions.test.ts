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

describe.skipIf(!DATABASE_URL)('purge window permissions', () => {
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

  test('manager can set pre-publish, cannot change post-publish, admin can override anytime', async () => {
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
    const adminCookie = cookieHeaderFromSetCookie(adminLogin.headers['set-cookie'] as any);
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
    const mgrCookie = cookieHeaderFromSetCookie(mgrLogin.headers['set-cookie'] as any);
    const managerCsrfToken = await fetchCsrfToken(app, '/manager/events/new', mgrCookie);

    const createRes = await app.inject({
      method: 'POST',
      url: '/manager/events/new',
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Purge Window Event',
        organizationId: orgRow.id,
        date: eventDate,
        description: 'Desc',
        locationName: 'Somewhere',
        locationMapUrl: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        purgeAfterDays: '14',
        csrfToken: managerCsrfToken
      })
    });

    expect(createRes.statusCode).toBe(303);
    const eventId = String(createRes.headers.location).split('/')[3];

    let row = await db.selectFrom('events').select(['purge_after_days']).where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(row.purge_after_days).toBe(14);

    const managerEditRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/edit`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Purge Window Event',
        organizationId: orgRow.id,
        isFeatured: '',
        tags: '',
        confirmationEmailNote: '',
        startDate: eventDate,
        endDate: eventDate,
        description: 'Desc',
        locationName: 'Somewhere',
        locationMapUrl: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        purgeAfterDays: '21',
        csrfToken: managerCsrfToken
      })
    });
    expect(managerEditRes.statusCode).toBe(303);

    row = await db.selectFrom('events').select(['purge_after_days']).where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(row.purge_after_days).toBe(21);

    const shiftRes = await app.inject({
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
    expect(shiftRes.statusCode).toBe(303);

    const publishRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/publish`,
      headers: { cookie: mgrCookie, 'x-csrf-token': managerCsrfToken }
    });
    expect(publishRes.statusCode).toBe(303);

    const managerEditAfterPublish = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/edit`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Purge Window Event',
        organizationId: orgRow.id,
        isFeatured: '',
        tags: '',
        confirmationEmailNote: '',
        startDate: eventDate,
        endDate: eventDate,
        description: 'Desc',
        locationName: 'Somewhere',
        locationMapUrl: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        purgeAfterDays: '30',
        csrfToken: managerCsrfToken
      })
    });

    expect(managerEditAfterPublish.statusCode).toBe(303);
    expect(String(managerEditAfterPublish.headers.location)).toContain('err=');

    row = await db.selectFrom('events').select(['purge_after_days']).where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(row.purge_after_days).toBe(21);

    const managerEditPage = await app.inject({ method: 'GET', url: `/manager/events/${eventId}/edit`, headers: { cookie: mgrCookie } });
    expect(managerEditPage.statusCode).toBe(200);
    expect(managerEditPage.body).toContain('Ask an admin to change the purge window');

    const adminPurgeCsrf = await fetchCsrfToken(app, `/admin/events/${eventId}/purge`, adminCookie);
    const adminUpdateRes = await app.inject({
      method: 'POST',
      url: `/admin/events/${eventId}/purge-window`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ purgeAfterDays: '30', csrfToken: adminPurgeCsrf })
    });

    expect(adminUpdateRes.statusCode).toBe(303);
    expect(String(adminUpdateRes.headers.location)).toContain('ok=');

    row = await db.selectFrom('events').select(['purge_after_days']).where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(row.purge_after_days).toBe(30);
  });
});
