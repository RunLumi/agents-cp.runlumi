import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import {
  isolatedChildEnv,
  nativeKeystoreArgs,
  prepareIsolatedHome,
} from "./lib/lumi-child-env.mjs";
import { confirmRevokedInUi } from "./lib/lumi-device-revoked.mjs";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { launch, newPage, connect, attachPage } from "../../apps/web/scripts/cdp.mjs";
import {
  TOOL_ALIAS,
  MOCK_WRITE_CONTENT,
  buildWriteIdentity,
  provisionToolRoute,
  provisionToolPlane,
  fixtureTarget,
  toolPrompt,
  waitForRun,
  waitForPendingApproval,
  resolveApproval,
} from "./lib/electron-tool-flow.mjs";
const root = resolve(import.meta.dirname, "../.."),
  client = join(root, "integrations/lumi-agents"),
  desktop = join(client, "packages/desktop");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
assert.ok(existsSync(binary), "prepare pinned Electron");
assert.ok(existsSync(join(desktop, "out/main/index.js")), "build desktop");
const profile = await mkdtemp(join(tmpdir(), "lumi-electron-account-"));
for (const n of ["userData", "session", "evidence"])
  mkdirSync(join(profile, n), { recursive: true });
prepareIsolatedHome(profile);
const workspacePath = join(profile, "workspace");
mkdirSync(workspacePath, { recursive: true });
const localSentinelPath = join(workspacePath, "local-only.txt");
writeFileSync(localSentinelPath, "local prompt and files stay local\n");
const localSentinelBefore = readFileSync(localSentinelPath, "utf8");
const probe = new SmokeHarness({ name: "Electron account" });
const desktopAssertions = [];
const observationRetries = [];
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("PASS "))
    desktopAssertions.push(args[0].slice(5));
  originalConsoleLog(...args);
};
let stage = "setup";
let completed = false;
let app,
  chrome,
  cdp,
  vite,
  appLog = "";
process.on("exit", () => {
  probe.cleanup();
  if (app?.pid)
    try {
      process.kill(-app.pid, "SIGKILL");
    } catch {}
});
async function wait(page, fn, label) {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(fn)) return;
    await delay(200);
  }
  const alert = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"]')]
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" | "),
  );
  throw new Error(`UI timeout: ${label}${alert ? `; alert=${alert.slice(0, 240)}` : ""}`);
}
async function click(page, label) {
  await page.evaluate((label) => {
    const el = [...document.querySelectorAll("button")].find(
      (x) => x.innerText.trim() === label || x.getAttribute("aria-label") === label,
    );
    if (!el) throw new Error("missing UI action");
    el.click();
  }, label);
  await delay(500);
}
async function stop() {
  cdp?.socket.close();
  if (app?.pid) {
    const exited = new Promise((r) => app.once("exit", r));
    app.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    try {
      process.kill(-app.pid, "SIGKILL");
    } catch {}
  }
  app = undefined;
}
async function start({ expectRestoredAccount = false } = {}) {
  const port = await probe.availablePort();
  app = spawn(
    binary,
    [
      desktop,
      `--open-workspace=${workspacePath}`,
      `--remote-debugging-port=${port}`,
      ...nativeKeystoreArgs(),
    ],
    {
      detached: true,
      // Main keeps the OS HOME (native keystore); Host/Agent HOME and app data roots are profile-owned.
      env: isolatedChildEnv(profile, {
        ZCODE_DESKTOP_APPLICATION_NAME: "Lumi Account E2E",
        LUMI_CONTROL_PLANE_ORIGIN: probe.baseUrl,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const pipe of [app.stdout, app.stderr])
    pipe.on("data", (d) => {
      appLog += d;
    });
  let version;
  for (let i = 0; i < 150; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {}
    await delay(200);
  }
  assert.ok(version, "Electron CDP");
  cdp = await connect(version.webSocketDebuggerUrl);
  let target;
  for (let i = 0; i < 150; i++) {
    target = (await cdp.send("Target.getTargets")).targetInfos.find(
      (x) => x.type === "page" && x.url.includes("/renderer/index.html"),
    );
    if (target) break;
    await delay(200);
  }
  assert.ok(target, "actual app renderer");
  const page = await attachPage(cdp, target.targetId);
  await wait(
    page,
    () =>
      document.body.innerText.includes("Connect") ||
      document.body.innerText.includes("Cancel") ||
      document.body.innerText.includes("Continue locally"),
    "initial UI",
  );
  for (let i = 0; i < 12; i++) {
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes("Continue locally")) {
      assert.equal(
        expectRestoredAccount,
        false,
        "restored Lumi session must not reopen startup entry",
      );
      assert.ok(body.includes("Welcome to Lumi Agents"), "Lumi is the startup identity");
      const legacyLogin = await page.evaluate(() =>
        [...document.querySelectorAll("button")].some((button) =>
          /sign in.*(z\.ai|bigmodel)|log in.*(z\.ai|bigmodel)/i.test(button.innerText),
        ),
      );
      assert.equal(legacyLogin, false, "legacy provider login choices are hidden at startup");
      await page.screenshot(join(profile, "evidence", "lumi-first-startup.png"));
      await page.setViewport(320, 720);
      await delay(250);
      const narrow = await page.evaluate(() => ({
        viewport: innerWidth,
        content: document.documentElement.scrollWidth,
        local: [...document.querySelectorAll("button")].some(
          (button) => button.innerText.trim() === "Continue locally",
        ),
      }));
      assert.ok(narrow.content <= narrow.viewport, "320px Lumi startup has no horizontal overflow");
      assert.equal(narrow.local, true);
      await page.screenshot(join(profile, "evidence", "lumi-first-startup-narrow.png"));
      await page.press("Tab");
      const focus = await page.evaluate(() => ({
        interactive:
          document.activeElement instanceof HTMLButtonElement ||
          document.activeElement instanceof HTMLInputElement,
        visible: document.activeElement?.matches(":focus-visible") ?? false,
        shadow: document.activeElement
          ? getComputedStyle(document.activeElement).boxShadow
          : "none",
      }));
      assert.equal(focus.interactive, true, "startup alternatives remain keyboard reachable");
      assert.equal(focus.visible, true, "real Tab preserves visible focus");
      assert.notEqual(focus.shadow, "none", "focused startup action has a rendered ring");
      await page.screenshot(join(profile, "evidence", "lumi-first-startup-focus.png"));
      await page.setViewport(1200, 800);
      await click(page, "Continue locally");
      console.log(
        "PASS actual Lumi-first startup offers explicit local continuation without provider login",
      );
    } else if (body.includes("Waiting for")) await click(page, "Cancel");
    else if (body.includes("Use API key")) await click(page, "Use API key");
    else if (body.includes("Skip for now")) await click(page, "Skip for now");
    else if (await page.evaluate(() => !!document.querySelector('[aria-label="Exit onboarding"]')))
      await click(page, "Exit onboarding");
    else if (await page.evaluate(() => !!document.querySelector('[aria-label="Settings"]'))) break;
    else await delay(500);
  }
  await wait(page, () => !!document.querySelector('[aria-label="Settings"]'), "local shell");
  await click(page, "Settings");
  await wait(page, () => !!document.querySelector('[aria-label="General"]'), "settings nav");
  await click(page, "General");
  await wait(
    page,
    () => document.body.innerText.includes("Lumi organization account"),
    "account section",
  );
  return page;
}
try {
  await probe.setup({ persistEnvVar: "DE2E_ELECTRON_PERSIST", portEnvVar: "DE2E_ELECTRON_PORT" });
  stage = "runtime";
  const fixture = probe.client(),
    email = `electron-${probe.nonce}@example.com`,
    password = `Lumi-e2e-${randomBytes(18).toString("hex")}!`;
  probe.registerSecret(password);
  const signup = await probe.request(fixture, "POST", "/api/v1/auth/password/signup", {
    email,
    display_name: "Electron Account",
    password,
  });
  assert.equal(signup.status, 200);
  const v = signup.payload.verification;
  probe.registerSecret(v.development_code);
  assert.equal(
    (
      await probe.request(fixture, "POST", "/api/v1/auth/verify-email", {
        challenge_id: v.challenge_id,
        code: v.development_code,
      })
    ).status,
    200,
  );
  const org = await probe.createOrganization(
    fixture,
    "Electron Device Org",
    `electron-org-${probe.nonce}`,
  );
  const projectResult = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    {
      name: "Electron Workspace Project",
      slug: `project-${probe.nonce.slice(0, 18)}`,
      visibility: "org",
    },
    probe.browserMutation(fixture, "electron-workspace-project"),
  );
  probe.expectStatus("create disposable Electron workspace project", projectResult, 201);
  const projectId = projectResult.payload?.id ?? projectResult.payload?.project?.id;
  assert.match(projectId, /^prj_[0-9a-f]{32}$/);
  const catalog = await probe.request(fixture, "GET", `/api/v1/orgs/${org.orgId}/catalog`);
  probe.expectStatus("read P04 catalog for Electron managed run", catalog, 200);
  const providerResult = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/catalog/providers`,
    {
      provider_key: "electron-mock",
      display_name: "Electron managed mock provider",
      adapter: "mock",
      endpoint_url: "mock://lumi-success",
    },
    probe.browserMutation(fixture, "electron-managed-provider"),
  );
  probe.expectStatus("create organization-owned controllable provider", providerResult, 201);
  const provider = providerResult.payload?.provider;
  assert.match(provider?.provider_id, /^prv_[0-9a-f]{32}$/);
  const modelResult = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/catalog/models`,
    {
      provider_id: provider.provider_id,
      provider_model_id: "mock-success",
      display_name: "Electron managed mock model",
      capabilities: ["text", "tools"],
      // The real Desktop Agent sends its system/tool catalog, not only the test
      // prompt. Keep this mock route above that bounded fixture payload so the
      // integration exercises dispatch instead of failing model-capability preflight.
      max_input_tokens: 1_000_000,
      max_output_tokens: 8_192,
      pricing_version: "electron-e2e-v1",
    },
    probe.browserMutation(fixture, "electron-managed-model"),
  );
  probe.expectStatus(
    "create tool-capable mock model with an Agent-sized context",
    modelResult,
    201,
  );
  const model = modelResult.payload?.model;
  assert.match(model?.model_id, /^mdl_[0-9a-f]{32}$/);
  const mockCredential = `electron-${probe.nonce}-mock-credential`;
  probe.registerSecret(mockCredential);
  const credentialResult = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/credentials`,
    {
      provider_id: provider.provider_id,
      owner_type: "organization",
      label: "Electron managed mock provider",
      secret: mockCredential,
    },
    probe.browserMutation(fixture, "electron-managed-credential"),
  );
  probe.expectStatus("create controllable managed provider credential", credentialResult, 201);
  const credentialId = credentialResult.payload?.credential?.credential_id;
  assert.match(credentialId, /^cred_[0-9a-f]{32}$/);
  const routeConfig = {
    strategy: "fixed",
    candidates: [
      {
        provider_id: provider.provider_id,
        model_id: model.model_id,
        weight: 100,
        timeout_ms: 5000,
        max_retries: 0,
        credential_id: credentialId,
      },
    ],
  };
  const routeResult = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/routes`,
    {
      alias: "coding-default",
      display_name: "Electron managed mock",
      strategy: "fixed",
      config: routeConfig,
    },
    probe.browserMutation(fixture, "electron-managed-route"),
  );
  probe.expectStatus("create Electron managed route", routeResult, 201);
  const routeId = routeResult.payload?.route?.route_id;
  assert.match(routeId, /^rte_[0-9a-f]{32}$/);
  const routePublish = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/routes/${routeId}/publish`,
    { version: routeResult.payload?.route?.version, config: routeConfig },
    probe.browserMutation(fixture, "electron-managed-route-publish"),
  );
  probe.expectStatus("publish Electron managed route", routePublish, 200);
  // The model-driven tool flow needs the exact descriptor the real Core registry
  // derives for the built-in Write tool, and a development-only controlled
  // provider route that emits a tool call chosen from the tools it is offered.
  const writeIdentity = await buildWriteIdentity(
    root,
    join(profile, "evidence", "write-tool-identity"),
  );
  const toolRoute = await provisionToolRoute({ probe, fixture, orgId: org.orgId });
  const currentPolicy = await probe.request(fixture, "GET", `/api/v1/orgs/${org.orgId}/policy`);
  probe.expectStatus("read Electron organization policy", currentPolicy, 200);
  const enabledPolicy = await probe.request(
    fixture,
    "PUT",
    `/api/v1/orgs/${org.orgId}/policy`,
    {
      allowed_aliases: ["coding-default", TOOL_ALIAS],
      allowed_models: [model.model_id, toolRoute.modelId],
      allowed_providers: [provider.provider_id, toolRoute.providerId],
      credential_mode: "organization_only",
      managed_route_enabled: true,
      version: currentPolicy.payload?.version ?? 0,
    },
    probe.browserMutation(fixture, "electron-managed-policy"),
  );
  probe.expectStatus("enable Electron managed policy", enabledPolicy, 200);
  const agentResult = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/agents`,
    {
      name: "Electron managed test agent",
      project_id: projectId,
      default_model_alias: "coding-default",
    },
    probe.browserMutation(fixture, "electron-managed-agent"),
  );
  probe.expectStatus("create project-approved managed agent", agentResult, 201);
  const agentId = agentResult.payload?.id;
  assert.match(agentId, /^agd_[0-9a-f]{32}$/);
  const toolPlane = await provisionToolPlane({
    probe,
    fixture,
    orgId: org.orgId,
    projectId,
    identity: writeIdentity,
  });
  const budgetResult = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/budgets`,
    {
      scope_type: "organization",
      period_start: new Date(Date.now() - 3_600_000).toISOString(),
      period_end: new Date(Date.now() + 86_400_000).toISOString(),
      // Reservation is one unit per estimated token; the real Agent sends its
      // bounded system/tool catalogue in addition to the short UI prompt.
      limit_minor: 100_000,
      currency: "USD",
      hard: true,
    },
    probe.browserMutation(fixture, "electron-managed-budget"),
  );
  probe.expectStatus("create bounded Electron managed budget", budgetResult, 201);
  const requireWeb = createRequire(join(root, "apps/web/package.json")),
    { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href),
    webPort = await probe.availablePort();
  vite = await createServer({
    root: join(root, "apps/web"),
    configFile: join(root, "apps/web/vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: webPort,
      proxy: { "/api": { target: probe.baseUrl, changeOrigin: true } },
    },
  });
  await vite.listen();
  let page = await start();
  await wait(
    page,
    () =>
      [...document.querySelectorAll("button")].some(
        (x) => x.innerText === "Sign in to Lumi" && !x.disabled,
      ),
    "restore settled",
  );
  await click(page, "Sign in to Lumi");
  await wait(page, () => document.body.innerText.includes("Match this code"), "PKCE started");
  const code = await page.evaluate(
    () =>
      document
        .querySelector("#lumi-account-heading")
        .parentElement.querySelector(".tracking-widest").innerText,
  );
  assert.match(code, /^[A-Z0-9]{8}$/);
  console.log("PASS actual Electron UI begins PKCE");
  chrome = await launch({ port: await probe.availablePort(), headless: true });
  const browserPage = await newPage(chrome);
  await browserPage.goto(`http://127.0.0.1:${webPort}/desktop?user_code=${code}`);
  await wait(
    browserPage,
    () => !!document.querySelector('input[type="password"]'),
    "browser login",
  );
  await browserPage.evaluate(
    (email, password) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      for (const [type, value] of [
        ["email", email],
        ["password", password],
      ]) {
        const el = document.querySelector(`input[type="${type}"]`);
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    email,
    password,
  );
  await click(browserPage, "Sign in with password");
  await wait(browserPage, () => !!document.querySelector("#desktop-code"), "approval");
  await browserPage.evaluate(() => document.querySelector('button[type="submit"]').focus());
  await browserPage.press("Enter");
  await wait(
    browserPage,
    () => document.body.innerText.includes("Desktop sign-in approved."),
    "approved",
  );
  await click(page, "I approved — complete sign-in");
  await wait(
    page,
    () => document.body.innerText.includes("Electron Account"),
    "desktop authenticated",
  );
  await page.screenshot(join(profile, "evidence", "authenticated.png"));
  console.log("PASS Electron IPC/Worker login after real browser approval");
  await wait(
    page,
    () => document.body.innerText.includes("Confirm and enroll this device"),
    "enrollment UI",
  );
  await click(page, "Confirm and enroll this device");
  await wait(page, () => document.body.innerText.includes("Sync policy"), "enrollment completes");
  const deviceId = await page.evaluate(
    () =>
      document
        .querySelector("#lumi-account-heading")
        .parentElement.innerText.match(/dvc_[0-9a-f]{32}/)?.[0],
  );
  assert.match(deviceId, /^dvc_[0-9a-f]{32}$/);
  const stored = await probe.d1Rows(
    `SELECT org_id,status FROM devices WHERE device_id = '${deviceId}'`,
    "enrolled device",
  );
  assert.equal(stored[0].org_id, org.orgId);
  assert.equal(stored[0].status, "active");
  await click(page, "Refresh device token");
  await wait(
    page,
    () =>
      ![...document.querySelectorAll("button")].find((x) => x.innerText === "Refresh device token")
        ?.disabled,
    "refresh complete",
  );
  assert.equal(
    await page.evaluate(() => document.body.innerText.includes("Device action failed")),
    false,
  );
  console.log("PASS Electron enrollment/proof/policy/refresh; D1 active device");
  await wait(
    page,
    () => document.body.innerText.includes("Review and bind this workspace"),
    "workspace adoption controls",
  );
  await wait(
    page,
    () => document.querySelectorAll("#lumi-workspace-project option").length > 1,
    "project options loaded",
  );
  const selectedProject = await page.evaluate((id) => {
    const select = document.querySelector("#lumi-workspace-project");
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, id);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value === id;
  }, projectId);
  assert.equal(selectedProject, true);
  await page.screenshot(join(profile, "evidence", "workspace-selection.png"));
  await wait(
    page,
    () =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.innerText.trim() === "Review and bind this workspace" && !button.disabled,
      ),
    "workspace binding consent ready",
  );
  await click(page, "Review and bind this workspace");
  await wait(
    page,
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText.trim() === "Continue: account is optional" && !button.disabled,
      ),
    "P08 stage 0",
  );
  await page.screenshot(join(profile, "evidence", "workspace-bound-local-stage.png"));
  const bindingRows = await probe.d1Rows(
    `SELECT binding_id, project_id, workspace_identity, display_name FROM workspace_bindings WHERE device_id = '${deviceId}' AND project_id = '${projectId}'`,
    "read back exact P03 workspace binding",
  );
  assert.equal(bindingRows.length, 1);
  assert.match(bindingRows[0].workspace_identity, /^[a-f0-9]{64}$/);
  assert.equal(bindingRows[0].workspace_identity.includes(workspacePath), false);
  assert.equal(bindingRows[0].display_name, "workspace");
  const p08Row = async () =>
    probe.d1Rows(
      `SELECT adoption_state_id, stage, ownership, external_workspace_key, reversion_count FROM workspace_adoption_states WHERE org_id = '${org.orgId}' AND external_workspace_key = '${bindingRows[0]?.workspace_identity}'`,
      "read back Electron adoption state",
    );
  await click(page, "Continue: account is optional");
  await wait(
    page,
    () => document.body.innerText.includes("Continue: device enrolled"),
    "P08 account stage",
  );
  await click(page, "Continue: device enrolled");
  await wait(
    page,
    () => document.body.innerText.includes("Confirm workspace ownership"),
    "P08 device stage",
  );
  await click(page, "Confirm workspace ownership");
  await wait(
    page,
    () => document.body.innerText.includes("Organization-managed"),
    "P08 workspace-bound stage",
  );
  let adoptionRows = await p08Row();
  assert.equal(adoptionRows.length, 1);
  assert.equal(adoptionRows[0].stage, "workspace_bound");
  assert.equal(adoptionRows[0].ownership, "org_managed");
  assert.equal(adoptionRows[0].external_workspace_key, bindingRows[0].workspace_identity);
  assert.equal(readFileSync(localSentinelPath, "utf8"), localSentinelBefore);
  await wait(
    page,
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText.trim() === "Apply managed policy" && !button.disabled,
      ),
    "P08 managed policy confirmation ready",
  );
  await click(page, "Apply managed policy");
  await wait(
    page,
    () =>
      document.body.innerText.includes("Run with managed policy") &&
      document.querySelectorAll("#lumi-managed-agent option").length > 1 &&
      document.querySelectorAll("#lumi-managed-model option").length > 1,
    "managed run controls with server-owned options",
  );
  const selectedManagedOptions = await page.evaluate(
    (input) => {
      const setSelect = (selector, value) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLSelectElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return element.value === value;
      };
      return (
        setSelect("#lumi-managed-agent", input.agentId) &&
        setSelect("#lumi-managed-model", "coding-default")
      );
    },
    { agentId },
  );
  assert.equal(selectedManagedOptions, true);
  const managedPrompt = `Reply with the mock provider response. E2E ${probe.nonce}`;
  await page.evaluate((value) => {
    const textarea = document.querySelector("#lumi-managed-prompt");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("missing managed prompt input");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }, managedPrompt);
  await wait(
    page,
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText.trim() === "Run with managed policy" && !button.disabled,
      ),
    "managed request action enabled",
  );
  await click(page, "Run with managed policy");
  await wait(
    page,
    () => document.body.innerText.includes("Hello from Lumi."),
    "managed response rendered",
  );
  console.log(
    "PASS actual Electron task sends one confirmed managed turn and renders streamed provider output",
  );
  await page.screenshot(join(profile, "evidence", "managed-run-response.png"));
  const managedRunRows = await probe.d1Rows(
    `SELECT run_id, org_id, project_id, agent_session_id, device_id, agent_definition_id, model_alias, state, request_id FROM runs WHERE org_id = '${org.orgId}' AND project_id = '${projectId}' AND agent_definition_id = '${agentId}' ORDER BY created_at DESC LIMIT 1`,
    "read back Electron managed run terminal state",
  );
  assert.equal(managedRunRows.length, 1);
  const managedRun = managedRunRows[0];
  assert.equal(managedRun.state, "succeeded");
  assert.equal(managedRun.model_alias, "coding-default");
  assert.equal(managedRun.device_id, deviceId);
  assert.equal(managedRun.project_id, projectId);
  const inferenceRows = await probe.d1Rows(
    `SELECT request_id, org_id, project_id, run_id, principal_user_id, session_id, agent_session_id, device_id, model_alias, response_state FROM inference_requests WHERE run_id = '${managedRun.run_id}' ORDER BY started_at DESC LIMIT 5`,
    "read back P04 request for Electron managed run",
  );
  assert.ok(inferenceRows.length >= 1);
  assert.equal(inferenceRows[0].org_id, org.orgId);
  assert.equal(inferenceRows[0].project_id, projectId);
  assert.equal(inferenceRows[0].run_id, managedRun.run_id);
  assert.match(inferenceRows[0].session_id, /^ses_[0-9a-f]{32}$/);
  assert.equal(inferenceRows[0].agent_session_id, managedRun.agent_session_id);
  assert.equal(inferenceRows[0].device_id, deviceId);
  assert.equal(inferenceRows[0].model_alias, "coding-default");
  assert.equal(inferenceRows[0].response_state, "completed");
  assert.equal(JSON.stringify(inferenceRows).includes(managedPrompt), false);
  const managedUsageRows = await probe.d1Rows(
    `SELECT request_id, org_id, project_id, run_id, device_id FROM usage_events WHERE run_id = '${managedRun.run_id}' LIMIT 5`,
    "read back usage attribution for Electron managed run",
  );
  assert.ok(managedUsageRows.length >= 1);
  assert.equal(managedUsageRows[0].org_id, org.orgId);
  assert.equal(managedUsageRows[0].project_id, projectId);
  assert.equal(managedUsageRows[0].device_id, deviceId);
  assert.equal(JSON.stringify(managedUsageRows).includes(managedPrompt), false);
  const closedManagedSessionRows = await probe.waitForD1(
    "managed P05 session closes after its one-shot run",
    `SELECT lifecycle FROM agent_sessions WHERE agent_session_id = '${managedRun.agent_session_id}'`,
    (rows) => rows.length === 1 && rows[0].lifecycle === "closed",
    20_000,
  );
  assert.equal(closedManagedSessionRows[0].lifecycle, "closed");
  // Scan every text column in ordinary accounting/audit tables, not merely the
  // selected attribution projection. Return counts only; no secret/content rows.
  const promptLiteral = "'" + managedPrompt.replaceAll("'", "''") + "'";
  for (const table of [
    "inference_requests",
    "usage_events",
    "runs",
    "run_events",
    "security_events",
    "outbox_events",
  ]) {
    const columns = await probe.d1Rows(
      `PRAGMA table_info(${table})`,
      `inspect ${table} content boundary`,
    );
    const textColumns = columns
      .filter((column) => /TEXT/i.test(column.type))
      .map((column) => column.name);
    assert.ok(textColumns.length > 0);
    assert.ok(textColumns.every((name) => /^[a-z_][a-z0-9_]*$/.test(name)));
    const sql = `SELECT COUNT(*) AS n FROM ${table} WHERE ${textColumns.map((name) => `instr(COALESCE(${name}, ''), ${promptLiteral}) > 0`).join(" OR ")}`;
    let matches;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        matches = await probe.d1Rows(sql, `verify raw prompt absence in ${table}`);
        break;
      } catch (error) {
        if (attempt === 3 || !/internal error; reference\s*=/.test(String(error?.message)))
          throw error;
        observationRetries.push({ table, attempt, reason: "local_d1_internal_error" });
        await delay(500 * attempt);
      }
    }
    assert.ok(matches, "disclosure query must return real stored-state evidence");
    assert.equal(matches[0].n, 0, `raw prompt found in ${table}`);
  }
  console.log(
    "PASS Worker D1 attributes request/usage, closes the one-shot P05 session, and stores no prompt text",
  );
  console.log(
    "PASS actual Electron UI binds only the selected opaque workspace and preserves local data",
  );
  // Model-driven built-in Write, once approved and once denied. The model turn is
  // the development-only controlled provider (real gateway transport); everything
  // after it is the real Agent: registry descriptor -> Core -> Host -> Main ->
  // Worker catalog/claim/approval -> real file handler -> stored result and audit.
  let localAllowClicks = 0;
  async function runManagedTool(label, decision) {
    const target = fixtureTarget(workspacePath, label, probe.nonce);
    assert.equal(existsSync(target), false);
    // The previous run left the renderer on its task view; return to the
    // managed-run controls the same way a user would.
    if (!(await page.evaluate(() => !!document.querySelector("#lumi-managed-agent")))) {
      await click(page, "Settings");
      await wait(page, () => !!document.querySelector('[aria-label="General"]'), "settings nav");
      await click(page, "General");
    }
    try {
      await wait(
        page,
        () =>
          document.querySelectorAll("#lumi-managed-agent option").length > 2 &&
          document.querySelectorAll("#lumi-managed-model option").length > 2,
        "managed run controls list the tool agent and route",
      );
    } catch (error) {
      const seen = await page.evaluate(() => ({
        agents: [...document.querySelectorAll("#lumi-managed-agent option")].map((o) => o.value),
        models: [...document.querySelectorAll("#lumi-managed-model option")].map((o) => o.value),
      }));
      throw new Error(`${error.message}; options=${JSON.stringify(seen)}`);
    }
    const selected = await page.evaluate(
      (input) => {
        const setSelect = (selector, value) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLSelectElement)) return false;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(
            element,
            value,
          );
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return element.value === value;
        };
        return (
          setSelect("#lumi-managed-agent", input.agentId) &&
          setSelect("#lumi-managed-model", input.alias)
        );
      },
      { agentId: toolPlane.agentId, alias: TOOL_ALIAS },
    );
    assert.equal(selected, true, "select the reviewed-tool agent and controlled route");
    await page.evaluate((value) => {
      const textarea = document.querySelector("#lumi-managed-prompt");
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("missing prompt input");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
        textarea,
        value,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }, toolPrompt(target));
    await wait(
      page,
      () =>
        [...document.querySelectorAll("button")].some(
          (button) => button.innerText.trim() === "Run with managed policy" && !button.disabled,
        ),
      `${label} managed tool run action enabled`,
    );
    await click(page, "Run with managed policy");
    const run = await waitForRun({ probe, orgId: org.orgId, agentId: toolPlane.agentId });
    const approval = await waitForPendingApproval({
      probe,
      fixture,
      orgId: org.orgId,
      runId: run.run_id,
      // The Agent's own "Ask before changes" prompt is the local, user-owned
      // permission layer in front of the managed gate. Answer it as a user would;
      // the managed approval below is the separate organization authority.
      onPoll: async () => {
        // Option 1 is "Allow only this time" (never the persistent or full-access
        // choices); it is then confirmed.
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
          // The prompt lives in the task view; leave settings like a user would.
          buttons.find((button) => button.innerText.trim() === "Back to workspace")?.click();
          return false;
        });
        if (choice) {
          await delay(400);
          const confirmed = await page.evaluate(() => {
            const confirm = [...document.querySelectorAll("button")].find(
              (button) => button.innerText.trim() === "Confirm" && !button.disabled,
            );
            confirm?.click();
            return !!confirm;
          });
          if (confirmed) localAllowClicks += 1;
          await delay(500);
        }
      },
      diagnose: async () => {
        await page.evaluate(() => {
          const toggle = [...document.querySelectorAll('button[data-history-open="false"]')].find(
            (element) => /^Worked for/.test(element.innerText?.trim() ?? ""),
          );
          toggle?.click();
        });
        await delay(800);
        await page.screenshot(join(profile, "evidence", `tool-${label}-no-approval.png`));
        // Did the (local) Write handler run? A file here means no managed gate.
        console.log(
          `diagnose: fixture file exists=${existsSync(target)} localAllow=${localAllowClicks}`,
        );
        const audit = await probe.d1Rows(
          `SELECT action, outcome FROM security_events WHERE org_id = '${org.orgId}' ORDER BY rowid DESC LIMIT 12`,
          "diagnose recent audit actions",
        );
        const runEvents = await probe.d1Rows(
          `SELECT event_type FROM run_events WHERE run_id = '${run.run_id}' ORDER BY sequence`,
          "diagnose run events",
        );
        const catalogRows = await probe.d1Rows(
          `SELECT tool_id, name, source, risk_class, lifecycle, fingerprint, capability_ids_json FROM tool_definitions WHERE org_id = '${org.orgId}'`,
          "diagnose reviewed catalog",
        );
        const deviceRows = await probe.d1Rows(
          `SELECT capabilities FROM devices WHERE device_id = '${deviceId}'`,
          "diagnose device capability report",
        );
        console.log(
          `diagnose audit=${JSON.stringify(audit)} run_events=${JSON.stringify(runEvents)}`,
        );
        console.log(
          `diagnose catalog=${JSON.stringify(catalogRows)} runtimeIdentity=${JSON.stringify(writeIdentity)} device=${JSON.stringify(deviceRows)}`,
        );
        const runs = await probe.d1Rows(
          `SELECT state FROM runs WHERE run_id = '${run.run_id}'`,
          "diagnose run",
        );
        const requests = await probe.d1Rows(
          `SELECT response_state, error_code FROM inference_requests WHERE run_id = '${run.run_id}'`,
          "diagnose inference",
        );
        const calls = await probe.d1Rows(toolSql(run.run_id), "diagnose tool calls");
        const codes = [...new Set(appLog.match(/lumi_[a-z_]{3,80}/g) ?? [])].join(",");
        const screen = await page.evaluate(() => ({
          alerts: [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent),
          codes: document.body.innerText.match(/lumi_[a-z_]{3,80}/g) ?? [],
          fixture: document.body.innerText.match(/The mock fixture[^\n]{0,260}/g) ?? [],
          toolText: (() => {
            const text = document.body.innerText;
            const at = text.indexOf("lumi-e2e-fixture");
            const worked = text.indexOf("Worked for");
            return worked < 0 ? "" : text.slice(worked, worked + 1200);
          })(),
          agent: document.querySelector("#lumi-managed-agent")?.value,
          model: document.querySelector("#lumi-managed-model")?.value,
        }));
        return JSON.stringify({ runs, requests, calls, codes, screen });
      },
    });
    assert.equal(approval.tool_id, toolPlane.toolId);
    assert.equal(approval.tool_fingerprint, writeIdentity.fingerprint);
    assert.equal(approval.risk_class, "filesystem_write");
    assert.equal(approval.approval_mode, "per_use");
    assert.equal(existsSync(target), false, "no file effect while approval is pending");
    await page.screenshot(join(profile, "evidence", `tool-${label}-pending.png`));
    await resolveApproval({
      probe,
      fixture,
      orgId: org.orgId,
      approval,
      decision,
      reason: decision === "denied" ? "Electron e2e denial control" : undefined,
    });
    return { target, run, approval };
  }
  const toolSql = (runId) =>
    `SELECT c.tool_call_id, c.tool_id, c.status, c.execution_started_at, c.execution_device_id, a.status AS approval_status, a.consumed_at FROM tool_call_refs c LEFT JOIN approval_requests a ON a.tool_call_id = c.tool_call_id WHERE c.run_id = '${runId}'`;
  // A second managed alias must work on the same already-running Agent.
  // Restart would hide the live alias registration defect.
  const approvedTool = await runManagedTool("approved", "approved");
  await wait(
    page,
    () => document.body.innerText.includes("The mock fixture received the tool result."),
    "model continues after the approved tool result",
  );
  assert.equal(
    readFileSync(approvedTool.target, "utf8"),
    MOCK_WRITE_CONTENT,
    "the real Write handler produced the exact approved file",
  );
  await page.screenshot(join(profile, "evidence", "tool-approved-result.png"));
  const approvedRows = await probe.waitForD1(
    "approved tool result is stored once",
    toolSql(approvedTool.run.run_id),
    (rows) => rows.length === 1 && rows[0].status === "completed",
    60_000,
  );
  assert.equal(approvedRows[0].tool_id, toolPlane.toolId);
  assert.equal(approvedRows[0].execution_device_id, deviceId);
  assert.ok(approvedRows[0].execution_started_at, "once-only execution claim recorded");
  assert.equal(approvedRows[0].approval_status, "approved");
  assert.ok(approvedRows[0].consumed_at, "approval grant consumed by the claim");
  const resultAudit = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM security_events WHERE run_id = '${approvedTool.run.run_id}' AND tool_call_id = '${approvedRows[0].tool_call_id}' AND action = 'tool.result.v1'`,
    "exactly one tool result audit event",
  );
  assert.equal(Number(resultAudit[0].n), 1);
  const toolInference = await probe.waitForD1(
    "tool run inference requests are completed and attributed",
    `SELECT response_state, device_id, run_id FROM inference_requests WHERE run_id = '${approvedTool.run.run_id}'`,
    (rows) => rows.length >= 2 && rows.every((row) => row.response_state === "completed"),
    30_000,
  );
  assert.ok(toolInference.every((row) => row.device_id === deviceId));
  console.log(
    "PASS actual Electron model-driven Write: exact reviewed descriptor, public approval, one claim, real file effect, stored result and audit",
  );
  const deniedTool = await runManagedTool("denied", "denied");
  const deniedRows = await probe.waitForD1(
    "denied tool call is settled without execution",
    toolSql(deniedTool.run.run_id),
    (rows) => rows.length === 1 && rows[0].approval_status === "denied",
    60_000,
  );
  await probe.waitForD1(
    "denied tool run reaches a terminal state",
    `SELECT state FROM runs WHERE run_id = '${deniedTool.run.run_id}'`,
    (rows) => rows.length === 1 && ["succeeded", "failed", "cancelled"].includes(rows[0].state),
    90_000,
  );
  assert.equal(existsSync(deniedTool.target), false, "denial leaves the file untouched");
  assert.equal(deniedRows[0].execution_started_at, null, "a denied call is never claimed");
  assert.equal(deniedRows[0].consumed_at, null);
  await page.screenshot(join(profile, "evidence", "tool-denied-result.png"));
  // Tool arguments/results are request content, not audit metadata.
  for (const needle of [approvedTool.target, deniedTool.target, MOCK_WRITE_CONTENT.trim()]) {
    const literal = "'" + needle.replaceAll("'", "''") + "'";
    for (const table of [
      "inference_requests",
      "usage_events",
      "run_events",
      "security_events",
      "outbox_events",
    ]) {
      const columns = (
        await probe.d1Rows(`PRAGMA table_info(${table})`, `inspect ${table} content boundary`)
      )
        .filter((column) => /TEXT/i.test(column.type))
        .map((column) => column.name);
      const hits = await probe.d1Rows(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${columns.map((name) => `instr(COALESCE(${name}, ''), ${literal}) > 0`).join(" OR ")}`,
        `verify tool content absence in ${table}`,
      );
      assert.equal(Number(hits[0].n), 0, `tool path/content found in ${table}`);
    }
  }
  console.log(
    "PASS actual Electron denial: file untouched, no execution claim, run settles, tool content absent from audit tables",
  );
  if (process.argv.includes("--stop-after-tools")) {
    console.log("STOP after tool flow (debug run; not a full regression verdict)");
    throw new Error("--stop-after-tools: partial run requested, not a regression verdict");
  }
  await stop();
  page = await start({ expectRestoredAccount: true });
  await wait(
    page,
    () => document.body.innerText.includes("Organization-managed"),
    "workspace restart readback",
  );
  const duplicateBindings = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM workspace_bindings WHERE device_id = '${deviceId}' AND project_id = '${projectId}'`,
    "check no duplicate binding after restart",
  );
  assert.equal(Number(duplicateBindings[0]?.n), 1);
  adoptionRows = await p08Row();
  assert.equal(adoptionRows.length, 1);
  console.log("PASS restart restores server-owned workspace ownership without duplicates");
  await click(page, "Return this workspace to local mode");
  await wait(
    page,
    () => document.body.innerText.includes("Review and bind this workspace"),
    "workspace rollback",
  );
  assert.equal(readFileSync(localSentinelPath, "utf8"), localSentinelBefore);
  const remainingBindings = await probe.d1Rows(
    `SELECT binding_id FROM workspace_bindings WHERE device_id = '${deviceId}' AND project_id = '${projectId}' AND removed_at IS NULL`,
    "verify Electron P03 binding rollback",
  );
  assert.equal(remainingBindings.length, 0);
  const historicalBinding = await probe.d1Rows(
    `SELECT binding_id, removed_at FROM workspace_bindings WHERE binding_id = '${bindingRows[0].binding_id}'`,
    "removed binding retains historical P05 attribution",
  );
  assert.equal(historicalBinding.length, 1);
  assert.ok(historicalBinding[0].removed_at);
  const historicalRun = await probe.d1Rows(
    `SELECT state, workspace_binding_id FROM runs WHERE run_id = '${managedRun.run_id}'`,
    "rollback retains completed run and its original binding ID",
  );
  assert.equal(historicalRun[0].state, "succeeded");
  assert.equal(historicalRun[0].workspace_binding_id, bindingRows[0].binding_id);
  adoptionRows = await p08Row();
  assert.equal(adoptionRows[0].stage, "local_unmanaged");
  assert.equal(adoptionRows[0].ownership, "local_unmanaged");
  console.log("PASS Electron rollback returns local ownership and leaves local files unchanged");
  const listedBindings = await probe.request(
    fixture,
    "GET",
    `/api/v1/orgs/${org.orgId}/projects/${projectId}/bindings`,
  );
  probe.expectStatus("removed binding is absent from active project listing", listedBindings, 200);
  assert.equal(JSON.stringify(listedBindings.payload).includes(bindingRows[0].binding_id), false);
  const sessionsBeforeRemovalAttack = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM agent_sessions WHERE org_id = '${org.orgId}'`,
    "session count before removed-binding attack",
  );
  const removedBindingAttack = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${org.orgId}/sessions`,
    {
      project_id: projectId,
      device_id: deviceId,
      workspace_binding_id: bindingRows[0].binding_id,
      agent_definition_id: agentId,
    },
    probe.browserMutation(fixture, "electron-removed-binding-refusal"),
  );
  probe.expectStatus(
    "removed binding cannot authorize a new P05 session",
    removedBindingAttack,
    404,
  );
  assert.equal(removedBindingAttack.payload?.error?.details?.reason, "workspace_binding_not_found");
  const sessionsAfterRemovalAttack = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM agent_sessions WHERE org_id = '${org.orgId}'`,
    "removed-binding refusal creates no session",
  );
  assert.deepEqual(sessionsAfterRemovalAttack, sessionsBeforeRemovalAttack);
  await wait(
    page,
    () => document.querySelectorAll("#lumi-workspace-project option").length > 1,
    "rebind project options",
  );
  await page.evaluate((id) => {
    const element = document.querySelector("#lumi-workspace-project");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(element, id);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, projectId);
  await click(page, "Review and bind this workspace");
  await wait(
    page,
    () => document.body.innerText.includes("Continue: account is optional"),
    "fresh explicit rebind",
  );
  const rebound = await probe.d1Rows(
    `SELECT binding_id FROM workspace_bindings WHERE device_id = '${deviceId}' AND project_id = '${projectId}' AND removed_at IS NULL`,
    "explicit rebind has one fresh live binding",
  );
  assert.equal(rebound.length, 1);
  assert.notEqual(rebound[0].binding_id, bindingRows[0].binding_id);
  await page.screenshot(join(profile, "evidence", "rebind-stage-zero.png"));
  await click(page, "Unbind this workspace");
  await wait(
    page,
    () => document.body.innerText.includes("Review and bind this workspace"),
    "second rollback",
  );
  assert.equal(readFileSync(localSentinelPath, "utf8"), localSentinelBefore);
  console.log(
    "PASS removed binding is hidden/refused without side effects; explicit rebind creates a fresh ID",
  );
  const workspaceVault = join(profile, "userData", "lumi-workspaces"),
    workspaceVaultFiles = (await readdir(workspaceVault)).filter(
      (f) => f.startsWith("lumi-workspace-") && f.endsWith(".json"),
    );
  assert.equal(workspaceVaultFiles.length, 1);
  const workspaceDisk = readFileSync(join(workspaceVault, workspaceVaultFiles[0]), "utf8");
  assert.ok(JSON.parse(workspaceDisk).ciphertext);
  assert.equal(workspaceDisk.includes(workspacePath), false);
  const vault = join(profile, "userData", "lumi-account"),
    files = (await readdir(vault)).filter(
      (f) => f.startsWith("lumi-session-") && f.endsWith(".json"),
    );
  assert.equal(files.length, 1);
  const disk = readFileSync(join(vault, files[0]), "utf8");
  assert.ok(JSON.parse(disk).ciphertext);
  assert.ok(!disk.includes("lumi_session"));
  console.log("PASS OS-encrypted vault exists");
  await stop();
  page = await start({ expectRestoredAccount: true });
  await wait(page, () => document.body.innerText.includes("Electron Account"), "restart restore");
  console.log("PASS actual restart restores session");
  await wait(page, () => document.body.innerText.includes("Sync policy"), "device restart restore");
  const count = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM devices WHERE org_id = '${org.orgId}'`,
    "no duplicate device",
  );
  assert.equal(count[0].n, 1);
  console.log("PASS restart restores same device, no reenrollment");
  const revoke = await probe.request(
    fixture,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${deviceId}`,
    {},
    probe.browserMutation(fixture, "revoke-electron"),
  );
  assert.equal(revoke.status, 204);
  const revokedPath = await confirmRevokedInUi(page);
  console.log(
    `PASS revoked Electron device shows the revoked state (${revokedPath}): no recovery, sync or re-enrollment`,
  );

  await click(page, "Sign out of Lumi");
  await wait(page, () => document.body.innerText.includes("Sign in to Lumi"), "logout");
  assert.equal(
    (await readdir(vault)).filter((f) => f.startsWith("lumi-session-") && f.endsWith(".json"))
      .length,
    0,
  );
  console.log("PASS logout removes own persisted session");
  assert.equal(
    appLog.includes(managedPrompt),
    false,
    "raw prompt must not enter ordinary desktop process logs",
  );
  assert.equal(probe.failures.length, 0);
  completed = true;
} finally {
  await stop();
  if (chrome) await chrome.close();
  if (vite) await vite.close();
  writeFileSync(join(profile, "evidence", "app.log"), probe.redact(appLog));
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const parentSha = git(root, "rev-parse", "HEAD");
  const clientSha = git(client, "rev-parse", "HEAD");
  const report = {
    verdict: completed ? "PASS" : stage === "runtime" ? "FAIL" : "BLOCKED",
    control_plane_sha: parentSha,
    lumi_agents_sha: clientSha,
    control_plane_dirty: git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
    lumi_agents_dirty: git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
    desktop_assertions: desktopAssertions,
    worker_assertions: probe.passes,
    observation_retries: observationRetries,
    screenshots: [
      "authenticated.png",
      "workspace-selection.png",
      "workspace-bound-local-stage.png",
      "managed-run-response.png",
    ],
  };
  writeFileSync(join(profile, "evidence", "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.LUMI_ELECTRON_REPORT)
    writeFileSync(process.env.LUMI_ELECTRON_REPORT, JSON.stringify(report, null, 2) + "\n");
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
