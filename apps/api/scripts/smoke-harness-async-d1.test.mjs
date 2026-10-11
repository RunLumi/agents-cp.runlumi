import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// A fake `wrangler` so the subprocess path is exercised without a Worker or a build. The harness reads
// PROBE_WRANGLER at module load, so it is set before the dynamic import.
const dir = mkdtempSync(join(tmpdir(), "async-d1-"));
const argvLog = join(dir, "argv.log");
const fake = join(dir, "wrangler");
writeFileSync(
  fake,
  `#!/bin/sh
printf '%s\\n' "$@" > "${argvLog}"
case "$*" in
  # A grandchild that INHERITS the stdout/stderr pipes and keeps writing a heartbeat to a file the test
  # owns ($HB), the way workerd/esbuild do under a real wrangler. Its pid goes to $PIDFILE.
  *GRAND_TIMEOUT*|*GRAND_FLOOD*)
    ( while :; do echo beat >> "$HB"; printf 'noise-noise-noise\\n'; sleep 0.05; done ) &
    echo $! > "$PIDFILE"
    case "$*" in *GRAND_FLOOD*) head -c 4096 /dev/zero | tr '\\0' 'x' ;; esac
    exec sleep 30 ;;
  *SLEEP*) exec sleep 0.6 ;;
  *HANG*) exec sleep 30 ;;
  *FAIL*) echo "boom token=SECRETCANARY" >&2; exit 3 ;;
esac
echo '[{"results":[{"n":1}],"success":true}]'
`,
);
chmodSync(fake, 0o755);
process.env.PROBE_WRANGLER = fake;

let SmokeHarness;
before(async () => {
  ({ SmokeHarness } = await import("./lib/smoke-harness.mjs"));
});

function probe() {
  const harness = new SmokeHarness({ name: "async d1 test" });
  harness.persistDir = join(dir, "persist");
  harness.registerSecret("SECRETCANARY");
  return harness;
}

test("the async path keeps the event loop servicing timers while wrangler runs; the sync path does not", async () => {
  const harness = probe();
  let asyncTicks = 0;
  let timer = setInterval(() => (asyncTicks += 1), 50);
  await harness.runWranglerAsync(["SLEEP"], "async sleep");
  clearInterval(timer);
  assert.equal(asyncTicks >= 5, true, `expected timers to keep firing, saw ${asyncTicks}`);

  let syncTicks = 0;
  timer = setInterval(() => (syncTicks += 1), 50);
  harness.runWrangler(["SLEEP"], "sync sleep");
  clearInterval(timer);
  assert.equal(syncTicks, 0);
});

test("async failure text matches the sync failure text and is redacted", async () => {
  const harness = probe();
  const syncError = (() => {
    try {
      harness.runWrangler(["FAIL"], "label");
    } catch (error) {
      return error.message;
    }
    return "";
  })();
  const asyncError = await harness.runWranglerAsync(["FAIL"], "label").then(
    () => "",
    (error) => error.message,
  );
  assert.match(asyncError, /^label failed \(3\): /);
  assert.equal(asyncError, syncError);
  assert.equal(asyncError.includes("SECRETCANARY"), false);
});

test("a wedged wrangler fails at the timeout instead of hanging", async () => {
  const harness = probe();
  const startedAt = Date.now();
  await assert.rejects(
    harness.runWranglerAsync(["HANG"], "wedged", { timeoutMs: 200 }),
    /^Error: wedged timed out after 200ms$/,
  );
  assert.equal(Date.now() - startedAt < 5_000, true);
});

test("d1Execute and d1Rows pass identical arguments whichever path is selected", async () => {
  const harness = probe();
  const argvFor = async (mode, run) => {
    harness.useAsyncSubprocesses(mode);
    await run();
    return readFileSync(argvLog, "utf8");
  };
  const syncWrite = await argvFor(false, () => harness.d1Execute("UPDATE t SET a=1", "w"));
  const asyncWrite = await argvFor(true, () => harness.d1Execute("UPDATE t SET a=1", "w"));
  assert.equal(asyncWrite, syncWrite);
  const syncRows = await argvFor(false, () => harness.d1Rows("SELECT 1", "r"));
  const asyncRows = await argvFor(true, () => harness.d1Rows("SELECT 1", "r"));
  assert.equal(asyncRows, syncRows);
  assert.deepEqual(await harness.d1Rows("SELECT 1", "r"), [{ n: 1 }]);
});

test("the harness default is unchanged: other probes stay synchronous unless they opt in", async () => {
  const harness = probe();
  assert.equal(Boolean(harness.asyncSubprocess), false);
});

test("a recorder is told async runs are non-blocking and sync runs are blocking", async () => {
  const { RequestBoundaryRecorder } = await import("./lib/request-boundary.mjs");
  const harness = probe();
  harness.boundary = new RequestBoundaryRecorder();
  await harness.runWranglerAsync(["OK"], "async one");
  harness.runWrangler(["OK"], "sync one");
  const blocks = harness.boundary.snapshot().recent_blocks;
  assert.deepEqual(
    blocks.map((block) => [block.label, block.blocking]),
    [
      ["async one", false],
      ["sync one", true],
    ],
  );
});

test("the account probe runs D1 asynchronously by default and never calls the blocking helper", () => {
  const source = readFileSync(
    new URL("../../../tests/integration/lumi-account.mjs", import.meta.url),
    "utf8",
  );
  // Opt-OUT, not opt-in: reverting to the blocking default must fail a test, not just CI.
  assert.match(source, /useAsyncSubprocesses\(process\.env\.LUMI_PROBE_SYNC_D1 !== "1"\)/);
  assert.equal(source.includes("probe.runWrangler("), false);
});

// --- Owned process tree: timeout and overflow must leave nothing running ------------------------------
//
// Every process below is spawned by these tests from the fake wrangler above and is identified by the pid
// the fixture wrote down. Nothing here signals by name, pkills, or touches any other process.

const posixOnly = { skip: process.platform === "win32" && "process groups are POSIX-only" };
const hbFile = join(dir, "heartbeat.log");
const pidFile = join(dir, "grandchild.pid");

function freshHeartbeat() {
  rmSync(hbFile, { force: true });
  rmSync(pidFile, { force: true });
  process.env.HB = hbFile;
  process.env.PIDFILE = pidFile;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const beats = () => statSync(hbFile, { throwIfNoEntry: false })?.size ?? 0;
const grandchildPid = () => Number(readFileSync(pidFile, "utf8").trim());

/** The grandchild must be provably dead AND silent, not merely absent from one listing. */
async function assertNothingLeftRunning() {
  const pid = grandchildPid();
  assert.equal(alive(pid), false, `grandchild ${pid} is still alive`);
  const written = beats();
  assert.equal(written > 0, true, "positive control: the grandchild really was writing");
  await delay(400);
  assert.equal(beats(), written, "the heartbeat file grew after the call returned");
}

test(
  "CONTROL: killing only the direct child leaves a pipe-holding grandchild writing (the old defect)",
  posixOnly,
  async () => {
    freshHeartbeat();
    // The OLD behaviour, reproduced on purpose: a plain spawn and `child.kill`. If this stops showing a
    // surviving writer, the fixtures below no longer prove anything.
    const child = spawn(fake, ["GRAND_TIMEOUT"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    try {
      await delay(300);
      child.kill("SIGKILL");
      await delay(150);
      const afterKill = beats();
      await delay(400);
      assert.equal(beats() > afterKill, true, "expected the grandchild to keep writing");
    } finally {
      // Cleanup of the exact pid the fixture recorded, a process this test itself started.
      try {
        process.kill(grandchildPid(), "SIGKILL");
      } catch {
        /* already gone */
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }
  },
);

test(
  "timeout stops the whole owned tree: grandchild dead, no writes afterwards, bounded",
  posixOnly,
  async () => {
    freshHeartbeat();
    const harness = probe();
    const startedAt = Date.now();
    await assert.rejects(
      harness.runWranglerAsync(["GRAND_TIMEOUT"], "gt", { timeoutMs: 400 }),
      /^Error: gt timed out after 400ms$/,
    );
    assert.equal(Date.now() - startedAt < 4_000, true);
    await assertNothingLeftRunning();
  },
);

test("overflow stops the whole owned tree too", posixOnly, async () => {
  freshHeartbeat();
  const harness = probe();
  const startedAt = Date.now();
  await assert.rejects(
    harness.runWranglerAsync(["GRAND_FLOOD"], "gf", { timeoutMs: 20_000, maxBytes: 1_000 }),
    /^Error: gf: wrangler output exceeded 1000 bytes$/,
  );
  assert.equal(Date.now() - startedAt < 5_000, true, "overflow must not wait for the timeout");
  await assertNothingLeftRunning();
});

test(
  "the CALLER exits on its own after a timeout: released pipes do not keep Node alive",
  posixOnly,
  async () => {
    freshHeartbeat();
    const driver = join(dir, "driver.mjs");
    const harnessUrl = new URL("./lib/smoke-harness.mjs", import.meta.url).href;
    writeFileSync(
      driver,
      `import { SmokeHarness } from ${JSON.stringify(harnessUrl)};
const harness = new SmokeHarness({ name: "driver" });
harness.persistDir = "unused";
try {
  await harness.runWranglerAsync(["GRAND_TIMEOUT"], "driver", { timeoutMs: 300 });
} catch (error) {
  console.log(error.message);
}
// No process.exit(): the process must end because nothing is left holding it open.
`,
    );
    const startedAt = Date.now();
    const result = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [driver],
        { env: { ...process.env, PROBE_WRANGLER: fake }, timeout: 10_000 },
        (error, stdout) => resolve({ error, stdout }),
      ),
    );
    assert.equal(result.error, null, `driver did not exit cleanly: ${result.error?.message}`);
    assert.match(result.stdout, /^driver timed out after 300ms$/m);
    assert.equal(Date.now() - startedAt < 8_000, true);
    await assertNothingLeftRunning();
  },
);
