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

describe.skipIf(!DATABASE_URL)('reminder send template rendering', () => {
  let createDb: any;
  let runMigrations: any;
  let sendUpcomingShiftReminders: any;

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
    ({ sendUpcomingShiftReminders } = await import('../src/notifications.js'));

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

  test('uses reminder rule templates and merge tags in outbound reminder content', async () => {
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
        slug: 'template-event',
        title: 'Template Event',
        category: 'normal',
        description_html: '<p>Bring water.<br/>Wear good shoes.</p>',
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
        role_description: 'Say hello',
        duration_minutes: 120,
        shift_date: eventDate,
        start_time: '09:00:00',
        end_time: '11:00:00',
        min_volunteers: 1,
        max_volunteers: 4,
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
      .insertInto('reminder_rules')
      .values({
        event_id: event.id,
        send_offset_hours: 336,
        subject_template: 'Reminder: {{event_title}} for {{volunteer_first_name}}',
        body_template: [
          'Hi {{volunteer_first_name}} {{volunteer_last_initial}},',
          'Role: {{shift_role}}',
          'Date: {{shift_date}}',
          'Time: {{shift_start_time}} to {{shift_end_time}} ({{shift_duration}})',
          'Org: {{organization_name}}',
          'Manager: {{manager_name}} <{{manager_email}}>',
          'Desc: {{event_description_plain}}',
          'Map: {{location_map_url}}',
          'Cancel: {{cancel_url}}',
          'Event: {{event_url}}'
        ].join('\n'),
        is_active: true
      })
      .execute();

    const res = await sendUpcomingShiftReminders({ db, offsetHours: 336, limit: 50 });
    expect(res.considered).toBe(1);

    const send = await db
      .selectFrom('notification_sends')
      .select(['kind', 'subject', 'body'])
      .where('signup_id', '=', signup.id)
      .where('kind', '=', 'shift_reminder_336h')
      .executeTakeFirstOrThrow();

    expect(send.subject).toContain('Template Event');
    expect(send.subject).toContain('Ada');
    expect(send.body).toContain('Hi Ada L');
    expect(send.body).toContain('Role: Greeter');
    expect(send.body).toContain('Org: Test Org');
    expect(send.body).toContain('Pat Manager <manager@example.com>');
    expect(send.body).toContain('Bring water.');
    expect(send.body).toContain('Wear good shoes.');
    expect(send.body).toContain('https://maps.example.com/loc');
    expect(send.body).toContain('http://localhost:3000/cancel/');
    expect(send.body).toContain('http://localhost:3000/events/template-event');
    expect(send.body).not.toContain('{{');
  });
});
