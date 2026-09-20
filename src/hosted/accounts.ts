import type { HostedEnv } from './types';
import { consumeRate } from './limits';
import { readJson } from './http';
import { configuredProvider, createPasswordUser, verifyProviderPassword, updateProviderPassword, ProviderMutationError, verifyAccessToken, refreshProviderSession, revokeProviderSession, type ProviderSession } from './auth-provider';
import { randomToken, tokenHash, withAuthRequest } from './account-crypto';

const DAY = 86_400_000;
const COOKIE = '__Host-shotsync-refresh';
interface UserRow { id: string; email: string; password_hash: string; verified_at: number | null; auth_version: number; auth_provider_id: string | null; auth_state: 'legacy' | 'active' | 'resetting' }
export interface Account { id: string; email: string; verified: boolean; via: 'cookie' | 'token'; authVersion?: number; sessionId?: string; expiresAt?: number }
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
function validPassword(value: unknown): value is string { return typeof value === 'string' && value.length >= 10 && new TextEncoder().encode(value).byteLength <= 72; }
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
  const raw = request.headers.get('Authorization')?.match(/^Bearer ([^ ]+)$/)?.[1];
  if (!raw) return null;
  if (/^[a-f0-9]{64}$/.test(raw)) {
    const row = await env.DB.prepare(`SELECT u.id,u.email,u.verified_at FROM device_tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=? AND t.expires_at>? AND t.auth_version=u.auth_version AND u.auth_state='active'`)
      .bind(await tokenHash(raw), Date.now()).first<UserRow>();
    return row ? { ...publicUser(row), via: 'token' } : null;
  }
  const claims = await verifyAccessToken(env, raw);
  if (!claims) return null;
  const row = await env.DB.prepare(`SELECT * FROM users WHERE id=? AND auth_provider_id=? AND auth_state='active' AND auth_version=? AND NOT EXISTS (SELECT 1 FROM revoked_auth_sessions WHERE session_id=?)`)
    .bind(claims.id, claims.id, claims.authVersion, claims.sessionId).first<UserRow>();
  return row ? { ...publicUser(row), via: 'cookie', authVersion: claims.authVersion, sessionId: claims.sessionId, expiresAt: claims.expiresAt } : null;
}
async function sessionReply(env: HostedEnv, session: ProviderSession, expectedVersion?: number): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM users WHERE id=? AND auth_provider_id=? AND auth_state='active' AND auth_version=? AND NOT EXISTS (SELECT 1 FROM revoked_auth_sessions WHERE session_id=?)`)
    .bind(session.id, session.id, session.authVersion, session.sessionId).first<UserRow>();
  if (!row || (expectedVersion !== undefined && row.auth_version !== expectedVersion)) return fail('Account changed. Please sign in again.', 409);
  return reply({ user: publicUser(row), accessToken: session.accessToken, expiresAt: session.expiresAt }, 200, cookie(session.refreshToken));
}

export async function reserveRegistration(db: D1Database, id: string, email: string, limit: number): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO auth_registrations(id,email,created_at) SELECT ?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE email=?)
      AND (SELECT COUNT(*) FROM users)+(SELECT COUNT(*) FROM auth_registrations WHERE state='pending')<?
    ON CONFLICT(email) DO UPDATE SET id=excluded.id,created_at=excluded.created_at,state='pending' WHERE auth_registrations.state='failed'`)
    .bind(id, email, Date.now(), email, limit).run();
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
        SELECT ?,?,id,?,?,?,auth_version FROM users WHERE id=? AND auth_state='active' AND auth_version=? AND NOT EXISTS (SELECT 1 FROM revoked_auth_sessions WHERE session_id=?) AND (SELECT COUNT(*) FROM device_tokens WHERE user_id=? AND expires_at>? AND auth_version=users.auth_version)<10`)
        .bind(id, await tokenHash(token), body.name.trim(), now, now + 90 * DAY, user.id, user.authVersion, user.sessionId, user.id, now).run();
      return inserted.meta.changes ? reply({ id, token }, 201) : fail('Maximum 10 active devices', 409);
    }
    return fail('Not found', 404);
  }
  if (request.method !== 'POST') return fail('Not found', 404);
  if (route === 'logout') {
    const bearer = request.headers.get('Authorization')?.match(/^Bearer ([^ ]+)$/)?.[1];
    const user = bearer ? await verifyAccessToken(env, bearer, true) : null;
    if (user?.sessionId) {
      // Keep the tombstone beyond any access JWT minted before remote revocation completes.
      await env.DB.prepare('INSERT INTO revoked_auth_sessions(session_id,expires_at) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)')
        .bind(user.sessionId, Number.MAX_SAFE_INTEGER).run();
      try {
        await revokeProviderSession(env, request.headers.get('Authorization')!.slice(7));
        await env.DB.prepare('UPDATE revoked_auth_sessions SET expires_at=? WHERE session_id=?').bind(Date.now() + 2 * DAY, user.sessionId).run();
      } catch {
        // An ambiguous remote sign-out must never let the refresh token revive this session.
        return reply({ ok: true, warning: 'Remote sign-out is pending; this session remains blocked.' }, 200, cookie('', 0));
      }
    }
    return reply({ ok: true }, 200, cookie('', 0));
  }
  if (route === 'refresh') {
    if (!configuredProvider(env)) return fail('Password authentication is temporarily unavailable', 503);
    const raw = sessionToken(request);
    if (!raw || !/^[a-zA-Z0-9_-]{10,2048}$/.test(raw)) return reply({ error: 'Sign in required' }, 401, cookie('', 0));
    if (await limited(env, `refresh:${await ipKey(request)}`, 60, 600)) return fail('Try again later', 429);
    const session = await withAuthRequest(env.DB, () => refreshProviderSession(env, raw));
    return session ? sessionReply(env, session) : reply({ error: 'Sign in required' }, 401, cookie('', 0));
  }
  if (!['register', 'login', 'reset-password'].includes(route)) return fail('Not found', 404);
  if (!configuredProvider(env)) return fail('Password authentication is temporarily unavailable', 503);
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
    // Provider identities are bound by immutable ID; matching email alone never grants access.
    if (user && user.auth_state !== 'active') return fail('Account needs recovery or operator assistance', 409);
    const session = await withAuthRequest(env.DB, () => verifyProviderPassword(env, user?.auth_provider_id || '', email, body.password as string));
    if (!user || !session) return fail('Invalid email or password', 401);
    return sessionReply(env, session, user.auth_version);
  }

  if (!configured(env)) return fail('Account registration and recovery are temporarily unavailable', 503);
  if (!(await challenge(request, env, body.turnstileToken))) return fail('Please complete the security check', 403);
  if (await limited(env, `manage:${emailKey}`, 5, 3600) || await limited(env, `manage-ip:${ip}`, 10, 3600)) return fail('Try again later', 429);
  if (!validPassword(body.password)) return fail('Password must be at least 10 characters and at most 72 UTF-8 bytes');
  if (route === 'reset-password') {
    if (typeof body.recoveryCode !== 'string' || !/^[a-f0-9]{64}$/.test(body.recoveryCode)) return fail('Invalid email or recovery code');
    const hash = await tokenHash(body.recoveryCode);
    const user = await env.DB.prepare('SELECT * FROM users WHERE email=? AND recovery_hash=?').bind(email, hash).first<UserRow>();
    if (!user) return fail('Invalid email or recovery code');
    if (user.auth_state === 'resetting') return fail('Password recovery is pending. Contact the service operator.', 409);
    if (await limited(env, 'password-global', 120, 60)) return fail('Authentication is busy. Try again shortly.', 429);
    const operation = crypto.randomUUID();
    // Claim once before any external mutation. Never expire/retry an ambiguous remote update.
    const claimed = await env.DB.prepare(`UPDATE users SET auth_state='resetting',auth_operation=?,auth_version=auth_version+1
      WHERE id=? AND recovery_hash=? AND auth_state IN ('active','legacy') RETURNING id`)
      .bind(operation, user.id, hash).first();
    if (!claimed) return fail('Recovery is already in progress', 409);
    const providerId = user.auth_provider_id || user.id;
    if (user.auth_provider_id) await updateProviderPassword(env, providerId, email, body.password as string, operation, user.auth_version + 1);
    else await createPasswordUser(env, providerId, email, body.password as string, operation, user.auth_version + 1);
    const recoveryCode = randomToken();
    const updated = await env.DB.prepare(`UPDATE users SET password_hash='external:supabase',auth_provider_id=?,auth_state='active',auth_operation=NULL,recovery_hash=?
      WHERE id=? AND auth_state='resetting' AND auth_operation=? RETURNING id`)
      .bind(providerId, await tokenHash(recoveryCode), user.id, operation).first();
    if (!updated) return fail('Password recovery is pending. Contact the service operator.', 503);
    return reply({ ok: true, recoveryCode }, 200, cookie('', 0));
  }
  if (await limited(env, 'registrations', 200, 86400)) return fail('Try again later', 429);
  const cap = Math.max(1, Math.min(100, Number.parseInt(env.REGISTRATION_LIMIT || '100', 10) || 100));
  if (await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first()) return fail('Account already exists. Sign in or use your recovery code.', 409);
  if (await limited(env, 'password-global', 120, 60)) return fail('Authentication is busy. Try again shortly.', 429);
  const id = crypto.randomUUID();
  if (!(await reserveRegistration(env.DB, id, email, cap))) return fail('Trial is full or registration is already pending.', 409);
  try { await createPasswordUser(env, id, email, body.password as string); }
  catch (error) {
    // Only a definitive rejection releases the slot. Timeout/5xx may already have created the identity.
    if (error instanceof ProviderMutationError && error.definitive) {
      await env.DB.prepare("UPDATE auth_registrations SET state='failed' WHERE id=? AND state='pending'").bind(id).run();
    }
    throw error;
  }
  const recoveryCode = randomToken();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users(id,email,password_hash,recovery_hash,created_at,auth_provider_id,auth_state)
      SELECT id,email,'external:supabase',?,?,id,'active' FROM auth_registrations WHERE id=? AND state='pending'`)
      .bind(await tokenHash(recoveryCode), Date.now(), id),
    env.DB.prepare("UPDATE auth_registrations SET state='complete' WHERE id=? AND state='pending'").bind(id),
  ]);
  return reply({ ok: true, recoveryCode }, 201);
}

export async function cleanupAccounts(db: D1Database): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM auth_registrations WHERE state IN ('failed','complete') AND created_at<?").bind(now - 7 * DAY),
    db.prepare('DELETE FROM revoked_auth_sessions WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM password_leases WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM account_tokens WHERE hash IN (SELECT hash FROM account_tokens WHERE expires_at<? LIMIT 500)').bind(now),
    db.prepare('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE expires_at<? LIMIT 500)').bind(now),
    db.prepare('DELETE FROM device_tokens WHERE id IN (SELECT id FROM device_tokens WHERE expires_at<? LIMIT 500)').bind(now),
  ]);
}
