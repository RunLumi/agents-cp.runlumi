#!/usr/bin/env node
// Does every `database.prepare(SQL, &[...])` bind exactly as many values as its SQL
// has placeholders?
//
// WHY THIS EXISTS
//
// D1 rejects a mismatched statement at execution time with "Wrong number of parameter
// bindings for SQL query". Nothing in the Rust suite catches it, because the tests
// exercise repositories against a mock or assert on a statement's shape rather than
// running it through D1.
//
// One such mismatch shipped and broke all four P06 data-governance job routes:
// `POST /api/v1/orgs/{org_id}/exports` returned 409 on every request, and
// `commit_mutation` discarded the underlying error, so it presented as a business
// conflict rather than a server fault. See VFY-008. A static check costs milliseconds
// and would have caught all six.
//
// WHAT COUNTS AS "HOW MANY VALUES SQL NEEDS"
//
// Not the number of DISTINCT placeholders. SQLite binds positionally and requires
// exactly as many values as the HIGHEST index used, so a statement using ?1, ?2 and
// ?4 needs four. Counting distinct placeholders reported a correct statement as
// broken.
//
// WHAT THIS DOES NOT COVER, stated rather than glossed
//
// It reads source, so it says nothing about whether a bound value is the RIGHT value
// -- only that the arity matches. It also cannot tell a live statement from one in
// dead code; a mismatch in an unreferenced function is still reported, and fixing it
// is still correct, but it is not by itself evidence of a runtime defect.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(apiDir, "src");

/** Every `*.rs` under `dir`, recursively. */
function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...rustFiles(path));
    else if (entry.endsWith(".rs")) out.push(path);
  }
  return out;
}

const OPEN = "([{";
const CLOSE = ")]}";

/**
 * Walk `text` from `start`, tracking nesting, and return the index of the bracket
 * that closes the one at `start`. String literals are skipped so a `"]"` inside a
 * SQL string cannot end the scan early.
 */
function closingBracket(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    // `OPEN.indexOf(ch) >= 0`, NOT `ch === "([{"`. Comparing one character to a
    // three-character string is never true, so the first port of this check from
    // Python -- where `ch in "([{"` is a membership test -- silently matched
    // nothing: every call returned -1, every statement was skipped, and the check
    // reported green having looked at zero statements. A verifier that cannot see
    // anything must not be able to pass.
    else if (OPEN.indexOf(ch) >= 0) depth += 1;
    else if (CLOSE.indexOf(ch) >= 0) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Elements of a Rust array literal, counted by its top-level commas. */
function topLevelCount(text) {
  // `&[]` binds nothing. Without this the counter starts at one and reports every
  // parameterless statement as binding a value it does not have -- two false
  // positives in billing.rs on the first run, both `prepare(SQL, &[])`.
  if (text.trim() === "") return 0;
  let depth = 0;
  let count = 1;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (OPEN.indexOf(ch) >= 0) depth += 1;
    else if (CLOSE.indexOf(ch) >= 0) depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  // A trailing comma adds a phantom element.
  return text.trimEnd().endsWith(",") ? count - 1 : count;
}

/** How many values SQLite requires: the highest `?N` index, or none. */
function requiredBindCount(sql) {
  let highest = 0;
  for (const match of sql.matchAll(/\?(\d+)/g)) {
    const index = Number(match[1]);
    if (index > highest) highest = index;
  }
  return highest;
}

const SQL_CONST = /const\s+([A-Z0-9_]+)\s*:\s*&str\s*=\s*r#"([\s\S]*?)"#\s*;/g;
const PREPARE = /\.prepare\(\s*([A-Z0-9_]+)\s*,\s*&\[/g;

const files = rustFiles(root);

// Constants are resolved PER FILE. Nine names are reused across modules with
// different arity -- INSERT_EVENT_SQL, INSERT_GRANT_SQL, INSERT_POLICY_SQL and six
// others -- so one global map matches a call against another module's SQL and
// invents mismatches. A global map is only consulted for names that are the same
// everywhere.
const perFile = new Map();
const globalVariants = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(SQL_CONST)) {
    const [, name, sql] = match;
    if (!perFile.has(file)) perFile.set(file, new Map());
    const local = perFile.get(file);
    if (!local.has(name)) local.set(name, []);
    local.get(name).push(sql);
    if (!globalVariants.has(name)) globalVariants.set(name, new Set());
    globalVariants.get(name).add(sql);
  }
}
const unambiguous = new Map();
for (const [name, variants] of globalVariants) {
  if (variants.size === 1) unambiguous.set(name, [...variants][0]);
}

const problems = [];
let checked = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  // Materialised rather than iterated directly. Iterating the `matchAll` iterator
  // here yielded nothing on this runtime while spreading the same call produced every
  // match, and a verifier that silently checks zero statements is worse than no
  // verifier: it reports green having looked at nothing.
  const calls = [...text.matchAll(PREPARE)];
  for (const match of calls) {
    const name = match[1];
    const local = perFile.get(file)?.get(name);
    const sql = local ? local[0] : unambiguous.get(name);
    if (sql === undefined) continue;
    const open = text.indexOf("[", match.index);
    const close = closingBracket(text, open);
    if (close === -1) continue;
    // The outer brackets are stripped: including them puts every element at depth
    // one and makes every array report a single element, which is how the first
    // version of this check reported 397 bogus mismatches.
    const bound = topLevelCount(text.slice(open + 1, close));
    const needed = requiredBindCount(sql);
    checked += 1;
    if (needed !== bound) {
      const line = text.slice(0, match.index).split("\n").length;
      const placeholders = [...new Set([...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])))];
      problems.push(
        `${file.replace(`${apiDir}/`, "")}:${line}  prepare(${name}, …) binds ${bound} value(s) ` +
          `but ${name} needs ${needed} for placeholders [${placeholders.join(", ")}]`,
      );
    }
  }
}

console.log(`checked ${checked} prepare() call(s) against their SQL constants`);
for (const problem of problems) console.log(`  MISMATCH  ${problem}`);
if (problems.length > 0) {
  console.log(`\n${problems.length} statement(s) would be rejected by D1 at execution time.`);
  process.exit(1);
}
console.log("\nevery prepare() call binds exactly as many values as its SQL has placeholders");
