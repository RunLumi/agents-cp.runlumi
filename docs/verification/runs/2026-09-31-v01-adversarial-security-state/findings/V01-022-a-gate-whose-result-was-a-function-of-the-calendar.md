# V01-022 — a gate whose result was a function of the calendar

## Status

**found, repaired, and re-proven.** `pnpm verify:budget-concurrency` is 28/28, exit 0.

## Severity

**high as a verifier defect.** Not because the product was wrong — the product was fine — but because
the board was reporting a measurement of something other than the claim, and it did so
**silently**, in both directions: the assertion that failed did not fail because the product changed.

## What happened

`pnpm verify:budget-concurrency` reported **23/25** today, with its headline case reading:

```
8 concurrent reservations of 30 against a limit of 100: 0 granted, 8 denied, 0 5xx
final: 0 reservations holding 0 against a limit of 100
```

Nothing was granted, so the two failures were the controls that exist precisely to catch that:

> *"the burst granted at least one reservation, so the ceiling assertion below is measuring a budget
> and not an absence"* — **nothing was granted**

The cause was a literal in the probe:

```js
const expiry = "2026-09-29T00:00:00.000Z";   // the reservation expiry
const now    = "2026-09-28T00:00:00.000Z";   // the inference fixture's row timestamp
```

and the run happened at **00:36 UTC on 2026-09-29**. The expiry was 36 minutes in the past, so
**every** reservation was refused with `expires_at_invalid`, nothing was ever held, and the ceiling
assertion was grading an **absence**.

The same gate reported **27/27 at 23:59 UTC the day before**, with no change to any code.

## Why this is the same failure as `verify:adoption-privacy`

That probe reported **"0 hits" with a private key sitting in the table**, because one NULL column
made the whole scan string empty. The shape is identical:

> a search that cannot find what it is looking for reports clean, and the clean is indistinguishable
> from a pass.

Here the search string was a **date**. Every reservation was refused, nothing was held, and the
ceiling assertion — *"concurrent reservations do not collectively exceed the hard limit"* — passed
vacuously, because zero reservations trivially do not exceed any limit. **The gate that exists to
prove the ceiling cannot overspend was green because nothing happened.**

The controls did their job, which is the only reason this was caught: a probe that asserts "at least
one was granted" is what turned a silently-vacuous pass into a visible failure. That control was
written for the right reason a long time ago and nobody had to add anything to catch this.

## The part that is worse than the failure: the denominator moved too

The repair took the total from **25 assertions to 28**, and **exactly one** of those was the new
control. **No skip was reported.**

So at least two assertions lived inside a branch the expired fixture never entered — they were
written, they were correct, and they **did not run**, and the reported total did not include them.

**The gate's denominator was itself a function of the defect.** A gate that reports `23/25` while
running 23 of its own 27 applicable assertions is not reporting a smaller number, it is reporting a
*different* number, and nothing in the output says so.

## The repair, and the control that makes the next one loud

Both literals are now relative to the clock:

```js
const now    = new Date(Date.now() - 60_000).toISOString();
const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
```

and there is a control that fails **the day before** this breaks again:

> **CONTROL: the reservation expiry is in the FUTURE, or every reservation is refused and the ceiling
> below grades an absence** — `expiry=…, now=…` — *a literal timestamp here makes this gate's result a
> function of the calendar rather than of the product.*

That is the durable part. The original defect was a literal; the fix is a control that notices the
class.

## The sweep, because the same hazard is elsewhere

Every hard-coded timestamp in the probe set, checked against the clock:

| probe | hard-coded | verdict |
|---|---|---|
| `v01-budget-concurrency` | `2026-09-29`, `2026-09-28` | **EXPIRED — this finding** |
| `v01-budget-concurrency`, `v01-filter-tenancy`, `v01-inference-failure`, `v01-mutating-tenancy` | budget period `2026-01-01` → `2027-01-01` | expires **2027-01-01** |
| `v01-lease-contention` | `2026-12-01`, `2027-01-01` | fine |
| `v01-privilege-escalation` | `2026-12-31` | fine |
| `p07-schema-invariants` | `2026-09-26` → `2026-10-26` | fine |

So one gate had already broken, and **the budget period shared by four probes expires on 2027-01-01**
— a second instance of the same shape, dated, and currently harmless. That is worth writing down now
rather than discovering in January.

## The generalisation

**A verifier must not let the wall clock into its fixtures.** A date written as a literal is a
hidden dependency on when the suite runs, and it fails in the worst direction: not loudly, and not
in the code. The general form is the adoption probe's: anything a gate uses to decide "did this
happen" must be checked for being *present*, not merely well-formed — and a fixture that makes
nothing happen is the case where that check is worth the most.
