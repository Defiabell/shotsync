import { HttpError } from './http';

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function tokenHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
// Limit read-only provider sign-ins. Mutations use persistent D1 state, not expiring leases.
export async function withAuthRequest<T>(db: D1Database, work: () => Promise<T>): Promise<T> {
  const id = crypto.randomUUID(), now = Date.now();
  const results = await db.batch([
    db.prepare('DELETE FROM password_leases WHERE expires_at<=?').bind(now),
    db.prepare('INSERT INTO password_leases(id,expires_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM password_leases)<1').bind(id, now + 30_000),
  ]);
  if (!results[1].meta.changes) throw new HttpError(429, 'Authentication is busy. Try again shortly.');
  try { return await work(); }
  finally { await db.prepare('DELETE FROM password_leases WHERE id=?').bind(id).run(); }
}
