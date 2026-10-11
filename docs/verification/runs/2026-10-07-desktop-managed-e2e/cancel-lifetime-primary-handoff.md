# Cancellation settlement lifetime: primary handoff (2026-10-09)

Status: **source change made; root cause NOT proven; no runtime proof.** No Worker
build, Electron or Node probe was run. Contract: [P04-CR-004](../../../implementation/change-requests/P04-CR-004.md)
(proposed, coordinator decision pending). This handoff originally cited P04-CR-003, whose ID
already belonged to the provider-redirect decision; the lifetime proposal was moved to
P04-CR-004. The Rust comments in `app.rs` and `adapters/execution.rs` still say P04-CR-003
and must be corrected by the Rust owner.

## Update 2026-10-09 (root-cause continuation; supervisor owns the WASM build and replay)

Status: **first hypothesis falsified by the supervisor's replay; second hypothesis (H2)
implemented as a candidate, native tests only; no runtime proof.** Supervisor facts: node
probe 63673 exit 2, D1 `stream_committed` with the reservation held 90 s, upstream socket
closed ~84 ms after the cut, no `inference_cancel_finalize` line of any kind. The original
`test-results/cancel-lifetime-node-runtime.log` is not in this worktree and was not read.

What reading the installed `worker 0.8.6` and `wasm-streams 0.6.0` showed: the response is
Rust stream -> JS stream A -> `worker::Body` (`IntoStream`, cancel-on-drop) -> axum body ->
`BodyStream` -> JS stream B. The cancellation guard only drops after two chained
abort-and-wake steps, each needing a live execution context. The 20 s deadline also never
settled in 90 s, so the pull future was neither running nor dropped. H2: the disconnect ends
the context first, and `wait_until` registered inside the late callbacks cannot help.

Changed (Rust owner scope: execution port, inference route; `lib.rs` untouched this round):

| Path | Change |
|---|---|
| `apps/api/src/adapters/execution.rs` | `BackgroundWork::hold()` (request lifetime registered at stream start, released when the stream state drops, no timer); `LatchClaim` (latch released when a claim is dropped unfinished); `PullScope`/`StreamClock` and bounded `inference_stream_trace:*` lines; 8 native tests with real futures |
| `apps/api/src/routes/inference.rs` | `StreamState` holds the `Hold` (declared last) and a pull counter; pulls are scoped; guard, abort listener and `armed` trace; `finalize_request_once` uses `LatchClaim` and traces `inline:{start,ok,err}` |
| `docs/implementation/change-requests/P04-CR-004.md` | Revision with H2, candidate change, and the outcome table that falsifies it |

Checks run (native only): `cargo test -p lumi-agents-control-plane-api --lib adapters::execution`
8/8; `cargo clippy -p ... --lib --tests -- -D warnings` and `cargo fmt --all -- --check` clean.
`cargo check --target wasm32-unknown-unknown` was **not** run (supervisor). The new trace
lines are `cfg(wasm32)` code paths, so the WASM build is the first compile of them.

Replay: read the table in P04-CR-004. First confirm `armed:*` and `hold:registered`
appear; without them nothing else is interpretable.

Left alone, outside the allowed write surface: the comment in `app.rs:39` still says
P04-CR-003 and should say P04-CR-004; `STATUS.md`, adapter probes, clients and CI untouched.

## Evidence gap

`test-results/cancel-settlement-source-review.md` and
`test-results/provider-node-unshimmed-runtime.log` do not exist in this worktree
(they live in the supervisor's checkout). The facts below come from
`provider-http-platform-handoff.md` and `DE2E-INT-05.md`: socket closed ~85 ms after
the cut, D1 `stream_committed` / reserved for 90 s, full-read control completed
with held=0, and the `mock://` "cut" at 21585 ms was a timeout.

## Source facts (verified by reading, not by running)

- `StreamCancellationGuard::drop` and the abort listener latched `finalized`, then
  `spawn_local`ed the D1 write and discarded its `Result`.
- `lib.rs::fetch` ignored its `Context`, so nothing was registered with `wait_until`.
- Consequence if the runtime cancels unregistered work after the client is gone:
  no write, no log, and the latch blocks the other settlement paths.

## Change

| Path | Change |
|---|---|
| `apps/api/src/adapters/execution.rs` (new) | `BackgroundWork` port over `Context::wait_until`; `schedule_cancel_settlement` (latch, release on failure, bounded trace `inference_cancel_finalize:scheduled\|ok\|err:<code>`); 3 native tests |
| `apps/api/src/adapters/mod.rs` | `pub(crate) mod execution` |
| `apps/api/src/lib.rs` | `fetch` passes `ctx` into `app::router` |
| `apps/api/src/app.rs` | `router(env, background)`; `AppState.background` |
| `apps/api/src/routes/inference.rs` | guard, abort listener and `make_stream` use the port; `spawn_local` import removed; `cancel_settlement` maps errors to a stable code |
| `docs/implementation/change-requests/P04-CR-004.md` | CR (proposed; was mis-numbered P04-CR-003) |

Unchanged: `finalize_request` CAS once-only state/usage/reservation, stale-flag
no-retry, auth, egress, budget. No globals, no Tokio.

## Checks run (source only, native)

- `cargo test -p lumi-agents-control-plane-api --lib adapters::execution`: 3/3 pass.
  These prove latch/release logic, not the runtime.
- `cargo clippy -p ... --lib --tests -- -D warnings` and `cargo fmt --check`: clean.
- `cargo check --target wasm32-unknown-unknown`: **not run**. The default toolchain
  has no wasm target and the pinned `RUSTUP_HOME`/`CARGO_HOME` env was not approved
  in this session. Owed.

## Owed at the coordinator window

1. WASM compile with the pinned toolchain env, then a fresh Worker build.
2. Replay the unshimmed Node cancel probe; read `inference_cancel_finalize` lines.
   - `scheduled` then `ok`, held=0 within seconds: lifetime cause confirmed.
   - `scheduled` then `err:<code>`: the write itself fails; fix that code.
   - `scheduled` and nothing else: the task is still cancelled; `wait_until`
     is insufficient and the hypothesis is falsified. Next: Durable Object or Queue.
   - No `scheduled`: the abort event / Drop never fires in workerd; the cause is
     upstream of this code (topology or workers-rs body drop).
3. Sensitivity: revert the `BackgroundWork` call to `spawn_local` in a disposable
   worktree and show the probe fails for that reason.
4. Open risk: `Context::wait_until` `.unwrap()`s a JS error. If workerd rejects
   `waitUntil` after the request is torn down, it would panic inside `Drop`. The
   trace will show this; do not rely on it silently.
