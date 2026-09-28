# V01-016 — a revoked device must be refused, and must not be able to mint a new token

## Status

**attack written, not yet run.** Evidence and verdict are filled in by the run.

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
