// P09: is the SQLite NULL-passes-CHECK hole unique to idempotency_records, or is
// it a class?
//
// VI-IDEM-001 found that `response_status BETWEEN 200 AND 299` on a NULL column
// evaluates to NULL, so `0 OR NULL` = NULL, and a CHECK constraint fails only on a
// definite FALSE -- it PASSES on NULL. That let a `completed` idempotency record
// exist with no response at all, in the table that makes every mutating route safe
// to retry.
//
// That was found by hand, from one bad row. This asks the question mechanically:
// across EVERY table and EVERY CHECK in the schema, is there a nullable column
// compared with BETWEEN in a position where NULL would make the whole constraint
// pass?
//
// This is a STATIC scan, so it is V1 evidence, not V3. It nominates candidates; the
// hand-written `expect` probes in p07-schema-invariants.mjs are what prove a fix,
// and the migration trigger is what actually closes one.
//
//   node apps/api/scripts/p09-null-check-scan.mjs
//   node apps/api/scripts/p09-null-check-scan.mjs --ignore-adjudications   # prove it fires
//
// The second form is the reason `--ignore-adjudications` exists. A scan that reports
// "0 open" is only evidence if you have watched it report otherwise, and the only
// honest way to do that is a supported flag rather than a hand-edit of the
// allow-list -- the first attempt at that edit produced a file that did not parse,
// which is a fine way to learn that a proof step should not be improvised.
//
// Three false-positive shapes had to be taught to this scanner, and each was found
// by running it and reading what it wrongly reported:
//
//   1. `col IS NULL OR col BETWEEN a AND b` -- the guard is the first arm of the
//      same OR. The single most common idiom in this schema; five tables use it.
//   2. A guard anywhere in the block, including inside a DIFFERENT OR arm. Wrong in
//      a way that is easy to miss: `idempotency_records` contains
//      `response_status IS NULL` (in the `pending` arm) and is still broken, so the
//      first version of this scanner reported the schema clean while the bug was
//      live. It is the same subtlety as the bug it was written to find.
//   3. A conjoined guard, `col IS NULL OR (other = 'x' AND col BETWEEN a AND b)`.
//      Looks like (2) but is safe: the NULL arm is unconditional.
//
// The rule that survives all three: a BETWEEN is NULL-safe when some SIBLING arm of
// the same OR imposes no requirement on the column other than its nullness.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORE_ADJUDICATIONS = process.argv.includes("--ignore-adjudications");

/**
 * Candidates this scan is not allowed to re-report, each with the reason.
 *
 * Same contract as `REVIEWED_DERIVED_DEBUG` in `security/secret_canary.rs`: an entry
 * is a decision with a written reason, adding to it is deliberate, and the tally
 * prints the count so shrinkage is visible.
 */
const ADJUDICATED = [
  {
    table: "idempotency_records",
    column: "response_status",
    reason:
      "CLOSED by migration 0020, triggers trg_idempotency_completed_requires_status " +
      "and its _update twin. A CHECK cannot express this: the `completed` arm's " +
      "`BETWEEN` is NULL and the pending arm's `IS NULL` is conjoined with other " +
      "conditions, so no arm is a pure nullness test. A trigger is NULL-safe and " +
      "additive, so the table was not rebuilt and rollback stays a Worker rollback. " +
      "Proven by the p07 case `a completed record with NO status is refused`.",
  },
];

const MIGRATIONS = "apps/api/migrations";
const db = new DatabaseSync(":memory:");
for (const file of readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
}

/** Split on a keyword that appears at paren depth 0 only. */
function splitTopLevel(body, keyword) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const upper = body.toUpperCase();
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && upper.startsWith(keyword, i)) {
      const before = i === 0 ? " " : body[i - 1];
      const after = body[i + keyword.length] ?? " ";
      if (/\s/.test(before) && /\s/.test(after)) {
        parts.push(body.slice(start, i));
        start = i + keyword.length;
        i += keyword.length - 1;
      }
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** CHECK bodies, found by scanning the stored DDL with a depth counter. */
function checkBlocks(ddl) {
  const blocks = [];
  for (const m of ddl.matchAll(/CHECK\s*\(/gi)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < ddl.length; i += 1) {
      if (ddl[i] === "(") depth += 1;
      else if (ddl[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(ddl.slice(m.index + m[0].length, i));
  }
  return blocks;
}

/**
 * Is `arm` a statement about `column`'s nullness and NOTHING else?
 *
 * "Nothing else" is the whole test, and it is why a naive "does the block contain
 * `col IS NULL`" check reports a broken schema as clean.
 */
function isPureNullnessTest(arm, column) {
  const stripped = arm.replace(/[()\s]/g, "");
  return new RegExp(`^(NOT)?${column}IS(NOT)?NULL$`, "i").test(stripped);
}

const tables = db
  .prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all();

let betweenBlocks = 0;
const findings = [];

for (const { name, sql } of tables) {
  const nullable = new Set(
    db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .filter((c) => c.notnull === 0)
      .map((c) => c.name),
  );
  if (nullable.size === 0) continue;

  for (const body of checkBlocks(sql ?? "")) {
    if (!/\bBETWEEN\b/i.test(body)) continue;
    betweenBlocks += 1;
    const arms = splitTopLevel(body, "OR");
    for (const arm of arms) {
      for (const column of nullable) {
        if (!new RegExp(`\\b${column}\\b\\s+BETWEEN`, "i").test(arm)) continue;
        // Guarded if a sibling arm is a PURE nullness test of the same column, or
        // if this very arm tests the column's nullness before comparing it.
        const siblingGuard = arms.some(
          (other) => other !== arm && isPureNullnessTest(other, column),
        );
        const localGuard = new RegExp(`\\b${column}\\b\\s+IS\\s+(NOT\\s+)?NULL`, "i").test(arm);
        if (siblingGuard || localGuard) continue;
        findings.push({
          table: name,
          column,
          body: arm.replace(/\s+/g, " ").trim().slice(0, 160),
        });
      }
    }
  }
}

const key = (f) => `${f.table}.${f.column}`;
const adjudications = IGNORE_ADJUDICATIONS ? [] : ADJUDICATED;
const adjudicatedKeys = new Set(adjudications.map((a) => `${a.table}.${a.column}`));
const open = findings.filter((f) => !adjudicatedKeys.has(key(f)));

console.log(
  `scanned ${tables.length} tables; ${betweenBlocks} CHECK block(s) use BETWEEN; ` +
    `${findings.length} raw candidate(s), ${adjudications.length} adjudicated, ${open.length} open`,
);
if (IGNORE_ADJUDICATIONS) {
  console.log("(--ignore-adjudications: proving the scan can still fail)");
}
if (adjudications.length > 0) {
  console.log("\nadjudicated (each is a decision with a written reason):");
  for (const a of adjudications) console.log(`  ${a.table}.${a.column}\n    ${a.reason}\n`);
}
if (open.length === 0) {
  console.log(
    "no nullable column is compared with BETWEEN anywhere NULL would let the whole\n" +
      "CHECK pass. `idempotency_records.response_status` was the only one; migration\n" +
      "0020 closes it and a probe in p07-schema-invariants.mjs proves it.",
  );
  process.exit(0);
}
console.log(`${open.length} OPEN candidate(s) — each can pass by being NULL:\n`);
for (const f of open) console.log(`  ${key(f)}\n    ${f.body}\n`);
process.exit(1);
