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

describe.skipIf(!DATABASE_URL)('admin reminder rules', () => {
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

  test('admin can create/update/delete reminder rules for any event', async () => {
    const eventDate = ymdOffset(12);
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

    const event = await db
      .insertInto('events')
      .values({
        organization_id: orgRow.id,
        manager_id: managerUser.id,
        slug: 'admin-reminder-rules-event',
        title: 'Admin Reminder Rules Event',
        category: 'normal',
        description_html: '<p>Hello</p>',
        location_name: 'Somewhere',
        location_map_url: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        location_lat: '34.852600',
        location_lng: '-82.394000',
        event_type: 'one_time',
        start_date: eventDate,
        end_date: eventDate,
        is_published: false,
        is_archived: false
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const adminEventsCsrf = adminCsrfToken;

    for (const h of [24, 8, 2]) {
      const addRule = await app.inject({
        method: 'POST',
        url: `/admin/events/${event.id}/reminders`,
        headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: formEncode({
          sendOffsetHours: String(h),
          subjectTemplate: `Admin Reminder ${h}h`,
          bodyTemplate: `Admin Body ${h}`,
          isActive: 'on',
          csrfToken: adminEventsCsrf
        })
      });
      expect(addRule.statusCode).toBe(303);
    }

    const count3 = await db
      .selectFrom('reminder_rules')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', event.id)
      .executeTakeFirst();
    expect(Number(count3?.c ?? 0)).toBe(3);

    const add4 = await app.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/reminders`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        sendOffsetHours: '1',
        subjectTemplate: 'Admin Reminder 1h',
        bodyTemplate: 'Admin Body 1',
        isActive: 'on',
        csrfToken: adminEventsCsrf
      })
    });
    expect(add4.statusCode).toBe(303);
    expect(String(add4.headers.location)).toContain('err=');

    const rules = await db
      .selectFrom('reminder_rules')
      .select(['id', 'send_offset_hours'])
      .where('event_id', '=', event.id)
      .orderBy('send_offset_hours', 'asc')
      .execute();
    const rule = rules[0];

    const updateRule = await app.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/reminders/${rule.id}/update`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        sendOffsetHours: '12',
        subjectTemplate: 'Admin Updated Subject',
        bodyTemplate: 'Admin Updated Body',
        csrfToken: adminEventsCsrf
      })
    });
    expect(updateRule.statusCode).toBe(303);

    const updated = await db
      .selectFrom('reminder_rules')
      .select(['send_offset_hours', 'subject_template', 'body_template', 'is_active'])
      .where('id', '=', rule.id)
      .executeTakeFirstOrThrow();
    expect(updated.send_offset_hours).toBe(12);
    expect(updated.subject_template).toBe('Admin Updated Subject');
    expect(updated.body_template).toBe('Admin Updated Body');
    expect(updated.is_active).toBe(false);

    const deleteRule = await app.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/reminders/${rule.id}/delete`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ csrfToken: adminEventsCsrf })
    });
    expect(deleteRule.statusCode).toBe(303);

    const count2 = await db
      .selectFrom('reminder_rules')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', event.id)
      .executeTakeFirst();
    expect(Number(count2?.c ?? 0)).toBe(2);
  });
});
