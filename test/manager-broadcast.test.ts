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

describe.skipIf(!DATABASE_URL)('manager broadcast', () => {
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

  test('manager broadcasts to event or single shift active signups', async () => {
    const eventDate = ymdOffset(6);
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

    const org = await db.selectFrom('organizations').select(['id']).where('slug', '=', 'test-org').executeTakeFirstOrThrow();
    const eventRes = await app.inject({
      method: 'POST',
      url: '/manager/events/new',
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Broadcast Event',
        organizationId: org.id,
        date: eventDate,
        description: 'Hello',
        locationName: 'Somewhere',
        locationMapUrl: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        csrfToken: managerCsrfToken
      })
    });
    const eventId = String(eventRes.headers.location).split('/')[3];

    await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/shifts`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        roleName: 'Shift A',
        shiftDate: eventDate,
        roleDescription: '',
        startTime: '10:00',
        durationMinutes: '60',
        minVolunteers: '0',
        maxVolunteers: '5',
        csrfToken: managerCsrfToken
      })
    });
    await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/shifts`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        roleName: 'Shift B',
        shiftDate: eventDate,
        roleDescription: '',
        startTime: '12:00',
        durationMinutes: '60',
        minVolunteers: '0',
        maxVolunteers: '5',
        csrfToken: managerCsrfToken
      })
    });

    const shifts = await db.selectFrom('shifts').select(['id', 'role_name']).where('event_id', '=', eventId).orderBy('start_time', 'asc').execute();
    const shiftA = shifts[0];
    const shiftB = shifts[1];

    await db
      .insertInto('signups')
      .values([
        {
          shift_id: shiftA.id,
          first_name: 'Ada',
          last_name: 'L',
          email: 'ada@example.com',
          status: 'active',
          cancel_token: 'a'.repeat(64),
          cancel_token_hmac: Buffer.from('abc'),
          cancel_token_expires_at: new Date(Date.now() + 86400000).toISOString()
        },
        {
          shift_id: shiftA.id,
          first_name: 'Grace',
          last_name: 'H',
          email: 'grace@example.com',
          status: 'cancelled',
          cancel_token: 'b'.repeat(64),
          cancel_token_hmac: Buffer.from('abc'),
          cancel_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
          cancelled_at: new Date().toISOString()
        },
        {
          shift_id: shiftB.id,
          first_name: 'Linus',
          last_name: 'T',
          email: 'linus@example.com',
          status: 'active',
          cancel_token: 'c'.repeat(64),
          cancel_token_hmac: Buffer.from('abc'),
          cancel_token_expires_at: new Date(Date.now() + 86400000).toISOString()
        }
      ])
      .execute();

    const eventWide = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/broadcast`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        subject: 'Weather update',
        message: 'Bring a poncho.',
        csrfToken: managerCsrfToken
      })
    });
    expect(eventWide.statusCode).toBe(303);

    const sends1 = await db
      .selectFrom('notification_sends')
      .select(['to_email', 'subject', 'body', 'kind'])
      .where('subject', '=', 'Weather update')
      .orderBy('to_email', 'asc')
      .execute();
    expect(sends1.length).toBe(2);
    expect(sends1.map((s: any) => s.to_email)).toEqual(['ada@example.com', 'linus@example.com']);
    for (const s of sends1 as any[]) {
      expect(String(s.kind)).toContain('broadcast_manual_');
      expect(String(s.body)).toContain('Bring a poncho.');
      expect(String(s.body)).toContain('Need to cancel? http://localhost:3000/cancel/');
    }

    const shiftOnly = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/broadcast`,
      headers: { cookie: mgrCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        shiftId: shiftA.id,
        subject: 'Shift A note',
        message: 'Shift A starts on time.',
        csrfToken: managerCsrfToken
      })
    });
    expect(shiftOnly.statusCode).toBe(303);

    const sends2 = await db
      .selectFrom('notification_sends')
      .select(['to_email', 'subject'])
      .where('subject', '=', 'Shift A note')
      .orderBy('to_email', 'asc')
      .execute();
    expect(sends2.length).toBe(1);
    expect(sends2[0].to_email).toBe('ada@example.com');
  });
});
