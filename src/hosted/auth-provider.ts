import { HttpError } from './http';

type ProviderEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string; PUBLIC_ORIGIN: string };
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
    typeof env.SUPABASE_SECRET_KEY === 'string' && (/^sb_secret_[a-zA-Z0-9_-]{16,}$/.test(env.SUPABASE_SECRET_KEY) || legacyKey(env.SUPABASE_SECRET_KEY));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: unknown, env: ProviderEnv, id: string, email: string): void {
  if (!object(value) || value.id !== id || value.email !== email || !object(value.app_metadata) ||
    value.app_metadata.shotsync_origin !== env.PUBLIC_ORIGIN || value.app_metadata.shotsync_user_id !== id) throw new HttpError(503, UNAVAILABLE);
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
async function request(env: ProviderEnv, path: string, method: string, body?: unknown, create = false): Promise<{ status: number; data: unknown }> {
  if (!configuredProvider(env)) throw new HttpError(503, UNAVAILABLE);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const headers: Record<string, string> = { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' };
        // Modern secret keys are not JWTs; only legacy service_role keys use Bearer.
        if (legacyKey(env.SUPABASE_SECRET_KEY)) headers.Authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
        const response = await fetch(`${env.SUPABASE_URL}/auth/v1${path}`, {
          method, headers, redirect: 'manual', signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (create && [400, 401, 403, 422, 429].includes(response.status)) {
          await response.body?.cancel();
          throw new ProviderMutationError(response.status === 429 ? 429 : 503, true);
        }
        if (response.status === 429) { await response.body?.cancel(); throw new HttpError(429, BUSY); }
        if (!response.ok && response.status !== 400) { await response.body?.cancel(); throw new HttpError(503, UNAVAILABLE); }
        return { status: response.status, data: await boundedJson(response) };
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
export async function createPasswordUser(env: ProviderEnv, id: string, email: string, password: string, operation?: string): Promise<void> {
  try {
    requireId(id);
    const { status, data } = await request(env, '/admin/users', 'POST', {
      id, email, password, email_confirm: true, app_metadata: { shotsync_origin: env.PUBLIC_ORIGIN, shotsync_user_id: id, ...(operation ? { shotsync_operation: operation } : {}) },
    }, true);
    if (status < 200 || status >= 300) throw new HttpError(503, UNAVAILABLE);
    identity(data, env, id, email);
  } catch (error) {
    if (error instanceof ProviderMutationError) throw error;
    throw new ProviderMutationError(error instanceof HttpError ? error.status : 503, false);
  }
}
export async function verifyProviderPassword(env: ProviderEnv, id: string, email: string, password: string): Promise<boolean> {
  if (id !== '') requireId(id);
  const { status, data } = await request(env, '/token?grant_type=password', 'POST', { email, password });
  if (status === 400 && object(data) && data.error_code === 'invalid_credentials') return false;
  if (status !== 200 || !object(data) || !object(data.user) || typeof data.user.id !== 'string' || !UUID.test(data.user.id) ||
    data.user.email !== email || !object(data.user.app_metadata)) throw new HttpError(503, UNAVAILABLE);
  // Unknown local accounts still do provider password work but can never link by email.
  if (id === '') return false;
  identity(data.user, env, id, email);
  return true;
}
export async function updateProviderPassword(env: ProviderEnv, id: string, email: string, password: string, operation?: string): Promise<void> {
  requireId(id);
  const path = `/admin/users/${id}`;
  const before = await request(env, path, 'GET');
  if (before.status !== 200) throw new HttpError(503, UNAVAILABLE);
  identity(before.data, env, id, email);
  const after = await request(env, path, 'PUT', { password, ...(operation ? { app_metadata: { shotsync_operation: operation } } : {}) });
  if (after.status !== 200) throw new HttpError(503, UNAVAILABLE);
  identity(after.data, env, id, email);
}
