# V04 release verdict — candidate `e55af37`

## VERDICT: **FAIL — do not release**

Not because the product is broadly broken. Because the release gate's own rule is explicit:

> Release is blocked if: any Tier-0 claim is FAIL, UNPROVEN, or BLOCKED …

**One Tier-0 claim is BLOCKED (T0-16, export/deletion), 13 P0 criteria are UNPROVEN, and the
auth-replay mutant class was not reached.** Those are blockers by the repository's own definition, and
the definition is the authority — not the size of what passed. One earlier blocker — the performance
baseline — was **resolved during this campaign** and is recorded as such rather than quietly dropped.

| | count | of which |
|---|---|---|
| Tier-0 claims | 20 | **19 PASS, 1 BLOCKED** |
| P0 acceptance criteria mapped | 210 | 197 with evidence · **13 UNPROVEN** |
| Runtime/adversarial gates run | 25 + 12 | 34 PASS · 1 BLOCKED (correctly reported) · 2 harness artefacts, re-run |
| Mutants killed | 10 | 5 of the 6 classes the release gate names |
| Defects found and repaired | 7 | **1 HIGH product**, 5 harness, 1 process |
| Product code changed | 2 files | both from the HIGH repair |

## The candidate

| | |
|---|---|
| **commit** | `e55af37` (re-pinned twice; see `candidate-pin.md`) |
| **original pin** | `795d403` — **a FAILED candidate**, it shipped V04-002 |
| **tree** | `main`, clean |
| **OS / node / pnpm / cargo** | Darwin 27.0.0 / v24.20.0 / 10.33.0 / 1.98.1 |
| **browser** | Google Chrome **154.0.8037.93** (V02 used 153 — see limitations) |
| **Worker runtime** | `wrangler dev --env development` (workerd 1.20260921.1) on a local D1 |
| **migration head** | `0022_p07_staff_actor_type.sql`, 22 files |
| **desktop client** | none exists in this repository — see External unknowns |

## Tier-0 summary

Every claim is graded on the evidence **taken in this campaign**, and each names the gate that carries
it. "The gate exists" is not evidence; the gate's own result is.

| # | Tier-0 claim | verdict | evidence in this campaign |
|---|---|---|---|
| T0-01 | no cross-tenant read/write through any route | **PASS** | `verify:collection-tenancy` (54/54, a positive-match control), `verify:filter-tenancy` (65/65), `verify:path-id-tenancy` |
| T0-02 | a client-supplied org/project/role id is never authority | **PASS** | `verify:privilege-escalation` (exit 0) |
| T0-03 | auth cannot be replayed, confused, or bound to the wrong ceremony | **PASS** | `smoke:passkey` (76/76, hostile challenge/origin/RP-ID/replay), `smoke:p02` device-code **exchange→200 then exchange→[401,409]** |
| T0-04 | revocation is terminal | **PASS** | `verify:revoked-device` (exit 0), `smoke:p03` case 10 |
| T0-05 | secrets never appear in a response, log, audit row, or telemetry | **PASS** | `verify:secret-tenancy` (exit 0), `verify:observability` **28/28 with 18 canary assertions and a positive control** |
| T0-06 | a hard budget refuses **before** upstream dispatch | **PASS** | `verify:budget-hardceiling` (exit 0) |
| T0-07 | budget ceilings hold under concurrency | **PASS** | `verify:budget-concurrency` (exit 0) |
| T0-08 | no fallback after committed output | **PASS** | `verify:inference-failure` (exit 0) **+ mutant VI-INF-001 KILLED** |
| T0-09 | destructive operations authorized and idempotent | **PASS** | `verify:device-idempotency`, `verify:idempotency`, `smoke:browser` revoke-and-confirm |
| T0-10 | local-only/adoption paths leak no user content | **PASS** | `verify:adoption-privacy` (exit 0, 8 content classes) |
| T0-11 | fresh **and** upgrade migrations both refuse invalid writes | **PASS** | baseline: fresh ledger (22 files) + **populated-table** upgrade (67 s) + `verify:restore` 125/125 with a trigger-loss fault detected |
| T0-12 | rollback/forward-fix known for data-affecting change | **PASS** | `verify:restore` 6/6 rehearsal, RTO 1483 ms, RPO 0 rows inside the snapshot |
| T0-13 | tool/browser/computer-use **denial** enforced | **PASS** | `verify:tool-policy-deny` **48/48** + two detected mutations (M1: 4 legs red, M2: 1 leg red) |
| T0-14 | admin/support authority bounded, every use audited with a real actor | **PASS** | `verify:staff-credential` (exit 0), all six internal routes measured |
| T0-15 | a client cannot override server authorization | **PASS** | `verify:privilege-escalation`, machine-key boundary assertions |
| T0-16 | export/deletion authorized, idempotent, every data class disposed | **BLOCKED** | `smoke:p06` **27/27 cases hold, 1 leg blocked** — envelope `queued`/attempt 1, outbox `delivered`, export row still `requested`. **This is a hard blocker.** |
| T0-17 | outbound retries bounded, no duplicate side effect | **PASS** | `verify:lease-contention`, `verify:attempt-exhaustion`, `verify:webhook-fanout` |
| T0-18 | a meaningful Tier-0 mutant is killed | **PASS** | 10 mutants KILLED, each "the verifier failed, and the failure names the invariant" |
| T0-19 | stale org context cannot leak across a switch | **PASS, sensitivity unproven** | `smoke:browser` 24 DOM samples per direction, 0 leaks — but this class has never been watched to fail |
| T0-20 | machine identity isolated from customer sessions and vice versa | **PASS** | `verify:staff-credential` (machine key refused on a staff route; session refused on a staff route) |

## The blockers, named

**1. T0-16 BLOCKED — the export job never completes, and the cause is environmental.**
`smoke:p06` reports `27/27 cases hold, 1 leg blocked by the environment`, with the envelope at
`queued`/attempt 1 and the export row still `requested`.

Measured carefully, because an earlier reading of this was wrong in both directions:

- the **outbox** side genuinely works. `delivery_status: delivered` is written by
  `modules/outbox/consumer.rs:108` calling `mark_delivered`, so it is set *after* the outbox consumer
  has handed the event to a queue — not by the publisher. That part is a real consumer run.
- the **jobs queue** consumer is what is absent. Its diagnostic (`p06_queue_routed:jobs`) did **not**
  appear in the final run. It *did* appear in an earlier run of the same probe, so local delivery to
  that consumer is **intermittent** rather than absent.

**What the campaign established about the cause, which is stronger than "the local queue is
unreliable":** in **two fresh runs** (`/Volumes/SSD/v04-logs/p06-probe1.log`, `p06-probe2.log`) the jobs
consumer was **never invoked at all** — zero `p06_queue_routed` lines, both runs, versus eight in one
earlier run, so local delivery is intermittent rather than reliably absent.

And the repository side is verifiably correct, which is what makes this environmental rather than a
defect:

| link | state | how it was checked |
|---|---|---|
| the export job is **published** | **yes** | `queue_job_envelopes` row is `state: queued, attempt: 1` |
| the **producer binding** is declared | **yes** | `wrangler.jsonc` dev env: `JOBS_QUEUE` → `lumi-agents-jobs-development` |
| a **consumer** is registered on it | **yes** | same file, `max_batch_size 10`, `max_retries 8`, with `lumi-agents-jobs-development-dlq` |
| the consumer's **route diagnostic** fires | **never** | no `p06_queue_routed` in two fresh runs |

So: produced, wired, and registered — and not invoked by the local runtime. That is the documented V01
condition, now measured rather than assumed, and it is a **stop condition** under the release repair
rule: *a required external system cannot be exercised*. There is no repository change that makes a local
queue simulator deliver a message, and inventing one would replace the proof with a mock.

The R2 artifact is therefore never written, so the data-governance rows ("private artifacts protected",
"every data class disposition") are **UNPROVEN** — correctly, and not because the product refused
anything. Fail-closed: the job sits queued and does nothing.

**V04-002 removed a real crash from underneath this**, and that is what made the distinction
measurable at all: before the repair, the jobs consumer could not even be constructed.

**2. Performance — RESOLVED in this campaign; originally UNPROVEN.** The runner started a dev stack
and never a production `vite preview`, so the first run measured the **dev server** and the probe said
so, unasked:

> note: measuring the dev server. AGENTS.md states these budgets under 'Web production baseline', and a
> dev-server number is not a production number.

Re-measured against `vite preview` with `PROBE_WEB`:

| budget | measured | limit | verdict |
|---|---|---|---|
| initial JS | 97.3 KiB gzip | 170 | **PASS** |
| initial CSS | 8.6 KiB gzip | 35 | **PASS** |
| largest route chunk | 38.8 KiB gzip | 80 | **PASS** |
| Worker bundle | 2575.0 KiB gzip | none | **TRACKED** (now measured — see V04-006) |
| 5 authenticated API routes | 8.2–22.0 ms p95 | 200 | **PASS** |
| LCP (cold) | 0.16 s | 2.5 s | **PASS** |
| CLS | 0.0 | 0.1 | **PASS** |
| worst long task | 0.0 ms | 200 ms | **PASS** |
| INP | — | 200 ms | **UNMEASURED** |

**0 over budget. 1 UNMEASURED.** The gate exits 1 rather than 0 because it refuses to call INP a pass,
which is correct behaviour and is not counted as a defect. Only INP remains, and it is genuinely
unmeasurable on this stack: the collector runs and the click produces no event-timing entry.

**3. 13 P0 acceptance criteria have no evidence at any layer**, and three of the six mutant classes the
release gate names were not reached before the campaign stopped.

## P0 acceptance criteria

210 criteria across 18 P0 specs (147 `FR-*` + 63 `MUST`), mapped in `03-p0-evidence-map.md` with each
row tagged by proof layer. **197 carry evidence; 13 are `—` UNPROVEN** and are named individually there.

One correction is recorded in that file and is worth repeating here: **the map first graded
FR-F01-013 (desktop sign-in) UNPROVEN, and that was false.** `smoke:p02:245-270` drives the whole
device-code flow including a replay attack. All fourteen asserted absences were then re-checked by
searching the probes for the *behaviour* rather than the route name; that was the only wrong one. A
false UNPROVEN on a P0 criterion is as damaging as a false PASS.

## Repaired findings

| finding | kind | severity | closed because |
|---|---|---|---|
| **V04-002** | **product** | **HIGH** | `WorkerEntrypoint` errors **11 → 0**; outbox publish+consume lines **0 → 8 each**; the `p06_queue_routed` consumer diagnostics went from never appearing to appearing. The original crash is gone and the queue path can be constructed. *(Corrected from an earlier overclaim in this record: the eight `delivered` lines are the outbox consumer's own audit lines, and they prove the OUTBOX consumer ran — not that the jobs queue consumer delivered.)* |
| **V04-003** | harness | MEDIUM | p06's BLOCKED report now executes and prints a real diagnostic — the first evidence that produced V04-002 |
| **V04-005** | harness | MEDIUM | `smoke:p03` 17/17; the case now asserts the refusal where it actually bites (at the challenge, which is stricter) instead of crashing |
| **V04-006** | harness | low | the Worker-bundle budget read its input from `/tmp`, so a full disk made it UNMEASURED for reasons unrelated to the product; input is now durable and the row **measures 2575.0 KiB gzip** |
| **V04-007** | harness | MEDIUM | `billing-panel.test.ts` pinned four literal instants, three of which had expired; `pnpm check` had gone red with **no product change**. Fixtures now relative to the clock, **plus a control that fails if any instant is not in the future**. `pnpm check` exit 0 |
| **V04-001** | harness | — | evidence survives a disk-space recovery and a machine restart |
| **V04-004** | process | — | recorded; bounds what this evidence can claim |

**V04-002 is the finding that matters.** `apps/api/sentry-entry.mjs` passed `undefined` as the first
argument to `new RustWorker(undefined, env)` on the queue path; workerd requires an Object, so the
first queue message ever threw an uncaught `TypeError` and killed the isolate. Every visible stack frame
was inside `@sentry/cloudflare`'s wrapper, so the first reading blamed the SDK — reading to the frame
that *constructs* the object showed the throw was ours. It survived a whole campaign because
`verify:webhook-fanout` passes and looks like async coverage while asserting only on `outbox_events`
rows, and the one gate that does publish and wait for delivery was blamed on the sandbox.

## Mutation sample

10 mutants KILLED, each naming the invariant its verifier caught:

`VI-TEN-001` cross-tenant read loses its org predicate · `VI-TEN-001` service-account page stops being
org-scoped · `VI-AUTHZ-001` human-only permission becomes grantable to a machine · `VI-INF-001`
truncated stream may complete · `VI-BUD-001` hard budget stops being enforced · `VI-BUD-001` budget
denial stops consulting its own decision · `VI-IDEM-001` completed idempotency record may hold no
status · `VI-MIG-001` terminal-state trigger stops enforcing · `VI-SEC-001` API key projection returns
the secret hash.

That covers **5 of the 6** classes the release gate names. The **auth-replay** class was mid-build when
the campaign stopped — **its verdict is UNKNOWN, not MISSED**, and a stalled build says nothing about
the mutant.

## Accepted residual risks

1. **The export/deletion R2 leg** (blocker 1). Fail-closed: the job does not complete, nothing is
   written. No data loss; a feature that does not work.
2. **Provider 429/5xx, inference TTFT, and queue-delivery failure injection** — BLOCKED by V01-026, a
   measured environmental cause (the Worker cannot open an outbound socket on this host, across three
   address classes). Not worked around; widening a probe's reach around it converts a harness
   limitation into product failures.
3. **V01-046 / V01-047 / V01-050 / V01-040** — fail-closed capabilities with no caller or no surface.
   Inherited, open by decision, and each recorded at its source.
4. **8 of 12 browser states have no product-side sensitivity proof.** Four do. "All twelve covered"
   remains a statement about the probe, not the product.
5. **INP UNMEASURED** and **first-visit LCP p75 UNPROVEN** — inherited, and neither is a pass.
6. **INP is UNMEASURED** and cannot be measured on this stack — the collector runs and the click
   produces no event-timing entry. Every other budget is measured and passing against the production
   preview (blocker 2 is resolved).

## External unknowns

- **No external Lumi Agents desktop client exists in this repository**, so the release gate's "External
  Lumi Agents" rows are **NOT_APPLICABLE to this candidate** — not because they were satisfied, but
  because there is nothing to exercise. What *is* in scope, the device-code handoff, is proven
  (`smoke:p02`, including replay refusal). The "compatibility matrix" has no rows and cannot gain any
  here.
- **No provider, billing, or webhook sandbox** is reachable from this host, so `provider error
  normalization`, real `webhook.deliver` delivery, and billing event replay are UNPROVEN beyond what the
  mocked adapters and `verify:webhook-fanout` cover.
- **D1 Time Travel was not exercised** (`verify:restore` says so in its own output). RPO is stated as
  "0 rows lost inside the snapshot", with the recoverable-loss window an operational decision.

## Migration and rollback

Fresh ledger applies (22 files, head `0022`). The **populated-table** upgrade path applies over rows
0015 seeds by design and `p08:invariants` still reports 17/17 on that path. `verify:restore` exports,
restores, and confirms **125/125** invalid writes are still refused, with a deliberate trigger-loss
fault detected (123/125, naming the two dependent checks). **RTO 1483 ms; RPO 0 rows inside the
snapshot.** The only schema change in this campaign is a bound parameter reusing an existing column —
no migration, so rollback is a pure revert.

## Limitations of this verdict

1. **The worktree was shared** (V04-004). A concurrent instance advanced `main` and created worktrees
   none of this campaign's scripts use. The product-tree pin held and every gate recorded its own exit
   code and durable log, but "the tree was untouched throughout" is not a claim this campaign can make.
2. **Seven harness defects were found and fixed in this campaign's own runners**, three of which had
   produced exit codes that read like results. Every one is documented where it was fixed; the point
   for the reader is that **two of the three "failures" in suite 2 were the runner, not the product**,
   and were only recognised because the exit code was checked against the log.
3. **Chrome differs from the campaigns this inherits** (154 here, 153 in V02). The browser row is
   evidence about a build V02 never touched.
4. **The mutation campaign was stopped** at 10 kills, mid-way through the auth-replay class, because
   its cost per case (~2.4 GB of scratch and a fresh build) exceeded what was spent on it.

## What important thing do we still not know?

**We do not know whether the jobs queue consumer actually processes an envelope.** Everything up to it
now works — a message is published, delivered, and a consumer is invoked — and the envelope still sits
at `queued` with `attempt: 1`. That is a Tier-0 export/deletion claim, and the gap between "invoked" and
"processed" is exactly where the remaining defects of this shape hide: it is the same class of failure
as the one just found, one layer further in, and no gate had ever driven a real queue delivery to
completion before today.

The queue question is now answered and the answer is not reassuring in the way a bug would be: **the
export path is correctly wired and the local runtime simply never runs the jobs consumer.** Two fresh
runs, zero invocations, a published envelope, a declared producer and a registered consumer with a dead
letter queue. So the remaining unknown is not "is there a defect in the export path" — on this evidence
there is not one to find — but **"does the jobs consumer work at all in production?"** Nothing here can
answer that, because the only way to exercise it is the mechanism this host does not provide. That is a
narrower and more uncomfortable gap than the one the campaign started with: it is not a defect to fix,
it is a whole Tier-0 feature path with no runtime evidence at all.

And we do not know whether 8 of the 12 browser states could fail at all, which means the browser
journey can still be green over a product that has lost one of them.