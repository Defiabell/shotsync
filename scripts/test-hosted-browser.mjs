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
 await db.prepare('UPDATE users SET retention_days=90 WHERE id=?').bind(fixtureId).run();
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
 const page=await context.newPage();
 let lastAccessToken='';
 page.on('response',async response=>{if(['/api/account/login','/api/account/refresh'].includes(new URL(response.url()).pathname)&&response.ok()){const data=await response.json();lastAccessToken=data.accessToken||lastAccessToken;}});
 // Deterministic challenge UI only; the Worker still calls and checks siteverify.
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => route.fulfill({
  contentType: 'application/javascript', body: "window.turnstile={render:(selector,options)=>{window.fixtureCaptcha=options;options.callback('fixture-challenge');return 'fixture-widget';},reset:()=>window.fixtureCaptcha.callback('fixture-challenge')};",
 }));
 const previewRequests=[];page.on('request',request=>{if(/^\/(?:i|t)\//.test(new URL(request.url()).pathname))previewRequests.push(new URL(request.url()).pathname);});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);
 await page.locator('#email').fill('browser@example.com');await page.locator('#password').fill(password);await page.locator('#auth-submit').click();
 await expect(page.locator('#app')).toBeVisible();
 await expect(page.locator('#settings-dialog')).not.toBeVisible();
 await expect(page.locator('#composer-dialog')).not.toBeVisible();
 await expect(page.locator('#device-form')).not.toBeVisible();
 await page.locator('#open-settings').click();
 await expect(page.locator('#retention')).toContainText('内容保留 90 天');
 await page.locator('#close-settings').click();
 const firstAccessToken=lastAccessToken;expect(firstAccessToken.split('.')).toHaveLength(3);
 await page.reload();await expect(page.locator('#app')).toBeVisible();
 expect(providerCalls.filter(call=>call==='POST /auth/v1/token').length).toBeGreaterThanOrEqual(2);
 const beforeConcurrent=providerCalls.filter(call=>call==='POST /auth/v1/token').length;
 await page.evaluate(async()=>{accessToken='invalid-fixture-access-token';await Promise.all([api('/api/list'),api('/api/account/devices')]);});
 expect(providerCalls.filter(call=>call==='POST /auth/v1/token').length).toBe(beforeConcurrent+1);
 // Composer stays out of the gallery until explicitly opened.
 await page.locator('#add-text').click();await expect(page.locator('#composer-dialog')).toBeVisible();
 await page.locator('#close-composer').click();await expect(page.locator('#composer-dialog')).not.toBeVisible();
 await page.locator('#add-text').click();
 await page.locator('#text').fill('跨设备取回测试');await page.locator('#text-form button').click();
 await expect(page.locator('#composer-dialog')).not.toBeVisible();await expect(page.locator('.tile')).toHaveCount(1);
 await expect(page.locator('.tile')).toContainText('跨设备取回测试');
 await page.locator('.tile-open').click();await expect(page.locator('#viewer-content')).toContainText('跨设备取回测试');
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await page.locator('#viewer-copy').click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('跨设备取回测试');
 const downloadEvent=page.waitForEvent('download');await page.locator('#viewer-download').click();expect((await downloadEvent).suggestedFilename()).toBe('text.txt');
 await page.locator('#close-viewer').click();
 await page.locator('#open-settings').click();
 await page.locator('#device-name').fill('测试设备');await page.locator('#device-form button').click();await expect(page.locator('#new-token')).toBeVisible();
 const token=await page.locator('#token-value').textContent();
 const deviceList=await context.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+token}});expect(deviceList.status()).toBe(200);
 const list=await deviceList.json();expect(list.limits.retentionDays).toBe(90);
 const item=list.items[0];expect(item.expiresAt-Date.now()).toBeGreaterThan(89*86400000);
 await page.locator('#close-settings').click();await page.locator('.tile-open').click();
 await expect(page.locator('#viewer-meta')).toContainText(new Date(item.expiresAt).toLocaleString('zh-CN'));
 await expect(page.locator('#viewer-meta')).toContainText('到期');
 const privateContext=await browser.newContext({ignoreHTTPSErrors:true});
 expect((await privateContext.request.get(origin+'/i/'+item.id)).status()).toBe(401);
 await page.locator('#viewer-share').click();
 await expect(page.locator('#share-link')).toHaveValue(/^https:/);const share=await page.locator('#share-link').inputValue();expect(await (await privateContext.request.get(share)).text()).toBe('跨设备取回测试');
 await page.locator('#viewer-revoke').click();await expect(page.locator('#share-result')).not.toBeVisible();expect((await privateContext.request.get(share)).status()).toBe(410);
 await page.locator('#close-viewer').click();await page.locator('#open-settings').click();
 await page.locator('#devices button').click();await expect(page.locator('#devices .device')).toHaveCount(0);expect((await privateContext.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+token}})).status()).toBe(401);
 await page.locator('#close-settings').click();
 // A real file-input change auto-uploads and produces an automatic thumbnail.
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=','base64');
 await page.locator('#file').setInputFiles({name:'同步截图.png',mimeType:'image/png',buffer:png});
 await expect(page.locator('.tile')).toHaveCount(2);
 await expect.poll(()=>page.locator('.tile img').evaluateAll(images=>images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
 const imageReads=previewRequests.length;
 await page.locator('#refresh').click();await expect(page.locator('#refresh')).toBeEnabled();expect(previewRequests.length).toBe(imageReads);
 // Pasting into a composer edits text; it must never upload a clipboard image.
 await page.locator('#add-text').click();
 await page.locator('#text').evaluate((textarea,encoded)=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'should-not-upload.png',{type:'image/png'}));textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},png.toString('base64'));
 await page.locator('#close-composer').click();await page.locator('#refresh').click();await expect(page.locator('#refresh')).toBeEnabled();await expect(page.locator('.tile')).toHaveCount(2);
 // Browser clipboard event enters the same upload flow without clicking upload.
 await page.evaluate(encoded=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'粘贴截图.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},png.toString('base64'));
 await expect(page.locator('.tile')).toHaveCount(3);
 await expect.poll(()=>page.locator('.tile img').evaluateAll(images=>images.length===2&&images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
 // Another device uploads; refresh discovers it without downloading old previews.
 const remoteText='另一台设备的笔记';
 const externalUpload=await context.request.post(origin+'/api/upload',{headers:{Authorization:'Bearer '+lastAccessToken,Origin:origin},multipart:{full:{name:'remote.txt',mimeType:'text/plain',buffer:Buffer.from(remoteText)}}});expect(externalUpload.status()).toBe(200);
 const oldReads=[...previewRequests];await page.locator('#refresh').click();await expect(page.locator('.tile')).toHaveCount(4);await expect(page.locator('#gallery')).toContainText(remoteText);
 for(const path of new Set(oldReads))expect(previewRequests.filter(value=>value===path).length).toBe(oldReads.filter(value=>value===path).length);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'/tmp/shotsync-sync-gallery-mobile.png',fullPage:true});
 await page.setViewportSize({width:1280,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'/tmp/shotsync-sync-gallery-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 // An earlier upload finishing must not close a newly opened composer or erase its draft.
 let releaseComposer;const composerGate=new Promise(resolve=>{releaseComposer=resolve;});
 let composerArrived;const composerPending=new Promise(resolve=>{composerArrived=resolve;});
 await page.route('**/api/upload',async route=>{const response=await route.fetch();composerArrived();await composerGate;await route.fulfill({response});},{times:1});
 await page.locator('#add-text').click();await page.locator('#text').fill('迟到的旧提交');await page.locator('#text-form button').click();await composerPending;
 await page.locator('#close-composer').click();await page.locator('#add-text').click();await page.locator('#text').fill('不能丢失的新草稿');releaseComposer();
 await expect(page.locator('#text-form button')).toBeEnabled();await expect(page.locator('#composer-dialog')).toBeVisible();await expect(page.locator('#text')).toHaveValue('不能丢失的新草稿');await page.locator('#close-composer').click();
 await expect(page.locator('.tile')).toHaveCount(5);
 page.on('dialog',dialog=>dialog.accept());
 while(await page.locator('.tile').count()){const remaining=await page.locator('.tile').count();await page.locator('.tile-open').first().click();await page.locator('#viewer-delete').click();await expect(page.locator('#viewer-dialog')).not.toBeVisible();await expect(page.locator('.tile')).toHaveCount(remaining-1);}
 // Account policy and object expiration must agree, including unlimited storage time.
 await db.prepare('UPDATE users SET retention_days=0 WHERE id=?').bind(fixtureId).run();
 await page.locator('#refresh').click();await expect(page.locator('#refresh')).toBeEnabled();await page.locator('#open-settings').click();await expect(page.locator('#retention')).toContainText('内容永久保存，不自动过期');await page.locator('#close-settings').click();
 await page.locator('#add-text').click();
 await page.locator('#text').fill('永久保留测试');await page.locator('#text-form button').click();
 await expect(page.locator('.tile')).toHaveCount(1);
 await page.locator('.tile-open').click();await expect(page.locator('#viewer-meta')).toContainText('永久保存');
 const permanentList=await page.evaluate(()=>api('/api/list'));
 expect(permanentList.limits.retentionDays).toBe(0);expect(permanentList.items[0].expiresAt).toBeNull();
 const shareResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.startsWith('/api/share/'));
 await page.locator('#viewer-share').click();
 const permanentShare=await (await shareResponse).json();
 expect(permanentShare.expiresAt-Date.now()).toBeGreaterThan(23*3600000);
 expect(permanentShare.expiresAt-Date.now()).toBeLessThanOrEqual(24*3600000);
 await expect(page.getByText('任何持有链接的人都可访问', {exact:false})).toContainText('最多 24 小时');
 await page.locator('#viewer-delete').click();await expect(page.locator('.tile')).toHaveCount(0);
 await db.prepare('UPDATE users SET retention_days=90 WHERE id=?').bind(fixtureId).run();
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
 const failedSettingsRefresh=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/refresh'&&response.status()===503);
 await page.locator('#open-settings').click();await failedSettingsRefresh;
 const beforeLogout=providerCalls.filter(call=>call==='POST /auth/v1/token').length;
 await page.locator('#logout').click();await expect(page.locator('#auth')).toBeVisible();
 expect(providerCalls.filter(call=>call==='POST /auth/v1/token').length).toBe(beforeLogout);
 expect((await context.cookies()).some(cookie=>cookie.name==='__Host-shotsync-refresh')).toBe(false);
 refreshFailure=0;expect(await page.locator('#token-value').textContent()).toBe('');
 await expect(page.locator('#gallery')).toBeEmpty();await expect(page.locator('#viewer-content')).toBeEmpty();await expect(page.locator('#settings-dialog')).not.toBeVisible();
 expect((await context.request.get(origin+'/api/list',{headers:{Authorization:'Bearer '+firstAccessToken}})).status()).toBe(401);
 await page.reload();await expect(page.locator('#auth')).toBeVisible();await expect(page.locator('#app')).toBeHidden();
 await page.locator('#tab-register').click();await page.locator('#email').fill('new@example.com');await page.locator('#password').fill(password);await page.locator('#auth-submit').click();
 await expect(page.locator('#recovery-result')).toBeVisible();
 const recovery=await page.locator('#recovery-value').textContent();expect(recovery).toMatch(/^[a-f0-9]{64}$/);
 await expect(page.locator('#recovery-value')).toHaveText(recovery);await expect(page.locator('#finish-recovery')).toBeDisabled();
 expect(await page.locator('#password').inputValue()).toBe('');
 await page.locator('#recovery-saved').check();await page.locator('#finish-recovery').click();await expect(page.locator('#recovery-value')).toHaveText('');
 await page.locator('#password').fill(password);await page.locator('#auth-submit').click();await expect(page.locator('#app')).toBeVisible();
 await page.locator('#open-settings').click();await expect(page.locator('#retention')).toContainText('内容保留 7 天');await page.locator('#close-settings').click();
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
 // A stale account request cannot retry its upload body using a later session.
 let releaseStale;const staleGate=new Promise(resolve=>{releaseStale=resolve;});let staleArrived;const stalePending=new Promise(resolve=>{staleArrived=resolve;});let staleRequests=0;
 await page.route('**/api/upload',async route=>{staleRequests++;staleArrived();await staleGate;await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'Unauthorized'})});});
 await page.evaluate(()=>{const body=new FormData();body.append('full',new Blob(['old-account-only'],{type:'text/plain'}),'old.txt');window.staleOperation=api('/api/upload',{method:'POST',body}).catch(()=>null);});
 await stalePending;await page.evaluate(()=>{generation++;accessToken='new-account-access-token';});releaseStale();await page.evaluate(()=>window.staleOperation);
 expect(staleRequests).toBe(1);expect(await page.evaluate(()=>accessToken)).toBe('new-account-access-token');await expect(page.locator('#app')).toBeVisible();await page.unroute('**/api/upload');
 expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);expect(errors).toEqual([]);
 console.log('PASS: gallery composer/image/paste, cached previews and remote refresh, viewer copy/download/share/revoke/delete, desktop/mobile layouts, settings/device isolation; native JWT login/refresh/logout/recovery and retention; delayed composer and stale-session 401 regressions. Core flows use real Worker/D1/R2 with external provider/Turnstile fixtures.');
 await privateContext.close();await context.close();
} finally {
 if(browser)await browser.close();if(server)await server.dispose();
 rmSync(temp,{recursive:true,force:true});
}
