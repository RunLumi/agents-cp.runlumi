# Phase 2 workspace hostile probe — claims, scope and handoff

Status: **CANDIDATE PROBE, NOT RUN.** Nothing here is a PASS. The script and its pure tests were
written in the independent clone only; no Worker, wrangler, D1, cargo or Electron process was
started by the author. The supervisor runs it against the fresh candidate Worker.

Probe: `apps/api/scripts/phase02-workspace-hostile-probe.mjs`
Pure support + tests: `apps/api/scripts/lib/phase02-workspace-probe-support.mjs`,
`apps/api/scripts/phase02-workspace-hostile-probe.test.mjs`

Subject contracts: F07 FR-F07-002 (unbind removes execution authority, history preserved, rebind
makes a new ID), P03-CG persistence paragraph, ADR 0012, P03-CR-003 (S5), P08-CR-002 and P08-CG
addendum (S4).

## Rules the probe obeys

1. Real HTTP to a real `wrangler dev --local` Worker with real local D1 (`SmokeHarness`). No
   Worker of its own is started on a port it did not allocate through the harness.
2. Fixtures use public routes only: real signed-in users, real org, project, agent, device
   enrollment with a real Ed25519 proof of possession (begin, approve, challenge, complete),
   `POST /devices/bindings`, adoption routes, device sessions/runs, automations.
3. No D1 write creates execution authority, a binding, a run, a session, a lease or an
   occurrence. D1 is **read** for stored-state evidence. The single exception is the same
   `entitlement_grants` plan row that `v01-lease-contention-probe.mjs` seeds so that
   `claim` is not refused for entitlement (an entitlement fixture, not execution authority; the
   control claim on the live-pinned sibling proves the path is entitled). See "Blocked and owed".
4. Every refusal is a **single** request. Mutating requests are never retried by the probe.
5. A refusal is graded only against stored state: adoption row, adoption events, security events,
   outbox, idempotency records and the full `workspace_bindings` digest, all measured before and
   after. A status code alone is never a verdict.
6. Every hostile claim has a control that proves the same route, fixture and request shape work
   (or a differential: same request refused for the *attributed* reason only after the state
   change). A failed control marks dependants `BLOCKED`, never PASS.
7. Statuses: `PASS`, `FAIL`, `BLOCKED` (a control failed or an environment prerequisite is absent),
   `UNPROVEN` (never reached). Exit 0 only if every table claim is `PASS`. Exit 1 on any `FAIL`.
   Exit 2 on `BLOCKED`/`UNPROVEN`/harness failure. A count of assertions is telemetry only.

## Claims table

Kinds: C = positive control, H = hostile, D = stored-state/FK evidence.

### S4 — explicit rebind after rollback (`POST /orgs/{org}/adoption/bindings` + `rebind_version`)

| ID | Kind | Claim | Evidence |
|---|---|---|---|
| S4-C1 | C | The real chain works: enrolled device, project, live binding, adoption record bound to both, ladder to `managed_policy`, rollback to local clears bound ids | statuses and D1 row after each step |
| S4-C2 | C/D | Rebind with the exact version succeeds and persists: ids set, stage/ownership/mode still local, `version+1`, adoption id, workspace key and `reversion_count` retained, response equals the D1 row | response vs D1 |
| S4-C3 | D | The rebind commits exactly +1 stage event (completed), +1 `adoption.rebound` security event, +1 `adoption.workspace_recorded.v1` outbox row with `rebound:true`, one completed idempotency record; replay of the same key returns the same body and adds nothing | counts before/after |
| S4-C4 | C/D | A second rollback after rebind clears both ids, `reversion_count+1`, and leaves the P03 binding row untouched and live | D1 |
| S4-H1 | H | Stale `rebind_version` (lower and higher than the row) is refused `409 version_conflict` with zero stored side effects | refusal + diff |
| S4-H2 | H | Rebind of a record that is not an unbound local record (stage `account_optional`; `managed_policy` bound; stage 0 still bound; non-local credential mode in body) is refused `409 adoption_rebind_not_allowed`, zero side effects | refusal + diff |
| S4-H3 | H | Revoked device: same request is `409 version_conflict` while the device is active (proves device/project/binding gates passed), then `404 device_not_found` after revocation; zero side effects | differential + diff |
| S4-H4 | H | Removed binding, binding for another project, and binding for another workspace identity are each `404 workspace_binding_not_found` (the removed case is `409` before removal), zero side effects | differential + diff |
| S4-H5 | H | Org B has a live project, device and binding whose workspace identity equals the org A record's. Naming them from org A is refused exactly like nonexistent ids (same status and reason: no existence oracle), org A and org B rows unchanged, no adoption row appears in org B | refusal + cross-org digest |
| S4-H6 | H | An org B principal cannot rebind org A's record (permission denied on A's path; `adoption_not_found` on B's own path), zero side effects | refusal + diff |
| S4-H7 | H | Transport guards: no CSRF token, no Idempotency-Key, `rebind_version` 0 or negative, and `rebind_version` for an unknown workspace are each refused with zero side effects | refusal + diff |

### S5 — tombstone removal of a workspace binding (migration 0026, ADR 0012)

| ID | Kind | Claim | Evidence |
|---|---|---|---|
| S5-C1 | C | Before removal the binding is live: in the device list, the admin project list and `GET /devices/policy` `projects.bindings`; a session and a `local_only` run are created pinned to it; two pinned automations (one to be removed, one live sibling) each have an occurrence | statuses + D1 FK columns |
| S5-T1 | D | `DELETE /devices/bindings/{id}` is `204` and the row **remains**: same `binding_id`, `removed_at` a 24-char timestamp, every other column unchanged, total binding row count unchanged | D1 |
| S5-T2 | D | Historical references survive: `runs`, `agent_sessions` and `automation_definitions` still carry the original binding id; the run is still readable through the device run route with that id; an orphan **join** (`LEFT JOIN workspace_bindings ... IS NULL`) over all three tables returns 0 (a join, not `PRAGMA`, because local D1 may refuse the pragma) | D1 + route |
| S5-T3 | H | Device-initiated removal: the binding is absent from the device list, the admin list and the policy `projects.bindings` | route reads |
| S5-T4 | H | Admin-initiated removal (`DELETE /orgs/{org}/projects/{p}/bindings/{id}`): row tombstoned (not deleted) and absent from both lists **and from the device policy**. Source note: that handler does not call `refresh_policy_snapshot`; this claim measures whether policy is stale | D1 + route reads |
| S5-T5 | H | A removed binding authorizes nothing new: new session naming it, a new run on the pre-existing session pinned to it, and a new automation targeting it are each refused; zero new `agent_sessions`/`runs`/`automation_definitions` rows | refusal + counts |
| S5-T6 | H | Due work: while the binding is live the pinned occurrence is offered on `GET /devices/automations/due`; after removal it is not, while the live-pinned sibling still is (control) | route reads |
| S5-T7 | H | Claim: after removal, `POST /devices/automation-occurrences/{id}/claim` for the occurrence pinned to the removed binding is refused, with no lease row and unchanged occurrence state; the same call for the live-pinned sibling succeeds (control). Source note: the claim/dispatch path reads no binding state | refusal + D1 + control |
| S5-T8 | C/D | Explicit rebind creates a new ID: `POST /devices/bindings` for the same device and identity is `201` with a new id; the old id stays tombstoned and is not in any list; exactly one live and two total rows for the pair; a duplicate live POST is `409 workspace_binding_conflict` | D1 + routes |
| S5-T9 | H | Replay after a post-commit policy refresh failure (obligation from `test-results/phase02-policy-refresh-review.md`): a trigger on `policy_snapshots` makes the refresh fail after the admin unbind commits (control: 5xx, tombstone stored, policy still lists the project, trigger dropped). The same-key retry must answer the stored 204, leave the tombstone untouched and leave the device policy without the project, with exactly one `project.binding_removed.v1` outbox row and exactly one new policy snapshot. Source note: `delete_project_binding` returns the stored replay before it reaches `refresh_policy_snapshot` | fault + replay + D1 |
| S5-H1 | H | Another device and another org cannot remove the binding (rows unchanged, `removed_at` NULL); a second removal by the owner is `404` and does not re-stamp `removed_at` | refusal + D1 |
| S6-C1 | C | Positive control: an eligible manual occurrence is dispatched by the real sweep (`pending` to `dispatching`) and offered on `GET /devices/automations/due` | sweep + route + D1 |
| S6-H1 | H | An org that lost eligibility (entitlement lowered as a denial fixture) after the occurrence was created: the sweep skips it with a stable reason, never dispatches, job `succeeded`, one `skipped` and no `dispatched` event, not offered; differential: restored eligibility dispatches a fresh occurrence | sweep + D1 |
| S6-H2 | H | `queue_one`: the successor stays `pending` queued behind its predecessor (marker, blocker), not offered; its job returns to `queued` with a future `next_attempt_at` and an UNCHANGED attempt count across repeated re-evaluations; after the predecessor is terminated through public claim+settle it dispatches, queue marker cleared, one event | sweep + lease routes + D1 |
| S6-H3 | H | `cancel_previous`: the predecessor is cancelled (stable reason), the successor waits, then dispatches exactly once | sweep + D1 |
| S6-H4 | H | Two open occurrences of one `skip` automation: only the OLDER dispatches, the newer is skipped for overlap (never both skipped, never inverted) | sweep + D1 |
| S6-H5 | H | Hostile dispatch jobs: a job naming ANOTHER org for an occurrence is dead-lettered (`automation_occurrence_missing`) and changes nothing; a duplicate job for an already-dispatched occurrence succeeds and writes nothing; the occurrence takes one state step and has one `dispatched` event | hostile rows + sweep + D1 |

## Hostile expectations the source already makes suspect (UNPROVEN until run)

These are source observations, not findings. The probe is built so each fails closed if true.

1. `S5-T7`: `claim_occurrence` / dispatch never read `workspace_bindings`; only the due-list SQL
   filters `removed_at`. If the claim succeeds, F07-002 ("MUST NOT authorize ... automation
   claims") is violated.
2. `S5-T4`: only the device DELETE refreshes the policy snapshot; the admin DELETE does not.
3. `S5-T6` positive control: `DEVICE_DUE_OCCURRENCES_SQL` in this candidate ends
   `ORDER BY o.scheduled_for_ ASC`; the column is `scheduled_for_utc`. If SQLite rejects it the
   due route answers 5xx, the positive control fails, and `S5-T6` is `BLOCKED` (the probe prints the
   source line as a labelled source fact and the Worker's own error lines).

## Handoff

### Exact commands

Pure tests (no Worker, no wrangler; already run by the author, 17/17 pass, which proves only the
probe's bookkeeping, not the product):

```bash
node --test apps/api/scripts/phase02-workspace-hostile-probe.test.mjs
node --check apps/api/scripts/phase02-workspace-hostile-probe.mjs
```

Runtime probe (**coordinator window only**; starts its own `wrangler dev --local` through
`SmokeHarness`, applies every migration including `0026`, allocates its own port):

```bash
# from the repository root, after the supervisor has built the fresh candidate Worker
node apps/api/scripts/phase02-workspace-hostile-probe.mjs
```

Optional environment (harness conventions): `P02WS_PERSIST_TO` (keep the D1 directory for
inspection), `P02WS_PORT`, `PROBE_WRANGLER` (wrangler path when running from a mutated copy with
no `node_modules`). The probe is not wired into `package.json` (outside this packet's write
surface); add `"verify:phase02-workspace"` there deliberately if wanted.

### Reading the result

The final block prints one line per table claim: `PASS | FAIL | BLOCKED | UNPROVEN`.
Exit `0` = every claim PASS. Exit `1` = at least one FAIL (a product defect or a wrong
expectation; the preserved failing output is the evidence, do not edit the probe to make it
green). Exit `2` = BLOCKED/UNPROVEN or harness failure (a control did not work, so nothing
downstream is evidence). "N/M cases hold" is telemetry. Quote the claim line, the exact head SHA,
and the printed assertion lines in any verdict.

### Scope boundary

In scope: S4 and S5 above, on the local development Worker and local D1 only.
Not proven by this probe, and still owed separately:

- the production Electron client half of rebind and unbind (DE2E-INT-03/04);
- migration safety on a **pre-existing** ledger with data (0026 is exercised on a fresh ledger
  only, because the harness applies migrations to an empty D1);
- `start_run`/tool/inference behaviour for a run created *before* removal (the contract text
  "MUST NOT authorize runs" is probed only for **new** sessions, runs and automations);
- the race between a rebind commit and a concurrent binding removal (`ASSERT_LIVE_BINDING_SQL`
  exists for it; the probe issues serial requests, so that guard is not shown to fire);
- restricted-project visibility on the rebind route and member-level (non-manager) callers;
- any production or hosted CI claim.

### Prerequisites that can BLOCK a claim

| Prerequisite | Claims | If absent |
|---|---|---|
| `wrangler` + built Worker from the supervisor's fresh candidate | all | harness failure, exit 2 |
| Occurrences reach `dispatching` through the harness's `/__scheduled` sweep within 48 s | S5-T6 | `BLOCKED`; S5-T7 still runs (claim accepts `pending` and `dispatching`). The block message now carries the measured `queue_job_envelopes` state and a labelled `lib.rs` source fact (see "S5-T6 diagnosis") |
| A trigger can be created and dropped through `wrangler d1 execute --local` | S5-T9 | `BLOCKED` (fault not injected); the trigger is dropped in `finally` and its absence is read back |
| `GET /devices/automations/due` answers 200 while the binding is live | S5-T6 | `FAIL` of the control with the labelled source fact and Worker lines (see suspicion 3) |
| The `plan` entitlement row for `automations.max_active` is accepted by the schema | S5-C1, S5-T7 | harness failure (the row is the same one v01-lease-contention seeds) |
| `automations`/`agents`/`sessions`/`runs` creation with the minimal bodies used here | S5-* | `FAIL` of S5-C1 (a control), dependants `BLOCKED` |

### Verifying the verifier (owed; not run)

Per AGENTS.md, in a **disposable worktree** (never the candidate, never the active Rust
cancellation lane), apply one fault at a time, rebuild, run the probe, and require the named
claim to fail **for that reason** (a build failure or a probe that did not run is not a kill):

| Fault in the candidate | Claim that must turn FAIL |
|---|---|
| `repositories/projects.rs` `BINDING_BY_ID_SQL`: drop `AND removed_at IS NULL` | S5-T5, S4-H4 (removed case) |
| `BINDINGS_BY_DEVICE_SQL`: drop `AND removed_at IS NULL` | S5-T3, S4-H4 |
| `BINDINGS_BY_PROJECT_SQL`: drop `AND removed_at IS NULL` | S5-T3 / S5-T4 (admin list) |
| `DELETE_BINDING_SQL` as a real `DELETE FROM` | S5-T1 and S5-T2 (FK RESTRICT or lost row) |
| `DEVICE_DUE_OCCURRENCES_SQL`: drop `AND b.removed_at IS NULL` | S5-T6 |
| `routes/migration.rs` rebind: skip `version != record.version` | S4-H1 |
| `routes/migration.rs` rebind: skip the `record.stage`/bound-id state check | S4-H2 |
| `routes/migration.rs` rebind: drop `device.status == "active"` | S4-H3 |
| `routes/migration.rs` rebind: drop `device.org_id == org_id` | S4-H5 |
| `routes/migration.rs` rebind: skip the `list_bindings_by_device` identity/project match | S4-H4 |
| `routes/migration.rs` rebind: `commit_mutation` without the `adoption.rebound` security statement | S4-C3 |
| `routes/devices.rs` `delete_device_binding`: remove `refresh_policy_snapshot` | S5-T3 policy leg |

### Hostile expectations the probe may turn into FAIL on the first run

See "Hostile expectations the source already makes suspect". Expect, at minimum, a decision on
`S5-T7` (claim reads no binding state) and `S5-T4` (admin removal leaves a stale policy). Both
are **source observations, UNPROVEN until a run**. Per AGENTS.md the repair loop is: preserve the
failing output, fix the root cause in a separate in-scope change, add regression proof, rerun the
original reproducer. This packet does not change the Rust candidate.

### Isolation and state

Authored only inside `/Volumes/SSD/agents-cp.runlumi/test-results/phase02-server-review-repo`.
No index change, branch, commit, push, STATUS edit, deploy or real key. Files added (all
untracked): the probe, `lib/phase02-workspace-probe-support.mjs`, the test, and this document.
The active Rust cancellation lane and every Rust file were untouched. The pre-existing untracked
`apps/api/node_modules`, `apps/web/dist`, `apps/web/node_modules`, `node_modules` and the
clone's other WIP were preserved.

## Server repair handoff — after hostile run 99176 (FAIL 117/120)

The original failing log (`test-results/phase02-workspace-hostile-first.log`) is preserved and is
not superseded by anything here. Source repair only; nothing has been rebuilt or rerun.

| Probe finding | Root cause | Repair (candidate paths) |
|---|---|---|
| S5-T4 policy binding remains after admin remove | admin DELETE never refreshed policy | `routes/projects.rs` `delete_project_binding` |
| S5-T7 claim on removed pin 2xx, lease created | claim/start never read binding state | `routes/automations.rs` (`require_pinned_binding_live`, batch guard in claim and start), `repositories/automations.rs` (`PINNED_BINDING_LIVE_SQL`, `assert_pinned_binding_live_statement`) |
| S5-T6 BLOCKED | `ORDER BY o.scheduled_for_` typo | `repositories/automations.rs` `DEVICE_DUE_OCCURRENCES_SQL` |

Also: `security/tenant_audit.rs` classifies the new statement; `phase02-workspace-hostile-probe.test.mjs`
gains the empty-claim-table refusal plus a positive-claims control (18/18 pass).
Contract: P03-CR-003 amendment 1, F07, P03-CG. No migration, route or response-shape change.

Local evidence: `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings` clean;
`cargo test --workspace` 1045 + 11 pass. `wasm32-unknown-unknown` is not installed in this checkout,
so the WASM check, the release Worker build and the probe rerun belong to the supervisor.

Not proven by source: runtime refusal, no lease/effects after refusal, the live-sibling positive
control and S5-T6 are UNPROVEN until the same probe reruns on a fresh build. The Rust tests are
SQL-shape checks, not behavioural proof. Sensitivity (remove the guard or revert the refresh,
expect S5-T7 / S5-T4 to FAIL) is still owed in a disposable worktree.

## Second replay and S5-T6 diagnosis (probe, helper and tests only)

Original second-replay log preserved and not superseded: `test-results/phase02-workspace-hostile-second.log`
(120/120 assertions; S5-T4 policy PASS; S5-T7 removed-pin refusal with no lease/state change PASS and the
live-sibling positive control PASS; overall **BLOCKED**, one skipped claim: `S5-T6`). No Rust, index,
branch, STATUS, commit, push or deploy change was made, and the runtime probe was not rerun here.

### S5-T6 diagnosis (source reading, UNPROVEN until the next window measures it)

`S5-T6` stayed BLOCKED because both occurrences were still `pending` after 24 real sweeps. Reading the
candidate (baseline P06 stage semantics, unchanged by the candidate diff), the producer half is missing:

1. `run-now` (`routes/automations.rs` `run_now`) commits the occurrence as `pending` plus an
   `automation.dispatch` row in `queue_job_envelopes` (`state='queued'`).
2. The cron sweep (`lib.rs` `run_scheduled_sweep` -> `dispatch_due_data_jobs`) reads due envelopes and
   `continue`s past every type except `export.run` / `deletion.run` ("dispatched by their own
   subsystems"). Nothing else publishes `automation.dispatch` to `JOBS_QUEUE`.
3. The consumer (`consume_p06_jobs` -> `AutomationJobHandler` -> `dispatch_occurrence_statements`, the only
   `pending -> dispatching` writer besides a claim) therefore never receives the message.
4. `DEVICE_DUE_OCCURRENCES_SQL` offers only `state = 'dispatching'`, so the due list is empty by design.

The public lifecycle cannot stand in for the missing step, so the positive control was **not** rewired:
`claim` moves `pending -> dispatching -> leased` in one batch (the occurrence is then leased, not due),
`release` returns `leased -> pending`, and lease expiry also returns it to `pending` with a new dispatch
job. No public edge leaves an occurrence `dispatching` without an active lease. Seeding `dispatching` in D1,
or dropping the requirement, would be exactly the bypass the packet forbids, and copying the later P06
producer into this candidate is out of scope.

Probe change: on the stall the probe now reads `queue_job_envelopes` for both occurrences and prints
whether each envelope is still `queued` with attempt 0 (the never-published signature) plus the `lib.rs`
filter line as a labelled source fact. The verdict stays `BLOCKED`; the due positive control still precedes
the removed-binding negative and the live-sibling control is still required.

**Next packet (small, Rust, coordinator window):** publish `automation.dispatch` envelopes from
`dispatch_due_data_jobs` (or an automation-owned producer) so the existing consumer runs, with a test that
a `pending` manual occurrence reaches `dispatching` through the sweep and a note that the data-job `LIMIT
100` read must not be starved by skipped automation rows. Keep S5-T6 BLOCKED until then; the independent
gates are unaffected.

### S5-T9 — replay after a post-commit policy refresh failure (new obligation, UNRUN)

From `test-results/phase02-policy-refresh-review.md`. Source fact: in `routes/projects.rs`
`delete_project_binding`, `PreparedScopedMutation::Replay` returns before `refresh_policy_snapshot`, and
only the in-flight `ScopedMutationCommit::Replayed` path reaches it, so the comment that a replay "heals a
refresh that failed after the first commit" does not cover the stored-success replay. This is a
source-supported concern, not a finding, until the probe runs.

Reproducer (probe only; one trigger on `policy_snapshots`, dropped in `finally`, no Rust change): fault
the refresh, issue the unbind, read back the committed tombstone and stale policy (control), then retry the
same Idempotency-Key and require the stored 204, the unchanged tombstone, a policy without the project and
no duplicate outbox row or snapshot. A failing control is `BLOCKED`, never PASS or FAIL. If the claim FAILs,
the repair belongs to the existing policy owner (a replay that re-runs the idempotent, payload-gated refresh
or an outbox-driven refresh), not to ad-hoc retries, and must not relax once-only mutation semantics or undo
the tombstone. Sensitivity: add `refresh_policy_snapshot` before the early `Replay` return in a disposable
worktree and require S5-T9 to turn PASS, then remove it and require FAIL for that reason.

### Canonical claim verdict for this packet

- **PASS** — `S4-*`, `S5-C1`, `S5-T1`..`S5-T5`, `S5-T7` (including the live-sibling claim control), `S5-T8`, `S5-H1`: second-replay log, 120/120 assertions.
- **BLOCKED** — `S5-T6`: no `pending -> dispatching` producer in the candidate; diagnosis above.
- **UNPROVEN** — `S5-T9`: authored, not run.
- **Whole probe: BLOCKED (exit 2).** One BLOCKED and one UNPROVEN claim; an assertion count is telemetry only.

## Repair of S5-T6 and S5-T9 (P06-CR-009) — original evidence preserved above

Preserved, not superseded: `test-results/phase02-workspace-hostile-s5t9-original.log` (inline Node 24.19, exact base
`fe3d6e1` plus the candidate working tree, before any repair): exit 1, **123/125, S5-T6 BLOCKED, S5-T9 FAIL** (policy still listed the
removed binding after the same-key replay; snapshots 14->14). `...-s5t9-before-harness-incomplete.log` and `...-before-killed-bg.log`
are harness failures (background jobs killed with the CLI), not product results.

Correction of the earlier diagnosis: `attempt = 1, lease_version = 0, state = queued` is the INITIAL row written by
`INSERT_QUEUE_JOB_SQL`; it never proved "advanced". The probe diagnostic now reports whether the row left its initial values and prints the
Worker's `p06_*` lines. Also, `dispatch_occurrence_statements` had no caller; the `Dispatch` consumer ran a global lease-expiry sweep.

Repair (P06-CR-009): `lib.rs` publishes due `automation.dispatch` rows; `consumers/automations.rs` dispatches ONE occurrence
subject-scoped, re-reading eligibility/overlap, with job claim + occurrence transition + lifecycle event + job completion in one guarded
batch; `routes/projects.rs` re-runs the payload-gated policy refresh on an authorized same-key unbind replay.
Measured defect found on the way: a `serde_json::Value` object passed to `Queue::send` reaches the consumer as `{}` (JS `Map`), so the
first publish was acknowledged as a no-op; the producer therefore sends the typed `QueueJobEnvelope`. The existing export/deletion publisher
passes a `Value` the same way and was NOT changed here (owed: check it under the local queue).

Result on the repaired build, real Worker + local D1, inline, Node 24.19: `test-results/phase02-workspace-hostile-final.log`,
**exit 0, 130/130, every claim PASS**, including: S5-T6 positive control (both pinned occurrences reach `dispatching` through the real
sweep and are offered), both dispatch jobs `succeeded` with no error code, exactly one `dispatched` event and one `state_version` step per
occurrence after two further sweeps (republish/redelivery dedupe), removed-pin occurrence not offered with the live sibling still offered;
S5-T9 control (5xx after tombstone commit, policy stale), same-key replay 204, tombstone unchanged, policy without the project, one outbox
row, +1 snapshot (14->15).

Quality at this tree: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
(1048 + 11 pass), `cargo check --workspace --target wasm32-unknown-unknown` clean (`test-results/phase02-server-quality-dispatch.log`);
probe node tests 20/20.

Still owed: sensitivity mutations in a disposable worktree for the load-bearing dispatch guards (occurrence `state_version`, eligibility,
tenant mismatch, job claim) and a hostile runtime case for an ineligible org (`pending_deletion`) not dispatching; `pnpm check`/web build
were not run; the pre-fix runs are the only "guard removed" evidence for S5-T6/S5-T9 (both flipped FAIL/BLOCKED to PASS with only the
repair changing). Not proven: queue_one/cancel_previous deferral at runtime (retry-and-ack path is unit-unproven), real Cloudflare queues.


## S6 dispatch guards, hardened verifier, mutation proofs and custody (P06-CR-009)

Exact base `fe3d6e13c6cb6083cc9fa5ca2e67fefcaa0f83d7` plus the dirty candidate tree (index and unrelated WIP untouched; nothing committed).
Node `/Users/james/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` v24.19.0, pinned Rust, SSD cargo target.

### Original FAIL evidence (preserved, redacted derivatives with raw hash provenance)
`test-results/phase02-log-redaction-manifest.txt` maps each raw log (mode 700 `secure-raw-logs/`, 600 files, hash verified 23/23 at the
time of the check and extended since) to its `*.redacted.log` derivative and prints `raw_sha256`, `redacted_sha256`, `leaks=0`. Raw logs are
never committed. Key records: `phase02-workspace-hostile-s5t9-original` (123/125, S5-T6 BLOCKED, S5-T9 FAIL), `...-s6-run1` (S6-H2/H3 FAIL:
combined read let `cancel_previous` dispatch before inspection; due read could answer `null`), `...-s6-final` and a later run (S6-H5 duplicate
job stayed `queued`; cause not isolated, see limits). Derivation is a custody measure, not a logger repair.

### Logger repair (source, not a filter)
The harness printed `probe.brief(...)` and every PASS/SKIP detail unredacted, and registered only tokens a probe remembered to register.
Now (`scripts/lib/smoke-harness.mjs`): `request()` registers every `*_token` / `*secret` field of any response before returning it, `brief()`
redacts before slicing, `pass()`/`skip()` redact. S5-T7 carries a redaction canary (the minted lease token is absent from `redact(text)` and
`brief(res)`); the S6 claim prints status and `lease_id` only. `scripts/phase02-redact-log.mjs` + a node test redact and gate derivatives.
Replay `phase02-workspace-hostile-s6-run4.log` (sha256 `ca045948232640909dfccdeeadb2aa7d37c4f9da0dc6fe0bf4e052bf2421ff68`): gate leaks 0, raw 64-hex runs 0,
raw `DeviceToken` 0, one `lease_token` key mention with value `[redacted]`.

### Verifier hardening (supervisor feedback)
Due reads must be HTTP 200 with an `items` array (`offered`/`notOffered` fail closed, never `null`-is-absent); S6-H1 asserts the exact reason
`entitlement_limit_exceeded`; the entitlement fixture value is read first, lowered (1), raised (50) only for the differential, and restored in a
`finally`; queue_one and cancel_previous run as separate phases with their own positive controls.

### Result on the final tree
`phase02-workspace-hostile-s6-run4.log`: exit 0, **149/149**, every claim PASS (S4, S5, S6-C1/H1..H5), real Worker + local D1, no D1 dispatch authority.
Quality: `cargo fmt --check`, `pnpm check` (818 web, 1048 + 11 Rust, 15/15 secret canaries, 17/17 guard cases, clippy -D warnings, WASM check),
`pnpm build` (web build + Wrangler dry-run), node tests 22/22. Logs: `phase02-server-pnpm-check-final.log`, `phase02-server-pnpm-build-final.log`.

### Producer starvation (new product-level repair)
`QUEUE_ENVELOPES_DUE_SQL` read `LIMIT 100` over every queued type, so unpublished types could starve dispatch rows. It now filters
`job_type IN ('export.run','deletion.run','automation.dispatch')` before the LIMIT. `p02-guard-probe.mjs` proves it against the real schema in SQLite:
150 older `webhook.deliver` rows then one `automation.dispatch` row, read with limit 100: with the filter the dispatch row is returned (17/17);
with the filter deleted the case FAILS (16/17), restored 17/17.

### Additional defects found and fixed in this lane
- `find_predecessor` returned ANY open sibling, so two pending occurrences saw each other (skip skipped both / ordering inverted). Now an OLDER open
  occurrence only (mutation B proves it).
- Deferral through the failure retry would burn the 8-attempt budget and strand a queue_one successor. Deferral now reschedules the job to `queued`
  with a later `next_attempt_at` and an unchanged attempt count (mutation E proves it); a message for a not-yet-due job is acknowledged, not re-evaluated
  (mutation F proves it).
- `Queue::send` of a `serde_json::Value` object arrives as `{}` locally; the producer sends the typed envelope.
- Candidate `ASSERT_PINNED_BINDING_LIVE_SQL` was not pinned by the guard polarity matrix (`pnpm check` failed); it is now (permit: no pin, live binding;
  abort: removed, other device, other org, missing).

### Disposable-copy mutation proofs (each fails only for the intended reason; S6-C1 positive control PASS in every run)
| ID | Fault (source hash in `phase02-mutation-efg-source-hashes.txt` for E-G) | Result |
|---|---|---|
| A | dispatch-time eligibility/overlap recheck removed | S6-H1/H2/H3/H4 FAIL (ineligible org dispatched; overlap ignored) |
| B | predecessor age bound removed | S6-H4 FAIL (older skipped, newer dispatched) |
| C | org scoping removed from occurrence and automation reads | S6-H5 FAIL (forged cross-org job succeeded) |
| D | already-dispatched early return removed | S6-H5 FAIL (duplicate job stays queued) |
| E | deferral consumes a job attempt | S6-H2 FAIL (`retry_wait`, attempt 2) |
| F | not-yet-due guard removed | S6-H3 FAIL (successor dispatched early) |
| G | same-key replay no longer refreshes policy | S5-T9 FAIL (policy stale, snapshots 14->14) |
E-G also show the S5-T7 redaction canary FAIL: those copies ran before the logger repair, which is the canary doing its job. Invalid attempts are preserved
and labelled (`...-INVALID-shared-target-race`, `...-INVALID-cold-build-timeout`): parallel builds shared one cargo target and cold builds exceeded the
Worker health timeout. Valid runs used isolated targets and a pre-build.

### Environment finding
`node_modules`, `apps/api/node_modules`, `apps/web/node_modules` and `apps/web/dist` were symlinks into a deleted `/private/tmp` checkout. They were
replaced with a real `pnpm install --frozen-lockfile --offline` and a real web build (untracked, generated).

### Remaining limits (not proven)
- S6-H5 duplicate-job flake: two earlier runs left a planted duplicate job `queued` through 14 sweeps; four later runs and the filtered read passed. The
  cause is not isolated (the type-filter is a source-supported mitigation, not a proven root cause). Repeat runs are owed.
- `state_version` / job-claim races are guarded in SQL and proven only serially here; no concurrent-consumer race test.
- Inconsistent-message cases (envelope tenant or payload disagreeing with the row) are unit-reasoned, not injected at runtime; the cross-org case uses a hostile D1 job row.
- `pending_deletion` org, revoked membership and expired license dispatch blocks: only the entitlement-limit block is runtime-proven.
- Export/deletion publishing passes a `serde_json::Value` to `Queue::send` like the original automation attempt did (delivered as `{}` locally). Outside this cut,
  unchanged, and a suspected defect: needs its own local-queue proof before any export/deletion claim. Do not copy broad P06 here.
- Real Cloudflare queues, desktop client, native account/race/restart/fault gates, hosted CI and deployment remain unproven.

### Repeat replays on the final tree
`phase02-workspace-hostile-s6-run6.log` (sha256 `3c4d8a0662d14c6440e63b09fb75b9cade8391dbc12169882efd9bf7d9c74137`): exit 0, 149/149, gate leaks 0, raw 64-hex 0.
`...-s6-run5-HARNESS-transport-failure.log` (sha256 `c9a6ae70b7ffe3884fbba7d4b6ee9e718e9048d934571f5546b816fd4e5e4d16`): exit 2, local Worker socket
"fetch failed" during the S5 stage, before S6: a harness failure, not a product verdict. With the type filter and condition-based waits: runs 3, 4 and 6 PASS
149/149 or 148/148 and none shows the S6-H5 duplicate-job symptom; three clean runs reduce but do not eliminate the flake limit above.
