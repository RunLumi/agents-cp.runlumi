// Node-only tests for the provider fixture and the deny-by-default forwarder. No workerd, no
// Worker: these prove the test-owned pieces behave before they are trusted as a measurement.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createOutboundForwarder } from "./provider-http-forwarder.mjs";
import { startProviderFixture } from "./provider-http-fixture.mjs";

const SECRET = "sk-fixture-secret-do-not-store";
const PUBLIC_HOST = "provider-http-fixture.example";
const url = (scenario, host = PUBLIC_HOST) => `https://${host}/v1/${scenario}/v1/chat/completions`;

const call = (forwarder, scenario, { stream = false, signal, headers = {} } = {}) =>
  forwarder(
    new Request(url(scenario), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
      body: JSON.stringify({
        model: "m",
        stream,
        max_tokens: 8,
        messages: [{ role: "user", content: "private prompt text" }],
      }),
      signal,
    }),
  );

describe("provider HTTP fixture + forwarder", () => {
  let fixture;
  let forwarder;
  before(async () => {
    fixture = await startProviderFixture({ expectedSecret: SECRET });
    forwarder = createOutboundForwarder({ permittedHost: PUBLIC_HOST, targetOrigin: fixture.origin });
  });
  after(() => fixture.close());
  beforeEach(() => forwarder.reset());

  test("non-streaming and streaming control reach the real socket exactly once each", async () => {
    const json = await call(forwarder, "ok");
    assert.equal(json.status, 200);
    assert.equal((await json.json()).usage.completion_tokens, 1);
    const sse = await call(forwarder, "ok", { stream: true });
    const text = await sse.text();
    assert.match(text, /fixture ok/);
    assert.match(text, /\[DONE\]/);
    const records = fixture.forScenario("ok").slice(-2);
    assert.deepEqual(
      records.map((r) => [r.body.stream, r.outcome]),
      [
        [false, "completed"],
        [true, "completed"],
      ],
    );
    assert.equal(forwarder.denials().length, 0);
  });

  test("auth, body shape and request id are captured redacted", async () => {
    await (await call(forwarder, "ok", { headers: { "x-lumi-request-id": "req_abc" } })).text();
    const record = fixture.forScenario("ok").at(-1);
    assert.equal(record.authorization.present, true);
    assert.equal(record.authorization.scheme, "Bearer");
    assert.equal(record.authorization.matchesExpected, true);
    assert.equal(record.lumiRequestId, "req_abc");
    assert.deepEqual(record.body.messages, [
      { role: "user", chars: 19, sha8: record.body.messages[0].sha8 },
    ]);
    assert.equal(fixture.holdsNoSecret(SECRET), true);
    assert.equal(JSON.stringify(fixture.records()).includes("private prompt text"), false);
  });

  test("a wrong credential is visible as a mismatch, not silently accepted", async () => {
    await (await call(forwarder, "ok", { headers: { authorization: "Bearer other" } })).text();
    assert.equal(fixture.forScenario("ok").at(-1).authorization.matchesExpected, false);
  });

  test("429 and 503 are single calls with the real status", async () => {
    const before429 = fixture.count("rate-limit");
    const r429 = await call(forwarder, "rate-limit");
    assert.equal(r429.status, 429);
    assert.equal(r429.headers.get("retry-after"), "1");
    assert.equal(fixture.count("rate-limit") - before429, 1);
    assert.equal((await call(forwarder, "server-error")).status, 503);
  });

  test("fail-before-output surfaces as a marked 502 with zero response bytes", async () => {
    const response = await call(forwarder, "fail-before-output");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-lumi-fixture-egress"), "upstream-transport-failure");
    assert.ok(forwarder.forwarded().at(-1).upstreamTransportError);
    const record = fixture.forScenario("fail-before-output").at(-1);
    assert.equal(record.outcome, "server-destroyed");
    assert.equal(record.framesWritten, 0);
  });

  test("output-then-fail delivers real output, then the stream errors", async () => {
    const response = await call(forwarder, "output-then-fail", { stream: true });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /partial output/);
    await assert.rejects(async () => {
      for (;;) if ((await reader.read()).done) throw new Error("ended cleanly, expected a fault");
    }, /(?!ended cleanly)/);
    assert.equal(fixture.forScenario("output-then-fail").at(-1).framesWritten, 1);
  });

  test("a truncated non-streaming body is an error, not a short success", async () => {
    const response = await call(forwarder, "output-then-fail");
    await assert.rejects(() => response.text());
  });

  test("a client-side abort reaches the owned socket (cancel control)", async () => {
    const controller = new AbortController();
    const response = await call(forwarder, "slow-stream", { stream: true, signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    const before = fixture.forScenario("slow-stream").at(-1).seq;
    controller.abort();
    await fixture.waitFor(
      (records) => records.find((r) => r.seq === before)?.outcome === "client-closed",
      { label: "server observed the client closing" },
    );
    const record = fixture.records().find((r) => r.seq === before);
    assert.equal(record.outcome, "client-closed");
    assert.ok(record.framesWritten >= 1);
  });

  test("a stalled provider is cut by a timeout signal", async () => {
    // Direct (non-Miniflare) call: the signal IS delivered, the upstream is aborted, and the
    // forwarder reports it as its marked 502 rather than a rejection.
    const response = await call(forwarder, "stall-before-headers", { signal: AbortSignal.timeout(150) });
    assert.equal(response.status, 502);
    assert.equal(forwarder.forwarded().at(-1).requestAborted, true);
    await fixture.waitFor(
      (records) => records.some((r) => r.scenario === "stall-before-headers" && r.outcome === "client-closed"),
      { label: "stalled request closed by client" },
    );
  });

  describe("every unmatched destination is denied and never reaches the fixture", () => {
    const cases = [
      ["plain http to the permitted host", "http://provider-http-fixture.example/v1/ok/v1/chat/completions", "scheme_not_https"],
      ["other public host", url("ok", "api.openai.com"), "host_not_permitted"],
      ["loopback literal", "https://127.0.0.1/v1/ok/v1/chat/completions", "host_not_permitted"],
      ["fixture's own origin", `${"http"}://127.0.0.1:1/v1/ok/v1/chat/completions`, "scheme_not_https"],
      ["host-suffix trick", url("ok", `${PUBLIC_HOST}.evil.test`), "host_not_permitted"],
      ["non-default port", `https://${PUBLIC_HOST}:8443/v1/ok/v1/chat/completions`, "port_not_default"],
      ["wrong path", `https://${PUBLIC_HOST}/v1/models`, "path_not_permitted"],
      ["query string", `https://${PUBLIC_HOST}/v1/ok/v1/chat/completions?x=1`, "path_not_permitted"],
    ];
    for (const [label, target, reason] of cases) {
      test(label, async () => {
        const before = fixture.count();
        const response = await forwarder(new Request(target, { method: "POST", body: "{}" }));
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("x-lumi-fixture-egress"), "denied");
        assert.deepEqual(
          forwarder.denials().map((d) => d.reason),
          [reason],
        );
        assert.equal(fixture.count(), before, "a denied request must not reach the fixture");
      });
    }
    test("userinfo is denied even when the Request constructor would refuse it", async () => {
      // undici's Request rejects credentialed URLs, so hand the forwarder a request-like object.
      const stub = {
        url: `https://user:pw@${PUBLIC_HOST}/v1/ok/v1/chat/completions`,
        method: "POST",
        headers: new Headers(),
        body: null,
      };
      const before = fixture.count();
      assert.equal((await forwarder(stub)).status, 403);
      assert.equal(forwarder.denials()[0].reason, "userinfo");
      assert.equal(fixture.count(), before);
    });
    test("non-POST to the permitted endpoint", async () => {
      const before = fixture.count();
      const response = await forwarder(new Request(url("ok"), { method: "GET" }));
      assert.equal(response.status, 403);
      assert.equal(forwarder.denials()[0].reason, "method_not_permitted");
      assert.equal(fixture.count(), before);
    });
    test("denial ledger omits query strings", async () => {
      await forwarder(new Request(`${url("ok")}?token=SECRET123`, { method: "POST", body: "{}" }));
      assert.equal(JSON.stringify(forwarder.denials()).includes("SECRET123"), false);
    });
  });
});
