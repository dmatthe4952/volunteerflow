import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'kysely';
import { loadAppForTest } from './helpers/env.js';
import { migrationsDirFromRepoRoot, resetDb } from './helpers/db.js';
import { cookieHeaderFromSetCookie, fetchCsrfToken } from './helpers/csrf.js';
import { decryptSettingValue } from '../src/settings_crypto.js';

const DATABASE_URL = process.env.DATABASE_URL;

function formEncode(values: Record<string, string>) {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe.skipIf(!DATABASE_URL)('admin smtp settings ui', () => {
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
      ADMIN_TOKEN: 'test-ops-change-me',
      SMTP_HOST: 'env.smtp.example.com',
      SMTP_PORT: '2525',
      SMTP_SECURE: 'false',
      SMTP_USER: 'env-user',
      SMTP_PASS: 'env-pass',
      SMTP_FROM_NAME: 'Env Sender',
      SMTP_FROM_EMAIL: 'env@example.com'
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

  test('admin can save smtp settings and blank password preserves existing value', async () => {
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

    const settingsPage = await app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie: adminCookie } });
    expect(settingsPage.statusCode).toBe(200);
    expect(settingsPage.body).toContain('SMTP');

    const csrf = await fetchCsrfToken(app, '/admin/settings', adminCookie);

    const save1 = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        host: 'smtp.example.com',
        port: '465',
        secure: 'on',
        user: 'mailer-user',
        pass: 'secret-one',
        fromName: 'LocalShifts Mailer',
        fromEmail: 'no-reply@example.com',
        csrfToken: csrf
      })
    });
    expect(save1.statusCode).toBe(303);
    expect(String(save1.headers.location)).toContain('ok=');

    const settingsRows1 = await db
      .selectFrom('system_settings')
      .select(['key'])
      .select((eb: any) => sql<string>`convert_from(${eb.ref('value_encrypted')}::bytea, 'UTF8')`.as('value'))
      .where('key', 'in', [
        'SMTP_HOST',
        'SMTP_PORT',
        'SMTP_SECURE',
        'SMTP_USER',
        'SMTP_PASS',
        'SMTP_FROM_NAME',
        'SMTP_FROM_EMAIL'
      ])
      .execute();

    const map1 = new Map(settingsRows1.map((r: any) => [r.key, r.value]));
    expect(String(map1.get('SMTP_HOST') ?? '')).toContain('enc:v1:');
    expect(String(map1.get('SMTP_PASS') ?? '')).toContain('enc:v1:');

    const decrypted1 = new Map(
      settingsRows1.map((r: any) => [r.key, decryptSettingValue(String(r.value ?? ''), 'test-only-change-me')])
    );
    expect(decrypted1.get('SMTP_HOST')).toBe('smtp.example.com');
    expect(decrypted1.get('SMTP_PORT')).toBe('465');
    expect(decrypted1.get('SMTP_SECURE')).toBe('true');
    expect(decrypted1.get('SMTP_USER')).toBe('mailer-user');
    expect(decrypted1.get('SMTP_PASS')).toBe('secret-one');
    expect(decrypted1.get('SMTP_FROM_NAME')).toBe('LocalShifts Mailer');
    expect(decrypted1.get('SMTP_FROM_EMAIL')).toBe('no-reply@example.com');

    const save2 = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        host: 'smtp2.example.com',
        port: '587',
        user: 'mailer-user-2',
        pass: '',
        fromName: 'Mailer 2',
        fromEmail: 'mail2@example.com',
        csrfToken: csrf
      })
    });

    expect(save2.statusCode).toBe(303);
    expect(String(save2.headers.location)).toContain('ok=');

    const settingsRows2 = await db
      .selectFrom('system_settings')
      .select(['key'])
      .select((eb: any) => sql<string>`convert_from(${eb.ref('value_encrypted')}::bytea, 'UTF8')`.as('value'))
      .where('key', 'in', ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME', 'SMTP_FROM_EMAIL'])
      .execute();

    const map2 = new Map(settingsRows2.map((r: any) => [r.key, r.value]));
    expect(String(map2.get('SMTP_HOST') ?? '')).toContain('enc:v1:');
    expect(String(map2.get('SMTP_PASS') ?? '')).toContain('enc:v1:');

    const decrypted2 = new Map(
      settingsRows2.map((r: any) => [r.key, decryptSettingValue(String(r.value ?? ''), 'test-only-change-me')])
    );
    expect(decrypted2.get('SMTP_HOST')).toBe('smtp2.example.com');
    expect(decrypted2.get('SMTP_PORT')).toBe('587');
    expect(decrypted2.get('SMTP_SECURE')).toBe('false');
    expect(decrypted2.get('SMTP_USER')).toBe('mailer-user-2');
    expect(decrypted2.get('SMTP_PASS')).toBe('secret-one');
    expect(decrypted2.get('SMTP_FROM_NAME')).toBe('Mailer 2');
    expect(decrypted2.get('SMTP_FROM_EMAIL')).toBe('mail2@example.com');
  });

  test('db smtp settings take precedence over env smtp settings', async () => {
    const { resolveSmtpConfig } = await import('../src/email.js');

    const initial = await resolveSmtpConfig(db);
    expect(initial.host).toBe('env.smtp.example.com');
    expect(initial.port).toBe(2525);
    expect(initial.secure).toBe(false);
    expect(initial.user).toBe('env-user');
    expect(initial.pass).toBe('env-pass');
    expect(initial.fromName).toBe('Env Sender');
    expect(initial.fromEmail).toBe('env@example.com');

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
    const csrf = await fetchCsrfToken(app, '/admin/settings', adminCookie);

    const save = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        host: 'db.smtp.example.com',
        port: '1465',
        secure: 'on',
        user: 'db-user',
        pass: 'db-pass',
        fromName: 'DB Sender',
        fromEmail: 'db@example.com',
        csrfToken: csrf
      })
    });
    expect(save.statusCode).toBe(303);

    const resolved = await resolveSmtpConfig(db);
    expect(resolved.host).toBe('db.smtp.example.com');
    expect(resolved.port).toBe(1465);
    expect(resolved.secure).toBe(true);
    expect(resolved.user).toBe('db-user');
    expect(resolved.pass).toBe('db-pass');
    expect(resolved.fromName).toBe('DB Sender');
    expect(resolved.fromEmail).toBe('db@example.com');
  });

  test('smtp test-email action reports validation and success states', async () => {
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
    const csrf = await fetchCsrfToken(app, '/admin/settings', adminCookie);

    const invalidRecipient = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp/test',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ to: 'not-an-email', csrfToken: csrf })
    });
    expect(invalidRecipient.statusCode).toBe(303);
    expect(String(invalidRecipient.headers.location)).toContain('testErr=');
    expect(decodeURIComponent(String(invalidRecipient.headers.location))).toContain('Valid recipient email is required');

    // Ensure DB-over-env precedence lets us intentionally clear SMTP so test-mode sendEmail
    // uses the non-SMTP path and succeeds deterministically.
    const clearSmtp = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        host: '',
        port: '587',
        user: '',
        pass: '',
        fromName: '',
        fromEmail: '',
        csrfToken: csrf
      })
    });
    expect(clearSmtp.statusCode).toBe(303);

    const missingConfig = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp/test',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ to: 'admin@example.com', csrfToken: csrf })
    });
    expect(missingConfig.statusCode).toBe(303);
    expect(String(missingConfig.headers.location)).toContain('testErr=');
    expect(decodeURIComponent(String(missingConfig.headers.location))).toContain('SMTP is not configured');

    const saveSmtp = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({
        host: 'smtp.example.com',
        port: '465',
        secure: 'on',
        user: 'mailer-user',
        pass: 'secret-one',
        fromName: 'LocalShifts Mailer',
        fromEmail: 'no-reply@example.com',
        csrfToken: csrf
      })
    });
    expect(saveSmtp.statusCode).toBe(303);

    // In test env this succeeds without external SMTP delivery.
    const ok = await app.inject({
      method: 'POST',
      url: '/admin/settings/smtp/test',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formEncode({ to: 'admin@example.com', csrfToken: csrf })
    });
    expect(ok.statusCode).toBe(303);
    expect(String(ok.headers.location)).toContain('testOk=');
    expect(decodeURIComponent(String(ok.headers.location))).toContain('Test email sent to admin@example.com');
  });
});
