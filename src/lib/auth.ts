import { randomHex, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'ee_session';
export const SCOPE_COOKIE = 'ee_client';
export const SESSION_TTL_MS = 14 * 86_400_000;
export const MAGIC_LINK_TTL_MS = 15 * 60_000;

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'client';
  client_id: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export const findUserByEmail = (db: D1Database, email: string) =>
  db.prepare('SELECT id, email, role, client_id FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first<SessionUser>();

export async function createUser(
  db: D1Database,
  u: { email: string; role: 'admin' | 'client'; clientId: string | null },
  nowMs: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO users (id, client_id, email, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, u.role === 'admin' ? null : u.clientId, u.email.trim().toLowerCase(), u.role, iso(nowMs))
    .run();
  return id;
}

/** Emailed sign-in token. Only its hash is stored. */
export async function createMagicLink(db: D1Database, userId: string, nowMs: number): Promise<string> {
  const token = randomHex(32);
  await db
    .prepare('INSERT INTO magic_links (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, iso(nowMs + MAGIC_LINK_TTL_MS), iso(nowMs))
    .run();
  return token;
}

/** Single use: the UPDATE only matches an unused, unexpired link, so two clicks cannot both succeed. */
export async function consumeMagicLink(db: D1Database, token: string, nowMs: number): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db
    .prepare('UPDATE magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id')
    .bind(iso(nowMs), await sha256Hex(token), iso(nowMs))
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function createSession(db: D1Database, userId: string, nowMs: number): Promise<string> {
  const token = randomHex(32);
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, iso(nowMs + SESSION_TTL_MS), iso(nowMs))
    .run();
  return token;
}

export async function getSessionUser(db: D1Database, token: string | undefined, nowMs: number): Promise<SessionUser | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return db
    .prepare(
      `SELECT u.id, u.email, u.role, u.client_id FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(token), iso(nowMs))
    .first<SessionUser>();
}

export async function destroySession(db: D1Database, token: string | undefined): Promise<void> {
  if (token) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
}

export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM magic_links WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}
