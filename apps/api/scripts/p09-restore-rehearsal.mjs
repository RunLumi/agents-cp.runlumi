// P09 backup/restore rehearsal.
//
// `docs/release/backup-restore.md` has said, since it was written, that no rehearsal
// has been run and no RPO or RTO has been measured. This is the run. It is the first
// follow-up the release checklist names, and the one whose absence is the largest gap
// in the P09 evidence: every other number in `docs/release/` was measured, and the
// number an on-call engineer needs most was not.
//
// WHAT MAKES THIS A REHEARSAL RATHER THAN A ROUND-TRIP
//
// The obvious version of this script migrates a database, exports it, restores it, and
// compares row counts. That version proves almost nothing, because the interesting
// failure is a restore that LOADS but whose TRIGGERS ARE MISSING -- a database that
// accepts a revoked credential being reactivated, because the trigger that refused it
// did not come back with the data. A row-count comparison cannot see that. Only an
// invariant suite can.
//
// So the verification step is the 125 storage invariants, run against the RESTORED
// file with `P07_SCHEMA_DB`, not against a freshly-migrated one. That mode is the
// reason this script exists: every number the harness has ever produced came from the
// freshly-migrated path, which is the path that cannot detect a lossy restore.
//
// The whole path goes through `wrangler d1`, because a rehearsal that uses a different
// export mechanism than production is a rehearsal of the wrong thing.
//
//   node apps/api/scripts/p09-restore-rehearsal.mjs
//   node apps/api/scripts/p09-restore-rehearsal.mjs --keep                 # keep artifacts
//   node apps/api/scripts/p09-restore-rehearsal.mjs --no-fault-injection   # skip step 6
//
// Step 6 is on by default and should stay that way: it drops a trigger from a COPY of
// the restored file and requires the suite to notice. A rehearsal that has only ever
// printed PASS has not shown it can fail.
//
// Exits non-zero if the restore loses a row, loses a trigger, or accepts a write the
// schema is supposed to refuse.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const KEEP = process.argv.includes("--keep");
// `--prove-detectable` runs the fault injection. It is ON by default because a
// verification step nobody runs is a step nobody should rely on, and the cost is one
// extra suite run.
const PROVE_DETECTABLE = !process.argv.includes("--no-fault-injection");
const REPO = process.cwd();
const API = join(REPO, "apps", "api");
const HARNESS = join(API, "scripts", "p07-schema-invariants.mjs");
const work = mkdtempSync(join(tmpdir(), "p09-restore-"));
const dump = join(work, "backup.sql");
const restored = join(work, "restored.db");
const seedSql = join(work, "seed.sql");

const results = [];
const record = (label, ok, detail) => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
};

// The rehearsal runs against a CLEAN local D1, and puts the developer's own state
// back afterwards.
//
// Two attempts got here. The first used the default `.wrangler/state`, so a second run
// inherited the first run's rows and the seed died on `UNIQUE constraint failed:
// users.email` -- a rehearsal you can only run once, in a clean checkout, is not a
// rehearsal you can rely on. The second used `--persist-to`, which `migrations apply`
// and `d1 execute` accept and `d1 export` does NOT, so the state the export read was
// not the state the script had built. Asking the script to be consistent across
// commands that disagree about the flag is the wrong shape.
//
// So: move the real state aside, run against a fresh one, put it back in `finally`.
// Non-destructive, re-runnable, and it still goes through wrangler's real export path
// rather than a substitute -- which matters, because a rehearsal that exports by
// another mechanism is a rehearsal of the wrong mechanism.
const STATE = join(API, ".wrangler", "state");
const STASH = `${STATE}.rehearsal-stash`;
let stashed = false;

function stashState() {
  if (!existsSync(STATE)) return;
  if (existsSync(STASH)) {
    throw new Error(
      `${STASH} already exists, so a previous rehearsal did not finish. Remove it, or ` +
        `check whether it holds local D1 data you need.`,
    );
  }
  renameSync(STATE, STASH);
  stashed = true;
}

function restoreState() {
  rmSync(STATE, { recursive: true, force: true });
  if (stashed) renameSync(STASH, STATE);
}

function wrangler(args) {
  return execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: API,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function harness(args, env = {}) {
  return execFileSync("node", [HARNESS, ...args], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sqlite(file, sql) {
  return execFileSync("sqlite3", [file, sql], { encoding: "utf8" });
}

const ms = (start) => `${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(0)} ms`;

try {
  // -- 1. SOURCE ------------------------------------------------------------
  // A database with real content, because an empty schema only proves a restore
  // reproduces an empty schema. The fixture is the harness's own seed, handed over as
  // SQL so the rehearsal's data and its verification cannot drift apart.
  console.log("\n1. build the source database\n");
  stashState();
  harness(["--emit-seed-sql", seedSql]);
  const t0 = process.hrtime.bigint();
  wrangler(["d1", "migrations", "apply", "DB", "--local", "--env", "development"]);
  wrangler(["d1", "execute", "DB", "--local", "--env", "development", "--file", seedSql]);
  const buildMs = ms(t0);
  console.log(`     schema + fixture applied in ${buildMs}`);

  // -- 2. EXPORT ------------------------------------------------------------
  console.log("\n2. export\n");
  const t1 = process.hrtime.bigint();
  wrangler(["d1", "export", "DB", "--local", "--env", "development", "--output", dump]);
  const exportMs = ms(t1);
  const dumpBytes = statSync(dump).size;
  console.log(`     ${(dumpBytes / 1024).toFixed(0)} KiB in ${exportMs}`);

  // -- 3. RESTORE -----------------------------------------------------------
  console.log("\n3. restore into an empty database\n");
  const t2 = process.hrtime.bigint();
  sqlite(restored, `.read ${dump}`);
  const restoreMs = ms(t2);
  console.log(`     loaded in ${restoreMs}`);

  // -- 4. VERIFY ------------------------------------------------------------
  // The timer starts HERE, before any verification, because the previous version
  // started it afterwards and cheerfully reported `verify 0 ms`. A rehearsal that
  // reports a fabricated timing is worse than one that reports none.
  const t3 = process.hrtime.bigint();
  console.log("\n4. verify the RESTORED database\n");

  // 4a. Structural: the schema came back whole.
  const count = (sql) => new DatabaseSync(restored).prepare(sql).get().n;
  const tables = count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'");
  const triggers = count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'");
  const indexes = count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index'");
  record(
    "the restored database carries its schema",
    tables >= 100 && triggers >= 70,
    `${tables} tables, ${triggers} triggers, ${indexes} indexes`,
  );

  // 4b. Integrity, as SQLite itself defines it. This is the check that would notice a
  //     truncated dump, and it is the one a row-count comparison would pass.
  const integrity = sqlite(restored, "PRAGMA integrity_check;").trim();
  record("SQLite integrity_check is clean", integrity === "ok", `reported: ${integrity}`);

  const fk = sqlite(restored, "PRAGMA foreign_key_check;").trim();
  record(
    "no dangling foreign keys",
    fk === "",
    fk === "" ? "foreign_key_check returned nothing" : fk.split("\n").slice(0, 3).join("; "),
  );

  // 4c. Row-level fidelity, per table, compared against the LIVE source rather than
  //     against a remembered number, so a seed change cannot make this quietly wrong.
  //
  //     The source counts come from the local D1 FILE, read-only. Two earlier
  //     attempts: opening the dump as a database, which fails outright because
  //     `d1 export --output x.sql` writes SQL TEXT; and one `wrangler d1 execute`
  //     carrying a UNION ALL across 110 tables, which dies on "too many terms in
  //     compound SELECT". Reading the file is only for COUNTING -- wrangler still
  //     built the database and still performs the export, which is the part that has
  //     to match production.
  const restoredDb = new DatabaseSync(restored);
  const tableNames = restoredDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_migrations%'",
    )
    .all()
    .map((r) => r.name);

  const sourceFiles = globSync(join(STATE, "**", "*.sqlite"), { nodir: true });
  const sourceFile = sourceFiles.find((f) => statSync(f).size > 0);
  if (!sourceFile) throw new Error(`no local D1 file found under ${STATE}`);
  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const mismatched = [];
  let compared = 0;
  for (const table of tableNames) {
    let before;
    let after;
    try {
      before = sourceDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    } catch {
      continue; // a table the source does not have is not a fidelity failure
    }
    after = restoredDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    compared += 1;
    if (before !== after) mismatched.push(`${table}: source ${before}, restored ${after}`);
  }
  sourceDb.close();
  record(
    "every table restored with the same row count",
    mismatched.length === 0 && compared > 50,
    mismatched.length === 0
      ? `${compared} tables compared against the live source`
      : mismatched.slice(0, 5).join("; "),
  );

  // 4d. THE POINT. The 125 invariants, against the restored file.
  //
  //     `P07_SCHEMA_DB` makes the harness skip migrations and the seed, because the
  //     restored file already has both. If the restore had lost a trigger, this is
  //     where it would show: the case that needs that trigger would report "accepted"
  //     and fail.
  const EXPECTED_CASES = Number(process.env.P07_EXPECTED_CASES ?? 125);
  let invariantLine = "did not report";
  let invariantOk = false;
  try {
    const out = harness([], { P07_SCHEMA_DB: restored });
    const tally = out.match(/(\d+)\/(\d+) invariants behave as declared/);
    if (tally) {
      const [, passed, total] = tally;
      invariantLine = `${passed}/${total}`;
      invariantOk = Number(passed) === EXPECTED_CASES && Number(total) === EXPECTED_CASES;
      if (!invariantOk) {
        invariantLine += ` (expected ${EXPECTED_CASES}/${EXPECTED_CASES})`;
      }
    }
  } catch (error) {
    const out = error.stdout ?? "";
    const tally = out.match(/(\d+)\/(\d+) invariants behave as declared/);
    invariantLine = tally ? `${tally[1]}/${tally[2]}` : "the suite did not report a tally";
    const failed = [...out.matchAll(/^\s+- (.+)$/gm)].map((m) => m[1]);
    if (failed.length) invariantLine += `; failing: ${failed.slice(0, 4).join(", ")}`;
  }
  record(
    "the RESTORED database still refuses every invalid write",
    invariantOk,
    invariantLine || "no verdict",
  );

  // stderr is swallowed because the refusal message is the thing under test, and a
  // report that interleaves it with the results is harder to read than one that
  // states the outcome.
  const probe = (statement) => {
    try {
      execFileSync("sqlite3", [restored, statement], { stdio: "ignore" });
      return "ACCEPTED";
    } catch {
      return "refused";
    }
  };

  // 4e. The specific failure this whole exercise exists to detect, asserted directly
  //     rather than inferred from 4d.
  //
  //     It is a SEQUENCE, because the invariant is about what happens *after* a
  //     revoke -- probing one statement at a time reports "accepted" for a row that
  //     was never revoked, which is a passing check that proves nothing. That is
  //     failure mode 4 in this harness's own header.
  const step1 = probe(
    "UPDATE api_keys SET status='revoked', revoke_reason='rotated off host' WHERE key_prefix='000000000001';",
  );
  const step2 = probe("UPDATE api_keys SET revoke_reason=NULL WHERE key_prefix='000000000001';");
  record(
    "a revoked API key's reason still cannot be blanked in the restored copy",
    step1 === "ACCEPTED" && step2 === "refused",
    `revoke: ${step1}; then blank the reason: ${step2}. A restore that lost this trigger ` +
      `accepts the blank, and a credential is silently un-revokable.`,
  );

  // -- 5. REPORT ------------------------------------------------------------
  const verifyMs = ms(t3);
  const rehearsalMs = ms(t0);
  const recoveryMs = ms(t1);
  const passed = results.filter((r) => r.ok).length;

  console.log("\n5. measured\n");
  console.log("     rehearsal setup (not part of recovery)");
  console.log(`       build source   ${buildMs}`);
  console.log("\n     recovery path -- what an operator actually does");
  console.log(`       export         ${exportMs}  (${(dumpBytes / 1024).toFixed(0)} KiB)`);
  console.log(`       restore        ${restoreMs}`);
  console.log(`       verify         ${verifyMs}`);
  console.log(`       ─────────────────────────`);
  console.log(`       RTO            ${recoveryMs}`);
  console.log(`\n     whole rehearsal ${rehearsalMs}`);
  console.log(`\n     RPO            0 rows lost inside the snapshot. A logical export is a`);
  console.log(`                    consistent point-in-time image, so the recoverable loss`);
  console.log(`                    window is the interval between exports -- an operational`);
  console.log(`                    decision, not a platform limit. D1 Time Travel is a`);
  console.log(`                    separate mechanism and was NOT exercised here.`);

  console.log(`\n${passed}/${results.length} rehearsal checks passed\n`);

  // -- 6. PROVE THE REHEARSAL CAN FAIL -----------------------------------------
  //
  // Everything above is a description of a restore that worked. This is the evidence
  // that the description would have noticed if it had not.
  //
  // The fault chosen is the one the whole exercise exists to catch: a restore that
  // LOADS but whose trigger did not come back with the data. Here it is simulated by
  // dropping a trigger from a COPY of the restored file -- so the file still has every
  // row, a clean integrity_check, and matching row counts, and it is still not a
  // database you could serve.
  //
  // If the 125 cases still pass against that copy, this script has been reporting
  // green for the wrong reason and must fail loudly.
  if (PROVE_DETECTABLE) {
    console.log("6. fault injection -- can this rehearsal detect a lossy restore?\n");
    const lossy = join(work, "lossy.db");
    copyFileSync(restored, lossy);
    execFileSync("sqlite3", [
      lossy,
      "DROP TRIGGER IF EXISTS trg_plugin_installs_blocked_is_explained;",
    ]);

    let detected = false;
    let detail = "";
    try {
      harness([], { P07_SCHEMA_DB: lossy });
      detail = "the suite reported no failure against a database missing a trigger";
    } catch (error) {
      // The failure list is printed with console.error, so stderr has to be read
      // too. Reading only stdout reported "failing: none listed" beside a 123/125
      // tally, which reads as a contradiction.
      const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      const tally = out.match(/(\d+)\/(\d+) invariants behave as declared/);
      const failing = [...out.matchAll(/^\s+- (.+)$/gm)].map((m) => m[1]);
      detected = (tally && Number(tally[1]) < Number(tally[2])) || failing.length > 0;
      detail = `suite reported ${tally ? `${tally[1]}/${tally[2]}` : "no tally"}; failing: ${
        failing.slice(0, 3).join(", ") || "none listed"
      }`;
    }
    const ok = detected;
    console.log(`  ${ok ? "PASS" : "FAIL"}  a restore missing a trigger is DETECTED`);
    console.log(`        ${detail}`);
    if (!ok) {
      console.error(
        "\n  The rehearsal cannot detect the failure it exists to detect, so every PASS\n" +
          "  above is unearned. Fix the verification before trusting this script.",
      );
      process.exitCode = 1;
    }
    console.log("");
  }

  if (passed !== results.length) process.exitCode = 1;
} finally {
  // Before anything else: the developer's local D1 goes back even if the rehearsal
  // threw. Losing someone's local data because a verification script crashed would be
  // the worst thing in this repository.
  try {
    restoreState();
  } catch (error) {
    console.error(`\nFAILED to put the local D1 state back: ${error.message}`);
    console.error(`Your original state is at ${STASH}. Move it to ${STATE} by hand.`);
    process.exitCode = 1;
  }
  if (KEEP) {
    console.log(`artifacts kept in ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}
