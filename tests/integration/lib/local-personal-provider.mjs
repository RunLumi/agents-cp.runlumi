// Local personal provider for the desktop automation journey. Why it exists: the isolated profile had no local
// default model, so the unmarked "Local control" automation threw `Automation 无法从目标 Host 解析首选模型`
// (local-control-retained-readback.json) and the old predicate still counted that as "dispatched". This module
// gives the profile ONE synthetic personal OpenAI-compatible provider that points at a loopback stub, so local
// personal work can really complete, and it grades completion by authoritative state, not by an attempt.
//
// Boundaries (spec 04 isolation, F11 FR-F11-004, inference-v1 "never silently replaced"):
//   * The config is written with the repository's own codec (local-personal-provider.entry.mts) into the
//     profile only, with a synthetic key and a loopback URL. No real credential, personal profile, org model or
//     managed provider is read, copied, seeded or relaxed; org policy is untouched.
//   * The stub keeps counts, header NAMES and booleans only (no bodies, no header values), is bounded, and
//     binds 127.0.0.1. Nothing leaves the machine and nothing is spent.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { canonicalPath, ownedProviderConfigPaths } from "./lumi-child-env.mjs";
import { until } from "./automation-evidence.mjs";
import { readTable } from "./automation-journey-state.mjs";
import { assistantTerminal, assistantText, managedTasks, outputShape, probe, taskOutput } from "./automation-task-output.mjs";

const run = promisify(execFile);

export const LOCAL_PROVIDER = Object.freeze({
  providerId: "e2e-personal-stub",
  providerName: "E2E personal stub",
  modelId: "stub-chat",
  reasoningValues: ["low", "high"],
  defaultReasoningLevel: "low",
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
});

const ENTRY = "tests/integration/lib/local-personal-provider.entry.mts";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ENTRY_STDOUT_BYTES = 1024 * 1024;

/**
 * Run the declared TypeScript extension on the SUPERVISOR's own Node (`process.execPath`) with the client's tsx
 * registered as an ESM loader (`--import`). The tsx CLI is deliberately not used: it forks a child over an IPC
 * pipe, and that child could resolve a different Node major than the supervisor.
 * Scope: cwd is the client, env is an allow-list (no user env, no root/provider-config variables), the run is
 * time- and output-bounded, and stdout must be exactly one JSON document. Failures are redacted to the mode and
 * exit status so no argument (paths, spec JSON) is echoed.
 */
export async function runEntry(root, mode, first, second, { timeout = 60_000 } = {}) {
  const client = join(root, "integrations/lumi-agents");
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    NODE_NO_WARNINGS: "1",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
  let stdout;
  try {
    ({ stdout } = await run(
      process.execPath,
      ["--import", pathToFileURL(join(client, "node_modules/tsx/dist/loader.mjs")).href, join(root, ENTRY), mode, first, second],
      { cwd: client, env, timeout, maxBuffer: MAX_ENTRY_STDOUT_BYTES, encoding: "utf8" },
    ));
  } catch (error) {
    const reason = error.killed ? `timed out after ${timeout}ms` : `exit ${error.code ?? "unknown"}`;
    throw new Error(`local-personal-provider entry "${mode}" failed (${reason})`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`local-personal-provider entry "${mode}" did not print exactly one JSON document`);
  }
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Loopback OpenAI-compatible `/v1/chat/completions` responder.
 * `markers` is `{ name: substring }`; a request is attributed to a marker by substring presence only, and only
 * the boolean is kept, so no prompt text is stored. After `maxRequests` the stub answers 429 (bounded spend/work).
 */
export async function startLocalProviderStub({ stamp, markers = {}, maxRequests = 200 } = {}) {
  const apiKey = `sk-synthetic-e2e-${stamp}`;
  const reply = `LOCAL-PERSONAL-STUB-OK-${stamp}`;
  const requests = [];
  let rejected = 0;
  let unauthorized = 0;
  let other = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
        other += 1;
        res.writeHead(path.endsWith("/models") ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(path.endsWith("/models") ? { object: "list", data: [{ id: LOCAL_PROVIDER.modelId, object: "model" }] } : { error: "not found" }));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const authorized = req.headers.authorization === `Bearer ${apiKey}`;
      const record = {
        path,
        stream: parsed?.stream === true,
        model: typeof parsed?.model === "string" ? parsed.model.slice(0, 80) : null,
        authorized,
        headerNames: Object.keys(req.headers).sort(),
        bodyBytes: size,
        markers: Object.entries(markers)
          .filter(([, needle]) => text.includes(needle))
          .map(([name]) => name),
      };
      if (!authorized) {
        unauthorized += 1;
        requests.push(record);
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad synthetic key", type: "invalid_request_error" } }));
        return;
      }
      if (requests.filter((item) => item.authorized).length >= maxRequests) {
        rejected += 1;
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub request cap reached", type: "rate_limit" } }));
        return;
      }
      requests.push(record);
      const base = { id: `chatcmpl-stub-${requests.length}`, created: Math.floor(Date.now() / 1_000), model: LOCAL_PROVIDER.modelId };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (record.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] });
        send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    apiKey,
    reply,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    /** Content-free snapshot: counts and booleans, never bodies or header values. */
    stats() {
      const accepted = requests.filter((item) => item.authorized);
      const byMarker = Object.fromEntries(Object.keys(markers).map((name) => [name, accepted.filter((item) => item.markers.includes(name)).length]));
      return { accepted: accepted.length, unauthorized, rejected, other, byMarker, maxRequests, requests: requests.map((item) => ({ ...item })) };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Write the profile-owned catalogs BEFORE the first launch: a copy of the repository builtin catalog and the
 * personal config built by the repository codec. Then read it back through the real registry + facade: the
 * resolution `resolveAutomationSubmissionModelSelection` performs (preferred selection WITH a reasoning level)
 * must succeed here, or the fixture is wrong and nothing has launched yet.
 */
export async function writeLocalPersonalConfig({ root, profile, stub }) {
  const { builtinFilePath, personalFilePath } = ownedProviderConfigPaths(profile);
  mkdirSync(dirname(builtinFilePath), { recursive: true });
  copyFileSync(join(root, "integrations/lumi-agents/config/provider/zcode-builtin.json"), builtinFilePath);
  const spec = { ...LOCAL_PROVIDER, apiKey: stub.apiKey, baseUrl: stub.baseUrl };
  const written = await runEntry(root, "write", personalFilePath, JSON.stringify(spec));
  const view = await runEntry(root, "resolve", builtinFilePath, personalFilePath);
  assert.deepEqual(
    view.preferredSelection,
    written.defaultModelSelection,
    `the Host would not resolve the synthetic default as preferred: ${JSON.stringify(view)}`,
  );
  assert.ok(view.preferredSelection.options?.reasoningLevel, "preferred selection carries a reasoning level");
  return { builtinFilePath, personalFilePath, defaultModelSelection: written.defaultModelSelection, sha256: sha256(personalFilePath), visibleProviders: view.visibleProviders };
}

/** Hash of the profile's personal provider config bytes (before/after adoption must match). */
export const personalConfigHash = (profile) => sha256(ownedProviderConfigPaths(profile).personalFilePath);

/** Seed a control with an explicit selection that is NOT in the catalog (must be rejected, never replaced). */
export async function seedBadModelControl({ root, profile, spec }) {
  const dbPath = join(profile, "home", ".zcode", "v2", "tasks-index.sqlite");
  return runEntry(
    root,
    "seed-bad-model",
    dbPath,
    JSON.stringify({ ...spec, modelSelection: { providerId: LOCAL_PROVIDER.providerId, modelId: "absent-model", options: { reasoningLevel: LOCAL_PROVIDER.defaultReasoningLevel } } }),
  );
}

const truncate = (value) => String(value ?? "").slice(0, 200);

/** Same directory on REAL paths: macOS tmpdir is a symlink (/var -> /private/var) and the product may store either spelling. */
const sameDirectory = (a, b) => typeof a === "string" && canonicalPath(a) === canonicalPath(b);

/**
 * Authoritative local run verdict from the profile's own stores. Pure read; no waiting.
 *   { status: "completed", run, task, ... }   a run row is dispatched+succeeded with no error AND its Agent
 *                                             task is completed AND the assistant text holds the stub reply
 *   { status: "failed", reason }              a run/task reports failure (reason carries the recorded error)
 *   { status: "pending", reason }             nothing terminal yet (caller keeps waiting)
 * An attempt, `last_error`, or a dispatched-only row is never `completed`.
 */
export function readLocalRun(profile, { automationId, reply, workspacePath }) {
  const automation = readTable(profile, "SELECT dispatch_status, dispatch_attempts, run_count, last_error FROM automations WHERE automation_id = ?", automationId)[0];
  if (!automation) return { status: "failed", reason: "automation row missing" };
  const runs = readTable(profile, "SELECT run_id, dispatch_status, outcome, session_id, error, attempts, model_selection FROM automation_runs WHERE automation_id = ? ORDER BY created_at", automationId);
  const failedRun = runs.find((row) => row.dispatch_status === "failed_to_dispatch" || row.outcome === "failed" || row.error);
  if (failedRun) return { status: "failed", reason: `run ${failedRun.run_id} ${failedRun.dispatch_status}/${failedRun.outcome}: ${truncate(failedRun.error)}` };
  const succeeded = runs.filter((row) => row.dispatch_status === "dispatched" && row.outcome === "succeeded" && !row.error && row.session_id);
  if (succeeded.length === 0)
    return {
      status: "pending",
      reason: `no succeeded run yet (runs ${JSON.stringify(runs.map((row) => [row.dispatch_status, row.outcome]))}; automation attempts ${automation.dispatch_attempts}, last_error ${truncate(automation.last_error) || "none"})`,
    };
  const tasks = probe(() => managedTasks(profile, { localAutomationId: automationId }));
  if (tasks.status !== "ok") return { status: "pending", reason: `tasks-index not readable (${tasks.code})` };
  for (const run of succeeded) {
    const task = tasks.value.find((item) => item.taskId === run.session_id);
    if (!task || task.status !== "completed") continue;
    if (workspacePath && !sameDirectory(task.workspacePath, workspacePath)) return { status: "failed", reason: "the control's task ran in a different workspace" };
    const output = probe(() => taskOutput(profile, task.taskId));
    if (output.status !== "ok") return { status: "pending", reason: `Agent store not readable (${output.code})` };
    if (!assistantTerminal(output.value)) continue;
    if (!assistantText(output.value).includes(reply))
      return { status: "failed", reason: `completed task lacks the stub marker: ${JSON.stringify(outputShape(output.value))}` };
    return { status: "completed", run, task, runCount: automation.run_count, modelSelection: run.model_selection };
  }
  return { status: "pending", reason: "run succeeded but no completed Agent task with a terminal assistant message yet" };
}

/** Wait for `readLocalRun` to be `completed`; a `failed` verdict throws immediately with the recorded reason. */
export async function awaitLocalRun(label, profile, params, { timeout = 150_000, every = 4_000 } = {}) {
  const result = await until(label, async () => readLocalRun(profile, params), (value) => value.status !== "pending", {
    timeout,
    every,
  });
  assert.equal(result.status, "completed", `${label}: ${result.reason}`);
  return result;
}

const rowOf = (profile, id) => readTable(profile, "SELECT * FROM automations WHERE automation_id = ?", id)[0];

/**
 * BEFORE adoption (call after onboarding, before the adopt stage): local personal work completes with no
 * managed involvement, and an explicit absent model is rejected instead of silently replaced. Records the
 * baseline config hash that the post-adoption proof compares against.
 */
export async function preAdoptionLocalProof(ctx) {
  const { ledger, profileA, workspacePath, seeds, localProvider } = ctx;
  const { stub } = localProvider;
  const done = await awaitLocalRun(
    "pre-adoption local preflight completes through the personal stub",
    profileA,
    { automationId: seeds.preflight.automationId, reply: stub.reply, workspacePath },
    { timeout: 240_000 },
  );
  const stats = stub.stats();
  assert.ok(stats.byMarker.preflight >= 1, "the stub received the preflight prompt");
  assert.equal(stats.byMarker.adopted, 0, "the future adoption original has made no local request");
  assert.equal(stats.unauthorized, 0, "every stub request carried the synthetic key");
  const baseline = personalConfigHash(profileA);
  ctx.state.localProvider = { baselineSha256: baseline, preflightRunId: done.run.run_id, preflightTaskId: done.task.taskId };
  ledger.pass(
    `pre-adoption positive: local preflight run ${done.run.run_id} is dispatched+succeeded with no error and its completed Agent task holds the stub marker (provider ${LOCAL_PROVIDER.providerId}; ${stats.byMarker.preflight} stub request(s) for it, config sha256 ${baseline.slice(0, 12)})`,
  );

  const bad = await until(
    "the explicit absent-model control is rejected",
    async () => rowOf(profileA, seeds.badModel.automationId),
    (row) => !!row && !!row.last_error,
    { timeout: 120_000, every: 4_000 },
  );
  assert.match(bad.last_error, /模型选择不可用/, `explicit bad model must fail with the selection error, got ${truncate(bad.last_error)}`);
  const badRuns = readTable(profileA, "SELECT dispatch_status, outcome, session_id FROM automation_runs WHERE automation_id = ?", seeds.badModel.automationId);
  assert.ok(badRuns.every((row) => row.dispatch_status !== "dispatched" && row.outcome !== "succeeded" && !row.session_id), `no bad-model run may dispatch: ${JSON.stringify(badRuns)}`);
  assert.equal(managedTasks(profileA, { localAutomationId: seeds.badModel.automationId }).length, 0, "no Agent task exists for the bad-model control");
  assert.equal(stub.stats().byMarker.badModel, 0, "the bad-model prompt never reached the stub (no silent fallback to the default)");
  ledger.pass(`explicit absent model negative: rejected with the selection error, ${badRuns.length} run row(s) none dispatched, no task, 0 stub requests (no silent fallback)`);
}

/**
 * AFTER adoption (call once the control is due): the unmarked control in the SAME workspace, still following
 * the Host default, completed locally with the same personal provider and unchanged config, while the adopted
 * original made no local stub request. Replaces the old attempt/last_error predicate.
 */
export async function postAdoptionLocalProof(ctx) {
  const { ledger, profileA, workspacePath, seeds, localProvider, state } = ctx;
  const { stub } = localProvider;
  const done = await awaitLocalRun(
    "post-adoption unmarked control completes through the personal stub",
    profileA,
    { automationId: seeds.control.automationId, reply: stub.reply, workspacePath },
    { timeout: 240_000 },
  );
  const control = rowOf(profileA, seeds.control.automationId);
  assert.equal(control.model_selection, "null", "the control still follows the Host default (its stored selection was not changed)");
  assert.ok(!control.last_error, `control last_error must be empty, got ${truncate(control.last_error)}`);
  const frozen = JSON.parse(done.modelSelection ?? "null");
  assert.equal(frozen?.providerId, LOCAL_PROVIDER.providerId, `the run froze ${JSON.stringify(frozen)}, not the personal provider`);
  assert.notEqual(frozen.providerId, "lumi-managed", "managed mode did not replace the local personal model");
  assert.equal(personalConfigHash(profileA), state.localProvider.baselineSha256, "provider_config.json bytes changed across adoption");
  const stats = stub.stats();
  assert.ok(stats.byMarker.control >= 1, "the stub received the control prompt");
  assert.equal(stats.byMarker.adopted, 0, "the adopted original made zero local stub requests (only the managed path ran it)");
  assert.equal(stats.unauthorized + stats.rejected, 0, `stub saw unauthorized=${stats.unauthorized} rejected=${stats.rejected}`);
  ledger.pass(
    `post-adoption positive: control run ${done.run.run_id} (same workspace, selection "null") is dispatched+succeeded with no error, its completed task ${done.task.taskId} holds the stub marker and it froze ${frozen.providerId}/${frozen.modelId}; provider_config.json sha256 unchanged (${state.localProvider.baselineSha256.slice(0, 12)}); stub requests control=${stats.byMarker.control} adopted=${stats.byMarker.adopted} badModel=${stats.byMarker.badModel} of cap ${stats.maxRequests}`,
  );
}
