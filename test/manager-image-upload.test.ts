import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';
import { cookieHeaderFromSetCookie, extractCsrfToken, fetchCsrfToken } from './helpers/csrf.js';

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

function multipartBody(
  fields: Array<{ name: string; value: string }>,
  file: { fieldName: string; filename: string; contentType: string; content: Buffer }
) {
  const boundary = `----vf-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const field of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
          `${field.value}\r\n`
      )
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`
    )
  );
  chunks.push(file.content);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(chunks), boundary };
}

describe.skipIf(!DATABASE_URL)('manager image upload validation', () => {
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

  test('rejects spoofed image bytes and accepts valid png content', async () => {
    const eventDate = ymdOffset(7);

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
    const adminCsrf = await fetchCsrfToken(app, '/admin/organizations', adminCookie);

    await app.inject({
      method: 'POST',
      url: '/admin/organizations',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        name: 'Test Org',
        slug: 'test-org',
        primaryColor: '#4DD4AC',
        contactEmail: 'contact@example.com',
        csrfToken: adminCsrf
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
        csrfToken: adminCsrf
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
    const managerPage = await app.inject({ method: 'GET', url: '/manager/events/new', headers: { cookie: mgrCookie } });
    expect(managerPage.statusCode).toBe(200);
    const managerCsrf = extractCsrfToken(String(managerPage.body));
    const refreshedMgrCookie = cookieHeaderFromSetCookie(managerPage.headers['set-cookie'] as any);
    const mgrCookieForPost = refreshedMgrCookie ? `${mgrCookie}; ${refreshedMgrCookie}` : mgrCookie;

    const eventRes = await app.inject({
      method: 'POST',
      url: '/manager/events/new',
      headers: { cookie: mgrCookieForPost, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        title: 'Image Upload Event',
        organizationId: orgRow.id,
        date: eventDate,
        description: 'Hello',
        locationName: 'Somewhere',
        locationMapUrl: 'https://www.google.com/maps/@34.852600,-82.394000,15z',
        csrfToken: managerCsrf
      })
    });
    expect(eventRes.statusCode).toBe(303);
    const eventId = String(eventRes.headers.location).split('/')[3];

    const spoofed = multipartBody(
      [{ name: 'csrfToken', value: managerCsrf }],
      {
        fieldName: 'image',
        filename: 'spoofed.png',
        contentType: 'image/png',
        content: Buffer.from('not a real png')
      }
    );
    const badUpload = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/image`,
      headers: {
        cookie: mgrCookieForPost,
        'x-csrf-token': managerCsrf,
        'content-type': `multipart/form-data; boundary=${spoofed.boundary}`
      },
      payload: spoofed.body
    });
    expect(badUpload.statusCode).toBe(303);
    expect(String(badUpload.headers.location)).toContain('err=');

    const eventAfterBad = await db.selectFrom('events').select(['image_path']).where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(eventAfterBad.image_path).toBeNull();

    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+Q3kAAAAASUVORK5CYII=',
      'base64'
    );
    const valid = multipartBody(
      [{ name: 'csrfToken', value: managerCsrf }],
      {
        fieldName: 'image',
        filename: 'pixel.png',
        contentType: 'image/png',
        content: pngBytes
      }
    );
    const okUpload = await app.inject({
      method: 'POST',
      url: `/manager/events/${eventId}/image`,
      headers: {
        cookie: mgrCookieForPost,
        'x-csrf-token': managerCsrf,
        'content-type': `multipart/form-data; boundary=${valid.boundary}`
      },
      payload: valid.body
    });
    expect(okUpload.statusCode).toBe(303);
    expect(String(okUpload.headers.location)).toContain('ok=');

    const eventAfterGood = await db.selectFrom('events').select(['image_path']).where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(String(eventAfterGood.image_path ?? '')).toMatch(/^\/event-images\/event-.+\.png$/);

    const savedName = String(eventAfterGood.image_path).replace('/event-images/', '');
    const savedPath = path.join(process.cwd(), 'uploads', 'event-images', savedName);
    expect(fs.existsSync(savedPath)).toBe(true);
  });
});
