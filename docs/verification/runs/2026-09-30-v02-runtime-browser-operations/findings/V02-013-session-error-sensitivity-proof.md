# V02-013 — the session-error class, watched to fail (after its gate refused to)

**Sensitivity proof for the V02-002 / V02-010 / V02-012 error-state classes · `evidence/v02-013-session-error-sensitivity.sh` · M1 DETECTED, script exit 0**

| | | |
|---|---|---|
| baseline | unmutated | **90/90, exit 0** |
| **M1** | the session error branch renders `loading` instead of `error` | **DETECTED** — **77/90, exit 1, 13 FAIL** |

`error-legs-failing=7 · recovery-failing=3 · stuck-loader-hits=2 · loading-still-passing=1`.
Tree restored (`cmp` **and** `git diff` clean), **HEAD unmoved**, stack restarted onto the restored
source, script exit **0** — the correct status for a run in which every case was DETECTED.

## The mutation

```diff
      } else {
-       setSession({ kind: "error", error });
+       setSession({ kind: "loading" });
```

A swallowed failure, and the most likely way for this branch to break in review: an error path
"simplified" into a state that already exists. It fails **silently** — no crash, no blank page, no
console error. On any failed `/me` the app shows *"Loading your workspace…"* forever instead of the
announced error state and its retry.

## What went red, and what that proves

13 failures across exactly the three classes that depend on the error branch:

| class | failures | relationship |
|---|---|---|
| V02-002 server error | 3 + 2 recovery | **direct** |
| V02-010 malformed response | 4 + 1 control | **direct** — all three injections share one screen |
| V02-012 downstream disconnect | 2 + 1 control | **direct** |
| V02-002 LOADING | 0 — **still passing** | the control, and the point of the run |

**The LOADING case passing while every error case fails is the most informative single line on the
sheet.** It is the positive control for the class: the mutation makes the app render loading
*instead of* the error, so a check that only knew "the app showed something" would be satisfied. The
gate distinguishes the two, which is the whole claim — and it does so with a class whose fault
produces a *plausible-looking* screen rather than a blank one.

**The stuck-loader detector hit twice** — the diagnostic added in V02-012 for exactly this shape
(headers arrive, promise breaks, spinner never clears) is the instrument that named the fault.

## The attribution is coarse, and that is stated rather than glossed

Everything downstream that needs the authenticated shell also went red. Those lines are cascade
consequences, not independent witnesses — the V02-009 lesson, unchanged: **the fault is caught
strongly, and the attribution is coarse.** The seven error legs and three controls are the direct
evidence for this class; nothing else on the sheet is.

## Two INVALID runs, and both were the harness working

This took three attempts, and the first two produced no verdict at all. Both were worth the runs.

**1. The anchor matched twice, so nothing was mutated.** `setSession({ kind: "error", error });`
occurs in `app.tsx` at line 30 (load-session) *and* line 44 (sign-out), byte-identical. The
`count != 1` guard refused to fault rather than faulting both branches — which would have been a
different, broader mutation than the header describes. **A harness that cannot aim its own fault
cannot report on it.** The anchor now carries the preceding `} else {`, making it unique.

**2. The gate could see the fault and threw it away.** With the anchor fixed, the mutated run passed
72 checks and the error screen never appeared — the signal was *there* — but the V02-002 `errorScreen`
`waitFor` had no `.catch`, so the timeout became an uncaught throw and the probe **exited 2
(INVALID)**, discarding it. Fixed in `1be274a`: the predicate now returns
`{stuckLoader: true}` when loading copy is present without an alert, the wait is catch-guarded, and
the diagnostic names `stuckLoader`.

That is the **fourth** instance of this campaign's rule that a check must **fail** when its
precondition is absent, not throw — after V02-009's `membersNarrow.headers`. Both were `undefined`
dereferences reached through a *different* section's violated expectation, and both turned a
detectable signal into INVALID.

## What this does and does not establish

**Establishes:** the error-state class — and therefore V02-002's server error, V02-010's malformed
response, and V02-012's disconnect, which all render the same screen — **can fail, and fails on the
fault it names.** Three more classes now carry a real product-side proof (with V02-005 and V02-009),
and the browser gate's largest blind spot is closed: it can no longer be true that "all 12 states
covered" hides a class that cannot go red.

**Does not establish:** sensitivity for the remaining browser states — empty, keyboard navigation,
visible focus, narrow layout, destructive confirmation, stale-data-after-org-switch, and
one-time-secret. Those are still covered by checks whose own failure mode is unproven, and
"covered" remains a statement about the probe rather than the product.
