/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * Dependency-free on purpose: Node 24 ships a global `WebSocket` and `fetch`, so
 * this needs nothing installed. Exists because the repository has NO browser
 * harness at all (no Playwright dependency, no DOM test environment), and the
 * verification system requires real-browser evidence for VI-UX-001/VI-UX-002 and
 * for a real WebAuthn ceremony for VI-AUTH-001.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Playwright-managed Chromium bundle cannot fork here (macOS refuses the
// app bundle: "sandbox_extension_issue_file_to_process ... Operation not
// permitted", then V8 dies with "Error loading V8 startup snapshot file"). The
// system Chrome is properly registered and works.
const CHROME =
  process.env.VFY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launch({ port = 9333, headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "vfy-chrome-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1440,900",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  const child = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  let version = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!version) {
    child.kill("SIGKILL");
    throw new Error(`chrome did not expose a debugging port. log tail:\n${log.slice(-2000)}`);
  }
  const browser = await connect(version.webSocketDebuggerUrl);
  browser.close = async () => {
    try {
      browser.socket.close();
    } catch {
      /* already closed */
    }
    child.kill("SIGKILL");
  };
  browser.log = () => log;
  return browser;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    const api = {
      socket,
      send(method, params = {}, sessionId) {
        const id = nextId++;
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        socket.send(JSON.stringify(message));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const { res, rej, method } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(`${method} failed: ${JSON.stringify(data.error)}`));
        else res(data.result);
        return;
      }
      for (const listener of listeners) listener(data);
    });
    socket.addEventListener("error", reject);
    socket.addEventListener("open", () => resolve(api));
  });
}

export async function newPage(browser, url = "about:blank") {
  const { targetId } = await browser.send("Target.createTarget", { url });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    targetId,
    sessionId,
    send: (method, params) => browser.send(method, params, sessionId),
    async evaluate(fn, ...args) {
      const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
      const result = await page.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `page evaluate threw: ${result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    },
    async goto(target, { waitUntil = "load", timeout = 30_000 } = {}) {
      const done = new Promise((resolve) => {
        const off = browser.on((data) => {
          if (data.sessionId !== sessionId) return;
          if (data.method === "Page.loadEventFired" && waitUntil === "load") {
            off();
            resolve();
          }
        });
        setTimeout(() => {
          off();
          resolve();
        }, timeout);
      });
      await page.send("Page.navigate", { url: target });
      await done;
    },
    async text() {
      return page.evaluate(() => document.body.innerText);
    },
    async screenshot(path) {
      const { data } = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    },
    async setViewport(width, height, mobile = false) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
    },
  };
  await page.send("Page.enable", {});
  await page.send("Runtime.enable", {});
  return page;
}

export function collectConsole(page, sink) {
  return page.browserOn;
}
