# P1b — device-token recovery: candidate delivery note

Status: **PROPOSED, UNPROVEN.** Prepared 2026-10-09 by the primary implementer as an
isolated candidate patch against exact parent `e7ad897a7f400048df17100594ef86b3788ea0f1`
(PR #51 head). No product checkout, index, branch or remote was changed to produce it. No
Cargo, Worker, Electron or build was run: runtime 31770 was live on the original checkout.
Nothing below is a PASS. This note does not replace the coordinator checkpoint, `STATUS.md`
or [`plan.md`](plan.md); the hunk rationale is [`delivery-plan.md`](delivery-plan.md) section 3.

## What the candidate contains

Backend recovery for P03-CR-002 only: an explicit, human-authorized, original-key-proven
way to recover an expired device token.

| Path | Content |
|---|---|
| `apps/api/migrations/0025_p03_device_token_recovery_challenges.sql` | new table, 64-char hash PK, one-pending-per-device partial unique index, expiry index |
| `apps/api/src/app.rs` | the two recovery route registrations |
| `apps/api/src/repositories/devices.rs` | recovery SQL, `CompleteDeviceRecoveryInput` (typed input; the 7-argument form fails `clippy -D warnings`), `DeviceRecoveryChallengeRecord`, challenge deletion on revoke |
| `apps/api/src/repositories/mod.rs` | exports for the two new types |
| `apps/api/src/routes/devices.rs` | `create_recovery_challenge`, `recover_token`; guard abort maps to `409 device_recovery_challenge_invalid` |
| `apps/api/src/security/tenant_audit.rs` | the six recovery SQL classifications only |
| `tests/integration/lumi-account.mjs` | recovery block, credential-store callbacks, vite fallback, JSON report writer |
| `scripts/integration/lumi-agents.mjs` | runs `lumi-account.mjs` and asserts its exact-head report |
| `docs/...` | P03-CR-002, P03-CG addendum, f19 FR-F19-010, schema map (25 migrations, 0025 row), DE2E-INT-02 notes, plan08 follow-on |

## Deliberately excluded (later phases)

Migrations 0026-0028; workspace binding tombstones/rebind (`delete_binding` signature,
`ASSERT_LIVE_BINDING_SQL`, `routes/devices.rs` hunk 5, `projects.rs`, `migration.rs`);
managed-tool claims (`tools.rs` entries); runtime capability toggles (f19 P03-CR-004
paragraph); automation repairs (P06-CR-007 entries in `tenant_audit.rs`, `jobs/`,
`consumers/`); the workspace/adoption block of `lumi-account.mjs`; the Electron and offline
changes in the pair runner; `desktop-account-electron.mjs`; `plan.md`.

## Differences from the index copy (judgement calls to review)

1. `P03-CG.md` and `f19` each carry two near-duplicate recovery paragraphs in the index;
   the candidate keeps the first (fuller) one only.
2. The 0025 schema-map row sits in the migration table after 0024, with measured
   table/index counts (1 / 2 / 0), not as a stray row after the closing prose. The headline
   is the independently measured **final state** after applying all 25 migrations to an
   in-memory SQLite database: `109 tables · 197 indexes · 73 triggers`
   (`recovery-candidate-schema-independent.log`). The index copy's `111 / 200 / 73` equals the
   cumulative sum of the per-migration columns through `0019`, not a final-state count. The
   per-migration columns are CREATE counts, were not re-measured, and sum to 112 / 202 / 73, so
   they do not reconcile with the final state (3 tables, 5 indexes); the candidate map says so
   and does not explain the gap. `security::release_docs` only requires that the map names
   every migration file; it does not check any count.
3. The `runEnv` parameter of the pair runner is omitted: the account run reuses the shared
   `env`, so it would be dead code until the later Electron/offline phase.

## Dependency and gitlink

The pair runner and `lumi-account.mjs` call the client at the pinned gitlink. For
**testing only**, the candidate expects `integrations/lumi-agents` at `2a49525` (PR #39).
The patch deliberately excludes the gitlink change. A Git patch can represent a `160000`
gitlink, but the testing pin must not ship: the final pin has to be the merged, retested
client commit, which is a release-pair step, not this phase. For testing, set it locally with
`git update-index --cacheinfo 160000,2a495254f0018644d24c9c1e5c5210bb7a30075c,integrations/lumi-agents`
(evidence and the archive recipe are in `client-2a49525-manifest.md`, kept beside the patch,
not in the repository). The client calls (`createDeviceRecoveryChallenge`, `recoverDeviceToken`,
`adoptRecoveredToken`, the credential-store constructor argument) exist only from that
client head; this candidate is not coherent against the `fd977fd` pin.

## Unresolved risks (honest list)

- **Compile/clippy/test: not run.** Most likely failures: `security::tenant_audit` (the
  split was done by hand; each of the six classes must match its SQL text; checked by reading
  only) and the compile itself. The Rust is the index/working copy verbatim apart from the
  excluded `delete_binding` hunk and the excluded `tenant_audit` entries.
- `routes/devices.rs` still imports and calls only symbols present at HEAD plus the new
  repository items; a missing one would be a compile error, not a silent change.
- DE2E-INT-02 text records coordinator PASS evidence for 25-migration D1; this candidate has
  not reproduced it.
- Actual Electron recovery UI remains UNPROVEN; only backend/client transport is covered.
- `lumi-account.mjs` writes `control_plane_dirty` from `git status`; in a clean candidate
  checkout it must be false for an exact-head claim.

## Review pass 2 (2026-10-09, static only; still UNPROVEN)

Static review of the exact-parent candidate, no Cargo/Worker/build. Verified by reading source:
every symbol `routes/devices.rs` newly calls exists at `e7ad897` with a matching signature and
import (`new_secret`, `sha256_hex`, `add_seconds`, `verify_device_proof`, `is_guard_abort`
re-exported by `core`, `D1Adapter::changes`, `find_membership`, `latest_min_client_version`,
`refresh_policy_snapshot`, `ScopedMutationCommit::Guarded`); every new `BindValue` count matches
its `?N` placeholders; `INSERT_DEVICE_TOKEN_SQL`/`DELETE_DEVICE_TOKENS_SQL` bind order is reused
unchanged (the "exactly one `DELETE FROM device_tokens`" probe text count stays one); the six
`tenant_audit` classes satisfy the mechanical predicates in
`every_classification_is_true_of_the_statement_it_labels` (`device_id = ?`, `org_id = ?`, org
column on INSERT, `org_id` in the SELECT list, IdChain resolver present); `secret_canary`
matches `SECRET_FIELDS` by exact name, so `challenge_hash` is not flagged and
`RecoverDeviceTokenRequest` derives no `Debug`; the client transport sends and reads exactly the
server keys (`challenge`, `signature`, `app_version` / `challenge`, `expires_at`,
`device_token`, `token_expires_at`, `policy_version`). `release_docs` was read: its only
schema-map requirement is that every migration filename appears, and `0025` does. Not
verified: `bind_correspondence`, `repository_liveness` and the compile itself. The client check read the
original checkout's working-tree client, which is not proof of what `2a49525` contains.

Harness changes made to `tests/integration/lumi-account.mjs` (candidate only):

1. Vacuous `probe.expect(..., true)` after `assert.rejects` replaced by stored-state reads: wrong
   proof leaves the challenge unconsumed and mints no token; expired challenge mints no token;
   replay leaves zero challenges and exactly one live token.
2. Cross-tenant negatives (AGENTS.md requirement): a user of another org gets 404 through their
   own org path and 403/404 through the device's org path, and no challenge row is stored.
3. The client directory honours `LUMI_AGENTS_DIR` exactly as the pair runner does, so the
   recorded `lumi_agents_sha` is the SHA of the client that was built (previously hardcoded).
4. The report writer's git calls are inside a nested `try`, so `probe.cleanup()` always runs and a
   git failure (for example a candidate directory that is not a repository) cannot mask the
   original error.

The coordinator's `make-patch.sh` run picked up the harness edits above (the patch contains
them). The schema-map headline correction and this note's corrections were made afterwards, so
`candidate.patch` and `manifest.txt` are **STALE again** until `make-patch.sh` is rerun (the
implementer's shell cannot run it); the file set is unchanged. The new assertions are
runtime-unproven: the `404` and `403/404` expectations and the `pending`/`live` counts were
derived from handler source, not observed.

## Isolated test tree plan (not executed)

Candidate has no Git history. Build a NEW repository outside the product checkout; never reuse
the product index.

```sh
T=/private/tmp/lumi-recovery-phase-repo
git init -q "$T" && cd "$T"
tar -xf /private/tmp/lumi-recovery-phase-candidate/base.tar            # exact e7ad897 tree
git add -A && git -c user.name=cand -c user.email=cand@example.invalid commit -qm "base e7ad897"
git switch -c codex/p03-token-recovery
git apply -p1 /private/tmp/lumi-recovery-phase-candidate/candidate.patch   # regenerated patch
git update-index --cacheinfo 160000,2a495254f0018644d24c9c1e5c5210bb7a30075c,integrations/lumi-agents
```

Then supply the client as an exact checkout of `2a49525` (a separate clone/worktree of the
client, passed via `LUMI_AGENTS_DIR`; the runner then reports `override: true`, so it is not a
CI-grade pin proof). Required before any runner: Node 24 on `PATH`, pnpm 10.33.2, `pnpm install
--frozen-lockfile` at the root, the client `@zcode/contracts...` install, a root `pnpm build`
(web before API), and the Rust toolchain via the coordinator's wrapper. Gaps found statically:
`base.tar` has no `node_modules`/`test-results`, so the runner's pnpm bootstrap needs network or
a pre-seeded `test-results/pnpm-tools`; the account test builds `hostTransport.ts` and
`deviceTransport.ts`, whose only `@zcode/shared` imports are type-only (erased), so the
`contracts` install is sufficient for these two bundles at the working-tree client.

Record both pins: the testing gitlink `2a49525` (PR #39 draft) and, separately, the final merged
client commit once PR #39 merges. A passing run at `2a49525` does not certify the merged pin.
Stack the phase PR on PR #51 (base `codex/desktop-backend-e2e` at `e7ad897`); no remote push or
PR until the coordinator validates.

## Evidence required before ready

Per `delivery-plan.md` section 3: `cargo fmt --check`, clippy `-D warnings`,
`cargo check --target wasm32-unknown-unknown`, `cargo test --workspace`, `pnpm check`/`build`,
a fresh 25-migration D1, `lumi-account.mjs` exact-head, a fault control for the 409
guard-abort mapping and one for token rotation, then CI `quality` and `adoption`.

## Coordinator review checkpoint — 2026-10-09

The recovery-only tree was independently applied to a separate clone at parent
`e7ad897a7f400048df17100594ef86b3788ea0f1`; unrelated later-phase work was excluded.
Format, lint, types, unit/schema/guard checks, Rust clippy/WASM and web/Worker dry-run
passed on that candidate. A fresh 25-migration Worker/D1 run using the exact clean
client `2a495254f0018644d24c9c1e5c5210bb7a30075c` passed recovery proof, expiry,
replay and cross-tenant stored-state controls. That first run was on an uncommitted
server candidate and is not exact committed-head certification; the frozen commit
must be replayed and checked in CI. These are SDK/HTTP results, not Electron recovery
UI or full A–E completion. The phase testing gitlink names the published client
phase head; a final release pin still must identify the merged, retested client.
