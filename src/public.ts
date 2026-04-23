import crypto from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { config } from './config.js';
import type { DB } from './db.js';

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseDateInput(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const v = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = parseDateInput(v);
  return d ? d.toISOString().slice(0, 10) : v;
}

function formatDate(value: unknown): string {
  if (typeof value === 'string') {
    const v = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      // Date-only values should not shift across timezones.
      const d = new Date(`${v}T00:00:00Z`);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }).format(d);
    }
  }
  const dt = parseDateInput(value);
  if (!dt) return String(value ?? '');
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(dt);
  } catch {
    return String(value ?? '');
  }
}

function formatDateShort(value: unknown): string {
  if (typeof value === 'string') {
    const v = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      // Date-only values should not shift across timezones.
      const d = new Date(`${v}T00:00:00Z`);
      return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(d);
    }
  }
  const dt = parseDateInput(value);
  if (!dt) return String(value ?? '');
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(dt);
  } catch {
    return String(value ?? '');
  }
}

function formatTime(timeStr: string): string {
  const [hhRaw, mmRaw] = timeStr.split(':');
  const hh = Number(hhRaw);
  const mm = Number(mmRaw ?? '0');
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function htmlToPlainText(html: string | null): string {
  if (!html) return '';
  const decodeOnce = (s: string) =>
    s
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  const decoded = decodeOnce(decodeOnce(String(html)));
  return decoded
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<\/?p>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function eventUrl(slug: string | null, id: string): string {
  return `/events/${encodeURIComponent(slug ?? id)}`;
}

function endOfDayPlusDaysUtc(date: Date, days: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const startOfDayUtc = Date.UTC(y, m, d);
  const ms = startOfDayUtc + (days + 1) * 24 * 60 * 60 * 1000 - 1000;
  return new Date(ms);
}

export async function listPublicEvents(db: Kysely<DB>) {
  return listPublicEventsFiltered(db, {
    tag: null,
    organizationSlug: null,
    originLat: null,
    originLng: null,
    radiusMiles: null
  });
}

export async function listPublicEventTags(db: Kysely<DB>) {
  const res = await sql<{ tag: string }>`
    select distinct t.name as tag
    from tags t
    join event_tags et on et.tag_id = t.id
    join events e on e.id = et.event_id
    where e.is_published = true
      and e.is_archived = false
    order by tag asc
  `.execute(db);
  return res.rows
    .map((r) => String(r.tag ?? '').trim())
    .filter(Boolean);
}

export async function listPublicEventOrganizations(db: Kysely<DB>) {
  const nowLocal = sql`timezone(${config.timezone}, now())`;
  const res = await sql<{ name: string; slug: string }>`
    select distinct o.name as name, o.slug as slug
    from organizations o
    join events e on e.organization_id = o.id
    where e.is_published = true
      and e.is_archived = false
      and exists (
        select 1
        from shifts s
        where s.event_id = e.id
          and s.is_active = true
          and (
            s.shift_date > (${nowLocal})::date
            or (s.shift_date = (${nowLocal})::date and s.start_time > (${nowLocal})::time)
          )
      )
    order by o.name asc
  `.execute(db);

  return res.rows
    .map((r) => ({ name: String(r.name ?? '').trim(), slug: String(r.slug ?? '').trim() }))
    .filter((r) => r.name && r.slug);
}

export async function listPublicEventsFiltered(
  db: Kysely<DB>,
  params: { tag: string | null; organizationSlug: string | null; originLat: number | null; originLng: number | null; radiusMiles: number | null }
) {
  const nowLocal = sql`timezone(${config.timezone}, now())`;
  const hasOrigin =
    Number.isFinite(params.originLat as number) &&
    Number.isFinite(params.originLng as number) &&
    params.originLat !== null &&
    params.originLng !== null;
  const eventHasValidCoordsExpr = sql<boolean>`(
    events.location_lat is not null
    and events.location_lng is not null
    and not (
      abs(events.location_lat::double precision) < 0.000001
      and abs(events.location_lng::double precision) < 0.000001
    )
  )`;
  const distanceMilesExpr = hasOrigin
    ? sql<number | null>`case
      when ${eventHasValidCoordsExpr} then
        3959 * acos(
          least(
            1,
            greatest(
              -1,
              cos(radians(${params.originLat as number})) * cos(radians(events.location_lat::double precision))
                * cos(radians(events.location_lng::double precision) - radians(${params.originLng as number}))
                + sin(radians(${params.originLat as number})) * sin(radians(events.location_lat::double precision))
            )
          )
        )
      else null
    end`
    : sql<number | null>`null`;

  let q = db
    .selectFrom('events')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .where('events.is_published', '=', true)
    .where('events.is_archived', '=', false)
    .where(
      sql<boolean>`exists (
        select 1
        from shifts s
        where s.event_id = events.id
          and s.is_active = true
          and (
            s.shift_date > (${nowLocal})::date
            or (s.shift_date = (${nowLocal})::date and s.start_time > (${nowLocal})::time)
          )
      )`
    );

  if (hasOrigin && params.radiusMiles !== null) {
    q = q.where(
      sql<boolean>`(
        not ${eventHasValidCoordsExpr}
        or ${distanceMilesExpr} <= ${params.radiusMiles}
      )`
    );
  }

  if (params.tag) {
    q = q.where(
      sql<boolean>`exists (
        select 1
        from event_tags et
        join tags t on t.id = et.tag_id
        where et.event_id = events.id
          and t.name = ${params.tag}
      )`
    );
  }

  if (params.organizationSlug) {
    q = q.where('organizations.slug', '=', params.organizationSlug);
  }

  q = q
    .select([
      'events.id',
      'events.slug',
      'events.title',
      'events.is_featured',
      'events.start_date',
      'events.end_date',
      'events.updated_at',
      'events.location_name',
      'events.description_html',
      'events.image_path',
      'events.cancelled_at',
      'organizations.name as organization_name',
      'organizations.slug as organization_slug',
      'organizations.primary_color as organization_primary_color'
    ])
    .select(sql<number>`extract(epoch from events.updated_at)`.as('updated_at_epoch'))
    .select(distanceMilesExpr.as('distance_miles'))
    .select(
      sql<string[]>`
        (
          select coalesce(array_agg(t.name order by t.name), '{}')
          from event_tags et
          join tags t on t.id = et.tag_id
          where et.event_id = events.id
        )
      `.as('tags')
    )
    .select(
      sql<string>`
        (
          select s.start_time::text
          from shifts s
          where s.event_id = events.id
            and s.is_active = true
          order by s.shift_date asc, s.start_time asc
          limit 1
        )
      `.as('first_shift_start_time')
    )
    .select(
      sql<string>`
        (
          select s.end_time::text
          from shifts s
          where s.event_id = events.id
            and s.is_active = true
          order by s.shift_date asc, s.start_time asc
          limit 1
        )
      `.as('first_shift_end_time')
    )
    // Avoid join-induced overcount by using correlated subqueries.
    .select(
      sql<number>`
        (
          select coalesce(sum(s.max_volunteers), 0)
          from shifts s
          where s.event_id = events.id
            and s.is_active = true
        )
      `.as('max_slots')
    )
    .select(
      sql<number>`
        (
          select count(*)
          from signups su
          join shifts s on s.id = su.shift_id
          where s.event_id = events.id
            and s.is_active = true
            and su.status = 'active'
        )
      `.as('filled_slots')
    );
  if (hasOrigin && params.radiusMiles !== null) {
    q = q
      .orderBy(sql`case when ${eventHasValidCoordsExpr} then 0 else 1 end`)
      .orderBy(distanceMilesExpr)
      .orderBy('events.start_date', 'asc')
      .orderBy('events.title', 'asc');
  } else {
    q = q.orderBy('events.start_date', 'asc').orderBy('events.title', 'asc');
  }

  const rows: any[] = await (q as any).execute();

  return rows.map((r: any) => {
    const maxSlots = Number(r.max_slots ?? 0);
    const filledSlots = Number(r.filled_slots ?? 0);
    const openSlots = Math.max(0, maxSlots - filledSlots);
    const sameDay = dateKey(r.start_date) === dateKey(r.end_date);
    const dateRange = sameDay ? formatDateShort(r.start_date) : `${formatDateShort(r.start_date)} – ${formatDateShort(r.end_date)}`;

    const timeLabelRaw = typeof (r as any).first_shift_start_time === 'string' ? (r as any).first_shift_start_time : '';
    const endTimeRaw = typeof (r as any).first_shift_end_time === 'string' ? (r as any).first_shift_end_time : '';
    const timeLabel =
      timeLabelRaw && endTimeRaw ? `${formatTime(timeLabelRaw)} – ${formatTime(endTimeRaw)}` : timeLabelRaw ? formatTime(timeLabelRaw) : '';

    const descriptionText = htmlToPlainText(r.description_html);
    const descriptionShort = descriptionText.length > 220 ? `${descriptionText.slice(0, 217)}…` : descriptionText;
    const distanceMilesRaw = (r as any).distance_miles;
    const distanceMilesNum =
      distanceMilesRaw == null || distanceMilesRaw === '' || Number.isNaN(Number(distanceMilesRaw)) ? null : Number(distanceMilesRaw);
    const distanceMiles =
      distanceMilesNum == null ? null : Math.round(distanceMilesNum * 10) / 10;

    return {
      id: r.id,
      slug: r.slug,
      url: eventUrl(r.slug, r.id),
      title: r.title,
      isFeatured: Boolean((r as any).is_featured),
      tags: Array.isArray((r as any).tags) ? ((r as any).tags as string[]).filter(Boolean) : [],
      organizationName: r.organization_name,
      dateRange,
      timeLabel,
      description: descriptionShort,
      descriptionHtml: r.description_html,
      locationName: r.location_name,
      imagePath: r.image_path ?? '/event-images/default_volunteers.png',
      cancelledAt: r.cancelled_at,
      updatedAt: r.updated_at,
      updatedAtEpoch: Number((r as any).updated_at_epoch ?? 0),
      distanceMiles,
      openSlots,
      isFull: openSlots === 0 && maxSlots > 0
    };
  });
}

export async function listPastPublicEvents(db: Kysely<DB>) {
  const nowLocal = sql`timezone(${config.timezone}, now())`;
  const rows = await db
    .selectFrom('events')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .where('events.is_published', '=', true)
    .where('events.is_archived', '=', false)
    .where(
      sql<boolean>`exists (
        select 1
        from shifts s
        where s.event_id = events.id
          and s.is_active = true
      )`
    )
    .where(
      sql<boolean>`not exists (
        select 1
        from shifts s
        where s.event_id = events.id
          and s.is_active = true
          and (
            s.shift_date > (${nowLocal})::date
            or (s.shift_date = (${nowLocal})::date and s.start_time > (${nowLocal})::time)
          )
      )`
    )
    .select([
      'events.id',
      'events.slug',
      'events.title',
      'events.start_date',
      'events.end_date',
      'events.updated_at',
      'events.location_name',
      'events.description_html',
      'events.image_path',
      'events.cancelled_at',
      'organizations.name as organization_name',
      'organizations.slug as organization_slug',
      'organizations.primary_color as organization_primary_color'
    ])
    .select(
      sql<number>`extract(epoch from events.updated_at)`.as('updated_at_epoch')
    )
    .select(
      sql<string[]>`
        (
          select coalesce(array_agg(t.name order by t.name), '{}')
          from event_tags et
          join tags t on t.id = et.tag_id
          where et.event_id = events.id
        )
      `.as('tags')
    )
    .orderBy('events.end_date', 'desc')
    .orderBy('events.title', 'asc')
    .execute();

  return rows.map((r) => {
    const sameDay = dateKey(r.start_date) === dateKey(r.end_date);
    const dateRange = sameDay ? formatDateShort(r.start_date) : `${formatDateShort(r.start_date)} – ${formatDateShort(r.end_date)}`;
    const descriptionText = htmlToPlainText(r.description_html);
    const descriptionShort = descriptionText.length > 220 ? `${descriptionText.slice(0, 217)}…` : descriptionText;

    return {
      id: r.id,
      slug: r.slug,
      url: eventUrl(r.slug, r.id),
      title: r.title,
      tags: Array.isArray((r as any).tags) ? ((r as any).tags as string[]).filter(Boolean) : [],
      organizationName: r.organization_name,
      dateRange,
      description: descriptionShort,
      descriptionHtml: r.description_html,
      locationName: r.location_name,
      imagePath: r.image_path ?? '/event-images/default_volunteers.png',
      cancelledAt: r.cancelled_at,
      updatedAt: r.updated_at,
      updatedAtEpoch: Number((r as any).updated_at_epoch ?? 0)
    };
  });
}

export async function getPublicEventBySlugOrId(db: Kysely<DB>, slugOrId: string) {
  return getPublicEventBySlugOrIdForViewer(db, slugOrId, undefined);
}

export async function getPublicEventBySlugOrIdForViewer(db: Kysely<DB>, slugOrId: string, viewerEmail: string | undefined) {
  const event = await db
    .selectFrom('events')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .select([
      'events.id',
      'events.slug',
      'events.title',
      'events.description_html',
      'events.location_name',
      'events.location_map_url',
      'events.image_path',
      'events.start_date',
      'events.end_date',
      'events.cancelled_at',
      'events.cancellation_message',
      'events.is_published',
      'events.is_archived',
      'organizations.name as organization_name',
      'organizations.slug as organization_slug',
      'organizations.primary_color as organization_primary_color',
      'organizations.logo_url as organization_logo_url'
    ])
    .where('events.is_archived', '=', false)
    .where(
      sql<boolean>`(events.slug = ${slugOrId} or events.id::text = ${slugOrId})`
    )
    .executeTakeFirst();

  if (!event) return null;
  if (!event.is_published) return null;

  const shifts = await db
    .selectFrom('shifts')
    .leftJoin('signups', (join) => join.onRef('signups.shift_id', '=', 'shifts.id').on('signups.status', '=', 'active'))
    .where('shifts.event_id', '=', event.id)
    .where('shifts.is_active', '=', true)
    .select([
      'shifts.id',
      'shifts.role_name',
      'shifts.role_description',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time',
      'shifts.min_volunteers',
      'shifts.max_volunteers'
    ])
    .select((eb) => eb.fn.count('signups.id').as('filled_slots'))
    .groupBy([
      'shifts.id',
      'shifts.role_name',
      'shifts.role_description',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time',
      'shifts.min_volunteers',
      'shifts.max_volunteers'
    ])
    .orderBy('shifts.shift_date', 'asc')
    .orderBy('shifts.start_time', 'asc')
    .execute();

  const viewerEmailNorm = typeof viewerEmail === 'string' ? viewerEmail.trim().toLowerCase() : '';
  const signupByShiftId = new Map<string, { cancelToken: string | null }>();
  if (viewerEmailNorm && shifts.length) {
    const shiftIds = shifts.map((s) => s.id);
    const signups = await db
      .selectFrom('signups')
      .select(['signups.shift_id', 'signups.cancel_token'])
      .where('signups.status', '=', 'active')
      .where(sql<boolean>`signups.email_norm = ${viewerEmailNorm}`)
      .where('signups.shift_id', 'in', shiftIds)
      .execute();

    for (const s of signups) signupByShiftId.set(s.shift_id, { cancelToken: s.cancel_token ?? null });
  }

  return {
    id: event.id,
    slug: event.slug,
    url: eventUrl(event.slug, event.id),
    title: event.title,
    organizationName: event.organization_name,
    organizationLogoUrl: event.organization_logo_url,
    organizationPrimaryColor: event.organization_primary_color,
    descriptionHtml: event.description_html,
    locationName: event.location_name,
    locationMapUrl: event.location_map_url,
    imagePath: event.image_path ?? '/event-images/default_volunteers.png',
    cancelledAt: event.cancelled_at,
    cancellationMessage: event.cancellation_message,
    dateRange:
      event.start_date === event.end_date
        ? formatDate(event.start_date)
        : `${formatDate(event.start_date)} – ${formatDate(event.end_date)}`,
    shifts: shifts.map((s) => {
      const filledSlots = Number(s.filled_slots ?? 0);
      const remaining = Math.max(0, s.max_volunteers - filledSlots);
      const viewerSignup = signupByShiftId.get(s.id);
      return {
        id: s.id,
        roleName: s.role_name,
        roleDescription: s.role_description,
        date: formatDateShort(s.shift_date),
        startTime: formatTime(s.start_time),
        endTime: formatTime(s.end_time),
        minVolunteers: s.min_volunteers,
        maxVolunteers: s.max_volunteers,
        filledSlots,
        remaining,
        isFull: remaining === 0,
        viewerSignup: viewerSignup
          ? {
              isSignedUp: true,
              cancelUrl: viewerSignup.cancelToken ? `/cancel/${encodeURIComponent(viewerSignup.cancelToken)}` : null
            }
          : { isSignedUp: false, cancelUrl: null }
      };
    })
  };
}

export async function createSignup(params: {
  db: Kysely<DB>;
  shiftId: string;
  firstName: string;
  lastName: string;
  email: string;
  allowUnpublished?: boolean;
}) {
  const firstName = params.firstName.trim();
  const lastName = params.lastName.trim();
  const email = params.email.trim();

  if (!firstName || firstName.length > 80) throw new Error('Please enter a valid first name (aliases allowed).');
  if (lastName.length !== 1) throw new Error('Please enter a valid last name initial (1 character).');
  if (!email || email.length > 120 || !isValidEmail(email)) throw new Error('Please enter a valid email address.');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHmac = crypto.createHmac('sha256', config.sessionSecret).update(rawToken).digest();

  const res = await params.db.transaction().execute(async (trx) => {
    const shift = await trx
      .selectFrom('shifts')
      .innerJoin('events', 'events.id', 'shifts.event_id')
      .select([
        'shifts.id',
        'shifts.shift_date',
        'shifts.max_volunteers',
        'shifts.is_active',
        'events.is_published',
        'events.is_archived',
        'events.cancelled_at'
      ])
      .where('shifts.id', '=', params.shiftId)
      .forUpdate()
      .executeTakeFirst();

    if (!shift || !shift.is_active) throw new Error('That shift is no longer available.');
    if ((!shift.is_published && !params.allowUnpublished) || shift.is_archived) {
      throw new Error('That event is not currently accepting signups.');
    }
    if (shift.cancelled_at) throw new Error('Sorry — this event has been cancelled.');

    const filled = await trx
      .selectFrom('signups')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('signups.shift_id', '=', params.shiftId)
      .where('signups.status', '=', 'active')
      .executeTakeFirst();

    const filledCount = Number(filled?.c ?? 0);
    if (filledCount >= shift.max_volunteers) throw new Error('Sorry — this shift is full.');

    const shiftDate = parseDateInput(shift.shift_date);
    if (!shiftDate) throw new Error('That shift has an invalid date.');
    const expiresAt = endOfDayPlusDaysUtc(shiftDate, 7);

    try {
      const inserted = await trx
        .insertInto('signups')
        .values({
          shift_id: params.shiftId,
          first_name: firstName,
          last_name: lastName,
          email,
          status: 'active',
          cancel_token: rawToken,
          cancel_token_hmac: tokenHmac,
          cancel_token_expires_at: expiresAt.toISOString()
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      return { signupId: inserted.id, token: rawToken };
	    } catch (err: any) {
	      if (err?.code === '23505') {
	        throw new Error(
	          'That email address is already signed up for this shift. If this is you, use the “My Signups” link to view or cancel your signup.'
	        );
	      }
	      throw err;
	    }
	  });

  return res;
}

export async function findActiveSignupByCancelToken(db: Kysely<DB>, rawToken: string) {
  if (!/^[a-f0-9]{64}$/.test(rawToken)) return null;
  const tokenHmac = crypto.createHmac('sha256', config.sessionSecret).update(rawToken).digest();

  const row = await db
    .selectFrom('signups')
    .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
    .innerJoin('events', 'events.id', 'shifts.event_id')
    .select([
      'signups.id as signup_id',
      'signups.status as signup_status',
      'signups.cancel_token_expires_at',
      'signups.first_name',
      'signups.last_name',
      'signups.email',
      'shifts.role_name',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time',
      'events.title as event_title'
    ])
    .where(sql<boolean>`(signups.cancel_token = ${rawToken} or signups.cancel_token_hmac = ${tokenHmac})`)
    .executeTakeFirst();

  if (!row) return null;
  if (row.signup_status !== 'active') return null;
  if (Date.parse(row.cancel_token_expires_at) < Date.now()) return { expired: true as const };

  return {
    expired: false as const,
    signupId: row.signup_id,
    volunteerName: `${row.first_name} ${row.last_name}`,
    volunteerEmail: row.email,
    eventTitle: row.event_title,
    shiftRole: row.role_name,
    shiftDate: formatDate(row.shift_date),
    shiftTime: `${formatTime(row.start_time)} – ${formatTime(row.end_time)}`
  };
}

export async function cancelSignup(params: { db: Kysely<DB>; signupId: string; note: string | undefined }) {
  const note = (params.note ?? '').trim();
  const cancelledAt = new Date().toISOString();
  const res = await params.db
    .updateTable('signups')
    .set({
      status: 'cancelled',
      cancelled_at: cancelledAt,
      cancellation_note: note.length ? note.slice(0, 2000) : null
    })
    .where('id', '=', params.signupId)
    .where('status', '=', 'active')
    .returning(['id'])
    .executeTakeFirst();

  return res ? { changed: true as const, cancelledAt } : { changed: false as const, cancelledAt };
}

export async function listViewerActiveSignups(db: Kysely<DB>, viewerEmail: string) {
  const viewerEmailNorm = viewerEmail.trim().toLowerCase();
  if (!viewerEmailNorm) return [];

  const rows = await db
    .selectFrom('signups')
    .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
    .innerJoin('events', 'events.id', 'shifts.event_id')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .select([
      'signups.id as signup_id',
      'signups.cancel_token',
      'events.title as event_title',
      'events.slug as event_slug',
      'events.id as event_id',
      'events.cancelled_at as event_cancelled_at',
      'events.cancellation_message as event_cancellation_message',
      'organizations.name as organization_name',
      'shifts.role_name',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time'
    ])
    .where('signups.status', '=', 'active')
    .where(sql<boolean>`signups.email_norm = ${viewerEmailNorm}`)
    .where(sql<boolean>`shifts.shift_date >= current_date`)
    .orderBy('shifts.shift_date', 'asc')
    .orderBy('shifts.start_time', 'asc')
    .execute();

  return rows.map((r) => ({
    signupId: r.signup_id,
    eventTitle: r.event_title,
    eventUrl: eventUrl(r.event_slug, r.event_id),
    organizationName: r.organization_name,
    shiftRole: r.role_name,
    shiftDate: formatDate(r.shift_date),
    shiftTime: `${formatTime(r.start_time)} – ${formatTime(r.end_time)}`,
    cancelUrl: r.cancel_token ? `/cancel/${encodeURIComponent(r.cancel_token)}` : null,
    eventCancelledAt: r.event_cancelled_at,
    eventCancellationMessage: r.event_cancellation_message
  }));
}

export async function requestMySignupsToken(db: Kysely<DB>, email: string) {
  const clean = email.trim();
  if (!clean || clean.length > 120 || !isValidEmail(clean)) throw new Error('Please enter a valid email address.');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHmac = crypto.createHmac('sha256', config.sessionSecret).update(rawToken).digest();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

  await db
    .insertInto('volunteer_email_tokens')
    .values({
      email: clean,
      token_hmac: tokenHmac,
      expires_at: expiresAt.toISOString()
    })
    .execute();

  return { token: rawToken, expiresAt };
}

export async function verifyMySignupsToken(db: Kysely<DB>, rawToken: string) {
  if (!/^[a-f0-9]{64}$/.test(rawToken)) return null;
  const tokenHmac = crypto.createHmac('sha256', config.sessionSecret).update(rawToken).digest();

  const now = new Date();
  const nowIso = now.toISOString();

  // Consume token on first successful verification.
  // This makes email links truly one-time (a second request will fail).
  const consumed = await db
    .updateTable('volunteer_email_tokens')
    .set({ used_at: nowIso, expires_at: nowIso })
    .where('token_hmac', '=', tokenHmac)
    .where('used_at', 'is', null)
    .where('expires_at', '>', nowIso)
    .returning(['email'])
    .executeTakeFirst();

  if (consumed) return { expired: false as const, email: consumed.email as string };

  // If we didn't consume a row, figure out whether it's missing vs. expired/used.
  const row = await db
    .selectFrom('volunteer_email_tokens')
    .select(['expires_at', 'used_at'])
    .where('token_hmac', '=', tokenHmac)
    .executeTakeFirst();

  if (!row) return null;
  if (row.used_at) return { expired: true as const };
  if (Date.parse(row.expires_at) <= now.getTime()) return { expired: true as const };

  // Token exists and appears valid, but we couldn't consume it (race or clock skew).
  return { expired: true as const };
}
