import nodemailer from 'nodemailer';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { config } from './config.js';
import type { DB } from './db.js';
import { decryptSettingValue } from './settings_crypto.js';

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

const SYSTEM_SETTING_SMTP_HOST = 'SMTP_HOST';
const SYSTEM_SETTING_SMTP_PORT = 'SMTP_PORT';
const SYSTEM_SETTING_SMTP_SECURE = 'SMTP_SECURE';
const SYSTEM_SETTING_SMTP_USER = 'SMTP_USER';
const SYSTEM_SETTING_SMTP_PASS = 'SMTP_PASS';
const SYSTEM_SETTING_SMTP_FROM_NAME = 'SMTP_FROM_NAME';
const SYSTEM_SETTING_SMTP_FROM_EMAIL = 'SMTP_FROM_EMAIL';

export type ResolvedSmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
};

function parseBooleanSetting(raw: string | null): boolean | null {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return null;
}

export async function resolveSmtpConfig(db?: Kysely<DB>): Promise<ResolvedSmtpConfig> {
  const rawByKey = new Map<string, string>();

  if (db) {
    const rows = await db
      .selectFrom('system_settings')
      .select(['key'])
      .select((eb) => sql<string>`convert_from(${eb.ref('value_encrypted')}::bytea, 'UTF8')`.as('value'))
      .where('key', 'in', [
        SYSTEM_SETTING_SMTP_HOST,
        SYSTEM_SETTING_SMTP_PORT,
        SYSTEM_SETTING_SMTP_SECURE,
        SYSTEM_SETTING_SMTP_USER,
        SYSTEM_SETTING_SMTP_PASS,
        SYSTEM_SETTING_SMTP_FROM_NAME,
        SYSTEM_SETTING_SMTP_FROM_EMAIL
      ])
      .execute();

    for (const row of rows as Array<{ key: string; value: string }>) {
      rawByKey.set(row.key, decryptSettingValue(String(row.value ?? ''), config.settingsEncryptionKey));
    }
  }

  const host = rawByKey.has(SYSTEM_SETTING_SMTP_HOST) ? String(rawByKey.get(SYSTEM_SETTING_SMTP_HOST) ?? '') : config.smtp.host;
  const portRaw = rawByKey.has(SYSTEM_SETTING_SMTP_PORT)
    ? String(rawByKey.get(SYSTEM_SETTING_SMTP_PORT) ?? '')
    : String(config.smtp.port ?? 587);
  const secureRaw = rawByKey.has(SYSTEM_SETTING_SMTP_SECURE)
    ? String(rawByKey.get(SYSTEM_SETTING_SMTP_SECURE) ?? '')
    : (config.smtp.secure ? 'true' : 'false');
  const user = rawByKey.has(SYSTEM_SETTING_SMTP_USER) ? String(rawByKey.get(SYSTEM_SETTING_SMTP_USER) ?? '') : config.smtp.user;
  const pass = rawByKey.has(SYSTEM_SETTING_SMTP_PASS) ? String(rawByKey.get(SYSTEM_SETTING_SMTP_PASS) ?? '') : config.smtp.pass;
  const fromName = rawByKey.has(SYSTEM_SETTING_SMTP_FROM_NAME)
    ? String(rawByKey.get(SYSTEM_SETTING_SMTP_FROM_NAME) ?? '')
    : config.smtp.fromName;
  const fromEmail = rawByKey.has(SYSTEM_SETTING_SMTP_FROM_EMAIL)
    ? String(rawByKey.get(SYSTEM_SETTING_SMTP_FROM_EMAIL) ?? '')
    : config.smtp.fromEmail;

  const parsedPort = Number(portRaw);
  const port = Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? Math.floor(parsedPort) : 587;
  const secure = parseBooleanSetting(secureRaw) ?? false;

  return {
    host: host.trim(),
    port,
    secure,
    user: user.trim(),
    pass: pass.trim(),
    fromName: fromName.trim() || 'LocalShifts',
    fromEmail: fromEmail.trim()
  };
}

export async function canSendEmail(db?: Kysely<DB>): Promise<boolean> {
  const smtp = await resolveSmtpConfig(db);
  if (smtp.host && smtp.fromEmail) return true;
  if (config.env === 'development') return true; // dev can log or optionally use sendmail
  if (config.env === 'test') return false;
  return false;
}

function redactEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '[redacted]';
  const maskedLocal = local.length <= 2 ? `${local[0] ?? ''}*` : `${local.slice(0, 2)}***`;
  return `${maskedLocal}@${domain}`;
}

function fromHeader(smtp: ResolvedSmtpConfig): string {
  const fromEmail = smtp.fromEmail;
  const fromName = smtp.fromName;
  if (fromEmail) return fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  // Dev fallback so local sendmail has something sane.
  if (config.env === 'development') return `"${fromName || 'LocalShifts'}" <no-reply@localhost>`;
  return '';
}

export async function sendEmail(msg: EmailMessage, options?: { db?: Kysely<DB> }): Promise<void> {
  const smtp = await resolveSmtpConfig(options?.db);
  const from = fromHeader(smtp);

  // Tests should never attempt external SMTP.
  if (config.env === 'test') {
    // eslint-disable-next-line no-console
    console.log('[email:test]', { to: redactEmail(msg.to), subject: msg.subject, text: msg.text, html: msg.html });
    return;
  }

  // SMTP (staging/production, or dev if explicitly configured)
  if (smtp.host && smtp.fromEmail) {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      // Prevent hanging requests if the SMTP endpoint is unreachable or stalls.
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000
    });

    await transporter.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html
    });
    return;
  }

  // Local dev optional: try system sendmail (works only if the runtime has a local MTA).
  // This is opt-in because many dev setups run in containers without sendmail installed.
  const wantSendmail =
    config.env === 'development' && (process.env.EMAIL_TRANSPORT === 'sendmail' || Boolean(process.env.SENDMAIL_PATH));
  if (wantSendmail) {
    try {
      const transporter = nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: process.env.SENDMAIL_PATH || undefined
      } as any);

      await transporter.sendMail({
        from: from || `"LocalShifts" <no-reply@localhost>`,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html
      });
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[email:dev] sendmail transport failed; falling back to console log', err);
      // Fall through to console logging below.
    }
  }

  // In non-dev environments, missing SMTP config is an error (don't silently "send").
  if (config.env !== 'development') {
    throw new Error('Email sending is not configured.');
  }

  // eslint-disable-next-line no-console
  console.log('[email:dev]', { to: redactEmail(msg.to), subject: msg.subject, text: msg.text, html: msg.html });
}
