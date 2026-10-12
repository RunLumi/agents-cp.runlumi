// DE2E-INT-05 journey E: automation adoption and managed scheduling through the ACTUAL Electron app
// and a real development Worker/D1. Nothing in the product is stubbed: the renderer UI, Main account
// owner, scheduler utility process, Host, bundled Agent, Worker routes and D1 are the shipped code.
// Test-owned parts are only: the disposable organization (public admin routes), pause/resume/revoke
// through those same public routes, firing the Worker's own scheduled handler (the server clock of a
// local Worker), SIGSTOP/SIGKILL of the app, the backend's development-only `mock://` providers, local
// seeding through the product's own AutomationRepo, and READS of D1 and the tasks-index SQLite.
//
// usage: node tests/integration/desktop-automation-electron.mjs [--until=<stage>] [--dump-ui]
//   stages: onboard, adopt, schedule, race, restart, faults   (default: all)
// Verdict rules (never weakened): the default run PASSES only when every stage is PASS; a stage with a
// named gap is PARTIAL, a stage that failed or never ran is FAIL/UNPROVEN, and the exit code is non-zero
// for anything but a complete PASS. `--until` is a scoped diagnostic: it never reports a full PASS.
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { createDesktopApp } from "./lib/lumi-desktop-app.mjs";
import { onboardToManagedPolicy, startApprovalWeb } from "./lib/lumi-desktop-onboarding.mjs";
import { provisionOrganization } from "./lib/lumi-org-fixture.mjs";
import { createLedger, provenance } from "./lib/automation-evidence.mjs";
import { seedLocalAutomations, serverState } from "./lib/automation-journey-state.mjs";
import { uiObservations } from "./lib/automation-ui.mjs";
import { startClaimRecordingProxy } from "./lib/claim-recording-proxy.mjs";
import { adoptStage } from "./lib/automation-stage-adopt.mjs";
import { scheduleStage } from "./lib/automation-stage-schedule.mjs";
import { raceStage } from "./lib/automation-stage-race.mjs";
import { faultsStage, restartStage } from "./lib/automation-stage-faults.mjs";
import {
  preAdoptionLocalProof,
  seedBadModelControl,
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
const STAGES = ["onboard", "adopt", "schedule", "race", "restart", "faults"];
const until = process.argv.find((arg) => arg.startsWith("--until="))?.slice(8);
if (until && !STAGES.includes(until))
  throw new Error(`unknown stage ${until}; stages: ${STAGES.join(", ")}`);
const dumpUi = process.argv.includes("--dump-ui");
const wants = (stage) => !until || STAGES.indexOf(stage) <= STAGES.indexOf(until);
const LOCAL_DUE_MS = Number(process.env.DE2E_AUTOMATION_LOCAL_DUE_MS ?? 480_000);

const probe = new SmokeHarness({ name: "Desktop automation" });
const ledger = createLedger(STAGES);
const originalLog = console.log.bind(console);

const profileA = await mkdtemp(join(tmpdir(), "lumi-automation-a-"));
const evidenceDir = join(profileA, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const workspacePath = join(profileA, "workspace");
mkdirSync(workspacePath, { recursive: true });
const stamp = Date.now();
const PROMPT = `AUTOMATION-PROMPT-${stamp}-do-not-upload`;
const CONTROL_PROMPT = `CONTROL-PROMPT-${stamp}-stays-local`;
const PREFLIGHT_PROMPT = `PREFLIGHT-PROMPT-${stamp}-stays-local`;
const BAD_MODEL_PROMPT = `BADMODEL-PROMPT-${stamp}-stays-local`;

const ctx = {
  root,
  binary,
  desktop,
  probe,
  ledger,
  profileA,
  workspacePath,
  evidenceDir,
  PROMPT,
  agentName: "Automation journey agent",
  successModelName: "coding-default",
  slowModelName: "coding-slow",
  state: {},
  seeds: {},
};
let web;
let setupError;
let blockedBy;
let prov;
let report;
process.on("exit", () => probe.cleanup());

async function dumpDom(label) {
  if (!dumpUi || !ctx.appA?.page) return;
  const info = await ctx.appA.page.evaluate(() => ({
    labels: [...document.querySelectorAll("[aria-label]")].map((el) =>
      el.getAttribute("aria-label"),
    ),
    buttons: [...document.querySelectorAll("button")]
      .map((el) => el.innerText.trim())
      .filter(Boolean),
    testIds: [...document.querySelectorAll("[data-testid]")].map((el) =>
      el.getAttribute("data-testid"),
    ),
    text: document.body.innerText.slice(0, 1500),
  }));
  writeFileSync(join(evidenceDir, `dom-${label}.json`), JSON.stringify(info, null, 2));
  originalLog(`DOM ${label}: ${JSON.stringify(info.labels)}`);
}

/** Run one stage; the first failure stops later stages, which then stay UNPROVEN (never PASS). */
async function stage(name, body) {
  if (!wants(name)) return;
  if (setupError || blockedBy) {
    originalLog(
      `UNPROVEN ${name}: not run (${setupError ? "setup failed" : `stage ${blockedBy} failed`})`,
    );
    return;
  }
  ledger.enter(name);
  try {
    await body();
    ledger.finish(name);
  } catch (error) {
    originalLog(`FAIL ${name}: ${error?.stack ?? error}`);
    ledger.finish(name, error);
    blockedBy = name;
    for (const [label, app] of [
      ["A", ctx.appA],
      ["B", ctx.appB],
    ])
      if (app)
        writeFileSync(join(evidenceDir, `app-${label}-at-failure.log`), app.log.slice(-60_000));
    await ctx.appA?.page?.screenshot(join(evidenceDir, `failure-${name}.png`)).catch(() => {});
  }
}

try {
  prov = provenance({ root, client, desktop });
  if (prov.buildStale && !process.env.DE2E_ALLOW_STALE_BUILD)
    throw new Error(
      `desktop bundles (oldest ${prov.oldestBundle}) are older than product source (${prov.newestSource}); rebuild or set DE2E_ALLOW_STALE_BUILD to record a stale run`,
    );
  await probe.setup({
    persistEnvVar: "DE2E_AUTOMATION_PERSIST",
    portEnvVar: "DE2E_AUTOMATION_PORT",
  });
  const fixtureOrg = await provisionOrganization(probe);
  const { org, projectId, agentId } = fixtureOrg;
  Object.assign(ctx, { fixtureOrg, org, orgId: org.orgId, projectId, agentId });
  ctx.server = serverState(probe, org.orgId);
  const entitlements = await probe.request(
    fixtureOrg.fixture,
    "GET",
    `/api/v1/orgs/${org.orgId}/entitlements`,
  );
  ctx.state.entitlementsRead = {
    status: entitlements.status,
    body: probe.brief(entitlements.payload, 600),
  };
  originalLog(
    "PASS disposable organization, project, success route, hanging route, policy, agent and budget exist",
  );

  // Local automations exist BEFORE the first launch, so they are real stored originals the app migrates.
  mkdirSync(join(profileA, "home", ".zcode", "v2"), { recursive: true });
  ctx.localDueAt = Date.now() + LOCAL_DUE_MS;
  const far = Date.now() + 6 * 3_600_000;
  // The isolated profile gets ONE synthetic personal provider (loopback stub, synthetic key) before first launch;
  // without a local default the unmarked control cannot resolve a model (local-control-retained-readback.json).
  const stub = await startLocalProviderStub({
    stamp,
    markers: {
      adopted: PROMPT,
      control: CONTROL_PROMPT,
      preflight: PREFLIGHT_PROMPT,
      badModel: BAD_MODEL_PROMPT,
    },
  });
  const personalConfig = await writeLocalPersonalConfig({ root, profile: profileA, stub });
  ctx.localProvider = { stub, ...personalConfig };
  originalLog(
    `PASS synthetic personal provider written into the profile; the real registry resolves ${JSON.stringify(personalConfig.defaultModelSelection)} as preferred (stub ${stub.baseUrl})`,
  );
  const [adopted, control, bounded, slow, preflight, slowLease, slowRevoke] =
    await seedLocalAutomations({
      root,
      profile: profileA,
      specs: [
        {
          title: "Nightly review",
          cronExpr: "* * * * *",
          prompt: PROMPT,
          workspacePath,
          nextRunAt: ctx.localDueAt,
        },
        {
          title: "Local control",
          cronExpr: "* * * * *",
          prompt: CONTROL_PROMPT,
          workspacePath,
          nextRunAt: ctx.localDueAt,
        },
        {
          title: "Bounded limit",
          cronExpr: "* * * * *",
          prompt: "bounded run",
          workspacePath,
          nextRunAt: far,
          maxRuns: 3,
        },
        {
          title: "Slow run",
          cronExpr: "* * * * *",
          prompt: `SLOW-PROMPT-${stamp}`,
          workspacePath,
          nextRunAt: far,
        },
        // due at first launch and bounded to one run: the PRE-adoption positive control, same workspace and config
        {
          title: "Local preflight",
          cronExpr: "* * * * *",
          prompt: PREFLIGHT_PROMPT,
          workspacePath,
          nextRunAt: Date.now(),
          maxRuns: 1,
        },
        // Separate originals for the lease-expiry and revocation faults: the restart fault leaves its occurrence
        // AMBIGUOUS, which (by contract) blocks every later slot of that same automation, so a fresh fault needs a
        // fresh automation. Each is still handed over through the real UI.
        {
          title: "Slow run (lease)",
          cronExpr: "* * * * *",
          prompt: `SLOW-LEASE-PROMPT-${stamp}`,
          workspacePath,
          nextRunAt: far,
        },
        {
          title: "Slow run (revocation)",
          cronExpr: "* * * * *",
          prompt: `SLOW-REVOKE-PROMPT-${stamp}`,
          workspacePath,
          nextRunAt: far,
        },
      ],
    });
  const badModel = await seedBadModelControl({
    root,
    profile: profileA,
    spec: {
      title: "Bad model control",
      cronExpr: "* * * * *",
      prompt: BAD_MODEL_PROMPT,
      workspacePath,
      nextRunAt: Date.now(),
      maxRuns: 1,
    },
  });
  ctx.seeds = { adopted, control, bounded, slow, preflight, badModel, slowLease, slowRevoke };
  originalLog(
    "PASS eight local automations are stored by the product's own repository before first launch",
  );
} catch (error) {
  setupError = error;
  originalLog(`FAIL setup: ${error?.stack ?? error}`);
}

try {
  if (!setupError) {
    web = await startApprovalWeb({ root, probe });
    ctx.web = web;
    // Both apps talk to the Worker through a transparent proxy that records only claim-route responses.
    ctx.claimProxy = await startClaimRecordingProxy({
      target: probe.baseUrl,
      redact: (text) => probe.redact(text),
    });
    ctx.appA = createDesktopApp({
      binary,
      desktop,
      probe,
      profile: profileA,
      workspacePath,
      name: "client A",
      origin: ctx.claimProxy.origin,
    });
  }
  await stage("onboard", async () => {
    await ctx.appA.start();
    const onboarding = await onboardToManagedPolicy({
      app: ctx.appA,
      probe,
      web,
      projectId: ctx.projectId,
      email: ctx.fixtureOrg.email,
      password: ctx.fixtureOrg.password,
    });
    ctx.state.deviceIdA = onboarding.deviceId;
    ledger.pass(
      "actual UI: Lumi sign-in, device enrollment, opaque binding and managed-policy workspace",
    );
    await dumpDom("after-onboard");
    await preAdoptionLocalProof(ctx);
  });
  await stage("adopt", () => adoptStage(ctx));
  await stage("schedule", () => scheduleStage(ctx));
  await stage("race", () => raceStage(ctx));
  await stage("restart", () => restartStage(ctx));
  await stage("faults", () => faultsStage(ctx));
} catch (error) {
  setupError ??= error;
  originalLog(`FAIL harness: ${error?.stack ?? error}`);
} finally {
  await ctx.appA?.stop();
  await ctx.appB?.stop();
  await web?.close();
  await ctx.claimProxy?.close();
  const localStubStats = ctx.localProvider?.stub.stats();
  await ctx.localProvider?.stub.close();
  const ranStages = STAGES.filter(wants);
  const snapshot = ledger.snapshot();
  const requested = ranStages.map((name) => snapshot[name]);
  const failed = requested.some((item) => item.status === "FAIL") || !!setupError;
  const notRun = requested.some((item) => item.status === "UNPROVEN" || item.status === "RUNNING");
  const allPass = requested.every((item) => item.status === "PASS");
  let verdict = "UNPROVEN";
  if (failed) verdict = "FAIL";
  else if (allPass) verdict = "PASS";
  else if (!notRun && requested.some((item) => item.status === "BLOCKED")) verdict = "BLOCKED";
  report = {
    verdict,
    until: until ?? "all",
    stages: snapshot,
    unprovenStages: STAGES.filter((name) => !wants(name) || snapshot[name].status !== "PASS"),
    scope: until
      ? `scoped diagnostic through ${until}; not journey E certification`
      : "full journey E",
    provenance: prov,
    setupError: setupError ? String(setupError.stack ?? setupError).slice(0, 4_000) : undefined,
    fixtures: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      deviceA: ctx.state.deviceIdA,
      deviceB: ctx.state.deviceIdB,
      managedAutomationId: ctx.state.managedAutomationId,
      slowManagedAutomationId: ctx.state.slowManagedId,
      entitlements: ctx.state.entitlementsRead,
      profileA,
      profileB: ctx.state.profileB,
      provider: "backend development-only mock:// routes; external provider claim BLOCKED",
    },
    race: ctx.state.raceResults,
    findings: ctx.state.findings,
    uiObservations,
    localProvider: localStubStats && {
      providerId: "e2e-personal-stub",
      synthetic: "loopback stub, synthetic key; no real credential or spend",
      baselineConfigSha256: ctx.state.localProvider?.baselineSha256,
      accepted: localStubStats.accepted,
      byMarker: localStubStats.byMarker,
      unauthorized: localStubStats.unauthorized,
      rejected: localStubStats.rejected,
      cap: localStubStats.maxRequests,
    },
  };
  try {
    writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(report, null, 2) + "\n");
    if (process.env.LUMI_AUTOMATION_REPORT)
      writeFileSync(process.env.LUMI_AUTOMATION_REPORT, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(
      join(evidenceDir, "proxy-requests.json"),
      JSON.stringify(ctx.claimProxy?.requestLog() ?? [], null, 1),
    );
    writeFileSync(
      join(evidenceDir, "worker-console.log"),
      String(probe.workerConsole?.(60_000) ?? ""),
    );
    for (const [label, app] of [
      ["A", ctx.appA],
      ["B", ctx.appB],
    ])
      if (app) writeFileSync(join(evidenceDir, `app-${label}-final.log`), app.log.slice(-120_000));
  } catch (error) {
    originalLog(`evidence write failed: ${error}`);
  }
  probe.cleanup();
  originalLog(
    `VERDICT ${verdict}; stages ${STAGES.map((name) => `${name}=${snapshot[name].status}`).join(" ")}`,
  );
  originalLog(`Profile/evidence retained: ${profileA}`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
