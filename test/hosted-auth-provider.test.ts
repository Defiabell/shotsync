import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredProvider, createPasswordUser, verifyProviderPassword, updateProviderPassword } from '../src/hosted/auth-provider';

const env = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_syntheticfixture123456789', PUBLIC_ORIGIN: 'https://shotsync.test' };
const id = '11111111-2222-4333-8444-555555555555', email = 'person@example.com', password = 'a-long-password';
const user = () => ({ id, email, app_metadata: { shotsync_origin: env.PUBLIC_ORIGIN, shotsync_user_id: id } });
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(user())); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('hosted password provider', () => {
  it('accepts canonical Supabase origins and privileged keys only', () => {
    expect(configuredProvider(env)).toBe(true);
    for (const SUPABASE_URL of ['', 'http://abcdefghijklmnopqrst.supabase.co', `${env.SUPABASE_URL}/`, `${env.SUPABASE_URL}/foo`, `${env.SUPABASE_URL}?x=1`, 'https://localhost', 'https://abcdefghijklmnopqrst.supabase.co.evil.test', 'https://key@abcdefghijklmnopqrst.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co:443']) {
      expect(configuredProvider({ ...env, SUPABASE_URL })).toBe(false);
    }
    for (const SUPABASE_SECRET_KEY of ['', 'sb_publishable_fixture', 'secret', 'eyJ.invalid.key']) expect(configuredProvider({ ...env, SUPABASE_SECRET_KEY })).toBe(false);
  });
  it('creates the exact identity without email delivery and never uses modern keys as Bearer', async () => {
    await createPasswordUser(env, id, email, password);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${env.SUPABASE_URL}/auth/v1/admin/users`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { apikey: env.SUPABASE_SECRET_KEY } });
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(init!.body as string)).toEqual({ id, email, password, email_confirm: true, app_metadata: user().app_metadata });
  });
  it('sends legacy service_role JWT as both apikey and Bearer', async () => {
    const key = `${btoa('{}').replace(/=/g, '')}.${btoa(JSON.stringify({ role: 'service_role' })).replace(/=/g, '')}.signature`;
    await createPasswordUser({ ...env, SUPABASE_SECRET_KEY: key }, id, email, password);
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${key}`);
    expect(configuredProvider({ ...env, SUPABASE_SECRET_KEY: `${btoa('{}').replace(/=/g, '')}.${btoa(JSON.stringify({ role: 'anon' })).replace(/=/g, '')}.signature` })).toBe(false);
  });
  it('accepts password verification only with exact provider identity and namespace', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ user: user(), access_token: 'never-returned' }));
    expect(await verifyProviderPassword(env, id, email, password)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`);
    for (const invalid of [{ ...user(), id: crypto.randomUUID() }, { ...user(), email: 'other@example.com' }, { ...user(), app_metadata: { ...user().app_metadata, shotsync_origin: 'https://other.test' } }, { ...user(), app_metadata: { ...user().app_metadata, shotsync_user_id: crypto.randomUUID() } }, { ...user(), app_metadata: null }, null]) {
      vi.mocked(fetch).mockResolvedValue(Response.json({ user: invalid }));
      await expect(verifyProviderPassword(env, id, email, password)).rejects.toMatchObject({ status: 503 });
    }
  });
  it('does provider password work for unknown local users without linking by email', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ user: user() }));
    expect(await verifyProviderPassword(env, '', email, password)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    vi.mocked(fetch).mockResolvedValue(Response.json({}));
    await expect(verifyProviderPassword(env, '', email, password)).rejects.toMatchObject({ status: 503 });
  });
  it('returns false only for explicit invalid credentials and hides provider errors', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error_code: 'invalid_credentials' }, { status: 400 }));
    expect(await verifyProviderPassword(env, id, email, password)).toBe(false);
    for (const status of [400, 401, 403, 422, 500, 503]) {
      vi.mocked(fetch).mockResolvedValue(Response.json({ msg: 'private upstream details' }, { status }));
      await expect(verifyProviderPassword(env, id, email, password)).rejects.toMatchObject({ status: 503, message: 'Password authentication is temporarily unavailable' });
    }
    vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 429 }));
    await expect(verifyProviderPassword(env, id, email, password)).rejects.toMatchObject({ status: 429 });
  });
  it('distinguishes definitive create rejection from ambiguous mutation results', async () => {
    for (const status of [400, 401, 403, 422, 429]) {
      vi.mocked(fetch).mockResolvedValue(Response.json({}, { status }));
      await expect(createPasswordUser(env, id, email, password)).rejects.toMatchObject({ definitive: true, status: status === 429 ? 429 : 503 });
    }
    for (const response of [Response.json({}, { status: 500 }), Response.json({ ...user(), id: crypto.randomUUID() }), new Response('not-json'), Response.json({})]) {
      vi.mocked(fetch).mockResolvedValue(response);
      await expect(createPasswordUser(env, id, email, password)).rejects.toMatchObject({ definitive: false, status: 503 });
    }
    vi.mocked(fetch).mockRejectedValue(new Error('secret network details'));
    await expect(createPasswordUser(env, id, email, password)).rejects.toMatchObject({ definitive: false, message: 'Password authentication is temporarily unavailable' });
  });
  it('checks identity before password update and sends no metadata or email mutation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(user())).mockResolvedValueOnce(Response.json(user()));
    await updateProviderPassword(env, id, email, password);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
    const [url, init] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init!.body as string)).toEqual({ password });
    vi.mocked(fetch).mockClear().mockResolvedValue(Response.json({ ...user(), email: 'other@example.com' }));
    await expect(updateProviderPassword(env, id, email, password)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects mutation response identity mismatch and oversized responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(user())).mockResolvedValueOnce(Response.json({ ...user(), app_metadata: {} }));
    await expect(updateProviderPassword(env, id, email, password)).rejects.toMatchObject({ status: 503 });
    vi.mocked(fetch).mockResolvedValue(new Response('x'.repeat(65537)));
    await expect(verifyProviderPassword(env, id, email, password)).rejects.toMatchObject({ status: 503 });
  });
  it('times out after ten seconds without retries and classifies creation as ambiguous', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const result = expect(createPasswordUser(env, id, email, password)).rejects.toMatchObject({ definitive: false, status: 503 });
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('fails invalid configuration and IDs before sending credentials', async () => {
    await expect(createPasswordUser({ ...env, SUPABASE_URL: 'http://evil.test' }, id, email, password)).rejects.toMatchObject({ definitive: false, status: 503 });
    await expect(verifyProviderPassword(env, '../other', email, password)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
