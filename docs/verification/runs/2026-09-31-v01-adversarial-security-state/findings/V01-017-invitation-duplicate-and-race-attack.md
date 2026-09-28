# V01-017 — inviting the same person twice, and the read-then-write behind it

## Status

**attack written, not yet run.** Evidence and verdict are filled in by the run.

## Severity

**medium** as a defect, **high as a diagnosability one** — and the second is the part that is
certain rather than predicted. A caller told "the control-plane store is unavailable" when the
truth is "this address is already invited" cannot act, cannot retry meaningfully, and cannot alert
correctly. That is the V01-010 family.

## The gap, and how reading it properly changed it

GAP-006 recorded `organizations.rs` invitations as "a read-then-write on a deterministic
identifier — a **race**, not an absence — correct in sequence, wrong under concurrency". Reading
the handler narrows that, and the narrowing is the finding:

```rust
let key = idempotency_key(&headers, &context)?;
let invitation_id = deterministic_resource_id(..., &key, ...);
if let Some(existing) = repository.find_invitation(&invitation_id).await? { /* replay or 409 */ }
// …then, on a miss:
let batch = vec![invitation_statement, security_statement, outbox];   // ← raw batch
```

**The handler never calls `commit_mutation`.** There is no idempotency claim and no guard in the
batch — which is the V01-009 shape in `projects.rs` and the shape V01-015 is looking for in
`devices.rs`, except that here the key is not even discarded: it is used to derive an id.

**The stored state is protected anyway**, by two constraints:
`invitations.invitation_id` is the PRIMARY KEY, and
`ux_invitations_pending_target` is `UNIQUE (org_id, email) WHERE status = 'pending'`.

The campaign grades on stored state, and a duplicate row is not available here. So the race — the
thing the gap was named for — is the *secondary* case.

## The sharper case needs no concurrency at all

A **sequential** second invite of the same email with a **different** key:

1. derives a different `invitation_id`, so `find_invitation` **misses** — correctly, because that
   is a genuinely different request;
2. reaches the insert, which violates `ux_invitations_pending_target`;
3. aborts the whole batch, so the `security_events` and `outbox_events` writes roll back with it;
4. and the caller is answered `503 service_unavailable` — *"The control-plane store is
   unavailable."*

Nothing about that is a race. It is one request, and it is the most likely thing a real operator
does: inviting the same colleague twice from the admin UI.

The distinction the gap drew matters here: the read-then-write is not merely *wrong under
concurrency*, it produces the wrong **response** for a *sequential* duplicate, because the
read-then-write only knows about duplicates that share a key.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-RACE-003` (new) |
| **Setup** | a real `wasm32` Worker and fresh local D1; a real owner and organization; **11 invitation requests** in total across four cases. |
| **Action** | **control:** one real invitation. **Case 1:** a *sequential* duplicate, same email, **different** key. **Case 2:** six *concurrent* invites, one key, one email, one payload. **Case 3:** four *concurrent* invites, **four** different keys, one email. Every count read from D1; every per-status breakdown printed. |
| **Expected** | one pending row per email in all four cases; every duplicate and every loser answered an explicit 4xx with a stable code; **no 503 anywhere**, because none of these is a store outage; and the count of successful invitation audit events equal to the count of rows, so a refused or lost race wrote no audit entry. |
| **Actual** | pending the run |
| **Evidence** | pending the run (`evidence/v01-017-invitation-race.txt`) |
| **Verdict** | pending the run |
| **Regression gap** | pending the run |
| **Severity** | medium; high for diagnosability |

## Why "no 503 anywhere" is the assertion that carries this

A 503 on any of these is not a style question. The body says the control-plane store is
unavailable, which is what V01-010 found this codebase already answering for causes it had thrown
away. A duplicate invite is a **client-correctable** condition — change the address, or accept
that the person is already invited — and answering it with an outage is the same defect as
discarding a cause: the caller is told something false and cannot recover.

The assertion is stated as "every loser is a 4xx and **none** of them is a 503" rather than as "the
losers failed", because both a clean 409 and a 503 count as "failed" and only one of them is
correct.

## The assertion that would otherwise pass for the wrong reason

Case 1's row-count assertion (`still exactly one row`) is satisfied by the partial unique index
whether or not the route does anything sensible. So the case's *real* content is the status
assertion beside it, and the probe states both. This is the same structure as V01-008's positive
control and as V01-015's different-key call: **a state assertion that a constraint satisfies for
free cannot be the one that decides the verdict.**

## The contract question is already settled — inside the same file

I recorded earlier that the repair might need a new stable code, and that if the spec's vocabulary
lacked one this would be a deliberate-change-process item rather than something to invent. **It
does not need one, and no contract change is required.** The invitation routes already establish
the pattern three times over, in the same module:

| route | what it does on a duplicate |
|---|---|
| `accept` | `domain_error(context, Conflict, "invitation_replayed", "The invitation is no longer available.")` |
| `resend`, `revoke` | checks `D1Adapter::changes(&results[0]) != 1` and returns `Conflict` |
| **`invite`** | **neither** — no rows-affected check, and the batch's failure is mapped to a bare `503` |

Two facts follow, and they change the finding:

1. **The vocabulary exists.** `ApiErrorCode::Conflict` serialises as `"conflict"`, and the codebase
   already carries 28 uses of `version_conflict`, 13 of `idempotency_conflict` and 4 of
   `invitation_replayed` under it, each distinguished by `details.reason`. A duplicate invite is
   the same shape as an already-used invitation, so `conflict` + a reason is the file's own
   convention rather than an invention.

2. **The rows-affected check is already written, twice, next door.** `resend` and `revoke` both
   do `changes(&results[0]) != 1` → `Conflict`. `invite` does not — which is precisely why a
   constraint violation becomes an opaque 503 rather than a refusal. **The handler is the outlier
   in its own module**, which is the strongest available form of "the intended behaviour is
   clear": the repair is not a design decision, it is internal consistency.

So this does not go to the deliberate change process. It is an implementation defect with an
existing in-file precedent, and the attack exists to establish its shape and its severity before
the repair is written.
