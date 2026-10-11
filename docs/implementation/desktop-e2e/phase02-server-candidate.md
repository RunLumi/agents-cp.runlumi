# Phase 2 server candidate — workspace binding removal, rebind, credential mode

Status: **CANDIDATE. Coordinator quality and credential runtime gates PASS; hostile unbind/rebind and exact committed pair remain UNPROVEN. The full goal remains INCOMPLETE.** Assembled 2026-10-09 in an independent clone from the declared cut in
`phase02-candidate-manifest.md` (section 3, S1 then S2+S3). Nothing was committed, pushed,
merged or deployed, and no PR was opened. No Cargo, pnpm, Worker, Electron, wrangler, Python or
SQLite process was run: this session could run only `git`, `sha256sum`, `ls` and file tools, so
every behavioural gate below is **NOT RUN**. The coordinator reviews and owns delivery.

## 1. Isolation and base (VERIFIED)

| Item | Value |
|---|---|
| Clone | `/Volumes/SSD/agents-cp.runlumi/test-results/phase02-server-review-repo` |
| Git dir / common dir | `.git` / `.git` inside the clone (a full clone, not a worktree; no shared object or ref store with the active checkout) |
| Base `HEAD` | `fe3d6e13c6cb6083cc9fa5ca2e67fefcaa0f83d7` (PR52 head), tree clean before editing |
| Branch | `codex/e2e-phase01-recovery` (inherited name; **no new branch, no commit made**; the coordinator names the delivery branch) |
| Source | the active worktree `desktop-e2e/agents-cp.runlumi`, dirty on `e7ad897`, read-only. Source SHA-256 list: `test-results/phase02-candidate-files.sha256` (generated 2026-10-09 by the manifest author) |
| Index use | the clone's own index only (`git apply --index`, `git add`). The active checkout's index was never touched |

Note: this session's sandbox cannot copy across the checkout boundary, so source patch content
was read with the file tool and re-created in the clone. Fidelity is therefore proven by SHA-256 of
every resulting file against the source list, not by patch hash (see 2).

## 2. What is in the candidate, and the evidence it matches the source

"Matches" means `sha256sum` of the clone file equals the source working-file hash in
`phase02-candidate-files.sha256`.

### S1 — retain removed workspace bindings (0026, ADR 0012)

| Path | Kind | Result |
|---|---|---|
| `apps/api/migrations/0026_p03_workspace_binding_removal.sql` | new, whole | matches `b8e63faf…` |
| `apps/api/src/repositories/projects.rs` | whole | matches `40d429d6…` |
| `apps/api/src/routes/projects.rs` | whole | matches `1ea27d2b…` |
| `docs/adr/0012-workspace-binding-removal.md` | new, whole | matches `a5ba72ac…` |
| `docs/implementation/change-requests/P03-CR-003.md` | new, whole | matches `5fed1a11…` |
| `docs/specs/f07-projects-workspaces-resource-ownership.md` | whole (+5 lines) | matches `9f564df2…` |
| `apps/api/src/routes/devices.rs` | MIXED: hunk 5 only (`delete_binding(.., &context.received_at)`) | file hash equals the source file `d5698212…`, so against the PR52 base this was the **only** remaining difference |
| `apps/api/src/repositories/automations.rs` | MIXED: **synthesized**, see 4.1 | `6289e0b1…`, not a source hash by design |
| `docs/implementation/gates/P03-CG.md` | MIXED: the P03-CR-003 / ADR 0012 paragraph only | `0afb753d…` |
| `docs/release/schema-migration-map.md` | MIXED: 0026 row, headline, provenance note | `db7808ba…`, see 4.3 |

### S2 + S3 — credential-mode-only PATCH and explicit rebind (kept as one change)

`routes/migration.rs` S2 and S3 hunks are interleaved in one file, so the manifest's allowed S2+S3
single commit is used. Order is S1 first; `rebind` joins `workspace_bindings.removed_at`.

| Path | Kind | Result |
|---|---|---|
| `apps/api/src/routes/migration.rs` | whole | matches `c3d3dd0a…` (the hash cited by the 63/63 evidence) |
| `apps/api/src/repositories/migration.rs` | whole | matches `6b558cb7…` (cited by the 63/63 evidence) |
| `apps/api/src/modules/migration/adoption.rs` | whole | matches `78d48db1…` |
| `apps/api/src/modules/migration/tests.rs` | whole | matches `ce9ab69e…` |
| `apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs` | new, whole | matches `ac78b4f5…` (cited by the 63/63 evidence) |
| `docs/implementation/change-requests/P08-CR-002.md` | new, whole | matches `203befc4…` |
| `docs/implementation/change-requests/P08-CR-003.md` | new, whole | matches `ca7ebfb1…` (still reads "pending coordinator") |
| `docs/implementation/gates/P08-CG.md` | whole | matches `64b64ad1…` |
| `apps/api/src/security/tenant_audit.rs` | MIXED: one `MECHANICAL` entry `repositories/migration.rs::ASSERT_LIVE_BINDING_SQL`, `Class::OrgBound` | `e3771952…` |

Source patch hashes recorded by the manifest author: tracked `ccd885a8…a50c`, untracked
`659aaab9…2176`. The tracked patch re-created here hashes `ae87e634…` (whitespace in blank context
lines differs from the original; `git apply --check` and `--index` succeeded, and every file it
produced matches its source hash). The untracked files were written whole, not applied as a patch.
The candidate patch of record is the one generated from this clone's index (section 6).

P08 mode idempotency: the exact-full-projection implementation and its tests are inside the whole
files above (`stage_write`, `after_write`, the `#[cfg(test)] mod tests` block, the replay-before-stage
ordering, and the version fence). Workspace rebind CAS (`rebind_version` plus the guard and
`ASSERT_LIVE_BINDING_SQL` in one batch), the live-binding match, tenant scoping through
`ensure_project_access` and the device `org_id` filter are all unmodified from the source.

## 3. Exclusions (not in this candidate)

Everything in manifest 3.4: migrations `0027`/`0028`, ADR `0013`, P05/P06/P04-CR-003/P03-CR-004
change requests, `tools`/`tool_execution`/`inference`/`providers`/`budget`/queues/jobs/consumers,
`egress_corpus.rs`, `lib.rs`, `routes/automations.rs` and the rest of `repositories/automations.rs`
(the P06-CR-007 rewrite, `DEVICE_WORKSPACE_BINDINGS_SQL`, run cancel, snapshots), the 5
`automations.rs` and 6 `tools.rs` `tenant_audit` entries, `plan08`, `f10/f13/f15`, the `f19`
paragraph, packets `DE2E-INT-03` and `DE2E-INT-03-CRED` (S4, coordinator-owned), `docs/prompts/*`,
`docs/verification/runs/**`, `tests/integration/**` including the workspace block of
`lumi-account.mjs`, `scripts/integration/**`, `desktop-*.mjs`, all client files, the gitlink. The
provider-redirect, cancel-topology and v01/p05/p06 scripts were not read or copied.

## 4. Mixed-hunk and synthesis risks (UNRESOLVED, for the coordinator)

### 4.1 `repositories/automations.rs`: synthesized hunk, not lifted

Added `AND b.removed_at IS NULL` to the existing pinned-binding `EXISTS` in
`DEVICE_DUE_OCCURRENCES_SQL`, and one source-text test,
`due_work_pinned_to_a_removed_binding_is_never_offered`, in the first `mod tests`. The binding-less
`COUNT(*) = 1` branch and the run-binding resolver were **not** taken. This is hand-written, has no
source hash and needs its own review.

- The test is a source-text assertion. It does not execute the query, so it is **not** hostile or
  runtime evidence for "a removed pinned binding is never offered a due occurrence" (manifest S-5).
- **Base defect found, outside this cut:** at `fe3d6e1` that same statement ends
  `ORDER BY o.scheduled_for_ ASC, ...` (line 428). `automation_occurrences` has `scheduled_for_utc`
  (migration `0011`) and no `scheduled_for_`, and the source working file reads
  `scheduled_for_utc`. By source reading SQLite rejects this with "no such column", so the device
  due-work query would fail whenever it is prepared. This is **not proven at runtime here**. The
  source fixes it inside the P06 rewrite. The candidate deliberately does not touch it. Decision
  needed: take the one-token fix into S1 (an extra P06 line, but the removed-binding filter cannot be
  proven on a statement that does not run), or defer both to the automations phase.
- Option B (omit the filter) remains available. Whether another path refuses a removed pinned
  binding is still UNVERIFIED.

### 4.2 `security/tenant_audit.rs`

One `MECHANICAL` entry labelled `OrgBound`, inserted as the first entry of the list. The audit
re-derives the class from statement text, so a wrong label fails `security::tenant_audit`; that
test **was not run**. The pre-existing `DELETE_BINDING_SQL` entry is
`IdChain(BINDING_BY_ID_SQL)` and is unchanged in the source; the statement is now an `UPDATE`
with the same `binding_id`/`project_id` predicate, but whether the audit still accepts the
`IdChain` label for an `UPDATE` is **UNVERIFIED** until the test runs. The source has the same
combination, so the source suite passing (1042 unit, per its README) is the only prior evidence.

### 4.3 `schema-migration-map.md` headline is derived, not measured

Headline changed to `26 migrations · 109 · 197 · 73`. Basis: the 25-migration counts were measured
independently on 2026-10-09; `0026` is an `ALTER TABLE ADD COLUMN` plus a same-name
`DROP INDEX`/`CREATE UNIQUE INDEX`, which adds no object. **The 26-migration ledger was not applied
by me.** The map says so in its own text. The dirty source headline (`28 · … · 76`) was not
copied. `test-results/measure-schema.py` (gitignored, throwaway) applies all migrations to
in-memory SQLite and prints the counts; run it from the clone root.
`security::release_docs` only requires each migration name in order, which the 0026 row satisfies.
The per-migration Tables/Indexes columns remain unreconciled, as before.

### 4.4 Other risks

- `repositories/data_governance.rs` hard-deletes from `workspace_bindings` (retention path,
  line 582) and reads them (line 1394). It is excluded and unchanged. Tombstones are now rows it
  may meet; retention behavior for removed bindings is not examined here.
- The reproducer depends on `apps/api/scripts/lib/smoke-harness.mjs` at base. The 63/63 run used
  the dirty-tree harness at `e7ad897`; commit `fe3d6e1` then changed `smoke-harness.mjs` by +114
  lines (async D1 subprocesses; `git show --stat`).
  Every helper the reproducer calls exists by name, but the interface was **not** diffed. A harness
  mismatch would show as a probe error, not a product defect.
- `P08-CR-003.md`, `P08-CG.md` still say "draft, pending coordinator"; the PR template requires an
  accepted CR for a changed contract. Not edited here (coordinator decision).
- `P08-CG.md` is taken whole. Its two new paragraphs sit at the top of "Purpose and boundaries"
  as in the source.
- Branch name: still PR52's. Rename before any commit so it cannot be confused with PR52.
- Squash-merging PR52 changes the base; the manifest-6 deltas for `devices.rs`,
  `tenant_audit.rs`, `P03-CG.md` and the map would need re-deriving.

## 5. Tests and gates still needed (all NOT RUN)

1. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace`, `cargo check --workspace --target wasm32-unknown-unknown`, at the exact
   head. Most at risk: `security::tenant_audit` (4.2), `security::release_docs`, the new
   `automations` test (it must also fail if the filter is removed), and the `routes::migration`
   tests. The `Waker::noop()` call in the route test module needs a Rust version that has it; the
   toolchain is not checked here.
2. Apply the 26-migration ledger to a fresh D1 and measure the headline (4.3).
3. **0026 on a populated 25-migration D1** (S-3). Only fresh-ledger runs exist.
4. `pnpm check` and `pnpm build`, `p08:invariants`, `p07-schema-invariants` on 26 migrations.
5. P08-CR-003 reproducer on the cut head, real Worker and D1, positive controls first (S-7), plus a
   mutation run in a disposable worktree (drop the new `UPDATE`).
6. Hostile probe for rebind (S-4): stale `rebind_version`, active-state rebind, revoked device,
   removed or mismatched binding, other org/project/device, archived project, member role,
   idempotency-key replay, each with a positive control; plus cross-tenant negatives in the PR (S-11).
7. A probe that a removed binding cannot authorize a run, device run, session or inference, and a
   mutation of the `removed_at` filters and `ASSERT_LIVE_BINDING_SQL` (S-5, S-6). The due-offer
   case depends on the 4.1 decision.
8. Hosted CI `quality` and `adoption` at the pushed head (S-10). PR52's own `adoption` is reported
   SUCCESS on `fe3d6e1`; that is the base, not this candidate.

## 6. Candidate patch of record

Staging beyond `git apply --index` was not available, so the candidate is a working tree plus
partial index, uncommitted. Tracked part: `git diff HEAD --binary` against `fe3d6e13`, 13 files,
+714/-161, written to `test-results/phase02-server-candidate-tracked.patch` (gitignored), SHA-256
`29e7216c70c4f4fa3b457ab3582714c07e94da45ca877429e4a45096a627c9f6`. Untracked part, 7 new files
(each hash in section 2, and this document): migration `0026`, the reproducer, ADR 0012,
`P03-CR-003`, `P08-CR-002`, `P08-CR-003`, and this note. `git status --short` lists exactly these 20
paths. Regenerate the tracked patch after any edit; this note is not part of its hash.

## 7. Deployment hazard

Merging to `main` runs the deploy job, which applies production migrations. Merging this applies
`0026` (forward-only) to production, and code rollback needs a removal-aware backend (ADR 0012).
No merge or push is authorized by this document.

## Coordinator verification refresh — 2026-10-09

The earlier NOT RUN tables describe the assembly handoff, not current status.
Independent full `pnpm check` PASS after one scoped reproducer-format repair;
original format failure preserved. Rust native 1043 + 11 PASS, format/clippy/WASM
PASS. Fresh release Worker build and real local Worker/D1 credential reproducer
PASS63/63, including stored-mode/readback/replay/chained/version/tenant refusals.
26-migration SQLite structural measurement:109tables197indexes73triggers.
Logs under original checkout test-results/phase02-server-*. No clean-install
pair proof is claimed: dependencies/webdist were readonly reuse symlinks.
Hostile rebind/tombstone runtime probe and sensitivity still owed, along with
exact committed head checks and clean pair. No commit, PR or merge yet.

## Server lane update (P06-CR-009, 2026-10-10)

Base `fe3d6e13c6cb6083cc9fa5ca2e67fefcaa0f83d7` + dirty tree; no commit/push/merge/deploy. Real Worker/D1 probe `phase02-workspace-hostile-s6-run4.log`: exit 0,
149/149. `pnpm check` and `pnpm build` (dry-run) pass; mutations A-G each fail only their intended claims; limits and findings are listed in
`docs/verification/phase02-workspace-hostile-probe.md` (section "S6 dispatch guards ..."). New/changed paths in this lane: see P06-CR-009 "Write surface actually used".
