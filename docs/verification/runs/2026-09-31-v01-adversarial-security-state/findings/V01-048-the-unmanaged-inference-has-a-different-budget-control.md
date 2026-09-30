# V01-048 — the unmanaged inference has a *different* budget control, and nobody had measured it

**Severity: HIGH (money) · Status: CLOSED for the behaviour, UNPROVEN for the sensitivity · Verdict: PASS with a declared gap · Product: correct on every run measured**

## The claim, and it is two of the objective's five named budget requirements

> 1. "hard denial before upstream dispatch"
> 5. "unavailable authoritative budget state follows spec"

Neither had any runtime evidence. `verify:budget-concurrency` is 28/28 and 34/34 elsewhere, and
every one of those drives the **managed** path.

## The structural finding

`run_inference` puts the budget admission, the rate admission and the entire P05 block inside one
conditional:

```rust
// apps/api/src/routes/inference.rs:1555
if let Some(project_id) = managed_project_id {
    ...  p05_rate_admission(...)
    ...  p05_budget_admission(...)          // <- guarded by P05_BUDGET_SNAPSHOT_LIMIT
}
else {
    // "the caller is explicitly on the P04/local compatibility path"
    match repository.hard_budget_remaining(&org_id, now).await {
        Ok(Some(remaining)) if remaining < reservation_minor =>
            return Err(gateway_error(&context, "budget_exceeded")),
        Ok(_) => {}
        Err(_) => return Err(gateway_error(&context, "budget_state_unavailable")),
    }
}
```

So there are **two code paths**, and an ordinary inference — one with no `run_id`, which is most
traffic — takes the `else`. Its only budget control before the write is a single comparison against
`hard_budget_remaining`, and its only budget work is:

```rust
// INSERT_BUDGET_RESERVATION_IF_AVAILABLE_SQL
... WHERE NOT EXISTS (
      SELECT 1 FROM budgets b
       WHERE b.org_id = ?3 AND b.hard = 1
         AND b.period_start <= ?6 AND b.period_end > ?6
         AND b.limit_minor - usage - reserved < ?4)
```

**The entire enforcement is "this INSERT matched a row."** An INSERT matching *zero* rows neither
aborts a D1 batch nor raises an error — the V01-042 shape, and the reason V01-043 had to add a
`find_quarantine` for the same thing on the UPDATE side. That made this the highest-value unmeasured
money path in the product.

## The measurement, and the product is right

`pnpm verify:budget-hardceiling` — **25/25, exit 0**, stable over three consecutive runs:

```
CONTROL (no hard budget)  -> 403 credential_unavailable, reservations 0->1
ATTACK  (exhausted hard)  -> 403 budget_exceeded,        reservations 1->1, usage 0->0
rows ADDED by the attack: [] dispatched=0
```

The refusal happens, **no reservation is held**, and **no inference row the attack added reached a
dispatched state** — `response_state` is a closed vocabulary that does not include "pending", and
`not_dispatched` is the one that means the request was refused before going out.

Six controls, because a `403` is a statement about a *response* and every assertion here could be
satisfied by a route that never consults a budget:

| | control |
|---|---|
| B1 | no hard budget ⇒ the same request **does** take a reservation. This is the "was it called?" instrument, and without it a refusal from a route that refuses everyone would satisfy everything |
| B2 | the hard budget exists, its limit is below the reservation, **and the product's own ceiling predicate says DENIED** — checked against the rule, not against the probe's belief |
| B3 | the reason is specifically `budget_exceeded` |
| B4 | reservations and usage read from D1 |
| B5 | no row the **attack added** reached a dispatched state, **plus a control that the control did dispatch** — otherwise "added nothing" is satisfied by a route that records nothing |
| B6 | a second organization with no hard budget is not refused, so it is one org's ceiling and not an outage |

## Four controls that were wrong for the wrong reason

Each is now the lesson it taught, and each was caught by a mechanism rather than by reasoning.

1. **B1 asserted only "not `budget_state_unavailable`"**, and a malformed content part answers
   `422 content_unsupported` **before** the budget check — so the control and the attack were both
   satisfied by a request that never reached a budget at all. **A control must exclude the refusals
   that happen *before* the thing under test, by name.** This is the second time this one probe made
   that mistake.
2. **The applicability control paraphrased the product's predicate** and dropped
   `b.period_start <= ?2 AND b.period_end > ?2`, counting **129** rows while the product's query
   saw **one** — and its budgets used distinct *historical* days, so at most one was applicable at
   all. **A control has to answer the same question the product answers.**
3. **`allowed_models: []` is an empty list, not an absent field**, and
   `CatalogPolicy::allows_model` tests `allowed_models.as_ref().is_none_or(|v| v.contains(id))` —
   so an empty array permits **nothing** while an *absent* field permits everything. An empty array
   is the **opposite of unrestricted**, and every field of that request was individually valid.
4. **Four closed vocabularies in one fixture**, each named by its own refusal: content part type
   (`text`, not `input_text`), `credential_mode` (`platform_only`, not `platform`), provider adapter
   (`mock`, not `openai`), model capability (`text`, not `chat`). Plus `managed_route_enabled: false`
   disabling a policy that still persisted its allowed alias, and `version: 1` on a create meaning
   *"I read version 0"* rather than *"this is a create"*.

A fifth lesson, from aiming at the wrong statement: **the migration ledger already seeds four mock
providers with models and endpoints.** I built a fifth provider and a fifth model through
`POST /catalog/providers`, got rows that each looked right, and still got `route_unavailable` —
which `route_error_reason` masks under a catch-all `_ =>`, so the reason said nothing. **A fixture
should use what the platform already ships**; a hand-built catalog entry is a second thing to get
right for no benefit.

## The sensitivity run, and the UNPROVEN in it

**M1 DETECTED, 4 declared MISSED** (`evidence/v01-budget-hardceiling-sensitivity.sh`, restored tree
25/25). M1 removes the probe's own fixture so there is no ceiling to detect.

M2, M3 and M4 are all **MISSED, and that is the point rather than a shortfall**:

- M2 removes the application precheck (`hard_budget_remaining`) — still refused.
- M3 removes the SQL ceiling — still refused.
- M4 removes **both** — still refused.

One candidate for the third guard was checked and is **not** it: line 1876 compares
`D1Adapter::changes(&initial_results[2]) != 1` and refuses with `budget_exceeded`, which is exactly
the rows-affected shape the class asserts — but it is gated on `scope.managed_run`, so it does not
execute for an unmanaged request.

**So: the product is right, and the gate has not been shown to notice if the control were removed.**
That is recorded as UNPROVEN, not as a pass, because manufacturing a mutation that happens to go red
would produce the appearance of sensitivity without the substance.

**What is established, and it is worth stating plainly:** every single control this script could
remove, it removed, and the request was still refused with no reservation and no dispatch.

## Two false verdicts the script produced first

Both are worse than a weak gate, because both would have been reported as successful detections.

- **Weakening the arithmetic is not disabling it.** `< ?4` → `< ?4 + 1e18` makes the threshold so
  large that EXISTS matches a row for *every* budget, so the INSERT matches **nothing**, so the
  request is refused — which is precisely what the class asserts. The mutation inverted the control.
  **Only the second kind is a defect.**
- **A broken mutation and a flaky start both read as a detection.** Renaming the pattern binding to
  `_remaining` broke the **build** (`E0425` — the binding is used later in the same match arm), the
  harness exited 2, and the script reported DETECTED. Separately, `pkill` returns as soon as the
  signal is delivered, so removing the persist directory three seconds later raced a live miniflare
  recreating it: two `exit 2, no sheet` flakes, also read as detections. The script now discriminates
  a rustc diagnostic in the Worker log and reports `INVALID`, and `settle_worker` polls until
  `workerd` is gone.

## The follow-up this leaves, stated rather than implied

There are at least three guards on this path and this campaign has isolated two. **The unmanaged
budget path deserves a deliberate read** — not because anything is known to be wrong, but because
"the guard we did not find" is the only remaining place a money defect could be hiding on the path
most traffic takes. Until then the honest status of this class's *sensitivity* is UNPROVEN and of its
*behaviour* is PASS.
