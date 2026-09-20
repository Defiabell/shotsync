import { HttpError } from './http';
import { createRemoteJWKSet, jwtVerify, errors, type JWTPayload } from 'jose';

type ProviderEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string; SUPABASE_PUBLISHABLE_KEY: string; PUBLIC_ORIGIN: string };
const UNAVAILABLE = 'Password authentication is temporarily unavailable';
const BUSY = 'Authentication is busy. Try again shortly.';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class ProviderMutationError extends HttpError {
  constructor(status: number, public definitive: boolean) { super(status, status === 429 ? BUSY : UNAVAILABLE); }
}
function legacyKey(key: string): boolean {
  try {
    const parts = key.split('.');
    return parts.length === 3 && parts.every(p => /^[a-zA-Z0-9_-]+$/.test(p)) &&
      JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role';
  } catch { return false; }
}
export function configuredProvider(env: ProviderEnv): boolean {
  return typeof env.SUPABASE_URL === 'string' && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL) &&
    typeof env.SUPABASE_PUBLISHABLE_KEY === 'string' && /^sb_publishable_[a-zA-Z0-9_-]{16,}$/.test(env.SUPABASE_PUBLISHABLE_KEY) &&
    typeof env.SUPABASE_SECRET_KEY === 'string' && (/^sb_secret_[a-zA-Z0-9_-]{16,}$/.test(env.SUPABASE_SECRET_KEY) || legacyKey(env.SUPABASE_SECRET_KEY));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: unknown, env: ProviderEnv, id: string, email: string, authVersion?: number): void {
  if (!object(value) || value.id !== id || value.email !== email || !object(value.app_metadata) ||
    value.app_metadata.shotsync_origin !== env.PUBLIC_ORIGIN || value.app_metadata.shotsync_user_id !== id || (authVersion !== undefined && value.app_metadata.shotsync_auth_version !== authVersion)) throw new HttpError(503, UNAVAILABLE);
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new HttpError(503, UNAVAILABLE);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new HttpError(503, UNAVAILABLE);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}
async function request(env: ProviderEnv, path: string, method: string, body?: unknown, create = false, accessToken?: string): Promise<{ status: number; data: unknown }> {
  if (!configuredProvider(env)) throw new HttpError(503, UNAVAILABLE);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const admin = path.startsWith('/admin/');
        const headers: Record<string, string> = { apikey: admin ? env.SUPABASE_SECRET_KEY : env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' };
        // Modern secret keys are not JWTs; only legacy service_role keys use Bearer.
        if (admin && legacyKey(env.SUPABASE_SECRET_KEY)) headers.Authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        const response = await fetch(`${env.SUPABASE_URL}/auth/v1${path}`, {
          method, headers, redirect: 'manual', signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (create && [400, 401, 403, 422, 429].includes(response.status)) {
          await response.body?.cancel();
          throw new ProviderMutationError(response.status === 429 ? 429 : 503, true);
        }
        if (response.status === 429) { await response.body?.cancel(); throw new HttpError(429, BUSY); }
        if (!response.ok && ![400,401,403].includes(response.status)) { await response.body?.cancel(); throw new HttpError(503, UNAVAILABLE); }
        return { status: response.status, data: response.status === 204 ? null : await boundedJson(response) };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new HttpError(503, UNAVAILABLE)); }, 10_000);
      }),
    ]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, UNAVAILABLE);
  } finally { if (timer) clearTimeout(timer); }
}
function requireId(id: string): void { if (!UUID.test(id)) throw new HttpError(503, UNAVAILABLE); }
export async function createPasswordUser(env: ProviderEnv, id: string, email: string, password: string, operation?: string, authVersion = 0): Promise<void> {
  try {
    requireId(id);
    const { status, data } = await request(env, '/admin/users', 'POST', {
      id, email, password, email_confirm: true, app_metadata: { shotsync_origin: env.PUBLIC_ORIGIN, shotsync_user_id: id, shotsync_auth_version: authVersion, ...(operation ? { shotsync_operation: operation } : {}) },
    }, true);
    if (status < 200 || status >= 300) throw new HttpError(503, UNAVAILABLE);
    identity(data, env, id, email, authVersion);
  } catch (error) {
    if (error instanceof ProviderMutationError) throw error;
    throw new ProviderMutationError(error instanceof HttpError ? error.status : 503, false);
  }
}
export interface ProviderSession { accessToken: string; refreshToken: string; expiresAt: number; id: string; email: string; authVersion: number; sessionId: string }
export interface ProviderClaims { id: string; authVersion: number; sessionId: string; expiresAt: number }
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyAccessToken(env: ProviderEnv, token: string, allowExpiredForLogout = false): Promise<ProviderClaims | null> {
  if (!configuredProvider(env) || token.length > 16384) return null;
  let keys = jwks.get(env.SUPABASE_URL);
  if (!keys) { keys = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`), { timeoutDuration: 5000 }); jwks.set(env.SUPABASE_URL, keys); }
  try {
    let payload: JWTPayload;
    try { ({ payload } = await jwtVerify(token, keys, { issuer: `${env.SUPABASE_URL}/auth/v1`, audience: 'authenticated', algorithms: ['ES256', 'RS256'], requiredClaims: ['sub', 'exp', 'iat', 'session_id'] })); }
    catch (error) {
      // jose verifies signature, issuer, audience and not-before before reporting expiration.
      // Only sign-out may use this payload; it can revoke a session but cannot authorize access.
      if (!allowExpiredForLogout || !(error instanceof errors.JWTExpired) || error.claim !== 'exp') return null;
      payload = error.payload;
    }
    const metadata = payload.app_metadata;
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub) || typeof payload.session_id !== 'string' || !UUID.test(payload.session_id) || !object(metadata) ||
      metadata.shotsync_origin !== env.PUBLIC_ORIGIN || metadata.shotsync_user_id !== payload.sub || !Number.isSafeInteger(metadata.shotsync_auth_version) || (metadata.shotsync_auth_version as number) < 0 ||
      typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + 60 || payload.exp - payload.iat > 86400 || payload.exp > Math.floor(Date.now() / 1000) + 86400) return null;
    return { id: payload.sub, authVersion: metadata.shotsync_auth_version as number, sessionId: payload.session_id, expiresAt: payload.exp * 1000 };
  } catch { return null; }
}
async function session(env: ProviderEnv, data: unknown): Promise<ProviderSession> {
  if (!object(data) || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !/^[a-zA-Z0-9_-]{10,2048}$/.test(data.refresh_token) || !object(data.user) || typeof data.user.id !== 'string' || typeof data.user.email !== 'string') throw new HttpError(503, UNAVAILABLE);
  identity(data.user, env, data.user.id, data.user.email);
  const claims = await verifyAccessToken(env, data.access_token);
  if (!claims || claims.id !== data.user.id) throw new HttpError(503, UNAVAILABLE);
  return { ...claims, accessToken: data.access_token, refreshToken: data.refresh_token, email: data.user.email };
}
export async function verifyProviderPassword(env: ProviderEnv, id: string, email: string, password: string): Promise<ProviderSession | null> {
  if (id !== '') requireId(id);
  const { status, data } = await request(env, '/token?grant_type=password', 'POST', { email, password });
  if (status === 400 && object(data) && data.error_code === 'invalid_credentials') return null;
  if (status !== 200 || !object(data) || !object(data.user)) throw new HttpError(503, UNAVAILABLE);
  if (id === '') return null;
  identity(data.user, env, id, email);
  return session(env, data);
}
export async function refreshProviderSession(env: ProviderEnv, refreshToken: string): Promise<ProviderSession | null> {
  const { status, data } = await request(env, '/token?grant_type=refresh_token', 'POST', { refresh_token: refreshToken });
  if ([400, 401, 403].includes(status)) return null;
  if (status !== 200) throw new HttpError(503, UNAVAILABLE);
  return session(env, data);
}
export async function revokeProviderSession(env: ProviderEnv, accessToken: string): Promise<void> {
  const { status } = await request(env, '/logout?scope=local', 'POST', undefined, false, accessToken);
  if (![200, 204].includes(status)) throw new HttpError(503, UNAVAILABLE);
}
export async function updateProviderPassword(env: ProviderEnv, id: string, email: string, password: string, operation?: string, authVersion = 0): Promise<void> {
  requireId(id);
  const path = `/admin/users/${id}`;
  const before = await request(env, path, 'GET');
  if (before.status !== 200) throw new HttpError(503, UNAVAILABLE);
  identity(before.data, env, id, email);
  const after = await request(env, path, 'PUT', { password, app_metadata: { shotsync_origin: env.PUBLIC_ORIGIN, shotsync_user_id: id, shotsync_auth_version: authVersion, ...(operation ? { shotsync_operation: operation } : {}) } });
  if (after.status !== 200) throw new HttpError(503, UNAVAILABLE);
  identity(after.data, env, id, email, authVersion);
}
