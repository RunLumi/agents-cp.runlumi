# V01-048 — the unmanaged inference has a *different* budget control, and nobody had measured it

**Severity: HIGH (money) · Status: CLOSED · Verdict: PASS, sensitivity PROVEN · Product: correct on every run measured**

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

## The sensitivity run: three guards, and the one I had not found

`evidence/v01-budget-hardceiling-sensitivity.sh` — **2 detected, 2 declared MISSED, restored tree
25/25.**

| | guard | removed by | result |
|---|---|---|---|
| 1 | `hard_budget_remaining(&org_id, now) < reservation_minor` (`inference.rs:1663-1666`) | M1 | MISSED |
| 2 | `WHERE NOT EXISTS (...)` ceiling in `INSERT_BUDGET_RESERVATION_IF_AVAILABLE_SQL` | M2 | MISSED |
| 3 | `changes(&initial_results[1]) != 1` -> `budget_exceeded` (`inference.rs:1834`, **ungated**) | M3 | **DETECTED** |
| — | the probe's own fixture builds no ceiling | M4 | DETECTED |

M3 removes **all three**, and its failures *are* the breach: **B4 — "and NO reservation is taken" —
FAILED**, meaning a reservation *was* taken against an exhausted hard budget. That is the money defect
the class exists to catch.

**Guard 3 is the V01-042 shape handled correctly.** `initial_results[1]` is the reservation statement
(`initial_statements = vec![request_statement, reservation_statement]`), so the guard reads the
INSERT's rows-affected and refuses when it did not match exactly one row. An INSERT matching zero rows
neither aborts a D1 batch nor raises an error, so **the only way to notice is to read `changes()`**.
That is why B4 asserts the stored count rather than the status.

The two MISSEDs are a property of the **product**, not a weakness of the gate: each single guard is
sufficient on its own, so removing any one leaves the other two standing. That is defence in depth,
*measured* rather than assumed — and it is only visible because a mutation that removes one layer at
a time is run before the one that removes them all.

## How I missed guard 3, which is the part worth keeping

The first version of this record ruled guard 3 out. I had found the `changes()` pattern at
`inference.rs:1876`, saw that it was gated on `scope.managed_run`, and concluded that rows-affected
checks on this path were managed-only. **I then never checked whether the first instance was gated at
all.**

One gated example was enough to generalise about a pattern, and the generalisation was wrong by one
line. Guard 3 sits **sixteen lines earlier** and is ungated.

**A pattern inferred from a single instance is a hypothesis, and the cheapest thing to do with a
hypothesis is to read the other instances.** That takes a minute. This campaign has been paid
several times this session for not doing it — the plugin fixture took five attempts because I read
the route's response shape by guessing instead of reading, and every one of those attempts was
answered by a line of code that was already on screen.

The mutation that found it was M3, written on the assumption that two guards existed. It came back
MISSED, and the correct response to a MISSED that contradicts your model of the product is to **read
the product**, not to write a fourth mutation.
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

## What remains

Nothing on this path is known to be wrong, and the sensitivity of the class that covers it is now
proven rather than asserted: removing every control it can reach produces the breach it is built to
catch. The three guards are mapped, each is individually sufficient, and the rows-affected check that
makes the SQL ceiling's silence observable is present and ungated.

The residual is the ordinary one: guard 3 is `changes(&initial_results[1]) != 1`, so a batch that
matched **more** than one row would also be refused. That is not a defect — the reservation is keyed
by `request_id` and cannot match twice — but it is the kind of fact worth knowing before someone
relies on it.
