# V04-007 — a test fixture with a literal date, and the day it silently broke the repository gate

**Severity: MEDIUM (harness), and a near-miss of HIGH. Found by re-running `pnpm check` on a candidate
whose source the campaign had not touched. Repaired, and the class is named rather than one instance
fixed.**

## What happened

The V04 baseline ran `pnpm check` green. Two hours later, on the same product code, with **no product
change**, `pnpm check` failed:

```
❯ src/features/billing/billing-panel.test.ts (17 tests | 2 failed)
  FAIL … > renders the two expiries as two distinct clocks
    expected '<section aria-label="Billing and enti…' to contain 'This is a different clock from the on…'
  FAIL … > shows each capability class with its own decision and reason
    expected '<section aria-label="Billing and enti…' to contain 'license_grace_active'
```

## Root cause

`billing-panel.test.ts` pinned four instants as literal strings:

```ts
grace_expires_at:      "2026-09-26T16:00:00.000Z"
current_period_ends_at:"2026-10-01T12:00:00.000Z"
policy_fresh_until:    "2026-09-25T16:15:00.000Z"
offline_valid_until:   "2026-10-02T12:00:00.000Z"
```

and `license-state.ts:299-303` compares each against the wall clock:

```ts
const now = input.now.getTime();
const grace = toEpoch(input.graceExpiresAt);
const graceEnded = grace !== null && grace <= now;
```

**The product is correct.** On 2026-09-26 the fixture's grace window genuinely closed, so the panel
correctly stopped rendering grace-active copy, and the two assertions began failing. `current_period_ends_at`
had expired a day *before* that, so the file had been quietly decaying for a week and nothing ran it in
a state anyone read.

## Why this one is worth more than the two red lines

It is the same class this repository already paid for in `verify:budget-concurrency` — recorded in
`AGENTS.md` as: *"its fixtures are relative to the clock, and a control asserts the reservation expiry
is in the FUTURE … it once used a literal date, and when that date passed every reservation was refused,
nothing was held, and the ceiling assertion passed vacuously."*

But this is the **inverse**: that fixture made nothing happen; this one made the asserted thing **stop
happening**. Same root cause, opposite symptom, and the second is the more dangerous of the two,
because:

- a failing assertion is noisy, so it gets noticed — which is why this was found;
- **a date that has not passed yet is silently correct today.** Nothing in the suite, in CI, or in a
  recorded baseline can tell you a fixture will expire next Tuesday. The defect has a **scheduled**
  failure date, and nothing in the repository records it.

That is the generalisation worth keeping: **an absolute date in a fixture is a loan against a future
incident, and nothing in the tree carries the due date.**

## The repair

The fixture is now relative to the clock, preserving the *original relationships* exactly — policy
fresh +15 min, grace +1 d, period end +5.8 d, offline validity +6.8 d from a nominal "now" of
2026-09-25 — so it still means what it meant when written, on any day the suite runs.

And, per the campaign's own rule, **a control runs first**:

```ts
it("PRECONDITION: every instant in this fixture is in the FUTURE, or the assertions below are about the wrong state", …)
```

It enumerates all four instants and fails if any is null or in the past. That control is what makes the
class visible to the next reader: if someone reintroduces a literal date, the suite says so on the day
it is introduced rather than on the day it expires. `pnpm check` exit 0, 18/18 in this file, 48/48 test
files, bind-count 463, clippy clean.

## The class, and what is deliberately NOT done about it

A scan finds **many** absolute past dates across the test tree:

```
2026-01-01, 2026-02-01, 2026-09-01, 2026-09-20, 2026-09-24, 2026-09-25 …
```

**Most of them are correct.** A test that asserts "this is expired" *should* use a past date — that is
the state under test. A mechanical scan cannot tell "intentionally past" from "should have been
future", and rewriting twenty files on a guess would replace working tests with speculative ones.

`pnpm check` is otherwise green, so no other fixture is *currently* breaking. The standing rule this
finding establishes is narrow and checkable by a reader:

> A fixture instant that feeds a **wall-clock comparison** in product code, where the assertion
> describes a **not-yet-expired** state, must be relative to the clock and must carry a control
> asserting the instants are in the future.

That rule is what makes the next one findable. It is not enforced by any tool today, and building a
checker that distinguishes the two cases is a real piece of work that this finding names rather than
pretends to have done.
