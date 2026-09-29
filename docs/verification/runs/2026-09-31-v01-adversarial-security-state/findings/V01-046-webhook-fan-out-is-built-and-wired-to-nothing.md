# V01-046 — the webhook fan-out is built, documented, and wired to nothing

**Severity: HIGH · Status: OPEN, deliberately unrepaired · Class: built-but-unwired (V01-040/041/042/043) · Product: the requirement is real and the mechanism is absent**

## The claim

`f17`'s FR-F17-003 gives a webhook endpoint "subscribed event types", and FR-F17-005 specifies
at-least-once delivery for those subscriptions, stable `event_id`, and bounded exponential backoff
with jitter. Together they require: **a committed business event reaches a subscribed endpoint.**

## What exists

Everything except the join.

| piece | state |
|---|---|
| `POST/GET/PATCH` endpoints, `rotate_webhook_secret`, `test_webhook`, `list_webhook_deliveries`, `replay_webhook_delivery` | wired, 8 routes |
| `WebhookDeliveryJobHandler`, `NotificationDeliveryJobHandler`, the dispatch in `lib.rs` | wired, with `is_webhook_job_type` routing |
| HMAC signing, retry, dead-letter, `webhook_deliveries` state machine | wired and enforced by the delivery handler |
| **`fan_out_event_statement`** — "Fan one committed business event out to every enabled endpoint in the SAME organization that subscribes to the exact event type" | **no caller** |
| **`insert_notification_statement` / `insert_notification_delivery_statement` / `fan_out_count`** | **no caller** |

The fan-out is not a stub. It is a complete, correct statement whose doc comment explains the design
and hands the caller an instruction:

> The caller passes the `EventEnvelope` that is being written to `outbox_events` in the same D1 batch,
> so the body serialized here is byte-for-byte the body persisted with the event. **Add this statement
> to a business transaction**; the tenant check and the exact-match subscription check both live in
> SQL and cannot be widened by a caller.

Nobody added it to a business transaction. The outbox consumer names the handoff and disclaims it:

> Fan-out eligibility (which of these reach a webhook) is a separate decision **owned by the delivery
> side**; this registry only proves the type is a known Lumi business event.

The delivery side owns it and never exercises it. `outbox.rs` handles ~60 registered business event
types and does not fan any of them out.

## Why the delivery path is *not* the evidence that it works

`insert_queue_job_statement` has four callers, and only two are webhook deliveries:
`test_webhook` (line 1453) and `replay_webhook_delivery` (line 1708). Both are **operator-initiated
against an endpoint the caller already named**. No caller creates a delivery from a business event.

So the delivery machinery is exercised — signing, retry, dead-letter, replay, and the
`pending -> queued` transition all run — and every exercise originates from a human asking for it.
The result reads exactly like a working feature: `test_webhook` succeeds, `replay_webhook_delivery`
succeeds, the dead-letter queue is reachable, and no event has ever been delivered to a subscriber.

## Blast radius

68 `EventEnvelope` references across 22 route files, and an event-name registry in `outbox.rs`
covering roughly sixty business types: agents, automations and their occurrences, credentials,
budgets, quotas, policy updates, rate limits, artifacts, plugin lifecycle, exports. **Not one of them
reaches a webhook.**

Every surface a customer would use to build on webhooks is therefore inert: a subscriber's endpoint
receives nothing, `list_webhook_deliveries` stays empty, and there is no error anywhere, because the
silence is exactly what an unwired fan-out produces.

## Runtime confirmation: the absence is measured, not inferred

A static "no caller" read is exactly the kind of claim this campaign has been wrong about before, so
`verify:webhook-fanout` attacks it over real HTTP. **19/19, exit 0.** Evidence:
`evidence/v01-046-webhook-fanout-confirmed-absence.txt`.

The class is built around **four controls**, and the point of the class is that the fifth assertion —
the absence — is worthless without them:

| | control | why it must be green |
|---|---|---|
| W0 | every subscribed type is a **string literal** in the outbox registry, read from source | an unregistered type is refused on the way out, and the subscriber would never have been eligible — the silence would look identical |
| W1 | the subscription is **persisted**, not merely accepted | the fan-out's own comment says the exact-match check lives in SQL, so the subscription must be in the database for that check to have anything to read |
| W2 | `test_webhook` **does** create a delivery row, in a real state | if this is red, every assertion below is a statement about a route that never delivers |
| W4 | the business event **was** emitted to the outbox | otherwise the silence is an event that was never *produced*, which is a much smaller finding |

**W5 — a subscribed endpoint receives no delivery — is asserted as a DELTA from the control, never an
absolute count**, so running the control twice cannot turn a broken fan-out into a pass.

Stored end state, from D1:

```
endpoint subscriptions: ["agent_definition.created.v1","automation.definition.created.v1"]
outbox events: 6   (including agent_definition.created.v1)
deliveries:    2   (test_webhook, and its replay)
```

The event was produced, the subscriber is eligible, and nothing was delivered. **W6** additionally
shows replaying the control's delivery returns 201, so the operator's remedy for a missed event is
reachable — which is what makes the finding *"no event is ever fanned out"* rather than *"the
recovery path is broken"*, and the two need different fixes.

## Six fixture faults, and the shape they share

Every one was caught by a control or by reading a rule, and none by reasoning about the product:

1. `https://127.0.0.1:9/...` → `webhook_url_blocked`. The SSRF guard is thorough and correct: it folds
   the historical IPv4 spellings, reads the range table from the *serialized* host, and rejects
   reserved names. **The obvious choice for an "unreachable" URL is the one the guard exists to
   refuse.** A plain DNS name on 443 passes, and is never resolved.
2. The event name was written from memory as `agent.definition.created.v1`; the real one is
   `agent_definition.created.v1`. **W0 caught it** — and a guessed event name is a *silent* way to make
   a fan-out probe vacuous, because an unregistered type is refused on the way out and the silence
   looks exactly the same.
3. W0 was originally `expect(..., true, ...)`. A literal cannot fail, so it was decoration occupying
   the word CONTROL in the sheet. **Worse than no control**, because the sheet then reads as though
   the registry had been checked.
4. The endpoint id was read from three top-level keys; the resource is nested under `endpoint`. The
   201 was reported as a failure — a probe that cannot see a success the product already gave it.
5. The agent id was then read from a nested `agent` key, copying the webhook shape. **Two routes, one
   product, two different response shapes**, so neither can be assumed from the other.
6. `outbox_events` has `organization_id` and `occurred_at`, not `org_id` and `created_at`. The column
   error surfaced as a **bail**, not a verdict, so the sheet was explicitly incomplete rather than
   quietly wrong — the harness's exit-2 discipline earning its keep.

The pattern: **a probe that has not read its own routes fails in ways indistinguishable from product
defects.** Three different `422`s came from three different field-set mistakes, and two `201`s were
reported as failures because the response shape was guessed rather than read.

## Why this is NOT repaired here

Repairing it means adding the fan-out statement to ~22 route files' business transactions, which is
a **feature decision with spec consequences**, not a defect fix:

- **Which events are eligible.** `outbox.rs` deliberately keeps that registry separate from fan-out
  eligibility. Choosing a set is a product decision, and the spec does not enumerate it.
- **Which endpoint types.** Internal `webhook.test.v1` and the six `webhook.delivery_*.v1` events are
  the platform talking to itself; fanning those out would let a customer endpoint receive delivery
  telemetry. Whether that is desirable is unstated.
- **Ordering and duplication.** FR-F17-007 requires ordering. Fanning out inside each business
  transaction makes fan-out order follow commit order, which is defensible, but it also means a
  retried transaction can fan out twice. The at-least-once promise covers it; the interaction with
  FR-F17-007 does not appear to have been decided.

**This is deliberately unrepaired and the current state is fail-closed**: an endpoint receives
nothing, which is the safe direction for an unwired control. The `verify:repository_liveness` check
named it, and the list entry is labelled `UNTRIAGED` — *"known-unexamined, which is the honest state
this check is designed to make visible instead of leaving as an unexamined list."* Implementing
delivery eligibility needs its own spec change; editing the requirement to match the code is the move
this campaign forbids.

## The generalisation, and it is the fourth of its kind

| | capability | enforcement | lever |
|---|---|---|---|
| V01-040 | support-grant **use** | not implemented | not implemented |
| V01-041 | device-enrollment **denial** | — | added |
| V01-042 | idempotency-record **purge** | — | added |
| V01-043 | plugin **quarantine** | enforced on four paths | added |
| **V01-046** | **webhook fan-out** | **not implemented** | **not implemented** |

V01-043 and V01-046 are the same shape with the same fix available — a repository method with a
complete statement and no caller — and they are opposite in severity. V01-043 was a **kill switch
with no lever**: enforceable, unoperable, dangerous during the incident it exists for. V01-046 is a
**lever with no trigger**: operable, inert, and safe in the failure direction.

**The shape is the lesson, and a liveness check finds it.** All four are `pub` repository functions,
and `security::repository_liveness` exists precisely to make "declared, tested, uncalled" visible. It
found this one; the four `UNTRIAGED` siblings it has not yet triaged — `insert_run_usage_statement`,
`list_cost_records`, `upsert_rollup_statement`, `find_snapshot*`, `find_live_device_token`,
`revoke_grants_statement`, `mark_artifact_deleted_statement` — are the same hypothesis in areas this
campaign cares about more, because they are **money** and **retention** rather than notifications.

## Evidence

- `fan_out_event_statement`, `insert_notification_statement`, `insert_notification_delivery_statement`,
  `fan_out_count` appear **only** in `apps/api/src/security/repository_liveness.rs` and their own
  declarations in `apps/api/src/repositories/webhooks.rs`.
- `insert_queue_job_statement` callers: `consumers/automations.rs:134`, `jobs/automations.rs:896`,
  `routes/webhooks.rs:1453` (`test_webhook`), `routes/webhooks.rs:1708` (`replay_webhook_delivery`).
- `consumers/outbox.rs` registry comment names fan-out eligibility as the delivery side's decision;
  `consumers/webhooks.rs` implements only the delivery handler.
- `pnpm check` green, 1030 tests: **the whole feature is invisible to the build**, which is the
  defining property of this class.
