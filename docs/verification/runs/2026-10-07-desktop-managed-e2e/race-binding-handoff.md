# Race binding resolution and queued-run cleanup — focused handoff

Packet: DE2E-INT-05 (race seam only). Implementer: Claude (primary). Updated 2026-10-09.
Branch `codex/desktop-backend-e2e`, base HEAD `e7ad897`, **dirty** (other agents' WIP preserved;
no STATUS/index/git/branch changes made by this work).

**Verdict: source change written, NOT built, NOT run.** No cargo, no Worker, no Electron was
executed (coordinator test window). Nothing here is runtime PASS; every claim below is UNPROVEN
until the commands in "Replay" run.

## Diagnosis (from source + `evidence/automation-full-isolated-race-fail.*`)

1. `DEVICE_DUE_OCCURRENCES_SQL` admitted every active device when the definition had no
   `target_workspace_binding_id`.
2. `routes/automations.rs::start_occurrence` copied the definition's (NULL) binding into the P05
   session and run.
3. Main (`lumiManagedAutomationActivation.ts`) requires `run.workspaceBindingId` to equal the
   binding it authorized and refuses NULL -> `run_activation_failed`. Correct; untouched.
4. Nothing cancelled the run when the occurrence settled `failed`; the client's cleanup read of a
   NULL-binding run fails too, so the run stayed `queued`.

## Change (server-authorized, authenticated device only; no client id is authority)

Files (mine): `apps/api/src/repositories/automations.rs`, `apps/api/src/routes/automations.rs`,
`apps/api/src/security/tenant_audit.rs` (3 registry rows only), `apps/api/scripts/v01-lease-contention-probe.mjs`,
`apps/api/scripts/v01-attempt-exhaustion-probe.mjs`, `docs/specs/f15-automations-scheduled-offpeak-tasks.md`
(one paragraph), `docs/implementation/change-requests/P06-CR-008.md`, this file.

- Resolver `resolve_device_workspace_binding` + pure `classify_device_bindings`
  (Resolved / Unresolved / Ambiguous). Pinned definition binding must be the claimer's own live
  binding; binding-less resolves to the device's single live binding for the project.
- `due`: binding-less work offered only to a device with exactly one live project binding.
- `claim`: resolves before the attempt is allocated; 409 `workspace_binding_unresolved` /
  `workspace_binding_ambiguous`.
- `start`: re-resolves, writes the resolved id to session+run, adds a batch guard
  (`assert_device_binding_current_statement`).
- `settle` outcome `failed`: same batch cancels the occurrence's run only if still `queued` and
  created by this occurrence+lease (`failure_code=automation_run_not_started`, `run.cancelled.v1`
  system event inserted only when the cancel took effect). Running/terminal runs untouched.
- No wire shape, schema or migration change. Main guards unchanged.

## Tests written (not run)

In `apps/api/src/repositories/automations.rs` `mod tests`:
`a_device_resolves_a_binding_only_when_exactly_one_is_live`,
`due_work_without_a_pinned_binding_is_offered_only_to_a_device_that_can_resolve_one`,
`start_binds_the_run_to_the_resolved_binding_and_claim_refuses_an_unresolvable_device`,
`failed_settlement_cancels_only_the_unstarted_run_it_created`. These are unit/structural checks;
they prove SQL/source shape only, not D1 behaviour. Existing audit tests
(`security::tenant_audit`) classify the three new SQL constants.

Still owed (runtime, needs Worker/D1): (a) due/claim/start with two devices where only one has a
project binding; (b) device with two bindings -> 409 ambiguous, attempt counter unchanged, no
lease; (c) failed settle after start leaves run `cancelled` + one event, and a `running` run is
untouched; (d) cross-tenant negative (another org's device/binding never resolves). Add as a
Worker/D1 probe or to the V01 probes; positive control first.

## Replay (original reproducer, unchanged)

Needs a rebuilt Worker (verifier checks wasm freshness) and a rebuilt client if any:
```
pnpm build            # web then API; coordinator-owned, not run here
node tests/integration/desktop-automation-electron.mjs   # full, no --until
```
Expect the race stage to change from `FAIL ... contested occurrence ended failed` only if client B
also has a live project binding on the server; otherwise B is (correctly) no longer offered the
work. **The race-stage harness owner must give B a binding via the supported adoption flow**
(its current B "marker" is test-seeded and unrelated to the server binding). Fast checks first:
`cargo test -p <api crate> automations` and `tenant_audit`, then `pnpm check`.

Sensitivity (owed): in a disposable worktree restore `workspace_binding_id: automation.target_workspace_binding_id.as_deref()`
in `start_occurrence`, and separately drop the `if next == OccurrenceState::Failed` block; the
runtime verifier must fail for those reasons.

## Risks / follow-ups

- Existing probes `v01-lease-contention-probe.mjs` and `v01-attempt-exhaustion-probe.mjs` claimed
  with binding-less devices; edited blind to create a binding via `POST /api/v1/devices/bindings`
  first. Unrun: verify them.
- Device with several live bindings for a project cannot run a binding-less automation
  (ambiguous by design); such automations must be pinned. Selecting among them needs a new frozen
  field (not done).
- Not covered: ambiguous/expired-lease sweep leaves a `queued` run if the host never settled.
  Settlement cleanup covers the demonstrated seam only.
- `rustfmt` was not runnable here; formatting hand-matched, run `cargo fmt --all --check`.
- `claim` previously did not check a pinned binding belongs to the claimer; now enforced via the
  same resolver (tightening beyond the demonstrated race).
