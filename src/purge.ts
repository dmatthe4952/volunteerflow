import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { config } from './config.js';
import type { DB } from './db.js';

function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 0) return null;
  return i;
}

function normalizeYmd(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString().slice(0, 10);
}

function addDaysToYmd(value: unknown, days: number): string {
  const ymd = normalizeYmd(value);
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type PurgeCandidate = {
  id: string;
  purge_after_days: number | null;
  last_shift_date: string;
};

export async function purgeEventVolunteerPII(params: {
  db: Kysely<DB>;
  eventId: string;
  dryRun?: boolean;
  nowIso?: string;
}) {
  const db = params.db;
  const eventId = String(params.eventId ?? '').trim();
  const dryRun = Boolean(params.dryRun);
  const nowIso = params.nowIso ?? new Date().toISOString();
  if (!eventId) throw new Error('eventId is required');

  const event = await db
    .selectFrom('events')
    .select(['id', 'purged_at'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) throw new Error('Event not found.');

  const signupCount = await db
    .selectFrom('signups')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .where(
      'shift_id',
      'in',
      db.selectFrom('shifts').select('id').where('event_id', '=', eventId)
    )
    .executeTakeFirst();
  const signupsBefore = Number(signupCount?.c ?? 0);
  const sendCount = await db
    .selectFrom('notification_sends')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .where((eb) =>
      eb.or([
        eb('event_id', '=', eventId),
        eb(
          'signup_id',
          'in',
          db
            .selectFrom('signups')
            .select('id')
            .where(
              'shift_id',
              'in',
              db.selectFrom('shifts').select('id').where('event_id', '=', eventId)
            )
        )
      ])
    )
    .executeTakeFirst();
  const notificationSendsBefore = Number(sendCount?.c ?? 0);

  if (dryRun) {
    return {
      eventId,
      alreadyPurged: Boolean(event.purged_at),
      signupsBefore,
      notificationSendsBefore,
      deletedSignups: 0,
      deletedNotificationSends: 0,
      purgedEvent: false,
      dryRun: true as const
    };
  }

  const deletedSends = await db
    .deleteFrom('notification_sends')
    .where((eb) =>
      eb.or([
        eb('event_id', '=', eventId),
        eb(
          'signup_id',
          'in',
          db
            .selectFrom('signups')
            .select('id')
            .where(
              'shift_id',
              'in',
              db.selectFrom('shifts').select('id').where('event_id', '=', eventId)
            )
        )
      ])
    )
    .executeTakeFirst();
  const deletedNotificationSends = Number((deletedSends as any)?.numDeletedRows ?? 0);

  const deleted = await db
    .deleteFrom('signups')
    .where(
      'shift_id',
      'in',
      db.selectFrom('shifts').select('id').where('event_id', '=', eventId)
    )
    .executeTakeFirst();
  const deletedSignups = Number((deleted as any)?.numDeletedRows ?? 0);

  const updated = await db
    .updateTable('events')
    .set({ purged_at: nowIso })
    .where('id', '=', eventId)
    .where('purged_at', 'is', null)
    .executeTakeFirst();
  const purgedEvent = Number((updated as any)?.numUpdatedRows ?? 0) > 0;

  return {
    eventId,
    alreadyPurged: Boolean(event.purged_at),
    signupsBefore,
    notificationSendsBefore,
    deletedSignups,
    deletedNotificationSends,
    purgedEvent,
    dryRun: false as const
  };
}

export async function purgeExpiredVolunteerPII(params: {
  db: Kysely<DB>;
  dryRun?: boolean;
  limit?: number;
}) {
  const db = params.db;
  const dryRun = Boolean(params.dryRun);
  const limitRaw = params.limit;
  const limit = limitRaw == null ? null : Math.max(1, Math.floor(Number(limitRaw)));
  const nowIso = new Date().toISOString();

  const todayRow = await sql<{ today_local: string }>`select (timezone(${config.timezone}, now()))::date::text as today_local`.execute(db);
  const todayLocal = String(todayRow.rows[0]?.today_local ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayLocal)) throw new Error('Unable to resolve local date for purge run.');

  const setting = await db
    .selectFrom('system_settings')
    .select((eb) => sql<string>`convert_from(${eb.ref('value_encrypted')}::bytea, 'UTF8')`.as('value'))
    .where('key', '=', 'DEFAULT_PURGE_DAYS')
    .executeTakeFirst();
  const defaultPurgeDays = parsePositiveInt(setting?.value) ?? 7;

  let q = db
    .selectFrom('events')
    .innerJoin('shifts', 'shifts.event_id', 'events.id')
    .select(['events.id', 'events.purge_after_days'])
    .select((eb) => eb.fn.max<string>('shifts.shift_date').as('last_shift_date'))
    .where('events.purged_at', 'is', null)
    .groupBy(['events.id', 'events.purge_after_days'])
    .orderBy('events.id', 'asc');

  if (limit !== null) q = q.limit(limit);

  const candidates = (await q.execute()) as unknown as PurgeCandidate[];
  const eligible = candidates.filter((c) => {
    const purgeDays = c.purge_after_days == null ? defaultPurgeDays : c.purge_after_days;
    const purgeDate = addDaysToYmd(String(c.last_shift_date), purgeDays);
    return purgeDate < todayLocal;
  });

  let deletedSignups = 0;
  let deletedNotificationSends = 0;
  let purgedEvents = 0;

  if (!dryRun) {
    for (const e of eligible) {
      const res = await purgeEventVolunteerPII({ db, eventId: e.id, nowIso });
      deletedSignups += res.deletedSignups;
      deletedNotificationSends += res.deletedNotificationSends;
      purgedEvents += res.purgedEvent ? 1 : 0;
    }
  }

  return {
    todayLocal,
    defaultPurgeDays,
    considered: candidates.length,
    eligible: eligible.length,
    purgedEvents,
    deletedSignups,
    deletedNotificationSends,
    dryRun
  };
}
