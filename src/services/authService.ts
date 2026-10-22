import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { query, withTransaction } from '../db/pool';
import { AppError, conflict, notFound } from '../utils/errors';
import { logger } from '../utils/logger';

export type Role = 'manager' | 'staff';
export interface AuthUser { id: number; name: string; email: string; role: Role }

const SESSION_DAYS = 7;
const LOCK_KEY = 727002; // serialises "first user becomes manager" and role changes

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, (e, key) => (e ? reject(e) : resolve(key))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = await derive(password, Buffer.from(salt, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const DUMMY_HASH = hashPassword('not-a-real-password'); // used so unknown emails cost the same time as wrong passwords
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`, [sha256(token), userId, SESSION_DAYS]);
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => undefined);
  return token;
}

export async function getUserByToken(token: string): Promise<AuthUser | null> {
  const { rows } = await query<AuthUser>(
    `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}
export const destroySession = (token: string) => query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);

export async function publicConfig() {
  const n = (await query<{ n: number }>('SELECT COUNT(*) AS n FROM users')).rows[0].n;
  return { firstUser: n === 0, inviteRequired: n > 0 && !!config.signupCode };
}

/** The very first account becomes the manager; everyone after that is staff. */
export async function signup(input: { name: string; email: string; password: string; inviteCode?: string }, forceRole?: Role): Promise<AuthUser> {
  const hash = await hashPassword(input.password);
  return withTransaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const n = (await c.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
    if (!forceRole && n > 0 && config.signupCode && input.inviteCode !== config.signupCode) {
      throw new AppError(403, 'INVALID_INVITE', 'A valid invite code is required to create an account');
    }
    try {
      const r = await c.query<AuthUser>(
        'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
        [input.name, input.email, hash, forceRole ?? (n === 0 ? 'manager' : 'staff')],
      );
      return r.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('EMAIL_EXISTS', 'An account with this email already exists');
      throw err;
    }
  });
}

export async function login(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
  const row = (
    await query<AuthUser & { password_hash: string }>(
      'SELECT id, name, email, role, password_hash FROM users WHERE lower(email) = lower($1)',
      [email],
    )
  ).rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? (await DUMMY_HASH));
  if (!row || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  return { user: { id: row.id, name: row.name, email: row.email, role: row.role }, token: await createSession(row.id) };
}

export async function listUsers() {
  return (await query('SELECT id, name, email, role, created_at AS "createdAt" FROM users ORDER BY id')).rows;
}

export async function setRole(id: number, role: Role) {
  return withTransaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const u = (await c.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw notFound('User', id);
    if (u.role === 'manager' && role === 'staff') {
      const managers = (await c.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'manager'")).rows[0].n;
      if (managers <= 1) throw conflict('LAST_MANAGER', 'There must always be at least one manager');
    }
    return (await c.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, name, email, role', [id, role])).rows[0];
  });
}

/** Production bootstrap: ADMIN_EMAIL + ADMIN_PASSWORD create the first manager if no users exist. */
export async function ensureAdminFromEnv() {
  const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  if ((await query<{ n: number }>('SELECT COUNT(*) AS n FROM users')).rows[0].n > 0) return;
  await signup({ name: process.env.ADMIN_NAME || 'Administrator', email: email.toLowerCase(), password }, 'manager');
  logger.info({ email }, 'Created initial manager account from ADMIN_EMAIL / ADMIN_PASSWORD');
}
