import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/hosted/http';
import { authenticate, createPendingUser, cleanupAccounts, handleAccounts } from '../src/hosted/accounts';
import { hashPassword, randomToken, tokenHash, verifyPassword, withPasswordWork } from '../src/hosted/account-crypto';
import type { HostedEnv } from '../src/hosted/types';
// @ts-expect-error Vite imports migration text for the real local D1 database.
import schema from '../migrations/0001_accounts.sql?raw';
const db = (env as unknown as { DB: D1Database }).DB;
const origin = 'https://shotsync.test';
const password = 'a-long-password!';
let sent: Array<{ text: string; to: string }>;
let bindings: HostedEnv;
let passwordHash: string;
function request(route: string, body?: unknown, headers: Record<string, string> = {}, method?: string) {
  return new Request(`${origin}/api/account/${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function call(route: string, body?: unknown, headers?: Record<string, string>, method?: string) {
  try { return (await handleAccounts(request(route, body, headers, method), bindings))!; }
  catch (error) { if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
}
async function seed(email = 'person@example.com', verified = true) {
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users(id,email,password_hash,verified_at,created_at) VALUES(?,?,?,?,?)').bind(id, email, passwordHash, verified ? Date.now() : null, Date.now()).run();
  return id;
}
async function login(email = 'person@example.com') {
  const response = await call('login', { email, password });
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
async function issue(id: string, kind = 'verify', expires = Date.now() + 60000) {
  const token = randomToken();
  await db.prepare('INSERT INTO account_tokens(hash,user_id,kind,expires_at,auth_version) VALUES(?,?,?,?,0)').bind(await tokenHash(token), id, kind, expires).run();
  return token;
}
beforeEach(async () => {
  for (const statement of (schema as string).split(';').filter(s => s.trim())) await db.prepare(statement).run();
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ success: true, hostname: 'shotsync.test' }));
  bindings = { ...env, DB: db, EMAIL_FROM: 'noreply@shotsync.test', PUBLIC_ORIGIN: origin, TURNSTILE_SECRET_KEY: 'test-secret', REGISTRATION_LIMIT: '100', EMAIL: { send: async (mail: { text: string; to: string }) => { sent.push(mail); return { messageId: 'mock' }; } } } as unknown as HostedEnv;
  passwordHash = await hashPassword(password);
});
afterEach(() => vi.restoreAllMocks());
describe('hosted accounts with real D1', () => {
  it('uses a salted modern scrypt hash in the Worker runtime', async () => {
    expect(passwordHash).toMatch(/^scrypt:16384:8:5:/);
    expect(await verifyPassword(password, passwordHash)).toBe(true);
    expect(await verifyPassword('wrong-password', passwordHash)).toBe(false);
    expect(await hashPassword(password)).not.toBe(passwordHash);
  });
  it('rejects cross-origin and form mutations', async () => {
    expect((await call('login', {}, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('login', {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
  });
  it('registers pending accounts and sends only hashed expiring tokens to D1', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ success: true, hostname: 'shotsync.test' }));
    const response = await call('register', { email: 'New@Example.com', password, turnstileToken: 'captcha' });
    expect(response.status).toBe(200);
    const user = await db.prepare('SELECT * FROM users WHERE email=?').bind('new@example.com').first();
    expect(user?.verified_at).toBeNull();
    expect(sent).toHaveLength(1);
    const token = sent[0].text.match(/#verify=([a-f0-9]+)/)![1];
    expect(await db.prepare('SELECT hash FROM account_tokens WHERE hash=?').bind(token).first()).toBeNull();
    expect(await db.prepare('SELECT hash FROM account_tokens WHERE hash=?').bind(await tokenHash(token)).first()).not.toBeNull();
    mock.mockRestore();
  });
  it('fails closed on wrong captcha hostname and missing mail config', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, hostname: 'attacker.test' }));
    expect((await call('register', { email: 'person@example.com', password, turnstileToken: 'captcha' })).status).toBe(403);
    bindings.EMAIL_FROM = '';
    expect((await call('register', { email: 'person@example.com', password, turnstileToken: 'captcha' })).status).toBe(503);
    expect(sent).toHaveLength(0);
    mock.mockRestore();
  });
  it('atomically assigns final trial seat and does not reserve seats for pending users', async () => {
    bindings.REGISTRATION_LIMIT = '1';
    const a = await seed('a@example.com', false), b = await seed('b@example.com', false);
    const ta = await issue(a), tb = await issue(b);
    const responses = await Promise.all([call('verify', { token: ta, password }), call('verify', { token: tb, password })]);
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect([409, 429]).toContain(responses.find(r => r.status !== 200)!.status);
    const loser = responses[0].status !== 200 ? ta : tb;
    expect((await call('verify', { token: loser, password })).status).toBe(409);
    expect((await db.prepare('SELECT COUNT(*) n FROM users WHERE verified_at IS NOT NULL').first<{ n: number }>())!.n).toBe(1);
    expect((await call('verify', { token: ta, password })).status).not.toBe(200);
  });
  it('verification chooses a fresh password and invalidates pre-verification sessions', async () => {
    const id = await seed('person@example.com', false);
    const oldCookie = await login();
    const token = await issue(id);
    expect((await call('verify', { token, password: 'new-owner-password' })).status).toBe(200);
    expect(await authenticate(request('me', undefined, { Cookie: oldCookie }), bindings)).toBeNull();
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(401);
    expect((await call('login', { email: 'person@example.com', password: 'new-owner-password' })).status).toBe(200);
  });
  it('sessions are secure; unverified accounts cannot create device tokens', async () => {
    await seed('person@example.com', false);
    const response = await call('login', { email: 'person@example.com', password });
    expect(response.headers.get('Set-Cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
    expect((await call('devices', { name: 'Mac' }, { Cookie: cookie })).status).toBe(403);
    expect((await call('logout', {}, { Cookie: cookie })).status).toBe(200);
    expect(await authenticate(request('me', undefined, { Cookie: cookie }), bindings)).toBeNull();
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
  it('reset is one-time and revokes every session and device', async () => {
    const id = await seed();
    const cookie = await login();
    const response = await call('devices', { name: 'Mac' }, { Cookie: cookie });
    const { token: device } = await response.json() as { token: string };
    const token = await issue(id, 'reset');
    const [a, b] = await Promise.all([call('reset-password', { token, password: 'new-password-one' }), call('reset-password', { token, password: 'new-password-two' })]);
    expect([a, b].filter(r => r.status === 200)).toHaveLength(1);
    expect([400, 409, 429]).toContain([a, b].find(r => r.status !== 200)!.status);
    expect((await call('reset-password', { token, password: 'new-password-three' })).status).toBe(400);
    expect(await authenticate(request('me', undefined, { Cookie: cookie }), bindings)).toBeNull();
    expect(await authenticate(request('me', undefined, { Authorization: `Bearer ${device}` }), bindings)).toBeNull();
  });
  it('expired reset tokens cannot change passwords', async () => {
    const id = await seed();
    const token = await issue(id, 'reset', Date.now() - 1);
    expect((await call('reset-password', { token, password: 'new-owner-password' })).status).toBe(400);
    expect(await login()).toContain('__Host-shotsync=');
  });
  it('email sends and login attempts are rate limited', async () => {
    await seed();
    for (let i = 0; i < 3; i++) expect((await call('forgot-password', { email: 'person@example.com', turnstileToken: 'captcha' })).status).toBe(200);
    expect((await call('forgot-password', { email: 'person@example.com', turnstileToken: 'captcha' })).status).toBe(429);
    expect(sent).toHaveLength(3);
    for (let i = 0; i < 10; i++) expect((await call('login', { email: 'person@example.com', password: 'x' })).status).toBe(401);
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(429);
  });
  it('cleanup removes expired pending registrations but preserves verified accounts', async () => {
    const a = await seed('old@example.com', false), b = await seed('verified@example.com');
    await db.prepare('UPDATE users SET created_at=? WHERE id IN (?,?)').bind(Date.now() - 8 * 86400000, a, b).run();
    await cleanupAccounts(db);
    expect(await db.prepare('SELECT id FROM users WHERE id=?').bind(a).first()).toBeNull();
    expect(await db.prepare('SELECT id FROM users WHERE id=?').bind(b).first()).not.toBeNull();
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
  it('mail failures invalidate the unsent credential without leaking provider details', async () => {
    await seed();
    bindings.EMAIL = { send: async () => { throw new Error('provider secret'); } } as unknown as SendEmail;
    const response = await call('forgot-password', { email: 'person@example.com', turnstileToken: 'captcha' });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('provider secret');
    expect((await db.prepare('SELECT COUNT(*) n FROM account_tokens').first<{ n: number }>())!.n).toBe(0);
  });

  it('caps concurrent password work atomically and releases every lease', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = async () => { started(); await held; return 'ok'; };
    const a = withPasswordWork(db, work);
    await ready;
    await expect(withPasswordWork(db, async () => 'blocked')).rejects.toMatchObject({ status: 429 });
    release();
    expect(await a).toBe('ok');
    expect((await db.prepare('SELECT COUNT(*) n FROM password_leases').first<{ n: number }>())!.n).toBe(0);
    await expect(withPasswordWork(db, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect((await db.prepare('SELECT COUNT(*) n FROM password_leases').first<{ n: number }>())!.n).toBe(0);
  });
  it('reclaims abandoned expired password leases', async () => {
    await db.prepare('INSERT INTO password_leases(id,expires_at) VALUES(?,?)').bind('expired', Date.now() - 1).run();
    expect(await withPasswordWork(db, async () => 'recovered')).toBe('recovered');
    expect((await db.prepare('SELECT COUNT(*) n FROM password_leases').first<{ n: number }>())!.n).toBe(0);
  });

  it('exhausted global mail allowance blocks new records before password work', async () => {
    const window = Math.floor(Date.now() / 86400000);
    await db.prepare('INSERT INTO rate_limits(key,window,n,expires_at) VALUES(?,?,?,?)').bind('account:mail-global', window, 200, (window + 1) * 86400000).run();
    const response = await call('register', { email: 'new@example.com', password, turnstileToken: 'captcha' });
    expect(response.status).toBe(429);
    expect(await db.prepare('SELECT id FROM users').first()).toBeNull();
    expect(await db.prepare('SELECT n FROM rate_limits WHERE key=?').bind('account:password-global').first()).toBeNull();
    expect(sent).toHaveLength(0);
  });
  it('new pending registrations have a separate daily bound before hashing', async () => {
    const window = Math.floor(Date.now() / 86400000);
    await db.prepare('INSERT INTO rate_limits(key,window,n,expires_at) VALUES(?,?,?,?)').bind('account:pending-registrations', window, 200, (window + 1) * 86400000).run();
    expect((await call('register', { email: 'new@example.com', password, turnstileToken: 'captcha' })).status).toBe(429);
    expect(await db.prepare('SELECT id FROM users').first()).toBeNull();
    expect(await db.prepare('SELECT n FROM rate_limits WHERE key=?').bind('account:password-global').first()).toBeNull();
    // Existing pending users can still request another verification email.
    await seed('pending@example.com', false);
    expect((await call('resend-verification', { email: 'pending@example.com', turnstileToken: 'captcha' })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });
  it('atomically bounds the last pending slot separately from verified capacity', async () => {
    const statements = Array.from({ length: 199 }, (_, i) => db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').bind('pending-' + i, 'pending' + i + '@example.com', passwordHash, Date.now()));
    await db.batch(statements);
    await seed('verified@example.com', true);
    await Promise.all([
      createPendingUser(db, 'candidate-a', 'a@example.com', passwordHash, 100),
      createPendingUser(db, 'candidate-b', 'b@example.com', passwordHash, 100),
    ]);
    expect((await db.prepare('SELECT COUNT(*) n FROM users WHERE verified_at IS NULL').first<{ n: number }>())!.n).toBe(200);
    expect((await db.prepare('SELECT COUNT(*) n FROM users WHERE verified_at IS NOT NULL').first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) n FROM users WHERE id IN ('candidate-a','candidate-b')").first<{ n: number }>())!.n).toBe(1);
  });
  it('new registration reserves exactly one global email allowance', async () => {
    expect((await call('register', { email: 'new@example.com', password, turnstileToken: 'captcha' })).status).toBe(200);
    expect((await db.prepare('SELECT n FROM rate_limits WHERE key=?').bind('account:mail-global').first<{ n: number }>())!.n).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('cleanup preserves an old pending account while its emailed link remains valid', async () => {
    const id = await seed('pending@example.com', false);
    await db.prepare('UPDATE users SET created_at=? WHERE id=?').bind(Date.now() - 8 * 86400000, id).run();
    const token = await issue(id);
    await cleanupAccounts(db);
    expect(await db.prepare('SELECT id FROM users WHERE id=?').bind(id).first()).not.toBeNull();
    expect((await call('verify', { token, password })).status).toBe(200);
  });

});
