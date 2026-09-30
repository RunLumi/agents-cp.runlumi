# V02-006 — empty, permission denied, non-disclosure, and a real arrow key

**`pnpm smoke:browser` 66/66, exit 0, stable over three consecutive runs · States 2 and 4 closed · State 7 upgraded from PARTIAL**

## What is now measured

**EMPTY (state 2) — the first thing every real user sees.** It was absent from the gate for the whole
campaign while the journey walked straight through it: at the moment the shell first renders, the
session has zero organizations, so `me.organizations.length === 0` routes to
`<CreateOrganizationPanel />`, and the very next block opens that panel. Exercised incidentally,
asserted on never — which is what a coverage gap that reads like coverage looks like from the top of
a file.

- the empty state **offers the way forward** (the create panel, not a blank region);
- the form is **present and labelled**, so the affordance is a form rather than a dead heading;
- it does **not reuse the error surface** — a brand-new account must not be told
  "Organization not found" when it simply has nothing yet.

**EMPTY CONTROL.** All four read the DOM, so the reader is entitled to ask whether that reading can
tell an empty shell from a populated one. The same reading is taken again once an organization
exists: a switcher is present and the organization's own name is on the page, while the empty shell
had no switcher. That is the delta, and it is specific to the populated state rather than a token
present in both.

**PERMISSION DENIED (state 4).** `org-dashboard.tsx` renders `role="alert"` with *"Organization not
found / This organization is not available in your current access scope."* Now driven for real:

- the denied URL renders an **announced** surface, not a blank region or a silent fallback;
- the refusal **explains itself**;
- the **content region carries the refusal and not the previous organization's data**;
- and a **recovery** leg: after a denied navigation the session can still reach an organization it
  *can* see, so the refusal is a navigation outcome and not a dead end.

**NON-DISCLOSURE — the browser half of a claim V01 proved at the HTTP layer.** A **real** organization
owned by a **second account** is created over the API, and its slug is compared against a phantom
slug that exists nowhere:

- the two render **the same answer**;
- and neither names the foreign organization.

Asserting only that the foreign org is refused would have passed on a UI reading *"you do not have
access to VFY Foreign Org"* — a cross-tenant **existence oracle**, the exact finding V01's path-id
sensitivity work kept returning to. The phantom leg is what makes the comparison meaningful, because it
exists in neither world, so any difference between the answers is disclosure. **The comparison is on
rendered text, not on statuses**: the claim is about what a user is told, and a status-only
comparison would be blind to copy that discloses what the status conceals.

**KEYBOARD (state 7) — PARTIAL → measured, with a real key.** The roving-tablist check fired
`new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })`. A synthetic event is *delivered*
to a listener that happens to be attached, so it only showed that a listener existed and read
`event.key`; it never proved a real key press reaches the tablist. It now navigates to a panel that
has one, asserts arrival as a **precondition**, and presses a real `ArrowRight` through CDP. Two
assertions: focus lands on the next tab, and focus **stays inside** the strip — roving tabindex means
the arrow moves along the strip rather than escaping to the next control in the page.

## Five bugs, all mine, and three of them were checks passing for the wrong reason

**1. The stale-data check searched the whole body.** `#org-switcher` is a `<select>` that lists the
user's **own** organizations — so "VFY Org A" appearing there is correct behaviour, not a leak. It
now reads `<main>`. A check that fires on correct behaviour is worse than no check, because it trains
a reader to distrust the assertion.

**2. `slug` is a lie.** The existing `slug` variable is `el.selectedOptions[0].textContent` — the
organization's **display name**. Navigating to it produced
`/org/VFY%20Org%20A%201790771513224/settings/data`, which `unauthorizedPath` correctly treats as an
organization this session cannot see — so the **recovery leg rendered the very denial surface it was
recovering from**. The deep-link test appears to contradict this: it builds its URL from the same
variable and passes, because it navigates with `history.pushState` and **the app then rewrites the
URL itself**. The probe read the rewritten path and printed a kebab-case slug, which is why the bug
was invisible for a run. The slug is now read from the session's own `/api/v1/me` answer.

**3. The recovery predicate was satisfiable by the sidebar.** It matched `VFY Org` anywhere in the
body, and the switcher names the current organization on every panel — including the denial screen.
Scoped to `<main>` and required *absence* of the denial copy.

**4. `recovered=undefined snippet=undefined`** — a red case whose detail is the absence of a
diagnostic. The fix is the one this campaign keeps arriving at: on a timeout, read the page. That one
change is what turned bug 2 from "times out, no idea why" into "`url` is the display name".

**5. One mistake, two red cases, and the second was nowhere near the cause.** My recovery navigated to
a bare `/org/{slug}`, which renders the Overview — no tablist — so the *next* check failed with
`{"error":"no tablist"}`. The keyboard check was reporting a symptom of my navigation, which is why its
own diagnostic (`"no tablist"`, naming the absence of its subject and nothing about the page) had to
be fixed at the same time.

## Honest limits

- **The EMPTY and PERMISSION-DENIED classes have no product-side sensitivity proof.** They have been
  observed reporting FAIL — five times, all on the harness bugs above — which proves the instrument
  goes red, not that it would go red on this class of product defect.
- **The keyboard class likewise.** A real-key check is stronger than a synthetic one, but no mutation
  has confirmed it detects a broken roving tabindex.
- **Permission denied is exercised for a cross-tenant URL only.** A same-organization member reaching
  for an owner-only action is a different surface, and the map shows `canDelete` already does the
  right thing (`disabled={!canDelete}` **plus** a rendered reason) — which is a counter-example to the
  assumption that hiding a control is the app's pattern.
- **Destructive confirmation (state 10) is still absent** from the gate. The surface exists in two
  patterns; it has not been driven.

The common shape of the outstanding work is unchanged and is the campaign's standing rule: **the
count is telemetry, the map is the evidence.**