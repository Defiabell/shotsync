import { chromium, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'shotsync-browser-'));
const origin = 'https://localhost:8788';
const cli = 'node_modules/wrangler/bin/wrangler.js';
const common = ['--config','wrangler.hosted.jsonc','--persist-to',join(temp,'state')];
const run = args => execFileSync(process.execPath,[cli,...args],{stdio:'pipe'});
let server, browser;
try {
 run(['d1','migrations','apply','shotsync-hosted','--local',...common]);
 const password='browser-fixture-password';
 // Valid format salt; test account exists only in the temporary local database.
 const validSalt='a'.repeat(64);
 const validHash='scrypt:16384:8:5:'+validSalt+':'+scryptSync(password,validSalt,32,{N:16384,r:8,p:5,maxmem:32*1024*1024}).toString('hex');
 const sql=join(temp,'fixture.sql');
 writeFileSync(sql,`INSERT INTO users(id,email,password_hash,verified_at,created_at) VALUES('browser','browser@example.com','${validHash}',NULL,1);`);
 run(['d1','execute','shotsync-hosted','--local','--file',sql,...common]);
 server=spawn(process.execPath,[cli,'dev','--local','--ip','127.0.0.1','--local-protocol','https','--port','8788','--var','PUBLIC_ORIGIN:'+origin,...common],{stdio:['ignore','pipe','pipe']});
 let output='';server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);
 await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(output.includes('Ready on')){clearInterval(timer);resolve();}else if(server.exitCode!==null||Date.now()-started>30000){clearInterval(timer);reject(new Error(output));}},100);});
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);
 await page.locator('#email').fill('browser@example.com');await page.locator('#password').fill(password);await page.locator('#auth-submit').click();
 await expect(page.locator('#app')).toBeVisible();
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
 await page.locator('#logout').click();await expect(page.locator('#auth')).toBeVisible();expect(await page.locator('#token-value').textContent()).toBe('');
 // UI-only recovery contracts; real registration/reset security is exercised by Workers tests.
 const recovery='a'.repeat(64),replacement='b'.repeat(64);
 await page.route('**/api/account/register',route=>route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({ok:true,recoveryCode:recovery})}));
 await page.route('**/api/account/reset-password',route=>{
  expect(route.request().postDataJSON()).toMatchObject({email:'new@example.com',recoveryCode:recovery,password:'replacement-password'});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,recoveryCode:replacement})});
 });
 await page.locator('#tab-register').click();await page.locator('#email').fill('new@example.com');await page.locator('#password').fill(password);await page.locator('#auth-submit').click();
 await expect(page.locator('#recovery-value')).toHaveText(recovery);await expect(page.locator('#finish-recovery')).toBeDisabled();
 expect(await page.locator('#password').inputValue()).toBe('');
 await page.locator('#recovery-saved').check();await page.locator('#finish-recovery').click();await expect(page.locator('#recovery-value')).toHaveText('');
 await page.locator('#forgot').click();await page.locator('#recovery-code').fill(recovery);await page.locator('#password').fill('replacement-password');await page.locator('#auth-submit').click();
 await expect(page.locator('#recovery-value')).toHaveText(replacement);await expect(page.locator('#finish-recovery')).toBeDisabled();
 expect(await page.locator('#recovery-code').inputValue()).toBe('');
 await page.locator('#recovery-saved').check();await page.locator('#finish-recovery').click();await expect(page.locator('#recovery-value')).toHaveText('');
 expect(await page.evaluate(()=>localStorage.length)).toBe(0);expect(errors).toEqual([]);
 console.log('PASS: real browser unverified-account login, upload, private preview, device token, anonymous isolation, share/revoke, delete and logout; mocked registration/recovery UI saves and clears recovery codes');
 await privateContext.close();await context.close();
} finally {
 if(browser)await browser.close();if(server)server.kill('SIGTERM');
 rmSync(temp,{recursive:true,force:true});
}
