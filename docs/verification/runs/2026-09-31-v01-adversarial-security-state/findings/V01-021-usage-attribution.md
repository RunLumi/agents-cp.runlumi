# V01-021 — usage attribution: PASS, and a refusal shape that lied about being an outage

## Status

**the attribution claim PASSES** (31/31, exit 0). One adjacent defect found and **repaired**:
a refusal reported a `503`.

## Severity of the attribution claim itself

**none — it holds.** This is the objective's budget item 4 ("usage attributed to correct
org/project/principal/run"), and it had **no evidence at all** before this: `verify:budget-concurrency`
proves the *ceiling*, `verify:inference-failure` proves the *money is released*, and neither ever
asked **whose** usage it was.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-BUDGET-004` (new) |
| **Setup** | a real `wasm32` Worker and fresh local D1. **Two** organizations, each with a real owner, a hard organization budget, a real project, a real credential against the `mock-success` provider, and a real published single-candidate route with its own alias. |
| **Action** | one real inference in each organization; then read every `usage_events` row and check it is **internally consistent**; then have **Alpha name Bravo's** `project_id`, `run_id` and model alias; then search every row Alpha wrote for **any** Bravo identifier. |
| **Expected** | every usage row's project, principal, credential and run belong to the org the row names; each org charged to its own alias; and no row written by Alpha names anything of Bravo's. |
| **Actual** | **exactly that.** 31/31, exit 0. `NO row written by Alpha names ANY of Bravo's identifiers — its org, project, credential, alias, run or user — 1 Alpha row, none naming Bravo`. |
| **Evidence** | `evidence/v01-021-usage-attribution.txt` |
| **Verdict** | **PASS** on attribution. **FAIL, repaired** on the shape of a refusal (below). |
| **Regression gap** | the `run_id` case is **SKIPPED**, named: Bravo produced no run to name. See the gap below. |
| **Severity** | none for the claim; **medium** for the refusal shape |

## Why the invariant is the assertion, and not a status

The load-bearing check reads D1, not responses:

> for every row in `usage_events`, the `project_id` it names belongs to the `org_id` it names, its
> `principal_user_id` is a **member** of that org, its `credential_id` belongs to that org, and its
> `run_id` belongs to that org.

A cross-tenant attribution is invisible to every status code — the request succeeds, the response
is a perfectly good `200` — and it may live in a repository three layers below the handler. This is
the same discipline as `verify:idempotency`'s row counts, and it is why the probe is worth more than
the code reading that preceded it.

**And the code reading was itself worth recording, because it is what made the attack worth
running.** It said, specifically:

- `RequestScope.project_id` is built from `effective_project_id`, which is the **managed run's**
  project or the **trusted policy snapshot's** — never `request.project_id`. A caller's body
  cannot reach attribution at all.
- a caller-supplied `run_id` forces `resolve_managed_run_scope(.., &principal, &org_id, ..)`, so
  the run is resolved *inside the caller's org*, and the project is then overwritten with the run's
  own;
- the alias goes through `policy.allows_alias` and an **org-scoped** `find_route_by_alias`.

That is a good design — and V01-008's placeholders, V01-011's 33 values against 34 columns and
V01-013's missing `SET` entry all read as fine too. **The reading was the hypothesis, not the
finding.**

## The defect the attack did find: a refusal that reported an outage

Naming another organization's model alias answered:

```
503  code=service_unavailable  details.reason=route_unavailable
     message="The inference request could not be completed."   (usage rows +0)
```

No money moved and nothing leaked, so the security claim held. But a client that named a model it
is not entitled to is told **the inference service is down**, for a condition it caused and can fix.
It will retry, back off, and page someone. That is the V01-010 and V01-019 family, in the one place
the objective names explicitly — *"model alias/route"*.

### The cause is two catch-alls deep

`gateway_error` maps a hand-written list of reasons to specific codes and sends **everything else**
to `ServiceUnavailable`. Separately, `route_error_reason` has its own `_ => "route_unavailable"`
arm — so **any** `RouteSelectionError` the product does not enumerate also arrives as
`route_unavailable` and becomes a `503`.

So the safety of the entire reason→code mapping depends on a list nobody can check at compile time,
and the one condition the product detects *routinely* — a caller naming an alias their org has no
route for — was the one missing from it.

### The repair, and what it deliberately does not do

The org-scoped lookup now raises `model_not_allowed`, which the same function already maps to
`PermissionDenied`. The client gets **`403 permission_denied`** instead of `503`. It is the same fact
`policy.allows_alias` reports one line above, so no new vocabulary is involved.

The **other eight** `route_unavailable` sites are left alone on purpose. For them the question is
genuinely different — a route that exists but is not published, a missing active version, a config
that does not parse — and those are server-side states where `503` is defensible. Reclassifying nine
sites on the strength of one measurement would be guessing, and guessing is how V01-008 and V01-011
happened.

### The regression test forces a *decision*, not a shape

The first version of the test demanded that **every** reason map to a 4xx. It failed, and it was
wrong: `request_timeout`, `upstream_invalid_response` and `budget_state_unavailable` are correctly
5xx, and insisting otherwise would have been its own kind of error — including a wrong one about
`budget_state_unavailable`, which the objective requires to be *refused* rather than guessed at.

So the test classifies every reason into one of two lists, with the reasoning written down:

- **`CLIENT_CORRECTABLE`** → must be a 4xx. A client told "unavailable" for something it did will
  retry and alert.
- **`LEGITIMATELY_TRANSIENT`** → 503 is honest: a timeout, an unparseable upstream response, an
  unreadable authoritative budget, a rate limit, a cancellation, and a route that exists but cannot
  serve.

Anything in **neither** list fails the test. So a new reason cannot be added without somebody
deciding whose fault it is — which is the decision that was skipped when `route_unavailable` was
handed to a lookup the *caller* controls. A second test pins the specific repair and **was verified
to fail** when the defect is re-introduced.

## The one SKIP, and why it is named

**Alpha naming Bravo's `run_id` was not exercised.** Bravo's inferences were plain chat completions,
which create no run, so there was no foreign run to name. Writing the row by hand would have been
easier and would have tested less, so it is reported as a skip rather than dropped — an unread
assertion is an unmeasured claim, and a silent drop shrinks the denominator without saying so.

**The gap is real and it is the more interesting half of the objective's item**, because the `run_id`
leg is the only one that goes through *resolution* rather than through a body field the server
ignores. Exercising it needs a **managed** run: a real device, an agent session, and
`POST /api/v1/devices/runs`, none of which any current probe builds. Recorded as a gap, not as a
pass.
