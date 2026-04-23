import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { config } from './config.js';
import type { DB } from './db.js';

export function tagSlug(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

export async function setEventTags(params: { db: Kysely<DB>; eventId: string; tagNames: string[]; createdByUserId: string | null }) {
  const normalized = (params.tagNames ?? [])
    .map((t) => String(t ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean);

  const slugToName = new Map<string, string>();
  for (const name of normalized) {
    const slug = tagSlug(name);
    if (!slug) continue;
    if (!slugToName.has(slug)) slugToName.set(slug, name);
  }
  const uniqueSlugs = Array.from(slugToName.keys());

  await params.db.transaction().execute(async (trx) => {
    if (uniqueSlugs.length) {
      const toInsert = uniqueSlugs.map((slug) => ({
        name: slugToName.get(slug) ?? slug,
        slug,
        is_system: false,
        created_by: params.createdByUserId
      }));

      await trx.insertInto('tags').values(toInsert).onConflict((oc) => oc.column('slug').doNothing()).execute();
    }

    await trx.deleteFrom('event_tags').where('event_id', '=', params.eventId).execute();

    if (!uniqueSlugs.length) return;

    const rows = await trx.selectFrom('tags').select(['id', 'slug']).where('slug', 'in', uniqueSlugs).execute();
    const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));

    const eventTagRows = uniqueSlugs
      .map((slug) => idBySlug.get(slug))
      .filter((id): id is string => Boolean(id))
      .map((tagId) => ({ event_id: params.eventId, tag_id: tagId }));

    if (!eventTagRows.length) return;
    await trx.insertInto('event_tags').values(eventTagRows).onConflict((oc) => oc.columns(['event_id', 'tag_id']).doNothing()).execute();
  });
}

const UNDERSTAFFED_TAG_SLUG = 'understaffed';

async function ensureUnderstaffedSystemTag(db: Kysely<DB>): Promise<string> {
  const existing = await db
    .selectFrom('tags')
    .select(['id', 'is_system'])
    .where('slug', '=', UNDERSTAFFED_TAG_SLUG)
    .executeTakeFirst();

  if (existing) {
    if (!existing.is_system) {
      await db.updateTable('tags').set({ is_system: true, created_by: null }).where('id', '=', existing.id).execute();
    }
    return existing.id;
  }

  const inserted = await db
    .insertInto('tags')
    .values({
      name: UNDERSTAFFED_TAG_SLUG,
      slug: UNDERSTAFFED_TAG_SLUG,
      is_system: true,
      created_by: null
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return inserted.id;
}

export async function syncUnderstaffedTagForEvent(params: { db: Kysely<DB>; eventId: string }) {
  const eventId = String(params.eventId ?? '').trim();
  if (!eventId) return { shouldApply: false, changed: false };
  const db = params.db;

  const event = await db
    .selectFrom('events')
    .select(['id', 'is_archived', 'cancelled_at'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) return { shouldApply: false, changed: false };

  const understaffedTagId = await ensureUnderstaffedSystemTag(db);
  let shouldApply = false;

  if (!event.is_archived && !event.cancelled_at) {
    const counts = await db
      .selectFrom('shifts')
      .leftJoin(
        db
          .selectFrom('signups')
          .select(['shift_id'])
          .select((eb) => eb.fn.countAll<number>().as('active_count'))
          .where('status', '=', 'active')
          .groupBy('shift_id')
          .as('active_signups'),
        'active_signups.shift_id',
        'shifts.id'
      )
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('shifts.event_id', '=', eventId)
      .where('shifts.is_active', '=', true)
      .where(sql<boolean>`shifts.shift_date >= (timezone(${config.timezone}, now()))::date`)
      .where(sql<boolean>`coalesce(active_signups.active_count, 0) < shifts.min_volunteers`)
      .executeTakeFirst();
    shouldApply = Number(counts?.c ?? 0) > 0;
  }

  const existing = await db
    .selectFrom('event_tags')
    .select(['event_id'])
    .where('event_id', '=', eventId)
    .where('tag_id', '=', understaffedTagId)
    .executeTakeFirst();
  const hasTag = Boolean(existing);

  if (shouldApply && !hasTag) {
    await db
      .insertInto('event_tags')
      .values({ event_id: eventId, tag_id: understaffedTagId })
      .onConflict((oc) => oc.columns(['event_id', 'tag_id']).doNothing())
      .execute();
    return { shouldApply: true, changed: true };
  }

  if (!shouldApply && hasTag) {
    await db.deleteFrom('event_tags').where('event_id', '=', eventId).where('tag_id', '=', understaffedTagId).execute();
    return { shouldApply: false, changed: true };
  }

  return { shouldApply, changed: false };
}
