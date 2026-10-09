import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { RequestBoundaryRecorder, workerLiveness } from "./lib/request-boundary.mjs";

let server;
let base;
const seenConnectionHeaders = [];

// A sandbox without loopback listen privileges must FAIL here, quickly and with the cause, not hang
// the suite at zero output. `--test-timeout` in package.json bounds every test as a second line.
const SETUP_TIMEOUT_MS = 5_000;

function listenBounded(target) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`listen on 127.0.0.1 did not complete in ${SETUP_TIMEOUT_MS}ms`)),
      SETUP_TIMEOUT_MS,
    );
    target.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(`cannot listen on 127.0.0.1 (${error.code ?? "unknown"}): ${error.message}`),
      );
    });
    target.listen(0, "127.0.0.1", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

before(async () => {
  server = createServer((req, res) => {
    seenConnectionHeaders.push(req.headers.connection ?? "");
    if (req.url.startsWith("/drop")) {
      // A server that closes the socket with the request in flight: the UND_ERR_SOCKET shape.
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await listenBounded(server);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

test("records status and keeps the query string (which can carry credentials) out of the path", async () => {
  const recorder = new RequestBoundaryRecorder().install();
  try {
    const response = await fetch(`${base}/api/health?token=secret`);
    await response.text();
    const [entry] = recorder.snapshot().recent_requests;
    assert.equal(entry.status, 200);
    assert.equal(entry.path, "/api/health");
    assert.equal(JSON.stringify(recorder.snapshot()).includes("secret"), false);
  } finally {
    recorder.uninstall();
  }
});

test("a socket closed with the request in flight is recorded with its cause and socket counters, and still throws", async () => {
  const recorder = new RequestBoundaryRecorder().install();
  try {
    await (await fetch(`${base}/ok`)).text();
    await assert.rejects(fetch(`${base}/drop`, { method: "POST", body: "{}" }));
    const entries = recorder.snapshot().recent_requests;
    const failed = entries.at(-1);
    assert.equal(failed.path, "/drop");
    assert.equal(failed.status, undefined);
    assert.equal(failed.error.causeCode, "UND_ERR_SOCKET");
    assert.equal(typeof failed.error.socket.bytesWritten, "number");
    assert.equal(failed.durationMs >= 0, true);
  } finally {
    recorder.uninstall();
  }
});

test("a thrown error and its cause cannot leak a registered secret or an unregistered query value", async () => {
  const realFetch = globalThis.fetch;
  const thrown = new TypeError("fetch failed https://h.example/p?token=QUERYCANARY&x=1");
  thrown.cause = Object.assign(
    new Error("Cookie lumi_session=SECRETCANARY on http://h.example/q?k=QUERYCANARY#QUERYCANARY"),
    { code: "UND_ERR_SOCKET" },
  );
  globalThis.fetch = async () => {
    throw thrown;
  };
  const recorder = new RequestBoundaryRecorder({
    redact: (text) => text.replaceAll("SECRETCANARY", "[redacted]"),
  }).install();
  try {
    // The ORIGINAL error object is rethrown: observation must not replace or wrap the failure.
    await assert.rejects(
      fetch("http://h.example/api/x?token=QUERYCANARY"),
      (error) => error === thrown,
    );
    const serialized = JSON.stringify(recorder.snapshot());
    assert.equal(serialized.includes("SECRETCANARY"), false);
    assert.equal(serialized.includes("QUERYCANARY"), false);
    const [entry] = recorder.snapshot().recent_requests;
    assert.equal(entry.path, "/api/x");
    assert.equal(entry.error.causeCode, "UND_ERR_SOCKET");
    assert.match(entry.error.causeMessage, /lumi_session=\[redacted\]/);
    // One attempt only: nothing here retries.
    assert.equal(recorder.snapshot().requests_seen, 1);
  } finally {
    recorder.uninstall();
    globalThis.fetch = realFetch;
  }
});

test("liveness redacts the health-probe error text", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect failed SECRETCANARY");
  };
  try {
    const evidence = await workerLiveness({
      child: { pid: 0x7ffffffe, exitCode: null, signalCode: null },
      baseUrl: "http://127.0.0.1:1",
      redact: (text) => text.replaceAll("SECRETCANARY", "[redacted]"),
    });
    assert.equal(JSON.stringify(evidence).includes("SECRETCANARY"), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an unavailable ps is reported as unavailable, never as an empty group", async () => {
  const evidence = await workerLiveness({
    child: { pid: 0, exitCode: null, signalCode: null },
    baseUrl: "http://127.0.0.1:1",
  });
  assert.equal(evidence.process_group.available, false);
  assert.equal("members" in evidence.process_group, false);
  assert.match(evidence.process_group.semantics, /best effort/);
});

test("each request records which socket carried it, and how many requests that socket had already carried", async () => {
  const recorder = new RequestBoundaryRecorder().install();
  try {
    for (const name of ["a", "b", "c"]) await (await fetch(`${base}/${name}`)).text();
    const snapshot = recorder.snapshot();
    // The channel must have reported something, or "no connection data" would pass silently.
    assert.equal(snapshot.connection_events.send_events_seen >= 3, true);
    assert.equal(snapshot.connection_events.opened_total >= 1, true);
    // The pool may spread requests over several sockets; the invariant is that the recorded count of
    // prior requests equals how many EARLIER recorded requests used the same local port.
    const seen = new Map();
    for (const entry of snapshot.recent_requests) {
      const port = entry.connection.localPort;
      assert.equal(typeof port, "number");
      assert.equal(entry.connection.priorRequestsOnSocket, seen.get(port) ?? 0);
      seen.set(port, (seen.get(port) ?? 0) + 1);
      assert.equal(entry.responseConnection, "keep-alive");
    }
  } finally {
    recorder.uninstall();
  }
});

test("blocking time inside the idle gap before a request is attributed to it", async () => {
  let clock = 1_000;
  const recorder = new RequestBoundaryRecorder({ now: () => clock }).install();
  try {
    await (await fetch(`${base}/first`)).text();
    const firstEnded = recorder.lastResponseAt;
    recorder.noteBlock("wrangler d1 execute", firstEnded + 200, firstEnded + 1_700);
    clock = firstEnded + 2_000;
    await (await fetch(`${base}/second`)).text();
    const second = recorder.snapshot().recent_requests.at(-1);
    assert.equal(second.idleBeforeMs, 2_000);
    assert.equal(second.blockedInIdleMs, 1_500);
  } finally {
    recorder.uninstall();
  }
});

test("non-blocking subprocess time explains the idle gap but is not counted as a blocked loop", async () => {
  let clock = 5_000;
  const recorder = new RequestBoundaryRecorder({ now: () => clock }).install();
  try {
    await (await fetch(`${base}/first`)).text();
    const firstEnded = recorder.lastResponseAt;
    recorder.noteBlock("async wrangler", firstEnded + 100, firstEnded + 1_300, false);
    clock = firstEnded + 1_500;
    await (await fetch(`${base}/second`)).text();
    const second = recorder.snapshot().recent_requests.at(-1);
    assert.equal(second.blockedInIdleMs, 0);
    assert.equal(second.subprocessInIdleMs, 1_200);
    assert.equal(recorder.snapshot().recent_blocks.at(-1).blocking, false);
  } finally {
    recorder.uninstall();
  }
});

test("the fresh-socket A/B switch sends Connection: close and nothing else changes", async () => {
  const recorder = new RequestBoundaryRecorder({ freshSockets: true }).install();
  try {
    seenConnectionHeaders.length = 0;
    const init = { method: "POST", body: "{}", headers: { "x-a": "1" } };
    await (await fetch(`${base}/ab`, init)).text();
    assert.equal(seenConnectionHeaders.at(-1), "close");
  } finally {
    recorder.uninstall();
  }
});

test("liveness reports a dead Worker without throwing", async () => {
  const evidence = await workerLiveness({
    child: { pid: 0x7ffffffe, exitCode: 1, signalCode: null },
    baseUrl: "http://127.0.0.1:1",
    consoleTail: "token=abc",
    redact: (text) => text.replaceAll("abc", "[redacted]"),
  });
  assert.equal(evidence.wrangler_pid_alive, false);
  assert.equal(evidence.fresh_connection_health.ok, false);
  assert.equal(evidence.worker_console_tail, "token=[redacted]");
});
