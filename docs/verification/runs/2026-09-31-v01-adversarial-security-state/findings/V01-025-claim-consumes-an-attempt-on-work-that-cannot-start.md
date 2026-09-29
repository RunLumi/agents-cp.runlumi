# OBS-001 — a claim can consume an automation's whole retry budget on work that can never start

## Status

**found and REPAIRED.** Severity **medium**, and it was *understated* when first observed: see
"severity, revised" below.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-IDEM-008` (new) — *a claimed occurrence is one the device can actually run* |
| **Setup** | a real Worker and fresh D1. One organization with **no** `automations.max_active` entitlement, one enrolled device with a real ed25519 proof, one automation with `max_start_attempts: 1`, and a `run_now` occurrence. |
| **Action** | claim the occurrence, then start it. Read the occurrence row and the lease table from D1. |
| **Expected** | either the claim is refused (nothing is spent), or the start succeeds. A claim that hands out a lease and burns an attempt for work the product will refuse is spending the automation's entire retry budget on nothing. |
| **Actual** | claim **`201`**, state `leased`, `attempt = 1`, **one active lease**. Start **`403 permission_denied` / `entitlement_not_granted`**. `run_id` stays null. The occurrence is now at its attempt ceiling with no run. |
| **Evidence** | `evidence/v01-023-attempt-exhaustion.txt` (the OBS-001 section) |
| **Verdict** | **FAIL, repaired** |
| **Regression gap** | none — asserted in `verify:attempt-exhaustion` with an **entitled control** |
| **Severity** | **medium** (org-internal availability, not isolation) |

## The asymmetry, and why it is the claim's job to close it

`start_occurrence` re-reads dispatch eligibility immediately before it creates the run:

```rust
// The principal, policy, and entitlement are re-read here, immediately before
// the P05 run exists. A value captured at schedule creation is never authority.
let eligibility = crate::jobs::automations::read_dispatch_eligibility(..).await?;
if let Some(block) = crate::jobs::automations::dispatch_block(&automation, &eligibility) { … }
```

`claim_occurrence` does not. It reads the occurrence, computes `attempt = occurrence.attempt + 1`,
checks it against `max_start_attempts`, and hands out a lease. It never asks whether the automation
is dispatchable.

The damage is specifically about **where the attempt is spent**. The counter moves at *claim* time,
so a check at *start* time cannot undo it: with the tightest legal bound (`max_start_attempts: 1`,
`CHECK (… BETWEEN 1 AND 3)`) a single such claim leaves the occurrence permanently unstartable, and
the sweep resolves the slot to `failed`. The attempt budget — the thing `verify:attempt-exhaustion`
exists to prove is enforced — is consumed by an operation that provably cannot succeed.

**Who can do it:** any active device in the organization. Not cross-tenant, so this is availability
of the org's own automations rather than an isolation breach. That is the whole of the medium rating,
and it is the reason the fix is a guard rather than an authorization change.

## The control that makes it an attack rather than an observation

`"No run was created"` is satisfied by an organization that can never start anything — which is the
state the attack asserts about. So the probe grants the entitlement and repeats the same two calls:

| | claim | start |
|---|---|---|
| unentitled organization | `201`, attempt 1, one active lease | **`403` `entitlement_not_granted`**, no run |
| **same org, once granted `automations.max_active`** | `201`, attempt 1 | **`201`**, `state=started`, a real `run_id`, one `automation_run_links` row |

Without the second row the first is not a finding — it is a restatement of the fixture. This is the
fourth time in this campaign that a control, not the attack, is what makes a claim mean something.

## Severity, revised

OBS-001 was first written as a *medium* observation with the reasoning that "a device can waste an
attempt on undispatchable work". That was right about the mechanism and **wrong about the worst case**,
and it was wrong because of **V01-023**: while it stood, `start_occurrence` could not succeed for *any*
organization, entitled or not. So the attempt was not merely wasted on undispatchable work — it was
wasted on **every** claim, and no automation in the system could ever run.

The asymmetry is still real and is still worth closing, because V01-023 is fixed and the two gates are
independent: fix the guard, and OBS-001 is the next thing that bites. But the honest reading is that
OBS-001 was **masked by a larger defect**, and it was only measurable once the larger one was gone.

## The repair

`claim_occurrence` now reads dispatch eligibility and applies `dispatch_block` **before** it computes
the attempt, so an undispatchable occurrence is refused at the point where refusing it is free:

- the same `read_dispatch_eligibility` / `dispatch_block` pair `start_occurrence` uses, so the two
  routes cannot disagree about what "dispatchable" means;
- **before** `let attempt = occurrence.attempt + 1`, which is the whole point — the counter must not
  move for work that cannot start;
- `start_occurrence` keeps its own re-read. Eligibility can change between a claim and a start (a
  license can lapse, an entitlement can be revoked), so the start's check is the load-bearing one and
  this is defence in depth. Duplicating a check is not a parallel concept here; it is the same
  function called at two points in one lifecycle, which is what `start_occurrence`'s own comment
  already argues for.

## Regression coverage

`verify:attempt-exhaustion` asserts, in order and with the control between the halves:

1. the attack organization holds **no** entitlement, so a start refusal is attributable to that;
2. the claim **succeeds** on it — the pre-fix behaviour, and the assertion that would fail if a future
   change made the claim refuse for an unrelated reason;
3. **after the repair**, the claim is **refused**, with no lease and **no attempt consumed**;
4. the entitled control still claims, starts and creates a run.

Point 2 is worth a note. A repair that made the claim refuse *always* would satisfy point 3 and break
point 4, so point 4 is what stops the fix from being a route that refuses everything. Point 3's
counter-assertion — `attempt` still 0 and no active lease — is what makes it a repair rather than a
different refusal.
