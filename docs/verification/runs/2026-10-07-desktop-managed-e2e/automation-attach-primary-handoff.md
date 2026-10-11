# Automation attach — primary handoff (client surfaces)

Packet: DE2E-INT-05, child lane "automation adoption attach / UI / service / commands / strict shared
action". Owner: Claude (primary, attach lane). 2026-10-09. Not touched: workspace credential owner,
account/session owner, backend Rust, index, branch, STATUS, builds, Electron/Worker runtime.
Checkout: child `integrations/lumi-agents` on `codex/lumi-control-plane-e2e`, **dirty** (other lanes' WIP
preserved; my edits are the files listed below).

**Verdict: implemented and unit-proven only. NOT run against Electron or a Worker.** Every runtime claim
is UNPROVEN. No type-check, lint, format, `pnpm check` or build was run (tsc needs approval that is not
available non-interactively); node:test suites below are the only executed checks.

## Gap this closes

`automation-race-harness-handoff.md` gap 1: client B's marker was test-seeded because no supported path
joined a second device to an existing managed definition (hand-over always CREATES a different definition).
Established vocabulary reused, nothing parallel: P06 definition `aut_…`, `automation_managed_adoptions`
marker, session `GET /automations` list + `GET /automations/{id}` (already used by recovery), P06-CR-008
binding resolution. **No wire/frozen-contract change, so no CR.** Server-side nothing is needed: the Worker
already offers a binding-less definition to a device with exactly one live binding for the project, which
is exactly what the UI onboarding gives B.

## Behavior

1. `preview-automation-attach` (read-only): local metadata (never the prompt) + Main-authorized workspace
   (project/binding) + the project's definitions, each with a stable refusal or attachable.
2. `attach-automation` (`confirm:true`, `expectedRevision`, `expectedVersion`): Main re-reads the definition
   (list is not authority), refuses unless: project == this workspace's project, `active`, execution principal
   is the current user, not off-peak, no device pin, binding-less or pinned to THIS workspace's binding,
   version unchanged, local original unchanged, not already attached. Then ONE local `BEGIN IMMEDIATE`
   writes the marker (`managed`, `origin=attached`). No server create/patch/upload; no request body at all.
3. Return of an attached marker only drops local suppression; it never pauses/deletes the shared definition
   (UI copy differs). An attached marker cannot be "re-adopted".
4. Local dispatch is suppressed only after validation; any refusal leaves the original running locally.

## Changed files (child)

- services: `session/tasksDatabase/automation-managed-attach-v6.ts` (new, migration `0006_automation_managed_attach`,
  additive `origin` column default `created`, CHECK), `tasksDatabase/migrations.ts`, `session/automationManagedAdoption.ts`
  (`origin`, `beginManagedAttach`), `session/automationRepo.ts`, `lumi-account/automationAdoptionTransport.ts`
  (`listManagedForProject`, bounded display facts on the projection), `lumi-account/automationAdoptionOwner.ts`
  (`previewAttach`, `attach`, `attachRefusal`, attached release), `node.ts` exports.
- shared: `lumi-account.ts` (two strict actions, attach projections, `origin`), `index.ts`, `test-ids.ts`.
- desktop main: `lumiAutomationCommands.ts` (strict keys/ids/`confirm`), `lumiAutomationOwner.ts` (ports, generation fence, projection).
- ui: `lumi/lumiAutomationAttachFlow.ts` (pure reducer), `settings/LumiAutomationAttachDialog.tsx`,
  `settings/LumiAutomationCardParts.tsx`, `settings/AutomationsSection.tsx` (state, dialog, return copy),
  `lumi/lumiAutomationAdoptionFlow.ts` (badge), `i18n/locales/{en-US,zh-CN}.ts`.
- docs: `docs/specs/lumi-agents/07-automation-adoption-scheduling.md` (new section "Attach to an existing managed automation").
- tests: owner (6 new), store/migration (2 new), Main assembly (2 new + projection `origin` assertions), commands (1 new), UI reducer (new file, 6).

## Executed checks (node --import tsx --test, Node 22.14 vs pinned 24.14)

- services: `automationAdoptionOwner`, `automationManagedAdoption`, `automationManagedGuard`, `lumi-account/*.test.ts` — 88 tests, 88 pass (after fixing one test of mine).
- desktop: `lumiAutomationCommands` + `lumiAutomationOwner` — 16 tests (15 + 1 new commands test), 0 fail.
- ui: `lumiAutomationAttachFlow` + `lumiAutomationAdoptionFlow` — 15, 0 fail.
- NOT run: `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm architecture:check --changed`, `pnpm lumi:notice`/`lumi:drift`,
  full desktop/ui suites, browser render, screenshots, keyboard/focus pass. The UI was not compared with
  `docs/screens/` or rendered; no screen reference was opened (state that explicitly in the PR).

## Product/contract issues found (need an owner decision)

1. **Prompt divergence (material).** The Worker definition carries no prompt; Main reads the retained
   original's prompt at dispatch (`lumiManagedAutomationRuntime.ts`). An attached device therefore runs ITS
   OWN original's instructions. Two devices with different originals run different work under one schedule.
   Attach neither compares nor uploads prompts; the dialog says so. Needs a decision before this is sold as
   "one shared automation" (server-held prompt reference, or an explicit acknowledgement). Not a wire change I
   can make from this lane.
2. **Schema agreement.** AGENTS.md requires module-maintainer agreement for DB structure; 0006 is an additive
   column. Flagged, not assumed. Downgrade: a 0005 build ignores the column; its inserts read back as `created`.
3. **Device-pinned definitions are refused** (the enrolled device id is not in the authorized-workspace context).
   Adding it would touch `lumiWorkspaceAuthorization` (other lane). The race stage's definition is binding-less,
   so this does not block it.
4. Sign-out/shutdown still end authority without stopping the Host task (existing spec gap; unchanged).

## What the race-harness lane must change (not done here; harness is theirs)

Replace `seedLocalAutomations … markManaged` for client B with the real path, keeping the server-binding
assertions: after B's UI onboarding binds B's workspace, open the automations list on B, card menu
`TID_LUMI_AUTOMATION_ATTACH` → dialog (`TID_LUMI_AUTOMATION_DIALOG`, `data-phase=choosing`) → select the
definition created by A (`TID_LUMI_AUTOMATION_ATTACH_OPTION`, `data-attachable=true`) → `TID_LUMI_AUTOMATION_CONFIRM`
→ `data-phase=done`. Readback (state, not the response): B's `automation_managed_adoptions` row has
`origin='attached'`, `state='managed'`, `managed_automation_id` = A's definition; B's `automations` row is
byte-identical; D1 shows no new definition and no audit/automation row from the attach (reads only). Then
the existing contested-occurrence assertions apply unchanged. The ledger line "client B became a managed
owner through a supported UI hand-over" can move from UNPROVEN only after that replay passes.
Negative controls to add: attach to another project's/other user's/paused definition is refused with no marker.

## Sensitivity proofs owed (disposable worktree; none run)

Weaken each and show the named test/verifier fails for that reason after its positive control: (a) remove the
`project_id` equality in `attachRefusal`; (b) remove the principal check; (c) write the marker before the
read-back; (d) make attached release delete the shared definition; (e) drop the unique
`(org_id, managed_automation_id)` conflict handling. Unit tests exist for each outcome; the mutation runs do not.

## Resume checkpoint

Next owner: run the narrow `pnpm typecheck`/`lint`/`fmt:check`/`architecture:check --changed`/`lumi:notice` for the
files above when a build window opens; render the dialog (desktop + narrow, keyboard, error/empty states) against
`DESIGN.md` and `docs/screens/`; then the harness replay above. Re-verify the checkout and that no other lane has
edited `AutomationsSection.tsx` / `lumi-account.ts` before committing.
