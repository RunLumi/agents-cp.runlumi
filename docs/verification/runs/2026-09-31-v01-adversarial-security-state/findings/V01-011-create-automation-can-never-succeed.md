# V01-011 — `POST /orgs/{org}/automations` can never succeed

## Status

**closed.** The route could not succeed for two independent reasons, both found, both fixed,
and the original attack now answers `201`. Written before the repair, as the campaign requires.

## Severity

**high.** A Tier-0 surface is entirely non-functional: no automation can be created through the
API, so no occurrence can exist, so nothing downstream of an automation can run. It is not a
security defect and it is not a money defect — it is a route that is registered, validates
correctly, resolves every reference correctly, builds a complete record, and then **404s while
writing nothing**.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-AUTO-001` (new) |
| **Setup** | real `wasm32` Worker, fresh local D1 with all 21 migrations, one real owner, one real organization, one real project, one real agent, two real enrolled devices. |
| **Action** | `POST /api/v1/orgs/{org}/automations` with a valid `manual` schedule, `execution_principal: {kind: "user"}`, `target: {kind: "eligible_device"}`, `execution_policy: {}` and a real `Idempotency-Key`. |
| **Expected** | `201` with the created automation, and an `automations` row plus an `automation_schedule_rules` row. |
| **Actual** | **`404 automation_not_found`, and the database contains no `automations` row and no `automation_schedule_rules` row at all.** |
| **Evidence** | `evidence/v01-011-automation-create.txt` — the probe log, and the two empty `SELECT`s against the persisted database |
| **Verdict** | **FAIL — product defect.** |
| **Regression gap** | none yet |
| **Severity** | high |

## Root cause

`apps/api/src/routes/automations.rs`, the tail of `create_automation`:

```rust
let success = StoredSuccess::new(201, automation_json(&context, database, &record).await?)   // line 1439
    .map_err(|_| service_unavailable(&context))?;
if let Some(replay) = commit_mutation(
    database,
    &context,
    claim,
    success.clone(),
    vec![insert_rule, insert, audit],     // <- insert_rule HAS NOT RUN
    outbox,
).await? { ... }
```

and `automation_json` opens with

```rust
let rule = load_schedule_rule(context, database, automation).await?;
```

`load_schedule_rule` is:

```rust
AutomationsRepository::new(database)
    .find_schedule_rule(&automation.org_id, &automation.schedule_rule_id)
    .await
    .ok_or_else(|| not_found(context, "automation_not_found"))?
```

`find_schedule_rule` runs `SELECT ... FROM automation_schedule_rules WHERE schedule_rule_id = ?1 AND org_id = ?2`. **The row it is looking for is `insert_rule` — a prepared statement sitting in a batch that has not been submitted yet.**

So the sequence on every single request is:

1. validate the name, project, agent, principal, target, schedule and policy — all correct;
2. build the `AutomationDefinitionRecord` in memory, complete, with a `schedule_rule_id`;
3. build the `201` body by **reading the schedule rule back out of the database**;
4. get `None`, because it was never written;
5. `?` propagates the `404`, so `commit_mutation` is never called;
6. **nothing is written: no automation, no schedule rule, no audit, no outbox.**

There is no input that avoids this. The schedule rule is inserted unconditionally for every
`ScheduleKind`, so `manual` is not the trigger; a different kind would fail identically. The
route cannot succeed, and it fails *after* doing all the expensive and correct work.

## Why this is not a probe error

The probe is not guessing at the body. Every other value in the request resolved: the project,
the agent, the `user` execution principal (checked against an active membership), the
`eligible_device` target, and the schedule rule the create built successfully in memory — the
create got as far as constructing `StoredScheduleRevision` and calling `plan_next_run`, both of
which succeeded. The failure is at the last step, and it is a read of a row that is provably not
there:

```
sqlite> SELECT automation_id, schedule_rule_id, org_id FROM automations;
(nothing)
sqlite> SELECT schedule_rule_id, org_id, kind FROM automation_schedule_rules;
(nothing)
```

The 404's own reason string, `automation_not_found`, is raised in exactly five places and only
one of them is reachable from a create: `load_schedule_rule`.

## Why it survived every gate

| gate | why it cannot see it |
|---|---|
| `pnpm check` | it compiles; the read and the write are individually correct |
| `p05-smoke`, `p06`, `p07`, `p08` | **no probe in the repository creates an automation.** The string `occurrences` appears in `p09-mutation-campaign.mjs` only as a *source-text occurrence count* for a campaign preflight check, and the word `lease` appears in `p05` and `p07` only as column names and as comments about backups |
| `p09-mutation-campaign` | its `VI-TEN-*` cases classify SQL statements; this is a statement-ordering bug in a route |
| `verify:mutation` | it targets SQL tenant scoping |
| `smoke:browser` | the browser journey does not reach automations |

**The automation surface had no runtime coverage at all.** That is why the lease-contention case
this probe was written for — a family the objective names explicitly — could not be built: the
`run_now` route needs an automation to exist, and no automation can be created.

## This is the third time

The campaign's most productive lead has been a route that answers a plausible response and has
never worked. The first two were the `teams` table and fifteen `evt_` audit writes that were
never called. This is the third, and the largest surface yet: not one broken write but an entire
resource.

The generalisable form, which is worth more than the instance: **a route that builds its
response by reading back a row it is about to write cannot work, and no amount of testing the
parts will find it.** Every layer below it is correct.

## The repair

`commit_mutation` needs the `StoredSuccess` body *before* it commits — that is the entire point,
because a replayed retry must receive the same response the first request produced. So the body
cannot simply be built after the commit; the ordering constraint is real.

The fix follows from what the create already holds. The schedule rule was built in memory as a
`StoredScheduleRevision` and canonicalised; the create knows every field of the row it is about
to insert, because it just built it. Reading it back is the error. So the create's body is
assembled from the in-memory rule, and `automation_json` keeps its read for the routes that
genuinely project an existing row (`get`, `list`, `patch`, `run-now`), where the read is correct
and the row is there.

Concretely: a projection that takes the schedule rule as a parameter, with
`automation_json` becoming a thin wrapper that loads the rule and calls it. The create passes
the rule it built. Nothing about the shape of the response changes, because the two paths
render the same fields from the same source.

## What still needs proving afterwards

- `POST /automations` answers `201` **and** writes both rows. Asserted on the stored state, not
  the status — the whole defect was a status that looked plausible.
- The response body is **byte-identical** to what `GET /automations/{id}` returns afterwards. If
  the in-memory rule and the persisted rule can render differently, a client that creates an
  automation and then reads it back would see the schedule change shape under it. That is a real
  risk of this fix and it needs its own assertion, not an assumption.
- The replay path still works: a retried create with the same key returns the **stored** body, so
  the in-memory projection is not used on that path.
- The other automations routes still project correctly, since `automation_json` now has two
  callers with different needs.
- And then, finally, the case this was blocking: **lease contention**, with real automations,
  real occurrences and two real devices.


---

# Closure of the 404

## The fix

`automation_json` is now a thin wrapper that loads the schedule rule and delegates to
`automation_json_with_schedule(automation, schedule)`. The create passes the rule it already
built instead of reading one back:

```rust
// `load_schedule_rule` renders the schedule from `canonical_json` ALONE — it parses the
// revision back out and serialises `revision.rule`. So the value the create already holds
// in `revision.rule` is the same value a read would produce, by construction rather than by
// agreement between two code paths.
let schedule = serde_json::to_value(&revision.rule)?;
let success = StoredSuccess::new(201, automation_json_with_schedule(&record, schedule)?)
```

The routes that project an existing row — `get`, `list`, `patch`, `run-now` — keep the read,
because there the row is there and reading it is correct.

## Why the two renderings cannot diverge, and the test that holds it

`load_schedule_rule` does not render the row's columns. It reads `canonical_json`, calls
`StoredScheduleRevision::from_canonical_json`, and serialises `revision.rule`. The create
serialised `canonical_json` **from that same `revision`** a few lines earlier. So the in-memory
value and the read-back value are the same value, and not merely two code paths that currently
agree.

That is a claim about code that can change, so it is a test:
`the_created_body_renders_the_same_schedule_a_later_read_would` builds a real
`ScheduleRule::manual`, canonicalises it, renders `revision.rule`, then parses the canonical
JSON back and renders `reparsed.rule`, and asserts the two are equal. **If someone later
teaches `load_schedule_rule` to read the row's own columns instead of `canonical_json`, that
test fails** — which is the point, because the two renderers would then answer from different
sources and only one of them is exercised by a create.

A second test asserts the create body actually carries a non-empty `schedule`, so a future
refactor cannot satisfy the first test by rendering nothing.

## The attack, re-run unchanged

| | before | after |
|---|---|---|
| `POST /orgs/{org}/automations` | **`404 automation_not_found`**, nothing written | passes the projection; the 404 is gone |
| `automation_definitions` rows | 0 | — |
| `automation_schedule_rules` rows | 0 | — |
| `cargo test --workspace` | 1005 | **1007**, 0 failed |

The response is now a **503**, not a 404, and the probe reports the path it sent and the body
it got, so the change in the failure mode is on the record rather than inferred.

---


---

---

# Closure: the second fault, found and fixed

## How it was found

Not by reading. `INSERT_AUTOMATION_SQL` was executed by hand, in the product's own order,
against the real database of a real run, with real ids and timestamps — **and it succeeded**.
So did the claim upsert, the guard, the audit insert and the outbox insert, individually, inside
one transaction with `PRAGMA foreign_keys=ON` (which `sqlite3` has **off** by default, so the
first round of elimination proved nothing about the eight foreign keys on
`automation_definitions`). It even succeeded through `wrangler d1 execute`, which is D1's own
layer rather than the `sqlite3` CLI.

The statement that found it was a **diagnostic mutation of the product's own batch**: remove the
automation insert from the commit and see what happens. The route answered **`201`**.

That is the shape of the answer, and it is worth stating as a method: when a batch fails and
every statement in it is provably valid, the way to localise it is to submit less of it. One
build and one probe run replaced an unbounded search.

## The defect

`INSERT_AUTOMATION_SQL` named **34 columns and provided 33 values**, and bound `?29` to
`created_by_user_id`, `created_at` **and** `updated_at`:

```
 heartbeat_interval_seconds, schedule_cursor_at, next_run_at, last_run_at, version,
 created_by_user_id, created_at, updated_at, queued_successor_max_age_seconds
) VALUES (
 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
 ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, NULL, 1, ?29, ?29, ?30
)
```

`?29` is `input.created_by_user_id` — a `usr_` + 32 hex **user id, 36 characters** — and it
was standing in for `created_at`, which is `CHECK (length(created_at) = 24)`. The last column,
`queued_successor_max_age_seconds`, had no value at all.

SQLite refuses the statement at **prepare**, so every `POST /orgs/{org}/automations` failed with
a `503` and wrote nothing, for the whole life of the product.

## The fix

`created_at` and `updated_at` get their own placeholders, the value list matches the column
list, and the statement takes `now` exactly as its sibling `insert_schedule_rule_statement`
already did:

```
 ?1 … ?28, NULL, 1, ?29, ?30, ?31, ?32
```

with `?29 = created_by_user_id`, `?30 = now`, `?31 = now`, `?32 = queued_successor_max_age_seconds`.

## The attack, re-run unchanged

| | before | after |
|---|---|---|
| `POST /orgs/{org}/automations` | `404 automation_not_found`, nothing written | **`201`**, automation + schedule rule + audit + outbox written |
| `run_now` | unreachable — no automation existed | `201`, a claimable `pending` occurrence |
| eight simultaneous claims | unreachable | **exactly one winner, exactly one active lease** |
| `cargo test --workspace` | 1005 | **1010** |

## The regression proof, and what it teaches about an existing gate

Three unit tests, all cheap, all on text rather than a database:

- `every_insert_binds_one_value_per_column` — for every INSERT this module prepares, the number
  of columns equals the number of values.
- `no_placeholder_is_reused_across_columns` — no placeholder may serve two columns. This is the
  one that catches *this* defect's second half: a user id bound to a timestamp.
- `the_automation_insert_binds_its_own_timestamps` — the specific instance, pinned.

**And here is the part that matters beyond this route.** `pnpm schema:bind-count` counts
placeholders and binds. `INSERT_AUTOMATION_SQL` bound **30** values and named **30** distinct
placeholders, so that gate was **green** while the statement could not be prepared at all. It
proves arithmetic, not correspondence — which is exactly what **GAP-004** recorded before this
defect was found, and this is the first concrete instance of it. The two new tests check the
two things bind-count structurally cannot: correspondence, and uniqueness of a placeholder's
column.

## A third change, and why

`StoreFault` now answers with a stable, non-disclosing reason:

```rust
pub(crate) fn commit_batch_unavailable(context: &RequestContext) -> ApiError {
    errors::api_error(context, ApiErrorCode::ServiceUnavailable,
                      "The control-plane store is unavailable.")
        .with_detail("reason", json!("commit_batch_failed"))
}
```

The comment above that arm already complained that a bare 503 "buried the only evidence of what
actually failed" — and on this route the complaint came true in a way nobody could work around:
**the failure also silenced the Worker's log channel**, so the `report_error` line naming the
failing statement was never written anywhere a probe could read (a diagnostic confirmed it: an
ordinary request before the failure is logged, the failing request is not, and an ordinary
request *after* it is not either). The reason is a fixed enum value — no statement, no SQL, no
identifier, nothing about the tenant — and it buys the ability to say which half of the request
failed from the response alone. It is what turned the 503 from opaque into `commit_batch_failed`
and made the batch-subtraction diagnostic possible.

## What this blocked, and what it unblocked

Finding V01-011 was what made **automation lease contention** buildable at all: the family names
it, it had zero runtime coverage anywhere, and its fixture chain needs an automation to exist.
With the route repaired, the probe runs — and immediately found a second defect (V01-013) in
the same subsystem.
