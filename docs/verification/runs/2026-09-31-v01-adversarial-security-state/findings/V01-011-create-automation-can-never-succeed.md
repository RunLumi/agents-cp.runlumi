# V01-011 — `POST /orgs/{org}/automations` can never succeed

## Status

**the 404 is closed; a SECOND fault in the same route is open.** The projection read is fixed
and the route now gets past it, where it hits a different 503 that is recorded below and is NOT
yet explained. Written before the repair, as the campaign requires.

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

# The 503, localised much further

Two rounds of elimination, both recorded because the elimination *is* the evidence.

## 1. It is not the schedule. Every kind that validates hits the same 503.

The probe now attempts **five** schedule shapes before giving up, because "the one kind I
happened to choose fails" is not the same finding as "the route is broken":

| schedule | result |
|---|---|
| `manual` | **503** `service_unavailable` |
| `one_time` + `scheduled_at` | **503** `service_unavailable` |
| `interval` (no zone) | 422 `schedule_timezone_invalid` — a *domain* rejection, from `build_zone` |
| `interval` + `utc_offset_seconds` + `timezone` | **503** `service_unavailable` |
| `cron` + `utc_offset_seconds` + `timezone` | **503** `service_unavailable` |

Two things fall out of that table. First, **the handler runs and can produce a precise,
specific reason** — a missing zone is `schedule_timezone_invalid`, not a 503 — so the route is
not failing wholesale at its front door. Second, **the 503 is reached only by the kinds that get
past validation, by every one of them**, so the fault is downstream of schedule resolution and
is not specific to a schedule shape.

(`build_zone` takes `utc_offset_seconds` plus an optional transition table, not a timezone
*string*. Passing `"timezone": "UTC"` is ignored, which is why an early version of this probe
saw `schedule_timezone_invalid` from every zoned kind and I briefly took it for a product
defect. It was a fixture error.)

## 2. Every statement in the batch is provably valid. All seven of them.

`commit_success` builds `[claim, guard, insert_rule, insert, audit, outbox, completion]`. Each
was executed **by hand, in the product's own order, against the real database of a real run**,
with the real ids, timestamps and values the route would have used:

| statement | result |
|---|---|
| `CLAIM_SQL` (the idempotency upsert) | succeeds |
| `ASSERT_CLAIM_SQL` (the guard) | **inserts nothing and does not error** when the claim's seven columns match — which is the design, verified against real bind values |
| `INSERT_SCHEDULE_RULE_SQL` | succeeds |
| `INSERT_AUTOMATION_SQL` | succeeds |
| the audit insert into `security_events` | succeeds |
| the outbox insert, with the product's exact `delivery_status`/`next_attempt_at` binding | succeeds |
| all four **inside one transaction with `PRAGMA foreign_keys=ON`** | succeeds |

The FK point matters and was a genuine hole in the first round of elimination. `sqlite3` has
foreign keys **off by default**, so the hand runs proved nothing about the eight foreign keys on
`automation_definitions` (`users`, `budgets`, `workspace_bindings`, `devices`,
`automation_schedule_rules`, `agent_definitions`, `projects`, `organizations`) or the one on
`security_events`. Re-run with enforcement on and inside an explicit transaction — which is what
a D1 batch is — and it still succeeds.

Two more things established:

- **The batch really is atomic and really did fail.** The `idempotency_records` row for the
  automations path is absent after a failed create, while the rows for the successful project
  and agent creates are present. So the claim was rolled back with everything else; this is a
  failed transaction, not a partial one.
- **The failure silences the Worker's log, permanently.** A diagnostic that makes one ordinary
  request, then the automations request, then another ordinary request, and searches the
  Worker's captured output for each `request_id` gives: first **present**, automations
  **absent**, third **absent**. `emit_request_log` is unconditional and cannot fail
  (`if let Ok(record) = serde_json::to_string(&log)`), and the middleware demonstrably ran for
  the automations request — it bound that very `request_id` into both the header and the body. So
  the line was produced, and the channel that carries it is dead from that moment, with no error
  and no warning: the console file contains exactly nine `console_log!` events, all of them
  `type: 'log'`, and none after that point.

**So the reason for this 503 is not merely unknown — it is unrecoverable from any probe on this
route, because the failure destroys the log that would explain it.** That is a sharper form of
V01-010 and V01-012, and it is the thing to fix next. In a deployed Worker the
`report_error` line is forwarded to Sentry, so the operator has it; a probe has nothing.

## What is still not known

Which statement in the batch fails, and why it fails when executed by D1 and not by `sqlite3`.
The candidates that remain are all at the boundary between the two: D1's own batch execution
rather than SQLite's, and the fact that a D1 batch is submitted as a unit with its own
transaction handling. Nothing narrower is available from the outside, and inventing a narrower
story would be a guess dressed as a finding.
