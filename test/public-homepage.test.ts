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
    maxVolunteers?: number;
    locationLat?: string | null;
    locationLng?: string | null;
    organizationId?: string;
  }): Promise<string> {
    const slug = params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const date = ymdOffset(params.dayOffset);
    const event = await db
      .insertInto('events')
      .values({
        organization_id: params.organizationId ?? orgId,
        manager_id: managerId,
        slug,
        title: params.title,
        category: params.isFeatured ? 'featured' : 'normal',
        is_featured: params.isFeatured,
        description_html: '<p>Test event.</p>',
        location_name: 'Somewhere',
        location_map_url: 'https://maps.example.com',
        location_lat: params.locationLat ?? null,
        location_lng: params.locationLng ?? null,
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
          max_volunteers: params.maxVolunteers ?? 2,
          is_active: true
        })
        .execute();
    }
    return event.id;
  }

  async function createOrganization(name: string, slug: string): Promise<string> {
    const org = await db
      .insertInto('organizations')
      .values({
        name,
        slug,
        primary_color: '#4DD4AC',
        contact_email: 'contact@example.com',
        created_by: adminId
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('manager_organizations')
      .values({ manager_id: managerId, organization_id: org.id, assigned_by: adminId })
      .onConflict((oc) => oc.columns(['manager_id', 'organization_id']).doNothing())
      .execute();

    return org.id;
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

  test('location filter keeps in-radius events first and still shows events with unknown coordinates', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const nearby = `Nearby Event ${suffix}`;
    const unknown = `Unknown Location Event ${suffix}`;
    const farAway = `Far Event ${suffix}`;

    // Approx Midtown Manhattan
    await createEvent({
      title: nearby,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      locationLat: '40.7500',
      locationLng: '-73.9970'
    });
    // Unknown geocode should still be shown
    await createEvent({
      title: unknown,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      locationLat: null,
      locationLng: null
    });
    // San Francisco-ish, should be filtered out for 20-mile NYC radius
    await createEvent({
      title: farAway,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      locationLat: '37.7749',
      locationLng: '-122.4194'
    });

    const res = await app.inject({ method: 'GET', url: '/?lat=40.7505&lng=-73.9965&radius=20' });
    expect(res.statusCode).toBe(200);

    const body = String(res.body);
    expect(body).toContain(nearby);
    expect(body).toContain(unknown);
    expect(body).not.toContain(farAway);

    // Unknown-location events should sort below in-radius events.
    expect(body.indexOf(nearby)).toBeGreaterThan(0);
    expect(body.indexOf(unknown)).toBeGreaterThan(body.indexOf(nearby));
  });

  test('ip location fallback from proxy headers applies when no query or cookie is provided', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const nearby = `IP Nearby Event ${suffix}`;
    const farAway = `IP Far Event ${suffix}`;

    await createEvent({
      title: nearby,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      locationLat: '40.7500',
      locationLng: '-73.9970'
    });
    await createEvent({
      title: farAway,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      locationLat: '37.7749',
      locationLng: '-122.4194'
    });

    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: {
        'cf-ipcity': 'New York',
        'cf-region-code': 'NY',
        'cf-iplatitude': '40.7505',
        'cf-iplongitude': '-73.9965'
      }
    });
    expect(res.statusCode).toBe(200);

    const body = String(res.body);
    expect(body).toContain('Showing events near New York, NY');
    expect(body).toContain(nearby);
    expect(body).not.toContain(farAway);
  });

  test('organization filter appears only when multiple orgs have published events and filters results', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const orgOneEvent = `Org One Event ${suffix}`;
    const orgTwoEvent = `Org Two Event ${suffix}`;

    await createEvent({
      title: orgOneEvent,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z'
    });

    const singleOrgRes = await app.inject({ method: 'GET', url: '/' });
    expect(singleOrgRes.statusCode).toBe(200);
    expect(String(singleOrgRes.body)).not.toContain('<span>Organization</span>');

    const secondOrgId = await createOrganization(`Second Org ${suffix}`, `second-org-${suffix}`);
    await createEvent({
      title: orgTwoEvent,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      organizationId: secondOrgId
    });

    const multiOrgRes = await app.inject({ method: 'GET', url: '/' });
    expect(multiOrgRes.statusCode).toBe(200);
    const body = String(multiOrgRes.body);
    expect(body).toContain('<span>Organization</span>');
    expect(body).toContain('All organizations');
    expect(body).toContain(`Second Org ${suffix}`);

    const filteredRes = await app.inject({ method: 'GET', url: `/?org=second-org-${suffix}` });
    expect(filteredRes.statusCode).toBe(200);
    const filteredBody = String(filteredRes.body);
    expect(filteredBody).toContain(orgTwoEvent);
    expect(filteredBody).not.toContain(orgOneEvent);
  });

  test('homepage renders Full badge when all slots are filled', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const fullTitle = `Full Event ${suffix}`;
    const openTitle = `Open Event ${suffix}`;

    const fullEventId = await createEvent({
      title: fullTitle,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      maxVolunteers: 1
    });
    await createEvent({
      title: openTitle,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      maxVolunteers: 2
    });

    const fullShift = await db
      .selectFrom('shifts')
      .select(['id'])
      .where('event_id', '=', fullEventId)
      .executeTakeFirstOrThrow();

    await db
      .insertInto('signups')
      .values({
        shift_id: fullShift.id,
        first_name: 'Ada',
        last_name: 'L',
        email: 'ada@example.com',
        status: 'active',
        cancel_token: 'a'.repeat(64),
        cancel_token_hmac: Buffer.from('abc'),
        cancel_token_expires_at: new Date(Date.now() + 86400000).toISOString()
      })
      .execute();

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = String(res.body);
    expect(body).toContain(fullTitle);
    expect(body).toContain(openTitle);
    expect((body.match(/<span class="badge">Full<\/span>/g) ?? []).length).toBe(1);
  });

  test('location cookie persists filter and loc=clear removes it', async () => {
    const suffix = crypto.randomBytes(3).toString('hex');
    const nearby = `Cookie Nearby Event ${suffix}`;
    const farAway = `Cookie Far Event ${suffix}`;

    await createEvent({
      title: nearby,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      locationLat: '40.7500',
      locationLng: '-73.9970'
    });
    await createEvent({
      title: farAway,
      isFeatured: false,
      dayOffset: 8,
      updatedAt: '2026-04-10T10:00:00.000Z',
      locationLat: '37.7749',
      locationLng: '-122.4194'
    });

    const setLocRes = await app.inject({ method: 'GET', url: '/?lat=40.7505&lng=-73.9965&radius=20' });
    expect(setLocRes.statusCode).toBe(200);
    expect(String(setLocRes.body)).toContain('Showing events near your current location');

    const setCookie = setLocRes.headers['set-cookie'];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((line) => String(line ?? '').split(';')[0])
      .filter(Boolean)
      .join('; ');
    expect(cookieHeader).toContain('vf_loc=');

    const persistedRes = await app.inject({ method: 'GET', url: '/', headers: { cookie: cookieHeader } });
    expect(persistedRes.statusCode).toBe(200);
    const persistedBody = String(persistedRes.body);
    expect(persistedBody).toContain('Showing events near your current location');
    expect(persistedBody).toContain(nearby);
    expect(persistedBody).not.toContain(farAway);

    const clearRes = await app.inject({ method: 'GET', url: '/?loc=clear', headers: { cookie: cookieHeader } });
    expect(clearRes.statusCode).toBe(200);
    const clearBody = String(clearRes.body);
    expect(clearBody).not.toContain('Showing events near');
    expect(clearBody).toContain(nearby);
    expect(clearBody).toContain(farAway);
  });
});
