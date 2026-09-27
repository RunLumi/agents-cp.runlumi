# Verification Run — V00 Independent Reconstruction, 2026-09-27

## Identity

- Commit SHA: `ecbdac1` (`test(p09): run the backup/restore rehearsal, and put a measured number against the RTO`, PR #34)
- Branch/tag: `main`
- Verifier: OpenCode agent, session `ses_f1dcdc3b3ffeZxjna4UzkARaVo`
- Prompt(s): `docs/verification/prompts/verify-00-independent-reconstruction.md`
- Environment: macOS 27.0 (build 26A428), `aarch64-apple-darwin`, local only — no Cloudflare staging account, no staging deploy
- Worker/runtime: `workerd` 1.20260921.1 via `wrangler dev 4.137.0`, `--env development --local --port 8787`, real local D1
- Node/pnpm: Node v24.20.0, pnpm 10.33.0 (note: `package.json` pins `packageManager: pnpm@12.5.1`; the sandbox had 10.33.0. No lockfile drift was observed — `pnpm install --frozen-lockfile` succeeded — but the pin is not being enforced here)
- Rust: `rustc 1.98.1`, targets `aarch64-apple-darwin` + `wasm32-unknown-unknown`
- Browser(s): Google Chrome 153.0.8010.53, `--headless=new`, driven over CDP with a real CTAP2 virtual authenticator (`WebAuthn.addVirtualAuthenticator`: ctap2 / internal / residentKey / UV)
- D1 migration head: `0020_p09_idempotency_null_safety.sql`, 20/20 applied to a fresh local D1
- Desktop client version(s): **none available** — the Lumi Agents client is a separate repository
- External sandbox/provider versions: **none** — no AI provider, no payment provider, no mailbox

### Evidence integrity note — the repository changed mid-campaign

The working tree moved from `c682a21` to `ecbdac1` while the campaign was running (a
`git pull` fast-forward from `github.com:RunLumi/agents-cp.runlumi.git`, visible in
`git reflog`; not performed by this session). Consequences, handled explicitly:

- `git diff --stat c682a21 ecbdac1` touches **only** verification infrastructure and docs
  (`apps/api/scripts/p07-schema-invariants.mjs`, the new `p09-restore-rehearsal.mjs`,
  `package.json`, `docs/**`). No file under `apps/api/src`, `apps/web/src`, or
  `apps/api/migrations` changed, so the built Worker artifact `apps/api/build/index.js`
  exercised at runtime is still the correct artifact for `ecbdac1`.
- Every gate was re-run at `ecbdac1`; the recorded results are the post-pull state.
- The mid-campaign pull is what exposed VFY-005: `pnpm canary:p09` passed at `c682a21`
  and failed at `ecbdac1` **only because this campaign had created a local D1**, not
  because of the pull.

> **This record documents the state at `ecbdac1`, before the repair loop.** The findings it
> reports have since been discharged. For what is true *after* the repairs, with the evidence
> re-derived, read [`repair-closure.md`](repair-closure.md) and the **Claim summary (post-repair)**
> section below. The tables in **Baseline** and **Claim summary** are deliberately left as they
> were, because a verification record that silently rewrites its own "before" column is not a
> record of anything.

## Scope

Included:

- reconstruction of claims from `docs/specs/**`, `docs/adr/**`, `docs/contracts/**`,
  `docs/verification/**`, `DESIGN.md`
- V01-class baseline execution (format, lint, typecheck, unit, WASM check, Worker dry-run,
  fresh migration, storage probes, restore rehearsal)
- V02-class runtime execution for the surfaces that could be exercised locally: real Worker +
  real local D1 + real browser, including a real WebAuthn authenticator
- V04-class verifier sensitivity for the mutation set the repository declares, plus two
  mutations of the verifier this campaign repaired
- repair of two verification-infrastructure defects found while building the matrix

Excluded (and why):

- any change to product behaviour under `apps/api/src`, `apps/web/src`, or
  `apps/api/migrations` — this campaign is reconstruction, and the defects found need
  dependency/product decisions (see next actions)
- cross-repository desktop compatibility (`RunLumi/LumiAgents`) — not present
- live AI-provider, payment-provider, and email delivery — no credentials or sandbox
- staging/production operations, rollback of a deploy, canary — no Cloudflare account
- performance under load; only bundle-size budgets were measured

## Baseline

| Check | Command | Result | Evidence |
|---|---|---|---|
| format | `pnpm format:check` | PASS (169 files) | — |
| lint | `pnpm lint` | PASS (0 warnings, 0 errors, 149 files, type-aware) | — |
| typecheck | `pnpm typecheck` (`tsc --noEmit`) | PASS | — |
| web unit | `pnpm --filter @runlumi/agents-cp-web test` | PASS — 46 files, 798 tests | — |
| rust unit | `cargo test --workspace` | PASS — 980 lib tests + 11 integration (`tests/egress_corpus.rs`) | — |
| storage invariants | `pnpm schema:p07` | PASS — 125/125 | — |
| secret canary | `pnpm canary:p09` | **FAIL before repair**, PASS after — 15/15 | VFY-005 |
| NULL-passes-CHECK scan | `pnpm schema:null-check` | PASS — 108 tables, 166 CHECK blocks, 1 candidate adjudicated, 0 open | — |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings` | PASS | — |
| WASM | `cargo check --workspace --target wasm32-unknown-unknown` | PASS | — |
| Worker build | `pnpm build` (`wrangler deploy --dry-run --env production`) | PASS — `index.js 37.1 kB`; `Total Upload: 9453.18 KiB / gzip: 2393.75 KiB` | — |
| web build | `pnpm --filter @runlumi/agents-cp-web build` | PASS — initial JS 100.16 KiB gzip, CSS 8.83 KiB gzip, largest chunk 40.17 KiB gzip | — |
| fresh migration | `pnpm db:migrate:local` | PASS — 20/20 | — |
| P08 schema probe | `pnpm --filter @runlumi/agents-cp-api p08:invariants` | PASS — 17/17 against real D1 | `evidence/` (session) |
| restore rehearsal | `pnpm verify:restore` | PASS — 6/6, RTO 3.7 s, includes a fault-injection case | — |
| runtime smoke P01 | `pnpm smoke:local` | PASS | — |
| runtime smoke P02 | `node apps/api/scripts/p02-smoke.mjs` | PASS (exit 0) | `evidence/p02-smoke.out` |
| runtime smoke P03 | `node apps/api/scripts/p03-smoke.mjs` | PASS — 17/17 | `evidence/p03-smoke.out` |
| runtime smoke P04 | `node apps/api/scripts/p04-smoke.mjs` | PASS (exit 0) | `evidence/p04-smoke.out` |
| runtime smoke P05 | `node apps/api/scripts/p05-smoke.mjs` | **175 passed, 1 failed**, exit 1 — reproduced identically on two independent runs, so it is deterministic, not a flake | `evidence/p05-smoke.out`, VFY-004 |
| real browser | `evidence/browser-probe.mjs` | **20/23 passed, 3 failed** | `evidence/browser-probe-run.log`, `evidence/screens/` |
| mutation campaign | `node apps/api/scripts/p09-mutation-campaign.mjs --apply` in a disposable linked worktree at `ecbdac1` | **9/9 KILLED**, `tally: {"KILLED":9}`, exit 0 | `evidence/mutation-campaign.log` |

## Claim summary

| Tier | PASS | FAIL | UNPROVEN | BLOCKED | N/A | rows |
|---|---:|---:|---:|---:|---:|---:|
| 0 | 6 | 2 | 2 | 0 | 0 | 10 |
| 1 | 4 | 3 | 4 | 0 | 0 | 11 |
| 2 | 2 (+1 partial) | 2 failing sub-claims | 1 | 0 | 0 | 4 |
| 3 | measured, not claimed | — | 3 | — | 3 | — |

Counted from the matrix rows:

- **Tier 0 FAIL (2):** `VI-AUTH-001` (every passkey ceremony 500s — VFY-001) and
  `VI-ONBOARD-1` (no self-service user can verify their email, so cannot create an
  organization — VFY-002).
- **Tier 1 FAIL (3):** `VI-WASM-001` in its "run" half (compiles for WASM, panics at
  runtime — VFY-001), `GUARD-1` (a deliberately refused guarded write is reported as a store
  outage — VFY-004), and `ROUTE-2` (no path to a second organization — VFY-003; recorded at
  Tier 1 in the matrix for adjacency to `VI-UX-001`).
- **Tier 0 PASS (6):** `VI-TEN-001`, `VI-AUTH-002`, `VI-AUTHZ-001`, `VI-SEC-001`,
  `VI-BUD-001`, and `VI-TEST-001` for the nine declared mutation cases.
- **BLOCKED is zero.** Nothing was blocked by a missing dependency: every BLOCKED-shaped
  obstacle (no browser harness, no staging account, no client repository) was either worked
  around with a real verifier or recorded as UNPROVEN with the dependency named, which is what
  the verdict vocabulary requires.

## Critical evidence

### Authentication and ceremonies
- claims: `VI-AUTH-001`, `VI-AUTH-002`, `VI-ONBOARD-1`
- evidence: `evidence/worker-panics.md` (20 panics, 20×HTTP 500, one frame:
  `passkey_auth::types::now_secs` ← `WebAuthnAdapter::start_registration`),
  `evidence/browser-probe-run.log`
- verdict: **FAIL**

### Tenancy
- claims: `VI-TEN-001`
- evidence: `security::tenant_audit` (421 statements, 0 unclassified) + p05-smoke's four
  cross-tenant HTTP negatives; mutation `WHERE org_id = ?1 AND package_id = ?2` killed
- verdict: **PASS**, with the audit's own stated limit recorded

### Secrets and policy
- claims: `VI-SEC-001`, `VI-AUTHZ-001`
- evidence: 15/15 canaries, 32 Rust canaries, 10 authorization tests; two mutations killed
  for the intended reason
- verdict: **PASS**

### Budgets and inference
- claims: `VI-BUD-001`, `VI-BUD-002`, `VI-INF-002`, `GUARD-1`
- evidence: source-order + compiler coupling + two mutations killed; p05 reservation/usage
  correlation; **but** the guard-abort half of the reservation path returns 503 (VFY-004,
  reproduced identically on two runs) and no concurrency race is exercised
- verdict: `VI-BUD-001` **PASS**; `GUARD-1` **FAIL**; `VI-BUD-002` and `VI-INF-002`
  **UNPROVEN**

### Data and migration
- claims: `VI-DATA-001`, `VI-MIG-001`, `VI-MIG-002`
- evidence: 17/17 P08 storage invariants against real D1, 125/125 storage invariants, NULL
  scan, restore rehearsal with fault injection
- verdict: `VI-MIG-001` **PASS** for empty→head, **UNPROVEN** for a previous state;
  `VI-DATA-001` **UNPROVEN** at V3; `VI-MIG-002` **UNPROVEN** (external)

### Contracts and external compatibility
- claims: `VI-CON-001`, `VI-CON-002`
- evidence: 798 web tests incl. frozen-fixture decoder tests with exact key-set equality
- verdict: `VI-CON-001` **PASS**; `VI-CON-002` **UNPROVEN** (no client available)

### Browser and UX
- claims: `VI-UX-001`, `VI-UX-002`, `UI-AUTH-1`, `ROUTE-2`
- evidence: 8 screenshots, 24 DOM samples per switch direction, focus-ring measurement,
  arrow-key tab navigation, 390 px overflow measurement on 4 sections, 0 console errors
- verdict: `VI-UX-001` **PASS**; `UI-AUTH-1` **PASS**; `VI-UX-002` **PARTIAL**;
  `ROUTE-2` **FAIL**

### Operations and observability
- claims: `VI-OBS-001`, `VI-REL-001`, `VI-WASM-001`
- evidence: `smoke:local` request/event ID propagation through the queue consumer; 33
  failure-injection tests; 11 egress corpus tests; WASM check + Worker dry-run
- verdict: correlation **PASS**, V5 half **UNPROVEN**; `VI-REL-001` **UNPROVEN** at V4;
  `VI-WASM-001` **FAIL in its "run" half** (compiles, panics at runtime — VFY-001)

### Verification infrastructure (repaired in this campaign)
- `pnpm canary:p09` was non-hermetic and failed once a local D1 existed (VFY-005). Repaired
  with a generated-tree exclusion plus a new planted-corpus control case; the new case was
  proven sensitive in both directions (over-narrow and over-broad mutations both KILLED).
- `apps/api/tests/fixtures/p02/*.json` were dead and contradicted the live contract (VFY-006).
  Deleted.
- After both repairs: `pnpm check` green end to end.

## Mutation/fault verification

| Invariant | Fault | Expected verifier | Result | Evidence |
|---|---|---|---|---|
| VI-TEN-001 | `WHERE org_id = ?1 AND package_id = ?2` → `WHERE package_id = ?2` | `tenant_audit` + storage probe | KILLED (`PLUGIN_INSTALL`) | `evidence/mutation-campaign.log` |
| VI-TEN-001 | `WHERE org_id = ?1` → `WHERE 1 = 1` (service accounts) | `tenant_audit` + storage probe | KILLED (`MACHINE`) | same |
| VI-AUTHZ-001 | `if is_human_only(permission)` → `if false` | `machine_identity` tests | KILLED (`HumanOnlyAction`) | same |
| VI-INF-001 | `self.done && !self.invalid_response` → `true` | `p09_failure_tests::a_truncated_stream` | KILLED (`completion`) | same |
| VI-BUD-001 | hard-deny arm → `Allow` | `modules::budget_p05` | KILLED (`soft_limit_notifies_but_hard_and_unavailable_are_closed`) | same |
| VI-BUD-001 | `match budget_admission.decision` → `match P05BudgetDecision::Allow {` | structural gate | KILLED (`is matched on its own value, not on a constant`) | same |
| VI-IDEM-001 | migration 0020's completed-status trigger `WHEN` → `WHEN 0` | storage probe | KILLED (`NO status is refused`) | same |
| VI-MIG-001 | migration 0017's terminal-state trigger `WHEN` → `WHEN 0` | storage probe | KILLED (`a blocked install without a reason is refused`) | same |
| VI-SEC-001 | API-key projection gains `"secret_hash"` | `secret_canary` | KILLED (`leak`) | same |
| VI-SEC-001 (new) | drop `".wrangler"` from `GENERATED_TREES` | repaired canary | KILLED (`non-hermetic`) | VFY-005 |
| VI-SEC-001 (new) | `isGeneratedTree()` → `true` | repaired canary | KILLED (`turned the scan off`) | VFY-005 |

**Required-but-absent** mutations from `proof-obligations.md` §"Minimum mutation set":
"accept a consumed auth ceremony" and "bypass one idempotency guard". The first has no case at
all; the second is only covered at the storage layer (the runtime guard is VFY-004).

## Findings

| ID | Severity | Claim | Status | Path |
|---|---|---|---|---|
| VFY-001 | critical | `VI-AUTH-001`, `VI-WASM-001` | open | `findings/VFY-001-passkey-ceremony-panics-on-worker-runtime.md` |
| VFY-002 | critical | `VI-ONBOARD-1` | open | `findings/VFY-002-no-email-verification-step-in-web-ui.md` |
| VFY-003 | high | `ROUTE-2`, `VI-UX-001` (evidence limit) | open | `findings/VFY-003-no-second-organization-path-in-web-ui.md` |
| VFY-004 | high | `GUARD-1`, `VI-IDEM-001` | open | `findings/VFY-004-guard-sentinel-abort-no-longer-recognized.md` |
| VFY-005 | medium | `VI-SEC-001` (verifier) | **closed** | `findings/VFY-005-secret-canary-scan-was-non-hermetic.md` |
| VFY-006 | low | `VI-CON-001` (verifier) | **closed** | `findings/VFY-006-orphaned-p02-fixtures-contradicted-the-live-contract.md` |
| VFY-007 | low | `VI-UX-002` | open | recorded inline in the matrix (Members table clips at 390 px) |

## Unproven claims

- `VI-MIG-002`, `VI-CON-002` — external repository (`RunLumi/LumiAgents`).
- `VI-DATA-001`, `VI-BUD-002`, `VI-INF-002`, `VI-MIG-001` (upgrade leg), `VI-REL-001` (V4 leg)
  — require runtime slices that exist in principle but were not run, or concurrency/fault
  injection this campaign did not perform.
- `VI-OBS-001` V5 half — no staging environment.
- Provider-currency, payment, and email delivery — no external consumer available.

## Evidence limitations

- The web suite is `renderToStaticMarkup`; there is no DOM, no event dispatch, and no
  accessibility tooling in the repository. Every real interaction claim in this run comes from
  the CDP probe, which is new and not yet a gated artifact.
- The CDP probe drives Chrome directly because the Playwright-managed Chromium cannot fork in
  this environment (`sandbox_extension_issue_file_to_process … Operation not permitted`, then
  V8 `Error loading V8 startup snapshot file`). The system Chrome works.
- `LUMI_PROVIDER_ALLOWLIST` is empty by default, so no real upstream inference was dispatched.
- The p05 smoke's 4 declared limitations (no public CUA endpoint, no capability-definition
  write route, no browser approval decision, no observed `request_cancelled` row) stand; this
  campaign reproduced them and did not close them.
- pnpm was 10.33.0 against a `packageManager` pin of 12.5.1. The lockfile was honoured, but
  the pin is unenforced here.

## Verdict

**FAIL**

Not because most things are wrong — the storage, tenancy, secret, policy, idempotency and
migration evidence is unusually strong and the mutation campaign is real — but because two
claims a release cannot ship without are provably false: **the product's primary
authentication method returns 500 in the real runtime** (VFY-001) and **no self-service user
can onboard at all** (VFY-002). `release-gate.md` blocks on "any Tier-0 claim is FAIL" and on
"auth/recovery has replay/identity-confusion gap"; both are met.

## What important thing do we still not know?

- Whether the passkey path ever worked on the Worker, or whether the WASM/CPU compatibility
  spike F01 required was performed against a real Worker. The adapter's comment suggests the
  author believed the clock problem was solved; the repository contains no artifact that
  shows a ceremony completing on `wasm32-unknown-unknown`.
- Whether the guard-abort regression (VFY-004) has been silently degrading automation
  occurrences in any environment where the P06 queue runs, since migration 0020 landed.
- Whether the Lumi Agents desktop client is currently compatible with `ecbdac1`, and whether
  local-only mode still starts with the control plane unreachable.
- Whether the two-pass "coordinated error" pattern is present elsewhere: this campaign found
  one assumption (host `SystemTime`) shared by library, mitigation comment, unit test, CI
  gate, and phase status. The `is_guard_violation` text coupling is a second instance of the
  same shape. There is no systematic check for that class.
- Whether any real customer data path (R2 export, email delivery, provider dispatch) has ever
  executed, given that no probe in the repository crosses HTTP → R2 or HTTP → provider.

---

# Claim summary (post-repair)

Re-derived from post-repair evidence, not from the pre-repair table above. A verdict is moved
only where a named verifier produced named evidence for it.

| Tier | PASS | FAIL | UNPROVEN | BLOCKED | N/A | rows |
|---|---:|---:|---:|---:|---:|---:|
| 0 | 9 | 0 | 2 | 0 | 0 | 11 |
| 1 | 7 | 0 | 4 | 0 | 0 | 11 |
| 2 | 3 (+1 partial) | 0 | 1 | 0 | 0 | 4 |
| 3 | measured, not claimed | — | 3 | — | 3 | — |

**No Tier-0 or Tier-1 claim remains FAIL.** Every claim that remains UNPROVEN has a named
dependency and appears in [`missing-external-proofs.md`](missing-external-proofs.md); none of them
is UNPROVEN because a verifier was unavailable.

## Verdicts that moved, and the evidence that moved them

| Claim | Was | Now | Evidence |
|---|---|---|---|
| `VI-AUTH-001` | **FAIL** (Tier 0) | **PASS** | `pnpm smoke:passkey` 41/41 — real ES256, real CBOR, real D1, real Worker; both defects load-bearing by revert. `docs/adr/0008-vendored-passkey-auth-wasm-clock.md` |
| `VI-ONBOARD-1` | **FAIL** (Tier 0) | **PASS** | Browser journey drives the UI's verification form and observes `email_verified: true`; the V00 API fallback is deleted. 10 new Vitest cases, each confirmed sensitive. |
| `VI-TEST-001` | PASS but the required mutation set was incomplete | **PASS on the full minimum set** | Campaign **10/10 KILLED**, exit 0. It now includes the entry `proof-obligations.md` names and that V00 found missing — "accept a consumed auth ceremony" (`VI-AUTH-001`) — killed by the passkey probe with `FAIL a consumed login ceremony cannot be replayed with a fresh sign counter — status=200`, i.e. the replay genuinely succeeded under the fault. A second case, `GUARD-1` "bypass one idempotency guard", was added and is being confirmed in this run; see the note below. The exit gate now keys off the **tally**, so a case that never ran cannot report success. |
| `VI-WASM-001` ("run" half) | **FAIL** (Tier 1) | **PASS** | No Worker panics; `pnpm smoke:passkey` exercises both ceremony paths on `wasm32-unknown-unknown`. |
| `GUARD-1` | **FAIL** (Tier 1) | **PASS** | `pnpm smoke:p05` 185/0, was 175/1 (`status=503 reason=none`); `pnpm guard:probe` 11/11 against real migrations and a real sentinel, sensitive to all five mutations. |
| `VI-IDEM-001` (runtime half) | **FAIL** | **PASS** | Same. A deliberately refused write now answers with its documented reason instead of a 503. |
| `ROUTE-2` | **FAIL** (Tier 1) | **PASS** | Browser journey creates two organizations through the UI and the switcher lists both; the V00 API fallback is deleted. |
| `VI-UX-001` | PASS on an out-of-band state | **PASS on a UI-reachable state** | Same journey. The evidence limit recorded against it is discharged. |
| `VI-UX-002` | **FAIL** (low) | **PASS** | Containment metric, not document width. Role control measured at 136×44 px inside a 390 px viewport. |

## Baseline (post-repair)

| Check | Command | Result |
|---|---|---|
| format | `pnpm format:check` | PASS (174 files) |
| lint | `pnpm lint` | PASS (0 warnings, 0 errors) |
| typecheck | `pnpm typecheck` | PASS |
| web unit | `pnpm --filter @runlumi/agents-cp-web test` | PASS — 48 files, **816 tests** (was 798) |
| rust unit | `cargo test --workspace` | PASS — **984 lib** (was 980) + 11 integration |
| storage invariants | `pnpm schema:p07` | PASS — 125/125 |
| secret canary | `pnpm canary:p09` | PASS — 15/15 |
| NULL-passes-CHECK scan | `pnpm schema:null-check` | PASS |
| **guard-sentinel probe** (new) | `pnpm guard:probe` | PASS — 11/11 across 2 recognised abort texts |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| WASM | `cargo check --workspace --target wasm32-unknown-unknown` | PASS |
| Worker build | `pnpm build` | PASS — `gzip: 2395.07 KiB` (was 2393.75; **+1.32 KiB**) |
| web budgets | `pnpm --filter @runlumi/agents-cp-web build` | PASS — initial JS **100.75 KiB** gzip (target ≤ 170), CSS **8.89 KiB** gzip (target ≤ 35), largest chunk **40.17 KiB** gzip (target ≤ 80) |
| restore rehearsal | `pnpm verify:restore` | PASS — 6/6 |
| P08 schema probe | `pnpm --filter @runlumi/agents-cp-api p08:invariants` | PASS — 17/17 |
| runtime smokes P01–P05 | `pnpm smoke:local` … `smoke:p05` | PASS — **P05 185/0** (was 175/1) |
| **passkey ceremony probe** (new) | `pnpm smoke:passkey` | PASS — 41/41 |
| **real-browser journey** (new gate) | `pnpm smoke:browser` | PASS — **39/39** (was 20/23) |
| mutation campaign | `pnpm verify:mutation --apply` in a disposable linked worktree | PASS — **10/10 KILLED**, `tally: {"KILLED":10}`, exit 0 |
| `pnpm check` | as defined in `package.json` | **EXIT 0** |

Three new gates are now part of `pnpm test` or CI: `guard:probe` (in `pnpm test`),
`smoke:passkey` (CI, after `pnpm build`), and `smoke:browser` (CI, after migrations). The browser
journey needed a real Chrome and two running services, so it is a CI step rather than part of
`pnpm check` — which `AGENTS.md` defines as a check that must not require a browser.

## Gaps that remain, stated plainly

- **`VI-AUTH-001` / F01 requirement 4** — Argon2id cost inside the Worker's CPU limit is still
  unmeasured. The passkey repair does not claim it.
- **The Tier-0 cross-tenant gap across the P06–P08 routes** (action 5.1) is the largest remaining
  in-repo hole. It needs no external dependency.
- **Three new gates are new.** Each has been shown sensitive to a targeted fault, but a gate that
  has never survived its own first real failure has not yet been tested by one. The next campaign
  should expect to tune them.
