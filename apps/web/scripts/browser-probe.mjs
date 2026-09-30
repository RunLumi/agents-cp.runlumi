/**
 * The real-browser journey for the Lumi Agents control plane.
 *
 * Crosses: real Chrome -> Vite dev server -> Wrangler dev Worker -> D1. Nothing is
 * mocked. The session cookie, CSRF token, WebAuthn ceremony, and every
 * org-scoped read come from the running system, and the WebAuthn authenticator is
 * a real CTAP2 virtual authenticator registered through CDP, so
 * `navigator.credentials.create` is a genuine registration rather than a stub.
 *
 * WHY A HAND-ROLLED CDP DRIVER
 *
 * The repository has no DOM test environment and no browser harness, and
 * `cdp.mjs` is ~200 lines of dependency-free driver rather than a Playwright
 * install. That is not minimalism for its own sake: a jsdom-style document cannot
 * produce a CTAP2 ceremony or a real `getBoundingClientRect`, so the dependency
 * would not have bought the evidence. It would only have bought a different way of
 * not producing it.
 *
 * WHAT THIS CAUGHT
 *
 * Promoted out of `docs/verification/runs/2026-09-27-v00-independent-reconstruction/evidence/`
 * after it found four product defects that no other gate could see:
 *
 *   * VFY-001 every passkey endpoint returned 500 in the Worker
 *   * VFY-002 the UI could not submit the one-time email code, so `email_verified`
 *     could never be set and creating an organization was refused forever
 *   * VFY-003 the create-organization panel was a one-way latch
 *   * VFY-007 the Members table clipped its Role and action columns at 390px
 *
 * None of those are visible to `renderToStaticMarkup`, to `cargo test`, or to a
 * document-level overflow metric. All four are visible here.
 *
 * A NOTE ON FALLBACKS
 *
 * The version of this probe in the V00 evidence directory contained API fallbacks:
 * when the UI could not verify an email it called `/api/v1/auth/verify-email`
 * itself, and when the UI could not create a second organization it called
 * `POST /api/v1/orgs` itself. Those fallbacks are GONE, deliberately. They kept the
 * rest of the journey testable, and in doing so they hid the defect they existed to
 * work around -- a verifier that repairs the system under test stops being a
 * verifier. The journey now fails at the point the product is broken, which is
 * where the evidence belongs.
 *
 * Usage:
 *   node apps/web/scripts/browser-probe.mjs
 *   PROBE_SHOTS=<dir> node apps/web/scripts/browser-probe.mjs
 *
 * Environment:
 *   PROBE_WEB           the Vite dev server URL        (default http://localhost:5173/)
 *   PROBE_SHOTS         write a screenshot per step    (default: no screenshots)
 *   PROBE_CHROME        Chrome/Chromium executable     (default: autodetected)
 *   PROBE_HEADLESS=0    run Chrome with a window       (default: headless)
 *   PROBE_TIMEOUT       per-condition timeout, ms     (default 25000)
 *
 * Requires a running Vite dev server and a running development Worker with
 * migrations applied. Exits 0 only when every check passes; exits 2 when the
 * harness could not run at all, which is deliberately distinct from a pass.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { collectConsoleErrors, launch, newPage, NO_CHROME_REASON } from "./cdp.mjs";

const WEB = process.env.PROBE_WEB ?? "http://localhost:5173/";
const SHOTS = process.env.PROBE_SHOTS;
const HEADLESS = process.env.PROBE_HEADLESS !== "0";
const CDP_PORT = Number(process.env.PROBE_CDP_PORT ?? 9333);
const STEP_TIMEOUT = Number(process.env.PROBE_TIMEOUT ?? 25_000);
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  page,
  fn,
  { timeout = STEP_TIMEOUT, interval = 150, label = "condition" } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await page.evaluate(fn);
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

const setInput = (selector, value) => {
  const el = document.querySelector(selector);
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};

const clickExact = (text) => {
  const el = [...document.querySelectorAll("button")].find((n) => n.textContent.trim() === text);
  if (!el) return false;
  el.click();
  return true;
};

const submitForm = () => {
  const form = document.querySelector("form");
  if (!form) return false;
  form.requestSubmit();
  return true;
};

let launchedBrowser = null;

/** Always tears the browser down, so a thrown step cannot leave it running. */
async function shutdown() {
  if (!launchedBrowser) return;
  const browser = launchedBrowser;
  launchedBrowser = null;
  try {
    await browser.close();
  } catch {
    /* already gone */
  }
}

/**
 * Did the signup screen reach a state where waiting longer cannot help?
 *
 * This must be INDEPENDENT of what the repaired UI looks like. The first version
 * tested for `input[name=one-time-code]`, `#org-switcher`, or the words "create
 * an organization" — all three of which the *repair* introduced. Run against the
 * pre-repair product it therefore timed out, and the probe exited 2 (harness
 * fault) instead of reporting that email verification was impossible. A gate that
 * can only pass on the exact UI it was written alongside is not a gate.
 *
 * Three repair-independent terminal states:
 *   - the signup form is gone (the app moved on)
 *   - an alert is showing (the app reported a failure -- that IS a terminal state,
 *     and reporting it is the whole point)
 *   - the authenticated shell is present
 */
const signupReachedTerminalState = () =>
  Boolean(
    ![...document.querySelectorAll("form")].some((f) => f.querySelector("input[type=email]")) ||
    document.querySelector("[role=alert]") ||
    document.querySelector("#org-switcher"),
  ) || undefined;

/**
 * Is a one-time-code affordance on screen, however it is worded?
 *
 * Structural first (an input that a browser or password manager would recognise as
 * a code field), then a deliberately broad copy match. The pre-repair screen said
 * "Verification required for …" and rendered no input at all, so the structural
 * test is false there and the copy test carries it — which is correct, because a
 * code the user cannot enter is precisely the defect.
 */
const looksLikeVerificationStep = () => {
  const codeField = [...document.querySelectorAll("input")].some((el) =>
    /one-time-code/i.test(
      `${el.getAttribute("autocomplete") ?? ""} ${el.name ?? ""} ${el.placeholder ?? ""}`,
    ),
  );
  if (codeField) return true;
  const submittable = [...document.querySelectorAll("form")].some(
    (f) => /code/i.test(f.textContent ?? "") && f.querySelector("input"),
  );
  if (submittable) return true;
  return /verif|one-time code|enter the code/i.test(document.body.innerText) || undefined;
};

async function main() {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const stamp = Date.now();
  const email = `vfy-${stamp}@example.test`;
  const password = "correct horse battery staple 42";
  const orgA = `VFY Org A ${stamp}`;
  const orgB = `VFY Org B ${stamp}`;

  const browser = await launch({ port: CDP_PORT, headless: HEADLESS });
  launchedBrowser = browser;
  const page = await newPage(browser);
  const consoleErrors = collectConsoleErrors(browser, page);

  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__vfy = { exchanges: [] };
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const response = await realFetch(input, init);
        let body = null; try { body = await response.clone().text(); } catch {}
        window.__vfy.exchanges.push({ url, method: (init && init.method) || "GET",
                                     sent: init && init.body, status: response.status, body });
        return response;
      };
    `,
  });

  await page.send("WebAuthn.enable", {});
  const { authenticatorId } = await page.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  check(
    "a real CTAP2 virtual authenticator (resident key + UV) is attached",
    Boolean(authenticatorId),
  );

  await page.goto(WEB, { waitUntil: "load" });
  await waitFor(page, () => document.body.innerText.includes("Sign in with passkey"), {
    label: "auth screen",
  });

  // ---- F01-003 acceptance: passkey is visibly the first/default option -----
  const hierarchy = await page.evaluate(() => {
    const form = document.querySelector("form");
    const controls = [...form.querySelectorAll("input, button")].map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      text: (el.textContent || "").trim(),
      primary: el.className.includes("bg-[var(--lumi-blue)]"),
    }));
    return { controls, heading: document.querySelector("h1")?.textContent };
  });
  const submit = hierarchy.controls.find((c) => c.tag === "button" && c.type === "submit");
  const emailAt = hierarchy.controls.findIndex((c) => c.tag === "input" && c.type === "email");
  check(
    "sign-in's first submit control is the passkey CTA",
    Boolean(submit) && /passkey/i.test(submit.text) && submit.primary,
    `submit="${submit?.text}" primary=${submit?.primary}`,
  );
  check(
    "the passkey CTA precedes the email field (passkey-first, not password-first)",
    emailAt > 0 && submit.index < emailAt,
    `submit@${submit.index} email@${emailAt}`,
  );
  if (SHOTS) await page.screenshot(join(SHOTS, "01-signin-passkey-first.png"));

  // ---- F01-004/005: does the ceremony the UI offers actually work? ---------
  const ceremonyProbe = await page.evaluate(async (mail) => {
    const attempt = async (url, body) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      return { url, status: response.status, body: raw.slice(0, 200), raw };
    };
    return {
      signup: await attempt("/api/v1/auth/passkey/signup/start", {
        email: mail,
        display_name: "VFY Verifier",
      }),
      login: await attempt("/api/v1/auth/passkey/login/start", {}),
    };
  }, email);
  // The probe truncates bodies for readable failure output, so the structured
  // facts are read here rather than by substring-matching the truncated text.
  // Asserting on a 200-character prefix is how the first version of this check
  // came to fail on a response that was in fact correct.
  const ceremonyFields = (r) => {
    try {
      return JSON.parse(r.raw);
    } catch {
      return {};
    }
  };
  const signupFields = ceremonyFields(ceremonyProbe.signup);
  const loginFields = ceremonyFields(ceremonyProbe.login);
  // 201, not 200: a ceremony start creates a pending `webauthn_ceremonies` row.
  // Asserting 200 here would have failed for a reason unrelated to the claim.
  const ceremonyOk = (r) => r.status === 200 || r.status === 201;
  check(
    "POST /api/v1/auth/passkey/signup/start returns server-side creation options",
    ceremonyOk(ceremonyProbe.signup),
    `status=${ceremonyProbe.signup.status} ${ceremonyProbe.signup.body}`,
  );
  check(
    "POST /api/v1/auth/passkey/login/start returns server-side request options",
    ceremonyOk(ceremonyProbe.login),
    `status=${ceremonyProbe.login.status} ${ceremonyProbe.login.body}`,
  );
  check(
    "both ceremony options carry a distinct server-issued challenge",
    typeof signupFields.public_key?.challenge === "string" &&
      signupFields.public_key.challenge.length >= 16 &&
      typeof loginFields.public_key?.challenge === "string" &&
      loginFields.public_key.challenge.length >= 16,
    // The SPA must never mint its own challenge: an attacker who can choose it
    // chooses the one the server verifies.
    `signup.challenge=${typeof signupFields.public_key?.challenge} ` +
      `login.challenge=${typeof loginFields.public_key?.challenge}`,
  );
  // `rpId` appears on a PublicKeyCredentialRequestOptions (login) and NOT on a
  // PublicKeyCredentialCreationOptions (registration) -- for registration the RP
  // ID is implied by the caller's origin. Asserting it on the registration
  // response was a probe bug, not a product defect.
  check(
    "the login ceremony options name the relying party explicitly",
    loginFields.public_key?.rpId === "localhost",
    `rpId=${loginFields.public_key?.rpId}`,
  );
  check(
    "the registration ceremony options bind the account to the ceremony",
    typeof signupFields.public_key?.user?.id === "string" &&
      signupFields.public_key.user.id.length > 0,
    `user.id=${typeof signupFields.public_key?.user?.id}`,
  );
  check(
    "the two ceremonies have DIFFERENT challenges",
    signupFields.public_key?.challenge !== loginFields.public_key?.challenge,
    "a shared challenge would let one ceremony's response satisfy the other",
  );

  // ---- password fallback still works, so the remaining UX claims are testable
  await page.evaluate(clickExact, "Create account");
  await waitFor(page, () => document.body.innerText.includes("Create account with passkey"), {
    label: "signup form",
  });
  await page.evaluate(clickExact, "Continue with password");
  await waitFor(page, () => document.body.innerText.includes("Create account with password"), {
    label: "password signup form",
  });
  await page.evaluate(setInput, "input[type=email]", email);
  await page.evaluate(setInput, "input[type=text]", "VFY Verifier");
  await page.evaluate(setInput, "input[type=password]", password);
  await page.evaluate(submitForm);
  const afterSignup = await waitFor(page, signupReachedTerminalState, {
    timeout: 60_000,
    label: "password signup result",
  }).catch(() => null);
  check(
    "email + password registration reaches a terminal screen",
    Boolean(afterSignup),
    afterSignup ? "" : "the signup form is still on screen after 60s",
  );
  if (!afterSignup) {
    // Continuing would time out again on the next wait, and the run would end as a
    // harness fault. Reporting the first failure with everything gathered is worth
    // more than four timeouts.
    check(
      "the browser console produced no errors during the journey",
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(" | "),
    );
    if (SHOTS) await page.screenshot(join(SHOTS, "02a-after-signup-stuck.png"));
    await shutdown();
    console.log(`\n${results.length - failures}/${results.length} browser checks passed`);
    process.exitCode = 1;
    return;
  }
  if (SHOTS) await page.screenshot(join(SHOTS, "02a-after-signup.png"));

  // ---- F01-002: the verification step must be completable FROM THE UI -------
  //
  // V00-2026-09-27, finding VFY-002: `verifyEmail()` was exported from
  // `lib/api.ts` and called from nowhere, and the screen showed a one-time code
  // with no control to submit it. `email_verified` could therefore never become
  // true, and because `Permission::requires_verified_email()` refuses every
  // mutating permission, the first thing a new user tries -- creating an
  // organization -- was refused with 403 `email_verification_required`, forever.
  //
  // The version of this probe in the V00 evidence directory called
  // `POST /api/v1/auth/verify-email` itself when the UI could not, so the journey
  // continued and the defect stayed invisible in the tally. That fallback is gone.
  // The UI is driven, or the probe fails here.
  const verifyScreen = Boolean(await page.evaluate(looksLikeVerificationStep));
  check(
    "registration hands the user a verification step to complete",
    verifyScreen,
    verifyScreen
      ? ""
      : "the account is unverified, so F01-002 requires a step that sets email_verified",
  );

  if (verifyScreen) {
    const control = await page.evaluate(() => {
      const form = [...document.querySelectorAll("form")].find((f) =>
        /one-time code/i.test(f.textContent),
      );
      const input = form?.querySelector("input");
      const submit = [...(form?.querySelectorAll("button") ?? [])].find((b) => b.type === "submit");
      const label = input ? document.querySelector(`label[for="${input.id}"]`) : null;
      return {
        found: Boolean(form && input && submit),
        inputNamed: Boolean(input?.name),
        labelled: Boolean(label),
        submitText: submit?.textContent?.trim() ?? "",
        // The submit must be enabled once a code is typed. A permanently disabled
        // button is the same dead end wearing a different hat.
        disabledBeforeTyping: submit?.disabled ?? null,
      };
    });
    check(
      "the verification step renders a submittable form, not a dead end",
      control.found,
      JSON.stringify(control),
    );
    check(
      "the one-time code field is named and labelled",
      control.inputNamed && control.labelled,
      JSON.stringify(control),
    );

    // Everything below INTERACTS with the form the two checks above just proved
    // exists. Run against the pre-repair product the first check reports
    // `found: false` and then `Object.getOwnPropertyDescriptor(...).set.call(
    // undefined, ...)` throws `TypeError: Illegal invocation`, so the probe died
    // with exit 2 and the remaining checks never ran. A verifier must survive the
    // state it exists to detect: report the missing form as a failure, and say
    // that the interactive checks could not be attempted.
    if (!control.found) {
      check(
        "the verification submit can be disabled and re-enabled",
        false,
        "no verification form exists to interact with, so its behaviour cannot be checked. " +
          "Reported rather than crashed: a verifier that dies on the state it exists to detect " +
          "reports a harness fault where it should report the defect",
      );
    } else {
      // The development flow pre-fills the code, so the disabled state is only
      // observable after clearing the field. Asserted directly rather than through
      // `control`, because `control` was captured before the clear.
      const submitStates = await page.evaluate(() => {
        const input = document.querySelector("input[name=one-time-code]");
        if (!input) return { missing: true, before: null, afterEmpty: null };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        const readDisabled = () => {
          const form = input.closest("form");
          const button = [...(form?.querySelectorAll("button") ?? [])].find(
            (b) => b.type === "submit",
          );
          return button?.disabled ?? null;
        };
        const before = readDisabled();
        setter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return { before, afterEmpty: readDisabled() };
      });
      check(
        "the verification submit is disabled while the field is empty",
        submitStates.afterEmpty === true,
        JSON.stringify(submitStates),
      );
      await sleep(120);
      await page.evaluate(() => {
        const input = document.querySelector("input[name=one-time-code]");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "abc");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(120);
      const tooShortDisabled = await page.evaluate(() => {
        const form = document.querySelector("input[name=one-time-code]")?.closest("form");
        const button = [...(form?.querySelectorAll("button") ?? [])].find(
          (b) => b.type === "submit",
        );
        return button?.disabled ?? null;
      });
      check(
        "the verification submit stays disabled for an implausibly short code",
        tooShortDisabled === true,
        `disabled=${tooShortDisabled}`,
      );
    }

    // Read the code from the element that displays it.
    //
    // The first version regexed `/\d{6,}/` out of `document.body.innerText`,
    // assuming a short numeric code. The real development code is a 64-character
    // hex string, so the regex matched a numeric run INSIDE it and submitted a
    // wrong value -- which the server correctly refused with 401
    // "The verification link is invalid or expired". A verifier that mangles its
    // own input and then blames the product is worse than no verifier, so the
    // value is now read from the element that renders it, and its shape is
    // checked before it is used.
    const code = await page.evaluate(() => {
      const el = [...document.querySelectorAll("code")].find((node) =>
        /^[0-9a-f]{32,}$/i.test(node.textContent.trim()),
      );
      return el?.textContent.trim() ?? null;
    });
    // Absent is not an error here: a production build never shows a code. It is
    // only a failure in the development build, which is what this probe drives.
    check(
      "the development build surfaces the verification code to the operator",
      typeof code === "string" && /^[0-9a-f]{32,}$/i.test(code),
      `code=${code ? `${code.slice(0, 6)}… (${code.length} chars)` : "not shown"}`,
    );

    if (code) {
      const issued = await page.evaluate(async (value) => {
        const before = window.__vfy.exchanges.filter((e) =>
          e.url.includes("/auth/verify-email"),
        ).length;
        const input = document.querySelector("input[name=one-time-code]");
        if (!input) {
          return {
            typed: false,
            status: null,
            body: "no one-time-code input exists, so the code could not be typed",
          };
        }
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const form = input.closest("form");
        form?.requestSubmit();
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, 250));
          const after = window.__vfy.exchanges.filter((e) => e.url.includes("/auth/verify-email"));
          if (after.length > before) {
            return { typed: true, status: after.at(-1).status, body: after.at(-1).body };
          }
        }
        return { typed: true, status: null, body: "no request was issued" };
      }, code);
      check(
        "submitting the form calls POST /api/v1/auth/verify-email",
        issued.typed && typeof issued.status === "number",
        `typed=${issued.typed} status=${issued.status} ${String(issued.body).slice(0, 120)}`,
      );
      check(
        "the UI completes verification successfully",
        issued.status === 200 || issued.status === 201 || issued.status === 204,
        `status=${issued.status} ${String(issued.body).slice(0, 160)}`,
      );
      await sleep(1500);
      if (SHOTS) await page.screenshot(join(SHOTS, "02b-verified.png"));

      // A shell that still refuses mutation after a successful verification would
      // mean the step did not actually set the flag.
      const verifiedShell = await page.evaluate(async () => {
        const response = await fetch("/api/v1/me");
        return { status: response.status, body: await response.json() };
      });
      check(
        "the session now reports a verified email",
        verifiedShell.status === 200 && verifiedShell.body?.user?.email_verified === true,
        `email_verified=${verifiedShell.body?.user?.email_verified}`,
      );
    }
  }
  // A brand-new member lands on the create-organization panel, which has no
  // switcher, so the shell test accepts either. Repair-independent: it looks for a
  // control that only an authenticated session renders, not for the verification
  // form's input, which the pre-repair product does not have.
  const reachedShell = await waitFor(
    page,
    () =>
      Boolean(
        document.querySelector("#org-switcher") ||
        [...document.querySelectorAll("button, form, input")].some((el) =>
          /organization name|create an organization|new organization/i.test(
            `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""}`,
          ),
        ) ||
        document.querySelector("[role=alert]"),
      ) || undefined,
    { timeout: 60_000, label: "authenticated shell" },
  ).catch(() => false);
  check(
    "a password session renders the authenticated organization shell",
    reachedShell !== false,
    reachedShell !== false ? "" : "no shell control appeared within 60s",
  );
  if (SHOTS) await page.screenshot(join(SHOTS, "02-authenticated-shell.png"));

  // ---- two organizations with distinctive names ---------------------------
  async function createOrg(name) {
    // A brand-new member lands straight on the create-organization panel, so
    // there may be no button to press first.
    const alreadyOpen = await page.evaluate(() =>
      document.body.innerText.includes("Create an organization"),
    );
    if (!alreadyOpen) {
      const opened = await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((node) =>
          /create an organization|new organization/i.test(node.textContent),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      if (!opened) return false;
      await sleep(400);
    }
    const filled = await page.evaluate((value) => {
      const label = [...document.querySelectorAll("label")].find((l) =>
        /organization name/i.test(l.textContent),
      );
      const input = label?.querySelector("input") ?? document.querySelector("input[type=text]");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, name);
    if (!filled) return false;
    await page.evaluate(submitForm);
    await sleep(2500);
    return page.evaluate((value) => document.body.innerText.includes(value), name);
  }
  const createdA = await createOrg(orgA);
  check("an organization can be created through the UI", createdA, `A=${createdA}`);

  // ---- F02-001: a second organization must be reachable from the shell -------
  //
  // V00-2026-09-27, finding VFY-003: `showCreateOrg` was initialised from
  // `me.organizations.length === 0` and only ever set to `false`, so the
  // create-organization panel was unreachable once a user belonged to any
  // organization. The API accepted a second one; only the UI hid it.
  //
  // The version of this probe in the V00 evidence directory created the second
  // organization through `POST /api/v1/orgs` when the UI could not, then reloaded
  // so the switcher claims below stayed testable. That fallback is gone: it made
  // the switcher evidence depend on the probe repairing its own subject.
  //
  // The two checks are deliberately separate. "The control is absent" and "the
  // panel cannot be opened" are different failures, and a fix that added a
  // control which did nothing would pass only the first.
  const reOpenControl = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((node) =>
      /new organization|create an organization/i.test(node.textContent),
    );
    return { present: Boolean(button), visible: Boolean(button?.getClientRects().length) };
  });
  check(
    "a control exists to open the create-organization panel again",
    reOpenControl.present,
    JSON.stringify(reOpenControl),
  );

  const createdB = await createOrg(orgB);
  check(
    "a SECOND organization can be created through the UI",
    createdB,
    createdB ? "" : "the panel could not be reopened once the user had one organization",
  );

  const switcherHasBoth = await waitFor(
    page,
    () => {
      const el = document.querySelector("#org-switcher");
      return el && el.options.length >= 2 ? el.options.length : false;
    },
    { label: "switcher listing both organizations", timeout: 40_000 },
  ).catch(() => 0);
  check(
    "the organization switcher lists both organizations after the UI created the second",
    Number(switcherHasBoth) >= 2,
    `options=${switcherHasBoth}`,
  );
  if (SHOTS) await page.screenshot(join(SHOTS, "03-org-created.png"));

  // ---- VI-UX-001: switching organization must not show stale data ----------
  //
  // Bounded, and the skip is reported rather than assumed. An unbounded wait here
  // turned a run that had already named two product defects into a 30-minute
  // timeout with exit 2, which reads as a broken harness instead of a broken
  // product. The switcher claims need two organizations, which the checks above
  // already tried to create; if that did not happen, saying so is the result.
  const hasSwitcher = await waitFor(page, () => Boolean(document.querySelector("#org-switcher")), {
    label: "organization shell after both orgs exist",
    timeout: 20_000,
  })
    .then(() => true)
    .catch(() => false);
  if (!hasSwitcher) {
    check(
      "the organization switcher exists, so cross-organization claims can be checked",
      false,
      "no switcher is present, which follows from the UI not being able to reach a second " +
        "organization. The VI-UX-001 and VI-UX-002 claims below are UNPROVEN, not PASS: a " +
        "verifier that cannot reach the state it is testing has proved nothing about it.",
    );
    if (SHOTS) await page.screenshot(join(SHOTS, "03b-no-switcher.png"));
    console.log(`\n${results.length - failures}/${results.length} browser checks passed`);
    process.exitCode = 1;
    return;
  }
  const switcher = await page.evaluate(() => {
    const el = document.querySelector("#org-switcher");
    return el ? [...el.options].map((o) => o.textContent.trim()) : null;
  });
  check(
    "the switcher always names the current organization and lists both",
    Array.isArray(switcher) && switcher.length >= 2,
    JSON.stringify(switcher),
  );

  async function switchTo(label) {
    const applied = await page.evaluate((wanted) => {
      const el = document.querySelector("#org-switcher");
      if (!el) return "no switcher";
      const option = [...el.options].find((o) => o.textContent.trim() === wanted);
      if (!option) return "no such option";
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(
        el,
        option.value,
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, label);
    if (applied !== true) return { applied, samples: [] };
    // Sample the rendered CONTENT continuously across the switch so a
    // transient flash of the previous organization's name is caught, not just
    // the settled state. The switcher's own <select> is excluded: it
    // legitimately lists every organization, so its option text is not a leak.
    const samples = [];
    for (let i = 0; i < 24; i += 1) {
      samples.push(
        await page.evaluate(() => {
          const switcher = document.querySelector("#org-switcher");
          if (switcher) switcher.style.display = "none";
          const text = document.body.innerText;
          if (switcher) switcher.style.display = "";
          return text;
        }),
      );
      await sleep(60);
    }
    return { applied, samples };
  }

  const switchedToB = await switchTo(orgB);
  if (switchedToB.applied !== true) {
    check(
      "the organization switcher can move to the second organization",
      false,
      String(switchedToB.applied),
    );
  } else {
    const leakedOnB = switchedToB.samples.filter((t) => t.includes(orgA));
    check(
      "after switching to org B no sample of the DOM ever shows org A's name",
      leakedOnB.length === 0 && switchedToB.samples.at(-1).includes(orgB),
      `samples=${switchedToB.samples.length} leaks=${leakedOnB.length}`,
    );
    if (SHOTS) await page.screenshot(join(SHOTS, "04-org-b-after-switch.png"));

    const switchedToA = await switchTo(orgA);
    const leakedOnA = switchedToA.samples.filter((t) => t.includes(orgB));
    check(
      "switching back restores org A and org B's name is never left behind",
      leakedOnA.length === 0 && switchedToA.samples.at(-1).includes(orgA),
      `samples=${switchedToA.samples.length} leaks=${leakedOnA.length}`,
    );
  }

  // ---- deep link / back button --------------------------------------------
  const slug = await page.evaluate(() => {
    const el = document.querySelector("#org-switcher");
    return el?.selectedOptions?.[0]?.textContent ?? "";
  });
  const deepLink = await page.evaluate(
    (organizationSlug) => {
      window.history.pushState({}, "", `/org/${organizationSlug}/settings/data`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return window.location.pathname;
    },
    await page.evaluate(() => document.body.innerText.match(/([a-z0-9-]+) · active/)?.[1] ?? "x"),
  );
  await sleep(1400);
  const deepLinkText = await page.text();
  check(
    "a hand-edited deep link resolves to a real panel, not a silent Overview",
    /Data & retention|Export history|Billing/i.test(deepLinkText),
    `${deepLink} (${slug})`,
  );
  if (SHOTS) await page.screenshot(join(SHOTS, "05-deeplink-data.png"));

  // ---- keyboard reachability and visible focus ----------------------------
  //
  // V02-001 REPAIRED. The previous version of this check was:
  //
  //   (focusProbe.boxShadow && focusProbe.boxShadow !== "none") || (outline not "none")
  //
  // and its own diagnostic printed `rgba(0, 0, 0, 0)` while it PASSED. Two failures in three
  // characters: `boxShadow !== "none"` is satisfied by a ZERO-ALPHA shadow, which is the canonical
  // absence of one, and any RESTING shadow satisfies it too. In a design system where every control
  // is `rounded-lg` with a border and a drop shadow, that assertion is true for every focused control
  // in the application -- and would still be true with the focus ring deleted from the source. The
  // check could not fail on the defect it names.
  //
  // The repair is a DELTA rather than an absolute: measure the control's rendering UNFOCUSED, then
  // again after a REAL key press, and require the rendering to change. A resting shadow is present
  // in both readings and cancels, so the assertion is immune to resting shadows, to transparent
  // layers, and to design-system tokens at once. This is the same "measure the delta, never an
  // absolute" discipline the V01 webhook fan-out gate uses for an absence.
  //
  // The key press is real. `element.focus()` from script and a synthetic `new KeyboardEvent` both
  // leave `cdp.mjs` without a way to deliver a key, which is why the old measurement could not
  // engage `:focus-visible` the way a keyboard user does. `page.press("Tab")` is one CDP call and
  // moves focus through the same input path a physical key takes.
  const focusProbe = await page.evaluate(() => {
    const target = document.querySelector("#org-switcher");
    if (!target) return null;
    // The delta below is only meaningful if the control did NOT already hold focus when `before` is
    // read. If it did, both readings are identical and the assertion reports "focusing changed
    // nothing" -- which is TRUE, because nothing changed.
    //
    // That is not hypothetical: the first run of this repair failed its OWN baseline with
    // `before="none" after="none"`, because the journey leaves focus on the switcher by the time it
    // gets here. The dependency was real and unstated, so the fix is to make the precondition
    // explicit and to report whether it had to be established. A check whose correctness depends on
    // incidental state elsewhere in the journey will fail for an unrelated reason, and "unrelated
    // reason" is how a green sheet becomes a coincidence.
    const alreadyFocused = document.activeElement === target;
    if (alreadyFocused) target.blur();
    const read = (element) => {
      const styles = getComputedStyle(element);
      return {
        boxShadow: styles.boxShadow,
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        outlineColor: styles.outlineColor,
        borderColor: styles.borderColor,
        background: styles.backgroundColor,
        // A ring can also be painted with an outline, so the outline's own width matters: an
        // `outline: none / 1px` pair is the "no outline" declaration, not a 1px outline.
        outlineVisible: styles.outlineStyle !== "none" && styles.outlineWidth !== "0px",
      };
    };
    return { before: read(target), alreadyFocused };
  });

  // A real Tab, repeated until the target itself holds focus. The first Tab from wherever focus
  // happens to sit may land elsewhere, and asserting on the wrong element would be the same class
  // of error as measuring the wrong property.
  let focusReached = false;
  let focusAfter = null;
  for (let attempt = 0; attempt < 24 && !focusReached; attempt += 1) {
    await page.press("Tab");
    focusAfter = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return { id: null, tag: "body" };
      const styles = getComputedStyle(active);
      return {
        id: active.id || null,
        tag: active.tagName,
        label: (active.textContent ?? "").trim().slice(0, 40),
        focusVisible: active.matches(":focus-visible"),
        boxShadow: styles.boxShadow,
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        outlineColor: styles.outlineColor,
        borderColor: styles.borderColor,
        background: styles.backgroundColor,
        outlineVisible: styles.outlineStyle !== "none" && styles.outlineWidth !== "0px",
      };
    });
    focusReached = focusAfter.id === "org-switcher";
  }

  check(
    "the focus delta's PRECONDITION holds: the switcher was not focused when its unfocused reading " +
      "was taken (the journey had left focus on it, which made the first run of this repair fail " +
      "its own baseline with before=after)",
    focusProbe !== null,
    `alreadyFocused=${focusProbe?.alreadyFocused} before.boxShadow=${JSON.stringify(focusProbe?.before?.boxShadow)}`,
  );
  check(
    "the organization switcher is reachable by pressing Tab (a real key event, not a synthetic one)",
    focusReached === true,
    `reached=${focusReached} active=<${focusAfter?.tag}> id=${focusAfter?.id ?? "-"} ` +
      `focusVisible=${focusAfter?.focusVisible} label=${JSON.stringify(focusAfter?.label ?? "")}`,
  );
  check(
    "the organization switcher is focusable and matches :focus-visible under keyboard focus",
    focusAfter?.focusVisible === true,
    `focusVisible=${focusAfter?.focusVisible}`,
  );

  // The delta itself. Compared property by property, because "some property changed" would be
  // satisfied by a transition the design system applies to every control regardless of focus.
  const before = focusProbe?.before;
  const changed = before
    ? [
        ["boxShadow", before.boxShadow !== focusAfter?.boxShadow],
        ["outlineWidth", before.outlineWidth !== focusAfter?.outlineWidth],
        ["outlineColor", before.outlineColor !== focusAfter?.outlineColor],
        ["borderColor", before.borderColor !== focusAfter?.borderColor],
        ["background", before.background !== focusAfter?.background],
      ].filter(([, changed]) => changed)
    : [];
  check(
    "focusing the switcher VISIBLY changes its rendering (a delta, not the presence of a shadow)",
    changed.length > 0,
    `changed=[${changed.map(([name]) => name).join(", ")}] ` +
      `before.boxShadow=${JSON.stringify(before?.boxShadow)} ` +
      `after.boxShadow=${JSON.stringify(focusAfter?.boxShadow)}`,
  );
  // And the assertion that actually closes V02-001, stated so it does not depend on WHICH property
  // carries the indicator.
  //
  // The version here first required `boxShadow` specifically, and it failed on a correct
  // implementation: the measured delta was `[outlineWidth, outlineColor]` because this control paints
  // its focus ring with an outline rather than a shadow. Demanding one property is the exact
  // brittleness the delta was introduced to remove -- a focus indicator may be a ring, an outline, or
  // a border-colour change, and a verifier that names one of them is a verifier that will report a
  // working control as broken.
  //
  // What V02-001 actually needs is narrower and is stated here: the change must include at least one
  // property that RENDERS A FOCUS INDICATOR. `background` is excluded on purpose -- a hover tint
  // would otherwise satisfy a delta that has nothing to do with focus. A control whose ring were
  // deleted changes NOTHING, so it fails both this and the case above.
  const INDICATOR_PROPERTIES = ["boxShadow", "outlineWidth", "outlineColor", "borderColor"];
  const indicatorChanged = changed.filter(([name]) => INDICATOR_PROPERTIES.includes(name));
  check(
    "focusing the switcher changes a property that RENDERS A FOCUS INDICATOR (ring, outline or " +
      "border colour) -- which is what the pre-V02-001 assertion could not distinguish from a " +
      "control's resting shadow, and a background-only change from a hover tint does not count",
    indicatorChanged.length > 0,
    `all changed=[${changed.map(([name]) => name).join(", ")}] ` +
      `indicator=[${indicatorChanged.map(([name]) => name).join(", ")}] ` +
      `before.boxShadow=${JSON.stringify(before?.boxShadow)} ` +
      `after.boxShadow=${JSON.stringify(focusAfter?.boxShadow)} ` +
      `before.outline=${JSON.stringify(before?.outlineStyle)}/${JSON.stringify(before?.outlineWidth)} ` +
      `after.outline=${JSON.stringify(focusAfter?.outlineStyle)}/${JSON.stringify(focusAfter?.outlineWidth)}`,
  );

  // A roving tabindex (one tab in the sequence, the rest reached with arrow
  // keys) is the correct ARIA pattern, so `tabIndex={-1}` on an unselected tab
  // is not a defect. The requirement is that arrow keys actually move between
  // them, which is asserted with real key events below. Anything else with a
  // negative tabIndex is a genuine keyboard dead end.
  const focusable = await page.evaluate(() => {
    const els = [
      ...document.querySelectorAll("a[href],button:not([disabled]),input,select,[tabindex]"),
    ];
    const describe = (el) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}` +
      `="${(el.textContent || "").trim().slice(0, 28)}" tabIndex=${el.tabIndex}`;
    const inRovingTablist = (el) => Boolean(el.closest('[role="tablist"]'));
    return {
      total: els.length,
      roving: els.filter((el) => el.tabIndex < 0 && inRovingTablist(el)).length,
      unreachable: els.filter((el) => el.tabIndex < 0 && !inRovingTablist(el)).map(describe),
      tabstrips: document.querySelectorAll('[role="tablist"]').length,
    };
  });
  check(
    "no interactive control outside a roving tablist is removed from the tab order",
    focusable.unreachable.length === 0,
    `total=${focusable.total} roving=${focusable.roving} tabstrips=${focusable.tabstrips} unreachable=${JSON.stringify(focusable.unreachable)}`,
  );

  // Drive the tablist with real arrow keys: focus the selected tab, press
  // ArrowRight, and require focus to land on the next tab.
  const arrowNav = await page.evaluate(() => {
    const strip = document.querySelector('[role="tablist"]');
    if (!strip) return { error: "no tablist" };
    const selected =
      strip.querySelector('[role="tab"][tabindex="0"]') ?? strip.querySelector('[role="tab"]');
    if (!selected) return { error: "no tab" };
    selected.focus();
    const before = document.activeElement.textContent.trim();
    strip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    const after = document.activeElement.textContent.trim();
    return { before, after, moved: before !== after };
  });
  check(
    "a tablist's unselected tabs are reachable with the keyboard (arrow keys)",
    arrowNav.moved === true,
    JSON.stringify(arrowNav),
  );

  // ---- narrow layout -------------------------------------------------------
  //
  // TWO MEASUREMENTS, and the difference between them is finding VFY-007.
  //
  // `documentElement.scrollWidth` is the metric V00 used, and it PASSED while the
  // Members table was clipping its Role and action columns at 390px -- because
  // the clipping happened inside an `overflow-x-auto` container, which absorbs the
  // overflow without propagating it to the document. A document that does not
  // scroll is not a page whose content is all reachable.
  //
  // So the second measurement is CONTAINMENT: for every scroll container, is any
  // of its content clipped off its own right edge, and is that content something
  // the user needs (a control, not a decorative rule or a long identifier)? This
  // is the metric that would have failed, and it is the one asserted below.
  const locateOverflow = () =>
    page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > limit + 1) {
          offenders.push(
            `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 70)} right=${Math.round(rect.right)} w=${Math.round(rect.width)}`,
          );
        }
        if (offenders.length > 6) break;
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: limit,
        offenders,
      };
    });

  /**
   * Content clipped inside a scroll container. Reports the element, the
   * container, and how much is hidden, so a failure names a thing that can be
   * fixed rather than a number that has to be interpreted.
   *
   * `interactive` counts only elements a user must be able to reach. A long
   * opaque identifier that wraps is fine; a role <select> that needs horizontal
   * scrolling to find is not.
   */
  const locateClippedContent = () =>
    page.evaluate(() => {
      const describe = (el) => {
        const id = el.id ? `#${el.id}` : "";
        const cls = String(el.className).split(" ").filter(Boolean).slice(0, 3).join(".");
        return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ""}`;
      };
      const containers = [...document.querySelectorAll("*")].filter((el) => {
        const style = getComputedStyle(el);
        return (
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          el.scrollWidth > el.clientWidth + 1
        );
      });
      // ONLY interactive elements are collected, and the budget is spent on them.
      //
      // The first version recorded every clipped node and stopped at eight. The
      // Members table produced eight non-interactive nodes -- `th`, `tbody`, `tr`,
      // `td` -- in DOM order, so the walk ended before it ever reached the role
      // `<select>`, and the check reported "no interactive control is clipped"
      // while a control was clipped by 68px. That is finding VFY-007's own shape:
      // a truncated sample reading as a clean bill of health. The count of
      // non-interactive clipping is reported separately as context.
      const INTERACTIVE =
        "button,a[href],input,select,textarea,[tabindex],[role=button],[role=tab],[contenteditable]";
      const interactiveClipped = [];
      let decorativeClipped = 0;
      for (const container of containers) {
        const box = container.getBoundingClientRect();
        for (const el of container.querySelectorAll("*")) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const hidden = Math.round(rect.right - box.right);
          if (hidden <= 1) continue;
          if (!el.matches(INTERACTIVE)) {
            decorativeClipped += 1;
            continue;
          }
          interactiveClipped.push({
            element: describe(el),
            container: describe(container),
            hiddenPx: hidden,
            label: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40),
          });
          if (interactiveClipped.length >= 6) break;
        }
        if (interactiveClipped.length >= 6) break;
      }
      return {
        scrollContainers: containers.length,
        decorativeClipped,
        interactiveClipped,
      };
    });

  const narrowSections = {};
  for (const label of ["current panel", "overview", "members", "usage"]) {
    if (label === "current panel") {
      narrowSections[label] = await locateOverflow();
    } else {
      await page.evaluate((section) => {
        const button = [...document.querySelectorAll("button")].find((b) =>
          new RegExp(`^\\s*${section}\\s*$`, "i").test(b.textContent),
        );
        button?.click();
      }, label);
      await sleep(900);
      narrowSections[label] = await locateOverflow();
    }
  }
  await page.setViewport(390, 844, true);
  await sleep(700);
  const measured = {};
  const clipped = {};
  const gotoSection = async (label) => {
    if (label === "current panel") return;
    await page.evaluate((section) => {
      const button = [...document.querySelectorAll("button")].find((b) =>
        new RegExp(`^\\s*${section}\\s*$`, "i").test(b.textContent),
      );
      button?.click();
    }, label);
    await sleep(900);
  };
  for (const label of ["current panel", "overview", "members", "usage"]) {
    await gotoSection(label);
    measured[label] = await locateOverflow();
    clipped[label] = await locateClippedContent();
  }

  // The document-level metric is kept, and it is genuinely useful: it catches a
  // page that scrolls sideways as a whole, which is its own defect.
  const overflowing = Object.entries(measured).filter(
    ([, value]) => value.scrollWidth > value.clientWidth + 1,
  );
  check(
    "the document itself does not scroll sideways at 390px",
    overflowing.length === 0,
    overflowing.length
      ? overflowing
          .map(
            ([label, value]) =>
              `${label}: ${value.scrollWidth}>${value.clientWidth} :: ${value.offenders[0] ?? "?"}`,
          )
          .join(" | ")
      : "no section overflows the document",
  );

  // The containment metric is the one that catches VFY-007, and it is asserted
  // separately because it fails for a different reason: the document is fine and
  // the content is still unreachable.
  const clippedInteractive = Object.entries(clipped).filter(
    ([, value]) => value.interactiveClipped.length > 0,
  );
  check(
    "no interactive control is clipped inside a scroll container at 390px",
    clippedInteractive.length === 0,
    clippedInteractive.length
      ? clippedInteractive
          .map(
            ([label, value]) =>
              `${label}: ${value.interactiveClipped
                .map((c) => `${c.element} hidden=${c.hiddenPx}px in ${c.container}`)
                .join(", ")}`,
          )
          .join(" | ")
      : `checked ${Object.values(clipped).reduce((n, v) => n + v.scrollContainers, 0)} scroll containers, ` +
          `${Object.values(clipped).reduce((n, v) => n + v.decorativeClipped, 0)} non-interactive nodes clipped ` +
          "(which is allowed: a long identifier may scroll)",
  );

  // The Members table specifically, because that is where the defect was found and
  // because "the role column is reachable on a phone" is the user-facing claim
  // behind F22-008.
  await gotoSection("members");
  const membersNarrow = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return { table: false };
    const headers = [...table.querySelectorAll("th")]
      .filter((th) => getComputedStyle(th).display !== "none")
      .map((th) => th.textContent.trim());
    const roleControl = document.querySelector("select[id^=role-]");
    const box = roleControl?.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    return {
      table: true,
      headers,
      viewport,
      roleControlPresent: Boolean(roleControl),
      roleControlReachable: box ? box.left >= -1 && box.right <= viewport + 1 : false,
      roleControlBox: box
        ? {
            left: Math.round(box.left),
            right: Math.round(box.right),
            width: Math.round(box.width),
            height: Math.round(box.height),
          }
        : null,
      // AGENTS.md: never trade target size for visual minimalism.
      roleControlMeetsTouchTarget: box ? box.width >= 44 && box.height >= 44 : false,
    };
  });
  // The Role is present in one of two forms at 390px: a visible column, or folded
  // into the member cell as secondary text. Either satisfies the requirement; what
  // does not satisfy it is the role being neither.
  const roleVisible = membersNarrow.headers.some((h) => /role/i.test(h));
  const roleFolded = await page.evaluate(() =>
    [...document.querySelectorAll("tbody td:first-child p")].some((p) =>
      /member|admin|owner|viewer/i.test(p.textContent),
    ),
  );
  check(
    "the Members table shows each member's role on a 390px screen",
    membersNarrow.table && (roleVisible || roleFolded),
    `headers=${JSON.stringify(membersNarrow.headers)} column=${roleVisible} folded=${roleFolded}`,
  );
  check(
    "the role control is fully inside the viewport at 390px, with no scrolling to reach it",
    membersNarrow.roleControlReachable === true,
    JSON.stringify(membersNarrow),
  );
  check(
    "the role control meets a 44x44 touch target at 390px",
    membersNarrow.roleControlMeetsTouchTarget === true,
    JSON.stringify(membersNarrow),
  );
  if (SHOTS) await page.screenshot(join(SHOTS, "06-narrow-390.png"));
  await page.setViewport(1440, 900);
  await sleep(400);

  // ---- VI-CON-001: the browser can read its own session --------------------
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/v1/me");
    return { status: response.status, body: await response.json() };
  });
  check(
    "the shell's own session is the one the browser presents to /api/v1/me",
    me.status === 200 && Array.isArray(me.body.organizations) && me.body.organizations.length >= 2,
    `orgs=${me.body?.organizations?.length}`,
  );

  // The console assertion covers the journey UP TO HERE, deliberately. The three cases below take
  // the network offline on purpose, and a rejected fetch is a console error -- so collecting across
  // them would mean either asserting zero errors over a stretch that is supposed to produce them, or
  // weakening the assertion to exclude the very failures it exists to catch. The scope is stated
  // rather than assumed.
  check(
    "the browser console produced no errors during the journey, up to the point the network is " +
      "deliberately taken offline (the three cases below are expected to log network errors)",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );

  // ==========================================================================================
  // V02-002 -- the LOADING, SERVER-ERROR and RETRY states, which no test had ever rendered.
  //
  // `app.tsx` branches four ways on `session.kind`: `loading` -> <LoadingScreen/>, `error` ->
  // <SessionError>, `anonymous` -> <AuthScreen/>, `authenticated` -> <OrgDashboard/>. The journey
  // above exercises only the last two. So three branches of the shipped product were unverified
  // code, and the objective names all three states explicitly.
  //
  // The failure is produced at the NETWORK with `Network.emulateNetworkConditions`, not by stubbing
  // anything in `apps/web`. A pending request is what shows the loading branch and a rejected one is
  // what shows the error branch -- a rejected request never shows a loading state, so the two have to
  // be produced differently or only one of them is measured at all.
  //
  // The recovery assertion is the CONTROL as well as the claim: it re-enables the network and clicks
  // the app's own retry, so a retry that silently did nothing would leave the error screen standing
  // and fail. A negative assertion with no positive counterpart is exactly the defect class this
  // campaign keeps finding.
  // ==========================================================================================

  // ---- SERVER ERROR: the API is unreachable, and the app must say so rather than spin ------------
  // The DOCUMENT still loads. Blanket `offline` fails the navigation too, so the app never mounts
  // and there is no error screen to find -- the first version of this case timed out that way and
  // would have read as a missing feature. Only the API request is failed, at the network.
  const releaseFail = await page.intercept("*/api/v1/me", { action: "fail" });
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  // NOTE the `return false` below: `waitFor` returns on the first TRUTHY value, so this predicate
  // must return a boolean, not a detail object. It only worked by accident in the first version --
  // the recovery case returned an object and therefore never waited at all.
  const errorScreen = await waitFor(
    page,
    () => {
      const alert = document.querySelector('[role="alert"]');
      if (!alert) return false;
      return {
        found: true,
        text: (alert.textContent ?? "").replace(/\s+/g, " ").trim(),
        hasRetry: Boolean(
          [...alert.querySelectorAll("button")].find((b) =>
            /retry|try again/i.test(b.textContent ?? ""),
          ),
        ),
        namesRequest: /Request\s+req_/.test((alert.textContent ?? "").replace(/\s+/g, " ")),
        stillShowsAuth: document.body.innerText.includes("Sign in with passkey"),
      };
    },
    { label: "a server-error screen" },
  );
  check(
    "with the network unreachable the app renders an ERROR state, not a spinner and not the " +
      "sign-in form -- an unreachable API is not an anonymous session, and conflating the two would " +
      "log the user out of a working session",
    errorScreen?.found === true,
    `found=${errorScreen?.found} text=${JSON.stringify(errorScreen?.text)?.slice(0, 150)}`,
  );
  check(
    "the error state is announced to assistive technology (role=alert), so it is not a silent " +
      "blank region",
    errorScreen?.found === true,
    `role=alert present=${errorScreen?.found}`,
  );
  check(
    "the error state does NOT masquerade as the sign-in form",
    errorScreen?.stillShowsAuth !== true,
    `sign-in copy still visible=${errorScreen?.stillShowsAuth}`,
  );
  check(
    "the error state offers a RETRY control -- a failure with no way forward is a dead end, and the " +
      "objective's retry/recovery state is about the offer, not only about the failure",
    errorScreen?.hasRetry === true,
    `retry=${errorScreen?.hasRetry} text=${JSON.stringify(errorScreen?.text)?.slice(0, 150)}`,
  );
  // My first expectation here was that the error state ALWAYS names a request id. It does not, and
  // it should not: a network-level failure has no HTTP response and therefore no request id, so
  // there is nothing a user could quote. `app.tsx:90` renders the line only when the id is truthy,
  // which is the right call -- rendering "Request " with nothing after it would be the defect.
  //
  // The useful assertion is the INVERSE, and it is a real one: the copy must not contain a DANGLING
  // request label. A screen that reads "Request " and stops is worse than one with no line at all,
  // because it looks like the app knows something and lost it in transit.
  check(
    "the error state contains no DANGLING request label -- a network failure has no request id, and " +
      "a screen reading 'Request ' with nothing after it is worse than no line at all",
    !/Request\s*$/.test(String(errorScreen?.text ?? "").trim()) &&
      !/\bRequest\b(?!\s+req_)/.test(String(errorScreen?.text ?? "")),
    `text=${JSON.stringify(errorScreen?.text)?.slice(0, 200)}`,
  );
  if (SHOTS) await page.screenshot(join(SHOTS, "08-server-error.png"));

  // ---- RECOVERY: the app's own retry, against a restored network. This is also the control. -----
  // The interception is RELEASED before the retry, so the request the app makes is a real one. If it
  // were not released, the retry would fail for the same reason as the original and the case would
  // pass while proving nothing about the app's retry at all.
  await releaseFail();
  await page.setNetwork({ offline: false, latencyMs: 0 });
  const retried = await page.evaluate(async () => {
    const alert = document.querySelector('[role="alert"]');
    const button = alert
      ? [...alert.querySelectorAll("button")].find((b) =>
          /retry|try again/i.test(b.textContent ?? ""),
        )
      : null;
    if (!button) return { clicked: false };
    button.click();
    return { clicked: true };
  });
  // Polled by hand rather than through `waitFor`, because `waitFor` returns on the first TRUTHY
  // value and a predicate returning an OBJECT is always truthy -- so it never waited at all and
  // sampled while the app was still in `loading`. The diagnostic said `stillError=false`, which at
  // that instant is true of every state except `error` and says nothing about recovery. A `waitFor`
  // predicate must return a boolean, and the detail has to be collected alongside rather than in place
  // of the condition.
  let recovered = null;
  for (let attempt = 0; attempt < 60 && recovered === null; attempt += 1) {
    const sample = await page.evaluate(() => {
      const body = document.body.innerText;
      return {
        stillError: Boolean(document.querySelector('[role="alert"]')),
        showsAuth: body.includes("Sign in with passkey"),
        shellWords: /Members|Settings|Overview|Projects/i.test(body),
        sawOrg: /VFY Org/i.test(body),
        snippet: body.replace(/\s+/g, " ").trim().slice(0, 120),
      };
    });
    if (!sample.stillError && (sample.shellWords || sample.showsAuth || sample.sawOrg)) {
      recovered = sample;
    } else {
      await sleep(150);
    }
  }
  check(
    "RECOVERY + CONTROL: clicking the app's own retry against a restored network returns the user to " +
      "the authenticated shell -- so the retry is a real control and not a decorative button, and " +
      "the cases above are measuring a screen the app can actually leave",
    retried.clicked === true && recovered !== null && recovered.stillError === false,
    `clicked=${retried.clicked} recovered=${recovered !== null} ` +
      `shellWords=${recovered?.shellWords} showsAuth=${recovered?.showsAuth} ` +
      `stillError=${recovered?.stillError} snippet=${JSON.stringify(recovered?.snippet)}`,
  );
  check(
    "and the recovered shell names the organization the journey created, so recovery restored the " +
      "SESSION rather than merely the page",
    recovered?.sawOrg === true,
    `sawOrg=${recovered?.sawOrg}`,
  );

  // ---- LOADING: a PENDING request, which is the only thing that shows this branch ---------------
  // The document loads normally and ONLY the API request is delayed. A rejected request never
  // renders a loading state, so this has to be a delayed request rather than a failed one -- otherwise
  // the case would pass for the wrong reason, which is the defect class this campaign finds most
  // often. Delaying the whole page instead would leave the document unparsed and the sample would be
  // measuring a blank pre-mount document rather than the app's loading state.
  const releaseDelay = await page.intercept("*/api/v1/me", { action: "delay", delayMs: 5000 });
  const reload = page.goto(WEB, { waitUntil: "domcontentloaded" });
  // Sampled DURING the request, not after: once the request settles the loading screen is gone by
  // construction, so a sample taken afterwards would be measuring the wrong moment.
  const loadingSeen = await (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const sample = await page.evaluate(() => {
        const body = document.body.innerText;
        return {
          // A spinner is not evidence on its own -- the objective asks for a loading STATE, and a
          // blank body is what a broken shell also looks like. So this asks whether something is
          // rendered at all, and separately whether it is the sign-in form.
          rendered: body.trim().length > 0,
          showsAuth: body.includes("Sign in with passkey"),
          showsError: Boolean(document.querySelector('[role="alert"]')),
          mentionsLoading: /loading|signing in|one moment/i.test(body),
        };
      });
      if (sample.rendered || sample.showsAuth || sample.showsError) return sample;
      await sleep(100);
    }
    return { rendered: false, showsAuth: false, showsError: false, mentionsLoading: false };
  })();
  await reload.catch(() => {});
  await releaseDelay();
  await page.setNetwork({ offline: false, latencyMs: 0 });
  check(
    "LOADING: with a pending (not failed) request the app renders SOMETHING rather than a blank " +
      "document -- a shell that renders nothing during load is indistinguishable from a broken one, " +
      "and it is the state a real user sees on every cold start",
    loadingSeen.rendered === true,
    `rendered=${loadingSeen.rendered} mentionsLoading=${loadingSeen.mentionsLoading} ` +
      `showsAuth=${loadingSeen.showsAuth} showsError=${loadingSeen.showsError}`,
  );
  check(
    "and it is not the ERROR state -- a pending request must not be reported as a failure, or every " +
      "slow network would look like an outage to the user",
    loadingSeen.showsError !== true,
    `showsError=${loadingSeen.showsError}`,
  );
  if (SHOTS) await page.screenshot(join(SHOTS, "09-loading.png"));

  // The network must be left exactly as it was found, or every later run inherits a broken world.
  await page.setNetwork({ offline: false, latencyMs: 0 });
  const finalConditions = await page.evaluate(() => "restored");
  check(
    "the network conditions are restored before the probe exits, so a later run cannot inherit a " +
      "deliberately broken world",
    finalConditions === "restored",
    `conditions=${finalConditions}`,
  );

  if (SHOTS) await page.screenshot(join(SHOTS, "07-final.png"));
  await shutdown();
  console.log(`\n${results.length - failures}/${results.length} browser checks passed`);
  process.exitCode = failures ? 1 : 0;
}

try {
  await main();
} catch (error) {
  // A harness fault is distinguishable from a product failure: exit 2, not 1.
  // Collapsing the two would let a broken probe read as a detected defect, or a
  // detected defect read as a broken probe, depending only on which number the
  // caller happened to treat as success.
  console.error(`browser probe failed: ${error?.stack ?? error}`);
  if (error?.code === "NO_BROWSER") console.error(`\n${NO_CHROME_REASON}`);
  process.exitCode = 2;
} finally {
  await shutdown();
}

// Explicit: an undrained handle (a Chrome pipe, a timer) must not be able to keep
// the process alive after the verdict is printed. `process.exitCode` alone does
// not do that.
process.exit(process.exitCode ?? 0);
