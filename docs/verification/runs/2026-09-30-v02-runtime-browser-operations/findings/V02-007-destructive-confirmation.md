# V02-007 — destructive confirmation, and the last absent browser state

**`pnpm smoke:browser` 73/73, exit 0, stable over three consecutive runs · State 10 closed · no ABSENT states remain**

## Why credential revoke

Automations delete would be the richer surface — it uses an **in-DOM** confirmation — but
`entitlement_grants` is **empty in this database (0 rows, measured)**, so creating an automation is
refused and the surface is unreachable without provisioning an entitlement first. Webhooks have **no
delete affordance in the UI at all**. Revoke is what exists and is reachable, so it is what is
driven.

The app confirms with a **native** dialog:

```ts
const confirmed = window.confirm(
  `Revoke "${credential.label}"? New requests will fail immediately; existing usage and audit history …`,
);
if (!confirmed) return;
```

## What is asserted, and why the middle one matters

The test is built around what a user relies on, which is **not** "a dialog appeared":

1. clicking Revoke opens a confirmation whose copy **states the consequence** — `AGENTS.md:181`
   requires "clear consequence copy", and *"Revoke?" alone tells a user nothing about whether
   in-flight requests break*;
2. **dismissing it leaves the credential alive** — this is the load-bearing assertion. A confirmation
   that opens but does not prevent anything is decoration, and "a dialog appeared" cannot tell the
   two apart;
3. accepting it **really revokes**: the Revoke control disappears and the credential shows a revoked
   status.

Plus two preconditions — a real credential exists, and **the app lists it**, so the button under test
is the app's own rather than something the probe conjured.

## Two behaviours the app gets right, which the naive assertions would have called bugs

**A revoked credential STAYS in the list.** The first version asserted the row disappeared. It does
not, and it should not: `models-routing-panel.tsx:421` drops the Rotate/Revoke buttons once
`credential.status === "revoked"` and renders a `StatusPill` instead. Deleting the row would hide
that the credential ever existed. The assertion is now a **delta on the control** — Revoke present
before, absent after, alongside a revoked status that was not there before — with a separate
assertion that the row survives, recorded as the audit surface it is.

**A modal dialog suspends the JavaScript that opened it.** `button.click()` inside `Runtime.evaluate`
cannot return while a `window.confirm` is up, so the first implementation — arm, `await click`,
then await the dialog — **deadlocks on any implementation that works correctly**. The click is now
fired without being awaited and the two settle independently against a timeout.

## The driver gained native dialog handling

`apps/web/scripts/cdp.mjs` gained `armDialog({ accept, timeout })`. A native dialog is rendered by the
**browser**, not the document, so `document.body.innerText` cannot see it and `page.evaluate` cannot
dismiss it. Without this the probe had exactly two bad options: assert nothing, or hang until the
dialog times out — both report a green journey over an unverified state.

**One-shot on purpose.** A handler left armed would silently accept the *next* dialog in the journey,
which is how a later assertion comes to pass for the wrong reason.

## Four bugs, all mine, and the third is the one worth keeping

**1. The wrong button.** The first version found the nearest container holding the credential's label
and clicked that container's **first** button — which is **Rotate**, not Revoke. It reported
`clicked=true` with no dialog, which reads as *"the app does not confirm destructive actions"* when
the truth is *"the probe clicked the wrong control"*. Targeting the button by its own text removes
the inference, and the not-found branch now names the buttons it can see.

**2. A fixture that authenticated as nobody.** The credential was created from Node with a fresh
`ApiJar`, which carries no cookies, so `/api/v1/me` answered with no organizations and the fixture
reported *"the session reports no organization"* — a sentence that reads as a product problem and was
entirely a harness one. It now runs **inside the page**, so the request carries the real session
cookie, the real CSRF token and the real origin, which is also what makes it the same call the UI
would make.

**3. Two plausible catalog paths, both wrong.** `/api/v1/inference/providers` answers **404** — it is
in neither the router nor the client. `/orgs/{id}/catalog/providers` exists but is a **POST** (a
create), so a GET answers **405 method_not_allowed**. Neither said "no providers exist"; both said "you
asked the wrong way", and the fixture reported both as a product-level absence. The catalog read that
lists providers is `GET /orgs/{id}/catalog`.

**4. A wrong assertion that would have "found" a bug.** Covered above — the revoked-row assumption.

The generalisation across all four: **every one of them reported as a product finding.** An
unauthenticated fixture, a mis-aimed click, and two wrong endpoints are indistinguishable from
"the app is broken" if the harness does not say what it actually observed. That is why the button
branch now names what it saw, why the fixture reports the HTTP status, and why the assertions read
the rendered state rather than a proxy for it.

## Honest limits

- **No product-side sensitivity proof** for this class. It has been watched to report FAIL — five
  times, all on the bugs above — which proves the instrument goes red, not that it would go red on
  this class of product defect.
- **Only one destructive action is covered.** Revoke is the only reachable one in this environment;
  automations delete needs an entitlement, and webhooks have no delete UI.
- **`window.confirm` satisfies `AGENTS.md:181` as written** and is now proven to actually prevent the
  action — but a native modal is not styleable and is inconsistent with the in-DOM surface the
  automations flow uses. **That is a product decision, recorded here rather than resolved.**