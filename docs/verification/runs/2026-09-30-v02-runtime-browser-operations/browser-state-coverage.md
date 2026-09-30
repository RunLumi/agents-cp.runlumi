# V02 browser-state coverage — what the gate claims, what it proves, and what is absent

**Campaign: V02 Runtime, Browser, and Operations · Recorded: 2026-09-30 · Baseline: `smoke:browser` 41/41, exit 0**

The objective names twelve browser states to verify. This is an honest map of the current gate
against that list, because **"the gate has a check" is a claim about the check, and the check's own
sensitivity is the evidence.**

## The headline

**Of the twelve required states, exactly one has been watched to fail.**

| | state | status | basis |
|---|---|---|---|
| 9 | narrow layout | **PROVEN** | 5 checks at 390 px: document overflow, clipped controls, the Members table's role column, the role control inside the viewport, and a 44×44 touch target |
| 11 | stale data after org switch | **PROVEN** | 24 DOM samples per direction, 0 leaks, both directions asserted |
| 3 | success | **PROVEN** | org created, second org created, switcher populated, session live |
| 8 | visible focus | **PROVEN, after V02-001** | repaired to a delta; sensitivity proof in `evidence/v02-001-focus-sensitivity.sh` |
| 6 | retry/recovery | PARTIAL | the create-organization panel re-opens; `SessionError`'s retry does not |
| 7 | keyboard navigation | PARTIAL | `Tab` reachability is real (V02-001 added it); the roving-tablist arrow test is still a **synthetic** `KeyboardEvent` |
| 12 | one-time secret lifecycle | PARTIAL | the email code is covered end to end, including a refused short code; a real secret (download grant, webhook secret) is not |
| 1 | loading | **ABSENT** | `<LoadingScreen />` is never observed |
| 2 | empty | **ABSENT** | no empty organization, no empty collection |
| 4 | permission denied | **ABSENT** | no forbidden view is ever attempted |
| 5 | server error | **ABSENT** | `session.kind === "error"` is never reached |
| 10 | destructive confirmation | **ABSENT** | no destructive action is ever performed |

**Five absent states are all states where the UI must tell the user something.** The gate proves the
happy path thoroughly and the *communication* paths not at all.

## Why V02-001 is the important entry in this table

State 8 was marked covered before V02-001, and it was not. Its assertion was

```js
(boxShadow && boxShadow !== "none") || (outline && !outline.startsWith("none"))
```

which `rgba(0, 0, 0, 0)` satisfies, and which **any resting shadow** satisfies — and every control in
this design system is `rounded-lg` with a border and a drop shadow. It would have passed with the
focus ring deleted from the source.

**So the gate's green sheet was reporting coverage it did not have, on a state the objective names
explicitly.** That is the finding the rest of this map is calibrated against: a browser check that
reports a state as covered is a claim, and here the claim was false in the direction that matters
most — it would have concealed a real accessibility regression.

The generalisable rule this campaign has now enforced repeatedly, in a fourth distinct harness:

> **A check that cannot be watched to fail is not evidence that the thing works. It is evidence that
> nobody has looked.**

## What the absent states cost, concretely

**Permission denied (4)** — the highest-value absence. The whole control plane is authorization-first,
and V01 spent a campaign on server-side authority: 96/96 privilege-escalation cases, cross-tenant
substitution, stored-state grading. **None of that is verified as a user-visible state.** A route that
correctly returns `403` can still render an empty shell, a spinner, a crash, or a stale previous
organization's data — and the current gate would not notice any of it.

**Server error (5)** — `app.tsx` has a `SessionError` branch with a retry control, reached when
`getMe()` fails with anything other than `401`. It is the branch a real outage lands in, and it has
never been rendered by a test. It is also the branch this session hit by accident: the first
`smoke:browser` run of the day timed out waiting for the auth screen *because* the API was not running,
and the probe reported a bare "timed out waiting for auth screen" — a symptom of the server-error
state, with no indication that the UI was showing a failure screen rather than the sign-in form.

**Loading (1)** — the smallest and cheapest of the five. `getMe()` is fast locally, so the loading
screen needs a deliberate hold to observe. A loading state that never renders is a layout shift; one
that never *disappears* is a blank page. Neither is measured, and CLS (< 0.1) is a stated budget.

**Empty (2)** — a new organization with nothing in it is the **first thing every real user sees**,
and it is unverified. Empty-state copy, an empty collection's affordances, and a destructive
confirmation (10) are all the same surface, and none of them is exercised.

**Destructive confirmation (10)** — the objective names it separately, which suggests the risk is
known. `AGENTS.md` requires *"destructive actions require clear consequence copy and an appropriate
confirmation pattern"*, and there is no browser evidence that any destructive action has a
confirmation at all.

## The next three attacks, in order

1. **Permission denied** — a second user in the same organization, and a user with no access to a
   resource they can name. Assert the *rendered* outcome, not the status, and assert the previous
   organization's data is gone from the DOM. This is the browser half of the claim V01 proved at the
   HTTP layer.
2. **Server error and loading** — one instrumented failure covers both: hold or fail `getMe()` and
   observe what the user sees. The positive control is the ordinary path returning to normal, so a
   retry that does nothing is visible.
3. **Empty and destructive confirmation** — a fresh organization, then a destructive action on real
   data, asserting the consequence copy and that the action is not one click away.

## A caution this map exists to prevent

The temptation with a 41/41 sheet is to record the browser pass as done. Twelve named states, five
unexercised, one exercised by a check that could not fail. **The count is telemetry; the map is the
evidence.**
