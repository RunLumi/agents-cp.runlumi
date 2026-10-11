# Supervisor review of credential persistence handoff

2026-10-09. Current dirty candidate; runtime persistence replay remains UNPROVEN.

Source now queues a version-guarded UPDATE for a mode-only change and stores its
full projected response. Same-mode no-op queues no event/audit/outbox. Independent
cargo fmt check found three formatting hunks; file-only rustfmt with existing
RUSTUP_HOME completed successfully. No Worker build or runtime executed while
another primary Claude edits backend race handling.

## Remaining response race

`advance_adoption_stage` stores `binding_json(projected)` in the idempotency
transaction, then awaits `find_by_id` and returns that newer row when present.
A concurrent successful mutation between commit and this read can make the first
response describe version N+1 while replay describes N. The CR requires the first
response and replay to match. This is a source-supported race hypothesis, not a
runtime-proven failure. A valid regression should hold the post-commit read,
perform a second guarded write, then compare first response/replay/current GET:
first and replay must equal the first committed version; GET may be newer.
Primary implementer should return the committed response projection (or exact
stored success) and reserve independent GET/D1 reads for verification; do not
weaken CAS, transaction semantics, or compare assertions to the latest row.

Also review stale same-mode requests and applied-transition replay, retain original
persistence FAIL evidence, run the existing Worker/D1 reproducer, and demonstrate
that dropping the actual mode-only UPDATE is detected after its positive control.
