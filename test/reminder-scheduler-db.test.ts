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

describe.skipIf(!DATABASE_URL)('reminder scheduler', () => {
  let createDb: any;
  let runMigrations: any;
  let runReminderScheduler: any;

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
    ({ runReminderScheduler } = await import('../src/reminder_scheduler.js'));

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

  test('runs active offsets and is idempotent across repeated runs', async () => {
    const eventDate = ymdOffset(2);

    const manager = await db
      .insertInto('users')
      .values({
        email: 'manager@example.com',
        password_hash: 'x',
        display_name: 'Pat Manager',
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

    const event = await db
      .insertInto('events')
      .values({
        organization_id: org.id,
        manager_id: manager.id,
        slug: 'sched-event',
        title: 'Scheduler Event',
        category: 'normal',
        description_html: '<p>Hello</p>',
        location_name: '123 Main St',
        location_map_url: 'https://maps.example.com/loc',
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
        role_name: 'Greeter',
        role_description: null,
        duration_minutes: 120,
        shift_date: eventDate,
        start_time: '09:00:00',
        end_time: '11:00:00',
        min_volunteers: 1,
        max_volunteers: 3,
        is_active: true
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('signups')
      .values({
        shift_id: shift.id,
        first_name: 'Ada',
        last_name: 'L',
        email: 'ada@example.com',
        status: 'active',
        cancel_token: 'b'.repeat(64),
        cancel_token_hmac: Buffer.from('abc'),
        cancel_token_expires_at: new Date(Date.now() + 86400000).toISOString()
      })
      .execute();

    await db
      .insertInto('reminder_rules')
      .values({
        event_id: event.id,
        send_offset_hours: 336,
        subject_template: 'R {{event_title}}',
        body_template: 'Hello {{volunteer_first_name}}',
        is_active: true
      })
      .execute();

    const first = await runReminderScheduler({ db, limitPerOffset: 50 });
    expect(first.offsets).toEqual([336]);
    expect(first.totalConsidered).toBe(1);

    const second = await runReminderScheduler({ db, limitPerOffset: 50 });
    expect(second.offsets).toEqual([336]);
    expect(second.totalConsidered).toBe(1);
    expect(second.totalSkippedAlreadySent).toBe(1);

    const sends = await db
      .selectFrom('notification_sends')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('kind', '=', 'shift_reminder_336h')
      .executeTakeFirst();
    expect(Number(sends?.c ?? 0)).toBe(1);
  });
});
