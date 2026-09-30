# V01-016 — a revoked device must be refused, and must not be able to mint a new token

## Status

**run. 25/26 — the load-bearing claim PASSES, and the run found a separate, adjacent defect**
(V01-019: the nonce endpoint is unauthenticated).

## Severity if it reproduces

**critical**, because it is the device credential boundary. A device token is a bearer
credential for a real agent on a real host; a revocation that does not end it is not a bug in a
bookkeeping field, it is a credential that outlives its own permission.

## Why it is UNPROVEN today

The run record lists it plainly: `p03` and `p05` **mention** device revocation, and neither
attacks it. So the only way a device credential is ever ended has no runtime evidence at all —
which is also why V01-015 could not reuse a revocation fixture.

## The claim being attacked, and the version of it that matters

The obvious claim is "a revoked device's token stops working". That is the weak version, because
revocation that only kills the token it already knows about is **escapable**: the device routes
include `GET /api/v1/devices/token/nonce` and `POST /api/v1/devices/token`, and the refresh mints
a **new** secret in exchange for a proof of possession over a fresh nonce.

So the attack is three legs after the revocation, not one:

| leg | call | what a pass requires |
|---|---|---|
| A | `GET /api/v1/devices/policy` | refused — a plain device-authenticated read |
| B | `GET /api/v1/devices/token/nonce` | refused — the first step of a credential mint |
| C | `POST /api/v1/devices/token` | refused, with a **real** `device_id`, a **real** server-issued nonce and a **real** signature over it |

**C is the one that carries the claim.** It is driven with the same ed25519 private key that
enrolled the device, over a nonce the server itself issued. A refusal there therefore cannot be an
artefact of a missing or malformed parameter — the only remaining reason is the revocation. If it
ever answers 2xx, revocation did not end the credential, it **rotated** it.

## Every leg is controlled by a success before the revocation

A refusal proves nothing on its own: a route that always answered 401 would pass this entire
probe. So before revoking, all three calls are made and must succeed — **including a full
nonce-then-refresh round trip that yields a real second token**, which is then kept and used again
after the revocation.

If any of them does not work first, the probe **exits 2** rather than reporting a refusal it
cannot interpret. That is the rule that made `verify:adoption-privacy`'s "0 hits" meaningless, and
the rule behind `verify:mutating-tenancy`'s per-route positive controls. Two places in this probe
can stop it for that reason, and both are deliberate.

## Graded on stored state, and the control that keeps the claim honest

The revocation itself is read out of D1 — `devices.status` must be `revoked` and **every**
`device_tokens` row for the device must be gone — and if it is not, the probe exits 2 rather than
measuring a device that was not actually revoked. A "revoked device was refused" line means
nothing unless the revocation reached the database first.

## The mechanism, as a clearly-labelled structural fact

Reading the code says the refusal is caused by **deletion and nothing else**:

- `DEVICE_TOKEN_BY_HASH_SQL` selects from `device_tokens` **only** — it does not join `devices` and
  does not consult `status`;
- in the whole crate there is exactly **one** `DELETE FROM device_tokens`, and it is in the same
  batch that sets `status = 'revoked'`.

So the claim is true, and true by exactly one mechanism with **no second check**. That is a real
fragility worth recording rather than a defect to invent: any future path that sets a device to a
non-active status without deleting its tokens would leave a live credential, and nothing in the
authentication query would notice.

A response cannot demonstrate the *absence* of a check, so this part is a source fact and is
labelled `STRUCTURAL:` in the output, resolved from `import.meta.url` rather than the working
directory (the `p02-guard-probe.mjs` convention). Its framing is that probe's: a test that reads
the value it is checking is circular, whereas reading the **constant** and then asking a real
database and a real Worker whether reality agrees with it is not. The two structural assertions
also print the counts — one token deletion, one `status = 'revoked'` writer — and fail if either
is not 1, because that coupling is what the whole claim rests on.

## What the run will settle

1. whether a revoked device is refused on a read, on the nonce, and on a **real** refresh (A, B, C);
2. whether the refusals are explicit 4xx with stable error codes, never a 2xx and never a bare 500;
3. whether a refused body leaks the presented device id;
4. whether the stored state really is `revoked` with zero token rows, and whether the two
   structural facts hold — that the lookup does not join `devices`, and that the coupling is
   1-and-1.

---

# The result: the credential dies, cannot be renewed, and the probe found something next door

`pnpm verify:revoked-device` reports **25/26**. The single failure is a real defect, and it is not
the one the case was built around.

## The load-bearing claim holds

| | before revocation | after revocation |
|---|---|---|
| `GET /devices/policy` | `200` | **`401`** |
| `GET /devices/token/nonce` | `200`, nonce issued | **`200` — still issues** ✗ |
| `POST /devices/token` (full refresh, real nonce, real signature) | **`200`, a REAL second token minted** | **`403`, `minted=false`** |
| `GET /devices/policy` with the second token | — | **`401`** |

And the stored state the claim rests on, read from D1: `status` went `active` → `revoked`,
`revoked_at` was stamped, and **token rows went 2 → 0**. So both tokens the device ever held are
gone, and the probe confirmed it reached the summary rather than stopping early.

The controls did their jobs, which is what makes the `403` trustworthy: a real pre-revocation mint
happened, so the post-revocation `403` is the revocation and not a route that never worked. Had the
control not run, "the refresh is refused" would have been the same sentence as "the refresh is
broken".

**So a revoked device cannot obtain a credential, by either route.** That is the critical claim,
and it is **PASS** — with runtime evidence, for the first time, after `p03` and `p05` had only ever
*mentioned* revocation.

## And the mechanism is exactly one line, which is worth stating

Both structural assertions held. `DEVICE_TOKEN_BY_HASH_SQL` does **not** join `devices`, and the
crate contains exactly **one** `DELETE FROM device_tokens` and exactly **one** writer of
`status = 'revoked'` — in the same batch. So the claim is true by a single mechanism with no second
check, and the fragility recorded before the run is real rather than speculative: a future path
that marks a device inactive without deleting its tokens would leave a live credential, and nothing
in the authentication query would notice.

## V01-019 — `GET /api/v1/devices/token/nonce` is unauthenticated

The route's whole signature is the evidence:

```rust
pub async fn token_nonce(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
) -> Result<Response, ApiError> {
```

There is no `HeaderMap` parameter, and no authentication call. It mints `new_secret()` and returns
it to **any caller** — an anonymous browser, a revoked device, anyone. Every one of its neighbours
in `app.rs` (`/devices/heartbeat`, `/devices/policy`, `/devices/policy/ack`, `/devices/token`)
requires `Authorization: DeviceToken`; this one requires nothing.

**Severity: medium, and deliberately not higher.** The nonce is useless on its own: the refresh
needs a valid device token *and* a valid ed25519 signature over the nonce, and the refresh
correctly answers `403` for the revoked device. There is no path from an anonymous nonce to a
credential, and the probe demonstrates that rather than assuming it.

It is still a real defect on three counts:

1. **It is unauthenticated**, in a group of routes where every sibling authenticates. A nonce is
   supposed to be the fresh half of a proof of possession; issuing one to a party that has proved
   nothing makes the construct weaker than the refresh's own comment describes it — *"The nonce is
   delivered by GET /devices/token/nonce and never stored server-side."*
2. **It does not consult revocation.** A revoked device still receives fresh server-generated
   secret material, which is precisely the question this probe was built to ask, and for this
   endpoint the answer is that revocation did not reach it.
3. **It mints unbounded server-issued secrets to anonymous callers** — a resource-consumption and
   oracle surface, on a route whose only other job is to gate a signature check.

The fix is small and needs no contract change: take the `HeaderMap`, authenticate as a device, and
refuse a non-`active` device. Every ingredient already exists in the module.

## What the framing bought, and the honest note on my own errors

This defect was found **because the probe insisted on the full mint path** rather than stopping at
"the old token stopped working". The dead-token version of this case would have passed cleanly and
reported 26/26 while leaving an unauthenticated secret-minting endpoint in place.

The record should also say plainly that **this probe did not work when first run**, and neither did
its two siblings: `revoke_device` is a `DELETE` on the device resource rather than a `POST` to
`/revoke` (I had this wrong in two probes and hit the router's bare fallback 404), and the refresh
returns `200` rather than `201`. In each case the probe **refused to grade** — exit 2, with the
reachability guard naming how far it got — rather than reporting a defect that was a fixture bug.
That is the `bail()` fix paying for itself, and it is the third time in this round that a probe
which had never run turned out to have a defect only running could find.
