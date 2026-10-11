# Credential persistence primary handoff (P08-CR-003 response seam)

2026-10-09. Author: Claude (bounded primary). Status: **source edited, nothing
compiled or run.** No Worker build, cargo, Electron or runtime was started. No index,
branch, STATUS, commit or push change. Runtime persistence/replay stays UNPROVEN until
the coordinator runs the reproducer.

## Defect addressed

Review finding: `advance_adoption_stage` stored `binding_json(projected)` in the
idempotency transaction, then re-read the row with `find_by_id` and returned it. A
concurrent successful mutation between commit and that read made the first response
describe version N+1 while a replay of the same key returned N. This is a
source-supported race hypothesis, not a runtime-proven failure.

## Change (`apps/api/src/routes/migration.rs`, PATCH seam only)

- The route builds `StoredSuccess` from the committed projection, keeps
  `committed = success.clone()`, passes `success` to `commit_mutation`, and on a clean
  commit answers `replay_response(committed)`. The post-commit `find_by_id` read is
  removed. First response and any replay are the same stored value through the same
  serializer.
- Unchanged: version guard leading the batch (compare-and-set), authorization,
  CSRF, idempotency claim/replay, `credential_mode_permitted`, event/audit/outbox shape
  (D-a, D-b), rollback, create, stage 5 denial. `repository` and `StatusCode` remain
  used elsewhere.
- Comment-only: `CredentialMode::MetadataOnly` doc comment
  (`modules/migration/adoption.rs`) said the control plane holds a provider identifier
  and fingerprint. CR-003 and the P08-CG addendum already label it a label only, and no
  code stores either, so the comment now says that. No behavior change.
- Docs: `P08-CR-003.md` response-contract text updated to "committed projection, not
  re-read".

## Update: joined runtime 10777 (FAIL 59/61) and the replay-ordering fix

Coordinator run 10777 failed exactly two assertions, both in `late-replay`
(`credential-persistence-joined-runtime.log` lines 44-45): the late replay answered
`409 migration_stage_invalid` instead of 200, so the body assertion saw `late=undefined`.
All 59 other assertions, including the original 61-assertion set's persistence, replay,
chain, no-op and negative checks, passed. Cause (read from source): `advance_adoption_stage`
ran `apply_stage` against the **current** stage before `prepare_mutation`'s replay lookup,
so a request that had already committed was judged against today's row. The reproducer
was right; no assertion was changed.

Fix (`routes/migration.rs`, credential PATCH only), new order:

1. authorization, CSRF, version validation, idempotency key, input parsing (unchanged);
2. `require_record` for the path organization (tenant scope, 404 otherwise);
3. `prepare_mutation`: completed replay, key/body fingerprint conflict and in-flight
   twin are decided here, before any check against the mutable stage. It writes nothing:
   the claim is only a prepared statement that joins the commit batch, so a request
   refused after this point leaves **no orphan claim**;
4. explicit fence: `record.version != body.version` -> `409 conflict`. The mode/stage
   projection and the no-op response are derived from this read, so a guessed future
   version can no longer become valid through a concurrent writer;
5. `apply_stage`, the version-guarded commit batch (compare-and-set unchanged), and the
   committed-projection response.

The fingerprint input now also carries `adoption_state_id`, because the scope path is a
template: the same key and body sent to a different record now conflicts instead of
replaying another record's response. This changes the fingerprint of in-flight keys only
(24 h TTL). It is the one addition beyond the ordering fix; revert it if the coordinator
prefers to keep the fingerprint byte-identical.

New reproducer negative: `a future-version PATCH is refused` (`version + 1` of the row ->
`409` / `conflict`, D1 and event count untouched). Not covered at runtime: the cross-record
same key/body conflict, and the in-flight race (needs a commit-path hook). The ordering
itself has no unit test: it lives in the async route, and a source-order assertion would
not be runtime proof, so `late-replay` is the proof.

Re-run `node apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs`; expect `late-replay`
to pass and the count to rise by the future-version pair. Nothing was built or run here.

## Tests (exact)

Rust, `apps/api/src/routes/migration.rs` `mod tests` (not executed):

- `a_mode_only_change_writes_the_current_stage_with_the_new_mode`
- `a_same_mode_reassertion_writes_nothing`
- `a_stage_step_writes_the_target_stage_ownership_and_mode`
- `the_projection_of_a_write_moves_only_the_version_and_the_timestamp`
- `the_first_response_is_the_committed_projection_even_when_a_newer_row_exists`:
  serves the stored success through `replay_response` twice, reads both bodies with
  `axum::body::to_bytes`, asserts identical status and bytes, version 3 and the
  committed mode, and that a constructed newer (version 4) row does not appear in it.
  Behavioral on the response bytes. **Limit:** it cannot inject a writer between the
  commit and the former read, because that needs a hook in the D1 commit path. It pins
  that the first response is produced from the stored value and not from a row read;
  the removal of the read itself is the structural fix.

Worker/D1 reproducer `apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs`
(not executed; run by the coordinator; do not start a second Worker on its port):

- new `late-replay` stage: after the chained advance (version 4), replay the original
  mode-only key. Must equal the first response with version 3 while the binding list
  and D1 show the newer version. This is the runtime half of "replay stable, GET may be
  newer".
- new stale same-mode negative: same stage and same stored mode at `version - 1` must
  be `409` / `conflict`, D1 and event count untouched.
- earlier corrections retained: stale reason is `conflict`, not `version_conflict`.

Commands for the coordinator: `cargo fmt --check`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo test --workspace` (focus
`routes::migration::tests`), `cargo check --workspace --target wasm32-unknown-unknown`,
then `node apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs`.

## Mutation to run

- Drop the `advance_statement` push in the mode-change path: PERSISTED must fail after
  its positive control.
- Re-introduce a post-commit `find_by_id` response: no test above can detect it
  without a commit-path hook (see Limit). Reviewer, not a runtime proof.

## Residual and unproven

- The future-version residual from the earlier draft is closed by the explicit
  `record.version != body.version` fence (see the update above); unproven at runtime
  until the re-run.
- Rollback has its own pre-existing first-versus-replay shape difference; intentionally
  untouched.
- No file hashes recorded: `shasum` / `git hash-object` need approval in this session.
- Formatting unchecked; a prior supervisor rustfmt pass exists and my edits since are
  unformatted.
