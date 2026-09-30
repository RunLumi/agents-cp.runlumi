# V01-049 — the liveness check cannot see an unrouted handler, and a scan of `routes/` over-reports

**Severity: MEDIUM (verifier blind spot) · Status: CLOSED (measured, recorded, and the check extended) · Verdict: PASS on the product, the campaign record corrected**

## Where this came from

Triaging the entitlement-provisioning cluster. `seat_policy_for_plan` turned out to be a second
*derivation* of the seat policy rather than a dead writer, which made me ask the question the
repository check cannot ask: **what about a handler that is written and never routed?**

`repository_liveness` scans `repositories/`. A `pub` handler in `routes/` is structurally invisible
to it — and `pub` in a `pub(crate)` module chain is exactly the shape of a capability that looks
complete.

## The measurement: five orphans out of 266, and a hand-written scan got the number wrong twice

**266 `pub` handlers across `apps/api/src/routes/`. Five are unrouted and uncalled. All five are
diagnosed; none is a security gap.**

My first attempt was a shell scan, and it was wrong in **both** directions before the compiled check
replaced it:

- It **over-reported** three handlers (`budgets::patch_budget`, `budgets::put_rate_limit`,
  `ai_catalog::usage`) because it excluded each whole file rather than the definition line.
  `update_budget` is a **one-line delegate**:

  ```rust
  pub async fn update_budget(/* ... */) -> ... {
      patch_budget(state, context, headers, path, body).await
  }
  ```

  so `patch_budget` is the *implementation* of a routed `PATCH /budgets/{budget_id}`. A reader who
  trusted that number would have gone looking for a missing budget-update capability that does not
  exist and is fully wired.

- It **under-reported**: it missed three real orphans the compiled check found.

**A scan that excludes a file reports every intra-file delegate as uncalled, and the error direction
is toward false findings** — which is the expensive direction here, because a false "capability wired
to nothing" is convincing enough to send someone into the product looking for a feature decision that
was never needed. And a shell scan and a compiled check disagreeing on the count is the strongest
argument there is for the check being a check.

### The five

| | handler | diagnosis |
|---|---|---|
| 1 | `billing::create_internal_override` | *"A SUPPORT/SERVICE entry point, deliberately not a browser route."* The DB `CHECK` independently refuses an override lacking an expiry, a reason or a granting principal, and a unique active-override index refuses a second unrevoked override. **This is V01-040's implementation.** |
| 2 | `billing::apply_provider_callback` | Its doc says it is consumed by the `billing.sync` job consumer or a provider webhook route; **neither exists**, and even inside it there is no failure branch. See below. |
| 3 | `organizations::audit` | **A third implementation of the same route.** The router wires `audit::audit`, whose own doc calls itself a *"compatibility entry point"* delegating to `audit::list`. So the live surface is a shim over the canonical body, and this is an independent third body with its own `authorize_org` and no delegate. **Two independent bodies for one read, and only one is exercised.** |
| 4 | `ai_catalog::get_policy` | **A real asymmetry, not a duplicate.** `ai_catalog::update_policy` is routed (`PUT /orgs/{org_id}/policy`) and this read of the same row is not — a customer can write an organization model policy and cannot read it back through the module that wrote it. The product is unaffected: `resolve_effective` and the inference path read it through `AiRepository::find_policy`. |
| 5 | `ai_catalog::usage` | Superseded. The router serves `usage::usage_summary`, `usage_rollups` and `usage_denials` from the dedicated `usage` module; this is the same derived-totals read left behind when the surface was split. |

So the routes surface is in good shape — **but not the shape my scan said it was in**, and three of the
five are facts about *divergence* rather than absence: two audit bodies, a write with no read, and a
capability whose only would-be failure path is behind a dead handler.

## The finding that did come out of it: a capability with no producer and no consumer

Triaging `record_provider_failure_statement` (also `UNTRIAGED`) surfaced a shape the campaign has
not recorded before.

`provider_sync_state` carries `consecutive_failures` and `last_error_code`. The only writer any code
reaches is the **success** writer, whose `ON CONFLICT` sets:

```sql
consecutive_failures = 0,
last_error_code     = NULL,
```

So on every row the platform can write, those columns are **structurally 0 and NULL**. The reader
agrees — `seed_ledger` (`routes/billing.rs:1849-1851`) reads only `last_event_id`,
`last_event_version` and `last_event_at`.

**The reason is structural, and a reader who saw only the missing caller would get the diagnosis
wrong.** The live path is `cancel_subscription` → `provider_transition_batch` →
`record_provider_success_statement`. The handler that would have recorded a failure is
`apply_provider_callback`, which is *itself* unrouted and uncalled — **and even inside it there is no
branch that calls the failure writer**, so the absence is not one dead call away from being fixed.
There is no `billing.sync` job consumer; the one named in the doc comment does not exist.

**A capability can be unwired at the bottom and have every layer above it look complete.** Every
previous instance of this class (V01-040, V01-043, V01-046, V01-047) was wired at the top and dead at
the bottom. This one is dead at the bottom, and the layer above it is *also* dead, and the layer
above that is a routed `POST` that works.

**Not a defect:** nothing depends on those columns, and no requirement names them. Recorded because
the *shape* is new and because a `grep` for callers produces a confidently wrong story.

## A correction to V01-040

The campaign record describes V01-040's grant-use half as *"not implemented"*. That is materially
imprecise. **`create_internal_override` is the implementation** — written, authorisation-checked,
constraint-backed by both a `CHECK` and a unique active-override index, and **deliberately** not
routed. The missing piece is the *surface and its authorisation*, not the design.

That changes what the deliberate change process is being asked for: not "design a staff grant
use", but "decide where staff access to customer context is surfaced and who may exercise it" — a
smaller and more tractable question than the one currently on the books.

## The check, extended

`security::repository_liveness` gained a `routes/` dimension: every `pub async fn` in
`apps/api/src/routes/*.rs` must either appear in `app.rs` or have a non-test caller, **or be on a
new `REVIEWED_UNROUTED` list with a reason**. The list starts with the five above, and the check
asserts its own non-vacuity — that it read at least 200 handlers and that the list is not empty —
**before** reporting a verdict, because a scan that read nothing would otherwise pass and claim the
class closed.

**A blind spot in a standing check is a claim the check is making about the whole of `repositories/`
that is quietly false.** This one now has a name and a list.
