-- A2: migration-safe backfills and idempotent defaults for new reminder/purge settings.

-- 1) Reminder rules hygiene and constraints.

-- Keep one rule per (event_id, send_offset_hours), deleting older duplicates if any exist.
with ranked as (
  select
    id,
    row_number() over (
      partition by event_id, send_offset_hours
      order by updated_at desc, created_at desc, id desc
    ) as rn
  from reminder_rules
)
delete from reminder_rules rr
using ranked r
where rr.id = r.id
  and r.rn > 1;

-- Enforce one rule per offset per event.
create unique index if not exists ux_reminder_rules_event_offset
  on reminder_rules (event_id, send_offset_hours);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_reminder_rules_offset_max_336'
  ) then
    alter table reminder_rules
      add constraint chk_reminder_rules_offset_max_336
      check (send_offset_hours <= 336);
  end if;
end $$;

-- 2) Events purge window guardrails.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_events_purge_after_days_nonneg'
  ) then
    alter table events
      add constraint chk_events_purge_after_days_nonneg
      check (purge_after_days is null or purge_after_days >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_events_purge_after_days_reasonable_max'
  ) then
    alter table events
      add constraint chk_events_purge_after_days_reasonable_max
      check (purge_after_days is null or purge_after_days <= 3650);
  end if;
end $$;

-- 3) Seed idempotent system default setting(s).
insert into system_settings (key, value_encrypted)
values ('DEFAULT_PURGE_DAYS', convert_to('7', 'UTF8'))
on conflict (key) do nothing;
