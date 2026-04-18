import type { Kysely } from 'kysely';
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
