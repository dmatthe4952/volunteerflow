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

describe.skipIf(!DATABASE_URL)('admin hard delete event', () => {
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

  test('admin can delete archived+unpublished event and cascades shifts', async () => {
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
      url: '/manager/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', password: 'correct-horse-battery-staple' })
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
        title: 'Delete Me',
        organizationId: org.id,
        date: '2026-04-01',
        description: '',
        locationName: '',
        locationMapUrl: '',
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
        shiftDate: '2026-04-01',
        roleDescription: '',
        startTime: '10:00',
        durationMinutes: '60',
        minVolunteers: '0',
        maxVolunteers: '2',
        csrfToken: managerCsrfToken
      })
    });

    // Not eligible yet
    const deleteAttempt1 = await app.inject({
      method: 'POST',
      url: `/admin/events/${eventId}/delete`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ confirmText: `DELETE ${eventId}`, acknowledge: 'yes', csrfToken: adminCsrfToken })
    });
    expect(deleteAttempt1.statusCode).toBe(303);
    expect(String(deleteAttempt1.headers.location)).toContain('/delete?err=');

    // Archive via manager (also unpublishes)
    const archiveRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/archive`,
      headers: { cookie: mgrCookie, 'x-csrf-token': managerCsrfToken }
    });
    expect(archiveRes.statusCode).toBe(303);

    const deleteConfirm = await app.inject({ method: 'GET', url: `/admin/events/${eventId}/delete`, headers: { cookie: adminCookie } });
    expect(deleteConfirm.statusCode).toBe(200);
    expect(deleteConfirm.body).toContain(`DELETE ${eventId}`);

    const deleteRes = await app.inject({
      method: 'POST',
      url: `/admin/events/${eventId}/delete`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ confirmText: `DELETE ${eventId}`, acknowledge: 'yes', csrfToken: adminCsrfToken })
    });
    expect(deleteRes.statusCode).toBe(303);
    expect(String(deleteRes.headers.location)).toContain('/admin/events?ok=');

    const ev = await db.selectFrom('events').select(['id']).where('id', '=', eventId).executeTakeFirst();
    expect(ev).toBeUndefined();

    const shiftCount = await db
      .selectFrom('shifts')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    expect(Number(shiftCount?.c ?? 0)).toBe(0);
  });
});
