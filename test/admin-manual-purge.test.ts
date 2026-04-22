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

describe.skipIf(!DATABASE_URL)('admin manual purge', () => {
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

  test('admin can manually purge an event with safeguards', async () => {
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

    const eventDate = ymdOffset(-5);
    const event = await db
      .insertInto('events')
      .values({
        organization_id: orgRow.id,
        manager_id: managerUser.id,
        slug: 'purge-me',
        title: 'Purge Me',
        category: 'normal',
        event_type: 'one_time',
        start_date: eventDate,
        end_date: eventDate,
        is_published: true,
        is_archived: false
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const shift = await db
      .insertInto('shifts')
      .values({
        event_id: event.id,
        role_name: 'Role',
        role_description: null,
        duration_minutes: 60,
        shift_date: eventDate,
        start_time: '10:00:00',
        end_time: '11:00:00',
        min_volunteers: 0,
        max_volunteers: 2,
        is_active: true
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const signup = await db
      .insertInto('signups')
      .values({
        shift_id: shift.id,
        first_name: 'Ada',
        last_name: 'L',
        email: 'ada@example.com',
        status: 'active',
        cancel_token: 'a'.repeat(64),
        cancel_token_hmac: Buffer.from('abc'),
        cancel_token_expires_at: new Date(Date.now() + 86400000).toISOString()
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('notification_sends')
      .values([
        {
          kind: 'signup_confirmation',
          event_id: event.id,
          signup_id: signup.id,
          to_email: 'ada@example.com',
          subject: 'Subject',
          body: 'Body',
          status: 'queued'
        },
        {
          kind: 'manager_broadcast_shift',
          event_id: event.id,
          signup_id: null,
          to_email: 'all@example.com',
          subject: 'Broadcast',
          body: 'Broadcast body',
          status: 'queued'
        }
      ])
      .execute();

    const purgeCsrfToken = await fetchCsrfToken(app, `/admin/events/${event.id}/purge`, adminCookie);

    const bad = await app.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/purge`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        confirmText: 'wrong',
        acknowledge: 'yes',
        csrfToken: purgeCsrfToken
      })
    });
    expect(bad.statusCode).toBe(303);
    expect(String(bad.headers.location)).toContain('err=');

    const ok = await app.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/purge`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        confirmText: `PURGE ${event.id}`,
        acknowledge: 'yes',
        csrfToken: purgeCsrfToken
      })
    });
    expect(ok.statusCode).toBe(303);
    expect(String(ok.headers.location)).toContain('ok=');

    const signupCount = await db
      .selectFrom('signups')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('shift_id', '=', shift.id)
      .executeTakeFirst();
    expect(Number(signupCount?.c ?? 0)).toBe(0);

    const sendCount = await db
      .selectFrom('notification_sends')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', event.id)
      .executeTakeFirst();
    expect(Number(sendCount?.c ?? 0)).toBe(0);

    const row = await db.selectFrom('events').select(['purged_at']).where('id', '=', event.id).executeTakeFirstOrThrow();
    expect(row.purged_at).toBeTruthy();
  });
});
