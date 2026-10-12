// Journey C through the ACTUAL Electron app against a fresh Worker/D1, each claim after its control:
//   - runtime policy enforcement: disabling the org's managed route and raising the device minimum
//     client version each stop new managed execution (no completed request, no usage), and restoring
//     the policy restores execution;
//   - the three frozen credential choices are recorded server-side exactly as chosen, and rollback
//     resets the label to local_credential;
//   - rollback through the UI from every reachable ladder stage (account_optional, device_enrolled,
//     workspace_bound, managed_policy) returns local ownership in D1 and leaves local files intact;
//   - a second workspace opened in the same profile stays local: no binding, no adoption record.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { provisionOrganization, SUCCESS_ALIAS } from "./lib/lumi-org-fixture.mjs";
import { readRowsWithRetry } from "./lib/automation-journey-state.mjs";
import { openManagedControls, submitManagedTurn } from "./lib/lumi-managed-turn.mjs";

const root = resolve(import.meta.dirname, "../..");
const client = join(root, "integrations/lumi-agents");
const desktop = join(client, "packages/desktop");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
const probe = new SmokeHarness({ name: "Electron adoption and policy" });
const profile = await mkdtemp(join(tmpdir(), "lumi-adoption-policy-"));
const evidence = join(profile, "evidence");
const workspacePath = join(profile, "workspace");
const secondWorkspacePath = join(profile, "second-workspace");
for (const dir of [evidence, workspacePath, secondWorkspacePath])
  mkdirSync(dir, { recursive: true });
const sentinel = join(workspacePath, "local-only.txt");
writeFileSync(sentinel, `local content ${Date.now()}\n`);
const sentinelBefore = readFileSync(sentinel, "utf8");
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
  await probe.setup({ persistEnvVar: "DE2E_ADOPTION_PERSIST" });
  const fixtureOrg = await provisionOrganization(probe);
  const { fixture, org, projectId, agentId } = fixtureOrg;
  const rows = (sql, label) => readRowsWithRetry(probe, sql, label);
  const counts = async () =>
    (
      await rows(
        `SELECT (SELECT COUNT(*) FROM usage_events WHERE org_id = '${org.orgId}') AS usage,
                (SELECT COUNT(*) FROM inference_requests WHERE org_id = '${org.orgId}'
                   AND response_state = 'completed') AS completed`,
        "managed counts",
      )
    )[0];
  const adoption = async () =>
    rows(
      `SELECT stage, ownership, credential_mode, reversion_count, external_workspace_key
         FROM workspace_adoption_states WHERE org_id = '${org.orgId}'`,
      "adoption rows",
    );
  const liveBindings = async () =>
    rows(
      `SELECT binding_id, workspace_identity FROM workspace_bindings
        WHERE project_id = '${projectId}' AND removed_at IS NULL`,
      "live bindings",
    );

  web = await startApprovalWeb({ root, probe });
  app = createDesktopApp({ binary, desktop, probe, profile, workspacePath, name: "adoption" });
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
  let page = app.page;
  let ui = uiHelpers(page);

  /** A managed turn that must succeed (control) or be refused with no completed request/usage. */
  async function managedTurn(label, { expect }) {
    const before = await counts();
    const opened = await openManagedControls(page);
    if (opened.state === "ready") {
      await submitManagedTurn(page, {
        agentId,
        alias: SUCCESS_ALIAS,
        prompt: `${label} ${Date.now()}`,
      });
      if (expect === "success") {
        await ui.wait(
          (n) => document.body.innerText.split("Hello from Lumi.").length > n,
          `${label} reply`,
          { arg: 1, timeout: 90_000 },
        );
      } else {
        // Give the refused path time to (not) produce a completed request.
        await delay(20_000);
      }
    } else assert.equal(expect, "refused", `${label}: controls refused ${opened.code}`);
    // Completed requests/usage are written when the stream ends; poll briefly for the control.
    let after = await counts();
    for (let i = 0; expect === "success" && after.completed <= before.completed && i < 15; i++) {
      await delay(2_000);
      after = await counts();
    }
    if (expect === "success") assert.ok(after.completed > before.completed, `${label}: completed`);
    else {
      assert.equal(after.completed, before.completed, `${label}: no completed request`);
      assert.equal(after.usage, before.usage, `${label}: no usage`);
    }
    await reachAccountSection(app, { expectRestoredAccount: true });
    return { before, after, uiState: opened.state, uiCode: opened.code };
  }

  // 1. Runtime policy enforcement, each mutation between two successful controls.
  await managedTurn("control before policy changes", { expect: "success" });
  pass("positive control: managed turn completes under the published policy");
  const policyNow = async () =>
    (await probe.request(fixture, "GET", `/api/v1/orgs/${org.orgId}/policy`)).payload;
  let policy = await policyNow();
  const putPolicy = async (patch, key) => {
    const result = await probe.request(
      fixture,
      "PUT",
      `/api/v1/orgs/${org.orgId}/policy`,
      { ...pickPolicy(policy), ...patch, version: policy.version },
      probe.browserMutation(fixture, key),
    );
    assert.equal(result.status, 200, `policy update ${key}: ${result.text?.slice(0, 200)}`);
    policy = await policyNow();
  };
  await putPolicy({ managed_route_enabled: false }, "disable-managed-route");
  const disabled = await managedTurn("managed route disabled", { expect: "refused" });
  pass(
    `org policy managed_route_enabled=false refuses new managed execution (UI ${disabled.uiState}${disabled.uiCode ? ` ${disabled.uiCode}` : ""}); no completed request or usage`,
  );
  await putPolicy({ managed_route_enabled: true }, "enable-managed-route");
  await managedTurn("control after re-enable", { expect: "success" });
  pass("restoring managed_route_enabled restores managed execution");

  const devicePolicy = async (min, key) => {
    const current = await probe.request(fixture, "GET", `/api/v1/orgs/${org.orgId}/device-policy`);
    const result = await probe.request(
      fixture,
      "PUT",
      `/api/v1/orgs/${org.orgId}/device-policy`,
      { min_client_version: min, version: current.payload?.version ?? 0 },
      probe.browserMutation(fixture, key),
    );
    assert.equal(result.status, 200, `device policy ${key}: ${result.text?.slice(0, 200)}`);
  };
  await devicePolicy("999.0.0", "raise-min-version");
  // P03-CG / P03-CR-001: the floor is enforced at device-token exchange (staged, not a surprise
  // brick). Refresh and policy sync must be refused now; once the current short-lived token is due,
  // the execution seam cannot obtain authority and the managed turn is refused.
  await ui.clickText("Refresh device token");
  await ui.wait(
    () => document.body.innerText.includes("Device action failed"),
    "token refresh refused below minimum version",
  );
  // Policy sync still succeeds: the snapshot carries the floor, and P03-CG enforces it at the
  // token exchange above, not at policy read. The decisive runtime proof follows.

  await probe.d1Execute(
    `UPDATE device_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE device_id = '${deviceId}'`,
    "current device token reaches its expiry",
  );
  const tooOld = await managedTurn("below minimum client version", { expect: "refused" });
  pass(
    `minimum client version above this app: token refresh refused (policy read still carries the floor); once the current token expires the managed turn is refused (UI ${tooOld.uiState}${tooOld.uiCode ? ` ${tooOld.uiCode}` : ""}); no completed request or usage`,
  );
  await devicePolicy(null, "clear-min-version");
  // The expired token cannot refresh itself; the user renews through human-authorized recovery
  // (P03-CR-002) when the app offers it, otherwise through an ordinary refresh.
  const recover = await page.evaluate(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.innerText.trim() === "Approve recovery and renew this device",
    ),
  );
  await ui.clickText(recover ? "Approve recovery and renew this device" : "Refresh device token");
  await delay(3_000);
  await managedTurn("control after clearing minimum version", { expect: "success" });
  pass("clearing the minimum client version lets the device exchange a token and execute again");

  // 2. Credential choices are recorded exactly as chosen.
  for (const mode of ["metadata_only", "org_managed_credential", "local_credential"]) {
    await ui.wait(
      (value) => !!document.querySelector(`input[name="lumi-credential-mode"][value="${value}"]`),
      `credential option ${mode}`,
      { arg: mode },
    );
    await page.evaluate((value) => {
      document.querySelector(`input[name="lumi-credential-mode"][value="${value}"]`).click();
    }, mode);
    await ui.wait(
      () =>
        [...document.querySelectorAll("button")].some(
          (b) => b.innerText.trim() === "Record this choice",
        ),
      "record choice",
    );
    await ui.clickText("Record this choice");
    let row;
    for (let i = 0; i < 15; i++) {
      [row] = await adoption();
      if (row?.credential_mode === mode) break;
      await delay(1_000);
    }
    assert.equal(row?.credential_mode, mode, `credential mode ${mode} recorded`);
  }
  pass("all three frozen credential choices are recorded server-side exactly as chosen in the UI");
  await page.evaluate(() =>
    document.querySelector('input[name="lumi-credential-mode"][value="metadata_only"]').click(),
  );
  await ui.clickText("Record this choice");
  await delay(2_000);

  // 3. Rollback from every reachable stage, highest first.
  const rollback = async (from) => {
    const before = (await adoption())[0];
    const label = await page.evaluate(() =>
      ["Return this workspace to local mode", "Unbind this workspace"].find((text) =>
        [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === text),
      ),
    );
    assert.ok(label, `rollback action visible at ${from}`);
    await ui.clickText(label);
    await ui.wait(
      () => document.body.innerText.includes("Review and bind this workspace"),
      `rollback from ${from}`,
    );
    const [after] = await adoption();
    assert.equal(after.stage, "local_unmanaged", `${from}: stage local`);
    assert.equal(after.ownership, "local_unmanaged", `${from}: ownership local`);
    assert.equal(after.credential_mode, "local_credential", `${from}: label reset`);
    assert.ok(Number(after.reversion_count) > Number(before.reversion_count), `${from}: reversion`);
    assert.equal((await liveBindings()).length, 0, `${from}: no live binding`);
    assert.equal(readFileSync(sentinel, "utf8"), sentinelBefore, `${from}: local file intact`);
  };
  await rollback("managed_policy");
  const ladder = [
    ["Continue: account is optional", "account_optional"],
    ["Continue: device enrolled", "device_enrolled"],
    ["Confirm workspace ownership", "workspace_bound"],
  ];
  for (let reach = 1; reach <= ladder.length; reach++) {
    await ui.clickText("Review and bind this workspace");
    for (const [button, expected] of ladder.slice(0, reach)) {
      await ui.wait(
        (text) =>
          [...document.querySelectorAll("button")].some(
            (b) => b.innerText.trim() === text && !b.disabled,
          ),
        `ladder ${button}`,
        { arg: button },
      );
      await ui.clickText(button);
      let row;
      for (let i = 0; i < 15; i++) {
        [row] = await adoption();
        if (row?.stage === expected) break;
        await delay(1_000);
      }
      assert.equal(row?.stage, expected, `ladder reached ${expected}`);
    }
    await rollback(ladder[reach - 1][1]);
  }
  pass(
    "UI rollback from managed_policy, workspace_bound, device_enrolled and account_optional each returns local ownership, resets the credential label, removes the live binding and leaves local files intact",
  );

  // 4. A second workspace opened later in the same profile stays local.
  const adoptionBefore = await adoption();
  await app.stop();
  const second = createDesktopApp({
    binary,
    desktop,
    probe,
    profile,
    workspacePath: secondWorkspacePath,
    name: "second workspace",
  });
  app = second;
  await app.start();
  page = app.page;
  ui = uiHelpers(page);
  await reachAccountSection(app, { expectRestoredAccount: true });
  await ui.wait(
    () => document.body.innerText.includes("Review and bind this workspace"),
    "second workspace offers explicit binding only",
  );
  const adoptionAfter = await adoption();
  assert.deepEqual(adoptionAfter, adoptionBefore, "opening a second workspace adopts nothing");
  assert.equal((await liveBindings()).length, 0, "second workspace has no binding");
  const devices = await rows(
    `SELECT COUNT(*) AS n FROM devices WHERE org_id = '${org.orgId}'`,
    "device count",
  );
  assert.equal(devices[0].n, 1, "same enrolled device, no re-enrollment");
  void deviceId;
  pass("a second workspace opened with the signed-in account stays local: no adoption, no binding");
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
    scope: "journey-c-policy-enforcement-credential-choices-rollback-all-stages-second-workspace",
    control_plane_sha: git(root, "rev-parse", "HEAD"),
    lumi_agents_sha: git(client, "rev-parse", "HEAD"),
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    desktop_assertions: assertions,
    worker_assertions: probe.passes,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_ADOPTION_REPORT)
    writeFileSync(process.env.LUMI_ADOPTION_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}

/** The writable fields of the org policy, carried forward unchanged except for the patch. */
function pickPolicy(policy) {
  const writable = [
    "allowed_aliases",
    "allowed_models",
    "allowed_providers",
    "credential_mode",
    "managed_route_enabled",
  ];
  return Object.fromEntries(
    writable.filter((key) => key in policy).map((key) => [key, policy[key]]),
  );
}
