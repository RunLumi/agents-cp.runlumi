# V01-019 — `GET /api/v1/devices/token/nonce` is unauthenticated

## Status

**CLOSED.** `pnpm verify:revoked-device` is 29/29, exit 0. The finding record exists before the
repair, as the campaign requires.

## Severity

**medium**, and deliberately not higher. The nonce is useless on its own: `POST /api/v1/devices/token`
requires a valid device token **and** a valid ed25519 signature over the nonce, and it answers
`403` for a revoked device. There is no path from an anonymous nonce to a credential, and the
probe demonstrates that at runtime rather than assuming it.

It would be **critical** if the refresh accepted the nonce alone, and that is the assertion to keep
in place after any repair here.

## The evidence

The route's whole signature:

```rust
pub async fn token_nonce(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
) -> Result<Response, ApiError> {
    database(&state, &context)?;
    let nonce = new_secret();
    let expires_at = add_seconds(&context.received_at, ENROLLMENT_TTL_SECONDS)
        .map_err(|_| service_unavailable(&context))?;
    Ok((StatusCode::OK, Json(NonceResponse { nonce, expires_at: expires_at.as_str().to_owned() }))
        .into_response())
}
```

There is **no `HeaderMap` parameter and no authentication call.** It mints `new_secret()` and
returns it to any caller.

Measured, on a real Worker and a real D1, with a real device that was enrolled, approved, completed
and then **revoked**:

| request | result |
|---|---|
| `GET /api/v1/devices/token/nonce` with **no** `Authorization` header | **`200`**, a fresh 64-hex nonce |
| `GET /api/v1/devices/token/nonce` with a **revoked** device's token | **`200`**, a fresh nonce |
| `GET /api/v1/devices/policy` with a revoked device's token | `401` — for contrast |
| `POST /api/v1/devices/token` with that nonce and a real signature | `403`, `minted=false` |

Evidence: `evidence/v01-016-revoked-device.txt`.

## Why it matters, given the nonce alone is useless

Three reasons, none of which depends on the nonce being sufficient on its own:

1. **It is unauthenticated in a group where every sibling authenticates.** `app.rs` registers
   `/devices/token/nonce` alongside `/devices/heartbeat`, `/devices/policy`, `/devices/policy/ack`
   and `/devices/token` — all of which require `Authorization: DeviceToken <token>`. A nonce is the
   fresh half of a proof of possession. Issuing one to a party that has proved nothing makes the
   construct weaker than the refresh's own comment claims: *"The nonce is delivered by
   `GET /devices/token/nonce` and never stored server-side."* That is a true statement about storage
   and a misleading one about who receives it.

2. **It does not consult revocation.** The campaign's Tier-0 question is whether revocation ends a
   device's credential. For the credential itself the answer is **yes** — proven, with the stored
   `status` read from D1 and both tokens refused with `401`, and the refresh refused with `403`. For
   this endpoint the answer is **no**: a revoked device still receives fresh server-generated secret
   material. A revocation that has to be enforced in four places and is enforced in three is one
   refactor away from being enforced in two.

3. **It mints unbounded server-issued secrets to anonymous callers.** That is a
   resource-consumption surface and an oracle, on a route whose only other job is to gate a
   signature check.

## Why nothing caught it

The same reason as V01-011, and now measurable: **no probe in the repository had ever created an
automation, a run, or a completed device token and then used it.** `p03` and `p05` exercise the
enrollment and completion ceremonies; neither authenticates with the resulting token, so nothing ever
reached a *post*-issuance device route with a *revoked* one.

That is the third time this campaign has found a defect of the shape *"a route that answers a
plausible response and has never been exercised with the credential it exists to check"*, after
`teams` and the 15 `evt_` audit writes.

## The fix, and the assertion that must survive it

Small, and it needs no contract change: take `headers: HeaderMap`, authenticate as a device with the
existing module helper, and refuse a device whose `status` is not `active`.

**The regression test that matters is not "the nonce endpoint now 401s".** That would pass if the
route simply always refused, which is the `verify:adoption-privacy` failure mode. The test must
assert both directions at once:

- a live, `active` device with a valid token still receives a nonce — the route keeps working;
- a **revoked** device, and a caller with **no** credential at all, are both refused.

And separately, the assertion that keeps the severity where it is: **the refresh must still refuse a
nonce obtained without a valid token and signature**, so that a future change making the nonce
sufficient is caught here rather than in production.

## What this finding says about the campaign's own coverage

`verify:revoked-device` was written to test one claim — that revocation ends a device credential —
and that claim **passed**. The nonce defect was found only because the probe drove the whole
*refresh* path rather than stopping at "the old token stopped working".

That is the third time in this campaign that insisting on the full path, rather than the obvious
short version, found something the short version would have passed over. It is worth treating as a
standing rule: **a claim about a credential should be tested through every route that can produce
one, not through the one that is easiest to reach.**

---

# Closure

## The fix, in two halves, at two different layers

**`token_nonce` now takes `headers: HeaderMap` and calls `authorize_device`.** That is the direct
answer: a nonce is the fresh half of a proof of possession, so issuing one to a party that has
proved nothing is incoherent.

**`authorize_device` now also refuses a device whose own `status` is not `active`.** That is the
part that matters, because it is not about this route. `DEVICE_TOKEN_BY_HASH_SQL` selects from
`device_tokens` and does not join `devices`, so nothing downstream of it can see a device's status:
the token lookup answers *"is this secret live"*, not *"is this device allowed to act"*. Revocation
worked only because `revoke_device` deletes the token rows in the same batch that sets
`status = 'revoked'` — **one mechanism, with no second check**, exactly the fragility V01-016
recorded. Now there are two, and they are in different places: a route that skips `authorize_device`
is the only remaining way in.

The refusal reuses the module's existing vocabulary — `permission_denied` / `device_revoked` /
*"The device has been revoked."*, the same answer `load_active_device` already gives. Two
vocabularies for one fact would let a client treat a revoked device as differently broken depending
on which route it reached for, which is the V01-010 shape wearing a different hat.

## The attack, re-run unchanged: 29/29, exit 0 (was 25/26)

| | before | after |
|---|---|---|
| `GET /devices/token/nonce` — **revoked** device | **`200`**, fresh 64-hex nonce | **`401`** |
| `GET /devices/token/nonce` — **no credential at all** | `200`, fresh nonce | **`401`**, `authentication_required`, no nonce |
| `GET /devices/token/nonce` — anonymous, after the revocation | `200` | `401` |
| `GET /devices/policy` — both tokens | `401` | `401` |
| the credential claim itself | **PASS** | **PASS** — unchanged |

The anonymous leg was **added**, because the revoked-device leg alone would not have caught this: a
revoked device still *had* a credential once, so a check that only tried a revoked device would
have passed against a route that authenticated nobody. It is now asserted before *and* after the
revocation, so the refusal is demonstrably the route's own gate rather than a side effect of the
device being revoked.

## The regression test walks the ROUTER, not the route

A test pinning `token_nonce` would be worth little: the same omission in the next device route would
pass. So the test reads `app.rs`, finds every route under `/api/v1/devices/` whose handler lives in
`routes::devices`, and requires that handler to take a `HeaderMap`. A new device route added
without credentials fails at compile time, with the path and the function name in the message.

**And it was shown to fail.** Re-introducing the defect — removing `headers` from `token_nonce` and
its `authorize_device` call — makes it report exactly
`"/api/v1/devices/token/nonce -> devices::token_nonce"`. A regression test that has only ever
passed proves nothing, and this one has watched itself fail.

Two details in it are worth recording because they are the ways such a test rots:

- **It refuses to pass having checked nothing.** The first version of the parser found no routes
  (because `app.rs` writes some registrations on one line and some across four) and the assertion
  `!device_routes.is_empty()` turned a silently-empty check into a failure. A line-oriented filter
  that finds *some* of what it looks for is worse than none, because the misses are silent.
- **Its one exemption is self-invalidating.** `refresh_token` is allow-listed because it
  authenticates by **proof of possession** rather than by bearer token — a `device_id` in the body
  and a signature over a fresh nonce, which is how a device whose token just expired gets a new
  one, and it refuses a revoked device from `load_active_device`. The test asserts that
  `refresh_token` **still** lacks a `HeaderMap`, so if it is ever changed to use a header, or
  renamed, the exemption stops applying instead of quietly hiding the next omission.

## What the repair did not need

No contract change, no new error code, and no new configuration. Every ingredient already existed in
the module — `authorize_device`, `load_active_device`, and the `device_revoked` reason. The defect
was an omission inside a module that had already solved the problem twice elsewhere, which is the
cheapest kind of defect to fix and the most expensive kind to leave in place.
