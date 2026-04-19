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

describe.skipIf(!DATABASE_URL)('public homepage listing', () => {
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
  let adminId: string;
  let managerId: string;
  let orgId: string;

  beforeEach(async () => {
    db = createDb();
    await resetDb(db);
    app = await buildApp({ db, runMigrations: false, logger: false });

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
    adminId = admin.id;

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
    managerId = manager.id;

    const org = await db
      .insertInto('organizations')
      .values({
        name: `Test Org ${suffix}`,
        slug: `test-org-${suffix}`,
        primary_color: '#4DD4AC',
        contact_email: 'contact@example.com',
        created_by: adminId
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    orgId = org.id;

    await db
      .insertInto('manager_organizations')
      .values({ manager_id: managerId, organization_id: orgId, assigned_by: adminId })
      .execute();
  });

  async function createEvent(params: {
    title: string;
    isFeatured: boolean;
    dayOffset: number;
    updatedAt: string;
    withShift?: boolean;
  }) {
    const slug = params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const date = ymdOffset(params.dayOffset);
    const event = await db
      .insertInto('events')
      .values({
        organization_id: orgId,
        manager_id: managerId,
        slug,
        title: params.title,
        category: params.isFeatured ? 'featured' : 'normal',
        is_featured: params.isFeatured,
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

    await db.updateTable('events').set({ updated_at: params.updatedAt }).where('id', '=', event.id).execute();

    if (params.withShift !== false) {
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
    }
  }

  test('shows only upcoming events and caps featured section to 3 most recently updated', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const fOld = `Featured Old ${suffix}`;
    const fMid = `Featured Mid ${suffix}`;
    const fNew = `Featured New ${suffix}`;
    const fNewest = `Featured Newest ${suffix}`;
    const normal = `Normal Upcoming ${suffix}`;
    const past = `Past Event ${suffix}`;
    const noShift = `No Shift Event ${suffix}`;

    await createEvent({ title: fOld, isFeatured: true, dayOffset: 9, updatedAt: '2026-04-01T10:00:00.000Z' });
    await createEvent({ title: fMid, isFeatured: true, dayOffset: 10, updatedAt: '2026-04-02T10:00:00.000Z' });
    await createEvent({ title: fNew, isFeatured: true, dayOffset: 11, updatedAt: '2026-04-03T10:00:00.000Z' });
    await createEvent({ title: fNewest, isFeatured: true, dayOffset: 12, updatedAt: '2026-04-04T10:00:00.000Z' });
    await createEvent({ title: normal, isFeatured: false, dayOffset: 8, updatedAt: '2026-04-05T10:00:00.000Z' });
    await createEvent({ title: past, isFeatured: true, dayOffset: -2, updatedAt: '2026-04-06T10:00:00.000Z' });
    await createEvent({ title: noShift, isFeatured: false, dayOffset: 7, updatedAt: '2026-04-07T10:00:00.000Z', withShift: false });

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);

    const body = String(res.body);
    expect((body.match(/class="card cat-featured"/g) ?? []).length).toBe(3);

    const splitToken = '<h3 style="margin-top:14px">All Events</h3>';
    const splitAt = body.indexOf(splitToken);
    expect(splitAt).toBeGreaterThan(0);
    const featuredSection = body.slice(0, splitAt);
    const allEventsSection = body.slice(splitAt);

    expect(featuredSection).toContain(fNewest);
    expect(featuredSection).toContain(fNew);
    expect(featuredSection).toContain(fMid);
    expect(featuredSection).not.toContain(fOld);

    expect(allEventsSection).toContain(fOld);
    expect(allEventsSection).toContain(normal);

    expect(body).not.toContain(past);
    expect(body).not.toContain(noShift);
  });
});

