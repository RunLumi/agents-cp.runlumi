# V01-023 — `start_occurrence` can never succeed: one guard's polarity is inverted

## Status

**found, pre-fix evidence preserved below, and REPAIRED.** Severity **high**. Found while attacking
OBS-001, and it makes OBS-001 far worse than the observation it started from.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-IDEM-007` (new) — *a claimed automation occurrence can be started* |
| **Setup** | a real Worker and fresh D1. One organization, one enrolled device with a real ed25519 proof, one automation, a `run_now` occurrence, a claim, and the organization granted `automations.max_active` so that nothing else can block dispatch. |
| **Action** | claim the occurrence, then `POST /api/v1/devices/automation-occurrences/{id}/start` with the lease id, version, fence and token the claim returned. |
| **Expected** | `200` with a start grant, a `run_id`, and `automation_run_links` holding one row. |
| **Actual** | **`409 conflict` / `lease_fence_invalid`**, with `run_id` still null and zero run links. |
| **Evidence** | `evidence/v01-023-attempt-exhaustion.txt` |
| **Verdict** | **FAIL, repaired** |
| **Regression gap** | none remaining; the polarity of **all nine** guards is now pinned by a unit test |
| **Severity** | **high** — no automation can ever run |

## The measurement, and why four earlier hypotheses were wrong

The 409 names a lease, and the lease was fine. Everything below was measured rather than read, and
each wrong hypothesis is recorded because each one cost a run:

| hypothesis | measurement | verdict |
|---|---|---|
| the entitlement is missing | granted `automations.max_active`; the start got *further*, not less far | wrong |
| the license state is not `active` | the route logs its own bound value: `license_state=active` | wrong |
| the presented fence is stale | presented `(version 1, fence 1)`; stored lease `(1, 1)`; `lease_token` fingerprint `sha256:d90d…` identical on both sides | wrong |
| the occurrence guard's `state_version` is stale | route bound `occurrence_state=leased occurrence_state_version=2`; the row agrees | wrong |

The reason string was the last thing to give. `lease_fence_invalid` is what a **guard** looks like
from outside, because the `guard!` macro aborts a D1 batch by inserting a deliberately invalid
`idempotency_records` row, and the route maps that abort to a lease error:

```rust
Err(error) if crate::repositories::is_guard_violation(&error) => { … }
```

So the answer was in a **discarded** `worker::Error` — the V01-010 shape, in a route nobody had
audited for it. Reading it required adding a log line, because the error text is the only thing that
distinguishes "a lost race" from "a guard that always fires":

```
a pending idempotency record carries no result and must hold a claim token:
  SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)
```

That is `trg_idempotency_pending_has_no_result`, which fires **only** when a guard's INSERT actually
inserts a row — which happens **only when the guard's condition is false**. So one of the four
guards in the start's batch was false, while every one of them read as true.

## Root cause — one guard asserts the opposite of its name

`apps/api/src/repositories/automations.rs`:

```rust
macro_rules! guard {
    ($condition:literal) => {
        concat!(… "SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL ",
                "WHERE NOT EXISTS (", $condition, ")")
    };
}
```

The macro's contract is: **abort when the condition returns no rows.** So a guard must state a
*positive* precondition — "the lease is current", "the occurrence is in this state".

Eight of the nine do exactly that. The ninth does not:

```rust
/// Refuse a `start` that would create a second P05 run for the same …
pub fn assert_run_link_absent_statement(&self, occurrence_id: &str, attempt: i64) -> … {
    self.database.prepare(
        guard!("SELECT 1 FROM automation_run_links
                 WHERE occurrence_id = ?1 AND attempt = ?2"),
        …
```

The condition is *"a run link already exists"*. `NOT EXISTS` inverts it, so the guard aborts when
**no** link exists. The predicate is exactly backwards:

| | guard aborts when |
|---|---|
| intended | a run link **already exists** (would duplicate a run) |
| actual | **no** run link exists — i.e. on every legitimate first start |

### How the probe named it, after the predicates all said "true"

Evaluating the four guard *predicates* was not enough: all four returned "holds", and a guard still
fired. The fix was to execute each guard **verbatim**, exactly as `guard!` expands it. That is
possible because the macro is a pure string expansion, and the result is unambiguous — a guard whose
condition holds inserts zero rows and cannot fail any CHECK, while one that fires inserts a row and
hits a constraint:

```
guard lease:       CONDITION HOLDS (the guard inserts nothing, as intended)
guard occurrence:  CONDITION HOLDS (the guard inserts nothing, as intended)
guard link_absent: GUARD FIRES -- the condition does NOT hold
guard eligibility: CONDITION HOLDS (the guard inserts nothing, as intended)
```

The three that "hold" were verified by their *silence*; `link_absent` was caught by the very error
text I first dismissed as my own mistake. My probe's guard INSERT used a `path` of `V01PROBE-link`,
which violates `idempotency_records`'s own `CHECK (substr(path, 1, 1) = '/')` — so I attributed the
error to my instrumentation and nearly kept looking elsewhere. It was not instrumentation noise: the
INSERT was only reached at all **because the guard decided to insert**, and a `WHERE NOT EXISTS` that
is false never evaluates a single row's CHECK. The bug was in my reasoning about which branch ran,
and the fix was to stop reasoning about branches and execute the statement.

## Why the severity is high, and not "one route is broken"

`start_occurrence` is the only transition from a lease to a run. With its batch permanently aborted:

- **no automation occurrence can ever start**, on any organization, under any configuration;
- every occurrence can still be **claimed**, which consumes the attempt counter and takes a lease;
- the sweep then resolves each one to `failed` once the attempt bound is reached.

So the durable outcome is an automation system that burns its own retry budget and produces nothing,
and the only symptom a client ever sees is `lease_fence_invalid` — a reason that names a lease, on a
route that never got as far as the lease.

It also **invalidates the recorded severity of OBS-001** (`claim_occurrence` not checking dispatch
eligibility). OBS-001 was measured as *medium* on the reasoning that a device could waste an attempt
on undispatchable work. That is still true, but it was never the worst case: the attempt was wasted
because **`start` is dead for every organization**, entitled or not. The attack is a real
pre-existing asymmetry and is left in place; the finding here is the larger one it was hiding behind.

And it explains a **gap that was recorded as environmental**. `GAP-008` was written as *"the
two-phase `start_occurrence` needs an entitled organization"*, and the named SKIP sat in
`verify:attempt-exhaustion` for the life of the probe with the comment *"the recorded severity of the
`started_at` half of V01-013 rests on reading the route until that exists"*. The gap was never
environmental. The organization was made entitled, the start was driven, and the transition was
**unreachable** — so a claim recorded as a coverage limitation was in fact a live defect, sitting
behind an assumption nobody had tested.

## The repair

`assert_run_link_absent_statement`'s condition is restated as the positive precondition the macro
requires — *"no run link exists for this attempt"*:

```rust
guard!("SELECT 1 WHERE NOT EXISTS (
         SELECT 1 FROM automation_run_links
          WHERE occurrence_id = ?1 AND attempt = ?2
       )")
```

The function's name, its doc comment and the route's comment at the call site all already say
"absent", so the SQL was the only thing out of step.

## Regression coverage — the polarity of all nine, not just this one

A unit test evaluates each of the nine guard predicates **twice**: once in the state the guard is
meant to permit, and once in the state it is meant to abort. A guard whose polarity is inverted fails
on one of the two, and a guard whose condition cannot distinguish the two fails as *vacuous* — which
is the failure this campaign has now hit four times, so it is asserted explicitly rather than assumed.

That is the generalisable form of this whole finding:

> A guard's SQL is not readable as intent. `guard!("SELECT 1 FROM t WHERE …")` and
> `guard!("SELECT 1 FROM t WHERE NOT …")` differ by one `NOT`, they have the same shape, the same
> macro, the same failure mode and the same error text — and one of them silently permits the
> duplicate it was written to prevent. **Test the polarity against both states, or the guard is
> decoration.**
