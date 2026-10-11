// Read-only readback of what the REAL desktop Agent produced for a managed run. Two production stores,
// traced from Host `managedAutomationRun.createTask/sendPrompt`, BOTH derived strictly from the supplied
// profile directory:
//   * the desktop tasks-index (`<profile>/home/.zcode/v2/tasks-index.sqlite`, table `tasks`) holds the task
//     row; `meta_json.cronAutomationId` is the local original the managed run was dispatched for.
//   * the Agent session store (`<profile>/home/.zcode/cli/db/db.sqlite`). The Agent resolves it from the
//     Host/Agent HOME, which Main sets from ZCODE_DESKTOP_HOME_DIR (`<profile>/home`, see `lumi-child-env.mjs`).
//     Main's own HOME stays the OS identity, so this store is proven only by a fresh replay readback.
// There is NO process.env.HOME / os.homedir() fallback anywhere in this file: a run whose Agent was not
// isolated simply has no store here and reads as UNPROVEN, never as "empty". A store path that resolves
// (through symlinks) outside the real profile is refused. Absence is never silently empty: a missing store,
// missing table/column, invalid JSON or a task whose session is missing throws a TaskOutputError with a
// stable `code`, and `probe()` turns those into an explicit UNPROVEN result. `[]`/"" are returned only when
// the store is present, well-formed and says so.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

export class TaskOutputError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TaskOutputError";
    this.code = code;
  }
}

export const tasksIndexFile = (profile) =>
  join(profile, "home", ".zcode", "v2", "tasks-index.sqlite");
export const agentStoreFile = (profile) =>
  join(profile, "home", ".zcode", "cli", "db", "db.sqlite");

/** Real path of `file` if it lies inside the real `profile`; undefined if absent; throws if it escapes. */
function confinedToProfile(profile, file, escapeCode) {
  if (typeof profile !== "string" || !isAbsolute(profile))
    throw new TaskOutputError("profile_invalid", "profile must be an absolute path");
  let root;
  try {
    root = realpathSync(profile);
  } catch {
    throw new TaskOutputError("profile_invalid", "profile does not exist");
  }
  if (!existsSync(file)) return undefined;
  const real = realpathSync(file);
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new TaskOutputError(escapeCode, "store resolves outside the profile");
  return real;
}

const TASK_COLUMNS = [
  "task_id",
  "title",
  "task_status",
  "model",
  "workspace_path",
  "created_at",
  "updated_at",
  "meta_json",
  "deleted",
];
const SESSION_TABLES = {
  session: ["id"],
  message: ["id", "session_id", "sequence", "time_created", "data"],
  part: ["id", "message_id", "session_id", "sequence", "time_created", "data"],
};

function openChecked(path, unavailableCode, schemaCode, tables) {
  if (!path) throw new TaskOutputError(unavailableCode, "store file not found in the profile");
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    for (const [table, columns] of Object.entries(tables)) {
      const present = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
      const missing = columns.filter((column) => !present.includes(column));
      if (missing.length)
        throw new TaskOutputError(
          schemaCode,
          `${table} lacks ${missing.join(",") || "all columns"}`,
        );
    }
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof TaskOutputError) throw error;
    throw new TaskOutputError(
      unavailableCode,
      String(error?.code ?? error?.message ?? error).slice(0, 120),
    );
  }
}

function parseObject(text, code, where) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TaskOutputError(code, `${where} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TaskOutputError(code, `${where} is not an object`);
  return value;
}

/**
 * Tasks in one profile's tasks-index, oldest first; with `localAutomationId` only those the managed
 * scheduler created for that retained original. Throws when the index is unavailable or malformed.
 */
export function managedTasks(profile, { localAutomationId } = {}) {
  const db = openChecked(
    confinedToProfile(profile, tasksIndexFile(profile), "task_index_outside_profile"),
    "task_index_unavailable",
    "task_index_schema_invalid",
    { tasks: TASK_COLUMNS },
  );
  try {
    return db
      .prepare(
        `SELECT ${TASK_COLUMNS.join(", ")} FROM tasks WHERE deleted = 0 ORDER BY created_at, task_id`,
      )
      .all()
      .map((row) => {
        const meta = parseObject(
          row.meta_json,
          "task_index_json_invalid",
          `task ${row.task_id} meta_json`,
        );
        return {
          taskId: row.task_id,
          title: row.title,
          status: row.task_status,
          model: row.model,
          workspacePath: row.workspace_path,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          cronAutomationId: meta.cronAutomationId ?? null,
        };
      })
      .filter((task) => !localAutomationId || task.cronAutomationId === localAutomationId);
  } finally {
    db.close();
  }
}

function describeMessage(db, row) {
  const data = parseObject(row.data, "agent_store_json_invalid", `message ${row.id}`);
  const parts = db
    .prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY sequence, time_created, id")
    .all(row.id)
    .map((part) => parseObject(part.data, "agent_store_json_invalid", `part ${part.id}`));
  return {
    id: row.id,
    role: data.role ?? null,
    createdAt: row.time_created,
    completedAt: data.time?.completed ?? null,
    finish: data.finish ?? null,
    error: data.error ?? null,
    text: parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(""),
    partTypes: parts.map((part) => part.type),
    toolStatuses: parts
      .filter((part) => part.type === "tool")
      .map((part) => part.state?.status ?? null),
  };
}

/**
 * The Agent session behind a task row (session id === task id). A task row whose session is absent is
 * `agent_session_missing`, never an empty transcript.
 */
export function taskOutput(profile, taskId) {
  const db = openChecked(
    confinedToProfile(profile, agentStoreFile(profile), "agent_store_outside_profile"),
    "agent_store_unavailable",
    "agent_store_schema_invalid",
    SESSION_TABLES,
  );
  try {
    if (!db.prepare("SELECT 1 AS present FROM session WHERE id = ?").get(taskId))
      throw new TaskOutputError("agent_session_missing", `no session ${taskId}`);
    const messages = db
      .prepare(
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY sequence, time_created, id",
      )
      .all(taskId)
      .map((row) => describeMessage(db, row));
    return { taskId, messages };
  } finally {
    db.close();
  }
}

/** `{status:"ok", value}` or `{status:"unproven", code}`; only TaskOutputError becomes UNPROVEN, bugs still throw. */
export function probe(read) {
  try {
    return { status: "ok", value: read() };
  } catch (error) {
    if (error instanceof TaskOutputError)
      return { status: "unproven", code: error.code, detail: error.message };
    throw error;
  }
}

/** Assistant-authored text of one task, in order. */
export const assistantText = (output) =>
  output.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("");

/** True when an assistant message reached a terminal marker (completed or errored). */
export const assistantTerminal = (output) =>
  output.messages.some(
    (message) => message.role === "assistant" && (message.completedAt || message.error),
  );

/** Content-free summary for ledger lines and failure messages (no prompt, no assistant text). */
export const outputShape = (output) =>
  output.messages.map((message) => ({
    role: message.role,
    completed: Boolean(message.completedAt),
    finish: message.finish ? (message.finish.reason ?? message.finish) : null,
    error: message.error ? (message.error.name ?? "error") : null,
    textChars: message.text.length,
    tools: message.toolStatuses,
  }));

/**
 * Content of a file the Agent wrote inside the workspace, or `undefined` if absent. Confinement is on
 * REAL paths: a `..` segment, an absolute path, a symlinked directory or a symlinked file that resolves
 * outside the workspace is refused (`workspace_path_escape` / `workspace_symlink_escape`).
 */
export function readWorkspaceFile(workspacePath, relativePath) {
  let root;
  try {
    root = realpathSync(workspacePath);
  } catch {
    throw new TaskOutputError("workspace_unavailable", "workspace does not exist");
  }
  const lexical = resolve(root, relativePath);
  const inside = (path) => {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(lexical))
    throw new TaskOutputError("workspace_path_escape", "path leaves the workspace");
  let stat;
  try {
    stat = lstatSync(lexical);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new TaskOutputError("workspace_unreadable", String(error.code));
  }
  let real;
  try {
    real = realpathSync(lexical);
  } catch {
    // a symlink whose target cannot be resolved is not a file the Agent wrote here
    throw new TaskOutputError(
      "workspace_symlink_escape",
      stat.isSymbolicLink() ? "dangling symlink" : "unresolvable path",
    );
  }
  if (!inside(real))
    throw new TaskOutputError("workspace_symlink_escape", "real path leaves the workspace");
  if (!lstatSync(real).isFile())
    throw new TaskOutputError("workspace_not_a_file", "not a regular file");
  return readFileSync(real, "utf8");
}
