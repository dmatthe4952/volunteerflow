import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { config } from './config.js';
import type { DB } from './db.js';
import { sendEmail } from './email.js';

function dateOnlyKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const v = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
}

function formatDateOnly(value: unknown): string {
  const key = dateOnlyKey(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return String(value ?? '');
  // Use UTC to avoid shifting date-only values across timezones.
  const d = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

function formatDateTimeLocal(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(d);
}

function escapeHtml(input: unknown): string {
  return String(input ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function escapeAttr(input: unknown): string {
  // For URLs in href. Basic escaping + strip control chars.
  const s = String(input ?? '').replace(/[\u0000-\u001F\u007F]/g, '');
  return escapeHtml(s);
}

function plainTextToHtml(text: string): string {
  const t = String(text ?? '');
  const escaped = escapeHtml(t);
  return escaped.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '<br/>');
}

async function sendAndRecord(params: {
  db: Kysely<DB>;
  kind: string;
  eventId: string | null;
  signupId: string | null;
  toEmail: string;
  subject: string;
  body: string;
  html?: string;
}) {
  const inserted = await params.db
    .insertInto('notification_sends')
    .values({
      kind: params.kind,
      event_id: params.eventId,
      signup_id: params.signupId,
      to_email: params.toEmail,
      subject: params.subject,
      body: params.body,
      status: 'queued'
    })
    .onConflict((oc) => oc.columns(['kind', 'signup_id']).doNothing())
    .returning(['id'])
    .executeTakeFirst();

  if (!inserted) return { skipped: true as const };

  try {
    await sendEmail({ to: params.toEmail, subject: params.subject, text: params.body, html: params.html });
    await params.db
      .updateTable('notification_sends')
      .set({ status: 'sent', sent_at: new Date().toISOString(), error: null })
      .where('id', '=', inserted.id)
      .execute();
    return { skipped: false as const };
  } catch (err: any) {
    await params.db
      .updateTable('notification_sends')
      .set({ status: 'failed', error: String(err?.message ?? err) })
      .where('id', '=', inserted.id)
      .execute();
    return { skipped: false as const };
  }
}

export async function sendUpcomingShiftReminders(params: {
  db: Kysely<DB>;
  offsetHours: number;
  dryRun?: boolean;
  limit?: number;
}) {
  const offsetHours = Math.floor(Number(params.offsetHours));
  if (!Number.isFinite(offsetHours) || offsetHours < 0 || offsetHours > 24 * 14) {
    throw new Error('Invalid offsetHours (must be between 0 and 336).');
  }

  const limit = Math.floor(Number(params.limit ?? 500));
  if (!Number.isFinite(limit) || limit < 1 || limit > 5000) throw new Error('Invalid limit.');

  const kind = `shift_reminder_${offsetHours}h`;
  const tz = config.timezone;

  const rows = await params.db
    .selectFrom('signups')
    .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
    .innerJoin('events', 'events.id', 'shifts.event_id')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .select([
      'signups.id as signup_id',
      'signups.first_name',
      'signups.email',
      'signups.cancel_token',
      'events.id as event_id',
      'events.title as event_title',
      'events.slug as event_slug',
      'organizations.name as organization_name',
      'shifts.role_name',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time',
      'events.location_name',
      'events.location_map_url'
    ])
    .where('signups.status', '=', 'active')
    .where('shifts.is_active', '=', true)
    .where('events.is_published', '=', true)
    .where('events.is_archived', '=', false)
    .where('events.cancelled_at', 'is', null)
    .where(
      sql<boolean>`
        (
          (shifts.shift_date::timestamp + shifts.start_time) at time zone ${tz}
        ) > now()
        and
        (
          (shifts.shift_date::timestamp + shifts.start_time) at time zone ${tz}
        ) <= now() + (${offsetHours} * interval '1 hour')
      `
    )
    .orderBy('shifts.shift_date', 'asc')
    .orderBy('shifts.start_time', 'asc')
    .limit(limit)
    .execute();

  let queued = 0;
  let skipped = 0;
  for (const row of rows as any[]) {
    const eventUrl = `${config.appUrl}/events/${encodeURIComponent(row.event_slug ?? row.event_id)}`;
    const when = `${formatDateOnly(row.shift_date)} ${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`;
    const cancelUrl = row.cancel_token ? `${config.appUrl}/cancel/${encodeURIComponent(row.cancel_token)}` : '';

    const subject = `Reminder: ${row.event_title} (${when})`;
    const body = [
      `Hi ${row.first_name},`,
      '',
      `This is a reminder about your upcoming volunteer shift:`,
      `${row.event_title} (${row.organization_name})`,
      `Shift: ${row.role_name}`,
      `When: ${when}`,
      row.location_name ? `Where: ${row.location_name}` : '',
      row.location_map_url ? `Directions: ${row.location_map_url}` : '',
      `Event page: ${eventUrl}`,
      cancelUrl ? '' : '',
      cancelUrl ? `Need to cancel? ${cancelUrl}` : '',
      '',
      `— LocalShifts`
    ]
      .filter(Boolean)
      .join('\n');

    const html = [
      `<p>Hi ${escapeHtml(row.first_name)},</p>`,
      `<p>This is a reminder about your upcoming volunteer shift:</p>`,
      `<p><strong>${escapeHtml(row.event_title)}</strong> (${escapeHtml(row.organization_name)})<br/>` +
        `Shift: ${escapeHtml(row.role_name)}<br/>` +
        `When: ${escapeHtml(when)}<br/>` +
        (row.location_name ? `Where: ${escapeHtml(row.location_name)}<br/>` : '') +
        (row.location_map_url ? `<a href="${escapeAttr(row.location_map_url)}">Click for directions</a><br/>` : '') +
        `<a href="${escapeAttr(eventUrl)}">View event details</a><br/>` +
        `</p>`,
      cancelUrl ? `<p><a href="${escapeAttr(cancelUrl)}">Need to cancel? Click here.</a></p>` : '',
      `<p>— LocalShifts</p>`
    ]
      .filter(Boolean)
      .join('\n');

    if (params.dryRun) {
      queued += 1;
      continue;
    }

    const res = await sendAndRecord({
      db: params.db,
      kind,
      eventId: row.event_id,
      signupId: row.signup_id,
      toEmail: row.email,
      subject,
      body,
      html
    });
    if (res.skipped) skipped += 1;
  }

  return { considered: rows.length, wouldSend: queued, skippedAlreadySent: skipped, kind };
}

export async function sendSignupConfirmationWithKind(db: Kysely<DB>, signupId: string, kind: string) {
  const row = await db
    .selectFrom('signups')
    .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
    .innerJoin('events', 'events.id', 'shifts.event_id')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .select([
      'signups.id as signup_id',
      'signups.first_name',
      'signups.email',
      'signups.cancel_token',
      'events.id as event_id',
      'events.title as event_title',
      'events.slug as event_slug',
      'events.confirmation_email_note',
      'organizations.name as organization_name',
      'shifts.role_name',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time',
      'events.location_name',
      'events.location_map_url'
    ])
    .where('signups.id', '=', signupId)
    .executeTakeFirst();

  if (!row) return;
  if (!row.cancel_token) return;

  const cancelUrl = `${config.appUrl}/cancel/${encodeURIComponent(row.cancel_token)}`;
  const eventUrl = `${config.appUrl}/events/${encodeURIComponent((row as any).event_slug ?? row.event_id)}`;
  const subject = `Signup confirmed: ${row.event_title}`;
  const when = `${formatDateOnly(row.shift_date)} ${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`;
  const note = String((row as any).confirmation_email_note ?? '').trim();
  const body = [
    `Hi ${row.first_name},`,
    '',
    `You’re signed up for:`,
    `${row.event_title} (${row.organization_name})`,
    `Shift: ${row.role_name}`,
    `When: ${when}`,
    row.location_name ? `Where: ${row.location_name}` : '',
    row.location_map_url ? `Directions: ${row.location_map_url}` : '',
    `Event page: ${eventUrl}`,
    note ? '' : '',
    note ? `Message from the organizer:` : '',
    note ? note : '',
    '',
    `Need to Cancel? Click here: ${cancelUrl}`,
    '',
    `— LocalShifts`
  ]
    .filter(Boolean)
    .join('\n');

  const html = [
    `<p>Hi ${escapeHtml(row.first_name)},</p>`,
    `<p>You’re signed up for:</p>`,
    `<p><strong>${escapeHtml(row.event_title)}</strong> (${escapeHtml(row.organization_name)})<br/>` +
      `Shift: ${escapeHtml(row.role_name)}<br/>` +
      `When: ${escapeHtml(when)}<br/>` +
      (row.location_name ? `Where: ${escapeHtml(row.location_name)}<br/>` : '') +
      (row.location_map_url ? `<a href="${escapeAttr(row.location_map_url)}">Click for directions</a><br/>` : '') +
      `<a href="${escapeAttr(eventUrl)}">View event details</a><br/>` +
      `</p>`,
    note ? `<p><strong>Message from the organizer</strong><br/>${plainTextToHtml(note)}</p>` : '',
    `<p><a href="${escapeAttr(cancelUrl)}">Need to Cancel? Click here.</a></p>`,
    `<p>— LocalShifts</p>`
  ]
    .filter(Boolean)
    .join('\n');

  await sendAndRecord({
    db,
    kind,
    eventId: row.event_id,
    signupId: row.signup_id,
    toEmail: row.email,
    subject,
    body,
    html
  });
}

export async function sendSignupConfirmation(db: Kysely<DB>, signupId: string) {
  return sendSignupConfirmationWithKind(db, signupId, 'signup_confirmation');
}

export async function sendCancellationEmails(db: Kysely<DB>, signupId: string, cancelledAt: string) {
  const row = await db
    .selectFrom('signups')
    .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
    .innerJoin('events', 'events.id', 'shifts.event_id')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .innerJoin('users', 'users.id', 'events.manager_id')
    .select([
      'signups.id as signup_id',
      'signups.first_name',
      'signups.last_name',
      'signups.email',
      'signups.cancellation_note',
      'events.id as event_id',
      'events.title as event_title',
      'organizations.name as organization_name',
      'users.email as manager_email',
      'users.display_name as manager_name',
      'shifts.role_name',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time'
    ])
    .where('signups.id', '=', signupId)
    .executeTakeFirst();

  if (!row) return;

  const when = `${formatDateOnly(row.shift_date)} ${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`;
  const canceledLocal = formatDateTimeLocal(cancelledAt);

  await sendAndRecord({
    db,
    kind: 'cancellation_confirmation',
    eventId: row.event_id,
    signupId: row.signup_id,
    toEmail: row.email,
    subject: `Cancellation confirmed: ${row.event_title}`,
    body: [
      `Hi ${row.first_name},`,
      '',
      `Your signup has been cancelled:`,
      `${row.event_title} (${row.organization_name})`,
      `Shift: ${row.role_name}`,
      `When: ${when}`,
      '',
      `Cancelled at: ${canceledLocal}`,
      '',
      `— LocalShifts`
    ].join('\n')
  });

  const note = row.cancellation_note ? `Note: ${row.cancellation_note}` : '';
  await sendAndRecord({
    db,
    kind: 'cancellation_alert_manager',
    eventId: row.event_id,
    signupId: row.signup_id,
    toEmail: row.manager_email,
    subject: `[CANCELLED] ${row.event_title} — ${row.role_name}`,
    body: [
      `Hello ${row.manager_name},`,
      '',
      `A volunteer cancelled their signup:`,
      `${row.first_name} ${row.last_name} <${row.email}>`,
      '',
      `Event: ${row.event_title} (${row.organization_name})`,
      `Shift: ${row.role_name}`,
      `When: ${when}`,
      '',
      note,
      '',
      `— LocalShifts`
    ]
      .filter(Boolean)
      .join('\n')
  });
}

export async function sendManagerRemovalNotice(db: Kysely<DB>, signupId: string) {
  const row = await db
    .selectFrom('signups')
    .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
    .innerJoin('events', 'events.id', 'shifts.event_id')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .select([
      'signups.id as signup_id',
      'signups.first_name',
      'signups.email',
      'events.id as event_id',
      'events.title as event_title',
      'organizations.name as organization_name',
      'shifts.role_name',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time'
    ])
    .where('signups.id', '=', signupId)
    .executeTakeFirst();

  if (!row) return;
  const when = `${formatDateOnly(row.shift_date)} ${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`;
  await sendAndRecord({
    db,
    kind: 'manager_removal_notice',
    eventId: row.event_id,
    signupId: row.signup_id,
    toEmail: row.email,
    subject: `Removed from shift: ${row.event_title}`,
    body: [
      `Hi ${row.first_name},`,
      '',
      `An organizer removed your signup:`,
      `${row.event_title} (${row.organization_name})`,
      `Shift: ${row.role_name}`,
      `When: ${when}`,
      '',
      `If you think this is a mistake, reply to the organizer.`,
      '',
      `— LocalShifts`
    ].join('\n')
  });
}
