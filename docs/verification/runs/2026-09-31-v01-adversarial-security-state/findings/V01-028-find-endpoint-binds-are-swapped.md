# V01-028 — `find_endpoint`'s binds are swapped, so every webhook endpoint lookup 404s

## Status

**found and REPAIRED.** Severity **high**. Found by a *positive control*, which makes the way it was
found the most useful part of this record.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-TEN-010` (new) — *the owner can rotate her own webhook signing secret* |
| **Setup** | a real Worker and fresh D1. Two organizations, each with a real owner, a real webhook endpoint created through the product's own `POST /webhooks` — and that route answers `201` with the **plaintext secret**, so each organization holds a real secret and the probe knows its plaintext. |
| **Action** | **first, the positive control:** Alice rotates **her own** endpoint's secret, in **her own** organization. |
| **Expected** | `200` with a new plaintext secret. |
| **Actual** | **`404 not_found` "The requested resource was not found."** — for the owner, in her own organization, on a row that exists. After the repair the same call answers **`503`**, which is a *different* failure further along the route. |
| **Evidence** | `evidence/v01-secret-tenancy.txt` (the two failing control assertions) |
| **Verdict** | **FAIL, repaired** for the bind swap; a second `503` in the same route is **OPEN** |
| **Regression gap** | the narrow structural test described below is **not yet written**; the probe's positive control is the runtime detector and it is currently failing on the exposed `503` |
| **Severity** | **high** — see "what else it breaks" |

## Root cause — the bind list is in the opposite order to the placeholders

`apps/api/src/repositories/webhooks.rs`:

```rust
const ENDPOINT_BY_ID_SQL: &str = r#"
…
FROM webhook_endpoints
WHERE org_id = ?1 AND endpoint_id = ?2
LIMIT 1
"#;

pub async fn find_endpoint(&self, org_id: &str, endpoint_id: &str) -> … {
    self.database
        .prepare(ENDPOINT_BY_ID_SQL,
            &[BindValue::Text(endpoint_id), BindValue::Text(org_id)])   // <-- swapped
        ?
```

`?1` is bound to `endpoint_id` but the SQL compares `org_id` against `?1`; `?2` is bound to `org_id`
but the SQL compares `endpoint_id` against `?2`. The statement is **unsatisfiable**: it requires a row
whose `org_id` equals an endpoint id *and* whose `endpoint_id` equals an org id. Measured against the
live database, with the real row present:

```
SELECT COUNT(*) FROM webhook_endpoints
 WHERE org_id = 'whe_6ae4…' AND endpoint_id = 'org_97d4…';   -->  0
SELECT endpoint_id, org_id FROM webhook_endpoints
 WHERE endpoint_id = 'whe_6ae4…';                              -->  whe_6ae4… | org_97d4…
```

`find_endpoint` therefore **always** returns `None`, so `load_endpoint` always raises `not_found`.

## Why no existing gate caught it, and that is the finding

`pnpm schema:bind-count` checks that every `prepare()` binds **as many values as its SQL has
placeholders**. This statement has two of each. The check is correct, it runs, and it passes — because
the defect is not *how many* but *which goes where*. That is **GAP-004** exactly, and this is its
first proven instance: `schema:bind-count` proves arithmetic, and this is a correspondence error.

This is now the **third** time this campaign has found a bind/placeholder defect the count cannot see:

| | defect | count check |
|---|---|---|
| V01-008 | `SET`/`WHERE` placeholder disagreement on `project PATCH` | blind |
| V01-011 | `INSERT` with 33 values against 34 columns | blind (bind count matched the *values*, not the columns) |
| **V01-028** | **two binds, right count, wrong order** | **blind** |

## A scanner I wrote for this, and why I am not shipping it

The obvious move is to extend `schema:bind-count` to check correspondence. I wrote the scan — it
walks every `prepare(CONST, &[...])`, reads each constant's `<col> = ?N` comparisons, and compares
them to the bind expressions in written order.

**It reports 117 candidates and almost all of them are false positives.** The heuristic cannot tell:

- a `SET col = ?N` **assignment** from a `WHERE col = ?N` **comparison** — they are different
  contracts and my regex treats them alike;
- a naming variant from a swap: `expected_version` vs `version`, `reason` vs `revoke_reason`,
  `org_id` vs `organization_id`, `mcp_id` vs `mcp_registration_id`;
- a **reused** placeholder from a positional one: `AND (?3 = '' OR project_id = ?3)` names a column
  for a parameter that is also something else entirely.

One of the 117 is the real defect. Shipping the other 116 would be a machine for reporting false
positives, and this campaign has already paid for exactly that twice — the 76-site discarded-key
inventory, and a `verify:budget-concurrency` that reported 27/27 with nothing held. **A check that
cannot distinguish a defect from a naming convention is not a weak check; it is a wrong one.**

So the scan is recorded here and **not** shipped. What ships instead is a narrow test for the one
unambiguous shape, described at the end.

## What else it breaks — the finding is bigger than one route

`find_endpoint` has exactly two callers, and neither is the one I was attacking:

1. `routes/webhooks.rs` — `load_endpoint`, so **every** endpoint-scoped webhook route 404s for its own
   owner: rotate-secret, patch, delete, test, deliveries. The owner cannot manage her own webhook.
2. **`consumers/webhooks.rs:370`** — the delivery consumer resolves the endpoint before dispatching.

The second is the worse one. A delivery consumer that cannot resolve its endpoint **cannot sign or
send the delivery at all**, so the outbound webhook path is dead end to end. And it is the same
subsystem as **V01-010** — "a failed provider dispatch was reported and then forgotten" — which was
itself found in this area. Two findings in one subsystem, one of them a consumer that has never
successfully resolved anything.

## The repair, and what it exposed

The bind list is put in the order the placeholders are written:

```rust
.prepare(ENDPOINT_BY_ID_SQL, &[BindValue::Text(org_id), BindValue::Text(endpoint_id)])
```

Nothing else changes. The SQL was not the thing that was wrong about itself; the caller was.

**Measured effect of the repair, on a from-scratch build:** the owner's own `rotate-secret` moved from
**`404 not_found`** to **`503 service_unavailable`**. The lookup now resolves — which is the claim this
finding makes, and it is the whole content of the fix — and the request proceeds further into the
route than it has ever been able to.

**A second, unlocalised failure is therefore exposed in the same route, and it is OPEN.** It is past
`load_endpoint`: `mint_secret` and the `commit_mutation` batch are the remaining candidates, and the
`credential_key` check inside `mint_secret` is the first thing to look at, since it raises the same
`503` and the development environment sets no `CREDENTIAL_ENCRYPTION_KEY` variable of its own.

I stopped localising it here rather than continue, and that is a deliberate line: the turn had already
produced a proven defect, a proven fix and a proven measurement, and the remaining question needs a
clean build plus one instrumented run, not more reading.

## Two methodology notes this finding cost, both worth keeping

**1. A fix that does not reach the artifact looks exactly like a fix that did not work.** Three
consecutive probe runs after the repair reported the *same* 404, and `cargo build --release` printed
`Finished in 0.32s` each time. The cause was a stale `wasm`: the edit had not been compiled in, because
cargo's fingerprint did not notice it. Forcing a rebuild (`rm` the artifact, rebuild from scratch) is
what produced the real measurement.

> The discriminator is the **artifact's timestamp**, not the source's and not the status code. A repair
> that did not take effect and a repair that did not work produce identical evidence, and the only
> thing that separates them is whether the binary you are testing was built from the source you are
> reading. This campaign's sensitivity harnesses already guard the *other* direction — `assert_changed`
> refuses a mutation that did not apply — and this is its mirror image, and it cost three runs.

**2. The probe's own positive control is what made this findable at all.** "Alice rotates her own
secret" says nothing about tenancy, and it is the only assertion that distinguishes *"the route refuses
another tenant"* from *"the route refuses everyone"*. Every tenancy row on the sheet below the control
is currently **uninterpretable**, and the probe says so by exiting 1 rather than reporting 30/32 as a
result. That is the discipline working: I am not able to claim the cross-tenant secret boundary is
proven, because the thing that would prove the route works at all has not passed.

## Regression coverage, and what it is allowed to be

**1. The probe's positive control** — already written, already fired, and it is the reason this was
found at all. It is a *control*, not an attack: "Alice rotates her own secret" says nothing about
tenancy, and it is the only thing that distinguishes "the route refuses another tenant" from "the
route refuses everyone". The sheet below it is uninterpretable without it, and four of this
campaign's gates have been found by a control rather than by an attack.

**2. A narrow structural test** for the one unambiguous shape, and deliberately narrow:

> a SQL constant whose **WHERE clause** has exactly two `<col> = ?N` comparisons in placeholder order,
> prepared with exactly two binds, where **both** positions disagree — the bind at `?1`'s position is
> named by the other column and vice versa.

Both positions must disagree, because one disagreement is a naming variant. `SET` clauses are
excluded, and a placeholder reused in `AND (?N = '' OR …)` is excluded. The test names the file, the
constant, both positions and both columns, so a failure is actionable rather than a number.

It is a weak test by construction — it will miss a swap in a statement with three or more predicates,
or one that reuses a placeholder, or where the two columns are named similarly. **That is the honest
limit and it is stated in the test's own comment**, because a narrow check presented as a general one
is how the 117-candidate scanner nearly got shipped. The runtime gate is what covers the rest, and
this finding is the argument for why the runtime gate has to exist.
