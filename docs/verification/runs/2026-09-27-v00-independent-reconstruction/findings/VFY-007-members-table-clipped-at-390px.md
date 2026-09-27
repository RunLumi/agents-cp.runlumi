# Finding VFY-007 — The Members table clips its Role and actions columns at 390 px

## Status

open

## Severity

low

## Affected claim

- Claim ID: `VI-UX-002` (one sub-claim)
- Source requirement: `docs/specs/f22-web-control-plane-ux-information-architecture.md`
  FR-F22-004 ("Large directories/logs use server pagination … Critical tables remain usable"),
  FR-F22-008 ("critical admin/security actions work on tablet/mobile");
  `AGENTS.md` frontend rules ("narrow layout" in the Definition of Done)
- Risk tier: 2

## Statement

At a 390 px viewport the Members table is wider than the card that contains it. The page itself
does not overflow, so a `scrollWidth` check passes; the table is clipped inside a horizontally
scrollable container whose only affordance is a thin scrollbar stub. The Role column is cut
mid-word and the row's action control is off-screen.

## Reproducer

### Preconditions

A signed-in, verified member of an organization on the **Members** section.

### Action

```bash
# see evidence/browser-probe.mjs
await page.setViewport(390, 844, true);
await sleep(700);
await page.screenshot("06-narrow-390.png");
```

### Expected

Either the table reflows (stacked rows, or a card list) or the scroll container has an explicit,
visible affordance — and, per `AGENTS.md`, no essential action is hover-only or off-screen.

### Actual

`evidence/screens/06-narrow-390.png` — the Role header renders as `F…` and the second column is
cut at the card edge. The row content is reachable only by horizontal scrolling inside the
card, with no visible cue other than a ~40 px scrollbar stub under the row.

## Why it matters

Members is a critical admin surface (F22 places it top level) and role display is how an
operator answers "who can do what". A 390 px viewport is a real phone width, and `AGENTS.md`
requires the narrow layout to be checked with screenshots before a visual change is handed off —
`STATUS.md` records that this was never done for P06, P07, or P08.

**Note on measurement.** The campaign's automated overflow check reported **no** horizontal
overflow at 390 px on four sections, because the clipping happens inside a scroll container
rather than on the document. A document-level overflow metric is therefore not a sufficient
narrow-layout verifier, which is itself part of this finding.

## Root cause

The table layout has no narrow-viewport variant, and no verifier measures containment rather
than document width.

## Repair constraints

- do not weaken: F22 FR-F22-004 (server pagination, not a client-side dataset), FR-F22-008.
- the fix must not reintroduce a full-dataset download into the browser.

## Regression requirement

- a browser probe step that, at 390 px, asserts every column header and every row action is
  within the viewport, or that the table is replaced by a stacked layout — measured on the
  scroll container's `scrollWidth`, not the document's;
- screenshots at 390 px and at a tablet width for every top-level section, compared against
  `DESIGN.md`.

## Closure evidence

- fix commit: _pending_
- original reproducer: `evidence/screens/06-narrow-390.png`
- focused regression: _pending_
- affected proofs: `VI-UX-002`
- broader gate: `pnpm check` + a promoted browser probe (next action 6)

---

# Closure — 2026-09-27, after the repair loop

**Status: CLOSED.** `VI-UX-002` → PASS. Full evidence: [`repair-closure.md`](../repair-closure.md).

## The metric was the first defect

V00 used `document.documentElement.scrollWidth`, which **passed** while the table was clipping.
The clipping happened inside an `overflow-x-auto` container, which absorbs the overflow without
propagating it to the document. A document that does not scroll is not a page whose content is all
reachable. The probe now measures **containment**: for every scroll container, is a control clipped
off its own right edge.

## The replacement metric had the same bug, and measuring found it

The first containment implementation collected every clipped node and stopped at eight. The Members
table produced eight **non-interactive** nodes in DOM order — `th`, `tbody`, `tr`, `td` — so the walk
ended before it ever reached the role `<select>`, and the check reported *"no interactive control is
clipped"* while a control was clipped by 68 px.

That is this finding's own shape: **a truncated sample reading as a clean bill of health.** It now
collects only interactive elements, and reports the non-interactive count separately as context.

## Measured failure, and the repair

At 390 px with three visible columns the table wanted **457 px**; the role `<select>` was squeezed
to **36 px wide at x=422..458** — entirely outside the viewport, reachable only by scrolling a
container, and below any reasonable touch target.

Three visible columns do not fit 390 px. Two do. The **Role** column folds into the member cell
below `sm`, alongside Status and Joined, leaving Member + Action. Nothing is lost: the folded text
is in the DOM at every width, so a screen reader still reads role, status, and join date — only the
layout differs. The select gets `min-w-[8.5rem]`, so the Action column cannot shrink below the
control and the Member cell wraps instead; the rationale is a comment on the declaration, because
`min-w-[8.5rem]` looks like tidying to the next person who reads it. Every column header carries
`scope="col"`.

**After:** headers `["Member", "Action"]`; role control at **x=225..361, 136×44 px**, fully inside
the viewport, meeting the 44×44 touch target `AGENTS.md` requires.

## Regression proof

10 cases in `org-dashboard.test.ts`, each verified to fail when its fix is reverted — including a
`min-w-[8.5rem]` case and a 44×44 touch-target case, so a future "tidying" of the floor fails a
gate rather than silently restoring the defect.

Behavioural proof is the browser journey, which measures containment and the control's box rather
than trusting the markup.
