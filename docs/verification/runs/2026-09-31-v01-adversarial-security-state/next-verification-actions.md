# V01 — next verification actions

Ordered by what is still unfalsified, not by what is easiest to fix.

## GAP-001 — adoption identifiers carry user content, and nothing says they must not

**Status:** open, needs the deliberate change process, **not** a code change.

`POST /orgs/{org}/adoption/bindings` stores the client's `external_workspace_key` and
`display_name` verbatim. Attacked with eight content classes (`prompt`, POSIX path, Windows
path, private-key body, API key, conversation history, MCP secret, arbitrary note); all eight
are stored, in the client's own organization, and served back by `GET /adoption/bindings` to
every org member.

What *is* enforced, and proven: the key refuses a path, the database refuses a path
independently, and no payload reaches `security_events`.

What is not enforced, and not required: nothing in `f01`–`f26` says an adoption identifier
may not contain text. `display_name` is free text by design. The decision needed is whether
adoption identifiers are opaque, and if so the requirement gets written first and enforced
second — the reverse order is how a verifier ends up weakened to match a probe.

Evidence: `findings/V01-001-…md`, `evidence/v01-001-stored-rows.txt`.

## GAP-004 — `schema:bind-count` proves arithmetic, not correspondence

It checks that each `prepare()` binds as many values as its SQL has placeholders. It cannot see
a statement that has the *right number* of binds in the *wrong slots*, and it did not: V01-008's
`UPDATE_PROJECT_SQL` used `?2..?6` in `SET` and `?1, ?7, ?8` in `WHERE` with `?1` bound to the
project's **name**, and 8-for-8 passed. Every project PATCH was refused with
`409 version_conflict` for the life of the route.

Two cheap additions catch the whole shape: no placeholder may appear in both a `SET` target and a
`WHERE` comparison, and no `SET` target may be a primary key or a tenant column. A placeholder
used for two different columns is malformed whatever the count says.

**This gap now has a second, and much stronger, instance — and part of it is already closed.**
`INSERT_AUTOMATION_SQL` shipped with **34 columns and 33 values**, and bound `?29` (a `usr_` + 32
hex **user id**, 36 characters) to `created_at` **and** `updated_at`, which are `CHECK (length(…)
= 24)`. SQLite refused the statement at prepare, so every `POST /orgs/{org}/automations` answered
`503` and wrote nothing. `schema:bind-count` was **green**: the statement bound 30 values and
named 30 distinct placeholders. Two counts agreed and the statement was still unrunnable, which
is the cleanest possible demonstration that a count is not a correspondence.

**Partly closed.** `repositories/automations.rs` now carries three unit tests that check what
bind-count structurally cannot, on the SQL text and on every `cargo test`:

- `every_insert_binds_one_value_per_column` — columns equal values, for every INSERT the module
  prepares;
- `no_placeholder_is_reused_across_columns` — no placeholder may serve two columns, which is
  what turned a user id into a timestamp;
- `the_automation_insert_binds_its_own_timestamps` — the specific instance, pinned.

**Still open, and it is the same class:** the first test and the second are hand-written per
module, so a statement added to a *different* module is not covered by them. The honest general
fix is a single repository-wide test that walks every `INSERT INTO` constant in the crate, plus
the two rules above — a property of the schema's own text rather than of one file. Until that
exists, V01-008's and V01-011's two statements were both caught only by a runtime probe
requiring the write to succeed, which is the correct backstop and the slowest one.

The stronger property — that the write actually lands and lands in the right columns — is
covered by `verify:mutating-tenancy`'s per-route positive controls and, now, by
`verify:lease-contention` needing an automation to exist before it can claim a lease at all. That
is the honest division: a count proves arithmetic, a probe that requires success proves
correspondence.

## GAP-003 — which reauth purpose guards identity linking is unspecified, and the feature is dead until it is

`link_identity_start` requires a grant with purpose `identity_link`; `validate_reauth_purpose`
allows only `passkey_management`, `password_change`, `account_recovery`. No grant with that
purpose can be minted, so `POST /me/identities/link` can never be completed and the
`identity_conflict` guard that implements **FR-F01-012's MUST NOT** is unreachable code.
V01-005. The fix is one line in either of two places, but the two are not equivalent — one
widens what a single security check can authorise, the other reuses an existing purpose — and
`f01` does not say which is intended. Deliberate change process, not a patch.

## GAP-002 — the last-owner rules have no HTTP-layer attack

> **CLOSED.** See [`findings/GAP-002-last-owner-rules-attacked-at-the-http-layer.md`](findings/GAP-002-last-owner-rules-attacked-at-the-http-layer.md) and V01-031. Three HTTP attacks, graded on stored state, with C1/C2/C3 as controls, **68/68** on `verify:privilege-escalation`, **sensitivity 2/2**. The limit that remained -- **FR-F02-006 ownership transfer** (`TransferOwnershipRequest`) -- is now attacked too: see [`findings/FR-F02-006-ownership-transfer-attacked.md`](findings/FR-F02-006-ownership-transfer-attacked.md), **82/82**, sensitivity **2 detected + 1 declared KNOWN MISSED**. Still unattacked *inside* it: a transfer to a **removed** member (the `status != 'active'` branch), and the re-auth grant's **TTL** (T3 uses a grant that never existed, which is weaker than a stale one).

`f02` requires that removing or demoting the last owner fails transactionally. `can_leave` and
`can_remove_member` are unit-tested, and V01-003 proved `can_change_role` had a real defect
behind a correct-looking test. Nothing attacks the *routes*: can the last owner be demoted,
removed, or made to leave? `smoke:p08` does not reach these routes. Add an owner-actor class to
`verify:privilege-escalation` that tries to end with zero active owners.
## The platform's own control plane had no gate — and four defects, and a bypass

> **CLOSED.** See
> [`findings/four-defects-in-one-ungated-surface.md`](findings/four-defects-in-one-ungated-surface.md)
> and the four records it parents.

This was not on any list, which is the point. `/api/v1/internal/**` is staff-authenticated, no probe
could mint a staff principal, and so nothing drove it. It turned out to carry:

- **V01-034 (CRITICAL)** — a staff credential's **secret is never verified**. The token resolves by its
  16-hex lookup prefix, so any well-formed token with a known prefix authenticates, and a wrong secret
  and an unknown prefix answered *differently*, making the endpoint an existence oracle too.
- **V01-035 / V01-036 / V01-037** — three independent reasons every internal **write** answered `503`,
  stacked, the outermost firing before any statement was prepared so it masked the other two.
- **V01-033's sixth site** — `lift_kill_switch`, invisible to a sweep that enumerated four variable
  names.

Four fixes and a bypass in fifty lines of one file. Two general lessons are now in `AGENTS.md`:

- **A documented command that cannot start is a gate that provides no evidence.** Found in the same
  round: `pnpm verify:filter-tenancy` had never run, because the probe's name contained a `/` and the
  harness put it in a filesystem path. It had a recorded 65/65 baseline and four detected mutations,
  all real, because its sensitivity script exported the persist-dir variable and took a different
  branch. A clean **exit 2** is the reason nobody noticed.
- **A verdict with no cause is the same failure as a verdict with no evidence.**
  `commit_scoped_mutation` had been logging SQLite's own message all along and the harness printed it
  only on a bail — so five repairs were spent on one route while the actual cause sat unread.

**What is still open here:** the standing check for V01-035's class is
`security::actor_type_correspondence`, and it grades **hard-coded `actor_type` literals only** — three
of the four sites in this repository *bind* the column, and a static scan cannot follow a bind. The
file counts them so the sheet never implies coverage it lacks, but the class is not closed for bound
values; a probe that drives each writer and reads the row is the only thing that closes it, and
`verify:staff-credential` now does that for all four.

## Unattacked, by family

Refreshed after V01-009. Six of the eleven families are now closed or partly closed; the
table below says what is still missing **now**, not what was missing when this list was
first written.

| # | family | what is missing | why it is next |
|---|---|---|---|
| 1 | ~~client privilege escalation~~ | **closed in V01-003** — 46/46 over 7 field classes (org, project, role, policy version, model alias/route, tool capability, entitlement/budget, credential id), graded on the **stored state** and not the status, 4 of 4 mutations detected. M4 was a critical co-owner escalation the probe found by measuring what was stored rather than what was answered. | closed |
| 2 | ~~budget / cost~~ | **the ceiling closed in V01-006** — 27/27, 8 simultaneous reservations for 240 against a limit of 100 grant 3 holding 90, measured not inferred. **the failure half closed in `verify:inference-failure`** (65/65): after success, fail-before-output, timeout, output-then-fail and a client disconnect, no reservation is left `reserved` and every request reaches a terminal state. **attribution closed in V01-021** — 43/43, exit 0, **0 skipped**: two organizations, a real inference and a real **managed** run in each, graded on a database invariant. 2 of 4 usage rows carry a `run_id`, and a control asserts that count is non-zero so the run clause cannot pass vacuously. Every escalation carries a positive control, after the previous `422`s were found to be **my own malformed body** rather than a refusal. A foreign run is answered identically to a run that never existed (`404/run_not_found` both), so the `404` is not an existence oracle. **Sensitivity: 2/2 detected** — and M1 showed the escalation case is *blind* to which refusal it gets, so the non-disclosure control is a single point of failure for the no-leak requirement. **Still missing:** whether upstream dispatch was *called* is instrumented nowhere. | Money is covered; only the dispatch question is left, and it is `verify:provider-faults`' environment block, not a new build. |
| 3 | ~~authentication~~ | **closed in V01-004** — wrong ceremony kind both ways with a control, identity-link conflict, recovery with active sessions; `smoke:passkey` 55/55 -> 76/76. Still open: a revoked **device** driven to a refusal, whether a revoked session's **refresh** token dies with it, the reauth grant's own ceremony kind. | three of nine cases, then the rest |
| 4 | inference streaming | provider faults are unit-tested in Rust (`p09_failure_tests`) but never driven through a real Worker: **429, 5xx, malformed chunk, timeout, client disconnect**, and emit-content-then-fail. Four `mock://` fault modes exist and have never been driven over HTTP. | A unit test is not an attack across a router. |
| 5 | ~~D1 / migrations~~ | **closed in V01-007** — 0015 and 0019 with stored idempotency claims, 19/19, both mutations detected first attempt. Still open: only two cut points, no assertion about a backfill's *content*, foreign keys not exercised. | mostly closed |
| 6b | ~~tenant isolation — the **collection** routes~~ | **closed for 25 of 32 in V01-027.** `verify:collection-tenancy` is **54/54, 0 leaks**: 25 org-scoped GET collections fetched as Org A and each whole body searched for 4 Org B identifiers read out of D1 plus Org B's email, with a positive-match control and a runtime method classification. `smoke:p08`'s headline moved **80 -> 64 of 104** once the credit was recorded, and its unproven set is now printed **grouped by shape**: 48 one-path-id, 12 collection, 4 nested. | a content search catches a `WHERE` that forgot `org_id`, which no substitution can; the 48 that remain need a parent row each |
| 6c | tenant isolation — the **one-path-id** routes | **18 of 48 closed in `verify:path-id-tenancy`** (198/198, every assertion at full strength, 0 degraded controls, 40 named skips). The `automations` family was added this round and needed an `automations.max_active` entitlement — `entitlement_grants` is **empty in every seeded database**, so without it every create is refused for a reason unrelated to tenancy — plus a project, an agent, and for `resume` a prior **state** rather than merely a prior row. The remaining credited families are named in the probe with the fixture each needs48/148, sensitivity 1 detected + 1 declared KNOWN MISSED), and `smoke:p08`'s unproven count moved 69 -> 60. **Three of its nine carry a DEGRADED control and are UNPROVEN**, not passed: `service-accounts/{id}` PATCH and `/suspend` answer `409 version_conflict` on the owner's own record at the version D1 reports, and `credentials/{id}/rotate` answers `404` for a credential D1 shows user-owned in the same org. The remaining 41 are credited by name, most with the specific fixture each needs. Two of them — `internal.rs`'s feature-flag PATCH and both `plugins.rs` policy writes — **had no gate at all** and were found dead by V01-033's two-order experiment rather than by a probe, because nothing exercises them. Covering them is the next piece of work, and it is the same work the other credited routes need. Two session paths are credited with a **design question** rather than a gap: `login_sessions` has no `org_id`, so `close` needs deciding between caller-scoped and org-scoped |
| 6 | ~~tenant isolation~~ | **mutating half closed in V01-008** (43/43) and the **query-string half closed in `verify:filter-tenancy`** (54/54): 6 filter routes, a foreign keyset cursor and 5 nested paths, graded by searching the whole body for the other org's identifiers. **and the query-string half closed in `verify:filter-tenancy`** (65/65): 6 filter routes, a foreign keyset cursor, 5 nested paths and the audit route's 12 id filters, graded by searching the whole body for the other org's identifiers. **No leak found on any surface.** Still open: the 28 org-scoped routes beyond the 11 driven, and runs/sessions/automations/usage, which are SKIPped for want of a run fixture. |
| ~~6b~~ | ~~tenant isolation — the **audit** route~~ | **closed** — `AuditListQuery`'s twelve id filters are attacked with values that exist in the other org, read out of that org's own audit rows. **Eight driven, no leak**, including through `metadata_json`, which the route returns in full. The remaining four (`run_id`, `agent_session_id`, `tool_call_id`, `device_id`) have no value in either org and are SKIPped for want of a run fixture. |
| 7a | ~~automation lease contention~~ | **the exclusivity claim is CLOSED and the family is no longer at zero.** `verify:lease-contention` drives 8 simultaneous claims on one occurrence and 2 devices racing: **exactly one winner, exactly one active lease, `state_version` advanced once, one attempt row, no loser carrying the winner's lease or raw token**, and the token is never persisted. It was **blocked by V01-011** until that route was repaired. **Two things remain:** the gate's sensitivity proof, and **V01-013** (`attempt` and `started_at` are written by nothing, so `max_start_attempts` is unenforceable), whose fix touches a statement shared by four routes and needs its own claim → lease-expiry → second-claim attack. **That attack is written and registered** (`pnpm verify:attempt-exhaustion`, finding V01-014) but **has not been run**, so the recorded severity is still the bookkeeping one rather than the proven one. It matters because a dead counter and an unenforced bound look identical to a single claim: the difference is whether one scheduled slot can run twice |
| 7 | idempotency / races | **the three required cases with no attack anywhere are now closed in V01-009** — same key + incompatible payload, concurrent same-key (6 and 8, one and different payloads), and a key reused by a different principal, all graded on row counts read from D1. **The discarded-key class is closed in V01-015/V01-018** — all 3 sites repaired (`approve_enrollment` was the fifth instance of the same family: it required a key, bound it to nothing, and refused the retry at a pending-status check), and a unit test now makes a *new* one fail the build, so the family cannot regrow unnoticed. **automation lease contention is CLOSED** — `verify:lease-contention` is **62/62**: 8 simultaneous claims on one occurrence and 2 devices racing for another, graded on D1 rows, with a sensitivity proof (M1 x3 DETECTED, M2 a KNOWN MISSED that identifies the compare-and-set as the load-bearing mechanism rather than the unique index, M3 DETECTED). **Still missing:** **outbox/webhook retry** side effects. | the same shape as V01-006, one layer down |

| ~~GAP-008~~ | **CLOSED — and it was never a gap. It was a live, high-severity defect filed as a coverage limitation.** The recorded reason was that `start_occurrence` re-reads the entitlement and refuses an organization without one, so the `started_at` half of V01-013 could not be observed. Granting the entitlement made the transition *reachable* and it then answered `409 lease_fence_invalid` for every organization: one of the four guards in its batch asserted that a run link **exists**, and `guard!`'s `NOT EXISTS` inverted it, so the guard aborted precisely when there was **no** link. `start_occurrence` had never succeeded for anyone. See V01-023; the polarity of all nine guards is now pinned by `guard:probe`, and re-introducing the defect gives 14/15. | **A gap recorded as environmental is a defect that nobody was looking for.** The one-line summary blamed the fixture; the fixture was a perfect detector and the target was unreachable. |
| OBS-001 | `claim_occurrence` does not check the entitlement that `start_occurrence` does | **an observation, not a finding** | found by accident: the probe claimed successfully and only discovered the missing entitlement at start. A device can take a real lease and consume an attempt on work its organization may not run, and under `max_start_attempts: 1` the slot is spent on a start that can never succeed. **No claim has been attacked.** Placing the gate at the moment work would happen is defensible; the question is whether the *claim* should also be refused, and that is the next attack rather than a finding |
## New gaps recorded by V01-009

| # | gap | what it is | why it is not a patch |
|---|---|---|---|
| ~~GAP-005~~ | **CLOSED — and it was half wrong, which is the useful part** | `foundation_checks.rs` was a **false member**: it does a complete idempotency flow, and entered the gap because the gap was written by reading *for the pattern* rather than reading the member. `devices.rs` was real and is now **repaired and measured**: `revoke_device` replays its stored `204`, and a different key still gets the preserved `409`, so a retry and a new request are distinguishable. `approve_enrollment` is **open on V01-020** — its body is a read-back projection, and all 27 wired sites build theirs from inputs |
| GAP-007 | **429, 5xx and a malformed chunk over a real HTTP provider — still BLOCKED, and the blocker is now MEASURED (V01-026), not inferred.** `v01-provider-fault-probe.mjs` binds its fault server to `0.0.0.0` and sweeps every address class available, asking the server's own tally whether a request arrived: `127.0.0.1` **0 calls**, `localhost` **0 calls**, and the machine's own routable `192.168.1.4` **0 calls**. So the blocker is not loopback and not name resolution — this Worker's runtime cannot open an outbound socket to *any* address on its own host, and the third row is what makes that a measurement rather than a guess. `pnpm verify:provider-faults` exits **2** with the sweep printed and one named control failure. | Needs a Worker that can reach a socket it does not share a kernel with: a second local Worker on a routable port, a container, or a tunnel. The probe runs unchanged when there is one. The 4 other streaming behaviours are measured by `verify:inference-failure` (65/65) and `smoke:p05`. |
| ~~GAP-006~~ | **CLOSED BY FALSIFICATION — `verify:invitation-race` is 23/23, exit 0.** The predicted defect does not exist. A *sequential* duplicate with a different key answers **`200` with `duplicate: true`** and the same invitation id, not `503`; six concurrent racers on one key give **1 creation and 5 replays**; four concurrent racers on four keys give **1 creation and 3 replays**; one row per email in all four cases, **no 5xx anywhere**, and `membership.invited.v1` audit events = 3 for 3 invitations. The read-then-write is correct because the derived id is stable per *(org, email, role)*, so the read **hits**; the PRIMARY KEY and `ux_invitations_pending_target` are the backstop rather than the mechanism. The lesson is recorded: a gap phrased as a *mechanism* ("this is a read-then-write") is weaker evidence than one phrased as an *outcome* ("two invitations can exist for one address"), and only the second is what a probe can attack |

## Done in V01, for the record

- **V01-001** adoption/privacy at the API and parser layer — 64 injections, 20/20, the three
  real rules proven, GAP-001 recorded for the deliberate change process.
- **V01-002** a verifier measured code that was not on disk — repaired, `buildFreshness()`
  added so it cannot recur silently.
- **V01-003** an admin could mint unlimited co-owners — **critical, fixed**, the original
  attack re-run unchanged at 0 escalated, four of four mutations detected.
- **V01-004** three authentication attacks the family names and nothing had run — 76/76.
- **V01-006** concurrent reservations against a hard budget ceiling — 27/27, and the atomicity
  is measured: 8 for 240 yields 3 grants holding 90. B1 oversells to 240 when the ceiling is
  neutralised, so the assertion is load-bearing.
- **V01-007** the migration ledger had only ever been applied to an empty database — 19/19
  over two populated prior states. That gap is how `teams` stayed unwritable while every gate
  was green.
- **V01-005** the identity-link feature cannot be completed, leaving FR-F01-012's MUST NOT
  enforced by unreachable code — low, fails closed, recorded for the deliberate change process
  as GAP-003. Found while proving the probe can fail: the section had been asserting the
  email conflict while actually measuring the challenge, because both share the reason code
  `identity_conflict`.

## Carried forward from V00, still open

- **14 of the 15 repaired audit call sites still lack individual runtime proof** (plugins ×6,
  internal ×2, plus others). Drive each over HTTP the way `smoke:p08` seeds orgs.
- **`smoke:p08`'s substituted-id set** covers 20 of 23 driven routes; 54 remaining org-scoped
  routes need a seeded resource and 28 are mutating actions.
- **`VI-DATA-001`'s R2 leg** is BLOCKED by local queue delivery, not by the product. Exit 2
  from `smoke:p06` means the harness could not run, not that a check failed.

## Open observation: `smoke:p06` now dies partway through

`pnpm smoke:p06` exits 2 with a Worker boot failure partway through the run —

```
Uncaught TypeError: Failed to construct 'WorkerEntrypoint': constructor parameter 1 is not of type 'Object'.
  at wrapQueueHandler (.../@sentry+cloudflare@10.74.0_wrangler@4.137.0 ...)
```

— after passing its first several cases (through "the export is created in the `requested`
state") and before printing a summary. The documented behaviour for this gate is that it
**exits 2 for a different and expected reason**: the local queue does not deliver a published
body, so the R2 leg is BLOCKED. Reaching that leg is what makes the exit meaningful, and this
run does not get there.

**Not attributable to the harness change in this round.** It reproduces with
`PROBE_QUIET_WORKER=1`, which restores the *original* wrangler invocation exactly — the flag
list is byte-for-byte what it was before `--log-level` and the dev-session flag were touched.
`pnpm smoke:p08` runs clean (47/47) on the same machine, immediately afterwards, so the
environment is capable of booting a Worker. Left open rather than explained, because the honest
answer is not yet known and a plausible story is not evidence.

## Tooling facts established in V01, so nothing rediscovers them

- **D1 refuses a result set wider than 100 columns.** 100 accepted, 101 refused. Documented on
  `smoke-harness.mjs::d1Rows`. Compound SELECT is unrestricted.
- **`npx` is blocked** in this repository by `pkg-age-guard`, so a limit measured through
  `npx wrangler` is a measurement of the guard. Use `apps/api/node_modules/.bin/wrangler`.
- **A restored file must be put back with `cp`, never `mv`** — `mv` preserves the pre-fault
  mtime, the build is skipped, and the next run measures the faulted binary. `buildFreshness()`
  now reports a served Worker that predates its source.

## V01-044 — a sensitivity harness that can ship the fault and report green

**Status:** closed. Recorded here because the class generalises to every sensitivity script in this
repository, and the existing scripts share the defect.

`evidence/v01-plugin-leak-sensitivity.sh` restored its mutated source with `cp -p`. `cp -p`
preserves the pre-fault mtime, cargo's freshness check is mtime-based, and the "restored" build
therefore **reused the faulted object** — producing a binary whose `find_install` did not filter on
`org_id` while the source tree read clean. The run reported **211/211**.

Measured:

```
clean source                     -> e6ae538ea1b18017
fault injected, build            -> 918939ebc7aaec13
source restored with `cp -p`     -> 918939ebc7aaec13   <-- still faulted
source restored, then `touch`ed  -> e6ae538ea1b18017
```

The result was a six-run "cross-tenant leak" that was entirely a harness artefact, and three
consecutive wrong diagnoses committed on the way to it — including a build-script change that has
since been reverted.

**The asymmetry, and it is the whole fix:** snapshot with `cp -p` (a fault must be *newer* than what
it replaced) and restore with `cp` + `touch` (a restore must *look newer* than the fault). A script
that uses `-p` on both sides will eventually ship its mutation.

**What every snapshotting sensitivity harness in this repository should carry**, because the rules
were already written down and implemented backwards in the one that failed:

1. restore with `cp` + `touch`, never `cp -p` / `mv`;
2. a Rust mutation must produce a byte-different artifact, or report `INVALID` instead of a verdict;
   a probe-only (JS) mutation is exempt, since cargo correctly does not rebuild;
3. the restored tree must rebuild to the *baseline* artifact — equality is the success case;
4. locate the repository with `git rev-parse --show-toplevel`, never `dirname/..`; outside a
   repository `git ls-files` lists nothing, so a tracked-file check reports a tracked file as
   untracked and blames the file;
5. no backticks inside a double-quoted `echo` — they are command substitution, and a `FATAL`
   message that cannot print cannot be read when it matters.

**The generalisable form:** a check that describes a rule it does not follow is worse than one that
omits it, because a reader trusts the prose. This script's header *named* the mtime trap in its
first ten lines and then walked into it on line 200.

## The liveness triage, in progress: 47 → 26 `UNTRIAGED`

`security::repository_liveness` lists 61 `pub` repository functions. Every entry is a **decision
someone made**; `UNTRIAGED` is the honest label for the ones nobody has looked at, and *an absent
list is a false assurance*. Sixteen are now examined across five clusters, and the verdicts are not
the same shape — which is the reason the work is worth doing rather than the count:

| verdict | entries | what it means |
|---|---|---|
| **a real gap** | `insert_run_usage_statement` (V01-047) | committed, unwired, and the read path pretends otherwise |
| **a latent tenant read** | `find_snapshot` | `WHERE policy_id = ?1` with **no `org_id`**, unreachable today, one route away |
| **superseded by something safer** | `find_live_device_token`, `find_active_credential` | wiring them would be a *regression* |
| **deliberately uncalled for security** | `find_key_by_prefix` | the exact shape of the V01-034 bypass; the live path compares constant-time |
| **a leaf, lifecycle intact** | `mark_artifact_deleted_statement`, `set_deletion_cutoff_statement` | the deletion job transitions; only the stamp is absent |
| **a convenience projection** | `to_verification_key` | the billing path uses the row directly |
| **out of band** | `insert_remediation_statement` | reached through the migration runner, not a route |
| **narrow capability gap** | `revoke_grants_statement` | export grants are live and unrevokable; 15-min TTL is the working control |

**The one that matters is `find_snapshot`.** Three of these verdicts are "correctly absent", and only
one is a defect waiting to happen. A check reporting the call graph without this distinction would
print sixteen identical names, and the fourth is the only one a reviewer could act on.

### The budget cluster, examined: the hard ceiling is live

The cluster I named as the next place to look came back **clean**, and that is worth establishing
rather than assuming — V01-047 sat directly beside it.

`ai.rs` holds **three** reservation statements and only two have callers. The survivor that carries
the money is the **conditional** insert, and its ceiling is in the SQL:

```sql
WHERE NOT EXISTS (SELECT 1 FROM budgets b WHERE b.org_id = ?3 AND b.hard = 1
  AND b.period_start <= ?6 AND b.period_end > ?6
  AND b.limit_minor - usage - reserved < ?4)
```

That is the statement `verify:budget-concurrency` measures at **28/28**, so the hard-budget refusal
is enforced by the query that is actually *called*. The uncalled one is the **unconditional** insert
— the leftover shape for a reservation made without a ceiling check — and leaving it uncalled is
correct, because wiring it would be a way to reserve without consulting the budget. That is the
V01-006 class, and the dead method is the safer state.

`find_budget_for_scope_period` is a pre-read for deterministic create conflicts, unused because a
duplicate create is refused on the `UNIQUE` constraint instead. **The constraint is the stronger
answer under concurrency**: a pre-read races, a constraint does not.

### Where this leaves the list

**19 of 61 entries examined; 23 `UNTRIAGED` remain**, and the remaining clusters are entitlement
provisioning (`insert_plan_statement`, `list_active_plans`, `seat_policy_for_plan`,
`insert_plan_entitlement_statement`, `list_entitlement_definitions`), identity, provisioning and the
notification cluster already covered by V01-046.

The tally of *verdicts* is the real output, because the verdicts are not one shape:

| verdict | count | what it means |
|---|---|---|
| a real gap | 1 | V01-047's run-source writer, committed and unwired |
| a latent cross-tenant read | 1 | `find_snapshot` — `WHERE policy_id = ?1`, no `org_id` |
| correctly absent, and absent *for a reason* | 17 | superseded, security-motivated, or a leaf of an intact lifecycle |

**Only one of the nineteen is a defect waiting to happen.** A check that printed the call graph
without this distinction would give all nineteen the same name, and a reviewer could not tell which
one to act on — which is the difference between a review list and a to-do list.

## V01-048 — the unmanaged inference has a different budget control (CLOSED)

**Status: CLOSED. Behaviour PASS, sensitivity PROVEN.**

`run_inference` puts the budget admission, the rate admission and the whole P05 block inside
`if let Some(project_id) = managed_project_id` (`routes/inference.rs:1555`). **An ordinary inference —
no `run_id`, which is most traffic — takes the `else`**, and every money gate in the repository drives
the *managed* path. Two of the objective's five named budget requirements had **no runtime evidence at
all** before this.

The product is **right**: `403 budget_exceeded`, reservation count unchanged, zero usage rows, and no
inference row the attack *added* reached a dispatched state. `pnpm verify:budget-hardceiling`
**25/25, exit 0**, stable over three runs.

### Three guards, each individually sufficient

| | guard | removed by | alone is |
|---|---|---|---|
| 1 | `hard_budget_remaining(&org_id, now) < reservation_minor` (`inference.rs:1663-1666`) | M1 | **MISSED** |
| 2 | `WHERE NOT EXISTS (...)` ceiling in `INSERT_BUDGET_RESERVATION_IF_AVAILABLE_SQL` | M2 | **MISSED** |
| 3 | `changes(&initial_results[1]) != 1` -> `budget_exceeded` (`inference.rs:1834`, **ungated**) | M3 | **DETECTED** |
| — | the probe's own fixture builds no ceiling | M4 | **DETECTED** |

M3 removes **all three** and its failures *are* the breach: **B4 — "and NO reservation is taken" —
FAILED**, meaning a reservation *was* taken against an exhausted hard budget.

The two MISSEDs are a property of the **product**, not a weakness of the gate: each guard is
sufficient alone, so removing any one leaves the other two. That is defence in depth, *measured* — and
only visible because a one-layer-at-a-time mutation runs before the all-at-once one.

**Guard 3 is the V01-042 shape handled correctly.** An INSERT matching zero rows neither aborts a D1
batch nor raises an error, so the only way to notice is to read `changes()`. That is why the class
asserts the stored reservation count rather than the status.

### How guard 3 was missed, and the lesson

I found the `changes()` pattern at `inference.rs:1876`, saw it was gated on `scope.managed_run`, and
concluded the pattern was managed-only — **without checking whether the first instance was gated at
all.** Guard 3 sits sixteen lines earlier and is ungated.

**A pattern inferred from a single instance is a hypothesis, and the cheapest thing to do with a
hypothesis is to read the other instances.** The plugin fixture in V01-043 took five attempts for the
same reason: guessing a response shape instead of reading it, each time answered by a line already on
screen.

The mutation that found it was M3, written on the assumption that two guards existed. It came back
MISSED, and **the correct response to a MISSED that contradicts your model of the product is to read
the product**, not to write a fourth mutation.

### Also recorded here, because they were wrong for the wrong reason

Four controls in this one probe were satisfied by the wrong mechanism, two of them mistakes this
campaign has made before:

- **A control must exclude the refusals that happen *before* the thing under test, by name.** B1
  asserted only "not `budget_state_unavailable`", and a malformed content part answers
  `422 content_unsupported` before the budget check — so control and attack were both satisfied by a
  request that never reached a budget.
- **A control must answer the same question the product answers.** The applicability control
  paraphrased the product's predicate and dropped `b.period_start <= ?2 AND b.period_end > ?2`,
  counting **129** rows while the product's query saw **one**.
- **`allowed_models: []` is an empty list that permits NOTHING**, where an absent field permits
  everything (`modules/catalog.rs:183`). An empty array is the *opposite* of unrestricted.
- **Weakening a control is not removing one.** `< ?4` -> `< ?4 + 1e18` makes EXISTS match every
  budget, so the INSERT matches nothing, so the request is **refused** — exactly what the class
  asserts. Only the second kind is a defect.

And two harness faults that produced a *false* verdict rather than a weak one: a mutation that broke
the **build** (`E0425`) was reported as **DETECTED**, and two `exit 2, no sheet` flakes from a live
miniflare recreating its persist directory were also read as detections. **`run_case` now
discriminates a rustc diagnostic and reports `INVALID`; `settle_worker` polls until `workerd` is
gone.**
