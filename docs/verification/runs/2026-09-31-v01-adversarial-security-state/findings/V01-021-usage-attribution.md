# V01-021 — usage attribution: PASS, and a refusal shape that lied about being an outage

## Status

**the attribution claim PASSES** (43/43, exit 0), with **no SKIPs** — the `run_id` leg is closed and
the **one previously reported result in this record was wrong** and has been corrected. Two adjacent
defects found and **repaired**: a refusal reported a `503`, and a non-disclosure check in this
probe passed **vacuously**.

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
| **Regression gap** | **none remaining.** The `run_id` case was SKIPPED in the first version of this probe and is now closed: a real managed run is built per organization and named across the tenant boundary. |
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

---

# Addendum — the SKIP is closed, and this record contained a wrong result

**43/43, exit 0, no SKIPs.** Both halves of the addendum are about the *verifier*, because the
product was correct in every case. That is the point of writing them down: the previous version of
this record reported a result that was true of the probe and false of the product.

## 1. A reported result was measuring my own malformed request

The two cases that name another organization's `project_id` and `run_id` were recorded as
**`422 validation_failed`, zero usage rows, "refused"**. That was wrong in a way that mattered:
**the 422 was my own bad request**, and "refused with nothing written" was asserted as a result.

`/api/v1/inference/responses` deserialises `NativeRequest` — `messages`, each with a `content`
**array** of `{type, text}` parts. The probe sent `input: [{role, content: "..."}]`, which is the
Chat Completions shape. The route answered a correct `422`, and the assertion "refused, or answered
without spending Bravo's budget" passed on it.

**A route that rejected every request would have passed those two cases.** There was no control to
say otherwise, which is the gap the campaign's own rule — *a positive control per case, or "refused"
is uninterpretable* — exists to close, and which I had applied to other probes and not here.

The repair is in the probe, not the product:

- the body shape is now stated **once**, in `nativeBody(..)`, so the managed leg, the escalation and
  the control cannot drift apart again;
- **every** escalation case now makes the same request **without** the foreign identifier first and
  requires a `2xx`. Only then is a refusal attributable to the identifier.

With both in place the three escalations read, and every control answered `200`:

| Alpha names | result | usage rows | what it means now |
|---|---|---|---|
| Bravo's `project_id` | `403 permission_denied` / `model_not_allowed` | **+0** | a real refusal, and the same fact `policy.allows_alias` reports |
| Bravo's `run_id` | `404 not_found` / `run_not_found` | **+0** | the run resolves inside Alpha's org and is not there |
| Bravo's model alias | `403 permission_denied` / `model_not_allowed` | **+0** | the V01-021 repair, unchanged |

**The numbers improved and the claim did not change**, which is the only reason to believe the
numbers now.

## 2. The managed run, and the four fixture traps on the way to it

`run_id` is only reachable through a **managed** run, so each organization now gets a real one:
enrollment → approval → device proof → binding → agent session → `POST .../runs` with
`execution_mode: "managed"` → `start`. `p05-smoke` already proved the sequence; no probe reused it,
which is why the leg was SKIPPED. Four things were wrong on the way, and each is a trap rather than
a bug:

1. **Device mutations require an `Idempotency-Key`.** `POST /api/v1/devices/sessions` answers a
   correct `400 idempotency_key_required` without one. The fixture's controls reported *"no managed
   run"* — they said something was **absent** and never said **why**, which cost a run. A control
   that reports *what is missing* is worth more than one that reports only that something is.
2. **A managed run cannot execute without a persisted model policy.** `run_inference` refuses any
   managed scope whose org has no `org_model_policies` row, with `model_not_allowed` — correctly,
   since a managed run must not fall back to the environment's test seam for authority. The route
   that creates one is `PUT /api/v1/orgs/{org}/policy`.
3. **Publishing a policy changes the *unmanaged* path too.** The record replaces the environment
   fallback for *every* request, not only managed ones, so the fixture has to restate the fallback
   (`platform_or_organization`, which is what `policy_from_record` returns for an org with no policy
   in development) or it breaks the very control inferences it is enabling. Both `platform_only` and
   `organization_only` refused the route with `route_unavailable`.
4. **An empty allowlist is an allow-*nothing* set.** `allows_model` and `allows_provider` test
   `values.contains(x)`, so `[]` denies every provider and model; only `None` is unrestricted — and
   the `PUT` always serialises an array, so **"unrestricted" is not expressible through this
   endpoint**. The policy must name the provider and model the route uses.

The managed leg now writes usage rows that carry a `run_id` — **2 of 4 rows** — and the probe
asserts that count is non-zero, because the internal-consistency invariant's `run_id` clause grades
nothing when no row names a run. That is the third time this campaign has built a check that could
pass on an empty set.

## 3. A new check of my own passed vacuously, and the fix is a check on the check

The objective asks that denial "not leak unintended existence", and a foreign `run_id` answers
`404` — so I added a non-disclosure control: name a **well-formed but absent** run id and require an
indistinguishable answer.

**It passed on the first run, for the wrong reason.** The helper was `async` and I did not `await`
it, so both sides of the comparison were `Promise` objects, `foreignRun.status` and
`phantomRun.status` were both `undefined`, and `undefined === undefined` is `true`. The log line I
had already printed said `undefined/undefined` and I read past it.

This is the **fourth** vacuous pass in this campaign and the **second** where the failure was
plainly visible in output I had already seen. The rule is now in the probe as an assertion:

> grade the **inputs** of a comparison before grading its **verdict** — if either side's status is
> not a number, the helper's result was never awaited and the comparison is `undefined === undefined`.

Graded for real, the two answers are the same:

```
non-disclosure: a real foreign run -> 404/run_not_found, a run that never existed -> 404/run_not_found
```

so the `404` is **not** an existence oracle: a caller cannot tell another organization's run from a
random 32-hex id, and cannot enumerate runs by probing.

## 4. Root cause, in one line

**verifier weakness**, in all four parts. No product defect was found in this addendum, and that is
recorded as plainly as a repair would be: the product refused every foreign identifier, wrote zero
usage rows for each, and answered the phantom run identically to the real one. What was broken was
the instrument, twice in the same record — once reporting a refusal that was really a malformed
request, once reporting a proof that graded nothing.

## 5. The gate can fail — and the mutation found the load-bearing assertion

`evidence/v01-usage-sensitivity.sh`, **exit 0, both mutations DETECTED**. A gate nobody has watched
fail is an assumption, and this one had just gained two new Tier-0 assertions.

### M1 — `find_run` binds `org_id` but no longer filters on it

`AND org_id = ?2` becomes `AND ?2 = ?2`: the placeholder stays, so the statement stays valid, and
only the scoping goes. A foreign run now resolves and is refused for a different reason:

```
a real foreign run        -> 403 / resource_scope_mismatch
a run that never existed  -> 404 / run_not_found
```

**The escalation case still PASSED.** Exactly one assertion failed out of the whole sheet, and it was
the non-disclosure one. That is the finding, and it is worth more than the detection:

> "Alpha naming Bravo's `run_id` is refused, or answered without spending Bravo's budget" accepts
> **any** non-2xx with zero usage rows — so it is blind to *which* refusal, by construction. The
> objective's "prove denial does not leak unintended existence" is therefore defended by a
> **different and single** assertion from the one that proves the run is refused at all. Under this
> mutation the product leaked — any caller could distinguish another organization's run from a
> random id and enumerate — and the escalation reported success.

If the non-disclosure control had not been added, this gate would have gone on reporting a clean
`run_id` boundary while the boundary was gone.

### The first M1 was invalid, and it is the more interesting half

The obvious edit — deleting `AND org_id = ?2` — is the **wrong** mutation, and it produced a clean
looking **MISSED**:

- the bind list still had two values and the SQL one placeholder, so D1 refused the statement;
- `find_run` then raised `run_state_unavailable`, and **both** probes answered `503`;
- identical answers, so the non-disclosure control **passed**, and the run reported the mutation
  undetected.

A gate reporting a correct-shaped pass on a build that cannot execute the query at all is the "a
verdict is only worth what its reference is worth" class reached from the other side: the reference
was **broken** rather than wrong. It is the same bind-count trap the tenant audit keeps finding —
here from the other direction, a dropped predicate with an untouched bind list — and it cost one
6-minute run to learn. `assert_changed` could not have caught it: the file *had* changed.

So the rule earns its place: **a mutation must break the claim, not the statement.** A predicate
removal that also removes a placeholder tests SQLite's bind checker, not the tenant boundary.

### M2 — the usage row stops naming its run

The `run_id` bind becomes `BindValue::Null`, unconditionally. Nothing fails: every inference still
succeeds, and org, project, principal and credential attribution all still look clean, because the
row simply no longer names a run. The probe's "at least one usage row carries a `run_id`" control
**DETECTED** it.

That control is the whole reason the run leg of the invariant is trustworthy. Without it, this
mutation turns the objective's `run` clause into an assertion over an empty set — which is the
third vacuous pass this campaign has produced and the first one *prevented* rather than discovered.


