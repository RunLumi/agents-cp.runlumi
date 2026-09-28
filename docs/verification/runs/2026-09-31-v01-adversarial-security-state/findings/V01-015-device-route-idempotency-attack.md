# V01-015 — do `approve_enrollment` and `revoke_device` honour an `Idempotency-Key`?

## Status

**attack written, not yet run.** Evidence and verdict are filled in by the run.

## Severity if it reproduces

**medium**, and deliberately not higher. Reading suggested this could duplicate a live device
credential, which would be high; it cannot, because `INSERT_DEVICE_SQL` sits under a
`UNIQUE (org_id, key_fingerprint)` and a replayed approval reuses the *enrollment's* key
fingerprint. So the likely outcomes are a spurious 503 on a legitimate client retry, and a
divergent body on a retried revoke. A retried request that already succeeded is answered with a
store outage, which is a real client-facing defect and a diagnosability one — the class V01-010
and V01-012 are about — but it is not a credential duplication.

That downgrade is itself a recorded result: the hypothesis that this route duplicates a security
principal was **falsified by reading the schema before the probe ran**, and the probe is still
written to measure rather than to confirm.

## The gap it attacks, and the correction to the gap

GAP-005 as recorded named two files. **One of them was wrong, and the error was mine.**

`foundation_checks.rs` does not ignore its key. It builds an `IdempotencyScope`, digests the key
with `sha256_hex(key.expose_for_digest())`, fingerprints `POST\n{path}\n{canonical_body}` into a
`RequestFingerprint`, then does `idempotency.lookup(...)` and a commit-time `lookup` with
`replay_response`. It is a complete idempotency flow. It entered the gap because the gap was
written by reading *for the pattern* — `read_idempotency_key` on line 51 looks like the V01-009
shape at a glance — rather than by reading the member. GAP-005 is narrowed in
`next-verification-actions.md` accordingly.

`devices.rs` is real. Two routes require a key and discard the string:

```rust
idempotency_key(&headers, &context)?;   // approve_enrollment, devices.rs:1267
idempotency_key(&headers, &context)?;   // revoke_device,       devices.rs:1468
```

Neither checks `rows_affected` on the guarded statements, and `revoke_device` mints no new
identifier. `REVOKE_DEVICE_SQL` is `WHERE device_id = ?1 AND status = 'active'`, so a second
revoke matches nothing and returns early — before the audit row. So what saves `revoke_device`
is an **incidental state guard, not idempotency**, and the probe is built to say so.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-IDEM-004` (new) |
| **Setup** | a real `wasm32` Worker and fresh local D1; a real owner and organization; **two** real device enrollments, each a real ed25519 keypair, each approved with a real device proof, so there is a real device token in each case. Two independent devices so case 1's state cannot make case 2's refusals look correct. |
| **Action** | for each route: call it once with key K, then call it **again with the same key K**, then call it **again with a different key K2** against the same fixture state; read the devices, the device tokens, the audit rows and the enrollment out of D1 after each call. |
| **Expected** | the replay returns the first response, status and body alike, and writes nothing: one device row, one audit row, one revocation timestamp. |
| **Actual** | pending the run |
| **Evidence** | pending the run (`evidence/v01-015-device-idempotency.txt`) |
| **Verdict** | pending the run |
| **Regression gap** | pending the run |
| **Severity** | medium unless the run finds a duplicated device row, which would be high |

## The design decision that this case lives or dies on

**The different-key call at the end of each case is a positive control, not a formality.**

A replay test can pass for the wrong reason: the second call is refused because the enrollment
is no longer `pending` or the device is already revoked, and the probe then reports "the key was
honoured" when the route would have refused a second attempt whatever key arrived. That is how
V01-008 hid for the life of the project PATCH — every cross-tenant attack was correctly refused,
and the one call that had to *work* answered 409, so the positive control is what found the
defect.

So each case ends by calling the same route with a **different** key against the **same** state.
A different key is a different request, so whatever it answers is the route's answer to a
genuinely new one. If the replay and the different-key call answer the same thing, the key is not
what distinguishes them and the route is refusing repeats from a state guard. There is no
disjunct that lets a differing first-response status excuse this, because that is precisely the
condition it exists to catch.

## What is graded on stored state rather than on the response

Every verdict reads D1. Specifically: the number of `devices` rows for the enrollment, the
number of `security_events` rows for the device, and `revoked_at` on the device. A 503 that
wrote nothing and a 201 that wrote a second device are different findings, and only the rows
tell them apart — which is the same discipline that graded V01-008 and V01-009.

One assertion is about audit integrity alone and does not depend on any response:
**a replayed revoke records no additional audit event**. That is the half of a discarded key
that matters even when the state guard makes the route appear safe, and the probe prints the
event counts grouped by action and resource so a duplicated logical action is visible in the
output rather than only in a verdict.

## If it reproduces

The repair is the V01-009 shape: wire both routes into `prepare_scoped_mutation` /
`commit_scoped_mutation` the way `create_project` now is, with a regression test per route. The
subtlety worth recording before the repair — because it is what a read-the-code repair would get
wrong — is that `revoke_device` **already** returns the right stored state on a replay. The
repair must therefore add a *replayed response*, not a new guard, or it will look like a no-op
and the test will pass for the wrong reason.
