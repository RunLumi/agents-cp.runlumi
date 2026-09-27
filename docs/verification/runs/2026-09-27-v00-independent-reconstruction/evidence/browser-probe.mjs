/**
 * V00 real-browser evidence for the Lumi Agents control plane.
 *
 * Crosses: real Chrome -> Vite dev server -> Wrangler dev Worker -> D1.
 * Nothing is mocked. The session cookie, CSRF token, WebAuthn ceremony, and
 * every org-scoped read come from the running system.
 *
 * The WebAuthn authenticator is a real CTAP2 virtual authenticator registered
 * through CDP, so `navigator.credentials.create` is a genuine registration
 * rather than a stub.
 *
 * Usage:
 *   VFY_SHOTS=<dir> node browser-probe.mjs
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { launch, newPage } from "./cdp.mjs";

const WEB = process.env.VFY_WEB ?? "http://localhost:5173/";
const SHOTS = process.env.VFY_SHOTS;
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, { timeout = 25_000, interval = 150, label = "condition" } = {}) {
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

async function main() {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const stamp = Date.now();
  const email = `vfy-${stamp}@example.test`;
  const password = "correct horse battery staple 42";
  const orgA = `VFY Org A ${stamp}`;
  const orgB = `VFY Org B ${stamp}`;

  const browser = await launch({ port: 9333 });
  const page = await newPage(browser);
  const consoleErrors = [];
  browser.on((data) => {
    if (data.sessionId !== page.sessionId) return;
    if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
      consoleErrors.push(data.params.args.map((a) => a.value ?? a.description).join(" "));
    }
    if (data.method === "Runtime.exceptionThrown") {
      consoleErrors.push(data.params.exceptionDetails?.exception?.description ?? "exception");
    }
  });

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
      return { url, status: response.status, body: (await response.text()).slice(0, 200) };
    };
    return {
      signup: await attempt("/api/v1/auth/passkey/signup/start", {
        email: mail,
        display_name: "VFY Verifier",
      }),
      login: await attempt("/api/v1/auth/passkey/login/start", {}),
    };
  }, email);
  check("POST /api/v1/auth/passkey/signup/start returns server-side creation options",
    ceremonyProbe.signup.status === 200, `status=${ceremonyProbe.signup.status} ${ceremonyProbe.signup.body}`);
  check("POST /api/v1/auth/passkey/login/start returns server-side request options",
    ceremonyProbe.login.status === 200, `status=${ceremonyProbe.login.status} ${ceremonyProbe.login.body}`);

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
  const afterSignup = await waitFor(
    page,
    () =>
      document.body.innerText.includes("Verification required") ||
      document.body.innerText.includes("ORGANIZATION") ||
      document.body.innerText.includes("Create an organization"),
    { timeout: 60_000, label: "password signup result" },
  );
  check("email + password registration succeeds in a real browser", Boolean(afterSignup));
  const verifyScreen = await page.evaluate(() =>
    document.body.innerText.includes("Verification required"),
  );
  check("the web shell offers no control that submits the one-time email code",
    verifyScreen === false || !(await page.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /verify|confirm code/i.test(b.textContent)),
    )),
    verifyScreen ? "verification screen shown; `verifyEmail` is exported but never called" : "no verification step");
  if (SHOTS) await page.screenshot(join(SHOTS, "02a-after-signup.png"));

  if (verifyScreen) {
    // The UI cannot finish this step, so the probe does it through the same
    // public API the UI is missing. This keeps the org-switch/focus/narrow
    // claims testable without pretending the web flow is complete.
    const verified = await page.evaluate(async () => {
      const exchange = window.__vfy.exchanges.find(
        (e) => e.url.includes("/api/v1/auth/password/signup") && e.body,
      );
      const payload = JSON.parse(exchange.body);
      const response = await fetch("/api/v1/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge_id: payload.verification.challenge_id,
          code: payload.verification.development_code,
        }),
      });
      return { status: response.status, body: (await response.text()).slice(0, 160) };
    });
    check("email verification succeeds when the client actually calls the endpoint",
      verified.status === 200, `status=${verified.status} ${verified.body}`);
    await page.evaluate(clickExact, "Continue to sign in");
    await waitFor(page, () => document.body.innerText.includes("Sign in with password"), {
      label: "sign-in form",
    });
    await page.evaluate(setInput, "input[type=email]", email);
    await page.evaluate(setInput, "input[type=password]", password);
    await page.evaluate(clickExact, "Sign in with password");
  }
  await waitFor(
    page,
    () =>
      document.body.innerText.includes("ORGANIZATION") ||
      document.body.innerText.includes("Create an organization"),
    { timeout: 60_000, label: "authenticated shell" },
  );
  check("a password session renders the authenticated organization shell", true);
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
  const createdB = await createOrg(orgB);
  check("an organization can be created through the UI", createdA, `A=${createdA}`);
  check(
    "a SECOND organization can also be created through the UI",
    createdB,
    createdB
      ? ""
      : "`showCreateOrg` is only ever initialised, never set back to true, so the panel is unreachable once the user has one organization",
  );

  if (!createdB) {
    // Create the second organization through the same public API the UI is
    // missing a control for, so the organization-switch claims below stay
    // testable instead of collapsing into the same defect.
    const viaApi = await page.evaluate(async (name) => {
      // Same double-submit CSRF proof the web client sends: the browser holds
      // `lumi_csrf` and echoes it on an unsafe method.
      const csrf = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("lumi_csrf="))
        ?.slice("lumi_csrf=".length);
      const response = await fetch("/api/v1/orgs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf ?? "",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ display_name: name }),
      });
      return { status: response.status, body: (await response.text()).slice(0, 160) };
    }, orgB);
    check("the API itself accepts a second organization (so the limit is the UI, not the server)",
      viaApi.status === 200 || viaApi.status === 201, `status=${viaApi.status} ${viaApi.body}`);
    await page.evaluate(() => window.location.reload());
    await waitFor(page, () => Boolean(document.querySelector("#org-switcher")), {
      timeout: 40_000,
      label: "shell after reload",
    });
  }
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
  // Attribute the overflow to a concrete element rather than reporting a number.
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
  for (const label of ["current panel", "overview", "members", "usage"]) {
    if (label === "current panel") {
      measured[label] = await locateOverflow();
    } else {
      await page.evaluate((section) => {
        const button = [...document.querySelectorAll("button")].find((b) =>
          new RegExp(`^\\s*${section}\\s*$`, "i").test(b.textContent),
        );
        button?.click();
      }, label);
      await sleep(900);
      measured[label] = await locateOverflow();
    }
  }
  const overflowing = Object.entries(measured).filter(
    ([, value]) => value.scrollWidth > value.clientWidth + 1,
  );
  check("no horizontal overflow at 390px on any critical section",
    overflowing.length === 0,
    overflowing.length
      ? overflowing
          .map(([label, value]) => `${label}: ${value.scrollWidth}>${value.clientWidth} :: ${value.offenders[0] ?? "?"}`)
          .join(" | ")
      : "no section overflows");
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
  await browser.close();
  console.log(`\n${results.length - failures}/${results.length} browser checks passed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(`browser probe failed: ${error.stack ?? error}`);
  process.exitCode = 2;
});
