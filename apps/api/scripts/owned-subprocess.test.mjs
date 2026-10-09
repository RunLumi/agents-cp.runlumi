import assert from "node:assert/strict";
import { test } from "node:test";
import { runOwnedSubprocess } from "./lib/owned-subprocess.mjs";

// The same owned-process-group pattern as SmokeHarness.killTree, restated so these tests exercise the
// helper alone. It signals only the group of a child the helper itself spawned.
const killTree = (child) => {
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const node = (script, options = {}) =>
  runOwnedSubprocess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 10_000,
    maxBytes: 1_000,
    killTree,
    ...options,
  });

test("the byte budget counts RAW BYTES: multi-byte text cannot slip under it chunk by chunk", async () => {
  // 400 x "é" is 800 bytes but only 400 UTF-16 units; then 400 more bytes. The old accounting added the
  // decoded string's length (400) to raw chunk bytes (400) = 800 < 1000 and accepted 1200 bytes.
  const result = await node(
    `process.stdout.write("é".repeat(400)); setTimeout(() => process.stdout.write("a".repeat(400)), 150);`,
  );
  assert.equal(result.failure, "overflow");
});

test("FIXTURE MODEL: the previous accounting would have accepted the input the test above rejects", () => {
  // The previous code kept `stdout` as a decoded string and tested `stdout.length + chunk.length > limit`,
  // adding UTF-16 units to raw bytes. Modelled here on the same two chunks, as a fixture and not as a
  // mutation of the product source, to show the byte-budget fixture discriminates.
  const limit = 1_000;
  let stdoutUnits = 0;
  let accepted = true;
  for (const chunk of [Buffer.from("é".repeat(400)), Buffer.from("a".repeat(400))]) {
    if (stdoutUnits + chunk.length > limit) accepted = false;
    else stdoutUnits += chunk.toString("utf8").length;
  }
  assert.equal(accepted, true, "the old model accepts 1200 bytes against a 1000-byte budget");
  assert.equal(Buffer.byteLength("é".repeat(400) + "a".repeat(400)), 1_200);
});

test("the budget is exact at the boundary: 1000 bytes pass, 1001 overflow", async () => {
  const exact = await node(`process.stdout.write("é".repeat(300) + "a".repeat(400));`);
  assert.equal(exact.failure, null);
  assert.equal(exact.bytes, 1_000);
  assert.equal(exact.stdout, "é".repeat(300) + "a".repeat(400));

  const over = await node(`process.stdout.write("é".repeat(300) + "a".repeat(401));`);
  assert.equal(over.failure, "overflow");
});

test("stdout and stderr share one budget", async () => {
  const result = await node(
    `process.stdout.write("a".repeat(600)); process.stderr.write("b".repeat(600));`,
  );
  assert.equal(result.failure, "overflow");
});

test("a multi-byte character split across chunks is decoded intact", async () => {
  const result = await node(
    `const b = Buffer.from("é"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 120);`,
  );
  assert.equal(result.failure, null);
  assert.equal(result.stdout, "é");
  assert.equal(result.bytes, 2);
});

test(
  "a stop that cannot be confirmed is reported as unconfirmed, never as clean",
  { skip: process.platform === "win32" },
  async () => {
    const startedAt = Date.now();
    // `killTree` deliberately does nothing, so the group survives the reap window.
    const result = await node(`setTimeout(() => {}, 30_000);`, {
      timeoutMs: 200,
      reapMs: 300,
      killTree: () => {},
    });
    try {
      assert.equal(result.failure, "timeout");
      assert.equal(result.treeStopped, false);
      const elapsed = Date.now() - startedAt;
      assert.equal(
        elapsed < 3_000,
        true,
        `must stay bounded even when the stop fails (${elapsed}ms)`,
      );
    } finally {
      // Cleanup of the group this test spawned.
      process.kill(-result.pid, "SIGKILL");
    }
  },
);

test(
  "on Windows the tree cannot be confirmed and says so",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await node(`setTimeout(() => {}, 30_000);`, { timeoutMs: 200 });
    assert.equal(result.treeStopped, "unsupported");
  },
);

test("a spawn failure is reported as an error, not a hang", async () => {
  const result = await runOwnedSubprocess({
    command: "/nonexistent/definitely-not-wrangler",
    args: [],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5_000,
    maxBytes: 1_000,
    killTree,
  });
  assert.equal(result.error?.code, "ENOENT");
  assert.equal(result.failure, null);
});
