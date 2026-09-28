#!/usr/bin/env node
// Shared harness for the runtime smoke probes that drive a real development Worker.
//
// WHY THIS EXISTS
//
// Two probes need the same thing: a real local D1 with every migration applied, a real
// `wrangler dev --local` Worker, a real signed-in user, and the CSRF and idempotency
// headers a browser client would send. The first version of that was inline in
// `p06-data-smoke.mjs`, and the second probe would have had to copy four hundred
// lines of it. A copy is worse than a shared module here for one specific reason:
// when the harness was wrong, and it was wrong several times while
// `p06-data-smoke.mjs` was being built, a copy would have been wrong in a second
// place too.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It has no opinion about what a probe is asserting. Every `expect`/`fail` is
// recorded in the calling probe's own tally, so a probe that fails reports its own
// name and count, not the harness's.
//
// The queue note: the P01 outbox is drained by the `*/1 * * * *` cron
// (`run_scheduled_sweep`), not by the request path -- no mutation publishes to
// `OUTBOX_QUEUE` except the foundation-check demo route. `wrangler dev
// --test-scheduled` exposes `/__scheduled` so a probe can fire that sweep on
// demand instead of waiting a wall-clock minute, which is what
// `waitForD1` does once before it gives up.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const apiDir = resolve(here, "..", "..");

/**
 * Where wrangler is, resolvable from OUTSIDE this tree.
 *
 * `PROBE_WRANGLER` is the same override `p02-passkey-smoke.mjs` and
 * `p05-smoke.mjs` already take (`P02_PASSKEY_WRANGLER`, `P05_WRANGLER`), and it
 * exists for one reason: the mutation campaign runs a probe against a MUTATED
 * COPY of the repository, and that copy carries no `node_modules` of its own.
 *
 * Without it this harness hard-failed on the mutant for the VFY-011 case with
 * "wrangler is not installed at <scratch>/apps/api/node_modules/.bin/wrangler"
 * -- so the campaign reported `KILLED_FOR_THE_WRONG_REASON`, which is correct
 * and unhelpful: the case stopped testing what it was written to test because of
 * a missing binary path, and the tally said nothing about the product.
 *
 * The first version of this harness had no override and nothing here mentioned
 * the campaign, so the regression was invisible until a case actually used it.
 */
const wranglerBin = process.env.PROBE_WRANGLER ?? join(apiDir, "node_modules", ".bin", "wrangler");

/**
 * A probe's own state: its tally, its services, its redaction set.
 *
 * Each probe constructs one. Nothing here is module-global, so two probes in the
 * same process could not read each other's passes -- which is the failure a
 * shared harness is most likely to introduce.
 */
export class SmokeHarness {
  constructor({ name, workerLogTail = 24_000 } = {}) {
    this.name = name;
    this.workerLogTail = workerLogTail;
    this.baseUrl = "";
    this.persistDir = "";
    this.worker = null;
    this.persistOwned = true;
    this.stage = "startup";
    this.passes = [];
    this.failures = [];
    this.secrets = new Set();
    this.services = [];
    this.skipped = [];

    // Bind every method to this instance, so a probe may destructure them and call
    // them bare. Destructuring a class method and calling it without its receiver
    // runs it with `this === undefined`, and the first thing any of these methods
    // touches is `this.passes` or `this.client` -- so the failure is a baffling
    // "Cannot read properties of undefined" deep inside a probe, two files away from
    // the line that caused it. Binding once, here, makes the destructuring pattern
    // safe by construction instead of by remembering.
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(this))) {
      if (name === "constructor") continue;
      const value = this[name];
      if (typeof value === "function") this[name] = value.bind(this);
    }
  }

  // --- redaction -----------------------------------------------------------

  redact(value) {
    let out = String(value);
    for (const secret of this.secrets) {
      if (secret) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  registerSecret(value) {
    if (typeof value === "string" && value.length > 0) this.secrets.add(value);
  }

  /** Bound a value for a failure message: no secrets, no unbounded strings. */
  sanitize(value, key = "", depth = 0) {
    if (depth > 4) return "[truncated]";
    if (Array.isArray(value))
      return value.slice(0, 5).map((item) => this.sanitize(item, key, depth + 1));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.sanitize(v, k, depth + 1);
      return out;
    }
    if (typeof value === "string") {
      if (/challenge|code|token|secret|cookie|password/i.test(key)) return "[redacted]";
      return value.length > 160 ? `${value.slice(0, 160)}…` : value;
    }
    return value;
  }

  // --- the tally -----------------------------------------------------------

  pass(name, detail = "") {
    this.passes.push(name);
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  }

  fail(name, detail = "") {
    this.failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  — ${this.redact(detail)}` : ""}`);
  }

  /** Record a limitation rather than a pass or a failure. */
  skip(name, reason) {
    this.skipped.push({ name, reason });
    console.log(`  SKIP  ${name}  — ${reason}`);
  }

  expect(name, condition, detail = "") {
    if (condition) this.pass(name, detail);
    else this.fail(name, detail || "condition was false");
    return condition;
  }

  expectStatus(name, result, statuses, reasons = []) {
    const wanted = Array.isArray(statuses) ? statuses : [statuses];
    const statusOk = wanted.includes(result.status);
    const reason = this.reasonOf(result);
    const reasonOk = reasons.length === 0 || (reason !== null && reasons.includes(reason));
    if (statusOk && reasonOk) {
      this.pass(name, `status=${result.status}${reason ? ` reason=${reason}` : ""}`);
      return true;
    }
    this.fail(
      name,
      `status=${result.status} reason=${reason} (wanted ${wanted.join("/")}` +
        `${reasons.length ? ` reason in ${reasons.join(",")}` : ""}) — ${this.redact(
          JSON.stringify(this.sanitize(result.payload)) ?? result.text,
        ).slice(0, 400)}`,
    );
    return false;
  }

  requirePayload(result, name) {
    if (result.payload === undefined) {
      this.fail(`${name} returned no JSON payload`, result.text?.slice(0, 200));
      return {};
    }
    return result.payload;
  }

  /**
   * The error envelope puts the stable machine reason at `details.reason`:
   *   { error: { code, message, request_id, details: { reason: "slug_invalid" } } }
   * Reading `payload.reason` or `payload.error.reason` -- both undefined there --
   * makes every reason assertion in a probe vacuous, which is how the first
   * version of `p06-data-smoke.mjs` read null from every denial it checked.
   */
  reasonOf(result) {
    const payload = result.payload ?? {};
    return (
      payload.details?.reason ??
      payload.error?.details?.reason ??
      payload.error?.reason ??
      payload.reason ??
      null
    );
  }

  statusIs(result, statuses, reasons = []) {
    const wanted = Array.isArray(statuses) ? statuses : [statuses];
    const reason = this.reasonOf(result);
    return wanted.includes(result.status) && (reasons.length === 0 || reasons.includes(reason));
  }

  idempotencyKey(label) {
    return `${this.nonce}-${label}`;
  }

  assertId(name, value, prefix) {
    if (typeof value === "string" && value.startsWith(`${prefix}_`)) {
      this.pass(name, value);
      return true;
    }
    this.fail(name, `expected an opaque ${prefix}_… identifier, got ${JSON.stringify(value)}`);
    return false;
  }

  get nonce() {
    if (!this._nonce) {
      this._nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    }
    return this._nonce;
  }

  // --- HTTP ----------------------------------------------------------------

  /**
   * One signed-in browser-equivalent client.
   *
   * A cookie jar rather than a token, because the CSRF cookie and the session
   * cookie have to move together: a probe that sent the session without the CSRF
   * token would be testing a client the product does not have.
   */
  client() {
    return new CookieJar();
  }

  async request(jar, method, routePath, body, extraHeaders = {}, options = {}) {
    const headers = { Accept: "application/json", ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.raw) headers.Accept = "*/*";
    const cookie = jar?.header?.();
    if (cookie) headers.Cookie = cookie;
    const init = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    };
    let response;
    try {
      response = await fetch(`${this.baseUrl}${routePath}`, init);
    } catch (error) {
      throw new Error(
        `${this.stage}: ${method} ${routePath} transport failure: ${this.redact(error.message)}`,
      );
    }
    jar?.absorb?.(response);
    const text = await response.text();
    let payload;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }
    return {
      method,
      path: routePath,
      status: response.status,
      payload,
      text,
      headers: response.headers,
    };
  }

  browserHeaders(jar, extra = {}) {
    return { "X-CSRF-Token": jar.cookies.get("lumi_csrf") ?? "", ...extra };
  }

  browserMutation(jar, label, extra = {}) {
    return this.browserHeaders(jar, { "Idempotency-Key": this.idempotencyKey(label), ...extra });
  }

  // --- D1 ------------------------------------------------------------------

  runWrangler(args, label) {
    const result = spawnSync(wranglerBin, args, {
      cwd: apiDir,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(
        `${label} failed (${result.status}): ${this.redact(`${result.stdout}${result.stderr}`).slice(0, 800)}`,
      );
    }
    return result.stdout;
  }

  /**
   * `wrangler d1 execute --json` prints a leading newline and the statement array
   * it returns is preceded by its own `[`. Stripping to the first `{` removes that
   * `[` and produces "Unexpected non-whitespace character after JSON" -- a harness
   * failure that reads like a product failure.
   */
  parseD1Json(output, label) {
    const text = String(output).trim();
    try {
      return JSON.parse(text);
    } catch {
      const start = text.search(/[[{]/);
      if (start >= 0) {
        try {
          return JSON.parse(text.slice(start));
        } catch {
          /* fall through to the diagnostic */
        }
      }
      throw new Error(
        `${label} returned invalid Wrangler JSON: ${this.redact(text.slice(-2_000))}`,
      );
    }
  }

  /**
   * Rows from one D1 statement.
   *
   * D1 refuses a result set wider than 100 columns -- 100 is accepted, 101 returns
   * "too many columns in result set". Measured against the `wrangler` binary this
   * harness uses; `npx wrangler` is blocked in this repository by `pkg-age-guard`, so
   * a limit measured with it is a measurement of the guard. Compound SELECT is not
   * restricted. A probe that needs a wide single-row aggregate must chunk.
   */
  async d1Rows(sql, label) {
    const output = this.runWrangler(
      [
        "d1",
        "execute",
        "DB",
        "--local",
        "--env",
        "development",
        "--persist-to",
        this.persistDir,
        "--json",
        "--command",
        sql,
      ],
      label,
    );
    const parsed = this.parseD1Json(output, label);
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    return statements.flatMap((statement) =>
      Array.isArray(statement?.results) ? statement.results : [],
    );
  }

  /**
   * Fire the outbox sweep.
   *
   * A job is written to `outbox_events` as `pending` by the request that creates
   * it, and only the cron sweep publishes pending events to OUTBOX_QUEUE. Without
   * this, a job sits in the queue table forever.
   */
  async triggerSweep() {
    try {
      await fetch(`${this.baseUrl}/__scheduled?cron=*`, {
        method: "GET",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // A sweep that cannot be triggered is reported by the caller's own state
      // assertions, which is where a reader learns the job never ran.
    }
  }

  async waitForD1(label, sql, predicate, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    let swept = false;
    while (Date.now() < deadline) {
      last = await this.d1Rows(sql, label);
      if (predicate(last)) return last;
      if (!swept) {
        swept = true;
        await delay(500);
        await this.triggerSweep();
      }
      await delay(1_000);
    }
    throw new Error(
      `${label} did not reach the expected state within ${timeoutMs}ms; last rows: ${JSON.stringify(this.sanitize(last)).slice(0, 400)}`,
    );
  }

  /**
   * Read an object out of the local R2 bucket.
   *
   * `wrangler r2 object list` DOES NOT EXIST in this wrangler version. Calling it
   * made the first version of this helper throw a wrangler usage error from
   * inside an assertion's arguments, so the probe died with a usage message
   * instead of a check result. `r2 object get` is supported and is better
   * evidence anyway: it returns the bytes, so a streamed download can be compared
   * against what is really in the bucket.
   *
   * Absence is a normal outcome, not an error: a deletion leg needs to assert it.
   */
  readObject(bucket, key) {
    if (typeof key !== "string" || key.length === 0) return { present: false, body: "" };
    const result = spawnSync(
      wranglerBin,
      [
        "r2",
        "object",
        "get",
        `${bucket}/${key}`,
        "--local",
        "--env",
        "development",
        "--persist-to",
        this.persistDir,
        "--pipe",
      ],
      {
        cwd: apiDir,
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (result.error || result.status !== 0) return { present: false, body: "" };
    return { present: true, body: result.stdout ?? "" };
  }

  // --- services ------------------------------------------------------------

  async availablePort() {
    const server = createServer();
    await new Promise((resolve_, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve_);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 8787;
    await new Promise((resolve_, reject) =>
      server.close((error) => (error ? reject(error) : resolve_())),
    );
    return port;
  }

  async waitForHealth(child) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/api/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) return;
      } catch {
        /* not up yet */
      }
      await delay(500);
    }
    const service = this.services.find((entry) => entry.child === child);
    throw new Error(
      `the Worker never became healthy on ${this.baseUrl}. Last output:\n${this.redact(service?.output ?? "").slice(-2_000)}`,
    );
  }

  // `--var NAME:VALUE` pairs a probe wants the Worker to see as a binding.
  //
  // A probe cannot set a Worker variable by assigning to `process.env`: `wrangler dev` does
  // not expose the process environment as Worker vars, so a var set that way is silently
  // absent and the Worker behaves as if it were never set. That is a harness trap rather
  // than a product one, and it cost a run before it was understood.
  //
  // This is a TEST affordance in the TEST harness. It does not relax any guard in the
  // product: naming a host the operator has chosen is what `LUMI_PROVIDER_ALLOWLIST` is for,
  // and a probe that needed a production check disabled in order to run would be replacing
  // production security semantics with test-only logic.
  setWorkerVars(vars = {}) {
    this.workerVars = { ...(this.workerVars ?? {}), ...vars };
  }

  startWorker(port) {
    const varArgs = Object.entries(this.workerVars ?? {}).flatMap(([name, value]) => [
      "--var",
      `${name}:${value}`,
    ]);
    const child = spawn(
      wranglerBin,
      [
        "dev",
        "--env",
        "development",
        "--local",
        "--port",
        String(port),
        "--persist-to",
        this.persistDir,
        // NOT passed: `--show-interactive-dev-session=false` suppresses the Worker's own
        // console output, so a `console_error!` from inside the Worker never reaches these
        // pipes. `commit_mutation` and `providers.rs` both log the failing statement's SQLite
        // error there and nowhere else, so with the flag a 503 is undiagnosable from a probe --
        // which is the same class of problem as V01-010, one layer out. Omitting it costs a
        // little console noise and buys the only stream that explains a failure.
        // `--log-level debug` is what makes a `console_error!` from INSIDE the Worker reach
        // these pipes. Without it wrangler forwards its own request log and its own banner and
        // silently drops the Worker's, so `commit_mutation`'s "the commit batch failed"
        // line — the one place the failing statement's SQLite error is written — is invisible
        // to every probe. Diagnosing a 503 in this repository is otherwise guesswork, and
        // V01-010 and V01-011 both hit it.
        ...(process.env.PROBE_QUIET_WORKER === "1"
          ? // The ORIGINAL invocation, exactly. Restoring the old behaviour must mean every
            // flag the old behaviour used, not "the same flag plus a new one" -- otherwise
            // "turn the new thing off" is not actually a way back.
            ["--show-interactive-dev-session=false"]
          : ["--log-level", process.env.PROBE_WORKER_LOG_LEVEL ?? "debug"]),
        // Exposes /__scheduled so `triggerSweep` can fire the cron on demand.
        "--test-scheduled",
        ...varArgs,
      ],
      {
        cwd: apiDir,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    let output = "";
    // The Worker's OWN log, teed to a file the probe can read.
    //
    // `workerLog()` returns what wrangler's own stdout/stderr pipes carried, and that is NOT
    // the same thing as what the Worker logged. A `console_error!` inside the Worker never
    // appears there under `--show-interactive-dev-session=false`, so a probe cannot see the one
    // line that names a failing statement. That is not a cosmetic gap: `commit_mutation` and
    // `providers.rs` both log their failure reasons precisely so the 503 is diagnosable, and a
    // harness that cannot read them makes the log lines unprovable.
    //
    // The file is truncated per run and capped, so it cannot grow without bound across a
    // campaign that runs dozens of probes.
    const logFile = join(this.persistDir, "worker-console.log");
    writeFileSync(logFile, "");
    const capture = (chunk) => {
      output = `${output}${chunk}`.slice(-20_000);
      try {
        const text = chunk.toString();
        const existing = statSync(logFile, { throwIfNoEntry: false })?.size ?? 0;
        if (existing > 2_000_000) return;
        appendFileSync(logFile, text);
      } catch {
        // A probe that cannot read the console log is a limitation, never a verdict.
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      output = `${output}\n${error.message}`.slice(-20_000);
    });
    this.services.push({
      child,
      label: "Worker",
      get output() {
        return output;
      },
    });
    return child;
  }

  killTree(child) {
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  stopServices() {
    for (const service of this.services.splice(0).reverse()) this.killTree(service.child);
  }

  /**
   * A fresh local D1 with every migration applied, and a Worker on it.
   *
   * `P06_PERSIST_TO` (or a probe's own equivalent) keeps the state directory
   * instead of deleting it, which is how a failure gets diagnosed: a route that
   * answers a generic 409 does not say which statement failed, so the rows are the
   * evidence. A diagnostic that deletes its own state makes every future run
   * start over.
   */
  /**
   * Is the Worker about to be served built from the source on disk right now?
   *
   * Nothing else in this harness establishes this, and getting it wrong does not look
   * like an error -- it looks like a result.
   *
   * Found by V01-001. A sensitivity run applies a fault, builds, drives the probe, then
   * undoes the fault by moving a saved copy back over the file. `mv` preserves the
   * saved copy's mtime, which is the mtime from *before* the fault was applied -- so
   * after the restore the source looks older than the artifact built from it, the build
   * tool declines to rebuild, and the next probe run measures the FAULTED binary while
   * reading source that says otherwise. Observed directly: the adoption privacy probe
   * reported five payload classes leaked into the audit trail against a tree where
   * `git status` was clean, because the previous run's fault was still compiled in.
   *
   * Read as a product defect, that is a serious false positive. Read as what it was, it
   * is the failure the whole campaign is about: a verdict with no evidence behind it.
   *
   * The fix has two halves and both are needed. Reverting with `cp` rather than `mv`
   * gives the file a fresh mtime, so the next build happens. This check is the other
   * half: it makes "the code under test is the code on disk" a verified property rather
   * than an assumption, so a stale artifact is reported instead of believed.
   */
  buildFreshness() {
    const newest = (dir, filter) => {
      let newestMtime = 0;
      let newestFile = "";
      const walk = (current) => {
        let entries;
        try {
          entries = readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (
            entry.name === "target" ||
            entry.name === "node_modules" ||
            entry.name.startsWith(".")
          ) {
            continue;
          }
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (filter && !filter(full)) continue;
          const mtime = statSync(full).mtimeMs;
          if (mtime > newestMtime) {
            newestMtime = mtime;
            newestFile = full;
          }
        }
      };
      walk(dir);
      return { mtime: newestMtime, file: newestFile };
    };

    const source = newest(apiDir, (f) => /\.(rs|toml)$/.test(f) && !f.includes("/build/"));
    const migrations = newest(join(apiDir, "migrations"));
    const newestSource = source.mtime > migrations.mtime ? source : migrations;
    // `wrangler dev` compiles into a fresh `.wrangler/tmp/dev-*` directory per run and
    // copies the same bundle to `apps/api/build/`. Both are candidates; the NEWEST is
    // the one being served, because the run that just started wrote the newest one.
    // Taking the oldest of the candidates, as the first version did, reports the
    // previous run's build and calls it this one's.
    const candidates = [];
    const collect = (dir, depth) => {
      if (depth < 0) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          collect(full, depth - 1);
        } else if (entry.name.endsWith("index_bg.wasm")) {
          candidates.push({ mtime: statSync(full).mtimeMs, file: full });
        }
      }
    };
    collect(join(apiDir, ".wrangler", "tmp"), 3);
    collect(join(apiDir, "build"), 1);

    if (candidates.length === 0) {
      return { ok: null, reason: "no compiled Worker found to compare against the source" };
    }
    const oldestArtifact = candidates.sort((a, b) => b.mtime - a.mtime)[0];

    const age = oldestArtifact.mtime - newestSource.mtime;
    return {
      ok: age >= 0,
      artifact: oldestArtifact,
      source: newestSource,
      behindMs: -age,
      reason:
        age >= 0
          ? null
          : `the built Worker is ${Math.round(-age / 1000)}s older than ` +
            `${newestSource.file.replace(apiDir + "/", "")}, so it was not built from the current source`,
    };
  }

  async setup({ persistEnvVar = "P06_PERSIST_TO", portEnvVar = "P06_PORT" } = {}) {
    if (!existsSync(wranglerBin)) {
      throw new Error(
        `wrangler is not installed at ${wranglerBin}. Run pnpm install, or point ` +
          "PROBE_WRANGLER at one -- the mutation campaign runs this probe against a mutated " +
          "copy of the repository that has no node_modules of its own.",
      );
    }
    if (process.env[persistEnvVar]) {
      this.persistDir = resolve(process.env[persistEnvVar]);
      mkdirSync(this.persistDir, { recursive: true });
      this.persistOwned = false;
      console.log(`Keeping the local D1/R2 state in ${this.persistDir}`);
    } else {
      this.persistDir = await mkdtemp(join(tmpdir(), `lumi-${this.name}-`));
      this.persistOwned = true;
    }
    const port = process.env[portEnvVar]
      ? Number(process.env[portEnvVar])
      : await this.availablePort();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${portEnvVar} is invalid: ${process.env[portEnvVar]}`);
    }
    this.baseUrl = `http://127.0.0.1:${port}`;

    this.runWrangler(
      [
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--env",
        "development",
        "--persist-to",
        this.persistDir,
      ],
      `${this.name} fresh D1 migration`,
    );
    const migrations = await this.d1Rows(
      "SELECT name FROM d1_migrations ORDER BY id",
      `${this.name} migration ledger check`,
    );
    if (migrations.length < 20) {
      throw new Error(
        `fresh D1 applied only ${migrations.length} migration(s); the probe would run against a partial schema`,
      );
    }
    this.pass("fresh D1 applies the full migration ledger", `${migrations.length} migration rows`);

    this.worker = this.startWorker(port);
    await this.waitForHealth(this.worker);
    this.pass("development Worker is healthy", this.baseUrl);

    // After the Worker answers, not before. `wrangler dev` compiles on spawn, so a
    // check placed before the health wait compares the source against the PREVIOUS
    // run's bundle and reports a stale build on a run that is about to rebuild. The
    // first version of this check sat in exactly that position and fired on a
    // sensitivity run whose own fault it was supposed to be able to see.
    const freshness = this.buildFreshness();
    if (freshness.ok === false) {
      this.fail(
        "the Worker under test was built from the current source",
        `${freshness.reason}. Evidence from this run would describe different code than the tree, ` +
          "so a result here is not a result about this code. Rebuild, or touch the source so the " +
          "artifact is regenerated.",
      );
    } else if (freshness.ok === null) {
      this.pass(
        "build freshness could not be established (not a failure, but not evidence either)",
        freshness.reason,
      );
    } else {
      const seconds = (freshness.artifact.mtime - freshness.source.mtime) / 1000;
      this.pass(
        "the Worker under test was built from the current source",
        `newest artifact ${freshness.artifact.file.replace(apiDir + "/", "")} is ` +
          `${Math.abs(Math.round(seconds))}s ${seconds >= 0 ? "newer" : "OLDER"} than ` +
          `${freshness.source.file.replace(apiDir + "/", "")}`,
      );
    }
  }

  cleanup() {
    this.stopServices();
    if (this.persistOwned && this.persistDir)
      rmSync(this.persistDir, { recursive: true, force: true });
  }

  /** The Worker's own log, for a failure that the probe's own output cannot explain. */
  workerLog() {
    const service = this.services.find((entry) => entry.label === "Worker") ?? this._lastWorker;
    return this.redact(service?.output ?? "").slice(-this.workerLogTail);
  }

  /**
   * What the WORKER logged, as opposed to what wrangler's own pipes carried.
   *
   * These are different streams, and only this one contains a `console_error!` written from
   * inside the Worker. That matters because `commit_mutation` and `providers.rs` both log the
   * failing statement's SQLite error there and nowhere else, so without this a 503 is
   * undiagnosable from a probe -- and a log line nobody can read is not evidence that it
   * exists.
   */
  workerConsole(tail = 8_000) {
    try {
      return this.redact(readFileSync(join(this.persistDir, "worker-console.log"), "utf8")).slice(
        -tail,
      );
    } catch {
      return "";
    }
  }

  rememberWorker() {
    this._lastWorker = this.services.find((entry) => entry.label === "Worker");
  }

  // --- fixtures ------------------------------------------------------------

  /** A signed-in, email-verified user. */
  async authenticatedUser(label) {
    const jar = this.client();
    const email = `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${this.nonce}@example.com`;
    let result = await this.request(jar, "POST", "/api/v1/auth/signup", {
      email,
      display_name: label,
    });
    this.expectStatus(`signup ${label}`, result, 201);
    const verification = this.requirePayload(result, `signup ${label}`).verification;
    if (!verification?.challenge_id || !verification?.development_code) {
      this.fail(
        `signup ${label} did not expose the development verification challenge`,
        JSON.stringify(this.sanitize(result.payload)),
      );
      throw new Error(`signup ${label} is not usable`);
    }
    this.registerSecret(verification.development_code);
    result = await this.request(jar, "POST", "/api/v1/auth/verify-email", {
      challenge_id: verification.challenge_id,
      code: verification.development_code,
    });
    this.expectStatus(`verify ${label}`, result, 200);

    result = await this.request(jar, "POST", "/api/v1/auth/login/start", { email });
    this.expectStatus(`login start ${label}`, result, 202);
    const login = this.requirePayload(result, `login start ${label}`);
    if (!login.challenge_id || !login.development_code) {
      this.fail(`login start ${label} did not expose a development challenge`);
      throw new Error(`login ${label} is not usable`);
    }
    this.registerSecret(login.development_code);
    result = await this.request(jar, "POST", "/api/v1/auth/login/complete", {
      challenge_id: login.challenge_id,
      code: login.development_code,
    });
    this.expectStatus(`login complete ${label}`, result, 200);
    const user = this.requirePayload(result, `login complete ${label}`).user;
    this.assertId(`user ${label} has an opaque ID`, user?.id, "usr");
    return { jar, user, email };
  }

  /**
   * An organization.
   *
   * `normalize_slug` accepts 3-63 characters of `[a-z0-9-]` with no edge hyphen.
   * An opaque resource ID contains underscores, so it is not a slug: the first
   * version of `p06-data-smoke.mjs` passed one and the probe reported a product
   * 422 that was in fact a probe bug.
   */
  async createOrganization(jar, label, slug) {
    const result = await this.request(
      jar,
      "POST",
      "/api/v1/orgs",
      { display_name: label, slug },
      this.browserMutation(jar, `org-${slug}`),
    );
    this.expectStatus(`create ${label}`, result, 201);
    const orgId = result.payload?.organization?.org_id;
    this.assertId(`${label} organization ID`, orgId, "org");
    return { orgId, slug };
  }

  async inviteAndAccept(admin, member, orgId, role = "member") {
    const invite = await this.request(
      admin.jar,
      "POST",
      `/api/v1/orgs/${orgId}/invitations`,
      { email: member.user.email, role },
      // One key per (organization, invitee, role). A single `invite-${orgId}` key makes
      // the second invite to the same organization a 409 idempotency conflict against a
      // different body -- which is correct API behaviour and a broken helper, and the
      // difference between the two is invisible unless you are adding a second invitee.
      this.browserMutation(admin.jar, `invite-${orgId}-${member.user.email}-${role}`),
    );
    this.expectStatus(`invite a ${role}`, invite, 201);
    const invitation = this.requirePayload(invite, `invite a ${role}`).invitation;
    const token = invite.payload?.development_token;
    const invitationId = invitation?.invitation_id ?? invitation?.id;
    if (!invitationId || !token) {
      this.fail(
        "invite response omitted the development invitation token",
        JSON.stringify(this.sanitize(invite.payload)),
      );
      throw new Error("invitation is not usable");
    }
    this.registerSecret(token);
    const accepted = await this.request(
      member.jar,
      "POST",
      `/api/v1/invitations/${invitationId}/accept`,
      { token },
      this.browserHeaders(member.jar),
    );
    this.expectStatus(`accept the ${role} invitation`, accepted, 200);
    return invitationId;
  }

  // --- finishing -----------------------------------------------------------

  /**
   * Print the tally and exit.
   *
   * `code` is explicit because three states have to stay distinguishable: a
   * check did not hold (1), the harness could not run the check (2), and
   * everything held (0). Collapsing 2 into 0 would let a broken probe read as a
   * clean bill of health; collapsing it into 1 would report a machine's limits as
   * a statement about the product.
   */
  finish(code, note = "") {
    this.stopServices();
    const held = this.passes.length;
    const total = held + this.failures.length;
    let summary = `${held}/${total} ${this.name} cases hold`;
    if (this.skipped.length > 0) summary += `, ${this.skipped.length} skipped`;
    if (note) summary += `, ${note}`;
    console.log(`\n${summary}`);
    if (this.failures.length > 0) {
      console.log(`\n${this.failures.length} case(s) failed:`);
      for (const name of this.failures) console.log(`  - ${name}`);
    }
    process.exit(code);
  }

  /**
   * Report a harness failure with the evidence a reader needs to act on.
   *
   * The Worker's own log is printed BEFORE the services are stopped. A diagnostic
   * that removes its own logs on failure makes every future run start from
   * scratch, and this harness was itself wrong several times while being built.
   */
  bail(error) {
    this.rememberWorker();
    const log = this.workerLog();
    this.stopServices();
    console.error(`\n${this.name} harness failure: ${this.redact(error.message)}`);
    if (log) console.error(`\n--- Worker log (tail) ---\n${log}`);
    if (this.failures.length === 0) process.exit(2);
    process.exit(1);
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      for (const part of value.split(/,(?=\s*[^;=]+=[^;]+)/)) {
        const [pair] = part.split(";");
        const separator = pair.indexOf("=");
        if (separator > 0) {
          this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
        }
      }
    }
  }

  header() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

/**
 * Run a probe's body, and turn any escape into the right exit code.
 *
 * A probe that throws has produced no evidence either way, which is 2, not 1 —
 * unless it had already recorded a failure, in which case 1 is right because
 * something *was* shown to be false.
 */
export async function runProbe(name, body) {
  const probe = new SmokeHarness({ name });
  process.on("exit", () => probe.cleanup());
  try {
    await body(probe);
    probe.finish(probe.failures.length > 0 ? 1 : 0);
  } catch (error) {
    probe.bail(error);
  }
}
