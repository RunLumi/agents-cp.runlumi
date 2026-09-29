# V01-015 — do `approve_enrollment` and `revoke_device` honour an `Idempotency-Key`?

## Status

**run, then HALF repaired. `revoke_device` is closed; `approve_enrollment` is blocked on V01-020**
(the helper cannot express a response built from the row it writes). 21/23, the two remaining failures
being that site.

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
| **Actual** | **neither route replays.** `approve_enrollment`: first `201`, replay **`409 conflict` "The enrollment is no longer pending."** `revoke_device`: first **`204`**, replay **`409 conflict` "The device was already revoked."** In both cases the replay is **byte-identical to a different-key call** once `request_id` is set aside — so the key is not what distinguishes the two. |
| **Evidence** | `evidence/v01-015-device-idempotency.txt` (19/23) |
| **Verdict** | **FAIL — confirmed on 2 of 2; `revoke_device` repaired and proven, `approve_enrollment` open pending V01-020** |
| **Regression gap** | 2 named assertions remain, for `approve_enrollment` only. The two `revoke_device` assertions now pass |
| **Severity** | **medium, measured** — the high hypothesis (a duplicated live device credential) was falsified |

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

---

# The result: confirmed on both routes, at the severity predicted, not the one feared

`pnpm verify:device-idempotency` reports **19/23**. The four failures are the finding and the two
controls both fired.

| | `approve_enrollment` | `revoke_device` |
|---|---|---|
| first call | `201` with the device projection | **`204`**, no body |
| replay, **same** key | `409 conflict` — *"The enrollment is no longer pending."* | `409 conflict` — *"The device was already revoked."* |
| call with a **different** key | `409 conflict` — the same message | `409 conflict` — the same message |
| replay identical to the different-key call, ignoring `request_id`? | **yes** | **yes** |
| stored state after the replay | 1 device, 1 audit event — **unchanged** | `revoked`, tokens dropped, `revoked_at` **unchanged**, no extra audit event |
| extra audit event from the replay | none | none |

So the defect is precisely and only this: **no route replays its first response**, and the key is
not what distinguishes a retry from a new request.

## The high-severity hypothesis was falsified, and falsified in the right place

I recorded before the run that reading `UNIQUE (org_id, key_fingerprint)` made a duplicated live
device credential unavailable, and that the realistic worst case was therefore a spurious 503. The
run says the worst case is better than that **and different**:

- **not a 503** — `approve_enrollment` has a state check that answers a clean `409 conflict` with a
  specific message, which is the same `Conflict` + `details.reason` convention `accept` and
  `revoke` use elsewhere in the invitation routes;
- **not a duplicate** — the state assertions held exactly: one device, one audit row, one
  revocation timestamp.

Which means the recorded severity is **medium and stable**, and the finding is a
correctness/diagnosability defect rather than a data-integrity one: a client that times out and
retries cannot learn the outcome of the request it already had answered, and the message it gets
describes *state* ("the enrollment is no longer pending") rather than *its own request* ("this
request already succeeded").

That is the V01-010 family once more, and it is why the defect is worth a gate at all: the server
knows exactly what happened — it did this, under this key — and answers as if it were being asked
about the present tense of a resource.

## Two probe defects this run found, and both were vacuous passes

### 1. The different-key control could not fire

`sameBody` compares whole response bodies, and every error body carries its own `request_id`. So
two refusals identical in every respect a caller can act on compared as **different**, and the
control — whose entire job is to notice that a replay and a genuinely new request are answered the
same way — was structurally incapable of firing. It reported PASS.

The fix compares everything **except** the per-request correlation id, and with it the control does
its job: both routes now fail it, which is the finding. Note the direction of the error: a control
that cannot fire is worse than no control, because it converts an unmeasured claim into a reported
pass. That is the same shape as `verify:adoption-privacy` reporting "0 hits" over a table full of
payloads, and it is the fifth wrong-reason or vacuous pass of this round.

`sameBody` is still used for the "replays the FIRST response" assertion, and **that is correct
there**: a true replay carries the *stored* `request_id`, so demanding it makes the assertion
stricter rather than weaker.

### 2. `JSON.stringify(undefined).slice(...)` is a crash, not a formatting quirk

The first fixed run died with `Cannot read properties of undefined (reading 'slice')` on the
revoke's **`204`, which has no body** — and `JSON.stringify(undefined)` is `undefined`, not a
string. Because an assertion's detail argument is evaluated *eagerly*, the probe died building the
message that would have explained the failure.

This is fixed at the right layer: `SmokeHarness.brief(value, max)` renders any value safely, and
all **30** hand-composed `JSON.stringify(...).slice(0, n)` sites across the five V01 probes now use
it. The harness fix matters beyond these probes, because the alternative — each probe remembering
not to do this — is the kind of rule that decays.

**And the fixed `bail()` earned its place on the same run:** it reported *exit 2, "DID NOT
COMPLETE. 17 assertion(s) passed and 1 failed before it died"* instead of the exit 1 that would
have let a partial run be read as a measurement.

---

# Half-closed: `revoke_device` repaired and proven, `approve_enrollment` blocked

`pnpm verify:device-idempotency` is **21/23**. The two remaining failures are both
`approve_enrollment`; both `revoke_device` assertions now pass.

## Site 2 — `revoke_device` — CLOSED

| | before | after |
|---|---|---|
| first call | `204` | `204` |
| **replay, same key** | `409` *"The device was already revoked."* | **`204` — the stored response** |
| **different key** | `409` | `409` — **preserved, and now distinguishable from the replay** |

The different-key call is the control, and it is what makes the replay meaningful: a retried
request and a genuinely new request are now answered **differently**, which is the whole claim.

Three things made this repair possible without changing behaviour:

- the claim is taken **after** authorization, so an unauthorized caller cannot learn whether a key is
  live, and **before** the state decision, because that ordering is what makes a retry a replay;
- the `409 "The device was already revoked."` refusal is kept **verbatim**, but is now decided from
  the device record the route already reads, rather than from how many rows the write happened to
  touch. That is the distinction the record above insisted on: *a test on the stored state would
  have passed before this change and after it, and proved nothing*;
- `DeviceRepository::revoke_device_statements` is split out so the route can compose the two
  statements into the commit, and the old `revoke_device` is now a thin wrapper over it — **one
  place** decides what a revocation writes and in which order, which matters because the second
  statement is the only thing that makes revocation effective (V01-016, V01-019).

## Site 1 — `approve_enrollment` — OPEN, and it is a shape limit, not an oversight

Its `201` body is `device_json(&device)` for the row **its own commit inserts**, and
`commit_scoped_mutation` requires the stored success *before* the write. I tried it anyway, and the
probe caught the mistake where my reading of the code did not: I read the device back before
committing, so every approval answered `503`, the enrollment stayed `pending`, and the fixture's own
control reported *"the approve fixture could not be built"* with an **exit 2**.

All 27 wired call sites build their response from inputs; **none** reads the row back. Repairing
this route means either synthesising a ~12-field projection — duplicating the DDL's defaults in a
second place, which is V01-011's shape one layer up — or changing a helper contract that 27 call
sites depend on. That is an architectural decision, and I stopped rather than take it by
inspection. Recorded as **V01-020**, with the measurement that establishes the limit (27 sites, 0
read-backs) and an explicit note that **how many mutations the limit blocks is unknown** — one of
three proven by trying, and no claim made about the rest.

## The repair found a latent defect in the campaign's own pattern, which is the part worth keeping

The first run after wiring `revoke_device` answered **`500` on every replay**. `replay_response` was
`(status, Json(body))` for every status, and `(204, Json(..))` is not a legal HTTP response.

It had never been seen because **all 27 wired sites store `200` or `201`** — across **182 call sites**
of `replay_response`, not one of which had ever needed a bodyless status. So the helper the campaign
has been using to close nine findings **could not replay one of the statuses the product actually
returns**, and the symptom was a `500` on a retried request: the least diagnosable place for it to
appear.

Repaired, with four regression tests that cover **both directions** — a fix emptying every replay
would be worse than the bug it replaced, since a retried `201` must stay distinguishable from a
`204` — and one that pins `StoredSuccess::new` accepts 2xx only, so widening it cannot silently
introduce a bodyless replay path nothing covers.

The asymmetry with V01-020's read-back limit is the point. That limit is **documented and discovered
by the compiler**: the signature states it, so the next route to hit it finds out immediately. The
bodyless limit was **undocumented and discovered through production behaviour**. A shape a helper
cannot express should be a shape it rejects; a shape it mishandles is a defect whether or not anyone
has reached it yet.
