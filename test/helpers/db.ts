import path from 'node:path';
import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../../src/db.js';

export async function resetDb(db: Kysely<DB>) {
  // Delete in dependency order.
  await db.deleteFrom('notification_sends').execute();
  await db.deleteFrom('volunteer_email_tokens').execute();
  await db.deleteFrom('sent_reminders').execute();
  await db.deleteFrom('reminder_rules').execute();
  await db.deleteFrom('signups').execute();
  await db.deleteFrom('shifts').execute();
  await db.deleteFrom('event_tags').execute();
  await db.deleteFrom('events').execute();
  await db.deleteFrom('tags').execute();
  await db.deleteFrom('manager_organizations').execute();
  await db.deleteFrom('impersonation_log').execute();
  await db.deleteFrom('organizations').execute();
  await db.deleteFrom('sessions').execute();
  await db.deleteFrom('login_audit').execute();
  await db.deleteFrom('role_templates').execute();
  await db.deleteFrom('system_settings').execute();
  await db.deleteFrom('users').execute();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120);
}

export async function seedBasicEvent(db: Kysely<DB>) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const admin = await db
    .insertInto('users')
    .values({
      email: `admin+${suffix}@example.com`,
      password_hash: 'test-only',
      display_name: 'Admin',
      role: 'super_admin',
      is_active: true
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const manager = await db
    .insertInto('users')
    .values({
      email: `manager+${suffix}@example.com`,
      password_hash: 'test-only',
      display_name: 'Manager',
      role: 'event_manager',
      is_active: true
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const org = await db
    .insertInto('organizations')
    .values({
      name: `Test Org ${suffix}`,
      slug: `test-org-${suffix}`,
      primary_color: '#4DD4AC',
      contact_email: 'contact@example.com',
      created_by: admin.id
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await db
    .insertInto('manager_organizations')
    .values({ manager_id: manager.id, organization_id: org.id, assigned_by: admin.id })
    .execute();

  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 7));
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, '0');
  const d = String(start.getUTCDate()).padStart(2, '0');
  const date = `${y}-${m}-${d}`;

  const title = `Test Event ${crypto.randomBytes(4).toString('hex')}`;
  const slug = slugify(title);

  const event = await db
    .insertInto('events')
    .values({
      organization_id: org.id,
      manager_id: manager.id,
      slug,
      title,
      category: 'normal',
      description_html: '<p>Test event.</p>',
      location_name: 'Somewhere',
      location_map_url: 'https://maps.example.com',
      event_type: 'one_time',
      start_date: date,
      end_date: date,
      is_published: true,
      is_archived: false
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const shift = await db
    .insertInto('shifts')
    .values({
      event_id: event.id,
      role_name: 'Packing',
      role_description: null,
      duration_minutes: 60,
      shift_date: date,
      start_time: '10:00:00',
      end_time: '11:00:00',
      min_volunteers: 1,
      max_volunteers: 2,
      is_active: true
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { eventSlug: slug, eventId: event.id, shiftId: shift.id };
}

export function migrationsDirFromRepoRoot(): string {
  return path.join(process.cwd(), 'migrations');
}
