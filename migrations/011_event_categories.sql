-- Event categories (user-manageable)

create table if not exists event_categories (
  id uuid primary key default gen_random_uuid(),
  slug varchar(60) not null,
  label varchar(80) not null,
  color char(7) not null default '#0f766e',
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug)
);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_event_categories_updated_at') then
    create trigger trg_event_categories_updated_at before update on event_categories
      for each row execute function set_updated_at();
  end if;
end $$;

-- Seed system categories (don't override if already customized)
insert into event_categories (slug, label, color, is_system, sort_order)
values
  ('featured', 'Featured', '#2563eb', true, 10),
  ('understaffed', 'Understaffed', '#b91c1c', true, 20),
  ('normal', 'No Category', '#0f766e', true, 30)
on conflict (slug) do nothing;

-- Backfill: ensure every existing event.category has a category row
insert into event_categories (slug, label, color, is_system, sort_order)
select
  e.category as slug,
  initcap(replace(e.category, '-', ' ')) as label,
  '#0f766e' as color,
  false as is_system,
  100 as sort_order
from events e
where e.category is not null
  and not exists (select 1 from event_categories c where c.slug = e.category);

-- Enforce referential integrity (delete -> back to default "normal")
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_events_category_slug') then
    alter table events
      add constraint fk_events_category_slug
      foreign key (category)
      references event_categories(slug)
      on update cascade
      on delete set default;
  end if;
end $$;

