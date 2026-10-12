// A real Electron instance of the Lumi desktop app against an ISOLATED profile.
//
// Adapted from tests/integration/desktop-account-electron.mjs so DE2E-INT-05 can run more than one
// client (two profiles) and can fault the process (SIGSTOP / SIGKILL). It launches the production
// bundles in packages/desktop/out; it never reads a personal profile, never mocks IPC and never
// calls a handler directly. Every profile directory is owned by the caller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { attachPage, connect } from "../../../apps/web/scripts/cdp.mjs";
import { isolatedChildEnv, nativeKeystoreArgs, prepareIsolatedHome } from "./lumi-child-env.mjs";

/** The renderer-side helpers shared by every journey. */
export function uiHelpers(page) {
  const wait = async (fn, label, { timeout = 30_000, arg } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await page.evaluate(fn, arg)) return;
      await delay(200);
    }
    const alert = await page.evaluate(() =>
      [...document.querySelectorAll('[role="alert"]')]
        .map((element) => element.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" | "),
    );
    throw new Error(`UI timeout: ${label}${alert ? `; alert=${alert.slice(0, 240)}` : ""}`);
  };
  const clickText = async (label) => {
    await page.evaluate((text) => {
      const element = [...document.querySelectorAll("button,[role='menuitem']")].find(
        (candidate) =>
          candidate.innerText.trim() === text || candidate.getAttribute("aria-label") === text,
      );
      if (!element) throw new Error(`missing UI action: ${text}`);
      element.click();
    }, label);
    await delay(400);
  };
  const clickTestId = async (testId) => {
    await page.evaluate((id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      if (!element) throw new Error(`missing test id: ${id}`);
      element.click();
    }, testId);
    await delay(400);
  };
  const selectValue = (selector, value) =>
    page.evaluate(
      (input) => {
        const element = document.querySelector(input.selector);
        if (!(element instanceof HTMLSelectElement)) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(
          element,
          input.value,
        );
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return element.value === input.value;
      },
      { selector, value },
    );
  return { wait, clickText, clickTestId, selectValue };
}

/** `origin` overrides the control-plane origin (a transparent recording proxy in front of the same Worker). */
export function createDesktopApp({ binary, desktop, probe, profile, workspacePath, name, origin }) {
  assert.ok(existsSync(binary), "prepare pinned Electron");
  assert.ok(existsSync(join(desktop, "out/main/index.js")), "build desktop");
  for (const directory of ["userData", "session", "evidence"])
    mkdirSync(join(profile, directory), { recursive: true });
  prepareIsolatedHome(profile);
  let app;
  let cdp;
  let log = "";
  let page;

  async function start({ port } = {}) {
    const debugPort = port ?? (await probe.availablePort());
    app = spawn(
      binary,
      [
        desktop,
        `--open-workspace=${workspacePath}`,
        `--remote-debugging-port=${debugPort}`,
        ...nativeKeystoreArgs(),
      ],
      {
        detached: true,
        // Main keeps the OS HOME (native keystore); Host/Agent HOME and app data roots are profile-owned.
        env: isolatedChildEnv(profile, {
          ZCODE_DESKTOP_APPLICATION_NAME: "Lumi Account E2E",
          LUMI_CONTROL_PLANE_ORIGIN: origin ?? probe.baseUrl,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const pipe of [app.stdout, app.stderr])
      pipe.on("data", (chunk) => {
        log += chunk;
      });
    let version;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
        break;
      } catch {
        await delay(200);
      }
    }
    assert.ok(version, `${name}: Electron CDP`);
    cdp = await connect(version.webSocketDebuggerUrl);
    let target;
    for (let attempt = 0; attempt < 150; attempt++) {
      target = (await cdp.send("Target.getTargets")).targetInfos.find(
        (item) => item.type === "page" && item.url.includes("/renderer/index.html"),
      );
      if (target) break;
      await delay(200);
    }
    assert.ok(target, `${name}: actual app renderer`);
    page = await attachPage(cdp, target.targetId);
    return page;
  }

  /** SIGSTOP/SIGCONT the whole process group: a frozen Main cannot renew, poll or settle. */
  function signal(name_) {
    if (app?.pid) process.kill(-app.pid, name_);
  }

  async function stop({ hard = false } = {}) {
    try {
      cdp?.socket.close();
    } catch {}
    if (app?.pid) {
      const exited = new Promise((resolve) => app.once("exit", resolve));
      if (hard) {
        try {
          process.kill(-app.pid, "SIGKILL");
        } catch {}
      } else app.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);
      try {
        process.kill(-app.pid, "SIGKILL");
      } catch {}
    }
    app = undefined;
    cdp = undefined;
    page = undefined;
  }

  return {
    name,
    profile,
    start,
    stop,
    signal,
    get page() {
      return page;
    },
    get pid() {
      return app?.pid;
    },
    get log() {
      return log;
    },
  };
}
