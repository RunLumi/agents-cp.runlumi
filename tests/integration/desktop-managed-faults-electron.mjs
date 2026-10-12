// Journey D failure modes through the ACTUAL Electron app (renderer -> Main -> Agent -> Worker ->
// controllable mock:// providers) against a fresh Worker/D1. For each fault the UI turn is started the
// way a user starts it, then D1 is read back:
//   - failure before output (mock://lumi-fail), output then failure (post-output), provider timeout,
//     and a user cancel of a hanging stream through the composer's stop control;
//   - every request becomes terminal, no reservation stays `reserved`, provider attempts stay bounded,
//     and a later ordinary turn still succeeds (recovery) with committed usage attributed to the run.
// No real provider, credential or spend is used; budgets are local fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { createDesktopApp, uiHelpers } from "./lib/lumi-desktop-app.mjs";
import {
  onboardToManagedPolicy,
  reachAccountSection,
  startApprovalWeb,
} from "./lib/lumi-desktop-onboarding.mjs";
import { provisionOrganization, SLOW_ALIAS, SUCCESS_ALIAS } from "./lib/lumi-org-fixture.mjs";
import { readRowsWithRetry } from "./lib/automation-journey-state.mjs";
import { submitManagedTurn } from "./lib/lumi-managed-turn.mjs";
import { observeRunInWeb } from "./lib/web-observation.mjs";

const root = resolve(import.meta.dirname, "../..");
const client = join(root, "integrations/lumi-agents");
const desktop = join(client, "packages/desktop");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
const FAIL_ALIAS = "coding-fail";
const PARTIAL_ALIAS = "coding-partial";
const TIMEOUT_ALIAS = "coding-timeout";
// The Agent retries a retryable managed failure with exponential backoff, at most 10 times
// ("Reconnecting... n/10"), so one turn may issue up to 11 separately reserved requests (F10:
// bounded backoff). The bound and the measured count/duration are recorded, never widened silently.
const MAX_PROVIDER_ATTEMPTS = 11;
const TERMINAL_RUN = ["succeeded", "failed", "cancelled", "timed_out"];
const probe = new SmokeHarness({ name: "Electron managed faults" });
const profile = await mkdtemp(join(tmpdir(), "lumi-managed-faults-"));
const evidence = join(profile, "evidence");
const workspacePath = join(profile, "workspace");
mkdirSync(evidence, { recursive: true });
mkdirSync(workspacePath, { recursive: true });
const assertions = [];
const observations = {};
const pass = (claim) => {
  assertions.push(claim);
  console.log(`PASS ${claim}`);
};
let app;
let web;
let stage = "setup";
let completed = false;
process.on("exit", () => probe.cleanup());

/** Wait for the newest run on `alias` after `since` to become terminal; return it with its requests. */
async function settledRun(orgId, alias, since, { timeout = 900_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const [run] = await readRowsWithRetry(
      probe,
      `SELECT run_id, state, failure_code, device_id, project_id, finished_at FROM runs
        WHERE org_id = '${orgId}' AND model_alias = '${alias}' AND created_at > '${since}'
        ORDER BY created_at DESC LIMIT 1`,
      `run on ${alias}`,
    );
    last = run;
    if (run && TERMINAL_RUN.includes(run.state)) {
      const requests = await readRowsWithRetry(
        probe,
        `SELECT r.request_id, r.response_state, r.error_code, r.device_id, b.status AS reservation,
                b.reserved_minor, b.committed_minor
           FROM inference_requests r LEFT JOIN budget_reservations b ON b.request_id = r.request_id
          WHERE r.run_id = '${run.run_id}' ORDER BY r.started_at`,
        `requests for ${run.run_id}`,
      );
      const usage = await readRowsWithRetry(
        probe,
        `SELECT request_id, run_id, device_id, project_id, actual_cost_minor, budget_decision
           FROM usage_events WHERE run_id = '${run.run_id}'`,
        `usage for ${run.run_id}`,
      );
      return { run, requests, usage };
    }
    await delay(2_000);
  }
  throw new Error(`run on ${alias} never became terminal: ${JSON.stringify(last)}`);
}

function assertSettled(label, { run, requests }, deviceId) {
  assert.equal(run.device_id, deviceId, `${label}: run attributed to the enrolled device`);
  assert.ok(requests.length >= 1, `${label}: at least one provider request`);
  assert.ok(
    requests.length <= MAX_PROVIDER_ATTEMPTS,
    `${label}: bounded provider attempts (${requests.length})`,
  );
  for (const request of requests) {
    assert.ok(
      ["completed", "failed"].includes(request.response_state),
      `${label}: request ${request.request_id} terminal, got ${request.response_state}`,
    );
    assert.notEqual(request.reservation, "reserved", `${label}: reservation settled`);
    assert.equal(request.device_id, deviceId, `${label}: request attributed to the device`);
  }
}

const now = () => new Date().toISOString();
const uiText = (page) => page.evaluate(() => document.body.innerText);

try {
  await probe.setup({ persistEnvVar: "DE2E_FAULTS_PERSIST" });
  const fixtureOrg = await provisionOrganization(probe, {
    slowTimeoutMs: 110_000,
    extraRoutes: [
      {
        alias: FAIL_ALIAS,
        adapterEndpoint: "mock://lumi-fail",
        providerModelId: "mock-fail",
        key: "fail",
        timeoutMs: 5_000,
      },
      {
        alias: PARTIAL_ALIAS,
        adapterEndpoint: "mock://lumi-post-output-failure",
        providerModelId: "mock-post-output-failure",
        key: "partial",
        timeoutMs: 5_000,
      },
      {
        alias: TIMEOUT_ALIAS,
        adapterEndpoint: "mock://lumi-timeout",
        providerModelId: "mock-timeout",
        key: "timeout",
        timeoutMs: 8_000,
      },
    ],
  });
  const { org, projectId, agentId } = fixtureOrg;
  web = await startApprovalWeb({ root, probe });
  app = createDesktopApp({ binary, desktop, probe, profile, workspacePath, name: "faults" });
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

  // Positive control: an ordinary streamed turn renders and commits usage.
  let since = now();
  await submitManagedTurn(page, {
    agentId,
    alias: SUCCESS_ALIAS,
    prompt: `Control ${probe.nonce}`,
  });
  await ui.wait(() => document.body.innerText.includes("Hello from Lumi."), "control reply");
  const success = await settledRun(org.orgId, SUCCESS_ALIAS, since);
  assert.equal(success.run.state, "succeeded");
  assertSettled("control", success, deviceId);
  assert.ok(success.requests.some((request) => request.reservation === "committed"));
  assert.ok(success.usage.length >= 1 && success.usage.every((row) => row.device_id === deviceId));
  observations.control = success;
  pass(
    `positive control: streamed managed turn succeeds; ${success.requests.length} request(s) completed, reservation committed, usage attributed to run/device/project`,
  );

  for (const [label, alias, expectPartial] of [
    ["failure before output", FAIL_ALIAS, false],
    ["output then failure", PARTIAL_ALIAS, true],
    ["provider timeout", TIMEOUT_ALIAS, false],
  ]) {
    since = now();
    await submitManagedTurn(page, { agentId, alias, prompt: `${label} ${probe.nonce}` });
    const result = await settledRun(org.orgId, alias, since);
    assert.notEqual(result.run.state, "succeeded", `${label}: run must not succeed`);
    assertSettled(label, result, deviceId);
    assert.ok(
      result.requests.every((request) => request.response_state === "failed"),
      `${label}: every provider request failed`,
    );
    const text = await uiText(page);
    if (expectPartial)
      assert.ok(text.includes("partial output"), `${label}: partial output rendered`);
    await page.screenshot(join(evidence, `${alias}.png`));
    observations[alias] = {
      ...result,
      attempts: result.requests.length,
      settle_ms: Date.parse(result.run.finished_at) - Date.parse(since),
      ui_excerpt: text.slice(-400),
    };
    pass(
      `${label}: run ${result.run.state} (${result.run.failure_code ?? "no code"}); ${result.requests.length} bounded request(s) failed; reservations ${result.requests.map((r) => r.reservation).join("/")}`,
    );
  }

  // User cancel of a hanging stream through the composer's stop control.
  since = now();
  await submitManagedTurn(page, { agentId, alias: SLOW_ALIAS, prompt: `Cancel ${probe.nonce}` });
  await ui.wait(() => !!document.querySelector('[data-testid="v4-stop"]'), "stop control shown", {
    timeout: 60_000,
  });
  await delay(3_000);
  await ui.clickTestId("v4-stop");
  let cancelled = await settledRun(org.orgId, SLOW_ALIAS, since, { timeout: 120_000 });
  // A downstream disconnect may not drop the Worker stream in local workerd; the Worker's watchdog
  // then settles the request at route deadline (110 s) + grace. Wait for exactly that bound.
  const cancelledAt = Date.now();
  while (
    cancelled.requests.some((request) => !["completed", "failed"].includes(request.response_state))
  ) {
    assert.ok(
      Date.now() - cancelledAt < 240_000,
      "cancel: request settles within deadline + grace",
    );
    await delay(5_000);
    cancelled = await settledRun(org.orgId, SLOW_ALIAS, since, { timeout: 30_000 });
  }
  const cancelSettleMs = Date.now() - cancelledAt;
  assert.ok(
    ["cancelled", "failed"].includes(cancelled.run.state),
    `cancel: run terminal as cancelled/failed, got ${cancelled.run.state}`,
  );
  assertSettled("cancel", cancelled, deviceId);
  await page.screenshot(join(evidence, "cancelled.png"));
  observations.cancel = cancelled;
  pass(
    `user cancel of a hanging stream: run ${cancelled.run.state}; request settled ${cancelSettleMs} ms after the run (watchdog bound); requests ${cancelled.requests.map((r) => r.response_state).join("/")}; reservations ${cancelled.requests.map((r) => r.reservation).join("/")}`,
  );

  // Recovery: the same desktop and session still complete an ordinary turn.
  since = now();
  await reachAccountSection(app, { expectRestoredAccount: true });
  await submitManagedTurn(page, {
    agentId,
    alias: SUCCESS_ALIAS,
    prompt: `Recover ${probe.nonce}`,
  });
  await ui.wait(
    () => document.body.innerText.split("Hello from Lumi.").length > 1,
    "recovery reply",
  );
  const recovered = await settledRun(org.orgId, SUCCESS_ALIAS, since);
  assert.equal(recovered.run.state, "succeeded");
  assertSettled("recovery", recovered, deviceId);
  pass("recovery: a later ordinary managed turn succeeds after every fault");

  // The same desktop run is visible to its owner in the web control plane, and only to them.
  const webClaims = await observeRunInWeb({
    probe,
    web,
    ownerJar: fixtureOrg.fixture,
    org,
    ids: {
      runId: recovered.run.run_id,
      requestId: recovered.requests[0].request_id,
      deviceId,
      projectId,
    },
    evidenceDir: evidence,
  });
  for (const claim of webClaims) pass(claim);

  const stuck = await readRowsWithRetry(
    probe,
    `SELECT COUNT(*) AS n FROM budget_reservations WHERE org_id = '${org.orgId}' AND status = 'reserved'`,
    "no reservation left reserved",
  );
  assert.equal(stuck[0].n, 0);
  pass("no budget reservation remains reserved for the organization");
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
    scope: "journey-d-managed-faults-cancel-settlement-recovery",
    control_plane_sha: git(root, "rev-parse", "HEAD"),
    lumi_agents_sha: git(client, "rev-parse", "HEAD"),
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    desktop_assertions: assertions,
    worker_assertions: probe.passes,
    observations: JSON.parse(probe.redact(JSON.stringify(observations))),
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_FAULTS_REPORT)
    writeFileSync(process.env.LUMI_FAULTS_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
