#!/usr/bin/env node
// VI-IDEM-001 / VFY-004 -- the guard-sentinel probe.
//
// WHY THIS EXISTS
//
// A "guard sentinel" is a deliberately invalid `idempotency_records` insert that
// aborts a D1 batch when a conditional write matched zero rows. 37 statements
// across 13 repository modules emit the identical row, and the batch error is the
// ONLY signal that a write was refused on purpose rather than the store being
// unavailable. The two must not be confused: a refusal means "re-read
// authoritative state and answer", an outage means "fail closed with 503".
//
// V00-2026-09-27 (finding VFY-004) is what that costs when the signal drifts.
// Migration 0020 added a `BEFORE INSERT` trigger that fires before the column
// constraints, so the error text for the IDENTICAL statement changed from
//
//     NOT NULL constraint failed: idempotency_records.principal_id
//
// to
//
//     a pending idempotency record carries no result and must hold a claim token
//
// and the recogniser -- a case-sensitive `contains("NOT NULL") ||
// contains("constraint")` -- matched neither. Every guard in the repository was
// silently reclassified as a store outage. `p05-smoke.mjs` began returning
// `status=503 reason=none` for a duplicate budget reservation, and P06 automation
// refusals became retryable job failures instead of settled ones.
//
// The Rust unit tests pin the texts the application MATCHES. This probe pins the
// other half: that the texts SQLite ACTUALLY produces for the ACTUAL sentinel,
// against the ACTUAL schema, are among them. Only a real database can answer
// that -- which is why this is a separate probe and not another `cargo test`.
//
// It also pins the negative half, which is the more dangerous direction: a
// failure on some other table must NOT read as a guard, because the old
// `contains("constraint")` accepted any of them and would answer an integrity
// failure with business copy.
//
// Usage:
//   node apps/api/scripts/p02-guard-probe.mjs
//   pnpm --filter @runlumi/agents-cp-api guard:probe
//
// Exits non-zero if any case does not behave as declared.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = join(scriptDir, "..");
const migrationsDir = join(apiDir, "migrations");
const idempotencySource = join(apiDir, "src/core/idempotency.rs");

// The migration whose BEFORE INSERT triggers took over the abort text. Used to
// build the pre-0020 schema, which is how the other text is reached.
const TRIGGER_MIGRATION = "0020_p09_idempotency_null_safety.sql";

// The one list the application matches against, parsed straight out of the Rust
// source. A test that reads the value it is checking is circular; reading the
// CONSTANT and then asking a real database whether reality agrees with it is not.
function guardAbortTexts() {
  const source = readFileSync(idempotencySource, "utf8");
  const block = /const GUARD_ABORT_TEXTS: &\[&str\] = &\[([\s\S]*?)\n\];/.exec(source);
  if (!block) {
    throw new Error(
      "GUARD_ABORT_TEXTS was not found in apps/api/src/core/idempotency.rs. The " +
        "recogniser moved or was renamed; this probe must be updated to match, not deleted.",
    );
  }
  return [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

/**
 * Read the body of `is_guard_abort` out of the Rust source.
 *
 * This probe verifies the LIST against a real database. It previously did not
 * verify that the FUNCTION reads that list -- it re-implemented the matching here in
 * JavaScript, so replacing `is_guard_abort`'s body with `contains("constraint")`
 * changed nothing this probe could see. The mutation campaign found that: a case
 * that reverts the recogniser to the pre-VFY-004 matcher left all eleven checks
 * green, and was reported as a harness fault because the guard probe exited 0.
 *
 * A list nobody reads is not a fix. So the wiring is asserted too, and the campaign's
 * mutation is detectable.
 */
function isGuardAbortBody() {
  const source = readFileSync(join(apiDir, "src/core/idempotency.rs"), "utf8");
  const start = source.indexOf("pub fn is_guard_abort(detail: &str) -> bool {");
  if (start === -1) return null;
  // Walk braces to the end of the function, so the body is read exactly rather than
  // guessed from a fixed number of lines.
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
      opened = true;
    } else if (source[i] === "}") {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

const isRecognised = (text, known) => {
  const lowered = String(text).toLowerCase();
  return known.some((candidate) => lowered.includes(candidate.toLowerCase()));
};

// The exact sentinel the repositories emit. Copied from
// `repositories/budgets.rs::ASSERT_RESERVATION_CREATED_SQL` and the other sites,
// which share this shape. A mismatch here would make the probe pass without
// testing the real statement, so the shape is checked against the repository
// source below rather than assumed.
const SENTINEL_ROW = "SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL";
const SENTINEL = `
INSERT INTO idempotency_records (
    principal_id, organization_id, method, path, key_digest, request_fingerprint,
    state, response_status, response_body, expires_at, claim_token
)
${SENTINEL_ROW}
WHERE NOT EXISTS (SELECT 1 FROM probe_guard_target WHERE marker = 'absent')`;

const cases = [];
const check = (label, run) => cases.push({ label, run });

/** A database with `upTo` of the real migrations applied, plus the probe's target. */
function freshDatabase(upTo = null) {
  const dir = mkdtempSync(join(tmpdir(), "lumi-guard-probe-"));
  const db = new DatabaseSync(join(dir, "probe.sqlite"));
  const names = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = upTo ? names.filter((n) => n < upTo) : names;
  for (const name of applied) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  db.exec("CREATE TABLE probe_guard_target (marker TEXT PRIMARY KEY)");
  db.exec("INSERT INTO probe_guard_target (marker) VALUES ('present')");
  return {
    db,
    appliedCount: applied.length,
    totalCount: names.length,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function captureError(db, sql) {
  try {
    db.exec(sql);
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

check("the real migrations apply, so the probe is testing the real schema", () => {
  const { db, appliedCount, totalCount, cleanup } = freshDatabase();
  try {
    // A marker table introduced by a late migration, so "migrations ran" is
    // demonstrated by the schema rather than by a bookkeeping table this probe
    // would otherwise have to fake.
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("webauthn_ceremonies");
    if (Number(row.n) !== 1) {
      return `migration 0008's table webauthn_ceremonies is missing, so the schema is not the real one`;
    }
    if (appliedCount !== totalCount) {
      return `applied ${appliedCount} of ${totalCount} migrations`;
    }
    return null;
  } finally {
    cleanup();
  }
});

check("the sentinel shape in this probe is the shape the repositories actually emit", () => {
  // If the repositories changed the sentinel, the text captured below would not
  // be the text the application meets, and every case in this file would be
  // theatre. Counted, not eyeballed.
  let sites = 0;
  const files = [];
  for (const file of readdirSync(join(apiDir, "src/repositories"))) {
    if (!file.endsWith(".rs")) continue;
    const source = readFileSync(join(apiDir, "src/repositories", file), "utf8");
    const hits = source.split(SENTINEL_ROW).length - 1;
    if (hits > 0) {
      sites += hits;
      files.push(`${file}(${hits})`);
    }
  }
  if (sites < 30) {
    return (
      `only ${sites} guard sentinels found across ${files.length} files; the shape this probe ` +
      `assumes may have changed. Counted: ${files.join(", ")}`
    );
  }
  return null;
});

check("a real sentinel aborts, and its text is one the recogniser knows", () => {
  const known = guardAbortTexts();
  const { db, cleanup } = freshDatabase();
  try {
    // The guard fires when the target is ABSENT, so the sentinel's WHERE holds.
    const message = captureError(db, SENTINEL);
    if (!message) {
      return "the sentinel did NOT abort, so this probe would pass without testing anything";
    }
    if (!isRecognised(message, known)) {
      return (
        "a guard aborted with an UNRECOGNISED text, so the application would classify it as a " +
        `store outage and return 503 instead of the documented conflict:\n  ${message}\n` +
        `  known texts: ${JSON.stringify(known)}\n` +
        "  fix: add the text to GUARD_ABORT_TEXTS in apps/api/src/core/idempotency.rs, naming the " +
        "migration that introduced it. Do NOT widen the matcher -- a real store failure reading as " +
        "a guard is a worse bug than the one being fixed."
      );
    }
    return null;
  } finally {
    cleanup();
  }
});

check("the sentinel inserts nothing, so the abort really did roll the batch back", () => {
  const { db, cleanup } = freshDatabase();
  try {
    captureError(db, SENTINEL);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM idempotency_records WHERE principal_id IS NULL")
      .get();
    if (Number(row.n) !== 0) {
      return `${row.n} sentinel rows persisted; the abort did not roll back, so the guard is not load-bearing`;
    }
    return null;
  } finally {
    cleanup();
  }
});

check("the abort text is migration 0020's trigger, so the old regression cannot return", () => {
  // The specific property VFY-004 broke: the current schema produces the TRIGGER
  // text, and the recogniser must therefore carry it. If a future migration
  // removes or reorders those triggers, this fails and says so, rather than
  // letting the list go stale and every guard silently become a 503.
  const known = guardAbortTexts();
  const { db, cleanup } = freshDatabase();
  try {
    const message = captureError(db, SENTINEL) ?? "";
    const isTriggerText = known.some((text) => message.toLowerCase().includes(text.toLowerCase()));
    if (!isTriggerText) {
      return (
        "the sentinel no longer produces any recognised text, so the 0020 trigger the recogniser " +
        `covers is untested. Observed: ${message || "(no error)"}`
      );
    }
    if (message.includes("NOT NULL constraint failed")) {
      return (
        "the sentinel now aborts through the column constraint rather than the 0020 trigger, so the " +
        `trigger text in GUARD_ABORT_TEXTS is unreachable. Observed: ${message}`
      );
    }
    return null;
  } finally {
    cleanup();
  }
});

check("the pre-0020 abort text is also recognised, so a rollback stays correct", () => {
  // Schema 0019 and earlier. A rollback of migration 0020, or a database restored
  // from an older backup, must still classify guards correctly -- the recognition
  // is not allowed to depend on which schema version is live.
  const known = guardAbortTexts();
  const { db, cleanup } = freshDatabase(TRIGGER_MIGRATION);
  try {
    const message = captureError(db, SENTINEL);
    if (!message) return "the pre-0020 sentinel did not abort, so the case proves nothing";
    if (!isRecognised(message, known)) {
      return (
        "a guard on the pre-0020 schema aborted with an UNRECOGNISED text:\n  " +
        `${message}\n  known texts: ${JSON.stringify(known)}`
      );
    }
    return null;
  } finally {
    cleanup();
  }
});

check("an UNIQUE violation on an unrelated table is NOT read as a guard", () => {
  const known = guardAbortTexts();
  const { db, cleanup } = freshDatabase();
  try {
    const message = captureError(db, "INSERT INTO probe_guard_target (marker) VALUES ('present')");
    if (!message) return "the UNIQUE violation did not fire, so the case proves nothing";
    if (isRecognised(message, known)) {
      return (
        "a UNIQUE violation on an unrelated table reads as a deliberate guard, so an integrity " +
        `failure would be answered with business copy instead of a 503:\n  ${message}`
      );
    }
    return null;
  } finally {
    cleanup();
  }
});

check("a NOT NULL violation on another idempotency_records column is NOT read as a guard", () => {
  // The narrowest of the negatives, and the one the recogniser's pre-0020 entry
  // is written to pass. Naming the column rather than the table is what makes
  // this hold.
  const known = guardAbortTexts();
  const { db, cleanup } = freshDatabase();
  try {
    // The row is COMPLETED and carries a 2xx status and a body, so migration
    // 0020's triggers both pass. That matters: a `pending` row would abort on
    // `trg_idempotency_pending_has_no_result` first and this case would measure
    // the trigger text again instead of the column constraint it is written to
    // isolate. The only defect here is the NULL `organization_id`, so the abort
    // must name that column.
    const message = captureError(
      db,
      "INSERT INTO idempotency_records (principal_id, organization_id, method, path, key_digest, " +
        "request_fingerprint, state, response_status, response_body, expires_at) VALUES " +
        "('usr_1', NULL, 'POST', '/x', 'k', 'f', 'completed', 200, '{}', '2030-01-01T00:00:00.000Z')",
    );
    if (!message) return "the NOT NULL violation did not fire, so the case proves nothing";
    if (!message.includes("organization_id")) {
      return (
        "the case did not reach the column constraint it exists to isolate, so it proves nothing " +
        `about the recogniser:\n  ${message}`
      );
    }
    if (isRecognised(message, known)) {
      return (
        "a code bug inserting a NULL into a non-sentinel column reads as a guard, so the caller " +
        `would get a business answer for a fault:\n  ${message}`
      );
    }
    return null;
  } finally {
    cleanup();
  }
});

check("a FOREIGN KEY violation is NOT read as a guard", () => {
  const known = guardAbortTexts();
  const { db, cleanup } = freshDatabase();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const message = captureError(
      db,
      "INSERT INTO webauthn_ceremonies (ceremony_id, kind, status, state_json, expires_at) " +
        "VALUES ('cer_probe', 'passkey_signup', 'pending', '{}', '2030-01-01T00:00:00.000Z')",
    );
    if (!message) return "the FOREIGN KEY violation did not fire, so the case proves nothing";
    if (isRecognised(message, known)) {
      return `a FOREIGN KEY violation reads as a guard:\n  ${message}`;
    }
    return null;
  } finally {
    cleanup();
  }
});

check("a real store failure is NOT read as a guard", () => {
  const known = guardAbortTexts();
  const { db, cleanup } = freshDatabase();
  try {
    const message = captureError(db, "SELECT * FROM a_table_that_does_not_exist");
    if (!message) return "the missing-table failure did not fire, so the case proves nothing";
    if (isRecognised(message, known)) {
      return `a missing-table failure reads as a guard:\n  ${message}`;
    }
    return null;
  } finally {
    cleanup();
  }
});

check("the recognised-text list holds only measured entries", () => {
  // Both entries are measured by the two "real sentinel aborts" cases above. A
  // third would have no evidence behind it, and a reader could not tell a
  // measured entry from a guessed one.
  const known = guardAbortTexts();
  if (known.length !== 2) {
    return (
      `GUARD_ABORT_TEXTS holds ${known.length} entries: ${JSON.stringify(known)}. Only two are ` +
      "reachable -- the column NOT NULL text (schema 0019 and earlier) and the pending-trigger " +
      "text (0020 onward). Prove any new one against a real database before adding it."
    );
  }
  if (known.some((text) => text.trim() === "")) {
    return "GUARD_ABORT_TEXTS holds an empty entry, which would match every error";
  }
  return null;
});

check("is_guard_abort actually reads the list this probe verifies", () => {
  // The gap this closes: the probe re-implements the match in JavaScript, so it
  // proved the LIST is right and said nothing about whether the application uses it.
  // A list nothing reads is not a fix.
  const body = isGuardAbortBody();
  if (body === null) {
    return (
      "is_guard_abort was not found in apps/api/src/core/idempotency.rs, so the probe " +
      "cannot tell whether the application still uses the list it verifies. If it moved or was " +
      "renamed, update this probe rather than deleting the check."
    );
  }
  if (!body.includes("GUARD_ABORT_TEXTS")) {
    return (
      "is_guard_abort no longer reads GUARD_ABORT_TEXTS:\n  " +
      body.replace(/\s+/g, " ").slice(0, 200) +
      "\n  The list this probe verifies against real SQLite is therefore decorative -- the " +
      "same class of defect as VFY-004 itself, where the matcher and the schema had drifted " +
      "apart and nothing connected them."
    );
  }
  return null;
});

// ---------------------------------------------------------------------------
// V01-023 -- the POLARITY of every `guard!` in repositories/automations.rs.
// ---------------------------------------------------------------------------
//
// The probe above pins WHICH TEXTS the recogniser matches. This pins something the recogniser cannot
// see: whether each guard fires in the state it is supposed to fire in.
//
// A guard is a string macro, and its SQL is not readable as intent. `guard!("SELECT 1 FROM t WHERE
// <positive>")` and `guard!("SELECT 1 FROM t WHERE <negative>")` have the same shape, the same
// macro, the same failure mode and the same error text, and differ by one `NOT`. V01-023 was exactly
// that: `assert_run_link_absent_statement` asserted the presence of a run link, `NOT EXISTS`
// inverted it, and every legitimate first `start_occurrence` was refused -- forever, for every
// organization, reporting `lease_fence_invalid`.
//
// So each guard is evaluated in BOTH states:
//   * the state it must PERMIT -- the guard must insert nothing, and the batch must not abort;
//   * the state it must ABORT  -- the guard must insert the sentinel, which the trigger refuses.
//
// A guard that cannot tell the two states apart is **vacuous**, and that is asserted rather than
// assumed: this campaign has now shipped four comparisons that held on empty or identical inputs,
// and a polarity test that passes because the predicate is constant would be the fifth.
//
// The nine conditions are read out of the repository source rather than restated here, so this
// matrix cannot drift from the code it grades: a tenth `guard!` fails the count.
// Resolved the way the rest of this probe resolves its sources -- from the script's own directory,
// not the working directory. `pnpm --filter` runs with `apps/api` as the cwd, and a hard-coded
// repo-relative path fails there while passing when the file is run by hand from the root. Two of
// these cases failed on exactly that before it was fixed, which is a reminder that a probe whose
// inputs are unreachable reports nothing rather than failing.
const AUTOMATIONS_REPO = join(apiDir, "src/repositories/automations.rs");

/** Every `guard!("...")` literal in the automations repository, in source order. */
function guardConditions() {
  const source = readFileSync(AUTOMATIONS_REPO, "utf8");
  const out = [];
  const re = /guard!\(\s*"([\s\S]*?)"\s*,?\s*\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    out.push(match[1].replace(/\s+/g, " ").trim());
  }
  return out;
}

/** The function each `guard!` belongs to, so a failure names a route-facing symbol. */
function guardOwners() {
  const source = readFileSync(AUTOMATIONS_REPO, "utf8");
  const out = [];
  const re = /pub fn (assert_[a-z_]+)_statement[\s\S]*?guard!\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    out.push(match[1]);
  }
  return out;
}

check("V01-023: the polarity matrix covers every guard! in the automations repository", () => {
  const conditions = guardConditions();
  const owners = guardOwners();
  if (conditions.length !== 9) {
    return (
      `found ${conditions.length} guard! sites and expected 9. Either a guard was added -- in ` +
      `which case its polarity is unpinned and this matrix is a false pass -- or one was removed, ` +
      `in which case this count is stale. Read ${AUTOMATIONS_REPO} and decide deliberately.`
    );
  }
  if (owners.length !== 9) {
    return (
      `attributed ${owners.length} of the 9 guard! sites to a named function, so a failure ` +
      `below could not be traced to a symbol`
    );
  }
  return null;
});

check(
  "V01-023: assert_run_link_absent_statement permits the first start and aborts a duplicate",
  () => {
    // Read the REAL condition out of the source rather than restating it, so a future "fix" that
    // re-inverts the polarity fails here instead of being graded by a copy that was edited in step.
    const source = readFileSync(AUTOMATIONS_REPO, "utf8");
    const start = source.indexOf("pub fn assert_run_link_absent_statement");
    if (start < 0) {
      return "assert_run_link_absent_statement is gone; if it was renamed, this matrix must follow";
    }
    const body = source.slice(start, source.indexOf("    }", start));
    const condition = /guard!\(\s*"([\s\S]*?)"\s*,?\s*\)/
      .exec(body)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    if (!condition) {
      return "could not read the guard! condition out of assert_run_link_absent_statement";
    }
    // A presence-shaped condition is the V01-023 defect verbatim, whatever else it says.
    if (/FROM automation_run_links WHERE/.test(condition) && !/NOT EXISTS/.test(condition)) {
      return (
        `the condition still asserts that a run link EXISTS: "${condition}". The guard! macro ` +
        `inverts it, so this aborts when there is NO link and refuses every legitimate first start.`
      );
    }

    const { db, cleanup } = freshDatabase();
    try {
      const guard = `INSERT INTO idempotency_records (
        principal_id, organization_id, method, path, key_digest, request_fingerprint,
        state, response_status, response_body, expires_at, claim_token
      ) ${SENTINEL_ROW} WHERE NOT EXISTS (${condition.replaceAll("?1", "'occ_probe'").replaceAll("?2", "1")})`;

      // PERMIT: no link exists yet -- the ordinary first start. This is the state V01-023 refused.
      const permitted = captureError(db, guard);
      if (permitted !== null) {
        return (
          `the guard ABORTED with no run link present, so a first start would be refused. ` +
          `That is V01-023. Error: ${permitted}`
        );
      }
      // ABORT: a link now exists -- a second start for the same attempt must be refused.
      //
      // The row goes into the REAL `automation_run_links`, not a stand-in table. My first version used
      // a probe table of its own, so the guard's condition -- which names the real table -- still saw
      // an empty one, and the ABORT half reported a false failure. A guard's polarity is a property
      // of the tables it names; testing it against a different table tests nothing.
      //
      // Foreign keys are off for the fixture only: the four parents (organization, occurrence, run,
      // lease) are an automation's whole lifecycle, and scaffolding them here would test the fixture
      // rather than the guard. Every NOT NULL and CHECK on the row itself is still satisfied.
      db.exec("PRAGMA foreign_keys = OFF");
      const stamp = "2026-01-01T00:00:00.000Z";
      const fixed = (prefix) => `'${prefix}_${"0".repeat(32)}'`;
      db.exec(
        `INSERT INTO automation_run_links
           (link_id, occurrence_id, org_id, run_id, lease_id, attempt, state, created_at, updated_at)
         VALUES (${fixed("lnk")}, 'occ_probe', 'org_probe', ${fixed("run")}, ${fixed("lse")}, 1,
                 'linked', '${stamp}', '${stamp}')`,
      );
      const linked = db
        .prepare(
          "SELECT COUNT(*) AS n FROM automation_run_links WHERE occurrence_id = ? AND attempt = ?",
        )
        .get("occ_probe", 1);
      if (Number(linked.n) !== 1) {
        return (
          `the run link fixture did not land, so the ABORT half would grade an empty table. ` +
          `That is the vacuous pass this campaign has hit four times, so it is checked.`
        );
      }
      const aborted = captureError(db, guard);
      if (aborted === null) {
        return (
          `the guard did NOT abort with a run link present, so a duplicate start would create a ` +
          `second run for the same attempt`
        );
      }
      if (!isRecognised(aborted, guardAbortTexts())) {
        return (
          `the guard aborted, but with an unrecognised text, so the route would answer 503 ` +
          `instead of a deliberate refusal: ${aborted}`
        );
      }
      return null;
    } finally {
      cleanup();
    }
  },
);

check("is_guard_abort does not widen itself past the list", () => {
  // Belt and braces. Even while reading the list, a function that also accepts any
  // text containing "constraint" is back to the pre-VFY-004 behaviour, which called
  // a UNIQUE violation on an unrelated table a deliberate guard.
  const body = isGuardAbortBody();
  if (body === null) return "is_guard_abort was not found; see the check above";
  if (/contains\(\s*["']constraint["']\s*\)/.test(body)) {
    return (
      'is_guard_abort still accepts any text containing "constraint", which is the ' +
      "over-broad half of the pre-VFY-004 matcher: an UNIQUE or FOREIGN KEY violation on an " +
      "unrelated table would be reported as a deliberate guard and answered with business copy."
    );
  }
  return null;
});

// --- runner -------------------------------------------------------------------

let passed = 0;
const failures = [];
for (const testCase of cases) {
  let problem = null;
  try {
    problem = testCase.run();
  } catch (error) {
    problem = `threw: ${error?.message ?? error}`;
  }
  if (problem) {
    failures.push(testCase.label);
    console.log(`  FAIL  ${testCase.label}`);
    for (const line of String(problem).split("\n")) console.log(`        ${line}`);
  } else {
    passed += 1;
    console.log(`  PASS  ${testCase.label}`);
  }
}

console.log(
  `\n${passed}/${cases.length} guard cases hold across ${guardAbortTexts().length} recognised abort texts`,
);
if (failures.length) {
  console.error(`\n${failures.length} case(s) failed:`);
  for (const label of failures) console.error(`  - ${label}`);
  process.exitCode = 1;
}
