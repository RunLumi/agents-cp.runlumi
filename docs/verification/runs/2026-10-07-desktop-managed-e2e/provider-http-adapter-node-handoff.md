# Provider HTTP adapter probe: `--outbound=node` handoff

Status: probe integration written and fixture-tested. **The adapter has not been run in node mode yet.** No adapter
verdict exists from this change; the supervisor runs the probe.

## What changed (test-owned files only)

- `apps/api/scripts/provider-http-adapter-probe.mjs`
  - New `--outbound=function|node`. Default `function` is unchanged and stays the control; any other value exits 2.
  - `node` starts the built, unmodified Worker with `dev.outboundService: { node: createNodeOutbound(...) }` (the form
    `provider-http-cancel-topology-wrangler-check.mjs` showed `unstable_startWorker` accepts; re-run today, exit 0).
  - `timeout-upstream-closure` and `cancel-upstream-propagation` are graded from the fixture record plus the node
    ledger under `node`; under `function` they stay UNPROVEN as before.
  - The final `PROVIDER_HTTP_VERDICTS` line now carries `outbound`.
- `apps/api/scripts/lib/provider-http-claims.mjs`: `classifyUpstreamClosure`, `classifySettleCause`.
- `apps/api/scripts/lib/provider-http-claims.test.mjs`: 7 new tests.

No Rust, harness, Electron, CI, build, STATUS, index or branch changes.

## How the node-mode claims are decided

- **Closure PASS** needs both: the fixture saw its client close before finishing (`outcome=client-closed`, fewer than
  60 frames for `slow-stream`) and the handler attributes it to a downstream close (`upstreamDestroyedBy` set,
  `resClosedBeforeFinish`). A pending socket, a finished stream, a fixture-initiated destroy, or a close the handler
  does not attribute is UNPROVEN with an `OBSERVED ...` note. None of these is a FAIL, so a socket still open after the
  5 s bound is reported for the supervisor to judge.
- **Exact request tie.** Exactly one new fixture record and one new forwarder entry for the scenario, and the record's
  `x-lumi-request-id` (sent by `providers.rs:497`) must equal the run request id the caller observed. Anything else is
  UNPROVEN, so a closure is never attributed to a neighbouring request. If the adapter's header differs in format from
  the response `x-request-id`, expect UNPROVEN here, which is fail-closed rather than a product finding.
- **Cancel precondition.** Propagation and settlement are graded only after `classifyStreamCut` established a 2xx SSE
  response with an observed `data:` frame. A pre-output cut is recorded as UNPROVEN with the reason.
- **Settle may be the timeout, not the cancel.** `cancel-settles` and `cancel-mock-control` PASS only if the request
  settled within 20 s, the error code does not name a timeout, and the settle was not within 1.5 s of the route timeout
  (`classifySettleCause`). Otherwise they are UNPROVEN and print the error code and timing. The mock control is
  `adapter: mock` on `mock://lumi-timeout`, so a settle there at about 20 s with `request_timeout` is the timeout path.
- **Settled needs a reservation row.** The request must be terminal and have at least one `budget_reservations` row for
  this request id, none `reserved`. Zero rows no longer counts as "nothing held". This also applies to the no-cancel
  control. `d1Rows` throws on a refused statement, so a failed state query aborts the run rather than reading as absence.
- The 90 s observation window (`--cancel-window-ms`, default 90000) and the `atBound` snapshot are unchanged, so the
  original "held past 20 s" observation survives.
- `summary-no-secret-in-ledger` now also scans the forwarder ledger. The node ledger stores no headers or bodies.

## Not claimed

- The node handler cannot see scheme or explicit port. The production URL guard stays enforced inside the Worker, and
  `provider-http-fixture.example` host plus path are all this topology restricts. **Nothing here validates https for the
  test forwarder.** Use `--outbound=function` for the scheme/port deny matrix.
- `unmodified-adapter-request` still depends on the built artifact accepting `redirect: "error"`, as before.
- Stand-in evidence (7 platform claims PASS, 4 fixture tests) is not adapter proof.

## Checkpoint

- Node v22.14.0, wrangler 4.137.0 (installed under `apps/api`).
- Tests run: `node --test` on `provider-http-claims`, `-fixture`, `-node-outbound`: 51/51 pass. `node --check` on the
  probe passes; `--outbound=bogus` prints the error and exits 2.
- Not run: the adapter probe in either mode, lint/format, `pnpm check`, cargo. The Electron/Worker run on 52972 was not
  touched and no files or artifacts of it were read or written.

## Command for the supervisor

```bash
cd apps/api
node scripts/provider-http-adapter-probe.mjs --outbound=node     # canonical verdict line: PROVIDER_HTTP_VERDICTS {..."outbound":"node"...}
node scripts/provider-http-adapter-probe.mjs                      # function-mode control, same ledger
```

Exit 0 only if every critical claim is PASS, 1 on a FAIL, 2 when any critical claim is UNPROVEN or BLOCKED.
