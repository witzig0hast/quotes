import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
export const COOKIE = 'sid';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(key, expected);
}

// Dummy-Hash, damit Login für unbekannte Nutzer gleich lang dauert (kein User-Enumeration-Timing).
export const DUMMY_HASH = await hashPassword(randomBytes(8).toString('hex'));

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, csrf, Date.now() + SESSION_TTL_MS);
  return { token, csrf };
}

export function getSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const row = db.prepare(`
    SELECT s.csrf, s.expires_at, u.id, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return { csrf: row.csrf, user: { id: row.id, username: row.username } };
}

export function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function cookieOptions(secure) {
  return { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: SESSION_TTL_MS };
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
