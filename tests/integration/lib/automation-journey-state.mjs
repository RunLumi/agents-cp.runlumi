// State readers for the desktop automation journey. Local state is read straight from the profile's real
// tasks-index SQLite (read-only); server state from the Worker's local D1. Nothing here mutates either.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const run = promisify(execFile);

export const tasksIndexPath = (profile) =>
  join(profile, "home", ".zcode", "v2", "tasks-index.sqlite");

/** Read-only handle; WAL lets it coexist with the running app/scheduler. */
function openReadOnly(profile) {
  const path = tasksIndexPath(profile);
  if (!existsSync(path)) return undefined;
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Byte-comparable snapshot of the retained originals and their history (rows, not file bytes). `only`
 * scopes it to the named automations: rows the local scheduler legitimately churns while a stage runs
 * (the bad-model control retries every minute) must not be mistaken for an effect of the action under test.
 */
export function snapshotLocal(profile, { only } = {}) {
  const db = openReadOnly(profile);
  if (!db) return { automations: [], runs: [], hash: "absent" };
  try {
    const keep = (row) => !only || only.includes(row.automation_id);
    const automations = db
      .prepare("SELECT * FROM automations ORDER BY automation_id")
      .all()
      .filter(keep);
    const runs = db.prepare("SELECT * FROM automation_runs ORDER BY run_id").all().filter(keep);
    const text = JSON.stringify({ automations, runs });
    return { automations, runs, hash: createHash("sha256").update(text).digest("hex") };
  } finally {
    db.close();
  }
}

export function readTable(profile, sql, ...params) {
  const db = openReadOnly(profile);
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** Seed local automations with the product's own repository (see seed-local-automations.mts). */
export async function seedLocalAutomations({ root, profile, specs }) {
  const client = join(root, "integrations/lumi-agents");
  const { stdout } = await run(
    "pnpm",
    [
      "--dir",
      client,
      "exec",
      "tsx",
      join(root, "tests/integration/lib/seed-local-automations.mts"),
      tasksIndexPath(profile),
      JSON.stringify(specs),
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const text = stdout.slice(stdout.indexOf("["));
  return JSON.parse(text);
}

const TRANSIENT_D1 =
  /Failed to parse body as JSON, got: Error: internal error|D1DatabaseObject\.queryExecute|"text": "internal error; reference = /;

/**
 * Read-only D1 query through Wrangler against the LIVE local database. Miniflare answers an occasional read with a
 * bare "internal error" (retained: native-full-lane3-run7.log). Only that signature is retried, a few times; any
 * other refusal and a persisting internal error still throw, so a failed read is never reported as an absence.
 */
export async function readRowsWithRetry(probe, sql, label, { attempts = 6, delayMs = 2_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await probe.d1Rows(sql, label);
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_D1.test(String(error?.message ?? error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** D1 helpers bound to one SmokeHarness. */
export function serverState(probe, orgId) {
  const rows = (sql, label) => readRowsWithRetry(probe, sql, label);
  return {
    rows,
    async counts() {
      const [definitions, occurrences, leases, runs, links, audit] = await Promise.all([
        rows(
          `SELECT COUNT(*) AS n FROM automation_definitions WHERE org_id='${orgId}'`,
          "count definitions",
        ),
        rows(
          `SELECT COUNT(*) AS n FROM automation_occurrences WHERE org_id='${orgId}'`,
          "count occurrences",
        ),
        rows(`SELECT COUNT(*) AS n FROM automation_leases WHERE org_id='${orgId}'`, "count leases"),
        rows(`SELECT COUNT(*) AS n FROM runs WHERE org_id='${orgId}'`, "count runs"),
        rows(
          `SELECT COUNT(*) AS n FROM automation_run_links WHERE org_id='${orgId}'`,
          "count links",
        ),
        rows(`SELECT COUNT(*) AS n FROM security_events WHERE org_id='${orgId}'`, "count audit"),
      ]);
      return {
        definitions: Number(definitions[0].n),
        occurrences: Number(occurrences[0].n),
        leases: Number(leases[0].n),
        runs: Number(runs[0].n),
        links: Number(links[0].n),
        audit: Number(audit[0].n),
      };
    },
    /**
     * STORAGE evidence: every text/blob/untyped column of `tables` in the Worker's persisted local D1 file must
     * exclude `needle`. Reads the SQLite file read-only; the Wrangler `d1 execute` path it replaces failed with a
     * Miniflare internal error on a live database. Any read failure throws -- it is never an absence.
     * Returns the scope actually measured so a caller can record it.
     */
    assertAbsent(needle, tables, label) {
      return assertTablesExclude(d1StoragePath(probe.persistDir), needle, tables, label);
    },
  };
}

/** The Miniflare D1 database file under a `--persist-to` directory (not the per-namespace metadata files). */
export function d1StoragePath(persistDir) {
  const dir = join(persistDir, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    : [];
  if (files.length !== 1) {
    throw new Error(`expected exactly one D1 database file in ${dir}, found ${files.length}`);
  }
  return join(dir, files[0]);
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEXT_LIKE = /^$|TEXT|CHAR|CLOB|BLOB|JSON/i;

/**
 * Scope = every table named, every column that can hold text. Fails closed on: a bad identifier, a table that
 * does not exist, a table with no inspectable column, a query the engine refuses, or an empty `needle`
 * (which would match every row and prove nothing).
 */
export function assertTablesExclude(dbPath, needle, tables, label, hooks = {}) {
  if (typeof needle !== "string" || needle.length === 0)
    throw new Error(`${label}: needle must be non-empty`);
  // An empty list measures nothing and would read as "absent"; a duplicate double-counts scope.
  if (!Array.isArray(tables) || tables.length === 0)
    throw new Error(`${label}: tables must be a non-empty array`);
  if (new Set(tables).size !== tables.length) throw new Error(`${label}: duplicate table in scope`);
  if (!existsSync(dbPath)) throw new Error(`${label}: database file not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const scope = [];
  try {
    // One read transaction: under WAL every table below is read from the same snapshot, so a concurrent
    // writer cannot make the scope a mix of two states. It is a point-in-time read, not a live one.
    db.exec("BEGIN");
    for (const table of tables) {
      if (!IDENTIFIER.test(table))
        throw new Error(`${label}: invalid table name ${JSON.stringify(table)}`);
      const exists = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) throw new Error(`${label}: table ${table} does not exist`);
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .filter((column) => TEXT_LIKE.test(column.type))
        .map((column) => column.name);
      if (columns.length === 0)
        throw new Error(`${label}: ${table} has no text columns to inspect`);
      const predicate = columns.map((name) => `instr(CAST("${name}" AS TEXT), ?) > 0`).join(" OR ");
      const hit = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`)
        .get(...columns.map(() => needle));
      const { n: rows } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      if (Number(hit.n) !== 0) throw new Error(`${label}: found in ${table}`);
      scope.push({ table, columns: columns.length, rows: Number(rows) });
      hooks.afterTable?.(table); // test seam: lets a test commit a write mid-scan
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return scope;
}

export const CONTENT_TABLES = [
  "automation_definitions",
  "automation_occurrences",
  "automation_occurrence_attempts",
  "automation_schedule_rules",
  "automation_run_links",
  "automation_leases",
  "agent_sessions",
  "runs",
  "run_events",
  "inference_requests",
  "usage_events",
  "security_events",
  "outbox_events",
];
