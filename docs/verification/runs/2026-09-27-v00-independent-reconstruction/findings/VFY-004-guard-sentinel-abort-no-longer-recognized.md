# Finding VFY-004 — Migration 0020 broke every deliberate guard abort, so guarded writes now return an opaque 503

## Status

open

## Severity

high

## Affected claim

- Claim ID: `VI-BUD-001` (adjacent path), `VI-IDEM-001`, `AUTOMATION-LEASE-1`
- Source requirement: `docs/contracts/p06-automation-lease-v1.md` ("A device MUST atomically
  claim work"); `docs/specs/f12-usage-metering-quotas-budgets-cost-controls.md` FR-F12-005;
  `docs/specs/f15-automations-scheduled-offpeak-tasks.md` FR-F15-004/005;
  `docs/specs/f23-api-contracts-versioning-pagination-idempotency.md` error model
- Risk tier: 1 (contract and money; durable-state transitions misreported)

## Statement

**36 statements across 13 repository modules** are *deliberate guard sentinels*: an insert
into `idempotency_records` of the exact shape
`SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL`, which violates a
constraint so a D1 batch aborts when a conditional write matched zero rows. Count with:

```bash
grep -rc "SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL" \
  apps/api/src --include='*.rs' | awk -F: '{s+=$2} END {print s}'   # 36
```
`is_guard_violation` recognises that abort by a case-sensitive substring match on the SQLite
error text. Migration `0020_p09_idempotency_null_safety.sql` added a `BEFORE INSERT` trigger
that fires *before* the column constraint and aborts with a custom `RAISE(ABORT, …)` message,
so the substring no longer matches, every guard is now classified as "store unavailable", and
the callers return a bare HTTP 503 instead of the documented conflict/replay result.

## Reproducer

### Preconditions

```bash
pnpm db:migrate:local          # migrations 0001..0020 into local D1
cd apps/api
DB="$(find .wrangler -name '*.sqlite' -path '*D1DatabaseObject*' ! -name metadata.sqlite | head -1)"
```

### Action — the error text before and after 0020, for the identical statement

```bash
# AFTER 0020 (the real local D1)
./node_modules/.bin/wrangler d1 execute DB --local --env development --command "
  INSERT INTO idempotency_records (principal_id, organization_id, method, path,
    key_digest, request_fingerprint, state, response_status, response_body,
    expires_at, claim_token)
  SELECT NULL,'','','','','','pending',NULL,NULL,'',NULL
  WHERE NOT EXISTS (SELECT 1 FROM budget_reservations WHERE reservation_id='nope');"
```

```text
ERROR  a pending idempotency record carries no result and must hold a claim token:
       SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)
```

```bash
# BEFORE 0020 (a throwaway database built from 0001..0019 only)
for f in apps/api/migrations/00*.sql; do
  case "$(basename $f)" in 0020_*) continue;; esac
  sqlite3 /tmp/pre0020.sqlite < "$f"
done
sqlite3 /tmp/pre0020.sqlite "<the same INSERT>"
```

```text
Error in 2nd command line argument:
  NOT NULL constraint failed: idempotency_records.principal_id
```

The matcher, unchanged across both:

```rust
// apps/api/src/repositories/automations.rs:986  and  apps/api/src/routes/usage.rs:252
pub fn is_guard_violation(error: &worker::Error) -> bool {
    let detail = format!("{error:?}");
    detail.contains("NOT NULL") || detail.contains("constraint")
}
```

`"NOT NULL"` matches the 0001–0019 text and is gone from the 0020 text. `"constraint"` is
lowercase; the 0020 text contains `SQLITE_CONSTRAINT` and a message with no lowercase
occurrence, so it does not match either.

### End-to-end, through the real Worker

`node apps/api/scripts/p05-smoke.mjs` (175 checks, 1 failure):

```text
FAIL  internal reservation endpoint replays the managed hold
      — status=503 reason=none
```

The 503 carries no `details.reason`, which identifies the source precisely: the only
reason-free 503 on this path is `service_unavailable(context)` in
`apps/api/src/routes/usage.rs:266`, reachable from
`commit_scoped_mutation`'s `Err(_)` arm after the guard is *not* recognised, when the
`idempotency_records` lookup returns `Missing` because the batch rolled back.

The same request on the documented path should return 200 (idempotent replay) or 409 with
`reservation_already_reconciled` / `reservation_conflict`.

## Call sites affected

```text
 6  repositories/ai.rs              1  repositories/billing.rs          1  repositories/plugins.rs
 1  repositories/automations.rs     6  repositories/budgets.rs         4  repositories/runs.rs
 1  repositories/data_governance.rs 2  repositories/machine_identity.rs 2 repositories/usage.rs
 2  repositories/migration.rs       2  repositories/platform_ops.rs    2  repositories/webhooks.rs
 6  repositories/tools.rs
```

Detectors: `repositories::is_guard_violation` (used by `consumers/automations.rs:329`,
`jobs/automations.rs:853,1481`, `routes/automations.rs:2565,2737`) and the private copy in
`routes/usage.rs:252` (used by `commit_scoped_mutation`, therefore by every
`prepare_scoped_mutation` caller: budgets, tools, billing, plugins, data governance).

## Why it matters

- **Stable error codes are lost.** A duplicate budget reservation that must answer
  `reservation_already_reconciled` answers 503 `"The usage store is unavailable."` with no
  reason detail, violating F23's error model and F12's reservation semantics.
- **Automation guards become retries.** In `consumers/automations.rs` a `Guarded` store
  outcome is treated as a benign duplicate, while the `Unavailable` outcome is a retryable
  job failure. After 0020 a legitimately-refused occurrence is retried up to
  `max_retries = 8` and then dead-lettered, instead of settling. That is F21-009 behaviour
  change and it burns queue budget on work that was correctly refused.
- **The failure is silent and structural.** Nothing in `pnpm check` exercises a guard abort at
  runtime. The mutation campaign's `VI-IDEM-001` case mutates migration 0020's trigger and
  proves the *storage* probe notices, which is the one thing that does not detect this
  regression.

## Root cause

`is_guard_violation` couples a security-relevant control-flow decision to SQLite's error
*text*, and migration 0020 changed that text for the same statement. A trigger added for
NULL-safety was not recognised as an equivalent abort.

## Repair constraints

- do not weaken: the sentinels must still abort their batch; the idempotency NULL-safety
  triggers must stay.
- do not "fix" this by loosening the matcher to accept any error: that would turn a genuine
  constraint violation into a benign guard. The two must stay distinguishable.
- related invariants: `VI-IDEM-001`, `VI-BUD-001`, P06 lease semantics.

## Candidate repair

Prefer removing the coupling over widening the substring:

1. Give the sentinel a signature the detector can name rather than pattern-match — for
   example a dedicated marker value, or a distinct `RAISE(ABORT, 'lumi_guard_abort: …')`
   message asserted by one shared constant used by every sentinel and by
   `is_guard_violation`.
2. Interim, if (1) is too invasive for one change: match the SQLite constraint *code*
   (`SQLITE_CONSTRAINT` / `SQLITE_CONSTRAINT_TRIGGER`) case-insensitively, which restores
   the pre-0020 behaviour exactly, plus a unit test that both text shapes are recognised and
   an unrelated error is not.

Either way the regression proof must cross D1, because the defect only exists in the text a
real database produces.

## Regression requirement

- a probe that applies 0001..head, executes one real guard sentinel through D1, and asserts
  `is_guard_violation` recognises the resulting error;
- a mutation case that adds a second `BEFORE INSERT` trigger with a new `RAISE` message and
  requires that probe to fail — so the coupling cannot be reintroduced silently;
- `node apps/api/scripts/p05-smoke.mjs` must reach 0 failures.

## Closure evidence

- fix commit: _pending_
- original reproducer: `p05-smoke.mjs` failure "internal reservation endpoint replays the
  managed hold"
- focused regression: _pending_
- affected proofs: `VI-BUD-001`, `VI-IDEM-001`, automation lease claims
- mutation/fault check: _pending_
- broader gate: `pnpm check`, `pnpm smoke:p05`

---

# Closure — 2026-09-27, after the repair loop

**Status: CLOSED.** `GUARD-1` FAIL → PASS. `VI-IDEM-001` runtime half FAIL → PASS.
Full evidence: [`repair-closure.md`](../repair-closure.md).

## The named list, and why it is only two entries

`core::idempotency::GUARD_ABORT_TEXTS` holds exactly two entries, and that number is **measured,
not assumed**. `apps/api/scripts/p02-guard-probe.mjs` applies the real migrations to a real SQLite
database and runs the real sentinel:

1. `NOT NULL constraint failed: idempotency_records.principal_id` — schema 0019 and earlier.
   Named down to the **column**, not the table. A test I wrote first asserted that a `NOT NULL`
   failure on a *different* column of the same table is not a guard; **it failed**, and the correct
   response was to narrow the entry rather than to relax the test. Naming the table would classify
   a code bug as a deliberate refusal and hand the caller a business answer for a fault.
2. `a pending idempotency record carries no result and must hold a claim token` — schema 0020
   onward, because the `BEFORE INSERT` triggers fire before the column constraints.

**Three of my first draft's entries were dead.** The `CHECK constraint failed: …` texts on this
table are unreachable — `principal_id TEXT NOT NULL` is a *column* constraint and SQLite evaluates
column constraints before table-level `CHECK`s — and
`trg_idempotency_completed_requires_status` cannot fire because all 37 sentinels set
`state = 'pending'`. They were removed. Dead entries are a liability: a future reader cannot tell a
measured entry from a guessed one, and a guessed one invites "fixing" the recogniser by matching
more.

## The duplicate is the real lesson

There were **two** copies of `is_guard_violation`. `repositories/automations.rs` now delegates to
the single definition in `core::idempotency`, and the private copy in `routes/usage.rs` is deleted.
Two copies cost exactly one migration's worth of drift.

The over-broad half is also fixed: `contains("constraint")` accepted a UNIQUE or FOREIGN KEY
violation on **any** table, so an unrelated integrity failure could be answered with business copy.

## New gate — 11/11, and sensitive to all five mutations

`apps/api/scripts/p02-guard-probe.mjs`, wired into `pnpm test`. It proves the real sentinel
aborts and rolls back, that its text is recognised on both schema versions, that the sentinel shape
in the probe is the shape the repositories emit (counted, not eyeballed), and that UNIQUE,
FOREIGN KEY, missing-table, and wrong-column failures are **not** guards.

`evidence/vfy004-guard-sensitivity.sh` reverts each repair in turn:

| Mutation | Probe |
|---|---|
| the `0020` trigger text removed (exactly the VFY-004 defect) | 8/11, 3 FAIL |
| the pre-`0020` text removed | 9/11, 2 FAIL |
| the old over-broad `["constraint"]` matcher, verbatim | 7/11, 8 FAIL |
| the list emptied | 7/11, 8 FAIL |
| the `0020` column entry widened back to the whole table | 10/11, 1 FAIL |
| restored | 11/11 |

## Runtime effect

`p05-smoke.mjs` went from **175 pass / 1 fail** (`status=503 reason=none`) to **185 pass / 0 fail**,
exit 0. The nine extra checks are ones the failure had been short-circuiting.
