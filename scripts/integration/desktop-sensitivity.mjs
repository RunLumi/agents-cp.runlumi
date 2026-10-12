#!/usr/bin/env node
// Sensitivity campaign for the paired desktop gate: show that each load-bearing boundary's verifier
// fails, for the intended reason, when that boundary is faulted. Every fault runs in a DISPOSABLE
// worktree of the committed HEAD (never the shared checkout); the edit must match exactly once and
// keep SQL/bind/type shapes valid. A fault whose anchor is missing, whose build or setup fails, or
// whose journey fails for another reason is INVALID, never "detected". Baseline (positive control)
// for every journey is the unfaulted desktop gate on the same pair.
//
//   node scripts/integration/desktop-sensitivity.mjs [fault-id ...]
//
// Prerequisites: the desktop gate has run in this checkout (client installed and built, Electron
// resolved, `test-results/lumi-agents/<run>/client/adoption.mjs` bundled). Linux runs each journey
// inside `linux-desktop-session.sh`.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mainClient = join(root, "integrations/lumi-agents");
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const stamp = new Date().toISOString().replaceAll(":", "-");
const output = join(root, "test-results/sensitivity", stamp);
mkdirSync(output, { recursive: true });
const pnpmBin = (version) => join(root, "test-results/pnpm-tools", version, "node_modules/.bin");

/** Each fault: where, exactly what changes, which journey must catch it, and why. */
const FAULTS = [
  {
    id: "S1-tenant-scope",
    boundary: "tenant scope of P08 adoption rollback",
    repo: "parent",
    edits: [
      {
        file: "apps/api/src/repositories/migration.rs",
        find: '     WHERE adoption_state_id = ?1 AND org_id = ?2";\n\nconst SELECT_ADOPTION_BY_EXTERNAL_SQL',
        replace:
          '     WHERE adoption_state_id = ?1 AND (org_id = ?2 OR 1 = 1)";\n\nconst SELECT_ADOPTION_BY_EXTERNAL_SQL',
      },
      {
        file: "apps/api/src/repositories/migration.rs",
        find: '     WHERE adoption_state_id = ?3 AND org_id = ?4 AND version = ?5";',
        replace: '     WHERE adoption_state_id = ?3 AND (org_id = ?4 OR 1 = 1) AND version = ?5";',
      },
    ],
    journey: "adoption",
    expect: /FAIL\s+foreign (organization rollback refused|rollback leaves row identical)/,
  },
  {
    id: "S2-revocation",
    boundary: "device revocation (token removal and status checks)",
    repo: "parent",
    edits: [
      {
        file: "apps/api/src/repositories/devices.rs",
        find: "DELETE FROM device_tokens WHERE device_id = ?1\n",
        replace: "DELETE FROM device_tokens WHERE device_id = ?1 AND 0 = 1\n",
      },
      {
        file: "apps/api/src/routes/authorization.rs",
        find: '    if device.status != "active" {',
        replace: '    if device.status != "active" && device.status != "revoked" {',
      },
      {
        file: "apps/api/src/routes/devices.rs",
        find: "    if DeviceStatus::parse(&device.status) == Some(DeviceStatus::Revoked) {",
        replace:
          "    if false && DeviceStatus::parse(&device.status) == Some(DeviceStatus::Revoked) {",
      },
    ],
    journey: "revocation",
    expect:
      /revoked seam must refuse|no run created after revocation|no inference request after revocation/,
  },
  {
    id: "S3-tool-denial",
    boundary: "managed tool deny enforced by the desktop host",
    repo: "client",
    edits: [
      {
        file: "packages/desktop/src/main/lumiManagedToolAdmission.ts",
        find: "    assertManagedRunLeaseCurrent(lease, ports.lease(params.context.runId));\n    return result;\n  };",
        replace:
          '    assertManagedRunLeaseCurrent(lease, ports.lease(params.context.runId));\n    return result.decision === "deny" ? { ...result, decision: "allow" as const } : result;\n  };',
      },
    ],
    journey: "account",
    expect: /denial leaves the file untouched|a denied call is never claimed/,
  },
  {
    id: "S4-budget-settlement",
    boundary: "reservation release when a managed request fails or is cancelled",
    repo: "parent",
    edits: [
      {
        file: "apps/api/src/repositories/ai.rs",
        find: "SET committed_minor = ?3, status = ?4, updated_at = ?5\nWHERE reservation_id = ?1 AND org_id = ?2 AND request_id = ?6 AND status = 'reserved'",
        replace:
          "SET committed_minor = ?3, status = CASE WHEN ?4 = 'released' THEN status ELSE ?4 END, updated_at = ?5\nWHERE reservation_id = ?1 AND org_id = ?2 AND request_id = ?6 AND status = 'reserved'",
      },
    ],
    journey: "managed-faults",
    expect: /reservation settled|no budget reservation remains reserved|status = 'reserved'/,
  },
  {
    id: "S5-local-preservation",
    boundary: "local scheduler never runs an adopted original",
    repo: "client",
    edits: [
      {
        file: "packages/services/src/session/automationRepo.ts",
        find: "          WHERE enabled = 1 AND running = 0\n            AND ${NOT_MANAGED_ADOPTED_SQL}\n",
        replace: "          WHERE enabled = 1 AND running = 0\n            AND 1 = 1\n",
      },
    ],
    journey: "local-preservation",
    expect: /adopted original|not claimed|byte-identical|no run history/,
  },
];

const JOURNEYS = {
  adoption: { file: "adoption.mjs", report: "LUMI_INTEGRATION_OUTPUT", reportFile: "journey.json" },
  account: { file: "desktop-account-electron.mjs", report: "LUMI_ELECTRON_REPORT" },
  revocation: { file: "desktop-revocation-electron.mjs", report: "LUMI_REVOCATION_REPORT" },
  "managed-faults": { file: "desktop-managed-faults-electron.mjs", report: "LUMI_FAULTS_REPORT" },
  "local-preservation": {
    file: "desktop-automation-local-preservation.mjs",
    report: "LUMI_LOCAL_PRESERVATION_REPORT",
  },
};

function run(command, args, cwd, env, logFile) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", (d) => (log += d));
    child.once("exit", (code) => {
      if (logFile) writeFileSync(logFile, log);
      done({ code, log });
    });
    child.once("error", (error) => done({ code: -1, log: String(error) }));
  });
}

function applyEdits(base, edits) {
  for (const edit of edits) {
    const path = join(base, edit.file);
    const text = readFileSync(path, "utf8");
    const count = text.split(edit.find).length - 1;
    if (count !== 1) return `anchor matched ${count} times in ${edit.file}`;
    writeFileSync(path, text.replace(edit.find, edit.replace));
  }
  return null;
}

const latestBundle = () => {
  const runs = join(root, "test-results/lumi-agents");
  const found = readdirSync(runs)
    .sort()
    .reverse()
    .map((dir) => join(runs, dir, "client/adoption.mjs"))
    .find(existsSync);
  if (!found) throw new Error("run the integration gate first: no client adoption bundle");
  return found;
};

const parentSha = git(root, "rev-parse", "HEAD");
const clientSha = git(mainClient, "rev-parse", "HEAD");
const sourceStatus = () => [
  git(root, "status", "--porcelain"),
  git(mainClient, "status", "--porcelain"),
];
const statusBefore = sourceStatus();
const selected = process.argv.slice(2);
const results = [];
const baseEnv = {
  ...process.env,
  PATH: [dirname(process.execPath), pnpmBin("12.5.1"), process.env.PATH].join(delimiter),
  WRANGLER_SEND_METRICS: "false",
  // Same tool home/store as the integration gate, so a worktree install reuses its cache.
  PNPM_HOME: join(root, "test-results/pnpm-tools"),
  npm_config_manage_package_manager_versions: "false",
};

for (const fault of FAULTS) {
  if (selected.length && !selected.includes(fault.id)) continue;
  const dir = join(output, fault.id);
  const wt = join(dir, "parent");
  mkdirSync(dir, { recursive: true });
  const result = { id: fault.id, boundary: fault.boundary, journey: fault.journey };
  const cleanups = [];
  try {
    git(root, "worktree", "add", "--detach", wt, parentSha);
    cleanups.push(() => git(root, "worktree", "remove", "--force", wt));
    const childPath = join(wt, "integrations/lumi-agents");
    if (fault.repo === "client") {
      execFileSync("rmdir", [childPath]);
      git(mainClient, "worktree", "add", "--detach", childPath, clientSha);
      cleanups.unshift(() => git(mainClient, "worktree", "remove", "--force", childPath));
    } else {
      // Parent-only fault: the unchanged, already built client at the recorded SHA is reused read-only.
      execFileSync("rmdir", [childPath]);
      symlinkSync(mainClient, childPath);
    }
    const install = await run(
      join(pnpmBin("12.5.1"), "pnpm"),
      ["install", "--frozen-lockfile"],
      wt,
      baseEnv,
      join(dir, "parent-install.log"),
    );
    if (install.code !== 0) throw new Error("INVALID: parent install failed");
    const anchor = applyEdits(fault.repo === "client" ? childPath : wt, fault.edits);
    if (anchor) throw new Error(`INVALID: ${anchor}`);
    result.diff = git(fault.repo === "client" ? childPath : wt, "diff", "--stat");
    if (fault.repo === "client") {
      const clientEnv = {
        ...baseEnv,
        CI: "true",
        PATH: [dirname(process.execPath), pnpmBin("10.33.2"), process.env.PATH].join(delimiter),
        ZCODE_SKIP_REMOTE_ASSETS: "1",
      };
      for (const [label, args] of [
        ["client-install", ["install", "--frozen-lockfile", "--config.ignore-scripts=false"]],
        ["client-assets", ["--filter", "@zcode/desktop", "prepare:runtime-assets"]],
        ["client-build", ["--filter", "@zcode/desktop", "build:no-runtime-assets"]],
      ]) {
        const step = await run(
          join(pnpmBin("10.33.2"), "pnpm"),
          args,
          childPath,
          clientEnv,
          join(dir, `${label}.log`),
        );
        if (step.code !== 0)
          throw new Error(`INVALID: ${label} failed (build failure is not detection)`);
      }
      const electron = await run(
        process.execPath,
        ["-p", "require('electron')"],
        childPath,
        clientEnv,
      );
      if (!existsSync(electron.log.trim().split("\n").at(-1)))
        throw new Error("INVALID: Electron binary unavailable");
    }
    const journey = JOURNEYS[fault.journey];
    const report = join(dir, "report.json");
    const env = { ...baseEnv };
    if (fault.journey === "adoption") {
      mkdirSync(join(dir, "adoption"), { recursive: true });
      env.LUMI_INTEGRATION_OUTPUT = join(dir, "adoption");
      env.LUMI_INTEGRATION_CLIENT_BUNDLE = latestBundle();
      env.LUMI_INTEGRATION_APP_VERSION = JSON.parse(
        readFileSync(join(mainClient, "package.json"), "utf8"),
      ).version;
    } else env[journey.report] = report;
    const script = join(wt, "tests/integration", journey.file);
    const command =
      process.platform === "linux" && fault.journey !== "adoption"
        ? [
            join(wt, "scripts/integration/linux-desktop-session.sh"),
            [join(dir, "session"), process.execPath, script],
          ]
        : [process.execPath, [script]];
    const outcome = await run(command[0], command[1], wt, env, join(dir, "journey.log"));
    const reportPath =
      fault.journey === "adoption" ? join(dir, "adoption", journey.reportFile) : report;
    const verdict = existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, "utf8")).verdict
      : undefined;
    result.exit = outcome.code;
    result.journey_verdict = verdict ?? "MISSING";
    result.reason_excerpt = (outcome.log.match(
      new RegExp(`.{0,160}${fault.expect.source}.{0,160}`),
    ) ?? [])[0];
    if (verdict === "PASS") result.verdict = "UNDETECTED";
    else if (verdict === "FAIL" && fault.expect.test(outcome.log)) result.verdict = "DETECTED";
    else result.verdict = "INVALID";
    if (result.verdict === "INVALID")
      result.detail = `journey ${verdict ?? "missing report"} without the intended reason (see journey.log)`;
  } catch (error) {
    result.verdict = "INVALID";
    result.detail = error.message;
  } finally {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        result.cleanup_error = error.message;
      }
    }
  }
  results.push(result);
  console.log(`${result.verdict} ${fault.id}: ${result.detail ?? result.reason_excerpt ?? ""}`);
}

const statusAfter = sourceStatus();
const summary = {
  control_plane_sha: parentSha,
  lumi_agents_sha: clientSha,
  shared_checkout_unchanged: JSON.stringify(statusBefore) === JSON.stringify(statusAfter),
  results,
};
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`Sensitivity summary: ${join(output, "summary.json")}`);
process.exitCode =
  summary.shared_checkout_unchanged && results.every((r) => r.verdict === "DETECTED") ? 0 : 1;
