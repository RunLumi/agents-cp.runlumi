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

# OPEN: a second fault in the same route, not yet explained

`POST /orgs/{org}/automations` now answers:

```
503 {"error":{"code":"service_unavailable","message":"The control-plane store is unavailable.",
            "request_id":"req_...","details":{}}}
```

with **`details` empty** and **nothing written** — no `automation_definitions` row, no
`automation_schedule_rules` row, no audit row, no outbox row. So the route is still
non-functional; only the *reason* changed.

## What has been ruled out, and how

This is recorded because the elimination is the evidence, and because the next person should
not repeat it:

| candidate | how it was ruled out |
|---|---|
| the three batch statements | all four were executed **by hand, in the product's own order, against the real database** with real ids and real timestamps. Every one succeeded: `automation_schedule_rules`, `automation_definitions`, `security_events`, and `outbox_events` with the product's exact `delivery_status`/`next_attempt_at` binding |
| `principal_membership_active` | its SQL run by hand against the real org and user: returns 1 |
| a domain failure | `domain_failure` maps every `DomainError` to a specific code with a frozen reason — `ValidationFailed`, `ScheduleInvalid`, `AutomationNotFound` and the rest. None of them is a 503 with empty `details` |
| the outbox statement | its own error path is `ServiceUnavailable` with the message **"The event store is unavailable."** The observed message is **"The control-plane store is unavailable."**, which is `database_error` |
| a stale Worker on the port | no `workerd` process survived any run; ports 8787–8790 were clear before the run |

## The observation that makes this strange, and it is the useful part

**The failing request does not appear in the Worker's own request log.**

The `http_request` log line is emitted unconditionally by the middleware
(`http/middleware.rs:67`), and the response body carries a `request_id` that the same
middleware bound into it — so the middleware demonstrably ran. Yet the `request_id` from the
503 appears **zero times** in the Worker's captured output for that run, while the ids of every
preceding request appear exactly once. The request produced a Worker-shaped response from a
Worker whose log does not contain it.

That is not explained, and it is not explained *by anything in this route*. It is recorded as
the next thing to attack.

## What the harness could not do, and now can

Diagnosing this consumed more time than the fix, for one reason: **no probe could see a log
line written by the Worker.** `workerLog()` returns what wrangler's own pipes carried, which is
wrangler's request log and its startup banner. A `console_error!` from inside the Worker never
appears there.

`commit_mutation` writes the failing statement's SQLite error — with a comment saying "this is
the only place the reason a mutation failed reaches anything at all" — and V01-010's whole
point was to make `providers.rs` log its transport error. **Both log lines were unprovable from
a probe**, which makes them decorative in the one place that matters.

Three harness changes, all of which are test affordances in the test harness:

1. `--show-interactive-dev-session=false` is no longer passed by default, and
   `--log-level debug` is. Without the level, wrangler forwards its own log and silently drops
   the Worker's. `PROBE_QUIET_WORKER=1` restores the old behaviour.
2. The Worker's output is teed to `<persist>/worker-console.log`, capped at 2 MB per run.
3. `probe.workerConsole()` reads that file, which is a **different stream** from
   `workerLog()` and the only one containing a `console_error!` from inside the Worker.

With those in place the 503 is still not explained — but it is now *visible*, which it was not,
and the next step is a request rather than a search.
