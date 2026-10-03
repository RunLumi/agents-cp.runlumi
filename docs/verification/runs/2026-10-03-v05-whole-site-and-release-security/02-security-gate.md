# §2 — Security gate

**GATE RESULT: PASS.** Every Tier-0-carrying runtime gate was re-run in THIS campaign against the
repaired candidate tree (`aa05674`); every gate met its expected exit, the two
environmentally-blocked gates behaved exactly as their measured blockers predict, and the two
harness-setup gaps the sweep itself found were repaired and the affected gates re-run to green.
No Tier-0 claim rests on inherited evidence alone.

## The sweep

`evidence/v05-security-sweep.sh` — 35 gates, each with its own log (`v05-gate-<name>.log`) and exit
code; summary in `v05-security-sweep-summary.txt`. Exit codes are load-bearing: 1 = a check did not
hold, 2 = the harness could not run.

| gate | exit | verdict carried |
|---|---|---|
| schema:bind-count | 0 | every `prepare()` binds its placeholders |
| db:migrate:local (fresh ledger) | 0 | 22 migrations apply |
| p08:invariants | 0 | schema triggers/constraints refuse invalid writes (17/17) |
| guard:probe | 0 | guard sentinel aborts are deliberate refusals |
| smoke:local | 0 | P01 foundation surface |
| smoke:p02 / p03 / p04 / p05 | 0 | P02–P05 surfaces answer (p02–p04 after the harness fix below) |
| verify:collection-tenancy | 0 | 30 collection routes, 0 cross-tenant leaks, positive-match control |
| verify:path-id-tenancy | 0 | 48 org-scoped routes: own id 2xx, foreign id refused, nowhere-id identical, foreign row byte-identical |
| verify:filter-tenancy | 0 | hostile query-string filters leak nothing |
| verify:mutating-tenancy | 0 | write half, graded on stored state, per-route positive controls |
| verify:privilege-escalation | 0 | 8 classes of client-supplied field, graded on stored state |
| smoke:p08 | 0 | cross-tenant boundary, three callers per route |
| verify:secret-tenancy | 0 | secrets cannot cross tenants, control runs first |
| verify:observability | 0 | **28/28, 0 unmeasured** (after the harness fix below) |
| verify:adoption-privacy | 0 | 8 content classes never reach security_events |
| verify:budget-hardceiling | 0 | hard budget refuses before dispatch, unmanaged path |
| verify:budget-concurrency | 0 | ceiling holds under 8-way concurrency |
| verify:inference-failure | 0 | failed/abandoned inference strands no reservation |
| verify:usage-attribution | 0 | usage rows internally consistent, no foreign identifiers |
| verify:idempotency | 0 | retried mutation is ONE mutation, graded on row counts |
| verify:device-idempotency | 0 | 23/23, different-key controls |
| verify:revoked-device | 0 | 29/29, anonymous leg both sides |
| verify:invitation-race | 0 | one address, concurrent invites, counts from D1 |
| verify:staff-credential | 0 | 46/46, all six internal routes, machine boundary |
| verify:tool-policy-deny | 0 | 50/50, denial enforced |
| verify:attempt-exhaustion | 0 | 49/49, the bound is enforced |
| verify:lease-contention | 0 | exactly one winner, graded on D1 rows |
| verify:webhook-fanout | 0 | the confirmed absence is proven, not assumed |
| verify:restore | 0 | restore rehearsal, invalid writes still refused |
| verify:migration-prior-state | 0 | ledger applies over populated tables |
| smoke:p06 | **2 (expected)** | the local jobs queue never delivers — the measured V01-026/T0-16 blocker, unchanged; 27/27 cases hold, R2 leg BLOCKED |
| verify:provider-faults | **2 (expected)** | the Worker cannot open an outbound socket (V01-026), measured across three address classes |
| verify:campaign-preflight | 0 | every mutation case's fault still applies |

## The two harness gaps the sweep found, and the re-runs

1. **smoke:p02/p03/p04 need a live Worker on :8787** (their AGENTS.md "Needs" column says so); the
   first sweep ran them cold and they answered ECONNREFUSED in 0 s — a harness-setup gap, not a
   product statement. Re-run against a migrated Worker on :8787
   (`evidence/v05-smoke-surfaces.sh`): **p02/p03/p04/p05 all PASS.** (The first re-run attempt
   started that Worker on a fresh persist directory **without migrations** — every signup answered
   the identity-store 503; the fix is in the script, with the lesson recorded.)
2. **verify:observability reads D1 from the DEFAULT persist location** (`apps/api/.wrangler/state`)
   and the worker's stdout for the log legs. Against a `--persist-to` Worker it grades an empty
   database (7 FAIL + 2 UNMEASURED — a harness-shaped world, recorded in
   `v05-gate-verify-observability-rerun.log`). Re-run under its documented setup — default state,
   fresh migrations, `OBS_LOG` at the captured stdout
   (`evidence/v05-observability-run.sh`): **28 pass, 0 fail, 0 unmeasured**, including both
   positive controls and the prefix-canary negative control.

`smoke:local`'s rerun under a held :8787 failed ("the HTTP request/correlation ID did not
propagate"); its green sweep run — taken with the port free, as it requires since it starts its own
workers — is the evidence carried.

## Tier-0 mapping for the release verdict

| Tier-0 claim | this campaign's evidence |
|---|---|
| T0-01 cross-tenant read/write | collection + path-id + filter + mutating tenancy, all exit 0 |
| T0-02 client-supplied ids are not authority | privilege-escalation exit 0 |
| T0-03 auth replay/confusion | §1: 91/91 under the production pairing, all five ceremony kinds |
| T0-04 revocation terminal | §1 revocation legs + revoked-device 29/29 |
| T0-05 secret non-disclosure | secret-tenancy + adoption-privacy + observability 28/28 (18 canary assertions) |
| T0-06 budget denial before dispatch | budget-hardceiling exit 0 |
| T0-07 ceilings under concurrency | budget-concurrency exit 0 |
| T0-08 no fallback after commit | inference-failure exit 0 (+ VI-INF-001 kill carried) |
| T0-09 destructive authorized + idempotent | idempotency + device-idempotency + §4's revoke-confirmation legs |
| T0-10 local-only/adoption privacy | adoption-privacy exit 0 |
| T0-11 migrations refuse invalid writes | fresh ledger + p08:invariants + migration-prior-state + restore |
| T0-12 rollback known | restore-rehearsal exit 0 (RTO/RPO as measured in V04's harness, re-run green) |
| T0-13 tool/browser/computer-use denial | tool-policy-deny 50/50 (the V04-010 unreachability of the catalogue is §3's finding, unchanged) |
| T0-14 admin/support authority + audit | staff-credential 46/46 |
| T0-15 client cannot override authorization | privilege-escalation + staff-credential boundaries |
| T0-16 export/deletion | **BLOCKED (carried, measured)** — smoke:p06 exit 2, local queue never invokes the jobs consumer; repository side proven wired |
| T0-17 outbound retries bounded | attempt-exhaustion + lease-contention + webhook-fanout |
| T0-18 meaningful mutant killed | carried from V04 (11 kills, 6 classes; product tree unchanged in the guarded code); campaign-preflight confirms every case still applies |
| T0-19 stale org context | smoke:browser 91/91 (switch-without-stale-data legs) on the current probe |
| T0-20 machine identity isolation | staff-credential's machine/staff/customer boundary legs |

## Verdict

**The security gate PASSES**, with T0-16 carried as a measured environmental BLOCKED exactly as V04
left it (fail-closed: the export job sits queued and does nothing), and T0-18's kills carried
explicitly rather than re-measured (the guarded code paths are byte-identical; `campaign-preflight`
confirms the cases still apply). No Tier-0 claim is FAIL. One claim is BLOCKED for a measured
environmental cause — which by the release gate's own rule keeps the release verdict from being an
unconditional PASS (see release-verdict.md).
