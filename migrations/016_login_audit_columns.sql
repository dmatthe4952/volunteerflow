-- Add staff login audit details for existing installations.

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

alter table login_audit
  add column if not exists attempted_role user_role null,
  add column if not exists user_id uuid null references users(id) on delete set null;

create index if not exists idx_login_audit_created_at on login_audit(created_at desc);
create index if not exists idx_login_audit_user_id on login_audit(user_id);
