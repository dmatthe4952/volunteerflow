import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import statik from '@fastify/static';
import fastifyView from '@fastify/view';
import nunjucks from 'nunjucks';
import { config } from './config.js';
import type { DB, EventCategory } from './db.js';
import { runMigrations } from './migrations.js';
import {
  cancelSignup,
  createSignup,
  findActiveSignupByCancelToken,
  getPublicEventBySlugOrIdForViewer,
  listPublicEventTags,
  listPublicEventOrganizations,
  listPublicEventsFiltered,
  listPastPublicEvents,
  listViewerActiveSignups,
  requestMySignupsToken,
  verifyMySignupsToken
} from './public.js';
import { cancelEventAndNotify, requireAdminToken } from './ops.js';
import { canSendEmail, sendEmail, resolveSmtpConfig } from './email.js';
import { decryptSettingValue, encryptSettingValue } from './settings_crypto.js';
import {
  authenticateUser,
  createSession,
  createUser,
  deleteSession,
  hasAnySuperAdmin,
  loadCurrentUserFromSession,
  recordLoginAudit,
  SESSION_ABSOLUTE_TIMEOUT_MS
} from './auth.js';
import {
  sendCancellationEmails,
  sendManagerRemovalNotice,
  sendSignupConfirmation,
  sendSignupConfirmationWithKind
} from './notifications.js';
import { compileNunjucksTemplates } from './templates.js';
import { setEventTags, syncUnderstaffedTagForEvent } from './tags.js';
import { purgeEventVolunteerPII } from './purge.js';
import { createGeoIpLookup } from './geoip.js';

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function extractHexToken(input: string): string | null {
  const trimmed = input.trim();
  const direct = trimmed.match(/^[a-f0-9]{64}$/i);
  if (direct) return trimmed.toLowerCase();
  const fromUrl = trimmed.match(/\/my\/verify\/([a-f0-9]{64})/i) ?? trimmed.match(/\/cancel\/([a-f0-9]{64})/i);
  if (fromUrl?.[1]) return fromUrl[1].toLowerCase();
  return null;
}

function imageExtFromMime(mime: string): string | null {
  const m = String(mime ?? '').toLowerCase().trim();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return null;
}

function imageExtFromMagicBytes(buf: Buffer): string | null {
  if (buf.length >= 8) {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (pngSig.every((b, i) => buf[i] === b)) return 'png';
  }
  if (buf.length >= 3) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  }
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (buf.length >= 12) {
    const riff = buf.subarray(0, 4).toString('ascii');
    const webp = buf.subarray(8, 12).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') return 'webp';
  }
  return null;
}

function readSignedCookie(req: any, name: string): string | null {
  const raw = req?.cookies?.[name];
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const res = req.unsignCookie(raw);
    if (res?.valid && typeof res.value === 'string') return res.value;
  } catch {
    // ignore
  }
  return null;
}

function createCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function buildApp(params: {
  db: Kysely<DB>;
  projectRoot?: string;
  runMigrations?: boolean;
  logger?: boolean;
}) {
  let logger: any = params.logger ?? true;
  if (logger && config.logFile) {
    try {
      fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
      const stream = fs.createWriteStream(config.logFile, { flags: 'a' });
      logger = { level: 'info', stream };
    } catch {
      // Fallback to stdout logging if file logging can't be initialized.
      logger = true;
    }
  }

  const app = Fastify({ logger, trustProxy: config.trustProxy });
  const geoIpLookup = createGeoIpLookup({
    dbPath: config.geoipDbPath,
    log: (line, err) => app.log.warn({ err }, line)
  });
  const projectRoot = params.projectRoot ?? process.cwd();
  const eventImagesDir = path.join(projectRoot, 'uploads', 'event-images');
  const addEventRequestsDir = path.join(projectRoot, 'uploads', 'add-event-requests');
  fs.mkdirSync(eventImagesDir, { recursive: true });
  if (config.env === 'development' || config.env === 'test') {
    fs.mkdirSync(addEventRequestsDir, { recursive: true });
  }
  const defaultEventImageName = 'default_volunteers.png';
  try {
    const source = path.join(projectRoot, 'public', 'images', defaultEventImageName);
    const target = path.join(eventImagesDir, defaultEventImageName);
    if (!fs.existsSync(target) && fs.existsSync(source)) fs.copyFileSync(source, target);
  } catch {
    // ignore
  }

  app.decorateRequest('currentUser', null);

  app.setErrorHandler(async (err: any, req: any, reply: any) => {
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    const requestId = req?.id;

    // Always log the full error server-side (including stack).
    try {
      app.log.error(
        {
          err,
          statusCode,
          requestId,
          method: req?.method,
          url: req?.url
        },
        'request failed'
      );
    } catch {
      // ignore
    }

    if (reply.sent) return;

    const accept = typeof req?.headers?.accept === 'string' ? req.headers.accept : '';
    const wantsHtml = accept.includes('text/html');
    const publicHtml =
      req?.method === 'GET' &&
      (req?.url === '/' ||
        req?.url?.startsWith?.('/events/') ||
        req?.url?.startsWith?.('/my') ||
        req?.url?.startsWith?.('/cancel/') ||
        req?.url?.startsWith?.('/admin/') ||
        req?.url?.startsWith?.('/manager/'));

    const safeMessage =
      config.env === 'development' || config.env === 'test'
        ? String(err?.message ?? err)
        : 'Something went wrong. Please try again in a moment.';

    if (wantsHtml && publicHtml) {
      return reply.code(statusCode).view('error.njk', {
        statusCode,
        message: safeMessage,
        requestId: requestId ? String(requestId) : ''
      });
    }

    return reply.code(statusCode).send({
      statusCode,
      error: statusCode >= 500 ? 'Internal Server Error' : 'Error',
      message: safeMessage,
      requestId: requestId ? String(requestId) : ''
    });
  });

  app.addHook('onRequest', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    reply.header('cross-origin-opener-policy', 'same-origin');

    if ((config.env === 'staging' || config.env === 'production') && config.appUrl.startsWith('https://')) {
      reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
    }
  });

  app.addHook('onClose', async () => {
    await params.db.destroy();
  });

  if (params.runMigrations ?? true) {
    await runMigrations({
      databaseUrl: config.databaseUrl,
      migrationsDir: path.join(projectRoot, 'migrations'),
      log: (line) => app.log.info(line)
    });
  }

  const SYSTEM_SETTING_PAST_EVENTS_ENABLED = 'PAST_EVENTS_ENABLED';
  const SYSTEM_SETTING_DEFAULT_PURGE_DAYS = 'DEFAULT_PURGE_DAYS';
  const SYSTEM_SETTING_SMTP_HOST = 'SMTP_HOST';
  const SYSTEM_SETTING_SMTP_PORT = 'SMTP_PORT';
  const SYSTEM_SETTING_SMTP_SECURE = 'SMTP_SECURE';
  const SYSTEM_SETTING_SMTP_USER = 'SMTP_USER';
  const SYSTEM_SETTING_SMTP_PASS = 'SMTP_PASS';
  const SYSTEM_SETTING_SMTP_FROM_NAME = 'SMTP_FROM_NAME';
  const SYSTEM_SETTING_SMTP_FROM_EMAIL = 'SMTP_FROM_EMAIL';
  const defaultPastEventsEnabled = config.env === 'staging' || config.env === 'development' || config.env === 'test';

  function parseBooleanSetting(raw: string | null): boolean | null {
    if (raw == null) return null;
    const v = String(raw).trim().toLowerCase();
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return null;
  }

  async function getSystemSetting(key: string): Promise<string | null> {
    const row = await params.db
      .selectFrom('system_settings')
      .select((eb) => sql<string>`convert_from(${eb.ref('value_encrypted')}::bytea, 'UTF8')`.as('value'))
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row?.value) return null;
    return decryptSettingValue(String(row.value), config.settingsEncryptionKey);
  }

  async function setSystemSetting(key: string, value: string, opts?: { encryptAtRest?: boolean }) {
    const toStore = opts?.encryptAtRest ? encryptSettingValue(value, config.settingsEncryptionKey) : value;
    await params.db
      .insertInto('system_settings')
      .values({ key, value_encrypted: sql<Buffer>`convert_to(${toStore}, 'UTF8')` as any })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value_encrypted: sql<Buffer>`convert_to(${toStore}, 'UTF8')`, updated_at: sql`now()` })
      )
      .execute();
  }

  async function getPastEventsEnabled(): Promise<boolean> {
    const parsed = parseBooleanSetting(await getSystemSetting(SYSTEM_SETTING_PAST_EVENTS_ENABLED));
    if (parsed != null) return parsed;
    await setSystemSetting(SYSTEM_SETTING_PAST_EVENTS_ENABLED, defaultPastEventsEnabled ? 'true' : 'false');
    return defaultPastEventsEnabled;
  }

  async function getDefaultPurgeAfterDays(): Promise<number> {
    const raw = await getSystemSetting(SYSTEM_SETTING_DEFAULT_PURGE_DAYS);
    const parsed = Number(String(raw ?? '').trim());
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 3650) return Math.floor(parsed);
    return 7;
  }

  async function getSmtpSettingsForAdmin() {
    const host = (await getSystemSetting(SYSTEM_SETTING_SMTP_HOST)) ?? config.smtp.host;
    const portRaw = (await getSystemSetting(SYSTEM_SETTING_SMTP_PORT)) ?? String(config.smtp.port ?? 587);
    const secureRaw = (await getSystemSetting(SYSTEM_SETTING_SMTP_SECURE)) ?? (config.smtp.secure ? 'true' : 'false');
    const user = (await getSystemSetting(SYSTEM_SETTING_SMTP_USER)) ?? config.smtp.user;
    const pass = await getSystemSetting(SYSTEM_SETTING_SMTP_PASS);
    const fromName = (await getSystemSetting(SYSTEM_SETTING_SMTP_FROM_NAME)) ?? config.smtp.fromName;
    const fromEmail = (await getSystemSetting(SYSTEM_SETTING_SMTP_FROM_EMAIL)) ?? config.smtp.fromEmail;

    const portNum = Number(portRaw);
    const port = Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535 ? Math.floor(portNum) : 587;
    const secure = String(secureRaw).trim().toLowerCase() === 'true';

    return {
      host: String(host ?? '').trim(),
      port,
      secure,
      user: String(user ?? '').trim(),
      pass: String(pass ?? '').trim(),
      fromName: String(fromName ?? '').trim(),
      fromEmail: String(fromEmail ?? '').trim()
    };
  }

  async function ensureSystemSettingsOnStartup() {
    await getPastEventsEnabled();
  }

  await ensureSystemSettingsOnStartup();

  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024
    }
  });

  app.addHook('preHandler', async (req) => {
    const raw = (req as any)?.cookies?.vf_sess;
    if (typeof raw !== 'string' || !raw) return;
    try {
      const res = (req as any).unsignCookie(raw);
      if (!res?.valid || typeof res.value !== 'string') return;
      const user = await loadCurrentUserFromSession(params.db, res.value);
      (req as any).currentUser = user;
    } catch {
      // ignore
    }
  });

  app.addHook('preHandler', async (req, reply) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    const pathOnly = String(req.url ?? '').split('?')[0] ?? '';
    if (!pathOnly.startsWith('/admin') && !pathOnly.startsWith('/manager')) return;

    if (pathOnly === '/admin/setup') return;

    const currentUser = (req as any).currentUser;
    if (!currentUser || (currentUser.role !== 'super_admin' && currentUser.role !== 'event_manager')) return;

    const expectedToken = readSignedCookie(req, 'vf_csrf');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bodyToken = typeof body.csrfToken === 'string' ? body.csrfToken : '';
    const headerTokenRaw = req.headers['x-csrf-token'];
    const headerToken = typeof headerTokenRaw === 'string' ? headerTokenRaw : '';
    const providedToken = bodyToken || headerToken;

    if (!expectedToken || !providedToken || providedToken !== expectedToken) {
      return reply.code(403).view('error.njk', { message: 'Invalid CSRF token. Please refresh and try again.' });
    }
  });

  await app.register(statik, {
    root: path.join(projectRoot, 'public'),
    prefix: '/public/'
  });

  await app.register(statik, {
    root: eventImagesDir,
    prefix: '/event-images/',
    decorateReply: false
  });

  await app.register(fastifyView, {
    engine: { nunjucks },
    root: path.join(projectRoot, 'views')
  });

  app.get('/healthz', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  nunjucks.configure(path.join(projectRoot, 'views'), {
    autoescape: true,
    noCache: config.env === 'development'
  });

  async function render(reply: any, template: string, data: any) {
    const currentUser = (reply.request as any).currentUser ?? null;
    let csrfToken: string | null = null;
    if (currentUser && (currentUser.role === 'super_admin' || currentUser.role === 'event_manager')) {
      csrfToken = readSignedCookie(reply.request, 'vf_csrf');
      if (!csrfToken) {
        csrfToken = createCsrfToken();
        reply.setCookie('vf_csrf', csrfToken, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: config.env !== 'development',
          signed: true,
          maxAge: Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)
        });
      }
    }
    return reply.view(template, { ...data, currentUser, csrfToken });
  }

  function requireRole(req: any, role: 'super_admin' | 'event_manager') {
    const user = (req as any).currentUser;
    if (!user || user.role !== role) {
      const err: any = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    return user;
  }

  function slugify(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 120);
  }

  async function uniqueEventSlug(base: string): Promise<string> {
    const root = slugify(base) || 'event';
    let slug = root;
    for (let i = 2; i < 50; i++) {
      const exists = await params.db
        .selectFrom('events')
        .select(['id'])
        .where('slug', '=', slug)
        .executeTakeFirst();
      if (!exists) return slug;
      slug = `${root}-${i}`;
    }
    return `${root}-${Date.now()}`;
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }

  function escapeHtmlAllowBasicFormatting(s: string): string {
    // Allow only a tiny, safe subset of tags (no attributes).
    // Everything else is escaped.
    const tokens: Array<{ token: string; html: string }> = [];
    let i = 0;
    const tokenized = s.replace(/<\/?\s*(strong|b|em|i)\s*>/gi, (m, tagRaw) => {
      const tag = String(tagRaw ?? '').toLowerCase();
      const isClose = m.trim().startsWith('</');
      const html =
        tag === 'strong' || tag === 'b'
          ? isClose
            ? '</strong>'
            : '<strong>'
          : tag === 'em' || tag === 'i'
            ? isClose
              ? '</em>'
              : '<em>'
            : '';
      if (!html) return m;
      const token = `[[VF_TAG_${i++}_${crypto.randomBytes(4).toString('hex')}]]`;
      tokens.push({ token, html });
      return token;
    });

    let out = escapeHtml(tokenized);
    for (const t of tokens) out = out.replaceAll(t.token, t.html);
    return out;
  }

  function unescapeHtml(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'");
  }

  function descriptionTextToHtml(text: string): string | null {
    const t = text.trim();
    if (!t) return null;
    const escaped = escapeHtmlAllowBasicFormatting(t);
    const paragraphs = escaped
      .split(/\n\s*\n/g)
      .map((p) => p.trim().replace(/\n/g, '<br />'))
      .filter(Boolean);
    return paragraphs.map((p) => `<p>${p}</p>`).join('');
  }

  function parseDateOnly(value: string): string {
    const v = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Invalid date.');
    return v;
  }

  function parsePurgeAfterDays(value: unknown): number | null {
    const v = String(value ?? '').trim();
    if (!v) return null;
    if (!/^\d+$/.test(v)) throw new Error('Purge window must be a whole number of days.');
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 3650) throw new Error('Purge window must be between 0 and 3650 days.');
    return Math.floor(n);
  }

  function parseTime(value: string): { hh: number; mm: number } {
    const v = value.trim();
    const m = v.match(/^(\d{2}):(\d{2})/);
    if (!m) throw new Error('Invalid time.');
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new Error('Invalid time.');
    return { hh, mm };
  }

  function endTimeFromStartAndDuration(start: string, durationMinutes: number): string {
    const { hh, mm } = parseTime(start);
    const startMinutes = hh * 60 + mm;
    const endMinutes = startMinutes + durationMinutes;
    if (endMinutes <= startMinutes) throw new Error('Shift must end after start time.');
    if (endMinutes > 24 * 60) throw new Error('Shift cannot cross midnight.');
    const eh = Math.floor(endMinutes / 60);
    const em = endMinutes % 60;
    return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00`;
  }

  function toIso(value: unknown): string {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value ?? '');
    return d.toISOString();
  }

  function toDateOnly(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') {
      const v = value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
    }
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
  }

  function formatDateTimeInAppTimezone(value: unknown): string {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value ?? '');
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      }).format(d);
    } catch {
      return d.toISOString();
    }
  }

  function parseTagsInput(raw: string): string[] {
    const normalizeTag = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const parts = String(raw ?? '')
      .split(/[,;\n]+/)
      .map((p) => normalizeTag(p))
      .filter(Boolean);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const t of parts) {
      if (t.length > 40) throw new Error('Tags are too long (max 40 characters each).');
      if (seen.has(t)) continue;
      seen.add(t);
      deduped.push(t);
      if (deduped.length > 20) throw new Error('Too many tags (max 20).');
    }
    return deduped;
  }

  function parseTagNameInput(raw: unknown): { name: string; slug: string } {
    const normalized = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
    if (!normalized) throw new Error('Tag name is required.');
    if (normalized.length > 40) throw new Error('Tag name is too long (max 40 characters).');
    const slug = slugify(normalized).slice(0, 60);
    if (!slug) throw new Error('Tag name must include letters or numbers.');
    return { name: normalized, slug };
  }

  async function syncUnderstaffed(eventId: string) {
    try {
      await syncUnderstaffedTagForEvent({ db: params.db, eventId });
    } catch (err) {
      app.log.warn({ err, eventId }, 'understaffed tag sync failed');
    }
  }

  function parseRadiusMiles(raw: unknown): number | null {
    const v = String(raw ?? '').trim().toLowerCase();
    if (!v || v === 'all' || v === 'show-all') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return 20;
    if (n <= 0) return 20;
    if (n > 200) return 200;
    return Math.round(n);
  }

  function parseCoord(raw: unknown): number | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  function isInvalidCoordPair(lat: number, lng: number): boolean {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return true;
    // Defensive guard: old bad cookie state could persist as (0,0).
    if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return true;
    return false;
  }

  function parseZip(raw: unknown): string | null {
    const v = String(raw ?? '').trim();
    const m = v.match(/^\d{5}$/);
    return m ? m[0] : null;
  }

  type PublicLocationCookie = {
    mode: 'zip' | 'geo' | 'ip';
    lat: number;
    lng: number;
    radiusMiles: number | null;
    zip?: string;
    label?: string;
  };

  function parsePublicLocationCookie(raw: string | null): PublicLocationCookie | null {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as PublicLocationCookie;
      if (!v || (v.mode !== 'zip' && v.mode !== 'geo' && v.mode !== 'ip')) return null;
      if (isInvalidCoordPair(v.lat, v.lng)) return null;
      return {
        ...v,
        radiusMiles:
          v.radiusMiles == null
            ? null
            : Number.isFinite(Number(v.radiusMiles))
              ? Math.round(Number(v.radiusMiles))
              : 20
      };
    } catch {
      return null;
    }
  }

  function getIpApproxLocationFromHeaders(req: any): { lat: number; lng: number; label: string } | null {
    const h = req?.headers ?? {};
    const cityRaw =
      (typeof h['cf-ipcity'] === 'string' ? h['cf-ipcity'] : '') ||
      (typeof h['x-vercel-ip-city'] === 'string' ? h['x-vercel-ip-city'] : '');
    const regionRaw =
      (typeof h['cf-region-code'] === 'string' ? h['cf-region-code'] : '') ||
      (typeof h['cf-region'] === 'string' ? h['cf-region'] : '') ||
      (typeof h['x-vercel-ip-country-region'] === 'string' ? h['x-vercel-ip-country-region'] : '');
    const lat = parseCoord(
      (typeof h['cf-iplatitude'] === 'string' ? h['cf-iplatitude'] : '') ||
        (typeof h['x-vercel-ip-latitude'] === 'string' ? h['x-vercel-ip-latitude'] : '')
    );
    const lng = parseCoord(
      (typeof h['cf-iplongitude'] === 'string' ? h['cf-iplongitude'] : '') ||
        (typeof h['x-vercel-ip-longitude'] === 'string' ? h['x-vercel-ip-longitude'] : '')
    );
    if (lat == null || lng == null) return null;
    if (isInvalidCoordPair(lat, lng)) return null;

    const city = cityRaw.trim();
    const region = regionRaw.trim();
    const label = city && region ? `${city}, ${region}` : city || region || 'your area';
    return { lat, lng, label };
  }

  async function getIpApproxLocation(req: any): Promise<{ lat: number; lng: number; label: string } | null> {
    const geoIp = await geoIpLookup.lookup(req);
    if (geoIp && !isInvalidCoordPair(geoIp.lat, geoIp.lng)) return geoIp;
    return getIpApproxLocationFromHeaders(req);
  }

  async function geocodeUsZip(zip: string): Promise<{ lat: number; lng: number; label: string } | null> {
    const normalizeZip = (value: unknown): string | null => {
      const m = String(value ?? '').match(/\b(\d{5})\b/);
      return m?.[1] ?? null;
    };
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    try {
      const url =
        `https://nominatim.openstreetmap.org/search?` +
        `postalcode=${encodeURIComponent(zip)}&countrycodes=us&addressdetails=1&format=jsonv2&limit=5`;
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'LocalShifts/0.1 (https://www.trtechapp.com)'
        }
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Array<Record<string, unknown>>;
      const rows = Array.isArray(body) ? body : [];
      const matched = rows.find((row) => {
        const addr = row.address as Record<string, unknown> | undefined;
        const zipFromAddr = normalizeZip(addr?.postcode);
        const zipFromDisplay = normalizeZip(row.display_name);
        const returnedZip = zipFromAddr ?? zipFromDisplay;
        return returnedZip === zip;
      });
      if (!matched) return null;
      const lat = Number(matched.lat);
      const lng = Number(matched.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const display = typeof matched.display_name === 'string' ? matched.display_name : '';
      const firstPart = display.split(',')[0]?.trim() || '';
      const label = firstPart ? `${firstPart} (${zip})` : `ZIP ${zip}`;
      return { lat, lng, label };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  function parseCoordsFromMapUrl(rawUrl: string | null | undefined): { lat: number; lng: number } | null {
    const text = String(rawUrl ?? '').trim();
    if (!text) return null;

    const fromPair = (latRaw: string, lngRaw: string): { lat: number; lng: number } | null => {
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      if (isInvalidCoordPair(lat, lng)) return null;
      return { lat, lng };
    };

    const patterns = [
      /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
      /[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (!m) continue;
      const parsed = fromPair(m[1] ?? '', m[2] ?? '');
      if (parsed) return parsed;
    }
    return null;
  }

  async function geocodeLocationName(locationName: string): Promise<{ lat: number; lng: number } | null> {
    const variants = Array.from(
      new Set(
        [
          locationName,
          locationName.replace(/\s*,\s*/g, ', '),
          `${locationName.replace(/\s*,\s*/g, ', ')}, USA`,
          locationName.replace(/,\s*([A-Z]{2})(\b|$)/, ', $1')
        ]
          .map((v) => v.trim())
          .filter(Boolean)
      )
    );

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    try {
      for (const candidate of variants) {
        const url =
          'https://nominatim.openstreetmap.org/search?' +
          `q=${encodeURIComponent(candidate)}&countrycodes=us&format=jsonv2&limit=1`;
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'LocalShifts/0.1 (https://www.trtechapp.com)'
          }
        });
        if (!res.ok) continue;
        const body = (await res.json()) as Array<Record<string, unknown>>;
        const first = Array.isArray(body) ? body[0] : null;
        if (!first) continue;
        const lat = Number(first.lat);
        const lng = Number(first.lon);
        if (isInvalidCoordPair(lat, lng)) continue;
        return { lat, lng };
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  function isSpecificEnoughAddress(locationNameRaw: string): boolean {
    const v = String(locationNameRaw ?? '').trim();
    if (!v) return false;
    // Accept ZIP-inclusive addresses.
    if (/\b\d{5}(?:-\d{4})?\b/.test(v)) return true;
    // Accept common comma-separated formats that include a region/state signal.
    const parts = v
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts.slice(1).join(' ');
      // Region token can be two-letter state abbreviation or full state name.
      if (/\b[A-Za-z]{2}\b/.test(tail)) return true;
      if (
        /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/i.test(
          tail
        )
      ) {
        return true;
      }
    }
    return false;
  }

  async function resolveEventLocationCoords(locationNameRaw: string, locationMapUrlRaw: string): Promise<{ lat: number; lng: number } | null> {
    const locationName = String(locationNameRaw ?? '').trim();
    if (!locationName) return null;

    const fromMapUrl = parseCoordsFromMapUrl(locationMapUrlRaw);
    if (fromMapUrl) return fromMapUrl;

    if (config.env !== 'test' && !isSpecificEnoughAddress(locationName)) return null;
    if (config.env === 'test') return null;
    return geocodeLocationName(locationName);
  }

  app.get('/', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const showAll = qs.all === '1';
    const rawTag = typeof qs.tag === 'string' ? qs.tag.trim().toLowerCase() : '';
    const navTagsRaw = await listPublicEventTags(params.db);
    const navTags = navTagsRaw.map((t) => ({ value: t, q: encodeURIComponent(t) }));
    const allowed = new Set(navTagsRaw.map((t) => t.toLowerCase()));
    const tag = showAll ? null : rawTag && allowed.has(rawTag) ? rawTag : null;
    const orgOptions = await listPublicEventOrganizations(params.db);
    const orgAllowed = new Set(orgOptions.map((o) => o.slug.toLowerCase()));
    const rawOrg = typeof qs.org === 'string' ? qs.org.trim().toLowerCase() : '';
    const organizationSlug = rawOrg && orgAllowed.has(rawOrg) ? rawOrg : null;
    const clearLocation = String(qs.loc ?? '').trim().toLowerCase() === 'clear';
    const radiusRaw = String(qs.radius ?? '').trim();
    const radiusParsed = parseRadiusMiles(qs.radius);
    const radiusMiles = radiusRaw ? radiusParsed : 20;
    const zip = parseZip(qs.zip);
    const qLat = parseCoord(qs.lat);
    const qLng = parseCoord(qs.lng);
    const hasCoordQuery = qLat !== null && qLng !== null && !isInvalidCoordPair(qLat, qLng);

    let locationContext: {
      hasActiveFilter: boolean;
      label: string | null;
      radiusMiles: number | null;
      zip: string;
    } = { hasActiveFilter: false, label: null, radiusMiles, zip: zip ?? '' };
    let originLat: number | null = null;
    let originLng: number | null = null;
    let locationCookie: PublicLocationCookie | null = null;

    if (clearLocation) {
      reply.clearCookie('vf_loc', { path: '/', signed: true });
    } else if (zip) {
      const geocoded = await geocodeUsZip(zip);
      if (geocoded) {
        originLat = geocoded.lat;
        originLng = geocoded.lng;
        locationContext = {
          hasActiveFilter: true,
          label: geocoded.label,
          radiusMiles,
          zip
        };
        locationCookie = {
          mode: 'zip',
          lat: geocoded.lat,
          lng: geocoded.lng,
          radiusMiles,
          zip,
          label: geocoded.label
        };
      } else {
        // Avoid sticky stale origin when ZIP lookup fails.
        reply.clearCookie('vf_loc', { path: '/', signed: true });
        locationContext = {
          hasActiveFilter: false,
          label: null,
          radiusMiles,
          zip
        };
      }
    } else if (hasCoordQuery) {
      originLat = qLat;
      originLng = qLng;
      locationContext = {
        hasActiveFilter: true,
        label: 'your current location',
        radiusMiles,
        zip: ''
      };
      locationCookie = {
        mode: 'geo',
        lat: qLat,
        lng: qLng,
        radiusMiles,
        label: 'your current location'
      };
    } else {
      const cookieLoc = parsePublicLocationCookie(readSignedCookie(req, 'vf_loc'));
      if (cookieLoc) {
        originLat = cookieLoc.lat;
        originLng = cookieLoc.lng;
        locationContext = {
          hasActiveFilter: true,
          label: cookieLoc.label ?? (cookieLoc.zip ? `ZIP ${cookieLoc.zip}` : 'your saved location'),
          radiusMiles: cookieLoc.radiusMiles,
          zip: cookieLoc.zip ?? ''
        };
        locationCookie = cookieLoc;
      } else {
        const ipLoc = await getIpApproxLocation(req);
        if (ipLoc) {
          originLat = ipLoc.lat;
          originLng = ipLoc.lng;
          locationContext = {
            hasActiveFilter: true,
            label: ipLoc.label,
            radiusMiles: radiusMiles ?? 20,
            zip: ''
          };
          locationCookie = {
            mode: 'ip',
            lat: ipLoc.lat,
            lng: ipLoc.lng,
            radiusMiles: radiusMiles ?? 20,
            label: ipLoc.label
          };
        }
      }
    }

    if (locationCookie && !clearLocation) {
      reply.setCookie('vf_loc', JSON.stringify(locationCookie), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.env !== 'development',
        signed: true,
        maxAge: 60 * 60 * 24 * 30
      });
    }

    const events = await listPublicEventsFiltered(params.db, {
      tag,
      organizationSlug,
      originLat,
      originLng,
      radiusMiles: locationContext.hasActiveFilter ? locationContext.radiusMiles : null
    });
    const featuredByRecency = events
      .filter((e: any) => e.isFeatured)
      .sort((a: any, b: any) => Number(b.updatedAtEpoch ?? 0) - Number(a.updatedAtEpoch ?? 0));
    const featuredEvents = featuredByRecency.slice(0, 3);
    const featuredIds = new Set(featuredEvents.map((e: any) => String(e.id)));
    const otherEvents = events.filter((e: any) => !featuredIds.has(String(e.id)));
    const showSeedHint = config.env === 'development' || config.env === 'test';
    const pastEventsEnabled = await getPastEventsEnabled();
    return render(reply, 'index.njk', {
      featuredEvents,
      otherEvents,
      showSeedHint,
      navAddEventOnly: true,
      navTags,
      tag,
      orgOptions,
      selectedOrg: organizationSlug,
      pastEventsEnabled,
      locationContext
    });
  });

  app.get('/events/past', async (_req, reply) => {
    const pastEventsEnabled = await getPastEventsEnabled();
    if (!pastEventsEnabled) return reply.code(404).view('not_found.njk', { message: 'Not found.' });

    const events = await listPastPublicEvents(params.db);
    return render(reply, 'events_past.njk', {
      events,
      navAddEventOnly: true
    });
  });

  app.get('/add-event', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const flash =
      qs.ok === '1'
        ? { type: 'ok' as const, message: 'Thanks! We received your event request.' }
        : typeof qs.err === 'string'
          ? { type: 'err' as const, message: qs.err }
          : null;

    return render(reply, 'add_event.njk', {
      flash,
      values: { title: '', date: '', time: '', description: '', organization: '', organizer: '' }
    });
  });

  app.get('/sign-in', async (_req, reply) => {
    return reply.code(303).redirect('/login');
  });

  app.get('/forgot-password', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const raw = String(qs.role ?? '').trim().toLowerCase();
    const role = raw === 'admin' ? 'admin' : raw === 'manager' ? 'manager' : '';
    return render(reply, 'forgot_password.njk', { role });
  });

  app.post(
    '/add-event',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour'
        }
      }
    },
    async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = String(body.title ?? '').trim();
    const date = String(body.date ?? '').trim();
    const time = String(body.time ?? '').trim();
    const description = String(body.description ?? '').trim();
    const organization = String(body.organization ?? '').trim();
    const organizer = String(body.organizer ?? '').trim();

    try {
      if (!title || title.length > 200) throw new Error('Title is required (max 200 characters).');
      parseDateOnly(date);
      parseTime(time);
      if (description.length > 5000) throw new Error('Description is too long (max 5000 characters).');
      if (!organization || organization.length > 200) throw new Error('Organization is required (max 200 characters).');
      if (!organizer || organizer.length > 200) throw new Error('Organizer is required (max 200 characters).');

      const submittedAt = new Date().toISOString();
      const subject = `Add Event request: ${title}`;
      const bodyText = [
        `A new event was requested via the public Add Event form.`,
        ``,
        `Title: ${title}`,
        `Date: ${date}`,
        `Time: ${time}`,
        `Organization: ${organization}`,
        `Organizer: ${organizer}`,
        ``,
        `Description:`,
        description || '(none)',
        ``,
        `Submitted at: ${submittedAt}`
      ].join('\n');

      if (config.env === 'development' || config.env === 'test') {
        try {
          const safe = slugify(title) || 'event';
          const name = `${Date.now()}-${safe}-${crypto.randomBytes(4).toString('hex')}.txt`;
          fs.writeFileSync(path.join(addEventRequestsDir, name), `Subject: ${subject}\n\n${bodyText}\n`, 'utf8');
        } catch (err: any) {
          req.log.warn({ err }, 'failed to write add-event request to disk');
        }
      }

      const admins = await params.db
        .selectFrom('users')
        .select(['email'])
        .where('role', '=', 'super_admin')
        .where('is_active', '=', true)
        .orderBy('created_at', 'asc')
        .execute();
      const emails = admins.map((a) => a.email).filter(Boolean);
      if (emails.length === 0) {
        req.log.warn({ title, organization, organizer }, 'add-event submitted but no active super_admin users found');
      } else {
        for (const to of emails) {
          await sendEmail({ to, subject, text: bodyText }, { db: params.db });
        }
      }

      req.log.info({ title, date, time, organization, organizer }, 'add-event submitted');
      return reply.code(303).redirect('/add-event?ok=1');
    } catch (err: any) {
      return render(reply, 'add_event.njk', {
        flash: { type: 'err', message: String(err?.message ?? err) },
        values: { title, date, time, description, organization, organizer }
      });
    }
    }
  );

  app.get('/events/:slugOrId', async (req, reply) => {
    const { slugOrId } = req.params as { slugOrId: string };
    const viewerEmail = readSignedCookie(req, 'vf_email') ?? undefined;
    const event = await getPublicEventBySlugOrIdForViewer(params.db, slugOrId, viewerEmail);
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const qs = req.query as Record<string, string | undefined>;
    const flash =
      qs.ok === 'signup'
        ? { type: 'ok', message: 'You’re signed up!', shiftId: typeof qs.shift === 'string' ? qs.shift : undefined }
        : qs.err
          ? { type: 'err', message: qs.err, shiftId: typeof qs.shift === 'string' ? qs.shift : undefined }
          : null;

    return render(reply, 'event.njk', { event, flash, viewerEmail });
  });

  app.post('/events/:slugOrId/shifts/:shiftId/signup', async (req, reply) => {
    const { slugOrId, shiftId } = req.params as { slugOrId: string; shiftId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const firstName = String(body.firstName ?? '');
    const lastName = String(body.lastName ?? '');
    const email = String(body.email ?? '').trim();

    // Remember the volunteer's email on this device even if signup fails.
    if (email && email.length <= 120 && isValidEmail(email)) {
      reply.setCookie('vf_email', email, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.env !== 'development',
        signed: true,
        maxAge: 60 * 60 * 24 * 60 // 60 days
      });
    }

    try {
      const { token } = await createSignup({ db: params.db, shiftId, firstName, lastName, email });
      const shiftRow = await params.db.selectFrom('shifts').select(['event_id']).where('id', '=', shiftId).executeTakeFirst();
      if (shiftRow?.event_id) await syncUnderstaffed(shiftRow.event_id);
      app.log.info({ shiftId, email }, 'signup created');
      if (config.env === 'development' || config.env === 'test') {
        app.log.info({ shiftId, email, token }, 'signup token generated');
      }
      // Best-effort email; signup should still succeed even if email fails.
      try {
        const created = await params.db
          .selectFrom('signups')
          .select(['id'])
          .where('shift_id', '=', shiftId)
          .where(sql<boolean>`email_norm = ${email.toLowerCase()}`)
          .where('status', '=', 'active')
          .orderBy('created_at', 'desc')
          .executeTakeFirstOrThrow();
        await sendSignupConfirmation(params.db, created.id);
      } catch (err) {
        app.log.warn({ err }, 'signup confirmation email failed');
      }
      return reply.code(303).redirect(`/events/${encodeURIComponent(slugOrId)}?ok=signup#shift-${shiftId}`);
    } catch (err: any) {
      const rawMsg = err?.message ? String(err.message) : 'Unable to sign you up for that shift.';
      const msg =
        rawMsg === 'Sorry — this shift is full.'
          ? 'That shift just filled up. Please choose another shift.'
          : rawMsg;
      return reply
        .code(303)
        .redirect(
          `/events/${encodeURIComponent(slugOrId)}?err=${encodeURIComponent(msg)}&shift=${encodeURIComponent(shiftId)}#shift-${shiftId}`
        );
    }
  });

  app.get('/cancel/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const found = await findActiveSignupByCancelToken(params.db, token);
    if (!found) return reply.code(404).view('not_found.njk', { message: 'That cancellation link is not valid.' });
    if (found.expired) return reply.code(410).view('cancel_expired.njk');
    return render(reply, 'cancel_confirm.njk', { token, signup: found });
  });

  app.post('/cancel/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const found = await findActiveSignupByCancelToken(params.db, token);
    if (!found) return reply.code(404).view('not_found.njk', { message: 'That cancellation link is not valid.' });
    if (found.expired) return reply.code(410).view('cancel_expired.njk');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = typeof body.note === 'string' ? body.note : '';
    const res = await cancelSignup({ db: params.db, signupId: found.signupId, note });
    if (res.changed) {
      const signupRow = await params.db
        .selectFrom('signups')
        .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
        .select(['shifts.event_id'])
        .where('signups.id', '=', found.signupId)
        .executeTakeFirst();
      if (signupRow?.event_id) await syncUnderstaffed(signupRow.event_id);
      app.log.info({ signupId: found.signupId }, 'signup cancelled');
      try {
        await sendCancellationEmails(params.db, found.signupId, res.cancelledAt);
      } catch (err) {
        app.log.warn({ err }, 'cancellation emails failed');
      }
    }
    return render(reply, 'cancel_done.njk', { signup: found });
  });

  app.get('/my', async (req, reply) => {
    const viewerEmail = readSignedCookie(req, 'vf_email');
    const signups = viewerEmail ? await listViewerActiveSignups(params.db, viewerEmail) : [];
    const qs = req.query as Record<string, string | undefined>;
    const notice = qs.sent ? 'Check your email for your sign-in link.' : null;
    return render(reply, 'my_signups.njk', { viewerEmail, signups, notice });
  });

  app.post(
    '/my/request',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour'
        }
      }
    },
    async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '').trim();

    try {
      const { token, expiresAt } = await requestMySignupsToken(params.db, email);

      const verifyUrlOneTime = `${config.appUrl}/my/verify/${encodeURIComponent(token)}?remember=0`;

      if (config.env === 'development' || config.env === 'test') {
        app.log.info({ email, verifyUrlOneTime, expiresAt }, 'my-signups token created');
      } else {
        app.log.info({ email, expiresAt }, 'my-signups token created');
      }

      const hasSmtp = await canSendEmail(params.db);

      // In test we never send real email.
      // In development we show the shortcut only when SMTP isn't configured.
      if (config.env === 'test' || (config.env === 'development' && !hasSmtp)) {
        return render(reply, 'my_email_sent.njk', {
          email,
          verifyUrlOneTime,
          expiresAt: expiresAt.toISOString()
        });
      }

      if (!hasSmtp) {
        return reply.code(501).view('my_email_sent.njk', { email, error: 'Email sending is not configured yet.' });
      }

      await sendEmail({
        to: email,
        subject: 'Your LocalShifts sign-in link',
        text: [
          'Click to view signups:',
          '',
          verifyUrlOneTime,
          '',
          'This link can be used once and expires in 1 hour.'
        ].join('\n'),
        html: [
          '<p><a href="' + verifyUrlOneTime + '">Click to view signups</a></p>',
          '<p style="color:#666;font-size:14px;margin:0">This link can be used once and expires in 1 hour.</p>'
        ].join('\n')
      }, { db: params.db });

      return reply.code(303).redirect('/my?sent=1');
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : 'Unable to send link.';
      return render(reply, 'my_email_sent.njk', { email, error: msg });
    }
    }
  );

  app.get('/my/verify/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const verified = await verifyMySignupsToken(params.db, token, { consume: false });
    if (!verified) {
      const asCancel = await findActiveSignupByCancelToken(params.db, token);
      if (asCancel && asCancel.expired === false) return reply.code(303).redirect(`/cancel/${encodeURIComponent(token)}`);
      return reply.code(410).view('my_link_expired.njk');
    }
    if (verified.expired) return reply.code(410).view('my_link_expired.njk');

    const qs = req.query as Record<string, string | undefined>;
    const remember = qs.remember !== '0';
    return render(reply, 'my_verify_confirm.njk', {
      token,
      remember
    });
  });

  app.post('/my/verify/:token/confirm', async (req, reply) => {
    const { token } = req.params as { token: string };
    const verified = await verifyMySignupsToken(params.db, token);
    if (!verified) {
      const asCancel = await findActiveSignupByCancelToken(params.db, token);
      if (asCancel && asCancel.expired === false) return reply.code(303).redirect(`/cancel/${encodeURIComponent(token)}`);
      return reply.code(410).view('my_link_expired.njk');
    }
    if (verified.expired) return reply.code(410).view('my_link_expired.njk');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const remember = String(body.remember ?? '') === '1';

    if (remember) {
      reply.setCookie('vf_email', verified.email, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.env !== 'development',
        signed: true,
        maxAge: 60 * 60 * 24 * 60 // 60 days
      });
      return reply.code(303).redirect('/my');
    }

    const signups = await listViewerActiveSignups(params.db, verified.email);
    return render(reply, 'my_one_time.njk', { viewerEmail: verified.email, signups });
  });

  app.post('/my/verify', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tokenOrUrl = String(body.token ?? '');
    if (tokenOrUrl.includes('/cancel/')) {
      const token = extractHexToken(tokenOrUrl);
      if (token) return reply.code(303).redirect(`/cancel/${encodeURIComponent(token)}`);
    }
    const token = extractHexToken(tokenOrUrl);
    if (!token) return reply.code(400).view('my_link_expired.njk');

    const remember = body.remember === 'on';
    return reply.code(303).redirect(`/my/verify/${encodeURIComponent(token)}?remember=${remember ? '1' : '0'}`);
  });

  app.post('/my/clear', async (_req, reply) => {
    reply.clearCookie('vf_email', { path: '/', signed: true });
    return reply.code(303).redirect('/my');
  });

  // Admin/Manager auth + pages
  app.get('/admin/setup', async (req, reply) => {
    const user = (req as any).currentUser;
    if (user?.role === 'super_admin') return reply.code(303).redirect('/admin/dashboard');

    const anyAdmin = await hasAnySuperAdmin(params.db);
    if (anyAdmin) return reply.code(404).view('not_found.njk', { message: 'Not found.' });

    // Production guarded by x-admin-token; dev/test allowed.
    if (config.env !== 'development' && config.env !== 'test') requireAdminToken(req);
    return render(reply, 'admin_setup.njk', {});
  });

  app.post('/admin/setup', async (req, reply) => {
    const anyAdmin = await hasAnySuperAdmin(params.db);
    if (anyAdmin) return reply.code(404).view('not_found.njk', { message: 'Not found.' });
    if (config.env !== 'development' && config.env !== 'test') requireAdminToken(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const email = String(body.email ?? '');
      const displayName = String(body.displayName ?? '');
      const password = String(body.password ?? '');
      await createUser(params.db, { email, displayName, password, role: 'super_admin' });
      return reply.code(303).redirect('/login?role=admin');
    } catch (err: any) {
      return render(reply, 'admin_setup.njk', { error: String(err?.message ?? err) });
    }
  });

  function parseLoginRole(raw: unknown): 'super_admin' | 'event_manager' {
    const role = String(raw ?? '').trim().toLowerCase();
    return role === 'admin' ? 'super_admin' : 'event_manager';
  }

  function loginRoleHint(role: 'super_admin' | 'event_manager'): 'admin' | 'manager' {
    return role === 'super_admin' ? 'admin' : 'manager';
  }

  function dashboardByRole(role: 'super_admin' | 'event_manager'): string {
    return role === 'super_admin' ? '/admin/dashboard' : '/manager/dashboard';
  }

  async function handleLogin(req: any, reply: any, forcedRole?: 'super_admin' | 'event_manager') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');
    const role = forcedRole ?? parseLoginRole(body.role);
    const roleHint = loginRoleHint(role);

    const user = await authenticateUser(params.db, { email, password, role });
    if (!user) {
      await recordLoginAudit(params.db, {
        email,
        attemptedRole: role,
        success: false,
        ipAddress: req?.ip ?? null,
        userAgent: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null
      });
      return render(reply, 'login.njk', { error: 'Invalid email or password.', roleHint });
    }

    const sess = await createSession(params.db, { userId: user.id });
    await recordLoginAudit(params.db, {
      email: user.email,
      attemptedRole: role,
      userId: user.id,
      success: true,
      ipAddress: req?.ip ?? null,
      userAgent: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null
    });
    reply.setCookie('vf_sess', sess.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.env !== 'development',
      signed: true,
      maxAge: Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)
    });
    reply.setCookie('vf_csrf', createCsrfToken(), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.env !== 'development',
      signed: true,
      maxAge: Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)
    });
    return reply.code(303).redirect(dashboardByRole(role));
  }

  app.get('/login', async (req, reply) => {
    const user = (req as any).currentUser;
    if (user?.role === 'super_admin') return reply.code(303).redirect('/admin/dashboard');
    if (user?.role === 'event_manager') return reply.code(303).redirect('/manager/dashboard');
    const qs = req.query as Record<string, string | undefined>;
    const roleRaw = String(qs.role ?? '').trim().toLowerCase();
    const roleHint = roleRaw === 'admin' ? 'admin' : roleRaw === 'manager' ? 'manager' : 'manager';
    return render(reply, 'login.njk', { roleHint });
  });

  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes'
        }
      }
    },
    async (req, reply) => {
      return handleLogin(req, reply);
    }
  );

  app.post('/logout', async (req, reply) => {
    const raw = req?.cookies?.vf_sess;
    if (typeof raw === 'string' && raw) {
      try {
        const res = (req as any).unsignCookie(raw);
        if (res?.valid && typeof res.value === 'string') await deleteSession(params.db, res.value);
      } catch {
        // ignore
      }
    }
    reply.clearCookie('vf_sess', { path: '/', signed: true });
    reply.clearCookie('vf_csrf', { path: '/', signed: true });
    return reply.code(303).redirect('/');
  });

  app.get('/admin/dashboard', async (req, reply) => {
    requireRole(req, 'super_admin');
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;
    const events = await params.db.selectFrom('events').select((eb) => eb.fn.countAll<number>().as('c')).executeTakeFirst();
    const upcomingShifts = await params.db
      .selectFrom('shifts')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where(sql<boolean>`shift_date >= current_date and shift_date < current_date + interval '14 days'`)
      .executeTakeFirst();
    const signups30d = await params.db
      .selectFrom('signups')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where(sql<boolean>`created_at >= now() - interval '30 days'`)
      .executeTakeFirst();
    const recentLoginAudit = await params.db
      .selectFrom('login_audit as la')
      .leftJoin('users as u', 'u.id', 'la.user_id')
      .select([
        'la.id',
        'la.email',
        'la.attempted_role',
        'la.success',
        'la.ip_address',
        'la.user_agent',
        'la.created_at',
        'u.display_name as user_display_name'
      ])
      .orderBy('la.created_at', 'desc')
      .limit(10)
      .execute();
    const recentImpersonationAudit = await params.db
      .selectFrom('impersonation_log as il')
      .innerJoin('users as admin_user', 'admin_user.id', 'il.admin_user_id')
      .innerJoin('users as manager_user', 'manager_user.id', 'il.manager_user_id')
      .select([
        'il.id',
        'il.started_at',
        'il.ended_at',
        'il.ip_address',
        'il.user_agent',
        'admin_user.display_name as admin_display_name',
        'admin_user.email as admin_email',
        'manager_user.display_name as manager_display_name',
        'manager_user.email as manager_email'
      ])
      .orderBy('il.started_at', 'desc')
      .limit(10)
      .execute();
    const pastEventsEnabled = await getPastEventsEnabled();
    return render(reply, 'admin_dashboard.njk', {
      ok,
      error,
      pastEventsEnabled,
      stats: {
        events: Number(events?.c ?? 0),
        upcomingShifts: Number(upcomingShifts?.c ?? 0),
        signups30d: Number(signups30d?.c ?? 0)
      },
      recentLoginAudit: recentLoginAudit.map((row: any) => ({
        id: row.id,
        email: row.email,
        role: row.attempted_role,
        success: Boolean(row.success),
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: formatDateTimeInAppTimezone(row.created_at),
        userDisplayName: row.user_display_name
      })),
      recentImpersonationAudit: recentImpersonationAudit.map((row: any) => ({
        id: row.id,
        startedAt: formatDateTimeInAppTimezone(row.started_at),
        endedAt: row.ended_at ? formatDateTimeInAppTimezone(row.ended_at) : null,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        adminDisplayName: row.admin_display_name,
        adminEmail: row.admin_email,
        managerDisplayName: row.manager_display_name,
        managerEmail: row.manager_email
      }))
    });
  });

  app.post('/admin/settings/past-events', async (req, reply) => {
    requireRole(req, 'super_admin');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const enabled = String(body.enabled ?? '').trim().toLowerCase() === 'true';
    await setSystemSetting(SYSTEM_SETTING_PAST_EVENTS_ENABLED, enabled ? 'true' : 'false');
    const msg = enabled ? 'Past events archive enabled.' : 'Past events archive disabled.';
    return reply.code(303).redirect(`/admin/dashboard?ok=${encodeURIComponent(msg)}`);
  });

  app.get('/admin/settings', async (req, reply) => {
    requireRole(req, 'super_admin');
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;
    const testOk = typeof qs.testOk === 'string' ? qs.testOk : undefined;
    const testError = typeof qs.testErr === 'string' ? qs.testErr : undefined;
    const smtp = await getSmtpSettingsForAdmin();
    const currentUser = (req as any).currentUser;
    return render(reply, 'admin_settings.njk', {
      ok,
      error,
      testOk,
      testError,
      testRecipientDefault: String(currentUser?.email ?? '').trim(),
      smtp: {
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        user: smtp.user,
        fromName: smtp.fromName,
        fromEmail: smtp.fromEmail,
        hasPass: Boolean(smtp.pass)
      }
    });
  });

  app.post('/admin/settings/smtp', async (req, reply) => {
    requireRole(req, 'super_admin');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const host = String(body.host ?? '').trim();
    const portRaw = String(body.port ?? '').trim();
    const secure = String(body.secure ?? '').trim() === 'on' || String(body.secure ?? '').trim() === 'true';
    const user = String(body.user ?? '').trim();
    const passInput = String(body.pass ?? '');
    const fromName = String(body.fromName ?? '').trim();
    const fromEmail = String(body.fromEmail ?? '').trim();

    try {
      const port = Number(portRaw || '587');
      if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('SMTP port must be between 1 and 65535.');
      if (host.length > 255) throw new Error('SMTP host is too long.');
      if (user.length > 255) throw new Error('SMTP username is too long.');
      if (fromName.length > 120) throw new Error('From name is too long.');
      if (fromEmail && !isValidEmail(fromEmail)) throw new Error('From email is invalid.');
      if (host && !fromEmail) throw new Error('From email is required when SMTP host is set.');
      if (fromEmail && !host) throw new Error('SMTP host is required when From email is set.');

      const existing = await getSmtpSettingsForAdmin();
      const nextPass = passInput.trim() ? passInput.trim() : existing.pass;

      await setSystemSetting(SYSTEM_SETTING_SMTP_HOST, host, { encryptAtRest: true });
      await setSystemSetting(SYSTEM_SETTING_SMTP_PORT, String(Math.floor(port)), { encryptAtRest: true });
      await setSystemSetting(SYSTEM_SETTING_SMTP_SECURE, secure ? 'true' : 'false', { encryptAtRest: true });
      await setSystemSetting(SYSTEM_SETTING_SMTP_USER, user, { encryptAtRest: true });
      await setSystemSetting(SYSTEM_SETTING_SMTP_PASS, nextPass, { encryptAtRest: true });
      await setSystemSetting(SYSTEM_SETTING_SMTP_FROM_NAME, fromName, { encryptAtRest: true });
      await setSystemSetting(SYSTEM_SETTING_SMTP_FROM_EMAIL, fromEmail, { encryptAtRest: true });

      return reply.code(303).redirect(`/admin/settings?ok=${encodeURIComponent('SMTP settings saved.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/settings?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/admin/settings/smtp/test', async (req, reply) => {
    requireRole(req, 'super_admin');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = String(body.to ?? '').trim();
    const smtp = await resolveSmtpConfig(params.db);

    try {
      if (!to || !to.includes('@') || /\s/.test(to) || to.includes('\n') || to.includes('\r')) {
        throw new Error('Valid recipient email is required.');
      }
      if (!smtp.host || !smtp.fromEmail) {
        throw new Error('SMTP is not configured. Save SMTP host and from email first.');
      }

      await sendEmail(
        {
          to,
          subject: 'LocalShifts SMTP test email',
          text: [
            'This is a test email from LocalShifts.',
            '',
            `Sent at: ${new Date().toISOString()}`
          ].join('\n')
        },
        { db: params.db }
      );
      return reply.code(303).redirect(`/admin/settings?testOk=${encodeURIComponent(`Test email sent to ${to}.`)}`);
    } catch (err: any) {
      return reply
        .code(303)
        .redirect(`/admin/settings?testErr=${encodeURIComponent(`Test email failed: ${String(err?.message ?? err)}`)}`);
    }
  });

  app.post('/admin/impersonate', async (req, reply) => {
    const currentUser = requireRole(req, 'super_admin');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = String(body.query ?? '').trim();
    if (!query) return reply.code(303).redirect(`/admin/dashboard?err=${encodeURIComponent('Manager name is required.')}`);

    const sessionCookie = req?.cookies?.vf_sess;
    if (typeof sessionCookie !== 'string' || !sessionCookie) {
      return reply.code(303).redirect('/login?role=admin');
    }
    const uns = (req as any).unsignCookie(sessionCookie);
    if (!uns?.valid || typeof uns.value !== 'string') {
      return reply.code(303).redirect('/login?role=admin');
    }
    const sessionId = uns.value;

    const rows = await params.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name'])
      .where('role', '=', 'event_manager')
      .where('is_active', '=', true)
      .where(sql<boolean>`(display_name ilike ${'%' + query + '%'} or email ilike ${'%' + query + '%'})`)
      .orderBy('display_name', 'asc')
      .limit(6)
      .execute();

    if (rows.length === 0) {
      return reply.code(303).redirect(`/admin/dashboard?err=${encodeURIComponent('No matching manager found.')}`);
    }
    if (rows.length > 1) {
      const hint = rows
        .slice(0, 5)
        .map((r: any) => `${r.display_name} <${r.email}>`)
        .join(', ');
      return reply
        .code(303)
        .redirect(`/admin/dashboard?err=${encodeURIComponent(`Multiple matches. Try a more specific name/email: ${hint}`)}`);
    }

    const manager = rows[0] as any;
    if (!manager?.id) return reply.code(303).redirect(`/admin/dashboard?err=${encodeURIComponent('No matching manager found.')}`);

    await params.db
      .insertInto('impersonation_log')
      .values({
        admin_user_id: currentUser.id,
        manager_user_id: manager.id,
        ip_address: (req as any).ip ?? null,
        user_agent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null
      })
      .execute();

    await params.db
      .updateTable('sessions')
      .set({
        data: sql`coalesce(data, '{}'::jsonb) || ${JSON.stringify({ impersonate_user_id: manager.id })}::jsonb`
      })
      .where('id', '=', sessionId)
      .where('user_id', '=', currentUser.id)
      .execute();

    return reply.code(303).redirect('/manager/dashboard');
  });

  app.post('/admin/impersonation/stop', async (req, reply) => {
    const sessionCookie = req?.cookies?.vf_sess;
    if (typeof sessionCookie !== 'string' || !sessionCookie) return reply.code(303).redirect('/');
    const uns = (req as any).unsignCookie(sessionCookie);
    if (!uns?.valid || typeof uns.value !== 'string') return reply.code(303).redirect('/');
    const sessionId = uns.value;

    const sess = await params.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select(['sessions.id', 'sessions.user_id', 'sessions.data', 'users.role'])
      .where('sessions.id', '=', sessionId)
      .executeTakeFirst();
    if (!sess || sess.role !== 'super_admin') return reply.code(303).redirect('/');

    const data = (sess as any).data as any;
    const impersonatedId = typeof data?.impersonate_user_id === 'string' ? data.impersonate_user_id : null;
    if (impersonatedId) {
      await sql`
        update impersonation_log
        set ended_at = now()
        where id = (
          select id
          from impersonation_log
          where admin_user_id = ${sess.user_id}
            and manager_user_id = ${impersonatedId}
            and ended_at is null
          order by started_at desc
          limit 1
        )
      `.execute(params.db);
    }

    await params.db
      .updateTable('sessions')
      .set({
        data: sql`coalesce(data, '{}'::jsonb) - 'impersonate_user_id'`
      })
      .where('id', '=', sessionId)
      .execute();

    return reply.code(303).redirect('/admin/dashboard?ok=' + encodeURIComponent('Stopped impersonating.'));
  });

  app.get('/admin/events', async (req, reply) => {
    requireRole(req, 'super_admin');
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const rows = await params.db
      .selectFrom('events')
      .innerJoin('organizations', 'organizations.id', 'events.organization_id')
      .innerJoin('users', 'users.id', 'events.manager_id')
      .select([
        'events.id',
        'events.slug',
        'events.title',
        'events.start_date',
        'events.end_date',
        'events.is_published',
        'events.is_archived',
        'events.cancelled_at',
        'events.created_at',
        'organizations.name as organization_name',
        'users.email as manager_email'
      ])
      .orderBy('events.created_at', 'desc')
      .execute();

    const eligible = rows.filter((r: any) => r.is_archived && !r.is_published);
    const others = rows.filter((r: any) => !(r.is_archived && !r.is_published));

    const mapRow = (r: any) => {
      const start = toDateOnly(r.start_date);
      const end = toDateOnly(r.end_date);
      return {
        id: r.id,
        title: r.title,
        slug: r.slug,
        organizationName: r.organization_name,
        managerEmail: r.manager_email,
        dateRange: start && end && start !== end ? `${start} – ${end}` : start || end,
        isPublished: r.is_published,
        isArchived: r.is_archived,
        cancelledAt: r.cancelled_at,
        createdAt: toIso(r.created_at),
        publicUrl: `/events/${encodeURIComponent(r.slug ?? r.id)}`
      };
    };

    return render(reply, 'admin_events.njk', {
      ok,
      error,
      eligibleEvents: eligible.map(mapRow),
      otherEvents: others.map(mapRow)
    });
  });

  app.get('/admin/tags', async (req, reply) => {
    requireRole(req, 'super_admin');
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const rows = await params.db
      .selectFrom('tags')
      .leftJoin('users', 'users.id', 'tags.created_by')
      .leftJoin('event_tags', 'event_tags.tag_id', 'tags.id')
      .select([
        'tags.id',
        'tags.name',
        'tags.slug',
        'tags.is_system',
        'tags.created_by',
        'users.email as creator_email',
        sql<number>`coalesce(count(distinct event_tags.event_id), 0)`.as('event_count')
      ])
      .groupBy(['tags.id', 'users.email'])
      .orderBy('tags.is_system', 'desc')
      .orderBy('tags.name', 'asc')
      .execute();

    return render(reply, 'admin_tags.njk', {
      ok,
      error,
      tags: rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        isSystem: Boolean(r.is_system),
        eventCount: Number(r.event_count ?? 0),
        creatorEmail: r.creator_email ?? null
      }))
    });
  });

  app.post('/admin/tags', async (req, reply) => {
    const currentUser = requireRole(req, 'super_admin');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const { name, slug } = parseTagNameInput(body.name);
      const existing = await params.db.selectFrom('tags').select(['id', 'name']).where('slug', '=', slug).executeTakeFirst();
      if (existing) throw new Error(`Tag "${existing.name}" already exists.`);

      await params.db
        .insertInto('tags')
        .values({
          name,
          slug,
          is_system: false,
          created_by: currentUser.id
        })
        .execute();
      return reply.code(303).redirect(`/admin/tags?ok=${encodeURIComponent('Tag created.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/tags?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/admin/tags/:id/update', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const tag = await params.db.selectFrom('tags').select(['id', 'name', 'slug', 'is_system']).where('id', '=', id).executeTakeFirst();
      if (!tag) throw new Error('Tag not found.');
      if (tag.is_system) throw new Error('System tags cannot be edited.');

      const { name, slug } = parseTagNameInput(body.name);
      const duplicate = await params.db
        .selectFrom('tags')
        .select(['id', 'name'])
        .where('slug', '=', slug)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (duplicate) throw new Error(`Tag "${duplicate.name}" already exists.`);

      await params.db.updateTable('tags').set({ name, slug }).where('id', '=', id).execute();
      return reply.code(303).redirect(`/admin/tags?ok=${encodeURIComponent('Tag updated.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/tags?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/admin/tags/:id/delete', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    try {
      const tag = await params.db.selectFrom('tags').select(['id', 'is_system']).where('id', '=', id).executeTakeFirst();
      if (!tag) throw new Error('Tag not found.');
      if (tag.is_system) throw new Error('System tags cannot be deleted.');

      await params.db.deleteFrom('tags').where('id', '=', id).execute();
      return reply.code(303).redirect(`/admin/tags?ok=${encodeURIComponent('Tag deleted.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/tags?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.get('/admin/events/:id/delete', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const event = await params.db
      .selectFrom('events')
      .innerJoin('organizations', 'organizations.id', 'events.organization_id')
      .innerJoin('users', 'users.id', 'events.manager_id')
      .select([
        'events.id',
        'events.slug',
        'events.title',
        'events.start_date',
        'events.end_date',
        'events.is_published',
        'events.is_archived',
        'events.cancelled_at',
        'events.created_at',
        'organizations.name as organization_name',
        'users.email as manager_email'
      ])
      .where('events.id', '=', id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const shifts = await params.db
      .selectFrom('shifts')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', id)
      .executeTakeFirst();

    const signups = await params.db
      .selectFrom('signups')
      .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('shifts.event_id', '=', id)
      .executeTakeFirst();

    const notifications = await params.db
      .selectFrom('notification_sends')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', id)
      .executeTakeFirst();

    const eligible = Boolean(event.is_archived) && !event.is_published;
    const requiredConfirmText = `DELETE ${event.id}`;

    const start = toDateOnly(event.start_date);
    const end = toDateOnly(event.end_date);

    return render(reply, 'admin_event_delete.njk', {
      error,
      eligible,
      requiredConfirmText,
      impact: {
        shifts: Number(shifts?.c ?? 0),
        signups: Number(signups?.c ?? 0),
        notifications: Number(notifications?.c ?? 0)
      },
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        organizationName: event.organization_name,
        managerEmail: event.manager_email,
        dateRange: start && end && start !== end ? `${start} – ${end}` : start || end,
        isPublished: event.is_published,
        isArchived: event.is_archived,
        cancelledAt: event.cancelled_at,
        createdAt: toIso(event.created_at),
        publicUrl: `/events/${encodeURIComponent(event.slug ?? event.id)}`
      }
    });
  });

  app.get('/admin/events/:id/reminders', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const event = await params.db
      .selectFrom('events')
      .innerJoin('organizations', 'organizations.id', 'events.organization_id')
      .innerJoin('users', 'users.id', 'events.manager_id')
      .select([
        'events.id',
        'events.title',
        'events.slug',
        'events.start_date',
        'events.end_date',
        'organizations.name as organization_name',
        'users.email as manager_email'
      ])
      .where('events.id', '=', id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const reminderRules = await params.db
      .selectFrom('reminder_rules')
      .select(['id', 'send_offset_hours', 'subject_template', 'body_template', 'is_active'])
      .where('event_id', '=', id)
      .orderBy('send_offset_hours', 'asc')
      .execute();

    const start = toDateOnly(event.start_date);
    const end = toDateOnly(event.end_date);

    return render(reply, 'admin_event_reminders.njk', {
      ok,
      error,
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        organizationName: event.organization_name,
        managerEmail: event.manager_email,
        dateRange: start && end && start !== end ? `${start} – ${end}` : start || end,
        publicUrl: `/events/${encodeURIComponent(event.slug ?? event.id)}`
      },
      reminderRules: reminderRules.map((r: any) => ({
        id: r.id,
        sendOffsetHours: r.send_offset_hours,
        subjectTemplate: r.subject_template,
        bodyTemplate: r.body_template,
        isActive: r.is_active
      }))
    });
  });

  app.post('/admin/events/:id/reminders', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sendOffsetHours = Number(body.sendOffsetHours ?? 0);
    const subjectTemplate = String(body.subjectTemplate ?? '').trim();
    const bodyTemplate = String(body.bodyTemplate ?? '').trim();
    const isActive = String(body.isActive ?? '').trim() === 'on' || String(body.isActive ?? '').trim() === 'true';

    try {
      const event = await params.db
        .selectFrom('events')
        .select(['id'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!event) throw new Error('Event not found.');

      if (!Number.isFinite(sendOffsetHours) || sendOffsetHours < 0 || sendOffsetHours > 336) {
        throw new Error('Offset must be between 0 and 336 hours.');
      }
      if (!subjectTemplate || subjectTemplate.length > 300) throw new Error('Subject is required (max 300 characters).');
      if (!bodyTemplate || bodyTemplate.length > 20000) throw new Error('Body is required (max 20000 characters).');

      const existing = await params.db
        .selectFrom('reminder_rules')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('event_id', '=', id)
        .executeTakeFirst();
      if (Number(existing?.c ?? 0) >= 3) throw new Error('You can set up to 3 reminder rules per event.');

      await params.db
        .insertInto('reminder_rules')
        .values({
          event_id: id,
          send_offset_hours: Math.floor(sendOffsetHours),
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          is_active: isActive
        })
        .execute();

      return reply.code(303).redirect(`/admin/events/${id}/reminders?ok=${encodeURIComponent('Reminder rule added.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/events/${id}/reminders?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/admin/events/:id/reminders/:ruleId/update', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sendOffsetHours = Number(body.sendOffsetHours ?? 0);
    const subjectTemplate = String(body.subjectTemplate ?? '').trim();
    const bodyTemplate = String(body.bodyTemplate ?? '').trim();
    const isActive = String(body.isActive ?? '').trim() === 'on' || String(body.isActive ?? '').trim() === 'true';

    try {
      if (!Number.isFinite(sendOffsetHours) || sendOffsetHours < 0 || sendOffsetHours > 336) {
        throw new Error('Offset must be between 0 and 336 hours.');
      }
      if (!subjectTemplate || subjectTemplate.length > 300) throw new Error('Subject is required (max 300 characters).');
      if (!bodyTemplate || bodyTemplate.length > 20000) throw new Error('Body is required (max 20000 characters).');

      const row = await params.db
        .selectFrom('reminder_rules')
        .select(['id'])
        .where('id', '=', ruleId)
        .where('event_id', '=', id)
        .executeTakeFirst();
      if (!row) throw new Error('Reminder rule not found.');

      await params.db
        .updateTable('reminder_rules')
        .set({
          send_offset_hours: Math.floor(sendOffsetHours),
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          is_active: isActive
        })
        .where('id', '=', ruleId)
        .where('event_id', '=', id)
        .execute();

      return reply.code(303).redirect(`/admin/events/${id}/reminders?ok=${encodeURIComponent('Reminder rule updated.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/events/${id}/reminders?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/admin/events/:id/reminders/:ruleId/delete', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id, ruleId } = req.params as { id: string; ruleId: string };

    try {
      const row = await params.db
        .selectFrom('reminder_rules')
        .select(['id'])
        .where('id', '=', ruleId)
        .where('event_id', '=', id)
        .executeTakeFirst();
      if (!row) throw new Error('Reminder rule not found.');

      await params.db
        .deleteFrom('reminder_rules')
        .where('id', '=', ruleId)
        .where('event_id', '=', id)
        .execute();

      return reply.code(303).redirect(`/admin/events/${id}/reminders?ok=${encodeURIComponent('Reminder rule deleted.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/events/${id}/reminders?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.get('/admin/events/:id/purge', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const error = typeof qs.err === 'string' ? qs.err : undefined;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;

    const event = await params.db
      .selectFrom('events')
      .innerJoin('organizations', 'organizations.id', 'events.organization_id')
      .innerJoin('users', 'users.id', 'events.manager_id')
      .select([
        'events.id',
        'events.slug',
        'events.title',
        'events.start_date',
        'events.end_date',
        'events.purge_after_days',
        'events.is_published',
        'events.is_archived',
        'events.purged_at',
        'events.created_at',
        'organizations.name as organization_name',
        'users.email as manager_email'
      ])
      .where('events.id', '=', id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const shifts = await params.db
      .selectFrom('shifts')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', id)
      .executeTakeFirst();

    const signups = await params.db
      .selectFrom('signups')
      .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('shifts.event_id', '=', id)
      .executeTakeFirst();

    const notifications = await params.db
      .selectFrom('notification_sends')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', id)
      .executeTakeFirst();

    const requiredConfirmText = `PURGE ${event.id}`;
    const start = toDateOnly(event.start_date);
    const end = toDateOnly(event.end_date);
    const defaultPurgeAfterDays = await getDefaultPurgeAfterDays();

    return render(reply, 'admin_event_purge.njk', {
      ok,
      error,
      requiredConfirmText,
      defaultPurgeAfterDays,
      impact: {
        shifts: Number(shifts?.c ?? 0),
        signups: Number(signups?.c ?? 0),
        notifications: Number(notifications?.c ?? 0)
      },
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        organizationName: (event as any).organization_name,
        managerEmail: (event as any).manager_email,
        dateRange: start && end && start !== end ? `${start} – ${end}` : start || end,
        isPublished: event.is_published,
        isArchived: event.is_archived,
        purgeAfterDays: event.purge_after_days,
        purgedAt: event.purged_at,
        createdAt: toIso(event.created_at),
        publicUrl: `/events/${encodeURIComponent(event.slug ?? event.id)}`
      }
    });
  });

  app.post('/admin/events/:id/purge-window', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const purgeAfterDays = parsePurgeAfterDays(body.purgeAfterDays);

    try {
      const event = await params.db
        .selectFrom('events')
        .select(['id'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!event) throw new Error('Event not found.');

      await params.db.updateTable('events').set({ purge_after_days: purgeAfterDays }).where('id', '=', id).execute();
      return reply.code(303).redirect(`/admin/events/${id}/purge?ok=${encodeURIComponent('Purge window updated.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/events/${id}/purge?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/admin/events/:id/purge', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const confirmText = String(body.confirmText ?? '').trim();
    const acknowledge = String(body.acknowledge ?? '').trim();

    const event = await params.db
      .selectFrom('events')
      .select(['id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const requiredConfirmText = `PURGE ${event.id}`;
    try {
      if (confirmText !== requiredConfirmText) throw new Error('Confirmation text does not match.');
      if (acknowledge !== 'yes') throw new Error('Acknowledgement is required.');

      const res = await purgeEventVolunteerPII({ db: params.db, eventId: id });
      const msg = res.alreadyPurged
        ? `Manual purge complete. Signups deleted: ${res.deletedSignups}. Notification log rows deleted: ${res.deletedNotificationSends}.`
        : `Manual purge complete. Purged event and deleted ${res.deletedSignups} signup(s) and ${res.deletedNotificationSends} notification log row(s).`;
      return reply.code(303).redirect(`/admin/events/${id}/purge?ok=${encodeURIComponent(msg)}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/events/${id}/purge?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/admin/events/:id/delete', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const confirmText = String(body.confirmText ?? '').trim();
    const acknowledge = String(body.acknowledge ?? '').trim();

    const event = await params.db
      .selectFrom('events')
      .select(['id', 'title', 'slug', 'is_published', 'is_archived'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const requiredConfirmText = `DELETE ${event.id}`;
    try {
      if (confirmText !== requiredConfirmText) throw new Error('Confirmation text does not match.');
      if (acknowledge !== 'yes') throw new Error('Acknowledgement is required.');
      if (!event.is_archived || event.is_published) throw new Error('Only archived and unpublished events can be deleted.');

      // Hard delete (cascades to shifts/signups/etc).
      const deleted = await params.db
        .deleteFrom('events')
        .where('id', '=', id)
        .where('is_archived', '=', true)
        .where('is_published', '=', false)
        .executeTakeFirst();

      if (Number((deleted as any)?.numDeletedRows ?? 0) === 0) throw new Error('Event not eligible for deletion.');

      app.log.warn({ eventId: event.id, title: event.title, slug: event.slug }, 'admin hard-deleted event');
      return reply.code(303).redirect(`/admin/events?ok=${encodeURIComponent('Event deleted.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/admin/events/${id}/delete?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.get('/admin/users', async (req, reply) => {
    requireRole(req, 'super_admin');
    const users = await params.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'is_active'])
      .where('role', '=', 'event_manager')
      .orderBy('created_at', 'desc')
      .execute();
    return render(reply, 'admin_users.njk', {
      users: users.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, isActive: u.is_active }))
    });
  });

  app.post('/admin/users', async (req, reply) => {
    requireRole(req, 'super_admin');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const email = String(body.email ?? '');
      const displayName = String(body.displayName ?? '');
      const password = String(body.password ?? '');
      await createUser(params.db, { email, displayName, password, role: 'event_manager' });
      return reply.code(303).redirect('/admin/users');
    } catch (err: any) {
      const users = await params.db
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'is_active'])
        .where('role', '=', 'event_manager')
        .orderBy('created_at', 'desc')
        .execute();
      return render(reply, 'admin_users.njk', {
        error: String(err?.message ?? err),
        users: users.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, isActive: u.is_active }))
      });
    }
  });

  app.post('/admin/users/:id/toggle', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const user = await params.db
      .selectFrom('users')
      .select(['id', 'is_active'])
      .where('id', '=', id)
      .where('role', '=', 'event_manager')
      .executeTakeFirst();
    if (!user) return reply.code(404).view('not_found.njk', { message: 'User not found.' });
    await params.db.updateTable('users').set({ is_active: !user.is_active }).where('id', '=', id).execute();
    return reply.code(303).redirect('/admin/users');
  });

  app.get('/admin/manager-orgs', async (req, reply) => {
    requireRole(req, 'super_admin');
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const managers = await params.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name'])
      .where('role', '=', 'event_manager')
      .orderBy('display_name', 'asc')
      .execute();

    const assignmentRows = await params.db
      .selectFrom('manager_organizations')
      .innerJoin('organizations', 'organizations.id', 'manager_organizations.organization_id')
      .select(['manager_organizations.manager_id as manager_id', 'organizations.name as org_name'])
      .orderBy('organizations.name', 'asc')
      .execute();

    const orgsByManagerId = new Map<string, string[]>();
    for (const r of assignmentRows as any[]) {
      const mid = String(r.manager_id);
      const arr = orgsByManagerId.get(mid) ?? [];
      arr.push(String(r.org_name));
      orgsByManagerId.set(mid, arr);
    }

    return render(reply, 'admin_manager_orgs.njk', {
      ok,
      error,
      managers: (managers as any[]).map((m) => ({
        id: m.id,
        email: m.email,
        displayName: m.display_name,
        orgNames: orgsByManagerId.get(m.id) ?? []
      }))
    });
  });

  app.get('/admin/manager-orgs/:id', async (req, reply) => {
    requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const manager = await params.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name'])
      .where('id', '=', id)
      .where('role', '=', 'event_manager')
      .executeTakeFirst();
    if (!manager) return reply.code(404).view('not_found.njk', { message: 'Manager not found.' });

    const orgs = await params.db.selectFrom('organizations').select(['id', 'name']).orderBy('name', 'asc').execute();
    const assigned = await params.db
      .selectFrom('manager_organizations')
      .select(['organization_id'])
      .where('manager_id', '=', id)
      .execute();
    const assignedSet = new Set(assigned.map((a) => a.organization_id));

    return render(reply, 'admin_manager_orgs_edit.njk', {
      ok,
      error,
      manager: { id: manager.id, email: manager.email, displayName: manager.display_name },
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, isAssigned: assignedSet.has(o.id) }))
    });
  });

  app.post('/admin/manager-orgs/:id', async (req, reply) => {
    const currentUser = requireRole(req, 'super_admin');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = (body.orgIds ?? []) as unknown;
    const orgIds = Array.isArray(raw) ? raw.map((v) => String(v)) : typeof raw === 'string' ? [raw] : [];

    const manager = await params.db
      .selectFrom('users')
      .select(['id'])
      .where('id', '=', id)
      .where('role', '=', 'event_manager')
      .executeTakeFirst();
    if (!manager) return reply.code(404).view('not_found.njk', { message: 'Manager not found.' });

    await params.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('manager_organizations').where('manager_id', '=', id).execute();
      if (!orgIds.length) return;
      const rows = orgIds.map((orgId) => ({
        manager_id: id,
        organization_id: orgId,
        assigned_by: currentUser.id
      }));
      await trx.insertInto('manager_organizations').values(rows).onConflict((oc) => oc.columns(['manager_id', 'organization_id']).doNothing()).execute();
    });

    return reply.code(303).redirect(`/admin/manager-orgs/${encodeURIComponent(id)}?ok=${encodeURIComponent('Assignments saved.')}`);
  });

  app.get('/manager/dashboard', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const events = await params.db
      .selectFrom('events')
      .select(['id', 'slug', 'title', 'start_date', 'end_date', 'is_published', 'cancelled_at'])
      .where('manager_id', '=', currentUser.id)
      .where('is_archived', '=', false)
      .orderBy('start_date', 'desc')
      .execute();

    const ids = events.map((e) => e.id);
    const statsRows =
      ids.length === 0
        ? []
        : await params.db
            .selectFrom('shifts')
            .innerJoin('events', 'events.id', 'shifts.event_id')
            .leftJoin('signups', (join) =>
              join.onRef('signups.shift_id', '=', 'shifts.id').on('signups.status', '=', sql.lit('active'))
            )
            .select([
              'shifts.event_id as event_id',
              sql<number>`count(distinct shifts.id)`.as('shift_count'),
              sql<number>`coalesce(count(signups.id), 0)`.as('filled'),
              sql<number>`coalesce(sum(shifts.max_volunteers), 0)`.as('capacity')
            ])
            .where('events.manager_id', '=', currentUser.id)
            .where('shifts.is_active', '=', true)
            .where('shifts.event_id', 'in', ids)
            .groupBy('shifts.event_id')
            .execute();

    const statsByEvent = new Map(
      statsRows.map((r: any) => [
        r.event_id,
        {
          shiftCount: Number(r.shift_count ?? 0),
          filled: Number(r.filled ?? 0),
          capacity: Number(r.capacity ?? 0)
        }
      ])
    );

    const mapped = events.map((e) => {
      const stats = statsByEvent.get(e.id) ?? { shiftCount: 0, filled: 0, capacity: 0 };
      const start = toDateOnly(e.start_date);
      const end = toDateOnly(e.end_date);
      return {
        id: e.id,
        title: e.title,
        dateRange: start && end && start !== end ? `${start} – ${end}` : start || end,
        publicUrl: `/events/${encodeURIComponent(e.slug ?? e.id)}`,
        isPublished: e.is_published,
        cancelledAt: e.cancelled_at,
        stats: {
          shifts: stats.shiftCount,
          filled: stats.filled,
          open: Math.max(0, stats.capacity - stats.filled)
        }
      };
    });

    const upcoming = await params.db
      .selectFrom('shifts')
      .innerJoin('events', 'events.id', 'shifts.event_id')
      .leftJoin('signups', (join) =>
        join.onRef('signups.shift_id', '=', 'shifts.id').on('signups.status', '=', sql.lit('active'))
      )
      .select([
        'shifts.id as shift_id',
        'shifts.role_name',
        'shifts.shift_date',
        'shifts.start_time',
        'shifts.end_time',
        'shifts.min_volunteers',
        'shifts.max_volunteers',
        'events.id as event_id',
        'events.title as event_title',
        sql<number>`coalesce(count(signups.id), 0)`.as('filled')
      ])
      .where('events.manager_id', '=', currentUser.id)
      .where('events.is_archived', '=', false)
      .where('shifts.is_active', '=', true)
      .where(sql<boolean>`shifts.shift_date >= current_date and shifts.shift_date < current_date + interval '14 days'`)
      .groupBy([
        'shifts.id',
        'events.id',
        'events.title',
        'shifts.role_name',
        'shifts.shift_date',
        'shifts.start_time',
        'shifts.end_time',
        'shifts.min_volunteers',
        'shifts.max_volunteers'
      ])
      .orderBy('shifts.shift_date', 'asc')
      .orderBy('shifts.start_time', 'asc')
      .execute();

    const upcomingMapped = upcoming.map((s: any) => {
      const filled = Number(s.filled ?? 0);
      const min = Number(s.min_volunteers ?? 0);
      const max = Number(s.max_volunteers ?? 0);
      return {
        shiftId: s.shift_id,
        eventId: s.event_id,
        eventTitle: s.event_title,
        roleName: s.role_name,
        date: toDateOnly(s.shift_date),
        timeRange: `${String(s.start_time)}–${String(s.end_time)}`,
        filled,
        max,
        open: Math.max(0, max - filled),
        isUnderstaffed: filled < min,
        rosterUrl: `/manager/events/${encodeURIComponent(s.event_id)}/signups`
      };
    });

    const understaffedCount = upcomingMapped.filter((s: any) => s.isUnderstaffed).length;

    return render(reply, 'manager_dashboard.njk', {
      currentUser,
      events: mapped,
      upcomingShifts: upcomingMapped,
      understaffedCount
    });
  });

  app.get('/manager/tags', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const rows = await params.db
      .selectFrom('tags')
      .leftJoin('users', 'users.id', 'tags.created_by')
      .leftJoin('event_tags', 'event_tags.tag_id', 'tags.id')
      .select([
        'tags.id',
        'tags.name',
        'tags.slug',
        'tags.is_system',
        'tags.created_by',
        'users.email as creator_email',
        sql<number>`coalesce(count(distinct event_tags.event_id), 0)`.as('event_count')
      ])
      .groupBy(['tags.id', 'users.email'])
      .orderBy('tags.is_system', 'desc')
      .orderBy('tags.name', 'asc')
      .execute();

    return render(reply, 'manager_tags.njk', {
      ok,
      error,
      tags: rows.map((r: any) => {
        const creatorId = r.created_by ? String(r.created_by) : null;
        const isMine = creatorId === currentUser.id;
        return {
          id: r.id,
          name: r.name,
          slug: r.slug,
          isSystem: Boolean(r.is_system),
          eventCount: Number(r.event_count ?? 0),
          creatorEmail: r.creator_email ?? null,
          isMine,
          canEdit: !r.is_system && isMine,
          canDelete: !r.is_system && isMine
        };
      })
    });
  });

  app.post('/manager/tags', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const { name, slug } = parseTagNameInput(body.name);
      const existing = await params.db.selectFrom('tags').select(['id', 'name']).where('slug', '=', slug).executeTakeFirst();
      if (existing) throw new Error(`Tag "${existing.name}" already exists.`);

      await params.db
        .insertInto('tags')
        .values({
          name,
          slug,
          is_system: false,
          created_by: currentUser.id
        })
        .execute();

      return reply.code(303).redirect(`/manager/tags?ok=${encodeURIComponent('Tag created.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/tags?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/tags/:id/update', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const tag = await params.db
        .selectFrom('tags')
        .select(['id', 'name', 'slug', 'is_system', 'created_by'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!tag) throw new Error('Tag not found.');
      if (tag.is_system) throw new Error('System tags cannot be edited.');
      if ((tag.created_by ?? null) !== currentUser.id) throw new Error('You can only edit tags you created.');

      const { name, slug } = parseTagNameInput(body.name);
      const duplicate = await params.db
        .selectFrom('tags')
        .select(['id', 'name'])
        .where('slug', '=', slug)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (duplicate) throw new Error(`Tag "${duplicate.name}" already exists.`);

      await params.db.updateTable('tags').set({ name, slug }).where('id', '=', id).execute();
      return reply.code(303).redirect(`/manager/tags?ok=${encodeURIComponent('Tag updated.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/tags?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/tags/:id/delete', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    try {
      const tag = await params.db
        .selectFrom('tags')
        .select(['id', 'is_system', 'created_by'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!tag) throw new Error('Tag not found.');
      if (tag.is_system) throw new Error('System tags cannot be deleted.');
      if ((tag.created_by ?? null) !== currentUser.id) throw new Error('You can only delete tags you created.');

      await params.db.deleteFrom('tags').where('id', '=', id).execute();
      return reply.code(303).redirect(`/manager/tags?ok=${encodeURIComponent('Tag deleted.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/tags?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  // Admin organizations (needed before managers can create events)
  app.get('/admin/organizations', async (req, reply) => {
    requireRole(req, 'super_admin');
    const orgs = await params.db
      .selectFrom('organizations')
      .select(['id', 'name', 'slug', 'contact_email'])
      .orderBy('name', 'asc')
      .execute();
    return render(reply, 'admin_organizations.njk', {
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, contactEmail: o.contact_email }))
    });
  });

  app.post('/admin/organizations', async (req, reply) => {
    const currentUser = requireRole(req, 'super_admin');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    const slug = String(body.slug ?? '').trim();
    const primaryColor = String(body.primaryColor ?? '').trim();
    const contactEmail = String(body.contactEmail ?? '').trim();
    try {
      if (!name || name.length > 120) throw new Error('Invalid name.');
      if (!slug || slug.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid slug.');
      if (primaryColor && !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) throw new Error('Invalid color (use #RRGGBB).');
      if (contactEmail && contactEmail.length > 120) throw new Error('Invalid contact email.');

      await params.db
        .insertInto('organizations')
        .values({
          name,
          slug,
          primary_color: primaryColor || null,
          contact_email: contactEmail || null,
          logo_url: null,
          created_by: currentUser.id
        })
        .execute();
      return reply.code(303).redirect('/admin/organizations');
    } catch (err: any) {
      const orgs = await params.db
        .selectFrom('organizations')
        .select(['id', 'name', 'slug', 'contact_email'])
        .orderBy('name', 'asc')
        .execute();
      return render(reply, 'admin_organizations.njk', {
        error: String(err?.message ?? err),
        orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, contactEmail: o.contact_email }))
      });
    }
  });

  // Manager event CRUD
  app.get('/manager/templates', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const rows = await params.db
      .selectFrom('role_templates')
      .select([
        'id',
        'role_name',
        'role_description',
        'duration_minutes',
        'default_min_volunteers',
        'default_max_volunteers',
        'created_at'
      ])
      .where('owner_user_id', '=', currentUser.id)
      .orderBy('role_name', 'asc')
      .execute();

    return render(reply, 'manager_templates.njk', {
      ok,
      error,
      templates: rows.map((t: any) => ({
        id: t.id,
        roleName: t.role_name,
        roleDescription: t.role_description ?? '',
        durationMinutes: t.duration_minutes,
        minVolunteers: t.default_min_volunteers,
        maxVolunteers: t.default_max_volunteers,
        createdAt: toIso(t.created_at)
      }))
    });
  });

  app.get('/manager/templates/new', async (req, reply) => {
    requireRole(req, 'event_manager');
    return render(reply, 'manager_template_new.njk', { template: null });
  });

  app.post('/manager/templates/new', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const roleName = String(body.roleName ?? '').trim();
    const roleDescription = String(body.roleDescription ?? '').trim();
    const durationMinutes = Number(body.durationMinutes ?? 0);
    const minVolunteers = Number(body.minVolunteers ?? 0);
    const maxVolunteers = Number(body.maxVolunteers ?? 0);

    try {
      if (!roleName || roleName.length > 120) throw new Error('Invalid role name.');
      if (roleDescription.length > 500) throw new Error('Role description is too long.');
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error('Invalid duration.');
      if (!Number.isFinite(minVolunteers) || minVolunteers < 0) throw new Error('Invalid min volunteers.');
      if (!Number.isFinite(maxVolunteers) || maxVolunteers <= 0) throw new Error('Invalid max volunteers.');

      await params.db
        .insertInto('role_templates')
        .values({
          owner_user_id: currentUser.id,
          role_name: roleName,
          role_description: roleDescription || null,
          duration_minutes: durationMinutes,
          default_min_volunteers: minVolunteers,
          default_max_volunteers: maxVolunteers
        })
        .execute();

      return reply.code(303).redirect(`/manager/templates?ok=${encodeURIComponent('Template created.')}`);
    } catch (err: any) {
      return render(reply, 'manager_template_new.njk', {
        error: String(err?.message ?? err),
        template: { id: null, roleName, roleDescription, durationMinutes, minVolunteers, maxVolunteers }
      });
    }
  });

  app.get('/manager/templates/:id/edit', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const row = await params.db
      .selectFrom('role_templates')
      .select(['id', 'role_name', 'role_description', 'duration_minutes', 'default_min_volunteers', 'default_max_volunteers'])
      .where('id', '=', id)
      .where('owner_user_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!row) return reply.code(404).view('not_found.njk', { message: 'Template not found.' });

    return render(reply, 'manager_template_edit.njk', {
      ok,
      error,
      template: {
        id: row.id,
        roleName: row.role_name,
        roleDescription: row.role_description ?? '',
        durationMinutes: row.duration_minutes,
        minVolunteers: row.default_min_volunteers,
        maxVolunteers: row.default_max_volunteers
      }
    });
  });

  app.post('/manager/templates/:id/edit', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const roleName = String(body.roleName ?? '').trim();
    const roleDescription = String(body.roleDescription ?? '').trim();
    const durationMinutes = Number(body.durationMinutes ?? 0);
    const minVolunteers = Number(body.minVolunteers ?? 0);
    const maxVolunteers = Number(body.maxVolunteers ?? 0);

    try {
      if (!roleName || roleName.length > 120) throw new Error('Invalid role name.');
      if (roleDescription.length > 500) throw new Error('Role description is too long.');
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error('Invalid duration.');
      if (!Number.isFinite(minVolunteers) || minVolunteers < 0) throw new Error('Invalid min volunteers.');
      if (!Number.isFinite(maxVolunteers) || maxVolunteers <= 0) throw new Error('Invalid max volunteers.');

      const updated = await params.db
        .updateTable('role_templates')
        .set({
          role_name: roleName,
          role_description: roleDescription || null,
          duration_minutes: durationMinutes,
          default_min_volunteers: minVolunteers,
          default_max_volunteers: maxVolunteers
        })
        .where('id', '=', id)
        .where('owner_user_id', '=', currentUser.id)
        .executeTakeFirst();

      if (Number((updated as any)?.numUpdatedRows ?? 0) === 0) throw new Error('Template not found.');
      return reply.code(303).redirect(`/manager/templates/${id}/edit?ok=${encodeURIComponent('Saved.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/templates/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/templates/:id/delete', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };

    const deleted = await params.db
      .deleteFrom('role_templates')
      .where('id', '=', id)
      .where('owner_user_id', '=', currentUser.id)
      .executeTakeFirst();

    if (Number((deleted as any)?.numDeletedRows ?? 0) === 0) {
      return reply.code(404).view('not_found.njk', { message: 'Template not found.' });
    }

    return reply.code(303).redirect(`/manager/templates?ok=${encodeURIComponent('Template deleted.')}`);
  });

  app.get('/manager/events', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const events = await params.db
      .selectFrom('events')
      .innerJoin('organizations', 'organizations.id', 'events.organization_id')
      .select([
        'events.id',
        'events.slug',
        'events.title',
        'events.start_date',
        'events.end_date',
        'events.is_published',
        'events.is_archived',
        'events.cancelled_at',
        'organizations.name as organization_name'
      ])
      .where('events.manager_id', '=', currentUser.id)
      .orderBy('events.start_date', 'desc')
      .execute();

    const mapEvent = (e: any) => {
      const start = toDateOnly(e.start_date);
      const end = toDateOnly(e.end_date);
      return {
        id: e.id,
        title: e.title,
        organizationName: e.organization_name,
        dateRange: start && end && start !== end ? `${start} – ${end}` : start || end,
        isPublished: e.is_published,
        isArchived: e.is_archived,
        cancelledAt: e.cancelled_at,
        publicUrl: `/events/${encodeURIComponent(e.slug ?? e.id)}`
      };
    };

    const activeEvents = events.filter((e: any) => !e.is_archived).map(mapEvent);
    const archivedEvents = events.filter((e: any) => e.is_archived).map(mapEvent);
    return render(reply, 'manager_events.njk', {
      events: activeEvents,
      archivedEvents
    });
  });

  app.get('/manager/events/new', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const orgs = await params.db
      .selectFrom('organizations')
      .innerJoin('manager_organizations', 'manager_organizations.organization_id', 'organizations.id')
      .select(['organizations.id', 'organizations.name'])
      .where('manager_organizations.manager_id', '=', currentUser.id)
      .orderBy('organizations.name', 'asc')
      .execute();
    const error = orgs.length === 0 ? 'No organizations are assigned to your account yet. Ask an admin to assign one.' : null;
    const defaultPurgeAfterDays = await getDefaultPurgeAfterDays();
    return render(reply, 'manager_event_new.njk', { orgs, error, defaultPurgeAfterDays });
  });

  app.post('/manager/events/new', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = String(body.title ?? '').trim();
    const organizationId = String(body.organizationId ?? '').trim();
    const isFeatured = String(body.isFeatured ?? '').trim() === 'on';
    const tags = parseTagsInput(String(body.tags ?? ''));
    const confirmationEmailNote = String(body.confirmationEmailNote ?? '');
    const date = String(body.date ?? '').trim();
    const description = String(body.description ?? '');
    const locationName = String(body.locationName ?? '').trim();
    const locationMapUrl = String(body.locationMapUrl ?? '').trim();
    const purgeAfterDays = parsePurgeAfterDays(body.purgeAfterDays);

    try {
      if (!title || title.length > 200) throw new Error('Invalid title.');
      if (!organizationId) throw new Error('Organization is required.');
      if (confirmationEmailNote.length > 2000) throw new Error('Confirmation note is too long (max 2000 characters).');
      const allowedOrg = await params.db
        .selectFrom('manager_organizations')
        .select(['organization_id'])
        .where('manager_id', '=', currentUser.id)
        .where('organization_id', '=', organizationId)
        .executeTakeFirst();
      if (!allowedOrg) throw new Error('You are not assigned to that organization.');
      const startDate = parseDateOnly(date);
      const slug = await uniqueEventSlug(title);
      const category = (isFeatured ? 'featured' : 'normal') as EventCategory;
      const draftCoords = parseCoordsFromMapUrl(locationMapUrl);

      const inserted = await params.db
        .insertInto('events')
        .values({
          organization_id: organizationId,
          manager_id: currentUser.id,
          slug,
          title,
          category,
          is_featured: isFeatured,
          tags,
          confirmation_email_note: confirmationEmailNote.trim() ? confirmationEmailNote.trim() : null,
          description_html: descriptionTextToHtml(description),
          location_name: locationName || null,
          location_map_url: locationMapUrl || null,
          location_lat: draftCoords ? draftCoords.lat.toFixed(6) : null,
          location_lng: draftCoords ? draftCoords.lng.toFixed(6) : null,
          image_path: null,
          event_type: 'one_time',
          recurrence_rule: null,
          start_date: startDate,
          end_date: startDate,
          purge_after_days: purgeAfterDays,
          is_published: false,
          is_archived: false
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await setEventTags({ db: params.db, eventId: inserted.id, tagNames: tags, createdByUserId: currentUser.id });
      return reply.code(303).redirect(`/manager/events/${inserted.id}/edit`);
    } catch (err: any) {
      const orgs = await params.db
        .selectFrom('organizations')
        .innerJoin('manager_organizations', 'manager_organizations.organization_id', 'organizations.id')
        .select(['organizations.id', 'organizations.name'])
        .where('manager_organizations.manager_id', '=', currentUser.id)
        .orderBy('organizations.name', 'asc')
        .execute();
      const defaultPurgeAfterDays = await getDefaultPurgeAfterDays();
      return render(reply, 'manager_event_new.njk', { orgs, error: String(err?.message ?? err), defaultPurgeAfterDays });
    }
  });

  app.get('/manager/events/:id/edit', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const error = typeof qs.err === 'string' ? qs.err : undefined;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const event = await params.db
      .selectFrom('events')
      .select([
        'id',
        'title',
        'organization_id',
        'category',
        'is_featured',
        'tags',
        'confirmation_email_note',
        'start_date',
        'end_date',
        'description_html',
        'location_name',
        'location_map_url',
        'image_path',
        'purge_after_days',
        'is_published',
        'is_archived',
        'cancelled_at',
        'cancellation_message'
      ])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const orgsBase = await params.db
      .selectFrom('organizations')
      .innerJoin('manager_organizations', 'manager_organizations.organization_id', 'organizations.id')
      .select(['organizations.id', 'organizations.name'])
      .where('manager_organizations.manager_id', '=', currentUser.id)
      .orderBy('organizations.name', 'asc')
      .execute();
    const orgs = orgsBase.some((o) => o.id === event.organization_id)
      ? orgsBase
      : [
          ...(orgsBase as any[]),
          ...(await params.db
            .selectFrom('organizations')
            .select(['id', 'name'])
            .where('id', '=', event.organization_id)
            .execute())
        ];
    const shifts = await params.db
      .selectFrom('shifts')
      .select([
        'id',
        'role_name',
        'role_description',
        'duration_minutes',
        'shift_date',
        'start_time',
        'end_time',
        'min_volunteers',
        'max_volunteers',
        'is_active'
      ])
      .where('event_id', '=', event.id)
      .orderBy('shift_date', 'asc')
      .orderBy('start_time', 'asc')
      .execute();

    const templates = await params.db
      .selectFrom('role_templates')
      .select(['id', 'role_name', 'duration_minutes', 'default_min_volunteers', 'default_max_volunteers'])
      .where('owner_user_id', '=', currentUser.id)
      .orderBy('role_name', 'asc')
      .execute();

    const reminderRules = await params.db
      .selectFrom('reminder_rules')
      .select(['id', 'send_offset_hours', 'subject_template', 'body_template', 'is_active'])
      .where('event_id', '=', event.id)
      .orderBy('send_offset_hours', 'asc')
      .execute();

    const description = unescapeHtml(
      (event.description_html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<\/?p>/gi, '')
    );
    const defaultPurgeAfterDays = await getDefaultPurgeAfterDays();
    return render(reply, 'manager_event_edit.njk', {
      error,
      ok,
      orgs,
      defaultPurgeAfterDays,
      event: {
        id: event.id,
        title: event.title,
        organizationId: event.organization_id,
        isFeatured: Boolean((event as any).is_featured),
        tags: Array.isArray((event as any).tags) ? ((event as any).tags as string[]).join(', ') : '',
        confirmationEmailNote: event.confirmation_email_note ?? '',
        startDate: toDateOnly(event.start_date),
        endDate: toDateOnly(event.end_date),
        description,
        locationName: event.location_name ?? '',
        locationMapUrl: event.location_map_url ?? '',
        imagePath: event.image_path ?? '/event-images/default_volunteers.png',
        hasCustomImage: Boolean(event.image_path),
        purgeAfterDays: event.purge_after_days,
        isPublished: event.is_published,
        isArchived: event.is_archived,
        cancelledAt: event.cancelled_at,
        cancellationMessage: event.cancellation_message
      },
      templates: templates.map((t: any) => ({
        id: t.id,
        roleName: t.role_name,
        durationMinutes: t.duration_minutes,
        minVolunteers: t.default_min_volunteers,
        maxVolunteers: t.default_max_volunteers
      })),
      reminderRules: reminderRules.map((r: any) => ({
        id: r.id,
        sendOffsetHours: r.send_offset_hours,
        subjectTemplate: r.subject_template,
        bodyTemplate: r.body_template,
        isActive: r.is_active
      })),
      shifts: shifts.map((s) => ({
        id: s.id,
        roleName: s.role_name,
        shiftDate: toDateOnly(s.shift_date),
        startTime: String(s.start_time).slice(0, 5),
        endTime: String(s.end_time).slice(0, 5),
        roleDescription: s.role_description ?? '',
        durationMinutes: s.duration_minutes,
        minVolunteers: s.min_volunteers,
        maxVolunteers: s.max_volunteers,
        isActive: s.is_active
      }))
    });
  });

  app.post('/manager/events/:id/edit', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = String(body.title ?? '').trim();
    const organizationId = String(body.organizationId ?? '').trim();
    const isFeatured = String(body.isFeatured ?? '').trim() === 'on';
    const tags = parseTagsInput(String(body.tags ?? ''));
    const confirmationEmailNote = String(body.confirmationEmailNote ?? '');
    const startDate = String(body.startDate ?? '').trim();
    const endDate = String(body.endDate ?? '').trim();
    const description = String(body.description ?? '');
    const locationName = String(body.locationName ?? '').trim();
    const locationMapUrl = String(body.locationMapUrl ?? '').trim();
    const purgeAfterDays = parsePurgeAfterDays(body.purgeAfterDays);

    try {
      if (!title || title.length > 200) throw new Error('Invalid title.');
      if (!organizationId) throw new Error('Organization is required.');
      if (confirmationEmailNote.length > 2000) throw new Error('Confirmation note is too long (max 2000 characters).');
      const sd = parseDateOnly(startDate);
      const ed = parseDateOnly(endDate);
      const category = (isFeatured ? 'featured' : 'normal') as EventCategory;
      const draftCoords = parseCoordsFromMapUrl(locationMapUrl);

      const existing = await params.db
        .selectFrom('events')
        .select(['organization_id', 'location_name', 'location_map_url', 'location_lat', 'location_lng', 'is_published', 'purge_after_days'])
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!existing) throw new Error('Event not found.');
      if (existing.is_published && purgeAfterDays !== (existing.purge_after_days ?? null)) {
        throw new Error('Purge window cannot be changed after publish. Ask an admin to update it.');
      }

      if (existing.organization_id !== organizationId) {
        const allowedOrg = await params.db
          .selectFrom('manager_organizations')
          .select(['organization_id'])
          .where('manager_id', '=', currentUser.id)
          .where('organization_id', '=', organizationId)
          .executeTakeFirst();
        if (!allowedOrg) throw new Error('You are not assigned to that organization.');
      }

      const nextLocationName = locationName || null;
      const nextLocationMapUrl = locationMapUrl || null;
      const locationChanged =
        String(existing.location_name ?? '').trim() !== String(nextLocationName ?? '').trim() ||
        String(existing.location_map_url ?? '').trim() !== String(nextLocationMapUrl ?? '').trim();
      const nextCoords = locationChanged
        ? draftCoords
          ? { lat: draftCoords.lat.toFixed(6), lng: draftCoords.lng.toFixed(6) }
          : { lat: null, lng: null }
        : { lat: existing.location_lat, lng: existing.location_lng };

      await params.db
        .updateTable('events')
        .set({
          title,
          organization_id: organizationId,
          category,
          is_featured: isFeatured,
          tags,
          confirmation_email_note: confirmationEmailNote.trim() ? confirmationEmailNote.trim() : null,
          start_date: sd,
          end_date: ed,
          description_html: descriptionTextToHtml(description),
          location_name: nextLocationName,
          location_map_url: nextLocationMapUrl,
          location_lat: nextCoords.lat,
          location_lng: nextCoords.lng,
          purge_after_days: purgeAfterDays
        })
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .execute();

      await setEventTags({ db: params.db, eventId: id, tagNames: tags, createdByUserId: currentUser.id });
      return reply.code(303).redirect(`/manager/events/${id}/edit`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/events/:id/reminder-rules', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sendOffsetHours = Number(body.sendOffsetHours ?? 0);
    const subjectTemplate = String(body.subjectTemplate ?? '').trim();
    const bodyTemplate = String(body.bodyTemplate ?? '').trim();
    const isActive = String(body.isActive ?? '').trim() === 'on' || String(body.isActive ?? '').trim() === 'true';

    try {
      const event = await params.db
        .selectFrom('events')
        .select(['id'])
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!event) throw new Error('Event not found.');

      if (!Number.isFinite(sendOffsetHours) || sendOffsetHours < 0 || sendOffsetHours > 336) {
        throw new Error('Offset must be between 0 and 336 hours.');
      }
      if (!subjectTemplate || subjectTemplate.length > 300) throw new Error('Subject is required (max 300 characters).');
      if (!bodyTemplate || bodyTemplate.length > 20000) throw new Error('Body is required (max 20000 characters).');

      const existing = await params.db
        .selectFrom('reminder_rules')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('event_id', '=', id)
        .executeTakeFirst();
      if (Number(existing?.c ?? 0) >= 3) throw new Error('You can set up to 3 reminder rules per event.');

      await params.db
        .insertInto('reminder_rules')
        .values({
          event_id: id,
          send_offset_hours: Math.floor(sendOffsetHours),
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          is_active: isActive
        })
        .execute();

      return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Reminder rule added.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/events/:id/reminder-rules/:ruleId/update', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sendOffsetHours = Number(body.sendOffsetHours ?? 0);
    const subjectTemplate = String(body.subjectTemplate ?? '').trim();
    const bodyTemplate = String(body.bodyTemplate ?? '').trim();
    const isActive = String(body.isActive ?? '').trim() === 'on' || String(body.isActive ?? '').trim() === 'true';

    try {
      if (!Number.isFinite(sendOffsetHours) || sendOffsetHours < 0 || sendOffsetHours > 336) {
        throw new Error('Offset must be between 0 and 336 hours.');
      }
      if (!subjectTemplate || subjectTemplate.length > 300) throw new Error('Subject is required (max 300 characters).');
      if (!bodyTemplate || bodyTemplate.length > 20000) throw new Error('Body is required (max 20000 characters).');

      const row = await params.db
        .selectFrom('reminder_rules')
        .innerJoin('events', 'events.id', 'reminder_rules.event_id')
        .select(['reminder_rules.id'])
        .where('reminder_rules.id', '=', ruleId)
        .where('reminder_rules.event_id', '=', id)
        .where('events.manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!row) throw new Error('Reminder rule not found.');

      await params.db
        .updateTable('reminder_rules')
        .set({
          send_offset_hours: Math.floor(sendOffsetHours),
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          is_active: isActive
        })
        .where('id', '=', ruleId)
        .where('event_id', '=', id)
        .execute();

      return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Reminder rule updated.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/events/:id/reminder-rules/:ruleId/delete', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id, ruleId } = req.params as { id: string; ruleId: string };

    try {
      const row = await params.db
        .selectFrom('reminder_rules')
        .innerJoin('events', 'events.id', 'reminder_rules.event_id')
        .select(['reminder_rules.id'])
        .where('reminder_rules.id', '=', ruleId)
        .where('reminder_rules.event_id', '=', id)
        .where('events.manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!row) throw new Error('Reminder rule not found.');

      await params.db
        .deleteFrom('reminder_rules')
        .where('id', '=', ruleId)
        .where('event_id', '=', id)
        .execute();

      return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Reminder rule deleted.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/events/:id/image', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    try {
      const event = await params.db
        .selectFrom('events')
        .select(['id', 'image_path'])
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

      const filePart = await (req as any).file();
      if (!filePart?.file) throw new Error('Image file is required.');
      const mimeExt = imageExtFromMime(String(filePart.mimetype ?? ''));
      const fileBuffer = await filePart.toBuffer();
      const magicExt = imageExtFromMagicBytes(fileBuffer);
      if (!mimeExt || !magicExt) throw new Error('Unsupported image type. Please upload a PNG, JPG, WebP, or GIF.');
      if (mimeExt !== magicExt) throw new Error('Image file contents do not match the declared image type.');
      const ext = magicExt;

      const name = `event-${id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const target = path.join(eventImagesDir, name);
      fs.writeFileSync(target, fileBuffer, { flag: 'wx' });

      await params.db
        .updateTable('events')
        .set({ image_path: `/event-images/${name}` })
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .execute();

      const oldPath = event.image_path;
      if (typeof oldPath === 'string' && oldPath.startsWith('/event-images/') && oldPath !== `/event-images/${name}`) {
        const oldName = oldPath.slice('/event-images/'.length);
        if (oldName) {
          try {
            fs.unlinkSync(path.join(eventImagesDir, oldName));
          } catch {
            // ignore
          }
        }
      }

      return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Event image updated.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/events/:id/image/clear', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const event = await params.db
      .selectFrom('events')
      .select(['id', 'image_path'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    await params.db
      .updateTable('events')
      .set({ image_path: null })
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .execute();

    const oldPath = event.image_path;
    if (typeof oldPath === 'string' && oldPath.startsWith('/event-images/')) {
      const oldName = oldPath.slice('/event-images/'.length);
      if (oldName) {
        try {
          fs.unlinkSync(path.join(eventImagesDir, oldName));
        } catch {
          // ignore
        }
      }
    }

    return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Event image removed.')}`);
  });

  app.post('/manager/events/:id/publish', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const ev = await params.db
      .selectFrom('events')
      .select(['is_archived', 'cancelled_at', 'location_name', 'location_map_url', 'location_lat', 'location_lng'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!ev) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });
    if (ev.is_archived) return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent('Event is archived.')}`);
    if (ev.cancelled_at) return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent('Event is cancelled.')}`);

    const shifts = await params.db
      .selectFrom('shifts')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('event_id', '=', id)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (Number(shifts?.c ?? 0) === 0) return reply.code(303).redirect(`/manager/events/${id}/edit?err=add_shift`);

    const locationName = String(ev.location_name ?? '').trim();
    const currentLat = ev.location_lat == null ? null : Number(ev.location_lat);
    const currentLng = ev.location_lng == null ? null : Number(ev.location_lng);
    const hasValidCoords = currentLat !== null && currentLng !== null && !isInvalidCoordPair(currentLat, currentLng);
    if (locationName && !hasValidCoords) {
      const resolved = await resolveEventLocationCoords(locationName, String(ev.location_map_url ?? ''));
      if (!resolved) {
        return reply
          .code(303)
          .redirect(`/manager/events/${id}/edit?err=${encodeURIComponent("Address couldn't be located. Use a full street address with city/state (or ZIP).")}`);
      }
      await params.db
        .updateTable('events')
        .set({
          location_lat: resolved.lat.toFixed(6),
          location_lng: resolved.lng.toFixed(6)
        })
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .execute();
    }

    await params.db
      .updateTable('events')
      .set({ is_published: true })
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .execute();
    return reply.code(303).redirect(`/manager/events/${id}/edit`);
  });

  app.post('/manager/events/:id/unpublish', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    await params.db
      .updateTable('events')
      .set({ is_published: false })
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .execute();
    return reply.code(303).redirect(`/manager/events/${id}/edit`);
  });

  app.post('/manager/events/:id/archive', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };

    const event = await params.db
      .selectFrom('events')
      .select(['id', 'is_archived'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });
    if (event.is_archived) return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Event already archived.')}`);

    await params.db
      .updateTable('events')
      .set({ is_archived: true, is_published: false })
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .execute();
    await syncUnderstaffed(id);

    return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Event archived. It is now unpublished.')}`);
  });

  app.post('/manager/events/:id/unarchive', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };

    const event = await params.db
      .selectFrom('events')
      .select(['id', 'is_archived'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });
    if (!event.is_archived) return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Event is not archived.')}`);

    await params.db
      .updateTable('events')
      .set({ is_archived: false })
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .execute();
    await syncUnderstaffed(id);

    return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Event unarchived. Publish when ready.')}`);
  });

  app.post('/manager/events/:id/shifts', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const roleName = String(body.roleName ?? '').trim();
    const roleDescription = String(body.roleDescription ?? '').trim();
    const shiftDate = String(body.shiftDate ?? '').trim();
    const startTime = String(body.startTime ?? '').trim();
    const durationMinutes = Number(body.durationMinutes ?? 0);
    const minVolunteers = Number(body.minVolunteers ?? 0);
    const maxVolunteers = Number(body.maxVolunteers ?? 0);
    try {
      if (!roleName || roleName.length > 120) throw new Error('Invalid role name.');
      const sd = parseDateOnly(shiftDate);
      if (!startTime) throw new Error('Start time is required.');
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error('Invalid duration.');
      if (!Number.isFinite(minVolunteers) || minVolunteers < 0) throw new Error('Invalid min volunteers.');
      if (!Number.isFinite(maxVolunteers) || maxVolunteers <= 0) throw new Error('Invalid max volunteers.');

      const ev = await params.db
        .selectFrom('events')
        .select(['id', 'is_archived', 'cancelled_at'])
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!ev) throw new Error('Event not found.');
      if (ev.is_archived) throw new Error('Event is archived.');
      if (ev.cancelled_at) throw new Error('Event is cancelled.');

      const endTime = endTimeFromStartAndDuration(startTime, durationMinutes);
      const startTimeDb = `${String(startTime).slice(0, 5)}:00`;

      await params.db
        .insertInto('shifts')
        .values({
          event_id: id,
          role_name: roleName,
          role_description: roleDescription || null,
          duration_minutes: durationMinutes,
          shift_date: sd,
          start_time: startTimeDb,
          end_time: endTime,
          min_volunteers: minVolunteers,
          max_volunteers: maxVolunteers,
          is_active: true
        })
        .execute();
      await syncUnderstaffed(id);
      return reply.code(303).redirect(`/manager/events/${id}/edit`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/events/:id/shifts/from-template', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const templateId = String(body.templateId ?? '').trim();
    const shiftDate = String(body.shiftDate ?? '').trim();
    const startTime = String(body.startTime ?? '').trim();

    try {
      if (!templateId) throw new Error('Template is required.');
      const sd = parseDateOnly(shiftDate);
      if (!startTime) throw new Error('Start time is required.');

      const ev = await params.db
        .selectFrom('events')
        .select(['id', 'is_archived', 'cancelled_at'])
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!ev) throw new Error('Event not found.');
      if (ev.is_archived) throw new Error('Event is archived.');
      if (ev.cancelled_at) throw new Error('Event is cancelled.');

      const tpl = await params.db
        .selectFrom('role_templates')
        .select(['id', 'role_name', 'role_description', 'duration_minutes', 'default_min_volunteers', 'default_max_volunteers'])
        .where('id', '=', templateId)
        .where('owner_user_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!tpl) throw new Error('Template not found.');

      const endTime = endTimeFromStartAndDuration(startTime, tpl.duration_minutes);
      const startTimeDb = `${String(startTime).slice(0, 5)}:00`;

      await params.db
        .insertInto('shifts')
        .values({
          event_id: id,
          role_name: tpl.role_name,
          role_description: tpl.role_description,
          duration_minutes: tpl.duration_minutes,
          shift_date: sd,
          start_time: startTimeDb,
          end_time: endTime,
          min_volunteers: tpl.default_min_volunteers,
          max_volunteers: tpl.default_max_volunteers,
          is_active: true
        })
        .execute();
      await syncUnderstaffed(id);

      return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Shift added from template.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/edit?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/shifts/:id/toggle', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const row = await params.db
      .selectFrom('shifts')
      .innerJoin('events', 'events.id', 'shifts.event_id')
      .select(['shifts.id as shift_id', 'shifts.is_active', 'events.id as event_id'])
      .where('shifts.id', '=', id)
      .where('events.manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!row) return reply.code(404).view('not_found.njk', { message: 'Shift not found.' });
    await params.db.updateTable('shifts').set({ is_active: !row.is_active }).where('id', '=', id).execute();
    await syncUnderstaffed(row.event_id);
    return reply.code(303).redirect(`/manager/events/${row.event_id}/edit`);
  });

  app.post('/manager/shifts/:id/update', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const eventId = String(body.eventId ?? '').trim();
    const roleName = String(body.roleName ?? '').trim();
    const roleDescription = String(body.roleDescription ?? '').trim();
    const shiftDate = String(body.shiftDate ?? '').trim();
    const startTime = String(body.startTime ?? '').trim();
    const durationMinutes = Number(body.durationMinutes ?? 0);
    const minVolunteers = Number(body.minVolunteers ?? 0);
    const maxVolunteers = Number(body.maxVolunteers ?? 0);

    let fallbackEventId = eventId;
    try {
      if (!roleName || roleName.length > 120) throw new Error('Invalid role name.');
      const sd = parseDateOnly(shiftDate);
      if (!startTime) throw new Error('Start time is required.');
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error('Invalid duration.');
      if (!Number.isFinite(minVolunteers) || minVolunteers < 0) throw new Error('Invalid min volunteers.');
      if (!Number.isFinite(maxVolunteers) || maxVolunteers <= 0) throw new Error('Invalid max volunteers.');

      const row = await params.db
        .selectFrom('shifts')
        .innerJoin('events', 'events.id', 'shifts.event_id')
        .select(['shifts.id as shift_id', 'shifts.event_id', 'events.manager_id'])
        .where('shifts.id', '=', id)
        .executeTakeFirst();
      if (!row || row.manager_id !== currentUser.id) throw new Error('Shift not found.');
      fallbackEventId = fallbackEventId || row.event_id;

      const active = await params.db
        .selectFrom('signups')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('shift_id', '=', id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const activeCount = Number(active?.c ?? 0);
      if (maxVolunteers < activeCount) throw new Error(`Max volunteers cannot be less than current active signups (${activeCount}).`);

      const endTime = endTimeFromStartAndDuration(startTime, durationMinutes);
      const startTimeDb = `${String(startTime).slice(0, 5)}:00`;

      await params.db
        .updateTable('shifts')
        .set({
          role_name: roleName,
          role_description: roleDescription || null,
          duration_minutes: durationMinutes,
          shift_date: sd,
          start_time: startTimeDb,
          end_time: endTime,
          min_volunteers: minVolunteers,
          max_volunteers: maxVolunteers
        })
        .where('id', '=', id)
        .execute();
      await syncUnderstaffed(row.event_id);

      return reply.code(303).redirect(`/manager/events/${eventId || row.event_id}/edit#shift-${id}`);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const target = fallbackEventId ? `/manager/events/${fallbackEventId}/edit` : '/manager/events';
      return reply.code(303).redirect(`${target}?err=${encodeURIComponent(msg)}#shift-${id}`);
    }
  });

  app.post('/manager/shifts/:id/delete', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const eventId = String(body.eventId ?? '').trim();

    try {
      const row = await params.db
        .selectFrom('shifts')
        .innerJoin('events', 'events.id', 'shifts.event_id')
        .select(['shifts.event_id', 'events.manager_id'])
        .where('shifts.id', '=', id)
        .executeTakeFirst();
      if (!row || row.manager_id !== currentUser.id) throw new Error('Shift not found.');

      const count = await params.db
        .selectFrom('signups')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('shift_id', '=', id)
        .executeTakeFirst();
      if (Number(count?.c ?? 0) > 0) throw new Error('Cannot delete a shift that has signups. Deactivate it instead.');

      await params.db.deleteFrom('shifts').where('id', '=', id).execute();
      await syncUnderstaffed(row.event_id);
      return reply.code(303).redirect(`/manager/events/${eventId || row.event_id}/edit`);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      return reply.code(303).redirect(`/manager/events/${encodeURIComponent(eventId)}/edit?err=${encodeURIComponent(msg)}#shift-${id}`);
    }
  });

  app.post('/manager/events/:id/cancel', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const event = await params.db
      .selectFrom('events')
      .select(['id', 'cancelled_at'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });
    if (event.cancelled_at) return reply.code(303).redirect(`/manager/events/${id}/edit?ok=${encodeURIComponent('Event already cancelled.')}`);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = String(body.message ?? '');
    try {
      const res = await cancelEventAndNotify({ db: params.db, slugOrId: id, message });
      await syncUnderstaffed(id);
      return reply
        .code(303)
        .redirect(
          `/manager/events/${id}/edit?ok=${encodeURIComponent(`Event cancelled. Notifications queued: ${res.notified}.`)}`
        );
    } catch (err: any) {
      return reply
        .code(303)
        .redirect(`/manager/events/${id}/cancel?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.get('/manager/events/:id/cancel', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const event = await params.db
      .selectFrom('events')
      .select(['id', 'title', 'cancelled_at', 'cancellation_message'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    return render(reply, 'manager_event_cancel.njk', {
      error,
      event: {
        id: event.id,
        title: event.title,
        cancelledAt: event.cancelled_at,
        cancellationMessage: event.cancellation_message
      }
    });
  });

  app.get('/manager/events/:id/broadcast', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const event = await params.db
      .selectFrom('events')
      .innerJoin('organizations', 'organizations.id', 'events.organization_id')
      .select(['events.id', 'events.title', 'events.slug', 'organizations.name as organization_name'])
      .where('events.id', '=', id)
      .where('events.manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const shifts = await params.db
      .selectFrom('shifts')
      .select(['id', 'role_name', 'shift_date', 'start_time', 'end_time'])
      .where('event_id', '=', id)
      .where('is_active', '=', true)
      .orderBy('shift_date', 'asc')
      .orderBy('start_time', 'asc')
      .execute();

    const counts = await params.db
      .selectFrom('signups')
      .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
      .select(['signups.shift_id'])
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('shifts.event_id', '=', id)
      .where('signups.status', '=', 'active')
      .groupBy('signups.shift_id')
      .execute();
    const countByShift = new Map<string, number>();
    for (const row of counts as any[]) countByShift.set(String(row.shift_id), Number(row.c ?? 0));

    const totalActive = Array.from(countByShift.values()).reduce((a, b) => a + b, 0);

    return render(reply, 'manager_event_broadcast.njk', {
      ok,
      error,
      event: {
        id: event.id,
        title: event.title,
        organizationName: (event as any).organization_name,
        publicUrl: `/events/${encodeURIComponent((event as any).slug ?? event.id)}`,
        totalActive
      },
      shifts: shifts.map((s: any) => ({
        id: s.id,
        roleName: s.role_name,
        shiftDate: toDateOnly(s.shift_date),
        startTime: String(s.start_time).slice(0, 5),
        endTime: String(s.end_time).slice(0, 5),
        activeCount: countByShift.get(String(s.id)) ?? 0
      }))
    });
  });

  app.post('/manager/events/:id/broadcast', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subject = String(body.subject ?? '').trim();
    const message = String(body.message ?? '').trim();
    const shiftId = String(body.shiftId ?? '').trim();

    try {
      if (!subject || subject.length > 200 || subject.includes('\n') || subject.includes('\r')) {
        throw new Error('Subject is required (max 200 chars).');
      }
      if (!message || message.length > 20000) throw new Error('Message is required (max 20000 chars).');

      const event = await params.db
        .selectFrom('events')
        .select(['id', 'slug', 'title', 'manager_id'])
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!event) throw new Error('Event not found.');

      if (shiftId) {
        const shift = await params.db
          .selectFrom('shifts')
          .select(['id'])
          .where('id', '=', shiftId)
          .where('event_id', '=', id)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (!shift) throw new Error('Selected shift not found.');
      }

      let q = params.db
        .selectFrom('signups')
        .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
        .select([
          'signups.id as signup_id',
          'signups.email',
          'signups.first_name',
          'signups.cancel_token',
          'shifts.id as shift_id',
          'shifts.role_name',
          'shifts.shift_date',
          'shifts.start_time',
          'shifts.end_time'
        ])
        .where('shifts.event_id', '=', id)
        .where('signups.status', '=', 'active');

      if (shiftId) q = q.where('shifts.id', '=', shiftId);

      const recipients = await q.execute();
      if (recipients.length === 0) throw new Error('No active signups match this selection.');

      const eventUrl = `${config.appUrl}/events/${encodeURIComponent((event as any).slug ?? event.id)}`;
      const kind = `broadcast_manual_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      let sent = 0;

      for (const r of recipients as any[]) {
        const cancelUrl = r.cancel_token ? `${config.appUrl}/cancel/${encodeURIComponent(r.cancel_token)}` : '';
        const shiftWhen = `${toDateOnly(r.shift_date)} ${String(r.start_time).slice(0, 5)}–${String(r.end_time).slice(0, 5)}`;
        const text = [
          `Hi ${String(r.first_name ?? '').trim() || 'volunteer'},`,
          '',
          message,
          '',
          `Event: ${event.title}`,
          `Shift: ${r.role_name} (${shiftWhen})`,
          `Event page: ${eventUrl}`,
          cancelUrl ? `Need to cancel? ${cancelUrl}` : '',
          '',
          `— LocalShifts`
        ]
          .filter(Boolean)
          .join('\n');

        const inserted = await params.db
          .insertInto('notification_sends')
          .values({
            kind,
            event_id: event.id,
            signup_id: r.signup_id,
            to_email: r.email,
            subject,
            body: text,
            status: 'queued'
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        try {
          await sendEmail({ to: r.email, subject, text }, { db: params.db });
          sent += 1;
          await params.db
            .updateTable('notification_sends')
            .set({ status: 'sent', sent_at: new Date().toISOString(), error: null })
            .where('id', '=', inserted.id)
            .execute();
        } catch (err: any) {
          await params.db
            .updateTable('notification_sends')
            .set({ status: 'failed', error: String(err?.message ?? err) })
            .where('id', '=', inserted.id)
            .execute();
        }
      }

      return reply
        .code(303)
        .redirect(`/manager/events/${id}/broadcast?ok=${encodeURIComponent(`Broadcast queued for ${recipients.length} signup(s). Sent: ${sent}.`)}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/broadcast?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.get('/manager/events/:id/signups', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;
    const error = typeof qs.err === 'string' ? qs.err : undefined;

    const event = await params.db
      .selectFrom('events')
      .select(['id', 'title'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const shifts = await params.db
      .selectFrom('shifts')
      .select(['id', 'role_name', 'shift_date', 'start_time', 'end_time', 'max_volunteers'])
      .where('event_id', '=', id)
      .orderBy('shift_date', 'asc')
      .orderBy('start_time', 'asc')
      .execute();

    const signups = await params.db
      .selectFrom('signups')
      .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
      .select([
        'signups.id',
        'signups.shift_id',
        'signups.first_name',
        'signups.last_name',
        'signups.email',
        'signups.status',
        'signups.created_at'
      ])
      .where('shifts.event_id', '=', id)
      .orderBy('signups.created_at', 'asc')
      .execute();

    const byShift = new Map<string, any[]>();
    for (const s of signups) {
      const list = byShift.get(s.shift_id) ?? [];
      list.push({
        id: s.id,
        firstName: s.first_name,
        lastName: s.last_name,
        email: s.email,
        status: s.status,
        createdAt: formatDateTimeInAppTimezone(s.created_at)
      });
      byShift.set(s.shift_id, list);
    }

    const activeCountByShift = new Map<string, number>();
    for (const s of signups) {
      if (s.status !== 'active') continue;
      activeCountByShift.set(s.shift_id, (activeCountByShift.get(s.shift_id) ?? 0) + 1);
    }

    return render(reply, 'manager_signups.njk', {
      ok,
      error,
      event: { id: event.id, title: event.title },
      shifts: shifts.map((sh) => ({
        id: sh.id,
        roleName: sh.role_name,
        shiftDate: toDateOnly(sh.shift_date),
        startTime: String(sh.start_time).slice(0, 5),
        endTime: String(sh.end_time).slice(0, 5),
        maxVolunteers: sh.max_volunteers,
        activeCount: activeCountByShift.get(sh.id) ?? 0,
        signups: byShift.get(sh.id) ?? []
      }))
    });
  });

  app.get('/manager/events/:id/signups.csv', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };

    const event = await params.db
      .selectFrom('events')
      .select(['id', 'title'])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).send('not found');

    const rows = await params.db
      .selectFrom('signups')
      .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
      .select([
        'signups.first_name',
        'signups.last_name',
        'signups.email',
        'signups.status',
        'signups.created_at',
        'shifts.role_name',
        'shifts.shift_date',
        'shifts.start_time',
        'shifts.end_time'
      ])
      .where('shifts.event_id', '=', id)
      .orderBy('shifts.shift_date', 'asc')
      .orderBy('shifts.start_time', 'asc')
      .orderBy('signups.created_at', 'asc')
      .execute();

    const esc = (v: unknown) => {
      const s = String(v ?? '');
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const header = ['role', 'shift_date', 'start_time', 'end_time', 'first_name', 'last_name', 'email', 'status', 'signed_up_at'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          esc(r.role_name),
          esc(r.shift_date),
          esc(String(r.start_time).slice(0, 5)),
          esc(String(r.end_time).slice(0, 5)),
          esc(r.first_name),
          esc(r.last_name),
          esc(r.email),
          esc(r.status),
          esc(toIso(r.created_at))
        ].join(',')
      );
    }

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${event.title.replace(/[^a-z0-9-_]+/gi, '_')}_signups.csv"`);
    return reply.send(lines.join('\n'));
  });

  app.post('/manager/events/:id/signups/add', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const shiftId = String(body.shiftId ?? '').trim();
    const firstName = String(body.firstName ?? '');
    const lastName = String(body.lastName ?? '');
    const email = String(body.email ?? '').trim();

    try {
      if (!shiftId) throw new Error('Shift is required.');
      const shift = await params.db
        .selectFrom('shifts')
        .innerJoin('events', 'events.id', 'shifts.event_id')
        .select(['shifts.id', 'shifts.max_volunteers', 'shifts.shift_date', 'events.is_archived', 'events.cancelled_at'])
        .where('shifts.id', '=', shiftId)
        .where('events.id', '=', id)
        .where('events.manager_id', '=', currentUser.id)
        .executeTakeFirst();
      if (!shift) throw new Error('Shift not found.');
      if (shift.is_archived || shift.cancelled_at) throw new Error('Event not accepting signups.');

      const filled = await params.db
        .selectFrom('signups')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('shift_id', '=', shiftId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (Number(filled?.c ?? 0) >= shift.max_volunteers) throw new Error('Shift is full.');

      // Reuse volunteer signup logic (includes duplicate protection + token creation) but without "must be published".
      const created = await createSignup({ db: params.db, shiftId, firstName, lastName, email, allowUnpublished: true });
      await syncUnderstaffed(id);
      try {
        await sendSignupConfirmation(params.db, created.signupId);
      } catch (err) {
        app.log.warn({ err }, 'manual signup confirmation email failed');
      }
      return reply.code(303).redirect(`/manager/events/${id}/signups?ok=${encodeURIComponent('Signup added.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/events/${id}/signups?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/signups/:signupId/cancel', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { signupId } = req.params as { signupId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const eventId = String(body.eventId ?? '').trim();

    const row = await params.db
      .selectFrom('signups')
      .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
      .innerJoin('events', 'events.id', 'shifts.event_id')
      .select(['signups.id as signup_id', 'events.id as event_id'])
      .where('signups.id', '=', signupId)
      .where('events.manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!row) return reply.code(404).view('not_found.njk', { message: 'Signup not found.' });

    await params.db
      .updateTable('signups')
      .set({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .where('id', '=', signupId)
      .where('status', '=', 'active')
      .execute();
    await syncUnderstaffed(row.event_id);

    try {
      await sendManagerRemovalNotice(params.db, signupId);
    } catch (err) {
      app.log.warn({ err }, 'manager removal notice failed');
    }

    const redirectEventId = eventId || row.event_id;
    return reply.code(303).redirect(`/manager/events/${redirectEventId}/signups?ok=${encodeURIComponent('Signup removed.')}`);
  });

  app.post('/manager/signups/:signupId/resend', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const { signupId } = req.params as { signupId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const eventId = String(body.eventId ?? '').trim();

    const row = await params.db
      .selectFrom('signups')
      .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
      .innerJoin('events', 'events.id', 'shifts.event_id')
      .select(['signups.id as signup_id', 'signups.status', 'events.id as event_id'])
      .where('signups.id', '=', signupId)
      .where('events.manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!row) return reply.code(404).view('not_found.njk', { message: 'Signup not found.' });
    if (row.status !== 'active') {
      const redirectEventId = eventId || row.event_id;
      return reply.code(303).redirect(`/manager/events/${redirectEventId}/signups?err=${encodeURIComponent('Signup is not active.')}`);
    }

    try {
      await sendSignupConfirmationWithKind(params.db, signupId, `signup_confirmation_manual_${Date.now()}`);
      const redirectEventId = eventId || row.event_id;
      return reply.code(303).redirect(`/manager/events/${redirectEventId}/signups?ok=${encodeURIComponent('Confirmation email queued.')}`);
    } catch (err: any) {
      const redirectEventId = eventId || row.event_id;
      return reply
        .code(303)
        .redirect(`/manager/events/${redirectEventId}/signups?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/ops/events/:slugOrId/cancel', async (req, reply) => {
    try {
      requireAdminToken(req);
      const { slugOrId } = req.params as { slugOrId: string };
      let body: Record<string, unknown> = (req.body ?? {}) as Record<string, unknown>;
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      const message = String(body.message ?? '');
      const res = await cancelEventAndNotify({ db: params.db, slugOrId, message });
      const event = await params.db
        .selectFrom('events')
        .select(['id'])
        .where(sql<boolean>`(events.slug = ${slugOrId} or events.id::text = ${slugOrId})`)
        .executeTakeFirst();
      if (event?.id) await syncUnderstaffed(event.id);
      return reply.send(res);
    } catch (err: any) {
      const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return reply.code(statusCode).send({ statusCode, error: 'Bad Request', message: String(err?.message ?? err) });
    }
  });

  app.post('/ops/email/test', async (req, reply) => {
    try {
      requireAdminToken(req);
      let body: Record<string, unknown> = (req.body ?? {}) as Record<string, unknown>;
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }

      const to = String(body.to ?? '').trim();
      const subject = String(body.subject ?? 'LocalShifts test email').trim();
      const text = String(body.text ?? 'This is a test email from LocalShifts.').trim();

      if (!to || !to.includes('@') || /\s/.test(to) || to.includes('\n') || to.includes('\r')) throw new Error('Valid `to` email is required.');
      if (!subject || subject.length > 200 || subject.includes('\n') || subject.includes('\r')) throw new Error('Valid `subject` is required.');
      if (!text || text.length > 20_000) throw new Error('Valid `text` is required.');

      await sendEmail({ to, subject, text }, { db: params.db });
      return reply.send({ ok: true });
    } catch (err: any) {
      const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return reply.code(statusCode).send({ statusCode, error: 'Bad Request', message: String(err?.message ?? err) });
    }
  });

  app.get('/ops/health', async (req, reply) => {
    try {
      requireAdminToken(req);
      await sql`select 1 as ok`.execute(params.db);
      return reply.send({ ok: true, db: 'ok' as const });
    } catch (err: any) {
      const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      return reply.code(statusCode).send({ ok: false, error: String(err?.message ?? err) });
    }
  });

  app.get('/ops/templates/compile', async (req, reply) => {
    try {
      requireAdminToken(req);
      const viewsDir = path.join(projectRoot, 'views');
      const res = compileNunjucksTemplates({ viewsDir });
      return reply.send({ ok: true, ...res });
    } catch (err: any) {
      const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      return reply.code(statusCode).send({ ok: false, error: String(err?.message ?? err) });
    }
  });

  app.get('/ops/version', async (req, reply) => {
    try {
      requireAdminToken(req);
      const gitSha = process.env.APP_GIT_SHA ?? '';
      const builtAt = process.env.APP_BUILD_TIME ?? '';
      return reply.send({
        ok: true,
        env: config.env,
        gitSha: gitSha || null,
        builtAt: builtAt || null,
        node: process.version
      });
    } catch (err: any) {
      const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      return reply.code(statusCode).send({ ok: false, error: String(err?.message ?? err) });
    }
  });

  app.get('/ops/diag/schema', async (req, reply) => {
    requireAdminToken(req);

    const expected: Record<string, string[]> = {
      users: ['id', 'email', 'password_hash', 'display_name', 'role', 'is_active', 'created_at', 'updated_at'],
      organizations: ['id', 'name', 'slug', 'created_by', 'created_at', 'updated_at'],
      events: [
        'id',
        'organization_id',
        'manager_id',
        'slug',
        'title',
        'description_html',
        'start_date',
        'end_date',
        'is_published',
        'is_archived',
        'cancelled_at',
        'cancellation_message',
        'created_at',
        'updated_at'
      ],
      shifts: [
        'id',
        'event_id',
        'role_name',
        'duration_minutes',
        'shift_date',
        'start_time',
        'end_time',
        'min_volunteers',
        'max_volunteers',
        'is_active',
        'created_at',
        'updated_at'
      ],
      signups: [
        'id',
        'shift_id',
        'first_name',
        'last_name',
        'email',
        'status',
        'cancel_token',
        'cancel_token_hmac',
        'cancel_token_expires_at',
        'created_at',
        'updated_at'
      ],
      sessions: ['id', 'user_id', 'data', 'expires_at', 'created_at', 'updated_at'],
      volunteer_email_tokens: ['id', 'email', 'token_hmac', 'expires_at', 'used_at', 'created_at'],
      notification_sends: ['id', 'kind', 'to_email', 'subject', 'body', 'status', 'error', 'created_at', 'sent_at']
    };

    const missingTables: string[] = [];
    const missingColumns: Record<string, string[]> = {};
    const presentColumns: Record<string, string[]> = {};

    for (const table of Object.keys(expected)) {
      const exists = await sql<{ c: number }>`
        select count(*)::int as c
        from information_schema.tables
        where table_schema = 'public'
          and table_name = ${table}
      `.execute(params.db);
      const tableExists = Number(exists.rows?.[0]?.c ?? 0) > 0;
      if (!tableExists) {
        missingTables.push(table);
        continue;
      }

      const colsRes = await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = ${table}
        order by ordinal_position
      `.execute(params.db);
      const cols = colsRes.rows.map((r) => r.column_name);
      presentColumns[table] = cols;
      const missing = expected[table].filter((c) => !cols.includes(c));
      if (missing.length) missingColumns[table] = missing;
    }

    let pgcryptoInstalled = false;
    try {
      const ext = await sql<{ extname: string }>`
        select extname from pg_extension where extname = 'pgcrypto'
      `.execute(params.db);
      pgcryptoInstalled = ext.rows.length > 0;
    } catch {
      // ignore
    }

    let appliedMigrations: string[] = [];
    try {
      const mig = await sql<{ name: string }>`select name from schema_migrations order by name`.execute(params.db);
      appliedMigrations = mig.rows.map((r) => r.name);
    } catch {
      appliedMigrations = [];
    }

    let migrationsOnDisk: string[] = [];
    try {
      migrationsOnDisk = fs.readdirSync(path.join(projectRoot, 'migrations')).filter((n) => n.endsWith('.sql')).sort();
    } catch {
      migrationsOnDisk = [];
    }

    const ok = missingTables.length === 0 && Object.keys(missingColumns).length === 0;
    return reply.send({
      ok,
      pgcryptoInstalled,
      schema: { missingTables, missingColumns, presentColumns },
      migrations: { applied: appliedMigrations, onDisk: migrationsOnDisk }
    });
  });

  return app;
}
