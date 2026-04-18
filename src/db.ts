import { Generated, Kysely, PostgresDialect } from 'kysely';
import { config } from './config.js';
import { createPgPool } from './pg.js';

export type UserRole = 'super_admin' | 'event_manager';
export type EventType = 'one_time' | 'recurring';
export type EventCategory = string; // event_categories.slug
export type SignupStatus = 'active' | 'cancelled';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  email_norm: Generated<string>;
  password_hash: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  totp_secret_encrypted: Buffer | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string | null;
  contact_email: string | null;
  created_by: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface EventsTable {
  id: Generated<string>;
  organization_id: string;
  manager_id: string;
  slug: string | null;
  title: string;
  category: EventCategory;
  is_featured: boolean;
  tags: string[];
  location_lat: string | null;
  location_lng: string | null;
  purge_after_days: number | null;
  purged_at: string | null;
  confirmation_email_note: string | null;
  description_html: string | null;
  location_name: string | null;
  location_map_url: string | null;
  image_path: string | null;
  event_type: EventType;
  recurrence_rule: string | null;
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
  is_published: boolean;
  is_archived: boolean;
  cancelled_at: string | null;
  cancellation_message: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ShiftsTable {
  id: Generated<string>;
  event_id: string;
  role_name: string;
  role_description: string | null;
  duration_minutes: number;
  shift_date: string; // YYYY-MM-DD
  start_time: string; // HH:mm:ss
  end_time: string; // HH:mm:ss
  min_volunteers: number;
  max_volunteers: number;
  is_active: boolean;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface RoleTemplatesTable {
  id: Generated<string>;
  owner_user_id: string;
  role_name: string;
  role_description: string | null;
  duration_minutes: number;
  default_min_volunteers: number;
  default_max_volunteers: number;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface SignupsTable {
  id: Generated<string>;
  shift_id: string;
  first_name: string;
  last_name: string;
  email: string;
  email_norm: Generated<string>;
  status: SignupStatus;
  cancel_token: string | null;
  cancel_token_hmac: Buffer;
  cancel_token_expires_at: string;
  cancellation_note: string | null;
  cancelled_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  data: unknown;
  expires_at: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface LoginAuditTable {
  id: Generated<number>;
  email: string;
  attempted_role: UserRole | null;
  user_id: string | null;
  success: boolean;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<string>;
}

export interface VolunteerEmailTokensTable {
  id: Generated<string>;
  email: string;
  email_norm: Generated<string>;
  token_hmac: Buffer;
  expires_at: string;
  used_at: string | null;
  created_at: Generated<string>;
}

export interface NotificationSendsTable {
  id: Generated<string>;
  kind: string;
  event_id: string | null;
  signup_id: string | null;
  to_email: string;
  subject: string;
  body: string;
  status: string;
  error: string | null;
  created_at: Generated<string>;
  sent_at: string | null;
}

export interface EventCategoriesTable {
  id: Generated<string>;
  slug: string;
  label: string;
  color: string;
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TagsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  is_system: boolean;
  created_by: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface EventTagsTable {
  event_id: string;
  tag_id: string;
  created_at: Generated<string>;
}

export interface ManagerOrganizationsTable {
  manager_id: string;
  organization_id: string;
  assigned_by: string | null;
  assigned_at: Generated<string>;
}

export interface ImpersonationLogTable {
  id: Generated<number>;
  admin_user_id: string;
  manager_user_id: string;
  started_at: Generated<string>;
  ended_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface DB {
  users: UsersTable;
  organizations: OrganizationsTable;
  events: EventsTable;
  event_categories: EventCategoriesTable;
  shifts: ShiftsTable;
  role_templates: RoleTemplatesTable;
  signups: SignupsTable;
  sessions: SessionsTable;
  login_audit: LoginAuditTable;
  volunteer_email_tokens: VolunteerEmailTokensTable;
  notification_sends: NotificationSendsTable;
  tags: TagsTable;
  event_tags: EventTagsTable;
  manager_organizations: ManagerOrganizationsTable;
  impersonation_log: ImpersonationLogTable;
}

export function createDb(): Kysely<DB> {
  const pool = createPgPool(config.databaseUrl);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: pool as any }) });
}
