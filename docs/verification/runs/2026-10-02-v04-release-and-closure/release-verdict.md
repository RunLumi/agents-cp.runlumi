# V04 release verdict — candidate `1d3ec1e`

## VERDICT: **FAIL — do not release**

Not because the product is broadly broken. Because the release gate's own rule is explicit:

> Release is blocked if: any Tier-0 claim is FAIL, UNPROVEN, or BLOCKED …

**One Tier-0 claim is BLOCKED (T0-16, export/deletion), 15 P0 criteria are unproven at the runtime
layer, and five of those 15 are missing *features* rather than missing proofs.** Those are blockers by
the repository's own definition, and
the definition is the authority — not the size of what passed. One earlier blocker — the performance
baseline — was **resolved during this campaign** and is recorded as such rather than quietly dropped.

| | count | of which |
|---|---|---|
| Tier-0 claims | 20 | **19 PASS, 1 BLOCKED** |
| P0 acceptance criteria mapped | 210 | **200** with evidence · **10 unproven at the runtime layer** |
| Runtime/adversarial gates run | 25 + 12 | 34 PASS · 1 BLOCKED (correctly reported) · 2 harness artefacts, re-run |
| Mutants killed | **11** | **all 6** classes the release gate names |
| Defects found | **10** | **3 HIGH product** (1 repaired — `V04-002`; 2 recorded — `V04-008`, `V04-010`), 1 product closed (`V04-009`), 5 harness, 1 process |
| Code changed | 9 files | 1 from the HIGH repair, 2 new check/probe modules, 6 harness repairs |
| `pnpm check` | exit **0** | re-run after the last repair; 463 binds, clippy clean, WASM target builds |

## The candidate

| | |
|---|---|
| **commit** | `1d3ec1e` (re-pinned **four** times; see `candidate-pin.md`). Every re-pin was forced by a repair landing after a judgement was made, which is the pin working as intended |
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
| T0-18 | a meaningful Tier-0 mutant is killed | **PASS** | **11 mutants KILLED across all 6 named classes**, each "the verifier failed, and the failure names the invariant". The auth-replay class (`VI-AUTH-001`) closed this turn: control 76/76, fault verbatim from the campaign, DETECTED, exit 0 |
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

### A harness bug this campaign already documented, walked into again in a new script

`v04-008-sensitivity.sh` reported both of its first cases `INVALID` because its compile-error
discriminator was `grep -qE "^error(\[|:)"` — which matches cargo's own summary line
`error: test failed, to rerun pass '--lib'`. That is the exact trap recorded against the V01-035
harness: `cargo test` exits 101 for a failing assertion *and* for a compile error, and `^error:` cannot
tell them apart.

Two things are worth separating. The **discrimination worked** — the script refused to report a
detection it had not measured, which is the behaviour that matters, and it exited 1 rather than 0. And
the recurrence is the actual finding: a lesson written into `AGENTS.md` did not transfer to a script
written in the same campaign, ninety minutes later, by the same author. **A recorded lesson reaches
only the code that already reads it.** The fix is now in the script, matching only rustc's coded
diagnostics (`error[E####]`, `could not compile`, `aborting`).

The same script's first run also produced a **false** `POST-RESTORE MISMATCH`, because its restore
function covered two of the three files it mutated. A false alarm in a harness reads exactly like a
real one, and it is the same shape as the `exit 2, no sheet` flakes `AGENTS.md` records: widening or
carelessly scoping a harness's own bookkeeping deletes the signal that separates "the product failed"
from "the harness is wrong about itself".

**3b. Five P0 criteria are missing *features*, not missing proofs** — and a sixth surface, browser and
computer-use policy, is missing its *catalogue* (**V04-010**, HIGH product, below). Every unproven row was classified
by asking one question — *does a route exist that makes this reachable?* — because `FR-F19-008` had been
annotated as a probe gap when it was a capability gap, and the two demand different work:

| | rows |
|---|---|
| **capability absent** | `FR-F03-008` bulk operations · `FR-F05-006` security notifications · `FR-F19-008` min client version · `FR-F23-008` OpenAPI · `FR-F23-010` rate-limit headers |
| blocked by V01-026 | `FR-F09-007` · `FR-F13-009` · `FR-F21-008` |
| conflict in the frozen contracts | `FR-F12-008` |
| **missing probes only** | **one remains**: `FR-F22-010` (design system — needs a rendered comparison against `DESIGN.md`, and this candidate changed no UI). Five more were on this list and are now **closed**: `FR-F04-007` (**1/1 detected** against a constant reason), `FR-F13-005`/`FR-F13-006` (**2/2 detected**, and doing it found V04-010), and `FR-F23-007`/`FR-F21-006` — closed by **locating** their enforcement, not by probing it |

So **5 of 15 are unimplemented capabilities** and only **3 are missing probes** — `FR-F04-007` and both
`FR-F13-005`/`FR-F13-006` were closed while this verdict was being written. `FR-F05-006` is a
second instance of the V04-008 shape found by the same question: the `notifications` table exists and
`notification_preferences` *is* written, but nothing ever inserts a notification. `FR-F23-010` is the
other: no response emits a rate-limit header at all — the only `Retry-After` in the tree belongs to an
**inbound** webhook consumer, which is a different requirement entirely.

None of the five is a small addition, and `FR-F19-008` fails open.

**3c. A `P0` spec containing a requirement whose own text says `P1`.** `docs/specs/README.md` marks F12
as P0; `FR-F12-008`'s text opens *"P1 compare internal usage/cost with provider invoice/export **where
API exists**"*. That is unreviewed drift in the frozen contracts, which the release gate lists as a hard
blocker. This campaign **cannot** resolve it — settling it means editing a frozen contract, the one move
delegated authority explicitly excludes. It is recorded so a human decides it deliberately rather than
discovering it when a gate fails.

**3a. A security control the platform cannot operate (V04-008, HIGH, product) — and this one is not
a coverage gap.** `FR-F19-008` says an organization or the platform can require a minimum client
version when a security fix demands it, with staged rollout and grace messaging. The device path
implements the control almost completely: the comparator (`modules/devices.rs:203`), the policy read
(`routes/devices.rs:386`), and the refusal (`routes/devices.rs:822` → `client_version_too_old`). What
does not exist is **the lever**. `org_device_policy_settings.min_client_version` is read and enforced
and **never written** — the table has exactly two mentions in the whole repository, the `CREATE TABLE`
in migration 0007 and that `SELECT`. So `if let Some(minimum)` is never taken and `version_at_least` at
`devices.rs:823` is a call that can never execute, which is the `is_run_source` shape from V01-047 and
invisible to any caller-counting check.

The consequence, measured rather than inferred: the one reachable floor,
`MIN_CLIENT_APP_VERSION = "0.4.0"`, only produces a `Remediation` via `derive_remediations` — it never
refuses — and `validate_app_version` checks syntax alone. **A device may present any syntactically
valid `app_version` and reach cloud-managed operations.**

This is the dangerous variant of a class the campaign has now seen seven times. V01-046 and V01-050
fail *closed* and are merely absent. This fails **open**, and it is the lever for responding to a
client-side security fix: every credential-handling bug in a desktop client is a candidate for a
forced minimum version, and there is nothing to set.

Recorded and deliberately **not implemented**: adding a routed write surface to a device-authorization
boundary, against a spec sentence that names no route, status or acceptance criteria, would broaden
the problem rather than solve it — a new write surface would arrive with nothing to check it against.
`security::guarded_column_writers` now enforces the class, and
`evidence/v04-008-sensitivity.sh` proves it (**2/2 detected, exit 0**) by making the lever appear and
by renaming the guard in the product.

**3e. Browser and computer-use policy cannot be reached at all (V04-010, HIGH, product).** Found by
writing the probe `FR-F13-005`/`FR-F13-006` were asking for, rather than recording them as unproven.

The eleven sub-controls the specs name **are implemented and correct** — `evaluate_browser_rules` and
`evaluate_computer_rules` consult every one, and the probe drives them over real HTTP to `71/71` with
the correct distinct reasons (`browser_action_denied`, `computer_action_denied`), proven by
`evidence/v04-f13-sensitivity.sh` (**2/2 detected**: making `allow_download` permissive reds exactly one
assertion and leaves the computer family green).

**None of that code is reachable.** A browser or computer call requires the `browser`/`computer`
capability to be present in `capability_definitions`, and that table has **no writer anywhere** — no
`INSERT`/`UPDATE` in `apps/api/src`, no seed in any migration, no route — so every such call in
managed-organization mode is refused `capability_not_defined` before any toggle is read. Compounding it,
a tool can never be *marked* browser-capable either: `has_browser_capability` matches the bare key or
`cap_`-stripped, while a catalog `CapabilityId` must be `cap_` + 32 lowercase hex, so that branch is
structurally incapable of being true — the `is_run_source` shape from V01-047.

**Measured, not inferred:** the first full run scored 51/68 with thirteen "denials" passing and *every
one* refused with the identical reason. The positive control refused the sheet on four successive runs,
each time correctly — `agent_tool_not_allowed`, `tool_risk_class_mismatch`, then the identical-reason
tell, then `runtime_capability_unavailable` — and every fix went into the **fixture**, never into an
assertion.

It **fails closed**: nothing browser-shaped is ever permitted, so no policy is bypassed. It is a
capability absence, and it is the third instance this campaign of a P0 row annotated "no probe" turning
out to be a missing capability rather than a missing test. Recorded, not implemented: the smaller fix is
named in the finding — `routes/tools.rs:2247` already projects the `capability_key` spelling, so relaxing
`has_browser_capability` / `has_computer_capability` to match it would let an org-scoped row reach the
evaluator with no new route.

**3d. The recovery ceremony had no replay test — CLOSED this turn, and the finding's first draft was
wrong (V04-009, LOW).** `smoke:passkey` drove replay for registration and for login; **recovery had no
such case**, and recovery is the ceremony that changes an account password. That gap is now closed: four
assertions added, baseline **76/76 → 80/80**, and `evidence/v04-009-sensitivity.sh` proves the new case
fails (**DETECTED**, exit 0).

The case is graded on **stored effect**, not status. `consume_recovery` returning `false` yields
`generic_recovery_failure` → the deliberately undifferentiated reason `recovery_invalid`, which is
correct (distinguishing "already consumed" from "never existed" would be an oracle) but means a green
status proves nothing on its own. So the replay carries a **different** new password and the case
asserts the original recovered password still authenticates and the replayed one does not. A refusal
asserted only by status would pass on a product that accepted the replay and then failed for an
unrelated reason.

**The first draft of this finding asserted a table showing recovery defended by ONE layer, and it was
false.** The table was built by searching for calls to `ensure_pending`, which is a search for one
*implementation* of the guard rather than for the guard. The mutation falsified it in one run: with
`consume_recovery`'s compare-and-set replaced by an unconditional `Ok(true)`, the replay was **still
refused** and the probe stayed green. The second defence is at `routes/authenticators.rs:971` — the same
status-and-expiry check `ensure_pending` performs, **inlined in the handler**. Recovery has the same
two-layer structure as its four siblings; with both sites removed the replay is accepted and the new
case goes red.

**Absence of a call to a named helper is not absence of the guard.** That is the fourth
inference-from-one-instance error this campaign has produced, and the others are recorded beside it:
`FR-F13-005/006` read as coarse from an enum when a dedicated policy struct carries a field per
sub-control; `FR-F23-007` read as an inert label when it is enforced at `routes/tools.rs:135`; a
site-2 mutation anchor read as unique when it occurs three times, which produced **a Tier-0 mutant
survivor that did not exist**; and this. Four for four. A pattern inferred from one instance is a
hypothesis, and the cheapest thing to do with a hypothesis is run the mutation.

Residual, recorded not fixed: recovery's route-level guard is **inlined**, so nothing enforces that
every ceremony path has one — `ensure_pending` covers four kinds by construction, recovery by a
hand-written check. A future path can lose it with `pnpm check` green. Folding it into `ensure_pending`,
or adding the recovery-replay case to VI-AUTH-001 so the class covers all five ceremony kinds, is a
refactor of an authentication path and outside this campaign's authority.

**3. 10 P0 acceptance criteria are unproven at the runtime layer** — down from 15. Five rows were closed
while this verdict was written, and the tally has a second lesson: **two of the five needed no probe at
all**, only a location. `FR-F23-007` and `FR-F21-006` were carried as "no probe exists", which is a
statement about a probe and said nothing whatever about the code — the deprecation gate is at
`routing.rs:180-181` and every outbound timeout is built and applied. **"Unproven" was partly a claim
that the verifier had not looked.** All six mutant classes the release gate names are killed —
see the mutation sample.

## P0 acceptance criteria

210 criteria across 18 P0 specs (147 `FR-*` + 63 `MUST`), mapped in `03-p0-evidence-map.md` with each
row tagged by proof layer. **195 carry runtime evidence; 15 are unproven** — 13 tagged `—` plus 2
tagged `S`, because this campaign's own legend says an `S` mapping "does not thereby satisfy" a
criterion, so the earlier 13 undercounted the decision by two. Both `S` rows are named individually there.

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
| **V04-008** | **product** | **HIGH** | recorded, not implemented — the minimum client version control has **no lever**, so `client_version_too_old` is unreachable and a device may present any syntactically valid `app_version`. Fails **open**. `security::guarded_column_writers` enforces the class (**2/2 detected, exit 0**) |
| **V04-010** | **product** | **HIGH** | recorded, not implemented — browser and computer-use policy is implemented, correct and **unreachable**: `capability_definitions` has no writer, so every such call is refused `capability_not_defined`. Fails **closed**. The eleven controls are now proven anyway (`71/71`, sensitivity **2/2 detected**), which is what established the unreachability |
| **V04-009** | product | LOW | **closed** — recovery ceremony replay is now driven over HTTP by four stored-effect assertions; baseline **76/76 → 80/80**, and `evidence/v04-009-sensitivity.sh` proves the new case **DETECTED** with both defences removed. The finding's first draft claimed recovery was defended by one layer; the mutation falsified that in one run and the claim is retracted above |
| **V04-001** | harness | — | evidence survives a disk-space recovery and a machine restart |
| **V04-004** | process | — | recorded; bounds what this evidence can claim |

**Three HIGH product findings. V04-002 is the one that changed behaviour; V04-008 and V04-010 are
recorded rather than implemented, and both fail in the safe direction only by accident of design.** `apps/api/sentry-entry.mjs` passed `undefined` as the first
argument to `new RustWorker(undefined, env)` on the queue path; workerd requires an Object, so the
first queue message ever threw an uncaught `TypeError` and killed the isolate. Every visible stack frame
was inside `@sentry/cloudflare`'s wrapper, so the first reading blamed the SDK — reading to the frame
that *constructs* the object showed the throw was ours. It survived a whole campaign because
`verify:webhook-fanout` passes and looks like async coverage while asserting only on `outbox_events`
rows, and the one gate that does publish and wait for delivery was blamed on the sandbox.

## Mutation sample

**11 mutants KILLED, covering all 6 classes the release gate names**, each naming the invariant its
verifier caught:

`VI-TEN-001` cross-tenant read loses its org predicate · `VI-TEN-001` service-account page stops being
org-scoped · `VI-AUTHZ-001` human-only permission becomes grantable to a machine · `VI-INF-001`
truncated stream may complete · `VI-BUD-001` hard budget stops being enforced · `VI-BUD-001` budget
denial stops consulting its own decision · `VI-IDEM-001` completed idempotency record may hold no
status · `VI-MIG-001` terminal-state trigger stops enforcing · `VI-SEC-001` API key projection returns
the secret hash · **`VI-AUTH-001` a consumed WebAuthn ceremony is accepted a second time**.

`VI-AUTH-001` was UNKNOWN until this turn, and closing it cost three harness defects that are each
worth more than the verdict. Its evidence is `evidence/v04-auth-001-sensitivity.sh`: control first
(`smoke:passkey` 76/76 on the unmutated tree), then the fault taken **verbatim** from the campaign's
own case definition, then **DETECTED**, restore verified against git, HEAD unmoved, exit 0.

**What that sequence actually found, in order:**

1. **The campaign wedged, and the cause was mine.** A stray `workerd` left on port 8787 by an earlier
   probe of this campaign made `wrangler dev` unable to bind, and `p02-passkey-smoke.mjs` sat for
   **1h35m having consumed 1.17s of CPU** with no worker child and the port free. It could not
   complete, so its verdict was UNMEASURED. The script now *checks port 8787 before starting* and
   refuses — a held port here produces a silent hang, not an error, which is worse than a false exit 2
   because nothing downstream is ever reached.
2. **A fresh worktree has no `node_modules`**, so `wrangler` cannot bundle `sentry-entry.mjs`, the
   Worker never becomes healthy, and the probe reports that — which a campaign grades as a kill for the
   wrong reason. The campaign symlinks them; this script now does too. **The control run is what caught
   it**, which is the whole argument for running the control first.
3. **A substring is not a verdict.** The classifier looked for `consumed login ceremony cannot be
   replayed` anywhere in the output — and the probe *prints that text when the check passes*, as the
   name of the check. An unmutated, fully green 76/76 tree was classified DETECTED.
4. **My restore was a silent no-op.** It wrote to `$REPO/$WT/...` with `$WT` absolute, so both `cp`s
   failed into `/dev/null`. The `git diff --quiet` check after every restore is what caught it — the
   same lesson as the V01 harness whose restores did nothing "while the script printed RESTORE FAILED
   and the grades carried on".
5. **I nearly recorded a Tier-0 mutant survivor that did not exist.** My site-2 assert required the
   anchor to be *unique*; it is not — `Ok(D1Adapter::changes(&result)? == 1)` occurs three times, in
   `consume_ceremony`, `revoke_passkey` and `consume_recovery`. The assert refused the mutation,
   silently degrading a **two-site fault to one**, and the resulting 76/76 is the *expected*
   single-site result. Only the diffstat saying `1 file changed` after a two-site mutation gave it away.

That fifth one is a real defect in the campaign's own case, not only in my harness: the campaign applies
faults with JavaScript `String.replace` on a **string** pattern, which replaces the **first** occurrence
only, so `VI-AUTH-001` is aimed correctly **only because `consume_ceremony` is defined first**. That is
targeting by source order, unstated and unchecked. Reorder those functions and the case silently
disables `revoke_passkey` or `consume_recovery` and reports a kill for a fault nobody intended — and it
would do so while the auth-replay class still reads KILLED. Written up in `V04-009`; the case should
anchor on the `UPDATE webauthn_ceremonies` statement or the function header.

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

## A production deployment exists, and this verdict was issued against a different commit than it

Found while auditing the pin at the very end of this campaign, and it belongs in the record rather than
in a message, because it changes what a reader has to do next.

`main` has **diverged from `origin/main`**: two commits landed from another instance
(`b2f3e94` production operations + deployment runbook, `a0ea9b6` deploy to `agents-cp.runlumi.app`) while
this verdict was being written. Neither is in the tree these measurements were taken on. What they change:

| surface | changed? | consequence for this verdict |
|---|---|---|
| `apps/api/src/**`, migrations | **no** | every handler, repository, SQL statement and migration measured here is the measured code |
| `wrangler.jsonc` — queue wiring | **no** | `JOBS_QUEUE` → `lumi-agents-jobs-development`, its consumer, and its dead-letter queue are unchanged, so **T0-16's evidence stands** |
| `wrangler.jsonc` — production | **yes** | a production env is declared: `workers_dev: false`, `preview_urls: false`, a custom domain `agents-cp.runlumi.app`, and production-only vars including `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` = `https://agents-cp.runlumi.app` |
| `apps/web/scripts/browser-probe.mjs` | **yes** | the org-switch staleness loop changed from a fixed 24 samples to a time-bounded loop (20 s) that breaks once ≥24 samples show the new org. It is *more* patient, not less — but **T0-19's cited "24 DOM samples per direction, 0 leaks" was measured against the superseded probe** and is carried forward, not re-measured |
| `package.json` build order | **yes** | web is now built before the API. `pnpm check` exit 0 here ran the previous order |

**Three consequences, stated plainly.**

1. **This verdict is FAIL, and a production deployment target exists.** Whether shipping it is right is a
   decision this campaign has no standing to make — but a reader holding this document needs to know
   both facts at once, not discover the second by reading `wrangler.jsonc`.
2. **Every WebAuthn ceremony verified here ran against a localhost origin.** Production's
   `WEBAUTHN_ORP_ID` and `WEBAUTHN_ORIGINS` are the custom domain, and that pairing has **never** been
   exercised by any gate in this repository — `smoke:passkey` drives ceremonies over loopback. Origin
   and RP-ID are exactly where WebAuthn ceremonies fail in production and pass locally, and the specs
   name both. This is an **UNPROVEN** Tier-0 authentication surface, and it is unproven for a reason no
   amount of local work fixes.
3. **Two Tier-0 rows are now carried forward against superseded tooling** (T0-19's probe). The pin
   discipline says a change to the judged surface voids the measurement; the honest resolution is to
   label the carry-forward rather than re-run a browser suite for a change this campaign did not make.

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

**We do not know whether a WebAuthn ceremony works on the production origin — and every ceremony this
campaign verified ran on localhost.**

`wrangler.jsonc` declares `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` as `agents-cp.runlumi.app`.
`smoke:passkey` drives every registration, login, add-credential and recovery ceremony over loopback,
against a local RP ID. The origin/RP-ID pairing is where ceremonies characteristically pass locally and
fail in production, the specs name both explicitly, and **no gate in this repository exercises the
production pairing** — not because one is missing, but because nothing here can reach a public
hostname. Authentication is a Tier-0 claim on the strength of evidence gathered in a configuration that
does not exist for real users.

That is the largest single unknown in this record, and it is not closable by more local work. Everything
below is smaller.

**Second: we do not know whether the one remaining missing probe would find anything — and we have
just learned that "unproven because untested" has twice meant "absent".**

That question was open at the start of this section and it is now **answered**: all 15 unproven rows were
classified by asking whether a route exists that makes the behaviour reachable. Five are missing
features, three are blocked by a measured environmental cause, one is a conflict inside the frozen
contracts, and six genuinely needed only a probe — **five of those six are now closed**: `FR-F04-007`,
both `FR-F13-005` and `FR-F13-006`, and — on inspection, without writing a probe — `FR-F23-007` and
`FR-F21-006`, whose enforcement turned out to be implemented and merely **unlocated**.

So the residual unknown is narrower still. It is about **one** row:

- `FR-F22-010` — the design system is verified by lint and a component inventory, with no rendered
  comparison against `DESIGN.md` or `docs/screens/**`. This campaign changed no UI at all (the diff is
  one new Rust check module, its registration, and probe scripts), so the comparison `AGENTS.md` requires
  "for changed primary screens" has nothing to compare. It remains the single standing gap, and it needs
  a rendered judgement rather than an assertion.

**`FR-F23-007` and `FR-F21-006` were closed by looking rather than by probing**, which is the cheapest
possible result and worth stating plainly: the deprecation enforcement is at `routing.rs:180-181`
(`provider_satisfies` and `model_satisfies`, both gating on `allows_new_routes()`), and every outbound
timeout is built and applied — `adapters/providers.rs:439,443` combines the caller's signal with the
validated `candidate.timeout_ms`, webhook delivery uses `DELIVERY_TIMEOUT_MS = 10_000`. Both had been
carried as "no probe exists", which is a statement about a probe and said nothing about the code.

**And the two closed rows are why the remaining three are worth closing.** `FR-F13-005`/`FR-F13-006`
were annotated "no probe drives a browser-use grant end to end" — a statement about a **probe**. Writing
that probe found **V04-010**: browser and computer-use policy cannot be reached at all, because
`capability_definitions` has no writer anywhere, so every such call is refused `capability_not_defined`
before any toggle is read. The eleven controls are implemented, correct, and unreachable; proving that
needed four rounds of fixing the *fixture* rather than any assertion, and the probe's positive control
refused a falsely-green sheet on each round.

That is the third time a row annotated "no probe" turned out to be a missing capability rather than a
missing test — after `FR-F19-008`, where nothing could arm the client-version guard. **"Unproven because
untested" and "unproven because absent" are indistinguishable from inside a coverage table**, and every
row this campaign has been willing to write a probe for has been worth more than the probe. `FR-F19-008` was annotated "no probe asserts a too-old client
is refused" and the truth was that nothing can arm the guard at all. The inference behind that
annotation was reasonable and wrong, which is the whole argument: **"unproven because untested" and
"unproven because absent" are indistinguishable from inside a coverage table**, and this campaign now has
two measured instances of the second masquerading as the first.

The generalisation is worth more than the five remaining probes. Seven capabilities in this repository were built
and wired to nothing, and every one sat behind a green `pnpm check`: `fan_out_event_statement`,
`provider_entitlement_projections`, the `'run'` usage writer, the staff grant-use surface, the
quarantine levers, the idempotency purge, and now the client-version floor. **Not one was found by a
gate.** `security::repository_liveness` and `security::guarded_column_writers` now cover the function and
column shapes of that class, and between them they catch the two forms that are mechanically checkable —
but a capability that is *present* and merely unwired from a route is still only findable by reading.

**We also do not know whether the jobs queue consumer actually processes an envelope.** Everything up to it
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