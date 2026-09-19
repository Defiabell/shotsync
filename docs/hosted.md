# Hosted ShotSync beta

The hosted entry point (`src/hosted/index.ts`) adds verified email accounts and private per-account pools. It is a separate Worker, D1 database and R2 bucket. Existing personal deployments and the read-only demo retain their token-based behavior. The hosted instance is not yet deployed; no sender domain or sending permissions have been configured.

## What people can do

Register with an email and password, complete Turnstile, then verify the email and choose the password on the verification page. Requiring the mailbox owner to choose the final password prevents pre-registration account takeover. After login, upload images or plain text and retrieve them on another device. Password reset invalidates all old browser sessions, device tokens and outstanding account links.

Browser sessions use Secure/HttpOnly/SameSite cookies. Mac and iOS clients use individually revocable device tokens (shown once, maximum 10, expire after 90 days). Use the hosted origin as the existing client's base URL and the device token as its bearer credential; the multipart `full`/optional `thumb` upload protocol is retained. Browser gallery JSON is specific to hosted mode.

File access, deletion and sharing resolve ownership from authenticated account IDs, never from caller-supplied user IDs. Files are not end-to-end encrypted: the service operator has access to storage. The UI doesn't persist credentials/files in localStorage or a service worker. Shared links are bearer credentials: anyone holding one can access its file until expiry or revocation.

## Initial hard limits

| Scope | Limit |
|---|---|
| Verified registrations | 100, atomically admitted on email verification |
| Pending registrations | 200 total, at most 200 new attempts/day; mail budget reserved before hashing/insertion |
| Per-account stored files | 100 files / 200 MiB, including thumbnails and pending reservations |
| Per-account upload allowance | 50 attempts / 100 MiB per UTC day |
| Per upload | Image 10 MiB; text 100 KiB; JPEG thumbnail 1 MiB; bounded multipart overhead 64 KiB |
| Upload bursts | 10/min/account; global simultaneous upload 1 (conservative memory bound) |
| Global upload allowance | 2,000 attempts / 2 GiB per UTC day; stored data 10 GiB |
| Downloads, including previews and shared links | Per account 2,000 requests / 1 GiB per UTC day; globally 20,000 / 20 GiB |
| Authenticated API frequency | 120/min/account; shared reads count against owner |
| API/share ingress | 120/min/IP, 600/min globally; D1-backed fixed windows |
| Password derivation | 120/min globally, concurrent 1, with expiring D1 lease |
| Outbound account emails | 3/address/hour, 10/IP/hour, 200/day globally; Turnstile required |
| Retention | 7 days; access denied immediately at expiry, cron deletes objects subsequently |
| Share links | One active link/file, up to 24 hours or file expiry, 50 accesses; owner can revoke |

Limits are launch defaults, not a capacity benchmark. Fixed windows may permit boundary bursts. Application limits do not cap the cost of requests reaching Cloudflare: rejected traffic still executes a Worker and some D1 queries. Billing notifications are not a hard spending cap. Configure edge protections and inspect account-level usage before raising limits or registration capacity. Resources within the same Cloudflare account may still share platform quotas.

`LIMITS` exposes UI values; matching constants in SQL triggers enforce atomic global and per-user limits. Changing limits requires a reviewed migration and matching UI constants, not only a JavaScript edit. `REGISTRATION_LIMIT` may lower the 100-person beta cap. `UPLOADS_ENABLED=0` stops new uploads while retaining limited download/deletion. No automatic paid subscription or plan upgrade is performed.

## Upload accounting and cleanup

Before reading a body, reserve the entire declared multipart Content-Length, or the maximum envelope if absent. Count actual bytes while reading with a 30-second deadline; dishonest Content-Length cannot bypass the bound. This may conservatively reject a request near quota until its small envelope fits. A SQL trigger atomically reserves account/global storage and daily allowance; a second request cannot observe stale remaining capacity.

On successful R2 writes, shrink the reservation to actual full+thumbnail bytes. Deleting successful files releases storage but **does not refund today's upload allowance**. Failed uploads consume an attempt but release reserved bytes after object deletion succeeds. This prevents endless upload/delete cycles from bypassing daily limits.

Pending uploads expire after five minutes; the one-minute cron reclaims them, expired files and failed deletions in batches of 100. A failed R2 delete retains the quota reservation for retry. A late writer whose lease was reclaimed cannot commit and attempts to remove its objects. Configure an eight-day R2 lifecycle as a backstop for physical orphans; app expiry remains seven days. Cleanup batches can take multiple ticks, so no exact physical deletion time is promised. Lifecycle deletion alone must not be used as the quota ledger.

## Deploy prerequisites

1. Node.js 22+, a Cloudflare account eligible for outbound Email Sending (currently requires Workers Paid), and a sender domain onboarded for transactional email. No real emails are sent by automated tests.
2. Dedicated Worker `shotsync-hosted`, R2 bucket `shotsync-hosted`, and D1 database `shotsync-hosted`. Never bind the personal or demo bucket. Put the returned D1 UUID into `wrangler.hosted.jsonc`.
3. Set `PUBLIC_ORIGIN` to the final HTTPS origin, `EMAIL_FROM` to the verified sender, and `TURNSTILE_SITE_KEY` to a widget restricted to that hostname. Store `TURNSTILE_SECRET_KEY` as a Worker secret. No other site's Turnstile keys are reused.
4. Configure the bucket's eight-day lifecycle and observability/billing alerts. Review registration and upload caps. Use a custom domain if stronger edge rules are needed.
5. With explicit deployment authorization: `npm run deploy:hosted`. It checks placeholders, applies the new hosted database migrations, then deploys the Worker. Do not run any personal/demo setup or seed scripts.
6. Test one real email address controlled by the operator: registration, mailbox verification, login, reset, and cross-device transfer. Confirm Turnstile hostname validation, cron cleanup and dashboard metrics. A provider accepting a send is not proof of inbox delivery.

The checked-in config deliberately contains a local origin, blank sender and placeholder DB UUID; the deployment preflight refuses these values. Run `npm run dev:hosted` only for local development. Local HTTPS is needed for browser session cookies; see the browser test for a fully isolated fixture environment.

## Verification and rollback

- `npm test`: existing personal/demo regressions plus account, security, concurrency, quota and cleanup tests against local Workers/D1/R2; email and Turnstile are mocked.
- `npm run typecheck` and `npm run types:hosted`.
- `npx playwright install chromium && npm run test:browser`: isolated temporary local D1/R2, HTTPS browser login, upload/preview, device token access, anonymous denial, share/revoke, deletion and logout. Never contacts production or sends mail.
- `npx wrangler deploy --config wrangler.hosted.jsonc --dry-run`.

To suspend new writes, set `UPLOADS_ENABLED=0` and deploy. Retain the hosted database/bucket; do not drop tables or remove user data during rollback. The original self-hosted app and demo are independent entry points. Account tokens, session tokens and device tokens are stored as hashes; password hashes use scrypt N=16384/r=8/p=5 with random salts.

Official references: [Email Service](https://developers.cloudflare.com/email-service/), [D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/), [R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Toolchain note: the compatible Vitest/Workers test stack currently reports development-only npm advisories (8 at implementation time); these packages are not imported by the deployed Worker. Run development servers on loopback only. The package resolver rejected the newest advertised Wrangler version with a publication-date cutoff; this change uses the resolved lockfile and its supported compatibility date. Track the toolchain updates separately before exposing any development server.
