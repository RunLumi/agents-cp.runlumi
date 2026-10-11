import assert from "node:assert/strict";
import test from "node:test";
import { awaitClaims, claimOutcomes, summarizeClaims } from "./automation-claim-console.mjs";

const json = (id, status) =>
  `{"event":"http_request","request_id":"${id}","correlation_id":"${id}","method":"POST","route":"/api/v1/devices/automation-occurrences/{occurrence_id}/claim","status":${status},"duration_ms":6}`;
const proxy = (occ, status) => `[wrangler-ProxyWorker:info] POST /api/v1/devices/automation-occurrences/${occ}/claim ${status} Created (26ms)`;
const text = [json("req_a", 201), "noise", proxy("occ_1", 201), json("req_b", 409), proxy("occ_1", 409), json("req_c", 201), proxy("occ_2", 201)].join("\n");

test("one accepted and one refused claim for the contested occurrence, with paired correlation ids", () => {
  const summary = summarizeClaims(claimOutcomes(text, "occ_1"));
  assert.deepEqual(summary, { accepted: 1, refused: 1, other: [], correlationIds: ["req_a", "req_b"] });
});

test("an occurrence nobody else claimed shows no refusal (positive control for the reader)", () => {
  assert.deepEqual(summarizeClaims(claimOutcomes(text, "occ_2")), { accepted: 1, refused: 0, other: [], correlationIds: ["req_c"] });
});

test("a capture whose lines do not pair 1:1 keeps statuses but withholds correlation ids", () => {
  const unpaired = text.replace(json("req_b", 409), "");
  const summary = summarizeClaims(claimOutcomes(unpaired, "occ_1"));
  assert.equal(summary.refused, 1);
  assert.deepEqual(summary.correlationIds, []);
});

test("unknown occurrence and empty capture produce no claims", () => {
  assert.deepEqual(claimOutcomes(text, "occ_x"), []);
  assert.deepEqual(claimOutcomes("", "occ_1"), []);
});

test("awaitClaims waits for lazily flushed lines and gives up inside its budget", async () => {
  let reads = 0;
  const late = () => (++reads < 3 ? "" : text);
  const found = await awaitClaims(late, "occ_1", { acceptedMs: 500, refusedMs: 500, everyMs: 5 });
  assert.equal(found.accepted, 1);
  assert.equal(found.refused, 1);
  const started = Date.now();
  const none = await awaitClaims(() => "", "occ_1", { acceptedMs: 30, refusedMs: 30, everyMs: 5 });
  assert.deepEqual([none.accepted, none.refused], [0, 0]);
  assert.ok(Date.now() - started < 1_000, "a missing claim does not wait beyond its budget");
});
