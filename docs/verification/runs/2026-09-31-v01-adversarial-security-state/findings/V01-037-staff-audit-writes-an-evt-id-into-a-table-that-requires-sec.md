# V01-037 — the sixteenth `evt_`/`sec_` site: `staff_audit` writes an outbox id into the audit table

- **Claim ID:** V01-037
- **Family:** Authentication / availability (found while attacking V01-034, after V01-035 and V01-036)
- **Severity:** **HIGH**
- **Status:** OPEN — recorded **before** repair
- **Verdict:** FAIL

## Claim

`staff_audit` in `apps/api/src/routes/internal.rs` builds its `security_events.event_id` with
`crate::adapters::new_event_id()`, which produces `evt_` + 32 hex. The column is CHECKed:

```sql
event_id TEXT PRIMARY KEY CHECK (
    length(event_id) = 36 AND substr(event_id, 1, 4) = 'sec_'
)
```

So the insert fails its CHECK, takes the whole D1 batch with it, and the caller is told the store is
unavailable. **Every `/api/v1/internal/**` write route answers `503`.**

## Setup

`apps/api/src/routes/support.rs` already contains the complete fix for this class, in a dedicated
type, with a comment that names the failure mode:

> | table | wants | length |
> |---|---|---|
> | `outbox_events` | `evt_` + 32 hex | 36 |
> | `security_events` | `sec_` + 32 hex | 36 |
>
> A `&str` parameter accepts both, and the failure surfaces as a D1 CHECK violation *inside a
> batch*, hundreds of lines from the call that caused it. **Fifteen call sites** passed
> `adapters::new_event_id()` — the `evt_` constructor — to `security_event_statement`, and every one
> took its whole transaction down.

The type is `SecurityEventId`, with `PREFIX = "sec_"`, `LENGTH = 36`, a `new()` that **asserts** the
namespace, and `generate()` for a fresh one. The comment states the intent exactly:

> Encoding the namespace in the type means the wrong id cannot be passed, and a caller who bypasses the
> type trips an assertion here that names the problem, rather than a constraint that does not.

`staff_audit` **bypasses the type**. It calls `adapters::new_event_id().as_str()` directly, so the
assertion never runs and the failure surfaces as the D1 constraint the type was introduced to
prevent. It is the **sixteenth** site of a class where fifteen were converted.

## Action

Read out of the Worker's own log. `commit_scoped_mutation` reports the failure through `report_error`
with SQLite's message, so the cause was available and unreachable at once — see "Regression gap".

```
lumi:report:commit_scoped_mutation: the commit batch failed and the outcome is unknown;
  Error: CHECK constraint failed: length(event_id) = 36 AND substr(event_id, 1, 4) = 'sec_'
```

Two-variable confirmation, run directly against a copy of the probe's own database, changing only the
id's prefix:

| `event_id` | result |
|---|---|
| `evt_` + 32 hex (what `new_event_id()` produces) | **REFUSED** |
| `sec_` + 32 hex (what `SecurityEventId::generate()` produces) | ACCEPTED |

## Actual

All four internal write routes answer `503`, and `security_events` receives **no** row — not a wrong
one and not a degraded one.

## Root cause

A partially applied fix. The type exists, the reasoning is documented, fifteen call sites were
converted, and one was not. Nothing enforces the conversion: `staff_audit` builds its statement
inline with a raw `prepare` rather than through `security_event_statement`, so the type has no
presence in that function at all and the compiler has nothing to check.

## A flaw in my own earlier reasoning, recorded because it is the more useful half

V01-035's record states that the batch "commits successfully in the database". **That was wrong, and
the way it was wrong matters more than the defect.**

To localise V01-035 I reproduced the batch by hand, in one transaction, against a copy of the probe's
own database — and the batch committed. But I **hand-wrote every id in that reproduction**: a
plausible `sec_` id, a plausible `request_id`, a plausible `key_digest`. The product writes an `evt_`
id. My reproduction was faithful in *shape* and wrong in *value*, so it agreed with a batch that
cannot commit.

> When reproducing a statement by hand to find a cause, every value must come from the product's own
> generator. A plausible value is a guess, and a guess that happens to be valid tests a statement the
> product never sends.

The same flaw appears one step earlier, in V01-035's own two-variable experiment. I held
`actor_type` as the only variable and varied it, which correctly established that `'staff'` is
refused — but I never asked whether the *rest* of the statement was valid. It was not. A
two-variable experiment proves the variable matters; it does not prove nothing else does.

This is why three repairs to one route produced no change, and why a fourth defect was sitting behind
the third. The campaign's own rule applies with full force: **an instrument that reports an absence it
did not measure is the recurring failure**, and here the instrument was my hand-written reproduction.

## Regression gap

- **The Worker log naming the cause was unreachable.** `commit_scoped_mutation` has reported the
  SQLite message through `report_error` since a previous round, but the harness printed the log only
  when a probe **bailed** — and a failing case is not a bail. So the sheet said "the route is broken"
  five times across four repairs while the actual cause sat in a log nobody printed. Fixed in
  `smoke-harness.mjs`: `finish` now reads the Worker's log before stopping services and prints the
  lines that name a cause whenever a case failed, including an explicit line saying so when there are
  none. **A verdict with no cause is the same failure as a verdict with no evidence.**
- No test asserts that the id passed to a `security_events` insert came from `SecurityEventId`. The
  type's `assert!` protects the sites that use it and cannot protect the one that does not, which is
  the general shape: **a type-level guarantee protects only its users, and "nobody uses the type here"
  is indistinguishable from "the type is unnecessary" without a check that counts its users.**
- The 4-assertion-per-route pattern that caught V01-033 found nothing here, because it never ran: the
  control failed first. A gate whose control fails reports one failure and hides every case behind
  it. This probe reports the blocked cases by name for that reason.

## Repair (recorded on closure, not now)

`staff_audit` builds its `event_id` with `SecurityEventId::generate()` — the generator that already
exists for exactly this column, in the module that already documents this exact class. No schema
change, no new type, and no new reasoning: the fix is to use the one the repository already wrote down
fifteen times.
