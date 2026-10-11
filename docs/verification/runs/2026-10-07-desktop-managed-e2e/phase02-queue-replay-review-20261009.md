# Independent feedback: phase02 dispatch and policy replay

Scope: read-only review of the independent phase02-server-review-repo candidate
on basefe3d6e1 and preserved real Worker/D1 original fault probe. No product repair
or new runtime PASS is claimed. Claude remains primary implementer, quota reset
21:50Asia/Saigon on2026-10-09.

## Confirmed source facts

1. `repositories/webhooks.rs::INSERT_QUEUE_JOB_SQL` inserts every new job with
`state=queued, attempt=1, lease_version=0`, notattempt0. `RETRY_JOB_SQL` increments
attempt only on retry. Therefore observedattempt1 in the S5-T6 original run is
consistent with untouched initialstate. The current probe diagnosis testsattempt0
and incorrectly saysattempt1 implies advancement. Correct the diagnostic with a
measured before/after baseline, leaseversion/error/state/delivery controls. A database
row alone cannot prove that a queue publish did or did not happen. Keep S5-T6BLOCKED
until a real positive dispatching/due control completes. Do not change the claim.

2. `lib.rs::dispatch_due_data_jobs` skips all nonexport/nondeletion jobs; there is
no automationjobpublisher in that function. Separatecron `run_automation_sweeps`
calls generation and leaseexpiry, not the persisted dispatch helper.

3. `consumers/automations.rs::AutomationJobHandler::run_sweep` maps BOTH
`JobType::Dispatch` and `JobType::ExpireLease` to `run_lease_expiry_sweep`.
`jobs/automations.rs::dispatch_occurrence_statements` has only its definition in
`rg` results acrossAPI source. Thus even a published dispatchjob has no wired
pending-to-dispatching path in this candidate. Producer-only repair is insufficient.
The existing helper contains occurrenceversionguard, dispatch-timeeligibility
recheck, overlap decision effects and lifecycle event statements; reuse its
contract instead of seedingstate or duplicating a dispatcher in the harness.

4. The current consumer calls its sweep before batching jobclaim/completion. The
comment claiming its jobclaim and domain sideeffect are one transaction does not
follow from that ordering. A proper dispatchrepair must assemble subjectscoped
statements with jobclaim/completion in one guarded batch and prove dedupe/fault
behaviour; do not simply mark the job succeeded after an unrelatedglobal sweep.
This is a source concern, not yet hostile runtime proof.

5. `routes/projects.rs::delete_project_binding` immediately returns a prepared
idempotentReplay before `refresh_policy_snapshot`. Successfulfirstcommit plus
failedsnapshotrefresh remains permanentlyunhealed on same-keyreplay. The new
S5-T9 actualruntimefault control confirms the committed tombstone/failedrefresh,
then observes204replay with oldpolicy and no new snapshot: twoassertionsFAIL.
Refresh must run on authorizedmatching replay as well as normalcommit, preserving
exactstoredresponse, unchangedtombstone, exactlyoneoutboxevent and payload-gated
snapshot. Do not read an active-only binding to authorize a completedreplay.

## Repair handoff and exit evidence

Read P06/F13 frozen contracts and update the packet/CR explicitly before consumer
write-surface expansion. PrimaryClaude owns the minimal producer + subjectscoped
consumer + replay repair; preserve currentcandidate and unrelatedactiveWIP/index.
Run originalNode24Worker/D1probe to fullPASS with positivecontrols. Then fault the
critical guards in a disposable checkout and show the intendedruntimeclaim fails.
Finish exactheadquality/WASM and sourcehashhandoff, then cohesive phasePRs in each
independenthistory. Fulldesktopgoal and its nativeaccount/race/restart/fault gates
remainINCOMPLETE.
