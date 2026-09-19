English | [简体中文](README.zh-CN.md)

# shotsync

Your own cross-device image & text pool, deployable to Cloudflare's free tier in a few minutes. Drop a screenshot or photo on one device, grab it on another. No app to install (the phone client is a PWA), no third-party image host — your data lives only in your own Cloudflare account.

**🎬 Live demo (read-only sample pool): https://shotsync-demo.defiabell.workers.dev**

**Product overview & setup guide:** https://shotsync-demo.defiabell.workers.dev/about

## Choose how to use ShotSync

**Self-hosting is the default: no ShotSync account, Supabase, D1 or email service is required.** Deploy to your Cloudflare account and enter the same access token on each device.

| Mode | Best for | Access | File storage |
| --- | --- | --- | --- |
| **Self-hosted (default)** | Your own image and text pool | Deploy, then enter your own `AUTH_TOKEN` | Your Cloudflare R2 |
| Hosted service (beta) | Using the operator's service without deploying | Register/sign in at the hosted URL | The operator's Cloudflare R2 |
| Read-only demo | Exploring the interface | Open the demo above; uploads are disabled | Public samples |

For self-hosting, follow [the steps below](#deploy-your-own-5-min). See the [hosted guide](docs/hosted.md) for availability and quotas: the current beta still has a Free-plan CPU limitation and its authentication upgrade is not deployed. [Mode details and FAQ](docs/deployment-modes.md).

![shotsync gallery](docs/screenshot.png)

## What it is

A single **Cloudflare Worker + R2 bucket** backing a small **PWA gallery**:

- Upload **images** (auto-converted to JPEG + thumbnailed client-side) and **text** snippets.
- View a newest-first feed on any device; tap to view full, **save/download**, or **delete**.
- Mint a **signed, expiring public link** to share one item — without exposing the rest of the pool.
- **Token-gated**: one shared secret unlocks the pool; everything else stays private.
- A **30-day transit pool** (auto-deleted), not an archive.

## Why

iCloud / AirDrop / network drives / public image hosts are either manual, ecosystem-locked, or route your (possibly work) screenshots through someone else's cloud. shotsync is a self-hosted, free, privacy-respecting take: data only moves between your devices and your own Cloudflare account.

## How it compares (LocalSend, PairDrop, messaging yourself)

The dividing line is **a live transfer vs. a pool that waits**. LocalSend and PairDrop connect two devices that are both awake right now and stream between them. shotsync keeps the item for 30 days, so the sending device can be asleep, on a different network, or in another country by the time you pick it up.

|  | shotsync | [LocalSend](https://localsend.org) | [PairDrop](https://pairdrop.net) |
| --- | --- | --- | --- |
| Both devices online at once | not required | required | required |
| Install | none (PWA in the browser) | an app on every device | none (browser) |
| Across different networks | yes | no — same local network | via a temporary public room |
| Where the bytes go | your own Cloudflare R2 | device to device, no server | peer-to-peer, public signalling server |
| Left behind after transfer | 30 days, browsable | nothing | nothing |
| Setup | deploy once, ~5 min | install, then open | just open the page |
| Per-item size limit | 25 MB | bounded by disk | bounded by the connection |

**Choose LocalSend if** both devices are on the same Wi-Fi, both in front of you, and the file is large. It is peer-to-peer, has no practical size ceiling, and needs no internet at all.

**Choose PairDrop if** you want zero setup and would rather not deploy anything. It is the shortest path from nothing to a transferred file.

**Choose shotsync if** you keep sending yourself screenshots and want them still there when you sit back down hours later, on a different machine, on a different network — and you would rather they lived in your own Cloudflare account than on a public image host. It replaces the habit of messaging things to yourself, not AirDrop.

**The default self-hosted mode has no per-user accounts:** one shared token unlocks the whole pool. Use the separate hosted mode if you need isolated accounts. See the "Security model & limitations" section below before deploying.

## Features

- Cross-device image + text pool (a shared clipboard + screenshot drop)
- PWA gallery — "Add to Home Screen", no native app, no App Store
- Client-side HEIC→JPEG + thumbnail generation (mobile-friendly; the Worker does no image processing)
- Signed, expiring public share links (HMAC-SHA256, 7 days)
- Per-item save/download + multi-select batch delete
- Single-token auth, constant-time compare, token never in URLs
- 30-day auto-retention via R2 lifecycle
- Runs entirely on the Cloudflare free tier (Workers + R2)
- Tests (Vitest + `@cloudflare/vitest-pool-workers`)

## Deploy your own (~5 min)

Prereqs: a Cloudflare account, Node.js 22+, and **R2 enabled** (Dashboard → R2 → enable; Cloudflare asks for a card even on the free tier — the free allowance is not charged).

```bash
git clone https://github.com/Defiabell/shotsync
cd shotsync
npm install
npx wrangler login

# 1. create the R2 bucket (name must match bucket_name in wrangler.toml)
npx wrangler r2 bucket create shotsync

# 2. set the shared access token — any long random string; you enter it on each device
openssl rand -hex 24                  # generate one, copy it
npx wrangler secret put AUTH_TOKEN --config wrangler.toml --env ""    # paste it when prompted

# 3. deploy
npm run deploy
```

You also need a **workers.dev subdomain** (Dashboard → Workers & Pages, one-time) or a custom domain. After deploy you get `https://shotsync.<your-subdomain>.workers.dev`.

`npm run deploy` explicitly uses `wrangler.toml` and deploys only the personal pool. It does not create an account database, request Supabase keys, or deploy the hosted service. `AUTH_TOKEN` is the ShotSync passphrase you generate, not a Cloudflare API token or Supabase key. Save it and share it only with people allowed to access the entire pool.

After deployment, open the same URL and enter the same token on two devices. Upload a short text snippet and check it appears on the other device. An email registration screen means you opened the hosted service; use the personal URL returned by Wrangler instead.

### 30-day retention

Dashboard → R2 → bucket `shotsync` → Settings → Object lifecycle rules → delete objects 30 days after creation.

This rule must be configured explicitly: the Worker does not create it automatically.

### Public product page and indexing

`/about` serves a static product overview without requiring JavaScript or a token. The gallery remains at `/` and links to it. Only the public demo advertises `/about` in `/sitemap.xml`; private deployments send `X-Robots-Tag: noindex, follow` for their copy. The gallery is marked `noindex, follow`, and `/robots.txt` excludes API, image, and share paths from crawling. These indexing hints are not access controls: the normal token and signed-link rules still apply.

## Using it

The UI labels are in Chinese; the English in parentheses below maps each step to the button you'll see.

### 1. First time, on each device
1. Open your Worker URL (e.g. `https://shotsync.<subdomain>.workers.dev`).
2. Enter your `AUTH_TOKEN` when prompted — it's saved in `localStorage`, so you won't be asked again on that device.
3. (Optional) In Safari: **Share → Add to Home Screen** to install it as a PWA. It then runs full-screen like an app.

The gallery shows every item newest-first and auto-refreshes every ~20 s, so anything uploaded from another device appears within seconds.

### 2. Add things to the pool
- **Image** — tap **`+ 图片`** (Add image): pick from photos or camera. It's converted to JPEG and thumbnailed in your browser, then uploaded.
- **Text** — tap **`✎ 文字`** (Text), paste/type a snippet, then **`发送`** (Send). It becomes a text card — a cross-device clipboard.
- **Mac screenshots, automatically** — install the [Mac menu-bar app](mac/README.md): every screenshot uploads on its own.
- **iOS share sheet** — set up the [Shortcut](shortcut/README.md) to push an image from any app's share sheet.

### 3. Open one item (tap it)
Tap any thumbnail/card to open it full-screen, then:
- **`保存` / `复制`** (Save / Copy) — image: save to Photos (mobile) or download (desktop); text: copy to clipboard.
- **`分享`** (Share) — mint a **7-day public link** to just that item, copied to your clipboard. Anyone with the link can view that one item; the rest of the pool stays private.
- **`删除`** (Delete) — remove this item.
- **`关闭`** (Close) — back to the gallery.

### 4. Delete many at once
1. Tap **`选择`** (Select) to enter selection mode.
2. Tap items to check them (blue outline); tap again to uncheck.
3. Tap **`删除选中 (N)`** (Delete selected) → confirm. Or **`取消`** (Cancel) to leave without deleting.

### 5. See your token, set up another device, or log out
Tap **`⚙`** in the top bar. The panel shows this pool's URL and the token this device holds — masked by default, because the Mac app auto-uploads screenshots and a plaintext token on screen is one ⌘⇧3 away from landing in the pool.
- **`显示`** (Show) toggles the full token; **`复制`** (Copy) puts it on the clipboard for pasting into another device.
- **`退出登录`** (Log out) forgets the token on this device and returns to the token prompt. Nothing changes server-side; the same token still works elsewhere.

## Security model & limitations

- **Single shared token.** Anyone with the URL **and** token can view/upload/delete. This is a single-user / trusted-circle tool, not multi-tenant — there are no per-user accounts and no way to "switch" tokens on one pool; a second pool is a second Worker deployment. Rotate with `npx wrangler secret put AUTH_TOKEN --config wrangler.toml --env ""` — note this also invalidates all live share links, since the token is the link signing key.
- **Share links are public** until they expire (7 days): anyone with the link can see that one item.
- **Transit pool, not an archive.** Items auto-delete after 30 days by design.
- **The UI is currently in Chinese.** i18n PRs welcome.
- The Worker stores received bytes as-is (no server-side image processing); format conversion and thumbnails happen on the client.

## Development

```bash
npm test          # Vitest (workers pool) — full suite
npx tsc --noEmit  # type-check
npm run dev       # local dev — create a .dev.vars with AUTH_TOKEN=<anything>
```

## License

[MIT](LICENSE)

## Hosted accounts (public beta)

An optional, separate hosted deployment supports email/password accounts with recovery codes (no email delivery), private file pools, revocable device tokens and strict account/global usage limits. [Try the hosted beta](https://shotsync-hosted.defiabell.workers.dev) (100 accounts). It runs on Workers Free, but measured login CPU exceeds the nominal free budget and may be throttled under load. Deployment prerequisites and limits are in [docs/hosted.md](docs/hosted.md). Existing self-hosted and read-only demo deployments keep their current behavior. Tooling now requires Node.js 22+.

The next managed-auth version delegates password work to Supabase Auth; deployment requires a dedicated personal project and is blocked until its configuration is supplied. See the migration and failure-recovery notes in the hosted guide.
