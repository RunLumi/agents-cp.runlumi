import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { after, before, test } from "node:test";
import { startProviderFixture } from "./provider-http-fixture.mjs";
import { createNodeOutbound } from "./provider-http-node-outbound.mjs";

const HOST = "provider-http-fixture.example";
let fixture;
let outbound;
let front;
let frontPort;

before(async () => {
  fixture = await startProviderFixture();
  outbound = createNodeOutbound({ permittedHost: HOST, targetOrigin: fixture.origin });
  // The handler is exercised on a plain node server: same (req, res) contract Miniflare provides.
  front = createServer((req, res) => outbound(req, res));
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  frontPort = front.address().port;
});
after(async () => {
  front.closeAllConnections();
  await new Promise((resolve) => front.close(resolve));
  await fixture.close();
});

function call({ host = HOST, path, method = "POST", onResponse }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: frontPort, method, path, headers: { host } }, (res) => {
      if (onResponse) return onResponse(req, res, resolve);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ model: "m", stream: false, messages: [] }));
  });
}

test("permitted host and path reach the fixture", async () => {
  const res = await call({ path: "/v1/ok/v1/chat/completions" });
  assert.equal(res.status, 200);
  assert.equal(fixture.count("ok"), 1);
});

test("deny matrix never reaches the fixture", async () => {
  const before = fixture.count();
  outbound.reset();
  const cases = [
    { host: "other.example", path: "/v1/ok/v1/chat/completions", reason: "host_not_permitted" },
    { method: "PUT", path: "/v1/ok/v1/chat/completions", reason: "method_not_permitted" },
    { path: "/v1/ok/v1/chat/completions?token=x", reason: "path_not_permitted" },
    { path: "/v1/ok/other", reason: "path_not_permitted" },
  ];
  for (const c of cases) assert.equal((await call(c)).status, 403, c.reason);
  assert.deepEqual(outbound.denials().map((d) => d.reason), cases.map((c) => c.reason));
  assert.equal(fixture.count(), before);
  assert.ok(!JSON.stringify(outbound.denials()).includes("token=x"), "query must not be recorded");
});

test("downstream close mid-stream destroys the provider socket", async () => {
  const start = fixture.count();
  await call({
    path: "/v1/slow-stream/v1/chat/completions",
    onResponse: (req, res, resolve) => {
      res.once("data", () => {
        req.destroy();
        resolve({ status: res.statusCode });
      });
    },
  });
  await fixture.waitFor((rs) => rs.length > start && rs[start].outcome !== "pending", { label: "close" });
  const record = fixture.records()[start];
  assert.equal(record.outcome, "client-closed");
  assert.ok(record.framesWritten < 60);
  assert.equal(await outbound.waitFor((l) => l.at(-1)?.upstreamDestroyedBy !== null), true);
});

test("an unreachable provider becomes a marked 502, not a hang", async () => {
  const dead = createNodeOutbound({ permittedHost: HOST, targetOrigin: "http://127.0.0.1:1" });
  const server = createServer((req, res) => dead(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server.address().port, method: "POST", path: "/v1/ok/v1/chat/completions", headers: { host: HOST } },
      (res) => {
        res.resume();
        res.on("end", () => resolve([res.statusCode, res.headers["x-lumi-fixture-egress"]]));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  server.close();
  assert.deepEqual(status, [502, "upstream-transport-failure"]);
});
