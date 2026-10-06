#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
async function run(command, args, cwd = root) {
  if (interrupted) throw new Error("Interrupted");
  console.log(`[integration] ${command} ${args.join(" ")}`);
  await new Promise((yes, no) => {
    active = spawn(command, args, {
      cwd,
      env,
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
    return (args) => run(process.execPath, [bin, ...args], repo);
  }
  const rootPnpm = await pnpmFor(root);
  const clientPnpm = await pnpmFor(client);
  await rootPnpm(["install", "--frozen-lockfile"]);
  await clientPnpm([
    "--filter",
    "@zcode/contracts...",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
  await rootPnpm(["build"]);
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
    throw new Error("Missing runtime PASS");
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
