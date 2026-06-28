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

## Use it

- **Any device**: open your Worker URL, enter the token once (stored in `localStorage`), then "Add to Home Screen" for an app-like PWA.
- **Upload**: `+ image` picks from gallery/camera (converted client-side); `✎ text` pastes a snippet.
- **Save**: open an item → Save (mobile: share to Photos; desktop: download).
- **Share**: open an item → Share → a 7-day signed public link is copied to your clipboard.
- **iOS share-sheet upload** (optional): set up the Shortcut described in [`shortcut/README.md`](shortcut/README.md).

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
