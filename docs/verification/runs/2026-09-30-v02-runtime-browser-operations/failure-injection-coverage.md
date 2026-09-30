# V02 failure-injection coverage — what is proven, what is blocked, and what is merely reachable

**Objective section: "At external adapters inject: connect failure; timeout; 429; 5xx; malformed response; queue/webhook retry; downstream disconnect."**

This is a map, not a finding. It exists because the section had **zero** coverage when this campaign
started and the honest position is easier to read as a table than to reconstruct from seven documents.

## The headline

**Two of the seven named injections are proven, one is proven in a narrower sense, and four are not
covered — two because the environment cannot reach them, and two because nothing has driven them
yet.**

Two of the three reachable ones are reachable **without any outbound socket**, which is the
non-obvious part: the blocker that has stopped this section twice (V01-026 / GAP-007) applies to
*upstream* adapters, not to faults injected at the browser's own network boundary.

| # | injection | verdict | instrument / blocker |
|---|---|---|---|
| 1 | **connect failure** | **PROVEN** | `Fetch.requestPaused` → `Fetch.failRequest` on `/api/v1/me`. The app renders an announced error state with a retry, and the retry against a restored network returns to the authenticated shell **and names the organization** (V02-002). |
| 2 | **timeout** | **PROVEN, narrow** | The same mechanism with `delay` rather than `fail`: a *pending* request renders a loading state and does **not** render the error state. Narrow because a pending `/me` is a session read, not an upstream provider call. |
| 3 | 429 | **NOT COVERED — BLOCKED** | Needs an upstream that answers 429. The Worker cannot open an outbound socket on this host (V01-026, measured across three address classes). |
| 4 | 5xx | **NOT COVERED — BLOCKED** | Same cause. |
| 5 | **malformed response** | **PROVEN (V02-010)** | `Fetch.fulfillRequest` answers `/api/v1/me` with **HTTP 200 and a body that is not JSON**, from the browser, with no upstream. The app renders an announced, explained, retryable error state and does **not** echo the proxy's HTML back as its own copy; a control proves the session recovers through the app's own retry. This is the row where a status-code assertion would have read the fault as success and an error interceptor could not see it at all. |
| 6 | queue / webhook retry | **PARTIAL, then BLOCKED** | `verify:webhook-fanout` W6 shows **replay** works over real HTTP (W0–W4 are controls, W6 the replay). Delivery **failure** injection is BLOCKED: the local queue does not deliver a published body, and driving a real non-2xx from a receiving endpoint needs an outbound socket. |
| 7 | downstream disconnect | **NOT COVERED — REACHABLE in part** | #1 is a failure *before* the response. A disconnect **after headers, mid-body** is a different fault and is not driven. Reachable via the same boundary. |

## The objective's second list, per injection

The objective asks each injection to be checked for: *stable errors, bounded retry, no duplicate side
effect, correct reconciliation, useful trace, and no secret leakage.* Honest coverage:

| property | covered? | by |
|---|---|---|
| stable errors | **yes** | V02-002 — a network failure is an error state, not a spinner and not the sign-in form |
| useful trace | **yes, and correctly absent** | V02-002 — a network-level failure has **no** request id, and `app.tsx` renders no dangling `Request ` line. The assertion is the *inverse*: the copy must contain no dangling label. |
| retry / recovery | **yes** | V02-002 recovery leg; V02-006 recovery-after-denial leg |
| no secret leakage | **yes, for stored records** | V02-004 canaries over 1.18 MB of `security_events` / `outbox_events` / `idempotency_records` / `users` / `sessions`, **with a positive control** |
| bounded retry | **no** | nothing drives a retry loop to its bound at an adapter |
| no duplicate side effect | **partly** | `verify:idempotency` proves a replayed mutation is one mutation; not tied to an injected fault |
| correct reconciliation | **no** | nothing drives a failure *after* a partial commit |

## What is deliberately not being done

**The blocked rows stay blocked.** V01-026 measured that the Worker cannot reach `127.0.0.1`,
`localhost`, or the machine's own routable address, so the blocker is the runtime and not the probe's
configuration. Widening a probe's reach to route around it converts a harness limitation into product
failures — the campaign has already made that mistake once and recorded what it cost.

**No SSRF guard is relaxed to make a row pass.** Where an endpoint host has to be named, it is named
through the documented allowlist, as `v01-provider-fault-probe.mjs` does.

## The three reachable rows, in order of value

1. ~~**Malformed response (5).**~~ **CLOSED in V02-010.** Client handling was already written and
   tested; the user-visible consequence is now measured, with a recovery control.
2. **Downstream disconnect (7).** Same boundary, different fault: the response begins and then fails.
   This is the one the objective lists that most resembles a real flaky network, and the loading/error
   distinction depends on it. Now the strongest remaining candidate.
3. **Bounded retry + reconciliation.** These two are properties of a *loop*, so they need a fault
   that repeats. That is the part of this section that will need a provider-shaped adapter, and it is
   the part most likely to remain blocked.

## A note on what "reachable" is worth

Reachable is not the same as cheap, and neither is the same as verified. Every row marked REACHABLE
here is a **claim about a fault I have not yet injected** — exactly the status of the eleven browser
states whose checks have never been watched to fail. The table's value is that it says which rows are
worth a run, not that they are done.