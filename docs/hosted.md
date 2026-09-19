# Hosted ShotSync beta

> This guide is for operators running a multi-user service. To deploy a personal pool without accounts, use the [default README instructions](../README.md#deploy-your-own-5-min): Worker + R2 + `AUTH_TOKEN`, with no D1 or Supabase. See [mode selection](deployment-modes.md).

The hosted entry point (`src/hosted/index.ts`) adds email/password accounts with recovery codes and private per-account pools. It is a separate Worker, D1 database and R2 bucket. Existing personal deployments and the read-only demo retain their token-based behavior. The existing [hosted beta](https://shotsync-hosted.defiabell.workers.dev) still uses the previous local password implementation until the managed-auth migration below is configured and deployed; email delivery and a sender domain are not required.

## What people can do

Register with an email and password, complete Turnstile, and save the recovery code shown once before signing in. The email is an unverified username, not proof of mailbox ownership. Recovery requires the email, recovery code and a new password; a successful reset replaces the recovery code and invalidates all old sessions and device tokens. Save the replacement code. Losing both password and recovery code means there is no self-service recovery; no reset emails are sent.

Supabase Auth now owns password storage and verification. The Worker calls its HTTPS API only during registration, login and recovery; there is no PBKDF2/scrypt fallback. Provider access/refresh tokens are never sent to the browser or accepted as ShotSync credentials. D1 retains user IDs, opaque cookie sessions, device tokens, recovery-code hashes and quotas; R2 retains files. Ordinary file requests do not contact Supabase.

Accounts are specific to ShotSync: using the same registration style as Yixi does not share accounts or its database. A dedicated personal Supabase project is required. Public Supabase signup must be disabled; ShotSync performs admin creation only after its own Turnstile and admission checks. Admin creation uses `email_confirm: true` only to allow password sign-in without mail; it is not evidence of mailbox ownership. IDs and server-controlled application metadata bind identities, never an email match alone. `verified_at` remains NULL for new accounts and is reserved for a future, explicit mailbox verification flow. Never link accounts across products or grant mailbox-based trust from an email string alone. Migration `0003_recovery.sql` only adds a nullable hash column; it does not mark existing accounts verified, delete users, or give legacy accounts guessed recovery codes. The obsolete mail-token table is retained for non-destructive migration compatibility, but mail endpoints and delivery code are removed.

Browser sessions use Secure/HttpOnly/SameSite cookies. Mac and iOS clients use individually revocable device tokens (shown once, maximum 10, expire after 90 days). Use the hosted origin as the existing client's base URL and the device token as its bearer credential; the multipart `full`/optional `thumb` upload protocol is retained. Browser gallery JSON is specific to hosted mode.

File access, deletion and sharing resolve ownership from authenticated account IDs, never from caller-supplied user IDs. Files are not end-to-end encrypted: the service operator has access to storage. The UI doesn't persist credentials/files in localStorage or a service worker. Shared links are bearer credentials: anyone holding one can access its file until expiry or revocation.

## Initial hard limits

| Scope | Limit |
|---|---|
| Registered accounts | 100 total, atomically admitted on registration |
| Per-account stored files | 100 files / 200 MiB, including thumbnails and pending reservations |
| Per-account upload allowance | 50 attempts / 100 MiB per UTC day |
| Per upload | Image 10 MiB; text 100 KiB; JPEG thumbnail 1 MiB; bounded multipart overhead 64 KiB |
| Upload bursts | 10/min/account; global simultaneous upload 1 (conservative memory bound) |
| Global upload allowance | 2,000 attempts / 2 GiB per UTC day; stored data 10 GiB |
| Downloads, including previews and shared links | Per account 2,000 requests / 1 GiB per UTC day; globally 20,000 / 20 GiB |
| Authenticated API frequency | 120/min/account; shared reads count against owner |
| API/share ingress | 120/min/IP, 600/min globally; D1-backed fixed windows |
| Provider password requests | 120/min globally; concurrent sign-in 1 with expiring D1 lease; mutations use persistent state |
| Registration/recovery | Turnstile and per-address/IP/global request limits; no outbound mail |
| Retention | 7 days; access denied immediately at expiry, cron deletes objects subsequently |
| Share links | One active link/file, up to 24 hours or file expiry, 50 accesses; owner can revoke |

Limits are launch defaults, not a capacity benchmark. Fixed windows may permit boundary bursts. Application limits do not cap the cost of requests reaching Cloudflare: rejected traffic still executes a Worker and some D1 queries. Billing notifications are not a hard spending cap. Configure edge protections and inspect account-level usage before raising limits or registration capacity. Resources within the same Cloudflare account may still share platform quotas.

`LIMITS` exposes UI values; matching constants in SQL triggers enforce atomic global and per-user limits. Changing limits requires a reviewed migration and matching UI constants, not only a JavaScript edit. `REGISTRATION_LIMIT` may lower the 100-person beta cap. `UPLOADS_ENABLED=0` stops new uploads while retaining limited download/deletion. No automatic paid subscription or plan upgrade is performed.

## Upload accounting and cleanup

Before reading a body, reserve the entire declared multipart Content-Length, or the maximum envelope if absent. Count actual bytes while reading with a 30-second deadline; dishonest Content-Length cannot bypass the bound. This may conservatively reject a request near quota until its small envelope fits. A SQL trigger atomically reserves account/global storage and daily allowance; a second request cannot observe stale remaining capacity.

On successful R2 writes, shrink the reservation to actual full+thumbnail bytes. Deleting successful files releases storage but **does not refund today's upload allowance**. Failed uploads consume an attempt but release reserved bytes after object deletion succeeds. This prevents endless upload/delete cycles from bypassing daily limits.

Pending uploads expire after five minutes; the one-minute cron reclaims them, expired files and failed deletions in batches of 100. A failed R2 delete retains the quota reservation for retry. A late writer whose lease was reclaimed cannot commit and attempts to remove its objects. Configure an eight-day R2 lifecycle as a backstop for physical orphans; app expiry remains seven days. Cleanup batches can take multiple ticks, so no exact physical deletion time is promised. Lifecycle deletion alone must not be used as the quota ledger.

## Deploy prerequisites

1. Node.js 22+, Cloudflare Workers/D1/R2, and a **dedicated personal Supabase Free project**. Password computation runs at Supabase, outside Worker CPU. Measure complete live routes before claiming Free-plan capacity; local or mocked tests cannot establish production CPU. No sender domain or email service is required. Supabase Free projects may pause after one week of inactivity and are limited to two active projects; it is not an uptime guarantee.
2. Dedicated Worker `shotsync-hosted`, R2 bucket `shotsync-hosted`, and D1 database `shotsync-hosted`. Never bind the personal or demo bucket. Put the returned D1 UUID into `wrangler.hosted.jsonc`.
3. Set `PUBLIC_ORIGIN` to the final HTTPS origin, and `TURNSTILE_SITE_KEY` to a widget restricted to that hostname. Store `TURNSTILE_SECRET_KEY` and `SUPABASE_SECRET_KEY` as Worker secrets. The Supabase secret may be a modern `sb_secret_` key or legacy `service_role` JWT; never expose it to browsers or Wrangler vars. Put only the canonical `https://<20-character-project-ref>.supabase.co` origin in `vars.SUPABASE_URL`. Missing provider configuration fails closed. The old `PASSWORD_PEPPER` is no longer used; retain its secret until the rollout and rollback decision is complete. No other site's Turnstile keys are reused.
4. In the dedicated Supabase project, enable email/password, turn **Allow new users to sign up OFF**, **Confirm email OFF**, anonymous sign-ins OFF and unused external providers OFF. Admin creation still works with public signup disabled. Do not enable a Supabase CAPTCHA requirement for this server-only token flow: ShotSync verifies its own Turnstile before admin registration/recovery. Never reuse a company project or change another app’s settings. Configure the bucket's eight-day lifecycle and observability/billing alerts. Review registration and upload caps. Use a custom domain if stronger edge rules are needed.
5. With explicit deployment authorization: `npm run deploy:hosted`. It checks placeholders (including the required Supabase URL), applies the hosted database migrations, then deploys the Worker. Validate the provider settings and secret first; an incomplete configuration must not be shipped. Migration `0004_managed_auth.sql` preserves existing rows/files and marks old accounts `legacy`: old sessions stop working, and the existing recovery code is required to establish the same account ID at Supabase. No old password hash is uploaded, and local passwords are not silently used as a fallback. Recheck production user count before this migration; existing accounts need the documented recovery path. Do not run any personal/demo setup or seed scripts.
6. Test registration, saving the recovery code, login, recovery-code rotation, rejection of old credentials, and cross-device transfer. Confirm Turnstile hostname validation, cron cleanup and dashboard metrics.

The checked-in config identifies the operator's dedicated hosted resources. For your own deployment, replace the origin, Turnstile site key, D1 ID and bucket with resources in your account; never copy another operator's resource IDs. The preflight rejects missing values and local origins. Run `npm run dev:hosted` only for local development. Local HTTPS is needed for browser session cookies; see the browser test for a fully isolated fixture environment.

## Verification and rollback

- `npm test`: existing personal/demo regressions plus account, security, concurrency, quota and cleanup tests against local Workers/D1/R2; Turnstile is mocked.
- `npm run typecheck` and `npm run types:hosted`.
- `npx playwright install chromium && npm run test:browser`: isolated temporary local D1/R2, HTTPS browser login, upload/preview, device token access, anonymous denial, share/revoke, deletion and logout. Never contacts production or sends mail.
- `npx wrangler deploy --config wrangler.hosted.jsonc --dry-run`.

To suspend new writes, set `UPLOADS_ENABLED=0` and deploy. Retain the hosted database/bucket; do not drop tables or remove user data during rollback. The original self-hosted app and demo are independent entry points. Recovery codes, session tokens and device tokens remain hashed. New D1 user records contain only the marker `external:supabase` in the legacy password column. Passwords are handled by Supabase over HTTPS and never persisted or logged by the Worker. Passwords require at least 10 characters and at most 72 UTF-8 bytes to avoid bcrypt truncation; the UI explains this for non-ASCII passwords.

## Distributed mutation failures

Registration reserves a D1 slot before calling the provider. Active users plus pending reservations cannot exceed the cap. A definite upstream rejection releases the reservation for a new attempt; a timeout, malformed response or uncertain failure retains it because a Supabase user may already exist. Reservations never expire automatically while pending. Do not reassign an identity just because its email matches. A successful response finalizes the reservation and user row in one D1 batch.

Recovery first atomically marks the account `resetting` and increments `auth_version`. All old cookies/devices and in-flight old logins become unusable before the provider mutation. The password update carries a server-owned operation marker for diagnosis. On success, D1 rotates the recovery hash and returns the replacement code. Any uncertain outcome remains locked; the Worker never retries password mutations automatically or unlocks on a timer, because a delayed prior request could overwrite a newer password.

Operator reconciliation is required for interrupted mutations. Inspect D1 `auth_registrations` or `users.auth_operation`, then the **same UUID** at Supabase with matching `shotsync_origin`/`shotsync_user_id`; for reset, inspect `shotsync_operation`. Establish the remote request has completed before any repair. Do not delete pending rows, blindly retry with a different password, auto-link by email, or log raw provider responses. This beta deliberately favors stopping an uncertain operation over unsafe automatic repair. A lost successful response can also lose a newly displayed recovery code; users should keep their known password and contact the operator rather than expecting email recovery.

An ordinary code-only rollback after applying migration 0004 is unsafe: old code does not honor `auth_state`, and managed password records cannot be verified locally. Keep managed auth/state checks and suspend affected operations while repairing. Preserve D1/R2 and provider users; do not delete data or roll back schema destructively.

Official references: [Supabase Auth configuration](https://supabase.com/docs/guides/auth/general-configuration), [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [Supabase Free limits](https://supabase.com/pricing), [D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/), [R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Toolchain note: the compatible Vitest/Workers test stack currently reports development-only npm advisories (8 at implementation time); these packages are not imported by the deployed Worker. Run development servers on loopback only. The package resolver rejected the newest advertised Wrangler version with a publication-date cutoff; this change uses the resolved lockfile and its supported compatibility date. Track the toolchain updates separately before exposing any development server.

Launch preparation (2026-09-19): dedicated D1/R2/Turnstile resources, all three migrations and eight-day object expiry are configured. Cron capacity has been freed. The password implementation supports deploying on Workers Free; deployment does not establish reliable operation within its CPU budget. Remote D1 required parenthesized CASE expressions in migration 0002 without changing quota behavior.

Launch verification (2026-09-20): PR #4 deployed as `b20bde51-2865-4464-a784-1a7e3f51b370`; both secrets are installed and the one-minute cleanup cron is registered. Homepage returns 200 and invalid Turnstile registration returns 403. Five unknown-account login probes (which perform the same PBKDF2/HMAC work) returned 401 normally, with **27–46 ms CPU**, down from prior scrypt probes of 172–326 ms. This still exceeds the documented Workers Free 10 ms CPU budget: burst tolerance allowed these requests, and reliable login under load is not established. No paid upgrade was made and the KDF was not weakened further. Successful login/upload/sharing were verified in the isolated local browser; production registration/recovery remain dependent on a real Turnstile challenge. 115 automated tests, TypeScript, dry run and independent code review passed.

Managed-auth implementation status (2026-09-20): provider adapter, persistent registration/recovery state and tests are implemented. Personal Supabase project credentials are now supplied and encrypted in the private secrets vault; the server secret is installed in Cloudflare. Real provider create/login/password-update/old-password-rejection tests passed and the disposable fixture was removed. The project still needs public signup and email confirmation disabled in the Dashboard before deployment. No migration 0004 or managed-auth deployment has been performed, and no production CPU improvement is claimed for this version. Store the project URL/secret in a mode-0600 local env file outside the repo, then back it up encrypted in the personal secrets vault.
