import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyAccessToken, refreshProviderSession, revokeProviderSession, configuredProvider, createPasswordUser, verifyProviderPassword, updateProviderPassword } from '../src/hosted/auth-provider';

const env = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_syntheticfixture123456789', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_syntheticfixture123456789', PUBLIC_ORIGIN: 'https://shotsync.test' };
const id = '11111111-2222-4333-8444-555555555555', email = 'person@example.com', password = 'a-long-password';
const user = () => ({ id, email, app_metadata: { shotsync_origin: env.PUBLIC_ORIGIN, shotsync_user_id: id, shotsync_auth_version: 0 } });
const keys = await generateKeyPair('ES256');
const jwk = {...await exportJWK(keys.publicKey),kid:'test',alg:'ES256'};
async function jwt(overrides:Record<string,unknown>={}) { return new SignJWT({session_id:'22222222-2222-4333-8444-555555555555',app_metadata:user().app_metadata,...overrides}).setProtectedHeader({alg:'ES256',kid:'test'}).setSubject(id).setAudience('authenticated').setIssuer(`${env.SUPABASE_URL}/auth/v1`).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey); }
async function sessionResponse() { return {user:user(),access_token:await jwt(),refresh_token:'synthetic_refresh_token_123456'}; }
function respond(data:unknown) { vi.mocked(fetch).mockImplementation(async input=>String(input).endsWith('/jwks.json') ? Response.json({keys:[jwk]}) : Response.json(data)); }
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
    const response=await sessionResponse(); respond(response);
    expect(await verifyProviderPassword(env, id, email, password)).toMatchObject({id,email,accessToken:response.access_token});
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('apikey')).toBe(env.SUPABASE_PUBLISHABLE_KEY);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`);
    for (const invalid of [{ ...user(), id: crypto.randomUUID() }, { ...user(), email: 'other@example.com' }, { ...user(), app_metadata: { ...user().app_metadata, shotsync_origin: 'https://other.test' } }, { ...user(), app_metadata: { ...user().app_metadata, shotsync_user_id: crypto.randomUUID() } }, { ...user(), app_metadata: null }, null]) {
      vi.mocked(fetch).mockResolvedValue(Response.json({ user: invalid }));
      await expect(verifyProviderPassword(env, id, email, password)).rejects.toMatchObject({ status: 503 });
    }
  });
  it('does provider password work for unknown local users without linking by email', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ user: user() }));
    expect(await verifyProviderPassword(env, '', email, password)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    vi.mocked(fetch).mockResolvedValue(Response.json({}));
    await expect(verifyProviderPassword(env, '', email, password)).rejects.toMatchObject({ status: 503 });
  });
  it('returns false only for explicit invalid credentials and hides provider errors', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error_code: 'invalid_credentials' }, { status: 400 }));
    expect(await verifyProviderPassword(env, id, email, password)).toBeNull();
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
  it('checks identity before password update and preserves the account binding', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(user())).mockResolvedValueOnce(Response.json(user()));
    await updateProviderPassword(env, id, email, password);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
    const [url, init] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init!.body as string)).toEqual({ password,app_metadata:user().app_metadata });
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
  it('verifies signed issuer/audience/namespace/version/session claims and rejects tampering', async () => {
    respond({});
    expect(await verifyAccessToken(env,await jwt())).toMatchObject({id,authVersion:0});
    for (const metadata of [{...user().app_metadata,shotsync_origin:'https://other.test'},{...user().app_metadata,shotsync_auth_version:undefined},{...user().app_metadata,shotsync_auth_version:-1}]) expect(await verifyAccessToken(env,await jwt({app_metadata:metadata}))).toBeNull();
    expect(await verifyAccessToken(env,await jwt({session_id:'bad'}))).toBeNull();
    const wrong=await new SignJWT({session_id:crypto.randomUUID(),app_metadata:user().app_metadata}).setProtectedHeader({alg:'ES256',kid:'test'}).setSubject(id).setAudience('wrong').setIssuer(`${env.SUPABASE_URL}/auth/v1`).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
    expect(await verifyAccessToken(env,wrong)).toBeNull();
    const signed=await jwt(); expect(await verifyAccessToken(env,signed.slice(0,-5)+'aaaaa')).toBeNull();
  });
  it('allows expired signed JWTs only for revocation and never accepts a forged expired token', async () => {
    respond({});
    const old = await new SignJWT({session_id:crypto.randomUUID(),app_metadata:user().app_metadata}).setProtectedHeader({alg:'ES256',kid:'test'}).setSubject(id).setAudience('authenticated').setIssuer(`${env.SUPABASE_URL}/auth/v1`).setIssuedAt(Math.floor(Date.now()/1000)-7200).setExpirationTime(Math.floor(Date.now()/1000)-3600).sign(keys.privateKey);
    expect(await verifyAccessToken(env,old)).toBeNull();
    expect(await verifyAccessToken(env,old,true)).toMatchObject({id});
    expect(await verifyAccessToken(env,old.slice(0,-5)+'aaaaa',true)).toBeNull();
  });
  it('refreshes provider sessions and signs out using publishable key and access JWT', async () => {
    respond(await sessionResponse());
    expect(await refreshProviderSession(env,'refresh_fixture')).toMatchObject({id,email});
    const first=vi.mocked(fetch).mock.calls[0];
    expect(first[0]).toContain('grant_type=refresh_token');
    expect(new Headers(first[1]?.headers).get('apikey')).toBe(env.SUPABASE_PUBLISHABLE_KEY);
    vi.mocked(fetch).mockResolvedValue(new Response(null,{status:204}));
    await revokeProviderSession(env,'access_fixture');
    const last=vi.mocked(fetch).mock.calls.at(-1)!;
    expect(last[0]).toContain('/logout?scope=local');
    expect(new Headers(last[1]?.headers).get('Authorization')).toBe('Bearer access_fixture');
  });

});
