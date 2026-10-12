#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(
  root,
  "test-results/lumi-agents",
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(output, { recursive: true });
const client = resolve(process.env.LUMI_AGENTS_DIR || join(root, "integrations/lumi-agents"));
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const evidence = { verdict: "BLOCKED", started_at: new Date().toISOString() };
const desktopMode = process.env.LUMI_INTEGRATION_DESKTOP === "1";
evidence.scope = desktopMode
  ? "adoption-account-device-plus-electron-journeys"
  : "adoption-account-device";
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  PNPM_HOME: join(root, "test-results/pnpm-tools"),
  npm_config_manage_package_manager_versions: "false",
  WRANGLER_SEND_METRICS: "false",
  LUMI_INTEGRATION_OUTPUT: output,
};
let active;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    if (active?.pid) {
      try {
        process.platform === "win32" ? active.kill(signal) : process.kill(-active.pid, signal);
      } catch {
        /* child already exited */
      }
    }
  });
async function run(command, args, cwd = root, runEnv = env) {
  if (interrupted) throw new Error("Interrupted");
  console.log(`[integration] ${command} ${args.join(" ")}`);
  await new Promise((yes, no) => {
    active = spawn(command, args, {
      cwd,
      env: runEnv,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    active.once("error", no);
    active.once("exit", (code, signal) => {
      active = undefined;
      code === 0 ? yes() : no(new Error(`${command}: ${signal || code}`));
    });
  });
}
function snapshot(cwd) {
  return {
    sha: git(cwd, "rev-parse", "HEAD"),
    dirty: git(cwd, "status", "--porcelain", "--untracked-files=normal") !== "",
    package_manager: JSON.parse(readFileSync(join(cwd, "package.json"))).packageManager,
  };
}
if (desktopMode && process.platform === "linux" && process.env.LUMI_DESKTOP_SESSION !== "1") {
  // Re-enter inside an owned headless session: private D-Bus bus, Xvfb display and an
  // isolated, unlocked gnome-keyring under this run's output. Personal sessions are never used.
  const state = join(output, "desktop-session");
  const code = await new Promise((done) => {
    const session = spawn(
      join(root, "scripts/integration/linux-desktop-session.sh"),
      [state, process.execPath, fileURLToPath(import.meta.url)],
      { stdio: "inherit", env: { ...process.env, LUMI_DESKTOP_SESSION: "1" } },
    );
    session.once("error", () => done(2));
    session.once("exit", (exitCode) => done(exitCode ?? 2));
  });
  rmSync(state, { recursive: true, force: true });
  process.exit(code);
}
try {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node.js 24");
  if (!process.env.LUMI_AGENTS_DIR && !existsSync(join(client, "package.json")))
    await run("git", ["submodule", "update", "--init", "--", "integrations/lumi-agents"]);
  evidence.control_plane = snapshot(root);
  evidence.lumi_agents = snapshot(client);
  evidence.pinned_lumi_agents_sha = git(
    root,
    "ls-files",
    "--stage",
    "integrations/lumi-agents",
  ).split(/\s+/)[1];
  evidence.override = Boolean(process.env.LUMI_AGENTS_DIR);
  evidence.reproducible = !evidence.control_plane.dirty && !evidence.lumi_agents.dirty;
  if (!evidence.override && evidence.lumi_agents.sha !== evidence.pinned_lumi_agents_sha)
    throw new Error(
      "Client HEAD differs from gitlink; preserve edits and select the pin deliberately",
    );
  if (process.env.CI && (!evidence.reproducible || evidence.override))
    throw new Error("CI requires clean sources and committed pin");
  console.log(JSON.stringify(evidence, null, 2));
  async function pnpmFor(repo) {
    const pin = JSON.parse(readFileSync(join(repo, "package.json"))).packageManager;
    if (!/^pnpm@\d+\.\d+\.\d+$/.test(pin)) throw new Error("Expected an exact pnpm version");
    const tool = join(root, "test-results/pnpm-tools", pin.slice(5));
    const bin = join(
      tool,
      "node_modules/pnpm/bin",
      Number(pin.slice(5).split(".")[0]) >= 11 ? "pnpm.mjs" : "pnpm.cjs",
    );
    if (!existsSync(bin))
      await run("npm", [
        "install",
        "--prefix",
        tool,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        pin,
      ]);
    const actual = execFileSync(process.execPath, [bin, "--version"], {
      cwd: repo,
      env,
      encoding: "utf8",
    }).trim();
    if (actual !== pin.slice(5)) throw new Error("Pinned pnpm verification failed");
    const pinnedEnv = {
      ...env,
      // Nested build scripts also invoke pnpm. Keep each repo's own exact
      // binary first, rather than falling back to the host's global version.
      PATH: `${join(tool, "node_modules/.bin")}${delimiter}${env.PATH}`,
    };
    return (args, overrides = {}) =>
      run(process.execPath, [bin, ...args], repo, { ...pinnedEnv, ...overrides });
  }
  const rootPnpm = await pnpmFor(root);
  const clientPnpm = await pnpmFor(client);
  const offlineArgs = process.env.LUMI_INTEGRATION_OFFLINE === "1" ? ["--offline"] : [];
  await rootPnpm(["install", "--frozen-lockfile", ...offlineArgs]);
  if (desktopMode) {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error(
        "Desktop runner requires macOS or Linux native runtime, display and keystore",
      );
    // The actual desktop requires its native/Electron install hooks. A failed
    // hook stays BLOCKED; the contract-only runner intentionally omits them.
    // Enable only the client's own `allowBuilds` hooks, even where a user-level
    // pnpm config disables lifecycle scripts, and let pnpm replace the module
    // gate's isolated layout without an interactive prompt.
    await clientPnpm([
      "install",
      "--frozen-lockfile",
      "--config.ignore-scripts=false",
      "--config.confirm-modules-purge=false",
      ...offlineArgs,
    ]);
  } else {
    // The module gate consumes only this dependency closure. pnpm 10's hoisted
    // linker can race while copying nested esbuild paths (pnpm/pnpm#12880,
    // #13627). Isolated linking avoids that path; desktop keeps its own layout.
    await clientPnpm([
      "--filter",
      "@zcode/contracts...",
      "--filter",
      "@zcode/services...",
      "install",
      "--config.node-linker=isolated",
      "--frozen-lockfile",
      "--ignore-scripts",
      ...offlineArgs,
    ]);
  }
  await rootPnpm(["build"]);
  if (desktopMode) {
    await clientPnpm(["--filter", "@zcode/desktop", "prepare:runtime-assets"], {
      // Local Electron gate needs current-host assets; cross-platform remote
      // release archives have their own compatibility/runtime campaign.
      ZCODE_SKIP_REMOTE_ASSETS: "1",
    });
    await clientPnpm(["--filter", "@zcode/desktop", "build:no-runtime-assets"]);
    // Electron 44 has no postinstall: its package downloads the pinned binary lazily when its
    // path is first resolved. Resolve it here through the package's own API, then verify.
    const electronPath = execFileSync(process.execPath, ["-p", "require('electron')"], {
      cwd: client,
      env,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .at(-1); // a first-time download prints a progress line before the path
    if (!existsSync(electronPath))
      throw new Error(`Pinned Electron binary missing: ${electronPath}`);
    evidence.electron_binary = electronPath.slice(client.length + 1);
  }
  const requireWeb = createRequire(join(root, "apps/web/package.json"));
  const { build } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
  await build({
    configFile: false,
    root: client,
    logLevel: "warn",
    ssr: { noExternal: true },
    build: {
      ssr: join(client, "apps/zcode-cli/packages/contracts/src/p08-migration-adoption.ts"),
      outDir: join(output, "client"),
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { entryFileNames: "adoption.mjs" } },
    },
  });
  env.LUMI_INTEGRATION_CLIENT_BUNDLE = join(output, "client/adoption.mjs");
  env.LUMI_INTEGRATION_APP_VERSION = JSON.parse(readFileSync(join(client, "package.json"))).version;
  evidence.stage = "runtime";
  try {
    await run(process.execPath, [join(root, "tests/integration/adoption.mjs")]);
  } catch (error) {
    const report = join(output, "journey.json");
    if (existsSync(report) && JSON.parse(readFileSync(report)).verdict === "BLOCKED")
      evidence.stage = "setup";
    throw error;
  }
  const result = JSON.parse(readFileSync(join(output, "journey.json")));
  if (result.verdict !== "PASS" || !result.assertions.length)
    throw new Error("Missing adoption runtime PASS");
  env.LUMI_ACCOUNT_REPORT = join(output, "account-report.json");
  await run(process.execPath, [join(root, "tests/integration/lumi-account.mjs")]);
  const accountResult = JSON.parse(readFileSync(env.LUMI_ACCOUNT_REPORT, "utf8"));
  if (
    accountResult.verdict !== "PASS" ||
    !accountResult.assertions.length ||
    accountResult.control_plane_sha !== evidence.control_plane.sha ||
    accountResult.lumi_agents_sha !== evidence.lumi_agents.sha
  )
    throw new Error("Missing exact-head account/device runtime PASS");
  evidence.account_integration = accountResult;
  if (desktopMode) {
    // Every actual-Electron journey runs, even after a failure, so one run preserves all evidence.
    // Each must PASS for exactly this source pair; the selected scope is recorded, never widened.
    const journeys = [
      ["account", "desktop-account-electron.mjs", "LUMI_ELECTRON_REPORT"],
      ["account-failures", "desktop-account-failures-electron.mjs", "LUMI_ACCOUNT_FAILURES_REPORT"],
      ["revocation", "desktop-revocation-electron.mjs", "LUMI_REVOCATION_REPORT"],
      ["managed-faults", "desktop-managed-faults-electron.mjs", "LUMI_FAULTS_REPORT"],
      ["adoption-policy", "desktop-adoption-policy-electron.mjs", "LUMI_ADOPTION_REPORT"],
      ["multi-org", "desktop-multi-org-electron.mjs", "LUMI_MULTI_ORG_REPORT"],
      [
        "local-preservation",
        "desktop-automation-local-preservation.mjs",
        "LUMI_LOCAL_PRESERVATION_REPORT",
      ],
      ["automation", "desktop-automation-electron.mjs", "LUMI_AUTOMATION_REPORT"],
    ];
    const selected = process.env.LUMI_DESKTOP_JOURNEYS?.split(",").filter(Boolean);
    evidence.desktop_scope = selected ?? journeys.map(([name]) => name);
    evidence.desktop_integration = {};
    const failures = [];
    for (const [name, file, reportVar] of journeys) {
      if (selected && !selected.includes(name)) continue;
      const report = join(output, `electron-${name}.json`);
      env[reportVar] = report;
      try {
        await run(process.execPath, [join(root, "tests/integration", file)]);
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
      const result = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined;
      const parentSha = result?.control_plane_sha ?? result?.provenance?.parentHead;
      const clientSha = result?.lumi_agents_sha ?? result?.provenance?.clientHead;
      evidence.desktop_integration[name] = result ?? { verdict: "MISSING" };
      if (
        result?.verdict !== "PASS" ||
        parentSha !== evidence.control_plane.sha ||
        clientSha !== evidence.lumi_agents.sha
      )
        failures.push(`${name}: verdict ${result?.verdict ?? "missing"} for the exact pair`);
    }
    if (selected) evidence.scope += `; desktop journeys limited to ${selected.join(",")}`;
    if (failures.length) throw new Error(`Desktop journeys failed: ${failures.join("; ")}`);
  }
  for (const [path, before] of [
    [root, evidence.control_plane],
    [client, evidence.lumi_agents],
  ]) {
    const after = snapshot(path);
    if (before.sha !== after.sha || (!before.dirty && after.dirty))
      throw new Error("Sources changed during run");
  }
  evidence.verdict = "PASS";
  evidence.assertions = result.assertions;
} catch (error) {
  evidence.verdict = evidence.stage === "runtime" ? "FAIL" : "BLOCKED";
  evidence.error = error.message;
  process.exitCode = evidence.verdict === "FAIL" ? 1 : 2;
  console.error(`${evidence.verdict}: ${error.message}`);
} finally {
  evidence.completed_at = new Date().toISOString();
  writeFileSync(join(output, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`${evidence.verdict}: ${join(output, "result.json")}`);
}
