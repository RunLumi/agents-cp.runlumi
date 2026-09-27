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

async function waitFor(page, fn, { timeout = STEP_TIMEOUT, interval = 150, label = "condition" } = {}) {
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
  const el = [...document.querySelectorAll("button")].find(
    (n) => n.textContent.trim() === text,
  );
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
  check("a real CTAP2 virtual authenticator (resident key + UV) is attached", Boolean(authenticatorId));

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
  check("sign-in's first submit control is the passkey CTA",
    Boolean(submit) && /passkey/i.test(submit.text) && submit.primary,
    `submit="${submit?.text}" primary=${submit?.primary}`);
  check("the passkey CTA precedes the email field (passkey-first, not password-first)",
    emailAt > 0 && submit.index < emailAt, `submit@${submit.index} email@${emailAt}`);
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
  check("POST /api/v1/auth/passkey/signup/start returns server-side creation options",
    ceremonyOk(ceremonyProbe.signup), `status=${ceremonyProbe.signup.status} ${ceremonyProbe.signup.body}`);
  check("POST /api/v1/auth/passkey/login/start returns server-side request options",
    ceremonyOk(ceremonyProbe.login), `status=${ceremonyProbe.login.status} ${ceremonyProbe.login.body}`);
  check("both ceremony options carry a distinct server-issued challenge",
    typeof signupFields.public_key?.challenge === "string" &&
      signupFields.public_key.challenge.length >= 16 &&
      typeof loginFields.public_key?.challenge === "string" &&
      loginFields.public_key.challenge.length >= 16,
    // The SPA must never mint its own challenge: an attacker who can choose it
    // chooses the one the server verifies.
    `signup.challenge=${typeof signupFields.public_key?.challenge} ` +
      `login.challenge=${typeof loginFields.public_key?.challenge}`);
  // `rpId` appears on a PublicKeyCredentialRequestOptions (login) and NOT on a
  // PublicKeyCredentialCreationOptions (registration) -- for registration the RP
  // ID is implied by the caller's origin. Asserting it on the registration
  // response was a probe bug, not a product defect.
  check("the login ceremony options name the relying party explicitly",
    loginFields.public_key?.rpId === "localhost",
    `rpId=${loginFields.public_key?.rpId}`);
  check("the registration ceremony options bind the account to the ceremony",
    typeof signupFields.public_key?.user?.id === "string" &&
      signupFields.public_key.user.id.length > 0,
    `user.id=${typeof signupFields.public_key?.user?.id}`);
  check("the two ceremonies have DIFFERENT challenges",
    signupFields.public_key?.challenge !== loginFields.public_key?.challenge,
    "a shared challenge would let one ceremony's response satisfy the other");

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
  // Matched on STRUCTURE, not on copy. The first version of this wait looked for
  // the literal string "Verification required", and it timed out once the
  // verification step was repaired and reworded -- a verifier coupled to
  // marketing copy breaks when the copy is fixed, which is backwards. What must
  // be true is that the app reached a terminal state after signup: either the
  // verification form, or the authenticated shell.
  const afterSignup = await waitFor(
    page,
    () =>
      Boolean(
        document.querySelector("input[name=one-time-code]") ||
          document.querySelector("#org-switcher") ||
          /create an organization/i.test(document.body.innerText),
      ) || undefined,
    { timeout: 60_000, label: "password signup result" },
  );
  check("email + password registration reaches a terminal screen", Boolean(afterSignup));
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
  const verifyScreen = await page.evaluate(() =>
    /verify .*email|one-time code/i.test(document.body.innerText),
  );
  check("registration hands the user a verification step to complete", verifyScreen,
    "the account is unverified, so F01-002 requires a step that sets email_verified");

  if (verifyScreen) {
    const control = await page.evaluate(() => {
      const form = [...document.querySelectorAll("form")].find((f) =>
        /one-time code/i.test(f.textContent),
      );
      const input = form?.querySelector("input");
      const submit = [...(form?.querySelectorAll("button") ?? [])].find(
        (b) => b.type === "submit",
      );
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
    check("the verification step renders a submittable form, not a dead end",
      control.found, JSON.stringify(control));
    check("the one-time code field is named and labelled",
      control.inputNamed && control.labelled, JSON.stringify(control));
    // The development flow pre-fills the code, so the disabled state is only
    // observable after clearing the field. Asserted directly rather than through
    // `control`, because `control` was captured before the clear.
    const submitStates = await page.evaluate(() => {
      const input = document.querySelector("input[name=one-time-code]");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const readDisabled = () => {
        const form = input?.closest("form");
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
    check("the verification submit is disabled while the field is empty",
      submitStates.afterEmpty === true, JSON.stringify(submitStates));
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
      const button = [...(form?.querySelectorAll("button") ?? [])].find((b) => b.type === "submit");
      return button?.disabled ?? null;
    });
    check("the verification submit stays disabled for an implausibly short code",
      tooShortDisabled === true, `disabled=${tooShortDisabled}`);

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
    check("the development build surfaces the verification code to the operator",
      typeof code === "string" && /^[0-9a-f]{32,}$/i.test(code),
      `code=${code ? `${code.slice(0, 6)}… (${code.length} chars)` : "not shown"}`);

    if (code) {
      const issued = await page.evaluate(
        async (value) => {
          const before = window.__vfy.exchanges.filter((e) =>
            e.url.includes("/auth/verify-email"),
          ).length;
          const input = document.querySelector("input[name=one-time-code]");
          if (!input) return { typed: false };
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
            input,
            value,
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const form = input.closest("form");
          form?.requestSubmit();
          for (let i = 0; i < 60; i += 1) {
            await new Promise((r) => setTimeout(r, 250));
            const after = window.__vfy.exchanges.filter((e) =>
              e.url.includes("/auth/verify-email"),
            );
            if (after.length > before) {
              return { typed: true, status: after.at(-1).status, body: after.at(-1).body };
            }
          }
          return { typed: true, status: null, body: "no request was issued" };
        },
        code,
      );
      check("submitting the form calls POST /api/v1/auth/verify-email",
        issued.typed && typeof issued.status === "number",
        `status=${issued.status} ${String(issued.body).slice(0, 120)}`);
      check("the UI completes verification successfully",
        issued.status === 200 || issued.status === 201 || issued.status === 204,
        `status=${issued.status} ${String(issued.body).slice(0, 160)}`);
      await sleep(1500);
      if (SHOTS) await page.screenshot(join(SHOTS, "02b-verified.png"));

      // A shell that still refuses mutation after a successful verification would
      // mean the step did not actually set the flag.
      const verifiedShell = await page.evaluate(async () => {
        const response = await fetch("/api/v1/me");
        return { status: response.status, body: await response.json() };
      });
      check("the session now reports a verified email",
        verifiedShell.status === 200 && verifiedShell.body?.user?.email_verified === true,
        `email_verified=${verifiedShell.body?.user?.email_verified}`);
    }
  }
  const reachedShell = await waitFor(
    page,
    () =>
      Boolean(
        document.querySelector("#org-switcher") ||
          document.querySelector("input[name=one-time-code]") ||
          /create an organization/i.test(document.body.innerText),
      ) || undefined,
    { timeout: 60_000, label: "authenticated shell" },
  ).catch(() => false);
  check("a password session renders the authenticated organization shell",
    reachedShell !== false);
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
  check("a control exists to open the create-organization panel again",
    reOpenControl.present, JSON.stringify(reOpenControl));

  const createdB = await createOrg(orgB);
  check("a SECOND organization can be created through the UI", createdB,
    createdB ? "" : "the panel could not be reopened once the user had one organization");

  const switcherHasBoth = await waitFor(
    page,
    () => {
      const el = document.querySelector("#org-switcher");
      return el && el.options.length >= 2 ? el.options.length : false;
    },
    { label: "switcher listing both organizations", timeout: 40_000 },
  ).catch(() => 0);
  check("the organization switcher lists both organizations after the UI created the second",
    Number(switcherHasBoth) >= 2, `options=${switcherHasBoth}`);
  if (SHOTS) await page.screenshot(join(SHOTS, "03-org-created.png"));

  // ---- VI-UX-001: switching organization must not show stale data ----------
  await waitFor(page, () => Boolean(document.querySelector("#org-switcher")), {
    label: "organization shell after both orgs exist",
  });
  const switcher = await page.evaluate(() => {
    const el = document.querySelector("#org-switcher");
    return el ? [...el.options].map((o) => o.textContent.trim()) : null;
  });
  check("the switcher always names the current organization and lists both",
    Array.isArray(switcher) && switcher.length >= 2, JSON.stringify(switcher));

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
    check("the organization switcher can move to the second organization", false,
      String(switchedToB.applied));
  } else {
    const leakedOnB = switchedToB.samples.filter((t) => t.includes(orgA));
    check("after switching to org B no sample of the DOM ever shows org A's name",
      leakedOnB.length === 0 && switchedToB.samples.at(-1).includes(orgB),
      `samples=${switchedToB.samples.length} leaks=${leakedOnB.length}`);
    if (SHOTS) await page.screenshot(join(SHOTS, "04-org-b-after-switch.png"));

    const switchedToA = await switchTo(orgA);
    const leakedOnA = switchedToA.samples.filter((t) => t.includes(orgB));
    check("switching back restores org A and org B's name is never left behind",
      leakedOnA.length === 0 && switchedToA.samples.at(-1).includes(orgA),
      `samples=${switchedToA.samples.length} leaks=${leakedOnA.length}`);
  }

  // ---- deep link / back button --------------------------------------------
  const slug = await page.evaluate(() => {
    const el = document.querySelector("#org-switcher");
    return el?.selectedOptions?.[0]?.textContent ?? "";
  });
  const deepLink = await page.evaluate((organizationSlug) => {
    window.history.pushState({}, "", `/org/${organizationSlug}/settings/data`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return window.location.pathname;
  }, (await page.evaluate(() => document.body.innerText.match(/([a-z0-9-]+) · active/)?.[1] ?? "x")));
  await sleep(1400);
  const deepLinkText = await page.text();
  check("a hand-edited deep link resolves to a real panel, not a silent Overview",
    /Data & retention|Export history|Billing/i.test(deepLinkText), `${deepLink} (${slug})`);
  if (SHOTS) await page.screenshot(join(SHOTS, "05-deeplink-data.png"));

  // ---- keyboard reachability and visible focus ----------------------------
  const focusProbe = await page.evaluate(() => {
    const first = document.querySelector("#org-switcher");
    if (!first) return null;
    first.focus();
    const styles = getComputedStyle(first);
    return {
      active: document.activeElement === first,
      boxShadow: styles.boxShadow,
      outline: `${styles.outlineStyle}/${styles.outlineWidth}`,
    };
  });
  check("the organization switcher is keyboard focusable", focusProbe?.active === true,
    JSON.stringify(focusProbe));
  check("focus on the primary navigation control is visible (ring or outline)",
    (focusProbe.boxShadow && focusProbe.boxShadow !== "none") ||
      (focusProbe.outline && !focusProbe.outline.startsWith("none")),
    `box-shadow=${focusProbe?.boxShadow}`);

  // A roving tabindex (one tab in the sequence, the rest reached with arrow
  // keys) is the correct ARIA pattern, so `tabIndex={-1}` on an unselected tab
  // is not a defect. The requirement is that arrow keys actually move between
  // them, which is asserted with real key events below. Anything else with a
  // negative tabIndex is a genuine keyboard dead end.
  const focusable = await page.evaluate(() => {
    const els = [...document.querySelectorAll("a[href],button:not([disabled]),input,select,[tabindex]")];
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
  check("no interactive control outside a roving tablist is removed from the tab order",
    focusable.unreachable.length === 0,
    `total=${focusable.total} roving=${focusable.roving} tabstrips=${focusable.tabstrips} unreachable=${JSON.stringify(focusable.unreachable)}`);

  // Drive the tablist with real arrow keys: focus the selected tab, press
  // ArrowRight, and require focus to land on the next tab.
  const arrowNav = await page.evaluate(() => {
    const strip = document.querySelector('[role="tablist"]');
    if (!strip) return { error: "no tablist" };
    const selected = strip.querySelector('[role="tab"][tabindex="0"]') ?? strip.querySelector('[role="tab"]');
    if (!selected) return { error: "no tab" };
    selected.focus();
    const before = document.activeElement.textContent.trim();
    strip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    const after = document.activeElement.textContent.trim();
    return { before, after, moved: before !== after };
  });
  check("a tablist's unselected tabs are reachable with the keyboard (arrow keys)",
    arrowNav.moved === true, JSON.stringify(arrowNav));

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
  check("the document itself does not scroll sideways at 390px",
    overflowing.length === 0,
    overflowing.length
      ? overflowing
          .map(
            ([label, value]) =>
              `${label}: ${value.scrollWidth}>${value.clientWidth} :: ${value.offenders[0] ?? "?"}`,
          )
          .join(" | ")
      : "no section overflows the document");

  // The containment metric is the one that catches VFY-007, and it is asserted
  // separately because it fails for a different reason: the document is fine and
  // the content is still unreachable.
  const clippedInteractive = Object.entries(clipped).filter(
    ([, value]) => value.interactiveClipped.length > 0,
  );
  check("no interactive control is clipped inside a scroll container at 390px",
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
        "(which is allowed: a long identifier may scroll)");

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
        ? { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height) }
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
  check("the Members table shows each member's role on a 390px screen",
    membersNarrow.table && (roleVisible || roleFolded),
    `headers=${JSON.stringify(membersNarrow.headers)} column=${roleVisible} folded=${roleFolded}`);
  check("the role control is fully inside the viewport at 390px, with no scrolling to reach it",
    membersNarrow.roleControlReachable === true,
    JSON.stringify(membersNarrow));
  check("the role control meets a 44x44 touch target at 390px",
    membersNarrow.roleControlMeetsTouchTarget === true,
    JSON.stringify(membersNarrow));
  if (SHOTS) await page.screenshot(join(SHOTS, "06-narrow-390.png"));
  await page.setViewport(1440, 900);
  await sleep(400);

  // ---- VI-CON-001: the browser can read its own session --------------------
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/v1/me");
    return { status: response.status, body: await response.json() };
  });
  check("the shell's own session is the one the browser presents to /api/v1/me",
    me.status === 200 && Array.isArray(me.body.organizations) && me.body.organizations.length >= 2,
    `orgs=${me.body?.organizations?.length}`);

  check("the browser console produced no errors during the journey",
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

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
