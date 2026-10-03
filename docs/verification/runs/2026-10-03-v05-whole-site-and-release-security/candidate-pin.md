# V05 — the candidate under judgement

Pinned before any evidence was taken, per the release gate's "Pin the candidate" step.

| | |
|---|---|
| **commit** | `8aaca08` (`main`, clean tree at pin time) |
| **product tree** | identical to `1d3ec1e` (V04's final re-pin): `git diff --name-only 1d3ec1e..HEAD -- apps Cargo.toml Cargo.lock pnpm-lock.yaml` returns exactly two **probe script** files (`apps/api/scripts/p02-passkey-smoke.mjs`, `apps/api/scripts/v02-tool-policy-deny-probe.mjs` — prettier formatting only, commit `f293082`) and no handler, route, repository, SQL, migration, or config file. Every commit after `1d3ec1e` otherwise touches `docs/` |
| **OS** | Darwin 27.0.0 (macOS, arm64) |
| **node / pnpm / cargo** | v24.20.0 (`~/.nvm/versions/node/v24.20.0`) / 12.5.1 (`~/.lumi-tools/bin/pnpm`) / 1.93.0 (`~/.cargo/bin/cargo` shim) |
| **browser** | Google Chrome 154.0.8037.93 |
| **Worker runtime** | `wrangler dev` (wrangler 4.137.0, workerd 1.20260921.1) on a local D1 |
| **build** | `pnpm check` exit 0 and `pnpm build` exit 0 (vite production build + Worker `--dry-run`) on the repaired tree |
| **migration head** | `0022_p07_staff_actor_type.sql` — 22 migration files |
| **contract version** | `/api/v1/meta` → `p01-cg-v1` (measured on the live deployment) |
| **desktop client** | none exists in this repository (V04 External unknowns carried) |

## The WebAuthn configuration in force — read before any ceremony was driven

There are **three** answers, and the differences between them are load-bearing:

1. **The live deployment** (`https://agents-cp.runlumi.app`, reachable and answering from this host —
   `/api/health` → 200 `{"status":"ok"}` in 0.69 s): deployed from the **`origin/main` deployment
   line**, whose `apps/api/wrangler.jsonc` production env declares `ENVIRONMENT=production`,
   `WEBAUTHN_RP_ID=agents-cp.runlumi.app`, `WEBAUTHN_RP_NAME=Lumi Agents`,
   `WEBAUTHN_ORIGINS=https://agents-cp.runlumi.app`, custom domain `agents-cp.runlumi.app`, and
   SPA assets (`../web/dist`) with `run_worker_first: ["/api", "/api/*"]`.
2. **The deployed code**, however, is the deployment line's tree: `origin/main` branched from
   `795d403` — V04's **original pin, a FAILED candidate** (it ships V04-002: the queue handler
   cannot construct the Worker). `git diff --stat 795d403..HEAD -- apps/api/src apps/api/migrations
   apps/web/src apps/api/sentry-entry.mjs` shows the candidate's product delta over the deployed
   tree is exactly `sentry-entry.mjs` (+ the V04-002 repair), `security/guarded_column_writers.rs`
   and `security/mod.rs` (a new standing check), and one web test file — **no route, handler, SQL or
   migration difference**. The passkey surface is byte-identical between what production runs and
   what this candidate would ship.
3. **The candidate's own `wrangler.jsonc` production env carries NO `WEBAUTHN_*` vars at all.** The
   deployment line added them on top of a shared base and the line was never merged back. A
   candidate deployed from **its own** config would construct `state.webauthn = None`
   (`app.rs:75-109` passes `Option` through for every non-development environment) and answer every
   passkey route with a service-unavailable error — the silently-disabled passkeys case this
   campaign is asked to measure. Measured locally in §1.

The histories have diverged without a merge: `main` is 43 commits ahead of `origin/main`,
`origin/main` is 2 commits ahead of the point it branched from (`git rev-list --count` both ways at
pin time).

## Discipline

- Verification records are committed on top of the candidate, so `HEAD` moves while the product
  does not. The pin holds while
  `git diff --name-only 8aaca08..HEAD -- apps Cargo.toml Cargo.lock pnpm-lock.yaml` contains no
  product file; a repair that changes product code voids this pin and forces a re-pin, which is the
  loop working.
- Shared-checkout discipline applies (V04-004): commit by explicit path list; never
  stash/checkout/rebase the shared tree.

---

## Re-pin — `aa05674` (voided by this campaign's own §1 repairs, exactly as the rule predicts)

V05-001/V05-002's repairs changed product files (`routes/authenticators.rs`, `apps/api/wrangler.jsonc`),
so the `8aaca08` pin is void in the direction that matters: the repairs are the point of the loop.
**Re-pinned to `aa05674`.**

**What was re-run against `aa05674`'s tree** (identical working-tree content to what the repairs
were measured on — the commit captured the tree, it did not change it):

| proof | result |
|---|---|
| `pnpm check` | **exit 0** — format, lint, typecheck, web tests, `cargo test --workspace`, schema/null/bind scans, guard probe, clippy clean, wasm target builds |
| `smoke:passkey` under the production pairing (`P02_PASSKEY_FORWARD_VARS=1`) | **91/91, exit 0** (`evidence/v05-passkey-final-tree.log`) |
| `evidence/v05-webauthn-config.sh` | **7/7, exit 0** — production-env Worker issues ceremonies for the deployed rp.id; the no-adapter state answers `passkeys_not_configured` while health stays 200 and the password route answers a normal 401 |
| `security::repository_liveness` + `security::guarded_column_writers` | **2/2 + 5/5, exit 0** (`evidence/v05-standing-checks.log`) |

**What is running against the same tree content and reported as it lands:** the §2 security sweep
(`evidence/v05-security-sweep.sh`, 35 gates). It was **started before the commit** — its header says
"candidate tree: `8aaca08` (+ working tree repairs)" — and the commit moved no byte of the tree it
measures, so its results are evidence about `aa05674`'s product. Anything the sweep itself repairs
would void this pin again, which is the rule working again.

**What is carried, not re-measured, from V04** (product tree identical to `1d3ec1e`): the eleven
Tier-0 mutant kills across all six release-gate classes, and the sensitivity proofs for the gates
this sweep re-runs. The one class §1 touched — `consume_ceremony`, the auth-replay mutant's target —
is unchanged by the repairs (they touch the error mapping and the config, not the guard).

---

## Merge addendum — branch `v05-release-security`, merge commit `2fce974`

To open the release PR, `origin/main` was merged into the campaign branch, so the tree under
judgement now also carries the deployment line's changes since `795d403`:
`.github/workflows/checks.yml`, `AGENTS.md`, `README.md`, `apps/api/scripts/smoke-production.mjs`,
`apps/api/wrangler.jsonc` (production-only fields: `account_id`, custom-domain route, SPA assets,
`database_id`; the duplicate early `env.production` block removed), `apps/web/scripts/browser-probe.mjs`
(the org-switch loop is time-bounded instead of sample-counted — V04 documented exactly this
supersession for T0-19), `package.json` (build order), deployment docs/ADRs/handoffs.

Effect on the measurements in this record, stated plainly:

- **No measured surface changed.** The only product file both lines touched is `wrangler.jsonc`, and
  the merge resolved to the deployed structure with **byte-identical `WEBAUTHN_*`/`EMAIL_FROM`
  values** (this campaign took them from the deployment line in the first place). The local gates
  all run `--env development`, which the merge did not touch; the production-env legs consumed
  exactly the vars, which are unchanged.
- `smoke:browser` 91/91 and the whole-site sweep ran on the pre-merge `browser-probe.mjs` (the
  journey assertions are the same; the deployment line's change is a patience increase in one wait
  loop). The probe's own §4 record says which tool produced which number, per the pin discipline.
- The config script's worker cleanup orphaned `wrangler dev` (subshell killed, wrangler not) — fixed
  in all three committed scripts with `exec`, after an orphan logged parse errors into a committed
  evidence log during the merge's conflict window. The log was restored to the passing run's
  content; the appended noise is described here rather than kept.
