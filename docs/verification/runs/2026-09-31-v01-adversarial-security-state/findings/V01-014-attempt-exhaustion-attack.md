# V01-014 — the attack on V01-013: can an occurrence be *started* twice under a bound of one?

## Status

**attack written, not yet run.** The evidence and verdict sections are filled in by the run;
everything else is fixed in advance so the run cannot be reinterpreted afterwards.

## Severity if it reproduces

**high.** `max_start_attempts` is the bound on how many times one scheduled slot may start its
work. If an occurrence whose lease has expired can be claimed again while that bound is 1, then
one scheduled slot runs its work twice — an automation that is meant to fire once fires twice,
and whatever it spends, sends, or mutates is spent twice. That is the difference between a
bookkeeping defect and a spend-and-abuse one, and only this attack separates them.

## Why V01-013 could not be closed on its own

V01-013's evidence is one successful claim and a dead column. That is enough to show the counter
is never written, and **not** enough to show the bound is unenforced, because a bound of 1 that
is never reached still refuses nothing the first time.

A single claim cannot distinguish the two worlds. Every claim is attempt 1 whatever the bound is,
so one claim looks identical under `max_start_attempts: 1` and under `max_start_attempts: 3`. The
defect only becomes observable when an occurrence is **started a second time**, and a second
start requires the first lease to stop being active.

Per the worker's own comment, the two automation sweeps are the authoritative clock and expire
leases from D1 state, so the arc is available without any test-only affordance: claim, wait out
the TTL, let the sweep expire the lease, claim again.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-LEASE-002` (new) |
| **Setup** | a real `wasm32` Worker and fresh local D1. A real owner, organization, project, agent and **automation created with `max_start_attempts: 1`**, `lease_ttl_seconds: 30` and `heartbeat_interval_seconds: 10`. A real enrolled device with a real ed25519 device proof. A real `run_now` occurrence. |
| **Action** | 1. read the stored retry policy out of D1 and assert it is `1`; 2. claim the occurrence; 3. read the occurrence's own `attempt`; 4. claim again while the lease is live; 5. wait for the sweep to expire the lease, **proving the expiry happened**; 6. claim a third time. |
| **Expected** | the first claim advances the occurrence's `attempt` to 1; the second is refused and moves nothing; after the lease expires, the third is **refused as an exhausted attempt**, and the occurrence's `attempt` sits at 1. |
| **Actual** | pending the run |
| **Evidence** | pending the run (`evidence/v01-014-attempt-exhaustion.txt`) |
| **Verdict** | pending the run |
| **Regression gap** | pending the run |
| **Severity** | high if the third claim succeeds |

## The five choices that make this attack mean something

Each of these is a way the case could have passed for the wrong reason, and each is closed
deliberately.

1. **The bound is read from the database, not from the request body.** Everything else in this
   probe is graded on stored state, and the single value that decides whether the final claim
   *should* have been refused deserves the same treatment. If the stored policy is not `1`, the
   probe **exits 2** rather than reporting a conclusion about a different bound than it claims —
   a case answered about `max_start_attempts: 3` would be a different finding wearing this one's
   name.

2. **`max_start_attempts: 1` and `lease_ttl_seconds: 30` are the schema's own extremes.**
   The column is `CHECK (max_start_attempts BETWEEN 1 AND 3)`, so 1 is the tightest bound that
   can be stored, and `lease_ttl_seconds` is `CHECK (… BETWEEN 30 AND 3600)`, so 30 seconds is
   the shortest lease that can be made to expire. A second start has the fewest possible places
   to hide, and the wait is the shortest the product permits rather than a number the test chose.

3. **The lease expiry is proved, not assumed.** A third claim refused by a still-live lease looks
   *exactly* like a correct enforcement, and that is the single most likely way this case could
   have reported a false PASS. So the probe waits for a **positive transition** — the lease
   leaving `active` in D1 — with a deadline, driven by the sweep, and asserts it before making
   the third claim. If the lease never expires, the case says so and refuses to grade. The same
   rule that stopped `verify:adoption-privacy` reporting "0 hits" over a table full of payloads:
   never let a negative assertion pass on an absence.

4. **The attempt is read from the occurrence, not from the response.** The claim response carries
   its own `attempt`, computed from the broken column, so it reads `1` on every claim and would
   have reported success. The occurrence row is the only place the counter is supposed to be
   *recorded*. Both are printed together so a divergence between them is visible rather than
   inferred.

5. **A refused final claim must take no lease.** This checks that the attempt bound and lease
   exclusivity do not disagree: if a claim is refused for exhausted attempts but still writes a
   lease, the occurrence is wedged rather than merely mis-counted, which is a different defect
   with a different repair.

## Two ways this case would have reported a false result, and both were closed first

Both were found **by reading the probe against the harness it calls**, before it ran — the same
discipline that found the two harness defects, applied to the probe rather than to the harness.

### 1. A one-shot sweep against a 30-second clock

The obvious way to wait for the lease to expire is `probe.waitForD1`, and it is wrong here. It
fires the sweep **once**, about 1.5 seconds in, and then polls. `lease_ttl_seconds` is 30, so
that sweep runs long before the lease can be expired, the helper then polls against a clock
nobody is turning, and after two minutes it reports that the lease never expired. The case would
come back UNPROVEN for a reason that is entirely the harness's own.

That is the same failure shape as `verify:adoption-privacy` reporting **"0 hits" with a private
key in the table**, and the correction is the same: never let a negative assertion pass because
the thing it needed never got a chance to happen. The probe now drives the sweep **repeatedly**,
every three seconds, and ends on the positive transition — the lease leaving `active` in D1.

### 2. A refusal from the wrong cause

A refused third claim is only evidence about the **attempt bound** if the occurrence is still
claimable when the claim is made. If the sweep responds to an expiry by moving the occurrence to
a terminal state, the claim is refused for *that* reason, and a probe asserting "the third claim
must be refused" reports a confident PASS about a bound it never tested.

So the occurrence's state is asserted claimable — `pending` or `dispatching` — **before** the
final claim, and a terminal state is recorded as UNPROVEN rather than as a pass. This is the
same rule as the first one, applied one level up: a negative assertion must be attributed to the
cause it names, not merely to be true.

## What a PASS would require of the product

Not merely that the third claim is refused. All of:

- the occurrence's `attempt` advanced 0 → 1 on the first claim;
- a `LEASED` occurrence records a 24-character `started_at`;
- the second claim, refused, left `attempt` and the lease count untouched;
- the lease left `active`, and that is observable in D1;
- the third claim is refused, takes no lease, and the occurrence's `attempt` is 1 — the number
  the refused claim would have used;
- and across every occurrence the probe created, more than one distinct `attempt` value is
  recorded, because a single distinct value *is* the finding.

## What happens to V01-013 if this reproduces

The repair is then forced, and it is not a one-line change. `TRANSITION_OCCURRENCE_SQL` is
prepared by four routes — `claim_occurrence`, `renew_lease`, `settle_lease` and
`release_occurrence` — and the question is which of the four should *advance* the counter and
which must *assert* the existing value. Adding `attempt = ?14` to the SET list without answering
that would make renew and settle each advance the counter, and an occurrence would exhaust its
attempts without ever having been started twice.

So the repair has to distinguish *a start* from *a transition of a started occurrence*, and that
distinction belongs in the route, not in a shared statement's SET list. This attack is what
pins the required behaviour, and it should be re-run unchanged after the repair.
