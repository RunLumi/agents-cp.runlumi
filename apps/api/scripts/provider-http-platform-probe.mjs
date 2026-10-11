#!/usr/bin/env node
// Platform-boundary proof: a REAL workerd Worker's outbound `fetch` to the permitted public
// provider endpoint reaches an owned loopback HTTP fixture through wrangler/Miniflare's
// `outboundService`, and every other destination is denied.
//
// The Worker here is a minimal stand-in that issues the same fetch shape as the production
// adapter (`providers.rs::dispatch`: POST, bearer header, AbortSignal timeout) EXCEPT for
// `redirect: "error"`, which this workerd rejects (measured below); the stand-in uses "manual".
// It proves the TOPOLOGY. It is not evidence about the Rust adapter; that needs the
// built Worker started with the same `outboundService` (see provider-http-platform-handoff.md).
//
// Exit codes follow the campaign convention: 0 all proven, 1 a claim failed, 2 harness blocked.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutboundForwarder } from "./lib/provider-http-forwarder.mjs";
import { startProviderFixture } from "./lib/provider-http-fixture.mjs";

const PUBLIC_HOST = "provider-http-fixture.example";
const SECRET = "sk-platform-probe-secret";

const WORKER_SOURCE = `
const endpoint = (host, scenario) => "https://" + host + "/v1/" + scenario + "/v1/chat/completions";
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const scenario = u.searchParams.get("scenario") ?? "ok";
    const stream = u.searchParams.get("stream") === "1";
    const timeoutMs = Number(u.searchParams.get("timeout") ?? "0");
    const target = u.searchParams.get("url") ?? endpoint(env.PUBLIC_HOST, scenario);
    const init = {
      method: u.searchParams.get("method") ?? "POST",
      redirect: u.searchParams.get("redirect") ?? "manual",
      headers: { "content-type": "application/json", authorization: "Bearer " + env.SECRET },
    };
    if (init.method === "POST") {
      init.body = JSON.stringify({ model: "m", stream, max_tokens: 8, messages: [{ role: "user", content: "platform probe" }] });
    }
    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
    // Pass-through mode: hand the upstream body straight to the caller so the caller's own
    // disconnect is what cancels it.
    if (u.pathname === "/pipe") {
      const upstream = await fetch(target, init);
      return new Response(upstream.body, { status: upstream.status });
    }
    try {
      const upstream = await fetch(target, init);
      let text = "";
      let bodyError = null;
      try { text = await upstream.text(); } catch (error) { bodyError = String(error?.message ?? error); }
      return Response.json({ status: upstream.status, text, bodyError });
    } catch (error) {
      return Response.json({ fetchError: String(error?.message ?? error), name: error?.name ?? null });
    }
  },
};
`;

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        ${detail}`}`);
};

const dir = mkdtempSync(join(tmpdir(), "lumi-provider-http-platform-"));
let fixture;
let worker;
try {
  writeFileSync(join(dir, "worker.mjs"), WORKER_SOURCE);
  fixture = await startProviderFixture({ expectedSecret: SECRET });
  const forwarder = createOutboundForwarder({
    permittedHost: PUBLIC_HOST,
    targetOrigin: fixture.origin,
  });

  let startWorker;
  try {
    ({ unstable_startWorker: startWorker } = await import("wrangler"));
  } catch (error) {
    console.log(`BLOCKED: wrangler's programmatic API is not importable: ${error.message}`);
    process.exit(2);
  }
  worker = await startWorker({
    name: "provider-http-platform-probe",
    entrypoint: join(dir, "worker.mjs"),
    compatibilityDate: "2026-09-24",
    bindings: {
      PUBLIC_HOST: { type: "plain_text", value: PUBLIC_HOST },
      SECRET: { type: "plain_text", value: SECRET },
    },
    dev: {
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      logLevel: "error",
      watch: false,
      persist: false,
      outboundService: forwarder,
    },
  });
  await worker.ready;
  const base = await worker.url;
  const ask = async (path) => {
    // Bounded: a Worker left waiting on a body that never completes is a result, not a hang.
    try {
      const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
      return await response.json();
    } catch (error) {
      return { probeTimeout: String(error?.name ?? error) };
    }
  };

  console.log(`\nPLATFORM provider HTTP topology (fixture ${fixture.origin}, public host ${PUBLIC_HOST})`);

  // --- a platform fact the production adapter depends on -------------------------------------
  const redirectError = await ask("/call?scenario=ok&redirect=error");
  check(
    'workerd REJECTS fetch redirect:"error" before any network I/O (production adapter sets it)',
    redirectError.name === "TypeError" &&
      /Invalid redirect value/.test(redirectError.fetchError ?? "") &&
      fixture.count() === 0,
    JSON.stringify(redirectError),
  );

  // --- positive controls: prove the route works before believing any refusal ---------------
  const okJson = await ask("/call?scenario=ok");
  check(
    "CONTROL non-streaming: permitted https endpoint reaches the loopback socket and returns the body",
    okJson.status === 200 && okJson.text.includes("fixture ok") && fixture.count("ok") === 1,
    JSON.stringify(okJson),
  );
  const okSse = await ask("/call?scenario=ok&stream=1");
  check(
    "CONTROL streaming: SSE frames and [DONE] arrive intact",
    okSse.status === 200 && okSse.text.includes("fixture ok") && okSse.text.includes("[DONE]"),
    JSON.stringify(okSse),
  );
  const ok = fixture.forScenario("ok");
  check(
    "request body/auth/context are the Worker's real ones, captured redacted",
    ok.length === 2 &&
      ok.every((r) => r.authorization.matchesExpected === true && r.authorization.scheme === "Bearer") &&
      ok[0].body.stream === false &&
      ok[1].body.stream === true &&
      ok[0].body.model === "m" &&
      fixture.holdsNoSecret(SECRET),
    JSON.stringify(ok),
  );
  check("no denial was recorded by the positive controls", forwarder.denials().length === 0);

  // --- upstream statuses, one call each ----------------------------------------------------
  const rate = await ask("/call?scenario=rate-limit");
  check("429 is returned as a real 429, one upstream call", rate.status === 429 && fixture.count("rate-limit") === 1, JSON.stringify(rate));
  const server = await ask("/call?scenario=server-error");
  check("503 is returned as a real 503, one upstream call", server.status === 503 && fixture.count("server-error") === 1, JSON.stringify(server));
  const malformed = await ask("/call?scenario=malformed&stream=1");
  check("malformed 200 SSE reaches the Worker verbatim (parser is the adapter's job)", malformed.status === 200 && malformed.text.includes("this is not json"), JSON.stringify(malformed));

  // --- faults that need a real socket ------------------------------------------------------
  const before = await ask("/call?scenario=fail-before-output");
  check(
    "fail-before-output: one upstream call, zero frames, Worker sees a marked 502 (Miniflare cannot surface a rejected fetch)",
    before.status === 502 && fixture.count("fail-before-output") === 1 && fixture.forScenario("fail-before-output")[0].framesWritten === 0 && forwarder.forwarded().some((f) => f.upstreamTransportError),
    JSON.stringify(before),
  );
  const after = await ask("/call?scenario=output-then-fail&stream=1");
  check(
    "output-then-fail (stream): the Worker received real output first and NO terminator (truncation is observable; Miniflare ends the body cleanly)",
    after.status === 200 && after.text.includes("partial output") && !after.text.includes("[DONE]"),
    JSON.stringify(after),
  );
  const truncated = await ask("/call?scenario=output-then-fail");
  check(
    "output-then-fail (non-stream): the truncated JSON never arrives as a complete success (body error, fetch error, or the Worker is left waiting)",
    typeof truncated.bodyError === "string" ||
      typeof truncated.fetchError === "string" ||
      truncated.probeTimeout !== undefined ||
      !(() => { try { JSON.parse(truncated.text); return true; } catch { return false; } })(),
    JSON.stringify(truncated),
  );
  const timeout = await ask("/call?scenario=stall-before-headers&timeout=300");
  check(
    "timeout before headers: AbortSignal.timeout fires in the Worker as a TimeoutError",
    typeof timeout.fetchError === "string" && timeout.name === "TimeoutError",
    JSON.stringify(timeout),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const stalled = forwarder.forwarded().find((f) => f.path.includes("stall-before-headers"));
  const stalledRecord = fixture.forScenario("stall-before-headers")[0];
  // LIMITATION L1, measured and recorded rather than graded: Miniflare's function outboundService
  // does not hand the forwarder the Worker's abort, so the owned socket stays open.
  console.log(
    `  INFO  L1 Worker-side timeout -> forwarder request.signal aborted=${stalled?.requestAborted}; provider socket outcome=${stalledRecord?.outcome}`,
  );
  const stallBody = await ask("/call?scenario=stall-after-headers&stream=1&timeout=300");
  check(
    "timeout after headers: the Worker is cut (response headers are not delivered until body bytes flow, so this surfaces as a TimeoutError on fetch)",
    stallBody.fetchError !== undefined ? stallBody.name === "TimeoutError" : typeof stallBody.bodyError === "string",
    JSON.stringify(stallBody),
  );

  // --- cancel: the caller disconnects from a streaming response ----------------------------
  // Bounded end to end. Measured, not graded: the diagnostic (provider-http-abort-diagnostic.mjs)
  // shows the same limitation L2 for a caller disconnect.
  const controller = new AbortController();
  try {
    const piped = await fetch(new URL("/pipe?scenario=slow-stream&stream=1", base), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6_000)]),
    });
    await piped.body.getReader().read();
    controller.abort();
  } catch (error) {
    console.log(`  INFO  cancel leg did not deliver a first frame: ${error?.name}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const slowRecord = fixture.forScenario("slow-stream")[0];
  const slowForward = forwarder.forwarded().find((f) => f.path.includes("slow-stream"));
  console.log(
    `  INFO  L2 caller disconnect -> forwarder aborted=${slowForward?.requestAborted} responseCancelled=${slowForward?.responseCancelled}; provider outcome=${slowRecord?.outcome} frames=${slowRecord?.framesWritten}`,
  );

  // --- denial matrix: nothing unmatched may leave, and nothing may reach the fixture -------
  forwarder.reset();
  const fixtureBefore = fixture.count();
  const denied = [
    ["loopback fixture origin directly", `${fixture.origin}/v1/ok/v1/chat/completions`, "scheme_not_https"],
    ["another public host", "https://api.openai.com/v1/chat/completions", "host_not_permitted"],
    ["IP literal", "https://203.0.113.9/v1/ok/v1/chat/completions", "host_not_permitted"],
    ["permitted host, other path", `https://${PUBLIC_HOST}/v1/models`, "path_not_permitted"],
    ["permitted host, non-default port", `https://${PUBLIC_HOST}:8443/v1/ok/v1/chat/completions`, "port_not_default"],
  ];
  for (const [label, url, reason] of denied) {
    const before = forwarder.denials().length;
    const result = await ask(`/call?url=${encodeURIComponent(url)}`);
    const added = forwarder.denials().slice(before);
    check(
      `DENIED ${label}`,
      result.status === 403 && added.length === 1 && added[0].reason === reason,
      `${JSON.stringify(result)} ledger=${JSON.stringify(added)}`,
    );
  }
  check("no denied destination reached the fixture", fixture.count() === fixtureBefore);
  check("fixture saw no request on an unexpected path", fixture.count("unknown") === 0);
  check("redaction held for the whole run", fixture.holdsNoSecret(SECRET));
} catch (error) {
  console.log(`\nBLOCKED/ERROR: ${error?.stack ?? error}`);
  process.exitCode = 2;
} finally {
  await worker?.dispose().catch(() => {});
  await fixture?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

if (process.exitCode !== 2) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}
