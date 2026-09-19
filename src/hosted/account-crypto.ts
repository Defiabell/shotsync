import { HttpError } from './http';
import { scrypt, timingSafeEqual } from 'node:crypto';

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function tokenHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function derive(password: string, salt: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomToken();
  return `scrypt:16384:8:5:${salt}:${Array.from(await derive(password, salt), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts.slice(0, 4).join(':') !== 'scrypt:16384:8:5' || !/^[a-f0-9]{64}$/.test(parts[4]) || !/^[a-f0-9]{64}$/.test(parts[5])) return false;
  return timingSafeEqual(await derive(password, parts[4]), Uint8Array.from(parts[5].match(/../g)!, b => parseInt(b, 16)));
}

// Bound native scrypt memory across concurrent requests and recover abandoned work.
export async function withPasswordWork<T>(db: D1Database, work: () => Promise<T>): Promise<T> {
  const id = crypto.randomUUID(), now = Date.now();
  const results = await db.batch([
    db.prepare('DELETE FROM password_leases WHERE expires_at<=?').bind(now),
    db.prepare('INSERT INTO password_leases(id,expires_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM password_leases)<1').bind(id, now + 30_000),
  ]);
  if (!results[1].meta.changes) throw new HttpError(429, 'Authentication is busy. Try again shortly.');
  try { return await work(); }
  finally { await db.prepare('DELETE FROM password_leases WHERE id=?').bind(id).run(); }
}
