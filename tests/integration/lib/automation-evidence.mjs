// Evidence helpers for the desktop automation journey: build/source provenance, the stage ledger that
// decides the verdict, and fail-closed D1/SQLite readers for the managed occurrence. D1 and the
// tasks-index are only ever READ here; every read goes through code that throws on a SQL error, so an
// error can never be mistaken for an absent row.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readTable } from "./automation-journey-state.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Digest + newest mtime of every file under `directory` (skipping node_modules). */
function treeStamp(directory, accept = () => true) {
  const hash = createHash("sha256");
  let newest = 0;
  let files = 0;
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name !== "node_modules") walk(full);
      } else if (accept(item.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
        hash.update(relative(directory, full)).update("\0").update(readFileSync(full)).update("\0");
        files += 1;
      }
    }
  };
  if (existsSync(directory)) walk(directory);
  return { files, newest, sha256: hash.digest("hex") };
}

/** Exact heads, dirty state and the built artifacts the run actually executed. */
export function provenance({ root, client, desktop }) {
  const dirty = (cwd) => git(cwd, "status", "--porcelain");
  const parentDirty = dirty(root);
  const clientDirty = dirty(client);
  const sourceDigest = (cwd, status) => {
    const paths = git(cwd, "diff", "--name-only", "HEAD").split("\n");
    paths.push(...git(cwd, "ls-files", "--others", "--exclude-standard").split("\n"));
    const hash = createHash("sha256").update(status);
    for (const path of [...new Set(paths.filter(Boolean))].sort()) {
      const full = join(cwd, path);
      hash.update(path).update("\0");
      if (existsSync(full) && statSync(full).isFile()) hash.update(readFileSync(full));
      else hash.update("<missing-or-directory>");
      hash.update("\0");
    }
    return hash.digest("hex");
  };
  const bundles = ["main", "host", "scheduler", "renderer", "preload"].map((name) => ({
    name,
    ...treeStamp(join(desktop, "out", name), (file) => !file.endsWith(".map")),
  }));
  const sources = ["desktop", "services", "shared", "ui"].map((name) =>
    treeStamp(
      join(client, "packages", name, "src"),
      (file) => /\.(ts|tsx|json)$/.test(file) && !/\.test\./.test(file),
    ),
  );
  const newestSource = Math.max(...sources.map((item) => item.newest));
  const oldestBundle = Math.min(...bundles.map((item) => item.newest));
  return {
    bundles: bundles.map(({ name, files, sha256, newest }) => ({
      name,
      files,
      sha256,
      newest: new Date(newest).toISOString(),
    })),
    newestSource: new Date(newestSource).toISOString(),
    oldestBundle: new Date(oldestBundle).toISOString(),
    /** True when a product source file is newer than a bundle the app will run: the build is stale. */
    buildStale: newestSource > oldestBundle,
    parentHead: git(root, "rev-parse", "HEAD"),
    clientHead: git(client, "rev-parse", "HEAD"),
    pairedGitlink: git(root, "ls-tree", "HEAD", "integrations/lumi-agents").split(/\s+/)[2],
    parentDirtyFiles: parentDirty ? parentDirty.split("\n").length : 0,
    clientDirtyFiles: clientDirty ? clientDirty.split("\n").length : 0,
    parentDirtyHash: createHash("sha256").update(parentDirty).digest("hex"),
    clientDirtyHash: createHash("sha256").update(clientDirty).digest("hex"),
    parentCandidateContentHash: sourceDigest(root, parentDirty),
    clientCandidateContentHash: sourceDigest(client, clientDirty),
    node: process.version,
  };
}

/**
 * The stage ledger. A stage is PASS only when every assertion in it ran; an exception is FAIL with
 * the message preserved; a stage that never ran or was cut short by an earlier failure is UNPROVEN.
 * `blocked` records a claim that cannot be exercised through public surfaces (kept out of PASS).
 */
function stageVerdict(claims) {
  // Fail closed: a stage with no executed PASS claim proves nothing, whatever else it recorded.
  if (claims.some((claim) => claim.verdict === "FAIL")) return "FAIL";
  const open = claims.filter(
    (claim) => claim.verdict !== "PASS" && claim.verdict !== "NOT_APPLICABLE",
  );
  if (open.length > 0 && open.every((claim) => claim.verdict === "BLOCKED")) return "BLOCKED";
  if (open.length > 0) return "UNPROVEN"; // UNPROVEN or any unrecognised verdict
  return claims.some((claim) => claim.verdict === "PASS") ? "PASS" : "UNPROVEN";
}

export function createLedger(stages) {
  const entries = new Map(
    stages.map((name) => [name, { status: "UNPROVEN", claims: [], notes: [] }]),
  );
  let current = "setup";
  const entry = (name) => entries.get(name) ?? { claims: [], notes: [] };
  return {
    get current() {
      return current;
    },
    enter(name) {
      current = name;
      if (entries.has(name)) entries.get(name).status = "RUNNING";
    },
    pass(claim) {
      entry(current).claims.push({ verdict: "PASS", claim });
      console.log(`PASS ${claim}`);
    },
    /** A named claim that was not (or could not be) exercised; never counted as PASS. */
    gap(stage, claim, status, reason) {
      entry(stage).claims.push({ verdict: status, claim, reason });
      console.log(`${status} ${claim} :: ${reason}`);
    },
    finish(name, error) {
      const item = entries.get(name);
      if (!item) throw new Error(`ledger: finish() for unknown stage ${name}`);
      if (error) {
        item.status = "FAIL";
        item.error = String(error?.stack ?? error).slice(0, 4_000);
      } else if (item.status === "RUNNING") {
        item.status = stageVerdict(item.claims);
      }
      // Never entered stays UNPROVEN and an already-finished stage keeps its verdict: no execution, no PASS.
    },
    snapshot() {
      return Object.fromEntries(entries);
    },
    allPass() {
      const items = [...entries.values()];
      return items.length > 0 && items.every((item) => item.status === "PASS");
    },
  };
}

/** Server rows for one managed automation, read straight from D1 (SELECT * so no column is assumed). */
export async function managedEvidence(server, orgId, managedAutomationId) {
  const id = `'${managedAutomationId}'`;
  const org = `'${orgId}'`;
  const occurrences = await server.rows(
    `SELECT * FROM automation_occurrences WHERE org_id=${org} AND automation_id=${id} ORDER BY created_at`,
    "managed occurrences",
  );
  const ids = occurrences.map((row) => `'${row.occurrence_id}'`).join(",") || "'none'";
  const [leases, attempts, links, definition] = await Promise.all([
    server.rows(
      `SELECT * FROM automation_leases WHERE occurrence_id IN (${ids}) ORDER BY claimed_at`,
      "leases",
    ),
    server.rows(
      `SELECT * FROM automation_occurrence_attempts WHERE occurrence_id IN (${ids}) ORDER BY recorded_at`,
      "attempts",
    ),
    server.rows(
      `SELECT * FROM automation_run_links WHERE occurrence_id IN (${ids}) ORDER BY created_at`,
      "links",
    ),
    server.rows(
      `SELECT * FROM automation_definitions WHERE org_id=${org} AND automation_id=${id}`,
      "definition",
    ),
  ]);
  const runIds = links.map((row) => `'${row.run_id}'`).join(",") || "'none'";
  const runs = await server.rows(`SELECT * FROM runs WHERE run_id IN (${runIds})`, "runs");
  return { definition: definition[0], occurrences, leases, attempts, links, runs };
}

/** Poll `read` until `done(value)`; the last value is returned in the failure so evidence is kept. */
export async function until(
  label,
  read,
  done,
  { timeout = 240_000, every = 5_000, tick, describe } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    if (tick) await tick();
    await delay(every);
  }
  throw new Error(
    `${label}: not reached within ${timeout}ms; last=${JSON.stringify(describe ? describe(last) : last).slice(0, 1_200)}`,
  );
}

/** Local managed-occurrence journal and adoption markers (tables from migrations 0004/0005). */
/** Compact, redacted occurrence/lease state for diagnostics: ids shortened, no tokens or bodies. */
export const compactOccurrences = (value) =>
  value.occurrences.slice(-10).map((row) => ({
    id: row.occurrence_id.slice(-8),
    state: row.state,
    reason: row.reason_code ?? null,
    at: row.scheduled_for,
    leases: value.leases
      .filter((lease) => lease.occurrence_id === row.occurrence_id)
      .map((lease) => lease.state),
  }));

export const localJournal = (profile) =>
  readTable(profile, "SELECT * FROM automation_managed_occurrences ORDER BY created_at");
export const localMarkers = (profile) =>
  readTable(profile, "SELECT * FROM automation_managed_adoptions ORDER BY created_at");

/** A deterministic text rendering of the tables a "nothing changed" assertion compares. */
export async function serverFingerprint(server, orgId) {
  const counts = await server.counts();
  const [definitions] = await Promise.all([
    server.rows(
      `SELECT automation_id, status, version, updated_at FROM automation_definitions WHERE org_id='${orgId}' ORDER BY automation_id`,
      "definition fingerprint",
    ),
  ]);
  return { counts, definitions };
}
