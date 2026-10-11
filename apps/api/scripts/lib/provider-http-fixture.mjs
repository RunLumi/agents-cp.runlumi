// Test-owned controllable HTTP provider fixture. NOT a product backend.
//
// A real `node:http` server that speaks just enough OpenAI-compatible chat completions to drive
// the production Rust provider adapter, with scripted faults that only a real socket produces and
// a per-request ledger that is the measurement ("was it called, how often, with what shape").
//
// The route is `/v1/<scenario>/v1/chat/completions`: a provider base URL carries a path and the
// adapter appends `/v1/chat/completions`, so the scenario is part of the endpoint the catalog
// stores. Any other path is recorded as `unknown` and answered 404, so a stray request cannot
// pass unnoticed.
//
// Nothing secret is retained. Credentials are recorded as presence + scheme + a short SHA-256
// prefix + whether they equal an expected value; prompt text is recorded as role + length + hash.

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const ROUTE = /^\/v1\/([a-z0-9-]+)\/v1\/chat\/completions$/;

export const SCENARIOS = Object.freeze({
  ok: "200; SSE when stream=true, JSON otherwise; carries usage",
  "rate-limit": "429 with Retry-After, before any output",
  "server-error": "503 JSON, before any output",
  malformed: "200 SSE whose frames are not valid JSON / not SSE",
  redirect: "302 to a different public host; a client that follows would show up as a denial",
  "fail-before-output": "socket destroyed after the request body is read, before any response byte",
  "output-then-fail":
    "200 plus one real content frame (or a truncated JSON body), then socket destroyed",
  "stall-before-headers": "request read, never answered (timeout control)",
  "stall-after-headers": "200 headers flushed, then no body bytes (timeout control)",
  "slow-stream": "200 SSE, one frame every 40 ms for 60 frames then a terminator (cancel control)",
});

const sha8 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 8);

function describeCredential(value, expected) {
  if (typeof value !== "string" || value === "") return { present: false };
  const [scheme, ...rest] = value.split(" ");
  const token = rest.length > 0 ? rest.join(" ") : value;
  return {
    present: true,
    scheme: rest.length > 0 ? scheme : "raw",
    sha8: sha8(token),
    matchesExpected: expected === undefined ? null : token === expected,
  };
}

function describeBody(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { parsed: false, bytes: Buffer.byteLength(text) };
  }
  const messages = Array.isArray(json.messages) ? json.messages : [];
  return {
    parsed: true,
    bytes: Buffer.byteLength(text),
    model: json.model ?? null,
    stream: json.stream === true,
    max_tokens: json.max_tokens ?? null,
    system_present: typeof json.system === "string",
    tool_count: Array.isArray(json.tools) ? json.tools.length : 0,
    messages: messages.map((message) => {
      const content = typeof message?.content === "string" ? message.content : "";
      return { role: message?.role ?? null, chars: content.length, sha8: sha8(content) };
    }),
  };
}

const sse = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const delta = (id, content) => ({ id, model: "fixture", choices: [{ delta: { content } }] });

/**
 * Start the fixture on an ephemeral loopback port.
 *
 * @param {{ expectedSecret?: string, host?: string }} [options]
 */
export async function startProviderFixture({ expectedSecret, host = "127.0.0.1" } = {}) {
  const records = [];
  const sockets = new Set();
  let connections = 0;
  let sequence = 0;
  const timers = new Set();

  const later = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const server = createServer(async (req, res) => {
    const record = {
      seq: ++sequence,
      scenario: "unknown",
      method: req.method,
      path: (req.url ?? "/").split("?")[0],
      headerNames: Object.keys(req.headers).sort(),
      accept: req.headers.accept ?? null,
      contentType: req.headers["content-type"] ?? null,
      authorization: describeCredential(req.headers.authorization, expectedSecret),
      apiKey: describeCredential(req.headers["x-api-key"], expectedSecret),
      lumiRequestId: req.headers["x-lumi-request-id"] ?? null,
      body: null,
      outcome: "pending",
      framesWritten: 0,
      startedAt: Date.now(),
      endedAt: null,
    };
    records.push(record);
    const finish = (outcome) => {
      if (record.outcome === "pending") {
        record.outcome = outcome;
        record.endedAt = Date.now();
      }
    };
    // `close` fires on normal completion too, so the outcome is only "client-closed" when the
    // response had not finished — which is how a Worker-side abort becomes visible here.
    res.on("close", () => finish(res.writableFinished ? "completed" : "client-closed"));
    const destroy = (outcome) => {
      finish(outcome);
      req.socket.destroy();
    };

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    record.body = describeBody(bodyText);
    const wantsStream = record.body.parsed && record.body.stream;
    const match = ROUTE.exec(record.path);
    if (req.method !== "POST" || !match || !(match[1] in SCENARIOS)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no fixture route" } }));
      return;
    }
    const scenario = match[1];
    record.scenario = scenario;
    const id = `fixture-${record.seq}`;

    switch (scenario) {
      case "ok": {
        if (wantsStream) {
          res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": id });
          res.write(sse(delta(id, "fixture ok")));
          res.write(
            sse({
              id,
              model: "fixture",
              choices: [],
              usage: { prompt_tokens: 2, completion_tokens: 1 },
            }),
          );
          res.end(sse("[DONE]"));
          record.framesWritten = 3;
        } else {
          res.writeHead(200, { "content-type": "application/json", "x-request-id": id });
          res.end(
            JSON.stringify({
              id,
              model: "fixture",
              choices: [{ index: 0, message: { role: "assistant", content: "fixture ok" } }],
              usage: { prompt_tokens: 2, completion_tokens: 1 },
            }),
          );
        }
        return;
      }
      case "rate-limit":
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: { message: "fixture rate limit", type: "rate_limit" } }));
        return;
      case "server-error":
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture server error" } }));
        return;
      case "redirect":
        res.writeHead(302, { location: "https://redirect-target.example/v1/chat/completions" });
        res.end();
        return;
      case "malformed":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {this is not json\n\n");
        res.write("<<< not an SSE frame >>>\n\n");
        res.end(sse("[DONE]"));
        return;
      case "fail-before-output":
        destroy("server-destroyed");
        return;
      case "output-then-fail":
        if (wantsStream) {
          res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": id });
          res.write(sse(delta(id, "partial output")));
          record.framesWritten = 1;
        } else {
          // Declares more bytes than it sends, so the body is truncated rather than absent.
          res.writeHead(200, { "content-type": "application/json", "content-length": "512" });
          res.write('{"id":"truncated","choices":[{"message":{"content":"par');
        }
        later(40, () => destroy("server-destroyed"));
        return;
      case "stall-before-headers":
        return;
      case "stall-after-headers":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        return;
      case "slow-stream": {
        res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": id });
        // Finite on purpose (60 frames, ~2.4 s, then a normal terminator): Miniflare's function
        // outbound service does not deliver aborts, so an endless stream would never settle and
        // could not be told apart from a Worker that failed to clean up.
        const tick = () => {
          if (res.destroyed || res.writableEnded) return;
          if (record.framesWritten >= 60) {
            res.write(
              sse({
                id,
                model: "fixture",
                choices: [],
                usage: { prompt_tokens: 2, completion_tokens: 60 },
              }),
            );
            res.end(sse("[DONE]"));
            return;
          }
          res.write(sse(delta(id, `tick-${record.framesWritten}`)));
          record.framesWritten += 1;
          later(40, tick);
        };
        tick();
        return;
      }
    }
  });
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();

  const forScenario = (scenario) => records.filter((record) => record.scenario === scenario);
  return {
    host,
    port,
    origin: `http://${host}:${port}`,
    /** Redacted ledger; a copy, so a test cannot mutate the measurement. */
    records: () => records.map((record) => structuredClone(record)),
    forScenario: (scenario) => forScenario(scenario).map((record) => structuredClone(record)),
    count: (scenario) => (scenario === undefined ? records.length : forScenario(scenario).length),
    connections: () => connections,
    openSockets: () => sockets.size,
    /** Poll a predicate against the live ledger; deterministic wait, not a fixed sleep. */
    async waitFor(predicate, { timeoutMs = 5_000, label = "condition" } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(records)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`fixture waitFor timed out: ${label}`);
    },
    /** True when no stored text contains `secret` — the redaction claim, as a check. */
    holdsNoSecret: (secret) => !JSON.stringify(records).includes(secret),
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
