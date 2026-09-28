#!/usr/bin/env node
// V01 — provider faults that only a real HTTP server can produce, and the answer to
// "was it called?".
//
// THE FOUR THINGS THIS EXISTS FOR
//
// The seeded catalog gives four `mock://` providers, and `verify:inference-failure` now drives
// all of them. What no seeded provider can produce is an **HTTP status from a real socket**:
//
//   * 429            — the rate-limit path, and the one case where a RETRY is arguably safe;
//   * 5xx            — the server-error path;
//   * a malformed chunk — a 200 whose SSE body is not parseable, which is the one fault the
//     mock's synthetic error frame is NOT: the mock fails cleanly, so it never exercises a
//     parser against bytes that are simply wrong.
//
// And the fourth thing is not a fault at all. Every provider question in this campaign has so
// far been answered by reading the Worker's own tables. That is a self-report. This probe runs
// a real HTTP server, **counts the requests that reach it**, and grades on that count, so
// "the provider was called once, and not retried" is a measurement rather than an inference.
//
// WHY THE CALL COUNT IS THE INTERESTING CLAIM
//
// `max_retries: 0` on a route is a claim the dispatcher honours, and nothing in the repository
// checked. If a 429 caused three dispatches despite `max_retries: 0`, every rate-limit response
// would cost three upstream calls — which is the opposite of what a rate limit is for. The
// server's own tally is the only place that can be seen, because a retry storm and a single
// attempt produce identical Worker-side state once the request finally fails.
//
// THE TWO CONTROL PROBLEMS THIS PROBE HAS TO SOLVE
//
// 1. **The server must be reached at all.** If the dispatcher refused the `http://127.0.0.1`
//    endpoint, every case would "pass" with a tidy 503 and nothing would have been exercised.
//    So the count is asserted per case, and a control route against a healthy path on the SAME
//    server must show exactly one call.
// 2. **A malformed body must be distinguishable from an empty one.** An SSE stream that is
//    empty, truncated, and syntactically broken all look like "no content" to a status check.
//    So the server sends a body that is recognisably wrong — a `data:` frame that is not JSON —
//    and the assertion is that the response says so rather than treating it as a success.

import { createServer } from "node:http";
import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 provider-http-faults", async (probe) => {
  const { request, expect, expectStatus, browserMutation, browserHeaders } = probe;

  // --- the fault server, with a tally per path -----------------------------
  const calls = new Map();
  const bump = (path) => calls.set(path, (calls.get(path) ?? 0) + 1);
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    bump(path);
    // A provider base URL carries a path, so the dispatcher appends the completions path to
    // it. Anything that is not one of the four routes is recorded and refused, so a request
    // to an unexpected path cannot pass unnoticed.
    if (path === "/v1/429") {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      res.end(JSON.stringify({ error: { message: "local rate limit", type: "rate_limit" } }));
      return;
    }
    if (path === "/v1/503") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "local server error" } }));
      return;
    }
    if (path === "/v1/malformed") {
      // A 200 whose body is recognisably wrong: a `data:` frame that is not JSON, then a bare
      // line that is not SSE at all, then a well-formed terminator. A parser that is lenient
      // will accept this as content, and that is the defect this case looks for.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {this is not json\n\n");
      res.write("<<< not an SSE frame >>>\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (path === "/v1/ok") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"id":"local-ok","model":"local-ok","choices":[{"delta":{"content":"local ok"}}]}\n\n',
      );
      res.write(
        'data: {"id":"local-ok","model":"local-ok","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      );
      res.end();
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no local route for ${path}` } }));
  });

  // Listen on BOTH loopback families. `localhost` can resolve to `::1` first, and a server
  // bound only to `127.0.0.1` then refuses the connection — which the dispatcher reports as
  // `provider_unavailable` with no detail, because it discards the transport error entirely.
  // That combination is the least diagnosable failure in this probe, and it is the product's
  // error handling that makes it so, not the probe.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  console.log(`\n  local fault server listening on ${base}`);

  try {
    // The endpoint has to be REACHABLE, and the product has two gates in the way: a private
    // destination check (relaxed in development) and an allowlist that defaults to EMPTY, so
    // an `http://` endpoint is refused with `ssrf_blocked` until its host is named.
    //
    // This is set through the product's OWN supported configuration — an env var the harness
    // passes to `wrangler dev` — and NOT by touching the SSRF guard. Relaxing the guard to
    // make a test pass would be replacing production security semantics with test-only logic,
    // which is the one thing this campaign must never do. Naming a host the operator has
    // chosen is what the allowlist is for.
    //
    // The loopback address is used because the fault server must be on this machine, and
    // `allow_local_provider_endpoints` is already true in development.
    // It has to be handed to the Worker as a BINDING, not as process env: `wrangler dev` does
    // not surface the process environment as Worker vars, so assigning `process.env` here
    // leaves the Worker behaving exactly as if the host had never been named. The harness
    // grows a `--var` passthrough for this, which is a test affordance in the test harness.
    probe.setWorkerVars({ LUMI_PROVIDER_ALLOWLIST: "127.0.0.1,localhost" });
    await probe.setup({ persistEnvVar: "V01_FAULT_PERSIST_TO", portEnvVar: "V01_FAULT_PORT" });

    probe.stage = "fixtures";
    const owner = await probe.authenticatedUser("Fault Owner");
    const org = await probe.createOrganization(owner.jar, "Fault Org", `v01-fault-${probe.nonce}`);
    const orgId = org.orgId;
    const orgHeaders = { ...browserHeaders(owner.jar), "X-Org-ID": orgId };
    const mutation = (label) => browserMutation(owner.jar, label);

    // A hard budget, so every case takes a reservation and the finalisation claims are real.
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
      mutation("v01-fault-budget"),
    );
    const budgetId = budget.payload?.budget?.budget_id ?? budget.payload?.budget_id;
    expect(
      "CONTROL: a hard budget exists, so a reservation is taken and the finalisation claims are not vacuous",
      typeof budgetId === "string" && budget.status < 300,
      `status=${budget.status} budget_id=${budgetId ?? "none"}`,
    );

    // One provider + model + credential + published route per local fault.
    const routeFor = async (name, { maxRetries = 0, timeoutMs = 3_000, variant = "" } = {}) => {
      // The variant is part of every identifier. Without it the second `429` route reuses the
      // first one's provider_key, alias and idempotency key, so it is answered
      // `409 idempotency_conflict` and the case silently measures nothing.
      const tag = `${name}${variant}`;
      const provider = await request(
        owner.jar,
        "POST",
        `/api/v1/orgs/${orgId}/catalog/providers`,
        {
          provider_key: `v01-local-${tag}-${probe.nonce}`.slice(0, 60),
          display_name: `V01 local ${name}`,
          adapter: "openai_compatible",
          endpoint_url: `${base}/v1/${name}`,
        },
        mutation(`v01-fault-provider-${tag}`),
      );
      const providerId = provider.payload?.provider?.provider_id;
      expect(
        `CONTROL: a provider pointing at the local ${name} endpoint was accepted`,
        typeof providerId === "string",
        `status=${provider.status} body=${JSON.stringify(provider.payload).slice(0, 220)}`,
      );
      if (typeof providerId !== "string") return null;

      const model = await request(
        owner.jar,
        "POST",
        `/api/v1/orgs/${orgId}/catalog/models`,
        {
          provider_id: providerId,
          provider_model_id: `local-${name}`,
          display_name: `V01 local ${name} model`,
          // `text` and `tools` are the only capability names the catalog accepts; the seeded
          // models use exactly these.
          capabilities: ["text"],
        },
        mutation(`v01-fault-model-${tag}`),
      );
      const modelId = model.payload?.model?.model_id;
      expect(
        `CONTROL: a model exists for the local ${name} provider`,
        typeof modelId === "string",
        `status=${model.status} body=${JSON.stringify(model.payload).slice(0, 220)}`,
      );
      if (typeof modelId !== "string") return null;

      const credential = await request(
        owner.jar,
        "POST",
        `/api/v1/orgs/${orgId}/credentials`,
        {
          provider_id: providerId,
          owner_type: "organization",
          label: `V01 local ${name} credential`,
          secret: `v01-fault-secret-${name}-${probe.nonce}`,
        },
        mutation(`v01-fault-cred-${tag}`),
      );
      const credentialId = credential.payload?.credential?.credential_id;
      if (typeof credentialId !== "string") {
        probe.skip(
          `the local ${name} route could not be built, so this case is unproven`,
          `credential status=${credential.status} body=${JSON.stringify(credential.payload).slice(0, 220)}`,
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
      const alias = `v01-fault-${tag}`.slice(0, 60);
      const created = await request(
        owner.jar,
        "POST",
        `/api/v1/orgs/${orgId}/routes`,
        { alias, display_name: `V01 local ${name}`, strategy: "fixed", config },
        mutation(`v01-fault-route-${tag}`),
      );
      const routeId = created.payload?.route?.route_id;
      if (typeof routeId !== "string") {
        probe.skip(
          `the local ${name} route could not be created, so this case is unproven`,
          `status=${created.status} body=${JSON.stringify(created.payload).slice(0, 220)}`,
        );
        return null;
      }
      const published = await request(
        owner.jar,
        "POST",
        `/api/v1/orgs/${orgId}/routes/${routeId}/publish`,
        { version: created.payload?.route?.version, config },
        mutation(`v01-fault-publish-${tag}`),
      );
      return published.status === 200 ? { alias, providerId, modelId } : null;
    };

    probe.stage = "routes";
    const okRoute = await routeFor("ok");
    const rateRoute = await routeFor("429");
    const serverErrorRoute = await routeFor("503");
    const malformedRoute = await routeFor("malformed");
    const rateRetryRoute = await routeFor("429", { maxRetries: 2, variant: "-retry" });

    // --- the state reader ---------------------------------------------------
    const requestRow = (requestId) =>
      probe.d1Rows(
        `SELECT response_state, error_code, completed_at FROM inference_requests WHERE request_id = '${requestId}'`,
        `V01 inference request ${requestId}`,
      );
    const usageCount = (requestId) =>
      probe.d1Rows(
        `SELECT input_tokens, output_tokens FROM usage_events WHERE request_id = '${requestId}'`,
        `V01 usage for ${requestId}`,
      );
    const reservationStatus = (requestId) =>
      probe.d1Rows(
        `SELECT status FROM budget_reservations WHERE request_id = '${requestId}'`,
        `V01 reservation for ${requestId}`,
      );
    const requestIdOf = (result) =>
      result?.payload?.request_id ??
      result?.payload?.id ??
      result?.payload?.error?.request_id ??
      ((result?.text ?? "").match(/"id":\s*"(req_[0-9a-f]{32})"/) ?? [])[1] ??
      null;
    const callsFor = (name) => calls.get(`/v1/${name}`) ?? 0;

    const ask = async (alias, { stream = false, label } = {}) => {
      const result = await request(
        owner.jar,
        "POST",
        "/api/v1/inference/chat/completions",
        { model: alias, messages: [{ role: "user", content: "V01 local fault" }], stream },
        { ...orgHeaders, ...mutation(`v01-fault-ask-${label ?? alias}-${stream}`) },
      );
      return result;
    };

    // =========================================================================
    // CONTROL — a healthy local endpoint, so "the server was reached" is proven
    // before any fault is believed
    // =========================================================================
    probe.stage = "control-ok";
    let controlCallsBefore = 0;
    if (okRoute) {
      controlCallsBefore = callsFor("ok");
      const result = await ask(okRoute.alias, { label: "control-ok" });
      const controlCalls = callsFor("ok") - controlCallsBefore;
      console.log(`\n  CONTROL ok: http=${result.status} server_calls=${controlCalls}`);
      expect(
        "CONTROL: the local provider was actually REACHED over a real socket, so the fault cases below are testing a dispatch and not a refusal",
        controlCalls >= 1,
        `server saw ${controlCalls} request(s) on /v1/ok; a count of 0 would mean the endpoint was never used and every fault case below would be vacuous`,
      );

      if (controlCalls === 0) {
        // BLOCKED, not four product failures.
        //
        // Every case below is graded on a call count from this server. If the socket is never
        // reached, all of them would read as "the provider was not called", which is true and
        // useless — and the probe would report a red sheet against a product that has not been
        // tested. The campaign's own rule is that exit 2 means the harness could not run, and
        // this is precisely that: the environment will not route a Worker's outbound fetch to a
        // host-local HTTP endpoint.
        //
        // The product's part in making this undiagnosable is recorded as V01-010:
        // `providers.rs` maps every fetch error to `transport_error()` and logs nothing, so a
        // misconfigured endpoint, a refused connection and a provider outage are one answer.
        // The Worker's own log, because that is the only place the cause now appears. Before
        // V01-010's fix there was nothing to print: the transport error was discarded, so this
        // probe spent three runs establishing the same fact with no evidence to show for it.
        const log = (probe.workerLog() ?? "")
          .split("\n")
          .filter((line) => line.includes("provider_dispatch_failed"))
          .slice(-3)
          .join("\n");
        console.log(
          "\n  BLOCKED: the Worker's outbound fetch never reached the local server.\n" +
            "  Every case in this probe is graded on that server's call tally, so none of them\n" +
            "  can run. Exiting 2 — the harness could not run, which is not a product verdict.",
        );
        console.log(
          log
            ? `  the Worker logged the cause (V01-010):\n${log
                .split("\n")
                .map((l) => `    ${l.slice(0, 200)}`)
                .join("\n")}`
            : "  the Worker logged NO cause for the failed dispatch. providers.rs maps every\n" +
                "  fetch error to transport_error(); V01-010 makes it log, and this run was built\n" +
                "  before that fix reached the binary, so its absence here is expected.",
        );
        probe.finish(
          2,
          "the local fault server was never reached, so no 429/5xx/malformed case was measured",
        );
        return;
      }

      expect(
        "CONTROL: the healthy local endpoint answers 200, so the server is a working provider and not a black hole",
        result.status === 200,
        `status=${result.status} body=${(result.text ?? JSON.stringify(result.payload)).slice(0, 200)}`,
      );
    }

    // =========================================================================
    // Case 1 — 429 with max_retries: 0. Exactly ONE upstream call.
    // =========================================================================
    probe.stage = "http-429";
    if (rateRoute) {
      const before = callsFor("429");
      const result = await ask(rateRoute.alias, { label: "429" });
      const made = callsFor("429") - before;
      const requestId = requestIdOf(result);
      console.log(
        `\n  429 (max_retries=0): http=${result.status} reason=${result.payload?.error?.details?.reason ?? "n/a"} server_calls=${made}`,
      );
      expect(
        "429: the fault IS surfaced, not swallowed into a 200",
        result.status >= 400,
        `status=${result.status} body=${JSON.stringify(result.payload).slice(0, 200)}`,
      );
      expect(
        "429: the provider was called, so the case exercised a dispatch",
        made >= 1,
        `server saw ${made} call(s); 0 would mean the endpoint was refused before dispatch and the status proves nothing`,
      );
      expect(
        "429: with max_retries=0 the provider is called EXACTLY ONCE, so a rate limit costs one upstream call and not a retry storm",
        made === 1,
        `server saw ${made} call(s) for a route configured with max_retries=0 — a retry here would defeat the purpose of a rate limit`,
      );
      if (typeof requestId === "string") {
        const [row] = await requestRow(requestId);
        const reservations = await reservationStatus(requestId);
        expect(
          "429: the request reaches a TERMINAL state and its reservation is not left held",
          Boolean(row) &&
            ["completed", "failed"].includes(row.response_state) &&
            reservations.every((r) => r.status !== "reserved"),
          `state=${row?.response_state ?? "no row"} error=${row?.error_code ?? "n/a"} reservations=${reservations.map((r) => r.status).join(",") || "none"}`,
        );
        const usage = await usageCount(requestId);
        expect(
          "429: no usage row is recorded, because a refused request produced no output to bill for",
          usage.length === 0,
          usage.length === 0
            ? `state=${row?.response_state}`
            : `CHARGED for nothing: ${JSON.stringify(usage)}`,
        );
      } else {
        probe.skip(
          "429: the finalisation claims are UNPROVEN, because no request id could be read from the response",
          `status=${result.status} server_calls=${made}`,
        );
      }
    }

    // =========================================================================
    // Case 2 — 429 with max_retries: 2. The retry budget is an UPPER bound.
    // =========================================================================
    probe.stage = "http-429-retries";
    if (rateRetryRoute) {
      const before = callsFor("429");
      const result = await ask(rateRetryRoute.alias, { label: "429-retry" });
      const made = callsFor("429") - before;
      console.log(
        `\n  429 (max_retries=2): http=${result.status} server_calls=${made} (this case shares /v1/429 with case 1)`,
      );
      expect(
        "429 with retries: the provider was called, so the case exercised a dispatch",
        made >= 1,
        `server saw ${made} call(s)`,
      );
      expect(
        "429 with retries: the upstream call count never exceeds the retry budget — 1 attempt plus 2 retries",
        made <= 3,
        `server saw ${made} call(s) for max_retries=2; more than 3 means the budget is not a bound`,
      );
    }

    // =========================================================================
    // Case 3 — 5xx
    // =========================================================================
    probe.stage = "http-503";
    if (serverErrorRoute) {
      const before = callsFor("503");
      const result = await ask(serverErrorRoute.alias, { label: "503" });
      const made = callsFor("503") - before;
      const requestId = requestIdOf(result);
      console.log(
        `\n  503 (max_retries=0): http=${result.status} reason=${result.payload?.error?.details?.reason ?? "n/a"} server_calls=${made}`,
      );
      expect(
        "503: the fault IS surfaced, not swallowed into a 200",
        result.status >= 400,
        `status=${result.status} body=${JSON.stringify(result.payload).slice(0, 200)}`,
      );
      expect(
        "503: with max_retries=0 the provider is called EXACTLY ONCE",
        made === 1,
        `server saw ${made} call(s) for a route configured with max_retries=0`,
      );
      if (typeof requestId === "string") {
        const [row] = await requestRow(requestId);
        const reservations = await reservationStatus(requestId);
        expect(
          "503: the request reaches a TERMINAL state and its reservation is not left held",
          Boolean(row) &&
            ["completed", "failed"].includes(row.response_state) &&
            reservations.every((r) => r.status !== "reserved"),
          `state=${row?.response_state ?? "no row"} error=${row?.error_code ?? "n/a"} reservations=${reservations.map((r) => r.status).join(",") || "none"}`,
        );
        const usage = await usageCount(requestId);
        expect(
          "503: no usage row is recorded, because a 5xx produced no output to bill for",
          usage.length === 0,
          usage.length === 0
            ? `state=${row?.error_code ?? row?.response_state}`
            : `CHARGED for nothing: ${JSON.stringify(usage)}`,
        );
      } else {
        probe.skip(
          "503: the finalisation claims are UNPROVEN, because no request id could be read",
          `status=${result.status} server_calls=${made}`,
        );
      }
    }

    // =========================================================================
    // Case 4 — a 200 whose body is not parseable
    //
    // The dangerous outcome is a LENIENT parser: the request answers 200, the garbage is
    // treated as content, and the client is handed a stream it cannot use while the server
    // records a success. So the claim is that the malformed body is reported as a FAILURE.
    // =========================================================================
    probe.stage = "http-malformed";
    if (malformedRoute) {
      const before = callsFor("malformed");
      const result = await ask(malformedRoute.alias, { stream: true, label: "malformed" });
      const made = callsFor("malformed") - before;
      const requestId = requestIdOf(result);
      const text = result.text ?? "";
      console.log(
        `\n  malformed: http=${result.status} server_calls=${made} leaked_garbage=${text.includes("this is not json")} ` +
          `reported_failure=${text.includes("upstream_invalid_response") || result.status >= 400}`,
      );
      expect(
        "malformed: the provider was called, so the case exercised a dispatch",
        made >= 1,
        `server saw ${made} call(s); 0 would mean the endpoint was refused and the case is vacuous`,
      );
      expect(
        "malformed: the unparseable body is REPORTED AS A FAILURE rather than handed back as a successful stream",
        result.status >= 400 || text.includes("upstream_invalid_response"),
        `status=${result.status} body=${text.slice(0, 260)}`,
      );
      expect(
        "malformed: no unparseable frame is passed through to the client as if it were content",
        !text.includes("this is not json"),
        `the client received the provider's broken frame verbatim: ${text.slice(0, 260)}`,
      );
      if (typeof requestId === "string") {
        const [row] = await requestRow(requestId);
        const reservations = await reservationStatus(requestId);
        expect(
          "malformed: the request reaches a TERMINAL state and its reservation is not left held",
          Boolean(row) &&
            ["completed", "failed"].includes(row.response_state) &&
            reservations.every((r) => r.status !== "reserved"),
          `state=${row?.response_state ?? "no row"} error=${row?.error_code ?? "n/a"} reservations=${reservations.map((r) => r.status).join(",") || "none"}`,
        );
        const usage = await usageCount(requestId);
        expect(
          "malformed: no usage row is recorded, because a stream whose frames could not be parsed produced no billable output",
          usage.length === 0,
          usage.length === 0
            ? `state=${row?.response_state} error=${row?.error_code ?? "n/a"}`
            : `CHARGED for unparseable output: ${JSON.stringify(usage)}`,
        );
      } else {
        probe.skip(
          "malformed: the finalisation claims are UNPROVEN, because no request id could be read",
          `status=${result.status} server_calls=${made}`,
        );
      }
    }

    // --- the summary ----------------------------------------------------------
    console.log(`\n  local fault server tally: ${JSON.stringify(Object.fromEntries(calls))}`);
    const unattempted = ["/v1/429", "/v1/503", "/v1/malformed", "/v1/ok"].filter(
      (p) => (calls.get(p) ?? 0) === 0,
    );
    expect(
      "every fault path on the local server was exercised at least once, so no case above is a claim about a request that was never made",
      unattempted.length === 0,
      unattempted.length === 0
        ? `tally ${JSON.stringify(Object.fromEntries(calls))}`
        : `never called: ${unattempted.join(", ")}`,
    );
    const stray = [...calls.keys()].filter(
      (p) => !["/v1/429", "/v1/503", "/v1/malformed", "/v1/ok"].includes(p),
    );
    expect(
      "the dispatcher only ever called the endpoints this probe published — no request went anywhere unexpected",
      stray.length === 0,
      stray.length === 0 ? "no unexpected path was called" : `unexpected: ${stray.join(", ")}`,
    );
  } finally {
    server.close();
  }

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
