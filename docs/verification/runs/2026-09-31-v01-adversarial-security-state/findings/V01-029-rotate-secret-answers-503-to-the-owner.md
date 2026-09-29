# V01-029 — `rotate_webhook_secret` answers 503 to the owner, and seven candidate sites are indistinguishable

> **CLOSED — by V01-030, not by anything in this file.** The 503 was a *symptom*: a
> `WebhookEndpointRecord` row could not be decoded, because D1 delivers its `INTEGER` columns as
> JavaScript numbers and the struct declared them `bool`. Every narrowing below is a true account of how
> the search went, including the four conclusions drawn from a stream nobody had verified could carry
> them. The root cause, the repair and the evidence are in
> [`V01-030-d1-integer-columns-cannot-be-decoded-as-bool.md`](V01-030-d1-integer-columns-cannot-be-decoded-as-bool.md).
> The `service_unavailable` that `webhooks.rs` shadowed — naming the *notification* store for endpoint
> routes — was a real second defect, and is fixed independently.

## Status

**OPEN.** Severity **high** (an organization cannot rotate its own webhook signing secret, so the
outbound webhook path is unusable). Found immediately after repairing V01-028, which is what made it
reachable.

This record is deliberately short on conclusions and long on what was *ruled out*, because the value
here is the narrowing. The next action is a single instrumented run and it is already instrumented.

## What is established, by measurement

1. The owner's own `POST /webhooks/{endpoint_id}/rotate-secret` answers **`503 service_unavailable`**.
2. **No `idempotency_records` row is written** for `rotate-secret` in that run — verified by reading
   D1, not by reading a response. So the failure is **before** the idempotency claim is taken.
3. **`load_endpoint` does not log its failure** (the log added in V01-028's repair is silent), so the
   endpoint lookup **succeeded** — which is V01-028's fix holding.
4. **`prepare_mutation`'s lookup does not log its failure** either, so the 503 is **before both**.

So the failure is one of the four steps ahead of `load_endpoint`:

```rust
let access = authorize_org(..).await?;                 // (a)
require_csrf(&headers, &access.session, &context).await?;  // (b)
let key = idempotency_key(&headers, &context)?;       // (c) 400, not 503 — ruled out
let database = database(&state, &context)?;           // (d)
```

(c) is excluded because a missing key is a `400`. That leaves **(a) `authorize_org`**, which has its
own `map_err(|_| service_unavailable(context))` on the membership and organization reads, and which
is the *only* step here that takes a **resource context** (`Some(resource_type), Some(&endpoint_id)`)
— the one thing `create_webhook` does not do, and the one thing that distinguishes this route from
every webhook route that works.

(b) and (d) remain possible; both are a single line to instrument.

## What was ruled out, and how — because the negative results are the expensive part

| hypothesis | test | result |
|---|---|---|
| the endpoint lookup still fails | V01-028's permanent `load_endpoint` log | **ruled out** — silent, so it resolved |
| the idempotency claim is taken and then rolled back | D1: any `idempotency_records` row for `rotate-secret` | **ruled out** — no row at all |
| the claim insert has a bind/placeholder mismatch | `pnpm schema:bind-count` over 462 `prepare()` calls | **ruled out** — `CLAIM_SQL` has 9 placeholders (`?9` is in the `ON CONFLICT ... WHERE expires_at <= ?9` clause) and 9 binds |
| the idempotency lookup has a bind/placeholder mismatch | read `LOOKUP_ACTIVE_SQL` against its binds | **ruled out** — `?1`…`?6` in order, binds in the same order |
| `prepare_mutation` is broken generally | it has **29** call sites, and `verify:attempt-exhaustion` (49/49) and `verify:lease-contention` (62/62) drive four of them to success | **ruled out** |
| the `IdempotencyScope` path template is rejected | `IdempotencyScope::new` rejects only a non-`/`-leading path, `?`, `#` and control characters; `WEBHOOK_ROTATE_PATH` is `/api/v1/orgs/{org_id}/webhooks/{endpoint_id}/rotate-secret` | **ruled out** — and 27 other sites pass templates |
| the `credential_key` is absent, so `mint_secret` raises the same 503 | `app.rs` supplies a development key unconditionally, and `POST /credentials` — which needs the same key — **succeeded in this very run** | **ruled out** |

## The diagnosis this record exists to prevent

Four of the seven are *structural* facts, and they are the reason the previous finding was possible at
all. `load_endpoint` collapsed six distinct outcomes into one `map_err(|_| service_unavailable(..))`,
and `prepare_mutation` has **seven**. A schema refusal, a decoding failure, a store outage and a
missing key binding are one answer, from outside and from the database.

That is **V01-010** — "a failed provider dispatch was reported and then forgotten" — and it is now the
third site in this campaign where the *reporting* was the defect rather than the behaviour. The
generalisation:

> **An error handler that maps everything to one code is a defect even when every behaviour behind it
> is correct**, because it converts "the product is broken in a way I cannot see" into "the product is
> unavailable", and the second is a thing nobody investigates.

## The instrument lied to me four times, and that is the second finding here

I instrumented four `service_unavailable` sites in `webhooks.rs` and `agents.rs`, rebuilt, and
concluded from each run that **no log fired** — so the failure was "somewhere else". Four times.

**The conclusion was wrong, and the instrument was the reason.** `workerConsole()` returns a *tail* of
a file that `wrangler dev`'s proxy appends to asynchronously. The decisive check is the one I did not
do until the fourth build:

> **Does the instrument record a request I already know arrived?** If the log has no line for a
> request the probe definitely made, then the log's *silence* is a property of the log, not of the
> product.

It does not. Across five runs the file held sixteen request lines and ended at the last fixture —
no `rotate-secret` line at all, for a call the probe demonstrably made and which came back with a
product-shaped body carrying a `request_id`. Every one of my four "no log fired" readings was
therefore reading a truncated stream as an absence of evidence, and each one cost a build.

This is the sixth time this campaign has graded something on a comparison that could hold vacuously,
and the first time the *instrument itself* was the empty set. The rule is the one the harness already
states for gates — *grade on a measurement, not on an absence* — applied to the thing doing the
grading:

> **A log's silence is evidence only after you have seen that log record something.** For a probe
> asserting a positive, that is a control. For a probe asserting an absence, it is a control too, and
> there was none.

The probe half of the fix is in place: the console is now read **at the point of use**, immediately
after the call it describes, rather than at the end of the run. The product-side logs are permanent
and will name the site on a run where the capture holds. What is still needed is a positive control
on the *capture*: the probe should assert that it can see a marker it knows was emitted, and fail as a
**harness fault** if it cannot — rather than reporting an absence.

## What I can and cannot claim

**Claimed, with evidence:** the owner's own `POST /webhooks/{id}/rotate-secret` answers
`503 "The notification store is unavailable."` after V01-028's repair, and the same message is returned
by several other endpoint-scoped webhook operations, so the failure is not specific to the rotation.

**Not claimed:** which call site produces it. Every narrowing I attempted rested on the console, and
the console is lossy.

## One thing the message itself did establish, and it is worth having

`webhooks.rs` defines a **private** `service_unavailable` whose message is *"The notification store is
unavailable."* It shadows the shared helper for the whole module, so **every** endpoint-route failure
in that file has been reported as a notification outage — credentials, webhooks, deliveries and
preferences alike. That single line is why the very first thing I did with this 503 was look for
notification code that does not exist on this path, and it is a defect in its own right:

* an operator reading a 503 on a credential or endpoint route is told the *notification* store is
  down, and will go and look at the wrong subsystem;
* the objective's requirement of **useful telemetry** is not met by an error that names the wrong
  subsystem, and this campaign's own rule is that an error handler that maps everything to one code
  is a defect even when every behaviour behind it is correct.

That much is worth fixing on its own evidence, and it does not depend on localising the 503.

### Fixed, and the fix is its own proof

The shadowing helper is removed and the shared one is used for all 19 call sites. Measured:

```
before:  503 "The notification store is unavailable."
after:   503 "The control-plane store is unavailable."
```

The 503 itself is unchanged, which is the point: **the message changing proves both that the repair
worked and that the 503 originates in this module** — no other route in `webhooks.rs` uses the shared
helper's message unless it goes through a `webhooks.rs` call site. So the localisation that four
builds of console-reading failed to achieve is established in one line by fixing an unrelated defect in
the same file, which is a humbling and useful thing to record.
