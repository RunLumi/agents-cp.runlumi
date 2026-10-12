// Journey D browser use through the ACTUAL Electron app (Main -> Host -> Agent -> node_repl MCP ->
// in-app browser) against a fresh Worker/D1, with a synthetic isolated profile. The development
// mock model calls the shipped Browser Use tool `mcp__node_repl__js` with a fixed snippet (the
// documented bootstrap + one navigation) to a disposable loopback page that counts hits; each
// stage has its own page path, so the effect is graded on hits and D1, never on status codes:
//   1. agent control: the agent definition does not allow the tool -> refused, 0 hits;
//   2. managed session: the org reviewed the exact runtime descriptor (derived by the real Core
//      MCP adapter from the node_repl bundle this build ships), approved the node_repl server,
//      allowed the tool and the 127.0.0.1 domain; the MCP risk floor requires per-use approval;
//      after the org approves, the call is claimed and runs, but its browser command has no
//      managed decision and is refused by the agent broker (fail closed, P05-CR-005) -> 0 hits;
//   3. browser policy: the tool stays allowed and the call is approved, but the org's browser
//      policy blocks 127.0.0.1 (FR-F13-005 allowed/blocked domains) -> the page is not hit;
//   4. approval denied: the org denies the per-use approval -> 0 hits, never claimed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { createDesktopApp } from "./lib/lumi-desktop-app.mjs";
import { onboardToManagedPolicy, startApprovalWeb } from "./lib/lumi-desktop-onboarding.mjs";
import { provisionOrganization } from "./lib/lumi-org-fixture.mjs";
import { readRowsWithRetry } from "./lib/automation-journey-state.mjs";
import { submitManagedTurn } from "./lib/lumi-managed-turn.mjs";
import {
  BROWSER_POLICY,
  buildMcpIdentity,
  provisionMcpPlane,
  putToolPolicy,
} from "./lib/mcp-tool-flow.mjs";

const TOOL_ALIAS = "coding-tools";
const JS_TOOL = "mcp__node_repl__js";
/** The agent broker's managed refusal, as the mock reports the tool result back. */
const MANAGED_BROWSER_REFUSAL = /not authorized to run managed browser actions|policy_denied/;
const TERMINAL = ["succeeded", "failed", "cancelled"];
const root = resolve(import.meta.dirname, "../..");
const client = join(root, "integrations/lumi-agents");
const desktop = join(client, "packages/desktop");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
const probe = new SmokeHarness({ name: "Electron managed browser use" });
const profile = await mkdtemp(join(tmpdir(), "lumi-browser-"));
const evidence = join(profile, "evidence");
const workspacePath = join(profile, "workspace");
mkdirSync(evidence, { recursive: true });
mkdirSync(workspacePath, { recursive: true });
const assertions = [];
const claims = {};
const pass = (claim) => {
  assertions.push(claim);
  console.log(`PASS ${claim}`);
};
let app;
let web;
let pageServer;
let stage = "setup";
let completed = false;
const observations = { stages: {} };
process.on("exit", () => probe.cleanup());
const rows = (sql, label) => readRowsWithRetry(probe, sql, label);

/** The user's local permission layer: answer "Allow only this time" whenever it is shown. */
async function answerLocalPrompt(page) {
  const choice = await page.evaluate(() => {
    const allow = [...document.querySelectorAll("button")].find(
      (button) =>
        /^1\.\s*Allow\s*\n\s*Allow only this time/.test(button.innerText.trim()) &&
        !button.disabled,
    );
    allow?.click();
    return !!allow;
  });
  if (!choice) return false;
  await delay(400);
  return page.evaluate(() => {
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.innerText.trim() === "Confirm" && !button.disabled,
    );
    confirm?.click();
    return !!confirm;
  });
}

try {
  await probe.setup({ persistEnvVar: "DE2E_BROWSER_PERSIST" });
  const fixtureOrg = await provisionOrganization(probe, {
    extraRoutes: [
      {
        alias: TOOL_ALIAS,
        adapterEndpoint: "mock://lumi-tool",
        providerModelId: "mock-tool",
        key: "tool",
        timeoutMs: 5_000,
      },
    ],
  });
  const { fixture, org, projectId } = fixtureOrg;
  const hits = [];
  pageServer = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "text/html" }).end("<title>Lumi fixture</title>ok");
  });
  await new Promise((done) => pageServer.listen(0, "127.0.0.1", done));
  const pageUrl = (label) =>
    `http://127.0.0.1:${pageServer.address().port}/lumi-e2e-browser-${probe.nonce}-${label}`;
  const hitsFor = (label) => hits.filter((path) => path === new URL(pageUrl(label)).pathname);

  // Identity of the shipped Browser Use tool, derived by the real Core MCP adapter (listTools
  // only) from the node_repl server bundle this desktop build ships.
  const glm = join(
    desktop,
    "bundled-agents",
    `${process.platform}-${process.arch}`,
    "glm/packages",
  );
  const { identity } = await buildMcpIdentity({
    root,
    outDir: join(evidence, "js-tool-identity"),
    serverName: "node_repl",
    config: {
      type: "stdio",
      command: process.execPath,
      args: [join(glm, "node-repl-host/dist/mcp/server.js")],
      cwd: workspacePath,
      env: { ZCODE_PLUGIN_ROOT: join(glm, "browser-use-plugin") },
      timeoutMs: 60_000,
    },
    toolModelName: JS_TOOL,
    stableName: "mcp:node_repl:js",
    stringProperties: ["code", "title"],
  });
  assert.equal(hits.length, 0, "identity derivation never runs the tool");
  observations.identity = identity;

  // The org reviews the exact descriptor, approves the node_repl server and allows the tool and
  // the 127.0.0.1 domain before the device enrolls: a tool policy change reaches a device's
  // published policy snapshot only at its next snapshot refresh (enrollment, token refresh,
  // binding or budget change), and the snapshot can only narrow the authoritative document.
  const plane = await provisionMcpPlane({
    probe,
    fixture,
    orgId: org.orgId,
    projectId,
    identity,
    script: "server.js",
    agentName: "Electron managed browser agent",
  });
  observations.plane = plane;
  const allowBrowser = { ...BROWSER_POLICY, allowed_domains: ["127.0.0.1"] };
  await putToolPolicy({
    probe,
    fixture,
    orgId: org.orgId,
    toolId: plane.toolId,
    mcpId: plane.mcpId,
    mode: "allow",
    label: "browser-allow",
    browser: allowBrowser,
  });
  web = await startApprovalWeb({ root, probe });
  app = createDesktopApp({ binary, desktop, probe, profile, workspacePath, name: "browser" });
  stage = "runtime";
  await app.start();
  const { deviceId } = await onboardToManagedPolicy({
    app,
    probe,
    web,
    org,
    projectId,
    email: fixtureOrg.email,
    password: fixtureOrg.password,
  });
  const page = app.page;

  const pendingApprovals = async (runId) => {
    const result = await probe.request(
      fixture,
      "GET",
      `/api/v1/orgs/${org.orgId}/approvals?status=pending&run_id=${runId}`,
    );
    probe.expectStatus("list pending browser approvals", result, 200);
    return result.payload?.items ?? result.payload?.data ?? [];
  };
  const knownRuns = new Set();
  /** One managed browser turn; `decide` resolves each pending org approval. */
  async function browserTurn(label, agentId, decide) {
    await submitManagedTurn(page, {
      agentId,
      alias: TOOL_ALIAS,
      prompt: `Open the fixture page (${label}). lumi-mock-call:${JS_TOOL} lumi-mock-url:${pageUrl(label)} then report.`,
    });
    const record = { localAllows: 0, approvals: [] };
    let runId;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (await answerLocalPrompt(page).catch(() => false)) record.localAllows += 1;
      if (!runId) {
        const found = await rows(
          `SELECT run_id FROM runs WHERE org_id = '${org.orgId}' ORDER BY created_at DESC`,
          "browser run starts",
        );
        runId = found.find((row) => !knownRuns.has(row.run_id))?.run_id;
        if (runId) knownRuns.add(runId);
      }
      if (runId) {
        for (const item of await pendingApprovals(runId)) {
          record.approvals.push({
            tool_id: item.tool_id,
            risk: item.risk_class,
            mode: item.approval_mode,
          });
          record.hitsWhilePending = hitsFor(label).length;
          const decision = decide(item);
          const resolved = await probe.request(
            fixture,
            "POST",
            `/api/v1/orgs/${org.orgId}/approvals/${item.id}/resolve`,
            { decision, version: item.version },
            probe.browserMutation(fixture, `browser-${label}-${item.id}`),
          );
          probe.expectStatus(`org ${decision} browser approval (${label})`, resolved, 200);
        }
        const [run] = await rows(`SELECT state FROM runs WHERE run_id = '${runId}'`, "run state");
        if (TERMINAL.includes(run?.state)) {
          record.state = run.state;
          break;
        }
      }
      await delay(700);
    }
    assert.ok(record.state, `${label}: run reached a terminal state`);
    await delay(1_500);
    record.runId = runId;
    record.hits = hitsFor(label).length;
    record.calls = await rows(
      `SELECT tool_id, risk_class, status, execution_started_at, execution_device_id FROM tool_call_refs WHERE run_id = '${runId}'`,
      "browser tool calls",
    );
    record.audit = (
      await rows(
        `SELECT action, reason FROM security_events WHERE run_id = '${runId}' AND action LIKE 'tool.%' ORDER BY created_at, rowid`,
        "browser tool audit",
      )
    ).map((row) => (row.reason ? `${row.action}:${row.reason}` : row.action));
    record.screen = await page.evaluate(() =>
      document.body.innerText.match(/Result: [^\n]+/g)?.at(-1),
    );
    await page.screenshot(join(evidence, `browser-${label}.png`));
    observations.stages[label] = record;
    return record;
  }

  // 1. Agent control: the fixture's default agent is not allowed to use the reviewed tool.
  const notAllowed = await browserTurn("agent-not-allowed", fixtureOrg.agentId, () => "denied");
  assert.equal(notAllowed.hits, 0, "a tool outside the agent allowlist never reaches the page");
  assert.ok(
    notAllowed.calls.every((call) => !call.execution_started_at),
    "a call outside the agent allowlist is never claimed",
  );
  assert.match(notAllowed.screen ?? "", /denied/);
  claims.agent_not_allowed = "PASS";
  pass(
    `agent control: ${JS_TOOL} outside the agent allowlist refused before execution (${notAllowed.screen}), 0 page hits, run ${notAllowed.state}`,
  );

  // 2. Approved call in a managed session. The org reviewed, allowed and approved the tool and
  //    the 127.0.0.1 domain, so the `js` call itself is claimed and executes; its browser command
  //    carries no managed decision yet (P05-CR-005 steps 2-3), so the agent broker refuses it
  //    (fail closed, step 1) and the page is never visited. Before that fix this exact stage
  //    visited the page once: the positive control showing the refusal is the gate's, not a
  //    broken browser path, is the result recorded for LumiAgents f3d31d55 in the evidence run.
  const allowed = await browserTurn("allow", plane.agentId, () => "approved");
  assert.equal(allowed.approvals.length, 1, "one per-use org approval (MCP risk floor)");
  assert.equal(allowed.approvals[0].tool_id, plane.toolId);
  assert.equal(allowed.hitsWhilePending, 0, "no page hit while the approval is pending");
  assert.equal(allowed.state, "succeeded");
  assert.equal(allowed.calls.length, 1);
  assert.equal(allowed.calls[0].status, "completed", "the approved js call executed");
  assert.equal(allowed.calls[0].execution_device_id, deviceId, "claimed by this device");
  assert.equal(allowed.hits, 0, "a managed browser command without a decision never navigates");
  assert.match(allowed.screen ?? "", MANAGED_BROWSER_REFUSAL, "refused by the managed gate");
  claims.managed_browser_fail_closed = "PASS";
  claims.managed_browser_capability = "UNAVAILABLE (P05-CR-005 steps 2-3)";
  pass(
    `managed session: reviewed ${identity.name} (fingerprint ${identity.fingerprint.slice(0, 12)}) allowed, org-approved per use and claimed by ${deviceId}; its browser command is refused by the agent broker (${allowed.screen}) -> 0 page hits, audit ${JSON.stringify(allowed.audit)}`,
  );

  // 3. Browser policy blocks the domain; the tool itself stays allowed and approved.
  await putToolPolicy({
    probe,
    fixture,
    orgId: org.orgId,
    toolId: plane.toolId,
    mcpId: plane.mcpId,
    mode: "allow",
    label: "browser-domain-blocked",
    browser: { ...BROWSER_POLICY, allowed_domains: [], blocked_domains: ["127.0.0.1"] },
  });
  const blocked = await browserTurn("domain-blocked", plane.agentId, () => "approved");
  assert.equal(blocked.hits, 0, "an org-blocked domain is never visited");
  assert.match(blocked.screen ?? "", MANAGED_BROWSER_REFUSAL);
  claims.domain_policy_bypass = "PASS";
  pass(
    `browser policy: with the tool approved and 127.0.0.1 blocked, the page is not visited (${blocked.screen})`,
  );

  // 4. Approval denied.
  await putToolPolicy({
    probe,
    fixture,
    orgId: org.orgId,
    toolId: plane.toolId,
    mcpId: plane.mcpId,
    mode: "allow",
    label: "browser-allow-again",
    browser: allowBrowser,
  });
  const deniedApproval = await browserTurn("approval-denied", plane.agentId, () => "denied");
  assert.equal(deniedApproval.approvals.length, 1, "the call waited for the org");
  assert.equal(deniedApproval.hits, 0, "a denied approval never reaches the page");
  assert.ok(
    deniedApproval.calls.every((call) => !call.execution_started_at),
    "never claimed",
  );
  claims.approval_denied = "PASS";
  pass(
    `approval denied: the org denied the per-use approval -> 0 page hits, never claimed (${deniedApproval.screen})`,
  );

  assert.equal(probe.failures.length, 0);
  completed = true;
} catch (error) {
  console.error(`FAIL ${error?.stack ?? error}`);
  await app?.page?.screenshot(join(evidence, "failure.png")).catch(() => {});
  process.exitCode = stage === "runtime" ? 1 : 2;
} finally {
  writeFileSync(join(evidence, "app.log"), probe.redact(app?.log ?? ""));
  await app?.stop();
  await web?.close();
  pageServer?.close();
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const report = {
    verdict: completed ? "PASS" : stage === "runtime" ? "FAIL" : "BLOCKED",
    scope: "journey-d-browser-use",
    control_plane_sha: git(root, "rev-parse", "HEAD"),
    lumi_agents_sha: git(client, "rev-parse", "HEAD"),
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    claims,
    desktop_assertions: assertions,
    worker_assertions: probe.passes,
    observations,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_BROWSER_REPORT)
    writeFileSync(process.env.LUMI_BROWSER_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
