# Desktop E2E — phase delivery plan (task note)

Status: **PROPOSED**. Authored read-only on 2026-10-09 by the primary implementer while
runtime `scheduler-json-fixed` was live. No product file, Git index, branch or remote was
changed to produce this note. It does not replace the coordinator checkpoint, `STATUS.md`
or the delivery ledger in [`plan.md`](plan.md); the coordinator may fold any part of it in.

Legend. **VERIFIED** = read directly from this checkout with read-only Git/grep on the date
above. **PROPOSED** = a plan that no one has executed. **UNVERIFIED** = needs a check I
could not make (stated each time).

## 1. Current state (VERIFIED)

- Branch `codex/desktop-backend-e2e`, `HEAD = e7ad897` (PR #51 head). `HEAD` pins the client
  gitlink at `fd977fd` (the baseline). The client phase head is `2a49525` (PR #39).
- The **index** already holds a staged "recovery" set: migration `0025`, the two recovery routes
  in `app.rs`, `repositories/devices.rs`, `repositories/mod.rs`, `routes/devices.rs`,
  `P03-CR-002.md`, `P03-CG.md`, `f19`, `DE2E-INT-02.md`, `plan08`, `schema-migration-map.md`,
  `desktop-e2e/plan.md`, and the gitlink bump `fd977fd -> 2a49525`.
- Nine of those files are `MM`: they carry **further unstaged edits**, and those edits mix the
  recovery phase with later phases (section 3). A commit of the index as it stands is therefore
  **not** a complete or clean recovery candidate, and `git add <file>` for any `MM` file would pull
  later-phase hunks into it.
- Everything for migrations `0026-0028`, ADRs `0012/0013`, `routes/tool_execution.rs`,
  `adapters/mock_tool.rs`, CRs `P03-CR-003/004`, `P05-CR-003/004`, `P06-CR-004..006`,
  `P08-CR-002`, packets `INT-03/04/05`, `tests/integration/lib/` and the automation/tool test
  scripts is **untracked**.
- The child repository's Git state could not be read from this session (approval required for
  `git -C integrations/lumi-agents ...`). Anything below about child commits is from file
  inspection only: **UNVERIFIED** as to what is tracked, committed or dirty there.

## 2. Why recovery sequencing matters (VERIFIED, then PROPOSED)

The client at the phase head calls `POST /api/v1/orgs/{org}/devices/{device}/recovery-challenges`
and `POST .../recover-token` (`packages/services/src/lumi-account/hostTransport.ts:322,345`).
Those routes, and the table they need (`device_token_recovery_challenges`, migration 0025), exist
in the parent **only as staged, uncommitted changes**. Consequences:

1. **PR #51 (`e7ad897`) cannot serve PR #39's recovery client.** A reviewer who merges the child
   against the published parent head gets a client whose recovery calls 404.
2. **CI does not catch it today.** The `adoption` job builds the pair from the gitlink; at
   `e7ad897` the pin is `fd977fd`, which has no recovery client, so the recovery proof in
   `tests/integration/lumi-account.mjs` is not exercised by PR #51's checks.
3. **The recovery commit is what makes the pair coherent**, because it carries both the routes
   and the gitlink bump to `2a49525`; only after it do `adoption` and `lumi-account.mjs` exercise
   the client against the server that implements it.

Proposed order (backend first, per the standing instruction):

1. Parent follow-on commit on the PR #51 branch: **P1b recovery** (section 3). Push; CI must pass
   at that exact head.
2. Child PR #39 is already at its phase head and needs no change for this step. It is mergeable
   only after P1b, because its recovery behaviour depends on P1b.
3. Merge order for the pair: parent PR #51 (with P1b) -> child PR #39 -> a **repin commit** in the
   parent to the merged child SHA. If PR #39 is squash- or rebase-merged, `2a49525` may not be on
   the child's main ancestry (the published phase branch can still retain it). The final pin
   must identify the actual merged, retested client commit, not assume reachability is lost.
   The repin belongs to the release-pair phase (section 5), not to P1b. Nothing here authorises
   a merge.

## 3. P1b — recovery commit: exact hunks (PROPOSED)

Principle: commit only what is needed for `cargo clippy -D warnings`, `cargo test --workspace`
and the account runtime proof to pass **on a tree containing no later-phase file**.

| File | Take | Leave for a later phase |
|---|---|---|
| `migrations/0025_...sql` | whole (already staged) | - |
| `src/app.rs` | whole (staged: the two recovery routes) | - |
| `src/repositories/devices.rs` | staged + **all** unstaged (input-struct refactor of `complete_recovery_statements`; without it the 7-argument function fails `clippy -D warnings`, so the staged copy alone is not clean) | - |
| `src/repositories/mod.rs` | staged + unstaged (`CompleteDeviceRecoveryInput` export) | - |
| `src/routes/devices.rs` | staged + hunks 1-4: import, `Debug` derive dropped on `RecoverDeviceTokenRequest`, `CompleteDeviceRecoveryInput` call, guard-abort -> `409 device_recovery_challenge_invalid` | **hunk 5**: `delete_binding(.., &context.received_at)`. It belongs to workspace removal (P03-CR-003) and does not compile without the matching `projects.rs` change |
| `src/security/tenant_audit.rs` | `JUDGEMENTS`: `DELETE_RECOVERY_CHALLENGES_SQL`, `ASSERT_RECOVERY_CONSUMED_SQL`. `MECHANICAL`: `INSERT/FIND/ASSERT/CONSUME_RECOVERY_CHALLENGE_SQL` | `ASSERT_LIVE_BINDING_SQL` (`migration.rs`, workspace/rebind) and the six `tools.rs` claim entries (managed execution). The first `MECHANICAL` hunk mixes recovery and workspace entries, so it needs a line-level split |
| `tests/integration/lumi-account.mjs` | recovery block; credential-store callbacks; vite fallback; JSON report writer | the block from `const projectSlug` through `PASS actual P03/P08 client transport bind, staged adoption ... rollback` (workspace + adoption + rollback, which needs `removed_at` from 0026) |
| `scripts/integration/lumi-agents.mjs` | `runEnv` parameter and the `LUMI_ACCOUNT_REPORT` exact-head account assertion | the `desktopMode` / Electron assertions (`renders streamed`, `explicit rebind`); the offline/pinned-PATH changes unless the coordinator wants them as a separate harness commit |
| `docs/implementation/change-requests/P03-CR-002.md` | whole (staged) | - |
| `docs/specs/f19-...md` | staged recovery text | the `P03-CR-004` runtime-toggle paragraph (unstaged) |
| `docs/implementation/gates/P03-CG.md` | staged recovery text | the `P03-CR-003 / ADR 0012` paragraph (unstaged) |
| `docs/release/schema-migration-map.md` | staged (`25 migrations`, 0025 row) | the `28 migrations ...` headline and rows `0026-0028`: the release-docs test requires the map to name exactly the migrations present, so listing 0026-0028 before they exist would fail it |
| `docs/implementation/packets/DE2E-INT-02.md` | staged + the unstaged continuation note (it records the recovery evidence) | - |
| `docs/implementation/plan08-...md` | staged | the `DE2E-INT-05` paragraph (automation phase) |
| `docs/implementation/desktop-e2e/plan.md` | coordinator-owned: its call | - |
| gitlink `integrations/lumi-agents` | staged `2a49525` | - |

Not in P1b, and not recovery despite being modified: `desktop-account-electron.mjs` (917 lines;
it contains no recovery reference, so its entire diff is later-phase), `p05-smoke.mjs`,
`v01-provider-fault-probe.mjs`, `egress_corpus.rs`, and all untracked files.

Mechanics (PROPOSED, for the person who owns the index): never `git add` a whole `MM` file. Use
`git add -p` (or `git apply --cached` with a prepared patch) for `routes/devices.rs`,
`tenant_audit.rs`, `lumi-account.mjs`, `scripts/integration/lumi-agents.mjs` and the four docs
above. This note does not touch the index.

### Evidence required before P1b may be called ready

Build the candidate **outside this checkout**: a detached worktree at `e7ad897` with only the
P1b patch applied, so no later-phase file can mask a missing dependency.

1. `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo check --target wasm32-unknown-unknown`, `cargo test --workspace`. The
   `security::tenant_audit` and `security::release_docs` tests are the two most likely to fail
   on a mis-split patch (UNVERIFIED: I expect, but have not run, the staged-only tree to fail
   `tenant_audit`).
2. `pnpm check` and `pnpm build` on Node 24.
3. Fresh local D1 with 25 migrations, then `p07` invariants covering the 0025 CHECKs and the
   one-pending partial unique index.
4. `tests/integration/lumi-account.mjs` on a fresh D1, exact-head: anonymous nonce stays 401;
   anonymous challenge mint 401; wrong device proof 403; expired challenge 409; consumed
   challenge replay 409; exactly one live token after rotation; audit event
   `device.token_recovered.v1`; recovered token re-enters ordinary refresh.
5. A fault control for the guard-abort mapping (a refused guard must be 409, not 500) and one
   for token rotation (an old token must not survive recovery), each failing for the intended
   reason.
6. CI: `quality` and `adoption` green at the pushed head, with the pin at `2a49525`.

Not provided by P1b, and to be recorded as such: the **Electron recovery button** has no test
(`desktop-account-electron.mjs` has none), so actual-UI recovery stays **UNPROVEN**; only the
backend/client-transport path is proven.

## 4. Later phases (PROPOSED; file lists are from the dirty tree and must be re-derived per commit)

| Phase | Parent commit candidate | Child | Depends on | Notes |
|---|---|---|---|---|
| P2 workspace ownership (INT-03) | 0026, ADR 0012, P03-CR-003, P08-CR-002; `repositories/projects.rs`, `migration.rs`, `routes/projects.rs`, `routes/migration.rs`, `modules/migration/*`; `routes/devices.rs` hunk 5; `tenant_audit` `ASSERT_LIVE_BINDING_SQL`; `P03-CG` and schema-map 0026 rows; the `lumi-account.mjs` workspace block | `lumiWorkspaceOwner*`, adoption transport | P1b only for the test script's position | `delete_binding` signature change must land with its callers in one commit |
| P3 managed execution (INT-04) | 0027, ADR 0013, P05-CR-003/004; `routes/tool_execution.rs`, `repositories/tools.rs`, `adapters/mock_tool.rs`, providers `mock://lumi-tool` + `egress_corpus.rs`, inference/budget changes, `p05` scripts, `tool-admission.mjs`; `tenant_audit` tools entries | managed runtime wiring | P2 for numbering order | UNVERIFIED: `tool_execution.rs` is untracked and `app.rs` shows no registration hunk; confirm how it is wired before staging |
| P3a device capabilities | 0028, P03-CR-004, `modules/devices.rs`, f19 toggle paragraph, map row | reports runtime toggles | P3 | could ride with P3 |
| P4 automations (INT-05) | P06-CR-004/005/006, f15, planner skip fix, `jobs/` + `consumers/` automations, producer projection, `json_body.rs`, `lib.rs` observability, `v01` probe, `p06-schedule-projection.py`, `tests/integration/desktop-automation-*` and `lib/`, `plan08` paragraph | preview/scheduler | P3 | scheduler-json-fixed replay is still live; execution/race/restart remain FAIL/UNPROVEN, so this stays draft |
| P5 release pair (QA-01/DEL-01) | repin to merged child SHAs; compatibility matrix; clean-checkout proof | - | all above merged | exact paired replay |

Migration order constraint: 0025 -> 0026 -> 0027 -> 0028. Each is additive and forward-only, and
production applies by filename, so merge the phase PRs in numeric order to keep the ledger
gap-free and to avoid reviewing one phase against another's schema.

Shared-file hazards to split by hunk, never by file: `routes/devices.rs`, `tenant_audit.rs`,
`lumi-account.mjs`, `scripts/integration/lumi-agents.mjs`, `schema-migration-map.md`, `P03-CG.md`,
`f19`, `plan08`, `plan.md`, `repositories/mod.rs`.

## 5. Open questions for the coordinator

1. Is the offline/pinned-PATH harness change part of P1b or its own commit?
2. Who produces the child-repository commit plan, given the child Git state was unreadable here?
3. Squash or merge-commit for the child PR (decides whether the repin is mandatory)?
