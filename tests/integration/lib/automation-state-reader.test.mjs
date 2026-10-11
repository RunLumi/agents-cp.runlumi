// Regression proof for the automation journey's storage-absence reader. The original FAIL (retained at
// test-results/int05-verifier/scheduler-policy-ready.log) was Wrangler's `d1 execute` returning a Miniflare
// internal error for a query over automation_leases; the reader now opens the persisted SQLite file read-only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  assertTablesExclude,
  d1StoragePath,
  readRowsWithRetry,
  serverState,
  snapshotLocal,
} from "./automation-journey-state.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const NEEDLE = "Summarise the quarterly 'incident' log; password=hunter2";

const root = mkdtempSync(join(tmpdir(), "automation-state-reader-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(name, setup) {
  const persist = join(root, name);
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "0123abcd.sqlite"));
  db.exec(`CREATE TABLE automation_leases (lease_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt INTEGER);
           CREATE TABLE runs (run_id TEXT PRIMARY KEY, payload TEXT, blob_col BLOB, note);
           CREATE TABLE counters (n INTEGER NOT NULL);
           INSERT INTO automation_leases VALUES ('lse_a', 'active', 1);
           INSERT INTO runs VALUES ('run_a', 'clean', x'00ff', 'clean');`);
  setup?.(db);
  db.close();
  // Metadata files sit beside the database and must not be mistaken for it.
  new DatabaseSync(join(dir, "metadata.sqlite")).close();
  return persist;
}

const TABLES = ["automation_leases", "runs"];

test("clean tables pass and report the scope that was measured", () => {
  const persist = fixture("clean");
  const scope = assertTablesExclude(d1StoragePath(persist), NEEDLE, TABLES, "clean");
  assert.deepEqual(scope, [
    { table: "automation_leases", columns: 2, rows: 1 },
    { table: "runs", columns: 4, rows: 1 },
  ]);
});

test("positive control: the sensitive string is found in a TEXT column, quote and all", () => {
  const persist = fixture("text", (db) =>
    db.prepare("INSERT INTO runs VALUES (?, ?, NULL, NULL)").run("run_b", `x ${NEEDLE} y`),
  );
  assert.throws(
    () => assertTablesExclude(d1StoragePath(persist), NEEDLE, TABLES, "text"),
    /text: found in runs/,
  );
});

test("positive control: found in an untyped column and in a BLOB column", () => {
  const untyped = fixture("untyped", (db) =>
    db.prepare("INSERT INTO runs VALUES ('run_b', NULL, NULL, ?)").run(NEEDLE),
  );
  assert.throws(
    () => assertTablesExclude(d1StoragePath(untyped), NEEDLE, TABLES, "u"),
    /found in runs/,
  );
  const blob = fixture("blob", (db) =>
    db.prepare("INSERT INTO runs VALUES ('run_b', NULL, ?, NULL)").run(Buffer.from(NEEDLE, "utf8")),
  );
  assert.throws(
    () => assertTablesExclude(d1StoragePath(blob), NEEDLE, TABLES, "b"),
    /found in runs/,
  );
});

test("positive control: a hit in the second table is not masked by a clean first table", () => {
  const persist = fixture("second", (db) =>
    db.prepare("UPDATE automation_leases SET state = ?").run(NEEDLE),
  );
  assert.throws(
    () => assertTablesExclude(d1StoragePath(persist), NEEDLE, TABLES, "s"),
    /found in automation_leases/,
  );
});

test("fault: a missing table fails instead of reading as absent", () => {
  const persist = fixture("missing");
  assert.throws(
    () =>
      assertTablesExclude(
        d1StoragePath(persist),
        NEEDLE,
        ["automation_leases", "automation_leasez"],
        "m",
      ),
    /table automation_leasez does not exist/,
  );
});

test("fault: a table with no inspectable column fails", () => {
  const persist = fixture("nocols");
  assert.throws(
    () => assertTablesExclude(d1StoragePath(persist), NEEDLE, ["counters"], "n"),
    /no text columns/,
  );
});

test("fault: hostile identifier and empty needle are refused before any query", () => {
  const persist = fixture("refuse");
  const path = d1StoragePath(persist);
  assert.throws(
    () => assertTablesExclude(path, NEEDLE, ["runs; DROP TABLE runs"], "i"),
    /invalid table name/,
  );
  assert.throws(() => assertTablesExclude(path, "", TABLES, "e"), /needle must be non-empty/);
});

test("fault: a query the engine refuses propagates (missing database, corrupt file)", () => {
  assert.throws(
    () => assertTablesExclude(join(root, "nope.sqlite"), NEEDLE, TABLES, "f"),
    /database file not found/,
  );
  const persist = fixture("corrupt");
  const path = d1StoragePath(persist);
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE runs; CREATE VIEW runs AS SELECT * FROM missing_source;");
  db.close();
  assert.throws(() => assertTablesExclude(path, NEEDLE, TABLES, "c"));
});

test("storage path: zero or several database files is an error, not a guess", () => {
  assert.throws(() => d1StoragePath(join(root, "no-such-persist")), /exactly one D1 database file/);
  const persist = fixture("two");
  new DatabaseSync(join(persist, "v3", "d1", "miniflare-D1DatabaseObject", "other.sqlite")).close();
  assert.throws(() => d1StoragePath(persist), /exactly one D1 database file/);
});

test("fault: empty, non-array and duplicate table lists are refused before the database is opened", () => {
  const missing = join(root, "never-opened.sqlite");
  assert.throws(() => assertTablesExclude(missing, NEEDLE, [], "e"), /non-empty array/);
  assert.throws(() => assertTablesExclude(missing, NEEDLE, "runs", "s"), /non-empty array/);
  assert.throws(() => assertTablesExclude(missing, NEEDLE, undefined, "u"), /non-empty array/);
  assert.throws(
    () => assertTablesExclude(missing, NEEDLE, ["runs", "runs"], "d"),
    /duplicate table/,
  );
});

test("positive control: a single valid table is measured and reported", () => {
  const persist = fixture("single");
  assert.deepEqual(assertTablesExclude(d1StoragePath(persist), NEEDLE, ["runs"], "one"), [
    { table: "runs", columns: 4, rows: 1 },
  ]);
});

test("WAL: reads coexist with an open writer and all tables come from one snapshot", () => {
  const persist = fixture("wal");
  const path = d1StoragePath(persist);
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode = WAL");
  try {
    // An uncommitted write is invisible and does not block the reader.
    writer.exec("BEGIN");
    writer.prepare("UPDATE runs SET payload = ?").run(NEEDLE);
    assert.equal(assertTablesExclude(path, NEEDLE, TABLES, "uncommitted").length, 2);
    writer.exec("ROLLBACK");

    // A write committed AFTER the first table was read must not be seen by the second: same snapshot.
    const scope = assertTablesExclude(path, NEEDLE, TABLES, "mid-scan", {
      afterTable: (table) => {
        if (table === "automation_leases")
          writer.prepare("UPDATE runs SET payload = ?").run(NEEDLE);
      },
    });
    assert.equal(scope.length, 2);

    // Control: a fresh scan after the commit does see it, so the pass above was the snapshot, not blindness.
    assert.throws(() => assertTablesExclude(path, NEEDLE, TABLES, "after"), /found in runs/);
  } finally {
    writer.close();
  }
});

test("serverState.assertAbsent reads the harness's persist dir and never shells out to Wrangler", async () => {
  const persist = fixture("wired", (db) => db.prepare("UPDATE runs SET payload = ?").run(NEEDLE));
  const probe = {
    persistDir: persist,
    d1Rows() {
      throw new Error("assertAbsent must not use the Wrangler d1Rows path");
    },
  };
  const server = serverState(probe, "org_x");
  assert.throws(() => server.assertAbsent(NEEDLE, TABLES, "w"), /found in runs/);
  assert.equal(server.assertAbsent("never-stored", TABLES, "w").length, 2);
});

// Regression for the retained adopt FAIL (native-race-lane3-run1.log): the local scheduler retries the
// bad-model control every minute, which changed an all-rows hash during an unrelated preview + cancel.
test("a scoped local snapshot ignores churn in other automations but still detects a change in scope", () => {
  const profile = mkdtempSync(join(root, "profile-"));
  const dir = join(profile, "home", ".zcode", "v2");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "tasks-index.sqlite"));
  db.exec(`CREATE TABLE automations (automation_id TEXT PRIMARY KEY, updated_at INTEGER);
           CREATE TABLE automation_runs (run_id TEXT PRIMARY KEY, automation_id TEXT, attempts INTEGER);
           INSERT INTO automations VALUES ('kept', 1), ('retrying', 1);
           INSERT INTO automation_runs VALUES ('r1', 'retrying', 1);`);
  const scoped = () => snapshotLocal(profile, { only: ["kept"] }).hash;
  const whole = () => snapshotLocal(profile).hash;
  const [scopedBefore, wholeBefore] = [scoped(), whole()];
  db.exec(
    "UPDATE automations SET updated_at = 2 WHERE automation_id = 'retrying'; UPDATE automation_runs SET attempts = 2",
  );
  assert.equal(scoped(), scopedBefore, "retry churn outside the scope is not an effect");
  assert.notEqual(whole(), wholeBefore, "positive control: the unscoped hash does see that churn");
  db.exec("UPDATE automations SET updated_at = 2 WHERE automation_id = 'kept'");
  assert.notEqual(scoped(), scopedBefore, "a change inside the scope is still detected");
  db.close();
});

test("D1 reads retry only the Miniflare internal-error signature and never turn a failure into an empty result", async () => {
  const internal = new Error(
    "links failed (1): Failed to parse body as JSON, got: Error: internal error; reference = x",
  );
  let calls = 0;
  const bare = new Error(
    'definition failed (1): {\n "error": {\n  "text": "internal error; reference = 0btpsupk438cdjb6voae7a4r"\n }\n}',
  );
  let bareCalls = 0;
  assert.deepEqual(
    await readRowsWithRetry(
      { d1Rows: async () => (++bareCalls < 2 ? Promise.reject(bare) : []) },
      "select 1",
      "bare",
      { delayMs: 1 },
    ),
    [],
  );
  assert.equal(
    bareCalls,
    2,
    "the bare internal-error form is retried too (native-full-lane3-run20)",
  );
  const flaky = { d1Rows: async () => (++calls < 3 ? Promise.reject(internal) : [{ n: 1 }]) };
  assert.deepEqual(await readRowsWithRetry(flaky, "select 1", "flaky", { delayMs: 1 }), [{ n: 1 }]);
  assert.equal(calls, 3);
  calls = 0;
  const refused = {
    d1Rows: async () => (
      calls++,
      Promise.reject(new Error("D1 refused the statement: no such column"))
    ),
  };
  await assert.rejects(
    () => readRowsWithRetry(refused, "select x", "refused", { delayMs: 1 }),
    /no such column/,
  );
  assert.equal(calls, 1, "a real refusal is not retried");
  calls = 0;
  const persistent = { d1Rows: async () => (calls++, Promise.reject(internal)) };
  await assert.rejects(
    () => readRowsWithRetry(persistent, "select 1", "persistent", { attempts: 3, delayMs: 1 }),
    /internal error/,
  );
  assert.equal(calls, 3, "a persisting internal error still fails after the bounded attempts");
});
