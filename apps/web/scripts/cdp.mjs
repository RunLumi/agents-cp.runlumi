/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * Dependency-free on purpose. Node ships a global `WebSocket` and `fetch`, so this
 * needs nothing installed -- no Playwright, no Puppeteer, no `puppeteer-core`. The
 * repository has no DOM test environment and no browser harness, and the
 * verification system requires real-browser evidence for VI-AUTH-001 (a real
 * WebAuthn ceremony) and VI-UX-001/VI-UX-002 (a real layout).
 *
 * A DOM testing library could not produce that evidence anyway: a CTAP2 virtual
 * authenticator and `getBoundingClientRect` are properties of a real browser, not
 * of a document model. So the dependency that would have been added buys nothing
 * here, and the ~200 lines below are the whole of what is needed.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chrome is located rather than installed. Playwright's bundled Chromium cannot
// fork on this platform -- macOS refuses the app bundle
// ("sandbox_extension_issue_file_to_process ... Operation not permitted") and V8
// then dies with "Error loading V8 startup snapshot file" -- while the system
// Chrome is properly registered and works. So the candidates are tried in order
// and `PROBE_CHROME` overrides them.
//
// A run with no Chrome at all is reported as SKIPPED with the reason, never as a
// pass. A verifier that cannot find its browser has proven nothing, and saying
// "0 failures" in that case is the exact failure mode this campaign exists to
// catch.
const CHROME_CANDIDATES = [
  process.env.PROBE_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Why no browser could be launched, phrased so a CI log is self-explanatory. */
export const NO_CHROME_REASON =
  "no Chrome/Chromium found. Install one, or set PROBE_CHROME to its executable. " +
  "Tried: " +
  CHROME_CANDIDATES.join(", ");

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
  const executable = findChrome();
  if (!executable) {
    const error = new Error(NO_CHROME_REASON);
    error.code = "NO_BROWSER";
    throw error;
  }
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * Virtual key codes for the keys this repository's browser journeys use.
 *
 * A closed table on purpose: `press` throws on an unregistered key rather than sending a guess, so
 * "I pressed a key" always means a key was actually delivered. That matters because an assertion
 * about keyboard behaviour is satisfied just as well by a key that never arrived as by a key the
 * product mishandled — the V02-001 class of defect, where the instrument cannot register a signal.
 */
const KEY_CODES = {
  Tab: { keyCode: 9, code: "Tab", text: "\t" },
  Enter: { keyCode: 13, code: "Enter", text: "\r" },
  Space: { keyCode: 32, code: "Space", text: " " },
  Escape: { keyCode: 27, code: "Escape" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  Home: { keyCode: 36, code: "Home" },
  End: { keyCode: 35, code: "End" },
};

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
          `page evaluate threw: ${
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
          }`,
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

    /**
     * Send a REAL key press through CDP.
     *
     * WHY THIS EXISTS (V02-001)
     *
     * Until now the driver had no key capability at all, so both keyboard claims in
     * `browser-probe.mjs` were synthetic: the focus check called `element.focus()` from script, and
     * the roving-tablist check dispatched `new KeyboardEvent("keydown", ...)`. A synthetic event
     * exercises a listener; it does not move focus, does not set `:focus-visible` the way a user
     * does, and does not traverse the tab order. So "reachable with the keyboard" was supported only
     * in the weak sense that a dispatched event invokes a handler.
     *
     * `Input.dispatchKeyEvent` is the real thing: Chrome processes it through the same input path a
     * physical key takes, so focus MOVES and `:focus-visible` engages. That is what makes a
     * visible-focus assertion meaningful rather than tautological.
     *
     * `key` is the physical key name ("Tab", "Enter", "ArrowRight"); the virtual key code is
     * required by the protocol and is filled in for the keys this repository uses. An unknown key
     * throws rather than silently doing nothing, because a key press that does not arrive would
     * make a keyboard assertion vacuously true.
     */
    async press(key, { shift = false } = {}) {
      const spec = KEY_CODES[key];
      if (!spec) {
        throw new Error(
          `press("${key}"): no virtual key code registered. A key press that cannot be sent would ` +
            `make a keyboard assertion vacuously true, so this throws instead.`,
        );
      }
      const modifiers = shift ? 8 : 0;
      const common = {
        key,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode,
        modifiers,
      };
      await page.send("Input.dispatchKeyEvent", { ...common, type: "rawKeyDown" });
      if (spec.text) {
        await page.send("Input.dispatchKeyEvent", { type: "char", text: spec.text, modifiers });
      }
      await page.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
      return key;
    },
  };
  await page.send("Page.enable", {});
  await page.send("Runtime.enable", {});
  return page;
}

/**
 * Records console errors and uncaught exceptions for one page, so a journey can
 * assert that the browser itself was not reporting failures the UI swallowed.
 */
export function collectConsoleErrors(browser, page) {
  const errors = [];
  browser.on((data) => {
    if (data.sessionId !== page.sessionId) return;
    if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
      errors.push(
        data.params.args
          .map((a) => a.value ?? a.description ?? "")
          .join(" ")
          .slice(0, 300),
      );
    }
    if (data.method === "Runtime.exceptionThrown") {
      errors.push(
        String(
          data.params.exceptionDetails?.exception?.description ??
            data.params.exceptionDetails?.text ??
            "exception",
        ).slice(0, 300),
      );
    }
  });
  return errors;
}
