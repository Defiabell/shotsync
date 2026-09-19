import { env } from 'cloudflare:test';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/hosted/http';
import { authenticate, createUser, cleanupAccounts, handleAccounts } from '../src/hosted/accounts';
import { hashPassword, randomToken, tokenHash, verifyPassword, withPasswordWork } from '../src/hosted/account-crypto';
import type { HostedEnv } from '../src/hosted/types';
// @ts-expect-error Vite imports migration text for the real local D1 database.
import schema from '../migrations/0001_accounts.sql?raw';
// @ts-expect-error Vite imports migration text for the real local D1 database.
import recoverySchema from '../migrations/0003_recovery.sql?raw';
const db = (env as unknown as { DB: D1Database }).DB;
const origin = 'https://shotsync.test';
const password = 'a-long-password!';
const pepper = 'ab'.repeat(32);

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
beforeEach(async () => {
  for (const statement of ((schema as string) + (recoverySchema as string)).split(';').filter(s => s.trim())) await db.prepare(statement).run();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ success: true, hostname: 'shotsync.test' }));
  bindings = { ...env, DB: db, PUBLIC_ORIGIN: origin, TURNSTILE_SECRET_KEY: 'test-secret', PASSWORD_PEPPER: pepper, REGISTRATION_LIMIT: '100' } as unknown as HostedEnv;
  passwordHash = await hashPassword(password, pepper);
});
afterEach(() => vi.restoreAllMocks());
describe('hosted accounts with real D1', () => {
  it('uses a salted and peppered PBKDF2 verifier in the Worker runtime', async () => {
    expect(passwordHash).toMatch(/^pbkdf2-sha256:v1:100000:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(await verifyPassword(password, passwordHash, pepper)).toBe(true);
    expect(await verifyPassword('wrong-password', passwordHash, pepper)).toBe(false);
    expect(await hashPassword(password, pepper)).not.toBe(passwordHash);
  });
  it('matches an independent PBKDF2/HMAC calculation and never stores the bare verifier', async () => {
    const salt = passwordHash.split(':')[3];
    const bare = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256');
    const expected = createHmac('sha256', Buffer.from(pepper, 'hex')).update(bare).digest('hex');
    expect(passwordHash.split(':')[4]).toBe(expected);
    expect(passwordHash).not.toContain(Buffer.from(bare).toString('hex'));
    expect(await verifyPassword(password, passwordHash, 'cd'.repeat(32))).toBe(false);
  });
  it('rejects missing or malformed pepper before creating or authenticating accounts', async () => {
    await seed();
    for (const bad of ['', 'short', 'gg'.repeat(32), 'ab'.repeat(31)]) {
      await expect(hashPassword(password, bad)).rejects.toMatchObject({ status: 503 });
      await expect(verifyPassword(password, passwordHash, bad)).rejects.toMatchObject({ status: 503 });
      bindings.PASSWORD_PEPPER = bad;
      for (const route of ['login', 'register', 'reset-password']) {
        expect((await call(route, { email: 'person@example.com', password, turnstileToken: 'captcha' })).status).toBe(503);
      }
    }
    expect(await db.prepare('SELECT hash FROM sessions').first()).toBeNull();
    expect((await db.prepare('SELECT COUNT(*) n FROM users').first())?.n).toBe(1);
  });
  it('rejects legacy hashes, unsupported versions, changed parameters and malformed values', async () => {
    const salt = passwordHash.split(':')[3], digest = passwordHash.split(':')[4];
    for (const stored of [
      `scrypt:16384:8:5:${salt}:${digest}`,
      passwordHash.replace(':v1:', ':v2:'),
      passwordHash.replace(':100000:', ':1:'),
      passwordHash.replace(salt, salt.slice(2)),
      passwordHash.replace(digest, 'gg'.repeat(32)),
      `${passwordHash}:extra`, '',
    ]) expect(await verifyPassword(password, stored, pepper)).toBe(false);
  });
  it('performs password work for unknown addresses and never issues a session', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    expect((await call('login', { email: 'unknown@example.com', password })).status).toBe(401);
    expect(derive).toHaveBeenCalledOnce();
    expect(derive.mock.calls[0][0]).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100_000 });
    expect(await db.prepare('SELECT hash FROM sessions').first()).toBeNull();
  });
  it('allows recovery from a legacy verifier without accepting the old hash', async () => {
    const id = await seed(), recoveryCode = randomToken();
    await db.prepare('UPDATE users SET password_hash=?,recovery_hash=? WHERE id=?')
      .bind(`scrypt:16384:8:5:${'ab'.repeat(32)}:${'cd'.repeat(32)}`, await tokenHash(recoveryCode), id).run();
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(401);
    expect((await call('reset-password', { email: 'person@example.com', recoveryCode, password, turnstileToken: 'captcha' })).status).toBe(200);
    expect((await call('login', { email: 'person@example.com', password })).status).toBe(200);
    expect((await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(id).first())?.password_hash).toMatch(/^pbkdf2-sha256:v1:100000:/);
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
      createUser(db, 'a', 'a@example.com', passwordHash, await tokenHash(randomToken()), 2),
      createUser(db, 'b', 'b@example.com', passwordHash, await tokenHash(randomToken()), 2),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await db.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())!.n).toBe(2);
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
