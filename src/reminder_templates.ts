function dateOnlyKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const v = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
}

function formatDateLong(value: unknown): string {
  const key = dateOnlyKey(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return String(value ?? '');
  const d = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(d);
}

function formatTimeHuman(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(s)) return s;
  const hh = Number(s.slice(0, 2));
  const mm = Number(s.slice(3, 5));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return s;
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function durationEnglish(startTime: unknown, endTime: unknown): string {
  const s = String(startTime ?? '').trim();
  const e = String(endTime ?? '').trim();
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(s) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(e)) return '';
  const sMin = Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const eMin = Number(e.slice(0, 2)) * 60 + Number(e.slice(3, 5));
  if (!Number.isFinite(sMin) || !Number.isFinite(eMin) || eMin <= sMin) return '';
  const mins = eMin - sMin;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m === 0) return h === 1 ? '1 hour' : `${h} hours`;
  if (h > 0) return `${h} hour${h === 1 ? '' : 's'} ${m} min`;
  return `${m} min`;
}

function htmlToPlainText(html: string | null | undefined): string {
  const raw = String(html ?? '');
  if (!raw.trim()) return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<\/?p>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

export type ReminderTemplateContext = {
  volunteer_first_name: string;
  volunteer_last_initial: string;
  event_title: string;
  event_description_plain: string;
  organization_name: string;
  shift_role: string;
  shift_date: string;
  shift_start_time: string;
  shift_end_time: string;
  shift_duration: string;
  location_name: string;
  location_map_url: string;
  cancel_url: string;
  event_url: string;
  manager_name: string;
  manager_email: string;
};

export function buildReminderTemplateContext(input: {
  volunteerFirstName?: unknown;
  volunteerLastInitial?: unknown;
  eventTitle?: unknown;
  eventDescriptionHtml?: unknown;
  organizationName?: unknown;
  shiftRole?: unknown;
  shiftDate?: unknown;
  shiftStartTime?: unknown;
  shiftEndTime?: unknown;
  locationName?: unknown;
  locationMapUrl?: unknown;
  cancelUrl?: unknown;
  eventUrl?: unknown;
  managerName?: unknown;
  managerEmail?: unknown;
}): ReminderTemplateContext {
  const start = String(input.shiftStartTime ?? '');
  const end = String(input.shiftEndTime ?? '');
  return {
    volunteer_first_name: String(input.volunteerFirstName ?? '').trim(),
    volunteer_last_initial: String(input.volunteerLastInitial ?? '').trim(),
    event_title: String(input.eventTitle ?? '').trim(),
    event_description_plain: htmlToPlainText(String(input.eventDescriptionHtml ?? '')),
    organization_name: String(input.organizationName ?? '').trim(),
    shift_role: String(input.shiftRole ?? '').trim(),
    shift_date: formatDateLong(input.shiftDate),
    shift_start_time: formatTimeHuman(start),
    shift_end_time: formatTimeHuman(end),
    shift_duration: durationEnglish(start, end),
    location_name: String(input.locationName ?? '').trim(),
    location_map_url: String(input.locationMapUrl ?? '').trim(),
    cancel_url: String(input.cancelUrl ?? '').trim(),
    event_url: String(input.eventUrl ?? '').trim(),
    manager_name: String(input.managerName ?? '').trim(),
    manager_email: String(input.managerEmail ?? '').trim()
  };
}

const KNOWN_KEYS = new Set<keyof ReminderTemplateContext>([
  'volunteer_first_name',
  'volunteer_last_initial',
  'event_title',
  'event_description_plain',
  'organization_name',
  'shift_role',
  'shift_date',
  'shift_start_time',
  'shift_end_time',
  'shift_duration',
  'location_name',
  'location_map_url',
  'cancel_url',
  'event_url',
  'manager_name',
  'manager_email'
]);

export function renderReminderTemplate(template: string, ctx: ReminderTemplateContext): string {
  const src = String(template ?? '');
  return src.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, rawKey: string) => {
    const key = String(rawKey ?? '').toLowerCase() as keyof ReminderTemplateContext;
    if (!KNOWN_KEYS.has(key)) return '';
    return String(ctx[key] ?? '');
  });
}
