# Automation race harness — binding wiring handoff

Packet: DE2E-INT-05 (race stage harness only). Owner: Claude (primary, harness lane). Updated 2026-10-09.
Branch `codex/desktop-backend-e2e`, base HEAD `e7ad897`, **dirty** (other agents' WIP preserved; no
STATUS/index/branch/Rust/child/CI changes by this lane). Companion: `race-binding-handoff.md` (backend lane),
`docs/implementation/change-requests/P06-CR-008.md`.

**Verdict: harness source changed and pure-tested only. NOT run against a Worker/Electron.** The only executed
check is `node --test tests/integration/lib/*.test.mjs` (48 tests, 47 pass, 0 fail, 1 skipped/todo). Nothing
below is runtime PASS; every behavioural claim is UNPROVEN until the original reproducer is replayed.

## Original reproducer (exact, unchanged command; full run, no `--until`)

Evidence of the failing state: `evidence/automation-full-isolated-race-fail.{log,json}`, line 57/68:
`FAIL race: AssertionError: contested occurrence ended failed`,
`VERDICT FAIL; stages onboard=PASS adopt=PASS schedule=UNPROVEN race=FAIL restart=UNPROVEN faults=UNPROVEN`.

```
pnpm build        # web then API; the harness checks wasm freshness. Coordinator-owned, not run here.
node tests/integration/desktop-automation-electron.mjs     # full journey, no --until, default 2 race rounds
```
Scoped diagnostic only (never certifies): `node tests/integration/desktop-automation-electron.mjs --until=race`.
Fast pure check first: `node --test tests/integration/lib/automation-race-binding.test.mjs`.

## What changed (harness only)

- New `tests/integration/lib/automation-race-binding.mjs` (+ `.test.mjs`, 6 cases): read-only mirror of the
  backend's resolution (`classifyDeviceBindings`, `admittedByResolver`, `assertEachDeviceResolves`,
  `readDeviceBindings` = D1 SELECTs only). Binding-less definition is admitted only to a device with exactly one
  live binding for the project; a pinned one only to the owner of that live binding.
- `automation-stage-race.mjs`:
  - B's execution authority is the server binding created by the **actual UI** onboarding
    (`onboardToManagedPolicy` selects the project and runs "Review and bind this workspace" -> managed policy on
    B's own workspace). The stage now READS D1 and fails by name unless A and B each hold exactly one live binding
    for the project with distinct binding ids and workspace identities (`state.bindingIds`).
  - The admission mirror was rewritten from the old SQL (which admitted any device for a binding-less definition)
    to the resolver rule; the positive control (only A admitted while pinned to A's binding) and the post-retarget
    "both admitted" assertion are kept.
  - New post-settle assertions: the contested run's `workspace_binding_id` equals the **winner's own** binding
    (never NULL, never the loser's) and the run is not left `queued`. Existing assertions kept: occurrence
    `succeeded` (dispatch failure is not accepted), one lease, one `claimed` attempt, one run link, one P05 run,
    winner journal settled, loser journal has no started/settled row, loser tasks-index gained no task, winner
    gained exactly one completed task, B's original byte-identical with no local run history.
  - Truly concurrent claim is preserved: A and B are both SIGSTOPped while the Worker generates the occurrence,
    then SIGCONTed together.
- No seeded binding, run, lease or execution authority anywhere. Main guards and backend untouched.

## Current gaps (named, not hidden)

1. **B's attach is now driven through the real UI in source, NOT yet runtime-verified (UNPROVEN until a run).**
   `automation-stage-race.mjs` no longer seeds `markManaged` for B. After B's real sign-in/enrollment/workspace
   binding, it (a) opens B's card menu -> "Attach to existing" (spec 07; `lumi-automation-attach`) while the
   definition is still pinned to A's binding and asserts the rendered candidate is `data-attachable=false` with
   Confirm unavailable and nothing written (control); (b) after the owner's public PATCH retarget, reopens the
   dialog, asserts the single candidate is attachable, Confirm is unavailable before a choice and before the
   acknowledgement checkbox (`lumi-automation-attach-ack`, which makes Main send
   `acknowledgeLocalInstructions:true`), then confirms with real CDP clicks. Post-checks: exactly one marker
   `state=managed, origin=attached` naming exactly `state.managedAutomationId`; B's original row byte-identical;
   no extra `automation_definitions` row; every definition's `status/version/updated_at` unchanged by the attach.
   All of this precedes the SIGSTOP/SIGCONT race, so native-B eligibility, true concurrent claim, loser absence and
   run-winner-binding assertions are unchanged. The old ledger gap `client B became a managed owner through a
   supported UI hand-over` was removed from source only; treat it as closed only once a real run records the
   attach PASS lines. New helpers: `startAttach`, `attachOptions`, `chooseAttachOption`, `toggleAttachAck` in
   `lib/automation-ui.mjs`. Needs the supervisor's rebuilt client (dialog + strict actions) before it can run.
   Still not substituted: authority seeding or a direct `attach-automation` command. The candidate option has no
   managed-id attribute in the DOM, so "exact managed id" is proved from the marker row, and "the one candidate" by
   the option count plus the D1 definition count.
2. **Not run.** Needs a rebuilt Worker (includes P06-CR-008) and fresh desktop bundles. Expected delta from
   `race=FAIL` is only if the backend source is built; otherwise B is correctly not offered the work or the old
   NULL-binding failure recurs.
3. Mirror drift risk: `automation-race-binding.mjs` copies the backend rule. A stale mirror fails at runtime
   (predicted admission vs actual lease/run binding), it cannot pass silently.
4. Loser non-disclosure at the desktop boundary stays a named gap (desktop does not expose the refused HTTP
   body); server-side non-disclosure is `pnpm verify:lease-contention` (unrun, edited by the backend lane).
5. Loser "demonstrably contended" (a server record of its claim attempt) is still a ledger gap when no
   `security_events` row names the loser.
6. Sensitivity proof owed: in a disposable worktree restore the NULL-binding copy in `start_occurrence`, and
   separately make `assertEachDeviceResolves` see zero bindings for B; the stage must fail for those reasons.

## Update: line-215 `orgId` ReferenceError repair (2026-10-09, harness lane)

- Cause: the Electron run that terminated `race=FAIL` with `ReferenceError: orgId` executed a revision of
  `startClientB` whose `seedLocalAutomations` spec still carried `markManaged: { orgId, ... }` while `orgId` is
  not bound in that function (only `raceStage`/`attachClientBThroughUi`/`makeBothEligible` destructure it).
  Concurrent fixture edits had re-introduced the old marker seed next to the UI attach flow. Current source has
  no `markManaged` and no unbound `orgId`; the seed carries no authority. FAIL report profile `Rvhlgm` is retained, untouched.
- Added fixture assertions in `startClientB`: B's seeded original has NO marker and an existing row before
  launch, and still no marker after real onboarding. The only marker writer left is the attach dialog
  (`origin=attached`, naming exactly `state.managedAutomationId`).
- Added `lib/automation-stage-race.test.mjs` (source guard: no `markManaged`; unmarked-fixture and
  `origin attached` assertions present; every function reading `orgId` binds it). Pure check only: whole lib
  suite 59 tests, 58 pass, 0 fail, 1 skipped. Guard sensitivity was shown on the old shape only by an inline regex
  replay, not by a disposable-worktree mutation (still owed).
- Unchanged: attach refusal control (pinned), acknowledgement gate, single Confirm, byte-identical original,
  SIGSTOP/SIGCONT true concurrency, winner-own binding on the run, loser absence. No client/Rust/CI/build/Electron/STATUS/push.
- Still UNPROVEN at runtime. Exact replay: `node --test tests/integration/lib/*.test.mjs` then
  `node tests/integration/desktop-automation-electron.mjs` (after coordinator `pnpm build`).

## Replay checklist (coordinator, when a build window opens)

1. `node --test tests/integration/lib/*.test.mjs`
2. `pnpm build`
3. original reproducer above; read `evidence/result.json` in the retained profile (`race` array, ledger gaps).
4. Positive controls to confirm in the log: "actual UI onboarding gave each device its own live server binding",
   "eligibility control ... only A", "both enrolled devices must be eligible".
