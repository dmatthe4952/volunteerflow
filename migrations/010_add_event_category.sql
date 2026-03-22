alter table events
  add column if not exists category text not null default 'normal';

-- Backfill safety (in case older rows exist without default applied)
update events set category = 'normal' where category is null;

