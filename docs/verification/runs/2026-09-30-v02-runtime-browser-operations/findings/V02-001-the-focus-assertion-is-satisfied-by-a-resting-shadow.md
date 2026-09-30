# V02-001 — the browser gate's visible-focus assertion is satisfied by a control's resting shadow

**Severity: HIGH (verifier blind spot on an explicit objective requirement) · Status: CLOSED on the behaviour; the sensitivity is PROVEN WITH TWO DECLARED LIMITS · Verdict: the PRODUCT is correct; the original GATE could not fail and now cannot be satisfied by a resting shadow**

## The claim

The objective requires the browser pass to verify **visible focus**, alongside keyboard navigation.
`smoke:browser` carries a check that claims exactly that:

```
PASS  focus on the primary navigation control is visible (ring or outline)
      — box-shadow=rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, …,
        oklab(0.999994 0.0000497986 0 / 0.22) 0px 1px 0px 0px inset,
        oklab(0.278476 -0.0194971 -0.0528874 / 0.22) 0px 1px 2px 0px
```

A **fully transparent** box-shadow, and the check passed. That is the finding, and it is not that
focus is broken.

## What the check actually asserts

```js
(focusProbe.boxShadow && focusProbe.boxShadow !== "none") ||
  (focusProbe.outline && !focusProbe.outline.startsWith("none"))
```

Two failures, both in the same three characters:

1. **`boxShadow !== "none"` is satisfied by `rgba(0, 0, 0, 0)`.** A zero-alpha shadow is the
   canonical *absence* of a shadow, and it is not `"none"`.
2. **Any resting shadow satisfies it.** The measured value carries two `oklab(… / 0.22)` layers —
   a 1px inset and a 2px drop. Those are the control's **resting** appearance, present whether or
   not it is focused.

In this design system *every* control is `rounded-lg` with a border and a shadow. So the assertion
is **true for any focused control in the application**, and would remain true with the focus ring
deleted from the source.

**The check cannot fail on the defect it names.** A reader — including me, before measuring —
would take a green sheet here as evidence that focus is visible.

## Ground truth, measured rather than inferred

A real Chrome 153, the real dev server, no mocking. Two measurements on the same control:

| measurement | `:focus-visible` | box-shadow |
|---|---|---|
| `element.focus()` (what the gate does) | `true` | `oklab(0.999994 … / 0.22) 0 1px 0 0 inset, oklab(0.278476 … / 0.22) 0 1px 2px 0` — **resting shadow only** |
| a **real `Tab` key press** via CDP | `true` | `rgb(255,255,255) 0 0 0 2px, rgb(0, 96, 147) 0 0 0 4px` — **a real ring** |

**The product is correct.** The switcher carries
`outline-none focus-visible:ring-2 focus-visible:ring-[var(--…)]`, and 296 `focus-visible:ring-*`
utilities exist across the app. Under real keyboard focus a 4px solid ring is painted.

## Three things I got wrong on the way, which is the more useful part

**1. My hypothesis about `:focus-visible` was wrong.** I predicted that programmatic `focus()`
would not match `:focus-visible` and that the gate was therefore measuring the wrong thing. It
**does** match, in Chrome 153, for a `<button>`. I would have written that into a finding as fact
without running it — the same error that produced three false alarms in V01. **A prediction about a
browser is a hypothesis until a browser answers.**

**2. My own corrected assertion was wrong, and passing.** The first version of the corrected check
read the **first** colour in a multi-layer `box-shadow` list — which is `rgba(0,0,0,0)` — and then
reported `ring alpha = 0` while the overall verdict was still `true`, because it fell through to
`outlineColor`. So the instrument printed an alpha of 0 and passed anyway.

I caught it by reading the **raw output** rather than the verdict line. **A verdict that contradicts
its own diagnostic is a defect in the instrument, and the diagnostic is the evidence.**

**3. Reading the first shadow layer is the wrong model regardless.** A focus ring is a *stack*, and
the visible layer is not the first. Parsing `box-shadow` as a single colour is simply the wrong
shape of check.

## The repair, and the shape it has to take

The correct assertion is a **delta**, not an absolute: *focusing this control changes its rendering
in a visible way.*

```js
const delta = focusedBoxShadow !== unfocusedBoxShadow
           || focusedOutlineColor !== unfocusedOutlineColor;
```

A delta is immune to all three failure modes at once — resting shadows, transparent layers, and
design-system tokens — because the resting contribution is present in **both** readings and cancels.
It also requires a **real key event**, because a synthetic `KeyboardEvent` does not move focus and a
script-driven `focus()` is not what a keyboard user does.

**And the driver has no key-event capability at all.** `cdp.mjs` exposes `send`, `evaluate`, `goto`,
`text`, `screenshot`, `setViewport` — no `Input.dispatchKeyEvent`. Both keyboard claims in the
existing gate are therefore synthetic:

- the focus check uses `element.focus()`;
- the roving-tablist check dispatches `new KeyboardEvent("keydown", …)`, which exercises a listener
  but is not a key press.

A `press(key)` on the driver is one CDP call, and it is the prerequisite for the objective's
keyboard and focus requirements being anything but partially proven.

## What is genuinely unproven until this is repaired

The objective names **keyboard navigation** and **visible focus** as required browser states. Today:

- keyboard reachability — **PARTIALLY PROVEN**. Arrow-key movement is asserted through a synthetic
  event, so "reachable with the keyboard" is supported only in the weak sense that a listener
  responds to a dispatched event. Real `Tab` order and real `Enter`/`Space` activation are **UNPROVEN**.
- visible focus — **UNPROVEN**, and *worse*: the gate reports it as proven. Per the objective's own
  rule, a claim with no evidence is UNPROVEN rather than PASS, and here the evidence that exists is
  misleading rather than absent.

Neither is a product defect. Both are gaps in the instrument, and a green sheet currently conceals
one of them.

## Repair and sensitivity, as measured

The gate is now **42/42** and the assertion is a **delta driven by a real key press**, with the
driver gaining `press(key)` — it previously had **no key-event capability at all**, which is why both
keyboard claims were synthetic.

`evidence/v02-001-focus-sensitivity.sh` — **0 detected, 2 declared KNOWN MISSED, restored tree 42/42**,
with the tree verified clean by `cmp` against the snapshot *and* `git diff` against the committed
source after every case.

### M1 — the app's focus ring deleted: **MISSED, and the cause is not a defect**

Measured on the same control in the same run:

```
before.boxShadow = "none"   after.boxShadow = "none"      <-- the app's ring IS gone
changed          = [outlineWidth, outlineColor]          <-- focus is STILL visible
```

`boxShadow` being `none` on both sides proves the mutation landed. The outline properties still
changing means **the browser supplies its own focus indicator on this control**, so removing the
app's ring removed a *redundant layer*: the user-visible requirement is still satisfied, and an
assertion that measures the requirement rather than the implementation detail is **correct to pass**.

That is the difference between a missed detection and a correct verdict, and the run tells them
apart by measurement rather than by assertion — had the outline not changed either, the delta would
have been empty and the gate would have gone red. It did not.

**Detecting the removal would require a different claim** — "the focus indicator uses the
design-system ring token" — which is styling conformance, not accessibility. That is a real claim
worth making, and it is not this gate's claim.

### M2 — `outline-none` removed, ring intact: **MISSED by construction**

Declared, and it establishes the boundary of what the repair can detect: the assertion proves focus
is *visibly different*, not that it is *correct*.

### The limit I did not engineer around

The delta detects a **change**, not a **visible** change. A ring declared in transparent — present in
`box-shadow` as `rgba(0, 0, 0, 0) 0 0 0 2px`, invisible on screen — would satisfy the delta exactly
as a visible ring does, because the computed value changes from `none` to that string.

**So the repaired assertion closes the resting-shadow defect and does not close the
transparent-ring defect.** Both are real, and the second is the honest limit of a delta-based check
rather than something a further mutation would have revealed. It is recorded here as a known gap
with the mechanism, because manufacturing a mutation that goes red would produce the appearance of
sensitivity without the substance.

### What the sensitivity run cost, and what it found in me

Six harness defects, each found by running the harness rather than reading it:

1. `curl | grep -q` under `set -o pipefail` — `grep -q` exits on first match, curl takes **SIGPIPE**,
   pipefail reports it as the pipeline's status, and the check failed on a module that contained the
   marker on all 40 attempts.
2. A marker asserting **presence** of a token present in both states, then a marker asserting
   **absence** of a token legitimately served twelve times, then a third "unique" marker served
   **twice** on a clean tree. Assuming uniqueness and then testing it is how all three reported a
   false FATAL for a fault that had landed. Replaced with a **hash of the served artefact**, which
   assumes nothing.
3. A silent restore. A failing `cp` left a deliberate fault in the tree while the run printed
   verdicts. Git was the independent reference that caught it.
4. `run_case` scoring **exit 2 as DETECTED**. Exit 2 is "the harness could not run"; a crashed probe
   reads as a successful detection, which is the worst direction for a false verdict.
5. `run_case` not restoring between cases, so M2 measured M1's fault.
6. A **prerequisite check written so it could only fail** — it read `api_code` on the line before
   assigning it, and `${api_code:-000}` cannot distinguish "unset" from "not serving".

**And one that reached `main`.** Commit `ddead30` was made with `pnpm format && git add -A` while a
mutation run was in flight whose M1 had left the ring removed. The fault was staged and committed, so
`git show HEAD` reported a product with **no focus ring on its primary organization switcher** for
six commits, and `git checkout --` would have restored the fault. This is the V01-046 disaster,
repeated in this session, by the same command, after I had read the paragraph warning against it.

The ring is restored and verified against the gate rather than by inspection: with it absent the
delta reads empty, with it present the delta reads non-empty and the case passes.

**The general rule, which I broke twice in one session:** never `git add -A` while a mutation run is
in flight or after one has failed; `git status` before every commit in a mutation campaign; and a
snapshotting harness is not a safety net for this — its trap restores the file, so it will
overwrite a legitimate edit made while it ran, which is how `pnpm format`'s reformat was reverted
earlier in this same session.
