export const PRODUCT_URL = "https://shotsync-demo.defiabell.workers.dev/about";
const REPO = "https://github.com/Defiabell/shotsync";
const title = "shotsync — 自部署的跨设备图片与文字暂存工具";
const description = "把截图、照片和文字放进自己的 Cloudflare 图片池，再从手机或电脑取走。了解 shotsync 的浏览器/PWA 用法、自部署步骤、共享 token、分享链接与数据保留限制。";

export const aboutHTML = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${PRODUCT_URL}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${PRODUCT_URL}">
<meta property="og:site_name" content="shotsync">
<meta property="og:locale" content="zh_CN">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "shotsync",
  url: PRODUCT_URL,
  description,
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Web",
  license: `${REPO}/blob/main/LICENSE`,
  sameAs: REPO,
  author: { "@type": "Person", name: "Jinkun Sun", url: "https://github.com/Defiabell" },
})}</script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #111; color: #eee; font: 17px/1.8 -apple-system, system-ui, sans-serif; }
  main, footer, nav { width: min(860px, 100%); margin: auto; padding: 24px; }
  nav { display: flex; flex-wrap: wrap; gap: 12px 24px; border-bottom: 1px solid #333; }
  a { color: #9dbdff; text-underline-offset: 4px; }
  a:focus-visible { outline: 2px solid #9dbdff; outline-offset: 4px; }
  h1 { font-size: clamp(30px, 6vw, 46px); line-height: 1.25; }
  h2 { margin-top: 2.2em; font-size: 25px; }
  h3 { font-size: 19px; }
  p, li { overflow-wrap: anywhere; }
  li { margin: 10px 0; }
  .intro { font-size: 20px; color: #d4dcec; }
  .actions { display: flex; flex-wrap: wrap; gap: 16px; margin: 28px 0; }
  .actions a { padding: 10px 18px; border: 1px solid #5475ae; border-radius: 10px; }
  .note { padding: 18px; background: #1b2230; border-radius: 12px; }
  code { font-size: .9em; background: #222; padding: 2px 5px; border-radius: 4px; }
  footer { border-top: 1px solid #333; color: #aaa; font-size: 14px; }
</style>
</head>
<body>
<nav aria-label="导航"><a href="/">打开当前图片池</a><a href="#setup">部署教程</a><a href="#faq">常见问题</a><a href="${REPO}">GitHub 源码</a></nav>
<main>
<p>开源 · 自部署 · 跨设备暂存</p>
<h1>shotsync：截图和文字，换台设备接着用。</h1>
<p class="intro">shotsync 是一个运行在你自己的 Cloudflare 账号中的图片与文字暂存工具。在电脑上传截图，稍后从手机保存；在手机发一段文字，回到电脑复制。两台设备无需同时在线，也无需连接同一个 Wi-Fi。</p>
<div class="actions"><a href="https://shotsync-demo.defiabell.workers.dev/">体验只读演示</a><a href="${REPO}#deploy-your-own-5-min">部署自己的 shotsync</a></div>
<p class="note">演示站只有公开样例，不提供访客上传。想同步自己的内容，需要先部署独立实例。</p>

<section aria-labelledby="use"><h2 id="use">适合什么场景？</h2>
<ul><li>工作时截一张图，过一会儿在另一台电脑或手机取走。</li><li>把照片、链接或一段纯文字暂存在自己的池子，代替给自己发消息。</li><li>给别人发送单个内容的临时分享链接，不开放整个图片池。</li></ul>
<p>它需要互联网连接，适合个人或可信的小圈子。它不是多人网盘、长期备份服务，也不适合视频和任意类型的大文件传输。</p></section>

<section aria-labelledby="devices"><h2 id="devices">手机和电脑怎么用？</h2>
<p>主界面是浏览器中的 PWA，无需安装原生应用。手机和电脑打开同一个部署地址，输入相同的访问 token，就可以访问同一份图片和文字。当前界面使用中文。</p>
<ol><li>在电脑打开自己的 shotsync，输入部署时设置的 token。</li><li>点击「+ 图片」上传截图，或点击「✎ 文字」发送文字片段。</li><li>在手机浏览器打开相同地址并输入 token。图片池约每 20 秒自动刷新一次。</li><li>点开内容，选择「保存」或「复制」。也可以从 Safari 分享菜单添加到主屏幕。</li></ol>
<p>可选的 <a href="${REPO}/tree/main/mac">macOS 菜单栏客户端</a>支持自动上传新截图，需要 macOS 13+ 和本地构建。iPhone 上可按 <a href="${REPO}/tree/main/shortcut">iOS 快捷指令教程</a>从其他 App 分享图片到池子。</p></section>

<section aria-labelledby="setup"><h2 id="setup">如何自部署 shotsync？</h2>
<p>后端由一个 Cloudflare Worker 和一个 R2 存储桶组成。你需要自己的 Cloudflare 账号、启用 R2，以及能运行项目工具链的 Node.js 环境。</p>
<ol><li>从 <a href="${REPO}">GitHub 仓库</a>克隆源码，安装依赖，使用 Wrangler 登录自己的 Cloudflare 账号。</li><li>创建 R2 存储桶，使其名称与项目的 <code>wrangler.toml</code> 配置一致。</li><li>生成足够长的随机 token，通过 Wrangler secret 设置 <code>AUTH_TOKEN</code>，然后部署 Worker。</li><li>在每台设备打开部署地址，输入同一个 token。</li><li>在 R2 的 Object lifecycle rules 中设置创建 30 天后删除对象。</li></ol>
<p><strong>30 天删除需要你配置 R2 生命周期规则，Worker 本身不会自动建立这条规则。</strong>重要文件请保留其他副本。完整命令及配置以 <a href="${REPO}#deploy-your-own-5-min">仓库部署说明</a>为准。</p>
<p>代码采用 MIT 许可证。运行费用由你的 Cloudflare 用量和当前套餐决定，免费额度并不代表无限使用；部署前查看 <a href="https://developers.cloudflare.com/workers/platform/pricing/">Workers</a> 和 <a href="https://developers.cloudflare.com/r2/pricing/">R2 官方计费说明</a>。</p></section>

<section aria-labelledby="privacy"><h2 id="privacy">数据、访问权限与限制</h2>
<ul><li><strong>数据位置：</strong>自部署后，内容存放在你自己的 Cloudflare R2 中，由你的 Worker 提供访问。它仍然是云存储，不是仅在设备之间传输，也没有应用层端到端加密。</li>
<li><strong>共享 token：</strong>持有 token 的人可以查看、上传和删除整个池子的内容。没有独立用户、分级权限或团队管理。</li>
<li><strong>本机凭证：</strong>网页将 token 保存在当前浏览器的 localStorage 中。公共设备用完应退出登录。</li>
<li><strong>公开分享：</strong>单项分享链接有效期为 7 天，任何拿到链接的人都能查看该项。内容提前删除后，链接也会失效。</li>
<li><strong>大小与格式：</strong>单项主文件上限为 25 MiB。支持图片和纯文字；浏览器上传图片时会转换为 JPEG 并生成缩略图，不用于保留原始图片格式。</li>
<li><strong>保留时间：</strong>按部署说明配置后，R2 按 30 天生命周期规则清理对象。shotsync 用于暂存，不用于归档。</li></ul></section>

<section aria-labelledby="faq"><h2 id="faq">常见问题</h2>
<h3>发送设备必须一直开着吗？</h3><p>不用。上传完成后，另一台设备可以稍后通过互联网取回，直到内容被手动删除或被 R2 生命周期规则清理。</p>
<h3>能直接用公开演示同步自己的截图吗？</h3><p>不能。演示是只读样例池；自己的数据应放在自己部署的实例中。</p>
<h3>token 泄露了怎么办？</h3><p>在自己的 Worker 上更新 <code>AUTH_TOKEN</code>，并在各设备重新输入。更新 token 也会使此前签发的分享链接失效。</p>
<h3>为什么上传后另一台设备看不到？</h3><p>先确认两台设备打开的是同一个部署地址，token 一致，上传已成功。等待一次自动刷新；如果仍失败，检查浏览器请求及 Worker 日志。仅打开网页不能完成设备间同步，内容必须先上传成功。</p></section>

<section lang="en" aria-labelledby="english"><h2 id="english">What is shotsync?</h2><p>shotsync is an open-source, self-hosted image and text pool built with Cloudflare Workers and R2. Upload a screenshot or text snippet on one device and retrieve it later on another. The browser/PWA client uses one shared access token; optional macOS and iOS Shortcut integrations are available. Configure R2 lifecycle rules for 30-day retention. It is a personal transit pool, not an archive or a multi-user file service.</p></section>
</main>
<footer>由 <a href="https://github.com/Defiabell">Jinkun Sun</a> 开发 · <a href="${REPO}">开源代码与使用说明</a> · 内容核对：2026-09-18</footer>
</body></html>`;

export function robotsTXT(isDemo: boolean): string {
  return `User-agent: *\nDisallow: /api/\nDisallow: /i/\nDisallow: /s/\n${isDemo ? `Sitemap: https://shotsync-demo.defiabell.workers.dev/sitemap.xml\n` : ""}`;
}

export function sitemapXML(isDemo: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${isDemo ? `<url><loc>${PRODUCT_URL}</loc></url>` : ""}</urlset>`;
}
