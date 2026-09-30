# V01-050 — a routed customer endpoint reads a table that nothing can ever write

**Severity: HIGH (customer-visible capability) · Status: OPEN by decision · Verdict: FAIL for the capability, PASS for the product's behaviour · Product: correct, and the feature is absent**

## The finding

`GET /api/v1/orgs/{org_id}/entitlements/provider` is routed, authenticated and org-scoped. It reads
`provider_entitlement_projections`:

```rust
// apps/api/src/routes/billing.rs:633  (inside read_provider_entitlements)
let rows = repository
    .list_provider_projections(&org_id)
    .await
    .map_err(|error| database_error(&context, error))?;
...
Ok((StatusCode::OK,
    Json(json!({ "org_id": org_id, "capability_class": ..., "items": provider_projection_items(&rows, &provider_kind) }))))
```

**The only `INSERT INTO provider_entitlement_projections` in the entire tree is inside
`upsert_provider_projection_statement`, which has no caller.** The table is created by migration
`0013_p06_billing_entitlements.sql` and never seeded. So `rows` is empty on every request, forever,
and the endpoint answers `200` with `items: []` on every call.

## Why this is a finding and not a note

It is the same read-half-live / write-half-dead shape this campaign has recorded three times — V01-046's
notification cluster, `record_provider_failure_statement`, and now this — and those two sit behind **no
route**. **This one sits behind a routed, authenticated, org-scoped endpoint.** That is the whole
difference between an architectural note and a customer-visible gap.

And it is **V01-030's shape on a customer surface**: a success status returned while the thing read can
never exist. Six rows once reported `PASS` while measuring the absence of a row rather than a refusal.
Here a *route* reports success while the table it reads is permanently empty, and **no assertion
anywhere could have distinguished that from correct behaviour** — a `200` with an empty list is what
correct behaviour looks like when a tenant has no provider entitlements, and the two are the same bytes.

No gate attacks it — and the reason is sharper than "an empty body passes a leak search".

`verify:collection-tenancy` **does** fetch this route (it is in the route list at line 147), and it
**does** carry a positive-match control. So the gate is not fooled wholesale. But look at what the
control asserts:

```js
alphaNeedles.length > 0 &&
  ownProjects.status === 200 &&
  alphaNeedles.every((v) => ownBody.includes(v))
```

It proves the *search mechanism* can find an identifier — **using `/projects`, not this route.** The
per-route verdict is "no foreign identifier appears in the body", and a body that can only ever be
`[]` satisfies that trivially.

**So: a positive-match control proves the needle can be found *somewhere*, not that every route's body
can contain one.** The gate is honest about its mechanism and silent about this route's content, and
its denominator counts the route as **covered**.

That is a generalisable verifier observation, and this probe's own comments say it is the **sixth**
time this campaign has hit a *negative assertion graded on an empty set*:

> "A positive-match control that passes when there is nothing to match is the same defect as a
> negative assertion graded on an empty set."

**A per-case leak assertion is graded on the absence of a needle. A body that can never contain one
satisfies it — and the control that defends the gate defends the aggregate, not the case.** The
defence against that is a per-route *non-emptiness* control: for each collection route, assert the
response is not trivially empty before its leak verdict means anything. That is a change to a frozen
gate's design, so it is recorded here as an observation about the gate rather than applied to it —
and it applies to every collection route, not only this one.

**This is a source reading, not a measured false pass:** the route is in the list, the control targets
`/projects`, and the per-route assertion is a "no foreign id" search. Running the gate green is
consistent with all three, which is the point.

## What is *not* wrong

The product is correct in every respect it is specified to be:

- the endpoint is org-scoped and authorised;
- it fails closed on a store error (`database_error`), rather than returning an empty list;
- `provider_projection_items` is a pure projection with no permissive default of its own.

The absence is a **feature** gap, not an implementation defect, and it is the same decision the
campaign already has open twice: **where does a provider entitlement projection come from?** There is
no `billing.sync` job consumer — the one named in `apply_provider_callback`'s doc comment does not
exist — and no provider-event ingest route.

## Why it is left unrepaired

Wiring the write means deciding **which events are eligible to produce a projection**, **whether
provider-sourced data may reach a customer-visible surface at all**, and **what happens to a
projection when its source event is later revoked** (a stale projection is a customer being told they
have a capability they lost, or the reverse). Those are feature decisions that need their own spec, and
editing `f18` to match the code is the one move this campaign is forbidden to make.

It is **fail-closed**: the endpoint returns nothing rather than something wrong. Nothing is disclosed
that should not be, and no money moves. The cost is a capability that does not work.

## The state of the family, now bounded

| | read half | write half | behind a route? |
|---|---|---|---|
| V01-046 notification cluster | `list_entitlement_definitions` covered by a sibling | **dead** — `insert_notification_statement`, `insert_notification_delivery_statement`, `fan_out_event_statement`, `fan_out_count` all uncalled | no |
| `provider_sync_state` failure columns | `seed_ledger` never reads them | `record_provider_failure_statement` uncalled, and its only would-be caller is itself dead | no |
| **V01-050 provider projections** | `list_provider_projections` **live, 2 call sites** | **dead** — the only INSERT is uncalled | **yes, a routed customer endpoint** |

**The read half being live is what makes the third row a finding.** In the first two, nothing depends
on the dead write. In the third, a shipped endpoint does.

## The liveness check is why this was found at all, and how

`security::repository_liveness` listed `upsert_provider_projection_statement` as `UNTRIAGED`. Triaging
it was mechanical: locate the function, find its SQL, count callers. **The triage was the detector** —
no mutation, no probe and no gate was needed to find a HIGH customer-visible gap.

The check has now taken this list to **zero `UNTRIAGED`**. That number is not a coverage claim: it
says every uncalled repository function carries a recorded reason, and it is only as good as those
reasons. Four of the fifty-three reasons written during this campaign were **wrong on arrival** and had
to be corrected by reading the product — which is the standing lesson below.

## The standing lesson, because it happened three times this session

I formed a Tier-0 hypothesis — *"an organization can never be suspended"* — from **one** grep result
showing a similarly-named function uncalled, and was about to write it up. The live function is
`update_state_statement`; `update_state` is a documented retained primitive; and
`POST /api/v1/orgs/{org_id}/suspend` is routed and live.

The same shape twice more:

- **V01-048**: found the `changes()` guard at line 1876, saw it gated on `scope.managed_run`, and
  generalised to "the pattern is managed-only" — without checking the first instance, sixteen lines
  earlier, which is ungated and load-bearing.
- **the `routes/` scan**: a shell scan reported 5 unrouted handlers where the compiled check found 5
  but with a *different membership* — three false positives (intra-file delegates) and three misses.

**A product fact inferred from a single search result about a similarly-named symbol is a hypothesis,
and the cheapest thing to do with a hypothesis is to read the sibling.** Both false alarms cost more
than the triage that corrected them, and one of them nearly became a written Tier-0 finding.
