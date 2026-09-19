import type { HostedEnv, Account } from './types';
import { LIMITS, consumeRate } from './limits';
import { HttpError, json, error, readBody } from './http';

type FileRow = { id: string; user_id: string; name: string; mime: string; size: number; full_size: number; thumb_size: number; state: string; created_at: number; expires_at: number; day: string };
const MAX_BODY = LIMITS.maxImageBytes + LIMITS.maxThumbBytes + 64 * 1024;
const DAY = 86400000;
const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const key = (f: Pick<FileRow, 'user_id' | 'id'>, thumb = false) => `users/${f.user_id}/${f.id}/${thumb ? 'thumb' : 'full'}`;
export async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join(''); }
function quotaError(e: unknown): never {
  if (String(e).includes('quota:')) throw new HttpError(429, '已达到账号或服务额度，请稍后重试；可删除旧文件释放存储空间');
  throw e;
}
export async function getUsage(env: HostedEnv, user: Account) {
  const store = await env.DB.prepare('SELECT bytes,items FROM storage_usage WHERE scope=?').bind(user.id).first<{ bytes: number; items: number }>();
  const daily = await env.DB.prepare('SELECT uploads,bytes,downloads,download_bytes FROM daily_usage WHERE scope=? AND day=?').bind(user.id, day()).first<{ uploads: number; bytes: number; downloads: number; download_bytes: number }>();
  return { usage: { storedBytes: store?.bytes ?? 0, storedItems: store?.items ?? 0, dailyUploads: daily?.uploads ?? 0, dailyBytes: daily?.bytes ?? 0, dailyDownloads: daily?.downloads ?? 0, dailyDownloadBytes: daily?.download_bytes ?? 0 }, limits: LIMITS };
}
export async function removeFile(env: HostedEnv, file: FileRow): Promise<void> {
  // Keep the reservation until both deletes succeed. A retry is idempotent.
  await env.DB.prepare("UPDATE files SET state='deleting' WHERE id=?").bind(file.id).run();
  await env.BUCKET.delete([key(file), key(file, true)]);
  await env.DB.prepare("DELETE FROM files WHERE id=? AND state='deleting'").bind(file.id).run();
}
async function upload(request: Request, env: HostedEnv, user: Account): Promise<Response> {
  if (env.UPLOADS_ENABLED !== '1') return error(503, '当前暂停上传，已有文件仍可取回');
  if (!(await consumeRate(env.DB, 'upload:' + user.id, 10, 60))) return error(429, '上传过于频繁，请稍后再试');
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.startsWith('multipart/form-data;')) return error(415, '需要 multipart 文件上传');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > MAX_BODY)) return error(413, '上传内容过大或长度无效');
  const reserved = declared === null ? MAX_BODY : Number(declared);
  const id = crypto.randomUUID();
  const now = Date.now();
  const pending: FileRow = { id, user_id: user.id, name: '', mime: '', size: reserved, full_size: 0, thumb_size: 0, state: 'pending', created_at: now, expires_at: now + 5 * 60_000, day: day(now) };
  try {
    await env.DB.prepare("INSERT INTO files(id,user_id,size,state,created_at,expires_at,day) VALUES(?,?,?,'pending',?,?,?)")
      .bind(id, user.id, reserved, now, pending.expires_at, pending.day).run();
  } catch (e) { quotaError(e); }
  try {
    const bytes = await readBody(request, reserved);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData(); }
    catch { throw new HttpError(400, '上传表单格式无效'); }
    const full = form.get('full');
    const thumb = form.get('thumb');
    if (!full || typeof full === 'string') throw new HttpError(400, '缺少文件');
    if (typeof thumb === 'string') throw new HttpError(400, '缩略图无效');
    if ([...form.keys()].some(k => k !== 'full' && k !== 'thumb') || form.getAll('full').length !== 1 || form.getAll('thumb').length > 1) throw new HttpError(400, '上传字段无效');
    const mime = full.type.split(';')[0].toLowerCase();
    if (!['image/png','image/jpeg','image/webp','text/plain'].includes(mime)) throw new HttpError(415, '只支持 PNG、JPEG、WebP 和纯文本');
    if (!full.size || full.size > (mime === 'text/plain' ? LIMITS.maxTextBytes : LIMITS.maxImageBytes)) throw new HttpError(413, '文件超过大小限制');
    if (thumb && (thumb.size > LIMITS.maxThumbBytes || thumb.type !== 'image/jpeg' || mime === 'text/plain')) throw new HttpError(413, '缩略图格式或大小无效');
    const size = full.size + (thumb?.size ?? 0);
    if (size > reserved) throw new HttpError(413, '文件超过预留额度');
    await env.BUCKET.put(key(pending), full.stream(), { httpMetadata: { contentType: mime } });
    if (thumb) await env.BUCKET.put(key(pending, true), thumb.stream(), { httpMetadata: { contentType: 'image/jpeg' } });
    const committed = await env.DB.prepare(`UPDATE files SET state='ready',size=?,full_size=?,thumb_size=?,mime=?,name=?,expires_at=? WHERE id=? AND state='pending' AND expires_at>? RETURNING id`)
      .bind(size, full.size, thumb?.size ?? 0, mime, full.name.slice(0, 200), now + LIMITS.retentionDays * DAY, id, Date.now()).first();
    if (!committed) throw new HttpError(409, '上传已过期，请重试');
    return json({ id, expiresAt: now + LIMITS.retentionDays * DAY });
  } catch (e) {
    await removeFile(env, pending);
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, '上传服务暂时不可用，请稍后重试');
  }
}
async function download(request: Request, env: HostedEnv, file: FileRow): Promise<Response> {
  const thumb = new URL(request.url).searchParams.get('size') === 'thumb' && file.thumb_size > 0;
  try {
    await env.DB.prepare('INSERT INTO downloads(id,user_id,day,bytes,created_at) VALUES(?,?,?,?,?)')
      .bind(crypto.randomUUID(), file.user_id, day(), thumb ? file.thumb_size : file.full_size, Date.now()).run();
  } catch (e) { quotaError(e); }
  const object = await env.BUCKET.get(key(file, thumb));
  if (!object) return error(404, '文件已清理');
  return new Response(object.body, { headers: {
    'content-type': thumb ? 'image/jpeg' : file.mime,
    'content-length': String(object.size),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'inline',
    'referrer-policy': 'no-referrer',
  } });
}
export async function handleShared(request: Request, env: HostedEnv): Promise<Response> {
  if (request.method !== 'GET') return error(405, '不支持此方法');
  const token = new URL(request.url).pathname.slice(3);
  if (!/^[a-f0-9]{64}$/.test(token)) return error(404, '分享不存在');
  const hash = await hashToken(token);
  const share = await env.DB.prepare('UPDATE shares SET hits=hits+1 WHERE hash=? AND expires_at>? AND hits<50 RETURNING file_id,user_id').bind(hash, Date.now()).first<{ file_id: string; user_id: string }>();
  if (!share) return error(410, '分享已过期、撤销或达到访问上限');
  const file = await env.DB.prepare("SELECT * FROM files WHERE id=? AND user_id=? AND state='ready' AND expires_at>?").bind(share.file_id, share.user_id, Date.now()).first<FileRow>();
  if (!file) return error(410, '文件已过期');
  if (!(await consumeRate(env.DB, 'read:' + file.user_id, 120, 60))) return error(429, '访问过于频繁');
  return download(request, env, file);
}
export async function handleFiles(request: Request, env: HostedEnv, user: Account): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (!user.verified) return error(403, '请先验证邮箱');
  if (path === '/api/upload' && method === 'POST') return upload(request, env, user);
  if (path === '/api/usage' && method === 'GET') return json(await getUsage(env, user));
  if (path === '/api/list' && method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM files WHERE user_id=? AND state='ready' AND expires_at>? ORDER BY created_at DESC LIMIT 100").bind(user.id, Date.now()).all<FileRow>();
    return json({ items: rows.results.map(f => ({ id: f.id, type: f.mime === 'text/plain' ? 'text' : 'image', size: f.size, createdAt: f.created_at, expiresAt: f.expires_at, name: f.name })), ...await getUsage(env, user) });
  }
  const match = path.match(/^\/(i|api\/img|api\/share)\/([a-f0-9-]{36})$/);
  if (!match) return error(404, '不存在');
  const file = await env.DB.prepare("SELECT * FROM files WHERE id=? AND user_id=? AND state='ready' AND expires_at>?").bind(match[2], user.id, Date.now()).first<FileRow>();
  if (!file) return error(404, '文件不存在或已过期');
  if (match[1] === 'i' && method === 'GET') return download(request, env, file);
  if (match[1] === 'api/img' && method === 'DELETE') { await removeFile(env, file); return json({ deleted: true }); }
  if (match[1] === 'api/share') {
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM shares WHERE file_id=? AND user_id=?').bind(file.id, user.id).run(); return json({ revoked: true }); }
    if (method === 'POST') {
      const token = randomToken(), hash = await hashToken(token), expiresAt = Math.min(Date.now() + DAY, file.expires_at);
      // One active link per file: replacing it revokes its predecessor.
      await env.DB.batch([env.DB.prepare('DELETE FROM shares WHERE file_id=?').bind(file.id), env.DB.prepare('INSERT INTO shares(hash,file_id,user_id,expires_at) VALUES(?,?,?,?)').bind(hash, file.id, user.id, expiresAt)]);
      return json({ url: env.PUBLIC_ORIGIN + '/s/' + token, expiresAt });
    }
  }
  return error(405, '不支持此方法');
}
export async function cleanupFiles(env: HostedEnv): Promise<void> {
  const rows = await env.DB.prepare("SELECT * FROM files WHERE expires_at<? OR state='deleting' ORDER BY expires_at LIMIT 100").bind(Date.now()).all<FileRow>();
  for (const file of rows.results) await removeFile(env, file);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shares WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('DELETE FROM downloads WHERE created_at<?').bind(Date.now() - DAY),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now() - DAY),
    env.DB.prepare('DELETE FROM daily_usage WHERE day<?').bind(day(Date.now() - 8 * DAY)),
  ]);
}
