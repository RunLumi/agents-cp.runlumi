# Ordered Next Verification Actions — after V00, 2026-09-27

Ordering rule: a Tier-0 FAIL that makes the product unusable outranks a Tier-1 contract gap,
which outranks closing a UNPROVEN, which outranks strengthening a verifier. Within a tier, the
cheapest verifier that can falsify the claim comes first.

Every action states the claim it discharges, the cheapest capable verifier, and what result
would move the verdict. Actions 1–4 are repairs, not audits; actions 5+ are proof.

---

> **Status: actions 0–6 are discharged.** See
> [`repair-closure.md`](repair-closure.md) for the post-repair evidence and
> `verification-run.md`'s **Claim summary (post-repair)** for the re-derived verdicts. The
> checkboxes below record what was done, not what remains; actions 5 (the remaining
> in-repo proof gaps), 7 (external proofs), and 8 (process) are still open, and their items
> are still unticked.

## 0. Freeze this record before anything else

Commit the two verification-infrastructure repairs and this run's records, then re-run
`pnpm check` on the result.

- [x] repair `canary:p09` hermeticity (VFY-005) — closed in this campaign
- [x] delete the orphaned `apps/api/tests/fixtures/p02/` set (VFY-006) — closed in this campaign
- [ ] `git add docs/verification/runs/2026-09-27-v00-independent-reconstruction/` and commit
      with the two script changes in one commit, message naming both finding IDs
- [x] record `ecbdac1` as the verified commit and add a line to
      `docs/verification/README.md` pointing at `runs/` so the next campaign inherits the
      baseline instead of rebuilding it

**Why first.** The findings below are worthless if the evidence is not pinned to a commit that
someone else can re-run.

---

## 1. VFY-001 — restore the primary authentication path (critical)

**Discharges.** `VI-AUTH-001` FAIL, `VI-WASM-001` "run" half FAIL, F01 FR-F01-004/005/016,
and the F01 acceptance criteria.

**Step 1 — decide, in writing.** This is a durable dependency decision, so `AGENTS.md`
requires an ADR before code. Choose between:

| Option | Change | Cost | Risk |
|---|---|---|---|
| A. Patch/vendored `passkey-auth` with Worker time | fork, or `[patch.crates-io]` to a local path | smallest behavioural delta; a fork to track | upstream drift |
| B. Replace the dependency | new crate + F01's five required proofs again | largest | new verifier semantics |
| C. Upgrade to a version that accepts an injected clock | Cargo.toml only | smallest if it exists | check `now_secs` is no longer on the path |

**Step 2 — the proof F01 already demanded.** F01's own note requires, before the feature may
be claimed: dependency compiles for `wasm32-unknown-unknown`; Worker dry-run succeeds;
**registration + assertion verify end-to-end with server-side ceremony state**; the password
KDF fits real Worker CPU/memory; bundle impact acceptable.

Measured state of each:

| # | Requirement | State |
|---|---|---|
| 1 | compiles for `wasm32-unknown-unknown` | PASS (`cargo check --target wasm32-unknown-unknown`) |
| 2 | Worker dry-run/build succeeds | PASS (`pnpm build`) |
| 3 | **registration + assertion verify end-to-end with server-side ceremony state** | **FAIL — never run against a real Worker.** This is VFY-001 |
| 4 | password KDF fits real Worker CPU/memory at the required parameters | **UNPROVEN.** `adapters/password.rs` asserts argon2id parameters and the dummy-hash timing equaliser, but only on the host target. No measurement exists of Argon2id cost inside the Worker's CPU limit, which is the question F01 actually asked |
| 5 | bundle/performance impact acceptable | PASS with a caveat — `gzip: 2393.75 KiB` is ~80 % of Cloudflare's 3 MiB free-tier compressed limit; ADR 0004 sets no Worker ceiling |

**Step 3 — gate it.** Add a passkey leg to a runtime smoke so this can never regress
un-noticed:

```bash
# proposed: apps/api/scripts/p02-smoke.mjs, or a new p02-passkey smoke
# 1. start ceremony                      -> 200, ceremony_id + public_key present
# 2. complete with a real CTAP2 response  -> 200, session established
# 3. replay the identical complete body   -> stable rejection, not 500
# 4. expired ceremony                     -> stable rejection
# 5. wrong origin / wrong RP ID           -> stable rejection
# 6. unknown/revoked credential           -> stable rejection
# 7. user_id substitution                 -> cannot authenticate as another user
```

**Verifier that already exists and currently fails.**
`docs/verification/runs/2026-09-27-v00-independent-reconstruction/evidence/browser-probe.mjs`
reports `POST /api/v1/auth/passkey/signup/start` and `.../login/start` as FAIL. Promote it to a
gated artifact (see action 6) and it becomes the regression test.

**Moves the verdict when.** The two ceremony-start endpoints return 200 on a real Worker and a
real CTAP2 authenticator completes registration and a discoverable assertion.

---

## 2. VFY-002 — let a new user finish onboarding (critical)

**Discharges.** `VI-ONBOARD-1` FAIL, F01 FR-F01-002 + `/verify-email` web route, F02 FR-F02-001,
F22 FR-F22-003/011, and the "no dead-end" cross-cutting UX invariant.

**Cheapest capable verifier.** A web test at the component level plus one browser step.
No backend change is needed — `POST /api/v1/auth/verify-email` already returns 200 (proven).

- [x] add a submit branch for `method === "code"` in `auth-screen.tsx` that calls the already
      exported `verifyEmail`, with the challenge id and the entered code
- [x] add `email_verification_required` to `presentApiError` with actionable copy
      ("Confirm your email address, then retry") and keep the generic 403 for real permission
      failures
- [x] add a `presentApiError` test that fails while the reason is unhandled
- [x] add a browser probe step that signs up with password only, **never** calling
      `verify-email` by hand, and still reaches the organization shell. Delete the manual
      fallback from `evidence/browser-probe.mjs` when it passes — otherwise the harness keeps
      masking the defect

**Moves the verdict when.** A fresh browser signup reaches an organization shell with no
out-of-band API call, and the 403 copy names the real blocker.

---

## 3. VFY-004 — make guard aborts recognisable again (high)

**Discharges.** `GUARD-1` FAIL, `VI-IDEM-001` runtime half, P06 automation lease semantics,
F21-009.

**Cheapest capable verifier.** Two D1 probes plus `p05-smoke.mjs`; no browser needed.

- [x] decide the recognition strategy (prefer a shared sentinel marker constant over widening
      the substring match; see the finding for the trade-off)
- [x] apply it to **both** detectors: `repositories/automations.rs::is_guard_violation` and the
      private copy in `routes/usage.rs` — or delete the duplicate and keep one
- [x] add a storage probe that executes one real guard sentinel through D1 and asserts the
      recogniser accepts the produced error
- [x] add a mutation case: a second `BEFORE INSERT` trigger with a new `RAISE` message must
      make that probe fail, so the coupling cannot be reintroduced silently
- [x] `node apps/api/scripts/p05-smoke.mjs` must reach 0 failures

**Moves the verdict when.** The p05 reservation check returns 200/409 with a documented reason
instead of `status=503 reason=none`, and a deliberately refused automation occurrence settles
instead of retrying eight times into the dead-letter queue.

---

## 4. VFY-003 — a real path to a second organization (high)

**Discharges.** `ROUTE-2` FAIL and the evidence limit recorded against `VI-UX-001`.

**Cheapest capable verifier.** A web component test plus one browser step.

- [x] add a create-organization entry point reachable from the shell (F22's tree has no
      top-level item for it, so the switcher or Settings is the natural home, matching the
      existing Settings-landing pattern)
- [x] add a test that renders the shell with `me.organizations.length === 1`, clicks the
      control, and asserts the form appears
- [x] remove the API fallback from `evidence/browser-probe.mjs`

**Moves the verdict when.** The browser probe creates two organizations through the UI and the
org-switch claims are proven on a UI-reachable state.

---

## 5. Close the cheapest UNPROVEN claims with in-repo runtime probes (high value per unit work)

Ordered by cost/benefit. Each is a smoke extension, not new infrastructure.

| # | Claim | Probe | Cheapest shape |
|---:|---|---|---|
| 5.1 | `GUARD-1` neighbours: **cross-tenant substitution across P06/P07/P08 routes** | new `p06-p08-smoke.mjs` (the export surface is now covered by `p06-data-smoke.mjs`; the rest is not) | seed org A + org B, authenticate as A, substitute B identifiers across automations, leases, webhooks, notifications, billing, entitlements, export/deletion, data policy, service accounts, API keys, plugins, support grants, feature flags, kill switches, adoption. Assert the denial is indistinguishable from not-found and no list leaks B's metadata. This is the single largest Tier-0 gap in the matrix and needs no external dependency. |
| 5.2 | `VI-DATA-001` | **DONE IN PART** — `p06-data-smoke.mjs` | Built, and it earned its keep: it found VFY-008 and VFY-009, two independent critical defects that made every export and deletion request fail. Cross-tenant denial, permission denial, idempotent replay, and the request/durable-row path are proven (26 cases). The **R2 leg is BLOCKED** — the local queue does not deliver a published body intact, so the object write, the streamed download, and object absence after deletion remain UNPROVED (`missing-external-proofs.md` §8). Needs a staging deploy or a producer that sends a string body. |
| 5.3 | `VI-BUD-002` | extend `p05-smoke` | two concurrent reservation attempts for the same budget against real D1; assert the second cannot overspend and that the uniqueness index is what refuses it |
| 5.4 | `VI-INF-002` | extend `p04-smoke` | publish v1 → v2 → rollback → dispatch on v1; assert the prior version is restored and no client redeploy is needed |
| 5.5 | `VI-MIG-001` (upgrade leg) | new `p09-migration-upgrade.mjs` | build a database at a representative earlier migration head, apply the remaining migrations, then re-run the P07/P08 probes and require the same verdicts |
| 5.6 | `VI-REL-001` (V4 leg) | stub server + a local HTTP endpoint | connect failure, 429, 5xx, timeout, malformed body, downstream disconnect, against the real inference and webhook transports; assert bounded retry, stable error codes, correct reservation release, and no duplicate effect |
| 5.7 | `VI-TEST-001` gap | extend `p09-mutation-campaign.mjs` | add the two mutations `proof-obligations.md` requires and that the campaign lacks: "accept a consumed auth ceremony" (after VFY-001 is fixed) and "bypass one idempotency guard" (the runtime guard, not just the storage trigger) |

---

## 6. Promote the browser probe into the repository and gate it (structural)

The absence of any browser harness is why VFY-001, VFY-002, and VFY-003 existed for as long as
they did. The probe in `evidence/` is dependency-free (Node 24 `WebSocket` + `fetch` over CDP)
and already catches all three.

- [x] move `evidence/cdp.mjs` + `evidence/browser-probe.mjs` to `apps/web/scripts/` (or
      `apps/api/scripts/`) as a first-class probe, with the Playwright-Chromium-bundle
      limitation documented and system Chrome as the supported path
- [x] add `smoke:browser` to `apps/api/package.json` and to the root `test`/`check` chain
- [x] add it to `.github/workflows/checks.yml` **after** the migrations step, the way
      `p08:invariants` is
- [x] add the missing root `smoke:p03` alias for symmetry with `smoke:p02/p04/p05`
- [ ] add a CI budget job for the web/Worker bundle sizes that ADR 0004 already names, and
      record the current Worker figure (gzip 2393.75 KiB, ~80 % of the 3 MiB free-tier
      compressed limit) as the baseline rather than leaving it unstated

**Why this matters more than its size.** `AGENTS.md`'s Definition of Done requires visual UI
changes to be compared against `docs/screens/` with evidence recorded. `STATUS.md` records that
debt for P06, P07, and P08 as "no browser pass". This action is what stops that from recurring.

---

## 7. External and operational proofs (see `missing-external-proofs.md`)

- [ ] `VI-MIG-002` and `VI-CON-002` in the `RunLumi/LumiAgents` repository, with the client
      artifact version recorded in `docs/release/compatibility-matrix.md`
- [ ] staging deploy, then `VI-OBS-001`'s V5 half: end-to-end request correlation and
      protected-content inspection of sampled logs
- [ ] bounded AI-provider canary with two providers (only after VFY-001 — the gateway's
      primary path currently panics)
- [ ] payment sandbox and a real mailbox for F17/F18/F01 delivery claims
- [ ] production-scale restore measurement with a stated RPO/RTO

---

## 8. Process change worth making

This campaign found the same **shape** of defect twice:

1. `passkey_auth::now_secs` — host `SystemTime` assumed to work; the assumption was shared by
   the library choice, the mitigation comment, the unit test, every CI gate, and the phase
   status.
2. `is_guard_violation` — an error *text* assumed stable; migration 0020 changed it and every
   guard silently reclassified.

Both are correlated error across implementation, test, and record. Neither is detectable by
reading code. The cheap structural countermeasure is a **runtime-probe coverage assertion**:
a test that enumerates the routed `POST`/`GET` handlers and requires each one to be named by
at least one runtime probe or explicitly listed as an accepted gap. That single check would
have surfaced "no passkey endpoint is exercised anywhere" before release, and it is the same
idea the tenant-isolation audit already applies to SQL.

- [ ] write that assertion as a work packet; it needs no product change and closes the class
      rather than the instance
