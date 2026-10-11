# CI adoption `UND_ERR_SOCKET` handoff

Scope: PR52 `LumiAgents integration / adoption` job, `tests/integration/lumi-account.mjs`.
Checkout: `/private/tmp/lumi-recovery-review-repo`, branch `codex/e2e-phase01-recovery`, base `4f730a5`.
Nothing here is committed, staged, pushed, or deployed.

## Verdict

**Root cause: NOT ESTABLISHED. Verdict for the failure: UNPROVEN. Default-gate repair: APPLIED IN THE
REVIEW CLONE, UNVERIFIED against the failing configuration. The CI root is not fixed until the default
hosted run passes on the published head; nothing here claims otherwise.**

The account probe now runs its wrangler D1 calls asynchronously by default. It is a harness repair for
one candidate trigger, chosen because it removes the only thing this probe does that an ordinary client
does not (stop servicing sockets for 1-4 s at a time). It has **not** been shown to fix the failure:
nothing runs the real Worker locally here, and the failure has not been reproduced outside hosted CI.
Confidence limits are in "Cause confidence". The failing logs and the blocking configuration are kept
(`sync_d1` / `LUMI_PROBE_SYNC_D1=1`) so the failure can be reproduced on purpose.

### Cause confidence

| Claim | Basis | Confidence |
| --- | --- | --- |
| The failing connection was a reused pooled socket | socket carried 12828 bytes before the failing request; **same head with `Connection: close` on every request (run 37888310239) passed, including recovery and logout, while the default run 37887744833 failed** | Fairly high: 3 default failures at the same point vs 1 fresh-socket pass. n=1 for the pass, and the failure is intermittent in principle |
| The Worker or wrangler crashed or restarted | wrangler alive, no exit/signal, workerd age ~ time since startup, fresh health 200 | Low: not supported |
| The socket died because it idled too long across a blocking call | seq 28 had the identical idle and survived; seq 18/30 survived ~3x longer idles | **Not supported as a simple idle-duration story.** Still possible if requests used different pool sockets (unmeasured before 787903e) |
| Unconsumed non-OK bodies in the pinned client are the cause | source fact only; local Node 22 control showed no extra connections | Not supported; not cleared on Node 24/workerd |
| The async D1 path fixes it | it removes the loop block; mechanism not demonstrated | **Unknown until a default hosted run on the published head** |

The fresh-socket pass shows reuse is part of the failing condition. It does not show why a reused socket
was dead, or that blocking the loop is the reason. The async path is a bet on the one difference between
this probe and an ordinary client; if it still fails, the evidence will say so (see below).

## Update: hosted diagnostics run 37887744833 (head `787903e`)

Sources: `test-results/ci52-diagnostics-hosted-fail.log` (raw) and
`ci52-diagnostics-hosted-failure-summary.json`. The same-head `fresh_sockets=1` dispatch `37888310239`
was reported SUCCESS (actual recovery and logout PASS) and quality `37887744748` SUCCESS with deploy
skipped; those outcomes come from the coordinator, I did not read the runs. The sections below were
written before that result was relayed and rest only on the failed run's own evidence.

### Measured (read directly from the evidence)

- The failing request is `seq 31`: `POST .../recovery-challenges`, the 31st request the recorder saw.
  It failed **2 ms** after it started with `SocketError: other side closed` (`UND_ERR_SOCKET`) on local
  port 55276, `bytesWritten` 12828, `bytesRead` 9829. The socket had therefore carried earlier requests.
- Its idle gap was **1277 ms, all of it inside the wrangler D1 read** `state after expired challenge`
  (`blockedInIdleMs` 1277). No request was in flight at any point (`concurrentInFlight` 0 on all 24
  recorded entries, seq 8-31).
- **The same idle succeeded elsewhere in the same run.** Idle / blocked / outcome:

  | seq | route | idle ms | blocked ms | result |
  | --- | --- | --- | --- | --- |
  | 18 | `GET /devices/token/nonce` | 3803 | 3801 | 401, as asserted |
  | 28 | `POST .../recovery-challenges` | 1277 | 1276 | 201 |
  | 30 | `POST .../recover-token` | 3814 | 3813 | 409, as asserted |
  | 31 | `POST .../recovery-challenges` | 1277 | 1277 | **socket closed** |

- Liveness at failure: wrangler pid alive, exit code and signal null; `ps` listed 5 session members
  (wrangler, one child, esbuild, two workerd); workerd/esbuild age 00:11 vs wrangler 00:35; a fresh
  `GET /api/health` connection returned 200 in 12 ms. Event-loop max 3821 ms, which is explained by the
  3813 ms synchronous block, so it is not independent evidence of anything.
- Across runs: attempt 2 and this hosted run have identical `bytesWritten` (12828) and `bytesRead`
  within 3 bytes (9826 / 9829), and both stopped right after the PASS line
  `expired recovery challenge mints no token`. Attempt 1 failed elsewhere (the `recover-token` request
  after the 403, on a socket with `bytesWritten` 2133). In this hosted run that same request, seq 30,
  passed.

### Inference (not proven)

- Supported: the failed connection was a reused pooled socket; the Worker and wrangler were alive and
  accepted a new connection immediately afterwards. A Worker crash or restart is **not** supported:
  wrangler alive, no exit or signal, and workerd age is consistent with no restart since startup.
- **Not supported by this data: a simple "idle too long across a synchronous block" mechanism.** Seq 28
  had the same idle as the failing request and survived, and seq 18 and 30 survived idles about three
  times longer. A server idle timeout shorter than 1.3 s would also have to spare seq 28. It stays
  possible if seq 28 used a different pooled socket than seq 31, but nothing recorded so far can say.
- The failing request in two of three runs follows a `recover-token` response (a 409 in attempt 2 and in
  this run, a 403 in attempt 1). That is a pattern worth recording, not a cause; seq 29's 403 was followed
  by a passing request here.
- The cause remains **UNPROVEN**.

### New evidence the next failure will carry

`request-boundary.mjs` now also records, per request: the local port of the socket that carried it,
how many recorded requests that socket had carried before, the socket's byte counters before send, and
the response's `Connection` / `Keep-Alive` headers; and for the run: every connection opened, and
requests per local port. It reads undici's own diagnostics channels
(`undici:client:connected`, `undici:client:sendHeaders`), and reports `send_events_seen` /
`opened_total` so that "the channel reported nothing" is distinguishable from "nothing happened".
That answers directly: did seq 31 reuse a socket, was it the same socket seq 28 and 30 used, how many
sockets the pool held, and did the server announce a close in an earlier response. Also recorded:
`d1_subprocess_mode`. Verified only against a local server on Node 22; **not yet seen on hosted Node 24**.

### Alternative reviewed: the pinned client leaves non-OK bodies unconsumed

`hostTransport.ts:83-86` throws on `!response.ok` without reading or cancelling the body (fact, read from
source). Measured locally on Node 22.14 (`/private/tmp/lumi-socket-repro/unconsumed.mjs`): 12 pairs of a
409 whose body is dropped followed by a 200, 2 server connections for 24 requests; the control that reads
every body: also 2. So a small unread body did **not** by itself multiply connections there. That says
nothing about Node 24 or workerd, so it neither clears nor convicts the client. The newer client
candidate was modified outside my scope; I did not review or edit it, and did not touch the gitlink or
the submodule, and nothing here hides the issue.

### Default-gate repair: async D1 subprocess path (the account probe's default)

`runWranglerAsync`, `useAsyncSubprocesses`, `d1Execute` in `smoke-harness.mjs`. `runWrangler` is
unchanged and synchronous, so every other probe is unaffected; `d1Rows` is already async and switches
only for a probe that opted in. The async path uses the same binary, cwd, env, error text and redaction,
adds a 120 s timeout (a wedged wrangler fails instead of hanging; the timeout resolves without waiting
for pipe close), and the account probe's two UPDATEs call `d1Execute` with the same SQL and labels.

`lumi-account.mjs` now opts in by default (`useAsyncSubprocesses(LUMI_PROBE_SYNC_D1 !== "1")`). The
old blocking behaviour stays one switch away: `LUMI_PROBE_SYNC_D1=1`, or the `sync_d1` dispatch input
(it replaces the earlier `async_d1`, which this inverts). Using it reproduces the failing configuration on
purpose; it is not a fix. A source-level test fails if the default is flipped back or the probe calls the
blocking helper again.

The recorder separates the two kinds of gap: async subprocess time is recorded as non-blocking
(`recent_blocks[].blocking: false`, `subprocessInIdleMs`) and is **not** counted as `blockedInIdleMs`. So a
failure under the async default will show `blockedInIdleMs: 0` with the gap still explained, and that
would refute "a blocked loop made the socket stale". The per-request socket identity (port, prior
requests on that socket, response `Connection` header) then shows whether the dead socket was reused and
what the server last said about it.

#### Subprocess lifecycle (supervisor review finding, fixed)

The first async version resolved a timeout right after `child.kill("SIGKILL")`, which kills only the
direct child. A descendant that inherited the pipes (wrangler spawns workerd and esbuild) could keep
running, hold the pipes, keep Node alive and keep writing to the probe's local D1 after the probe had
reported failure. It also summed decoded UTF-16 string length with raw chunk bytes, so the "64 MiB" budget
was not a byte count. Both are fixed in `apps/api/scripts/lib/owned-subprocess.mjs`, which
`runWranglerAsync` now wraps (arguments, env, redaction and the normal error text are unchanged):

- **POSIX:** the child is spawned `detached` (own session and process group). Every stop (timeout,
  overflow, or a survivor after a normal exit) is a SIGKILL to that whole group through
  `SmokeHarness.killTree`, the same owned-process-group pattern the Worker uses; the helper never signals
  by name, never `pkill`s, and never touches a process it did not spawn. Then it **polls until the group
  is gone**, bounded by `reapMs` (default 2 s). Pipes are destroyed on timeout and overflow.
- If the group cannot be confirmed stopped, the error says so (`; the owned process tree could not be
  confirmed stopped within Nms`) and the call still returns in bounded time. Nothing claims a stop that
  was not observed.
- **Windows: unsupported.** There are no process groups here, so only the direct child is killed and the
  tree cannot be confirmed; the error says `descendant cleanup is unsupported on this platform`. The
  integration probes run on Linux/macOS. This is a stated limit, not a tested behaviour: the Windows
  case has one test that is **skipped on this machine** (it is `# SKIP` here, so it has never run).
- **Bytes:** one raw-byte counter over stdout and stderr together (not per stream, unlike `spawnSync`'s
  `maxBuffer`), limit 64 MiB by default; decoding happens once at the end, so split multi-byte characters
  are neither miscounted nor mangled.
- Spawning detached means a Ctrl-C to the parent no longer reaches these wrangler runs directly; the group
  kill on timeout or exit of the call covers them, and the Worker already works this way.

Tests (all local, Node 22.14, fake `wrangler`, nothing is run against a real Worker; every process
involved was spawned by the test and found by the pid its fixture recorded):

| Test | What it proves |
| --- | --- |
| CONTROL: killing only the direct child leaves a pipe-holding grandchild writing | the fixture reproduces the **old defect** (heartbeat keeps growing after `child.kill`), so the next tests are able to fail |
| timeout stops the whole owned tree | grandchild pid dead, heartbeat file stops growing for 400 ms after the call returns, call bounded (< 4 s for a 400 ms timeout) |
| overflow stops the whole owned tree too | same, with a 1000-byte budget, and it returns long before the 20 s timeout |
| the CALLER exits on its own after a timeout | a separate Node process runs the harness with no `process.exit`; it must end by itself within 8 s (`execFile` timeout would fail it if pipes held it open) |
| byte budget counts raw bytes | `é`x400 then `a`x400 (1200 bytes, 800 old-style units) overflows a 1000 budget |
| FIXTURE MODEL | models the previous accounting on the same chunks and shows it would have **accepted** them; a fixture, not a mutation of product source |
| exact boundary | 1000 bytes pass, 1001 overflow; stdout+stderr share one budget; a character split across chunks decodes intact |
| unconfirmed stop | `killTree` deliberately does nothing: reports `treeStopped: false`, stays bounded, test cleans up its own group |
| spawn failure | `ENOENT` is reported as an error, not a hang |

No product source was mutated for these: this clone is dirty, so product-source sensitivity (for example
removing the group kill and checking the tree tests fail) still needs a disposable baseline. The CONTROL
test is the stand-in for that until it is run.

Not done, deliberately: **bounded error-body disposal** (draining or cancelling non-OK bodies at the
harness `fetch` boundary). It is the other candidate, but it has no demonstrated mechanism (the Node 22
control showed no extra connections, and a complete small body does not hold a socket), and it would paper
over the pinned client's real defect, which the child transports still have. If the async default fails
with socket identity pointing at the pool or at response handling, reconsider it with that evidence;
otherwise leave the client defect visible and fix it in the client pin.

Neither the fresh-socket switch nor `sync_d1` is a permanent fix, and no mutating recovery request is
retried anywhere.

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
| `node --test --test-timeout=15000 apps/api/scripts/request-boundary.test.mjs apps/api/scripts/smoke-harness-async-d1.test.mjs` | 29 tests, 28 pass, 1 skipped (Node 22.14, local): `request-boundary.test.mjs` (10), `smoke-harness-async-d1.test.mjs` (11), `owned-subprocess.test.mjs` (8; the Windows case is the skip). Run twice with no failures. The supervisor ran the earlier 17-test version on Node 24; **the process-tree and byte tests have not been run on Node 24 by me.** |
| Mutation: async error text without redaction | fails exactly `async failure text matches the sync failure text and is redacted`; restored |
| Mutation: account probe default flipped back to blocking | fails exactly `the account probe runs D1 asynchronously by default and never calls the blocking helper`; restored |
| Real Worker replay, default hosted CI on the published head, Node 24, new connection fields | **NOT RUN / UNPROVEN**: needs the coordinator's publish window |
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
