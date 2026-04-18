-- Phase 1 (PRD v2.2): manager↔org assignments, normalized tags, geocoding + retention fields, impersonation log

-- 1) Events: geocoding + retention fields
alter table events
  add column if not exists location_lat numeric(9, 6) null,
  add column if not exists location_lng numeric(9, 6) null,
  add column if not exists purge_after_days integer null,
  add column if not exists purged_at timestamptz null;

-- 2) Manager ↔ organization assignments (PRD 4.11)
create table if not exists manager_organizations (
  manager_id uuid not null references users(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  assigned_by uuid null references users(id),
  assigned_at timestamptz not null default now(),
  primary key (manager_id, organization_id)
);

create index if not exists idx_manager_organizations_org_id on manager_organizations (organization_id);

-- Backfill assignments based on existing events so existing managers can keep creating events under the orgs they already use.
insert into manager_organizations (manager_id, organization_id, assigned_by, assigned_at)
select distinct e.manager_id, e.organization_id, null::uuid, now()
from events e
join users u on u.id = e.manager_id
where u.role = 'event_manager'
on conflict do nothing;

-- 3) Normalized tags (PRD 4.5, 4.6)
create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  name varchar(40) not null,
  slug varchar(60) not null,
  is_system boolean not null default false,
  created_by uuid null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug)
);

create table if not exists event_tags (
  event_id uuid not null references events(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, tag_id)
);

create index if not exists idx_event_tags_tag_id on event_tags (tag_id);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tags_updated_at') then
    create trigger trg_tags_updated_at before update on tags
      for each row execute function set_updated_at();
  end if;
end $$;

-- Backfill tags from legacy events.tags (text[]) column
with distinct_tags as (
  select distinct
    lower(regexp_replace(trim(t), '\s+', ' ', 'g')) as name,
    left(
      regexp_replace(
        regexp_replace(
          lower(regexp_replace(trim(t), '\s+', ' ', 'g')),
          '[^a-z0-9]+',
          '-',
          'g'
        ),
        '(^-|-$)',
        '',
        'g'
      ),
      60
    ) as slug
  from events e
  cross join lateral unnest(e.tags) t
  where t is not null and trim(t) <> ''
)
insert into tags (name, slug, is_system, created_by)
select dt.name, dt.slug, false, null::uuid
from distinct_tags dt
where dt.slug <> ''
on conflict (slug) do nothing;

-- Backfill event_tags from legacy events.tags (text[]) column
insert into event_tags (event_id, tag_id)
select
  e.id as event_id,
  tg.id as tag_id
from events e
cross join lateral unnest(e.tags) t
join tags tg
  on tg.slug =
    left(
      regexp_replace(
        regexp_replace(
          lower(regexp_replace(trim(t), '\s+', ' ', 'g')),
          '[^a-z0-9]+',
          '-',
          'g'
        ),
        '(^-|-$)',
        '',
        'g'
      ),
      60
    )
where t is not null and trim(t) <> ''
on conflict do nothing;

-- 4) Impersonation log (PRD 4.10, 8.5)
create table if not exists impersonation_log (
  id bigserial primary key,
  admin_user_id uuid not null references users(id) on delete cascade,
  manager_user_id uuid not null references users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  ip_address inet null,
  user_agent text null
);

create index if not exists idx_impersonation_log_admin_started on impersonation_log (admin_user_id, started_at desc);
create index if not exists idx_impersonation_log_manager_started on impersonation_log (manager_user_id, started_at desc);
