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
