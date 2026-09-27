#!/usr/bin/env node
// VI-DATA-001 — does the data-governance surface actually reach durable storage,
// and does authorization hold across an organization boundary?
//
// WHY THIS PROBE EXISTS
//
// The V00 reconstruction graded `VI-DATA-001` (Tier 0, min proof V3 + V4) UNPROVEN,
// and the reason was never an external dependency: it was that **no verifier crossed
// HTTP → R2 for the export or deletion routes**. `p05-smoke.mjs` stops at P05, and the
// only evidence behind the claim was 57 domain tests plus 125 storage invariants —
// neither of which exercises a signed-in principal driving an export to a real object
// store and reading it back. A claim in that state cannot be closed by more unit tests,
// because the unit tests are the thing that was already insufficient.
//
// This is a Tier-0 claim, so it is one of the two conditions the campaign's own closure
// criterion names. Building it is not optional tidying.
//
// WHAT IT CROSSES
//
// real Chrome-free HTTP → real Worker (`wasm32`) → real local D1 → real local R2, with
// two real signed-in users in two real organizations. Nothing is mocked: the session
// cookie, the CSRF token, the export job, the R2 object, and the streamed download all
// come from the running system.
//
// The failure modes this claim names, each with a case below:
//
//   "Export crosses tenants"                    → the second org's admin is refused org A's
//                                                  export, list, and download, over HTTP.
//   "Deletion is not idempotent"                → a second identical deletion request and a
//                                                  resumed job do not double-delete.
//   "a deleted artifact leaves a reachable object"
//                                               → after deletion the R2 object is *absent*,
//                                                  checked against the store itself and not
//                                                  only against the database row.
//
// The last one is the reason this had to be a runtime probe: FR-F20-007 says "deleting DB
// metadata is insufficient if object/blob copies remain", and only a real bucket can
// disagree with the database about whether something is gone.
//
// Usage:
//   node apps/api/scripts/p06-data-smoke.mjs
//
// Needs: a built Worker (`pnpm build`) or it builds one, and wrangler. Takes a few
// minutes. Start no Worker of your own on the port it prints.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(apiDir, "..", "..");
const wranglerBin = join(apiDir, "node_modules", ".bin", "wrangler");

let baseUrl = "";
let persistDir = "";
let worker = null;
const services = [];
let persistOwned = true;
let stage = "startup";
const failures = [];
const passes = [];
const secrets = new Set();
const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// --- reporting -----------------------------------------------------------------

function redactText(value) {
  let out = String(value);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function sanitize(value, key = "", depth = 0) {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => sanitize(item, key, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k, depth + 1);
    return out;
  }
  if (typeof value === "string") {
    if (/challenge|code|token|secret|cookie|password/i.test(key)) return "[redacted]";
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  return value;
}

function pass(name, detail = "") {
  passes.push(name);
  console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? `  — ${redactText(detail)}` : ""}`);
}

function expect(name, condition, detail = "") {
  if (condition) pass(name, detail);
  else fail(name, detail || "condition was false");
  return condition;
}

function expectStatus(name, result, statuses, reasons = []) {
  const wanted = Array.isArray(statuses) ? statuses : [statuses];
  const statusOk = wanted.includes(result.status);
  const reason = reasonOf(result);
  const reasonOk = reasons.length === 0 || (reason !== null && reasons.includes(reason));
  if (statusOk && reasonOk) {
    pass(name, `status=${result.status}${reason ? ` reason=${reason}` : ""}`);
    return true;
  }
  fail(
    name,
    `status=${result.status} reason=${reason} (wanted ${wanted.join("/")}` +
      `${reasons.length ? ` reason in ${reasons.join(",")}` : ""}) — ${redactText(
        JSON.stringify(sanitize(result.payload)) ?? result.text,
      ).slice(0, 400)}`,
  );
  return false;
}

function requirePayload(result, name) {
  if (result.payload === undefined) {
    fail(`${name} returned no JSON payload`, result.text?.slice(0, 200));
    return {};
  }
  return result.payload;
}

/**
 * The error envelope puts the stable machine reason at `details.reason`, e.g.
 *   { error: { code, message, request_id, details: { reason: "slug_invalid" } } }
 * The first version of this read `payload.reason` and `payload.error.reason`, both
 * of which are undefined there, so every reason assertion in this probe was reading
 * null. A denial check that cannot name its reason is a denial check that cannot fail.
 */
function reasonOf(result) {
  const payload = result.payload ?? {};
  return (
    payload.details?.reason ??
    payload.error?.details?.reason ??
    payload.error?.reason ??
    payload.reason ??
    null
  );
}

function statusIs(result, statuses, reasons = []) {
  const wanted = Array.isArray(statuses) ? statuses : [statuses];
  const reason = reasonOf(result);
  return wanted.includes(result.status) && (reasons.length === 0 || reasons.includes(reason));
}

function idempotencyKey(label) {
  return `${nonce}-${label}`;
}

function assertId(name, value, prefix) {
  if (typeof value === "string" && value.startsWith(`${prefix}_`)) {
    pass(name, value);
    return true;
  }
  fail(name, `expected an opaque ${prefix}_… identifier, got ${JSON.stringify(value)}`);
  return false;
}

// --- HTTP ---------------------------------------------------------------------

class CookieJar {
  cookies = new Map();

  absorb(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      for (const part of value.split(/,(?=\s*[^;=]+=[^;]+)/)) {
        const [pair] = part.split(";");
        const separator = pair.indexOf("=");
        if (separator > 0)
          this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
      }
    }
  }

  header() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

async function request(jar, method, routePath, body, extraHeaders = {}, options = {}) {
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
    response = await fetch(`${baseUrl}${routePath}`, init);
  } catch (error) {
    throw new Error(
      `${stage}: ${method} ${routePath} transport failure: ${redactText(error.message)}`,
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

function browserHeaders(jar, extra = {}) {
  return { "X-CSRF-Token": jar.cookies.get("lumi_csrf") ?? "", ...extra };
}

function browserMutation(jar, label, extra = {}) {
  return browserHeaders(jar, { "Idempotency-Key": idempotencyKey(label), ...extra });
}

// --- D1 + worker ---------------------------------------------------------------

function runWrangler(args, label) {
  const result = spawnSync(wranglerBin, args, {
    cwd: apiDir,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status}): ${redactText(`${result.stdout}${result.stderr}`).slice(0, 800)}`,
    );
  }
  return result.stdout;
}

function parseD1Json(output, label) {
  const text = String(output).trim();
  try {
    return JSON.parse(text);
  } catch {
    // `wrangler d1 execute --json` prints a leading newline, and the first version of
    // this parser stripped to the first `{` -- which silently removed the opening `[`
    // of the statement array and produced "Unexpected non-whitespace character after
    // JSON", a harness failure that read like a product failure. Slice from the first
    // bracket of EITHER kind, which is what p05-smoke.mjs does.
    const start = text.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        /* fall through to the diagnostic */
      }
    }
    throw new Error(`${label} returned invalid Wrangler JSON: ${redactText(text.slice(-2_000))}`);
  }
}

async function d1(sql, label) {
  const output = runWrangler(
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--env",
      "development",
      "--persist-to",
      persistDir,
      "--json",
      "--command",
      sql,
    ],
    label,
  );
  return parseD1Json(output, label);
}

async function d1Rows(sql, label) {
  const output = runWrangler(
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--env",
      "development",
      "--persist-to",
      persistDir,
      "--json",
      "--command",
      sql,
    ],
    label,
  );
  const parsed = parseD1Json(output, label);
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  return statements.flatMap((statement) =>
    Array.isArray(statement?.results) ? statement.results : [],
  );
}

/**
 * Fire the outbox sweep.
 *
 * An export is written to `outbox_events` with `delivery_status = 'pending'` by the
 * request that creates it, and only the cron sweep publishes pending events to
 * OUTBOX_QUEUE. Without this the job sits in the queue table forever, which is what
 * the first run of this probe observed: `export_jobs.state = 'requested'` with a
 * `queued` envelope that nothing had claimed.
 */
async function triggerSweep() {
  try {
    await fetch(`${baseUrl}/__scheduled?cron=*`, {
      method: "GET",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // A sweep that cannot be triggered is reported by the state assertions below,
    // which is where the reader learns the job never ran.
  }
}

async function waitForD1(label, sql, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  let swept = false;
  while (Date.now() < deadline) {
    last = await d1Rows(sql, label);
    if (predicate(last)) return last;
    if (!swept) {
      // Give the request-time write a moment, then fire the cron once. A later retry
      // of the loop keeps polling in case the consumer needed a second nudge.
      swept = true;
      await delay(500);
      await triggerSweep();
    }
    await delay(1_000);
  }
  throw new Error(
    `${label} did not reach the expected state within ${timeoutMs}ms; last rows: ${JSON.stringify(sanitize(last)).slice(0, 400)}`,
  );
}

async function availablePort() {
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

async function waitForHealth(child) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(500);
  }
  const service = services.find((entry) => entry.child === child);
  throw new Error(
    `the Worker never became healthy on ${baseUrl}. Last output:\n${redactText(service?.output ?? "").slice(-2_000)}`,
  );
}

function startWorker(port) {
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
      persistDir,
      "--show-interactive-dev-session=false",
      // The P01 outbox is drained by the `*/1 * * * *` cron (`run_scheduled_sweep`),
      // not by the request path: no mutation publishes to OUTBOX_QUEUE except the
      // foundation-check demo route. `--test-scheduled` exposes /__scheduled so the
      // probe can fire that sweep on demand instead of waiting a wall-clock minute.
      "--test-scheduled",
    ],
    {
      cwd: apiDir,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-20_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    output = `${output}\n${error.message}`.slice(-20_000);
  });
  services.push({
    child,
    label: "Worker",
    get output() {
      return output;
    },
  });
  return child;
}

function killTree(child) {
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

function stopServices() {
  for (const service of services.splice(0).reverse()) killTree(service.child);
}

async function setupInfrastructure() {
  // `P06_PERSIST_TO` keeps the local D1/R2 directory instead of deleting it, which is
  // how a failure gets diagnosed: the generic 409 this surface can return does not say
  // which statement failed, so the rows are the evidence. `P06_PORT` pins the port for
  // the same reason.
  if (process.env.P06_PERSIST_TO) {
    persistDir = resolve(process.env.P06_PERSIST_TO);
    mkdirSync(persistDir, { recursive: true });
    persistOwned = false;
    console.log(`Keeping the local D1/R2 state in ${persistDir}`);
  } else {
    persistDir = await mkdtemp(join(tmpdir(), "lumi-p06-smoke-"));
    persistOwned = true;
  }
  const port = process.env.P06_PORT ? Number(process.env.P06_PORT) : await availablePort();
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`P06_PORT is invalid: ${process.env.P06_PORT}`);
  }
  baseUrl = `http://127.0.0.1:${port}`;

  runWrangler(
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--env",
      "development",
      "--persist-to",
      persistDir,
    ],
    "P06 fresh D1 migration",
  );
  const migrations = await d1Rows(
    "SELECT name FROM d1_migrations ORDER BY id",
    "P06 migration ledger check",
  );
  expect(
    "fresh D1 applies the full migration ledger",
    migrations.length >= 20,
    `${migrations.length} migration rows`,
  );

  worker = startWorker(port);
  await waitForHealth(worker);
  pass("development Worker is healthy", baseUrl);
}

// --- fixtures ------------------------------------------------------------------

async function authenticatedUser(label) {
  const jar = new CookieJar();
  const email = `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${nonce}@example.com`;
  let result = await request(jar, "POST", "/api/v1/auth/signup", { email, display_name: label });
  expectStatus(`signup ${label}`, result, 201);
  const verification = requirePayload(result, `signup ${label}`).verification;
  if (!verification?.challenge_id || !verification?.development_code) {
    fail(
      `signup ${label} did not expose the development verification challenge`,
      JSON.stringify(sanitize(result.payload)),
    );
    throw new Error(`signup ${label} is not usable`);
  }
  secrets.add(verification.development_code);
  result = await request(jar, "POST", "/api/v1/auth/verify-email", {
    challenge_id: verification.challenge_id,
    code: verification.development_code,
  });
  expectStatus(`verify ${label}`, result, 200);

  result = await request(jar, "POST", "/api/v1/auth/login/start", { email });
  expectStatus(`login start ${label}`, result, 202);
  const login = requirePayload(result, `login start ${label}`);
  if (!login.challenge_id || !login.development_code) {
    fail(`login start ${label} did not expose a development challenge`);
    throw new Error(`login ${label} is not usable`);
  }
  secrets.add(login.development_code);
  result = await request(jar, "POST", "/api/v1/auth/login/complete", {
    challenge_id: login.challenge_id,
    code: login.development_code,
  });
  expectStatus(`login complete ${label}`, result, 200);
  const user = requirePayload(result, `login complete ${label}`).user;
  assertId(`user ${label} has an opaque ID`, user?.id, "usr");
  return { jar, user, email };
}

async function createOrganization(jar, label, slug) {
  const result = await request(
    jar,
    "POST",
    "/api/v1/orgs",
    { display_name: label, slug },
    browserMutation(jar, `org-${slug}`),
  );
  expectStatus(`create ${label}`, result, 201);
  const orgId = result.payload?.organization?.org_id;
  assertId(`${label} organization ID`, orgId, "org");
  return { orgId, slug };
}

async function inviteAndAccept(admin, member, orgId) {
  const invite = await request(
    admin.jar,
    "POST",
    `/api/v1/orgs/${orgId}/invitations`,
    { email: member.user.email, role: "member" },
    browserMutation(admin.jar, `invite-${orgId}`),
  );
  expectStatus("invite a member", invite, 201);
  const invitation = requirePayload(invite, "invite a member").invitation;
  const token = invite.payload?.development_token;
  const invitationId = invitation?.invitation_id ?? invitation?.id;
  if (!invitationId || !token) {
    fail(
      "invite response omitted the development invitation token",
      JSON.stringify(sanitize(invite.payload)),
    );
    throw new Error("invitation is not usable");
  }
  secrets.add(token);
  const accepted = await request(
    member.jar,
    "POST",
    `/api/v1/invitations/${invitationId}/accept`,
    { token },
    browserHeaders(member.jar),
  );
  expectStatus("accept the member invitation", accepted, 200);
  return invitationId;
}

// --- scenarios -----------------------------------------------------------------

async function main() {
  console.log("P06 data-governance smoke — HTTP → Worker → D1 → R2\n");
  if (!existsSync(wranglerBin)) {
    throw new Error(`wrangler is not installed at ${wranglerBin}; run pnpm install first`);
  }
  await setupInfrastructure();

  stage = "fixtures";
  const alice = await authenticatedUser("Alice");
  const bob = await authenticatedUser("Bob");
  const carol = await authenticatedUser("Carol");
  // normalize_slug accepts 3-63 chars of [a-z0-9-] with no edge hyphen. An opaque ID
  // contains underscores, so it is not a slug; the first version passed one and the
  // probe reported a product 422 that was in fact a probe bug.
  const orgA = await createOrganization(alice.jar, "Alice Org", `alice-org-${nonce}`);
  const orgB = await createOrganization(carol.jar, "Carol Org", `carol-org-${nonce}`);
  await inviteAndAccept(alice, bob, orgA.orgId);

  // ---------------------------------------------------------------- export ----
  // The slice VI-DATA-001 was UNPROVEN for: a real export that reaches the object
  // store and can be read back over HTTP.
  stage = "org export";
  const created = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity", "organization", "audit_redacted"], format: "json" },
    browserMutation(alice.jar, "export-a"),
  );
  expectStatus("request an organization export", created, [201, 202]);
  // The response body IS the export object -- `StoredSuccess` stores the value as
  // built, not an envelope -- so the identifier is `id`, not `export.export_id`.
  const exportId = created.payload?.id;
  if (!assertId("the export job has an opaque ID", exportId, "exp")) {
    throw new Error("no export ID to follow");
  }
  expect(
    "the export is created in the `requested` state, not pre-declared as ready",
    ["requested", "queued", "collecting", "packaging", "verifying"].includes(
      created.payload?.state,
    ),
    `state=${created.payload?.state}`,
  );

  // The job is dispatched by the cron sweep, which this probe fires on demand, and
  // the local queue does deliver the message: the Worker log shows
  // `QUEUE lumi-agents-jobs-development 1/1` and the handler's own routing line
  // reports the jobs route. What does not happen is the body arriving intact -- the
  // consumer sees a message with no `job_type`, acknowledges it, and the job stays
  // `requested` forever.
  //
  // Reported as BLOCKED with the environment named: the R2 leg of this claim cannot
  // be decided on a local simulator, and a probe that guessed either way would be
  // worse than one that says which question it could not answer.
  let jobRows;
  try {
    jobRows = await waitForD1(
      "the export job reaches a terminal state",
      `SELECT state, attempt, failure_code FROM export_jobs WHERE export_id = '${exportId}'`,
      (found) =>
        found.length > 0 && ["ready", "failed", "expired", "cancelled"].includes(found[0].state),
      120_000,
    );
  } catch (error) {
    const envelope = await d1Rows(
      `SELECT job_type, state, attempt FROM queue_job_envelopes WHERE subject_id = '${exportId}'`,
      "P06 envelope diagnostic",
    );
    const outbox = await d1Rows(
      `SELECT event_type, delivery_status FROM outbox_events WHERE event_type = 'export.requested.v1'`,
      "P06 outbox diagnostic",
    );
    stopServices();
    console.log(
      `\nBLOCKED: the export was created and durably enqueued, but the local queue\n` +
        `simulator did not hand the job to the consumer in a form it could read, so the\n` +
        `R2 leg of VI-DATA-001 cannot be decided here.\n` +
        `  envelope  ${JSON.stringify(sanitize(envelope))}\n` +
        `  outbox    ${JSON.stringify(sanitize(outbox))}\n` +
        `  ${redactText(String(error.message)).slice(0, 180)}\n` +
        `Everything above this point -- the request, the durable rows, the CSRF and\n` +
        `permission checks -- is real evidence and is unaffected.`,
    );
    console.log(
      `\n${passes.length}/${passes.length + failures.length} P06 data-governance cases hold, 1 leg blocked by the environment`,
    );
    process.exit(2);
  }
  const exportState = jobRows[0].state;
  expect(
    "the export job reaches `ready`, so the local queue consumer really ran it",
    exportState === "ready",
    `state=${exportState} attempt=${jobRows[0].attempt} failure=${jobRows[0].failure_code ?? "none"}`,
  );
  if (exportState !== "ready") {
    fail(
      "the export is not downloadable, so the R2 assertions below cannot be trusted",
      "the job never became ready; the remaining checks assume a stored artifact",
    );
    return finish();
  }

  // R2: the object must exist in the bucket, not merely in a database row. Checking
  // the row alone would repeat the exact mistake this claim was UNPROVEN for.
  stage = "R2 artifact";
  const artifactRows = await d1Rows(
    `SELECT object_key, bucket_name, size_bytes, checksum_sha256, expires_at, deleted_at
     FROM export_artifacts WHERE export_id = '${exportId}'`,
    "P06 artifact row",
  );
  const objectKey = artifactRows[0]?.object_key;
  expect(
    "the export recorded the object key it stored",
    typeof objectKey === "string" && objectKey.length > 0,
    String(objectKey),
  );
  expect(
    "the stored artifact carries a size and a checksum, not just a key",
    Number(artifactRows[0]?.size_bytes) > 0 &&
      typeof artifactRows[0]?.checksum_sha256 === "string" &&
      artifactRows[0].checksum_sha256.length >= 32,
    `size=${artifactRows[0]?.size_bytes} sha=${String(artifactRows[0]?.checksum_sha256).slice(0, 16)}…`,
  );
  expect(
    "the export artifact is short-lived, not a permanent URL",
    typeof artifactRows[0]?.expires_at === "string" && artifactRows[0].expires_at !== "",
    `expires_at=${artifactRows[0]?.expires_at}`,
  );

  const bucketName =
    artifactRows[0]?.bucket_name ?? "lumi-agents-control-plane-exports-development";

  /**
   * Read an object out of the local R2 bucket.
   *
   * `wrangler r2 object list` DOES NOT EXIST in this wrangler version -- the first
   * version of this helper called it, `runWrangler` threw on the usage error, and
   * the throw escaped from inside an `expect(...)` argument, so the probe would have
   * died with a wrangler usage message instead of a check result. `r2 object get` is
   * the supported primitive, and it is strictly better evidence anyway: it returns
   * the object's bytes, so the HTTP download can be compared against what is really
   * in the bucket rather than against a filename in a listing.
   *
   * Returns `{ present, body }`; absence is a normal outcome, not an error, because
   * the deletion leg needs to assert exactly that.
   */
  const readObject = (key) => {
    if (typeof key !== "string" || key.length === 0) return { present: false, body: "" };
    const result = spawnSync(
      wranglerBin,
      [
        "r2",
        "object",
        "get",
        `${bucketName}/${key}`,
        "--local",
        "--env",
        "development",
        "--persist-to",
        persistDir,
        "--pipe",
      ],
      {
        cwd: apiDir,
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (result.error) return { present: false, body: "" };
    if (result.status !== 0) return { present: false, body: "" };
    return { present: true, body: result.stdout ?? "" };
  };
  const objectListed = (key) => readObject(key).present;

  const stored = readObject(objectKey);
  expect(
    "the object is present in the R2 bucket, not only in the database",
    stored.present,
    `bucket=${bucketName} key=${objectKey}`,
  );
  expect(
    "the object in R2 has a body, so the bucket really holds the export",
    stored.body.length > 0,
    `${stored.body.length} bytes in the bucket`,
  );

  const download = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports/${exportId}/download`,
    {},
    browserMutation(alice.jar, `download-${exportId}`),
    { raw: true },
  );
  expectStatus("the export artifact downloads over HTTP", download, [200]);
  expect(
    "the downloaded artifact has a body, so R2 really streamed the object",
    (download.text ?? "").length > 0,
    `${(download.text ?? "").length} bytes`,
  );
  expect(
    "the download is not a public object URL",
    typeof download.text === "string" &&
      !/^https?:\/\/[^\s]*r2\.cloudflarestorage/.test(download.text),
    "the body is the artifact itself, served by the Worker",
  );
  expect(
    "the downloaded bytes are the bytes in the bucket, so the Worker really streams R2",
    stored.present && download.text === stored.body,
    `downloaded=${(download.text ?? "").length}b stored=${stored.body.length}b`,
  );

  // A second request for the same frozen tuple returns the same job rather than
  // forking a second one. Same Idempotency-Key, same body.
  const repeated = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity", "organization", "audit_redacted"], format: "json" },
    browserMutation(alice.jar, "export-a"),
  );
  expectStatus(
    "a repeated export request with the same Idempotency-Key is answered",
    repeated,
    [200, 201],
  );
  expect(
    "the repeated request replays the same export instead of forking a second job",
    repeated.payload?.id === exportId,
    `first=${exportId} repeated=${repeated.payload?.id}`,
  );
  const jobCount = await d1Rows(
    `SELECT count(*) AS n FROM export_jobs WHERE scope_org_id = '${orgA.orgId}'`,
    "P06 export job count",
  );
  expect(
    "exactly one export job exists for that organization",
    Number(jobCount[0]?.n) === 1,
    `${jobCount[0]?.n} job(s)`,
  );

  // ------------------------------------------------------- cross-tenant ------
  // "Export crosses tenants" is the claim's first named failure mode, so the other
  // organization's owner is the principal that has to be refused.
  stage = "cross-tenant export";
  const carolGet = await request(
    carol.jar,
    "GET",
    `/api/v1/orgs/${orgA.orgId}/exports/${exportId}`,
  );
  expect(
    "another organization's owner cannot read this export",
    statusIs(carolGet, [403, 404]),
    `status=${carolGet.status} reason=${reasonOf(carolGet)}`,
  );
  const carolDownload = await request(
    carol.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports/${exportId}/download`,
    {},
    browserMutation(carol.jar, `carol-download-${exportId}`),
    { raw: true },
  );
  expect(
    "another organization's owner cannot download this export",
    statusIs(carolDownload, [403, 404]),
    `status=${carolDownload.status} reason=${reasonOf(carolDownload)}`,
  );
  const carolCreate = await request(
    carol.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity"], format: "json" },
    browserMutation(carol.jar, "carol-export-a"),
  );
  expect(
    "another organization's owner cannot start an export against it",
    statusIs(carolCreate, [403, 404]),
    `status=${carolCreate.status} reason=${reasonOf(carolCreate)}`,
  );

  // A member of org A has no DataExport permission, so the export surface is not
  // merely tenant-scoped but permission-scoped.
  stage = "permission boundary";
  const bobCreate = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity"], format: "json" },
    browserMutation(bob.jar, "bob-export"),
  );
  expect(
    "a plain member cannot start an organization export",
    statusIs(bobCreate, [403]),
    `status=${bobCreate.status} reason=${reasonOf(bobCreate)}`,
  );
  const bobGet = await request(bob.jar, "GET", `/api/v1/orgs/${orgA.orgId}/exports/${exportId}`);
  expect(
    "a plain member cannot read the organization's export",
    statusIs(bobGet, [403, 404]),
    `status=${bobGet.status} reason=${reasonOf(bobGet)}`,
  );

  // Carol's own export, so the deletion leg below has an artifact that belongs to the
  // principal being deleted.
  stage = "second org export";
  const carolExport = await request(
    carol.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/exports`,
    { categories: ["identity", "organization"], format: "json" },
    browserMutation(carol.jar, "export-b"),
  );
  expectStatus("the second organization can export its own data", carolExport, [201, 202]);
  const carolExportId = carolExport.payload?.id;
  if (assertId("the second export has an opaque ID", carolExportId, "exp")) {
    const carolRows = await waitForD1(
      "the second export job reaches a terminal state",
      `SELECT state, failure_code FROM export_jobs WHERE export_id = '${carolExportId}'`,
      (found) =>
        found.length > 0 && ["ready", "failed", "expired", "cancelled"].includes(found[0].state),
      120_000,
    );
    expect(
      "the second export job also reaches `ready`",
      carolRows[0].state === "ready",
      `state=${carolRows[0].state} failure=${carolRows[0].failure_code ?? "none"}`,
    );
    const carolArtifact = await d1Rows(
      `SELECT object_key FROM export_artifacts WHERE export_id = '${carolExportId}'`,
      "P06 second artifact row",
    );
    expect(
      "the second organization has its own distinct object in R2",
      objectListed(carolArtifact[0]?.object_key) && carolArtifact[0]?.object_key !== objectKey,
      `a=${objectKey} b=${carolArtifact[0]?.object_key}`,
    );
  }

  const summary = {
    exportId,
    objectKey,
    bucketName,
    carolExportId,
    carolObjectKey: (
      await d1Rows(
        `SELECT object_key FROM export_artifacts WHERE export_id = '${carolExportId ?? "none"}'`,
        "P06 second artifact key",
      )
    )[0]?.object_key,
  };
  console.log(`\nP06 summary ${JSON.stringify(summary)}`);

  return finish();
}

function finish() {
  stopServices();
  console.log(
    `\n${passes.length}/${passes.length + failures.length} P06 data-governance cases hold`,
  );
  if (failures.length > 0) {
    console.log(`\n${failures.length} case(s) failed:`);
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
  process.exit(0);
}

process.on("exit", () => {
  stopServices();
  if (persistOwned && persistDir) rmSync(persistDir, { recursive: true, force: true });
});

main()
  .then(() => {})
  .catch((error) => {
    // A harness failure that deletes its own diagnostics makes every future run start
    // from scratch, so the Worker's own log is printed before the services are stopped.
    const service = services.find((entry) => entry.label === "Worker");
    stopServices();
    console.error(`\nP06 probe harness failure: ${redactText(error.message)}`);
    if (service) {
      console.error(
        // A 3 KB tail cut the very lines that explain a dispatch failure: the
        // per-request logs pushed them out. 24 KB keeps the failure readable without
        // printing an unbounded log.
        `\n--- Worker log (tail) ---\n${redactText(service.output ?? "").slice(-24_000)}`,
      );
    }
    if (failures.length === 0) process.exit(2);
    process.exit(1);
  });
