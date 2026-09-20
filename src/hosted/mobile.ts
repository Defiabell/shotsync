import type { HostedEnv } from './types';
import { MOBILE_ICONS } from './mobile-icons';

export const MOBILE_HEAD = `<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png"><meta name="theme-color" content="#111111"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="ShotSync"><meta name="apple-mobile-web-app-status-bar-style" content="default">`;

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function mobileHTML(env: Pick<HostedEnv, 'PUBLIC_ORIGIN'>): string {
  const address = escapeHTML(new URL('/', env.PUBLIC_ORIGIN).href);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">${MOBILE_HEAD}<title>手机快捷入口 · ShotSync</title><style>
:root{color-scheme:dark;font-family:-apple-system,system-ui,sans-serif;background:#111;color:#eee}*{box-sizing:border-box}body{margin:0;padding:24px max(20px,env(safe-area-inset-right)) max(32px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));padding-top:max(24px,env(safe-area-inset-top))}main{max-width:620px;margin:auto}h1{font-size:26px;margin:28px 0 12px}h2{font-size:19px;margin:0 0 12px}p,li{font-size:15px;line-height:1.8}li+li{margin-top:8px}ol{padding-left:22px}a{color:#a8c4ff}button,.button{display:inline-block;padding:12px 16px;border:0;border-radius:10px;background:#2b6cff;color:white;font:inherit;text-decoration:none;cursor:pointer}button:focus-visible,a:focus-visible{outline:2px solid #aac6ff;outline-offset:3px}.muted{color:#aaa;font-size:13px}section{padding:20px;background:#1b1b1b;border:1px solid #333;border-radius:14px;margin:18px 0}label{display:block;margin-bottom:8px}input{font:inherit;width:100%;min-width:0;padding:12px;background:#111;color:#eee;border:1px solid #444;border-radius:8px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}#copy-status{min-height:24px}header{display:flex;gap:10px;align-items:center}header img{width:40px;height:40px;border-radius:9px}
</style></head><body><main><header><img src="/icons/icon-192.png" alt=""><strong>ShotSync</strong></header><h1>在手机上一点就打开</h1><p>把相册放到主屏幕，随时传图片、发文字。第一次从新入口打开时，可能需要重新登录。</p><section><label for="mobile-url">你的相册地址</label><input id="mobile-url" readonly value="${address}"><div class="actions"><button id="copy-mobile-url">复制地址</button><a class="button" id="open-gallery" href="/">打开相册</a></div><p id="copy-status" class="muted" role="status" aria-live="polite"></p></section>
<section><h2>iPhone · 添加到主屏幕</h2><ol><li>用 <strong>Safari</strong> 打开上面的相册地址。</li><li>点「分享」（部分版本先点「更多」），选择「添加到主屏幕」。</li><li>如果出现「作为网页 App 打开」，将它打开，再点「添加」。以后点主屏幕上的 ShotSync 图标即可进入。</li></ol><p class="muted">在微信等 App 内打开时，先复制地址到 Safari。菜单名称可能随系统版本变化。</p></section>
<section><h2>Android · 添加到主屏幕</h2><ol><li>用 <strong>Chrome</strong> 打开上面的相册地址。</li><li>点右上角「⋮」菜单，选择「添加到主屏幕」。</li><li>根据浏览器显示选择「安装」或「创建快捷方式」，按屏幕提示完成。</li></ol><p class="muted">是否提供安装、以及打开后的窗口样式，由浏览器和系统决定。</p></section>
<section><h2>iPhone · 快捷指令入口</h2><ol><li>先复制上面的相册地址，打开「快捷指令」App，新建快捷指令。</li><li>添加「打开 URL」动作，填入相册地址，命名为「打开 ShotSync」。</li><li>可把它放到「快捷指令」小组件；支持的 iPhone 也可在系统设置里绑定「操作按钮」或「轻点背面」。</li></ol><p class="muted">这个入口只负责打开相册，无需把密码或令牌放进网址。打开后仍使用你的账号登录。</p></section>
<p class="muted">同步需要联网；添加到主屏幕不会开启离线保存。需要在 Mac 客户端或上传快捷指令中同步？登录相册后，在「设置 → 连接其他设备」复制地址并生成设备令牌。</p><p class="muted">官方说明：<a href="https://support.apple.com/guide/iphone/iphea86e5236/ios">iPhone 添加到主屏幕</a> · <a href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&amp;hl=zh-Hans">Android 网页应用</a></p>
</main><script>'use strict';document.getElementById('copy-mobile-url').onclick=async()=>{const input=document.getElementById('mobile-url'),status=document.getElementById('copy-status');try{await navigator.clipboard.writeText(input.value);status.textContent='相册地址已复制。';}catch{input.focus();input.select();status.textContent='请长按已选中的地址并复制。';}};</script></body></html>`;
}

/** Public, credential-free assets. No service worker or offline private cache. */
export function mobileResponse(request: Request, env: Pick<HostedEnv, 'PUBLIC_ORIGIN'>): Response | null {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const path = new URL(request.url).pathname;
  const head = request.method === 'HEAD';
  if (path === '/mobile') return new Response(head ? null : mobileHTML(env), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (path === '/manifest.webmanifest') {
    return new Response(head ? null : JSON.stringify({
      id: '/', name: 'ShotSync', short_name: 'ShotSync', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#111111', theme_color: '#111111', lang: 'zh-CN',
      icons: [192, 512].map(size => ({ src: '/icons/icon-' + size + '.png', sizes: size + 'x' + size, type: 'image/png', purpose: 'any maskable' })),
    }), { headers: { 'content-type': 'application/manifest+json; charset=utf-8' } });
  }
  if (Object.hasOwn(MOBILE_ICONS, path)) {
    const bytes = head ? null : Uint8Array.from(atob(MOBILE_ICONS[path]), char => char.charCodeAt(0));
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  }
  return null;
}
