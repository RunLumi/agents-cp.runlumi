# V01 — Adversarial Security and State Verification

## Status

**in progress.** **Ten findings**, four of them product defects found and fixed — one
**critical** (V01-009: four route modules require an `Idempotency-Key` and then discard it, so
every retry executed again) and three narrower. Eight of the nine required families now have a
gate whose failure has been *watched*, and three of those gates were written in this round.

The remaining work is listed item by item below with the specific missing evidence for each.
Nothing is carried as "probably fine".

## What this campaign has produced

| finding | severity | kind | state |
|---|---|---|---|
| **V01-003** an admin can mint unlimited co-owners, bypassing the security-check-gated ownership transfer | **critical** | product defect | **closed** — fixed, original attack re-run unchanged at 0 escalated, 4 of 4 mutations detected |
| **V01-005** the identity-link feature cannot be completed, so FR-F01-012's MUST NOT is enforced by unreachable code | low | functional defect | **open** — GAP-003, deliberate change process, no MUST violated |
| **V01-006** concurrent reservations cannot overspend a hard budget | none found | absent evidence | **closed** — 8 for 240 yields 3 grants holding 90; B1 oversells to 240 when the ceiling is neutralised |
| **V01-007** the migration ledger had only ever been applied to an empty database | none found | absent evidence | **closed** — two populated prior states, 19/19, both mutations detected |
| **V01-008** every project PATCH was refused with 409, because `SET` and `WHERE` disagreed | **high** | product defect | **closed** — the rename/visibility/archive path had never worked; 3 of 3 mutations detected |
| **V01-009** four route modules require an `Idempotency-Key` and then discard it, so every retry executes again | **critical** | product defect | **closed for `projects.rs`** — 6 racers on one key made 6 projects, now 1; 41/41, 4 mutations detected; 3 modules open as GAP-005/006 |
| **V01-010** a provider dispatch that never reached the provider was reported, and the cause was then discarded | medium | observability defect | **closed** — the endpoint and cause are logged; 2 unit tests; 429/5xx/malformed recorded as GAP-007 |
| **V01-011** `POST /orgs/{org}/automations` can never succeed — the 201 body was built by reading back a row the un-run batch would have written | **high** | product defect | **404 closed**; a SECOND 503 keeps the route non-functional. Localised: not the schedule (every kind that validates hits it), and all seven batch statements are provably valid — the reason is unrecoverable because the failure silences the Worker's log |
| **V01-012** no probe can read a log line written by the Worker, so every `report_error` is unprovable | high (verifier) | verifier defect | **closed** — `--log-level debug` plus a teed console file and `workerConsole()` |
| **V01-011** `POST /orgs/{org}/automations` could not succeed — twice over | **high** | product defect | **closed**. The 201 body read back a row the un-run batch would have written (404, nothing written); then the insert itself named 34 columns and 33 values and bound a **user id** to `created_at` (503, nothing written). Now `201`. `schema:bind-count` was green throughout — the first concrete instance of GAP-004 |
| **V01-013** the attempt counter that bounds automation retries is written by nothing | **high** | product defect | **CLOSED.** `TRANSITION_OCCURRENCE_SQL` gained `attempt = COALESCE(?14, attempt)`, with `Some(attempt)` from the claim and `None` from the other five transition routes. **Two enforcement points came alive, not one**: the claim's guard *and* the expiry sweep's exhaustion test, which had never executed in the product's life. 1010 → 1013 tests, three regression tests, `pnpm check` green |
| **V01-014** the attack on V01-013: is the retry bound *enforced*, or only *unreachable*? | **high** | product defect | **CLOSED with V01-013 — 34/34, exit 0.** The sweep now resolves an expired slot to `failed` / `lease_expired_retry_exhausted` (was: back to `pending`), and the third claim answers **`409 automation_invalid_state`** instead of a detail-less **`503`**. A device that lost its lease is told the slot is spent rather than that the store is down. **Two of my own assertions were wrong and the product was right**, in opposite directions |

| **V01-014** the attack on V01-013: is the retry bound *enforced*, or only *unreachable*? | **high** | product defect | **FAIL, 27/31.** The arc ran to completion and every control held -- the sweep expired the lease, the occurrence stayed `pending` and claimable, the first claim took exactly one lease, a second claim while leased was `409`. But the **third** claim answered **`503 service_unavailable` with empty `details`**, not an exhausted-attempt refusal. Because `attempt` never advances, the re-claim recomputes `attempt = 1` and its attempt row collides on `ux_automation_occurrence_attempts(occurrence_id, attempt, outcome)`, aborting the batch. A device that lost its lease and retried is told the whole store is down. **Same root cause as V01-013, so the same fix removes it** |
| **V01-015** do `approve_enrollment` and `revoke_device` honour an `Idempotency-Key`? | **medium** | product defect, **HALF CLOSED — 21/23** | **`revoke_device` is closed**: the claim is taken after authorization and before the state decision, the `409 "already revoked"` refusal is preserved verbatim but now decided from the record already read, and a same-key replay returns the stored `204` while a different key still gets `409` — so a retry and a new request are finally distinguishable. **`approve_enrollment` is blocked on V01-020**: its body is a read-back projection and the helper requires the success before the write. Repairing it also found and closed a latent defect in the campaign's own pattern — `replay_response` could not replay a `204`, across 182 call sites |

| **V01-016** must a **revoked device** be refused, and can it mint a new token? | **critical** if it reproduced | claim **PASS**, adjacent defect **FAIL** | the credential claim **holds, with runtime evidence for the first time**: after a real revocation (`status` → `revoked`, token rows **2 → 0**, read from D1) both tokens answer `401` and a full refresh answers `403, minted=false`. What the run found instead is **V01-019** |
| **V01-019** `GET /api/v1/devices/token/nonce` is **unauthenticated** | **medium** | product defect | **CLOSED — 29/29, exit 0.** The route now takes `HeaderMap` and calls `authorize_device`, and `authorize_device` itself refuses a non-active device — because `DEVICE_TOKEN_BY_HASH_SQL` never joins `devices`, so revocation was a **single** mechanism with no second check. Both an anonymous caller and a revoked device now get `401`. The regression test walks **`app.rs`** rather than pinning the route, and was **shown to fail** by re-introducing the defect |

| **V01-017** can one address be invited twice, and what happens under concurrency? | none | **hypothesis falsified** | **NOT_APPLICABLE — the defect does not exist.** A sequential duplicate answers `200` with `duplicate: true` and the same id; six concurrent racers on one key give **1 creation + 5 replays**; four on four keys give **1 + 3**; one row per email; no 5xx; audit events = 3 for 3 invitations. The read-then-write is correct because the derived id is stable per *(org, email, role)*, so the read **hits** — the constraints are the backstop, not the mechanism. My `503` prediction was wrong, and so were two of my assertions |
| **V01-020** the idempotency helper cannot express a response built from the row it writes | architectural | product constraint, not repaired | **all 27** `commit_scoped_mutation` sites build their stored success from inputs and **none** reads the row back, so the limit is uniform and documented — and it is why `approve_enrollment` is unwired. Repair needs either a synthetic projection duplicating the DDL's defaults or a contract change across 27 call sites. It also exposed a **silent** limit, now closed: `replay_response` answered `500` for any `204` |
| **V01-018** the discarded-`Idempotency-Key` class, enumerated exactly | **medium** | product defect, unproven per site | **3 sites, not 76.** A substring pattern counting `idempotency_key(...)?;` matched both the discarded statement and the tail of `let key = idempotency_key(...)?;`, so 71 correct sites were counted as broken. Requiring the call to be the whole line gives 3: `approve_enrollment`, `revoke_device` (V01-015 attacks both) and `delete_project_binding` (unattacked). The defect is that **no route replays its first response**; two of the three are protected by incidental state guards, which is the dangerous shape, because a naturally-idempotent operation looks correct to a state-graded gate |
| **V01-002** a verifier measured code that was not on disk | high | verifier defect | **closed** — `buildFreshness()` added so it cannot recur silently |
| **V01-001** the adoption privacy property is under-specified, and the probe that "proved" it was searching nothing | high (verifier) / gap (spec) | verifier defect + spec gap | **closed** — probe retargeted to the three rules that exist; GAP-001 recorded |
| **V01-004** three authentication attacks the family names and nothing had ever run | none found | absent evidence | **closed** — 55/55 → 76/76, and one of the three turned out to be testing the wrong condition |

Three new runtime gates:

| gate | cases | sensitivity |
|---|---|---|
| `pnpm verify:adoption-privacy` | 20/20 | 2 of 2 detected |
| `pnpm verify:privilege-escalation` | 46/46 | 4 of 4 detected |
| `pnpm verify:budget-concurrency` | 27/27 | B1, B2 detected; B3 an expected MISSED |
| `pnpm verify:idempotency` | 41/41 | 4 of 4 detected, 1 KNOWN MISSED with its reason recorded |
| `pnpm verify:filter-tenancy` | 65/65, 9 skipped | 4 of 4 detected, each printing the identifiers it leaked |
| `pnpm verify:inference-failure` | 65/65, 0 skipped | 3 of 3 detected, incl. the success case stranding money |
| `pnpm verify:invitation-race` | **23/23, exit 0 — GAP-006 is falsified, not fixed.** 11 requests over a control, a sequential duplicate, six concurrent on one key and four concurrent on four keys. One row per email throughout, no 5xx anywhere, and the audit count matches the row count |
| `pnpm verify:revoked-device` | **29/29, exit 0.** Every leg is controlled by a success **before** the revocation, including a real pre-revocation token mint, so a post-revocation refusal is attributable to the revocation rather than to a route that never worked. The **anonymous** leg is asserted before *and* after, because a revoked device still once had a credential and so cannot stand in for a caller with none. Two `STRUCTURAL:` assertions establish that the device-token lookup does **not** join `devices` |

| `pnpm verify:device-idempotency` | **19/23 — 4 FAILs are the confirmed V01-015 defect.** Each case ends with a **different-key** call as a positive control, comparing answers while ignoring `request_id`, so "the route refuses repeats for a reason unrelated to the key" cannot pass as "the key was honoured". Graded on stored state: device rows, audit rows, token counts and `revoked_at` |
| `pnpm verify:attempt-exhaustion` | **34/34, exit 0, 1 named SKIP.** claim → wait out the 30s TTL → the sweep expires the lease → claim again with `max_start_attempts: 1`. It is the attack that separates a dead counter from an unenforced bound, and it is what turned V01-013 from a hunch into a severity. The SKIP is the two-phase `start_occurrence` transition, which re-reads the organization entitlement and needs an entitled fixture |

| `pnpm verify:lease-contention` | **58/60 — 2 FAILs are the open V01-013 defect, asserted on purpose.** **The earlier 32/34 was a partial run and the record has been corrected**: the probe died inside its first case on `no such table: automation_attempts` (the table is `automation_occurrence_attempts`), and because `bail()` exited 1 when it died *after* recording the two known failures, the run looked like a completed one. The three cases that never ran — two devices racing, sequential re-claim, and a cross-tenant device — are now measured for the first time |
| pending: the exclusivity claim needs a sensitivity proof |
| `pnpm verify:migration-prior-state` | 19/19 | 2 of 2 detected, first attempt |
| `pnpm verify:mutating-tenancy` | 43/43 | 3 of 3 detected, incl. the V01-008 defect verbatim |

## The one that mattered

`PATCH /orgs/{org}/members/{id}` with `{"role":"owner"}`, issued by an **admin**, returned
200 and stored. An admin could promote anyone — including itself — to owner, at will, and a
campaign run ended with three active owners in an organization that had one.

The authorization decision never saw the requested role. `change_role` parsed `body.role`,
validated it, and passed the *target's existing* role into the predicate:

```rust
can_change_role(actor_role, target_role, target_status)
//                    ^ the target's CURRENT role
```

so the only owner protection expressible was "an admin may not re-role somebody who is
already an owner". Nothing prevented **creating** one.

The product's own design says this is a bug, with no interpretation needed:
`org.ownership_transfer` is a separate permission from `members.manage`; the transfer route
additionally demands a recent security check; `role_can_be_invited` refuses `owner` for every
actor including owners. Owner is **transferred**, never assigned — and `change_role` walked
past all three.

Fixed by making the requested role an argument and renaming the parameter
`target_current_role`, so the old wiring is a type error rather than a silently wrong answer.

## The pattern that produced the findings

**Six of the ten findings were found by an assertion that disagreed with itself or with its own
context, not by a code review.** In every case the same discipline found it:

1. **Read the state, not the response.** A 2xx that ignored the field is correct; a 2xx that
   granted it is a breach. Only the second is a failure, and only reading D1 tells them apart.
2. **Prove a negative can be believed.** A search that cannot find a marker it plants will
   report clean over a table full of payloads. The adoption probe reported "0 hits" with a
   private key in the table, because one NULL column made the whole scan string empty.
3. **Take a baseline immediately before the action.** A count remembered from earlier in a
   run makes a negative assertion true or false for the wrong reason.
4. **Let a refused prerequisite stop the section.** The recovery probe reported that sessions
   survive a password reset — the exact shape of a critical defect — because its own reset
   request was malformed and the three assertions after it kept running anyway.
5. **Require a write to SUCCEED.** V01-008 was found by the positive control of a probe built
   for a different purpose: every cross-tenant attack was correctly refused, and the one call
   that had to work — an owner renaming its own project — answered 409. This is the third defect
   in this repository of the shape *"a route that answers a plausible response and has never
   succeeded"*, after `teams` and the 15 `evt_` audit writes. None is a logic error, and none is
   visible to a gate that only reads responses.
6. **When a batch fails and every statement in it is provably valid, submit LESS of it.**
   V01-011's second fault — `INSERT_AUTOMATION_SQL` naming 34 columns against 33 values — was
   read past, executed by hand against the real database individually and inside one transaction
   with foreign keys on, and executed again through D1's own layer. All five attempts said the
   statement was fine. The thing that found it was removing that one statement from the
   product's own batch: the route answered `201`. The reasoning is that a defect which survives
   "run it by hand" is usually not in what the statement *says* but in what the *batch* is, and
   subtracting from a batch is cheap where more reading is not.
   V01-011's first fault is the same shape one layer out: a route that built its 201 body by
   reading back a row the un-run batch was about to write. A response assembled from the database
   is a response that can be assembled from the wrong moment.

## A gate that dies is not a gate that passed, and this harness made that invisible

The most consequential defect of the round was not in the product at all.
`verify:lease-contention` had been reporting **32/34** since the moment it was written, and the
campaign record had closed the automation-lease family on that basis. In fact the probe **died
inside its first case**, on `no such table: automation_attempts` — the table is
`automation_occurrence_attempts` — and three of its four cases had never executed.

What made it invisible was the harness, in exactly the way this campaign's own rules forbid:

```rust
if (this.failures.length === 0) process.exit(2);
process.exit(1);
```

A probe that died **after** recording a failure exited **1**, the code that means "the product is
broken". So a run that stopped in its first case was indistinguishable from a run that graded
every case and found two defects, and the numbers a reader could see were a fraction whose
denominator silently excluded everything that never ran.

Three things had to be true for that to pass unnoticed, and each is now a check:

1. **the failure was real but boring** — a SQL typo, the kind that reads as a product bug for
   exactly as long as you do not check the table name;
2. **the fraction still looked like a fraction** — 32/34 is a plausible number, and nothing in
   it says "three cases did not run";
3. **the harness reported the run as finished** — no summary line, no exit-2, nothing.

The fixes are general rather than specific: `bail()` now **always** exits 2 and states how many
cases were reached and that everything after the failure was never run; and every caller that
drives a probe requires the probe's own summary line before it will accept the log, so a partial
run cannot be a verdict whatever the exit code claims.

The generalisation is the part worth keeping: **a gate's denominator is a claim about what ran.**
A verifier that reports a ratio must make the denominator checkable, or the ratio can be made to
look like evidence by the simple expedient of not running the hard part.

**Two counts agreeing is not a correspondence.** `INSERT_AUTOMATION_SQL` bound 30 values and
named 30 distinct placeholders, so `pnpm schema:bind-count` was green while the statement could
not be prepared at all. That is GAP-004 — recorded before the defect was found — with a
concrete instance, and it is the sharpest available statement of why a structural check and a
behavioural one are both necessary: the count proves arithmetic, and only a probe that requires
the write to succeed proves correspondence.

## Gates on the merged tree

| gate | result |
|---|---|
| `pnpm check` | exit 0 |
| `pnpm smoke:passkey` | **76/76**, exit 0 (was 55/55) |
| `pnpm verify:adoption-privacy` | 20/20, exit 0 |
| `pnpm verify:privilege-escalation` | 46/46, exit 0 |
| `pnpm smoke:p02` | exit 0 |
| `pnpm smoke:p03` | exit 0 |
| `pnpm smoke:browser` | 39/39, exit 0 |
| `pnpm verify:idempotency` | **41/41**, exit 0 |
| `pnpm verify:filter-tenancy` | **65/65**, 9 skipped, exit 0 — no leak on any surface |
| `pnpm verify:inference-failure` | **65/65**, 0 skipped, exit 0 |
| `pnpm verify:provider-faults` | **exit 2 — BLOCKED**, see GAP-007 |
| `pnpm smoke:p04` / `pnpm smoke:p05` | exit 0 |
| `v01-001-sensitivity.sh` | 2 of 2 detected |
| `v01-003-sensitivity.sh` | 4 of 4 detected, source verified back to its snapshot |
| `v01-004-sensitivity.sh` | 1 of 3 detected; **A1 and A3 are honest MISSEDs** — see below |
| `v01-006-sensitivity.sh` | 2 of 2 gating cases detected; B3 an expected MISSED, exit 0 |
| `v01-007-sensitivity.sh` | 2 of 2 detected, first attempt, exit 0 |
| `v01-008-sensitivity.sh` | 3 of 3 detected, exit 0 |
| `v01-009-sensitivity.sh` | 4 of 4 detected; 1 KNOWN MISSED, explained |
| `v01-filter-sensitivity.sh` | 4 of 4 detected, each printing the ids it leaked |
| `v01-infer-sensitivity.sh` | 3 of 3 detected |

## What is still UNPROVEN, and why

Nothing below is claimed as a pass. Each names the specific evidence that is missing.

| item | verdict | what is missing |
|---|---|---|
| FR-F01-012's MUST NOT — conflicting identities must not auto-merge | **UNPROVEN** | the guard is unreachable code; `link_identity_start` needs a reauth grant whose purpose cannot be minted (V01-005, GAP-003) |
| wrong-kind ceremony: the single-layer mutation | **not load-bearing** | two independent gates refuse it, so weakening one is invisible through HTTP. Recorded as defence in depth, and the reason the lower gate is proven by unit tests |
| the email-conflict guard | **not load-bearing** | same, and it is unreachable in any case (V01-005) |
| ~~migrations on **representative prior state**~~ | **CLOSED in V01-007** | 19/19. Two cut points: 0015 (the ledger seeds rows by design) and 0019 with stored idempotency claims. `p08-invariants` still 17/17 on the populated path |
| ~~concurrent reservations against a hard budget ceiling~~ | **CLOSED in V01-006** | 8 concurrent requests for 240 against a limit of 100 yield 3 grants holding 90. `verify:budget-concurrency`, 27/27, sensitivity-proven. A released hold returns its capacity and a denied request can then reserve it |
| a reservation's SQL inference-correlation clause | **redundant second line** | the route resolves the request first and returns 404. B3 is an expected MISSED, recorded in V01-006 |
| ~~inference streaming: fail-before-output, timeout, output-then-fail, client disconnect~~ | **CLOSED in `verify:inference-failure`** | 65/65, 0 skipped. After every outcome no reservation is left `reserved` and every request reaches a terminal state, graded on two D1 tables. Client-disconnect side effects were previously *performed and never checked* |
| inference streaming: **429, 5xx, a genuinely malformed chunk** | **BLOCKED — GAP-007** | the probe exists and counts the requests reaching a real local server, but `wrangler dev` here does not route a Worker's outbound fetch to a host-local endpoint, so it exits 2. V01-010 is what made the blocker nameable |
| ~~cross-tenant substitution through FILTERS, PAGINATION and NESTED routes~~ | **CLOSED in `verify:filter-tenancy`** | 65/65, 9 skipped, **no leak found** on any surface, including through the audit route's `metadata_json`. Four mutations detected |
| ~~same key + incompatible payload, concurrent same-key, cross-principal key reuse~~ | **CLOSED in V01-009, after a critical defect** | 6 racers on one key made 6 projects; now 1. 41/41 |
| a failed provider dispatch's cause | **CLOSED in V01-010** | it was discarded entirely; `provider_unavailable` was the whole answer for a refused socket, a DNS failure and a bad endpoint alike |
| `devices.rs` and `foundation_checks.rs` also require a key and ignore it | **UNPROVEN — GAP-005, narrowed** | **half the gap was wrong and reading the member removed it**: `foundation_checks.rs` builds a full `IdempotencyScope`, digests the key, fingerprints the body and does `lookup` + commit-time `lookup` with `replay_response`. It entered the gap because the gap was written by reading *for the pattern*. `devices.rs` is real — `approve_enrollment` and `revoke_device` both discard the key — and **V01-015** (`verify:device-idempotency`) is written to measure it, with a different-key positive control per case. Reading falsified the high-severity hypothesis before the probe ran: `INSERT_DEVICE_SQL` sits under `UNIQUE (org_id, key_fingerprint)`, so a replayed approval cannot duplicate a live device |
| ~~`organizations.rs` invitations read-then-write a deterministic id~~ | **CLOSED BY FALSIFICATION in V01-017** | `verify:invitation-race` is **23/23, exit 0**. A sequential duplicate with a *different* key answers **`200` with `duplicate: true`** and the same invitation id; six concurrent racers on one key give **1 creation + 5 replays**; four on four keys give **1 + 3**; one row per email in all four cases; **no 5xx anywhere**; and `membership.invited.v1` audit events = 3 for the 3 invitations that exist. The read-then-write is correct because the derived id is stable per *(org, email, role)*, so the read **hits** — the PRIMARY KEY and `ux_invitations_pending_target` are the backstop, not the mechanism. The `503` this gap predicted does not occur |
| ~~migrations on **representative prior state**~~ | **CLOSED in V01-007** | two cut points only, no assertion about the *content* of a backfill, and foreign keys are not exercised. Those limits are listed in the finding |
| ~~mutating cross-tenant calls~~ | **CLOSED in V01-008's probe** | 11 mutations from another tenant's owner and from a plain member of the same tenant, across role, capability, project, budget and org. 0 of 11 changed state; refusals are 404 for both an existing and an absent id, so there is no existence oracle. **Still open**: list/**filter**, **pagination** and **nested** substitution, and 28 more mutating routes |
| 82 of 104 org-scoped routes | **partly closed** | 20 read routes in `smoke:p08` plus 11 mutating routes in `verify:mutating-tenancy`. No filter, pagination or nested substitution anywhere |
| 14 of the 15 repaired audit call sites | **UNPROVEN** | repaired in #39; only some have individual runtime evidence |
| `delete_project_binding` discards its `Idempotency-Key` | **UNPROVEN — V01-018 site 3** | a retried delete answers **`404`** because the binding is gone, so the pre-read 404s before the audit write. No duplicated state, and **that is the problem**: the operation is naturally idempotent, so a state-graded gate passes it and only a **response-replay** check can see the defect. `verify:idempotency` grades on row counts and is structurally unable to. It is named here because the *corrected* inventory found it — the uncorrected one reported 76 sites and would have sent a sweep after the 71 that are already right |
| ~~a **revoked device** driven to a refusal~~ | **CLOSED in V01-016** | 25/26, and the credential claim **passes**: after a real revocation, `status = 'revoked'` and token rows **2 → 0** in D1, both tokens answer `401`, and a full refresh signed over a real server-issued nonce answers `403` with `minted=false`. What the run found instead is **V01-019**, the unauthenticated nonce endpoint |
| a revoked session's **refresh** token | **UNPROVEN** | the recovery section proves the session dies; not that its refresh token does |
| the reauth grant's own ceremony kind | **UNPROVEN** | a reauth grant is a ceremony; the kind attack does not cover it |
| the last-owner rules at the HTTP layer | **UNPROVEN** | `f02` requires that removing or demoting the last owner fails transactionally. `can_leave` is unit-tested; the routes are not attacked. GAP-002 |

## The correction this campaign had to make to itself

The coverage map's first draft claimed, for the budget family, *"usage attribution 0
mentions, overspend 0 mentions"*. **Both were false.** `smoke:p05` asserts attribution
directly — `usage.org_id === orgA.orgId`, `usage.run_id === created.runId`. I had counted
keyword occurrences and reported the count as coverage.

That is the same class of error as V01-001, at a different scale, and it is recorded in the
map because a map built by grepping is a list of words rather than a list of claims. It will
confidently report a well-tested property as untested, which is worse than leaving the row
blank: it sends the next reader looking for a defect that is not there.

## Tooling facts established here, so nothing rediscovers them

- **D1 refuses a result set wider than 100 columns.** 100 accepted, 101 refused. Measured
  with `apps/api/node_modules/.bin/wrangler`; documented on `smoke-harness.mjs::d1Rows`.
  Compound SELECT is not restricted.
- **`npx` is blocked** in this repository by `pkg-age-guard`, so a limit measured through
  `npx wrangler` is a measurement of the guard. It is how a 100-column limit first appeared
  to be 1000.
- **`buildFreshness()`** compares the newest source against the compiled Worker and fails the
  run when the artifact predates it. It proves artifact-matches-tree. It cannot tell you the
  tree is correct — it reported PASS on a run whose source still carried a deliberate fault.
- **A sensitivity harness must restore with `cp` and verify against a snapshot.** `mv`
  preserves the pre-fault mtime and the build is skipped (V01-002); a snapshot directory that
  was never created makes every restore a no-op and leaves faults compiled in (V01-003).
- **A sensitivity harness needs `set -e` and an explicit "did the mutation apply" check.**
  `set -uo pipefail` does not abort, so three mutations whose asserts failed reported three
  MISSED verdicts for runs that never happened (V01-006). The one harness written with
  `set -e` and that guard from the start — V01-007's — worked on its first attempt.
- **Capture stderr when driving wrangler.** A `CHECK` failure goes to stderr while the
  confirmation banner goes to stdout, so a stdout-only capture reports every failing write as
  a success (V01-007).

## Order of the remaining work

1. ~~Budget: concurrent reservations against a hard ceiling.~~ **Done** — V01-006.
2. ~~Migrations on representative prior state.~~ **Done** — V01-007.
3. ~~Mutating cross-tenant calls.~~ **Done** — V01-008's probe, and it found a high-severity
   defect on its first run. Still open in this family: **filter**, **pagination** and **nested**
   substitution, and 28 more mutating routes.
4. **Inference streaming through a real Worker.** Four `mock://` fault modes exist and have
   never been driven over HTTP; 429, 5xx and malformed chunks additionally need a local fake
   provider, which `allow_local_provider_endpoints` makes reachable in development.
5. GAP-002 (last-owner rules at the HTTP layer) and the three residual authentication claims.

## Provenance

Four commits on `main`, pushed:

| commit | what |
|---|---|
| `9c38826` | V01-001 adoption/privacy attack + V01-002 stale-build repair |
| `95c3841` | **V01-003 the critical escalation, fixed** |
| `220e604` | V01-004 the three missing authentication attacks |
| `439206f` | V01-004 sensitivity proof + V01-005 the dead identity-link feature |

The repository squash-merges, so per-round commits are not on `main`; these are direct
pushes to `main` and are present as-is.
