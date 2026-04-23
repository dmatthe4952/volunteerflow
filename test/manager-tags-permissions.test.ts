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

describe.skipIf(!DATABASE_URL)('manager tag permissions', () => {
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

  test('manager can manage own tags, cannot manage others/system, duplicates are blocked', async () => {
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

    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        email: 'manager1@example.com',
        displayName: 'Manager 1',
        password: 'correct-horse-battery-staple',
        csrfToken: adminCsrf
      })
    });

    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        email: 'manager2@example.com',
        displayName: 'Manager 2',
        password: 'correct-horse-battery-staple',
        csrfToken: adminCsrf
      })
    });

    const manager1 = await db.selectFrom('users').select(['id']).where('email', '=', 'manager1@example.com').executeTakeFirstOrThrow();
    const manager2 = await db.selectFrom('users').select(['id']).where('email', '=', 'manager2@example.com').executeTakeFirstOrThrow();

    const mgr1Login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager1@example.com', password: 'correct-horse-battery-staple', role: 'manager' })
    });
    const mgr1Cookie = cookieHeaderFromSetCookie(mgr1Login.headers['set-cookie'] as any);
    const mgr1Csrf = await fetchCsrfToken(app, '/manager/tags', mgr1Cookie);

    const mgr2Login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ email: 'manager2@example.com', password: 'correct-horse-battery-staple', role: 'manager' })
    });
    const mgr2Cookie = cookieHeaderFromSetCookie(mgr2Login.headers['set-cookie'] as any);
    const mgr2Csrf = await fetchCsrfToken(app, '/manager/tags', mgr2Cookie);

    const create1 = await app.inject({
      method: 'POST',
      url: '/manager/tags',
      headers: { cookie: mgr1Cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: 'Food Bank', csrfToken: mgr1Csrf })
    });
    expect(create1.statusCode).toBe(303);

    const ownTag = await db.selectFrom('tags').select(['id', 'name', 'created_by']).where('slug', '=', 'food-bank').executeTakeFirstOrThrow();
    expect(ownTag.name).toBe('food bank');
    expect(ownTag.created_by).toBe(manager1.id);

    const dup = await app.inject({
      method: 'POST',
      url: '/manager/tags',
      headers: { cookie: mgr1Cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: '  FOOD   bank ', csrfToken: mgr1Csrf })
    });
    expect(dup.statusCode).toBe(303);
    expect(String(dup.headers.location)).toContain('err=');

    const manager2Update = await app.inject({
      method: 'POST',
      url: `/manager/tags/${ownTag.id}/update`,
      headers: { cookie: mgr2Cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: 'Canvassing', csrfToken: mgr2Csrf })
    });
    expect(manager2Update.statusCode).toBe(303);
    expect(String(manager2Update.headers.location)).toContain('err=');

    const afterForbiddenUpdate = await db.selectFrom('tags').select(['name']).where('id', '=', ownTag.id).executeTakeFirstOrThrow();
    expect(afterForbiddenUpdate.name).toBe('food bank');

    const manager2Delete = await app.inject({
      method: 'POST',
      url: `/manager/tags/${ownTag.id}/delete`,
      headers: { cookie: mgr2Cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ csrfToken: mgr2Csrf })
    });
    expect(manager2Delete.statusCode).toBe(303);
    expect(String(manager2Delete.headers.location)).toContain('err=');

    await db
      .insertInto('tags')
      .values({ name: 'understaffed', slug: 'understaffed', is_system: true, created_by: null })
      .execute();
    const systemTag = await db.selectFrom('tags').select(['id']).where('slug', '=', 'understaffed').executeTakeFirstOrThrow();

    const managerSystemDelete = await app.inject({
      method: 'POST',
      url: `/manager/tags/${systemTag.id}/delete`,
      headers: { cookie: mgr1Cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ csrfToken: mgr1Csrf })
    });
    expect(managerSystemDelete.statusCode).toBe(303);
    expect(String(managerSystemDelete.headers.location)).toContain('err=');

    const ownUpdate = await app.inject({
      method: 'POST',
      url: `/manager/tags/${ownTag.id}/update`,
      headers: { cookie: mgr1Cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ name: 'Food Pantry', csrfToken: mgr1Csrf })
    });
    expect(ownUpdate.statusCode).toBe(303);

    const renamed = await db.selectFrom('tags').select(['slug', 'name']).where('id', '=', ownTag.id).executeTakeFirstOrThrow();
    expect(renamed.slug).toBe('food-pantry');
    expect(renamed.name).toBe('food pantry');

    const ownDelete = await app.inject({
      method: 'POST',
      url: `/manager/tags/${ownTag.id}/delete`,
      headers: { cookie: mgr1Cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ csrfToken: mgr1Csrf })
    });
    expect(ownDelete.statusCode).toBe(303);

    const finalCount = await db
      .selectFrom('tags')
      .select((eb: any) => eb.fn.countAll<number>().as('c'))
      .where('slug', '=', 'food-pantry')
      .executeTakeFirst();
    expect(Number(finalCount?.c ?? 0)).toBe(0);

    expect(manager2.id).toBeTruthy();
  });
});
