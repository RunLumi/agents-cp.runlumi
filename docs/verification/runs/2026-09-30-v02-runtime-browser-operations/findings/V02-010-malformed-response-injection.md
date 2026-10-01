# V02-010 — malformed response: the injection a status-code check cannot see

**`pnpm smoke:browser` 87/87, exit 0, stable over three consecutive runs · failure-injection row 5 closed**

## Why this one, out of the seven the objective names

It is the most deceptive of the adapter injections, and it is the case where the objective's
"grade on observable state and stored records, not on status codes alone" stops being stylistic and
becomes load-bearing.

The injected fault is: **`/api/v1/me` answers HTTP 200 with a body that is not JSON.**

- An **error interceptor cannot see it** — there is no network error to intercept.
- A **status-code assertion reads it as success** — the status is 200.

So a verifier built on either of those two would report the product working while a user stares at a
failure screen. That is the entire reason the claim is worth a case.

The response is synthesised at the network layer with `Fetch.fulfillRequest`, so **nothing in
`apps/web` is stubbed** and the app's real parse path runs on a real body — the same standard the
campaign has held for every other injection.

## What is asserted

| assertion | result |
|---|---|
| an HTTP 200 with a non-JSON body renders an **ERROR state**, not a blank region | PASS |
| it **explains itself** rather than leaving the user to interpret emptiness | PASS |
| it does **not echo the malformed payload** — a proxy's `502 Bad Gateway` HTML must not appear as the product's own error copy | PASS |
| it offers a **retry**, because an unparseable response is where a user most needs a way forward | PASS |
| **CONTROL** — once the response is well-formed again, the session recovers **through the app's own retry** | PASS |

The control is what makes the four above mean anything: it proves the screen measured is one the app
can leave, and that the retry is a real control rather than decoration.

## What the product actually does

`requestJson` handles the body correctly at the client: `validJson = false`, and then
`makeInvalidResponseError`. The user-visible half was unproven and is now measured — an announced,
explained, retryable error state.

**One copy observation, recorded rather than reported as a defect.** The screen reads *"The API could
not be reached / Check your connection, then try again."* For a 200 whose body will not parse, the API
*was* reached. The wording conflates *unreachable* with *unparseable*. It is defensible — from a user's
position the session genuinely could not be established, and the guidance ("check your connection")
is not harmful — so this is recorded as a copy-accuracy question for whoever owns the messaging, not
as a behavioural defect. Nothing in the objective's requirements is violated by it.

## Two defects in the interception machinery, found by the fault that needed it

**1. `Invalid InterceptionId`, and a process crash rather than a failed case.** The `fetch`-interception
handler in `cdp.mjs` had **no session filter** — `browser.on` receives events from every attached
target, and an interception id belongs to the session that paused the request, so acting on another
session's event is always invalid. It then **threw**, inside an `async` handler that `browser.on`
invokes without awaiting, so the rejection was unhandled and Node exited — taking the probe down at
that point instead of recording one failed interception.

The session filter is now in place, the handler body is wrapped so its failures are *collected*, and
`intercept()` returns those collected errors on release, so a case that expected an interception can
say the interception did not happen rather than reading an absence as a product result. The dialog
handler already filtered by session; the interception handler did not, and `fail`/`delay` had masked it
because they were tolerated where `fulfill` was not.

**2. The control could never pass, by construction.** It waited for the authenticated shell and only
clicked retry inside a `.then()` — so the wait had to succeed *before* the click that would make it
succeed. It could never succeed, and reported `recovered=undefined`.

## And one structural mistake, in the shape this campaign keeps hitting

I inserted the malformed class **between** V02-002's server-error screen and its own recovery check.
The malformed class ends by recovering to the authenticated shell, so by the time V02-002's recovery
ran there was **no alert left to click** — and the failure surfaced in a section I had not touched,
named `RECOVERY + CONTROL`, one screen earlier in the file than the mistake.

That is the "one mistake, two red cases, and the second is nowhere near the cause" pattern for the
fourth time in this campaign, and it is worth naming why it recurs: a journey is a **sequence of state
transitions**, and a block that ends by restoring a healthy state silently consumes the preconditions
of whatever runs next. The class now runs **after** V02-002's recovery rather than inside it.

## What is NOT established

- **No product-side sensitivity proof.** This class has been watched to report FAIL only on harness
  faults — the two above. It has not been watched failing on a malformed-response-shaped product
  defect.
- **Only the session read is covered.** A malformed response on an org-scoped collection, on a
  mutation, or mid-stream is not driven.
- **429 and 5xx remain BLOCKED**, and this does not change that: they need an upstream that produces
  them, and V01-026 measured that the Worker cannot open an outbound socket on this host.

## The failure-injection ledger after this

| # | injection | verdict |
|---|---|---|
| 1 | connect failure | **PROVEN** (V02-002) |
| 2 | timeout | **PROVEN, narrow** — a pending request, not an upstream call |
| 5 | **malformed response** | **PROVEN** (this finding) |
| 7 | downstream disconnect | not covered; reachable in part via the same boundary |
| 3, 4 | 429, 5xx | **BLOCKED** — V01-026 |
| 6 | queue / webhook retry | partial (replay proven); delivery-failure injection **BLOCKED** |

Three of the seven are now measured without any outbound socket, which is the part V01-026 had
obscured: the blocker applies to *upstream adapters*, not to faults injected at the browser's own
network boundary.