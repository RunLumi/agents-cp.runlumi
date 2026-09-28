# V01 — Adversarial Security and State Verification

## Status

**in progress.** Six families attacked, eight findings, two product defects found and fixed
(one **critical**, one **high**), and three claims proven that had no evidence at all. The remaining families and every open item are listed below with what is missing
and why it is still missing.

## What this campaign has produced

| finding | severity | kind | state |
|---|---|---|---|
| **V01-003** an admin can mint unlimited co-owners, bypassing the security-check-gated ownership transfer | **critical** | product defect | **closed** — fixed, original attack re-run unchanged at 0 escalated, 4 of 4 mutations detected |
| **V01-005** the identity-link feature cannot be completed, so FR-F01-012's MUST NOT is enforced by unreachable code | low | functional defect | **open** — GAP-003, deliberate change process, no MUST violated |
| **V01-006** concurrent reservations cannot overspend a hard budget | none found | absent evidence | **closed** — 8 for 240 yields 3 grants holding 90; B1 oversells to 240 when the ceiling is neutralised |
| **V01-007** the migration ledger had only ever been applied to an empty database | none found | absent evidence | **closed** — two populated prior states, 19/19, both mutations detected |
| **V01-008** every project PATCH was refused with 409, because `SET` and `WHERE` disagreed | **high** | product defect | **closed** — the rename/visibility/archive path had never worked; 3 of 3 mutations detected |
| **V01-009** four route modules require an `Idempotency-Key` and then discard it, so every retry executes again | **critical** | product defect | **closed for `projects.rs`** — 6 racers on one key made 6 projects, now 1; 41/41, 4 mutations detected; 3 modules open as GAP-005/006 |
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
| `pnpm verify:filter-tenancy` | 54/54, 5 skipped | 3 of 3 detected, each printing the identifiers it leaked |
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

**Four of eight findings were found by an assertion that disagreed with itself or with its own
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
| `v01-001-sensitivity.sh` | 2 of 2 detected |
| `v01-003-sensitivity.sh` | 4 of 4 detected, source verified back to its snapshot |
| `v01-004-sensitivity.sh` | 1 of 3 detected; **A1 and A3 are honest MISSEDs** — see below |
| `v01-006-sensitivity.sh` | 2 of 2 gating cases detected; B3 an expected MISSED, exit 0 |
| `v01-007-sensitivity.sh` | 2 of 2 detected, first attempt, exit 0 |
| `v01-008-sensitivity.sh` | 3 of 3 detected, exit 0 |

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
| inference streaming: 429, 5xx, malformed chunk, timeout, client disconnect | **UNPROVEN** | unit-tested in Rust (`p09_failure_tests`) but never driven through a real Worker. `mock_dispatch` has five fault modes selectable by `endpoint` (mock://lumi-fail, mock://lumi-timeout, mock://lumi-post-output-failure, mock://lumi-success) and is a ready-made surface |
| ~~migrations on **representative prior state**~~ | **CLOSED in V01-007** | two cut points only, no assertion about the *content* of a backfill, and foreign keys are not exercised. Those limits are listed in the finding |
| ~~mutating cross-tenant calls~~ | **CLOSED in V01-008's probe** | 11 mutations from another tenant's owner and from a plain member of the same tenant, across role, capability, project, budget and org. 0 of 11 changed state; refusals are 404 for both an existing and an absent id, so there is no existence oracle. **Still open**: list/**filter**, **pagination** and **nested** substitution, and 28 more mutating routes |
| 82 of 104 org-scoped routes | **partly closed** | 20 read routes in `smoke:p08` plus 11 mutating routes in `verify:mutating-tenancy`. No filter, pagination or nested substitution anywhere |
| 14 of the 15 repaired audit call sites | **UNPROVEN** | repaired in #39; only some have individual runtime evidence |
| a **revoked device** driven to a refusal | **UNPROVEN** | `p03` and `p05` mention device revocation; neither attacks it |
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
