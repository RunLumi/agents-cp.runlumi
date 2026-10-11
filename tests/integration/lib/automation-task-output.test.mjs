// Focused controls for automation-task-output.mjs and lumi-child-env.mjs. Everything runs on synthetic
// profiles built in a scratch directory with the production table shapes; nothing here reads the
// operator's home. Run: node --test tests/integration/lib/automation-task-output.test.mjs
//   Optional: DE2E_RETAINED_PROFILE=<old profile> asserts the OLD (pre-isolation) profile has a task row
//   but NO Agent store inside it, i.e. its Agent output is UNPROVEN, never empty success.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentStoreFile,
  assistantText,
  assistantTerminal,
  managedTasks,
  outputShape,
  probe,
  readWorkspaceFile,
  taskOutput,
  tasksIndexFile,
} from "./automation-task-output.mjs";
import { assertProfileIsNotPersonal, describeIsolation, isolatedChildEnv, isolatedHomeLayout, prepareIsolatedHome } from "./lumi-child-env.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const scratch = () => mkdtempSync(join(tmpdir(), "task-output-test-"));
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code ?? error.message;
  }
  return undefined;
};

function makeTasksIndex(profile, { tasks = [], badMeta } = {}) {
  mkdirSync(join(profile, "home", ".zcode", "v2"), { recursive: true });
  const db = new DatabaseSync(tasksIndexFile(profile));
  db.exec(`CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, task_id TEXT, title TEXT, task_status TEXT,
    model TEXT, created_at INTEGER, updated_at INTEGER, meta_json TEXT, deleted INTEGER NOT NULL DEFAULT 0)`);
  for (const task of tasks)
    db.prepare("INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, model, created_at, updated_at, meta_json) VALUES ('w','w',?,?,?,?,?,?,?)").run(
      task.id, "t", task.status ?? "completed", "m", task.at ?? 1, 1, badMeta ?? JSON.stringify({ cronAutomationId: task.automation }),
    );
  db.close();
}

function makeAgentStore(path, { sessions = [], messages = [], parts = [], skipPart = false } = {}) {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)");
  if (!skipPart)
    db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)");
  for (const id of sessions) db.prepare("INSERT INTO session VALUES (?)").run(id);
  messages.forEach((m, i) => db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(m.id, m.session, i, i, i, m.data));
  parts.forEach((p, i) => db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(p.id, p.message, p.session, i, i, i, p.data));
  db.close();
}

const GOOD = {
  sessions: ["sess_1"],
  messages: [
    { id: "m1", session: "sess_1", data: '{"role":"user","time":{"created":1}}' },
    { id: "m2", session: "sess_1", data: '{"role":"assistant","time":{"created":2,"completed":3},"finish":"stop"}' },
  ],
  parts: [
    { id: "p1", message: "m1", session: "sess_1", data: '{"type":"text","text":"do the thing"}' },
    { id: "p2", message: "m2", session: "sess_1", data: '{"type":"text","text":"Hello from Lumi."}' },
  ],
};

test("positive control: an isolated profile yields the task row and the assistant text from ITS OWN store", () => {
  const profile = scratch();
  makeTasksIndex(profile, { tasks: [{ id: "sess_1", automation: "automation-a" }, { id: "sess_9", automation: "automation-b" }] });
  makeAgentStore(agentStoreFile(profile), GOOD);
  assert.deepEqual(managedTasks(profile, { localAutomationId: "automation-a" }).map((t) => t.taskId), ["sess_1"]);
  const output = taskOutput(profile, "sess_1");
  assert.equal(assistantText(output), "Hello from Lumi.");
  assert.equal(assistantTerminal(output), true);
  assert.equal(JSON.stringify(outputShape(output)).includes("Hello"), false, "the shape is content-free");
});

test("a genuinely empty task index is [], a missing one is unavailable (UNPROVEN), never empty", () => {
  const empty = scratch();
  makeTasksIndex(empty);
  assert.deepEqual(managedTasks(empty), []);
  assert.equal(codeOf(() => managedTasks(scratch())), "task_index_unavailable");
  assert.equal(probe(() => managedTasks(scratch())).status, "unproven");
});

test("no HOME fallback: a profile without an Agent store is unavailable even when HOME has one", () => {
  const profile = scratch();
  makeTasksIndex(profile, { tasks: [{ id: "sess_1", automation: "a" }] });
  const fakeHome = scratch();
  makeAgentStore(join(fakeHome, ".zcode", "cli", "db", "db.sqlite"), GOOD);
  const previous = process.env.HOME;
  process.env.HOME = fakeHome; // a decoy ONLY: proves the reader ignores it; restored below
  try {
    assert.equal(codeOf(() => taskOutput(profile, "sess_1")), "agent_store_unavailable");
    assert.equal(probe(() => taskOutput(profile, "sess_1")).status, "unproven");
  } finally {
    process.env.HOME = previous;
  }
});

test("a symlinked or relative profile store that resolves outside the profile is refused", () => {
  const profile = scratch();
  const outside = scratch();
  makeAgentStore(join(outside, "db.sqlite"), GOOD);
  mkdirSync(join(profile, "home", ".zcode", "cli"), { recursive: true });
  symlinkSync(outside, join(profile, "home", ".zcode", "cli", "db"));
  assert.equal(codeOf(() => taskOutput(profile, "sess_1")), "agent_store_outside_profile");
  assert.equal(codeOf(() => taskOutput("relative/profile", "sess_1")), "profile_invalid");
  assert.equal(codeOf(() => taskOutput(join(profile, "missing"), "sess_1")), "profile_invalid");
});

test("a missing schema, session or malformed JSON is a stable error, never empty", () => {
  const profile = scratch();
  makeAgentStore(agentStoreFile(profile), { sessions: GOOD.sessions, messages: GOOD.messages, skipPart: true });
  assert.equal(codeOf(() => taskOutput(profile, "sess_1")), "agent_store_schema_invalid");
  const noSession = scratch();
  makeAgentStore(agentStoreFile(noSession), GOOD);
  assert.equal(codeOf(() => taskOutput(noSession, "sess_absent")), "agent_session_missing");
  const badMessage = scratch();
  makeAgentStore(agentStoreFile(badMessage), { sessions: ["s"], messages: [{ id: "m", session: "s", data: "{not json" }] });
  assert.equal(codeOf(() => taskOutput(badMessage, "s")), "agent_store_json_invalid");
  const badPart = scratch();
  makeAgentStore(agentStoreFile(badPart), {
    sessions: ["s"],
    messages: [{ id: "m", session: "s", data: '{"role":"assistant"}' }],
    parts: [{ id: "p", message: "m", session: "s", data: "[1]" }],
  });
  assert.equal(probe(() => taskOutput(badPart, "s")).code, "agent_store_json_invalid");
  const badMeta = scratch();
  makeTasksIndex(badMeta, { tasks: [{ id: "t", automation: "a" }], badMeta: "nope" });
  assert.equal(codeOf(() => managedTasks(badMeta)), "task_index_json_invalid");
  assert.throws(() => probe(() => { throw new TypeError("a bug is not UNPROVEN"); }), TypeError);
});

test("child env: Main keeps OS HOME; Host/Agent home, XDG and data roots are profile-owned; supervisor env untouched", () => {
  const profile = scratch();
  const base = { HOME: "/personal", USERPROFILE: "C:\\personal", XDG_CONFIG_HOME: "/personal/.config", ZCODE_HOME: "/personal/.zcode", PATH: "/bin", APPDATA: "x" };
  const before = JSON.stringify(base);
  const env = isolatedChildEnv(profile, { LUMI_CONTROL_PLANE_ORIGIN: "http://127.0.0.1:1" }, base);
  const layout = isolatedHomeLayout(profile);
  assert.equal(env.HOME, "/personal", "Main keeps the OS HOME for the native keystore");
  assert.equal(env.USERPROFILE, "C:\\personal");
  assert.equal(env.ZCODE_DESKTOP_HOME_DIR, layout.home, "Host/Agent HOME is requested via the existing explicit root");
  const manifest = describeIsolation(profile, env);
  assert.equal(manifest.nativeOsKeystore.mainHomeIsProfile, false);
  assert.equal(manifest.nativeOsKeystore.homeSource, "inherited-os-home");
  assert.equal(manifest.hostAgentHome.requestedRoot, layout.home);
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"])
    assert.ok(env[key].startsWith(layout.home), `${key} stays inside the profile home`);
  assert.equal(env.ZCODE_DATA_BASE_DIR, layout.home);
  assert.equal(env.ZCODE_SESSION_DB_PATH, layout.agentStore, "Agent session store is pinned inside the profile");
  assert.equal(env.ZCODE_STORAGE_DIR, layout.storageRoot);
  assert.equal(env.ZCODE_LOG_DIR, layout.agentLogDir);
  for (const key of ["ZCODE_SESSION_DB_PATH", "ZCODE_STORAGE_DIR", "ZCODE_LOG_DIR"])
    assert.ok(env[key].startsWith(join(profile, "home")), `${key} stays inside the profile`);
  const inheritedPins = isolatedChildEnv(profile, {}, { ZCODE_SESSION_DB: "/personal/db", ZCODE_SESSION_DB_PATH: "/personal/db", ZCODE_LOG_DIR: "/personal/log", ZCODE_STORAGE_DIR: "/personal/.zcode" });
  assert.equal(inheritedPins.ZCODE_SESSION_DB, undefined, "the ZCODE_SESSION_DB alias cannot reach the child");
  assert.equal(inheritedPins.ZCODE_SESSION_DB_PATH, layout.agentStore, "an inherited personal store path is replaced");
  assert.equal(env.ZCODE_HOME, undefined, "an inherited ZCODE_HOME cannot redirect to personal state");
  assert.equal(env.APPDATA, undefined);
  assert.equal(env.PATH, "/bin", "ordinary variables are preserved");
  assert.equal(env.LUMI_CONTROL_PLANE_ORIGIN, "http://127.0.0.1:1");
  assert.equal(JSON.stringify(base), before, "the supplied base environment is not mutated");
  assert.equal(agentStoreFile(profile), layout.agentStore, "the reader and the Agent's HOME agree on the store path");
  prepareIsolatedHome(profile);
});

test("a personal home (or an ancestor of it) is refused as a profile", () => {
  assert.throws(() => assertProfileIsNotPersonal(homedir()), /must not be/);
  assert.throws(() => assertProfileIsNotPersonal("/"), /must not be/);
  assert.throws(() => assertProfileIsNotPersonal("relative"), /absolute/);
  assertProfileIsNotPersonal(scratch());
});

test("profile guard compares REAL paths: symlink aliases of the personal home or its ancestor are refused", () => {
  const base = scratch();
  const fakeHome = join(base, "people", "fake-personal-home");
  mkdirSync(fakeHome, { recursive: true });
  const aliasOfHome = join(base, "alias-profile");
  symlinkSync(fakeHome, aliasOfHome);
  const aliasOfAncestor = join(base, "alias-ancestor");
  symlinkSync(join(base, "people"), aliasOfAncestor);
  assert.throws(() => assertProfileIsNotPersonal(fakeHome, fakeHome), /must not be/);
  assert.throws(() => assertProfileIsNotPersonal(aliasOfHome, fakeHome), /must not be/, "symlink alias of the home");
  assert.throws(() => assertProfileIsNotPersonal(aliasOfAncestor, fakeHome), /must not be/, "symlinked ancestor of the home");
  assert.throws(() => assertProfileIsNotPersonal(join(aliasOfAncestor, "x", ".."), fakeHome), /must not be/);
  const hiddenHome = scratch();
  symlinkSync(fakeHome, join(hiddenHome, "home"));
  assert.throws(() => assertProfileIsNotPersonal(hiddenHome, fakeHome), /must not be/, "profile/home symlinked to the home");
  assertProfileIsNotPersonal(scratch(), fakeHome); // positive control: a disjoint profile passes
  assertProfileIsNotPersonal(join(scratch(), "not-created-yet"), fakeHome); // an uncreated tail is fine
});

test("overrides cannot replace isolation roots; origin and app name overrides still work", () => {
  const profile = scratch();
  const base = { HOME: "/personal", PATH: "/bin" };
  for (const key of ["HOME", "USERPROFILE", "xdg_config_home", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "ZCODE_HOME", "ZCODE_DATA_BASE_DIR", "ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH", "ZCODE_SESSION_DB", "ZCODE_LOG_DIR", "ZCODE_DESKTOP_HOME_DIR", "ZCODE_DESKTOP_USER_DATA_DIR", "ZCODE_DESKTOP_SESSION_DATA_DIR"])
    assert.throws(() => isolatedChildEnv(profile, { [key]: "/personal" }, base), /may not replace isolation roots/, key);
  const env = isolatedChildEnv(profile, { ZCODE_DESKTOP_APPLICATION_NAME: "App", LUMI_CONTROL_PLANE_ORIGIN: "http://127.0.0.1:2" }, base);
  assert.equal(env.ZCODE_DESKTOP_APPLICATION_NAME, "App");
  assert.equal(env.LUMI_CONTROL_PLANE_ORIGIN, "http://127.0.0.1:2");
  assert.equal(env.HOME, "/personal");
  const lowerCase = isolatedChildEnv(profile, {}, { home: "/personal", Xdg_Cache_Home: "/personal/.cache" });
  assert.equal(Object.keys(lowerCase).some((key) => key.toLowerCase() === "home" && key !== "HOME"), false, "a differently-cased inherited root is dropped");
});

test("workspace reader: inside file reads; .., absolute, symlink file/dir and dangling links are refused", () => {
  const workspace = scratch();
  const outside = scratch();
  writeFileSync(join(outside, "secret.txt"), "outside");
  writeFileSync(join(workspace, "ok.txt"), "inside");
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "sub", "n.txt"), "nested");
  symlinkSync(join(workspace, "ok.txt"), join(workspace, "inside-link.txt"));
  symlinkSync(join(outside, "secret.txt"), join(workspace, "file-link.txt"));
  symlinkSync(outside, join(workspace, "dir-link"));
  symlinkSync(join(outside, "gone.txt"), join(workspace, "dangling.txt"));
  assert.equal(readWorkspaceFile(workspace, "ok.txt"), "inside");
  assert.equal(readWorkspaceFile(workspace, "sub/n.txt"), "nested");
  assert.equal(readWorkspaceFile(workspace, "inside-link.txt"), "inside", "a symlink that stays inside is allowed");
  assert.equal(readWorkspaceFile(workspace, "absent.txt"), undefined);
  assert.equal(codeOf(() => readWorkspaceFile(workspace, "../" + outside.split("/").pop() + "/secret.txt")), "workspace_path_escape");
  assert.equal(codeOf(() => readWorkspaceFile(workspace, join(outside, "secret.txt"))), "workspace_path_escape");
  assert.equal(codeOf(() => readWorkspaceFile(workspace, "file-link.txt")), "workspace_symlink_escape");
  assert.equal(codeOf(() => readWorkspaceFile(workspace, "dir-link/secret.txt")), "workspace_symlink_escape");
  assert.equal(codeOf(() => readWorkspaceFile(workspace, "dangling.txt")), "workspace_symlink_escape");
  assert.equal(codeOf(() => readWorkspaceFile(workspace, "sub")), "workspace_not_a_file");
  assert.equal(codeOf(() => readWorkspaceFile(join(workspace, "nope"), "x")), "workspace_unavailable");
});

test(
  "old retained profile: has the task row but NO in-profile Agent store, so its output is UNPROVEN",
  { skip: process.env.DE2E_RETAINED_PROFILE ? false : "DE2E_RETAINED_PROFILE not set (not a pass)" },
  () => {
    const profile = process.env.DE2E_RETAINED_PROFILE;
    assert.ok(managedTasks(profile).length >= 1, "the retained tasks-index has the task row");
    const result = probe(() => taskOutput(profile, managedTasks(profile)[0].taskId));
    assert.equal(result.status, "unproven");
    assert.equal(result.code, "agent_store_unavailable", "an old run was not isolated, so it cannot certify Agent output");
  },
);
