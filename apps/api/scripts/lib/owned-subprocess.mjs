// Run one subprocess to completion without ever leaving its descendants behind.
//
// Why this exists: `runWranglerAsync` used to resolve a timeout right after `child.kill("SIGKILL")`. That
// kills only the direct child. A descendant that inherited the stdout/stderr pipes (wrangler spawns
// workerd and esbuild) keeps running, keeps the pipes open, can keep this Node process alive, and can
// keep WRITING to the probe's local D1 after the probe has already reported failure. A bounded wait that
// leaves the thing it bounded running is not bounded.
//
// Contract:
//   * POSIX: the child is spawned `detached` (its own session and process group) and every stop is a
//     SIGKILL to the whole group, through the caller's `killTree` (the harness's existing owned-process-
//     group pattern; this module never signals anything it did not spawn and never pkills by name).
//     After a stop it POLLS until the group is gone, bounded by `reapMs`, so a return means "confirmed
//     stopped" or an explicit `treeStopped: false`. It never claims a stop it did not observe.
//   * Windows: process groups are not available here, so only the direct child can be killed and the
//     tree cannot be confirmed: `treeStopped` is "unsupported". Callers must not rely on descendant
//     cleanup there. The integration probes run on Linux/macOS.
//   * The pipes are destroyed on timeout and on overflow, so they cannot keep this process alive.
//   * The output budget is counted in RAW BYTES across stdout and stderr together, and decoding happens
//     once at the end so a multi-byte character split across chunks cannot be miscounted or mangled.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const POLL_MS = 25;

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function confirmStopped(child, reapMs) {
  if (process.platform === "win32") return "unsupported";
  const deadline = Date.now() + reapMs;
  while (Date.now() < deadline) {
    if (!groupAlive(child.pid)) return true;
    await delay(POLL_MS);
  }
  return !groupAlive(child.pid);
}

/**
 * @param {{
 *   command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
 *   timeoutMs: number, maxBytes: number, reapMs?: number,
 *   killTree: (child: import("node:child_process").ChildProcess) => void,
 * }} options
 * @returns {Promise<{
 *   stdout: string, stderr: string, status: number | null,
 *   failure: null | "timeout" | "overflow", error: Error | null,
 *   treeStopped: true | false | "unsupported", bytes: number, pid: number | null,
 * }>}
 */
export async function runOwnedSubprocess({
  command,
  args,
  cwd,
  env,
  timeoutMs,
  maxBytes,
  reapMs = 2_000,
  killTree,
}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const out = [];
  const err = [];
  let bytes = 0;
  let failure = null;
  const stop = () => {
    killTree(child);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const outcome = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      failure = "timeout";
      stop();
      // Not waiting for `close`: a descendant holding the pipes could delay it indefinitely.
      finish({});
    }, timeoutMs);
    const collect = (sink) => (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = "overflow";
        stop();
        finish({});
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.once("error", (error) => finish({ error }));
    child.once("close", (status) => finish({ status }));
  });
  // Whatever happened, nothing owned may outlive the call: on success there are normally no survivors and
  // the group check is instant; on failure the group was just signalled and this confirms it.
  if (!failure && process.platform !== "win32" && groupAlive(child.pid)) stop();
  const treeStopped = child.pid ? await confirmStopped(child, reapMs) : true;
  return {
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    status: outcome.status ?? null,
    failure,
    error: outcome.error ?? null,
    treeStopped,
    bytes,
    pid: child.pid ?? null,
  };
}
