# Cloudflare production delivery

Production origin: https://agents-cp.runlumi.app
Worker: lumi-agents-control-plane-api-production
Account: RunLumi (`73fe06de8746378768229a64680dd62f`)
D1: lumi-agents-control-plane (`3cc54c20-2b3c-4ad2-a3b3-6d2d19d5d0f1`)
Private R2: lumi-agents-control-plane-exports
Queues: lumi-agents-outbox, lumi-agents-outbox-dlq, lumi-agents-jobs,
lumi-agents-jobs-dlq. Cron: every minute, preserving bounded domain sweeps.

## Deploy

Use the pinned Node 24, pnpm and worker-build toolchain from the quality workflow.
`pnpm build` builds web first, then the production Worker dry-run.

```sh
pnpm build
pnpm --filter @runlumi/agents-cp-api exec wrangler whoami
pnpm --filter @runlumi/agents-cp-api exec wrangler d1 migrations apply DB --remote --env production
pnpm --filter @runlumi/agents-cp-api exec wrangler deploy --env production
node apps/api/scripts/smoke-production.mjs
```

The custom-domain route creates managed DNS and TLS. SPA fallback is restricted
by explicit /api and /api/* Worker-first patterns. workers.dev and preview URLs
are disabled; passkeys bind only to the canonical production domain.

## CI

Checks runs quality for PRs and main. The deployment job runs only on main after
quality passes. It serializes uploads, checks main freshness immediately before
migrations and skips superseded commits. Manual workflow dispatch on main also
runs quality. No PR code receives a deployment step.

`CLOUDFLARE_API_TOKEN` is stored in repository Actions secrets. The account-owned
agents-cp-github-production token has Workers Editor, D1 Write, Queues Write,
Workers R2 Storage Write for RunLumi, and Zone Read/Workers Routes Write only for
runlumi.app. Account resource permissions cover that account's resources; this
is not per-database isolation. Revoke it when CI is retired, or rotate it by
creating a replacement and updating the secret before revoking the old token.

## Runtime prerequisites

Email Sending is enabled for runlumi.app. EMAIL_FROM is agents@runlumi.app and
EMAIL is bound; inbox delivery requires its own test and is not inferred from
an upload. Provider credentials and provider allowlist are separate from hosting.

Production CREDENTIAL_ENCRYPTION_KEY and WEBHOOK_SECRET_KEY must be random 32-byte
lowercase hex Worker secrets. LICENSE_SIGNING_SECRET is key_id:base64_pkcs8_der.
SENTRY_DSN is optional. Never put values in Wrangler vars or Git. Inspect names
with `wrangler secret list --env production`, configure using secret put/bulk,
and retain encryption/signing keys in approved secure storage before using them.
Absent secrets keep dependent operations fail-closed.

## Migration and recovery

All 22 existing migrations applied to the new production database on 2026-10-02.
Subsequent migrations must remain compatible with the old Worker until upload
succeeds. A failed migration prevents deployment. Worker rollback does not undo
D1 changes: use Wrangler rollback for application recovery while preserving D1,
private R2, queue state and secrets. Follow backup-restore.md for reviewed data
recovery; never restore/drop production automatically from a failed CI run.

## Evidence boundary

Hosting smoke checks root/deep-link HTML, Rust health under browser navigation,
unknown API fallback, anonymous refusal and absence of development internals.
These do not certify production email, provider billing, export queue delivery,
all authenticated flows, or production-scale restore/SLOs.
