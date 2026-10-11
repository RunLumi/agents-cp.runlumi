// Focused controls for local-personal-provider.mjs and the provider env in lumi-child-env.mjs. Synthetic scratch
// profiles only; no Electron, no Worker, no network beyond the loopback stub, no personal profile.
// Run: node --test tests/integration/lib/local-personal-provider.test.mjs
//   (the last two tests spawn the client's tsx for the real codec/registry; they need `pnpm install` done)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { agentStoreFile, tasksIndexFile } from "./automation-task-output.mjs";
import {
  LOCAL_PROVIDER,
  readLocalRun,
  runEntry,
  startLocalProviderStub,
  writeLocalPersonalConfig,
} from "./local-personal-provider.mjs";
import { isolatedChildEnv, ownedProviderConfigEnv, ownedProviderConfigPaths } from "./lumi-child-env.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const root = resolve(import.meta.dirname, "../../..");
const scratch = () => mkdtempSync(join(tmpdir(), "local-provider-test-"));
const post = (url, key, body) =>
  fetch(`${url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("stub: JSON and SSE replies carry the marker; counts and markers are booleans, never bodies or key values", async () => {
  const stub = await startLocalProviderStub({ stamp: "t1", markers: { control: "CONTROL-X", adopted: "ADOPTED-X" }, maxRequests: 10 });
  try {
    const json = await (await post(stub.baseUrl, stub.apiKey, { model: "stub-chat", messages: [{ role: "user", content: "hi CONTROL-X" }] })).json();
    assert.equal(json.choices[0].message.content, stub.reply);
    const sse = await (await post(stub.baseUrl, stub.apiKey, { model: "stub-chat", stream: true, messages: [{ role: "user", content: "hi" }] })).text();
    assert.ok(sse.includes(stub.reply) && sse.trimEnd().endsWith("data: [DONE]"));
    const stats = stub.stats();
    assert.deepEqual([stats.accepted, stats.byMarker.control, stats.byMarker.adopted, stats.unauthorized], [2, 1, 0, 0]);
    const text = JSON.stringify(stats);
    for (const secret of [stub.apiKey, "hi CONTROL-X", "Bearer"]) assert.equal(text.includes(secret), false, `stats leak ${secret}`);
    assert.ok(stats.requests[0].headerNames.includes("authorization"), "header NAMES are kept");
  } finally {
    await stub.close();
  }
});

test("stub: a wrong key is 401 and not counted as accepted work; the cap answers 429 and is bounded", async () => {
  const stub = await startLocalProviderStub({ stamp: "t2", maxRequests: 2 });
  try {
    assert.equal((await post(stub.baseUrl, "sk-wrong", { messages: [] })).status, 401);
    assert.equal((await post(stub.baseUrl, stub.apiKey, { messages: [] })).status, 200);
    assert.equal((await post(stub.baseUrl, stub.apiKey, { messages: [] })).status, 200);
    assert.equal((await post(stub.baseUrl, stub.apiKey, { messages: [] })).status, 429);
    const stats = stub.stats();
    assert.deepEqual([stats.accepted, stats.unauthorized, stats.rejected], [2, 1, 1]);
    assert.equal((await fetch(`${stub.baseUrl}/models`)).status, 200);
    assert.equal(stub.stats().other, 1);
  } finally {
    await stub.close();
  }
});

// ---- readLocalRun: the authoritative verdict --------------------------------------------------------------
const WORKSPACE = "workspace-real";
const REPLY = "LOCAL-PERSONAL-STUB-OK-fixture";

function fixtureProfile({ run, task, assistant = REPLY, completed = true }) {
  const profile = scratch();
  mkdirSync(join(profile, WORKSPACE), { recursive: true });
  mkdirSync(dirname(tasksIndexFile(profile)), { recursive: true });
  const db = new DatabaseSync(tasksIndexFile(profile));
  db.exec(`CREATE TABLE automations (automation_id TEXT, dispatch_status TEXT, dispatch_attempts INTEGER, run_count INTEGER, last_error TEXT);
    CREATE TABLE automation_runs (run_id TEXT, automation_id TEXT, dispatch_status TEXT, outcome TEXT, session_id TEXT, error TEXT, attempts INTEGER, model_selection TEXT, created_at INTEGER);
    CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, task_id TEXT, title TEXT, task_status TEXT, model TEXT, created_at INTEGER, updated_at INTEGER, meta_json TEXT, deleted INTEGER NOT NULL DEFAULT 0)`);
  db.prepare("INSERT INTO automations VALUES ('a1','idle',?,?,?)").run(run?.attempts ?? 3, run?.runCount ?? 0, run?.lastError ?? null);
  if (run)
    db.prepare("INSERT INTO automation_runs VALUES ('r1','a1',?,?,?,?,1,?,1)").run(
      run.dispatch, run.outcome ?? null, run.session ?? null, run.error ?? null, JSON.stringify({ providerId: LOCAL_PROVIDER.providerId, modelId: LOCAL_PROVIDER.modelId }),
    );
  if (task)
    db.prepare("INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, model, created_at, updated_at, meta_json) VALUES ('w',?,?,?,?,?,1,1,?)").run(
      task.workspace ?? join(profile, WORKSPACE), "s1", "t", task.status ?? "completed", "m", JSON.stringify({ cronAutomationId: "a1" }),
    );
  db.close();
  if (task) {
    mkdirSync(dirname(agentStoreFile(profile)), { recursive: true });
    const agent = new DatabaseSync(agentStoreFile(profile));
    agent.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    agent.prepare("INSERT INTO session VALUES ('s1')").run();
    agent.prepare("INSERT INTO message VALUES ('m1','s1',1,1,1,?)").run(JSON.stringify({ role: "assistant", time: completed ? { completed: 2 } : {} }));
    agent.prepare("INSERT INTO part VALUES ('p1','m1','s1',1,1,1,?)").run(JSON.stringify({ type: "text", text: assistant }));
    agent.close();
  }
  return profile;
}
const verdict = (profile) => readLocalRun(profile, { automationId: "a1", reply: REPLY, workspacePath: join(profile, WORKSPACE) });
const OK_RUN = { dispatch: "dispatched", outcome: "succeeded", session: "s1", attempts: 1, lastError: null };

test("verifier fails the ORIGINAL defect: attempts + last_error + failed run is FAILED, never completed", () => {
  const profile = fixtureProfile({
    run: { dispatch: "failed_to_dispatch", error: "Automation 无法从目标 Host 解析首选模型", lastError: "Automation 无法从目标 Host 解析首选模型" },
  });
  const result = verdict(profile);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /无法从目标 Host 解析首选模型/);
});

test("verifier: attempts without any run, or a dispatched-only run, stay pending (not completed)", () => {
  assert.equal(verdict(fixtureProfile({})).status, "pending");
  assert.equal(verdict(fixtureProfile({ run: { dispatch: "dispatched", session: "s1", attempts: 1 } })).status, "pending");
});

test("verifier positive control: succeeded run + completed task + stub marker is completed", () => {
  const profile = fixtureProfile({ run: OK_RUN, task: {} });
  const result = verdict(profile);
  assert.equal(result.status, "completed");
  assert.equal(result.run.run_id, "r1");
  assert.equal(result.task.taskId, "s1");
});

test("verifier: a succeeded run whose task is incomplete, lacks the marker, or ran elsewhere is not completed", () => {
  assert.equal(verdict(fixtureProfile({ run: OK_RUN, task: { status: "running" } })).status, "pending");
  assert.equal(verdict(fixtureProfile({ run: OK_RUN, task: {}, completed: false })).status, "pending");
  const noMarker = verdict(fixtureProfile({ run: OK_RUN, task: {}, assistant: "some other reply" }));
  assert.equal(noMarker.status, "failed");
  assert.match(noMarker.reason, /lacks the stub marker/);
  const elsewhere = verdict(fixtureProfile({ run: OK_RUN, task: { workspace: join(scratch(), "other") } }));
  assert.equal(elsewhere.status, "failed");
  assert.match(elsewhere.reason, /different workspace/);
});

// ---- profile-owned provider env ---------------------------------------------------------------------------
test("provider env: absent files add nothing; both files add BOTH keys inside the profile; supervisor values are never inherited", () => {
  const profile = scratch();
  assert.deepEqual(ownedProviderConfigEnv(profile), {});
  const { builtinFilePath, personalFilePath } = ownedProviderConfigPaths(profile);
  mkdirSync(dirname(builtinFilePath), { recursive: true });
  mkdirSync(dirname(personalFilePath), { recursive: true });
  writeFileSync(builtinFilePath, "{}");
  assert.deepEqual(ownedProviderConfigEnv(profile), {}, "only one file present must not set one key (the runtime throws on that)");
  writeFileSync(personalFilePath, "{}");
  const env = ownedProviderConfigEnv(profile);
  assert.deepEqual(Object.keys(env).sort(), ["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]);
  const child = isolatedChildEnv(profile, {}, { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/personal/builtin.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/personal/p.json", PATH: "/bin" });
  assert.equal(child.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, builtinFilePath);
  assert.equal(child.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, personalFilePath);
  const bare = isolatedChildEnv(scratch(), {}, { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/personal/p.json" });
  assert.equal(bare.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined, "an unowned profile drops the supervisor's value");
  assert.throws(() => isolatedChildEnv(profile, { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/elsewhere" }, {}), /overrides may not replace isolation roots/);
});

// ---- real codec + registry (spawns the client's tsx; no Electron) --------------------------------------------
test("fixture config is accepted by the repository codec and the real registry resolves it as preferred with a reasoning level", async () => {
  const profile = scratch();
  const stub = await startLocalProviderStub({ stamp: "t3" });
  try {
    const written = await writeLocalPersonalConfig({ root, profile, stub });
    assert.equal(written.defaultModelSelection.providerId, LOCAL_PROVIDER.providerId);
    assert.equal(written.defaultModelSelection.options.reasoningLevel, LOCAL_PROVIDER.defaultReasoningLevel);
    assert.deepEqual(written.visibleProviders, [LOCAL_PROVIDER.providerId]);
  } finally {
    await stub.close();
  }
});

test("verifier fails the ORIGINAL profile: with no personal provider the real registry resolves NO preferred selection", async () => {
  const profile = scratch();
  const { builtinFilePath, personalFilePath } = ownedProviderConfigPaths(profile);
  mkdirSync(dirname(builtinFilePath), { recursive: true });
  mkdirSync(dirname(personalFilePath), { recursive: true });
  writeFileSync(builtinFilePath, JSON.stringify(JSON.parse((await import("node:fs")).readFileSync(join(root, "integrations/lumi-agents/config/provider/zcode-builtin.json"), "utf8"))));
  writeFileSync(
    personalFilePath,
    JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }),
  );
  const view = await runEntry(root, "resolve", builtinFilePath, personalFilePath);
  assert.equal(view.preferredSelection, null, `the keyless isolated profile has no preferred model: ${JSON.stringify(view)}`);
});
