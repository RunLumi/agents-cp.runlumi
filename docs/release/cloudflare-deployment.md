# Cloudflare production deployment runbook

This is the operating procedure for the deployment introduced by [PR #43](https://github.com/RunLumi/agents-cp.runlumi/pull/43).
Read it before deploying, changing hosting configuration, provisioning secrets,
or recovering production. [ADR 0010](../adr/0010-worker-static-assets-production.md)
records the architecture; this document records operations and proof.

## Source of truth and production identity

| Surface | Authoritative source / configured resource |
| --- | --- |
| Worker bindings, domain, RP/origin, cron | [apps/api/wrangler.jsonc](../../apps/api/wrangler.jsonc), explicit `production` environment |
| Build order and package/tool versions | [package.json](../../package.json), [API package](../../apps/api/package.json), lockfiles |
| Quality and auto-deployment | [.github/workflows/checks.yml](../../.github/workflows/checks.yml) |
| Hosting smoke | [smoke-production.mjs](../../apps/api/scripts/smoke-production.mjs) |
| Canonical origin | `https://agents-cp.runlumi.app` |
| Account | RunLumi: `73fe06de8746378768229a64680dd62f` |
| Worker | `lumi-agents-control-plane-api-production` |
| D1 | `lumi-agents-control-plane`: `3cc54c20-2b3c-4ad2-a3b3-6d2d19d5d0f1` |
| Private R2 export bucket | `lumi-agents-control-plane-exports` |
| Outbox / dead-letter queues | `lumi-agents-outbox`, `lumi-agents-outbox-dlq` |
| Jobs / dead-letter queues | `lumi-agents-jobs`, `lumi-agents-jobs-dlq` |
| Scheduled sweeps | `*/1 * * * *` |
| Authentication origin | RP ID `agents-cp.runlumi.app`; origin `https://agents-cp.runlumi.app` |
| Email | `EMAIL` binding; sender `agents@runlumi.app` |

The existing Rust Worker serves `/api` and `/api/*`; Cloudflare Static Assets
serves `apps/web/dist`, with SPA fallback for UI navigation. Explicit Worker-first
API patterns prevent an API navigation from returning `index.html`. The SPA and
API share one origin, preserving the existing cookie/CSRF model. `workers.dev`
and preview URLs are disabled. Development remains Vite plus the development
Worker; it does not use production D1.

Do not deploy the top-level/default Worker or use `--env development` for
production. Every production Wrangler operation below uses `--env production`.
Never add another `production` key: the original config declared it twice and
silently discarded its email binding.

## Verified delivery record — 2026-10-02

These are dated observations, not a promise that current production still runs
this version. Refresh the deployment list and Actions state for later work.

| Claim | Verdict and evidence |
| --- | --- |
| Deployment changes merged | PASS: [PR #43](https://github.com/RunLumi/agents-cp.runlumi/pull/43), main `a0ea9b6080981a1f20cbb1d92a1aad884813766f` |
| Exact PR head passed quality | PASS: [run 36991725616](https://github.com/RunLumi/agents-cp.runlumi/actions/runs/36991725616), head `faf1440e1a965f6ad4ce97fb0991db2300405927`; PR deployment skipped as intended |
| First main auto-deploy | PASS: [run 36992492079](https://github.com/RunLumi/agents-cp.runlumi/actions/runs/36992492079), quality and deploy succeeded for merged main |
| Active Worker matched main | PASS: 100% version `f23e769c-4c78-4f4d-9f4e-4ed5cf6fd32f`, deployment message equals the full main SHA above |
| Earlier manual upload | PASS: version `96911a8d-3f66-48aa-89fb-141318039a3e`; superseded by the automatic upload |
| Production schema | PASS: remote D1 ledger contained all 22 existing migrations; auto-deploy reported no pending migrations |
| Hosting and public boundaries | PASS: six live smoke checks, repeated after auto-deploy; also passed against local production config |
| Browser rendering | PASS: live HTTPS domain rendered passkey/password sign-in |
| Production passkey login-start | PASS: HTTP 201 and RP ID `agents-cp.runlumi.app`; this starts a ceremony, not a complete login |
| Full local/hosted checks | PASS: `pnpm check`, Worker dry-run, hosted D1 structural checks, WebAuthn ceremony and browser journey gates |
| Production inbox/provider/export delivery | UNPROVEN: hosting checks do not establish these integrations |
| Production-scale restore or sustained SLO | UNPROVEN: see [backup/restore](backup-restore.md) and [SLOs](slo-and-dashboards.md) |

The uploaded Worker was 2574.30 KiB gzip. That is artifact evidence, not a
measurement of real request latency, uptime or CPU percentiles.

## Before an operation

1. Read this runbook, ADR 0010 and the config/workflow being changed. Inspect the
   real Cloudflare state before creating a resource; reuse the named resources.
2. Confirm the intended commit and clean working tree. Use an isolated checkout
   when the shared checkout has unrelated edits or local commits. Do not stash,
   reset, rebase or switch that shared checkout to make deployment convenient.
3. Use Node 24, the repository-pinned pnpm and Wrangler, and compatible
   `worker-build` (`^0.8`, installed with `--locked`). Keep the committed lockfiles.
4. Verify authentication before any remote mutation. Local Wrangler uses OAuth;
   GitHub Actions uses its account-owned API token. Sandbox/network denial does
   not prove a credential is invalid: retry with the tool's authorized network
   access before creating or rotating credentials.
5. Confirm pending migrations are compatible with the currently running Worker.
   Migration application precedes upload and is not undone if upload fails.

From the repository root:

```sh
git status --short --branch
git fetch origin
git rev-parse HEAD origin/main
pnpm --filter @runlumi/agents-cp-api exec wrangler whoami
pnpm --filter @runlumi/agents-cp-api exec wrangler d1 migrations list DB --remote --env production
pnpm --filter @runlumi/agents-cp-api exec wrangler secret list --env production
```

Inspect secret **names** only. Never print credential config files, `.dev.vars`,
authorization headers, token values, private keys or sensitive exports.

## Normal release: checked main through GitHub Actions

Open a focused PR with its packet and handoff. Wait for `quality` on the exact
head, merge only within the owner's authorization, and read back remote main.
`Checks` runs on PRs and pushes to main; `workflow_dispatch` on main also runs
quality. Every main push currently triggers this pipeline, including docs-only
changes. No PR run receives a deployment step.

The deployment job:

1. Requires a successful quality job and `CLOUDFLARE_API_TOKEN`.
2. Checks out the triggering commit, installs the pinned toolchain, builds the
   SPA, and performs the production Worker dry-run.
3. Serializes production deployments with cancellation disabled, so a newer run
   does not interrupt an in-flight migration/upload.
4. Compares the triggering SHA with remote main immediately before migration;
   skips deployment if already superseded. This is a point-in-time check, not a
   lock preventing main from advancing later.
5. Applies pending forward-only D1 migrations.
6. Uploads the Worker, assets and custom domain with the full Git SHA as message.
7. Runs the production smoke and fails the job if its assertions fail.

A green workflow with a skipped deployment is not proof of an upload. Check the
individual deploy steps, version ID and deployment message. If the post-upload
smoke fails, the new version may already be active; a red job does not imply an
automatic rollback.

## Manual deployment and readback

Use this only for an authorized release/recovery from a clean, validated commit.
`pnpm build` deliberately builds web before API: the Worker dry-run needs the
existing SPA output. An API-only build in a fresh checkout is insufficient.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm --filter @runlumi/agents-cp-api exec wrangler whoami
pnpm --filter @runlumi/agents-cp-api exec wrangler d1 migrations apply DB --remote --env production
pnpm --filter @runlumi/agents-cp-api exec wrangler deploy --env production --message "$(git rev-parse HEAD)"
node apps/api/scripts/smoke-production.mjs
pnpm --filter @runlumi/agents-cp-api exec wrangler deployments list --env production
```

Verify the deployment's active version and message against the intended SHA and
check the actual HTTPS domain in a browser. The custom-domain config manages DNS
and TLS; do not add a parallel Pages project, DNS workaround or second origin.

The smoke verifies root and `/settings` HTML, JSON health even during browser
navigation, unknown API 404 without SPA fallback, anonymous account-session
refusal, and absence of the development foundation route. It does not log in,
verify email delivery, execute inference, download an R2 export or measure SLOs.

Local production routing can be checked without touching remote resources:

```sh
pnpm --filter @runlumi/agents-cp-api exec wrangler dev --env production --local --port 8790 --inspector-port 9235
```

In another terminal:

```sh
PRODUCTION_ORIGIN=http://localhost:8790 node apps/api/scripts/smoke-production.mjs
```

Choose unused HTTP and inspector ports; stop only the process started for this
check. A production-config local Worker is still local evidence.

## CI access and runtime secrets are different

The repository Actions secret `CLOUDFLARE_API_TOKEN` holds the account-owned token
named `agents-cp-github-production`. Its configured policies are Workers Editor,
D1 Write, Queues Write and Workers R2 Storage Write in RunLumi, plus Zone Read and
Workers Routes Write for **runlumi.app only**. Account resource permissions cover
that account's resources; they are not isolated per database/bucket/Worker.
The account ID is non-secret and is pinned in config and the workflow.

The token was created in the signed-in browser and saved directly in GitHub
Actions secrets. Its value was not committed or included in evidence. Creation,
permission changes and storage must follow the active tool's approval rules;
do not silently expand permissions after a failed deploy. The configured policy is the modern Workers Editor group; verify the actual
policy rather than substituting a similarly named permission.

For token rotation, prepare an equivalent replacement, update the same Actions
secret, prove a main deployment succeeds, then revoke the old token. Do not
revoke a working token first or assume GitHub can reveal its stored value.
Revocation is also required when this CI integration is retired.

A fresh `wrangler secret list --env production` returned `[]` on 2026-10-02:

| Worker secret | Required format / purpose | Dated readiness |
| --- | --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | Random 32-byte lowercase hex key for provider credential encryption | BLOCKED: not installed |
| `WEBHOOK_SECRET_KEY` | Random 32-byte lowercase hex key for webhook secret encryption | BLOCKED: not installed |
| `LICENSE_SIGNING_SECRET` | `key_id:base64_pkcs8_der` signing material | BLOCKED: not installed |
| `SENTRY_DSN` | Optional Sentry reporting DSN | NOT_APPLICABLE to hosting; not installed |

Missing required keys keep their dependent features fail-closed. A successful
hosting deploy does not configure them. Preserve existing encryption/signing
keys through ordinary deployments and rollback; regenerating a key can make
persisted ciphertext or signatures unusable. Before first provisioning, arrange
approved secure custody and backup. Do not store key values in this runbook,
Wrangler vars, Git, PR bodies or logs. Use interactive `wrangler secret put NAME
--env production` through the API workspace, or an approved protected bulk input;
never put the value in a command-line argument.

Email Sending was enabled for runlumi.app; `EMAIL` and `EMAIL_FROM` are configured.
Inbox delivery remains UNPROVEN. `LUMI_PROVIDER_ALLOWLIST`, provider credentials
and their execution proof are separate prerequisites; do not weaken the egress
allowlist or set production `ENVIRONMENT=development` to make a test succeed.

## Rollback and data recovery

First inspect the current deployment, selected old version and schema changes
between them. A code rollback may be incompatible with migrations already
applied. Choose a compatible previous version explicitly, then, for an authorized
rollback, run from the repository root:

```sh
pnpm --filter @runlumi/agents-cp-api exec wrangler rollback <compatible-version-id> --env production --message "incident: restore compatible Worker"
node apps/api/scripts/smoke-production.mjs
pnpm --filter @runlumi/agents-cp-api exec wrangler deployments list --env production
```

Worker rollback does not revert D1, clear queue messages, remove exported objects
or recover a lost key. Preserve those resources. Keep the main deployment
pipeline coordinated with an incident rollback: a subsequent main push can
automatically deploy again. Record the rollback reason/version and repair the
source before resuming normal delivery.

Never edit applied migrations, drop production resources, reset D1 or restore a
backup automatically because a deploy failed. Forward-fix the schema or use the
reviewed [backup/restore procedure](backup-restore.md). Its local rehearsal does
not prove a production-scale RPO/RTO or a live D1 Time Travel restore.

## Troubleshooting

| Symptom | Next narrow check / response |
| --- | --- |
| Quality red, deploy skipped | Fix the named check; never bypass or weaken it to ship. Re-run against the new exact head. |
| Deployment credentials missing / unauthorized | Check secret name, account, token status and policies; do not print the value or recreate resources. |
| Auto-deploy green but no new version | Inspect the freshness step and whether mutation/upload steps were skipped. |
| API navigation returns HTML | Check explicit production `/api` and `/api/*` Worker-first rules and active version; do not change the frontend to accept HTML. |
| Fresh API build reports missing assets | Build web first using `pnpm build`. |
| Migration succeeds, upload fails | Previous Worker may still run against the new schema. Assess compatibility, repair upload or forward-fix; do not undo the ledger blindly. |
| Post-upload smoke fails | Read the active version first; investigate the failed boundary or execute an authorized compatible rollback. |
| Email/provider operation fails | Verify the actual binding, sender, allowlist and secret prerequisites; hosting success does not settle delivery. |
| Local workerd bind error | HTTP or inspector port may be occupied; select unused ports instead of killing unrelated processes. |
| Disk fills / scratch checkout disappears | Preserve source changes in a stable isolated worktree on a volume with capacity; rebuild only this task's generated artifacts. Re-inventory paths before continuing. |
| Browser org-switch/deep-link gate fails | Inspect settled state and retained samples. Existing probe samples the whole bounded transition with a 24-sample minimum; stale-tenant assertions remain mandatory. |

For each handoff record the exact source SHA, PR/Actions URLs, active Worker
version/message, migration verdict, domain smoke and browser result, plus named
UNPROVEN/BLOCKED integrations. Keep local checks, hosted CI, live Worker behavior
and downstream delivery as separate claims.
