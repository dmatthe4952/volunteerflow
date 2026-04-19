import crypto from 'node:crypto';
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

describe.skipIf(!DATABASE_URL)('public past events archive', () => {
  let runMigrations: any;

  beforeAll(async () => {
    ({ runMigrations } = await loadAppForTest({
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

  async function seedPastEvent(db: any) {
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

    const title = `Past Event ${suffix}`;
    const date = ymdOffset(-2);
    const event = await db
      .insertInto('events')
      .values({
        organization_id: org.id,
        manager_id: manager.id,
        slug: `past-event-${suffix}`,
        title,
        category: 'normal',
        description_html: '<p>Past event.</p>',
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

    await db
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
      .execute();

    return { title };
  }

  test('staging default exposes /events/past', async () => {
    const { createDb, buildApp } = await loadAppForTest({
      APP_ENV: 'staging',
      APP_PORT: '3000',
      APP_URL: 'http://localhost:3000',
      APP_TIMEZONE: 'America/New_York',
      DATABASE_URL: DATABASE_URL!,
      SESSION_SECRET: 'test-only-change-me',
      ADMIN_TOKEN: 'test-ops-change-me'
    });

    const db = createDb();
    await resetDb(db);
    const { title } = await seedPastEvent(db);
    const app = await buildApp({ db, runMigrations: false, logger: false });

    const res = await app.inject({ method: 'GET', url: '/events/past' });
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain(title);
  });

  test('production default hides /events/past', async () => {
    const { createDb, buildApp } = await loadAppForTest({
      APP_ENV: 'production',
      APP_PORT: '3000',
      APP_URL: 'http://localhost:3000',
      APP_TIMEZONE: 'America/New_York',
      DATABASE_URL: DATABASE_URL!,
      SESSION_SECRET: 'test-only-change-me',
      ADMIN_TOKEN: 'test-ops-change-me'
    });

    const db = createDb();
    await resetDb(db);
    await seedPastEvent(db);
    const app = await buildApp({ db, runMigrations: false, logger: false });

    const res = await app.inject({ method: 'GET', url: '/events/past' });
    expect(res.statusCode).toBe(404);
  });
});
