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

describe.skipIf(!DATABASE_URL)('admin tags', () => {
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

  test('admin can manage any non-system tag; duplicate and system protections apply', async () => {
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
    const adminCsrf = await fetchCsrfToken(app, '/admin/tags', adminCookie);

    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        email: 'manager@example.com',
        displayName: 'Manager',
        password: 'correct-horse-battery-staple',
        csrfToken: adminCsrf
      })
    });

    const manager = await db.selectFrom('users').select(['id']).where('email', '=', 'manager@example.com').executeTakeFirstOrThrow();

    const managerTag = await db
      .insertInto('tags')
      .values({ name: 'canvassing', slug: 'canvassing', is_system: false, created_by: manager.id })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('tags')
      .values({ name: 'understaffed', slug: 'understaffed', is_system: true, created_by: null })
      .execute();
    const systemTag = await db.selectFrom('tags').select(['id']).where('slug', '=', 'understaffed').executeTakeFirstOrThrow();

    const createUrgent = await app.inject({
      method: 'POST',
      url: '/admin/tags',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: 'Urgent', csrfToken: adminCsrf })
    });
    expect(createUrgent.statusCode).toBe(303);

    const createUrgentDup = await app.inject({
      method: 'POST',
      url: '/admin/tags',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: ' urgent  ', csrfToken: adminCsrf })
    });
    expect(createUrgentDup.statusCode).toBe(303);
    expect(String(createUrgentDup.headers.location)).toContain('err=');

    const adminRenameManagerTag = await app.inject({
      method: 'POST',
      url: `/admin/tags/${managerTag.id}/update`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: 'Outreach', csrfToken: adminCsrf })
    });
    expect(adminRenameManagerTag.statusCode).toBe(303);

    const renamed = await db.selectFrom('tags').select(['name', 'slug']).where('id', '=', managerTag.id).executeTakeFirstOrThrow();
    expect(renamed.name).toBe('outreach');
    expect(renamed.slug).toBe('outreach');

    const adminDeleteSystem = await app.inject({
      method: 'POST',
      url: `/admin/tags/${systemTag.id}/delete`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ csrfToken: adminCsrf })
    });
    expect(adminDeleteSystem.statusCode).toBe(303);
    expect(String(adminDeleteSystem.headers.location)).toContain('err=');

    const adminDeleteManagerTag = await app.inject({
      method: 'POST',
      url: `/admin/tags/${managerTag.id}/delete`,
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ csrfToken: adminCsrf })
    });
    expect(adminDeleteManagerTag.statusCode).toBe(303);

    const remaining = await db
      .selectFrom('tags')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('id', '=', managerTag.id)
      .executeTakeFirst();
    expect(Number(remaining?.c ?? 0)).toBe(0);
  });

  test('admin screen inventory routes are reachable for admin and forbidden for manager', async () => {
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
    const adminCsrf = await fetchCsrfToken(app, '/admin/users', adminCookie);

    const createManager = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        email: 'manager@example.com',
        displayName: 'Manager',
        password: 'correct-horse-battery-staple',
        csrfToken: adminCsrf
      })
    });
    expect(createManager.statusCode).toBe(303);

    const managerLogin = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager@example.com', password: 'correct-horse-battery-staple', role: 'manager' })
    });
    const managerCookie = cookieHeaderFromSetCookie(managerLogin.headers['set-cookie'] as any);

    const inventory: Array<{ path: string; marker: string }> = [
      { path: '/admin/dashboard', marker: 'Admin Dashboard' },
      { path: '/admin/users', marker: 'Users' },
      { path: '/admin/organizations', marker: 'Organizations' },
      { path: '/admin/tags', marker: 'Tag Management' },
      { path: '/admin/settings', marker: 'System Settings' }
    ];

    for (const route of inventory) {
      const adminRes = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: adminCookie }
      });
      expect(adminRes.statusCode).toBe(200);
      expect(adminRes.body).toContain(route.marker);

      const managerRes = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: managerCookie }
      });
      expect(managerRes.statusCode).toBe(403);
    }
  });
});
