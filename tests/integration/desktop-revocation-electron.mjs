// Journey B revocation through the ACTUAL Electron app (Main -> Host -> Agent) against a fresh
// Worker/D1. Proves, in order, each claim only after its positive control:
//   1. a bound, enrolled desktop completes a managed turn through the UI (positive control) and the
//      host IPC seam (`begin-managed-run`) mints managed context for the same inputs;
//   2. after the control plane revokes the device, the running app refuses new managed execution at
//      the UI AND at the host seam, policy sync is refused, and D1 gains no run/inference row;
//   3. a restart restores the human session but not device authority: no re-enrollment, no new
//      device, still refused at the seam, still no new managed rows;
//   4. local personal work (a seeded local automation using a synthetic personal provider) still
//      completes after revocation, with no managed involvement.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { createDesktopApp, uiHelpers } from "./lib/lumi-desktop-app.mjs";
import { startSecretSweepProxy } from "./lib/secret-sweep-proxy.mjs";
import {
  onboardToManagedPolicy,
  reachAccountSection,
  startApprovalWeb,
} from "./lib/lumi-desktop-onboarding.mjs";
import { provisionOrganization, SUCCESS_ALIAS } from "./lib/lumi-org-fixture.mjs";
import { readRowsWithRetry, seedLocalAutomations } from "./lib/automation-journey-state.mjs";
import {
  managedSectionCode,
  openManagedControls,
  submitManagedTurn,
} from "./lib/lumi-managed-turn.mjs";
import {
  awaitLocalRun,
  personalConfigHash,
  startLocalProviderStub,
  writeLocalPersonalConfig,
} from "./lib/local-personal-provider.mjs";

const root = resolve(import.meta.dirname, "../..");
const client = join(root, "integrations/lumi-agents");
const desktop = join(client, "packages/desktop");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
const probe = new SmokeHarness({ name: "Electron revocation" });
const profile = await mkdtemp(join(tmpdir(), "lumi-revocation-"));
const evidence = join(profile, "evidence");
const workspacePath = join(profile, "workspace");
mkdirSync(evidence, { recursive: true });
mkdirSync(workspacePath, { recursive: true });
mkdirSync(join(profile, "home", ".zcode", "v2"), { recursive: true });
const assertions = [];
const pass = (claim) => {
  assertions.push(claim);
  console.log(`PASS ${claim}`);
};
const stamp = Date.now();
const LOCAL_PROMPT = `REVOKED-LOCAL-${stamp}-stays-local`;
// Due after onboarding, the managed control and the revocation; the scheduler only runs it then.
const LOCAL_DUE_MS = Number(process.env.DE2E_REVOCATION_LOCAL_DUE_MS ?? 300_000);
let app;
let web;
let stub;
let sweep;
let stage = "setup";
let completed = false;
process.on("exit", () => probe.cleanup());

async function managedCounts(orgId, deviceId) {
  const [row] = await readRowsWithRetry(
    probe,
    `SELECT (SELECT COUNT(*) FROM runs WHERE org_id = '${orgId}') AS runs,
            (SELECT COUNT(*) FROM inference_requests WHERE org_id = '${orgId}') AS requests,
            (SELECT COUNT(*) FROM devices WHERE org_id = '${orgId}') AS devices,
            (SELECT status FROM devices WHERE device_id = '${deviceId}') AS status`,
    "managed counts",
  );
  return row;
}

/** The host seam the renderer uses; called directly to show enforcement is not renderer-only. */
const beginManagedRun = (page, input) =>
  page.evaluate(
    (command) => window.zcode.lumiAccount.request({ action: "begin-managed-run", ...command }),
    { ...input, confirm: true },
  );

try {
  await probe.setup({ persistEnvVar: "DE2E_REVOCATION_PERSIST" });
  const fixtureOrg = await provisionOrganization(probe);
  const { fixture, org, projectId, agentId } = fixtureOrg;
  stub = await startLocalProviderStub({ stamp, markers: { local: LOCAL_PROMPT } });
  await writeLocalPersonalConfig({ root, profile, stub });
  const [localControl] = await seedLocalAutomations({
    root,
    profile,
    specs: [
      {
        title: "Local work after revocation",
        cronExpr: "* * * * *",
        prompt: LOCAL_PROMPT,
        workspacePath,
        nextRunAt: Date.now() + LOCAL_DUE_MS,
      },
    ],
  });
  const personalBefore = personalConfigHash(profile);
  web = await startApprovalWeb({ root, probe });
  // Wire/at-rest sweep: every desktop request goes through a recording proxy that keeps issued
  // secrets in memory only and flags request bodies carrying the local path or local prompt.
  sweep = await startSecretSweepProxy({
    target: probe.baseUrl,
    forbiddenInBodies: [
      // Managed inference carries the model's context (which names the working directory) by
      // design; adoption, binding, device, policy and every other route must not.
      {
        label: "workspace path",
        needle: workspacePath,
        allowedRoutes: [/^POST \/api\/v1\/inference\//],
      },
      // Local personal work never reaches the control plane on any route.
      { label: "local automation prompt", needle: LOCAL_PROMPT },
    ],
  });
  app = createDesktopApp({
    binary,
    desktop,
    probe,
    profile,
    workspacePath,
    name: "revocation",
    origin: sweep.origin,
  });
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

  // 1. Positive controls: UI turn completes; the host seam mints context for the same inputs.
  await submitManagedTurn(page, {
    agentId,
    alias: SUCCESS_ALIAS,
    prompt: `Managed control ${stamp}`,
  });
  await ui.wait(
    () => document.body.innerText.includes("Hello from Lumi."),
    "managed control reply",
  );
  const control = await managedCounts(org.orgId, deviceId);
  assert.equal(control.status, "active");
  assert.ok(control.runs >= 1 && control.requests >= 1, JSON.stringify(control));
  pass(
    `positive control: enrolled, bound desktop completes a managed UI turn (${control.runs} run, ${control.requests} request)`,
  );
  const workspaceIdentity = workspacePath;
  const seamControl = await beginManagedRun(page, {
    orgId: org.orgId,
    workspaceIdentity,
    agentDefinitionId: agentId,
    modelAlias: SUCCESS_ALIAS,
  });
  assert.equal(seamControl.ok, true, `host seam control: ${JSON.stringify(seamControl)}`);
  const abort = await page.evaluate(
    (runId) =>
      window.zcode.lumiAccount.request({ action: "abort-managed-run", runId, confirm: true }),
    seamControl.managedContext.runId,
  );
  assert.equal(abort.ok, true);
  pass("positive control: host begin-managed-run mints managed context for the same inputs");

  // 2. Revoke in the control plane; the running app must refuse new managed execution.
  const revoke = await probe.request(
    fixture,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${deviceId}`,
    {},
    probe.browserMutation(fixture, "revoke-running-desktop"),
  );
  assert.equal(revoke.status, 204);
  // Runtime enforcement is asserted first, so a fault in it is detected by the refusal itself
  // rather than by the bookkeeping readback below.
  const revokedCounts = await managedCounts(org.orgId, deviceId);
  const seamRefusal = await beginManagedRun(page, {
    orgId: org.orgId,
    workspaceIdentity,
    agentDefinitionId: agentId,
    modelAlias: SUCCESS_ALIAS,
  });
  assert.equal(seamRefusal.ok, false, `revoked seam must refuse: ${JSON.stringify(seamRefusal)}`);
  assert.match(seamRefusal.code, /^lumi_[a-z_]+$/);
  // The user retries through the UI: refusal may surface when options are listed or at Run.
  const reopened = await openManagedControls(page);
  let uiCode = reopened.code;
  let uiPoint = "options";
  if (reopened.state === "ready") {
    uiPoint = "run";
    await submitManagedTurn(page, {
      agentId,
      alias: SUCCESS_ALIAS,
      prompt: `Managed after revoke ${stamp}`,
    });
    await ui.wait(() => /lumi_[a-z_]{3,80}/.test(document.body.innerText), "revoked UI refusal");
    uiCode = await managedSectionCode(page);
  }
  assert.match(uiCode ?? "", /^lumi_[a-z_]+$/, "UI shows a stable refusal code");
  await page.screenshot(join(evidence, "revoked-managed-refusal.png"));
  const afterRevoke = await managedCounts(org.orgId, deviceId);
  assert.equal(afterRevoke.runs, revokedCounts.runs, "no run created after revocation");
  assert.equal(
    afterRevoke.requests,
    revokedCounts.requests,
    "no inference request after revocation",
  );
  pass(
    `running app refuses new managed execution after revocation at the host seam (${seamRefusal.code}) and in the UI at ${uiPoint} (${uiCode}); D1 runs/requests unchanged`,
  );
  const revoked = await managedCounts(org.orgId, deviceId);
  assert.equal(revoked.status, "revoked");
  const tokens = await readRowsWithRetry(
    probe,
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id = '${deviceId}'`,
    "live device tokens after revoke",
  );
  assert.equal(tokens[0].n, 0);
  pass("control plane revokes the device: D1 status revoked and zero live device tokens");

  await reachAccountSection(app, { expectRestoredAccount: true });
  await ui.clickText("Sync policy");
  await ui.wait(
    () => document.body.innerText.includes("Device action failed"),
    "revoked policy sync refusal",
  );
  pass("running app policy sync is refused after revocation");

  // 3. Restart: the human session restores; device authority does not.
  await app.stop();
  await app.start();
  await reachAccountSection(app, { expectRestoredAccount: true });
  const restartSeam = await beginManagedRun(app.page, {
    orgId: org.orgId,
    workspaceIdentity,
    agentDefinitionId: agentId,
    modelAlias: SUCCESS_ALIAS,
  });
  assert.equal(restartSeam.ok, false, `restart must not restore: ${JSON.stringify(restartSeam)}`);
  const afterRestart = await managedCounts(org.orgId, deviceId);
  assert.equal(afterRestart.devices, 1, "restart must not enroll a new device");
  assert.equal(afterRestart.status, "revoked");
  assert.equal(afterRestart.runs, revoked.runs);
  assert.equal(afterRestart.requests, revoked.requests);
  await app.page.screenshot(join(evidence, "revoked-after-restart.png"));
  pass(
    `restart restores the session but not device authority: seam refused (${restartSeam.code}), one device still revoked, no new run/request`,
  );

  // 4. Local personal work is unaffected by losing managed authority.
  const local = await awaitLocalRun(
    "local automation after revocation completes through the personal provider",
    profile,
    { automationId: localControl.automationId, reply: stub.reply, workspacePath },
    { timeout: LOCAL_DUE_MS + 300_000 },
  );
  const final = await managedCounts(org.orgId, deviceId);
  assert.equal(final.runs, revoked.runs, "local work made no managed run");
  assert.ok(stub.stats().byMarker.local >= 1, "personal provider received the local prompt");
  pass(
    `local personal work still completes after revocation (local run ${local.run.run_id}); no managed run created`,
  );
  // Secret sweep, after the whole lifecycle and a restart. Controls first: secrets were captured,
  // and the scanner finds a planted copy, so "no hits" means absent rather than incapable.
  assert.ok(sweep.secretCount() >= 2, `issued secrets captured: ${sweep.secretCount()}`);
  assert.equal(sweep.selfTest(), true, "the scanner finds a planted copy of a captured secret");
  const hits = sweep.scan(profile);
  assert.deepEqual(hits, [], `plaintext session/device/lease secrets found at rest: ${hits}`);
  assert.deepEqual(
    sweep.bodyLeaks(),
    [],
    `local path or prompt sent on the wire: ${sweep.bodyLeaks()}`,
  );
  writeFileSync(join(evidence, "wire-routes.json"), JSON.stringify(sweep.routeShapes(), null, 2));
  pass(
    `no issued session/device/lease secret (${sweep.secretCount()} captured) appears in plaintext anywhere in the profile, Agent home or logs; no non-inference request carried the workspace path and no request carried the local prompt (${sweep.routeShapes().length} route shapes recorded)`,
  );
  assert.equal(
    personalConfigHash(profile),
    personalBefore,
    "personal provider configuration unchanged by sign-in, enrollment, managed runs, revocation and restart",
  );
  pass("personal BYOK provider configuration is byte-identical after the whole managed lifecycle");
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
  await stub?.close?.();
  await sweep?.close();
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const report = {
    verdict: completed ? "PASS" : stage === "runtime" ? "FAIL" : "BLOCKED",
    scope: "journey-b-revocation-running-and-restart-plus-local-preservation",
    control_plane_sha: git(root, "rev-parse", "HEAD"),
    lumi_agents_sha: git(client, "rev-parse", "HEAD"),
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    desktop_assertions: assertions,
    worker_assertions: probe.passes,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_REVOCATION_REPORT)
    writeFileSync(process.env.LUMI_REVOCATION_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
