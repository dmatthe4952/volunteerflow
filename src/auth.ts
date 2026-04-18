import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB, UserRole } from './db.js';

const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hashPassword(password: string): string {
  const pw = password.normalize('NFKC');
  const salt = crypto.randomBytes(16).toString('base64');
  const derived = crypto.pbkdf2Sync(pw, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('base64');
  return [`pbkdf2_${PBKDF2_DIGEST}`, String(PBKDF2_ITERATIONS), salt, derived].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const pw = password.normalize('NFKC');
  // Historical compatibility: earlier hashes accidentally used "$$" separators.
  const parts = stored.split('$').filter((p) => p.length > 0);
  if (parts.length !== 4) return false;
  const [algo, iterStr, salt, expected] = parts;
  if (!algo.startsWith('pbkdf2_')) return false;
  const digest = algo.replace('pbkdf2_', '');
  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  if (!salt) return false;

  const derived = crypto.pbkdf2Sync(pw, salt, iterations, PBKDF2_KEYLEN, digest as any).toString('base64');
  return timingSafeEqual(derived, expected);
}

export type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  impersonator?: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
  };
};

export async function findUserByEmail(db: Kysely<DB>, email: string) {
  const emailNorm = email.trim().toLowerCase();
  if (!emailNorm) return null;
  return db
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'role', 'password_hash', 'is_active'])
    .where(sql<boolean>`email_norm = ${emailNorm}`)
    .executeTakeFirst();
}

export async function authenticateUser(db: Kysely<DB>, params: { email: string; password: string; role?: UserRole }) {
  const user = await findUserByEmail(db, params.email);
  if (!user || !user.is_active) return null;
  if (params.role && user.role !== params.role) return null;
  if (!verifyPassword(params.password, user.password_hash)) return null;
  return user;
}

export async function createUser(db: Kysely<DB>, params: { email: string; displayName: string; password: string; role: UserRole }) {
  const email = params.email.trim();
  const displayName = params.displayName.trim();
  if (!email || email.length > 120) throw new Error('Invalid email.');
  if (!displayName || displayName.length > 160) throw new Error('Invalid display name.');
  if (!params.password || params.password.length < 10) throw new Error('Password must be at least 10 characters.');
  const passwordHash = hashPassword(params.password);

  return db
    .insertInto('users')
    .values({
      email,
      password_hash: passwordHash,
      display_name: displayName,
      role: params.role,
      is_active: true
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
}

export async function hasAnySuperAdmin(db: Kysely<DB>): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .where('role', '=', 'super_admin')
    .executeTakeFirst();
  return Number(row?.c ?? 0) > 0;
}

export async function createSession(db: Kysely<DB>, params: { userId: string; ttlDays: number }) {
  const expiresAt = new Date(Date.now() + params.ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const row = await db
    .insertInto('sessions')
    .values({
      user_id: params.userId,
      data: {},
      expires_at: expiresAt
    })
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow();
  return { id: row.id, expiresAt: row.expires_at };
}

export async function recordLoginAudit(
  db: Kysely<DB>,
  params: {
    email: string;
    attemptedRole?: UserRole;
    userId?: string | null;
    success: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
) {
  await db
    .insertInto('login_audit')
    .values({
      email: params.email.trim(),
      attempted_role: params.attemptedRole ?? null,
      user_id: params.userId ?? null,
      success: params.success,
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null
    })
    .execute();
}

export async function loadCurrentUserFromSession(db: Kysely<DB>, sessionId: string): Promise<CurrentUser | null> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'users.id as user_id',
      'users.email',
      'users.display_name',
      'users.role',
      'users.is_active',
      'sessions.expires_at',
      'sessions.data'
    ])
    .where('sessions.id', '=', sessionId)
    .executeTakeFirst();

  if (!row) return null;
  if (!row.is_active) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;

  const baseUser: CurrentUser = { id: row.user_id, email: row.email, displayName: row.display_name, role: row.role };

  const data = row.data as any;
  const impersonateUserId = typeof data?.impersonate_user_id === 'string' ? data.impersonate_user_id : '';
  if (!impersonateUserId) return baseUser;
  if (baseUser.role !== 'super_admin') return baseUser;

  const imp = await db
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'role', 'is_active'])
    .where('id', '=', impersonateUserId)
    .where('role', '=', 'event_manager')
    .executeTakeFirst();
  if (!imp || !imp.is_active) return baseUser;

  return {
    id: imp.id,
    email: imp.email,
    displayName: imp.display_name,
    role: imp.role,
    impersonator: baseUser
  };
}

export async function deleteSession(db: Kysely<DB>, sessionId: string) {
  await db.deleteFrom('sessions').where('id', '=', sessionId).execute();
}
