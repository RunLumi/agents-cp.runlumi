# V01-019 — `GET /api/v1/devices/token/nonce` is unauthenticated

## Status

**found by `pnpm verify:revoked-device`, not yet repaired.** The finding record exists before the
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
