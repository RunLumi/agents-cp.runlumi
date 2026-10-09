# CI adoption `UND_ERR_SOCKET` handoff

Scope: PR52 `LumiAgents integration / adoption` job, `tests/integration/lumi-account.mjs`.
Checkout: `/private/tmp/lumi-recovery-review-repo`, branch `codex/e2e-phase01-recovery`, base `4f730a5`.
Nothing here is committed, staged, pushed, or deployed.

## Verdict

**Root cause: NOT ESTABLISHED. Verdict for the failure: UNPROVEN.**

No fix was applied, because every candidate fix I could write would have been a guess. Applying one and
seeing green would hide the cause instead of finding it. What changed is that the next CI failure, or
the next CI pass, now produces evidence that separates the live hypotheses. See "Next CI run".

## What the two failed runs establish

Sources: `test-results/recovery-phase-ci-adoption-fail.log` (attempt 1) and `...-attempt2-fail.log`
(attempt 2). Both ran the same code. The log's `control_plane.sha` is `b36de94`, which is the PR merge
commit rather than the `4f730a5` branch head.

| Fact | Attempt 1 | Attempt 2 |
| --- | --- | --- |
| Failing process | `lumi-account.mjs` (second Worker) | `lumi-account.mjs` (second Worker) |
| `adoption.mjs` (first Worker, also interleaves wrangler D1 reads with requests) | passed | passed |
| Last PASS before failure | `challenge expiry is stored in D1` 03:57:05.888 | `expired recovery challenge mints no token` 04:05:43.683 |
| Failure | 03:57:05.946 (58 ms later) | 04:05:43.749 (66 ms later) |
| Failing request | line 269, `recoverDeviceToken` expecting 409 (stack names it) | line 286 or 288: no stack in the log, so not identifiable |
| Worker age at failure | ~6.2 s after healthy | ~10.9 s after healthy |
| Socket `bytesWritten` / `bytesRead` | 2133 / 1603 | 12828 / 9826 |
| `remoteAddress` on the socket | `undefined` | `undefined` |
| Error | `fetch failed` / `SocketError: other side closed` / `UND_ERR_SOCKET` | same |

Established by reading the logs and code:

1. Each failure was the **first HTTP request after a `probe.d1Rows` call**. `d1Rows` runs
   `runWrangler`, which is `spawnSync` and blocks this process's event loop for ~0.7–2.5 s.
   Earlier requests after the same pattern passed in both runs, so "after a D1 probe" is necessary
   to the pattern but not sufficient to explain it.
2. The socket counters differ by about 6x. So the failing sockets were **different members of the
   undici pool**, and both had carried earlier requests (neither is a fresh connection).
3. The Worker had answered every earlier request. Nothing in the log shows the Worker's state at the
   moment of failure, because `lumi-account.mjs` went to `finally` -> `probe.cleanup()`, which kills the
   Worker, and printed no Worker log. **There was no liveness, stderr, or request-boundary evidence.**
   That is the gap this change closes.
4. `LumiAccountHostTransport.#request` (`integrations/lumi-agents/.../hostTransport.ts:83-86`) throws on
   a non-OK status **without consuming or cancelling the response body**. `probe.request` always reads
   it. This is a fact about the client code. Whether it matters here is unproven. The submodule is
   pinned, so I did not touch it.

## What I tried and what it showed

`/private/tmp/lumi-socket-repro/repro.mjs` (outside the repo, throwaway): a Node HTTP server in a
**separate process** with a 1 s idle keep-alive timeout, and a client doing `fetch`, then a 1.6 s
`spawnSync` block (or an async wait as control), then `fetch` again, 20 rounds.

| Mode | Failures |
| --- | --- |
| `spawnSync` block longer than server idle timeout | 0 / 20 |
| async wait of the same length | 0 / 20 |

This reproduces nothing and agrees with the earlier minimal-control result. It does **not** exclude the
stale-socket hypothesis: it ran on Node 22.14 (CI is 24.21), with a single pooled socket, against a
Node server instead of workerd. I also could not run the real Worker locally: `worker-build` is not
installed here and building needs approval, and the client's `node_modules` are absent. The full
`lumi-account.mjs` flow has therefore **not** been run by me at all.

## Open hypotheses and what separates them

| Id | Hypothesis | Evidence that supports it | Evidence that refutes it |
| --- | --- | --- | --- |
| H1 | A pooled socket idle across a `spawnSync` block was closed by the Worker side, and undici reused it | failing entry has `socket.bytesWritten > 0`, large `blockedInIdleMs`, large `idleBeforeMs`; fresh Worker health is OK; **passes with `fresh_sockets`** | fails identically with `fresh_sockets` |
| H2 | `wrangler dev`/workerd reloaded or crashed mid-run | `wrangler_pid_alive` false, a non-null exit code/signal, or reload/restart text in the console tail; fresh health fails. `process_group.members` is corroboration only (see below) | wrangler alive, no exit/signal, no restart text, fresh health OK |

`process_group` lists what `ps -g <pid>` returns. That is **session members on Linux procps** (equal to
the pid only because the Worker is spawned `detached`), something else on BSD/macOS, and
`available: false` with a `reason` when `ps` is missing, times out or exits non-zero. Neither
`available: false` nor a short or empty `members` list is evidence of a crash; the field says what was
asked and nothing more. A crash claim needs `wrangler_pid_alive`, the exit code/signal or the console.
| H3 | The Worker aborted that one request (wasm trap or panic) | console tail has `panicked`, `unreachable`, `RuntimeError`; fresh health OK; fails with `fresh_sockets` on the same route | no such console line |
| H4 | `wrangler d1 execute --persist-to` on the live Worker's SQLite files interferes with it | first request after the UPDATE fails; console has `SQLITE`/`database is locked`-type lines | failure not tied to the request right after an UPDATE |

Nothing in hand ranks these. I will not call H1 the cause: the earlier control and mine both failed to
reproduce it.

## What changed (observation only; no assertion weakened, nothing retried)

- `apps/api/scripts/lib/request-boundary.mjs` (new). `RequestBoundaryRecorder` wraps `globalThis.fetch`
  and keeps a ring of the last 64 requests: method, **path only** (no query/body/headers), duration,
  status or error `causeCode`, undici socket counters, idle gap before the request, and how much of
  that gap was spent blocked in `spawnSync`. It also tracks event-loop delay. `workerLiveness` reports
  wrangler pid/exit/signal, the process group (best-effort `ps -g <pid>`; the Worker is spawned `detached`, so on Linux its pid is its session id), a single read-only `GET /api/health` on a fresh
  `Connection: close` connection, and a redacted tail of the Worker's own output and console. It never
  replays the failed request.
- `apps/api/scripts/lib/smoke-harness.mjs`: `runWrangler` reports its blocking time to the recorder;
  new `attachBoundaryRecorder()` and `captureFailureEvidence(error)`. The recorder is off unless
  attached, so other probes are unaffected.
- `tests/integration/lumi-account.mjs`: attaches the recorder before the transports are constructed
  (they bind `fetch` at construction), and on any exception captures evidence **before** `finally`
  kills the Worker, prints it to stderr, stores it as `failure_evidence` in the account report, and
  **rethrows the original error**.
- `.github/workflows/lumi-agents-integration.yml`: the step summary now also publishes
  `account-report.json`, which `lumi-agents.mjs` writes to the same output dir but the `find` never
  matched. `workflow_dispatch` gains a `fresh_sockets` boolean that sets `LUMI_PROBE_FRESH_SOCKETS=1`,
  which makes the recorder send `Connection: close`. It is a diagnostic switch, **not a repair**, and
  defaults to off.
- **Redaction.** The only free text the recorder stores is a thrown error's `message`, its cause's
  `message` and `code`, and the health-probe error. Each goes through `sanitize`: URL query/fragment is
  stripped first (a registered-secret redactor cannot know an unregistered query value), then the
  harness's `redact` runs, then the length is bounded, in that order so truncation cannot leave a
  secret prefix the redactor no longer recognises. `attachBoundaryRecorder` passes the harness
  `redact`. Request paths exclude the query by construction. The original error object is rethrown
  untouched and nothing is retried (tested: one attempt, `error === thrown`).
- `apps/api/scripts/request-boundary.test.mjs` (new) + `test:request-boundary` in root `package.json`
  and the `test` script, run as `node --test --test-timeout=15000`. Setup is bounded: `listen` has an
  error handler and a 5 s timeout, so missing loopback privileges fail with the cause instead of
  hanging at zero output. 8 tests: status/path redaction; a server that destroys the socket mid-request
  yields `UND_ERR_SOCKET` with socket counters and still throws; a canary test where the thrown error
  and its cause carry a registered secret (`SECRETCANARY`) and unregistered query values
  (`QUERYCANARY`) and neither may appear in the snapshot; health-probe error redaction; an unavailable
  `ps` is reported as unavailable; block attribution; the A/B header; a dead Worker does not throw.
- Mutation check of the canary test: replacing `sanitize` with a plain truncation fails exactly the
  canary test (7 pass / 1 fail), restored source passes 8/8. Mutating `listen` to an unassignable
  address fails every test fast with `cannot listen on 127.0.0.1 (EADDRNOTAVAIL)`; also restored.

## Verification performed

| Check | Result |
| --- | --- |
| `node --test --test-timeout=15000 apps/api/scripts/request-boundary.test.mjs` | 8 / 8 pass (Node 22.14, local); supervisor reported PASS on Node 24 for the earlier 5-test version, **not re-run on Node 24 for the 8-test version** |
| `node --check` on the module, test, `smoke-harness.mjs`, `lumi-account.mjs` | OK |
| `oxfmt --check`, `oxlint`, `pnpm check` | **NOT RUN by me** (approval required); I hand-wrapped lines over the width. Supervisor's scoped lint reported only the existing `smoke-harness.mjs` ~line 550 spread warning; I did not touch that line or reformat unrelated code. |
| `lumi-account.mjs` end to end, locally | **NOT RUN** (no `worker-build`, no client deps) |
| Real failure-path output on a failing CI run | **UNPROVEN**: only exercised by unit tests |
| Fresh-socket A/B on CI | **UNPROVEN**: needs a push |

The failure-path capture in `lumi-account.mjs` has only been syntax-checked. Its first real exercise
will be the next CI failure, and a bug there would show up as `capture_failed` in the evidence, not as a
masked original error.

## Next CI run (needs someone with push rights; I did not push)

1. Run the workflow on the published head. No fixed number of runs is required: the next failure
   carries `failure_evidence`, which may already discriminate. Use the `fresh_sockets` `workflow_dispatch`
   input only if that evidence points at H1 and a paired run would help, then adapt. One green run of
   either arm proves nothing about an intermittent failure.
2. On a failure, read `failure_evidence` in the step summary / stderr:
   - `liveness.wrangler_pid_alive` false, or restart text in `worker_console_tail` -> **H2**.
   - `fresh_connection_health.ok` true, failing entry `socket.bytesWritten > 0`, large
     `blockedInIdleMs` / `idleBeforeMs`, and green when `fresh_sockets` is on -> **H1**.
   - `panicked` / `unreachable` in the console, fails with `fresh_sockets` on -> **H3**.
   - `SQLITE`/lock lines on the request right after a wrangler UPDATE -> **H4**.
3. Only then choose a fix. If H1 holds, the proportionate repair is to stop blocking the loop:
   run `runWrangler`/`d1Rows` through async `spawn` so undici services its sockets. It would be a
   harness change with no assertion change. If H2-H4 hold, the defect is in the Worker/wrangler
   interaction and belongs with the backend owner. None of these should be applied before the evidence
   picks one.

## Not done, on purpose

- No speculative mitigation (retry, longer timeouts, keep-alive tuning, async `spawn`). A retry of a
  mutating recovery request would also break the single-use challenge semantics the test asserts.
- No change to the submodule, the product routes, or any assertion.
- No commit, index, branch, STATUS, push, or deploy change.
- Scratch reproducer left at `/private/tmp/lumi-socket-repro/repro.mjs`; it is outside the repo.

## Independent coordinator verification

2026-10-09: Node24 bounded suite PASS8/8, scoped format and diff-check PASS.
Required format/web lint/types/tests/schema/canary/guard passed; clippy was
interrupted by ENOSPC. Moved only this review clone's generated target to SSD;
rerun clippy and WASM check PASS. Original interrupted quality log preserved.
These local checks certify diagnostics candidate behavior only; hosted socket
root cause and real failure-path liveness capture remain UNPROVEN.
