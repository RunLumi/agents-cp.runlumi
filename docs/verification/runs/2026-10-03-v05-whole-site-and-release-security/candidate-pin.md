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
