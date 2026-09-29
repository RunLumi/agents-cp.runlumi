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
    // Every HTTP request this probe has made, counted here so the console capture can be graded
    // against something. See `consoleCapture()`.
    this.httpRequests = 0;
    this.lastRequestLine = "";
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

  /**
   * A short, printable rendering of any value, for an assertion's detail string.
   *
   * `JSON.stringify(undefined).slice(0, 200)` throws, because `JSON.stringify(undefined)` is
   * `undefined` and not a string. That is not a cosmetic hazard: an assertion's detail argument
   * is evaluated EAGERLY, so a probe building its own diagnostic on a response with no body -- a
   * 204, or any response whose payload did not parse -- dies with `Cannot read properties of
   * undefined` before the assertion it was about to explain. The reader then gets a TypeError
   * instead of the finding, and the whole run is reported as a harness failure with no clue which
   * check was in flight.
   *
   * It bit `verify:device-idempotency` on a real 204 from the revoke route. Every probe should
   * use this rather than composing `JSON.stringify` and `slice` by hand.
   */
  brief(value, max = 240) {
    if (value === undefined) return "(no body)";
    if (value === null) return "null";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, max);
  }

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
      this.httpRequests += 1;
      this.lastRequestLine = `${method} ${routePath}`;
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
    const parse = () => {
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
    };
    const parsed = parse();
    // A statement D1 REFUSED and a statement that matched no rows arrive the same way from
    // `d1Rows`: no `results`. Only the payload distinguishes them -- `{"success": false, "error":
    // {"text": "no such column: version"}}` versus `{"results": [], "success": true}` -- and for at
    // least one wrangler invocation the process still exits 0, so `runWrangler` does not throw.
    //
    // That makes a refused query report as "no such row", which a probe then reads as a fact about the
    // PRODUCT. It is how the invitation fixture in `verify:path-id-tenancy` spent a run reporting
    // `A=undefined` for a row that existed: the seed asked for a `version` column that `invitations`
    // does not have, the statement was refused, and the probe concluded there was no invitation.
    //
    // So the refusal is raised here, once, for every probe that reads D1. An instrument that reports an
    // absence it did not measure is the failure this campaign keeps meeting in a new place.
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    for (const statement of statements) {
      const failure = statement?.error?.text ?? statement?.error?.message;
      if (failure || statement?.success === false) {
        throw new Error(
          `${label}: D1 refused the statement: ${this.redact(String(failure ?? "success was false"))}. ` +
            `An empty result and a refused statement are different findings and this harness now ` +
            `distinguishes them.`,
        );
      }
    }
    return parsed;
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
      // The probe NAME goes into a filesystem path here, so it must be a path SEGMENT. One probe is
      // called `V01 filter/pagination/nested`, and `mkdtemp` treats the `/` as a directory separator:
      // `pnpm verify:filter-tenancy` died with ENOENT before running a single case.
      //
      // It went unnoticed because that gate's sensitivity script exports V01_FILTER_PERSIST_TO, which
      // takes the other branch -- so the probe had demonstrable evidence, a recorded 65/65 baseline,
      // and four detected mutations, while the command printed in AGENTS.md could not start. A gate
      // that only runs when an undocumented environment variable is set provides no evidence to
      // anyone who follows the documentation, and the failure mode is a clean exit 2 that reads like
      // "the harness could not run" rather than "this command has never worked".
      //
      // Sanitised rather than renamed, because the name is a label in the output and reads well.
      const slug = this.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "probe";
      this.persistDir = await mkdtemp(join(tmpdir(), `lumi-${slug}-`));
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

  /**
   * Is the console capture actually capturing?
   *
   * V01-029 cost four builds because this stream was read as an absence of evidence. The probe
   * instrumented four error sites, and each run concluded "no log fired" -- so the failure was
   * elsewhere. It was not: `worker-console.log` is appended to ASYNCHRONOUSLY by wrangler's proxy
   * and is truncated, so across five runs it held sixteen request lines and ended at the last
   * fixture. It contained no line for a request the probe had demonstrably made and which came back
   * with a product-shaped body carrying a `request_id`.
   *
   * So a log's silence is not evidence until the log has been shown to record something, and the
   * check for that is cheap and belongs HERE rather than in every probe that reads the console:
   *
   *   - count the request lines wrangler's proxy wrote, and
   *   - compare them with the number of requests this harness actually made.
   *
   * A capture that has fallen behind is reported as `ok: false` with both counts, so a probe can
   * refuse to conclude anything from a silent log and can fail as a HARNESS FAULT (exit 2) rather
   * than reporting a product verdict. It is a floor, not a ceiling: a capture may be behind by a
   * line or two through ordinary buffering, so `ok` requires a majority rather than an equality.
   */
  consoleCapture() {
    const requested = this.httpRequests;
    let seen = 0;
    // `text` is hoisted OUT of the try on purpose. It is read again after the block, and the first
    // version of this function declared it inside, so the tail check threw a ReferenceError on every
    // call -- which `node --check` cannot see, because it is a runtime fault and not a syntax one. The
    // symptom was a probe that died AFTER its last request with no error of its own, in a function
    // whose entire job is to report on instrumentation.
    let text = "";
    try {
      text = readFileSync(join(this.persistDir, "worker-console.log"), "utf8");
      seen = (text.match(/\[wrangler-ProxyWorker:info\]\s+(GET|POST|PUT|PATCH|DELETE) \//g) ?? [])
        .length;
    } catch {
      return { ok: false, requested, seen: 0, reason: "the console file is unreadable" };
    }
    // With no requests yet there is nothing to be behind on, and claiming otherwise would make a
    // probe fail for reading the console before it has made a call.
    if (requested === 0) {
      return {
        ok: true,
        requested,
        seen,
        newest: "",
        newestSeen: true,
        reason: "no requests have been made yet",
      };
    }
    // The criterion is the NEWEST request, not a majority. A majority check passes while the most
    // recent requests -- the ones a diagnosis is about -- are exactly the ones missing, which is both
    // the truncation shape and the flush shape. A count cannot tell them apart; a tail can.
    const newestSeen = this.lastRequestLine !== "" && text.includes(this.lastRequestLine);
    return {
      ok: newestSeen,
      requested,
      seen,
      newest: this.lastRequestLine,
      newestSeen,
      reason: newestSeen
        ? ""
        : `the most recent request (${this.lastRequestLine}) does not appear in a file holding ` +
          `${seen} request line(s) for ${requested} request(s) this harness made, so its SILENCE IS ` +
          `NOT EVIDENCE that a log was not written. Read it at the END of the run, and do not ` +
          `conclude anything from it until this says it can be trusted.`,
    };
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
    // The Worker's log is read BEFORE the services stop, for the same reason `bail` reads it first: a
    // diagnostic that removes itself on failure makes the next run start from scratch.
    //
    // This was added because a 503 with no cause is a verdict with no evidence, which is the campaign's
    // recurring failure in a place it had not appeared before. `verify:staff-credential` reported
    // `create_flag` -> 503 for four separate repairs, and the reason -- which the Worker DOES report,
    // through `report_error`, with SQLite's own message -- was unreachable because the log was only
    // printed when the probe BAILED, and a failing case is not a bail. So the sheet said "the route is
    // broken" five times and the cause was in a log nobody printed.
    const log = this.failures.length > 0 ? this.workerLog() : "";
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
      // Only the lines that name a cause. A raw tail is mostly wrangler's startup banner, and a
      // failure report buried in it is a failure report nobody reads.
      const diagnostic = (log ?? "")
        .split("\n")
        .filter(
          (line) =>
            /error|Error|ERROR|abort|SQLITE|constraint|no such|failed/i.test(line) &&
            !/wrangler|update available|metrics|dispatcher|nps|node_modules/i.test(line),
        )
        .slice(-24);
      if (diagnostic.length > 0) {
        console.log(`\n--- Worker lines naming a cause (tail) ---`);
        for (const line of diagnostic) console.log(`  ${line}`);
      } else {
        console.log(
          `\n(no Worker line named a cause. That is itself a finding: the route refused without ` +
            `logging why, so the cause is only reachable by reproducing the statement by hand.)`,
        );
      }
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

    // ALWAYS exit 2, even when assertions had already failed.
    //
    // This used to exit 1 whenever anything had already failed, on the reasoning that there was
    // something to report. That is the exact collapse the campaign forbids: exit 1 is a
    // statement about the PRODUCT and exit 2 is a statement about the HARNESS, and merging them
    // lets a probe that died mid-run read as a detected defect.
    //
    // It is not theoretical. `verify:lease-contention` died on `no such table:
    // automation_attempts` in case 1 -- after the two known-open V01-013 assertions had already
    // failed -- so it exited 1, and `verify:lease-contention`'s sensitivity harness read that as
    // a valid measurement. Every "PASS" it reported after that point was reported by a run that
    // had stopped. Worse, the cases that never ran were silently absent from the denominator: the
    // gate reported 32/34 while three of its four cases had never executed.
    //
    // So: a harness failure is a harness failure, and the count of cases that DID run is printed
    // so a reader can see the run was incomplete rather than inferring it from a total.
    console.error(
      `\n${this.name} DID NOT COMPLETE. ${this.passes.length} assertion(s) passed and ` +
        `${this.failures.length} failed before it died; every case after the failure above was ` +
        `NEVER RUN, and the totals below do not include them.`,
    );
    console.error(
      `\n${this.passes.length}/${this.passes.length + this.failures.length} cases reached before the failure`,
    );
    process.exit(2);
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
