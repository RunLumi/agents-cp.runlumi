# Phase 2 candidate manifest — workspace ownership, credential choice, startup

Status: **PROPOSED cut list. Nothing here is a PASS, and the goal remains INCOMPLETE.**
Prepared 2026-10-09 by the primary implementer, read-only. No product file, index, branch,
stash, worktree or remote was changed. No Cargo, Worker, Electron, pnpm or build was run, so
this manifest records scope, order and gaps and does not prove behavior. Only this file and
the scratch files under `test-results/` (gitignored) were written. It does not replace the
coordinator checkpoint, `STATUS.md`, [`plan.md`](plan.md) or the earlier
[`delivery-plan.md`](delivery-plan.md) and [`recovery-candidate.md`](recovery-candidate.md).
Those two notes describe the recovery phase, which was later extracted as PR52, so their
"P1b hunks" table is superseded. This phase is the next one.

Legend. **VERIFIED**: read directly from this checkout on 2026-10-09 with read-only commands.
**LEDGER**: copied from [`plan.md`](plan.md) or an evidence file, not re-read from a remote.
**UNVERIFIED**: could not be checked here, with the reason. **PROPOSED**: unexecuted.

Scratch artifacts (SHA-256 only, no archives, no secret-bearing files):

| File | What it is |
|---|---|
| `test-results/phase02-candidate-files.sha256` | working-tree SHA-256 of every file named below as WHOLE or MIXED |
| `test-results/phase02-server-tracked-wholefile.patch` | `git diff HEAD --binary` of the eight tracked whole-file server paths. sha256 `ccd885a8cebb391221e686f83926bd0cd6bca2b443e333cafeb82353aca4a50c`; 1040 lines |
| `test-results/phase02-server-untracked-wholefile.patch` | `git diff --no-index` new-file patch of the six untracked whole-file server paths. sha256 `659aaab9b922de02f241046a4234e249b37c738aa23fd464ec96829c70742176` |

`git apply --check` was not run, because `git apply --cached` needs approval here. Both patches
are **UNVERIFIED as applicable**. Check them in the independent clone (section 2). They are
against `e7ad897`. They touch no file that PR52 touches, so they should apply on the PR52 head.

## 1. Exact state (VERIFIED unless marked)

| Item | Value |
|---|---|
| Parent branch / HEAD | `codex/desktop-backend-e2e` @ `e7ad897a7f400048df17100594ef86b3788ea0f1` (PR51 head) |
| Parent PRs (LEDGER) | PR51 `e7ad897` draft; **PR52** `4f730a52c6ad8b0abde8f204f473315cf399d796` draft, stacked on PR51, carries recovery (migration 0025, P03-CR-002). Coordinator live refresh: PR52 now head `fe3d6e13c6cb6083cc9fa5ca2e67fefcaa0f83d7`; hosted quality run `37915576559` and default adoption run `37915576667` both SUCCESS. Original socket failures remain preserved; async D1/owned subprocess repair is published. The original `4f730a5` entry describes the recovery commit, not the current PR head. |
| PR52 object locally | **absent**: `git cat-file -t 4f730a5…` fails in this checkout. The base for Phase 2 cannot be diffed locally. |
| Child repo | gitdir `/Volumes/SSD/agents-cp.runlumi/.git/worktrees/agents-cp.runlumi1/modules/integrations/lumi-agents`. Its `HEAD` file reads `ref: refs/heads/codex/lumi-control-plane-e2e`. |
| Child commits (reflog) | `d78e8d5` (= `origin/main`) then eight commits to `2a49525` (PR39, LEDGER). No commit after `2a49525`. |
| Parent gitlink | HEAD `fd977fd`; index `2a49525` (staged); child HEAD `2a49525`. `git status --porcelain=v2` shows `S.MU`: the child has modified tracked content and untracked files. |
| Child git access | `git -C`, `--git-dir=`, `gh`, `ls-remote`, `hash-object`, `apply --cached` all need approval here. Child scope below comes from (a) reading the child `index` and `logs/HEAD` with Read/Grep, (b) the parent `status`, (c) mtime, (d) handoff docs. Treat the child file lists as **UNVERIFIED** until `git -C integrations/lumi-agents status` is run. |
| Parent index | 13 staged paths from the **old recovery** attempt. Nine are `MM`: `repositories/devices.rs`, `repositories/mod.rs`, `routes/devices.rs`, `desktop-e2e/plan.md`, `P03-CG.md`, `DE2E-INT-02.md`, `plan08`, `schema-migration-map.md`, `f19`. Also the gitlink bump. **Never commit or `git add -u` from this index.** PR52 supersedes it. |
| Parent dirty tree | 54 tracked paths modified, plus untracked migrations `0026-0028`, ADRs `0012/0013`, CRs, packets `INT-03/-03-CRED/-04/-05`, `tests/integration/lib/`, `docs/verification/runs/2026-10-07-desktop-managed-e2e/`. |
| Live WIP not mine | a new untracked `apps/api/scripts/provider-http-cancel-topology-probe.mjs` (mtime 17:30) appeared after the status snapshot. The Rust redirect/cancel prototype owns `adapters/providers.rs`, `egress_corpus.rs`, `provider-http-*`. Do not touch or stage them. |
| Main tip (LEDGER) | `516b818993208f244394d8bea7e1ac87d4fa768e` when INT-03-CRED was written. Re-read before any base decision. |

Merged contract gates this phase consumes (LEDGER, from `DE2E-INT-03-CRED.md`):
`P03-CG v1` `31af63b`, `P04-CG v1` `57b2df9`, `P08-CG v1` `8352a7a`, all on `main`. **Not
merged, and so not gates:** the P08-CG addendum for CR-002/CR-003 (in the dirty tree) and the
P03-CG paragraph for CR-003.

## 2. Extraction strategy (PROPOSED)

Never use the original checkout's index or `git add -A`. Per standing instruction and the PR52
precedent, build each phase in an **independent clone outside the product checkout**.

1. `git clone` the parent into e.g. `/Volumes/SSD/agents-cp.runlumi/test-results/phase02-server-repo`
   and check out the PR52 head `4f730a5` as base. Re-read the remote SHA first. If PR52 has
   already merged, base on the merged `main` and re-derive section 3, because the
   `devices.rs`, `tenant_audit.rs`, `P03-CG.md`, `schema-migration-map.md` and
   `lumi-account.mjs` deltas below assume PR52 content is the base.
2. Apply the two scratch patches (`git apply --check` first), then **hand-apply only the
   named hunks** of the MIXED files in section 3, using `git diff <PR52> -- <file>` against the
   dirty file and `git apply -p1 --include`/interactive selection in the clone only.
3. Child: the same, in a clone of the child at `2a49525` (PR39 head), on a new branch.
   Child extraction is **harder and cannot be pre-patched here**, because child git is
   unreadable from this session. The coordinator generates `git diff 2a49525 -- <path>` in the child.
4. Verify each commit's tree in the clone, not in the dirty checkout. A dirty tree masks a
   missing dependency (the recovery note's principle).

A Git patch can carry a `160000` gitlink, but no gitlink bump belongs in the server PR (section 3).

## 3. SERVER cut (parent): `workspace binding removal + P08 rebind + credential mode`

Proposed PR: base **PR52 head**, branch named by the coordinator (suggest
`codex/p03-binding-removal-p08-credential`). Packet IDs: `DE2E-INT-03` and `DE2E-INT-03-CRED`
(backend half). Contract references: P03-CG v1, P08-CG v1, **accepted** CRs P03-CR-003,
P08-CR-002, P08-CR-003, ADR 0012. Migration order constraint: `0025 → 0026`, so merge PR52 first.

### 3.1 Commits, in order

| # | Commit (conventional) | Contents | Why it must be one commit |
|---|---|---|---|
| S1 | `feat(p03): retain removed workspace bindings (0026, ADR 0012)` | migration `0026_p03_workspace_binding_removal.sql`; `repositories/projects.rs` (WHOLE); `routes/projects.rs` (WHOLE); `routes/devices.rs` **hunk 5 only**: `delete_binding(.., &context.received_at)`; `repositories/automations.rs` one synthesized hunk, below; ADR `0012`; `P03-CR-003.md`; `f07` spec (WHOLE, +5 lines); `P03-CG.md` the "P03-CR-003 / ADR 0012" paragraph only; `schema-migration-map.md` the `0026` row plus a **re-measured** headline | `delete_binding` changes signature in `projects.rs`, so both callers must change in the same commit or it does not compile. The `0026` row is required by `security::release_docs` the moment the migration file exists. |
| S2 | `fix(p08): persist credential-mode-only PATCH and replay the committed projection (P08-CR-003)` | `routes/migration.rs` hunks `advance_adoption_stage`, `stage_write`, `after_write`, the `#[cfg(test)] mod tests` block and the `status_code` removal; `repositories/migration.rs` (statement builder side); `modules/migration/adoption.rs` comment change; `P08-CR-003.md`; the P08-CR-003 paragraph of `P08-CG.md`; `p08-cr003-credential-mode-reproducer.mjs` | The route and reproducer encode one behavior. `P08-CR-003.md` records fix and evidence together. |
| S3 | `feat(p08): explicit versioned rebind and stage-zero unbind (P08-CR-002)` | `routes/migration.rs` hunks `rebind_local_adoption`, `AdoptionRebind`, `rebind_version` on `RecordAdoptionRequest`, the `record_adoption` dispatch hunks; `repositories/migration.rs` `ASSERT_LIVE_BINDING_SQL` and `assert_live_binding_statement`; `modules/migration/adoption.rs` rollback change; `modules/migration/tests.rs`; `tenant_audit.rs` **one** `MECHANICAL` entry `repositories/migration.rs::ASSERT_LIVE_BINDING_SQL`; `P08-CR-002.md`; the P08-CR-002 paragraph of `P08-CG.md` | `rebind` joins `workspace_bindings.removed_at`, so it depends on S1 and not the reverse. The `tenant_audit` entry must land with the SQL constant, or `security::tenant_audit` fails. |
| S4 | `docs(desktop-e2e): INT-03 and INT-03-CRED packets` | `DE2E-INT-03.md`, `DE2E-INT-03-CRED.md` | packet definitions and resume checkpoints. Coordinator-owned; its call. |

`routes/migration.rs` S2/S3 hunks are interleaved. The dirty file's hunk headers are
`@@ -122` (rebind field), `-442` (+186, rebind), `-539`/`-543` (record_adoption), `-699..-866`
(advance, eight hunks, CR-003), `-1520` (`status_code` removal), `-1586` (+179 tests). If the
coordinator does not want a two-way split of one 2039-line file, **S2+S3 may be one commit**.
The only dependency order that matters is S1 first. All of this file's hunks are P08, and none
is another phase's.

#### The `repositories/automations.rs` hunk in S1 (synthesized, decision required)

At `HEAD`, `DEVICE_DUE_OCCURRENCES_SQL` checks a pinned binding with
`b.binding_id = … AND b.device_id = ?1 AND b.org_id = o.org_id` and **no `removed_at` filter**.
P03-CR-003 and ADR 0012 say removed bindings must not make an automation eligible. The dirty
file fixes this inside the P06-CR-007 rewrite, which also adds a binding-less
`COUNT(*) = 1` branch and the run-binding resolver. That is a different phase, so it **cannot
be lifted as a hunk**. Options:

- **A (recommended):** hand-write the one-line addition `AND b.removed_at IS NULL` inside the
  existing pinned-binding `EXISTS`, plus a source-text assertion in the same module's tests.
  Not extractable from the dirty tree, so it carries **synthesized-hunk risk** and needs its
  own review.
- **B:** omit it, and state in the PR that automation due-eligibility of a removed pinned binding
  is not enforced until the automations phase. Whether other paths already refuse it is
  **UNVERIFIED**. `find_binding` now filters `removed_at`, and the run, device-run, agent-session and
  inference routes call it, but the due query does not.

Everything else in `automations.rs` (`DEVICE_WORKSPACE_BINDINGS_SQL`, run cancel,
`LATEST_POLICY_SNAPSHOT_SQL`, schedule-rule projection, `split_values` tests) belongs to P06 and
is **excluded**.

### 3.2 Mixed-hunk risks (server)

| File | Mixed with | Take | Leave |
|---|---|---|---|
| `routes/devices.rs` | recovery (PR52) | hunk 5 (`delete_binding` call) | hunks 1-4 are in PR52. Against the PR52 base only hunk 5 should remain; **UNVERIFIED** until diffed against `4f730a5`. |
| `security/tenant_audit.rs` | recovery (PR52), P06-CR-007, P05 claims | `repositories/migration.rs::ASSERT_LIVE_BINDING_SQL` | recovery entries (PR52), 5 `automations.rs` entries and `DEVICE_WORKSPACE_BINDINGS_SQL` (P06), 6 `tools.rs` claim entries (P05). The first `MECHANICAL` hunk interleaves recovery and `ASSERT_LIVE_BINDING_SQL`, so a line-level split is needed. |
| `docs/implementation/gates/P03-CG.md` | recovery (PR52) | the 0026 paragraph only | recovery text |
| `docs/release/schema-migration-map.md` | 0025 (PR52), 0027/0028 | the 0026 row | the dirty headline `28 migrations · 109 · 197 · 76`. `security::release_docs` requires the map to name exactly the migrations present, so a 26-migration headline must be **re-measured** (see gap S-9). The dirty `76 triggers` includes 0027's 3. |
| `docs/implementation/plan08-…md`, `P08-CG.md` | `plan08` carries the INT-05 paragraph | `P08-CG.md` is whole (both paragraphs are P08) | `plan08` is excluded from Phase 2 |
| `tests/integration/lumi-account.mjs` | recovery (PR52) | see 3.3 | |

### 3.3 The workspace block of `lumi-account.mjs` is NOT in the server PR

`tests/integration/lumi-account.mjs` from `const projectSlug` through
`PASS actual P03/P08 client transport bind, staged adoption …` calls
`device.createWorkspaceBinding`, `transport.createAdoptionRecord`, `advanceAdoptionRecord`,
`rollbackAdoptionRecord`, which come from client files that are **untracked at `2a49525`**
(`adoptionTransport.ts` and others are not in the child index). The parent `adoption` CI job
builds the pair from the gitlink. If that block lands while the pin is `2a49525`, the job fails
for a missing client, not a product defect. So:

- The server PR keeps the gitlink at `2a49525` and carries **only server-side proofs**: the
  P08-CR-003 reproducer (raw HTTP, no client) plus Rust tests.
- That block, the `desktop-account-electron.mjs` workspace/credential sections, the
  `scripts/integration/lumi-agents.mjs` desktop-mode changes and the gitlink bump to the client
  Phase 2 head go into a **separate "pair" parent PR**, stacked after the child PR exists. This
  is the release-pair phase from `plan.md`, narrowed to this phase's evidence.
- Whether `deviceTransport.createWorkspaceBinding` and `deleteWorkspaceBinding` already exist at
  `2a49525` is **UNVERIFIED**. `deviceTransport.ts` is tracked, in the child index and modified.

### 3.4 Excluded from the server PR

Migrations `0027`, `0028`; ADR `0013`; `P05-CR-003/004`, `P06-CR-004..008`, `P04-CR-003` (provider redirect), `P04-CR-004` (cancel-lifetime proposal, coordinator decision pending),
`P03-CR-004`; `routes/tool_execution.rs`, `adapters/mock_tool.rs`, `repositories/tools.rs`,
`adapters/providers.rs`, `adapters/queues/*`, `routes/inference.rs`, `modules/inference.rs`,
`modules/budget.rs`, `modules/devices.rs`, `egress_corpus.rs`, `lib.rs`, `routes/automations.rs`,
`routes/tools.rs`, `jobs/`, `consumers/`, `repositories/data_governance.rs`, all `p05*`/`p06*`/
`provider-http*`/`v01*` scripts, `docs/contracts/inference-v1.md`, `compatibility-matrix.md`,
`threat-model.md`, `f10`, `f13`, `f15`, the `f19` runtime-toggle paragraph, `docs/integration/lumi-agents.md`,
`docs/prompts/*`, `docs/verification/runs/**` (evidence: coordinator decides whether any is
committed; some files are very large), `tests/integration/lib/**`, `desktop-automation-*.mjs`,
`tool-admission.mjs`, `desktop-e2e/plan.md` (coordinator-owned).

**Secrets.** Do not archive, copy or commit `.dev.vars`, `.wrangler/`, `test-results/`, any
Electron profile, vault, keychain export, Cloudflare token or `evidence/` payload containing
profile paths. `test-results/` is gitignored (`.gitignore:6`). The scratch manifests hold hashes
and source patches only.

## 4. CLIENT cut (`integrations/lumi-agents`): workspace, credential, startup

Base **`2a49525`** (PR39 head; the child `main` is `d78e8d5`). Open as a PR stacked on PR39's
branch, or on `main` once PR39 merges. The child's merge mode is **merge commit or rebase, never
squash**, because squash drops `Signed-off-by` (`CONTRIBUTING.md` §"Merge mode"). The child has
**no PR template**. CI is `.github/workflows/dco-license.yml` (plus release workflows).
Dependencies on parent: the server PR (section 3) must be merged or published first. The client calls
`rebind_version`, the mode-only PATCH and the tombstoning DELETE. `p08-cg-v1` `8352a7a` is the
merged gate. The CRs above are not.

Child file lists are derived from the child **index** (tracked set at index state), the mtime
scan after `2a49525`'s commit time (`2026-10-07 07:06:50`) and the handoff docs.

### 4.1 Commits (PROPOSED)

| # | Commit | Whole new files (untracked, not in child index) | Mixed, tracked or shared: hunks only |
|---|---|---|---|
| C1 | `fix(startup): resolve bootstrap settings from the owned state root` | `desktopBootstrapStateRoot.test.ts`; `main-profile-bootstrap-handoff.md` | `services/src/paths.ts` (`getBootstrapHomeDir`, `getBootstrapSettingsFile`, `applyConfiguredDataBaseDir`); `desktopDataBaseDirBootstrap.ts`; `desktopChromiumHardwareAccelerationBootstrap.ts`; `mcpUserDirectory/index.ts`; `exportLogs.ts`; `setting/settingService.ts`; `main/index.ts` (the handoff names **4 hunks** and calls it a shared WIP file); `services/src/node.ts` (79 managed/automation mentions, so hunk-level) |
| C2 | `feat(lumi-account): adoption transport, device workspace binding transport` | `adoptionTransport.ts` + `.test.ts`; `errors.ts`; `deviceFields.ts` | `hostTransport.ts` + `.test.ts` (adoption delegates and `changeAdoptionCredentialMode`); `deviceTransport.ts` (workspace binding create/delete; 31 mentions of managed/automation); `shared/src/lumi-account.ts` (workspace and credential projection and commands; 49 mentions) |
| C3 | `feat(lumi-workspace): main-owned encrypted workspace owner with session/org fences` | `lumiWorkspaceOwner.ts` + `.test.ts`, `lumiWorkspaceOwnerTypes.ts`, `lumiWorkspaceServerState.ts`, `lumiWorkspaceValidation.ts`, `lumiWorkspaceVault.ts` + `.test.ts`, `lumiWorkspaceCredentialMode.ts` + `.test.ts`, `lumiWorkspaceMutationFence.test.ts`, `lumiSessionFence.ts` | none |
| C4 | `feat(lumi-workspace): account commands and IPC` | `lumiAccountCredentialCommand.test.ts` | `lumiAccountCommands.ts` + `.test.ts`, `lumiAccountIpc.ts` (18 mentions), `lumiAccountOwner.ts` (**66 mentions: composition of every phase**), `shared/src/channels.ts` (16), `shared/src/index.ts` (16) |
| C5 | `feat(ui): workspace section, credential choice, Lumi-first startup gate` | `LumiWorkspaceSection.tsx`, `LumiWorkspaceCredentialChoice.tsx`, `ui/src/lumi/*` (`LumiEntryPanel`, `lumiAccountFlow`, `useLumiAccountFlow`, `useLumiStartupGate`), `ui/test/lumiAccountFlow.test.ts` | `SettingsPage.tsx`, `Root.tsx`, `WelcomeScreen.tsx`, `LumiAccountSection.tsx`, `locales/en-US.ts` + `zh-CN.ts` (**keep EN/ZH key parity**; the handoff says the `lumiWorkspace.credential.*` sets were compared by listing, not by a test) |
| C6 | `docs(lumi-agents): workspace adoption and credential spec` | `05-workspace-adoption-runtime.md`, `credential-choice-handoff.md` | `04-control-plane-account.md`, `docs/upstream/FORK-DIFFERENCES.md` (must record every new upstream difference) |

Spec-first rule (child `AGENTS.md`): the 05 spec must precede or accompany behavior. Put C6
first if the reviewer wants spec-before-code. The order in the table keeps every commit
independently compilable only if the shared type edits in C2 land before C3-C5. C1 is
independent and can ship first as its own PR. `main-profile-bootstrap-handoff.md` says the
`pnpm typecheck` errors it saw were in other lanes' files, so C1 on a clean tree must be
re-proven.

**"Startup" is ambiguous.** The packets use it for two things: (a) bootstrap state-root isolation
(C1) and (b) the Lumi-first startup entry gate (`useLumiStartupGate`, `LumiEntryPanel`,
`WelcomeScreen`, `Root`; evidence says "Lumi-first entry", "restored session does not reopen
entry"). Both are in the table. The `ui/src/lumi/*` files are **not in PR39**, so the gate UI has
never been delivered. The coordinator should confirm it belongs here and not in the account/device phase.

### 4.2 Files whose phase is undecided (UNVERIFIED; need a child diff)

`hostProcessHomeEnv.ts` + `.test.ts`, `desktopHostProcess.ts`, `desktopRuntimeEnv.ts`
(HOME/profile env for the host process; likely isolation or managed runtime),
`lumiPrivateVault.ts`, `lumiDeviceOwner.ts` (19 mentions), `lumiManagedRunTeardown.ts` (extracted
from `lumiAccountOwner.ts` only to satisfy `max-lines`: C4 needs it or an equivalent split),
`lumiWorkspaceAuthorization.ts` (managed-run authorization, probably INT-04),
`deviceHeartbeat*.ts` and `deviceHeartbeat.test.ts` (device phase, not workspace, and not in PR39).

### 4.3 Excluded from the client cut

`apps/zcode-cli/**`; `packages/provider/**`; `packages/desktop/src/host/**` (incl.
`lumiManagedToolBridge`, `managedAutomationRun`); `packages/desktop/src/scheduler/**`;
`desktopCronScheduler.ts`; every `lumiManaged*`, `lumiAutomation*`, `lumiRuntimeCapabilityPublication*`
file; `services/src/session/automation*`, `tasksDatabase/automation-*`, `zcodeTaskService.ts`,
`zcode-agent/*`; `services/lumi-account/automation*`, `managedRunTransport.ts`,
`managedToolTransport*`, `reviewedToolCatalog*`; `shared/src/model-execution.ts`,
`zcode-protocol/*`, `managed-run-context.ts`; the ui `Automation*`, `LumiManagedRunSection`,
`useLumiAutomationAdoptions` files; `docs/specs/lumi-agents/06-*` and `07-*`.

**Generated or ignored files inside the child worktree that an mtime scan lists but a cut must
never contain:** `*.tsbuildinfo`, `dist-types/`, `dist-server/`, `packages/desktop/bundled-agents/`,
`bundled-tools/`, `mock-cdn/` (tarballs, native `pty.node`, `rg`, `bfs`, `ugrep` binaries),
`resources/macos-window-bounds/`, `packages/.ruff_cache/`, `packages/server/tsup.config.bundled_*.mjs`,
`apps/zcode-cli/**/dist*`. Confirm with `git -C integrations/lumi-agents status --ignored`.

### 4.4 Required for the child PR

- Every commit: `git commit -s`, made by the **human committer**. The tool never signs. The
  `Signed-off-by` must match the commit author's verified identity. The reflog author is
  `j <hong@cloudjetkpi.com>`; the account email in this session is `hong@runlumi.app`. **Check
  `git config user.email` in the child before committing**, or the DCO check fails. A Claude
  `Co-Authored-By` trailer is not a sign-off.
- `node scripts/lumi-modified-files.mjs apply` so every modified upstream file carries the
  Apache-2.0 §4(b) notice; `pnpm lumi:notice`, `pnpm lumi:drift`.
- Pre-push: `pnpm verify:pre-push`, `pnpm architecture:check --changed`, `pnpm typecheck`,
  `pnpm lint` (baseline 70 warnings; report as baseline), `pnpm fmt:check` (repo-wide baseline
  dirty; check touched files only and say so).
- UI changes: `DESIGN.md`, a desktop and a 320 px screenshot, keyboard/focus, EN and ZH, loading
  and error states. No `docs/screens/` reference exists for these controls (stated, not invented).

## 5. Parent PR template and evidence discipline

Required sections of `.github/PULL_REQUEST_TEMPLATE.md`: Work packet (ID, phase, lane, **Contract
Gate commit**, specs, ADRs), Outcome, **declared write surface and exceptions**, Contracts
(consumed/changed with the accepted CR link), Tests, Security/privacy, Performance, Migration/rollback,
Handoff, Reviewer focus.

- Server PR: packet `DE2E-INT-03` + `DE2E-INT-03-CRED`; gate `p03-cg-v1 31af63b`, `p08-cg-v1 8352a7a`;
  CRs P03-CR-003, P08-CR-002, P08-CR-003; ADR 0012. Contracts **changed**: P08 POST gains optional
  `rebind_version`; mode-only PATCH now persists. Both are additive/conformance changes that need an
  **accepted** CR. Write-surface exceptions: `tenant_audit.rs`, `schema-migration-map.md`, `P03-CG.md`, `P08-CG.md`
  (gate addenda are coordinator-owned per `AGENTS.md`) and `routes/devices.rs` (P03 file edited for P08).
- Migration/rollback line: **0026 is forward-only, and code rollback needs a removal-aware backend**
  (ADR 0012). Older binaries show tombstones as active.
- **Main-push deploy hazard:** the `deploy` job in `.github/workflows/checks.yml` applies production
  migrations on a push to `main`. Merging this PR applies 0026 to production. No merge or push without
  explicit authorization. This manifest authorizes none.

## 6. Evidence already scoped (separate local / CI / live)

| Claim | Evidence (LEDGER; files under `docs/verification/runs/2026-10-07-desktop-managed-e2e/evidence/`) | Scope limit |
|---|---|---|
| P08-CR-003 mode-only PATCH persists, replays committed projection | original FAIL 46/52 (`credential-mode-original-runtime.log`); joined FAIL 59/61; **PASS 63/63** (`credential-late-replay-runtime-pass.log`, `.json`) | Dirty parent `e7ad897` and dirty child `2a49525`. `source_hashes` for `routes/migration.rs` `c3d3dd0a…`, `repositories/migration.rs` `6b558cb7…` and the reproducer `ac78b4f5…` **equal the working files on disk now** (VERIFIED by `sha256sum`). Real local Worker/D1, no client, **not a clean or 26-migration tree** |
| Verifier can fail | `credential-sensitivity-proof.json`: dropping the `UPDATE` is DETECTED (55/63 fault, 63/63 restored) in a disposable clone | covers the P08-CR-003 reproducer only |
| Binding removal / rebind in a real app | INT-03 and README: Electron journey PASS (bind, three ladder steps, restart no duplicate, rollback, 204 after a run, old binding ID refused 404, rebind new ID, stage-zero unbind, local sentinel intact) | dirty pair; **runtime on the working tree, not clean-checkout or pair proof** |
| P03/P08 client transport against Worker/D1 | `lumi-account.mjs` workspace block PASS (INT-03 checkpoint) | needs the client Phase 2 head (3.3) |
| Rust | 1042 unit + 11 egress-guard tests and clippy PASS (README "Quality and limits") | whole dirty tree, not the cut |
| Client unit | 14/14 (INT-03); credential owner/transport/UI-flow 60/60; session/org fence 36/36; mutation fence 13/13 (handoff); bootstrap 6/6 + one sensitivity | fakes and stateful in-memory servers; `createLumiAccountOwner` itself is never constructed in a test |

## 7. Gates still missing for this phase

**Server**
- S-1 `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo check --target wasm32-unknown-unknown`, `cargo test --workspace` on the **extracted clean tree** at the exact head. Not run. Most at risk: `security::tenant_audit`
  (mis-split) and `security::release_docs`.
- S-2 `pnpm check`, `pnpm build` (web before API), D1 `db:migrations:apply:local` on 26 migrations, and the CI-listed `p08:invariants`
  and `p07` schema invariants on the 26-migration ledger.
- S-3 **0026 applied to a populated 25-migration D1** (the CR asks for "fresh and existing ledgers"). Only fresh-ledger Electron runs are recorded.
- S-4 **No hostile probe for rebind (P08-CR-002).** Only a positive Electron journey exists. Needed, each with a positive control:
  stale `rebind_version`, active-state rebind, revoked device, removed or mismatched binding, other
  org/project/device, archived project, member role, replay of the idempotency key. `scripts/` has no such file.
- S-5 **No automated probe that a removed binding cannot authorize** a run or a session (`find_binding`, which now filters, is called by
  the run, device-run, session and inference routes) nor an automation due-offer (3.1 option A/B). The 404 is recorded only in the Electron README.
- S-6 **No mutation sensitivity** for the `removed_at` filters, the partial unique index or `ASSERT_LIVE_BINDING_SQL`. Only the P08-CR-003 `UPDATE` has one.
- S-7 P08-CR-003 reproducer re-run on the cut head, because the 63/63 run was on a dirty tree.
- S-8 CR decisions: `P08-CR-003.md` still reads `accepted / rejected / superseded: pending coordinator`, with the merge-protocol boxes unticked.
  `P08-CG.md` calls it "draft, pending coordinator". The PR template requires a linked accepted CR for a changed contract.
- S-9 `schema-migration-map.md` headline for 26 migrations (tables/indexes/triggers) measured by applying the ledger, not copied from the dirty `28 · 109 · 197 · 76`.
- S-10 Hosted CI `quality` and `adoption` at the exact pushed head. **`adoption` failed twice on PR52** (`UND_ERR_SOCKET`, no Linux Worker diagnostics); stacking on PR52 inherits that unresolved failure.
- S-11 Cross-tenant negative tests (required by `AGENTS.md` for multi-tenant features) for the rebind and unbind paths, in the PR, not only in notes.

**Client**
- C-1 Clean clone: `pnpm install --frozen-lockfile` is **BLOCKED** (tarball timeouts; offline missing `emoji-regex@10.6.0`/`semver@6.3.1` snapshot), so
  `typecheck`, `lint`, architecture, notice and drift have **not** been run at any exact head. The lane used a source-mapped `/tmp` tsc: 0 errors in touched files, but ~90 unrelated errors elsewhere.
  Plain `tsc -p packages/ui --noEmit` gives phantom errors (stale built declarations).
- C-2 `createLumiAccountOwner` composition (C4) has no runtime test except the real-Electron journey; that journey ran on the dirty tree.
- C-3 Rendered UI: credential control has **no** screenshot, keyboard/focus walk or async-state capture. No React render harness exists.
  Separate finding: the 320 px startup focus ring was judged too faint; the repair is "pending rebuild/runtime evidence".
- C-4 Electron credential UI journey (consent, cancel, stale, org switch, rollback with each mode) and the secret canary on the wire (the INT-03-CRED acceptance items 1-8) are not run.
  `org_managed_credential` is gated client-side only (decision D2-a); that decision and D1-D4 are recorded as "pending coordinator" in `DE2E-INT-03-CRED.md`.
- C-5 DCO/license CI on the pushed head; PR39's own DCO/license passed (LEDGER) but the new commits are unsigned until a human signs them.
- C-6 Pair proof: parent `adoption` job at a gitlink that points at the client Phase 2 head, exact-head, both dirty flags false (`lumi-account.mjs` writes `control_plane_dirty`/`lumi_agents_dirty`).

## 8. Decisions needed from the coordinator

1. Server PR keeps the pin at `2a49525` and omits the workspace block of `lumi-account.mjs` (section 3.3)? **Recommended.**
2. `automations.rs` one-line `removed_at` filter: option A (synthesized hunk) or B (defer)?
3. Is the Lumi-first startup gate UI (`ui/src/lumi/*`) part of this phase or of account/device?
4. Accept or amend P08-CR-003, and record D1-D4 of `DE2E-INT-03-CRED.md`.
5. Should evidence under `docs/verification/runs/**` be committed (large, partly profile-path-bearing) or kept as an artifact link?
6. If PR52 merges first (squash vs merge commit), re-base the server branch and re-derive the section 3.2 deltas.
7. Does `hostProcessHomeEnv.ts` belong to C1?

## 9. Concrete steps for the coordinator (NOT executed)

1. Re-read remote SHAs: parent `main`, PR51, PR52; child `main`, PR39. Run `git -C integrations/lumi-agents status --porcelain=v2 --branch --ignored`.
2. Clone parent at the PR52 head into a path outside the checkout. `git apply --check` then apply the two scratch patches, verify
   `sha256sum` of each applied file equals `phase02-candidate-files.sha256` (WHOLE section), then hand-apply S1's `devices.rs` hunk 5,
   `tenant_audit.rs` entry, `P03-CG.md` paragraph and `0026` map row. Commit S1, S2, S3 separately, running S-1 and S-2 after each.
3. Run S-3 to S-7, fix what fails, and re-record. Push and open a **draft** PR using the template. Keep it draft.
4. In a child clone at `2a49525`, build C1 first (independent), then C2-C6, `git commit -s` by the human, notices, pre-push. Open a draft child PR.
5. Only then open the pair PR (3.3) that bumps the gitlink and adds the workspace and Electron harness sections.
6. Merge order, **only when authorized**: PR51, PR52, server PR, child PRs, pair/repin PR. Verify exact heads and checks at each step.

**Not claimed:** phase completion, a clean-checkout result, hosted CI, merge, deploy, release, a complete A-E result,
or any behavior of a cut that has not been built in a clean tree.
