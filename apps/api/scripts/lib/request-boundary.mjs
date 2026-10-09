// Bounded request-boundary and Worker-liveness evidence for integration probes.
//
// Why this exists: two exact-head CI runs of tests/integration/lumi-account.mjs died with
// `TypeError: fetch failed / SocketError: other side closed (UND_ERR_SOCKET)` at DIFFERENT post-D1
// requests, and the probe's cleanup killed the Worker before anything about it was printed. A socket
// error says one side of a connection went away; it does not say which side, why, or whether the
// Worker was still alive. This records what separates those explanations:
//
//   * every request's boundary: start, duration, status or error code, and the socket byte counters
//     undici attaches to the error (a socket that carried many requests was REUSED; one that never
//     read a byte was fresh);
//   * the idle gap before each request and how much of it the event loop spent BLOCKED inside a
//     synchronous wrangler call (the only thing in this probe that stops undici servicing sockets);
//   * on failure, whether the Worker process group is alive, what its console said last, and whether
//     a brand-new connection to it succeeds right now.
//
// It never retries, replays, or mutates anything: the liveness check is a single read-only GET of
// /api/health on a connection that is closed afterwards.

import { spawnSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";

const RING = 64;
const TAIL = 4_000;

export class RequestBoundaryRecorder {
  /**
   * @param {{ freshSockets?: boolean, now?: () => number }} [options]
   *   `freshSockets` sends `Connection: close` so no pooled socket can be reused. It is an A/B
   *   switch for diagnosis, not a repair: if the failure survives it, the Worker closed a socket
   *   that had a request in flight.
   */
  constructor({ freshSockets = false, now = () => Date.now(), redact = (text) => text } = {}) {
    this.freshSockets = freshSockets;
    this.now = now;
    // The caller's secret-aware redactor (the harness's `redact`). `sanitize` runs it AFTER stripping
    // URL query strings, so a credential is removed whether it is a registered secret or only a query.
    this.redact = redact;
    this.entries = [];
    this.blocks = [];
    this.seq = 0;
    this.lastResponseAt = 0;
    this.inFlight = new Map();
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.realFetch = null;
  }

  /** Replace `globalThis.fetch` so the client under test is observed through the same dispatcher. */
  install() {
    if (this.realFetch) return this;
    this.realFetch = globalThis.fetch;
    this.loop.enable();
    const record = this;
    globalThis.fetch = function observedFetch(input, init = {}) {
      return record.observe(input, init);
    };
    return this;
  }

  uninstall() {
    if (!this.realFetch) return;
    globalThis.fetch = this.realFetch;
    this.realFetch = null;
    this.loop.disable();
  }

  /** A synchronous child-process call blocks undici's sockets; record how long. */
  noteBlock(label, startedAt, endedAt) {
    this.blocks.push({ label, startedAt, endedAt });
    if (this.blocks.length > RING) this.blocks.shift();
  }

  blockedBetween(from, to) {
    let total = 0;
    for (const block of this.blocks) {
      const start = Math.max(block.startedAt, from);
      const end = Math.min(block.endedAt, to);
      if (end > start) total += end - start;
    }
    return total;
  }

  async observe(input, init) {
    const startedAt = this.now();
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init.method ?? (input instanceof Request ? input.method : "GET"));
    const idleBeforeMs = this.lastResponseAt ? startedAt - this.lastResponseAt : null;
    const entry = {
      seq: (this.seq += 1),
      method,
      // Path only: query strings and bodies can carry credentials.
      path: url.pathname,
      startedAt,
      idleBeforeMs,
      blockedInIdleMs: this.lastResponseAt
        ? this.blockedBetween(this.lastResponseAt, startedAt)
        : 0,
      concurrentInFlight: this.inFlight.size,
    };
    this.inFlight.set(entry.seq, entry);
    let nextInit = init;
    if (this.freshSockets) {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : {}));
      headers.set("Connection", "close");
      nextInit = { ...init, headers };
    }
    try {
      const response = await this.realFetch(input, nextInit);
      entry.status = response.status;
      return response;
    } catch (error) {
      const cause = error?.cause ?? {};
      entry.error = {
        message: this.sanitize(error?.message ?? error),
        causeCode: cause.code ? this.sanitize(cause.code, 48) : null,
        causeMessage: cause.message ? this.sanitize(cause.message) : null,
        socket: cause.socket
          ? {
              localPort: cause.socket.localPort ?? null,
              bytesWritten: cause.socket.bytesWritten ?? null,
              bytesRead: cause.socket.bytesRead ?? null,
              remoteAddress: cause.socket.remoteAddress ?? null,
            }
          : null,
      };
      throw error;
    } finally {
      const endedAt = this.now();
      entry.durationMs = endedAt - startedAt;
      this.lastResponseAt = endedAt;
      this.inFlight.delete(entry.seq);
      this.entries.push(entry);
      if (this.entries.length > RING) this.entries.shift();
    }
  }

  /**
   * Free text from a thrown error is the only untrusted string this recorder stores. Strip any URL's
   * query/fragment first (a registered-secret redactor cannot know about an unregistered query value),
   * then apply the caller's redactor, then bound the length. Truncation is last so it cannot cut a
   * secret in half and leave a prefix the redactor no longer recognises.
   */
  sanitize(value, max = 160) {
    const noQuery = String(value).replace(
      /(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi,
      "$1?[redacted]",
    );
    return this.redact(noQuery).slice(0, max);
  }

  snapshot() {
    return {
      node: process.version,
      fresh_sockets: this.freshSockets,
      requests_seen: this.seq,
      recent_requests: this.entries.slice(-24),
      recent_blocks: this.blocks.slice(-12).map((b) => ({
        label: b.label,
        durationMs: b.endedAt - b.startedAt,
        endedAt: b.endedAt,
      })),
      event_loop_delay_max_ms: Math.round(this.loop.max / 1e6),
    };
  }
}

/**
 * Best-effort listing of processes the Worker's wrangler may have spawned.
 *
 * What `ps -g <pid>` selects is platform-dependent: procps (Linux) selects by SESSION id (or group
 * name), which equals the pid here only because the Worker is spawned `detached` (setsid); BSD/macOS
 * `ps -g` means something else. So this is a session-member listing on Linux and nothing reliable
 * elsewhere. `available: false` means ps could not answer (missing, timed out, non-zero exit) and says
 * NOTHING about whether the Worker is alive. An empty or short `members` list is not evidence of a
 * crash either: use `wrangler_pid_alive`, the exit code/signal, and the console tail for that.
 */
function processGroup(pid) {
  const semantics = "ps -g <pid>: Linux procps session members; platform-dependent, best effort";
  if (!pid) return { available: false, reason: "no pid", semantics };
  const result = spawnSync("ps", ["-g", String(pid), "-o", "pid=,ppid=,etime=,stat=,comm="], {
    encoding: "utf8",
    timeout: 3_000,
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      reason: String(result.error?.code ?? `exit ${result.status}`).slice(0, 60),
      semantics,
    };
  }
  const lines = String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { available: true, semantics, members: lines.slice(0, 12), member_count: lines.length };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Is the Worker alive, and does a BRAND-NEW connection to it work right now?
 *
 * `child` is the `wrangler dev` child. A read-only GET /api/health on a closed-after-use connection is
 * the only request made here; it is never a replay of a request that failed.
 */
export async function workerLiveness({ child, baseUrl, consoleTail, redact = (text) => text }) {
  const out = {
    wrangler_pid: child?.pid ?? null,
    wrangler_exit_code: child?.exitCode ?? null,
    wrangler_signal: child?.signalCode ?? null,
    wrangler_pid_alive: pidAlive(child?.pid),
    process_group: processGroup(child?.pid),
    fresh_connection_health: null,
    worker_console_tail: redact(String(consoleTail ?? "")).slice(-TAIL),
  };
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(3_000),
    });
    await response.arrayBuffer();
    out.fresh_connection_health = { ok: response.ok, status: response.status };
  } catch (error) {
    out.fresh_connection_health = {
      ok: false,
      error: redact(String(error?.cause?.code ?? error?.message ?? error)).slice(0, 120),
    };
  }
  out.fresh_connection_health.durationMs = Date.now() - startedAt;
  return out;
}
