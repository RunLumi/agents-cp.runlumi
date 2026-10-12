// Journeys A/B failure paths through the ACTUAL Electron app against a fresh Worker/D1:
//   - cancelled sign-in, completing before approval, an expired device code and a code approved for
//     a different request all leave the desktop signed out with no persisted session;
//   - a real sign-in succeeds (positive control), then server-side session expiry is honoured after a
//     restart: the app does not resurrect the account and offers sign-in again;
//   - device enrollment killed mid-flight resumes after restart without a duplicate device or token.
// Direct D1 writes only administer synthetic fixtures (expiry); every user action goes through the UI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { launch, newPage } from "../../apps/web/scripts/cdp.mjs";
import { createDesktopApp, uiHelpers } from "./lib/lumi-desktop-app.mjs";
import {
  clickWhenReady,
  reachAccountSection,
  startApprovalWeb,
} from "./lib/lumi-desktop-onboarding.mjs";
import { provisionOrganization } from "./lib/lumi-org-fixture.mjs";
import { readRowsWithRetry } from "./lib/automation-journey-state.mjs";

const root = resolve(import.meta.dirname, "../..");
const client = join(root, "integrations/lumi-agents");
const desktop = join(client, "packages/desktop");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
const probe = new SmokeHarness({ name: "Electron account failures" });
const profile = await mkdtemp(join(tmpdir(), "lumi-account-failures-"));
const evidence = join(profile, "evidence");
const workspacePath = join(profile, "workspace");
mkdirSync(evidence, { recursive: true });
mkdirSync(workspacePath, { recursive: true });
const assertions = [];
const pass = (claim) => {
  assertions.push(claim);
  console.log(`PASS ${claim}`);
};
const PAST = "2000-01-01T00:00:00.000Z";
let app;
let web;
let stage = "setup";
let completed = false;
process.on("exit", () => probe.cleanup());

const sessionFiles = () => {
  const vault = join(profile, "userData", "lumi-account");
  return existsSync(vault)
    ? readdirSync(vault).filter((f) => f.startsWith("lumi-session-") && f.endsWith(".json"))
    : [];
};

async function beginSignIn(page) {
  const ui = uiHelpers(page);
  await ui.wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText === "Sign in to Lumi" && !button.disabled,
      ),
    "sign-in available",
  );
  await ui.clickText("Sign in to Lumi");
  await ui.wait(() => document.body.innerText.includes("Match this code"), "PKCE started");
  return page.evaluate(
    () =>
      document
        .querySelector("#lumi-account-heading")
        .parentElement.querySelector(".tracking-widest").innerText,
  );
}

/** Approve `code` in a real browser as the fixture user; returns the page's final text. */
async function approveInBrowser(fixtureOrg, code, { expectApproved = true } = {}) {
  const chrome = await launch({ port: await probe.availablePort(), headless: true });
  try {
    const browser = await newPage(chrome);
    await browser.goto(`http://127.0.0.1:${web.port}/desktop?user_code=${code}`);
    const ui = uiHelpers(browser);
    await ui.wait(() => !!document.querySelector('input[type="password"]'), "browser login");
    await browser.evaluate(
      (account, secret) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        for (const [type, value] of [
          ["email", account],
          ["password", secret],
        ]) {
          const element = document.querySelector(`input[type="${type}"]`);
          setter.call(element, value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
        }
      },
      fixtureOrg.email,
      fixtureOrg.password,
    );
    await ui.clickText("Sign in with password");
    await ui.wait(() => !!document.querySelector("#desktop-code"), "approval form");
    await browser.evaluate(() => document.querySelector('button[type="submit"]').click());
    await ui.wait(
      () =>
        document.body.innerText.includes("Desktop sign-in approved.") ||
        !!document.querySelector('[role="alert"]'),
      "approval outcome",
    );
    const text = await browser.evaluate(() => document.body.innerText);
    assert.equal(text.includes("Desktop sign-in approved."), expectApproved, text.slice(0, 300));
    return text;
  } finally {
    await chrome.close();
  }
}

const authorizationStates = () =>
  readRowsWithRetry(
    probe,
    "SELECT status, COUNT(*) AS n FROM device_authorizations GROUP BY status ORDER BY status",
    "device authorization states",
  );

try {
  await probe.setup({ persistEnvVar: "DE2E_ACCOUNT_FAILURES_PERSIST" });
  const fixtureOrg = await provisionOrganization(probe);
  const { org } = fixtureOrg;
  web = await startApprovalWeb({ root, probe });
  app = createDesktopApp({ binary, desktop, probe, profile, workspacePath, name: "failures" });
  stage = "runtime";
  await app.start();
  await reachAccountSection(app);
  let page = app.page;
  let ui = uiHelpers(page);

  // 1. Cancel in the desktop: no approval, no session.
  await beginSignIn(page);
  await ui.clickText("Cancel");
  await ui.wait(() => document.body.innerText.includes("Sign in to Lumi"), "cancelled sign-in");
  assert.equal(sessionFiles().length, 0);
  pass("cancelled sign-in returns to signed-out with no persisted session");

  // 2. Completing before browser approval is refused and leaves no session.
  await beginSignIn(page);
  await ui.clickText("I approved — complete sign-in");
  await ui.wait(
    () =>
      !!document.querySelector('[role="alert"]') || /lumi_[a-z_]+/.test(document.body.innerText),
    "unapproved completion refused",
  );
  assert.equal(sessionFiles().length, 0);
  assert.equal(
    await page.evaluate(() => document.body.innerText.includes("Sign out of Lumi")),
    false,
  );
  pass("completing before browser approval is refused; no session persisted");
  await ui.clickText("Cancel").catch(() => {});

  // 3. An expired device code cannot be approved or exchanged.
  const expiredCode = await beginSignIn(page);
  await probe.d1Execute(
    `UPDATE device_authorizations SET expires_at = '${PAST}' WHERE status = 'pending'`,
    "expire pending device codes",
  );
  await approveInBrowser(fixtureOrg, expiredCode, { expectApproved: false });
  await ui.clickText("I approved — complete sign-in");
  await ui.wait(
    () =>
      !!document.querySelector('[role="alert"]') || /lumi_[a-z_]+/.test(document.body.innerText),
    "expired completion refused",
  );
  assert.equal(sessionFiles().length, 0);
  pass("an expired device code is refused in the browser and at completion; no session");
  await ui.clickText("Cancel").catch(() => {});

  // 4. A code approved for a different request does not authorize this desktop.
  await beginSignIn(page);
  await approveInBrowser(fixtureOrg, "ZZZZ9999", { expectApproved: false });
  await ui.clickText("I approved — complete sign-in");
  await ui.wait(
    () =>
      !!document.querySelector('[role="alert"]') || /lumi_[a-z_]+/.test(document.body.innerText),
    "wrong-code completion refused",
  );
  assert.equal(sessionFiles().length, 0);
  pass("approving a code that is not this desktop's request does not sign it in");
  await ui.clickText("Cancel").catch(() => {});
  const statesBefore = await authorizationStates();
  assert.ok(!statesBefore.some((row) => row.status === "consumed"), JSON.stringify(statesBefore));

  // 5. Positive control: a real sign-in succeeds and persists one OS-encrypted session.
  const code = await beginSignIn(page);
  await approveInBrowser(fixtureOrg, code);
  await ui.clickText("I approved — complete sign-in");
  await ui.wait(() => document.body.innerText.includes("Sign out of Lumi"), "signed in");
  assert.equal(sessionFiles().length, 1);
  pass("positive control: approved sign-in succeeds and persists exactly one session");

  // 6. Enrollment interrupted by a hard kill resumes without duplicates.
  await ui.wait(
    () => document.body.innerText.includes("Confirm and enroll this device"),
    "enrollment UI",
  );
  await clickWhenReady(page, "Confirm and enroll this device");
  await delay(150);
  await app.stop({ hard: true });
  const enrollmentsAtKill = await readRowsWithRetry(
    probe,
    `SELECT status, COUNT(*) AS n FROM device_enrollments WHERE org_id = '${org.orgId}' GROUP BY status`,
    "enrollment rows at kill",
  );
  await app.start();
  await reachAccountSection(app, { expectRestoredAccount: true });
  page = app.page;
  ui = uiHelpers(page);
  await ui.wait(
    () =>
      document.body.innerText.includes("Sync policy") ||
      document.body.innerText.includes("Resume device enrollment") ||
      document.body.innerText.includes("Confirm and enroll this device"),
    "enrollment state after restart",
    { timeout: 60_000 },
  );
  const afterKill = await page.evaluate(() => document.body.innerText);
  if (afterKill.includes("Resume device enrollment"))
    await clickWhenReady(page, "Resume device enrollment");
  else if (afterKill.includes("Confirm and enroll this device"))
    await clickWhenReady(page, "Confirm and enroll this device");
  await ui.wait(() => document.body.innerText.includes("Sync policy"), "enrollment completes", {
    timeout: 60_000,
  });
  const devices = await readRowsWithRetry(
    probe,
    `SELECT device_id, status FROM devices WHERE org_id = '${org.orgId}'`,
    "devices after resumed enrollment",
  );
  assert.equal(devices.length, 1, `one device after resume: ${JSON.stringify(devices)}`);
  assert.equal(devices[0].status, "active");
  const tokens = await readRowsWithRetry(
    probe,
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id = '${devices[0].device_id}'`,
    "device tokens after resume",
  );
  assert.equal(tokens[0].n, 1, "exactly one live device token after resume");
  pass(
    `enrollment killed mid-flight (D1 at kill: ${JSON.stringify(enrollmentsAtKill)}) resumes after restart with one active device and one token`,
  );

  // 7. Server-side session expiry is honoured across a restart.
  await probe.d1Execute(
    `UPDATE login_sessions SET expires_at = '${PAST}' WHERE revoked_at IS NULL`,
    "expire live login sessions",
  );
  await app.stop();
  await app.start();
  page = app.page;
  ui = uiHelpers(page);
  await reachAccountSection(app);
  await ui.wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText === "Sign in to Lumi",
      ),
    "expired session requires sign-in",
    { timeout: 60_000 },
  );
  assert.equal(
    await page.evaluate(() => document.body.innerText.includes("Sign out of Lumi")),
    false,
  );
  await page.screenshot(join(evidence, "expired-session.png"));
  pass(
    "after server-side session expiry a restart does not resurrect the account; sign-in offered",
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
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const report = {
    verdict: completed ? "PASS" : stage === "runtime" ? "FAIL" : "BLOCKED",
    scope: "journeys-a-b-account-failure-paths-expiry-interrupted-enrollment",
    control_plane_sha: git(root, "rev-parse", "HEAD"),
    lumi_agents_sha: git(client, "rev-parse", "HEAD"),
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    desktop_assertions: assertions,
    worker_assertions: probe.passes,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_ACCOUNT_FAILURES_REPORT)
    writeFileSync(process.env.LUMI_ACCOUNT_FAILURES_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
