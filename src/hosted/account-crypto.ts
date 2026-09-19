import { HttpError } from './http';
import { timingSafeEqual } from 'node:crypto';

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function tokenHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
const HASH_PREFIX = 'pbkdf2-sha256:v1:100000';
const HEX_32 = /^[a-f0-9]{64}$/;
function decodeHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16));
}
export function validPasswordPepper(value: unknown): value is string {
  return typeof value === 'string' && HEX_32.test(value);
}
function requirePepper(pepper: string): void {
  if (!validPasswordPepper(pepper)) throw new HttpError(503, 'Password authentication is temporarily unavailable');
}
async function derive(password: string, salt: string, pepper: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: decodeHex(salt), iterations: 100_000 }, key, 256);
  const pepperKey = await crypto.subtle.importKey('raw', decodeHex(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // Persist only the peppered verifier, never the intermediate PBKDF2 result.
  return new Uint8Array(await crypto.subtle.sign('HMAC', pepperKey, derived));
}
export async function hashPassword(password: string, pepper: string): Promise<string> {
  requirePepper(pepper);
  const salt = randomToken();
  return `${HASH_PREFIX}:${salt}:${Array.from(await derive(password, salt, pepper), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  requirePepper(pepper);
  const parts = stored.split(':');
  if (parts.length !== 5 || parts.slice(0, 3).join(':') !== HASH_PREFIX || !HEX_32.test(parts[3]) || !HEX_32.test(parts[4])) return false;
  return timingSafeEqual(await derive(password, parts[3], pepper), decodeHex(parts[4]));
}

// Bound expensive password work across requests and recover abandoned leases.
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
