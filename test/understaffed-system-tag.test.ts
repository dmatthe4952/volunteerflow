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

describe.skipIf(!DATABASE_URL)('understaffed system tag lifecycle', () => {
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

  test('auto applies/removes Understaffed based on upcoming active shift capacity', async () => {
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
    const adminCsrf = await fetchCsrfToken(app, '/admin/organizations', adminCookie);

    await app.inject({
      method: 'POST',
      url: '/admin/organizations',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        name: 'Test Org',
        slug: 'test-org',
        primaryColor: '#4DD4AC',
        contactEmail: 'contact@example.com',
        csrfToken: adminCsrf
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
        csrfToken: adminCsrf
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
    const mgrCsrf = await fetchCsrfToken(app, '/manager/events/new', mgrCookie);

    const eventRes = await app.inject({
      method: 'POST',
      url: '/manager/events/new',
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Understaffed Event',
        organizationId: orgRow.id,
        date: eventDate,
        description: 'Desc',
        locationName: 'Somewhere',
        locationMapUrl: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        csrfToken: mgrCsrf
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
        shiftDate: eventDate,
        roleDescription: '',
        startTime: '10:00',
        durationMinutes: '60',
        minVolunteers: '2',
        maxVolunteers: '2',
        csrfToken: mgrCsrf
      })
    });
    expect(shiftRes.statusCode).toBe(303);

    const countUnderstaffedTag = async () => {
      const row = await db
        .selectFrom('event_tags')
        .innerJoin('tags', 'tags.id', 'event_tags.tag_id')
        .select((eb: any) => eb.fn.countAll<number>().as('c'))
        .where('event_tags.event_id', '=', eventId)
        .where('tags.slug', '=', 'understaffed')
        .executeTakeFirst();
      return Number(row?.c ?? 0);
    };

    const understaffedTag = await db.selectFrom('tags').select(['is_system']).where('slug', '=', 'understaffed').executeTakeFirstOrThrow();
    expect(understaffedTag.is_system).toBe(true);
    expect(await countUnderstaffedTag()).toBe(1);

    const archiveRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/archive`,
      headers: { cookie: mgrCookie, 'x-csrf-token': mgrCsrf }
    });
    expect(archiveRes.statusCode).toBe(303);
    expect(await countUnderstaffedTag()).toBe(0);

    const unarchiveRes = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/unarchive`,
      headers: { cookie: mgrCookie, 'x-csrf-token': mgrCsrf }
    });
    expect(unarchiveRes.statusCode).toBe(303);
    expect(await countUnderstaffedTag()).toBe(1);

    const shift = await db.selectFrom('shifts').select(['id']).where('event_id', '=', eventId).executeTakeFirstOrThrow();

    const add1 = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/signups/add`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        shiftId: shift.id,
        firstName: 'Ada',
        lastName: 'L',
        email: 'ada@example.com',
        csrfToken: mgrCsrf
      })
    });
    expect(add1.statusCode).toBe(303);
    expect(await countUnderstaffedTag()).toBe(1);

    const add2 = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/signups/add`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        shiftId: shift.id,
        firstName: 'Linus',
        lastName: 'T',
        email: 'linus@example.com',
        csrfToken: mgrCsrf
      })
    });
    expect(add2.statusCode).toBe(303);
    expect(await countUnderstaffedTag()).toBe(0);

    const signup = await db
      .selectFrom('signups')
      .select(['id'])
      .where('shift_id', '=', shift.id)
      .where('email', '=', 'ada@example.com')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();

    const cancelOne = await app.inject({
      method: 'POST',
      url: `/manager/signups/${signup.id}/cancel`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ eventId, csrfToken: mgrCsrf })
    });
    expect(cancelOne.statusCode).toBe(303);
    expect(await countUnderstaffedTag()).toBe(1);

    const toggleShift = await app.inject({
      method: 'POST',
      url: `/manager/shifts/${shift.id}/toggle`,
      headers: { cookie: mgrCookie, 'x-csrf-token': mgrCsrf }
    });
    expect(toggleShift.statusCode).toBe(303);
    expect(await countUnderstaffedTag()).toBe(0);
  });
});
