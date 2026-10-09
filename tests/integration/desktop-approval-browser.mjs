import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
import { launch, newPage } from "../../apps/web/scripts/cdp.mjs";
const root = resolve(import.meta.dirname, "../..");
const requireWeb = createRequire(resolve(root, "apps/web/package.json"));
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const { LumiAccountHostTransport } = await import(
  pathToFileURL(resolve(root, "test-results/lumi-account-client/transport.mjs")).href
);
const probe = new SmokeHarness({ name: "desktop approval browser" });
let vite, browser;
const shots = resolve(root, "test-results/desktop-approval-browser");
mkdirSync(shots, { recursive: true });
process.on("exit", () => probe.cleanup());
async function wait(page, condition) {
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate(condition)) return;
    await delay(200);
  }
  throw new Error("UI condition timeout");
}
try {
  await probe.setup({ persistEnvVar: "DE2E_BROWSER_PERSIST", portEnvVar: "DE2E_BROWSER_PORT" });
  const fixture = probe.client();
  const email = `desktop-${probe.nonce}@example.com`;
  const password = `Lumi-test-${randomBytes(18).toString("base64url")}!`;
  probe.registerSecret(password);
  const signup = await probe.request(fixture, "POST", "/api/v1/auth/password/signup", {
    email,
    display_name: "Desktop Browser",
    password,
  });
  assert.equal(signup.status, 200);
  const verification = signup.payload.verification;
  probe.registerSecret(verification.development_code);
  const verified = await probe.request(fixture, "POST", "/api/v1/auth/verify-email", {
    challenge_id: verification.challenge_id,
    code: verification.development_code,
  });
  assert.equal(verified.status, 200);
  const port = await probe.availablePort();
  vite = await createServer({
    configFile: resolve(root, "apps/web/vite.config.ts"),
    root: resolve(root, "apps/web"),
    server: {
      host: "127.0.0.1",
      port,
      proxy: { "/api": { target: probe.baseUrl, changeOrigin: true } },
    },
  });
  await vite.listen();
  const transport = new LumiAccountHostTransport(probe.baseUrl);
  const flow = await transport.beginSignIn("Browser proof desktop");
  browser = await launch({ port: await probe.availablePort(), headless: true });
  const page = await newPage(browser);
  await page.goto(`http://127.0.0.1:${port}/desktop?user_code=${flow.userCode}`);
  await wait(page, () => !!document.querySelector('input[type="email"]'));
  await page.evaluate(
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
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Sign in with password",
    );
    button.click();
  });
  await wait(page, () => !!document.querySelector("#desktop-code"));
  assert.equal(
    await page.evaluate(() => document.querySelector("#desktop-code").value),
    flow.userCode,
  );
  console.log("PASS actual password login retains desktop approval code");
  const pending = await probe.d1Rows(
    `SELECT status FROM device_authorizations WHERE device_label = 'Browser proof desktop'`,
    "before explicit approval",
  );
  assert.equal(pending[0].status, "pending");
  console.log("PASS page does not approve automatically");
  await page.setViewport(390, 844);
  await page.screenshot(resolve(shots, "approval-narrow.png"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await page.evaluate(() => document.querySelector('button[type="submit"]').focus());
  await page.press("Enter");
  await wait(page, () => document.body.innerText.includes("Desktop sign-in approved."));
  await page.screenshot(resolve(shots, "approved-narrow.png"));
  console.log("PASS keyboard confirmation approves via UI on narrow viewport");
  await transport.completeSignIn();
  const me = await transport.readAccount();
  assert.equal(me.user.email, email);
  console.log("PASS real client exchanges UI-approved flow and reads own account");
  await transport.signOut();
  assert.equal(probe.failures.length, 0);
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
  probe.cleanup();
}
