import assert from "node:assert/strict";

const origin = process.env.PRODUCTION_ORIGIN ?? "https://agents-cp.runlumi.app";
assert.ok(["https:", "http:"].includes(new URL(origin).protocol));
if (new URL(origin).protocol === "http:") {
  assert.equal(new URL(origin).hostname, "localhost");
}
async function request(path, options = {}) {
  const response = await fetch(new URL(path, origin), {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  return { response, body: await response.text() };
}
for (const path of ["/", "/settings"]) {
  const { response, body } = await request(path, {
    headers: { "Sec-Fetch-Mode": "navigate" },
  });
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("content-type"), /text\/html/, path);
  assert.match(body, /id="root"/, path);
  assert.match(body, /\/assets\/[^"']+\.js/, path);
  console.log(`PASS SPA ${path}`);
}
const { response: health, body: healthBody } = await request("/api/health", {
  headers: { "Sec-Fetch-Mode": "navigate" },
});
assert.equal(health.status, 200);
assert.match(health.headers.get("content-type"), /application\/json/);
assert.equal(JSON.parse(healthBody).status, "ok");
console.log("PASS Rust health, including browser navigation");
const { response: unknown, body: unknownBody } = await request("/api/not-a-route");
assert.equal(unknown.status, 404);
assert.doesNotMatch(unknownBody, /id="root"/);
console.log("PASS unknown API does not fall back to SPA");
const { response: protectedResponse } = await request("/api/v1/account/sessions");
assert.equal(protectedResponse.status, 401);
console.log("PASS anonymous account access refused");
const { response: internal } = await request("/api/v1/_internal/foundation-checks");
assert.equal(internal.status, 404);
console.log("PASS development-only route absent");
