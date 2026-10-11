# Phase 2 client cut — Lumi-first startup, account/session/org fences, workspace adoption, credential mode, UI

Status: **PROPOSED extraction cut. No cut has been built, and nothing here is a PASS. The goal remains INCOMPLETE.**
Prepared 2026-10-09 by the primary client implementer. Docs-only. No Git mutation (no index, branch, commit, push, merge,
clone or `STATUS.md` edit), no emit, build, install or test run, and no source write. Native Electron `52972` is live,
so no personal profile was opened. The only files written are this one and
`test-results/phase02-client-files.sha256` (SHA-256 only, gitignored). It complements
[`phase02-candidate-manifest.md`](phase02-candidate-manifest.md), whose section 4 it **refines**. Where the two differ, this file
wins for the client, and the difference is called out in section 3.

Legend: **VERIFIED** read from this checkout on 2026-10-09 with read-only commands. **LEDGER** copied from a handoff or the
manifest. **UNVERIFIED** not checkable here (reason given). **PROPOSED** unexecuted.

## 1. Bases and provenance

| Item | Value |
|---|---|
| Child base (VERIFIED) | `2a495254f0018644d24c9c1e5c5210bb7a30075c` = parent gitlink in the index (`git ls-files -s`). Child `main` is `d78e8d5` (LEDGER). `2a49525` is the PR39 head (LEDGER). |
| Parent HEAD (VERIFIED) | `e7ad897a7f400048df17100594ef86b3788ea0f1`, branch `codex/desktop-backend-e2e`. Parent `HEAD` gitlink is `fd977fd` (manifest, LEDGER). |
| Child git access | `git -C`/`cd` into the child is approval-gated in this session, so the child `status` and `diff` were **not** read. Tracked/untracked classification comes from a read of the child `index` file (below), `Glob`, `Grep` and file hashes. Treat per-file "new vs modified" as **UNVERIFIED** until `git -C integrations/lumi-agents status --porcelain=v2 --ignored` is run by the coordinator. |
| Histories | Parent and child stay separate. The child gets its own branch off `2a49525` (stacked on PR39) in its **own** clone. No parent index, `git add -A`, `git add -u` or whole-index copy anywhere. |
| Path hashes | `test-results/phase02-client-files.sha256`: 41 working-tree files (all C1-C6 named paths that exist; C1's tracked bootstrap files are not hashed, see 3.1). Re-run `sha256sum -c` from the parent root before trusting them. |

**Child index read (VERIFIED, `Grep` on the child `index`):** `lumiAccountCommands.ts`, `lumiAccountOwner.ts`, `lumiDeviceOwner.ts`
and `lumiPrivateVault.ts` are tracked at the base. `lumiAutomationCommands.ts`, `lumiWorkspaceAuthorization.ts` and
`lumiManagedRunTeardown.ts` are **not**, so they are new or untracked work.

## 2. Contract references this cut consumes

- Parent gates on `main` (LEDGER, from `DE2E-INT-03-CRED.md`): `P03-CG v1` `31af63b`, `P04-CG v1` `57b2df9`,
  `P08-CG v1` `8352a7a`. The client wire follows `p08-cg-v1` (VERIFIED: spec 05 line 97).
- **Not merged, so not frozen:** P08-CR-002 (explicit `rebind_version`, stage-zero unbind), P08-CR-003 (mode-only PATCH persists),
  P03-CR-003 and ADR 0012 (tombstoning `DELETE`). The client calls all three. The server PR (manifest section 3) must be merged or
  published first. Without it the client's rebind, credential-mode and unbind calls have no matching backend.
- Specs: parent `docs/specs/f04-authorization-policy-engine.md`, `f05-sessions-devices-account-security.md` (session and org fences),
  `f07` (workspace ownership), `f19` (device policy). Child `docs/specs/lumi-agents/04-control-plane-account.md` and
  `05-workspace-adoption-runtime.md`. Spec 05 says "implementation in progress for DE2E-INT-03" (VERIFIED, line 3). It must be
  updated to a real status before it ships.
- Parent packets: `DE2E-INT-03`, `DE2E-INT-03-CRED` (decisions D1-D4 are still "pending coordinator", LEDGER).

## 3. Cut (PROPOSED), in commit order

Order differs from the manifest in one way: **C6 (spec) first**, because the child `AGENTS.md` requires the spec to precede or
accompany behavior, and the DCO/notice rules apply to all commits. Every commit must compile on its own in a clean clone.

| # | Commit | Whole files (new) | Mixed or tracked: hunks only | Hard dependency |
|---|---|---|---|---|
| C6 | `docs(lumi-agents): workspace adoption and credential spec` | `05-workspace-adoption-runtime.md` (2 automation/managed-run mentions: review), `credential-choice-handoff.md` | `04-control-plane-account.md`, `docs/upstream/FORK-DIFFERENCES.md` (must record every new upstream difference) | none |
| C1 | `fix(startup): resolve bootstrap settings from the owned state root` | `desktopBootstrapStateRoot.test.ts`, `main-profile-bootstrap-handoff.md` | `services/src/paths.ts`, `desktopDataBaseDirBootstrap.ts`, `desktopChromiumHardwareAccelerationBootstrap.ts`, `mcpUserDirectory/index.ts`, `exportLogs.ts`, `settingService.ts`, `main/index.ts` (4 hunks, shared WIP), `services/src/node.ts` | independent; ships as its own PR |
| C2 | `feat(lumi-account): adoption and workspace-binding transport` | `adoptionTransport.ts` + `.test.ts`, `errors.ts`, `deviceFields.ts` | `hostTransport.ts` + `.test.ts`, `deviceTransport.ts`, `shared/src/lumi-account.ts` (adoption and credential projection and commands only) | `errors.ts`/`deviceFields.ts` tracked-ness UNVERIFIED |
| C3 | `feat(lumi-workspace): encrypted workspace owner with session/org fences` | `lumiWorkspaceOwner.ts` + `.test.ts`, `lumiWorkspaceOwnerTypes.ts`, `lumiWorkspaceServerState.ts`, `lumiWorkspaceValidation.ts`, `lumiWorkspaceVault.ts` + `.test.ts`, `lumiWorkspaceCredentialMode.ts` + `.test.ts`, `lumiWorkspaceMutationFence.test.ts`, `lumiSessionFence.ts`, **`lumiWorkspaceAuthorization.ts`** | none | `lumiWorkspaceOwner.ts` imports `lumiWorkspaceAuthorization.ts` (VERIFIED), so it joins C3. `lumiWorkspaceVault.ts` imports `lumiPrivateVault.ts`, which is already tracked, so take it only if modified (UNVERIFIED). |
| C4 | `feat(lumi-workspace): account commands and IPC` | `lumiAccountCredentialCommand.test.ts` | `lumiAccountCommands.ts` + `.test.ts`, `lumiAccountIpc.ts`, `lumiAccountOwner.ts`, `shared/src/channels.ts`, `shared/src/index.ts` | see 3.2 |
| C5 | `feat(ui): workspace section, credential choice, Lumi-first startup gate` | `LumiWorkspaceSection.tsx`, `LumiWorkspaceCredentialChoice.tsx`, `ui/src/lumi/LumiEntryPanel.tsx`, `lumiAccountFlow.ts`, `useLumiAccountFlow.ts`, `useLumiStartupGate.ts`, `ui/test/lumiAccountFlow.test.ts` | `SettingsPage.tsx`, `Root.tsx`, `WelcomeScreen.tsx`, `LumiAccountSection.tsx`, `locales/en-US.ts` + `zh-CN.ts` | `lumiAutomationAttachFlow.ts`/`lumiAutomationAdoptionFlow.ts` live in `ui/src/lumi/` but are **excluded** |

### 3.1 Refinements to the manifest (VERIFIED by grep)

1. `lumiWorkspaceAuthorization.ts` moves from "undecided" (manifest 4.2) into **C3**: the owner imports it. It has one
   comment-only mention of automation (line 40), so it is clean to ship.
2. `lumiSessionFence.ts` has one comment-only mention of automation (line 28: "consumed by automation commands"). The *type* is
   generic. Reword the comment in C3 so the file carries no automation reference.
3. Whole-file C3 files and the `ui/src/lumi/` C5 files **other than the two automation flows** have **zero** references to
   `lumiManaged*`, `lumiAutomation*`, `managedRun`, `ManagedTool`, `reviewedToolCatalog` or `RuntimeCapability`. The count scan covered
   the listed files, so C3 and the C5 UI files separate cleanly.
4. `desktopBootstrap*`/`paths.ts` hashes are not in the scratch file because they are tracked and mixed. Hash them in the clone
   after the hunks are applied.

### 3.2 Mixed-hunk map: what C4 and C2 must **not** carry

Automation, tools and provider-managed changes are interleaved with the in-scope hunks in these files. Counts are of the strings
`managed`/`automation`/`ManagedTool`/`RuntimeCapability` in the dirty file (VERIFIED):

| File | Mentions | Take | Leave (other phases) |
|---|---|---|---|
| `lumiAccountOwner.ts` (408 lines) | 41 | workspace owner composition, session fence wiring, credential-mode and startup-state commands | managed-run teardown, automation adoption owner, tool bridge, runtime-capability publication |
| `lumiAccountCommands.ts` (391) | 6 | `isCredentialChoiceCommand` import and dispatch (`./lumiWorkspaceValidation.js`) | **line 14-16** `import … from "./lumiAutomationCommands.js"`, line 28 `extends AutomationCommandOwner`, line 115-116 `dispatchLumiAutomationCommand`. These require a file that is not tracked and is not in this cut. C4 fails to compile if they remain. |
| `lumiAccountIpc.ts` | 14 | workspace and credential IPC registration | automation/managed-run channels |
| `shared/src/channels.ts`, `index.ts` | 16 each (manifest) | workspace and credential channels and re-exports | automation/tool/managed-run channels and exports |
| `shared/src/lumi-account.ts` | 49 (manifest) | workspace and credential projection and commands | automation attach, managed run, tool projection |
| `deviceTransport.ts` | 31 (manifest) | workspace-binding create/delete | automation and managed-run calls |
| `hostTransport.ts` | n/a | adoption delegates, `changeAdoptionCredentialMode` | managed-tool and automation delegates |

The two highest-risk files are `lumiAccountOwner.ts` and `lumiAccountCommands.ts`. Both are shared composition roots. Expect to
hand-edit rather than cherry-pick, so each needs its own review pass, and a build in the clean clone is the only proof that the
split is complete. Any `AutomationCommandOwner`-shaped member left on the owner interface is a defect of this cut.

### 3.3 Excluded entirely

Everything in manifest 4.3, plus `lumiAutomationCommands.ts`, `lumiManagedRunTeardown.ts`, `ui/src/lumi/lumiAutomation*`,
`useLumiAutomationAdoptions.ts`, `docs/specs/lumi-agents/06-*`/`07-*`, `deviceHeartbeat*`, `lumiDeviceOwner.ts` unless a diff shows a
workspace-only hunk (UNVERIFIED), and all generated output: `packages/*/dist/` (VERIFIED present: ui `dist/lumi/*`,
`dist/settings/LumiWorkspace*`, services `dist/lumi-account/adoptionTransport*`), `*.tsbuildinfo`, `dist-types`,
`bundled-agents/`, `mock-cdn/`, native binaries. Never `git add` a `dist` path. The `.d.ts`/`.js.map` files are emitted from the
sources above and must not be committed.

**Secrets and profiles.** No `.dev.vars`, `.wrangler`, Electron profile, vault file, keychain export, token or `test-results/` payload
in any commit, archive or log. `lumiWorkspaceVault.ts` and `lumiPrivateVault.ts` are *code* for an encrypted vault; do not copy any
vault *data*. A secret canary scan of the final diff is part of the gate (section 6).

## 4. Independent clone (PROPOSED, not created)

- No existing client candidate clone was found under `test-results/` (listing: `lumi-account-client`, `lumi-agents`,
  `electron-auth-proof`, `desktop-approval-browser`, `pnpm-tools`, `client-tool-admission`; no `.git` child). The server candidate
  process `55094` owns its own clone and was not touched.
- **Yes, a new independent clone may be created there**: `test-results/phase02-client-repo`, from the child remote or from a local
  object copy of `2a49525`, on a new branch (name set by the coordinator). That path is gitignored by the parent, so it does not
  pollute the parent index. Clone from the **remote**, not from the dirty worktree, so no WIP, `dist` or generated file can come
  with it. I did not create it, per "prefer docs plan first, no Git mutation".
- Build by copying whole new files from the dirty worktree after verifying `sha256sum -c` against the scratch file, then hand-apply
  the mixed hunks from `git diff 2a49525 -- <path>` (generated by the coordinator, since child git is gated here).
- Native Electron `52972` is live: do not run `pnpm build`, a bundler, Electron or any emitting step in the **original** checkout
  until it exits. Builds belong in the clone.

## 5. Required for the pull request

- Every commit `git commit -s` by the **human committer**, with `Signed-off-by` matching the commit author. The tool does not sign.
  A `Co-Authored-By` trailer is not a sign-off. Reflog author is `j <hong@cloudjetkpi.com>`; this session's account is
  `hong@runlumi.app`. Check `git config user.email` in the clone first, or DCO fails (LEDGER, `CONTRIBUTING.md`).
- Merge mode merge-commit or rebase, **never squash** (drops sign-offs). Child has no PR template. CI is `dco-license.yml`.
- `node scripts/lumi-modified-files.mjs apply` so each modified upstream file carries the Apache-2.0 4(b) notice, then
  `pnpm lumi:notice`, `pnpm lumi:drift`. Record each new upstream difference in `FORK-DIFFERENCES.md`.
- Provenance statement per commit: which of the files above are upstream-derived and modified, and which are Lumi-original.
- Keep it a **draft** and reviewable: five small PR-sized commits, plus C1 optionally as its own PR. Not a mega-PR.
  Do not claim the goal, the phase, a clean-checkout result or a hosted CI result.

## 6. Validation still owed (none of it has been run at an exact head)

Current typecheck, build and lint results are supporting context only. They were produced on the dirty tree via a source-mapped
`/tmp` `tsc` (0 errors in touched files, ~90 unrelated errors elsewhere, LEDGER). They are **not** clean-commit proof.

Focused tests, in the clean clone, per commit (LEDGER counts are from the dirty tree and must be reproduced):

| Commit | Command (PROPOSED) | LEDGER baseline |
|---|---|---|
| C1 | `desktopBootstrapStateRoot.test.ts` | 6/6 plus one sensitivity |
| C2 | `adoptionTransport.test.ts`, `hostTransport.test.ts` | INT-03 14/14 |
| C3 | `lumiWorkspaceOwner`, `lumiWorkspaceVault`, `lumiWorkspaceCredentialMode`, `lumiWorkspaceMutationFence` tests | fence 36/36, mutation fence 13/13 |
| C4 | `lumiAccountCommands`, `lumiAccountCredentialCommand` tests | credential owner/transport/UI-flow 60/60 |
| C5 | `ui/test/lumiAccountFlow.test.ts` | part of 60/60 |

Repo-wide, at the final head: `pnpm install --frozen-lockfile` (**BLOCKED** earlier by tarball timeouts and a missing offline
`emoji-regex@10.6.0`/`semver@6.3.1` snapshot), `pnpm typecheck`, `pnpm lint` (baseline 70 warnings, report as baseline),
`pnpm fmt:check` on touched files only (repo baseline dirty, say so), `pnpm architecture:check --changed`, `pnpm verify:pre-push`,
notice and drift checks.

**Screenshots (owed, none exist for the credential control):** rendered UI against `DESIGN.md` at desktop and 320 px, EN and ZH,
keyboard focus walk, loading, empty, error and rollback states for the workspace section, credential choice and Lumi-first entry
gate. No `docs/screens/` reference exists for these controls (state it, do not invent one). The 320 px startup focus ring was judged
too faint and its repair is still "pending rebuild/runtime evidence" (LEDGER). EN/ZH `lumiWorkspace.credential.*` key parity was
compared by listing, not by a test. Add a parity assertion.

**Hostile evidence still owed** (each needs a positive control and a sensitivity fault):
1. Session/org fence: a stale-generation or org-switched mutation is refused and leaves vault and server state unchanged, including
   a mutation in flight across sign-out and org switch.
2. Cross-tenant: a workspace mapping from org A is unreadable and unusable after switching to org B.
3. Credential mode: `org_managed_credential` consent, cancel, stale `rebind_version`, rollback with each mode, and the secret canary
   (a planted token never appears in IPC payloads, logs, the wire or renderer state). The mode gate is client-side only (decision D2-a).
4. Startup: a restored session does not reopen the Lumi-first entry, and bootstrap settings resolve from the owned state root without
   reading a personal profile.
5. Pair: the parent `adoption` job at a gitlink that points to the client head, both dirty flags false (`lumi-account.mjs`
   `control_plane_dirty`/`lumi_agents_dirty`). Only then can a pair PR bump the gitlink.

## 7. Coordinator decisions

1. Is the Lumi-first startup gate UI (`useLumiStartupGate`, `LumiEntryPanel`, `Root`, `WelcomeScreen`) in this phase or in account/device?
   It has never been delivered (not in PR39).
2. C1 as its own PR now, or stacked in this one? (`hostProcessHomeEnv.ts` placement remains open; UNVERIFIED.)
3. Merge order: the server PR first, or publish the client draft against an unmerged server contract? The client needs P08-CR-002/003.
4. Resolve D1-D4 in `DE2E-INT-03-CRED.md` before C4/C5, since they shape the owner composition.
5. Approve creating `test-results/phase02-client-repo` and the `git -C` reads of the child that this session could not run.

**Not claimed:** any behavior of an unbuilt cut, a clean-checkout result, hosted CI, DCO status, merge, release, or goal completion.
