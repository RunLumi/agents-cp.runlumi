import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  assertRefusalDisclosesNothing,
  decodeBody,
  disclosesLeaseId,
  refusalReason,
  routeShape,
  startClaimRecordingProxy,
} from "./claim-recording-proxy.mjs";

async function fixtureWorker() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body });
      if (req.url.endsWith("/claim")) {
        const first = seen.filter((r) => r.url.endsWith("/claim")).length === 1;
        res.writeHead(first ? 201 : 409, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            first
              ? { lease_id: "lease_aaaaaaaa" }
              : { error: { code: "occurrence_already_claimed", message: "already claimed" } },
          ),
        );
      } else {
        res.writeHead(200);
        res.end("secret-other-route");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, seen };
}

test("forwards unchanged, records only the claim route response, never other routes or request bodies", async () => {
  const worker = await fixtureWorker();
  const proxy = await startClaimRecordingProxy({ target: worker.url });
  try {
    const occ = "occ_0123456789abcdef";
    const claim = `${proxy.origin}/api/v1/devices/automation-occurrences/${occ}/claim`;
    const first = await fetch(claim, { method: "POST", body: "device-secret-body" });
    const second = await fetch(claim, { method: "POST", body: "device-secret-body" });
    const other = await fetch(`${proxy.origin}/api/v1/me`);
    assert.deepEqual([first.status, second.status, other.status], [201, 409, 200]);
    assert.equal(await other.text(), "secret-other-route");
    assert.equal(
      worker.seen[0].body,
      "device-secret-body",
      "the Worker received the request body unchanged",
    );
    const rows = proxy.claimsFor(occ);
    assert.deepEqual(
      rows.map((r) => r.status),
      [201, 409],
    );
    const log = proxy.requestLog();
    assert.equal(log.length, 3);
    assert.deepEqual(
      log.map((row) => row.route),
      [
        `/api/v1/devices/automation-occurrences/occ_*/claim`,
        `/api/v1/devices/automation-occurrences/occ_*/claim`,
        "/api/v1/me",
      ],
    );
    assert.equal(
      JSON.stringify(log).includes("device-secret-body"),
      false,
      "the request log holds shapes only",
    );
    assert.equal(JSON.stringify(rows).includes("secret-other-route"), false);
    assert.equal(
      JSON.stringify(rows).includes("device-secret-body"),
      false,
      "request bodies are never recorded",
    );
    assert.deepEqual(assertRefusalDisclosesNothing(rows[1], { forbidden: ["dev_winner"] }), []);
    assert.equal(refusalReason(rows[1]), "occurrence_already_claimed");
  } finally {
    await proxy.close();
    worker.server.close();
  }
});

test("a refusal that leaks identity or a credential is reported; the deliberate lease id is not a leak", () => {
  const leak = {
    body: JSON.stringify({ error: { code: "conflict", details: { holder: "dvc_12345678abcd" } } }),
  };
  assert.ok(assertRefusalDisclosesNothing(leak, { forbidden: [] }).some((p) => p.includes("dvc_")));
  const token = {
    body: JSON.stringify({ error: { code: "conflict", details: { lease_token: "x" } } }),
  };
  assert.ok(assertRefusalDisclosesNothing(token, { forbidden: [] }).length > 0);
  assert.ok(assertRefusalDisclosesNothing({ body: "nope" }, { forbidden: [] }).length > 0);
  assert.ok(
    assertRefusalDisclosesNothing(
      { body: JSON.stringify({ error: { code: "conflict" }, x: "WINNER-ID" }) },
      { forbidden: ["WINNER-ID"] },
    ).length > 0,
  );
  const designed = {
    body: JSON.stringify({
      error: {
        code: "conflict",
        details: { reason: "occurrence_already_claimed", existing_lease_id: "lse_aaaaaaaabbbb" },
      },
    }),
  };
  assert.deepEqual(assertRefusalDisclosesNothing(designed, { forbidden: [] }), []);
  assert.equal(refusalReason(designed), "occurrence_already_claimed");
  assert.equal(disclosesLeaseId(designed), true);
  assert.equal(
    refusalReason({ body: JSON.stringify({ error: { code: "conflict" } }) }),
    "conflict",
  );
  assert.equal(refusalReason({ body: "x" }), undefined);
});

test("decodeBody undoes gzip and reports an undecodable body instead of mojibake", () => {
  const json = JSON.stringify({ error: { code: "occurrence_already_claimed" } });
  assert.equal(decodeBody([gzipSync(json)], "gzip"), json);
  assert.equal(decodeBody([Buffer.from(json)], undefined), json);
  assert.match(decodeBody([Buffer.from("not gzip")], "gzip"), /undecodable gzip body/);
});

test("routeShape strips identifiers and queries", () => {
  assert.equal(
    routeShape("/api/v1/orgs/org_0123456789abcdef/automations/aut_0123456789abcdef?x=y"),
    "/api/v1/orgs/org_*/automations/aut_*",
  );
});

test("an oversized or bomb-like decoded body is flagged, never validated as a clean refusal", () => {
  assert.match(decodeBody([gzipSync(Buffer.alloc(200_000, 97))], "gzip"), /undecodable gzip body/);
  const big = JSON.stringify({ error: { code: "conflict", pad: "x".repeat(6_000) } });
  assert.ok(
    assertRefusalDisclosesNothing(
      { body: big.slice(0, 4_096), truncated: true },
      { forbidden: [] },
    ).some((p) => p.includes("exceeds the validated bound")),
  );
});

test("the claim barrier forwards both claims of one occurrence together, unchanged, and releases a lone claim after its budget", async () => {
  const arrivals = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      arrivals.push({ at: Date.now(), body });
      res.writeHead(arrivals.length === 1 ? 201 : 409);
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxy = await startClaimRecordingProxy({
    target: `http://127.0.0.1:${server.address().port}`,
    claimBarrierMs: 400,
  });
  try {
    const url = `${proxy.origin}/api/v1/devices/automation-occurrences/occ_0123456789abcdef/claim`;
    const sent = Date.now();
    const first = fetch(url, { method: "POST", body: "A" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(arrivals.length, 0, "the first claim is held while the second has not arrived");
    const second = fetch(url, { method: "POST", body: "B" });
    await Promise.all([first, second]);
    assert.equal(arrivals.length, 2);
    assert.ok(Math.abs(arrivals[0].at - arrivals[1].at) < 100, "released together");
    assert.deepEqual(arrivals.map((a) => a.body).sort(), ["A", "B"]);
    arrivals.length = 0;
    const lone = Date.now();
    await fetch(
      `${proxy.origin}/api/v1/devices/automation-occurrences/occ_fedcba9876543210/claim`,
      { method: "POST", body: "C" },
    );
    assert.ok(
      Date.now() - lone >= 350 && arrivals.length === 1,
      "a lone claim waits its budget then goes through",
    );
    assert.ok(Date.now() - sent < 5_000);
  } finally {
    await proxy.close();
    server.close();
  }
});

test("dropNextResponse lets the Worker commit, withholds exactly one response, then passes through", async () => {
  const committed = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      committed.push(req.url);
      res.writeHead(201);
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxy = await startClaimRecordingProxy({
    target: `http://127.0.0.1:${server.address().port}`,
  });
  try {
    const fault = proxy.dropNextResponse(/\/start$/);
    const url = `${proxy.origin}/api/v1/devices/automation-occurrences/occ_0123456789abcdef/start`;
    await assert.rejects(
      () => fetch(url, { method: "POST", body: "x" }),
      "the client sees a transport failure",
    );
    assert.equal(committed.length, 1, "the Worker still committed the request");
    assert.equal(fault.result.status, 201, "and answered, but the answer never reached the client");
    assert.equal(
      (await fetch(url, { method: "POST", body: "x" })).status,
      201,
      "only one response is dropped",
    );
    assert.equal(proxy.requestLog()[0].status, "dropped_after_201");
  } finally {
    await proxy.close();
    server.close();
  }
});
