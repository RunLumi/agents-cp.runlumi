# V01-007 — the migration ledger had only ever been applied to an empty database

## Status

**closed** — two representative prior states now have runtime evidence, and the probe is
sensitivity-proven

## Severity

none found. Every migration did the right thing over populated tables.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-DATA-002` (new) |
| **Setup** | a real local D1 built by applying the **real ledger files in order** with wrangler — the same statement stream `wrangler d1 migrations apply` sends — stopped part-way, then written to with rows a real deployment would hold at that point. |
| **Action** | **Prior state A**: stop after `0015_p06_baseline_seed` (which seeds rows *by design*), write a user and an organization, then apply 0016–0021. **Prior state B**: stop after 0019, write a stored idempotency claim, then apply 0020–0021. |
| **Expected** | every row written before the remaining migrations ran survives them, and the constraints the later migrations introduce are enforced over the rows that are there. |
| **Actual** | 1 plan and 19 entitlements, one user, one organization: all survive 0016–0021. One stored idempotency claim: survives 0020's null-safety rewrite, and 0020's trigger refuses a `completed` claim with a non-2xx status. `p08-invariants` still reports **17/17** on the populated path. |
| **Evidence** | `evidence/v01-007-migration-prior-state.txt`, `evidence/v01-007-sensitivity.txt` |
| **Verdict** | **PASS** |
| **Regression gap** | none; the sensitivity proof detects both mutations |
| **Severity** | none |

## Why this was worth doing

Every existing migration gate starts from zero rows: `p08-invariants.sh` (17/17),
`schema:p07` (125/125), `verify:restore` (exit 0). All three pass, and **none of them can
see the class of defect this probe is about**, because a migration that only works on empty
tables is indistinguishable from a correct one when the table is empty.

This repository has already paid for that gap. `teams.team_id` was declared
`length = 36` while `generated_id("team")` produces 37 characters, so the table was
**unwritable** — `POST /teams` answered 409, team membership could never be written, and
project access granted through a team silently never applied. Every gate was green. It was
found by inspection in #39, not by a probe. This probe is the gate that would have found it.

## What a representative prior state actually is here — and the fiction I first built

The first version cut the ledger at 0007 and tried to write a `teams` row. **That is not
constructible**, and the reason is written in migration 0021's own header:

> Both tables are empty, and **provably so**: the check being corrected is what makes the
> insert impossible.

So no prior state anywhere in history can hold a `teams` row, and a probe that pretends
otherwise is testing a fiction. The probe now says so and checks the premise instead:

```
ok  a 36-character team id is refused, which is why no prior state can hold a team row
```

That is worth recording on its own: it means 0021's "the copies below are still written in
full so the migration is correct for any database that somehow holds rows" is **defensive
code that cannot be exercised by any real prior state.** The migration is right to write it;
a reader should know it is unreachable.

The real prior states are the ones the ledger produces:

- **A — after `0015_p06_baseline_seed`.** That migration exists to seed `plans` and
  `entitlement_definitions`, so **every database past it is non-empty by design**, and
  0016–0021 have to cope with that. This is the representative state, and it is not
  hypothetical.
- **B — after 0019, with stored idempotency claims**, so 0020's rewrite of
  `idempotency_records` runs against rows rather than an empty table.

## The trigger 0020 exists for, proven

0020's header explains the design precisely:

> a completed idempotency record must carry a status, and a CHECK cannot say so … the
> `OR` becomes `0 OR NULL` = NULL, and a SQLite CHECK constraint … The CHECK stays as the
> fast path and the documented intent; the trigger closes the one clause the CHECK cannot
> express.

So there are two layers and the claim is about the second. The probe asserts it, with the row
otherwise valid so nothing else can be what refuses it:

```
ok  a completed idempotency claim with a non-2xx response_status is refused, and by the
    trigger rather than the CHECK -- the row is otherwise valid
```

Getting that case to mean what it says took two corrections that are worth recording. The
first version omitted `response_status` and the **CHECK** refused the row, so the case passed
while testing the wrong constraint. The second omitted `response_body`, and the CHECK
refused it again for the same reason. Only with the row valid apart from the status is the
trigger the only thing that can refuse it.

That is a small instance of the campaign's recurring shape: **a case that passes for the
wrong reason is indistinguishable from a case that passes.**

## Rerunnable probes confirm the same meaning

The objective asks that rerunnable probes be re-run and confirmed to mean the same thing.
`p08-invariants.sh` is the structural gate, and it is re-run here against a database that
came up through **prior state A's path** — 0015 → populated → 0021 — rather than from empty:

```
ok  p08-invariants holds on a database that migrated through a populated state
    (passed: 17  failed: 0)
```

Same 17, same 0. The meaning is unchanged, and now it is also the meaning *on that path*.

## Sensitivity — both cases detected, on the first run

```
baseline: passed: 19  failed: 0
M1 applied: 0018 now deletes the seeded plans
M2 applied: 0020 now deletes the stored idempotency claims

M1 a migration drops the seeded plans:   detected
M2 0020 drops the stored claims:         detected

FAIL  the seeded plans survive 0016-0021
FAIL  the stored idempotency claim survives the 0020 null-safety rewrite
```

Both are the smallest possible expression of the defect — a migration that reaches its
conclusion without preserving the data — and neither needs the probe to be clever. The point
is that the probe is **watching the rows**, not counting tables, which is the only way a
"the migration applied successfully" gate can notice anything.

This harness was written with `set -e` and an explicit `mutation_applied` guard **from the
start**, and it worked first time. That is worth noting against the three consecutive
verifiers in this campaign that reported verdicts for runs that never happened: the
difference is not care, it is `set -e` plus a check that the file actually changed.

## Three fixture defects the probe produced, all the same shape

Every one was a column or table name I had inferred rather than read, and each surfaced as a
*silent* failure — the write reported success and the table stayed empty.

1. **`must_insert` captured stdout only.** Wrangler prints its confirmation banner on stdout
   and a `CHECK` failure on **stderr**, so every failing insert was reported as a success.
   Three assertions then failed with "found 0" and no reason at all.
2. **`teams.external_team_id` does not exist.** I invented it — the column lives on
   `workspace_adoption_states` as `external_workspace_key` — and I called the team's name
   column `name` when it is `display_name`. The real shape is
   `teams(team_id, org_id, display_name, slug, created_by_user_id, version, created_at, updated_at)`.
3. **The error detail grepped for `"text"`**, which only appears in a JSON error envelope. A
   trigger refusal is a plain `ERROR` line, so three failures carried an **empty** reason.
   Capturing `2>&1` and stripping the ANSI codes is what made the real message visible:
   `CHECK constraint failed: (state = 'pending' …)`.

The fix in all three is the same: make the harness say what the database said. A probe whose
failures are unreadable is a probe whose failures get skipped.

## Coverage this does not provide

- **Only two cut points.** 0007 and 0019 were tried; 0007 turned out to be unconstructible for
  the table it was meant to populate, and 0015 is the one the ledger's own seeding makes
  representative. A deployment that skipped 0015, or applied migrations out of order, is not
  covered.
- **No assertion about the *content* of a backfill.** If a migration rewrites a column's
  *meaning* rather than preserving it, this probe sees the row survive and says nothing
  about its value. Each backfill needs its own expectation, and inventing them here would
  assert a requirement nobody wrote.
- **Foreign keys are not exercised.** The migrations are applied with whatever PRAGMA state
  wrangler's D1 has; a migration that depends on `PRAGMA foreign_keys=ON` would not be
  distinguished from one that does not.
