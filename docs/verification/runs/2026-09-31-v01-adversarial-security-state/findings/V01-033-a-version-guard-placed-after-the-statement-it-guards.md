# V01-033 — a version guard placed *after* the statement it guards can never pass

- **Claim:** `PATCH /api/v1/orgs/{org}/service-accounts/{id}` works for the organization's own record.
- **Severity:** HIGH. The route is **permanently dead** — every request, from any caller, for any version.
  And it reports `409 version_conflict`, so it reads as a concurrency problem rather than a broken route,
  which is the more expensive of the two to diagnose.
- **Verdict:** FAIL at discovery; one case PROVEN, six named candidates
- **Discovered by:** `verify:path-id-tenancy`'s control for a route it could not establish
- **Regression gap:** the gate's own control is the regression test, and it was the thing that refused to
  be papered over

## Setup

- Alice owns a service account in her organization, created through the API, at `version = 1`.
- `verify:path-id-tenancy` sends `PATCH /orgs/{A}/service-accounts/{id}` with `{"version": 1, "name":
  "Renamed"}` — the version read out of D1 immediately beforehand, and printed in the failure detail so
  it could not be a guess.

## Action

Rename the organization's own service account, at the current version.

## Expected

`200`, and the row's `name` and `version` updated.

## Actual

```
409 conflict   "The service account changed. Refresh and try again."
details.reason = "version_conflict"
```

with the request carrying the version the database holds. `suspend` on the same record answers the same
way, and `credentials/{id}/rotate` answers `404` for a credential D1 shows as user-owned in the same org —
three UNPROVEN items in a gate that had been green an hour earlier.

## Root cause: the order inside the batch

`patch_service_account` builds its batch as:

```rust
vec![update, guard]      // the guard is SECOND
```

where

- `update` is `UPDATE_ACCOUNT_SQL`, whose `SET` includes `version = version + 1`;
- `guard` is `ASSERT_ACCOUNT_VERSION_SQL`, which aborts the batch when
  `NOT EXISTS (SELECT 1 FROM service_accounts WHERE service_account_id = ?1 AND org_id = ?2 AND version = ?3)`.

So the batch runs the `UPDATE` — which moves the row from `version = 1` to `version = 2` — and *then*
evaluates a guard that asserts the row is still at `version = 1`. It never is. The guard always aborts, and
the caller reports `Guarded` as `version_conflict`.

The guard is a **precondition** ("this row is at the version I read") and is being evaluated as a
**postcondition**.

## Proof, from the database, with the order as the only variable

Two copies of the probe's own database, the same account, the same version, the same two statements:

| | order | result |
|---|---|---|
| A | `UPDATE` then guard — **what the code does** | guard trips: *"a pending idempotency record carries no result and must hold a claim token"*, and the caller answers `version_conflict` |
| B | guard then `UPDATE` | **succeeds**, and the row's version becomes 2 |

Nothing else differs. And the guard on its own, with a version that matches, inserts **nothing** — the
row count of `idempotency_records` was 8 before and 8 after — so the guard's own logic is correct and only
its *position* is wrong.

## The convention, and why this is a defect rather than a style

Scanning every `vec![...]` batch in `apps/api/src/routes` for a version-asserting guard:

**33 batches carry one. 26 place the guard FIRST. 7 place it after a writer.**

So "assert the expected version, then write" is the established order, and these seven deviate from it.
That is the opposite of the situation the campaign hit with the 117-candidate bind scanner: there, a
pattern matched both defects and conventions, so it proved nothing. Here the majority order *is* the
convention, and the minority is the deviation.

**That makes the seven candidates, not seven findings.** A guard that asserts a **postcondition on a row
just written** must run second, and one site is exactly that:

- `budgets.rs:1177` — `vec![insert, guard, audit]` where the guard is
  `assert_reservation_created_statement`. It asserts the reservation that the `insert` creates, so it
  **must** run after it. Current order correct; **not a defect**.

Reordering every guard-first would have been the wrong fix, and it would have broken this one. The
discriminator is what the guard's SQL selects, not where the guard sits, and that is why the seven are
reported as candidates with the discriminator named.

## Status of the seven

| site | batch | status |
|---|---|---|
| `machine_identity.rs:519` | `vec![update, guard]` | **PROVEN DEFECT** — the two-order experiment above, and the gate's own control |
| `machine_identity.rs:669` | `vec![statement, guard]` | **PROVEN DEFECT** — the `suspend` control answers the same `409` at the version D1 reports, and the statement is the same version-bumping `UPDATE` |
| `budgets.rs:1403` | `vec![update, guard, audit]` | **NOT a defect — and the campaign's own re-run proved it.** See the section below. |
| `budgets.rs:1177` | `vec![insert, guard, audit]` | **NOT a defect** — postcondition on the inserted row; the current order is required |
| `internal.rs:418` | `vec![update, guard]` | **CANDIDATE** — guard builder not yet identified |
| `plugins.rs:566` | `vec![statement, guard]` | **CANDIDATE** — guard builder not yet identified |
| `plugins.rs:1499` | `vec![statement, guard]` | **CANDIDATE** — guard builder not yet identified |

The three candidates are named rather than claimed, and each needs one thing: **read its guard's SQL and
decide whether it is a precondition on a version the writer bumps, or a postcondition on a row the writer
just created.** That is a five-minute reading each, and it is left rather than guessed.

## The wrong fix I applied, and the gate that caught it

Having established the mechanism on `machine_identity`, I applied the same reorder to
`budgets.rs:1403` — `vec![update, guard, audit]` → `vec![guard, update, audit]` — because its guard is
`assert_budget_version_statement(&budget_id, &org_id, body.version)` and the update is handed
`expected_version: body.version`, so both use the *same* pre-write version. By the reasoning above it
should have been the same fix.

**It broke three cases.** `verify:budget-concurrency` went **28/28 → 25/28**, on the reservation-**release**
path: the release answered `403 budget_exceeded` and `held 90 -> 90 after releasing`. Reverting only that
one reorder and rebuilding restored **28/28**, so the regression was mine and not the environment.

**I do not have a verified mechanism for why.** The reordering leaves `audit` last and swaps only the first
two statements, and both sides of the comparison use the same pre-write version, so the argument that the
guard is a precondition — which is sound on `machine_identity` — does not explain it. Something about the
order interacts with the scoped-mutation claim that I have not traced. Rather than invent a mechanism, the
site is recorded as **current order correct, cause not established**.

The lesson is the one this record is really about, and it cost a gate:

> **"The guard follows a writer" is not a defect. It is a defect only when the guard asserts something the
> writer invalidates, and that has to be established per site.** My scan told me the *shape*; the
> two-order experiment told me the *mechanism* for one site; and neither told me the other. The cheap,
> decisive test is the one the campaign already insists on — **re-run the affected gate after the fix** —
> and it is what stopped a wrong repair from being merged as a right one.

The scan's 7 candidates are **1 proven defect (machine_identity ×2), 1 postcondition that is correct
(budgets 1177), 1 cleared by measurement (budgets 1403), and 3 more defects, established the same way.**

### The three remaining candidates, measured rather than reasoned about

Each was classified the only way that survived the budgets lesson — by reading what its guard is handed,
and then by running the same two-order experiment against a **copy of a real database with the row
created for it**:

| site | guard builder | handed | `feature_flags` / `plugin_policies` measurement |
|---|---|---|---|
| `internal.rs:418` | `assert_flag_version_statement` | `body.version` | writer→guard **ABORTS**; guard→writer **succeeds**, version 1 → 2 |
| `plugins.rs:566` | `assert_policy_version_statement` | `body.version` | identical |
| `plugins.rs:1499` | `assert_policy_version_statement` | `body.version` | identical |

All three hand the guard the **client's pre-write version**, so all three are preconditions, and all three
are placed after the statement that replaces that version. **Three more routes could never succeed**, and
each reported `version_conflict`.

The mechanism is therefore **table-independent** — it was measured on three separate tables
(`service_accounts`, `feature_flags`, `plugin_policies`) with the same result — which is what makes it a
class rather than an accident.

**All three are fixed.** The remaining `vec![update, guard, audit]` in `budgets.rs:1412` is annotated in
the source explaining that it was measured, that reordering it regressed budget-concurrency, and that the
pattern is not the diagnosis — so the next reader does not "fix" it a second time.

### Confirmed scope: 5 routes across 4 tables

`machine_identity.rs` ×2, `internal.rs` ×1, `plugins.rs` ×2. Every one was a permanently dead route
reporting a concurrency problem.

**No gate covers the feature-flag or plugin-policy routes**, which is why the two-order experiment rather
than a gate run is the evidence here — and it is also a coverage gap in its own right, recorded below.

## The two false readings this produced first, and why they are worth recording

**Reading one: the guard can never succeed.** `ASSERT_ACCOUNT_VERSION_SQL` inserts a sentinel
`idempotency_records` row with `claim_token = NULL`, and the database refuses it — *"a pending
idempotency record carries no result and must hold a claim token"*. A scan found **33 guards of that
shape**, and the obvious reading is that every versioned route in the product is dead. That reading is
**wrong**: `ASSERT_BUDGET_VERSION_SQL` is byte-identical in shape and `verify:budget-concurrency` is
28/28. The trigger refusal is the guard's *intended* abort mechanism — it is how a guard says "no".

**Reading two: the phantom version.** The same 409 also arrived for a request carrying a version looked up
in the database, so the first hypothesis was a read skew between the Worker and `wrangler d1 execute`. The
two-order experiment is what settled it, and it took a copy of the real database rather than a rebuild.

> A check that cannot distinguish a defect from a convention is the wrong check. A text scan over 33
> identical-looking guard statements would have produced a confident, alarming and completely wrong claim,
> and the only thing that caught it was a **green gate using the identical statement**.

## Fix

Reorder the batch so the guard precedes the version-bumping statement. This is the order 26 of the 33
sites already use, and it is the only order in which a compare-and-set means anything: assert the version
you read, then write against it.

## Coverage gap this exposed

Three of the five routes fixed here — `internal.rs` and both `plugins.rs` sites — have **no gate at all**.
`smoke:p08` counts org-scoped routes; these are not among them, and no probe drives them. A permanently
dead route in a family nobody exercises is the most durable kind of defect, because nothing will ever
notice it.

They are now credited by name in `verify:path-id-tenancy`'s credit table as needing a fixture, which makes
the gap visible. Growing that gate to cover them is the next piece of work, and it is the same work the
remaining 41 credited routes need.

## Closure evidence

Added on repair; the proof is the gate's own control for `service-accounts` PATCH and `suspend` going from
a degraded `409` to a `2xx`, and the two `UNPROVEN` items in `verify:path-id-tenancy` either closing or
becoming something else. See the commit that closes this finding.
