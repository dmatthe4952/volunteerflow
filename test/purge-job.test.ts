import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';

const DATABASE_URL = process.env.DATABASE_URL;

function ymdOffset(days: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe.skipIf(!DATABASE_URL)('purge job', () => {
  let createDb: any;
  let runMigrations: any;
  let purgeExpiredVolunteerPII: any;

  beforeAll(async () => {
    ({ createDb, runMigrations } = await loadAppForTest({
      APP_ENV: 'test',
      APP_PORT: '3000',
      APP_URL: 'http://localhost:3000',
      APP_TIMEZONE: 'America/New_York',
      DATABASE_URL: DATABASE_URL!,
      SESSION_SECRET: 'test-only-change-me',
      ADMIN_TOKEN: 'test-ops-change-me'
    }));
    ({ purgeExpiredVolunteerPII } = await import('../src/purge.js'));

    await runMigrations({
      databaseUrl: DATABASE_URL!,
      migrationsDir: migrationsDirFromRepoRoot()
    });
  });

  let db: any;

  beforeEach(async () => {
    db = createDb();
    await resetDb(db);
  });

  test('purges eligible events based on override/default and is idempotent', async () => {
    const manager = await db
      .insertInto('users')
      .values({
        email: 'manager@example.com',
        password_hash: 'x',
        display_name: 'Manager',
        role: 'event_manager',
        is_active: true
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const org = await db
      .insertInto('organizations')
      .values({
        name: 'Test Org',
        slug: 'test-org',
        primary_color: '#4DD4AC',
        contact_email: 'contact@example.com',
        created_by: manager.id
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('system_settings')
      .values({ key: 'DEFAULT_PURGE_DAYS', value_encrypted: Buffer.from('7', 'utf8') })
      .onConflict((oc: any) => oc.column('key').doUpdateSet({ value_encrypted: Buffer.from('7', 'utf8') }))
      .execute();

    const eEligibleDefault = await db
      .insertInto('events')
      .values({
        organization_id: org.id,
        manager_id: manager.id,
        slug: 'e-default',
        title: 'Eligible By Default',
        category: 'normal',
        event_type: 'one_time',
        start_date: ymdOffset(-12),
        end_date: ymdOffset(-12),
        is_published: true,
        is_archived: false
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const eNotYetDefault = await db
      .insertInto('events')
      .values({
        organization_id: org.id,
        manager_id: manager.id,
        slug: 'e-not-yet',
        title: 'Not Yet By Default',
        category: 'normal',
        event_type: 'one_time',
        start_date: ymdOffset(-3),
        end_date: ymdOffset(-3),
        is_published: true,
        is_archived: false
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const eEligibleOverride = await db
      .insertInto('events')
      .values({
        organization_id: org.id,
        manager_id: manager.id,
        slug: 'e-override',
        title: 'Eligible By Override',
        category: 'normal',
        event_type: 'one_time',
        start_date: ymdOffset(-12),
        end_date: ymdOffset(-12),
        purge_after_days: 5,
        is_published: true,
        is_archived: false
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const eNotYetOverride = await db
      .insertInto('events')
      .values({
        organization_id: org.id,
        manager_id: manager.id,
        slug: 'e-not-yet-override',
        title: 'Not Yet By Override',
        category: 'normal',
        event_type: 'one_time',
        start_date: ymdOffset(-12),
        end_date: ymdOffset(-12),
        purge_after_days: 30,
        is_published: true,
        is_archived: false
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const mkShift = async (eventId: string, date: string) =>
      db
        .insertInto('shifts')
        .values({
          event_id: eventId,
          role_name: 'Role',
          role_description: null,
          duration_minutes: 60,
          shift_date: date,
          start_time: '10:00:00',
          end_time: '11:00:00',
          min_volunteers: 0,
          max_volunteers: 2,
          is_active: true
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

    const s1 = await mkShift(eEligibleDefault.id, ymdOffset(-12));
    const s2 = await mkShift(eNotYetDefault.id, ymdOffset(-3));
    const s3 = await mkShift(eEligibleOverride.id, ymdOffset(-12));
    const s4 = await mkShift(eNotYetOverride.id, ymdOffset(-12));

    const mkSignup = async (shiftId: string, email: string, token: string) =>
      db
        .insertInto('signups')
        .values({
          shift_id: shiftId,
          first_name: 'A',
          last_name: 'L',
          email,
          status: 'active',
          cancel_token: token,
          cancel_token_hmac: Buffer.from('abc'),
          cancel_token_expires_at: new Date(Date.now() + 86400000).toISOString()
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

    const sg1 = await mkSignup(s1.id, 'a1@example.com', 'a'.repeat(64));
    const sg2 = await mkSignup(s2.id, 'a2@example.com', 'b'.repeat(64));
    const sg3 = await mkSignup(s3.id, 'a3@example.com', 'c'.repeat(64));
    const sg4 = await mkSignup(s4.id, 'a4@example.com', 'd'.repeat(64));

    await db
      .insertInto('notification_sends')
      .values([
        {
          kind: 'signup_confirmation',
          event_id: eEligibleDefault.id,
          signup_id: sg1.id,
          to_email: 'a1@example.com',
          subject: 's1',
          body: 'b1',
          status: 'queued'
        },
        {
          kind: 'signup_confirmation',
          event_id: eNotYetDefault.id,
          signup_id: sg2.id,
          to_email: 'a2@example.com',
          subject: 's2',
          body: 'b2',
          status: 'queued'
        },
        {
          kind: 'signup_confirmation',
          event_id: eEligibleOverride.id,
          signup_id: sg3.id,
          to_email: 'a3@example.com',
          subject: 's3',
          body: 'b3',
          status: 'queued'
        },
        {
          kind: 'signup_confirmation',
          event_id: eNotYetOverride.id,
          signup_id: sg4.id,
          to_email: 'a4@example.com',
          subject: 's4',
          body: 'b4',
          status: 'queued'
        },
        {
          kind: 'manager_broadcast_shift',
          event_id: eEligibleDefault.id,
          signup_id: null,
          to_email: 'broadcast-purged@example.com',
          subject: 'broadcast-purged',
          body: 'broadcast-purged',
          status: 'queued'
        },
        {
          kind: 'manager_broadcast_shift',
          event_id: eNotYetDefault.id,
          signup_id: null,
          to_email: 'broadcast-kept@example.com',
          subject: 'broadcast-kept',
          body: 'broadcast-kept',
          status: 'queued'
        }
      ])
      .execute();

    const run1 = await purgeExpiredVolunteerPII({ db });
    expect(run1.defaultPurgeDays).toBe(7);
    expect(run1.eligible).toBe(2);
    expect(run1.purgedEvents).toBe(2);
    expect(run1.deletedSignups).toBe(2);
    expect(run1.deletedNotificationSends).toBe(3);

    const signupsLeft = await db
      .selectFrom('signups')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .executeTakeFirst();
    expect(Number(signupsLeft?.c ?? 0)).toBe(2);

    const sendsLeft = await db
      .selectFrom('notification_sends')
      .select(['to_email'])
      .orderBy('to_email', 'asc')
      .execute();
    expect(sendsLeft.map((r: any) => r.to_email)).toEqual(['a2@example.com', 'a4@example.com', 'broadcast-kept@example.com']);

    const events = await db
      .selectFrom('events')
      .select(['slug', 'purged_at'])
      .where('slug', 'in', ['e-default', 'e-not-yet', 'e-override', 'e-not-yet-override'])
      .orderBy('slug', 'asc')
      .execute();
    const bySlug = new Map(events.map((e: any) => [e.slug, e.purged_at]));
    expect(bySlug.get('e-default')).toBeTruthy();
    expect(bySlug.get('e-override')).toBeTruthy();
    expect(bySlug.get('e-not-yet')).toBeNull();
    expect(bySlug.get('e-not-yet-override')).toBeNull();

    const run2 = await purgeExpiredVolunteerPII({ db });
    expect(run2.eligible).toBe(0);
    expect(run2.purgedEvents).toBe(0);
    expect(run2.deletedSignups).toBe(0);
    expect(run2.deletedNotificationSends).toBe(0);
  });
});
