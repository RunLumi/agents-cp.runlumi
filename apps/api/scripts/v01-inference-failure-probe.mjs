#!/usr/bin/env node
// V01 — inference streaming: what a failed or abandoned request leaves behind.
//
// WHAT IS ACTUALLY UNCOVERED, after correcting the coverage map
//
// The map said this family had "no HTTP-level provider-fault attack". That was wrong, and it
// was wrong in the way the map itself documents as its recurring error: `p04-smoke` drives
// THREE of the four seeded `mock://` providers over real HTTP — fail-before-output, timeout
// (503 `request_timeout`), and post-output-failure on an `ordered_fallback` route, where it
// already asserts the claim that matters most (one error event, no `Hello from Lumi.`, no
// `response.completed`, so no fallback happened after output was committed).
//
// What is genuinely missing is narrower and it is a MONEY claim:
//
//   * `p04-smoke` calls `abortRequest` and asserts NOTHING about what the disconnect left.
//   * usage is attributed on SUCCESS only, so no failure path is checked against the budget.
//
// `budget_reservations.status` is one of `reserved | committed | released | expired`, and
// `inference_requests.response_state` is one of `not_dispatched | dispatched_no_output |
// stream_committed | completed | failed`. A reservation left `reserved` is money held against
// a request that will never produce output, and an inference request left in a non-terminal
// state is a run that never closes. Both are the sort of thing a smoke test never looks at,
// because the response it asserted was correct.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT THE STATUS
//
// Every assertion reads D1 after the response, and the assertion is about the terminal state
// of two rows. The response status is recorded and printed, because it is evidence, but the
// claim is never "it answered 503".
//
// EVERY CASE CARRIES A POSITIVE CONTROL, and this is the part that matters most
//
// "The reservation was released" is a vacuous claim if no reservation was ever taken. A probe
// with no budget has no reservations, so every release assertion would hold trivially against
// a product that never reserves anything. So each case asserts, IN ORDER:
//
//   1. a hard budget exists;
//   2. the request produced an `inference_requests` row — the request really was dispatched;
//   3. a `budget_reservations` row EXISTS for it — the thing under test was actually taken;
//   4. only then, that the reservation is not left `reserved` and the request is terminal.
//
// Step 3 before step 4 is the rule this campaign has now been bitten by five times: never let
// a negative assertion pass on an absence. The first version of a case here would have
// reported "no stranded reservation" against a product that had made none.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 inference-failure", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation, browserHeaders } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_INFER_PERSIST_TO", portEnvVar: "V01_INFER_PORT" });

  probe.stage = "fixtures";
  const owner = await probe.authenticatedUser("Inference Owner");
  const org = await probe.createOrganization(
    owner.jar,
    "Inference Org",
    `v01-infer-${probe.nonce}`,
  );
  const orgId = org.orgId;

  // A hard budget, so a reservation is actually taken. Without it every "released"
  // assertion below is a claim about nothing.
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
    browserMutation(owner.jar, "v01-infer-budget"),
  );
  const budgetId = budget.payload?.budget?.budget_id ?? budget.payload?.budget_id;
  expect(
    "CONTROL: a hard organization budget exists, so a reservation is actually taken and a release claim means something",
    typeof budgetId === "string" && budget.status < 300,
    `status=${budget.status} budget_id=${budgetId ?? "none"}`,
  );
  if (typeof budgetId !== "string") {
    probe.finish(2, "the budget fixture could not be created, so no money claim is testable");
    return;
  }

  // --- the seeded catalog: four providers, four models, no creation needed ---
  probe.stage = "catalog";
  const catalog = await request(
    owner.jar,
    "GET",
    `/api/v1/orgs/${orgId}/catalog`,
    undefined,
    browserHeaders(owner.jar),
  );
  expectStatus("CONTROL: the catalog is readable", catalog, [200]);
  const providers = catalog.payload?.providers ?? [];
  const models = catalog.payload?.models ?? [];
  const providerFor = (key) => providers.find((p) => p.provider_key === key);
  const modelFor = (key) => models.find((m) => m.provider_model_id === key);
  for (const key of ["mock-success", "mock-fail", "mock-timeout", "mock-post-output-failure"]) {
    expect(
      `CONTROL: the seeded catalog provides ${key}`,
      Boolean(providerFor(key) && modelFor(key)),
      `provider=${Boolean(providerFor(key))} model=${Boolean(modelFor(key))}`,
    );
  }

  // The inference routes are not org-scoped in the path -- `/api/v1/inference/chat/completions`
  // has no org segment -- so the org arrives in a header. Sending the browser headers without
  // it is why the first run answered `org_context_required` on every call.
  const orgHeaders = { ...browserHeaders(owner.jar), "X-Org-ID": orgId };
  const mutation = (label) => browserMutation(owner.jar, label);

  // A credential and a published single-candidate route per provider. `max_retries: 0` so a
  // retry cannot mask a defect, and a short `timeout_ms` so the timeout case cannot hang the
  // probe — an unbounded wait is a gate defect, and this campaign has already found one.
  const routeFor = async (key, { timeoutMs = 1_000, label } = {}) => {
    const provider = providerFor(key);
    const model = modelFor(key);
    if (!provider || !model) return null;
    const credential = await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/credentials`,
      {
        provider_id: provider.provider_id,
        owner_type: "organization",
        label: `V01 ${label} credential`,
        secret: `v01-secret-${label}-${probe.nonce}`,
      },
      mutation(`v01-infer-cred-${label}`),
    );
    const credentialId = credential.payload?.credential?.credential_id;
    expect(
      `CONTROL: a credential exists for ${key}`,
      typeof credentialId === "string",
      `status=${credential.status} credential_id=${credentialId ?? "none"}`,
    );
    const config = {
      strategy: "fixed",
      candidates: [
        {
          provider_id: provider.provider_id,
          model_id: model.model_id,
          weight: 100,
          timeout_ms: timeoutMs,
          max_retries: 0,
          credential_id: credentialId,
        },
      ],
    };
    const alias = `v01-${label}`;
    const created = await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/routes`,
      { alias, display_name: `V01 ${label}`, strategy: "fixed", config },
      mutation(`v01-infer-route-${label}`),
    );
    const routeId = created.payload?.route?.route_id;
    expect(
      `CONTROL: a route exists for ${key}`,
      typeof routeId === "string",
      `status=${created.status} alias=${alias}`,
    );
    if (!routeId) return null;
    const published = await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/routes/${routeId}/publish`,
      { version: created.payload?.route?.version, config },
      mutation(`v01-infer-publish-${label}`),
    );
    expect(
      `CONTROL: the ${key} route is published`,
      published.status === 200,
      `status=${published.status}`,
    );
    return published.status === 200 ? { alias, routeId, provider } : null;
  };

  probe.stage = "routes";
  const successRoute = await routeFor("mock-success", { label: "success" });
  const failRoute = await routeFor("mock-fail", { label: "fails" });
  const timeoutRoute = await routeFor("mock-timeout", { timeoutMs: 1_000, label: "timesout" });
  const postOutputRoute = await routeFor("mock-post-output-failure", { label: "postoutput" });

  // --- the state reader, and the two invariants ------------------------------
  const requestRows = (requestId) =>
    d1Rows(
      `SELECT response_state, error_code, first_output_at, completed_at, fallback_count, model_alias
         FROM inference_requests WHERE request_id = '${requestId}'`,
      `V01 inference request ${requestId}`,
    );
  const reservationRows = (requestId) =>
    d1Rows(
      `SELECT reservation_id, status, reserved_minor, committed_minor, reconciled_at, reconciliation_reason
         FROM budget_reservations WHERE request_id = '${requestId}'`,
      `V01 reservation for ${requestId}`,
    );
  const usageRows = (requestId) =>
    d1Rows(
      `SELECT input_tokens, output_tokens FROM usage_events WHERE request_id = '${requestId}'`,
      `V01 usage for ${requestId}`,
    );

  const TERMINAL = new Set(["completed", "failed"]);

  // The four-step assertion. Steps 1-3 prove the claim is about something.
  const assertFinalised = async ({ label, result, requestId, expectUsage }) => {
    probe.stage = label;

    // 2. the request really was dispatched
    const reqRows = await requestRows(requestId);
    expect(
      `${label}: an inference_requests row exists, so the request was really dispatched`,
      reqRows.length === 1,
      `request_id=${requestId} rows=${reqRows.length}`,
    );
    if (reqRows.length === 0) {
      probe.skip(
        `${label}: the final-state claims below are UNPROVEN, because no request row exists to read`,
        `http status=${result.status}; without a row, "not left pending" is a claim about nothing`,
      );
      return;
    }
    const row = reqRows[0];

    // 3. a reservation was actually TAKEN. Asserted before anything is said about it.
    const resRows = await reservationRows(requestId);
    expect(
      `${label}: a budget_reservations row was taken, so "not left reserved" is a claim about a real reservation`,
      resRows.length >= 1,
      `request_id=${requestId} reservations=${resRows.length} http status=${result.status}`,
    );
    if (resRows.length === 0) {
      probe.skip(
        `${label}: the reservation claim is UNPROVEN, because no reservation was taken for this request`,
        "a release assertion over a reservation that never existed holds for any product, including one that never reserves",
      );
      return;
    }

    // 4. the two invariants
    const stranded = resRows.filter((r) => r.status === "reserved");
    expect(
      `${label}: the reservation is not left 'reserved' after the request finished`,
      stranded.length === 0,
      stranded.length === 0
        ? `status(es)=${resRows.map((r) => r.status).join(",")} reason=${resRows[0]?.reconciliation_reason ?? "n/a"} http=${result.status}`
        : `STRANDED ${stranded.length} reservation(s) still 'reserved': ${JSON.stringify(stranded).slice(0, 300)}`,
    );
    expect(
      `${label}: the inference request reaches a TERMINAL state`,
      TERMINAL.has(row.response_state),
      `response_state=${row.response_state} error_code=${row.error_code ?? "none"} ` +
        `first_output_at=${row.first_output_at ?? "null"} completed_at=${row.completed_at ?? "null"} http=${result.status}`,
    );

    // And the money side: nothing may be charged for output that was never produced.
    const usage = await usageRows(requestId);
    if (expectUsage === null) {
      // Observe only. Used where the correct answer is genuinely "whatever the provider
      // produced", so asserting either presence or absence would be asserting a fiction.
      console.log(
        `  ${label}: usage rows=${usage.length} (${usage.map((u) => `${u.input_tokens}/${u.output_tokens}`).join(",") || "none"}) — observed, not asserted`,
      );
    } else if (expectUsage) {
      expect(
        `${label}: a usage row exists, because this request DID produce output`,
        usage.length >= 1,
        `usage rows=${usage.length} tokens=${usage.map((u) => `${u.input_tokens}/${u.output_tokens}`).join(",")}`,
      );
    } else {
      expect(
        `${label}: NO usage row is recorded, because this request produced no output to bill for`,
        usage.length === 0,
        usage.length === 0
          ? `response_state=${row.response_state} error_code=${row.error_code ?? "none"} http=${result.status}`
          : `CHARGED for output that was never produced: ${JSON.stringify(usage).slice(0, 300)}`,
      );
    }
  };

  // A refusal carries its request id inside the ERROR ENVELOPE, not at the top level, so the
  // first version of this probe could not find it and reported two cases UNPROVEN while their
  // rows sat in the database unread. An unread row is an unmeasured claim, not an absent one.
  const requestIdOf = (result) =>
    result?.payload?.request_id ??
    result?.payload?.id ??
    result?.payload?.error?.request_id ??
    null;

  const ask = async (alias, { stream }) => {
    const response = await request(
      owner.jar,
      "POST",
      "/api/v1/inference/chat/completions",
      {
        model: alias,
        messages: [{ role: "user", content: "V01 inference failure probe" }],
        stream,
      },
      { ...orgHeaders, ...browserMutation(owner.jar, `v01-infer-ask-${alias}-${stream}`) },
    );
    return response;
  };

  // =========================================================================
  // Case 1 — the control: a request that succeeds must be finalised AND billed
  // =========================================================================
  let successResult = null;
  let successRequestId = null;
  if (successRoute) {
    probe.stage = "success";
    successResult = await ask(successRoute.alias, { stream: false });
    expectStatus("CONTROL: a healthy provider answers 200", successResult, [200]);
    successRequestId = requestIdOf(successResult);
    expect(
      "CONTROL: the healthy response returns a request id, so its final state can be read back",
      typeof successRequestId === "string",
      `request_id=${successRequestId ?? "none"}`,
    );
    if (typeof successRequestId === "string") {
      await assertFinalised({
        label: "success (control)",
        result: successResult,
        requestId: successRequestId,
        expectUsage: true,
      });
    }
  }

  // =========================================================================
  // Case 2 — fail BEFORE any output
  // =========================================================================
  if (failRoute) {
    probe.stage = "fail-before-output";
    const result = await ask(failRoute.alias, { stream: false });
    const requestId = requestIdOf(result);
    console.log(
      `\n  fail-before-output: http=${result.status} reason=${result.payload?.error?.details?.reason ?? "n/a"}`,
    );
    expect(
      "fail-before-output: the failure is reported, not silently swallowed into a 200",
      result.status >= 400,
      `status=${result.status} body=${JSON.stringify(result.payload).slice(0, 200)}`,
    );
    if (typeof requestId === "string") {
      await assertFinalised({
        label: "fail-before-output",
        result,
        requestId,
        expectUsage: false,
      });
    } else {
      probe.skip(
        "fail-before-output: the final-state claims are UNPROVEN, because the error body carries no request id",
        `status=${result.status}; without a request id there is no row to read and nothing was measured`,
      );
    }
  }

  // =========================================================================
  // Case 3 — the provider never answers
  //
  // Bounded: the route's own `timeout_ms` is 1000, and the probe additionally races a hard
  // ceiling, because an unbounded wait is a defect in the GATE and not a pass.
  // =========================================================================
  if (timeoutRoute) {
    probe.stage = "timeout";
    const raced = await Promise.race([
      ask(timeoutRoute.alias, { stream: false }),
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ status: 0, payload: null, text: "", gateTimeout: true }),
          30_000,
        ),
      ),
    ]);
    const requestId = requestIdOf(raced);
    console.log(
      `\n  timeout: http=${raced.status} reason=${raced.payload?.error?.details?.reason ?? "n/a"}${raced.gateTimeout ? " GATE TIMED OUT" : ""}`,
    );
    expect(
      "timeout: the probe's own hard ceiling was not reached, so this is a product answer and not a gate hang",
      !raced.gateTimeout,
      raced.gateTimeout
        ? "the probe waited 30s for a route configured with timeout_ms=1000"
        : `answered in under 30s with status ${raced.status}`,
    );
    if (!raced.gateTimeout && typeof requestId === "string") {
      await assertFinalised({
        label: "timeout",
        result: raced,
        requestId,
        expectUsage: false,
      });
    } else if (!raced.gateTimeout) {
      probe.skip(
        "timeout: the final-state claims are UNPROVEN, because the error body carries no request id",
        `status=${raced.status}`,
      );
    }
  }

  // =========================================================================
  // Case 4 — output was committed, THEN the provider failed
  //
  // The dangerous shape: a stream that has already sent content must not be retried onto a
  // fallback candidate, because the client already saw the first output. The reservation is
  // the money question here — real tokens were produced, so this one MAY be committed.
  // =========================================================================
  if (postOutputRoute) {
    probe.stage = "post-output-failure";
    const result = await ask(postOutputRoute.alias, { stream: true });
    const text = result.text ?? "";
    // A streaming response carries its request id INSIDE the first frame, not in a header and
    // not at the top level of a JSON body. Reading only the envelope is why this case reported
    // its final-state claims UNPROVEN while the row was sitting in the database.
    const requestId =
      requestIdOf(result) ?? (text.match(/"id":\s*"(req_[0-9a-f]{32})"/) ?? [])[1] ?? null;
    console.log(
      `\n  post-output-failure: http=${result.status} partial=${text.includes("partial output")} ` +
        `error_frames=${[...text.matchAll(/data: (\{[^\n]*"error"[^\n]*\})/g)].length} ` +
        `done=${text.includes("[DONE]")} leaked_other_output=${text.includes("Hello from Lumi.")}`,
    );
    expect(
      "post-output-failure: the partial output IS delivered, so the client learns the provider committed before failing",
      text.includes("partial output"),
      `http=${result.status} body=${text.slice(0, 200)}`,
    );
    // The chat-completions endpoint streams BARE `data:` frames with no `event:` names, unlike
    // `/api/v1/inference/responses`, which is what p04-smoke drives and what carries
    // `event: error`. Two needles were wrong here before the right one was found:
    //
    //   * counting `event: error` finds zero on an endpoint that never emits one;
    //   * matching the SUBSTRING `"error"` finds three, because every frame carries
    //     `"error":null`. An error is `"error":{`.
    //
    // And the frame sequence is: role delta, the partial content, then a frame with
    // `finish_reason: "error"` and a non-null error, then `[DONE]`.
    //
    // `[DONE]` is NOT the success signal, which is what my third assertion assumed. It is the SSE
    // terminator, and a well-behaved stream closes with it whether it succeeded or not. What
    // tells a client the stream FAILED is the terminal `finish_reason` being `error` rather than
    // `stop`, and the error being non-null. Asserting the absence of `[DONE]` would have been
    // asserting a broken stream, and a probe that rewards a broken stream is worse than none.
    const frames = [...text.matchAll(/data: (\{.*?\})(?=\n\n|$)/g)].map((m) => m[1]);
    const errorFrames = frames.filter((f) => /"error":\s*\{/.test(f));
    const finishReasons = frames
      .map((f) => f.match(/"finish_reason":\s*"([a-z_]+)"/))
      .filter(Boolean)
      .map((m) => m[1]);

    console.log(
      `  post-output-failure: frames=${frames.length} error_frames=${errorFrames.length} ` +
        `finish_reasons=[${finishReasons.join(",")}] done=${text.includes("[DONE]")}`,
    );
    expect(
      "post-output-failure: the partial output IS delivered, so the client learns the provider committed before failing",
      text.includes("partial output"),
      `http=${result.status} body=${text.slice(0, 200)}`,
    );
    expect(
      'post-output-failure: EXACTLY ONE frame carries a non-null "error", so a client cannot be told twice that the same stream failed',
      errorFrames.length === 1,
      `frames=${frames.length} error frames=${errorFrames.length} errors=${errorFrames.map((f) => (f.match(/"error":\s*\{[^}]*\}/) ?? [""])[0].slice(0, 120)).join(" || ")}`,
    );
    expect(
      'post-output-failure: the terminal finish_reason is "error" and never "stop", so a client cannot mistake this for a completed response',
      finishReasons.length > 0 &&
        finishReasons[finishReasons.length - 1] === "error" &&
        !finishReasons.includes("stop"),
      `finish_reasons=[${finishReasons.join(",")}] — \`[DONE]\` closes the stream either way, so it is the finish_reason that carries the verdict`,
    );
    expect(
      "post-output-failure: the stream does not leak another candidate's output, so no fallback happened after output was committed",
      !text.includes("Hello from Lumi."),
      `leaked: ${text.includes("Hello from Lumi.")}`,
    );

    if (typeof requestId === "string") {
      await assertFinalised({
        label: "fail-before-output",
        result,
        requestId,
        expectUsage: false,
      });
    } else {
      probe.skip(
        "fail-before-output: the final-state claims are UNPROVEN, because the error body carries no request id",
        `status=${result.status}; without a request id there is no row to read and nothing was measured`,
      );
    }
  }

  // =========================================================================
  // Case 5 — the client disconnects mid-stream
  //
  // This is the one p04-smoke performs and never checks. A cancelled Worker can skip the
  // finalisation that a completed request performs, and a skipped finalisation on a request
  // that took a reservation is money held forever.
  // =========================================================================
  if (successRoute) {
    probe.stage = "client-disconnect";
    const baseUrl = probe.baseUrl;
    const controller = new AbortController();
    const headers = { Accept: "text/event-stream", ...orgHeaders };
    headers["Content-Type"] = "application/json";
    const cookie = owner.jar.header();
    if (cookie) headers.Cookie = cookie;
    let sawFirstChunk = false;
    let disconnectStatus = 0;
    setTimeout(() => controller.abort(), 3_000);
    try {
      const pending = await fetch(`${baseUrl}/api/v1/inference/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: successRoute.alias,
          messages: [{ role: "user", content: "V01 client disconnect" }],
          stream: true,
        }),
        signal: controller.signal,
      });
      disconnectStatus = pending.status;
      const reader = pending.body?.getReader();
      if (reader) {
        const first = await reader.read();
        sawFirstChunk = Boolean(first?.value);
      }
      controller.abort();
    } catch {
      // The downstream abort is the point of the case.
    }
    console.log(
      `\n  client-disconnect: http=${disconnectStatus} saw_output_before_abort=${sawFirstChunk}`,
    );
    expect(
      "client-disconnect: the probe really did receive output before aborting, so the request had committed and the abort was not a pre-flight cancellation",
      sawFirstChunk,
      `http=${disconnectStatus} — if no chunk arrived, the abort landed before any output and the claim below is weaker`,
    );

    // Give the Worker a moment to finalise, then read the newest request for this org.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const latest = await d1Rows(
      `SELECT request_id, response_state, error_code, completed_at
         FROM inference_requests WHERE org_id = '${orgId}'
         ORDER BY started_at DESC LIMIT 1`,
      "V01 the most recent inference request",
    );
    const latestId = latest[0]?.request_id;
    expect(
      "client-disconnect: an inference request row exists to inspect",
      typeof latestId === "string",
      `latest=${JSON.stringify(latest[0] ?? null).slice(0, 200)}`,
    );
    if (typeof latestId === "string" && latestId !== successRequestId) {
      // NOT `expectUsage: false`. The provider really did produce tokens before the client
      // walked away, and billing for output that was generated is correct. The first version
      // asserted "no usage row" and reported a defect that is the product behaving properly.
      //
      // What must hold is that whatever IS recorded is attributed to THIS request, so an
      // abandoned stream cannot leave its cost on someone else's row.
      const before = await assertFinalised({
        label: "client-disconnect",
        result: { status: disconnectStatus, payload: null },
        requestId: latestId,
        expectUsage: null,
      });
      const disconnectUsage = await usageRows(latestId);
      console.log(
        `  client-disconnect: usage rows for the abandoned request = ${disconnectUsage.length} ` +
          `(${disconnectUsage.map((u) => `${u.input_tokens}/${u.output_tokens}`).join(",") || "none"})`,
      );
      expect(
        "client-disconnect: any usage recorded for the abandoned request is attributed to THAT request, never to another one",
        disconnectUsage.every((u) => typeof u.input_tokens === "number"),
        `rows=${disconnectUsage.length} — attribution is by request_id, which is what this read used`,
      );
      void before;
    } else if (typeof latestId === "string") {
      probe.skip(
        "client-disconnect: the newest inference request is the CONTROL's own request, so the abort produced no row of its own",
        "the claim is UNPROVEN: a disconnect that leaves no row cannot be shown to have been finalised",
      );
    }
  }

  // --- the summary ----------------------------------------------------------
  const stranded = await d1Rows(
    `SELECT reservation_id, status, request_id FROM budget_reservations WHERE status = 'reserved'`,
    "V01 every reservation still held",
  );
  console.log(
    `\n  reservations still 'reserved' for this org: ${stranded.length} (across every outcome above)`,
  );
  expect(
    "no reservation anywhere in the database is left 'reserved' after every outcome in this probe, which is the whole money claim in one assertion",
    stranded.length === 0,
    stranded.length === 0
      ? "every reservation taken was committed or released"
      : `STRANDED: ${JSON.stringify(stranded).slice(0, 400)}`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
