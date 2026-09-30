# V02-008 — one-time secret lifecycle, and the last non-PROVEN browser state

**`pnpm smoke:browser` 82/82, exit 0, stable over three consecutive runs · all twelve states PROVEN**

## Why this state is different from the email code

The verification code was already covered end to end, including a refused short code — but a
verification code is not a *secret*: it authenticates one transaction. This state is about a
credential whose entire safety property is that it is shown **once** and then cannot be retrieved.

The webhook signing secret is exactly that, and the app states the contract in its own copy:

```
title:   "Signing secret — shown once"
warning: "Copy this value now: it is not stored in the control plane and cannot be shown again."
```

and `secret-reveal.tsx` opens with *"rendered exactly as returned, never masked into something that
could be mistaken for the real secret, and never persisted."*

## What is asserted, against rendered text

1. the reveal appears with its shown-once title and the warning;
2. the exact secret is **rendered and readable** — captured through the app's own **Copy secret**
   control and required to be present in the page as text, with no row of bullets standing in for it;
3. **leaving the panel and returning does not bring the secret back** — searched for as that exact
   captured literal;
4. and the endpoint is **still listed**, so (3) proves the *secret* is gone rather than the *record*
   being absent.

Point 4 is the control that makes 3 meaningful. Without it, a create that silently failed would also
produce "no secret on return", and the assertion would pass for the wrong reason.

## The lesson worth more than the finding: guess the secret's shape, or ask for it

Capturing "the secret" by regexing the DOM failed **three times**, and each failure produced a
confident wrong answer:

| attempt | what it matched | consequence |
|---|---|---|
| 1 | a 28+ character token in the body | matched an unrelated element |
| 2 | `/\bwhsec_…\|\b[A-Za-z0-9_-]{28,}\b/` | matched a `whe_` **endpoint id** |
| 3 | same regex, different page state | matched a **`whs_` fingerprint** |

The third is the instructive one. A `whs_` fingerprint is *shown again on purpose* — it is a key
identifier, not a secret — so the "the secret did not come back" assertion was **comparing a
fingerprint with itself** and reporting a credential leak that does not exist. A real finding, wrong.

The fix is to stop guessing: click **Copy secret**, grant clipboard permission through
`Browser.grantPermissions`, and read `navigator.clipboard.readText()`. Whatever the app offers to copy
*is* the secret, by definition. `grantClipboard(origin)` is now a driver method, and it takes the
origin explicitly because the page object does not track its own URL — guessing one would grant the
permission to the wrong origin, which fails closed for a reason that looks like the browser refusing.

## The server was right and the test was wrong — twice

**`422 "Select at least one event type and no more than 64."`** The form was submitted with an empty
subscription. That is **correct product behaviour**: an endpoint subscribed to nothing is a
misconfiguration, not a valid endpoint that simply receives nothing. Four full probe runs were spent
assuming the product was broken before the cause was read out of the server.

Reading it took **one request from inside the page**, using the session that was already open:

```js
if (!revealSeen) { /* POST the same body from the page and report status + body */ }
```

Two independent causes — a missing submit button and a rejected submit — produce the identical symptom
(the form simply stays open), and distinguishing them from `curl` cost a run each time. The probe now
asks the server itself, inside a run that is already happening.

## Four more of my own bugs, and a tautology caught before it shipped

**A tautology.** One assertion was written as
`/VFY Endpoint/.test(body) || !/VFY Endpoint/.test(body)` — **true for every possible page**, a check
that looks like a control and asserts nothing. Replaced with the real claim (the endpoint *is*
listed). This is the most dangerous shape a check can have, and it was written and spotted inside the
same edit.

**An assertion on a slice.** `endpointNamePresent` tested a 200-character slice of the body that
contained only the page header, so it could never be true. Now computed against the whole body inside
the page.

**A misleading diagnostic.** The "unmasked" case required `secretSample !== null`, where the sample
came from the broad regex — so it matched the organization's own slug and the assertion quietly reduced
to "no bullet mask anywhere", while printing a `secretSample` that had nothing to do with the secret.
It now requires the *captured* value to be on the page.

**A temporal dead zone that `node --check` cannot see.** `secretValue` was used by an assertion
declared above its `const`. A TDZ violation is a **runtime** error and `const` is hoisted, so the
file passed every syntactic check and the probe died at `exit 2` on the first assertion that read it.
This is the **second** time in this campaign that exact trap was sprung — after the same bug in the
observability probe — and both times the symptom was a harness failure attributed to nothing.

## Honest limits

- **Only the reveal half is proven.** That the secret is never *persisted* server-side is a property
  of the API's design and of `verify:secret-tenancy`; a browser cannot observe the absence of a
  column.
- **No rotation leg.** Rotate-secret exists as a route (`/webhooks/{id}/rotate-secret`) and the copy
  for it is written ("New signing secret — shown once", "The previous secret stops verifying new
  deliveries immediately"), but driving it through the UI is not covered.
- **No product-side sensitivity proof** for this class, as for V02-002 and V02-006.

**A shape worth recording:** of the twelve browser states, **eleven** are now covered by checks whose
own sensitivity is unproven, and the twelfth was a check that **could not fail** until this campaign
repaired it. All twelve states being covered is a statement about the probe. It is not yet a statement
about the product.