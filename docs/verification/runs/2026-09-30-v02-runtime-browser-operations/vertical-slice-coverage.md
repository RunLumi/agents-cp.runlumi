# V02 vertical-slice coverage — the objective's ten slices, graded

**Objective section: "Representative vertical slices 1–10."**

This maps each of the ten slices to the runtime evidence that exists for it, and grades the slice on
**that evidence** rather than on the presence of a gate. A gate that exists is a claim; the claim this
document makes is about which gates have actually been run and what they asserted.

## The headline

**Nine of ten slices have adversarial runtime evidence that grades on stored state. Slice 5 was
the capability fully wired and never driven, until V02-011 drove it and repaired two defects found
along the way. One (7) has a known, deliberate gap carried over from V01.**

| # | slice | verdict | evidence |
|---|---|---|---|
| 1 | account/session lifecycle | **PROVEN** | `smoke:p02` (signup, email verification, password login, recovery, session revocation), `verify:revoked-device` (29/29, exit 0), `smoke:passkey` (a real WebAuthn ceremony with hostile cases for challenge, origin, RP ID, replay, expiry, revocation) |
| 2 | org/project/resource authorization | **PROVEN** | `verify:path-id-tenancy` (198/198 across 18 one-path-id routes), `verify:filter-tenancy` (65/65), `verify:collection-tenancy` (54/54), `verify:mutating-tenancy` (the **write** half, graded on stored rows), `verify:privilege-escalation` (96/96), `smoke:p08` |
| 3 | managed inference + budget denial | **PROVEN** | `verify:budget-hardceiling` (25/25, 3 detected mutations), `verify:budget-concurrency` (a hard ceiling measured under 8 simultaneous reservations), `verify:inference-failure` (five outcomes, graded on two D1 tables) |
| 4 | BYOK metadata path without secret exposure | **PROVEN** | `verify:secret-tenancy` (32/32, canary-based) **+ V02-007/V02-008 in a real browser** — this is the one slice with browser evidence added this campaign |
| 5 | **tool-policy allow/deny** | **PROVEN (V02-011)** | `verify:tool-policy-deny` (48/48, exit 0, stable ×4): the deny branch driven for the first time over real HTTP — stored `denied` with `org_tool_denied`, a `tool.decision_recorded.v1` envelope, an attributable security row, a `tool.denied.v1` timeline entry, a liftable deny, and a foreign-org==phantom 404 comparison. Found and repaired two product defects (fail-open denial, check-order oracle), each with a detected sensitivity mutation. |
| 6 | automation + lease/retry | **PROVEN** | `verify:lease-contention` (exactly one winner, one lease, `state_version` advanced once), `verify:attempt-exhaustion` (49/49 — found V01-023 and V01-025, the two largest defects of that round) |
| 7 | webhook/outbox | **PROVEN, with a known gap** | `verify:webhook-fanout` (19/19) proves delivery and replay work. **V01-046**: a committed business event is never fanned out to a subscribed endpoint — `fan_out_event_statement` has no caller. Fail-closed, open by decision. |
| 8 | export/deletion | **PROVEN** | `smoke:p06` (a real export over HTTP to a real Worker and local D1, with tenant and permission boundaries and idempotent replay). **Its R2 leg is BLOCKED** — the local queue does not deliver a published body. |
| 9 | migration/adoption | **PROVEN** | `verify:adoption-privacy` (8 content classes against every adoption write surface), `verify:migration-prior-state` (the ledger applied to *populated* tables), `db:migrate:local`, `verify:restore`, `p08-invariants` (17/17) |
| 10 | one admin/support action with audit | **PROVEN** | `verify:staff-credential` (46/46, exit 0) — all six `/api/v1/internal/**` routes measured, including the four that carry V01-034 through V01-038 |

## Slice 5, in detail: the capability was wired and never driven — until V02-011

This was the one gap this campaign identified rather than inherited, and it was **not** the
V01-043 shape. The difference mattered then, and it matters differently now: driving the branch
for the first time found two product defects (a fail-open denial and a check-order existence
oracle), both repaired, both sensitivity-proven. The table below is kept as the record of what the
gap *was*, so a reader can see what "driven" changed:

| | V01-043 (plugin quarantine) | **slice 5 (tool-policy deny)** |
|---|---|---|
| schema | present | present |
| statement | present | present |
| production caller | **none** | **present** — `routes/tools.rs:1687` calls `evaluate(&evaluation)` |
| route branch | **none** | **present** — `if input.decision == ToolDecision::Deny { return persist_denial(...) }` at line 1758 |
| unit tests | present | present (`tool_policy_tests.rs`, 28 references) |
| **runtime evidence** | **none** | **none** |

So this is *not* a capability built and wired to nothing. The evaluation is reachable, the deny branch
is implemented, and the reason codes (`org_tool_denied`, `project_tool_denied`, `tool_denied`) are all
present. **Nothing has ever put a non-empty `denied_tool_ids` into a fixture and called the route.**

That is measurable, not inferred:

```
$ grep -c "denied_tool_ids: \[\]" apps/api/scripts/*.mjs
v01-privilege-escalation-probe.mjs: 2      # always EMPTY
p05-smoke.mjs:                            # one non-empty, and it is a fixed-fixture setup for an
                                          # outbox reason enum, not an executed denial
```

Every fixture sets the deny list to empty, so `ToolDecision::Deny` is never produced by a real
request. The deny branch is unverified code in a shipped product.

**The endpoint is `POST /api/v1/runs/{run_id}/tool-decisions`, and that is why the fixture is
expensive:** reaching it requires a real `run_id`, which requires a managed project, a model policy
with `managed_route_enabled`, an entitlement, and a dispatched occurrence. `verify:lease-contention`
already builds that chain, so it is feasible — it is a fixture-reuse problem, not an architecture
problem.

**The next action, stated concretely:** a probe that creates a run (reusing `verify:lease-contention`'s
fixture), sets `denied_tool_ids` to contain the tool it is about to request, calls the endpoint, and
asserts on the **stored** state that (a) the response is a refusal carrying a `tool.denied.v1` event,
(b) no approval row exists, and (c) the event is attributable per ADR 0007. Grading on stored rows
matters here: a handler that answered `200` while writing no denial would pass a status check.

**Not recorded as a defect.** No requirement in `docs/specs` appears to demand runtime evidence for
this branch, and the code is present and reviewed. This is a **coverage gap against the objective's own
slice list**, and it is recorded as such rather than escalated.

## Two slices where the grade carries a caveat worth stating

**Slice 7 (webhook/outbox) is proven *and* has a gap, and those are different statements.** Delivery and
replay work over real HTTP with controls (W0–W4 prove the subscription is persisted, the test endpoint
creates a delivery, and the business event reached the outbox; W6 proves replay). What does not happen
is a **committed business event being fanned out** to a subscriber — V01-046, fail-closed, open by
decision. A reader who saw "19/19" and concluded fan-out works would be wrong, and
`verify:webhook-fanout`'s own record says so explicitly.

**Slice 8 (export/deletion) is proven with one leg BLOCKED.** `smoke:p06` drives a real export to a
real Worker and local D1, and proves its tenant and permission boundaries and its idempotent replay.
The **R2 leg is BLOCKED**: the local queue does not deliver a published body, so `smoke:p06` **exits 2
here** rather than 0. That is the correct verdict — the gate knows it did not measure the whole
surface.

## How this map is calibrated

The same rule as the browser-state map, applied to slices: **the count of gates is telemetry; the
evidence behind them is the claim.** A slice is marked PROVEN here only where at least one gate grades
on stored state or a real runtime outcome, and where the gate's own sensitivity has been demonstrated
at least once. Slice 5 now passes that test: `verify:tool-policy-deny` grades on stored rows and carries two detected mutations (M1, M2).