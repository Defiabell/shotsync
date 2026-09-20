import { webcrypto, randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
const temp = mkdtempSync(join(tmpdir(), 'shotsync-browser-'));
const origin = 'https://localhost:8788';
const providerOrigin = 'https://abcdefghijklmnopqrst.supabase.co';
const secret = 'sb_secret_browserfixture123456789';
const publishable = 'sb_publishable_browserfixture123456789';
const password = 'browser-fixture-password';
const fixtureId = '11111111-2222-4333-8444-555555555555';
const providerUsers = new Map([[fixtureId, { id: fixtureId, email: 'browser@example.com', password,
 app_metadata: { shotsync_origin: origin, shotsync_user_id: fixtureId, shotsync_auth_version: 0 } }]]);
const providerCalls = [];
let refreshFailure=0;
const keyPair = await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk = {...await webcrypto.subtle.exportKey('jwk',keyPair.publicKey),kid:'browser-fixture',alg:'RS256',use:'sig'};
const refreshTokens = new Map();
const providerSessions = new Map();
const publicUser = user => ({ id: user.id, email: user.email, app_metadata: user.app_metadata });
async function session(user, sessionId=randomUUID()) {
 const now=Math.floor(Date.now()/1000);
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const unsigned=encode({alg:'RS256',kid:jwk.kid,typ:'JWT'})+'.'+encode({iss:providerOrigin+'/auth/v1',sub:user.id,aud:'authenticated',role:'authenticated',email:user.email,app_metadata:user.app_metadata,iat:now,exp:now+3600,session_id:sessionId});
 const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keyPair.privateKey,Buffer.from(unsigned));
 const refresh=randomUUID();refreshTokens.set(refresh,{user,sessionId});providerSessions.set(sessionId,user);
 return {user:publicUser(user),access_token:unsigned+'.'+Buffer.from(signature).toString('base64url'),refresh_token:refresh,expires_at:now+3600,expires_in:3600,token_type:'bearer'};
}
const json = (value, status = 200) => MiniflareResponse.json(value, { status });
// Fake only the external services. Requests still traverse the bundled Worker,
// its real D1/R2 bindings, session cookies, identity validation and recovery flow.
async function outbound(request) {
 const url = new URL(request.url);
 if (url.origin === 'https://challenges.cloudflare.com' && url.pathname === '/turnstile/v0/siteverify') {
  const body = await request.formData();
  return json({ success: body.get('secret') === 'fixture-turnstile-secret' && body.get('response') === 'fixture-challenge', hostname: 'localhost' });
 }
 if (url.origin !== providerOrigin) throw new Error('Unexpected browser fixture outbound origin');
 if(url.pathname==='/auth/v1/.well-known/jwks.json')return json({keys:[jwk]});
 expect(request.headers.get('apikey')).toBe(url.pathname.startsWith('/auth/v1/admin/')?secret:publishable);
 if(url.pathname==='/auth/v1/logout') {
  const jwt=request.headers.get('Authorization')?.replace('Bearer ','');
  const claims=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString());
  providerSessions.delete(claims.session_id);
  for(const [token,value] of refreshTokens)if(value.sessionId===claims.session_id)refreshTokens.delete(token);
  return new MiniflareResponse(null,{status:204});
 }
 expect(request.headers.has('Authorization')).toBe(false);
 providerCalls.push(`${request.method} ${url.pathname}`);
 const body = request.method === 'GET' ? null : await request.json();
 if (url.pathname === '/auth/v1/token' && request.method === 'POST') {
  if(url.searchParams.get('grant_type')==='refresh_token') {
   if(refreshFailure)return json({error:'fixture temporary provider failure'},refreshFailure);
   const current=refreshTokens.get(body.refresh_token);refreshTokens.delete(body.refresh_token);
   return current&&providerSessions.has(current.sessionId)?json(await session(current.user,current.sessionId)):json({error_code:'refresh_token_not_found'},400);
  }
  const user = [...providerUsers.values()].find(user => user.email === body.email && user.password === body.password);
  return user ? json(await session(user)) : json({ error_code: 'invalid_credentials' }, 400);
 }
 if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
  expect(body.email_confirm).toBe(true);
  if ([...providerUsers.values()].some(user => user.email === body.email)) return json({ error_code: 'email_exists' }, 422);
  providerUsers.set(body.id, body);
  return json(publicUser(body));
 }
 const id = url.pathname.match(/^\/auth\/v1\/admin\/users\/([a-f0-9-]+)$/)?.[1];
 const user = providerUsers.get(id);
 if (!user) return json({ error_code: 'user_not_found' }, 404);
 if (request.method === 'PUT') {
  user.password = body.password;
  if (body.app_metadata) user.app_metadata = { ...user.app_metadata, ...body.app_metadata };
 }
 return json(publicUser(user));
}
let server, browser;
try {
 execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--config', 'wrangler.hosted.jsonc', '--outdir', join(temp, 'build')], { stdio: 'pipe' });
 server = new Miniflare({
  modules: true, modulesRoot: join(temp, 'build'), scriptPath: join(temp, 'build', 'index.js'), compatibilityDate: '2026-08-22', compatibilityFlags: ['nodejs_compat'],
  host: '127.0.0.1', port: 8788, https: true, cf: false,
  d1Databases: ['DB'], r2Buckets: ['BUCKET'],
  bindings: { PUBLIC_ORIGIN: origin, SUPABASE_URL: providerOrigin, SUPABASE_SECRET_KEY: secret, SUPABASE_PUBLISHABLE_KEY: publishable,
   TURNSTILE_SITE_KEY: 'fixture-site-key', TURNSTILE_SECRET_KEY: 'fixture-turnstile-secret', REGISTRATION_LIMIT: '100', UPLOADS_ENABLED: '1' },
  outboundService: outbound,
 });
 await server.ready;
 const db = await server.getD1Database('DB');
 for (const migration of await readD1Migrations('migrations')) await db.batch(migration.queries.map(query => db.prepare(query)));
 await db.prepare("INSERT INTO users(id,email,password_hash,verified_at,created_at,auth_provider_id,auth_state) VALUES(?,?,'external:supabase',NULL,1,?,'active')")
  .bind(fixtureId, 'browser@example.com', fixtureId).run();
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
 const page=await context.newPage();
 let lastAccessToken='';
 page.on('response',async response=>{if(['/api/account/login','/api/account/refresh'].includes(new URL(response.url()).pathname)&&response.ok()){const data=await response.json();lastAccessToken=data.accessToken||lastAccessToken;}});
 // Deterministic challenge UI only; the Worker still calls and checks siteverify.
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => route.fulfill({
  contentType: 'application/javascript', body: "window.turnstile={render:(selector,options)=>{window.fixtureCaptcha=options;options.callback('fixture-challenge');return 'fixture-widget';},reset:()=>window.fixtureCaptcha.callback('fixture-challenge')};",
 }));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);
 await page.locator('#email').fill('browser@example.com');await page.locator('#password').fill(password);await page.locator('#auth-submit').click();
 await expect(page.locator('#app')).toBeVisible();
 const firstAccessToken=lastAccessToken;expect(firstAccessToken.split('.')).toHaveLength(3);
 await page.reload();await expect(page.locator('#app')).toBeVisible();
 expect(providerCalls.filter(call=>call==='POST /auth/v1/token').length).toBeGreaterThanOrEqual(2);
 const beforeConcurrent=providerCalls.filter(call=>call==='POST /auth/v1/token').length;
 await page.evaluate(async()=>{accessToken='invalid-fixture-access-token';await Promise.all([api('/api/list'),api('/api/account/devices')]);});
 expect(providerCalls.filter(call=>call==='POST /auth/v1/token').length).toBe(beforeConcurrent+1);
 await page.locator('#text').fill('跨设备取回测试');await page.locator('#text-form button').click();
 await expect(page.locator('.tile')).toHaveCount(1);
 await page.getByRole('button',{name:'预览',exact:true}).click();await expect(page.locator('.textpreview')).toHaveText('跨设备取回测试');
 await page.locator('#device-name').fill('测试设备');await page.locator('#device-form button').click();await expect(page.locator('#new-token')).toBeVisible();
 const token=await page.locator('#token-value').textContent();
 const deviceList=await context.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+token}});expect(deviceList.status()).toBe(200);
 const item=(await deviceList.json()).items[0];
 const privateContext=await browser.newContext({ignoreHTTPSErrors:true});
 expect((await privateContext.request.get(origin+'/i/'+item.id)).status()).toBe(401);
 await page.getByRole('button',{name:'分享',exact:true}).click();
 const share=await page.getByLabel('分享链接').inputValue();expect(await (await privateContext.request.get(share)).text()).toBe('跨设备取回测试');
 await page.getByRole('button',{name:'撤销分享',exact:true}).click();await expect(page.getByText('分享已撤销。')).toBeVisible();expect((await privateContext.request.get(share)).status()).toBe(410);
 await page.locator('#devices button').click();await expect(page.locator('#devices .device')).toHaveCount(0);expect((await privateContext.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+token}})).status()).toBe(401);
 await page.screenshot({path:join(temp,'mobile.png'),fullPage:true});
 page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除',exact:true}).click();await expect(page.locator('.tile')).toHaveCount(0);
 refreshFailure=429;
 await page.evaluate(()=>{expiresAt=Date.now()-1;});
 await page.locator('#refresh').click();
 await expect(page.locator('#refresh')).toBeEnabled();
 await expect(page.locator('#status')).toContainText('登录服务暂时不可用');
 await expect(page.locator('#app')).toBeVisible();
 expect(await page.evaluate(()=>accessToken.length>0)).toBe(true);
 refreshFailure=503;
 await page.locator('#refresh').click();
 await expect(page.locator('#refresh')).toBeEnabled();
 await expect(page.locator('#status')).toContainText('登录服务暂时不可用');
 await expect(page.locator('#app')).toBeVisible();
 expect(await page.evaluate(()=>accessToken.length>0)).toBe(true);
 const beforeLogout=providerCalls.filter(call=>call==='POST /auth/v1/token').length;
 await page.locator('#logout').click();await expect(page.locator('#auth')).toBeVisible();
 expect(providerCalls.filter(call=>call==='POST /auth/v1/token').length).toBe(beforeLogout);
 expect((await context.cookies()).some(cookie=>cookie.name==='__Host-shotsync-refresh')).toBe(false);
 refreshFailure=0;expect(await page.locator('#token-value').textContent()).toBe('');
 expect((await context.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+firstAccessToken}})).status()).toBe(401);
 await page.reload();await expect(page.locator('#auth')).toBeVisible();await expect(page.locator('#app')).toBeHidden();
 await page.locator('#tab-register').click();await page.locator('#email').fill('new@example.com');await page.locator('#password').fill(password);await page.locator('#auth-submit').click();
 await expect(page.locator('#recovery-result')).toBeVisible();
 const recovery=await page.locator('#recovery-value').textContent();expect(recovery).toMatch(/^[a-f0-9]{64}$/);
 await expect(page.locator('#recovery-value')).toHaveText(recovery);await expect(page.locator('#finish-recovery')).toBeDisabled();
 expect(await page.locator('#password').inputValue()).toBe('');
 await page.locator('#recovery-saved').check();await page.locator('#finish-recovery').click();await expect(page.locator('#recovery-value')).toHaveText('');
 await page.locator('#password').fill(password);await page.locator('#auth-submit').click();await expect(page.locator('#app')).toBeVisible();
 const preRecoveryJWT=lastAccessToken;
 const recoveryDeviceResponse=await context.request.post(origin+'/api/account/devices',{headers:{Authorization:'Bearer '+preRecoveryJWT,Origin:origin},data:{name:'recovery fixture'}});
 expect(recoveryDeviceResponse.status()).toBe(201);
 const recoveryDevice=(await recoveryDeviceResponse.json()).token;
 // Reset in a separate unauthenticated browser page, leaving the old session active.
 const resetPage=await context.newPage();await resetPage.goto(origin);await expect(resetPage.locator('#app')).toBeVisible();
 await context.clearCookies();await page.reload();await expect(page.locator('#auth')).toBeVisible();
 await page.locator('#email').fill('new@example.com');
 await page.locator('#forgot').click();await page.locator('#recovery-code').fill(recovery);await page.locator('#password').fill('replacement-password');await page.locator('#auth-submit').click();
 await expect(page.locator('#recovery-result')).toBeVisible();
 expect((await context.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+preRecoveryJWT}})).status()).toBe(401);
 expect((await context.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+recoveryDevice}})).status()).toBe(401);
 await resetPage.close();
 const replacement=await page.locator('#recovery-value').textContent();expect(replacement).toMatch(/^[a-f0-9]{64}$/);expect(replacement).not.toBe(recovery);
 await expect(page.locator('#recovery-value')).toHaveText(replacement);await expect(page.locator('#finish-recovery')).toBeDisabled();
 expect(await page.locator('#recovery-code').inputValue()).toBe('');
 await page.locator('#recovery-saved').check();await page.locator('#finish-recovery').click();await expect(page.locator('#recovery-value')).toHaveText('');
 await page.locator('#password').fill('replacement-password');await page.locator('#auth-submit').click();
 await expect(page.locator('#app')).toBeVisible();
 expect(providerCalls).toContain('POST /auth/v1/admin/users');
 expect(providerCalls.some(call=>call.startsWith('PUT /auth/v1/admin/users/'))).toBe(true);
 const registered=await db.prepare('SELECT password_hash,auth_state,verified_at FROM users WHERE email=?').bind('new@example.com').first();
 expect(registered).toMatchObject({password_hash:'external:supabase',auth_state:'active',verified_at:null});
 expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);expect(errors).toEqual([]);
 console.log('PASS: real browser signed-JWT login, reload/rotating refresh, concurrent 401 singleflight, upload/private preview, device isolation, share/revoke, delete, logout revocation; registration/recovery rotates codes and invalidates old JWT/device, with fake provider/Turnstile only at outbound boundaries');
 await privateContext.close();await context.close();
} finally {
 if(browser)await browser.close();if(server)await server.dispose();
 rmSync(temp,{recursive:true,force:true});
}
