import type { Kysely } from 'kysely';
import type { DB } from './db.js';

export type EventCategoryRecord = {
  id: string;
  slug: string;
  label: string;
  color: string; // #RRGGBB
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
};

export type EventCategoryBadge = {
  slug: string;
  label: string;
  colorHex: string;
  colorRgb: string; // "r, g, b"
};

export function hexToRgbTriplet(hex: string): string | null {
  const h = String(hex ?? '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

export async function listEventCategories(db: Kysely<DB>, opts?: { includeInactive?: boolean }) {
  const includeInactive = Boolean(opts?.includeInactive);
  let q = db.selectFrom('event_categories').select(['id', 'slug', 'label', 'color', 'is_system', 'is_active', 'sort_order']);
  if (!includeInactive) q = q.where('is_active', '=', true);
  const rows = await q.orderBy('sort_order', 'asc').orderBy('label', 'asc').execute();

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    color: r.color,
    isSystem: r.is_system,
    isActive: r.is_active,
    sortOrder: r.sort_order
  })) satisfies EventCategoryRecord[];
}

export async function getEventCategoryBadgeBySlug(db: Kysely<DB>, slug: string): Promise<EventCategoryBadge | null> {
  const row = await db
    .selectFrom('event_categories')
    .select(['slug', 'label', 'color'])
    .where('slug', '=', slug)
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!row) return null;
  const rgb = hexToRgbTriplet(row.color) ?? '15, 118, 110';
  return { slug: row.slug, label: row.label, colorHex: row.color, colorRgb: rgb };
}

export function toBadgeFromRow(input: { slug: string; label: string | null; color: string | null }): EventCategoryBadge {
  const slug = input.slug || 'normal';
  const label = input.label?.trim() || (slug === 'normal' ? 'No Category' : slug);
  const colorHex = input.color && /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : '#0f766e';
  const colorRgb = hexToRgbTriplet(colorHex) ?? '15, 118, 110';
  return { slug, label, colorHex, colorRgb };
}

