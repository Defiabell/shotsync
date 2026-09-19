import { env, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFiles, handleShared, cleanupFiles, getUsage } from '../src/hosted/files';
import { consumeRate, LIMITS } from '../src/hosted/limits';
import type { HostedEnv, Account } from '../src/hosted/types';
import worker from '../src/hosted/index';
const bindings = env as unknown as HostedEnv & { TEST_MIGRATIONS: D1Migration[] };
const hosted = { ...bindings, PUBLIC_ORIGIN: 'https://shotsync.test', UPLOADS_ENABLED: '1' };
const user: Account = { id: 'u1', email: 'one@example.com', verified: true, via: 'cookie' };
const other: Account = { ...user, id: 'u2', email: 'two@example.com' };
const origin = hosted.PUBLIC_ORIGIN;
function req(path: string, method = 'GET') { return new Request(origin + path, { method, headers: { origin } }); }
async function upload(text = 'hello') {
 const form = new FormData(); form.set('full', new Blob([text], { type: 'text/plain' }), 'note.txt');
 return handleFiles(new Request(origin + '/api/upload', { method: 'POST', body: form }), hosted, user);
}
async function saved() { return (await (await upload()).json<{id:string}>()).id; }
beforeEach(async () => {
 await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
 for (const u of [user, other]) await bindings.DB.prepare("INSERT INTO users(id,email,password_hash,verified_at,created_at) VALUES(?,?,'unused',1,1)").bind(u.id,u.email).run();
});
describe('hosted tenant isolation and exact quotas', () => {
 it('stores only user-scoped keys and denies other users list/read/delete/share', async () => {
  const id = await saved();
  const list = await (await handleFiles(req('/api/list'),hosted,other)).json<{items:unknown[]}>(); expect(list.items).toEqual([]);
  for (const [path,method] of [[`/i/${id}`,'GET'],[`/api/img/${id}`,'DELETE'],[`/api/share/${id}`,'POST']]) expect((await handleFiles(req(path,method),hosted,other)).status).toBe(404);
  const result = await handleFiles(req(`/i/${id}`),hosted,user); expect(await result.text()).toBe('hello'); expect(result.headers.get('cache-control')).toContain('no-store');
  expect((await bindings.BUCKET.list()).objects.map(x=>x.key)).toEqual([`users/u1/${id}/full`]);
 });
 it('rejects unverified writes and global paused uploads', async () => {
  expect((await handleFiles(req('/api/upload','POST'),hosted,{...user,verified:false})).status).toBe(403);
  expect((await handleFiles(req('/api/upload','POST'),{...hosted,UPLOADS_ENABLED:'0'},user)).status).toBe(503);
 });
 it('deleting releases storage but not daily consumption', async () => {
  const id=await saved(); await handleFiles(req(`/api/img/${id}`,'DELETE'),hosted,user);
  const result=await getUsage(hosted,user);expect(result.usage.storedBytes).toBe(0);expect(result.usage.storedItems).toBe(0);expect(result.usage.dailyUploads).toBe(1);expect(result.usage.dailyBytes).toBe(5);
 });
 it('enforces last slot atomically under concurrent uploads', async () => {
  await bindings.DB.prepare("INSERT INTO storage_usage(scope,bytes,items) VALUES('u1',0,99)").run();
  const results=await Promise.allSettled([upload(),upload(),upload()]);
  expect(results.filter(x=>x.status==='fulfilled' && x.value.status===200)).toHaveLength(1);
  expect((await getUsage(hosted,user)).usage.storedItems).toBe(100);
 });
 it('caps concurrent uploads across accounts before body buffering', async () => {
  const now=Date.now(), date=new Date().toISOString().slice(0,10);
  await bindings.DB.prepare("INSERT INTO files(id,user_id,size,state,created_at,expires_at,day) VALUES('pending','u2',10,'pending',?,?,?)").bind(now,now+60000,date).run();
  await expect(upload()).rejects.toMatchObject({status:429});
 });
 it('enforces global budget even when personal budget has room', async () => {
  await bindings.DB.prepare("INSERT INTO daily_usage(scope,day,uploads,bytes) VALUES('global',?,2000,0)").bind(new Date().toISOString().slice(0,10)).run();
  await expect(upload()).rejects.toMatchObject({status:429});expect((await bindings.BUCKET.list()).objects).toHaveLength(0);
 });
 it('bounds body bytes independent of dishonest content length and frees reservation', async () => {
  const request = new Request(origin+'/api/upload',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=x','content-length':'1'},body:'very large'});
  await expect(handleFiles(request,hosted,user)).rejects.toMatchObject({status:413});expect((await getUsage(hosted,user)).usage.storedBytes).toBe(0);
 });
 it('rejects oversize thumbnails and text before R2 writes', async () => {
  const form=new FormData();form.set('full',new Blob(['x'],{type:'image/png'}),'a.png');form.set('thumb',new Blob([new Uint8Array(LIMITS.maxThumbBytes+1)],{type:'image/jpeg'}),'a.jpg');
  await expect(handleFiles(new Request(origin+'/api/upload',{method:'POST',body:form}),hosted,user)).rejects.toMatchObject({status:413});
  await expect(upload('x'.repeat(LIMITS.maxTextBytes+1))).rejects.toMatchObject({status:413});expect((await bindings.BUCKET.list()).objects).toHaveLength(0);
 });
 it('cleans partial writes after failed upload and can retry failed cleanup', async () => {
  const put=vi.spyOn(hosted.BUCKET,'put').mockRejectedValueOnce(new Error('r2 unavailable'));
  await expect(upload()).rejects.toMatchObject({status:503});put.mockRestore();expect((await getUsage(hosted,user)).usage.storedBytes).toBe(0);
  const id=await saved();const del=vi.spyOn(hosted.BUCKET,'delete').mockRejectedValueOnce(new Error('temporary'));
  await expect(handleFiles(req(`/api/img/${id}`,'DELETE'),hosted,user)).rejects.toThrow();del.mockRestore();expect((await getUsage(hosted,user)).usage.storedBytes).toBe(5);
  await cleanupFiles(hosted);expect((await getUsage(hosted,user)).usage.storedBytes).toBe(0);
 });
 it('expires and revokes shares and caps download counts', async () => {
  const id=await saved();const created=await (await handleFiles(req(`/api/share/${id}`,'POST'),hosted,user)).json<{url:string}>();
  expect(await (await handleShared(new Request(created.url),hosted)).text()).toBe('hello');
  await bindings.DB.prepare('UPDATE shares SET hits=50').run();expect((await handleShared(new Request(created.url),hosted)).status).toBe(410);
  const fresh=await (await handleFiles(req(`/api/share/${id}`,'POST'),hosted,user)).json<{url:string}>();
  await handleFiles(req(`/api/share/${id}`,'DELETE'),hosted,user);expect((await handleShared(new Request(fresh.url),hosted)).status).toBe(410);
 });
 it('counts owner download budget for anonymous shares', async () => {
  const id=await saved();const share=await (await handleFiles(req(`/api/share/${id}`,'POST'),hosted,user)).json<{url:string}>();
  await bindings.DB.prepare('UPDATE daily_usage SET download_bytes=? WHERE scope=?').bind(LIMITS.dailyDownloadBytes,user.id).run();
  await expect(handleShared(new Request(share.url),hosted)).rejects.toMatchObject({status:429});
 });
 it('denies expired files immediately, then deletes objects and releases quota on cleanup', async () => {
  const id=await saved();await bindings.DB.prepare('UPDATE files SET expires_at=1 WHERE id=?').bind(id).run();
  expect((await handleFiles(req(`/i/${id}`),hosted,user)).status).toBe(404);await cleanupFiles(hosted);expect((await bindings.BUCKET.list()).objects).toHaveLength(0);expect((await getUsage(hosted,user)).usage.storedItems).toBe(0);
 });
 it('atomic rate limit survives competing calls and resets next window', async () => {
  const values=await Promise.all(Array.from({length:10},()=>consumeRate(bindings.DB,'test',3,60,120000)));expect(values.filter(Boolean)).toHaveLength(3);expect(await consumeRate(bindings.DB,'test',3,60,180000)).toBe(true);
 });
 it('root rejects cross-origin browser mutations and never exposes personal legacy pool', async () => {
  expect((await worker.fetch(new Request(origin+'/api/upload',{method:'POST',headers:{origin:'https://evil.test'}}),hosted)).status).toBe(403);
  expect((await worker.fetch(req('/api/list'),hosted)).status).toBe(401);
  expect((await worker.fetch(new Request(origin+'/api/account/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:'null'}),hosted)).status).toBe(400);
  expect((await worker.fetch(new Request('https://other.test/'),hosted)).status).toBe(421);
 });
});
