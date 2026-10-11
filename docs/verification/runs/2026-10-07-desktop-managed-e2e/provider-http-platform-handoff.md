# Provider HTTP platform lane — handoff

Date: 2026-10-09. Parent base `e7ad897` plus dirty WIP. Lane: full-goal D, controllable HTTP provider at
the platform and adapter boundary. No existing harness/Rust/client/CI file was edited; no index, branch,
STATUS, commit, push or secret custody action. No Electron launch, no build, no deployed Tunnel/cloud
resource, no real API key or spend.

## Verdict summary

| Claim | Verdict |
|---|---|
| A Miniflare/wrangler `outboundService` can forward ONLY the permitted public provider endpoint to an owned loopback Node HTTP server and deny every other destination | **PASS** (platform probe 21/21, node tests 20/20) |
| The unmodified production Rust adapter reaches that fixture | **FAIL / product defect candidate**: workerd rejects `redirect:"error"`; see Finding 1 |
| Adapter-boundary matrix (status, retry count, malformed, before/after-output, timeout, redirect no-follow, settlement, redaction) | **PASS with `--redirect-shim`** (58/59 + 3 explicit UNPROVEN, run before the last cancel edit); NOT proof about the unmodified request |
| Cancel/timeout propagation to the provider socket | **UNPROVEN** through this topology (Limitations L1, L2) |
| Disconnect-then-settlement | **OBSERVATION, needs control** (Finding 2) |
| External real provider | **BLOCKED** (no approved key/cap); nothing here substitutes |

## Findings

### 1. Production adapter sets a redirect mode workerd rejects (candidate product defect)

`apps/api/src/adapters/providers.rs:476` does `init.with_redirect(RequestRedirect::Error)` (also
`adapters/webhooks/outbound.rs:511,620`). With workerd `1.20260921.1` (wrangler 4.137.0 / miniflare
`5.20260921.0-alpha`) constructing that request throws:

```
TypeError: Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented
since it does not make sense at the edge; use "manual" and check the response status code).
```

Measured three ways:

1. Stand-in Worker (`provider-http-platform-probe.mjs`): `redirect:"error"` throws before any I/O.
2. Real built Worker, positive control: `POST /api/v1/inference/chat/completions` → 503
   `provider_unavailable`, fixture calls 0, forwarder forwarded 0 and denied 0, no Worker log line.
3. Real built Worker with `--trace-request` (test-owned wrapper entry that logs `new Request` failures):
   `LUMI_PROBE_REQUEST_CONSTRUCT_FAILED redirect=error Invalid redirect value…`.

Why it stayed invisible: `providers.rs:482/487` is `Request::new_with_init(..).map_err(|_| transport_error())?`,
which discards the cause; only the later `Fetch::send` error arm (line 512) logs
`provider_dispatch_failed`. This is very likely the real cause of the earlier "host HTTP reachability"
failures (the old probe's "No provider_dispatch_failed line observed" text), not host routing.

Scope of the claim: measured on the local runtime. Production behaviour is not measured (no real provider);
workerd semantics are shared, so a defect there is likely but UNPROVEN. Needs a product-owner decision (use
`manual` and treat 3xx as an error, which is what the message recommends) and a log line on the construct
failure. Not changed here.

### 2. Disconnect mid-stream left the request unsettled for 20 s (observation, not a verdict)

With a finite 60-frame provider stream (~2.4 s) and a caller that aborts after the first frame, the request
stayed `response_state=stream_committed` with one reservation `reserved` for the whole 20 s poll. Not yet a
defect claim: the expired-reservation sweeper may reclaim it, and no `mock://` disconnect control or sweeper
timing run exists. `stream_committed` also counts toward the active-inference concurrency query
(`repositories/budgets.rs:410`) while it lingers. Next step: same disconnect against `mock://lumi-timeout`,
then trigger the sweep (`--test-scheduled` is enabled) and measure when it settles.

## Topology (what is real, what is test-owned)

```
Real built Worker (apps/api/build, development env, real D1/queues/R2 under a temp persist dir)
  adapter dispatch: POST https://provider-http-fixture.example/v1/<scenario>/v1/chat/completions
  LUMI_PROVIDER_ALLOWLIST=provider-http-fixture.example (the product's own operator var; no guard touched)
        │ outboundService  (wrangler unstable_startWorker dev.outboundService, a (Request)=>Response fn)
        ▼
provider-http-forwarder.mjs — allow exactly: https, host == permitted, default port, no userinfo, POST,
  no query, path /v1/<scenario>/v1/chat/completions. Everything else → 403 + denial ledger entry,
  never dialled. Allowed → re-dial http://127.0.0.1:<ephemeral> with redirect:"manual".
        ▼
provider-http-fixture.mjs — node:http server, scripted faults, redacted per-request ledger.
```

Real in the adapter probe: request translation, auth header, SSRF/allowlist validation of an `https://` public
host (catalog accepts it unchanged), parser, retry/timeout logic, budgets, reservation/finalisation, D1.
Test-owned: only the network path to that one host. The Node server is a test fixture, not a backend.

## Files (all new)

| File | Role |
|---|---|
| `apps/api/scripts/lib/provider-http-fixture.mjs` | Controllable provider: `ok` (SSE or JSON), `rate-limit`, `server-error`, `redirect`, `malformed`, `fail-before-output`, `output-then-fail`, `stall-before-headers`, `stall-after-headers`, `slow-stream`. Records seq, scenario, path, header names, credential presence/scheme/sha8/matches-expected, body shape (roles, char counts, sha8; no prompt text), outcome (`completed`/`client-closed`/`server-destroyed`), frames, connections, open sockets. |
| `apps/api/scripts/lib/provider-http-forwarder.mjs` | Deny-by-default forwarder + `forwarded()`/`denials()` ledgers (query strings never recorded), abort wiring, marked 502 for pre-output transport faults. |
| `apps/api/scripts/lib/provider-http-fixture.test.mjs` | 20 node tests: controls, redaction, wrong-credential visibility, each fault, abort, 11-case deny matrix. |
| `apps/api/scripts/provider-http-platform-probe.mjs` | Real workerd stand-in Worker through `outboundService`; 21 checks incl. the workerd redirect fact and the deny matrix. |
| `apps/api/scripts/provider-http-adapter-probe.mjs` | The real built Worker via the existing `SmokeHarness` with only the process launch replaced. Flags: `--trace-request`, `--redirect-shim`. |
| `apps/api/scripts/provider-http-abort-diagnostic.mjs` | Prints which abort signals Miniflare delivers (L1/L2). |

## Commands (run from `apps/api`)

```bash
node --test scripts/lib/provider-http-fixture.test.mjs          # 20/20 pass
node scripts/provider-http-platform-probe.mjs                   # 21/21 pass
node scripts/provider-http-adapter-probe.mjs                    # exit 2 BLOCKED: Finding 1
node scripts/provider-http-adapter-probe.mjs --trace-request    # exit 2, prints the TypeError cause
node scripts/provider-http-adapter-probe.mjs --redirect-shim    # matrix, labelled workaround
node scripts/provider-http-abort-diagnostic.mjs [--cancel-only] # may need Ctrl-C on the cancel leg
```

Versions: wrangler 4.137.0, miniflare 5.20260921.0-alpha (resolved through wrangler), workerd 1.20260921.1,
Node as installed. `startWorker` with `build: { custom: { command: "" } }` runs no build (empty string is
falsy at `wrangler-dist/cli.js:186462`); the Worker served is the existing artifact. The harness freshness
check reported it newer than the newest source file (about 8600–9500 s), which is the harness's own
heuristic, not a hash binding.

Verification of the API: `unstable_startWorker` input `dev.outboundService` is plumbed at
`wrangler-dist/cli.js:206043` and `:363085` (installed 4.137.0). Miniflare's own README/types were NOT
read: the miniflare package is not reachable from this worktree's allowed paths and WebFetch for the
official README was not permitted. The function form was verified by behaviour only. The README's
"node handler" form was not tried and might give raw socket control (follow-up).

## `--redirect-shim` (workaround, clearly not production proof)

Test-owned wrapper entry rewrites `redirect:"error"` to `"manual"` in `new Request(...)`. A 3xx is then
returned unfollowed and the adapter rejects it as non-2xx (`upstream_invalid_response`). Measured: redirect
scenario → provider called once, 0 forwarder denials (a follow to `redirect-target.example` would register as
one), terminal `failed`, reservation not held. Remove the shim once Finding 1 is fixed and re-run unflagged.

Adapter-probe results with the shim (real adapter, D1 read back after each case):

| Case | Result |
|---|---|
| Control JSON + SSE | 200, fixture 1 call each, Bearer matched, body translated (`model`, `stream`, 1 message), `completed`, hold released, no denials |
| 429, `max_retries=0` | 429, exactly 1 call, `failed provider_rate_limited`, no usage |
| 503, `max_retries=0` | 503, exactly 1 call, `failed provider_unavailable`, no usage |
| 429, `max_retries=2` | 1 call (no retry on 429; within the ≤3 bound) |
| Redirect | not followed, 1 call, failed, hold released |
| Malformed SSE | failure `upstream_invalid_response`, broken frame not forwarded |
| Fail before output | error, 1 call, failed, no usage |
| Output then fail (stream) | partial output then failure, `failed upstream_invalid_response`, hold released |
| Stall before/after headers, route timeout 1.5 s | 503 `request_timeout` in ~1.52 s, `failed`, hold released |
| Whole run | 0 unknown paths, 0 denials, ledger holds no credential value |

## Limitations of this topology (not product defects)

- **L1/L2 — aborts are not delivered.** Miniflare's function `outboundService` never aborts the forwarder's
  `request.signal` nor cancels its response body when the Worker times out or the caller disconnects
  (diagnostic: `requestAborted=false responseCancelled=false`; provider socket stays `pending`; a finite
  stream runs to completion). Provider-socket closure on timeout/cancel is therefore UNPROVEN here. The
  forwarder's abort wiring is exercised and passes only in the direct node tests.
- A throwing handler becomes an HTTP 500 with a stack, so pre-output socket faults are modelled as a marked
  502 (`x-lumi-fixture-egress: upstream-transport-failure`), not a rejected `fetch`; the adapter classifies
  502 and a transport error separately, so the transport-error branch is not covered.
- A mid-body upstream fault reaches the Worker as a clean end of body (truncation observable only by the
  missing terminator); response headers are not delivered to the Worker until body bytes flow
  (`stall-after-headers` surfaces as a fetch `TimeoutError`).
- `smoke-harness` `d1Rows` uses `spawnSync`, which blocks the in-process Worker and fixture while it runs.
  The poll loops yield between calls; keep reads short.

## Not covered / blockers

- External real provider: BLOCKED pending approved key and spend cap.
- Unmodified-adapter fault matrix: blocked by Finding 1 until a product change lands.
- Counts of timeout/cancel provider-socket closure, and the `mock://` disconnect control for Finding 2.
- `anthropic` adapter, tool-call translation and usage-attribution through this fixture: not exercised.
- Not run: Electron, desktop client, `pnpm check`, `cargo` checks, lint/format on the new files.

## Coordinator join (when allowed to touch the harness)

1. Decide Finding 1 with the product owner and add a log line for the construct error.
2. Promote `startWorker` override into the harness (`--outbound` option) so `wrangler dev`-based probes can
   use the forwarder; `v01-provider-fault-probe.mjs` can then replace its host-reachability sweep with the
   fixed `provider-http-fixture.example` endpoint.
3. Re-run `provider-http-adapter-probe.mjs` unflagged; keep `--redirect-shim` only as a diagnostic.
4. Try Miniflare's node-handler `outboundService` form (after reading the installed types) for abort fidelity.

## Continuation 2026-10-09 (verifier lane, after prior handle 87892 left no handoff)

Scope kept: only `provider-http-adapter-probe.mjs`, `lib/provider-http-claims.{mjs,test.mjs}` and this doc. No Rust adapter edit (the redirect repair belongs to another owner), no harness/CI/client/index/branch/STATUS/push/deploy, and **no Worker build or run this session** (waiting for the coordinator window).

### What the probe now does (inspected, not re-run)

- Verdicts are per claim through `lib/provider-http-claims.mjs` (PASS/FAIL/UNPROVEN/BLOCKED/NOT_APPLICABLE). A declared claim with no evidence is UNPROVEN; NOT_APPLICABLE is refused for critical claims; the worst record wins. Exit 0 only when every critical claim is PASS, 1 on any FAIL, **2 when a critical claim is UNPROVEN or BLOCKED**. The harness `finish()` calls `process.exit(code)`, so the exit code is the ledger's.
- Cancel evidence has three controls so the held-reservation observation cannot be blurred: `stream-no-cancel-settles` (critical positive control: slow stream read to `[DONE]` must settle), `cancel-mock-control` (advisory: disconnect on `mock://lumi-success`, separates the adapter path from generic disconnect handling) and `cancel-settles` (critical: disconnect on the HTTP fixture). `classifyCancelSettlement` keeps the original observation: a settle after the 20 s bound is UNPROVEN and the state at the bound (`atBound`) is preserved even if the sweeper reclaims later in the 90 s window (`--cancel-window-ms=N`). A late reclaim is never a PASS and no product cause is asserted.
- `--redirect-shim` forces `unmodified-adapter-request` to UNPROVEN, so a shimmed run can never be overall PASS.
- A failed positive control marks `unmodified-adapter-request`, `control-json` and `control-sse` BLOCKED and concludes at once (later claims stay UNPROVEN because they never ran).
- A mid-run harness error prints the ledger before bailing.

### Bounded checks run this session

- `node --check` on the adapter and platform probes: OK.
- `node --test lib/provider-http-claims.test.mjs lib/provider-http-fixture.test.mjs`: **36/36 pass** (ledger exit mapping, held-reservation classification, shim cannot PASS, every recorded claim id is declared, no `skip()` downgrade left; plus the 20 fixture/forwarder tests).

### Canonical critical verdict (derived, not measured this session)

| Claim | Verdict | Why |
|---|---|---|
| unmodified-adapter-request, control-json, control-sse | BLOCKED until the Rust repair lands | Finding 1 (workerd rejects `redirect:"error"`); last measured control: 503, 0 fixture calls |
| timeout-upstream-closure, cancel-upstream-propagation | UNPROVEN on every run in this topology | Miniflare function `outboundService` does not deliver aborts (L1/L2) |
| cancel-settles | UNPROVEN | `reserved` row observed for the whole 20 s poll (Finding 2); sweeper and mock controls not yet measured |
| status, retry, redirect, stream and timeout-bound claims | shim-only PASS (58/59 earlier); UNPROVEN for the unmodified request | |

Expected overall result today: **exit 2 (BLOCKED)**. After the Rust repair lands and the build is refreshed it is still **exit 2 (UNPROVEN)** until a topology that delivers aborts exists. Exit 2 is a statement about evidence, not a product verdict, and is not a PASS. No claim is counted as shim PASS.

### Owed at the coordinator window

1. Run unflagged: `node scripts/provider-http-adapter-probe.mjs` (expect BLOCKED, exit 2, before the repair) and keep the `PROVIDER_HTTP_VERDICTS` line as evidence.
2. After the redirect repair and a fresh Worker build, re-run unflagged; run the shim variant only as a labelled diagnostic.
3. Read the no-cancel, `mock://` and HTTP cancel lines together. If the HTTP case holds the reservation while both controls settle, the cause is the adapter path; if all three hold it, it is generic disconnect handling. Also measure when the sweeper (`--test-scheduled`) reclaims it, and preserve the 20 s held observation either way.
4. Try Miniflare's node-handler `outboundService` form for abort fidelity.

## Finding 1 repair status (docs lane, 2026-10-09)

Decision recorded in `docs/implementation/change-requests/P04-CR-003.md`. Source now builds the provider
request with `RequestRedirect::Manual`, refuses any 3xx as terminal/non-retryable `upstream_invalid_response`
(`Location` never read), and logs construction failures. Supervisor-owned Rust egress/provider tests were
live when this was written; their results are not recorded here and no build was run by this lane.

| Claim | Verdict now |
|---|---|
| Local workerd rejects `redirect:"error"` (measured, three ways above) | Fact, local runtime only |
| Source is `Manual` + explicit 3xx refusal; structural test requires a refusal path | Source fact; test result pending supervisor |
| Unmodified built adapter dispatches and does not follow a 3xx (fixture count 1, 0 denials) | **UNPROVEN** until the unflagged probe runs on a fresh build |
| Production Cloudflare behaviour | **UNPROVEN** |
| Webhook `redirect:"error"` (`outbound.rs:511,620`) on workerd | **UNPROVEN**, deliberately unchanged, separate change |

The `--redirect-shim` result stays a labelled diagnostic and earns no credit. A source-string guard is not
runtime hostile-redirect proof. Owed: build, then `node scripts/provider-http-adapter-probe.mjs` unflagged
(expected exit 2 while cancel/timeout closure is UNPROVEN, not 0).

## Disconnect-control repair (verifier lane, 2026-10-09, after the unshimmed 90 s run)

Scope: `provider-http-adapter-probe.mjs`, `lib/provider-http-claims.{mjs,test.mjs}` and this doc only. No Rust, harness, CI, index, branch, STATUS, push or deploy. **No Worker build or probe run this session**; checks below are node unit/syntax only.

### What the unshimmed run established (as reported; original `provider-unshimmed-runtime.log` retained)

Critical JSON/SSE/redirect/fault settlements PASS; overall UNPROVEN. The disconnect case ended `stream_committed`, held=1 after 90000 ms. That stays an observation, not a verdict; no product cause is asserted.

### Defect in the verifier: the `mock://` control was not a control

The advisory `cancel-mock-control` got HTTP 503 `provider_unavailable` yet logged PASS (`state=failed error=provider_unavailable held=0`, ~1.1 s). From source:

- The probe created the provider with `adapter: "openai_compatible"` and endpoint `mock://lumi-success`. `mock_dispatch` (`adapters/providers.rs:459`) runs only for `AdapterKind::Mock`, which the catalog accepts only in `development` (`routes/ai_catalog.rs:495`). Under `openai_compatible` the `mock://` URL takes the HTTP path and fails before any output.
- `disconnectMidStream` read once and aborted without checking status, content type or that a frame arrived, so a pre-output 503 was recorded as a post-output disconnect.
- Even with the right adapter, `mock://lumi-success` is a finite 4-chunk stream that can finish before the cut.

### Changes

| Change | Where |
|---|---|
| Mock control uses `adapter: "mock"` on `mock://lumi-timeout` (one SSE frame, then held open: a real post-output stream) | probe `routeFor` |
| `classifyStreamCut`: a cut counts only on 2xx + `text/event-stream` + a `data:` frame in the first read | `lib/provider-http-claims.mjs` |
| `disconnectMidStream` returns status, precondition verdict and first chunk | probe |
| Precondition not met: `cancel-mock-control` is **BLOCKED**, `cancel-settles` is **UNPROVEN**; the pre-output state is printed on a separate `(pre-output observation, not a cancel verdict)` line, so pre-output failure proof is kept but never feeds a cancel claim | probe `cutNotEstablished` |
| 90 s window (`--cancel-window-ms`), `atBound` snapshot and canonical non-PASS overall unchanged | probe |

Regression tests (`node --test lib/provider-http-claims.test.mjs`: 20/20 pass; `node --check` on the probe OK): a 503 JSON error cannot establish a cut; a 200 JSON body, an SSE response with no data frame and a missing status are not established; a source guard requires the `mock` adapter and the precondition gate on both cancel claims. These prove classification and wiring, not the product.

### Still owed (coordinator window; nothing here is measured)

1. Re-run unflagged on a fresh build. `cancel-mock-control` should either reach a real 200-SSE cut or be BLOCKED with a stated reason; BLOCKED/UNPROVEN is never a pass.
2. Read the three lines together (no-cancel slow-stream, `mock://lumi-timeout` cut, HTTP fixture cut). HTTP holds while mock settles: adapter path. All hold: generic disconnect handling. `lumi-timeout` stays open until the route timeout, so a settle may come from the timeout; check `error=` (`request_timeout` vs a cancel code) before attributing.
3. Before any product diagnosis, compare the actual expired-reservation sweeper cadence/expiry against the spec and the observed 90 s, and consider the L1/L2 topology limit (aborts not delivered). Neither is established.
4. The positive slow-stream full-read control (completed, held 0) is already known and unchanged.
