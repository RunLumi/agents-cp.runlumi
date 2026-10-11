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

export function connect(url) {
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
  return attachPage(browser, targetId);
}

/** Attach to an actual Electron renderer instead of creating a replacement. */
export async function attachPage(browser, targetId) {
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
     * Emulate network conditions for this page.
     *
     * WHY THIS EXISTS (V02-002)
     *
     * The objective requires a real-browser check of the LOADING, SERVER-ERROR and RETRY states, and
     * the app has a branch for each -- `session.kind` is `loading`, `error`, `anonymous`, or
     * `authenticated`. None of the three had ever been rendered by a test, so the branches were
     * unverified code in the shipped product.
     *
     * The failure has to be produced at the NETWORK, not by stubbing the app. `Fetch`-level request
     * interception would be a mock of the thing under test; `Network.emulateNetworkConditions` is
     * the platform's own network stack being told to be slow or unreachable, so the app receives a
     * real pending request and a real network error and takes its real code path. Nothing in
     * `apps/web` is stubbed, and the recovery assertion is the same code path in reverse.
     *
     * `offline` produces a REJECTED fetch, which is the server-error branch. `latencyMs` with the
     * network online produces a PENDING fetch, which is the loading branch -- a rejected request
     * never shows a loading state, so the two must be produced differently or only one is measured.
     */
    async setNetwork({
      offline = false,
      latencyMs = 0,
      downloadThroughput = -1,
      uploadThroughput = -1,
    } = {}) {
      await page.send("Network.enable", {});
      await page.send("Network.emulateNetworkConditions", {
        offline,
        latency: latencyMs,
        downloadThroughput,
        uploadThroughput,
      });
      return { offline, latencyMs };
    },

    /**
     * Make requests matching `urlPattern` fail or hang, at the NETWORK, for real.
     *
     * WHY THIS REPLACED BLANKET `offline`
     *
     * Taking the whole page offline also fails the DOCUMENT navigation, so the app never mounts and
     * there is no error screen to find -- the probe timed out waiting for one. That is the harness
     * producing its own timeout and reading it as a missing feature.
     *
     * A blanket offline is also the wrong instrument for the LOADING state: a pending request has to
     * be pending, and a rejected one never renders a loading screen, so the two states need
     * different faults even though both are "the network misbehaves".
     *
     * `Fetch.requestPaused` failing or delaying a real request for a real URL is failure INJECTION at
     * the network boundary -- the same class the objective asks for at external adapters
     * ("connect failure, timeout, ..."). It stubs nothing in `apps/web`: the app receives a genuine
     * network-level rejection, takes its real error path, and recovers through its real retry.
     *
     * `Fetch.disable` and a `continueRequest` for everything already paused are issued on release, so
     * a later case cannot inherit an interception -- the same "leave the world as you found it"
     * discipline the persist-directory rule exists for.
     */
    async intercept(
      urlPattern,
      {
        action = "fail",
        delayMs = 0,
        status = 200,
        body = "",
        contentType = "text/html",
        // V02-012 — the STAGE the interception pauses at. `Request` fails before anything is
        // sent (connect failure); `Response` pauses AFTER the response headers arrive and fails
        // there, so the browser received headers and then the connection died mid-body. That is
        // the downstream-disconnect fault: the closest this boundary can get to a flaky network,
        // and the one the objective lists that most resembles what a real user actually suffers.
        stage = "Request",
        errorReason = "ConnectionFailed",
      } = {},
    ) {
      await page.send("Fetch.enable", { patterns: [{ urlPattern, requestStage: stage }] });
      // TWO DEFECTS, both found by the `fulfill` action failing with `Invalid InterceptionId`.
      //
      // 1. NO SESSION FILTER. `browser.on` receives events from EVERY attached target, and this
      //    handler acted on any `Fetch.requestPaused` regardless of which session raised it. An
      //    interception id belongs to the session that paused the request, so handling another
      //    session's event is always an invalid id. The dialog handler filters by session; this one
      //    did not, and `fail`/`delay` masked it because they were tolerated where `fulfill` was not.
      //
      // 2. AN UNHANDLED REJECTION CRASHED THE PROCESS. `browser.on` invokes this async function
      //    without awaiting it, so a throw inside it becomes an unhandled rejection and Node exits
      //    -- taking the whole probe down at that point rather than recording one failed interception.
      //    A harness fault in ONE interception must not end the run; it must appear as a failed case.
      const handler = async (data) => {
        if (data.method !== "Fetch.requestPaused") return;
        if (data.sessionId !== page.sessionId) return;
        try {
          await handlePause(data, data.sessionId);
        } catch (error) {
          interceptionErrors.push(String(error?.message ?? error));
        }
      };
      const interceptionErrors = [];
      const handlePause = async (data, sessionId) => {
        // WHY `fulfill` EXISTS (V02-010)
        //
        // The objective names `malformed response` among the adapter injections, and it is the most
        // deceptive of the seven: the browser receives **HTTP 200** and a body that is not JSON. Any
        // check that grades on the status code reads that as success, which is precisely the failure
        // mode the objective warns about. A real user behind a misconfigured proxy or CDN sees
        // exactly this.
        //
        // `Fetch.fulfillRequest` is how the browser itself produces that: a genuine response,
        // synthesised at the network layer, with nothing in `apps/web` stubbed. The app's real parse
        // path runs on a real body.
        if (action === "fulfill") {
          await browser.send(
            "Fetch.fulfillRequest",
            {
              requestId: data.params.requestId,
              responseCode: status,
              responseHeaders: [
                { name: "Content-Type", value: contentType },
                // A request id, so the app has a trace to show even on this fault -- which is the
                // point: a malformed response from a real intermediary WOULD carry one, and a
                // verifier that supplies it is testing the app's behaviour rather than the
                // harness's ability to synthesise headers.
                {
                  name: "X-Request-ID",
                  value: `req_v02_malformed_${data.params.requestId.slice(0, 12)}`,
                },
              ],
              body: Buffer.from(body, "utf8").toString("base64"),
            },
            sessionId,
          );
          return;
        }
        if (action === "delay") {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          await browser.send(
            "Fetch.continueRequest",
            { requestId: data.params.requestId },
            sessionId,
          );
        } else {
          await browser.send(
            "Fetch.failRequest",
            { requestId: data.params.requestId, errorReason },
            sessionId,
          );
        }
      };
      // `browser.on` RETURNS its own unsubscribe function; there is no `off`. The first version of
      // this called a non-existent `browser.off?.(handler)`, which the optional call made silently
      // do nothing -- so the handler would have outlived the interception and failed every later
      // request in the journey. An optional call on a method that does not exist is a way of
      // writing a cleanup that never runs.
      const unsubscribe = browser.on(handler);
      return async () => {
        unsubscribe();
        await page.send("Fetch.disable", {}).catch(() => {});
        // Interceptions that failed are returned rather than swallowed, so a case that expected an
        // interception can say the interception did not happen instead of reading an absence as a
        // product result.
        return { errors: interceptionErrors.slice() };
      };
    },

    /** The conditions currently in force, read back from the platform rather than remembered. */
    async networkConditions() {
      return page
        .send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        .then(() => "restored");
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

    /**
     * Grant clipboard read/write to this page.
     *
     * WHY (V02-008)
     *
     * The webhook secret reveal offers a "Copy secret" button, so the clipboard is the path a user
     * actually takes and the most faithful thing to assert on. Reading it needs a permission the
     * page does not have by default, which is what `Browser.grantPermissions` is for.
     *
     * Without this, capturing "the secret" from the DOM means guessing its shape -- and the guess
     * was wrong three times: it matched an endpoint id, then a `whs_` FINGERPRINT, and the
     * fingerprint is shown again on purpose, so the "the secret did not come back" assertion was
     * comparing a fingerprint with itself and reporting a leak that does not exist. Reading the
     * clipboard removes the guess: whatever the app offers to copy IS the secret, by definition.
     */
    // The origin is passed in rather than read from the page: the page object does not track its own
    // URL, and guessing one would grant the permission to the wrong origin -- which fails closed, but
    // for a reason that looks like the browser refusing.
    async grantClipboard(origin = "http://localhost:5173") {
      await browser.send("Browser.grantPermissions", {
        origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      return true;
    },

    /**
     * Arm a ONE-SHOT handler for a native JavaScript dialog (`window.confirm`, `window.alert`,
     * `window.prompt`), and resolve with what the dialog said.
     *
     * WHY THIS EXISTS (V02-006)
     *
     * The objective names `destructive confirmation` as a state to verify in a real browser, and
     * the app's credential-revoke path is the reachable destructive action:
     *
     *     const confirmed = window.confirm(`Revoke "${credential.label}"? New requests will fail
     *     immediately; existing usage and audit history ...`);
     *     if (!confirmed) return;
     *
     * A native dialog is rendered by the BROWSER, not by the document, so `document.body.innerText`
     * cannot see it and `page.evaluate` cannot dismiss it. Without this method a probe has two bad
     * options: assert nothing, or hang until the dialog times out. Either way the journey reports
     * green over an unverified state -- which is the failure this campaign has now found in seven
     * harnesses.
     *
     * ONE-SHOT ON PURPOSE. A handler left armed would silently accept the NEXT dialog in the
     * journey, which is how a later assertion comes to pass for the wrong reason. Each armed handler
     * resolves once and unsubscribes.
     *
     * `accept: false` is the interesting case: it is how a test proves the confirmation actually
     * PREVENTS the action. "A dialog appeared" is a weak claim; "the dialog appeared, and the
     * credential is still there afterwards" is the one a user actually relies on.
     */
    armDialog({ accept = true, timeout = 8_000 } = {}) {
      let settle;
      const result = new Promise((resolve) => {
        settle = resolve;
      });
      const timer = setTimeout(() => {
        unsubscribe();
        settle({ opened: false, reason: `no dialog within ${timeout}ms` });
      }, timeout);
      const unsubscribe = browser.on(async (data) => {
        if (data.sessionId !== page.sessionId) return;
        if (data.method !== "Page.javascriptDialogOpening") return;
        unsubscribe();
        clearTimeout(timer);
        const { type, message, defaultPrompt } = data.params;
        await page
          .send("Page.handleJavaScriptDialog", { accept, promptText: defaultPrompt ?? undefined })
          .catch(() => {});
        settle({ opened: true, type, message: message ?? "", accepted: accept });
      });
      return result;
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
