// Real UI onboarding for the desktop automation journey: Lumi-first startup, PKCE sign-in approved in
// a real headless Chrome against the web control plane, device enrollment, opaque workspace binding,
// and the explicit P08 ladder to managed policy. Steps and labels mirror the passing account probe
// (tests/integration/desktop-account-electron.mjs); only the sequencing is shared here.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { launch, newPage } from "../../../apps/web/scripts/cdp.mjs";
import { uiHelpers } from "./lumi-desktop-app.mjs";

/** The web control plane's `/desktop` approval page, served by vite and proxied to the Worker. */
export async function startApprovalWeb({ root, probe }) {
  const requireWeb = createRequire(join(root, "apps/web/package.json"));
  const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
  const port = await probe.availablePort();
  const vite = await createServer({
    root: join(root, "apps/web"),
    configFile: join(root, "apps/web/vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port,
      proxy: { "/api": { target: probe.baseUrl, changeOrigin: true } },
    },
  });
  await vite.listen();
  return { port, close: () => vite.close() };
}

/**
 * In-page admission probe for one exact-label button inside the Lumi account section. Runs in the
 * renderer; reports state only (no auth, no account data). `ready` means exactly one visible, enabled,
 * unobscured match, so a native click at `point` lands on it.
 */
function probeScopedButton(label) {
  const scope = document.querySelector("#lumi-account-heading")?.parentElement;
  if (!scope) return { ready: false, reason: "account section missing", matches: 0 };
  const matches = [...scope.querySelectorAll("button")].filter(
    (button) => button.innerText.trim() === label,
  );
  const states = matches.map((button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility === "visible" &&
      style.display !== "none" &&
      style.pointerEvents !== "none";
    return { button, rect, visible };
  });
  const shown = states.filter((state) => state.visible);
  const base = {
    matches: matches.length,
    visible: shown.length,
    disabled: shown.filter((state) => state.button.disabled).length,
    busy: !!scope.querySelector('[role="status"]'),
  };
  if (shown.length !== 1) return { ...base, ready: false, reason: "need exactly one visible button" };
  const { button, rect } = shown[0];
  if (button.disabled || button.getAttribute("aria-disabled") === "true")
    return { ...base, ready: false, reason: "disabled" };
  button.scrollIntoView({ block: "center", inline: "center" });
  const settled = button.getBoundingClientRect();
  const x = settled.left + settled.width / 2;
  const y = settled.top + settled.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== button && !button.contains(hit)))
    return { ...base, ready: false, reason: "not hit-testable" };
  return { ...base, ready: true, point: { x, y }, moved: settled.top !== rect.top };
}

/**
 * Click an account-section button only once it is actually usable, with one real CDP mouse click.
 * Waiting for the label alone is not admission: the Lumi device section renders its enroll button
 * disabled while the automatic `read-device` is in flight, and a scripted click on a disabled button
 * is a silent no-op. Never retries a click; fails closed (bounded) with a state-only diagnostic.
 */
export async function clickWhenReady(page, label, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let previous;
  while (Date.now() < deadline) {
    last = await page.evaluate(probeScopedButton, label);
    // Two consecutive identical hit-testable readings: layout has stopped moving under the pointer.
    if (last.ready && previous?.ready && !last.moved) {
      const { x, y } = last.point;
      const mouse = { x, y, button: "left", clickCount: 1 };
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await page.send("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" });
      await page.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" });
      await delay(400);
      return;
    }
    previous = last;
    await delay(200);
  }
  const { point: _point, ...state } = last ?? {};
  throw new Error(`UI timeout: "${label}" never became clickable; state=${JSON.stringify(state)}`);
}

/** Pass the first-run screens and land on Settings → General (where the Lumi section lives). */
export async function reachAccountSection(app, { expectRestoredAccount = false } = {}) {
  const page = app.page;
  const ui = uiHelpers(page);
  await ui.wait(
    () =>
      document.body.innerText.includes("Connect") ||
      document.body.innerText.includes("Cancel") ||
      document.body.innerText.includes("Continue locally") ||
      !!document.querySelector('[aria-label="Settings"]'),
    "initial UI",
  );
  for (let i = 0; i < 12; i++) {
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes("Continue locally")) {
      assert.equal(expectRestoredAccount, false, "restored Lumi session must not reopen startup entry");
      await ui.clickText("Continue locally");
    } else if (body.includes("Waiting for")) await ui.clickText("Cancel");
    else if (body.includes("Use API key")) await ui.clickText("Use API key");
    else if (body.includes("Skip for now")) await ui.clickText("Skip for now");
    else if (await page.evaluate(() => !!document.querySelector('[aria-label="Exit onboarding"]')))
      await ui.clickText("Exit onboarding");
    else if (await page.evaluate(() => !!document.querySelector('[aria-label="Settings"]'))) break;
    else await delay(500);
  }
  await ui.wait(() => !!document.querySelector('[aria-label="Settings"]'), "local shell");
  await ui.clickText("Settings");
  await ui.wait(() => !!document.querySelector('[aria-label="General"]'), "settings nav");
  await ui.clickText("General");
  await ui.wait(
    () => document.body.innerText.includes("Lumi organization account"),
    "account section",
  );
}

/**
 * Sign in through the real PKCE flow (code matched in a real browser), enroll the device, bind the
 * workspace and advance it to managed policy. Returns identifiers read back from the UI/Worker.
 */
export async function onboardToManagedPolicy({ app, probe, web, org, org_fixture, projectId, email, password }) {
  const page = app.page;
  const ui = uiHelpers(page);
  await reachAccountSection(app);
  await ui.wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText === "Sign in to Lumi" && !button.disabled,
      ),
    "restore settled",
  );
  await ui.clickText("Sign in to Lumi");
  await ui.wait(() => document.body.innerText.includes("Match this code"), "PKCE started");
  const code = await page.evaluate(
    () =>
      document
        .querySelector("#lumi-account-heading")
        .parentElement.querySelector(".tracking-widest").innerText,
  );
  assert.match(code, /^[A-Z0-9]{8}$/);
  const chrome = await launch({ port: await probe.availablePort(), headless: true });
  try {
    const browser = await newPage(chrome);
    await browser.goto(`http://127.0.0.1:${web.port}/desktop?user_code=${code}`);
    const browserUi = uiHelpers(browser);
    await browserUi.wait(
      () => !!document.querySelector('input[type="password"]'),
      "browser login",
    );
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
      email,
      password,
    );
    await browserUi.clickText("Sign in with password");
    await browserUi.wait(() => !!document.querySelector("#desktop-code"), "approval");
    await browser.evaluate(() => document.querySelector('button[type="submit"]').focus());
    await browser.press("Enter");
    await browserUi.wait(
      () => document.body.innerText.includes("Desktop sign-in approved."),
      "approved",
    );
  } finally {
    await chrome.close();
  }
  await ui.clickText("I approved — complete sign-in");
  await ui.wait(() => document.body.innerText.includes("Automation Journey"), "desktop authenticated");
  await ui.wait(
    () => document.body.innerText.includes("Confirm and enroll this device"),
    "enrollment UI",
  );
  await clickWhenReady(page, "Confirm and enroll this device");
  await ui.wait(() => document.body.innerText.includes("Sync policy"), "enrollment completes");
  const deviceId = await page.evaluate(
    () =>
      document
        .querySelector("#lumi-account-heading")
        .parentElement.innerText.match(/dvc_[0-9a-f]{32}/)?.[0],
  );
  assert.match(deviceId, /^dvc_[0-9a-f]{32}$/);
  await ui.wait(
    () => document.body.innerText.includes("Review and bind this workspace"),
    "workspace adoption controls",
  );
  await ui.wait(
    () => document.querySelectorAll("#lumi-workspace-project option").length > 1,
    "project options loaded",
  );
  assert.equal(await ui.selectValue("#lumi-workspace-project", projectId), true);
  await ui.wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.innerText.trim() === "Review and bind this workspace" && !button.disabled,
      ),
    "binding consent ready",
  );
  await ui.clickText("Review and bind this workspace");
  for (const [label, next] of [
    ["Continue: account is optional", "Continue: device enrolled"],
    ["Continue: device enrolled", "Confirm workspace ownership"],
    ["Confirm workspace ownership", "Apply managed policy"],
  ]) {
    await ui.wait(
      (text) =>
        [...document.querySelectorAll("button")].some(
          (button) => button.innerText.trim() === text && !button.disabled,
        ),
      `ladder step ${label}`,
      { arg: label },
    );
    await ui.clickText(label);
    await ui.wait(
      (text) => document.body.innerText.includes(text),
      `ladder reached ${next}`,
      { arg: next },
    );
  }
  await ui.clickText("Apply managed policy");
  await ui.wait(
    () => document.body.innerText.includes("Run with managed policy"),
    "managed policy applied",
  );
  void org;
  void org_fixture;
  return { deviceId };
}
