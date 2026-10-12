// Journey D (MCP / browser / computer use) through the ACTUAL Electron app (Main -> Host -> Agent)
// against a fresh Worker/D1, with a synthetic isolated profile. Proves, each claim only after its
// positive control, graded on the MCP effect file and D1 (never on status codes alone):
//   1. a benign stdio MCP server configured through the product's real config file is launched by
//      the Agent, its `mcp__<server>__<tool>` is offered to the model, and when the org reviewed the
//      exact runtime descriptor, approved the MCP server and allowed the tool, the server's MCP
//      risk floor still requires a per-use org approval; once approved, one model-driven call
//      executes exactly once: one effect line; D1 tool_call_refs completed with a
//      once-only execution claim by this device, a decision + result audit;
//   2. the org denies the MCP server by policy -> the same call is refused before execution: no
//      effect line, no execution claim, a denial audit, the run settles;
//   3. per-use approval is required, the call waits for the org, the org DENIES through the public
//      approval route -> no effect line, no claim, the run settles;
//   4. per-use approval is pending, the control plane REVOKES the device, then the org approves ->
//      the revoked desktop never executes (no effect line, no claim), and new managed execution is
//      refused at the host seam;
//   5. browser/computer use: the device's runtime capability report (D1 devices.capabilities) is
//      recorded; computer_use must be false on this build (NOT_APPLICABLE: packages/zcode-cua is a
//      fail-closed placeholder); browser runtime is UNPROVEN here (see report) unless driven.
// The user's own local "Ask before changes" prompt is answered "Allow only this time" every time it
// appears, so in 2-4 the ONLY thing standing between the model and the effect is managed enforcement.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { createDesktopApp } from "./lib/lumi-desktop-app.mjs";
import { onboardToManagedPolicy, startApprovalWeb } from "./lib/lumi-desktop-onboarding.mjs";
import { provisionOrganization } from "./lib/lumi-org-fixture.mjs";
import { readRowsWithRetry } from "./lib/automation-journey-state.mjs";
import { submitManagedTurn } from "./lib/lumi-managed-turn.mjs";
import { isolatedHomeLayout } from "./lib/lumi-child-env.mjs";
import {
  effectLines,
  mcpServerConfig,
  MCP_SERVER_NAME,
  MCP_TOOL_MODEL_NAME,
  writeMcpStubServer,
  writeProductMcpConfig,
} from "./lib/mcp-stub-server.mjs";
import {
  buildMcpIdentity,
  mcpPrompt,
  provisionMcpPlane,
  putToolPolicy,
} from "./lib/mcp-tool-flow.mjs";

const TOOL_ALIAS = "coding-tools";
const MOCK_CALL_NOTE = "lumi mock tool call fixture";
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
const probe = new SmokeHarness({ name: "Electron managed MCP" });
const profile = await mkdtemp(join(tmpdir(), "lumi-mcp-"));
const evidence = join(profile, "evidence");
const workspacePath = join(profile, "workspace");
const effectLog = join(profile, "mcp-effects.log");
mkdirSync(evidence, { recursive: true });
mkdirSync(workspacePath, { recursive: true });
mkdirSync(join(profile, "home", ".zcode", "v2"), { recursive: true });
const assertions = [];
const claims = {};
const pass = (claim) => {
  assertions.push(claim);
  console.log(`PASS ${claim}`);
};
let app;
let web;
let stage = "setup";
let completed = false;
const observedCapabilities = [];
let diagnose = async () => ({});
process.on("exit", () => probe.cleanup());

const rows = (sql, label) => readRowsWithRetry(probe, sql, label);
const toolSql = (runId) =>
  `SELECT c.tool_call_id, c.tool_id, c.tool_fingerprint, c.risk_class, c.status, c.execution_started_at, c.execution_device_id, a.status AS approval_status, a.consumed_at FROM tool_call_refs c LEFT JOIN approval_requests a ON a.tool_call_id = c.tool_call_id WHERE c.run_id = '${runId}'`;
const auditFor = (runId) =>
  rows(
    `SELECT action, outcome, reason FROM security_events WHERE run_id = '${runId}' ORDER BY created_at, rowid`,
    "tool audit for run",
  );

/** The user's local permission layer: answer "Allow only this time" whenever it is shown. */
async function answerLocalPrompt(page) {
  const choice = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const allow = buttons.find(
      (button) =>
        /^1\.\s*Allow\s*\n\s*Allow only this time/.test(button.innerText.trim()) &&
        !button.disabled,
    );
    if (allow) {
      allow.click();
      return true;
    }
    buttons.find((button) => button.innerText.trim() === "Back to workspace")?.click();
    return false;
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

async function recordCapabilities(deviceId, label) {
  const [row] = await rows(
    `SELECT capabilities FROM devices WHERE device_id = '${deviceId}'`,
    "device runtime capabilities",
  );
  const parsed = row?.capabilities ? JSON.parse(row.capabilities) : null;
  if (parsed && Object.keys(parsed).length > 0) observedCapabilities.push({ label, ...parsed });
  return parsed;
}

/** Drive the UI (answering local prompts) until `check` returns a value or the deadline passes. */
async function driveUntil(page, label, check, { timeout = 120_000, deviceId } = {}) {
  const deadline = Date.now() + timeout;
  let localAllows = 0;
  while (Date.now() < deadline) {
    if (await answerLocalPrompt(page).catch(() => false)) localAllows += 1;
    if (deviceId) await recordCapabilities(deviceId, label).catch(() => {});
    const value = await check();
    if (value) return { value, localAllows };
    await delay(700);
  }
  await page.screenshot(join(evidence, `timeout-${label}.png`)).catch(() => {});
  throw new Error(`timeout: ${label}`);
}

const knownRuns = new Set();
async function startMcpTurn({ page, orgId, agentId, label }) {
  await submitManagedTurn(page, { agentId, alias: TOOL_ALIAS, prompt: mcpPrompt(label) });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = await rows(
      `SELECT run_id, state FROM runs WHERE org_id = '${orgId}' AND agent_definition_id = '${agentId}' ORDER BY created_at DESC`,
      "managed MCP run starts",
    );
    const fresh = found.find((row) => !knownRuns.has(row.run_id));
    if (fresh) {
      knownRuns.add(fresh.run_id);
      return fresh;
    }
    await delay(500);
  }
  throw new Error(`no new managed run for ${label}`);
}

/** The managed denial code the Agent fed back to the model, as rendered in the task view. */
async function renderedDenial(page, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const code = await page.evaluate(() =>
      document.body.innerText.match(/Managed tool decision denied: ([a-z_]+)/g)?.at(-1),
    );
    if (code) return code.split(": ")[1];
    await answerLocalPrompt(page).catch(() => false);
    await delay(500);
  }
  await page.screenshot(join(evidence, `no-denial-${label}.png`)).catch(() => {});
  return null;
}

const runState = async (runId) =>
  (await rows(`SELECT state FROM runs WHERE run_id = '${runId}'`, "run state"))[0]?.state;

try {
  await probe.setup({ persistEnvVar: "DE2E_MCP_PERSIST" });
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
  diagnose = async () => ({
    runs: await probe.d1Rows(
      `SELECT run_id, state FROM runs WHERE org_id = '${org.orgId}' ORDER BY created_at`,
      "diagnose runs",
    ),
    calls: await probe.d1Rows(
      `SELECT c.run_id, c.status, c.risk_class, c.execution_started_at, a.status AS approval_status, a.approval_mode, a.expires_at FROM tool_call_refs c LEFT JOIN approval_requests a ON a.tool_call_id = c.tool_call_id WHERE c.org_id = '${org.orgId}' ORDER BY c.created_at`,
      "diagnose tool calls",
    ),
    audit: await probe.d1Rows(
      `SELECT run_id, action, outcome, reason FROM security_events WHERE org_id = '${org.orgId}' AND action LIKE 'tool.%' ORDER BY created_at, rowid`,
      "diagnose tool audit",
    ),
    effects: effectLines(effectLog),
    capabilities: observedCapabilities,
  });

  // Benign stdio MCP server, configured through the product's real config files.
  const { script, sdk } = writeMcpStubServer({ client, dir: profile });
  const serverConfig = mcpServerConfig({ script, effectLog });
  const configFiles = writeProductMcpConfig({
    workspacePath,
    agentHome: isolatedHomeLayout(profile).home,
    server: serverConfig,
  });
  // The exact identity the real Core path derives for mcp__<server>__<tool>. Deriving it connects
  // the product adapter to the stub (listTools only); it must not have called the tool.
  const { identity, descriptor } = await buildMcpIdentity({
    root,
    outDir: join(profile, "evidence", "mcp-tool-identity"),
    serverName: MCP_SERVER_NAME,
    config: serverConfig,
  });
  assert.equal(effectLines(effectLog).length, 0, "identity derivation never calls the tool");
  writeFileSync(
    join(evidence, "mcp-identity.json"),
    JSON.stringify({ identity, descriptor, configFiles, sdk: sdk.version }, null, 2),
  );
  const plane = await provisionMcpPlane({
    probe,
    fixture,
    orgId: org.orgId,
    projectId,
    identity,
    script,
  });
  await putToolPolicy({
    probe,
    fixture,
    orgId: org.orgId,
    toolId: plane.toolId,
    mcpId: plane.mcpId,
    mode: "allow",
    label: "allow",
  });
  web = await startApprovalWeb({ root, probe });
  app = createDesktopApp({ binary, desktop, probe, profile, workspacePath, name: "mcp" });
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

  // 1. Positive control. The org policy says approval "none", but the server's MCP risk floor
  //    (tool_policy.rs minimum_approval_mode: Mcp => PerUse) raises it to per-use: the call must
  //    wait for an org approval, and executes exactly once after the org APPROVES it.
  const pendingApproval = async (runId) => {
    const result = await probe.request(
      fixture,
      "GET",
      `/api/v1/orgs/${org.orgId}/approvals?status=pending&run_id=${runId}`,
    );
    probe.expectStatus("list pending MCP approvals", result, 200);
    const items = result.payload?.items ?? result.payload?.data ?? [];
    return items.length ? items : null;
  };
  const allowRun = await startMcpTurn({
    page,
    orgId: org.orgId,
    agentId: plane.agentId,
    label: "allow",
  });
  const allowPending = await driveUntil(
    page,
    "allow-pending-approval",
    async () => {
      const items = await pendingApproval(allowRun.run_id);
      if (items) return items;
      const state = await runState(allowRun.run_id);
      if (TERMINAL.includes(state)) {
        const text = await page.evaluate(() => document.body.innerText.slice(-1500));
        throw new Error(`run ${state} before any approval; screen=${text}`);
      }
      return null;
    },
    { deviceId, timeout: 180_000 },
  );
  assert.equal(allowPending.value.length, 1, "exactly one pending approval");
  const allowApproval = allowPending.value[0];
  assert.equal(allowApproval.tool_id, plane.toolId);
  assert.equal(allowApproval.tool_fingerprint, identity.fingerprint);
  assert.equal(allowApproval.risk_class, "mcp");
  assert.equal(allowApproval.approval_mode, "per_use", "MCP risk floor raises policy none");
  assert.equal(effectLines(effectLog).length, 0, "no effect while approval is pending");
  await page.screenshot(join(evidence, "mcp-allow-pending.png"));
  const approvedResolve = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/approvals/${allowApproval.id}/resolve`,
    { decision: "approved", version: allowApproval.version },
    probe.browserMutation(fixture, `mcp-approval-approve-${allowApproval.id}`),
  );
  probe.expectStatus("approve MCP approval", approvedResolve, 200);
  const allowed = await driveUntil(
    page,
    "allowed-mcp-call",
    async () => {
      const calls = await rows(toolSql(allowRun.run_id), "allowed tool call");
      const state = await runState(allowRun.run_id);
      return calls.length >= 1 && calls[0].status === "completed" && TERMINAL.includes(state)
        ? { calls, state }
        : null;
    },
    { deviceId, timeout: 180_000 },
  );
  allowed.localAllows += allowPending.localAllows;
  await page.screenshot(join(evidence, "mcp-allowed.png"));
  const allowLines = effectLines(effectLog);
  assert.equal(allowLines.length, 1, `exactly one effect line: ${JSON.stringify(allowLines)}`);
  assert.equal(JSON.parse(allowLines[0].split(" ").slice(1).join(" ")).note, MOCK_CALL_NOTE);
  const [allowCall] = allowed.value.calls;
  assert.equal(allowed.value.calls.length, 1, "one tool call ref for one model call");
  assert.equal(allowCall.tool_id, plane.toolId);
  assert.equal(allowCall.tool_fingerprint, identity.fingerprint);
  assert.equal(allowCall.risk_class, "mcp");
  assert.ok(allowCall.execution_started_at, "once-only execution claim recorded");
  assert.equal(allowCall.execution_device_id, deviceId);
  assert.equal(allowCall.approval_status, "approved");
  assert.ok(allowCall.consumed_at, "approval grant consumed by the once-only claim");
  const allowAudit = await auditFor(allowRun.run_id);
  const allowActions = allowAudit.map((row) => row.action);
  assert.ok(allowActions.includes("tool.execution_started.v1"), JSON.stringify(allowActions));
  assert.equal(
    allowActions.filter((action) => action === "tool.result.v1").length,
    1,
    "exactly one result audit",
  );
  assert.ok(!allowActions.includes("tool.denied.v1"));
  claims.mcp_allow = "PASS";
  pass(
    `positive control: reviewed+approved MCP tool ${MCP_TOOL_MODEL_NAME} (fingerprint ${identity.fingerprint.slice(0, 12)}) allowed by policy (approval none, raised to per_use by the MCP risk floor; no effect while pending), org APPROVED via public route -> executes exactly once: 1 effect line, tool_call_refs completed with execution claim by ${deviceId}, audit ${JSON.stringify([...new Set(allowActions)])}, run ${allowed.value.state}, local allow answered ${allowed.localAllows}x`,
  );
  const capsAfterAllow = observedCapabilities.find((row) => row.mcp_execution === true);
  assert.ok(
    capsAfterAllow,
    `device reported mcp_execution while running: ${JSON.stringify(observedCapabilities)}`,
  );
  pass(
    `device runtime capability report (D1 devices.capabilities) carried mcp_execution=true during the run: ${JSON.stringify(capsAfterAllow)}`,
  );

  // 2. Deny: the org denies the MCP server by policy.
  await putToolPolicy({
    probe,
    fixture,
    orgId: org.orgId,
    toolId: plane.toolId,
    mcpId: plane.mcpId,
    mode: "deny_mcp",
    label: "deny-mcp",
  });
  const denyRun = await startMcpTurn({
    page,
    orgId: org.orgId,
    agentId: plane.agentId,
    label: "deny",
  });
  const denied = await driveUntil(
    page,
    "denied-mcp-call",
    async () => {
      const calls = await rows(toolSql(denyRun.run_id), "denied tool call");
      const state = await runState(denyRun.run_id);
      return calls.length >= 1 && TERMINAL.includes(state) ? { calls, state } : null;
    },
    { deviceId, timeout: 180_000 },
  );
  const policyDenial = await renderedDenial(page, "deny");
  await page.screenshot(join(evidence, "mcp-denied.png"));
  assert.equal(policyDenial, "mcp_source_not_allowed", "the Agent saw the MCP policy denial");
  assert.equal(effectLines(effectLog).length, 1, "policy denial adds no effect line");
  assert.ok(
    denied.value.calls.every((call) => call.execution_started_at === null),
    "a denied call is never claimed",
  );
  assert.ok(
    denied.value.calls.every((call) => call.status === "denied"),
    JSON.stringify(denied),
  );
  const denyAudit = await auditFor(denyRun.run_id);
  assert.ok(
    denyAudit.some((row) => row.action === "tool.denied.v1"),
    JSON.stringify(denyAudit),
  );
  assert.ok(!denyAudit.some((row) => row.action === "tool.execution_started.v1"));
  claims.mcp_policy_deny = "PASS";
  pass(
    `MCP server denied by org policy (denied_mcp_ids): no effect line, tool_call_refs ${denied.value.calls.map((c) => c.status).join(",")} with no execution claim, Agent result 'Managed tool decision denied: ${policyDenial}', audit tool.denied.v1, run settled ${denied.value.state}`,
  );

  // 3. Per-use approval required, then DENIED by the org through the public approval route.
  await putToolPolicy({
    probe,
    fixture,
    orgId: org.orgId,
    toolId: plane.toolId,
    mcpId: plane.mcpId,
    mode: "per_use",
    label: "per-use-deny",
  });
  const approvalRun = await startMcpTurn({
    page,
    orgId: org.orgId,
    agentId: plane.agentId,
    label: "approval-deny",
  });
  const pending = await driveUntil(page, "pending-approval", () =>
    pendingApproval(approvalRun.run_id),
  );
  assert.equal(pending.value.length, 1, "exactly one pending approval");
  const approval = pending.value[0];
  assert.equal(approval.tool_id, plane.toolId);
  assert.equal(approval.tool_fingerprint, identity.fingerprint);
  assert.equal(approval.risk_class, "mcp");
  assert.equal(approval.approval_mode, "per_use");
  assert.equal(effectLines(effectLog).length, 1, "no effect while approval is pending");
  await page.screenshot(join(evidence, "mcp-approval-pending.png"));
  const resolved = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/approvals/${approval.id}/resolve`,
    { decision: "denied", version: approval.version, reason: "Electron MCP e2e denial" },
    probe.browserMutation(fixture, `mcp-approval-deny-${approval.id}`),
  );
  probe.expectStatus("deny MCP approval", resolved, 200);
  const approvalDenied = await driveUntil(
    page,
    "approval-denied-settles",
    async () => {
      const calls = await rows(toolSql(approvalRun.run_id), "approval-denied call");
      const state = await runState(approvalRun.run_id);
      return calls.length === 1 && calls[0].approval_status === "denied" && TERMINAL.includes(state)
        ? { calls, state }
        : null;
    },
    { timeout: 120_000 },
  );
  const approvalDenial = await renderedDenial(page, "approval-deny");
  await page.screenshot(join(evidence, "mcp-approval-denied.png"));
  assert.ok(approvalDenial, "the Agent saw the approval denial");
  assert.equal(effectLines(effectLog).length, 1, "approval denial adds no effect line");
  assert.equal(approvalDenied.value.calls[0].execution_started_at, null, "never claimed");
  assert.equal(approvalDenied.value.calls[0].consumed_at, null, "grant never consumed");
  claims.mcp_approval_denied = "PASS";
  pass(
    `per-use approval required (pending approval bound to tool ${plane.toolId}/fingerprint, risk mcp, no effect while pending), org DENIED via public route: Agent result denied (${approvalDenial}), no effect line, no execution claim, grant unconsumed, run settled ${approvalDenied.value.state}`,
  );

  // 4. Revocation mid-way: approval pending, device revoked, then the org approves.
  const revokeRun = await startMcpTurn({
    page,
    orgId: org.orgId,
    agentId: plane.agentId,
    label: "revoke",
  });
  const revokePending = await driveUntil(page, "revoke-pending-approval", () =>
    pendingApproval(revokeRun.run_id),
  );
  const revokeApproval = revokePending.value[0];
  assert.equal(effectLines(effectLog).length, 1, "no effect before revocation");
  const revoke = await probe.request(
    fixture,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${deviceId}`,
    {},
    probe.browserMutation(fixture, "revoke-mcp-desktop"),
  );
  assert.equal(revoke.status, 204, "control plane revokes the running desktop");
  const lateApprove = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/approvals/${revokeApproval.id}/resolve`,
    { decision: "approved", version: revokeApproval.version },
    probe.browserMutation(fixture, `mcp-approval-late-${revokeApproval.id}`),
  );
  // Give Main's approval wait time to observe the decision and attempt (and fail) re-authorization.
  const settleUntil = Date.now() + 45_000;
  while (Date.now() < settleUntil) {
    await answerLocalPrompt(page).catch(() => false);
    if (effectLines(effectLog).length !== 1) break;
    await delay(1_000);
  }
  const revokedDenial = await renderedDenial(page, "revoke");
  await page.screenshot(join(evidence, "mcp-revoked.png"));
  const revokeCalls = await rows(toolSql(revokeRun.run_id), "revoked run tool calls");
  const [deviceRow] = await rows(
    `SELECT status, (SELECT COUNT(*) FROM device_tokens WHERE device_id = '${deviceId}') AS tokens FROM devices WHERE device_id = '${deviceId}'`,
    "revoked device",
  );
  assert.equal(effectLines(effectLog).length, 1, "revoked desktop adds no effect line");
  assert.ok(
    revokeCalls.every((call) => call.execution_started_at === null),
    `revoked desktop never claims execution: ${JSON.stringify(revokeCalls)}`,
  );
  assert.equal(deviceRow.status, "revoked");
  assert.equal(Number(deviceRow.tokens), 0);
  const seam = await page.evaluate(
    (command) => window.zcode.lumiAccount.request({ action: "begin-managed-run", ...command }),
    {
      orgId: org.orgId,
      workspaceIdentity: workspacePath,
      agentDefinitionId: plane.agentId,
      modelAlias: TOOL_ALIAS,
      confirm: true,
    },
  );
  assert.equal(seam.ok, false, `revoked seam must refuse: ${JSON.stringify(seam)}`);
  claims.mcp_revocation = "PASS";
  pass(
    `device revoked while the MCP call awaited approval; org approval afterwards answered ${lateApprove.status}; Agent result denied (${revokedDenial ?? "not rendered within 30s"})${lateApprove.payload?.error?.reason ? ` (${lateApprove.payload.error.reason})` : ""}: no effect line, tool_call_refs ${JSON.stringify(revokeCalls.map((c) => ({ status: c.status, approval: c.approval_status, claimed: c.execution_started_at })))}, device revoked with 0 tokens, new managed execution refused at the host seam (${seam.code}), run ${await runState(revokeRun.run_id)}`,
  );

  // 5. Browser / computer use: the runtime capability report.
  const reported = observedCapabilities.at(-1) ?? {};
  writeFileSync(
    join(evidence, "runtime-capabilities.json"),
    JSON.stringify(observedCapabilities, null, 2),
  );
  assert.equal(
    reported.computer_use,
    false,
    `computer_use must be false: ${JSON.stringify(reported)}`,
  );
  claims.computer_use = "NOT_APPLICABLE";
  pass(
    "computer use NOT_APPLICABLE: device reported computer_use=false (packages/zcode-cua is the fail-closed placeholder 'This build ships without Computer Use')",
  );
  claims.browser_use_reported = reported.browser_use === true;
  claims.browser_runtime = "UNPROVEN";
  pass(
    `browser use: device reported browser_use=${reported.browser_use}; runtime browser execution UNPROVEN here — the built-in browser tool (node_repl js) schema has code/title/timeout_ms and no string note, so mock://lumi-tool's lumi-mock-call marker cannot drive it (apps/api/src/adapters/mock_tool.rs requested_call); component evidence: LumiAgents c261135a bootstrap/tests/lumi-managed-tool-enforcement.test.ts`,
  );
  assert.equal(probe.failures.length, 0);
  completed = true;
} catch (error) {
  console.error(`FAIL ${error?.stack ?? error}`);
  const diagnostics = await diagnose().catch((cause) => ({ error: String(cause) }));
  writeFileSync(join(evidence, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
  console.error(`diagnostics ${JSON.stringify(diagnostics).slice(0, 4000)}`);
  await app?.page?.screenshot(join(evidence, "failure.png")).catch(() => {});
  process.exitCode = stage === "runtime" ? 1 : 2;
} finally {
  writeFileSync(join(evidence, "app.log"), probe.redact(app?.log ?? ""));
  writeFileSync(join(evidence, "effect-lines.json"), JSON.stringify(effectLines(effectLog)));
  await app?.stop();
  await web?.close();
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const report = {
    verdict: completed ? "PASS" : stage === "runtime" ? "FAIL" : "BLOCKED",
    scope:
      "journey-d-mcp-allow-deny-approval-revocation-plus-browser-computer-capability-classification",
    control_plane_sha: git(root, "rev-parse", "HEAD"),
    lumi_agents_sha: git(client, "rev-parse", "HEAD"),
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    claims,
    runtime_capabilities: observedCapabilities.at(-1) ?? null,
    desktop_assertions: assertions,
    worker_assertions: probe.passes,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_MCP_REPORT)
    writeFileSync(process.env.LUMI_MCP_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
