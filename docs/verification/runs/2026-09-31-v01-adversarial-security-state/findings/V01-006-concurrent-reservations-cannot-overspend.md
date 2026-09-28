# V01-006 — concurrent reservations cannot overspend a hard budget, and the ceiling's atomicity is measured rather than assumed

## Status

**closed** — the claim is proven, the probe is sensitivity-proven, and no product defect was found

## Severity

none found. The product was correct on every case.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-BUDGET-001` (new — `smoke:p05` covers hard-budget denial, reconciliation and attribution, but not the ceiling under concurrency) |
| **Setup** | real `wasm32` Worker, fresh local D1 with all 21 migrations, a real org, a real enrolled device (full ed25519 enrollment: begin, approve as owner, poll for the proof challenge, sign it), a real hard budget with `limit_minor = 100`, and 8 real `inference_requests` rows in state `not_dispatched`. |
| **Action** | **8 concurrent** `POST /api/v1/devices/{org}/budgets/{budget}/reservations` requests, each reserving **30**, issued in one `Promise.all` — asking for 240 against a limit of 100. Then a reconcile releasing one hold, and a retry of a request the burst had denied. |
| **Expected** | outstanding reservations never exceed 100; a denied request leaves no row; a released hold returns its capacity; a retry of the denied request succeeds. |
| **Actual** | **3 granted, 5 denied, 0 5xx. 3 reservations hold 90.** Release: 90 → 60. Retry of a denied request: `201`. Reservation against a nonexistent budget: `404 budget_not_found`. |
| **Evidence** | `evidence/v01-006-budget-concurrency.txt`, `evidence/v01-006-sensitivity.txt` |
| **Verdict** | **PASS** |
| **Regression gap** | none for the ceiling; the two claims B3 covers are recorded below |
| **Severity** | none |

## The claim, and why "it is one statement" is not the claim

The ceiling lives in a conditional INSERT — `INSERT_RESERVATION_IF_AVAILABLE_SQL` in
`apps/api/src/repositories/budgets.rs`:

```sql
INSERT INTO budget_reservations (...)
SELECT ?1, ?2, ... WHERE ?4 > 0
  AND ?5 > ?6
  AND EXISTS (SELECT 1 FROM inference_requests r WHERE r.request_id = ?2 AND r.org_id = ?3)
  AND ...
  AND NOT EXISTS (
      SELECT 1 FROM budgets b
      WHERE b.org_id = ?3 AND b.hard = 1
        AND b.period_start <= ?6 AND b.period_end > ?6
        AND (b.budget_id = ?8 OR b.scope_type = 'organization')
        AND b.limit_minor
            - COALESCE((SELECT SUM(...) FROM usage_events u WHERE ...), 0)
            - COALESCE((SELECT SUM(COALESCE(rv.reserved_minor,0) - COALESCE(rv.committed_minor,0))
                        FROM budget_reservations rv
                        WHERE rv.org_id = ?3 AND rv.status = 'reserved' AND rv.expires_at > ?6
                          AND (...)), 0)
            < ?4
  )
```

Putting the check in SQL is the only design that *can* be correct here, because a
read-then-write in Rust cannot be: eight concurrent requests would each read the same
`spent`, each conclude there was room, and each insert.

But "the check is in one statement" is a claim about the **code**. The claim under test is
about the **system**, and the difference is the whole point. D1 wraps a batch in a
transaction, and a deferred transaction lets two writers both read before either writes.
Whether this particular statement is serialised is a property of the runtime.

So the answer had to be measured, and the measurement is unambiguous: **3 grants, 90 held,
240 requested.** The conditional insert is atomic under D1.

## The instrument for "was it called?"

The objective requires that upstream dispatch be instrumentable. The repository already
contains the instrument, and it is a production-meaningful one rather than a test hook:

| row state | what it proves |
|---|---|
| a `budget_reservations` row with `status = 'reserved'` | the caller passed the budget check and was cleared to proceed |
| the same row with `status = 'released'` or `'expired'` | the caller held budget and the work then failed or timed out |
| **no** row at all | the caller never got past the gate — nothing was dispatched |
| a `usage_events` row with a `request_id` | the provider was actually reached and cost was recorded |

The probe uses the third form directly: `3 rows for 3 grants (denied: 5)` — the five denied
requests left no trace, so nothing about them reached a provider.

## The three verifier defects the sensitivity proof found, all of the same shape

`evidence/v01-006-sensitivity.sh` runs three mutations. **B1 and B2 are detected. B3 is an
expected MISSED.** Getting there took four harness defects, and each one is the same shape as
V01-002 and V01-003: **a verdict produced without evidence behind it.**

### 1. A failed mutation graded a run that never happened

The first harness used `set -uo pipefail`, which does **not** abort on a non-zero command.
All three Python mutations failed their asserts, every probe ran against the **unmutated**
product, and all three cases reported `MISSED`. The output was indistinguishable from a real
result.

The repair is `set -e` **plus** an explicit `mutation_applied` guard before every graded run,
which aborts if the product is byte-identical to the snapshot. A harness that reports MISSED
for a mutation it never applied is reporting on itself.

### 2. An overspend assertion that passed on zero reservations

B1's first form deleted the whole `NOT EXISTS (...)` block. That leaves a dangling `AND`,
SQLite rejects the statement, and **all eight requests answered 5xx** — nothing reserved,
nothing oversold. The probe's headline assertion reported:

```
PASS  concurrent reservations do not collectively exceed the hard limit
      — 8 concurrent requests asked for 240 against a limit of 100; 0 reservations hold 0
```

`0 ≤ 100`. The budget gate was bypassed completely and the gate reported clean, with a number
next to it that looks like a measurement. The probe now asserts, before the ceiling:

```
PASS  the burst granted at least one reservation, so the ceiling assertion below is
      measuring a budget and not an absence
```

A gate that passes because the budget was never consulted is worse than no gate, because the
figure beside it is trusted.

### 3. A mutation that broke the build instead of testing the claim

The same B1, second form, replaced the ceiling's limit with `-1` — reasoning that the clause
is `NOT EXISTS (… < ?4)`, so an always-true limit would make the `NOT EXISTS` always false.
**The polarity is the other way round**: all eight were *denied*. The mutation was a denial,
not an overspend.

The correct mutation makes the condition always **false**, so the limit becomes a number no
burst can approach. It is now:

```js
lines[target] = lines[target].replace("b.limit_minor", "999999999")
```

and the attack succeeds as an attack should:

```
FAIL  concurrent reservations do not collectively exceed the hard limit
      — OVERSOLD: 8 reservations hold 240 against a limit of 100
```

A mutation that breaks the build, or that produces the opposite of the defect, reports a
different finding than the one under test. That is `KILLED_FOR_THE_WRONG_REASON`, and this
repository has now hit it in three separate harnesses.

## B2 — the released capacity case

Removing `rv.status = 'reserved'` from the outstanding sum means a **released** reservation
keeps holding its amount. The release itself still succeeds, so an assertion naming the
release does not move — the symptom appears at the retry:

```
FAIL  a request denied during the burst can reserve the capacity freed by a failed one
      — status=403 reason=budget_exceeded
```

The grading needle had to change to match, because a needle that begins mid-sentence cannot
match a line anchored with `^  FAIL  `. A verifier that looks in the wrong place reports
MISSED for a detected defect, which is the same failure in the opposite direction.

## B3 — an honest MISSED, and the reason is the product being right

Removing the `EXISTS (inference_requests)` clause changed **nothing observable**, because
`create_reservation` resolves the request itself, first:

```rust
let inference = repository
    .find_inference_request_scope(&org_id, &request_id)
    .await
    .map_err(|_| budget_state_unavailable(&context))?
    .ok_or_else(|| not_found(&context, "resource_not_found"))?;
```

An uncorrelated request is refused with `404` before the statement is ever reached, so the
SQL clause is a **second line for the same rule**. B3 is therefore recorded as an expected
MISSED and does not gate the run.

A joint mutation removing both would break the probe's own fixture — every request it makes
has a real inference row — so it would measure the fixture rather than the claim. That is the
same structural fact as V01-003's M2 and V01-004's A1/A3: **a single-layer weakening of the
lower gate is not observable through HTTP, which is exactly why the lower gates need unit
tests.**

The uncorrelated attack is in the probe regardless, and it earns its place: it is what proves
the *route-level* refusal, and it would catch a future change that dropped the route's lookup
while leaving the SQL clause intact.

## What this probe does and does not prove

| claim | verdict | where |
|---|---|---|
| concurrent reservations cannot collectively exceed a hard limit | **PASS**, measured | this probe, sensitivity-proven by B1 |
| a denied reservation leaves no row, so nothing reached a provider | **PASS** | this probe |
| a failed dispatch releases its capacity and it is reusable | **PASS** | this probe, sensitivity-proven by B2 |
| a reservation against a budget that does not exist is refused, not treated as unlimited | **PASS** (`404 budget_not_found`) | this probe |
| a reservation must be correlated with a real inference request | **PASS** via the route; the SQL clause is a redundant second line | this probe; B3 is an expected MISSED |
| hard denial happens **before** upstream dispatch | **PASS** | `smoke:p05` |
| usage is attributed to the right org / project / principal / run | **PASS** | `smoke:p05` — it asserts `usage.org_id`, `usage.run_id`, `usage.project_id` against the values it seeded |

**What it does not prove:** that the reservation is correctly correlated with a *real*
inference. The `inference_requests` rows here are inserted directly, because the only way to
create one is `POST /inference/responses` and that needs p05's whole agent/binding/route
fixture chain. The claim under test is the ceiling arithmetic and its atomicity, and the
inference row is a precondition rather than the subject — so between this probe and p05 the
claim is covered, and neither covers both alone. That is stated rather than blurred.
