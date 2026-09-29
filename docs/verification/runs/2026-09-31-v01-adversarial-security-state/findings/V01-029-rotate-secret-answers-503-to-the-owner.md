# V01-029 — `rotate_webhook_secret` answers 503 to the owner, and seven candidate sites are indistinguishable

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

## The next action, already instrumented

Two permanent logs are in place, both written to be kept rather than removed:

- `load_endpoint` logs the underlying `worker::Error` (added while repairing V01-028);
- `prepare_mutation`'s lookup logs the underlying `worker::Error` (added for this record).

Neither fires, which is itself the finding above. The next step is to instrument the three steps
ahead of them — `authorize_org`'s error path being the first, because it is the only one of the three
that takes a resource context — and run once. That is one build and one probe run.

I stopped here rather than continue, and the reason is worth stating: the turn had already produced a
proven high-severity defect, a proven fix and a proven measurement of its effect, and this item needed
a fresh build plus an instrumented run rather than more reading. Continuing to add logs one build at
a time is how a turn turns into a build-fingerprint investigation.

## What this blocks

`verify:secret-tenancy` cannot certify the cross-tenant secret boundary while its positive control
fails, and it correctly refuses to: it reports **30/32 with the control red and exits 1** rather than
presenting the passing attack rows as a result. The attack rows themselves look right — a foreign
endpoint answers `404`, no secret material appears in any body, and Org B's stored state is unchanged
— but "no leak" on a route the owner cannot use is not a tenant-isolation result. It is a route that
refuses everyone, which is the exact confusion the positive control exists to prevent, and this is the
fourth time in this campaign that the control has been the thing that found the defect.
