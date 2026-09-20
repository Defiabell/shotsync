import type { HostedEnv } from './types';
import { authenticate, handleAccounts, cleanupAccounts } from './accounts';
import { handleFiles, handleShared, cleanupFiles } from './files';
import { consumeRate } from './limits';
import { error, HttpError } from './http';
import { hostedHTML } from './ui';
import { mobileResponse } from './mobile';

async function route(request: Request, env: HostedEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (url.origin !== env.PUBLIC_ORIGIN) return error(421, '请使用服务正式地址');
  const mobile = mobileResponse(request, env);
  if (mobile) return mobile;
  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
  if ((path === '/' || path === '/account') && request.method === 'GET') {
    return new Response(hostedHTML(env), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  // Early bounded counters gate all API, auth and public-share traffic.
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (!(await consumeRate(env.DB, 'global-requests', 600, 60)) || !(await consumeRate(env.DB, 'ip:' + ip, 120, 60))) return error(429, '请求过于频繁，请稍后再试');
  if (!['GET','HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    const bearer = request.headers.get('authorization')?.startsWith('Bearer ');
    if ((!bearer && origin !== env.PUBLIC_ORIGIN) || (origin && origin !== env.PUBLIC_ORIGIN)) return error(403, '请求来源不允许');
  }
  if (path.startsWith('/api/account/')) return (await handleAccounts(request, env)) ?? error(404, '不存在');
  if (path.startsWith('/s/')) return handleShared(request, env);
  const user = await authenticate(request, env);
  if (!user) return error(401, '请先登录');
  if (!(await consumeRate(env.DB, 'read:' + user.id, 120, 60))) return error(429, '操作过于频繁');
  return handleFiles(request, env, user);
}
export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (e) {
      if (e instanceof HttpError) response = error(e.status, e.message);
      else { console.error('hosted_request_failed'); response = error(503, '服务暂时不可用，请稍后重试'); }
    }
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('x-frame-options', 'DENY');
    headers.set('x-robots-tag', 'noindex, nofollow');
    if (response.status === 429) headers.set('retry-after', '60');
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event: ScheduledController, env: HostedEnv): Promise<void> {
    await cleanupFiles(env);
    await cleanupAccounts(env.DB);
  },
} satisfies ExportedHandler<HostedEnv>;
