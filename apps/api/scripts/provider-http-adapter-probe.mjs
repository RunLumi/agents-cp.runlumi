#!/usr/bin/env node
// Adapter-boundary proof: the REAL built Rust Worker (apps/api/build, unmodified) dispatches an
// `openai_compatible` provider whose catalog endpoint is a public-looking https host. The Worker's
// outbound fetch is routed by wrangler's `outboundService` to an owned loopback Node HTTP fixture.
// Production adapter, SSRF/allowlist rules, auth header, request translation, parser, budgets and
// finalisation all run for real; only the network path to that ONE host is test topology, and
// every other destination is denied.
//
// This file adds no harness/product edits: it reuses SmokeHarness and replaces only how the
// Worker process is started (in-process `unstable_startWorker` instead of the `wrangler dev` CLI,
// which has no outbound hook). It does NOT build; it serves the existing apps/api/build artifact
// and the harness's freshness check reports whether that artifact matches the source tree.
//
// Verdicts are per claim (lib/provider-http-claims.mjs) using PASS / FAIL / UNPROVEN / BLOCKED /
// NOT_APPLICABLE. Exit codes: 0 every critical claim PASS, 1 a claim FAILED, 2 at least one
// critical claim is UNPROVEN or BLOCKED (the run did not establish it; this is NOT a product
// verdict and NOT green). Observations are never promoted to PASS and never relabelled
// NOT_APPLICABLE. Through this topology provider-socket closure on timeout/disconnect cannot be
// observed (Miniflare's function outboundService does not deliver aborts), so those two claims
// are UNPROVEN on every run here and the overall result is never exit 0 until a topology that
// delivers aborts is used.
//
// `--outbound=function` (default, the control) serves the Worker's outbound fetch through the function
// form `(Request) => Response`, which cannot deliver aborts. `--outbound=node` serves it through
// `{ node: handler }` (lib/provider-http-node-outbound.mjs), where a Worker-side timeout or a caller
// disconnect surfaces as a real socket close; `timeout-upstream-closure` and
// `cancel-upstream-propagation` are then graded from the fixture record + node ledger. The node
// handler cannot observe scheme or explicit port (the production URL guard stays enforced in the
// Worker), so this mode makes NO claim about https validation of the test forwarder.
//
// `--redirect-shim` results describe the adapter WITH a test-side workaround and are reported
// separately: the claim `unmodified-adapter-request` stays UNPROVEN under the shim.
// `--cancel-window-ms=N` bounds how long a held reservation is observed after a disconnect
// (default 90000).
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createClaimLedger,
  classifyCancelSettlement,
  classifySettleCause,
  classifyStreamCut,
  classifyUpstreamClosure,
} from "./lib/provider-http-claims.mjs";
import { createOutboundForwarder } from "./lib/provider-http-forwarder.mjs";
import { startProviderFixture } from "./lib/provider-http-fixture.mjs";
import { createNodeOutbound } from "./lib/provider-http-node-outbound.mjs";
import { SmokeHarness, apiDir } from "./lib/smoke-harness.mjs";

const PUBLIC_HOST = "provider-http-fixture.example";
const SECRET_PREFIX = "pf-adapter-secret";
const CANCEL_SETTLE_BOUND_MS = 20_000;
const cancelWindowArg = process.argv.find((a) => a.startsWith("--cancel-window-ms="));
const CANCEL_WINDOW_MS = Math.max(
  CANCEL_SETTLE_BOUND_MS,
  Number(cancelWindowArg?.split("=")[1]) || 90_000,
);

const SLOW_STREAM_FRAMES = 60;
const outboundArg = process.argv.find((a) => a.startsWith("--outbound="));
const OUTBOUND = outboundArg === undefined ? "function" : outboundArg.split("=")[1];
if (!["function", "node"].includes(OUTBOUND)) {
  console.error(`unknown --outbound=${OUTBOUND}; expected function or node`);
  process.exit(2);
}
const nodeOutbound = OUTBOUND === "node";
console.log(
  `\n  outbound topology: ${OUTBOUND}${nodeOutbound ? " (scheme/port not observable by the node handler; production URL guard still enforced by the Worker)" : ""}`,
);

const redirectShim = process.argv.includes("--redirect-shim");
if (redirectShim) {
  console.log(
    '\n  *** --redirect-shim ACTIVE: redirect:"error" is rewritten to "manual" in the TEST entry. ' +
      "Results describe the adapter with that workaround, not the unmodified production request. ***",
  );
}
const probe = new SmokeHarness({ name: "provider-http-adapter" });
process.on("exit", () => probe.cleanup());

const ledger = createClaimLedger();
for (const [id, title] of [
  [
    "unmodified-adapter-request",
    "the unmodified production adapter's request is accepted by the runtime and reaches the provider",
  ],
  [
    "control-json",
    "non-streaming completion through the real adapter, credential/translation correct, request terminal",
  ],
  ["control-sse", "streaming SSE passes through intact and the request is terminal"],
  ["status-429", "provider 429 is an error, one upstream call, terminal, no usage billed"],
  ["status-503", "provider 503 is an error, one upstream call, terminal, no usage billed"],
  ["retry-bound-429", "429 retries stay within 1 attempt + max_retries"],
  ["redirect-not-followed", "a provider 3xx is an error and is never followed"],
  [
    "stream-malformed",
    "a malformed stream frame fails the request and is not forwarded as content",
  ],
  [
    "stream-fail-before-output",
    "a transport failure before output is an error, one call, terminal, no usage",
  ],
  [
    "stream-output-then-fail",
    "a failure after partial output is reported and the request is terminal",
  ],
  [
    "timeout-stall-before-headers",
    "a stall before headers is bounded by the route timeout and ends terminal",
  ],
  [
    "timeout-stall-after-headers",
    "a stall after headers is bounded by the route timeout and ends terminal",
  ],
  ["timeout-upstream-closure", "on timeout the provider socket is closed by the Worker"],
  [
    "stream-no-cancel-settles",
    "positive control: a fully-read stream settles terminal with no reservation held",
  ],
  [
    "cancel-settles",
    "after a client disconnect the request settles terminal within the bound and holds no reservation",
  ],
  ["cancel-upstream-propagation", "a client disconnect cancels the upstream provider request"],
  ["summary-no-unknown-path", "no request reached the fixture on an unknown path"],
  ["summary-no-denied-egress", "the Worker dialled only the one permitted host"],
  ["summary-no-secret-in-ledger", "the fixture ledger holds no credential value"],
]) {
  ledger.declare(id, title);
}
ledger.declare(
  "cancel-mock-control",
  "advisory control: disconnect on a mock:// provider settles terminal (separates adapter path from generic cancel handling)",
  {
    critical: false,
  },
);

/** An assertion that is evidence for one claim: PASS/FAIL, also counted by the harness. */
const check = (claimId, name, condition, detail = "") => {
  probe.expect(name, condition, detail);
  ledger.record(claimId, condition ? "PASS" : "FAIL", `${name}${detail ? ` (${detail})` : ""}`);
  return condition;
};
/** An observation or topology limit: reported as UNPROVEN/BLOCKED, never as PASS. */
const note = (claimId, verdict, name, detail = "") => {
  console.log(`  ${verdict.padEnd(8)}  ${name}${detail ? `  — ${detail}` : ""}`);
  ledger.record(claimId, verdict, `${name}${detail ? ` (${detail})` : ""}`);
};
const conclude = (extra = "") => {
  const conclusion = ledger.conclude({ failuresElsewhere: probe.failures.length });
  console.log(ledger.format(conclusion));
  console.log(
    `PROVIDER_HTTP_VERDICTS ${JSON.stringify({
      overall: conclusion.overall,
      redirectShim,
      outbound: OUTBOUND,
      claims: Object.fromEntries(conclusion.rows.map((r) => [r.id, r.verdict])),
    })}`,
  );
  const shimNote = redirectShim
    ? "with the test-side --redirect-shim workaround; not the unmodified adapter"
    : "";
  probe.finish(conclusion.exitCode, [shimNote, extra].filter(Boolean).join("; "));
};

let fixture;
let forwarder;
let worker;
try {
  fixture = await startProviderFixture();
  forwarder = (nodeOutbound ? createNodeOutbound : createOutboundForwarder)({
    permittedHost: PUBLIC_HOST,
    targetOrigin: fixture.origin,
  });
  const { unstable_startWorker: startWorker } = await import("wrangler");

  // --- replace only the process launch ------------------------------------------------------
  let ready;
  let logFile = "";
  let logTail = "";
  const baseWaitForHealth = probe.waitForHealth;
  probe.startWorker = (port) => {
    logFile = join(probe.persistDir, "worker-console.log");
    writeFileSync(logFile, "");
    const sink = (text) => {
      logTail = `${logTail}${text}\n`.slice(-20_000);
      appendFileSync(logFile, `${text}\n`);
    };
    // Opt-in diagnosis (`--trace-request`): a test-owned wrapper entry that logs any
    // failure of `new Request(...)` inside the real Worker. The adapter discards that error
    // (`Request::new_with_init(..).map_err(|_| transport_error())`), so without this a refused
    // request construction is indistinguishable from an unreachable provider. Nothing in the
    // product source or the built artifact is touched.
    let traceEntry;
    if (redirectShim || process.argv.includes("--trace-request")) {
      traceEntry = join(probe.persistDir, "trace-entry.mjs");
      writeFileSync(
        traceEntry,
        `import real from ${JSON.stringify(join(apiDir, "sentry-entry.mjs"))};
const NativeRequest = globalThis.Request;
const shim = ${JSON.stringify(redirectShim)};
globalThis.Request = new Proxy(NativeRequest, {
  construct(target, args, newTarget) {
    // WORKAROUND, test-side only (--redirect-shim): workerd rejects redirect:"error", which the
    // production adapter sets. "manual" returns a 3xx to the caller unfollowed, which the adapter
    // then rejects as a non-2xx. Remove once the adapter stops requesting an unsupported mode.
    if (shim && args[1]?.redirect === "error") args = [args[0], { ...args[1], redirect: "manual" }, ...args.slice(2)];
    try {
      return Reflect.construct(target, args, newTarget);
    } catch (error) {
      console.error("LUMI_PROBE_REQUEST_CONSTRUCT_FAILED redirect=" + args[1]?.redirect + " " + (error?.message ?? error));
      throw error;
    }
  },
});
export default real;
`,
      );
    }
    ready = startWorker({
      config: join(apiDir, "wrangler.jsonc"),
      ...(traceEntry ? { entrypoint: traceEntry } : {}),
      env: "development",
      // `""` is falsy: wrangler runs no build and serves the artifact already on disk.
      build: { custom: { command: "" } },
      bindings: {
        LUMI_PROVIDER_ALLOWLIST: { type: "plain_text", value: PUBLIC_HOST },
      },
      dev: {
        server: { hostname: "127.0.0.1", port },
        inspector: false,
        watch: false,
        logLevel: "debug",
        persist: probe.persistDir,
        testScheduled: true,
        outboundService: nodeOutbound ? { node: forwarder } : forwarder,
        structuredLogsHandler: (log) => sink(JSON.stringify(log)),
      },
    }).then(async (handle) => {
      worker = handle;
      await handle.ready;
    });
    probe.services.push({
      child: { pid: undefined, kill() {} },
      label: "Worker",
      get output() {
        return logTail;
      },
    });
    return { pid: undefined };
  };
  probe.waitForHealth = async (child) => {
    await ready;
    return baseWaitForHealth(child);
  };

  const { request, expect, browserMutation, browserHeaders } = probe;
  await probe.setup({
    persistEnvVar: "PROVIDER_HTTP_PERSIST_TO",
    portEnvVar: "PROVIDER_HTTP_PORT",
  });

  probe.stage = "fixtures";
  const owner = await probe.authenticatedUser("Provider HTTP Owner");
  const org = await probe.createOrganization(
    owner.jar,
    "Provider HTTP Org",
    `phttp-${probe.nonce}`,
  );
  const orgId = org.orgId;
  const orgHeaders = { ...browserHeaders(owner.jar), "X-Org-ID": orgId };
  const mutation = (label) => browserMutation(owner.jar, label);
  const secret = `${SECRET_PREFIX}-${probe.nonce}`;
  probe.secrets.add(secret);

  const budget = await request(
    owner.jar,
    "POST",
    `/api/v1/orgs/${orgId}/budgets`,
    {
      scope_type: "organization",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2027-01-01T00:00:00.000Z",
      limit_minor: 100_00,
      hard: true,
      currency: "USD",
    },
    mutation("phttp-budget"),
  );
  expect("CONTROL: a hard budget exists", budget.status < 300, `status=${budget.status}`);

  // `mockClaim`: build the route on a `mock://` endpoint (no fixture traffic) as the control for
  // that claim. A catalog that refuses it is BLOCKED evidence for the claim, not a product FAIL.
  // `claims`: the claim ids this route is evidence for; a route that cannot be built marks them BLOCKED.
  const routeFor = async (
    scenario,
    { maxRetries = 0, timeoutMs = 3_000, tag = scenario, mockClaim, claims = [] } = {},
  ) => {
    const routeBlocked = (why, detail) => {
      for (const id of mockClaim ? [mockClaim] : claims)
        note(id, "BLOCKED", `route for ${scenario}: ${why}`, detail);
    };
    const create = async (path, body, label) => {
      const result = await request(
        owner.jar,
        "POST",
        path,
        body,
        mutation(`phttp-${label}-${tag}`),
      );
      return result;
    };
    const provider = await create(
      `/api/v1/orgs/${orgId}/catalog/providers`,
      {
        provider_key: `phttp-${tag}-${probe.nonce}`.slice(0, 60),
        display_name: `HTTP fixture ${scenario}`,
        // The mock endpoints are only dispatched by the `mock` adapter (providers.rs
        // dispatch → mock_dispatch). Under `openai_compatible` a `mock://` URL is sent through
        // the HTTP path and fails provider_unavailable, which is not a stream at all.
        // `mock://lumi-timeout` writes one SSE frame and then stays pending: a real held
        // post-output stream to cut (the finite `lumi-success` stream can finish before the cut).
        adapter: mockClaim ? "mock" : "openai_compatible",
        endpoint_url: mockClaim ? "mock://lumi-timeout" : `https://${PUBLIC_HOST}/v1/${scenario}`,
      },
      "provider",
    );
    const providerId = provider.payload?.provider?.provider_id;
    if (mockClaim) {
      if (typeof providerId !== "string") {
        note(
          mockClaim,
          "BLOCKED",
          `mock:// route for ${scenario} was not accepted`,
          `status=${provider.status} body=${probe.brief(provider.payload)}`,
        );
        return null;
      }
    } else {
      expect(
        `CONTROL: catalog accepts the public https endpoint for ${scenario} through the real SSRF/allowlist gate`,
        typeof providerId === "string",
        `status=${provider.status} body=${probe.brief(provider.payload)}`,
      );
    }
    if (typeof providerId !== "string") return null;
    const model = await create(
      `/api/v1/orgs/${orgId}/catalog/models`,
      {
        provider_id: providerId,
        provider_model_id: `fixture-${scenario}`,
        display_name: `HTTP fixture ${scenario} model`,
        capabilities: ["text"],
      },
      "model",
    );
    const modelId = model.payload?.model?.model_id;
    const credential = await create(
      `/api/v1/orgs/${orgId}/credentials`,
      {
        provider_id: providerId,
        owner_type: "organization",
        label: `HTTP fixture ${scenario} credential`,
        secret,
      },
      "cred",
    );
    const credentialId = credential.payload?.credential?.credential_id;
    if (typeof modelId !== "string" || typeof credentialId !== "string") {
      routeBlocked(
        "model/credential not created",
        probe.brief({ m: model.payload, c: credential.payload }),
      );
      return null;
    }
    const config = {
      strategy: "fixed",
      candidates: [
        {
          provider_id: providerId,
          model_id: modelId,
          weight: 100,
          timeout_ms: timeoutMs,
          max_retries: maxRetries,
          credential_id: credentialId,
        },
      ],
    };
    const alias = `phttp-${tag}`.slice(0, 60);
    const created = await create(
      `/api/v1/orgs/${orgId}/routes`,
      { alias, display_name: `HTTP fixture ${scenario}`, strategy: "fixed", config },
      "route",
    );
    const routeId = created.payload?.route?.route_id;
    if (typeof routeId !== "string") {
      routeBlocked("route not created", `status=${created.status} ${probe.brief(created.payload)}`);
      return null;
    }
    const published = await create(
      `/api/v1/orgs/${orgId}/routes/${routeId}/publish`,
      { version: created.payload?.route?.version, config },
      "publish",
    );
    if (published.status !== 200) {
      routeBlocked(
        "route not published",
        `status=${published.status} ${probe.brief(published.payload)}`,
      );
      return null;
    }
    return { alias };
  };

  const requestRow = async (requestId) =>
    (
      await probe.d1Rows(
        `SELECT response_state, error_code FROM inference_requests WHERE request_id = '${requestId}'`,
        `request ${requestId}`,
      )
    )[0];
  const reservations = (requestId) =>
    probe.d1Rows(
      `SELECT status FROM budget_reservations WHERE request_id = '${requestId}'`,
      `reservation ${requestId}`,
    );
  const usage = (requestId) =>
    probe.d1Rows(
      `SELECT input_tokens, output_tokens FROM usage_events WHERE request_id = '${requestId}'`,
      `usage ${requestId}`,
    );
  const requestIdOf = (result) =>
    result?.payload?.request_id ??
    result?.payload?.id ??
    result?.payload?.error?.request_id ??
    ((result?.text ?? "").match(/"id":\s*"(req_[0-9a-f]{32})"/) ?? [])[1] ??
    null;
  const ask = (alias, { stream = false, label = alias } = {}) =>
    request(
      owner.jar,
      "POST",
      "/api/v1/inference/chat/completions",
      { model: alias, messages: [{ role: "user", content: "adapter boundary probe" }], stream },
      { ...orgHeaders, ...mutation(`phttp-ask-${label}-${stream}`) },
    );
  const terminal = async (claimId, label, requestId) => {
    if (typeof requestId !== "string") {
      note(claimId, "UNPROVEN", `${label}: finalisation unproven, no request id`);
      return;
    }
    const row = await requestRow(requestId);
    const held = (await reservations(requestId)).filter((r) => r.status === "reserved");
    check(
      claimId,
      `${label}: request reaches a terminal state and no reservation is left held`,
      ["completed", "failed"].includes(row?.response_state) && held.length === 0,
      `state=${row?.response_state ?? "no row"} error=${row?.error_code ?? "n/a"} held=${held.length}`,
    );
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Grade provider-socket closure for ONE request from the two node-topology ledgers. Only the
  // records added since `fixtureBefore`/`forwardedBefore` count, and exactly one of each must exist:
  // a stray or missing record is UNPROVEN, never matched to the wrong request. Only the node
  // topology delivers aborts, so under `--outbound=function` this stays UNPROVEN by construction.
  // The adapter sends `x-lumi-request-id`; the fixture record must carry exactly the run request id
  // the caller observed, otherwise the closure belongs to some other request and is UNPROVEN.
  const upstreamClosure = async (
    claimId,
    label,
    scenario,
    { fixtureBefore, forwardedBefore, completeFrames, requestId, boundMs = 5_000 },
  ) => {
    if (!nodeOutbound) {
      const seen = fixture.forScenario(scenario).at(-1);
      note(
        claimId,
        "UNPROVEN",
        `${label}: provider-socket closure is not observable through the function outbound topology`,
        `fixture outcome=${seen?.outcome}; use --outbound=node`,
      );
      return;
    }
    const added = () => fixture.forScenario(scenario).slice(fixtureBefore);
    const deadline = Date.now() + boundMs;
    while (Date.now() < deadline && !(added()[0] && added()[0].outcome !== "pending"))
      await sleep(50);
    const records = added();
    const entries = forwarder.forwarded().slice(forwardedBefore);
    if (records.length !== 1 || entries.length !== 1) {
      note(
        claimId,
        "UNPROVEN",
        `${label}: expected exactly one provider call and one forwarded entry for this request`,
        `fixture=${records.length} forwarded=${entries.length}`,
      );
      return;
    }
    if (typeof requestId !== "string" || records[0].lumiRequestId !== requestId) {
      note(
        claimId,
        "UNPROVEN",
        `${label}: the provider record is not tied to the run request id`,
        `run=${requestId ?? "none"} provider-header=${records[0].lumiRequestId ?? "none"}`,
      );
      return;
    }
    const verdict = classifyUpstreamClosure({
      fixtureRecord: records[0],
      ledgerEntry: entries[0],
      completeFrames,
    });
    console.log(
      `  ${label}: upstream ${verdict.note}; closedAfter=${records[0].endedAt === null ? "n/a" : `${records[0].endedAt - records[0].startedAt}ms`}`,
    );
    if (verdict.verdict === "PASS")
      check(
        claimId,
        `${label}: the provider socket was closed by the Worker side before the provider finished`,
        true,
        verdict.note,
      );
    else note(claimId, verdict.verdict, label, verdict.note);
  };

  // --- CONTROL FIRST: prove the topology reaches the real adapter before believing any fault ---
  probe.stage = "control";
  const okRoute = await routeFor("ok", {
    claims: ["control-json", "control-sse", "unmodified-adapter-request"],
  });
  const controlJson = okRoute ? await ask(okRoute.alias, { label: "control-json" }) : null;
  const reached = fixture.count("ok");
  console.log(
    `\n  control: http=${controlJson?.status} fixture_calls=${reached} forwarded=${forwarder.forwarded().length} denials=${JSON.stringify(forwarder.denials())}`,
  );
  if (!(controlJson?.status === 200 && reached >= 1)) {
    const lines = (probe.workerLog() ?? "")
      .split("\n")
      .filter((l) => /provider_dispatch_failed|LUMI_PROBE|TypeError|redirect/i.test(l))
      .slice(-5);
    console.log(
      `  BLOCKED: positive control did not reach the fixture. reason=${controlJson?.payload?.error?.details?.reason ?? "n/a"} ` +
        `body=${probe.brief(controlJson?.payload)}\n  worker log matches: ${lines.join(" | ") || "none (the adapter discards Request-construction errors)"}`,
    );
    for (const id of ["unmodified-adapter-request", "control-json", "control-sse"]) {
      note(
        id,
        "BLOCKED",
        "positive control did not reach the fixture",
        `http=${controlJson?.status ?? "none"}${redirectShim ? " (shim active)" : ""}`,
      );
    }
    conclude(
      "the real adapter never reached the fixture; fault cases not run (every later claim is UNPROVEN)",
    );
  }
  if (redirectShim) {
    note(
      "unmodified-adapter-request",
      "UNPROVEN",
      "--redirect-shim active: the request was rewritten by the test entry; this is not proof of the unmodified adapter",
    );
  } else {
    check(
      "unmodified-adapter-request",
      "CONTROL: the unmodified adapter's request was accepted by the runtime and reached the provider",
      true,
      `fixture_calls=${reached}`,
    );
  }
  check(
    "control-json",
    "CONTROL: non-streaming completion returns the fixture body through the real adapter",
    controlJson.text.includes("fixture ok"),
    probe.brief(controlJson.text),
  );
  const [first] = fixture.forScenario("ok");
  check(
    "control-json",
    "CONTROL: the adapter sent the real credential, JSON content type, and a translated body",
    first.authorization.matchesExpected !== false &&
      first.authorization.scheme === "Bearer" &&
      first.contentType?.includes("application/json") &&
      first.body.parsed &&
      first.body.model === "fixture-ok" &&
      first.body.stream === false &&
      first.body.messages.length === 1,
    probe.brief(first),
  );
  expect(
    "CONTROL: no unexpected outbound destination was attempted",
    forwarder.denials().length === 0,
    probe.brief(forwarder.denials()),
  );
  await terminal("control-json", "CONTROL json", requestIdOf(controlJson));

  const sse = await ask(okRoute.alias, { stream: true, label: "control-sse" });
  check(
    "control-sse",
    "CONTROL: streaming SSE passes through intact",
    sse.status === 200 &&
      sse.text.includes("fixture ok") &&
      fixture.forScenario("ok").at(-1).body.stream === true,
    probe.brief(sse.text),
  );
  await terminal("control-sse", "CONTROL sse", requestIdOf(sse));

  // --- single-call status faults ---------------------------------------------------------------
  probe.stage = "status-faults";
  for (const [scenario, label] of [
    ["rate-limit", "429"],
    ["server-error", "503"],
  ]) {
    const claim = `status-${label}`;
    const route = await routeFor(scenario, { claims: [claim] });
    if (!route) continue;
    const before = fixture.count(scenario);
    const result = await ask(route.alias, { label });
    check(
      claim,
      `${label}: surfaced as an error, not a 200`,
      result.status >= 400,
      `status=${result.status}`,
    );
    check(
      claim,
      `${label}: exactly one upstream call with max_retries=0`,
      fixture.count(scenario) - before === 1,
      `calls=${fixture.count(scenario) - before}`,
    );
    await terminal(claim, label, requestIdOf(result));
    const id = requestIdOf(result);
    if (typeof id === "string")
      check(claim, `${label}: no usage billed`, (await usage(id)).length === 0);
  }

  const retryRoute = await routeFor("rate-limit", {
    maxRetries: 2,
    tag: "rate-limit-retry",
    claims: ["retry-bound-429"],
  });
  if (retryRoute) {
    const before = fixture.count("rate-limit");
    await ask(retryRoute.alias, { label: "429-retry" });
    const made = fixture.count("rate-limit") - before;
    check(
      "retry-bound-429",
      "429 with max_retries=2: calls are within 1 attempt + 2 retries",
      made >= 1 && made <= 3,
      `calls=${made}`,
    );
  }

  // --- a redirect is never followed ---------------------------------------------------------------
  probe.stage = "redirect";
  const redirectRoute = await routeFor("redirect", { claims: ["redirect-not-followed"] });
  if (redirectRoute) {
    const before = fixture.count("redirect");
    const deniedBefore = forwarder.denials().length;
    const result = await ask(redirectRoute.alias, { label: "redirect" });
    check(
      "redirect-not-followed",
      "redirect: surfaced as an error, not a 200",
      result.status >= 400,
      `status=${result.status}`,
    );
    check(
      "redirect-not-followed",
      "redirect: the provider was called once",
      fixture.count("redirect") - before === 1,
    );
    check(
      "redirect-not-followed",
      "redirect: the Worker did NOT follow the Location (a follow would hit the forwarder as a denied host)",
      forwarder.denials().length === deniedBefore,
      probe.brief(forwarder.denials().slice(deniedBefore)),
    );
    await terminal("redirect-not-followed", "redirect", requestIdOf(result));
  }

  // --- stream faults ----------------------------------------------------------------------------
  probe.stage = "stream-faults";
  const malformed = await routeFor("malformed", { claims: ["stream-malformed"] });
  if (malformed) {
    const result = await ask(malformed.alias, { stream: true, label: "malformed" });
    check(
      "stream-malformed",
      "malformed: reported as failure and the broken frame is not forwarded as content",
      (result.status >= 400 || result.text.includes("upstream_invalid_response")) &&
        !result.text.includes("this is not json"),
      probe.brief(result.text),
    );
    await terminal("stream-malformed", "malformed", requestIdOf(result));
  }
  const failBefore = await routeFor("fail-before-output", {
    claims: ["stream-fail-before-output"],
  });
  if (failBefore) {
    const before = fixture.count("fail-before-output");
    const result = await ask(failBefore.alias, { stream: true, label: "fail-before" });
    check(
      "stream-fail-before-output",
      "fail-before-output: surfaced as an error",
      result.status >= 400 || /error/.test(result.text),
      probe.brief(result.text),
    );
    check(
      "stream-fail-before-output",
      "fail-before-output: the provider was reached once",
      fixture.count("fail-before-output") - before === 1,
    );
    await terminal("stream-fail-before-output", "fail-before-output", requestIdOf(result));
    const id = requestIdOf(result);
    if (typeof id === "string")
      check(
        "stream-fail-before-output",
        "fail-before-output: no usage billed",
        (await usage(id)).length === 0,
      );
  }
  const outputThenFail = await routeFor("output-then-fail", {
    claims: ["stream-output-then-fail"],
  });
  if (outputThenFail) {
    const result = await ask(outputThenFail.alias, { stream: true, label: "output-then-fail" });
    console.log(
      `\n  output-then-fail: http=${result.status} body=${probe.brief(result.text, 300)}`,
    );
    check(
      "stream-output-then-fail",
      "output-then-fail: the client is told about the failure after partial output",
      /error|failed|upstream/i.test(result.text) || result.status >= 400,
      probe.brief(result.text),
    );
    await terminal("stream-output-then-fail", "output-then-fail", requestIdOf(result));
  }

  // --- timeouts ---------------------------------------------------------------------------------
  probe.stage = "timeouts";
  for (const scenario of ["stall-before-headers", "stall-after-headers"]) {
    const claim = `timeout-${scenario}`;
    const route = await routeFor(scenario, {
      timeoutMs: 1_500,
      claims: [claim, "timeout-upstream-closure"],
    });
    if (!route) continue;
    const fixtureBefore = fixture.count(scenario);
    const forwardedBefore = forwarder.forwarded().length;
    const started = Date.now();
    const result = await ask(route.alias, {
      stream: scenario === "stall-after-headers",
      label: scenario,
    });
    const elapsed = Date.now() - started;
    check(
      claim,
      `${scenario}: the route timeout fires (bounded by ~1.5 s, well under the 30 s client cap)`,
      elapsed < 12_000,
      `elapsed=${elapsed}ms status=${result.status}`,
    );
    check(
      claim,
      `${scenario}: surfaced as an error`,
      result.status >= 400 || /error|timeout/i.test(result.text),
      probe.brief(result.text),
    );
    await terminal(claim, scenario, requestIdOf(result));
    // Under the function outbound topology Miniflare never delivers the Worker's abort to the
    // forwarder (provider-http-abort-diagnostic.mjs), so closure is UNPROVEN there: a topology limit,
    // never a product FAIL and never a PASS. Under `--outbound=node` it is graded from the ledgers.
    const timedOutRequestId = requestIdOf(result);
    if (typeof timedOutRequestId === "string") {
      const row = await requestRow(timedOutRequestId);
      console.log(
        `  ${scenario}: request ${timedOutRequestId} state=${row?.response_state ?? "no row"} error=${row?.error_code ?? "n/a"} elapsed=${elapsed}ms`,
      );
    }
    await upstreamClosure("timeout-upstream-closure", scenario, scenario, {
      fixtureBefore,
      forwardedBefore,
      requestId: timedOutRequestId,
    });
  }

  // --- cancel -----------------------------------------------------------------------------------
  probe.stage = "cancel";
  // Settled = terminal state AND at least one reservation row for THIS request id, none still
  // `reserved`. Zero reservation rows would make "no reservation held" vacuously true, so it is
  // not settlement evidence.
  const isSettled = (row, held, rows) =>
    ["completed", "failed"].includes(row?.response_state) && held.length === 0 && rows.length > 0;

  // Open a streaming completion, read the first chunk, then drop the connection.
  const disconnectMidStream = async (alias, label) => {
    const controller = new AbortController();
    const response = await fetch(`${probe.baseUrl}/api/v1/inference/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: owner.jar.header(),
        ...orgHeaders,
        ...mutation(`phttp-ask-${label}`),
      },
      body: JSON.stringify({
        model: alias,
        messages: [{ role: "user", content: "cancel me" }],
        stream: true,
      }),
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstChunk = first.value ? new TextDecoder().decode(first.value) : "";
    const requestId = response.headers.get("x-request-id") ?? null;
    const precondition = classifyStreamCut({
      status: response.status,
      contentType: response.headers.get("content-type"),
      firstChunk,
    });
    controller.abort();
    return {
      requestId,
      headers: [...response.headers.keys()].join(","),
      status: response.status,
      precondition,
      firstChunk: probe.brief(firstChunk),
    };
  };

  // A cut that did not land after SSE output is not evidence for a cancel claim. Record the claim
  // as `verdict`, and keep the pre-output outcome as a separate, labelled observation.
  const cutNotEstablished = async (claimId, label, cut, verdict) => {
    note(
      claimId,
      verdict,
      `${label}: the disconnect was not a post-output cut, so it is not cancel evidence`,
      `${cut.precondition.reason}; first=${cut.firstChunk}`,
    );
    if (typeof cut.requestId === "string") {
      const row = await requestRow(cut.requestId);
      console.log(
        `  (pre-output observation, not a cancel verdict) ${label}: http=${cut.status} state=${row?.response_state ?? "no row"} error=${row?.error_code ?? "n/a"}`,
      );
    }
  };

  // Poll the ledger until the request is terminal AND holds no reservation, or the window ends.
  // `atBound` snapshots the state at the first sample at/after the settle bound, so the original
  // "held at 20 s" observation survives even when the request is reclaimed later in the window.
  const observeSettlement = async (requestId, { boundMs, windowMs }) => {
    const started = Date.now();
    let atBound;
    for (;;) {
      // d1Rows throws on a refused statement (harness fail-closed), so a failed read can never look
      // like "no row"/"no reservation" here.
      const row = await requestRow(requestId);
      const rows = await reservations(requestId);
      const held = rows.filter((r) => r.status === "reserved");
      const elapsed = Date.now() - started;
      if (isSettled(row, held, rows)) return { settledWithinMs: elapsed, row, held, rows, atBound };
      if (atBound === undefined && elapsed >= boundMs)
        atBound = {
          elapsed,
          state: row?.response_state ?? "no row",
          error: row?.error_code ?? "n/a",
          held: held.length,
        };
      if (elapsed >= windowMs) return { settledWithinMs: null, row, held, rows, atBound };
      await sleep(500);
    }
  };

  const describe = (obs) =>
    `state=${obs.row?.response_state ?? "no row"} error=${obs.row?.error_code ?? "n/a"} reservations=${obs.rows.map((r) => r.status).join("|") || "none"} held=${obs.held.length}` +
    (obs.atBound
      ? ` atBound(${obs.atBound.elapsed}ms)=state:${obs.atBound.state},held:${obs.atBound.held}`
      : "");

  // A settle inside the bound is cancel evidence only when it was not the route-timeout path. A
  // timeout (error code, or a settle at the route timeout) records error + timing and stays UNPROVEN.
  const gradeSettlement = (claimId, label, obs, routeTimeoutMs, passTitle) => {
    const verdict = classifyCancelSettlement({
      settledWithinMs: obs.settledWithinMs,
      boundMs: CANCEL_SETTLE_BOUND_MS,
      windowMs: CANCEL_WINDOW_MS,
    });
    if (verdict.verdict !== "PASS")
      return note(claimId, verdict.verdict, `${label}: ${verdict.note}`, describe(obs));
    const cause = classifySettleCause({
      errorCode: obs.row?.error_code,
      settledWithinMs: obs.settledWithinMs,
      routeTimeoutMs,
    });
    if (cause !== "not-timeout") {
      return note(
        claimId,
        "UNPROVEN",
        `${label}: settled via the ${cause} path, not shown to be the cancel`,
        `error=${obs.row?.error_code ?? "n/a"} settledWithin=${obs.settledWithinMs}ms routeTimeout=${routeTimeoutMs}ms; ${describe(obs)}`,
      );
    }
    return check(
      claimId,
      passTitle,
      true,
      `${verdict.note}; error=${obs.row?.error_code ?? "n/a"}; ${describe(obs)}`,
    );
  };

  // CONTROL 1 (positive, no cancel): the same provider stream read to the end must settle. This
  // gives the baseline settle time and shows the route/fixture can finalise before any cancel
  // observation is interpreted.
  const slowControl = await routeFor("slow-stream", {
    timeoutMs: 20_000,
    tag: "slow-stream-control",
    claims: ["stream-no-cancel-settles"],
  });
  if (slowControl) {
    const startedAt = Date.now();
    const full = await ask(slowControl.alias, { stream: true, label: "slow-control" });
    const id = requestIdOf(full);
    check(
      "stream-no-cancel-settles",
      "slow-stream control: the stream was read to its terminator",
      full.status === 200 && full.text.includes("tick-0") && full.text.includes("[DONE]"),
      probe.brief(full.text),
    );
    if (typeof id === "string") {
      const obs = await observeSettlement(id, {
        boundMs: CANCEL_SETTLE_BOUND_MS,
        windowMs: CANCEL_SETTLE_BOUND_MS,
      });
      console.log(
        `\n  slow-stream no-cancel control: ${describe(obs)} total=${Date.now() - startedAt}ms`,
      );
      check(
        "stream-no-cancel-settles",
        "slow-stream control: a fully-read stream settles terminal with no reservation held",
        obs.settledWithinMs !== null,
        describe(obs),
      );
    } else {
      note("stream-no-cancel-settles", "UNPROVEN", "slow-stream control: no request id");
    }
  }

  // CONTROL 2 (advisory, mock://): a disconnect on a provider with no fixture traffic. If this
  // settles and the HTTP case below does not, the difference is in the HTTP adapter path; if both
  // hold the reservation, it is generic disconnect handling. The control is `adapter: mock` on
  // `mock://lumi-timeout` (one SSE frame, then held open), and it counts only when the cut landed
  // on a 2xx SSE response after a data frame (classifyStreamCut); otherwise it is BLOCKED.
  const mockRoute = await routeFor("mock-control", {
    timeoutMs: 20_000,
    tag: "mock-control",
    mockClaim: "cancel-mock-control",
  });
  if (mockRoute) {
    const cut = await disconnectMidStream(mockRoute.alias, "cancel-mock");
    if (!cut.precondition.established) {
      await cutNotEstablished("cancel-mock-control", "mock:// control", cut, "BLOCKED");
    } else if (typeof cut.requestId === "string") {
      const obs = await observeSettlement(cut.requestId, {
        boundMs: CANCEL_SETTLE_BOUND_MS,
        windowMs: CANCEL_WINDOW_MS,
      });
      console.log(
        `\n  mock:// disconnect control: ${describe(obs)} settledWithin=${obs.settledWithinMs}ms`,
      );
      gradeSettlement(
        "cancel-mock-control",
        "mock:// control",
        obs,
        20_000,
        "mock:// control: a disconnect settles terminal within the bound with no reservation held, not via the route timeout",
      );
    } else {
      note(
        "cancel-mock-control",
        "UNPROVEN",
        "mock:// control: response carried no x-request-id",
        `headers=${cut.headers}`,
      );
    }
  }

  // The claim under test: disconnect mid-stream on the HTTP adapter path.
  const slow = await routeFor("slow-stream", {
    timeoutMs: 20_000,
    claims: ["cancel-settles", "cancel-upstream-propagation"],
  });
  if (slow) {
    const fixtureBefore = fixture.count("slow-stream");
    const forwardedBefore = forwarder.forwarded().length;
    const cut = await disconnectMidStream(slow.alias, "cancel");
    // Propagation is graded only under `--outbound=node` (the function topology never delivers the
    // abort) and only when the cut really landed after an observed SSE data frame.
    if (!cut.precondition.established) {
      note(
        "cancel-upstream-propagation",
        "UNPROVEN",
        "cancel: the disconnect was not a post-output cut, so provider closure is not cancel evidence",
        cut.precondition.reason,
      );
    } else {
      await upstreamClosure("cancel-upstream-propagation", "cancel", "slow-stream", {
        fixtureBefore,
        forwardedBefore,
        completeFrames: SLOW_STREAM_FRAMES,
        requestId: cut.requestId,
      });
    }
    if (!cut.precondition.established) {
      await cutNotEstablished("cancel-settles", "cancel", cut, "UNPROVEN");
    } else if (typeof cut.requestId === "string") {
      const obs = await observeSettlement(cut.requestId, {
        boundMs: CANCEL_SETTLE_BOUND_MS,
        windowMs: CANCEL_WINDOW_MS,
      });
      console.log(
        `\n  cancel settlement: ${describe(obs)} settledWithin=${obs.settledWithinMs}ms window=${CANCEL_WINDOW_MS}ms`,
      );
      // A late or timeout-path settle is an OBSERVATION, never a PASS: the reservation held past the
      // bound (the original observation is preserved in `atBound`/the 90 s window) or was reclaimed
      // by the route timeout. Product cause is not diagnosed here; compare the controls above.
      gradeSettlement(
        "cancel-settles",
        "cancel",
        obs,
        20_000,
        "cancel: after a client disconnect the request settles to a terminal state within 20 s, not via the route timeout, and holds no reservation",
      );
    } else {
      note(
        "cancel-settles",
        "UNPROVEN",
        "cancel: settlement unproven, response carried no x-request-id",
        `headers=${cut.headers}`,
      );
    }
  }

  // --- summary guards ---------------------------------------------------------------------------
  probe.stage = "summary";
  console.log(
    `\n  fixture tally: ${JSON.stringify(Object.fromEntries(["ok", "rate-limit", "server-error", "redirect", "malformed", "fail-before-output", "output-then-fail", "stall-before-headers", "stall-after-headers", "slow-stream"].map((s) => [s, fixture.count(s)])))}`,
  );
  check(
    "summary-no-unknown-path",
    "no request reached the fixture on an unknown path",
    fixture.count("unknown") === 0,
  );
  check(
    "summary-no-denied-egress",
    "the forwarder denied nothing during the whole run (the Worker only dialled the one permitted host)",
    forwarder.denials().length === 0,
    probe.brief(forwarder.denials()),
  );
  check(
    "summary-no-secret-in-ledger",
    "fixture and forwarder ledgers hold no credential value",
    fixture.holdsNoSecret(secret) &&
      !JSON.stringify([forwarder.forwarded(), forwarder.denials()]).includes(secret),
  );
  conclude();
} catch (error) {
  // Never let a mid-run harness failure hide which claims were established before it died.
  console.log(ledger.format());
  probe.bail(error);
} finally {
  await worker?.dispose?.().catch(() => {});
  await fixture?.close().catch(() => {});
}
