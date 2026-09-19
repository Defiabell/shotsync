import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/hosted/http';
import { authenticate, reserveRegistration, cleanupAccounts, handleAccounts } from '../src/hosted/accounts';
import { randomToken, tokenHash, withAuthRequest } from '../src/hosted/account-crypto';
import * as provider from '../src/hosted/auth-provider';
import type { HostedEnv } from '../src/hosted/types';
// @ts-expect-error Vite imports migration text for the real local D1 database.
import schema from '../migrations/0001_accounts.sql?raw';
// @ts-expect-error Vite imports migration text for the real local D1 database.
import recoverySchema from '../migrations/0003_recovery.sql?raw';
// @ts-expect-error Vite imports migration text.
import managedSchema from '../migrations/0004_managed_auth.sql?raw';
const db = (env as unknown as { DB: D1Database }).DB;
const origin = 'https://shotsync.test';
const password = 'a-long-password!';
const providerUsers = new Map<string, { id: string; password: string }>();

let bindings: HostedEnv;
const passwordHash = 'external:supabase';
function request(route: string, body?: unknown, headers: Record<string, string> = {}, method?: string) {
  return new Request(`${origin}/api/account/${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function call(route: string, body?: unknown, headers?: Record<string, string>, method?: string) {
  try { return (await handleAccounts(request(route, body, headers, method), bindings))!; }
  catch (error) { if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
}
async function seed(email = 'person@example.com', verified = true) {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO users(id,email,password_hash,verified_at,created_at,auth_provider_id,auth_state) VALUES(?,?,?,?,?,?,'active')").bind(id, email, passwordHash, verified ? Date.now() : null, Date.now(), id).run();
  providerUsers.set(email, { id, password });
  return id;
}
async function login(email = 'person@example.com') {
  const response = await call('login', { email, password });
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
beforeEach(async () => {
  for (const statement of ((schema as string) + (recoverySchema as string) + (managedSchema as string)).split(';').filter(s => s.trim())) await db.prepare(statement).run();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ success: true, hostname: 'shotsync.test' }));
  bindings = { ...env, DB: db, PUBLIC_ORIGIN: origin, TURNSTILE_SECRET_KEY: 'test-secret', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test-provider-key', REGISTRATION_LIMIT: '100' } as unknown as HostedEnv;
  providerUsers.clear();
  vi.spyOn(provider, 'createPasswordUser').mockImplementation(async (_env, id, email, supplied) => {
    if (providerUsers.has(email)) throw new HttpError(503, 'Provider rejected request');
    providerUsers.set(email, { id, password: supplied });
  });
  vi.spyOn(provider, 'verifyProviderPassword').mockImplementation(async (_env, id, email, supplied) => {
    const remote = providerUsers.get(email);
    return !!remote && remote.id === id && remote.password === supplied;
  });
  vi.spyOn(provider, 'updateProviderPassword').mockImplementation(async (_env, id, email, supplied) => {
    const remote = providerUsers.get(email);
    if (!remote || remote.id !== id) throw new HttpError(503, 'Provider unavailable');
    remote.password = supplied;
  });
});
afterEach(() => vi.restoreAllMocks());
describe('hosted accounts with real D1', () => {
  it('fails closed without provider configuration and performs no local password derivation', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    bindings.SUPABASE_SECRET_KEY = '';
    for (const route of ['login', 'register', 'reset-password']) {
      expect((await call(route, { email: 'person@example.com', password, turnstileToken: 'captcha' })).status).toBe(503);
    }
    expect(provider.verifyProviderPassword).not.toHaveBeenCalled();
    expect(derive).not.toHaveBeenCalled();
  });
  it('delegates unknown-account password checks without issuing a local session', async () => {
    expect((await call('login', { email: 'unknown@example.com', password })).status).toBe(401);
    expect(provider.verifyProviderPassword).toHaveBeenCalledWith(bindings, '', 'unknown@example.com', password);
    expect(await db.prepare('SELECT hash FROM sessions').first()).toBeNull();
  });
  it('does not link an unrelated provider identity by matching email', async () => {
    await seed();
    providerUsers.set('person@example.com', { id: crypto.randomUUID(), password });
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(401);
  });
  it('provider outages never become invalid-password errors or local fallback', async () => {
    await seed();
    vi.mocked(provider.verifyProviderPassword).mockRejectedValue(new HttpError(503, 'Provider unavailable'));
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(503);
    expect(await db.prepare('SELECT hash FROM sessions').first()).toBeNull();
  });
  it('migrates legacy credentials only with the existing recovery code', async () => {
    const id = await seed(), recoveryCode = randomToken();
    providerUsers.delete('person@example.com');
    await db.prepare("UPDATE users SET auth_state='legacy',auth_provider_id=NULL,password_hash='legacy-hash',recovery_hash=? WHERE id=?")
      .bind(await tokenHash(recoveryCode), id).run();
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(409);
    expect((await call('reset-password', { email: 'person@example.com', recoveryCode, password, turnstileToken: 'captcha' })).status).toBe(200);
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(200);
    expect((await db.prepare('SELECT password_hash,auth_provider_id FROM users WHERE id=?').bind(id).first())).toMatchObject({ password_hash: 'external:supabase', auth_provider_id: id });
  });
  it('keeps uncertain registration reserved and never retries a possibly completed mutation', async () => {
    bindings.REGISTRATION_LIMIT = '1';
    vi.mocked(provider.createPasswordUser).mockRejectedValue(new provider.ProviderMutationError(503, false));
    expect((await call('register', { email: 'pending@example.com', password, turnstileToken: 'captcha' })).status).toBe(503);
    expect((await call('register', { email: 'pending@example.com', password, turnstileToken: 'captcha' })).status).toBe(409);
    expect((await call('register', { email: 'other@example.com', password, turnstileToken: 'captcha' })).status).toBe(409);
    expect(provider.createPasswordUser).toHaveBeenCalledOnce();
    expect(await db.prepare('SELECT state FROM auth_registrations').first()).toEqual({ state: 'pending' });
    await db.prepare('UPDATE auth_registrations SET created_at=0').run();
    await cleanupAccounts(db);
    expect(await db.prepare('SELECT state FROM auth_registrations').first()).toEqual({ state: 'pending' });
  });
  it('releases only definitively rejected registrations and allows a new attempt', async () => {
    bindings.REGISTRATION_LIMIT = '1';
    vi.mocked(provider.createPasswordUser).mockRejectedValueOnce(new provider.ProviderMutationError(503, true));
    expect((await call('register', { email: 'new@example.com', password, turnstileToken: 'captcha' })).status).toBe(503);
    expect(await db.prepare('SELECT state FROM auth_registrations').first()).toEqual({ state: 'failed' });
    expect((await call('register', { email: 'new@example.com', password, turnstileToken: 'captcha' })).status).toBe(201);
    expect(provider.createPasswordUser).toHaveBeenCalledTimes(2);
  });
  it('uncertain recovery blocks all old credentials and later password mutations', async () => {
    const id = await seed(), recoveryCode = randomToken();
    await db.prepare('UPDATE users SET recovery_hash=? WHERE id=?').bind(await tokenHash(recoveryCode), id).run();
    const cookie = await login();
    const device = await (await call('devices', { name: 'old' }, { Cookie: cookie })).json() as { token: string };
    vi.mocked(provider.updateProviderPassword).mockRejectedValue(new HttpError(503, 'Provider timeout'));
    const body = { email: 'person@example.com', recoveryCode, password: 'new-owner-password', turnstileToken: 'captcha' };
    expect((await call('reset-password', body)).status).toBe(503);
    expect(await authenticate(request('me', undefined, { Cookie: cookie }), bindings)).toBeNull();
    expect(await authenticate(request('me', undefined, { Authorization: 'Bearer ' + device.token }), bindings)).toBeNull();
    expect((await call('devices', { name: 'forbidden' }, { Cookie: cookie })).status).toBe(401);
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(409);
    expect((await call('reset-password', { ...body, password: 'another-new-password' })).status).toBe(409);
    expect(provider.updateProviderPassword).toHaveBeenCalledOnce();
    await cleanupAccounts(db);
    expect((await db.prepare('SELECT auth_state,auth_version,recovery_hash FROM users WHERE id=?').bind(id).first())).toMatchObject({ auth_state: 'resetting', auth_version: 1, recovery_hash: await tokenHash(recoveryCode) });
  });
  it('cannot issue a session from a provider response that crosses a recovery boundary', async () => {
    const id = await seed();
    vi.mocked(provider.verifyProviderPassword).mockImplementationOnce(async () => {
      await db.prepare("UPDATE users SET auth_state='resetting',auth_version=auth_version+1 WHERE id=?").bind(id).run();
      return true;
    });
    const response = await call('login', { email: 'person@example.com', password });
    expect(response.status).toBe(409);
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(await db.prepare('SELECT hash FROM sessions').first()).toBeNull();
  });
  it('a stale login cannot delete a newer post-recovery session', async () => {
    const id = await seed(), newToken = randomToken();
    vi.mocked(provider.verifyProviderPassword).mockImplementationOnce(async () => {
      await db.batch([
        db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').bind(id),
        db.prepare('INSERT INTO sessions(hash,user_id,expires_at,auth_version) VALUES(?,?,?,1)').bind(await tokenHash(newToken), id, Date.now() + 60000),
      ]);
      return true;
    });
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(409);
    expect(await authenticate(request('me', undefined, { Cookie: '__Host-shotsync=' + newToken }), bindings)).not.toBeNull();
  });
  it('enforces the provider UTF-8 password boundary without truncation', async () => {
    const over = '中'.repeat(25), valid = '中'.repeat(24);
    expect((await call('register', { email: 'too-long@example.com', password: over, turnstileToken: 'captcha' })).status).toBe(400);
    expect(provider.createPasswordUser).not.toHaveBeenCalled();
    expect((await call('register', { email: 'valid@example.com', password: valid, turnstileToken: 'captcha' })).status).toBe(201);
    expect(provider.createPasswordUser).toHaveBeenCalledWith(bindings, expect.any(String), 'valid@example.com', valid);
    expect((await call('login', { email: 'valid@example.com', password: over })).status).toBe(401);
  });
  it('rejects cross-origin and form mutations', async () => {
    expect((await call('login', {}, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('login', {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
  });
  it('device tokens are scoped, revocable, and cannot manage devices themselves', async () => {
    await seed();
    const cookie = await login();
    const created = await call('devices', { name: 'Mac' }, { Cookie: cookie });
    expect(created.status).toBe(201);
    const device = await created.json() as { id: string; token: string };
    const user = await authenticate(request('me', undefined, { Authorization: `Bearer ${device.token}` }), bindings);
    expect(user?.via).toBe('token');
    expect((await call('devices', undefined, { Authorization: `Bearer ${device.token}` })).status).toBe(401);
    await call(`devices/${device.id}`, undefined, { Cookie: cookie }, 'DELETE');
    expect(await authenticate(request('me', undefined, { Authorization: `Bearer ${device.token}` }), bindings)).toBeNull();
  });
  it('one account cannot revoke another account device', async () => {
    await seed();
    const a = await login();
    const response = await call('devices', { name: 'Mac' }, { Cookie: a });
    const device = await response.json() as { id: string; token: string };
    await seed('other@example.com');
    const b = await login('other@example.com');
    await call(`devices/${device.id}`, undefined, { Cookie: b }, 'DELETE');
    expect(await authenticate(request('me', undefined, { Authorization: `Bearer ${device.token}` }), bindings)).not.toBeNull();
  });
  it('concurrent device creation cannot exceed ten active tokens', async () => {
    const id = await seed();
    const cookie = await login();
    for (let i = 0; i < 9; i++) await db.prepare('INSERT INTO device_tokens(id,hash,user_id,name,created_at,expires_at,auth_version) VALUES(?,?,?,?,?,?,0)').bind(crypto.randomUUID(), randomToken(), id, 'seed', Date.now(), Date.now() + 60000).run();
    const responses = await Promise.all([call('devices', { name: 'a' }, { Cookie: cookie }), call('devices', { name: 'b' }, { Cookie: cookie })]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  });
  it('caps concurrent provider sign-ins atomically and releases every lease', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = async () => { started(); await held; return 'ok'; };
    const a = withAuthRequest(db, work);
    await ready;
    await expect(withAuthRequest(db, async () => 'blocked')).rejects.toMatchObject({ status: 429 });
    release();
    expect(await a).toBe('ok');
    expect((await db.prepare('SELECT COUNT(*) n FROM password_leases').first<{ n: number }>())!.n).toBe(0);
    await expect(withAuthRequest(db, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect((await db.prepare('SELECT COUNT(*) n FROM password_leases').first<{ n: number }>())!.n).toBe(0);
  });
  it('reclaims abandoned expired provider request leases', async () => {
    await db.prepare('INSERT INTO password_leases(id,expires_at) VALUES(?,?)').bind('expired', Date.now() - 1).run();
    expect(await withAuthRequest(db, async () => 'recovered')).toBe('recovered');
    expect((await db.prepare('SELECT COUNT(*) n FROM password_leases').first<{ n: number }>())!.n).toBe(0);
  });

  it('registers immediately usable accounts without email delivery and stores only the recovery hash', async () => {
    const response = await call('register', { email: 'New@Example.com', password, turnstileToken: 'captcha' });
    expect(response.status).toBe(201);
    const { recoveryCode } = await response.json() as { recoveryCode: string };
    expect(recoveryCode).toMatch(/^[a-f0-9]{64}$/);
    const user = await db.prepare('SELECT * FROM users WHERE email=?').bind('new@example.com').first();
    expect(user?.verified_at).toBeNull();
    expect(user?.recovery_hash).toBe(await tokenHash(recoveryCode));
    expect(user?.recovery_hash).not.toBe(recoveryCode);
    const cookie = await login('new@example.com');
    expect((await authenticate(request('me', undefined, { Cookie: cookie }), bindings))?.verified).toBe(false);
    expect((await call('devices', { name: 'Mac' }, { Cookie: cookie })).status).toBe(201);
    expect((await db.prepare('SELECT COUNT(*) n FROM account_tokens').first<{ n: number }>())!.n).toBe(0);
  });
  it('requires configured Turnstile and the correct challenge hostname', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, hostname: 'attacker.test' }));
    expect((await call('register', { email: 'person@example.com', password, turnstileToken: 'captcha' })).status).toBe(403);
    bindings.TURNSTILE_SECRET_KEY = '';
    expect((await call('register', { email: 'person@example.com', password, turnstileToken: 'captcha' })).status).toBe(503);
  });
  it('atomically admits only one account into the final trial slot including unverified accounts', async () => {
    await seed('existing@example.com', false);
    const results = await Promise.all([
      reserveRegistration(db, 'a', 'a@example.com', 2),
      reserveRegistration(db, 'b', 'b@example.com', 2),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await db.prepare("SELECT (SELECT COUNT(*) FROM users)+(SELECT COUNT(*) FROM auth_registrations WHERE state='pending') n").first<{ n: number }>())!.n).toBe(2);
    bindings.REGISTRATION_LIMIT = '2';
    expect((await call('register', { email: 'c@example.com', password, turnstileToken: 'captcha' })).status).toBe(409);
  });
  it('does not overwrite an existing account or disclose its recovery code', async () => {
    const id = await seed('person@example.com', false);
    const response = await call('register', { email: 'person@example.com', password: 'attacker-password', turnstileToken: 'captcha' });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('recoveryCode');
    expect((await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(id).first())?.password_hash).toBe(passwordHash);
  });
  it('recovery rotates once, invalidates every old credential, and accepts only the new code next time', async () => {
    const id = await seed('person@example.com', false), recoveryCode = randomToken();
    await db.prepare('UPDATE users SET recovery_hash=? WHERE id=?').bind(await tokenHash(recoveryCode), id).run();
    const cookie = await login();
    const deviceResponse = await call('devices', { name: 'Mac' }, { Cookie: cookie });
    const { token: device } = await deviceResponse.json() as { token: string };
    const reset = (code: string) => call('reset-password', { email: 'person@example.com', recoveryCode: code, password: 'new-owner-password', turnstileToken: 'captcha' });
    const responses = await Promise.all([reset(recoveryCode), reset(recoveryCode)]);
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect([400, 409, 429]).toContain(responses.find(r => r.status !== 200)!.status);
    const { recoveryCode: next } = await responses.find(r => r.status === 200)!.json() as { recoveryCode: string };
    expect(next).not.toBe(recoveryCode);
    expect((await reset(recoveryCode)).status).toBe(400);
    expect(await authenticate(request('me', undefined, { Cookie: cookie }), bindings)).toBeNull();
    expect(await authenticate(request('me', undefined, { Authorization: `Bearer ${device}` }), bindings)).toBeNull();
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(401);
    expect((await call('login', { email: 'person@example.com', password: 'new-owner-password' })).status).toBe(200);
    expect((await reset(next)).status).toBe(200);
    expect((await db.prepare('SELECT verified_at FROM users WHERE id=?').bind(id).first())?.verified_at).toBeNull();
  });
  it('wrong recovery credentials cannot reset an account and attempts are rate limited', async () => {
    await seed('person@example.com', false);
    for (let i = 0; i < 5; i++) expect((await call('reset-password', { email: 'person@example.com', recoveryCode: randomToken(), password, turnstileToken: 'captcha' })).status).toBe(400);
    expect((await call('reset-password', { email: 'person@example.com', recoveryCode: randomToken(), password, turnstileToken: 'captcha' })).status).toBe(429);
    expect(await login()).toContain('__Host-shotsync=');
  });
  it('cleanup retains active unverified accounts and removes expired sessions', async () => {
    const id = await seed('person@example.com', false);
    await db.prepare('UPDATE users SET created_at=? WHERE id=?').bind(Date.now() - 30 * 86400000, id).run();
    await db.prepare('INSERT INTO sessions(hash,user_id,expires_at,auth_version) VALUES(?,?,?,0)').bind(randomToken(), id, Date.now() - 1).run();
    await cleanupAccounts(db);
    expect(await db.prepare('SELECT id FROM users WHERE id=?').bind(id).first()).not.toBeNull();
    expect(await db.prepare('SELECT hash FROM sessions').first()).toBeNull();
  });
  it('bounds daily registration attempts before expensive password work', async () => {
    const window = Math.floor(Date.now() / 86400000);
    await db.prepare('INSERT INTO rate_limits(key,window,n,expires_at) VALUES(?,?,?,?)').bind('account:registrations', window, 200, (window + 1) * 86400000).run();
    expect((await call('register', { email: 'new@example.com', password, turnstileToken: 'captcha' })).status).toBe(429);
    expect(await db.prepare('SELECT id FROM users').first()).toBeNull();
    expect(await db.prepare('SELECT n FROM rate_limits WHERE key=?').bind('account:password-global').first()).toBeNull();
  });
  it('secures sessions and invalidates them on logout', async () => {
    await seed('person@example.com', false);
    const response = await call('login', { email: 'person@example.com', password });
    expect(response.headers.get('Set-Cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
    expect((await call('logout', {}, { Cookie: cookie })).status).toBe(200);
    expect(await authenticate(request('me', undefined, { Cookie: cookie }), bindings)).toBeNull();
  });
  it('requires a fresh captcha for recovery and rate limits password guessing', async () => {
    const id = await seed('person@example.com', false), recoveryCode = randomToken();
    await db.prepare('UPDATE users SET recovery_hash=? WHERE id=?').bind(await tokenHash(recoveryCode), id).run();
    expect((await call('reset-password', { email: 'person@example.com', recoveryCode, password })).status).toBe(403);
    for (let i = 0; i < 10; i++) expect((await call('login', { email: 'person@example.com', password: 'x' })).status).toBe(401);
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(429);
    expect((await db.prepare('SELECT recovery_hash FROM users WHERE id=?').bind(id).first())?.recovery_hash).toBe(await tokenHash(recoveryCode));
  });
  it('removes email verification and emailed password reset endpoints', async () => {
    for (const route of ['verify', 'resend-verification', 'forgot-password']) expect((await call(route, {})).status).toBe(404);
  });
});
