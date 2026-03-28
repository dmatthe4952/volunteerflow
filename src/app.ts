import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
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
import { hexToRgbTriplet, listEventCategories } from './event_categories.js';
import {
  cancelSignup,
  createSignup,
  findActiveSignupByCancelToken,
  getPublicEventBySlugOrIdForViewer,
  listPublicEventsFiltered,
  listViewerActiveSignups,
  requestMySignupsToken,
  verifyMySignupsToken
} from './public.js';
import { cancelEventAndNotify, requireAdminToken } from './ops.js';
import { canSendEmail, sendEmail } from './email.js';
import {
  authenticateUser,
  createSession,
  createUser,
  deleteSession,
  hasAnySuperAdmin,
  loadCurrentUserFromSession
} from './auth.js';
import {
  sendCancellationEmails,
  sendManagerRemovalNotice,
  sendSignupConfirmation,
  sendSignupConfirmationWithKind
} from './notifications.js';
import { compileNunjucksTemplates } from './templates.js';

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
    const navCategoriesRaw =
      Array.isArray(data?.navCategories) && data.navCategories.length > 0 ? null : await listEventCategories(params.db);
    const navCategories =
      Array.isArray(data?.navCategories) && data.navCategories.length > 0
        ? data.navCategories
        : navCategoriesRaw!.map((c) => ({
            slug: c.slug,
            label: c.label,
            colorHex: c.color,
            colorRgb: hexToRgbTriplet(c.color) ?? '15, 118, 110'
          }));
    return reply.view(template, { ...data, currentUser, navCategories });
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

  app.get('/', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const showAll = qs.all === '1';
    const raw = typeof qs.category === 'string' ? qs.category.trim() : '';
    const cats = await listEventCategories(params.db);
    const navCategories = cats.map((c) => ({
      slug: c.slug,
      label: c.label,
      colorHex: c.color,
      colorRgb: hexToRgbTriplet(c.color) ?? '15, 118, 110'
    }));

    const allowed = new Set(cats.filter((c) => c.isActive).map((c) => c.slug));
    const category: EventCategory | null = showAll ? null : raw && allowed.has(raw) ? raw : 'featured';

    const events = await listPublicEventsFiltered(params.db, showAll ? null : category);
    const showSeedHint = config.env === 'development' || config.env === 'test';
    return render(reply, 'index.njk', { events, showSeedHint, navAddEventOnly: true, navCategories });
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
    return render(reply, 'sign_in.njk', {});
  });

  app.get('/forgot-password', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const raw = String(qs.role ?? '').trim().toLowerCase();
    const role = raw === 'admin' ? 'admin' : raw === 'manager' ? 'manager' : '';
    return render(reply, 'forgot_password.njk', { role });
  });

  app.post('/add-event', async (req, reply) => {
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
          await sendEmail({ to, subject, text: bodyText });
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
  });

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

  app.post('/my/request', async (req, reply) => {
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

      const hasSmtp = Boolean(config.smtp.host && config.smtp.fromEmail);

      // In test we never send real email.
      // In development we show the shortcut only when SMTP isn't configured.
      if (config.env === 'test' || (config.env === 'development' && !hasSmtp)) {
        return render(reply, 'my_email_sent.njk', {
          email,
          verifyUrlOneTime,
          expiresAt: expiresAt.toISOString()
        });
      }

      if (!canSendEmail()) {
        return reply.code(501).view('my_email_sent.njk', { email, error: 'Email sending is not configured yet.' });
      }

      await sendEmail({
        to: email,
        subject: 'Your VolunteerFlow sign-in link',
        text: [
          'Click to view signups:',
          '',
          verifyUrlOneTime,
          '',
          'This link can be used once and expires in 30 minutes.'
        ].join('\n'),
        html: [
          '<p><a href="' + verifyUrlOneTime + '">Click to view signups</a></p>',
          '<p style="color:#666;font-size:14px;margin:0">This link can be used once and expires in 30 minutes.</p>'
        ].join('\n')
      });

      return reply.code(303).redirect('/my?sent=1');
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : 'Unable to send link.';
      return render(reply, 'my_email_sent.njk', { email, error: msg });
    }
  });

  app.get('/my/verify/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const verified = await verifyMySignupsToken(params.db, token);
    if (!verified) {
      const asCancel = await findActiveSignupByCancelToken(params.db, token);
      if (asCancel && asCancel.expired === false) return reply.code(303).redirect(`/cancel/${encodeURIComponent(token)}`);
      return reply.code(410).view('my_link_expired.njk');
    }
    if (verified.expired) return reply.code(410).view('my_link_expired.njk');

    const qs = req.query as Record<string, string | undefined>;
    const remember = qs.remember !== '0';

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
      return reply.code(303).redirect('/admin/login');
    } catch (err: any) {
      return render(reply, 'admin_setup.njk', { error: String(err?.message ?? err) });
    }
  });

  app.get('/admin/login', async (req, reply) => {
    const user = (req as any).currentUser;
    if (user?.role === 'super_admin') return reply.code(303).redirect('/admin/dashboard');
    return render(reply, 'admin_login.njk', {});
  });

  app.post('/admin/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');
    const user = await authenticateUser(params.db, { email, password, role: 'super_admin' });
    if (!user) return render(reply, 'admin_login.njk', { error: 'Invalid email or password.' });
    const sess = await createSession(params.db, { userId: user.id, ttlDays: 30 });
    reply.setCookie('vf_sess', sess.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env !== 'development',
      signed: true,
      maxAge: 60 * 60 * 24 * 30
    });
    return reply.code(303).redirect('/admin/dashboard');
  });

  app.get('/manager/login', async (req, reply) => {
    const user = (req as any).currentUser;
    if (user?.role === 'event_manager') return reply.code(303).redirect('/manager/dashboard');
    return render(reply, 'manager_login.njk', {});
  });

  app.post('/manager/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');
    const user = await authenticateUser(params.db, { email, password, role: 'event_manager' });
    if (!user) return render(reply, 'manager_login.njk', { error: 'Invalid email or password.' });
    const sess = await createSession(params.db, { userId: user.id, ttlDays: 30 });
    reply.setCookie('vf_sess', sess.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env !== 'development',
      signed: true,
      maxAge: 60 * 60 * 24 * 30
    });
    return reply.code(303).redirect('/manager/dashboard');
  });

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
    return reply.code(303).redirect('/');
  });

  app.get('/admin/dashboard', async (req, reply) => {
    requireRole(req, 'super_admin');
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
    return render(reply, 'admin_dashboard.njk', {
      stats: {
        events: Number(events?.c ?? 0),
        upcomingShifts: Number(upcomingShifts?.c ?? 0),
        signups30d: Number(signups30d?.c ?? 0)
      }
    });
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

  // Manager: Event categories
  app.get('/manager/categories', async (req, reply) => {
    requireRole(req, 'event_manager');
    const qs = req.query as Record<string, string | undefined>;
    const error = typeof qs.err === 'string' ? qs.err : undefined;
    const ok = typeof qs.ok === 'string' ? qs.ok : undefined;

    const categories = (await listEventCategories(params.db, { includeInactive: true })).map((c) => ({
      ...c,
      colorRgb: hexToRgbTriplet(c.color) ?? '15, 118, 110'
    }));
    return render(reply, 'manager_categories.njk', {
      error,
      ok,
      categories
    });
  });

  app.post('/manager/categories', async (req, reply) => {
    requireRole(req, 'event_manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = String(body.label ?? '').trim();
    const slugRaw = String(body.slug ?? '').trim();
    const slug = slugRaw ? slugify(slugRaw) : slugify(label);
    const color = String(body.color ?? '').trim();

    try {
      if (!label || label.length > 80) throw new Error('Invalid category name.');
      if (!slug || slug.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid slug.');
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Invalid color (use #RRGGBB).');

      await params.db
        .insertInto('event_categories')
        .values({
          slug,
          label,
          color,
          is_system: false,
          is_active: true,
          sort_order: 100
        })
        .execute();

      return reply.code(303).redirect(`/manager/categories?ok=${encodeURIComponent('Category added.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/categories?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/categories/:id', async (req, reply) => {
    requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = String(body.label ?? '').trim();
    const color = String(body.color ?? '').trim();

    try {
      if (!label || label.length > 80) throw new Error('Invalid category name.');
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Invalid color (use #RRGGBB).');

      await params.db.updateTable('event_categories').set({ label, color }).where('id', '=', id).execute();
      return reply.code(303).redirect(`/manager/categories?ok=${encodeURIComponent('Category updated.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/categories?err=${encodeURIComponent(String(err?.message ?? err))}`);
    }
  });

  app.post('/manager/categories/:id/delete', async (req, reply) => {
    requireRole(req, 'event_manager');
    const { id } = req.params as { id: string };
    try {
      const cat = await params.db
        .selectFrom('event_categories')
        .select(['id', 'slug', 'is_system'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!cat) throw new Error('Category not found.');
      if (cat.is_system) throw new Error('System categories cannot be deleted.');

      await params.db.deleteFrom('event_categories').where('id', '=', id).execute();
      return reply.code(303).redirect(`/manager/categories?ok=${encodeURIComponent('Category deleted.')}`);
    } catch (err: any) {
      return reply.code(303).redirect(`/manager/categories?err=${encodeURIComponent(String(err?.message ?? err))}`);
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
    requireRole(req, 'event_manager');
    const orgs = await params.db.selectFrom('organizations').select(['id', 'name']).orderBy('name', 'asc').execute();
    const categories = await listEventCategories(params.db);
    return render(reply, 'manager_event_new.njk', { orgs, categories });
  });

  app.post('/manager/events/new', async (req, reply) => {
    const currentUser = requireRole(req, 'event_manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = String(body.title ?? '').trim();
    const organizationId = String(body.organizationId ?? '').trim();
    const category = String(body.category ?? '').trim();
    const confirmationEmailNote = String(body.confirmationEmailNote ?? '');
    const date = String(body.date ?? '').trim();
    const description = String(body.description ?? '');
    const locationName = String(body.locationName ?? '').trim();
    const locationMapUrl = String(body.locationMapUrl ?? '').trim();

    try {
      if (!title || title.length > 200) throw new Error('Invalid title.');
      if (!organizationId) throw new Error('Organization is required.');
      const cats = await listEventCategories(params.db);
      const allowed = new Set(cats.map((c) => c.slug));
      const cat = category && allowed.has(category) ? category : 'normal';
      if (confirmationEmailNote.length > 2000) throw new Error('Confirmation note is too long (max 2000 characters).');
      const startDate = parseDateOnly(date);
      const slug = await uniqueEventSlug(title);

      const inserted = await params.db
        .insertInto('events')
        .values({
          organization_id: organizationId,
          manager_id: currentUser.id,
          slug,
          title,
          category: cat as EventCategory,
          confirmation_email_note: confirmationEmailNote.trim() ? confirmationEmailNote.trim() : null,
          description_html: descriptionTextToHtml(description),
          location_name: locationName || null,
          location_map_url: locationMapUrl || null,
          image_path: null,
          event_type: 'one_time',
          recurrence_rule: null,
          start_date: startDate,
          end_date: startDate,
          is_published: false,
          is_archived: false
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      return reply.code(303).redirect(`/manager/events/${inserted.id}/edit`);
    } catch (err: any) {
      const orgs = await params.db.selectFrom('organizations').select(['id', 'name']).orderBy('name', 'asc').execute();
      const categories = await listEventCategories(params.db);
      return render(reply, 'manager_event_new.njk', { orgs, categories, error: String(err?.message ?? err) });
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
        'confirmation_email_note',
        'start_date',
        'end_date',
        'description_html',
        'location_name',
        'location_map_url',
        'image_path',
        'is_published',
        'is_archived',
        'cancelled_at',
        'cancellation_message'
      ])
      .where('id', '=', id)
      .where('manager_id', '=', currentUser.id)
      .executeTakeFirst();
    if (!event) return reply.code(404).view('not_found.njk', { message: 'Event not found.' });

    const orgs = await params.db.selectFrom('organizations').select(['id', 'name']).orderBy('name', 'asc').execute();
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

    const categories = await listEventCategories(params.db);

    const description = unescapeHtml(
      (event.description_html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<\/?p>/gi, '')
    );
    return render(reply, 'manager_event_edit.njk', {
      error,
      ok,
      orgs,
      categories,
      event: {
        id: event.id,
        title: event.title,
        organizationId: event.organization_id,
        category: event.category ?? 'normal',
        confirmationEmailNote: event.confirmation_email_note ?? '',
        startDate: toDateOnly(event.start_date),
        endDate: toDateOnly(event.end_date),
        description,
        locationName: event.location_name ?? '',
        locationMapUrl: event.location_map_url ?? '',
        imagePath: event.image_path ?? '/event-images/default_volunteers.png',
        hasCustomImage: Boolean(event.image_path),
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
    const category = String(body.category ?? '').trim();
    const confirmationEmailNote = String(body.confirmationEmailNote ?? '');
    const startDate = String(body.startDate ?? '').trim();
    const endDate = String(body.endDate ?? '').trim();
    const description = String(body.description ?? '');
    const locationName = String(body.locationName ?? '').trim();
    const locationMapUrl = String(body.locationMapUrl ?? '').trim();

    try {
      if (!title || title.length > 200) throw new Error('Invalid title.');
      if (!organizationId) throw new Error('Organization is required.');
      const cats = await listEventCategories(params.db);
      const allowed = new Set(cats.map((c) => c.slug));
      const cat = (category && allowed.has(category) ? category : 'normal') as EventCategory;
      if (confirmationEmailNote.length > 2000) throw new Error('Confirmation note is too long (max 2000 characters).');
      const sd = parseDateOnly(startDate);
      const ed = parseDateOnly(endDate);

      await params.db
        .updateTable('events')
        .set({
          title,
          organization_id: organizationId,
          category: cat,
          confirmation_email_note: confirmationEmailNote.trim() ? confirmationEmailNote.trim() : null,
          start_date: sd,
          end_date: ed,
          description_html: descriptionTextToHtml(description),
          location_name: locationName || null,
          location_map_url: locationMapUrl || null
        })
        .where('id', '=', id)
        .where('manager_id', '=', currentUser.id)
        .execute();

      return reply.code(303).redirect(`/manager/events/${id}/edit`);
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
      const ext = imageExtFromMime(String(filePart.mimetype ?? ''));
      if (!ext) throw new Error('Unsupported image type. Please upload a PNG, JPG, WebP, or GIF.');

      const name = `event-${id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const target = path.join(eventImagesDir, name);
      await pipeline(filePart.file, fs.createWriteStream(target, { flags: 'wx' }));

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
      .select(['is_archived', 'cancelled_at'])
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
        createdAt: toIso(s.created_at)
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
      const subject = String(body.subject ?? 'VolunteerFlow test email').trim();
      const text = String(body.text ?? 'This is a test email from VolunteerFlow.').trim();

      if (!to || !to.includes('@') || /\s/.test(to) || to.includes('\n') || to.includes('\r')) throw new Error('Valid `to` email is required.');
      if (!subject || subject.length > 200 || subject.includes('\n') || subject.includes('\r')) throw new Error('Valid `subject` is required.');
      if (!text || text.length > 20_000) throw new Error('Valid `text` is required.');

      await sendEmail({ to, subject, text });
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
