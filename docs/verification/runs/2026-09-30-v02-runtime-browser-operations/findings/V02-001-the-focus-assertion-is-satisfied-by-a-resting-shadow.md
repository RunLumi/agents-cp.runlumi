# V02-001 — the browser gate's visible-focus assertion is satisfied by a control's resting shadow

**Severity: HIGH (verifier blind spot on an explicit objective requirement) · Status: OPEN, repair in progress · Verdict: the PRODUCT is correct; the GATE cannot fail**

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
