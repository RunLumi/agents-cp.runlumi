# V01-042 — nothing ever purges `idempotency_records`, and they retain response bodies indefinitely

- **Claim ID:** V01-042
- **Family:** Durable state / data retention
- **Severity:** **MEDIUM** (unbounded growth and indefinite retention of response bodies; no
  confidentiality or availability failure *today*)
- **Status:** CLOSED — recorded before repair, updated with root cause, fix, and proof
- **Verdict:** FAIL → **PASS** (the sweep purges; the class is now a standing check)

## Claim

`idempotency_records` grows without bound. Every idempotent mutation writes a row carrying the
**response body**, `expires_at` is set, and **nothing ever deletes an expired row** unless the same
`Idempotency-Key` is presented again.

The purge exists — SQL, a validated repository method, and a dedicated index built for it. It has no
caller, and the scheduled sweep that would call it runs **every minute** and does not.

## Setup

The purge is fully built:

```rust
const PURGE_EXPIRED_SQL: &str = r#"
DELETE FROM idempotency_records
WHERE rowid IN (
  SELECT rowid FROM idempotency_records
  WHERE expires_at <= ?1
  ORDER BY expires_at ASC
  ...
"#;

pub fn purge_expired_statement(&self, now: &Timestamp, limit: usize) -> ... {
    validate_storage_timestamp(now)?;
    if !(1..=500).contains(&limit) { return Err(invalid_input()); }
    ...
}
```

Batched, oldest-first, bounded, with a validated limit. `migration 0001` creates
`idx_idempotency_records_expires_at ON idempotency_records (expires_at)` — a single-column index on
`expires_at`, whose only sensible use is finding expired rows.

**And `purge_expired_statement` has zero non-test callers.**

The only two `DELETE FROM idempotency_records` statements in the tree are:

| constant | what it does | is it a purge? |
|---|---|---|
| `RELEASE_CLAIM_SQL` | deletes a **pending** claim, scoped to one `(principal, org, method, path, key_digest)`, when a commit fails | no — key-scoped, and only for `pending` |
| `PURGE_EXPIRED_SQL` | batched, oldest-first, bounded | yes — and uncalled |

So the only reclamation path that fires is a **key collision**: `CLAIM_SQL`'s
`ON CONFLICT ... DO UPDATE ... WHERE idempotency_records.expires_at <= ?9` overwrites an expired row
*for that key*. A key never reused keeps its row — and its `response_body` — forever.

## Why this is a repair and not a feature

The Worker already has `#[event(scheduled)]` → `run_scheduled_sweep`, and `wrangler.jsonc` configures
`"crons": ["*/1 * * * *"]`. The sweep runs every minute. It currently does two things:

1. `jobs::run_retry_sweep(...)` — the P01 outbox retry sweep;
2. `dispatch_due_data_jobs(...)` — the P06 job-queue producer.

The purge is the third thing it should be doing. No new infrastructure, no new trigger, no new schedule
decision — the composition is simply missing, and the pieces are individually correct.

## The finding that is really about the class

`dispatch_due_data_jobs`'s own doc comment describes **this exact defect**, already found and fixed, in
the same function:

> This function is the producer half of the P06 job queue, **and it did not exist**. `JOBS_QUEUE` was
> declared as a producer binding, had a consumer attached, and a handler that routes on
> `batch.queue()` — but no code anywhere obtained the binding, so nothing was ever sent.

> **A binding declared, a consumer attached, a handler present, and no code that obtains it.**

That was fixed for P06. **The class was never swept for.** The same shape is present twice more in
this round — V01-040's `find_grants_for_staff_and_org` ("the grant read every customer-context request
uses", with a unit test over its SQL and no caller) and V01-041's `deny_enrollment` (schema state,
correct statement, repository method, registered sibling route, no caller).

So the generalisation is not "watch for uncalled functions". It is:

> **Fixing one instance of "built but never wired" does not close the class. The repair for this class
> is a check that asks the question, not a fix.**

Which is what the liveness scan is, and why it is worth building rather than running once.

## Impact

- **Unbounded growth.** One row per distinct `(principal_id, organization_id, method, path,
  key_digest)`, retained forever. On a real deployment that is every distinct idempotency key ever
  used, on every route.
- **Indefinite retention of response bodies.** `response_body` holds the response of every idempotent
  mutation — organization and project names, resource identifiers, and whatever else a mutation echoes.
  `verify:adoption-privacy` asserts that certain *content classes* never reach certain tables; this is
  the opposite situation, a table that legitimately holds response bodies with **no upper bound on how
  long**. AGENTS.md names data retention as a cross-feature invariant.
- **Cost.** D1 row counts and storage grow without limit, and every `ON CONFLICT` lookup on the claim
  path works against a table that only gets bigger.

## What could NOT be measured at runtime, and why

A short probe run cannot observe an expired row: the TTL is longer than a probe's lifetime, so
`SELECT count(*) FROM idempotency_records WHERE expires_at < now` is legitimately `0` immediately after
a run. Measured on two real probe databases: 10 rows / 0 expired, and 3 rows / 0 expired.

That is recorded rather than papered over, because it is the reason the claim is stated
**structurally** — the absence of a caller, the two `DELETE`s, and the unused index — rather than as an
observed row count. A demonstration built on expiring rows artificially would prove only that SQLite
can be made to hold an old row, which was never in doubt.

## Regression gap

- No test asserts that `run_scheduled_sweep` purges. The sweep's two existing halves are both
  reachable; this one is not called at all, and nothing in the suite would notice its absence.
- `purge_expired_statement`'s own validation (the `1..=500` bound, `validate_storage_timestamp`) is
  correct and therefore gives the *appearance* of a tested, finished capability.
- `idx_idempotency_records_expires_at` is a real cost with no query using it, and nothing checks for
  that.

## Fix

`apps/api/src/lib.rs`. `run_scheduled_sweep` now does three things instead of two:

```rust
if let Err(error) = purge_expired_idempotency_records(&database, now.as_str()).await {
    console_error!("lumi:report:the idempotency purge failed and expired records were retained; \
                    error={error}");
}
```

**Bounded** at `IDEMPOTENCY_PURGE_BATCH = 200` per tick, inside the method's own validated `1..=500`.
Chosen at the low end deliberately: the sweep runs every minute, so its job is to *keep up* rather than
to catch up in one pass, and a burst delete on the table that also serves the claim path is the wrong
trade for a housekeeping step.

**Non-fatal, and that is the load-bearing property.** `dispatch_due_data_jobs` states the sweep's own
rule — one row that cannot be processed must not strand every job behind it — and it applies more
sharply here: a purge that returned its error would take the **outbox retry sweep** and the **P06 job
dispatch** down with it, turning a housekeeping step into an availability incident. The error is logged
with the same `lumi:report:` prefix the rest of the file uses.

The repository gained `purge_expired_statement` as a **prepared-statement** builder only in V01-041's
sibling work; the purge here already had one, and `deny_enrollment` was the case that needed the
`*_statement` shape added. Both now follow it.

## Regression proof

`security::repository_liveness` — the new standing check this finding produced, which is the class
close rather than a one-off assertion about the purge.

`pnpm check` exit 0, **1030 tests** (up from 1029), the whole suite in **0.99s** — the check adds
**0.24s**.

**Sensitivity:** `evidence/v01-liveness-sensitivity.txt`, **M1 and M2 both DETECTED**, exit 0.

- **M1** adds an uncalled `pub fn` to a repository file. The check names it.
- **M2** removes a genuinely-dead name from the reviewed list. The check reports it — which is what
  makes the list a record of decisions rather than a permission slip. Attacking only M1 would prove the
  scan works and say nothing about whether the list can be widened silently.

**M1 took three attempts, and the failures are the useful part.** Two earlier versions removed a
function's *sole caller*, and both broke the build — the harness reported `compile-error` and then
correctly **refused to count either as a verdict**.

> In a statically linked language, removing the only call to a function almost always fails to compile,
> so such a mutation measures the compiler rather than the check.

And removing a caller is the wrong failure to reproduce: all three findings in this class were
capabilities **added and never wired**, not callers that disappeared. M1 now reproduces the historical
shape, which is also guaranteed to compile — the 53 uncalled functions already in the tree compile clean
under `-D warnings`, because a `pub` item is public API and `dead_code` does not fire.

A third attempt failed for a subtler reason: the mutation counted four call sites where the scan counted
one, because three are inside a `#[cfg(test)]` module. **The mutation has to agree with the rule it is
proving** — the check strips tests, so a mutation that counts them is testing a different question.

## The 53, and what the check does with them

The check does not merely assert that the list is empty. Every uncalled function must be **on the list
with a reason**, so the 53 become 53 recorded decisions rather than an unexamined scan output nobody
read — and two of the three findings in this class were sitting in exactly that output.

Each entry is one of:

- **resolved** — `deny_enrollment` (V01-041) and `purge_expired_statement` (V01-042), now called. Kept in
  the list so the decision stays visible rather than vanishing when the function gains a caller.
- **deliberately out of band** — `insert_staff_statement`, `find_staff`, `list_staff`. `core::staff`
  states the raw value is "shown once to the operator who provisioned the principal", so staff
  provisioning is an operator action; `verify:staff-credential` provisions one by inserting the row for
  the same reason.
- **a known gap** — `find_grants_for_staff_and_org` (V01-040).
- **examined** — a handful with a real reason, including `touch_credential_statement`, which duplicates
  `mark_credential_used_statement` (which **is** called from `routes/inference.rs`) with the same
  `UPDATE credentials SET last_used_at`. Two ways to write one column is the hazard, not the convenience.
- **`UNTRIAGED`** — the remainder, **labelled as untriaged rather than given an invented
  justification.** Before this check the same information existed as an unexamined list of 53; saying
  "53, of which 48 are untriaged" is a to-do list, and a list that is absent is a false assurance.

**Two entries the check found that the scan that motivated it had missed:** `budget` and
`list_attempts`, whose only non-declaration occurrences are inside a comment or a string literal. That
is the third parser fault in the check's header, and it runs the **opposite** way to the first: the
stricter instrument found *more* dead code, because the looseness was in the weaker one.

## Performance, because a check nobody can afford to run does not ship

The first version re-read and re-processed every file for each of 569 functions: **102 seconds**, in a
suite that otherwise finished in under a second. The second, which scanned the cached corpus per
function, was **25 seconds**. The third collects every called identifier in **one tokenised pass** and
tests membership: **0.24s**.

That is not an optimisation; it is the difference between a standing check that ships and one that gets
deleted for being slow, in a repository with explicit performance budgets.

## The limit, stated rather than implied

It is a **liveness** check. It proves a function is *called*, not that it is called correctly, for the
right reason, or on the right path — a function called once from dead code passes. It reads source text,
so a `macro_rules!` expansion or a build script that generates a call would be invisible. And it counts
by name, so two same-named functions on different types are indistinguishable; no such collision exists
today, and one would show up as a **false pass**, which is the dangerous direction.

It would not have caught any of the three findings on its own either — it caught V01-041 by being run
once by hand. What it does is make the *next* one impossible to add without a decision.

## Re-run after the fix

`pnpm check` exit 0, 1030 tests. `verify:revoked-device` 36/36, `verify:idempotency` 47/47,
`verify:staff-credential` 46/46, `verify:path-id-tenancy` 199/199.
