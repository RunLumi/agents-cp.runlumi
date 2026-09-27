#!/usr/bin/env node
// VI-TEST-001 — is the critical verification actually sensitive to a dangerous
// implementation fault?
//
// The contract (`docs/verification/contracts/core-invariants-v1.yaml`) names a
// specific mutation per Tier-0 invariant and requires that "the mutation must be
// killed by the expected verifier FOR THE INTENDED REASON". A test suite that
// fails for an unrelated reason has not proven anything, so every case here checks
// BOTH halves:
//
//   1. the mutant SURVIVES a build/compile, so the fault really is injected and
//      not merely a syntax error that trivially "fails the test"; and
//   2. the named verifier FAILS, and the failure text is inspected for the
//      invariant it is supposed to be defending.
//
// Usage:
//   node apps/api/scripts/p09-mutation-campaign.mjs            # report
//   node apps/api/scripts/p09-mutation-campaign.mjs --apply    # mutate + verify
//
// `--apply` mutates a DISPOSABLE WORKTREE and never the working tree; it refuses
// to run unless the worktree it was given is not the current checkout. The
// campaign is therefore safe to run, and running it is how you find out that a
// gate you wrote cannot fail.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");

/**
 * Every case names the invariant, the fault, where it goes, and the verifier that
 * MUST die. `expect` is a substring of the expected failure, so a verifier that
 * fails for the wrong reason does not count as a kill.
 */
const CASES = [
  {
    id: "VI-TEN-001",
    tier: 0,
    title: "a cross-tenant read loses its organization predicate",
    file: "apps/api/src/repositories/plugins.rs",
    // The org-scoped install read every P09 statement-classification test asserts.
    find: "WHERE org_id = ?1 AND package_id = ?2",
    replace: "WHERE package_id = ?2",
    verifier: ["tenant_audit", "schema"],
    expect: "PLUGIN_INSTALL",
  },
  {
    id: "VI-TEN-001",
    tier: 0,
    title: "a service-account page stops being org-scoped",
    file: "apps/api/src/repositories/machine_identity.rs",
    find: "WHERE org_id = ?1",
    replace: "WHERE 1 = 1",
    verifier: ["tenant_audit", "schema"],
    expect: "MACHINE",
  },
  {
    id: "VI-AUTHZ-001",
    tier: 0,
    title: "a human-only permission becomes grantable to a machine",
    file: "apps/api/src/modules/machine_identity.rs",
    find: "return Err(MachineIdentityError::CapabilityHumanOnly);",
    replace: "return Err(MachineIdentityError::CapabilityUnknown);",
    verifier: ["cargo", "machine_identity"],
    expect: "human_only",
  },
  {
    id: "VI-INF-001",
    tier: 0,
    title: "a truncated stream is allowed to complete",
    file: "apps/api/src/modules/inference.rs",
    find: "self.done && !self.invalid_response",
    replace: "true",
    verifier: ["cargo", "p09_failure_tests::a_truncated_stream"],
    expect: "completion",
  },
  {
    id: "VI-BUD-001",
    tier: 0,
    // The contract asks for "move the budget decision after dispatch". This case does
    // NOT do that: a string-replace harness cannot move a call site honestly, and a
    // mutation that reshuffles code and then fails to compile proves nothing. So it
    // tests the load-bearing half instead -- that a hard over-limit budget is
    // enforced AT ALL -- and says so, rather than claiming an ordering property it
    // does not establish. The ordering half remains UNPROVEN and is named as a
    // follow-up in the P09 gate.
    title: "a hard budget stops being enforced at all",
    file: "apps/api/src/modules/budget_p05.rs",
    find: "if policy.kind == BudgetKind::Hard\n            && (policy.limit_minor > MAX_RESERVATION_MINOR",
    replace: "if false\n            && (policy.limit_minor > MAX_RESERVATION_MINOR",
    verifier: ["cargo", "modules::budget_p05"],
    expect: "reservation_too_large",
  },
  {
    id: "VI-IDEM-001",
    tier: 0,
    // The original form of this case renamed a column in the upsert's ON CONFLICT
    // clause and expected the schema harness to notice. It did not, because the
    // harness had no case for `idempotency_records` at all -- `grep -c idempotency`
    // returned 0. A SURVIVED verdict there was correct and load-bearing: it said the
    // retry-safety substrate had no database-level proof.
    //
    // It now mutates the trigger that migration 0020 added, so it tests that the
    // proof which was written to close the gap is itself sensitive.
    title: "a completed idempotency record is allowed to hold no status again",
    file: "apps/api/migrations/0020_p09_idempotency_null_safety.sql",
    find: "WHEN NEW.state = 'completed'\n AND (\n        NEW.response_status IS NULL\n     OR NEW.response_status NOT BETWEEN 200 AND 299\n )",
    replace:
      "WHEN 0\n AND (\n        NEW.response_status IS NULL\n     OR NEW.response_status NOT BETWEEN 200 AND 299\n )",
    verifier: ["schema"],
    expect: "NO status is refused",
  },
  {
    id: "VI-MIG-001",
    tier: 1,
    title: "a terminal-state trigger stops enforcing",
    file: "apps/api/migrations/0017_p07_plugin_governance.sql",
    // Not "delete the trigger". Deleting only the `CREATE TRIGGER` line leaves
    // `BEFORE UPDATE OF ... BEGIN ... END;` as an orphan statement, the migration
    // fails to apply, and the harness reports a PARSE ERROR -- which is not the same
    // as the invariant failing to be enforced, and is how this case first came out
    // KILLED_FOR_THE_WRONG_REASON. Neutralising the WHEN clause keeps the DDL valid
    // and removes only the enforcement, which is the fault under test.
    find: "FOR EACH ROW WHEN NEW.review_state = 'blocked' AND NEW.blocked_reason IS NULL",
    replace: "FOR EACH ROW WHEN 0",
    verifier: ["schema"],
    expect: "blocked plugin install must record a reason",
  },
  {
    id: "VI-SEC-001",
    tier: 0,
    title: "an API key projection starts returning the secret hash",
    file: "apps/api/src/routes/machine_identity.rs",
    find: '"fingerprint": key.fingerprint,',
    replace: '"fingerprint": key.fingerprint,\n        "secret_hash": key.secret_hash,',
    verifier: ["cargo", "secret_canary"],
    expect: "leak",
  },
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryRun(cmd, args, cwd) {
  try {
    return { code: 0, out: run(cmd, args, cwd) };
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

console.log(
  APPLY
    ? "VI-TEST-001 mutation campaign — APPLYING in a disposable worktree\n"
    : "VI-TEST-001 mutation campaign — dry run (use --apply to mutate)\n",
);
for (const c of CASES) {
  console.log(`  ${c.id} (tier ${c.tier})  ${c.title}`);
  console.log(`      fault in  ${c.file}`);
  console.log(`      killed by ${c.verifier.join(" + ")}; reason must mention "${c.expect}"`);
}
if (!APPLY) {
  console.log("\nNothing was mutated. The cases above are the campaign.");
  process.exit(0);
}

// --- execute --------------------------------------------------------------

// Refuse to run against the MAIN checkout. `git rev-parse --git-dir` is the
// honest test: in a linked worktree it resolves to `<repo>/.git/worktrees/<name>`,
// while in the main checkout it is `<repo>/.git` itself. Comparing the script's
// own path to the cwd does NOT work, because the script is copied into the
// worktree along with everything else.
function gitDir(cwd) {
  try {
    return run("git", ["rev-parse", "--git-dir"], cwd).trim();
  } catch {
    return "";
  }
}

if (!gitDir(process.cwd()).includes("/worktrees/")) {
  console.error(
    "\nRefusing to run: --apply must be pointed at a disposable LINKED worktree,\n" +
      "not the main checkout. This script mutates code on purpose. Create one with:\n" +
      "  git worktree add /tmp/p09-verify HEAD\n" +
      "and run this script with that directory as cwd.\n" +
      `  git rev-parse --git-dir here: ${gitDir(process.cwd()) || "not a git checkout"}`,
  );
  process.exit(2);
}
console.log(`mutating a linked worktree at ${process.cwd()}\n`);

const results = [];
for (const testCase of CASES) {
  const scratch = mkdtempSync(join(tmpdir(), "p09-mutant-"));
  const label = `${testCase.id} ${testCase.title}`;
  try {
    // A cheap copy rather than a worktree per case: the tree is small enough and
    // `target/` is the only thing worth not copying.
    cpSync(process.cwd(), scratch, {
      recursive: true,
      filter: (src) =>
        !src.includes("/target/") && !src.includes("/node_modules/") && !src.includes("/.git/"),
    });
    const path = join(scratch, testCase.file);
    if (!existsSync(path)) {
      results.push({ ...testCase, verdict: "BLOCKED", detail: `${testCase.file} not found` });
      continue;
    }
    const before = readFileSync(path, "utf8");
    if (!before.includes(testCase.find)) {
      results.push({
        ...testCase,
        verdict: "BLOCKED",
        detail: `anchor not present, so the fault was never injected: "${testCase.find}"`,
      });
      continue;
    }
    writeFileSync(path, before.replace(testCase.find, testCase.replace));

    // Half one: the mutant must COMPILE. A mutation that fails to build has
    // killed nothing; it just failed to typecheck.
    const build = testCase.verifier.includes("schema")
      ? { code: 0, out: "" }
      : tryRun("cargo", ["build", "--tests", "-p", "lumi-agents-control-plane-api"], scratch);
    if (build.code !== 0) {
      results.push({
        ...testCase,
        verdict: "NOT_A_VALID_MUTATION",
        detail: "the mutant did not compile, so no verifier could have caught the fault",
      });
      continue;
    }

    // Half two: EVERY named verifier must die, and say why.
    //
    // Running only the first named verifier is a reporting bug that reads as a
    // finding: three of the four "survivors" in the first run of this campaign were
    // this line, not the system.
    const runs = [];
    for (const verifier of testCase.verifier) {
      if (verifier === "tenant_audit") {
        runs.push([
          "tenant_audit",
          tryRun(
            "cargo",
            ["test", "-p", "lumi-agents-control-plane-api", "--lib", "security::tenant_audit"],
            scratch,
          ),
        ]);
      } else if (verifier === "schema") {
        runs.push([
          "schema",
          tryRun("node", ["apps/api/scripts/p07-schema-invariants.mjs"], scratch),
        ]);
      } else if (verifier === "canary") {
        runs.push(["canary", tryRun("node", ["apps/api/scripts/p09-secret-canary.mjs"], scratch)]);
      } else if (verifier === "cargo") {
        continue; // the concrete filter is the next entry
      } else {
        const r = tryRun(
          "cargo",
          ["test", "-p", "lumi-agents-control-plane-api", "--lib", verifier],
          scratch,
        );
        // A filter that matches nothing exits 0 and looks exactly like a pass.
        // Count the tests so that failure mode is impossible to miss.
        const matched = Number((r.out.match(/test result: ok\. (\d+) passed/) ?? [])[1] ?? 0);
        if (matched === 0 && r.code === 0) {
          results.push({
            ...testCase,
            verdict: "HARNESS_FAULT",
            detail: `the filter "${verifier}" matched ZERO tests, so cargo exited 0 and it looked like a pass`,
          });
          continue;
        }
        runs.push([verifier, r]);
      }
    }
    if (results[results.length - 1]?.verdict === "HARNESS_FAULT") continue;
    // Killed if ANY named verifier dies. Requiring all of them was the second
    // reporting bug in this harness: naming the schema harness alongside the tenant
    // audit made a mutation the audit catches look like a survivor, because the
    // schema harness legitimately still passed.
    const out = runs.map(([, r]) => r.out).join("\n");
    const code = runs.some(([, r]) => r.code !== 0) ? 1 : 0;
    if (code === 0) {
      results.push({
        ...testCase,
        verdict: "SURVIVED",
        detail: `the fault is live and NO verifier noticed — this is the dangerous outcome`,
      });
      continue;
    }
    const killedForTheRightReason = out.toLowerCase().includes(testCase.expect.toLowerCase());
    results.push({
      ...testCase,
      verdict: killedForTheRightReason ? "KILLED" : "KILLED_FOR_THE_WRONG_REASON",
      detail: killedForTheRightReason
        ? "the verifier failed, and the failure names the invariant"
        : `the verifier failed but nothing mentioned "${testCase.expect}", so the kill may be incidental`,
    });
  } catch (error) {
    results.push({
      ...testCase,
      verdict: "BLOCKED",
      detail: String(error.message ?? error).slice(0, 200),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // Logged here rather than after the loop: a `continue` on the BLOCKED or
    // NOT_A_VALID_MUTATION paths jumps past a trailing log, and a verdict that is
    // computed but not printed is the same as no verdict at all.
    const last = results[results.length - 1];
    const mark = last.verdict === "KILLED" ? "✓" : "✗";
    console.log(`  ${mark} [${last.verdict}] ${testCase.id}  ${testCase.title}`);
    console.log(`      ${last.detail}`);
    console.log("");
  }
}

const killed = results.filter((r) => r.verdict === "KILLED").length;
const total = results.length;
const byVerdict = {};
for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
console.log("tally:", JSON.stringify(byVerdict));
console.log(
  `${killed}/${total} mutations were killed by the verifier that is supposed to defend them`,
);
const survivors = results.filter(
  (r) => r.verdict === "SURVIVED" || r.verdict === "KILLED_FOR_THE_WRONG_REASON",
);
if (survivors.length) {
  console.log("\nA surviving mutation means a Tier-0 claim is UNPROVEN, not PASS:");
  for (const s of survivors) console.log(`  - ${s.id}: ${s.title} (${s.verdict})`);
}
process.exit(survivors.length ? 1 : 0);
