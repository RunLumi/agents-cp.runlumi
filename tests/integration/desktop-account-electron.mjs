import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { launch, newPage, connect, attachPage } from "../../apps/web/scripts/cdp.mjs";
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
for (const n of ["home", "userData", "session", "evidence"])
  mkdirSync(join(profile, n), { recursive: true });
const probe = new SmokeHarness({ name: "Electron account" });
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
  throw new Error(`UI timeout: ${label}`);
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
async function start() {
  const port = await probe.availablePort();
  app = spawn(binary, [desktop, `--remote-debugging-port=${port}`], {
    detached: true,
    env: {
      ...process.env,
      ZCODE_DATA_BASE_DIR: join(profile, "home"),
      ZCODE_DESKTOP_HOME_DIR: join(profile, "home"),
      ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "userData"),
      ZCODE_DESKTOP_SESSION_DATA_DIR: join(profile, "session"),
      ZCODE_DESKTOP_APPLICATION_NAME: "Lumi Account E2E",
      ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
      LUMI_CONTROL_PLANE_ORIGIN: probe.baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const pipe of [app.stdout, app.stderr])
    pipe.on("data", (d) => {
      appLog = (appLog + d).slice(-30000);
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
    () => document.body.innerText.includes("Connect") || document.body.innerText.includes("Cancel"),
    "initial UI",
  );
  for (let i = 0; i < 12; i++) {
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes("Waiting for")) await click(page, "Cancel");
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
  page = await start();
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
  await click(page, "Sync policy");
  await wait(
    page,
    () => document.body.innerText.includes("Device action failed"),
    "revoked policy refusal",
  );
  console.log("PASS revoked Electron policy sync refused");

  await click(page, "Sign out of Lumi");
  await wait(page, () => document.body.innerText.includes("Sign in to Lumi"), "logout");
  assert.equal(
    (await readdir(vault)).filter((f) => f.startsWith("lumi-session-") && f.endsWith(".json"))
      .length,
    0,
  );
  console.log("PASS logout removes own persisted session");
  assert.equal(probe.failures.length, 0);
} finally {
  await stop();
  if (chrome) await chrome.close();
  if (vite) await vite.close();
  writeFileSync(join(profile, "evidence", "app.log"), probe.redact(appLog));
  probe.cleanup();
  console.log(`Profile/evidence retained: ${profile}`);
}
