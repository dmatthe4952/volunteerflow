-- VolunteerFlow core schema (PRD v1.0)

create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('super_admin', 'event_manager');
  end if;
  if not exists (select 1 from pg_type where typname = 'event_type') then
    create type event_type as enum ('one_time', 'recurring');
  end if;
  if not exists (select 1 from pg_type where typname = 'signup_status') then
    create type signup_status as enum ('active', 'cancelled');
  end if;
end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email varchar(120) not null,
  email_norm text generated always as (lower(email)) stored,
  password_hash text not null,
  display_name varchar(160) not null,
  role user_role not null,
  is_active boolean not null default true,
  totp_secret_encrypted bytea null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email_norm)
);

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null,
  slug varchar(60) not null,
  logo_url varchar(255) null,
  primary_color char(7) null,
  contact_email varchar(120) null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug)
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  manager_id uuid not null references users(id),
  title varchar(200) not null,
  description_html text null,
  location_name varchar(200) null,
  location_map_url varchar(500) null,
  image_path varchar(255) null,
  event_type event_type not null,
  recurrence_rule varchar(200) null,
  start_date date not null,
  end_date date not null,
  is_published boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_event_dates check (end_date >= start_date)
);

create table if not exists role_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id),
  role_name varchar(120) not null,
  role_description varchar(500) null,
  duration_minutes integer not null,
  default_min_volunteers integer not null default 0,
  default_max_volunteers integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_template_duration check (duration_minutes > 0),
  constraint chk_template_min check (default_min_volunteers >= 0),
  constraint chk_template_max check (default_max_volunteers > 0)
);

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  role_name varchar(120) not null,
  role_description varchar(500) null,
  duration_minutes integer not null,
  shift_date date not null,
  start_time time not null,
  end_time time not null,
  min_volunteers integer not null default 0,
  max_volunteers integer not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_shift_duration check (duration_minutes > 0),
  constraint chk_shift_min check (min_volunteers >= 0),
  constraint chk_shift_max check (max_volunteers > 0),
  constraint chk_shift_end_after_start check (end_time > start_time)
);

create table if not exists signups (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references shifts(id) on delete cascade,
  first_name varchar(80) not null,
  last_name varchar(80) not null,
  email varchar(120) not null,
  email_norm text generated always as (lower(email)) stored,
  status signup_status not null default 'active',
  cancel_token_hmac bytea not null,
  cancel_token_expires_at timestamptz not null,
  cancellation_note text null,
  cancelled_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_signups_active_shift_email
  on signups (shift_id, email_norm)
  where status = 'active';

create table if not exists reminder_rules (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  send_offset_hours integer not null,
  subject_template varchar(300) not null,
  body_template text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_offset_nonneg check (send_offset_hours >= 0)
);

create table if not exists sent_reminders (
  id uuid primary key default gen_random_uuid(),
  signup_id uuid not null references signups(id) on delete cascade,
  reminder_rule_id uuid not null references reminder_rules(id) on delete cascade,
  sent_at timestamptz not null default now(),
  unique (signup_id, reminder_rule_id)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sessions_expires_at on sessions(expires_at);

create table if not exists login_audit (
  id bigserial primary key,
  email varchar(255) not null,
  attempted_role user_role null,
  user_id uuid null references users(id) on delete set null,
  success boolean not null,
  ip_address inet null,
  user_agent text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_login_audit_created_at on login_audit(created_at desc);
create index if not exists idx_login_audit_user_id on login_audit(user_id);

create table if not exists system_settings (
  key text primary key,
  value_encrypted bytea not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_events_public_listing
  on events (is_published, is_archived, start_date);

create index if not exists idx_shifts_event_date
  on shifts (event_id, shift_date, start_time);

create index if not exists idx_signups_shift
  on signups (shift_id);

create index if not exists idx_reminder_rules_event
  on reminder_rules (event_id);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_users_updated_at') then
    create trigger trg_users_updated_at before update on users
      for each row execute function set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_orgs_updated_at') then
    create trigger trg_orgs_updated_at before update on organizations
      for each row execute function set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_events_updated_at') then
    create trigger trg_events_updated_at before update on events
      for each row execute function set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_role_templates_updated_at') then
    create trigger trg_role_templates_updated_at before update on role_templates
      for each row execute function set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_shifts_updated_at') then
    create trigger trg_shifts_updated_at before update on shifts
      for each row execute function set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_signups_updated_at') then
    create trigger trg_signups_updated_at before update on signups
      for each row execute function set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_reminder_rules_updated_at') then
    create trigger trg_reminder_rules_updated_at before update on reminder_rules
      for each row execute function set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_sessions_updated_at') then
    create trigger trg_sessions_updated_at before update on sessions
      for each row execute function set_updated_at();
  end if;
end $$;
