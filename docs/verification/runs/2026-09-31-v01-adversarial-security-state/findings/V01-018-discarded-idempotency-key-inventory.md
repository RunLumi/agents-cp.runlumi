# V01-018 — the discarded-`Idempotency-Key` class, enumerated exactly

## Status

**the class is CLOSED — 3 of 3 repaired, and 0 discards are now structurally impossible.** Site 3 had
no gate at all until now; site 1 was recorded as "blocked on V01-020", which was the wrong diagnosis
and is corrected in V01-015.

**81 call sites across 20 modules; 0 discard the key.** That number is now *enforced* rather than
enumerated: `usage.rs`'s `v01_018_no_discarded_idempotency_key` fails the build if any line in
`src/routes` *begins* with `idempotency_key(`, reads the directory so new modules are covered, and
asserts its own vacuity (>= 20 modules, >= 70 call sites) **before** reporting a verdict — because a
scan that read nothing would otherwise pass and claim this class closed while checking nothing.

## The count, and the correction that produced it

My first inventory said **76 discarded call sites across 19 modules**, against 28 wired. That
number is wrong, and the way it was wrong is the interesting part.

The pattern I matched was `idempotency_key(&headers, &context)?;` — which is a **substring** of
both shapes:

```rust
idempotency_key(&headers, &context)?;                 // discarded: the key is required and thrown away
let key = idempotency_key(&headers, &context)?;       // used: the key is required and bound
```

Because the first is a suffix of the second, a substring search counts 76 of them. Requiring the
call to be the **entire statement** gives:

| | count |
|---|---|
| **true discards** | **3**, in 3 distinct production functions |
| keys bound and used | 71 |

So the class is **three sites, not seventy-six**, and `create_automation` — which my bad inventory
listed — is in fact one of the *correct* ones: it binds `let key = …` and hands `&key` to
`prepare_mutation`.

This is worth recording as a finding of its own kind. A false scope claim is worse than no scope
claim, because it invites a "sweep 76 sites" response that would consume the campaign's budget
chasing sites that are already correct, while the three that are broken get lost in the noise. The
generalisation: **an inventory must distinguish a statement from a fragment of one**, and the
cheapest way to be sure is to make the pattern assert the whole line — which is what turned a
plausible 76 into the real 3.

## The three sites

| # | route | **measured** outcome of a retry on the same key | attacked by |
|---|---|---|---|
| 1 | `devices.rs:1267` `approve_enrollment` | **`409 conflict` "The enrollment is no longer pending."** — not the `503` reading predicted, and not a duplicate. One device, one audit row, unchanged. **OPEN: blocked on V01-020**, its body is a read-back projection the helper cannot express |
| 2 | `devices.rs:1468` `revoke_device` | **`409 conflict` "The device was already revoked."** — and now **`204` on a replay**, with the different-key call still `409`, so a retry and a new request are finally distinguishable | **closed** |
| 3 | `projects.rs:876` `delete_project_binding` | **`404`** on a replay — measured, not read: `first=204 replay=404 different-key=404`, so a retry and a new request were **indistinguishable**. Now **`204`**, and the different-key call still `404` | **closed** |

Sites 1 and 2 are the *only* ones with runtime evidence, and note what the measurement changed: the
`503` I predicted from the schema did not happen, because both routes have clean state guards. The
defect is narrower and sharper than predicted — **only** the missing replay — and the recorded
severity stays at medium for the right reason rather than by assumption.

## What all three share, and what differs

Shared: **the key is required, discarded, and therefore no route replays its first response.** A
client that times out and retries cannot learn the outcome of the request it already had answered.

That is the whole defect, and it is worth stating plainly because the three routes differ in how
much it costs:

- **site 1** may cost a spurious 503 on a legitimate retry, or a duplicated write;
- **sites 2 and 3** are protected by **incidental state guards** — the operations are naturally
  idempotent, and only the *response* is wrong;
- and that is the dangerous shape, because a naturally-idempotent operation looks correct. A gate
  that checks "did the state change twice?" passes; a gate that checks "did a retry get the first
  answer?" fails.

So the class is small, and the measurement that matters is a **response-replay** check rather than
a state check. `verify:idempotency` already grades on row counts, which is right for
`create_project` and **structurally unable** to see sites 2 and 3.

## Severity

**medium** for the class, and it is not a data-integrity defect: no site is known to duplicate
state. It is a correctness-and-diagnosability defect in the V01-010 family — a route telling the
caller something false about an operation that already succeeded.

## Regression gap

**None remaining.** Sites 1 and 2 are asserted by `verify:device-idempotency` (V01-015) — **23/23** —
each with a **different-key positive control** so that "the route refuses repeats for an unrelated
reason" cannot pass as "the key was honoured". Site 3 is asserted by `verify:idempotency` — **47/47**
— which is the only gate for `delete_project_binding`, whose replay used to answer `404` for a delete
that had already succeeded, indistinguishable from a different-key call.

And the *class* is asserted structurally, which is the stronger of the two: a new route that
requires a key and drops it fails a unit test rather than waiting for a probe to be written for it.
That is the difference between an inventory and an invariant, and this class was an inventory for the
whole campaign before today.

## The repair is already the codebase's own convention

28 sites are wired through `prepare_scoped_mutation` / `commit_scoped_mutation`, which is what
V01-009 applied to `create_project`. So the repair for site 1 and site 3 is not a design decision
— it is the pattern nine modules already use. Site 2 needs the same wiring, and the measurement
must come first, because its natural state guard means a repair could look like a no-op and the
regression test would then pass for the wrong reason.
