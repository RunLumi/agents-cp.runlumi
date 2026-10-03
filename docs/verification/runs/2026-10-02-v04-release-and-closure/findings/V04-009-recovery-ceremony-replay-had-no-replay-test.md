# V04-009 — the recovery ceremony had no replay test; the structural claim in the first draft of this finding was **wrong**

**Severity: LOW, and downgraded from MEDIUM by measurement. The coverage gap was real and is now
closed. The structural claim it was first written with — that recovery was defended by one layer where
its siblings have two — was false, and the mutation is what proved it.**

## What is true, and was verified

`smoke:passkey` drove replay for **registration** and for **login**. Recovery had **no such case**,
while recovery is the ceremony that changes an account password. That coverage gap was real, and it is
now closed: `apps/api/scripts/p02-passkey-smoke.mjs` carries four new assertions, the baseline moved
**76/76 → 80/80**, and `evidence/v04-009-sensitivity.sh` proves the new case can fail (**DETECTED**,
exit 0).

## What was false, and how the mutation caught it

The first draft of this finding asserted a table: `ensure_pending` is the shared route-level replay
guard; it is called for `PasskeySignup`, `PasskeyLogin`, `PasskeyAdd` and `Reauthenticate`; it is
called for **none** of recovery; therefore recovery has **one** defence, `consume_recovery`'s
compare-and-set, where its four siblings have two.

The table was built by reading the code for **calls to `ensure_pending`**. That is a search for one
implementation of the guard, not for the guard.

The sensitivity run falsified it immediately. With `consume_recovery`'s compare-and-set replaced by an
unconditional `Ok(true)` — the path's supposed *only* defence — the replay was **still refused**, and
the probe stayed green at 80/80. So a second defence existed. It is at `routes/authenticators.rs:971`:

```rust
let challenge = repository.find_recovery(&body.challenge_id).await...;
if challenge.status != "pending"
    || challenge.expires_at.as_str() <= context.received_at.as_str()
{
    return Err(generic_recovery_failure(&context));
}
```

That is **the same check `ensure_pending` performs** — status is pending, not expired — but **inlined in
the handler** rather than factored into the shared function. Recovery therefore has the same two-layer
structure as its four siblings, and the correct fault is a two-site mutation, exactly like VI-AUTH-001's
login case. Re-run with both sites removed, the replay is accepted and the new probe case goes red:
**DETECTED**.

| fault | result | what it establishes |
|---|---|---|
| `consume_recovery`'s CAS only | replay still refused, 80/80 | a second defence exists |
| inline guard **and** the CAS | replay accepted, new case **FAIL** | recovery has exactly two defences, and the new probe detects their joint removal |

**The lesson is the generalisation, not the repair: absence of a call to a named helper is not absence
of the guard.** A factored function and its inlined equivalent are the same defence, and grepping for
one of them cannot tell you whether the other is present. This is the fourth time this campaign inferred
a conclusion from a single instance and was wrong — the others are in
`V04-008`'s companion notes and in the verdict's mutation sample: `FR-F13-005/006` read as coarse from
the `BrowserCapability` enum when `BrowserPolicy`/`ComputerPolicy` carry a field per sub-control;
`FR-F23-007` read as an inert label when it is enforced at `routes/tools.rs:135`; a site-2 anchor read
as unique when it occurs three times, which produced a **Tier-0 mutant survivor that did not exist**;
and this one. Four for four. **A pattern inferred from one instance is a hypothesis, and the cheapest
thing to do with a hypothesis is to run the mutation.**

## What remains true as a residual

The coverage gap is closed; the assurance gap is not, and it is small. Because the route-level guard for
recovery is **inlined**, nothing enforces that every ceremony path has one. `ensure_pending` covers
four kinds by construction; recovery is covered by a check someone wrote by hand in the handler. A
future ceremony path — or a refactor that moves recovery's logic — can lose that check silently, and
`pnpm check` would stay green, because there is no mutant for a path whose guard nobody removed.

That is recorded rather than fixed. The fix — folding recovery's inline check into `ensure_pending`, or
a check asserting every ceremony-completion route performs a status/expiry guard — is a refactor of an
authentication path, and this campaign's authority excludes changes that broaden the work it is
judging. The next action is named: fold it in, or add the mutant, and add the recovery-replay case to
VI-AUTH-001 so the class covers all five ceremony kinds rather than login alone.

## Why the new probe case is built the way it is

The refusal reason **cannot** prove which defence fired. `consume_recovery` returning `false` yields
`generic_recovery_failure`, whose reason is the deliberately undifferentiated `recovery_invalid` —
correct, because distinguishing "already consumed" from "never existed" would be an oracle, but it
makes a green status prove nothing on its own.

So the four assertions grade **stored effect**, with the replay carrying a **different** new password:

1. the replay is refused;
2. the reason is `recovery_invalid`, the same answer a wrong code gets — consuming a ceremony is not
   distinguishable from never having started one;
3. the password set by the *original* recovery **still authenticates**, so the replay changed nothing;
4. the password carried by the replay does **not** authenticate.

Assertions 3 and 4 are the ones with teeth. A refusal asserted only by status would pass on a product
that accepted the replay and then failed for an unrelated reason; and if the CAS alone were removed while
the inline guard survived, nothing would be accepted and nothing would be visible — which is exactly
what the one-site run measured.