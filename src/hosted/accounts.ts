import type { HostedEnv } from './types';
import { consumeRate } from './limits';
import { readJson } from './http';
import { hashPassword, randomToken, tokenHash, validPasswordPepper, verifyPassword, withPasswordWork } from './account-crypto';

const DAY = 86_400_000;
const COOKIE = '__Host-shotsync';
interface UserRow { id: string; email: string; password_hash: string; verified_at: number | null; auth_version: number }
export interface Account { id: string; email: string; verified: boolean; via: 'cookie' | 'token' }
function reply(body: unknown, status = 200, cookie?: string): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}
function fail(error: string, status = 400): Response { return reply({ error }, status); }
function cookie(token: string, maxAge = 30 * 86400): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function sessionToken(request: Request): string | undefined {
  return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
function publicUser(user: UserRow) { return { id: user.id, email: user.email, verified: user.verified_at !== null }; }
function validPassword(value: unknown): value is string { return typeof value === 'string' && value.length >= 10 && value.length <= 128; }
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email) ? email : null;
}
function configured(env: HostedEnv): boolean {
  try { return new URL(env.PUBLIC_ORIGIN).protocol === 'https:' && !!env.TURNSTILE_SECRET_KEY; } catch { return false; }
}
async function limited(env: HostedEnv, key: string, count: number, seconds: number): Promise<boolean> {
  return !(await consumeRate(env.DB, `account:${key}`, count, seconds));
}
async function ipKey(request: Request): Promise<string> {
  return tokenHash(request.headers.get('CF-Connecting-IP') || 'unknown');
}
async function challenge(request: Request, env: HostedEnv, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: request.headers.get('CF-Connecting-IP') || '' }),
  });
  if (!response.ok) return false;
  const result = await response.json() as { success?: boolean; hostname?: string };
  return result.success === true && result.hostname === new URL(env.PUBLIC_ORIGIN).hostname;
}
export async function authenticate(request: Request, env: HostedEnv): Promise<Account | null> {
  const authorization = request.headers.get('Authorization');
  const bearer = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const raw = authorization ? bearer : sessionToken(request);
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
  const table = authorization ? 'device_tokens' : 'sessions';
  const row = await env.DB.prepare(`SELECT u.id,u.email,u.verified_at FROM ${table} t JOIN users u ON u.id=t.user_id WHERE t.hash=? AND t.expires_at>? AND t.auth_version=u.auth_version`)
    .bind(await tokenHash(raw), Date.now()).first<{ id: string; email: string; verified_at: number | null }>();
  return row ? { id: row.id, email: row.email, verified: row.verified_at !== null, via: authorization ? 'token' : 'cookie' } : null;
}
export async function createUser(db: D1Database, id: string, email: string, passwordHash: string, recoveryHash: string, limit: number): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO users(id,email,password_hash,recovery_hash,created_at) SELECT ?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM users)<? ON CONFLICT(email) DO NOTHING`)
    .bind(id, email, passwordHash, recoveryHash, Date.now(), limit).run();
  return result.meta.changes > 0;
}
export async function handleAccounts(request: Request, env: HostedEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/account/')) return null;
  const route = path.slice('/api/account/'.length);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return fail('Method not allowed', 405);
  if (request.method !== 'GET') {
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) return fail('Invalid origin', 403);
    if (request.method === 'POST' && !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return fail('JSON required', 415);
  }
  if (request.method === 'GET' && route === 'me') {
    const user = await authenticate(request, env);
    return reply({ user: user ? { id: user.id, email: user.email, verified: user.verified } : null });
  }
  if (route === 'devices' || route.startsWith('devices/')) {
    const user = await authenticate(request, env);
    if (!user || user.via !== 'cookie') return fail('Browser login required', 401);
    if (request.method === 'GET' && route === 'devices') {
      const devices = await env.DB.prepare('SELECT id,name,created_at,expires_at FROM device_tokens WHERE user_id=? AND expires_at>? AND auth_version=(SELECT auth_version FROM users WHERE id=?) ORDER BY created_at DESC').bind(user.id, Date.now(), user.id).all();
      return reply({ devices: devices.results });
    }
    if (request.method === 'DELETE' && route.startsWith('devices/')) {
      await env.DB.prepare('DELETE FROM device_tokens WHERE id=? AND user_id=?').bind(route.slice('devices/'.length), user.id).run();
      return reply({ ok: true });
    }
    if (request.method === 'POST' && route === 'devices') {
      if (await limited(env, `devices:${user.id}`, 10, 3600)) return fail('Try again later', 429);
      const body = await readJson(request);
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) return fail('Device name must be 1–80 characters');
      const token = randomToken(), id = crypto.randomUUID(), now = Date.now();
      const inserted = await env.DB.prepare(`INSERT INTO device_tokens(id,hash,user_id,name,created_at,expires_at,auth_version)
        SELECT ?,?,id,?,?,?,auth_version FROM users WHERE id=? AND EXISTS (SELECT 1 FROM sessions WHERE hash=? AND user_id=users.id AND auth_version=users.auth_version AND expires_at>?) AND (SELECT COUNT(*) FROM device_tokens WHERE user_id=? AND expires_at>? AND auth_version=users.auth_version)<10`)
        .bind(id, await tokenHash(token), body.name.trim(), now, now + 90 * DAY, user.id, await tokenHash(sessionToken(request) || ''), now, user.id, now).run();
      return inserted.meta.changes ? reply({ id, token }, 201) : fail('Maximum 10 active devices', 409);
    }
    return fail('Not found', 404);
  }
  if (request.method !== 'POST') return fail('Not found', 404);
  if (route === 'logout') {
    const raw = sessionToken(request);
    if (raw) await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await tokenHash(raw)).run();
    return reply({ ok: true }, 200, cookie('', 0));
  }
  if (!['register', 'login', 'reset-password'].includes(route)) return fail('Not found', 404);
  if (!validPasswordPepper(env.PASSWORD_PEPPER)) return fail('Password authentication is temporarily unavailable', 503);
  const ip = await ipKey(request);
  if (await limited(env, `ip:${ip}`, 30, 600)) return fail('Try again later', 429);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return fail('Valid email required');
  const emailKey = await tokenHash(email);
  if (route === 'login') {
    if (await limited(env, `login:${emailKey}`, 10, 600)) return fail('Try again later', 429);
    if (!validPassword(body.password)) return fail('Invalid email or password', 401);
    if (await limited(env, 'password-global', 120, 60)) return fail('Authentication is busy. Try again shortly.', 429);
    const user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first<UserRow>();
    // Equal-cost password work also for unknown addresses.
    const valid = await withPasswordWork(env.DB, async () => user ? verifyPassword(body.password as string, user.password_hash, env.PASSWORD_PEPPER) : (await hashPassword(body.password as string, env.PASSWORD_PEPPER), false));
    if (!user || !valid) return fail('Invalid email or password', 401);
    const token = randomToken(), now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND (expires_at<=? OR auth_version<>?)').bind(user.id, now, user.auth_version),
      env.DB.prepare('INSERT INTO sessions(hash,user_id,expires_at,auth_version) VALUES(?,?,?,?)').bind(await tokenHash(token), user.id, now + 30 * DAY, user.auth_version),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 20)').bind(user.id, user.id),
    ]);
    return reply({ user: publicUser(user) }, 200, cookie(token));
  }
  if (!configured(env)) return fail('Account registration and recovery are temporarily unavailable', 503);
  if (!(await challenge(request, env, body.turnstileToken))) return fail('Please complete the security check', 403);
  if (await limited(env, `manage:${emailKey}`, 5, 3600) || await limited(env, `manage-ip:${ip}`, 10, 3600)) return fail('Try again later', 429);
  if (!validPassword(body.password)) return fail('Password must be 10–128 characters');
  if (route === 'reset-password') {
    if (typeof body.recoveryCode !== 'string' || !/^[a-f0-9]{64}$/.test(body.recoveryCode)) return fail('Invalid email or recovery code');
    const hash = await tokenHash(body.recoveryCode);
    const user = await env.DB.prepare('SELECT id FROM users WHERE email=? AND recovery_hash=?').bind(email, hash).first();
    if (!user) return fail('Invalid email or recovery code');
    if (await limited(env, 'password-global', 120, 60)) return fail('Authentication is busy. Try again shortly.', 429);
    const password = await withPasswordWork(env.DB, () => hashPassword(body.password as string, env.PASSWORD_PEPPER));
    const recoveryCode = randomToken();
    // Compare-and-swap makes recovery one-time even when requests race.
    const updated = await env.DB.prepare('UPDATE users SET password_hash=?,recovery_hash=?,auth_version=auth_version+1 WHERE email=? AND recovery_hash=? RETURNING id')
      .bind(password, await tokenHash(recoveryCode), email, hash).first();
    if (!updated) return fail('Recovery code already used', 409);
    return reply({ ok: true, recoveryCode }, 200, cookie('', 0));
  }
  if (await limited(env, 'registrations', 200, 86400)) return fail('Try again later', 429);
  const cap = Math.max(1, Math.min(100, Number.parseInt(env.REGISTRATION_LIMIT || '100', 10) || 100));
  if (await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first()) return fail('Account already exists. Sign in or use your recovery code.', 409);
  if ((await env.DB.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())!.n >= cap) return fail('Trial is full. Please try again later.', 409);
  if (await limited(env, 'password-global', 120, 60)) return fail('Authentication is busy. Try again shortly.', 429);
  const password = await withPasswordWork(env.DB, () => hashPassword(body.password as string, env.PASSWORD_PEPPER));
  const recoveryCode = randomToken();
  const inserted = await createUser(env.DB, crypto.randomUUID(), email, password, await tokenHash(recoveryCode), cap);
  if (!inserted) return fail('Account already exists or trial is full.', 409);
  return reply({ ok: true, recoveryCode }, 201);
}

export async function cleanupAccounts(db: D1Database): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM password_leases WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM account_tokens WHERE hash IN (SELECT hash FROM account_tokens WHERE expires_at<? LIMIT 500)').bind(now),
    db.prepare('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE expires_at<? LIMIT 500)').bind(now),
    db.prepare('DELETE FROM device_tokens WHERE id IN (SELECT id FROM device_tokens WHERE expires_at<? LIMIT 500)').bind(now),
  ]);
}
