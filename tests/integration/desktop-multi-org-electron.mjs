// Journey A/C organization choice through the ACTUAL Electron app against a fresh Worker/D1. One
// user belongs to two organizations. After the desktop is enrolled and its workspace adopted in
// org A (positive control: a managed turn completes there), choosing org B in the UI must not
// carry anything across: no device or authority in B, the workspace stays local for B, the host
// seam refuses a managed run for B, D1 holds no B binding/adoption/run, and switching back to A
// shows A's adoption unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { createDesktopApp, uiHelpers } from "./lib/lumi-desktop-app.mjs";
import { onboardToManagedPolicy, startApprovalWeb } from "./lib/lumi-desktop-onboarding.mjs";
import { provisionOrganization, SUCCESS_ALIAS } from "./lib/lumi-org-fixture.mjs";
import { readRowsWithRetry } from "./lib/automation-journey-state.mjs";
import { submitManagedTurn } from "./lib/lumi-managed-turn.mjs";

const root = resolve(import.meta.dirname, "../..");
const client = join(root, "integrations/lumi-agents");
const desktop = join(client, "packages/desktop");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
const probe = new SmokeHarness({ name: "Electron multi-org" });
const profile = await mkdtemp(join(tmpdir(), "lumi-multi-org-"));
const evidence = join(profile, "evidence");
const workspacePath = join(profile, "workspace");
mkdirSync(evidence, { recursive: true });
mkdirSync(workspacePath, { recursive: true });
const assertions = [];
const pass = (claim) => {
  assertions.push(claim);
  console.log(`PASS ${claim}`);
};
let app;
let web;
let stage = "setup";
let completed = false;
process.on("exit", () => probe.cleanup());

try {
  await probe.setup({ persistEnvVar: "DE2E_MULTI_ORG_PERSIST" });
  const fixtureOrg = await provisionOrganization(probe);
  const { fixture, org, projectId, agentId } = fixtureOrg;
  const orgB = await probe.createOrganization(
    fixture,
    "Second Journey Org",
    `second-${probe.nonce}`,
  );
  const rows = (sql, label) => readRowsWithRetry(probe, sql, label);
  const orgBState = async () =>
    (
      await rows(
        `SELECT (SELECT COUNT(*) FROM devices WHERE org_id = '${orgB.orgId}') AS devices,
                (SELECT COUNT(*) FROM workspace_adoption_states WHERE org_id = '${orgB.orgId}') AS adoptions,
                (SELECT COUNT(*) FROM runs WHERE org_id = '${orgB.orgId}') AS runs,
                (SELECT COUNT(*) FROM inference_requests WHERE org_id = '${orgB.orgId}') AS requests`,
        "org B state",
      )
    )[0];
  const adoptionA = () =>
    rows(
      `SELECT stage, ownership, version FROM workspace_adoption_states WHERE org_id = '${org.orgId}'`,
      "org A adoption",
    );

  web = await startApprovalWeb({ root, probe });
  app = createDesktopApp({ binary, desktop, probe, profile, workspacePath, name: "multi-org" });
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
  const ui = uiHelpers(page);
  await submitManagedTurn(page, { agentId, alias: SUCCESS_ALIAS, prompt: `Org A ${probe.nonce}` });
  await ui.wait(() => document.body.innerText.includes("Hello from Lumi."), "org A reply", {
    timeout: 90_000,
  });
  const beforeA = await adoptionA();
  assert.equal(beforeA[0]?.stage, "managed_policy");
  assert.deepEqual(await orgBState(), { devices: 0, adoptions: 0, runs: 0, requests: 0 });
  pass("positive control: org A device, adoption and managed turn work; org B has nothing");

  // Choose org B in both the device and workspace sections, the way a user does.
  await ui.clickText("Settings");
  await ui.wait(() => !!document.querySelector('[aria-label="General"]'), "settings nav");
  await ui.clickText("General");
  await ui.wait(
    (id) => !!document.querySelector(`#lumi-device-org option[value="${id}"]`),
    "org B listed",
    { arg: orgB.orgId },
  );
  assert.equal(await ui.selectValue("#lumi-device-org", orgB.orgId), true);
  await ui.wait(
    () => document.body.innerText.includes("Confirm and enroll this device"),
    "org B offers enrollment, not A's device",
  );
  assert.equal(await ui.selectValue("#lumi-workspace-org", orgB.orgId), true);
  await delay(3_000);
  const workspaceText = await page.evaluate(
    () => document.querySelector("#lumi-workspace-heading")?.parentElement?.innerText ?? "",
  );
  assert.equal(workspaceText.includes("Organization-managed"), false, "B shows no managed state");
  await page.screenshot(join(evidence, "org-b-selected.png"));
  const seam = await page.evaluate((command) => window.zcode.lumiAccount.request(command), {
    action: "begin-managed-run",
    orgId: orgB.orgId,
    workspaceIdentity: workspacePath,
    agentDefinitionId: agentId,
    modelAlias: SUCCESS_ALIAS,
    confirm: true,
  });
  assert.equal(seam.ok, false, `org B managed run must be refused: ${JSON.stringify(seam)}`);
  assert.deepEqual(await orgBState(), { devices: 0, adoptions: 0, runs: 0, requests: 0 });
  pass(
    `choosing org B carries no device, adoption or authority from A: enrollment offered, workspace not managed, host seam refuses (${seam.code}), D1 has no B device/adoption/run/request`,
  );

  // Back to A: A's adoption is exactly as it was.
  assert.equal(await ui.selectValue("#lumi-device-org", org.orgId), true);
  assert.equal(await ui.selectValue("#lumi-workspace-org", org.orgId), true);
  await ui.wait(
    () => document.body.innerText.includes("Organization-managed"),
    "org A managed state restored",
  );
  const afterA = await adoptionA();
  assert.deepEqual(afterA, beforeA, "switching organizations changed nothing in A");
  const devices = await rows(
    `SELECT device_id FROM devices WHERE org_id = '${org.orgId}'`,
    "org A devices",
  );
  assert.deepEqual(
    devices.map((row) => row.device_id),
    [deviceId],
  );
  pass("switching back to org A shows its adoption unchanged and the same single device");
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
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const report = {
    verdict: completed ? "PASS" : stage === "runtime" ? "FAIL" : "BLOCKED",
    scope: "journeys-a-c-organization-choice-no-carry-over",
    control_plane_sha: git(root, "rev-parse", "HEAD"),
    lumi_agents_sha: git(client, "rev-parse", "HEAD"),
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    desktop_assertions: assertions,
    worker_assertions: probe.passes,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_MULTI_ORG_REPORT)
    writeFileSync(process.env.LUMI_MULTI_ORG_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
