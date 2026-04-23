export type AppEnv = 'development' | 'test' | 'staging' | 'production';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const env = (process.env.APP_ENV as AppEnv | undefined) ?? 'development';
const port = Number(process.env.APP_PORT ?? '3000');

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  return undefined;
}

function envOrDevDefault(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (env === 'development' || env === 'test') return devDefault;
  throw new Error(`Missing required env var: ${name}`);
}

function resolveTimezone(): string {
  const timezone = process.env.APP_TIMEZONE ?? 'America/New_York';
  try {
    // Throws for unknown/invalid IANA timezone values.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid APP_TIMEZONE: ${timezone}`);
  }
  return timezone;
}

export const config = {
  env,
  port,
  appUrl: envOrDevDefault('APP_URL', `http://localhost:${port}`),
  trustProxy: envBool('TRUST_PROXY') ?? (env === 'staging' || env === 'production'),
  timezone: resolveTimezone(),
  databaseUrl: requireEnv('DATABASE_URL'),
  sessionSecret: requireEnv('SESSION_SECRET'),
  settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || requireEnv('SESSION_SECRET'),
  adminToken: process.env.ADMIN_TOKEN ?? '',
  logFile: process.env.APP_LOG_FILE ?? '',
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    fromName: process.env.SMTP_FROM_NAME ?? 'LocalShifts',
    fromEmail: process.env.SMTP_FROM_EMAIL ?? ''
  }
} as const;
