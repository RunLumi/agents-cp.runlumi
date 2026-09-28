# V01-013 — the attempt counter that bounds automation retries is written by nothing

## Status

**open.** Found by the lease-contention probe on its first successful run. Root cause located
and confirmed; the repair is **not** applied, and it is not attempted here, because
`TRANSITION_OCCURRENCE_SQL` is shared by four routes and needs its own attack.

## Severity

**high.** `max_start_attempts` is the bound on how many times an automation occurrence may be
started, and it is **unenforceable**. Nothing can be retried forever through this path, because
the number the check reads never changes.

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
