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
| **Actual** | the arc ran to completion and every control held, but the final claim was refused for the **wrong reason and with the wrong shape**. The sweep expired the lease (`lse_…:expired`), the occurrence stayed `pending` and claimable, and the third claim answered **`503 {"code":"service_unavailable","message":"The automation control-plane store is unavailable.","details":{}}`** — not an exhausted-attempt refusal. |
| **Evidence** | `evidence/v01-014-attempt-exhaustion.txt` (27/31; the 4 FAILs are V01-013 and the wrong-shape refusal) |
| **Verdict** | **FAIL — product defect**, and the root cause is V01-013's with a second symptom |
| **Regression gap** | asserted in `verify:attempt-exhaustion` and failing on purpose: 4 named assertions |
| **Severity** | **high**, and higher than recorded before the run — see the causal chain below |

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

---

# The result: one root cause, two symptoms, and the wrong shape on top

`pnpm verify:attempt-exhaustion` reports **27/31**, and the four failures are the whole point.

## What held, and it is worth stating because each of these could have been the thing that broke

| step | result |
|---|---|
| the first claim succeeds and takes exactly one lease | `201`, one active lease |
| the occurrence's `attempt` advances | **0 → 0.** Fails. |
| a `leased` occurrence records `started_at` | **`null`.** Fails. |
| a second claim while the lease is live is refused | `409 automation_invalid_state`, still one active lease, `attempt` unmoved |
| the lease leaves `active` **by the sweep** | `lse_…:expired` — the positive transition, read from D1, not assumed |
| the occurrence is still claimable afterwards | `state=pending` — so the refusal below is not a terminal state |
| the third claim takes no lease | `active_leases=0` |

The two controls that keep this honest both did their job: the lease expiry was **proved** rather
than waited for, and the occurrence was confirmed still claimable before the final claim, so its
refusal is attributable and not a side effect of the sweep having ended it.

## The causal chain, established from the database rather than inferred

The third claim is refused. The question is *why*, and the answer is a chain that ties V01-013 to
a second, separate symptom:

1. `TRANSITION_OCCURRENCE_SQL` has no `attempt` in its SET list, so `automation_occurrences.attempt`
   stays **0** forever.
2. The re-claim therefore computes `let attempt = occurrence.attempt + 1` = **1** — the *same*
   attempt number the first claim used.
3. `ux_automation_occurrence_attempts` is `UNIQUE (occurrence_id, attempt, outcome)`. The first
   claim left `(occ, 1, 'claimed')`, so the re-claim's attempt row **collides with it**.
4. The collision aborts the whole batch, and `automations.rs`'s own
   `service_unavailable` helper — `"The automation control-plane store is unavailable."` with
   **`details: {}`** — is what the caller receives.

The database shows the collision is real, and shows the schema anticipating a *real* counter: it
holds **two** rows for one occurrence at `attempt = 1`, differing only in outcome —

```
att_3693d4f2…  occ_e5168f2a…  attempt=1  outcome=claimed
job_92e3799c…  occ_e5168f2a…  attempt=1  outcome=expired  reason=lease_expired_…
```

— which is only possible because the index includes `outcome`. The schema clearly means "one
attempt may have several outcomes", and it clearly means `attempt` to be a genuine counter. The
code does not make it one.

## Why this is worse than the bookkeeping defect V01-013 recorded

V01-013's evidence was a dead column, which reads as an accounting problem. The chain above shows
the same defect is also a **client-facing availability lie**:

> a device that lost its lease, waited out the TTL, and dutifully retried, is told **the entire
> control-plane store is unavailable** — with an empty `details`, so it cannot even tell that from
> any other outage. It will back off and retry against a fiction.

That is the V01-010 family exactly: a cause the server had and threw away, replaced with a
detail-less "unavailable". And it is the **same root cause**, so the fix for V01-013 — advancing
`attempt`, and stamping `started_at` — removes this symptom too. There is no second decision to
make and no new contract to negotiate.

## The probe bug this run found, which is the round's fourth

My first version of the final assertion asked only for `third.status >= 400`, and it **passed on
the 503**. That is the wrong-reason pass this campaign has now hit four times in three different
places: a probe that reports a PASS for a check that did not test what its name says.

It is fixed, and the fix is the general one: the assertion now requires a **4xx with a stable
reason and never a 5xx**, because "refused" and "refused *correctly*" are different claims and only
one of them is worth anything. The re-run reports 27/31 with this assertion failing, which is the
truthful number; the first run's 28/31 was a pass bought by a weak predicate.
