# shotsync

Your own cross-device image & text pool, deployable to Cloudflare's free tier in a few minutes. Drop a screenshot or photo on one device, grab it on another. No app to install (the phone client is a PWA), no third-party image host — your data lives only in your own Cloudflare account.

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

## Features

- Cross-device image + text pool (a shared clipboard + screenshot drop)
- PWA gallery — "Add to Home Screen", no native app, no App Store
- Client-side HEIC→JPEG + thumbnail generation (mobile-friendly; the Worker does no image processing)
- Signed, expiring public share links (HMAC-SHA256, 7 days)
- Per-item save/download + multi-select batch delete
- Single-token auth, constant-time compare, token never in URLs
- 30-day auto-retention via R2 lifecycle
- Runs entirely on the Cloudflare free tier (Workers + R2)
- ~50 tests (Vitest + `@cloudflare/vitest-pool-workers`)

## Deploy your own (~5 min)

Prereqs: a Cloudflare account, Node 18+, and **R2 enabled** (Dashboard → R2 → enable; Cloudflare asks for a card even on the free tier — the free allowance is not charged).

```bash
git clone https://github.com/Defiabell/shotsync
cd shotsync
npm install
npx wrangler login

# 1. create the R2 bucket (name must match bucket_name in wrangler.toml)
npx wrangler r2 bucket create shotsync

# 2. set the shared access token — any long random string; you enter it on each device
openssl rand -hex 24                  # generate one, copy it
npx wrangler secret put AUTH_TOKEN    # paste it when prompted

# 3. deploy
npm run deploy
```

You also need a **workers.dev subdomain** (Dashboard → Workers & Pages, one-time) or a custom domain. After deploy you get `https://shotsync.<your-subdomain>.workers.dev`.

### 30-day retention

Dashboard → R2 → bucket `shotsync` → Settings → Object lifecycle rules → delete objects 30 days after creation.

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

## Security model & limitations (please read)

- **Single shared token.** Anyone with the URL **and** token can view/upload/delete. This is a single-user / trusted-circle tool, not multi-tenant. Rotate with `npx wrangler secret put AUTH_TOKEN` — note this also invalidates all live share links, since the token is the link signing key.
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
