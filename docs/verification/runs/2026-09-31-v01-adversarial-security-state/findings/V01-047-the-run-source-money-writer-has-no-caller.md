# V01-047 — the second money source is a commitment with no writer, and the code pretends it exists

**Severity: HIGH (money) · Status: OPEN, deliberately unrepaired · Class: built-but-unwired (V01-040/041/042/043/046) · Product: the inference source is correct; the *second* source is inert**

## The claim

`P05-CR-002` §7, **status accepted**, commits in the present tense:

> P04 `usage_events` remains the immutable inference source and keeps its request-scoped foreign key.
> **Non-inference run usage is stored in an additive `run_usage_events` source table** with the same
> normalized usage/cost envelope and explicit `source='run'`; it is not a second reservation authority.
> **Both sources feed the same read-only summary/rollup queries.**

and §8:

> P05 `run_usage_events` is additive and **must use the same cost/pricing/reconciliation rules**.

So there are two usage sources, one writer each, and one read path over both. That is the design.

## What exists

| piece | state |
|---|---|
| `run_usage_events` table, with its append-only trigger | migrated |
| `RUN_USAGE_EVENT_SOURCE_SQL` — the normalized projection branch | written |
| `list_usage` / `summarize_usage` — `UNION ALL` of **both** sources | wired and called |
| `insert_run_usage_statement` — the **writer** | **no caller** |
| `is_run_source()` — `self.source == "run"` | **called from 6 sites** |
| `insert_run_cost_record_statement`, `assert_run_cost_record_statement` | **called, and unreachable** |

`insert_run_usage_statement` has **zero non-test callers**, and `UsageSource::Run` appears in
production code at only three sites — all of them *reads* or *branches*:

```
apps/api/src/modules/usage.rs:607    if self.source == UsageSource::Run && self.run_id.is_none()  (validation)
apps/api/src/modules/usage.rs:1350   UsageSource::Run => self.run_id.is_some()                    (validation)
apps/api/src/routes/usage.rs:989     UsageSource::Run                                            (branch)
```

## The claim, established three ways — because a grep was not enough

`UsageSource` is **`Deserialize`-derived**, so the variant could in principle arrive from a request
body, and a grep for `UsageSource::Run` would miss every such arrival. Three independent checks:

1. **Every mention in non-test code is a read or a branch**, never a construction: three sites in
   `modules/usage.rs` (two validations) and `routes/usage.rs:989`. Eight mentions are in tests.
2. **Every `source:` field in production** is either a `pub`/struct declaration or one of
   `pricing_source` / `eligibility_source` / `internal_override` / `plan` — different fields. The
   only production *construction* of a `UsageEventRecord` with a `source` is
   `apps/api/src/repositories/usage.rs:894`, inside `#[cfg(test)]`, and it takes `source: &str` as a
   parameter so a test can pass either value.
3. **The schema permits but the application never writes it.** `usage_events.source` is
   `TEXT NOT NULL DEFAULT 'inference' CHECK (source IN ('inference', 'run'))`.

**So the database would accept `source='run'` in `usage_events`, and no code path ever writes it.**
That is the sharpest form of the finding: the constraint was widened to admit the second source, the
read path was built to consume it, and the writer was never written. `is_run_source()` is therefore
not merely usually-false — it is **structurally incapable of being true in production**, and the only
thing that can make it true is a direct database write.

## Why this is worse than the other four instances of this class

V01-040, V01-046 and the P09 findings are capabilities that are absent: nothing happens, and nothing
claims otherwise. **This one is a lie the code tells itself, four times over:**

1. **`is_run_source()` is called from six production sites** and its branch selects
   `insert_run_cost_record_statement` / `assert_run_cost_record_statement` over the
   `usage_events` pair. A reader of `routes/usage.rs:1082` sees a complete, symmetric, two-source cost
   path. It is dead code past a condition that can never hold.
2. **`list_usage` and `summarize_usage` `UNION ALL` a table that is always empty.** The read path
   pays the cost of a second source on every query and receives nothing for it, and the schema of the
   query implies two sources exist.
3. **The module header states the invariant in prose**: *"Both are read through one normalized
   projection so summary/rollup reads and reconciliation never need a second reservation or usage
   authority."* Two sources, one of which is empty.
4. **The change request commits to it in the present tense** and calls it `must`.

`pnpm check` is green with 1030 tests. Nothing in the build, and nothing in the test suite, can see
that a committed table has no writer — because the tests that exercise `UsageSource::Run` build the
value themselves.

## The runtime shape

```
run_usage_events rows: 0
usage_events rows:     0   (in a probe that makes no inference)
```

and structurally: any query's `UNION ALL` right-hand side is empty for every organization, forever.

## Blast radius, stated carefully

**The inference money path is not affected and is proven.** `verify:budget-concurrency` 28/28,
`verify:usage-attribution` 43/43, `verify:idempotency` 47/47 — the `usage_events` source carries
request-scoped inference, is attributed correctly, and reconciles. This is **not** a money-loss
finding.

What is unproven is the **other half of a committed design**: whether non-inference run usage
(scheduled jobs, automations, any work billed to an org without an inference request) is recorded at
all. Given that `UsageSource::Run` has no production constructor, **it is not** — and a run that
consumes tokens without an inference request would be invisible to every budget, summary and
rollup read.

## Why this is NOT repaired here

Writing the run source means deciding **which events are non-inference and billable**, and that is a
product decision with money attached:

- what counts as billable non-inference usage (automation steps? scheduled runs? tool calls?);
- whether a run's spend is attributed to its parent inference request, which would make it
  **not** a second source and contradict §7's "additive";
- the pricing/reconciliation rules §8 says it "must use" — the same ones, or a distinct
  non-inference schedule, and if the latter then `pricing_version` semantics differ per source.

`UsageSource::Run` being unconstructed is consistent with a deliberate deferral *or* with a
half-landed slice. **I cannot tell which from the code**, and that is exactly why this is recorded as
UNPROVEN rather than closed either way. Repairing it by writing the row would mean inventing the
billing rule; leaving it means a committed `must` is unsatisfied. Both need the deliberate change
process, so the finding is preserved in full and left open.

## What is triaged, and what is not

This closes four of the forty `UNTRIAGED` liveness entries as **examined, deliberately open**:

`insert_run_usage_statement`, `list_cost_records`, `upsert_rollup_statement`, and the money members
of the same cluster (`find_budget_for_scope_period`, `insert_budget_reservation_statement`,
`list_reservations_page`, `insert_plan_statement`, `list_active_plans`, `seat_policy_for_plan`,
`insert_plan_entitlement_statement`, `list_entitlement_definitions`) remain **UNTRIAGED** and
unexamined. The honest label is unchanged: *known-unexamined, which is the state this check is
designed to make visible instead of leaving as an unexamined list.*

## The generalisation, and it is the fifth of its kind

| | capability | enforcement | lever |
|---|---|---|---|
| V01-040 | support-grant **use** | not implemented | not implemented |
| V01-041 | device-enrollment **denial** | — | added |
| V01-042 | idempotency-record **purge** | — | added |
| V01-043 | plugin **quarantine** | enforced on four paths | added |
| V01-046 | webhook **fan-out** | not implemented | not implemented |
| **V01-047** | **run-source usage writer** | **not implemented** | **read path wired anyway** |

**V01-047 is the first instance where the READ path is wired and the WRITE path is not.** That is a
strictly worse shape than the four before it, and the reason is structural: a `UNION ALL` over two
sources compiles, type-checks, returns correct answers for the one that is populated, and is
**indistinguishable from correct** to every test that uses inference. A missing capability is
visible; **a missing half of a symmetric pair is invisible by construction**, because the populated
half answers for the empty one.

**The liveness check found it, and only because it counts callers rather than asking whether a
feature works.** The check's own limitation is the general form of the lesson: it proves a function
is *called*, not that it is called correctly — and here it proved the exact opposite of what a reader
would assume, since `is_run_source` and both run-cost writers *are* called, and are unreachable
behind a condition that can never hold. **A check that proves liveness can be satisfied by a call
that can never execute.**
