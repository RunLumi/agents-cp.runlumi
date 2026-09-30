# V02-009 — the permission-denied class, watched to fail (and a prediction that was wrong)

**Sensitivity proof for V02-006 / V02-008 · `evidence/v02-006-permission-denied-sensitivity.sh` · Verdict: M1 DETECTED**

| | | |
|---|---|---|
| baseline | unmutated | **82/82, exit 0** |
| **M1** | the `!` dropped from `unauthorizedPath` | **DETECTED** — 53/78, exit 1, **25 FAIL** |

`denied-legs-failing = 4`, `recovery-failing = 1`. Tree restored (`cmp` **and** `git diff` clean),
**HEAD unmoved**, stack restarted onto the restored source, script exit **0** — which is the correct
status for a run in which every case was DETECTED.

## The mutation

```diff
- pathSlug && !me.organizations.some((item) => item.organization.slug === pathSlug),
+ pathSlug &&  me.organizations.some((item) => item.organization.slug === pathSlug),
```

A forgotten negation — the single most likely edit to make in that line — and it fails **OPEN**: an
organization the session *cannot* see stops being treated as unavailable.

## My prediction was wrong, and the run is what corrected it

The script header says, in advance:

> "NON-DISCLOSURE will still PASS. Both of its legs change together … A class that 'cannot fail'
> because both its legs move together is a class whose green sheet says very little."

**It did not pass. It went red — but not for the predicted reason.** The diagnostic is:

```
FAIL  NON-DISCLOSURE: the two answers can be compared
      — one leg was unmeasurable: foreign=unread phantom=unread
```

With the predicate inverted, `unauthorizedPath` is true only for a slug the session **owns**. So a
phantom slug and a real foreign slug are *both* now ordinary pages: neither raises the denial, and both
`readDeniedView` calls time out looking for `[role=alert]`. The comparison cannot be made at all.

So the honest statement is narrower and different from the one I wrote down: **the check does not
silently survive the fault, but it goes red because its subject disappeared, not because the two
answers diverged.** Those are different failures and only one of them is the check doing its job. A
prediction written into a harness header and then contradicted by the run is worth recording as
wrong; a prediction quietly edited afterwards would have hidden exactly the information a reader
needs.

## The blast radius is wide, and that is worth saying plainly

25 failures across **six** classes for one dropped `!`:

| class | failures | relationship to the fault |
|---|---|---|
| stale-data-after-org-switch | 2 | **cascade** — you cannot reach a panel, so the switch appears to leak |
| permission denied | 4 | **direct** |
| non-disclosure | 1 | **cascade** — its subject is gone |
| permission-denied recovery | 1 | **direct** |
| keyboard (precondition + 2) | 3 | **cascade** — the data panel is unreachable |
| destructive confirmation | 3 | **cascade** — the models panel is unreachable |

The gate detects the fault strongly. But most of those red lines are **downstream consequences, not
independent evidence about their own class**. A reader who saw "25 failures" and concluded that six
classes independently caught a dropped negation would be wrong; the permission-denied and recovery
legs are the direct witnesses, and the other four classes went red because the application could not
render the page they test.

That is the difference between *a gate that can fail* and *six gates that can each fail*, and this
campaign's whole argument is the first one. It is now measured for this class, and the honest summary
is: **the fault is caught, and the attribution is coarse.**

## The first run of this proof scored INVALID — and that was the harness working

The first attempt produced:

```
INVALID M1  the probe exited 2, so the harness could not run
  browser probe failed: TypeError: Cannot read properties of undefined (reading 'some')
      at browser-probe.mjs:2215
```

M1 inverts `unauthorizedPath`, so navigating to the session's **own** organization raises the denial,
the Members panel never mounts, and `membersNarrow.headers.some(...)` threw. The probe exited 2 and
the run was scored INVALID.

Three things are worth separating here:

1. **The harness was right.** A crash is not a detection. Reporting MISSED or DETECTED for a probe
   that did not complete would have been the campaign's most consequential error yet, because the
   crash *looked* like the gate noticing the fault.
2. **The mutation had in fact worked.** The gate's own narrow-layout case had everything it needed to
   report red — `gotoSection("members")` lands on a denial page, so `membersNarrow.table` is `false`.
   The signal existed and was discarded.
3. **The defect was structural, not a typo.** A violation of an *earlier* section's expectation
   surfaced as a **crash in a later, unrelated section**, so the verdict came back as INVALID and
   nothing was learned about the gate.

`(membersNarrow.headers ?? []).some(...)` is the entire fix. **A check must FAIL when its precondition
is absent, not throw.** One absent array is the whole difference between a sheet that says what is
wrong and a sheet that says the harness could not run.

## A cost worth recording

The mutated run took substantially longer than the baseline. With the predicate inverted, several
navigations land on pages the probe does not expect, and each `waitFor` burns its full 25-second
timeout **in series**. So the failure path is slow in proportion to how badly the product is broken —
which is the right trade (a timeout gives a slow app its chance) and is worth knowing before anyone
concludes that a long detection run is a hang.

## What this does and does not establish

**Establishes:** the permission-denied and recovery classes can fail, and they fail on the fault they
name. `smoke:browser` is not asserting a guarantee it cannot detect.

**Does not establish:** that the other five classes can fail *on their own fault*. They went red here
as cascades. Each would need its own mutation — for example removing `me.organizations.length === 0`
from the empty-state branch, or making the `SecretReveal` warning conditional — and that work is
outstanding, not done.