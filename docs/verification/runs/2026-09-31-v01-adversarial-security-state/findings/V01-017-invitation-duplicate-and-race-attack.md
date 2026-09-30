# V01-017 — inviting the same person twice, and the read-then-write behind it

## Status

**run. 23/23, exit 0 — the hypothesis is FALSIFIED.** The route is correct. GAP-006 is closed by
falsification rather than by a repair, and the probe stays as a regression gate.

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
| **Actual** | **one invitation row in all four cases, no 5xx anywhere, and correct replay.** First `201`. Sequential duplicate (different key) `200` with `duplicate: true`, same `id`, 1 row. Six concurrent on one key: **1 creation at 201, 5 replays at 200, 0 refusals**, 1 row. Four concurrent on four keys, one email: **1 creation, 3 replays**, 1 pending row. Audit events `membership.invited.v1` = **3**, matching the 3 invitations that exist |
| **Evidence** | `evidence/v01-017-invitation-race.txt` (23/23, exit 0) |
| **Verdict** | **NOT_APPLICABLE — no defect.** The read-then-write is correct under every shape attacked |
| **Regression gap** | none. The probe is the regression gate, and it passes |
| **Severity** | **none** — the predicted defect does not exist |

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

---

# The result: the hypothesis is wrong, and saying so is the finding

`pnpm verify:invitation-race` reports **23/23, exit 0**. Every prediction in the record above is
falsified, and they are falsified in the direction that matters:

| predicted from reading | measured |
|---|---|
| a **sequential** duplicate with a different key aborts the batch and answers **`503 service_unavailable`** | **`200`**, carrying `duplicate: true`, referring to the *same* invitation id |
| concurrent same-key racers mostly **fail** with a store fault | **1 creation at 201, 5 replays at 200, 0 refusals**, and one row |
| concurrent different-key racers mostly fail | **1 creation, 3 replays**, one pending row |
| some racer answers a 5xx | **no racer answered a 5xx anywhere** |

And the audit trail agrees with the rows: `membership.invited.v1` = **3** events for the 3
invitations that exist. So a refused or lost race wrote no audit entry either.

**So GAP-006 was not a defect.** The read-then-write is correct in sequence and correct under
concurrency, and the `duplicate: true` answer is *better* than the 409 I demanded: it tells the
caller the invitation exists rather than only that their request conflicts.

The interesting part is **why** it holds, because it is not the mechanism I assumed. I expected the
`find_invitation` read-then-write to be the weak point, with the `invitation_id` PRIMARY KEY and
`ux_invitations_pending_target` as backstops that turn a race into an error. Instead **the
replay branch is reached**: five of six racers found the existing invitation and replayed it. The
derived id is evidently stable per *(org, email, role)* rather than per key, so the read hits
rather than misses. The two constraints are the backstop, not the mechanism — which is the
difference between "correct" and "correct by luck", and here the reading is what it is because
something stronger is underneath.

## Three assertions of mine were wrong, and two of them were failing for the right reason

This is the sixth and seventh wrong-reason or vacuous pass of the round, and both of these were
caught only by running:

1. **"at most one of the six racers is a success" failed with `successes=6`.** I counted every 2xx
   as a success, so five *correct replays* read as five extra invitations. That is the exact
   inversion of the rule I wrote into this file's own header — **grade on stored state, never on
   status** — and I broke it while writing the file that states it. The assertion now counts
   **creations** (201), which is the thing that must be unique.

2. **"every losing racer is an explicit refusal … and NONE is a 503" was vacuous.** It filtered to
   `status >= 400` first, and since the losers *replayed* rather than being refused, the set was
   empty and the assertion had checked nothing while reporting PASS. It is now stated over **all**
   racers — no racer may answer a 5xx — which is the claim I actually meant, and it is checkable
   whether the losers replay or refuse.

3. **The duplicate criterion itself was mis-stated.** I demanded a "stable 4xx conflict"; the
   product answers `200` with an explicit `duplicate: true`, which is honest and more informative.
   The requirement worth asserting is that the answer is **explicit** — a marked 2xx or a stable
   4xx — and never a bare 2xx that looks like a fresh creation, and never a 503. That is now what
   the probe says. (Its id assertion also guessed `invitation.invitation_id`; the redacted
   projection names it `id`, read from `redact_invitation` so the assertion is about the response
   rather than about my guess at it.)

## What this is worth beyond closing a gap

A gap recorded from reading, and then **falsified by an attack, is a good outcome** — it is the
campaign working. The alternative is a gap that sits in the record implying a defect, and gets
"addressed" by a repair that changes correct code.

The specific trap here was reading `find_invitation(...)` + `insert` and concluding "race". The
read-then-write shape is only a race if the read can miss. Here the derived id makes the read hit,
and the two constraints are the belt to a pair of braces that are already doing the work. **A gap
phrased as a mechanism ("this is a read-then-write") is weaker evidence than a gap phrased as an
outcome ("two invitations can exist for one address")**, and the second is what the probe attacks.
