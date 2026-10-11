# Provider HTTP cancel/timeout topology — handoff

Date: 2026-10-09. Parent base `e7ad897` plus dirty WIP. Lane: primary topology investigation for full-goal D
(cancellation / upstream socket closure that a function `outboundService` cannot prove). Companion to
`provider-http-platform-handoff.md` (L1/L2 are the limitations this lane addresses).

Scope kept: only the new files below plus this doc. No production adapter, Rust, egress, config, harness,
existing probe/helper, client or CI edit. No Worker build, no built artifact run, no Electron, no index/branch/
STATUS/commit/push, no external network, real key, spend or deploy. Node `node:http` fixture only.

**Everything here is a platform stand-in result. It is not proof about the Rust adapter.**

## Verdict summary

| Claim | Verdict | Evidence |
|---|---|---|
| Installed Miniflare accepts `outboundService: { node: (req, res, miniflare) => Awaitable<void> }` | **PASS (API verified)** | Installed README line 345/351, `index.d.ts` `V4NodeHandler`, runtime exercised |
| Worker-side `AbortSignal.timeout` before response headers closes the provider-facing socket | **PASS** (stand-in) | fixture `client-closed` ~306 ms after a 300 ms timeout |
| Worker-side timeout while blocked reading the body closes the provider socket | **PASS** (stand-in) | `client-closed` ~304 ms, Worker saw `TimeoutError` |
| Caller disconnect mid-stream closes the provider socket before the stream ends | **PASS** (stand-in) | `client-closed`, 1–3 of 60 frames written, observed ≤ 42 ms after abort |
| No-cancel stream runs to completion (positive control) | **PASS** | fixture `completed`, 60 frames, caller saw `[DONE]`, ~2.5 s |
| Same cases through the function form | **UNPROVEN** (reproduces L1/L2) | socket stays `pending`/runs to completion; 2–3 sockets open at end |
| `wrangler` `unstable_startWorker` accepts `dev.outboundService: { node }` | **PASS** (timeout case only) | `provider-http-cancel-topology-wrangler-check.mjs` exit 0 |
| Unmodified Rust adapter closes the provider socket on cancel/timeout | **UNPROVEN** | not run; no build in this lane |
| Reservation / terminal request state after cancel | **UNPROVEN** | needs the real Worker + D1 (platform-handoff Finding 2) |
| Production Cloudflare behaviour | **UNPROVEN** | local workerd only |

## Miniflare API (installed `miniflare 5.20260921.0-alpha`, via wrangler 4.137.0, workerd 1.20260921.1)

- Documented form (`README.md:345,351`): `{ node: (req: http.IncomingMessage, res: http.ServerResponse, miniflare: Miniflare) => Awaitable<void> }`.
  Types: `V4NodeHandler` (`dist/src/index.d.ts`), parsed as `{ type: "node-handler", handler }`.
- **Gotcha:** `new Miniflare(...)` in this version validates the new schema (`workers: [...]` required). The README options
  are the V4 shape and must go through the exported `convertV4MiniflareOptions(...)` first, otherwise it throws
  `ERR_VALIDATION ... workers: expected array`. `wrangler`'s `unstable_startWorker` does this itself and accepted
  `{ node }` unchanged.
- Mechanism (`dist/src/index.js` `#handleLoopbackCustomNodeService`, ~118337): workerd issues a real HTTP request to
  Miniflare's loopback server tagged `MF-Custom-Node-Service`; the handler gets that live `req`/`res`. A Worker abort
  therefore appears as a socket/response `close` before `writableFinished`, which is what the helper turns into
  `upstream.destroy()`.
- **What the node handler cannot see:** unlike the fetch-service path, no original-URL header is set, so the **scheme
  (https vs http) and explicit port are not observable**; only `Host` and path. The helper's deny rules are therefore
  host + method + path + no-query, and the ledger records `schemeObservable: false`. The function form (`request.url`)
  can enforce scheme/port/userinfo; the node form cannot. The production adapter still validates scheme itself, but the
  topology layer is weaker here. Do not describe the node forwarder as enforcing https.
- A handler that throws gets a 500 with the error text (`writeHead(500)`; `res.end(message)`), so keep errors inside it.

## Measured behaviour and one probe artifact

- A stand-in Worker that returns `new Response(r.body, { status })` **without a `content-type`** had the whole body
  buffered before the caller's first read (first chunk at 2515 ms vs 11 ms with `content-type: text/event-stream`),
  in both topologies. That produced a false "disconnect → provider completed" reading in my first run. The probe now
  forwards the upstream content-type. The real adapter sets an SSE content-type; the artifact is specific to this stand-in
  pipe route but is a reminder that a cancel case must first prove streaming reaches the caller.
- In the node form, response headers reach the Worker immediately (`stall-after-headers` returned 200), unlike the
  function form (platform-handoff: headers withheld until body bytes flow).
- `unread-body-at-worker-return-closes-upstream` (advisory): a Worker that returns without reading the provider body
  also closes the socket (~5 ms). That is **not** a timeout result; the real timeout cases are separate and require the
  close to be ≥ 250 ms after start.

## Files (all new)

| File | Role |
|---|---|
| `apps/api/scripts/lib/provider-http-node-outbound.mjs` | Node-handler forwarder. Deny by default (403, drained body, query never recorded), re-dials only the owned fixture, destroys the upstream on `res`/socket close or `aborted`, marked 502 on transport failure. Ledger `forwarded()`/`denials()` with `reqSocketClosed`, `resClosedBeforeFinish`, `upstreamDestroyedBy`, `upstreamError`; `waitFor()` bounded. |
| `apps/api/scripts/lib/provider-http-node-outbound.test.mjs` | 4 node tests on a plain node server (same `(req,res)` contract): permitted request, deny matrix (4 cases, no fixture call, no query in ledger), downstream close destroys upstream, dead provider → marked 502. **4/4 pass.** |
| `apps/api/scripts/provider-http-cancel-topology-probe.mjs` | Miniflare stand-in Worker; runs both topologies (`--topology=node|function|both`, `--json`). Imports (read-only) the existing fixture and function forwarder. Prints `CANCEL_TOPOLOGY_VERDICT`; exit 0 all node critical PASS, 1 FAIL, 2 UNPROVEN. |
| `apps/api/scripts/provider-http-cancel-topology-wrangler-check.mjs` | Same timeout case through `unstable_startWorker` with `{ node }`. Exit 0/1/2. |

No existing file was edited. Miniflare is resolved relative to wrangler's install (`createRequire`), since it is not a
direct dependency.

## Commands (from `apps/api`)

```bash
node --test scripts/lib/provider-http-node-outbound.test.mjs        # 4/4
node scripts/provider-http-cancel-topology-probe.mjs                 # node: exit 0; function column shows UNPROVEN rows
node scripts/provider-http-cancel-topology-probe.mjs --topology=node
node scripts/provider-http-cancel-topology-wrangler-check.mjs        # exit 0
```

Last run counts (node topology): 6 fixture calls, 4 connections, **0 sockets open at end**; 1 denial (other host), 0 fixture
calls for it. Function topology: 6 calls, 3 connections, **3 sockets still open at end**, `requestAborted=false
responseCancelled=false` on every forwarded entry. Not run: lint/format on the new files, `pnpm check`, cargo.

## Cleanup

All processes started here exited via `dispose()` + `process.exit`; temp dirs removed; the one scratch script
(`.tmp-cancel-timing.mjs`) was deleted. Two other `workerd` processes were visible (sockets 53068/53203) and are **not**
from this lane; they were left alone.

## Next integration design (not done; for the coordinator)

1. Add a `--outbound=node` option to the harness/adapter probe so `unstable_startWorker` receives
   `dev.outboundService: { node: createNodeOutbound(...) }` (accepted, per the wrangler check). Keep the function
   forwarder as the default for scheme/port enforcement, or run both: node form for cancel claims, function form for
   the deny/scheme matrix. State which topology produced each verdict.
2. Re-point `timeout-upstream-closure` and `cancel-upstream-propagation` in `lib/provider-http-claims.mjs` at the node
   ledger (`fixture.outcome === "client-closed"` plus `resClosedBeforeFinish`) instead of L1/L2 UNPROVEN. Keep them
   UNPROVEN unless the real adapter probe produced the evidence.
3. The adapter-level run must add what a stand-in cannot: provider call count, terminal request state,
   reservation `reserved`→released/settled, and the Finding 2 sweeper timing, read back from D1, with the no-cancel,
   caller-disconnect and timeout controls side by side. Until then the reservation question stays UNPROVEN.
4. Add a log/assertion that the first streamed byte reached the caller before the disconnect (the buffering artifact above).
5. This needs the Rust redirect repair (P04-CR-003) and a fresh build to be meaningful; unmodified-adapter dispatch
   remains BLOCKED until then.

## Limitations

- Local workerd only; production Cloudflare egress and its abort semantics are not measured.
- Stand-in Worker, not the adapter: Rust timeout/cancel code paths, retries and budget settlement are untested here.
- Scheme/port/userinfo are not enforceable in the node handler (see above).
- One platform build (workerd 1.20260921.1); the `{ node }` form is documented but the installed package is an alpha.
- Timing observations are single local runs plus one repeat; bounds are generous (5 s), not performance claims.
