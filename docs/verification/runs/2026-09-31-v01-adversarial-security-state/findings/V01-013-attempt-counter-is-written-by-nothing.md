# V01-013 — the attempt counter that bounds automation retries is written by nothing

## Status

**CLOSED.** Found by the lease-contention probe on its first successful run. Root cause located
and confirmed; the repair is **not** applied, and it is not attempted here, because
`TRANSITION_OCCURRENCE_SQL` is shared by four routes and needs its own attack.

## Severity

**high.** `max_start_attempts` is the bound on how many times an automation occurrence may be
started, and it is **unenforceable**. Nothing can be retried forever through this path, because
the number the check reads never changes.

**Raised by V01-014's run, with a second symptom that is client-facing.** Driving the whole arc
showed the dead counter also makes a *legitimate* re-claim fail as an outage: because the re-claim
recomputes `attempt = 0 + 1 = 1`, its attempt row collides with the first claim's on
`ux_automation_occurrence_attempts(occurrence_id, attempt, outcome)`, the batch aborts, and the
device is told **"The automation control-plane store is unavailable."** with empty `details`. A
device that lost its lease and retried is therefore told the whole store is down, and backs off
against a fiction. Same root cause, so the same fix removes it -- see V01-014 for the chain and
the database evidence.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-LEASE-001` (new) |
| **Setup** | real `wasm32` Worker, fresh local D1, a real owner, a real organization, project, agent and **automation**, a real `run_now` occurrence, and a real enrolled device with a real ed25519 device proof. |
| **Action** | eight **simultaneous** `POST /api/v1/devices/automation-occurrences/{id}/claim` from one device, then read the occurrence back out of D1. |
| **Expected** | a `leased` occurrence whose `attempt` has advanced and whose `started_at` records when the work began. |
| **Actual** | `state=leased attempt=0 started_at=null`. The lease row says `attempt=1`; the **occurrence** still says `0`. |
| **Evidence** | `evidence/v01-013-lease-attempt.txt` |
| **Verdict** | **FAIL — product defect.** |
| **Regression gap** | the two assertions exist in the probe and **fail on purpose** until this is fixed |
| **Severity** | high |

## Root cause

`apps/api/src/repositories/automations.rs`:

```sql
const TRANSITION_OCCURRENCE_SQL: &str = r#"
UPDATE automation_occurrences
SET state = ?3,
    state_version = state_version + 1,
    reason_code = ?4,
    run_id = COALESCE(?5, run_id),
    lease_expires_at = ?6,
    queued_at = ?7,
    blocked_by_occurrence_id = ?8,
    started_at = COALESCE(started_at, ?9),
    finished_at = ?10,
    updated_at = ?11
WHERE occurrence_id = ?1 AND org_id = ?2 AND state = ?12 AND state_version = ?13
"#;
```

**There is no `attempt` in the SET list.** It is the only column of `automation_occurrences`
that this statement does not touch, and nothing else writes it either — the occurrence is
inserted with `attempt = 0` and never changed. The claim computes:

```rust
let attempt = occurrence.attempt + 1;
if attempt > i64::from(retry.max_start_attempts) {
    return Err(domain_failure(context, DomainError::OccurrenceLeaseExpired));
}
```

With `occurrence.attempt` permanently `0`, that expression is **always `1`**. So:

- `max_start_attempts` can never be exceeded. The guard is real code, reads the right column,
  and is dead.
- Every claim in the lifetime of an occurrence is attempt 1.

`started_at` is the second half of the same defect. The statement does
`started_at = COALESCE(started_at, ?9)`, and the claim's transition input passes
`started_at: None` — so `COALESCE(started_at, NULL)` is `NULL` and a **leased** occurrence
records no start time. Whatever later transition does pass a `started_at`, the first one to
arrive wins, and the claim is the transition that establishes the lease.

### Why the second half is not merely cosmetic

`automation_run_links` and `automation_occurrence_attempts` are keyed by
`(occurrence_id, attempt)`, with a unique index each. A second claim after a lease expiry
would therefore be attempt 1 again and collide on that index — so the retry is blocked, but by
an unrelated constraint with an unrelated error, rather than by the bound that is supposed to
express it. And a leased occurrence with no start time cannot have its duration computed by any
sweep that looks for stuck work.

## What the probe proved alongside it

The exclusivity claim itself is **sound**, and that is worth stating because it was the
required case with no evidence at all before this round:

| claim | result |
|---|---|
| 8 simultaneous claims, one device, one occurrence → exactly one winner | **1 of 8** (`201`, seven `409`) |
| exactly **one** `active` lease for the occurrence | **1** |
| `state_version` advanced by exactly one transition | **1 → 2** |
| exactly one attempt row | **1** |
| no losing response carries the winner's lease id or raw token | **0 of 7** |
| every loser is an explicit 4xx with a stable reason | seven `409 occurrence_already_claimed` |
| the winner's raw token is never persisted | only a `sha256:` fingerprint is stored |

Two independent mechanisms hold this up and both were verified rather than assumed: the
`state_version` compare-and-set in the transition's `WHERE`, and the partial unique index
`ux_automation_leases_active ON automation_leases(occurrence_id) WHERE state = 'active'`.

## What the sensitivity proof established about WHICH mechanism carries the claim

The exclusivity claim was defended by two things that looked equally load-bearing: the
`state_version` compare-and-set in `TRANSITION_OCCURRENCE_SQL`, and the partial unique index
`ux_automation_leases_active`. Mutating each in turn showed they are **not** equal, and the
difference is the useful part of the result.

**Breaking the compare-and-set fails CLOSED.** With `state_version = state_version + 1` replaced
by `state_version = state_version`, every racer's `UPDATE` matches, so all eight batches run and
all eight **fail**: zero active leases, every status a `503`, the occurrence still `pending`. The
system denies all the work rather than admitting two leases, which is the right way round to
break. A lease *count* alone would not have noticed — the index would still have admitted one —
so it is the `state_version` counter assertion that sees this case.

**Breaking the unique index changes nothing observable.** With `WHERE state = 'active'` replaced
by `WHERE state = 'never'` on the index, the claim held **perfectly**: one winner, one active
lease, one state transition, no loser carrying the winner's material. The only failures were the
two known-open V01-013 ones.

So the compare-and-set is the load-bearing mechanism, and the index is a **redundant second line
for this claim**. That is worth recording rather than smoothing over, for two reasons. A reviewer
who assumed the index was the guarantee would be wrong about which statement to protect, and a
future code path that inserts a lease without going through the CAS would have **no protection
from this proof at all** — the mutation that exposed the dependence would not touch that path.

The two mutations are mirror images, and that is why both were worth running: one shows what
happens when the real mechanism breaks, and the other shows that the belt is not what is holding
the braces up.

## Why nothing caught it

The same reason as V01-011, one level down: **no probe in the repository had ever created an
automation**, so no occurrence could exist, so nothing could claim one. The word `lease` appears
in `p05-smoke` and `p07-schema-invariants` only as column names and as comments about backups,
and `occurrences` in the mutation campaign only as a *source-text occurrence count* for a
campaign preflight check.

## The repair, and why it is not attempted here

`TRANSITION_OCCURRENCE_SQL` is prepared by four routes — `claim_occurrence`, `renew_lease`,
`settle_lease` and `release_occurrence`. Adding `attempt = ?14` and passing it from each is
mechanical, but "which of the four should advance the counter, and which must assert the
existing value" is a behavioural question about a shared statement, and answering it by
inspection is exactly how the V01-008 and V01-011 defects happened. It needs its own attack:
claim → lease expiry → second claim, asserting the attempt advances to 2, that
`max_start_attempts: 1` then **refuses** the second claim, and that renew/settle/release do not
each advance it themselves.

That attack is blocked today by the fact that a lease expiry path needs a real device and a
real occurrence, which now exist — so the next round can build it.

---

# Closure

## The fix

```sql
SET state = ?3,
    state_version = state_version + 1,
    attempt = COALESCE(?14, attempt),
    ...
```

with `?14` bound from a new `OccurrenceTransition.start_attempt: Option<i64>`: `Some(attempt)` from
`claim_occurrence`, and `None` from `renew_lease`, `start_occurrence`, `settle_occurrence`,
`release_occurrence` and the expiry sweep.

**The COALESCE is the whole design, and it was forced by a fact the finding had to establish
first.** The statement is prepared by six routes and only one of them starts an attempt.
`start_occurrence` in particular *reads* `lease.attempt`, so an unconditional `attempt = ?14`
would have spent **two** of a `max_start_attempts: 2` budget on one start — a defect introduced by
the repair of a defect. Making the distinction a property of the *call* rather than of the SET list
is what prevents that, and `None` means a route **physically cannot** advance the counter.

The compiler enumerated all six call sites, which is the check I wanted: a new transition route
cannot be added without stating its intent.

## The attack, re-run unchanged: 34/34, exit 0 (was 27/31)

| | before | after |
|---|---|---|
| first claim | `occurrence_attempt 0 → 0` | **`0 → 1`** |
| third claim after the lease expired | **`503`, `details: {}`** | **`409 automation_invalid_state`** |
| the sweep's resolution of the slot | `pending`, `reason_code = null` | **`failed`, `reason_code = lease_expired_retry_exhausted`** |
| `pnpm check` / unit tests | 1010 | green / **1013** |

## Two enforcement points came alive, not one

The finding recorded that the claim's guard was dead. It did not record that the **sweep** reads
the same column, and that was the larger consequence.

With `attempt` permanently `0`, the sweep's own exhaustion test was `0 + 1 <= max_start_attempts`
— always true. So an expired lease was resolved by **returning the slot to `pending`**, and the
next claim recomputed attempt 1, collided with the first claim's `(occurrence, 1, 'claimed')` row
on `ux_automation_occurrence_attempts`, and aborted the batch into a detail-less `503`.

That is the whole causal chain, and the repair closes it at the source rather than at either end:
a spent slot now becomes `failed` / `lease_expired_retry_exhausted`, and the device that retries
is told the slot is spent.

**The sweep's retry-exhaustion path had never executed in the product's life.** It is not new
code; it is existing code that a dead column had made unreachable, which is the same failure shape
as V01-011's batch and V01-008's PATCH.

## The regression proof, and why two of the three tests are structural

Three unit tests, on SQL and source text, no database, on every `cargo test`:

- `the_transition_only_advances_the_counter_when_asked_to` — the `COALESCE` is present;
- `exactly_one_route_starts_an_attempt_and_it_is_the_claim` — one `Some(..)`, and it is the claim;
- `every_non_starting_transition_declares_none` — all six literals state their intent.

The second and third read the route sources. That is deliberate: **a runtime assertion that a start
does not double-count cannot distinguish "the counter is COALESCE'd" from "the counter is assigned
but the routes happen to pass the current value"** — and that second case *is* this defect. Only
reading the call sites distinguishes them.

## Two of my own assertions were wrong, and the product was right

Both probes asserted *"a LEASED occurrence records when the work started"*. **It should not.**
`POST /api/v1/devices/automation-occurrences/{id}/start` is a separate registered route that mints
the run, session and link, so "has the lease" and "has begun work" are deliberately different
facts — and collapsing them would destroy the only signal that separates a lease taken and never
used from one that started and stalled, which is what the sweep and any stuck-work report depend on.

I would have "fixed" a correct two-phase design. Reading the route table caught it, and the
assertion is now a **control** that pins the intent, so nobody repeats the mistake.

The second: `verify:attempt-exhaustion` demanded the occurrence still be *claimable* after the
sweep. That would have **failed this correct repair and passed the defect** — with the dead column
the sweep believed an attempt remained and handed the slot back, which is exactly the wrong
outcome. The requirement is that the sweep *resolve* the slot, and with a bound of 1 it must resolve
it terminally naming exhaustion. Both of those were false before the repair, in opposite
directions, and only the second was visible.
