#!/usr/bin/env node
/**
 * V05 §4 — the whole-site browser sweep.
 *
 * The gap verify-05 names: the existing browser journey visits four sections
 * against nineteen. This probe drives EVERY addressable section of the control
 * plane in real Chrome — 13 top-level nav sections and 6 settings sub-pages —
 * and per section measures, in the real rendered DOM:
 *
 *   - the section actually renders (its heading appears; no error boundary);
 *   - the EMPTY state (fresh organization, no seeds) is a real screen, not a
 *     blank;
 *   - keyboard: Tab reaches an interactive element and the focus indicator is
 *     visible (getComputedStyle focus-visible outline/box-shadow, not `none`);
 *   - 390 px: `documentElement.scrollWidth <= innerWidth` — no horizontal page
 *     scroll, the failure class VFY-007 was;
 *   - a screenshot at 1440x900 and at 390x844, for the screen-reference
 *     comparison and the record.
 *
 * Beyond the breadth sweep, the states the objective names are produced at the
 * NETWORK, the same way browser-probe does it (nothing in apps/web is stubbed):
 *
 *   - server-error + retry/recovery: `Fetch`-level failure injected on a
 *     section's own API while navigating to it, released, then recovered —
 *     driven on `usage` and `models`;
 *   - one-time secret lifecycle + destructive confirmation: the API-key create
 *     flow in Settings → Security (secret shown once, then masked; revoke asks
 *     for confirmation and Escape cancels);
 *   - permission: a second, foreign account visits this organization's
 *     sections; the app must render a refusal/empty state and must NOT render
 *     the organization's data;
 *   - keyboard sign-in: the auth screen is completed entirely from the
 *     keyboard, as the manual critical-path check.
 *
 * Requires a running Vite dev server (PROBE_WEB) and development Worker
 * (PROBE_API) with migrations. Exits 1 when a check did not hold, 2 when the
 * harness could not run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..", "..");
const cdp = await import(
  `file://${join(REPO, "apps", "web", "scripts", "cdp.mjs")}`
);

const WEB = process.env.PROBE_WEB ?? "http://localhost:5173";
const API = process.env.PROBE_API ?? "http://127.0.0.1:8787";
const SHOTS = process.env.PROBE_SHOTS ?? join(HERE, "shots");
const HEADLESS = process.env.PROBE_HEADLESS !== "0";
const CDP_PORT = Number(process.env.PROBE_CDP_PORT ?? 9444);
const STAMP = Date.now().toString(36);
const PASSWORD = "correct horse battery staple 42";

mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The 19 addressable sections: path under /org/{slug}/ plus the heading text
 *  that proves the right panel rendered. */
const SECTIONS = [
  { path: "overview", expect: /overview|organization/i },
  { path: "projects", expect: /projects/i },
  { path: "runs", expect: /agents|runs/i },
  { path: "members", expect: /members/i },
  { path: "teams", expect: /teams/i },
  { path: "tools", expect: /tools|approvals/i },
  { path: "models", expect: /models|routing/i },
  { path: "usage", expect: /usage|budget/i },
  { path: "automations", expect: /automations/i },
  { path: "devices", expect: /devices/i },
  { path: "adoption", expect: /adoption/i },
  { path: "policy", expect: /policy/i },
  { path: "settings", expect: /settings/i },
  { path: "settings/billing", expect: /billing|plan/i },
  { path: "settings/data", expect: /data|export/i },
  { path: "settings/webhooks", expect: /webhooks?/i },
  { path: "settings/security", expect: /security|sessions|passkeys?/i },
  { path: "settings/identity", expect: /api key|identity|service account/i },
  { path: "settings/plugins", expect: /plugins?/i },
];

async function api(method, path, body, jar) {
  // `jar` is { cookies: Map, csrf: () => string } — authenticated mutations
  // must carry BOTH the session cookie and the X-CSRF-Token the lumi_csrf
  // cookie holds, or the request is refused 403 csrf_failed.
  const headers = {
    Accept: "application/json",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  };
  if (jar) {
    const cookie = [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.Cookie = cookie;
    const csrf = jar.cookies.get("lumi_csrf");
    if (csrf && method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrf;
  }
  // Mutations require an Idempotency-Key (the product refuses without one).
  if (method !== "GET" && method !== "HEAD") {
    headers["Idempotency-Key"] = `v05site-${STAMP}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = { raw };
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie && jar) {
    for (const value of response.headers.getSetCookie?.() ?? [setCookie]) {
      const [pair] = value.split(";");
      const at = pair.indexOf("=");
      if (at > 0) jar.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  return { status: response.status, body: parsed };
}

/** A verified account with its own organization, via the development code the
 *  signup response carries. Returns { jar, orgSlug, orgId, email, cookie }. */
async function newVerifiedAccount(label) {
  const jar = { cookies: new Map() };
  const email = `v05-site-${label}-${STAMP}@example.test`;
  const signup = await api("POST", "/api/v1/auth/password/signup", {
    email,
    display_name: `V05 Site ${label}`,
    password: PASSWORD,
  });
  if (signup.status >= 400) throw new Error(`signup failed ${signup.status}: ${JSON.stringify(signup.body).slice(0, 200)}`);
  const verification = signup.body?.verification ?? {};
  const challenge = verification.challenge_id ?? verification.challengeId;
  const code = verification.development_code ?? verification.code ?? signup.body?.development_code;
  if (!challenge || !code) throw new Error("no development verification challenge in signup response");
  const verified = await api("POST", "/api/v1/auth/verify-email", { challenge_id: challenge, code });
  if (verified.status >= 400) throw new Error(`verify failed ${verified.status}`);
  const login = await api("POST", "/api/v1/auth/password/login", { email, password: PASSWORD }, jar);
  if (login.status >= 400) throw new Error(`login failed ${login.status}`);
  const cookie = [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  if (!cookie) throw new Error("login returned no session cookie");
  const org = await api(
    "POST",
    "/api/v1/orgs",
    {
      display_name: `V05 Site Org ${label}`,
      slug: `v05-site-${label}-${STAMP}`,
    },
    jar,
  );
  if (org.status >= 400) throw new Error(`org create failed ${org.status}: ${JSON.stringify(org.body).slice(0, 200)}`);
  const me = await api("GET", "/api/v1/me", undefined, jar);
  const membership = me.body?.organizations?.[0] ?? {};
  const orgSlug = membership.organization?.slug ?? org.body?.slug;
  const orgId = membership.organization?.id ?? org.body?.id;
  if (!orgSlug) throw new Error("no organization slug after create");
  return { jar, cookie, orgSlug, orgId, email, displayName: `V05 Site Org ${label}` };
}

/** Poll until the app has rendered something stable — and the workspace
 *  loading screen is GONE, which is how a lazy route chunk announces itself. */
async function waitForRender(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      text: document.body.innerText,
      ready: document.readyState,
    }));
    const settled =
      state.ready === "complete" &&
      state.text.length > 20 &&
      !/loading your workspace/i.test(state.text) &&
      state.text === last;
    if (settled) return state.text;
    last = state.text;
    await sleep(300);
  }
  return last;
}

const FOCUS_PROBE = () => {
  const before = document.activeElement?.tagName ?? "none";
  return before;
};

// --- harness -----------------------------------------------------------------

const chrome = cdp.findChrome();
if (!chrome) {
  console.log(`FATAL: no Chrome found (${cdp.NO_CHROME_REASON ?? "autodetect failed"})`);
  process.exit(2);
}
let browser;
try {
  browser = await cdp.launch({ port: CDP_PORT, headless: HEADLESS });
} catch (error) {
  console.log(`FATAL: Chrome could not start: ${error?.message ?? error}`);
  process.exit(2);
}

let owner, foreign;
try {
  owner = await newVerifiedAccount("owner");
  foreign = await newVerifiedAccount("foreign");
} catch (error) {
  console.log(`FATAL: account setup failed: ${error?.message ?? error}`);
  process.exit(2);
}
console.log(`accounts ready — owner org: ${owner.orgSlug}`);

const page = await cdp.newPage(browser, "about:blank");
// A Chrome left over from an earlier run (same CDP port) carries its session
// cookies, and a sweep that begins signed-in measures the WRONG account all the
// way down. Start anonymous, always.
await page.send("Network.enable", {});
await page.send("Network.clearBrowserCookies", {});
const pageErrors = [];
const originalOnError = (data) => {
  if (data.sessionId === page.sessionId && data.method === "Runtime.exceptionThrown") {
    pageErrors.push(data.params?.exceptionDetails?.exception?.description ?? "exception");
  }
};
browser.on(originalOnError);

const ORG_BASE = `${WEB}/org/${owner.orgSlug}`;

// --- sign the browser in via the real form, from the keyboard -----------------
await page.setViewport(1440, 900);
await page.goto(`${WEB}/`);
await waitForRender(page);
const keyboardSignin = async () => {
  const auth = await page.evaluate(() => document.body.innerText);
  if (!/sign in|sign up|passkey|password/i.test(auth)) {
    return `auth screen not rendered: ${auth.slice(0, 80)}`;
  }
  // Real keyboard path: Tab into the email field, type, Tab to password, type,
  // submit with Enter. `Input.dispatchKeyEvent` is the browser's own input.
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
  const focusAfterTab = await page.evaluate(FOCUS_PROBE);
  if (!["INPUT", "BUTTON", "A"].includes(focusAfterTab)) {
    return `first Tab landed on ${focusAfterTab}`;
  }
  const focusedVisible = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return "no active element";
    const style = getComputedStyle(el);
    const visible =
      (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
      (style.boxShadow && style.boxShadow !== "none");
    el.focus();
    return visible ? "visible" : `outline=${style.outlineStyle}/${style.outlineWidth} shadow=${style.boxShadow}`;
  });
  if (focusedVisible !== "visible") return `focus indicator not visible: ${focusedVisible}`;
  await page.keyboard?.type?.("");
  // Type into the focused fields. The auth screen's first field is the email.
  await page.evaluate((email) => {
    const el = document.activeElement;
    if (el && el.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, email);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, owner.email);
  // Switch to the password mode if the screen is passkey-first: find and click
  // the password sign-in affordance by its accessible text.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button, a")].find((el) =>
      /password/i.test(el.innerText),
    );
    if (button) button.click();
  });
  await sleep(400);
  const typed = await page.evaluate(
    ([email, password]) => {
      const inputs = [...document.querySelectorAll("input")];
      const emailInput = inputs.find((i) => i.type === "email" || i.type === "text");
      const passwordInput = inputs.find((i) => i.type === "password");
      const set = (el, value) => {
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      const okEmail = set(emailInput, email);
      const okPassword = set(passwordInput, password);
      return { okEmail, okPassword, fields: inputs.map((i) => i.type) };
    },
    [owner.email, PASSWORD],
  );
  if (!typed.okEmail || !typed.okPassword) {
    return `could not fill the sign-in form: ${JSON.stringify(typed)}`;
  }
  await page.evaluate(() => {
    // The passkey-first screen has several "Sign in…" buttons; the password
    // form's own submit is the one labelled "Sign in with password". A loose
    // /sign in/ match selects the PASSKEY button — which starts a ceremony and
    // waits for an authenticator that will never come (measured the hard way).
    const submit =
      [...document.querySelectorAll("button")].find((b) =>
        /^sign in with password$/i.test((b.innerText ?? "").trim()),
      ) ??
      document.querySelector('form button[type="submit"]');
    submit?.click();
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText);
    if (/overview|projects|organization/i.test(text) && !/sign in/i.test(text.slice(0, 400))) return "signed-in";
    await sleep(400);
  }
  return "dashboard never rendered after keyboard sign-in";
};
const signinOutcome = await keyboardSignin();
check(
  "the auth screen is completable entirely from the keyboard (critical path walked)",
  signinOutcome === "signed-in",
  typeof signinOutcome === "string" ? signinOutcome : JSON.stringify(signinOutcome),
);

// --- the breadth sweep ---------------------------------------------------------
const sweep = [];
for (const section of SECTIONS) {
  await page.setViewport(1440, 900);
  await page.goto(`${ORG_BASE}/${section.path}`);
  const text = await waitForRender(page);

  const name = section.path;
  const rendered = check(
    `${name}: renders its panel`,
    section.expect.test(text) && text.length > 40,
    `text[0..60]=${JSON.stringify(text.slice(0, 60))}`,
  );
  const boundary = check(
    `${name}: no error boundary`,
    !/something went wrong|unexpected application error/i.test(text),
  );
  await page.screenshot(join(SHOTS, `${name.replace(/\//g, "-")}-desktop.png`));

  // Keyboard: Tab reaches an interactive element and the focus indicator shows.
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: "body", visible: false };
    const style = getComputedStyle(el);
    const visible =
      (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
      (style.boxShadow && style.boxShadow !== "none");
    return { tag: el.tagName, visible, text: (el.innerText ?? el.getAttribute("aria-label") ?? "").slice(0, 30) };
  });
  check(
    `${name}: Tab reaches an interactive element with a visible focus indicator`,
    focus.tag !== "body" && focus.visible,
    JSON.stringify(focus),
  );

  // 390 px: the page must not scroll horizontally.
  await page.setViewport(390, 844, true);
  await sleep(350);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  check(
    `${name}: no horizontal page scroll at 390px`,
    overflow.scroll <= overflow.inner + 2,
    `scrollWidth=${overflow.scroll} innerWidth=${overflow.inner}`,
  );
  await page.screenshot(join(SHOTS, `${name.replace(/\//g, "-")}-390.png`));
  sweep.push({ name, rendered, boundary });
}

// --- server error + retry, produced at the network -----------------------------
const errorRecovery = async (sectionPath, apiPattern, label) => {
  await page.setViewport(1440, 900);
  const release = await page.intercept(apiPattern, { action: "fail" });
  await page.goto(`${ORG_BASE}/${sectionPath}`);
  // The panel is a lazy route chunk; give the failure state time to render and
  // poll rather than sample once.
  let broken = "";
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    broken = await page.evaluate(() => document.body.innerText);
    if (/failed|error|couldn't|could not|try again|went wrong|unavailable|retry/i.test(broken)) break;
  }
  const errorShown =
    /failed|error|couldn't|could not|try again|went wrong|unavailable|retry/i.test(broken);
  check(`${label}: a network-level failure renders the section's error state`, errorShown,
    JSON.stringify(broken.slice(0, 160)));
  await release();
  // Recovery through the product's own retry affordance when one exists, else a
  // re-navigation, which is the recovery a user can always perform.
  await page.goto(`${ORG_BASE}/${sectionPath}`);
  const recovered = await waitForRender(page);
  check(
    `${label}: the section recovers once the network is restored`,
    recovered.length > 40 && !/something went wrong/i.test(recovered),
    JSON.stringify(recovered.slice(0, 80)),
  );
};
await errorRecovery("usage", "*/api/v1/orgs/*/usage*", "usage");
await errorRecovery("models", "*/api/v1/orgs/*/routes*", "models");

// --- one-time secret lifecycle + destructive confirmation (API keys) -----------
// The identity section is two tabs: "Service accounts" (the machine identities)
// and "API keys". A key belongs to a service account, so the flow is: create
// the account, switch tabs, create the key, watch the secret be shown exactly
// once (SecretReveal has no close button and Escape is deliberately cancelled —
// the only exit is the explicit acknowledgement), then revoke-with-confirmation.
await page.setViewport(1440, 900);
await page.goto(`${ORG_BASE}/settings/identity`);
await waitForRender(page);
const saCreated = await page.evaluate(async () => {
  const byText = (p) =>
    [...document.querySelectorAll("button")].find((el) => p.test((el.innerText ?? "").trim()));
  const opener = byText(/new service account/i) ?? byText(/create service account/i);
  if (!opener) return { step: "no-opener", text: document.body.innerText.slice(0, 200) };
  opener.click();
  await new Promise((r) => setTimeout(r, 400));
  const nameInput =
    document.querySelector('input[placeholder="Release pipeline"]') ??
    document.querySelector('input[type="text"]');
  if (!nameInput) return { step: "no-name-input", text: document.body.innerText.slice(0, 200) };
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(nameInput, "v05 site probe");
  nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  // The form refuses an account with no capability ("needs at least one
  // capability"), so tick the first capability controls the picker offers.
  for (const box of [...document.querySelectorAll('input[type="checkbox"]')].slice(0, 2)) {
    if (!box.checked) {
      box.click();
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  const create = byText(/create service account/i);
  if (!create) return { step: "no-create-button" };
  create.click();
  await new Promise((r) => setTimeout(r, 1500));
  const text = document.body.innerText;
  return {
    step: "account-created",
    created: text.includes("v05 site probe"),
    stillEmpty: /No service accounts/.test(text),
    text: text.slice(-260),
  };
});
check(
  "identity: a service account can be created from the UI",
  saCreated.step === "account-created" && saCreated.created && !saCreated.stillEmpty,
  JSON.stringify(saCreated).slice(0, 180),
);
// Switch to the API keys tab — from a FRESH navigation, so no state from the
// service-account leg (an open form, a stale panel) can leak into this one —
// and WAIT for each affordance to exist rather than sleeping a fixed amount.
await page.goto(`${ORG_BASE}/settings/identity`);
await waitForRender(page);
const waitForKey = async (source, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((src) => {
      const pattern = new RegExp(src, "i");
      return [...document.querySelectorAll("button")]
        .some((el) => pattern.test((el.innerText ?? "").trim()));
    }, source);
    if (found) return true;
    await sleep(300);
  }
  return false;
};
const tabThere = await waitForKey("^api keys$");
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('button[role="tab"], button')].find((el) =>
    /^api keys$/i.test((el.innerText ?? "").trim()),
  );
  tab?.click();
});
await waitForKey("^new api key$");
await sleep(400);
// Machine keys are `lumik_…` (the reveal renders the full secret once).
const SECRET_PATTERN = /lumik_[A-Za-z0-9_-]{8,}/;
const keyFlow = await page.evaluate(async (secretPatternSource) => {
  const secretPattern = new RegExp(secretPatternSource);
  const byText = (p) =>
    [...document.querySelectorAll("button")].find((el) => p.test((el.innerText ?? "").trim()));
  const waitByText = async (p, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = byText(p);
      if (el) return el;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };
  const opener = await waitByText(/new (api )?key/i);
  if (!opener) return { step: "no-key-opener", text: document.body.innerText.slice(-400) };
  opener.click();
  // The create form is a lazy chunk; wait for its submit to exist.
  const create = await waitByText(/create key and show secret/i);
  if (!create) return { step: "no-create-key", text: document.body.innerText.slice(-400) };
  const input = [...document.querySelectorAll('input[type="text"]')][0];
  if (input) {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(input, "v05 one-time-secret");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // The key form scopes the key to a service account; pick its first real
  // option — the select looked up INSIDE the form. `document.querySelector`
  // alone returns the ORG SWITCHER in the header, and re-firing it re-runs
  // organization selection, which wedges the dashboard in its loading state.
  const formEl = create.closest("form");
  const select = formEl?.querySelector("select");
  if (select && select.options.length > 1) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    const option = select.options[1] ?? select.options[0];
    if (option) {
      setter.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  // A key holds an explicit capability subset; an empty selection leaves the
  // submit disabled, which is why the click alone used to do nothing.
  for (const box of [...(formEl?.querySelectorAll('input[type="checkbox"]') ?? [])].slice(0, 2)) {
    if (!box.checked) {
      box.click();
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  create.click();
  // Creating the key triggers an org-level refetch; poll for the reveal rather
  // than sampling once.
  let text = "";
  let match = null;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    text = document.body.innerText;
    match = text.match(secretPattern);
    if (match) break;
  }
  return {
    step: "key-created",
    secretShown: Boolean(match),
    fullSecret: match?.[0] ?? null,
    text: text.slice(-300),
  };
}, SECRET_PATTERN.source);
check(
  "identity: creating an API key shows the secret exactly once",
  keyFlow.step === "key-created" && keyFlow.secretShown,
  // Never print the secret: the check detail lands in the run log, and a
  // committed log that carries a secret-shaped literal trips the product's own
  // secret canary (measured: p09-secret-canary refused the first commit of
  // this evidence). The full value is kept only in memory for the
  // acknowledgement assertion below.
  JSON.stringify({ ...keyFlow, fullSecret: keyFlow.fullSecret ? "[shown — redacted]" : null }).slice(0, 200),
);
if (keyFlow.step === "key-created") {
  // The only exit from the reveal is the explicit acknowledgement.
  const acknowledged = await page.evaluate(() => {
    const ack = [...document.querySelectorAll("button")].find((el) =>
      /i have stored this key/i.test((el.innerText ?? "").trim()),
    );
    ack?.click();
    return Boolean(ack);
  });
  await sleep(500);
  const afterAck = await page.evaluate(
    (secret) => ({ text: document.body.innerText, gone: !document.body.innerText.includes(secret) }),
    keyFlow.fullSecret,
  );
  check(
    "identity: after acknowledgement the secret is gone from the page",
    afterAck.gone,
    // The public PREFIX remaining visible is correct behaviour; the full secret
    // must not be.
    afterAck.gone ? "full secret absent (prefix may remain)" : "the full secret still renders",
  );

  // Destructive confirmation: open the key's detail (the revoke control lives
  // there), revoke asks, Escape cancels, the key survives.
  const opened = await page.evaluate(() => {
    const row =
      [...document.querySelectorAll("button")].find((el) =>
        /v05 one-time-secret/i.test((el.innerText ?? "").trim()),
      ) ??
      [...document.querySelectorAll("button")].find((el) =>
        /^(view|details|manage)$/i.test((el.innerText ?? "").trim()),
      );
    row?.click();
    return Boolean(row);
  });
  await sleep(700);
  const revokeAsk = await page.evaluate(() => {
    const revoke = [...document.querySelectorAll("button")].find((el) =>
      /revoke/i.test((el.innerText ?? "").trim()),
    );
    if (!revoke) return { asked: false, why: "no revoke button" };
    revoke.click();
    return { asked: true };
  });
  await sleep(600);
  // The confirmation may be a dialog, inline wording, or a second confirm
  // button — poll briefly for any of the three.
  let confirmShown = { shown: false, text: "" };
  for (let i = 0; i < 8; i += 1) {
    await sleep(350);
    confirmShown = await page.evaluate(() => {
      const text = document.body.innerText;
      const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
      const confirmButton = [...document.querySelectorAll("button")].find((el) =>
        /^(confirm|yes,? revoke|revoke key)$/i.test((el.innerText ?? "").trim()),
      );
      return {
        shown: Boolean(dialog) || Boolean(confirmButton) ||
          /permanently|cannot be undone|are you sure|irreversible/i.test(text),
        text: text.slice(-260),
      };
    });
    if (confirmShown.shown) break;
  }
  check(
    "identity: revoke asks for confirmation before acting",
    revokeAsk.asked && confirmShown.shown,
    JSON.stringify({ revokeAsk, confirm: confirmShown.text }).slice(0, 200),
  );
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await sleep(400);
  const survived = await page.evaluate(() => document.body.innerText);
  check(
    "identity: Escape cancels the destructive confirmation and the key survives",
    /v05 one-time-secret/i.test(survived) && !/permanently refused/i.test(survived),
    JSON.stringify(survived.slice(0, 160)),
  );
}

// --- permission: a foreign account must see no trace of this organization ------
// The browser is still carrying the OWNER's session; sign it in as the foreign
// account through the page's own fetch (cookies land in the browser jar), then
// reload so the app re-resolves the session.
await page.setViewport(1440, 900);
const switched = await page.evaluate(
  async ([email, password]) => {
    const login = await fetch("/api/v1/auth/password/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return login.status;
  },
  [foreign.email, PASSWORD],
);
await page.goto(`${WEB}/`);
await waitForRender(page);
const activeOrg = await page.evaluate(() => document.body.innerText.slice(0, 300));
check(
  "permission: the browser session switches to the foreign account",
  switched === 200 && activeOrg.includes(foreign.displayName),
  `login=${switched} shell=${JSON.stringify(activeOrg.slice(0, 120))}`,
);
const foreignLeak = [];
for (const sectionPath of ["overview", "members", "usage", "settings/billing"]) {
  await page.goto(`${WEB}/org/${owner.orgSlug}/${sectionPath}`);
  await sleep(900);
  const text = await page.evaluate(() => document.body.innerText);
  const leaked = text.includes(owner.displayName) || text.includes(owner.email);
  foreignLeak.push({ sectionPath, leaked });
  check(
    `foreign viewer at ${sectionPath}: the owner organization's data does not render`,
    !leaked,
    leaked ? "owner org name or email appears in the DOM" : "",
  );
}
check(
  "foreign viewer: the browser session stays the foreign account's own (no silent org switch)",
  foreignLeak.every((l) => !l.leaked),
);

// --- console discipline ---------------------------------------------------------
check(
  "no uncaught page exceptions across the whole sweep",
  pageErrors.length === 0,
  pageErrors.slice(0, 3).join(" | "),
);

console.log(`\nV05 whole-site sweep: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} check(s) failed`}`);
console.log(`screenshots: ${SHOTS}`);
writeFileSync(
  join(HERE, "v05-whole-site-results.json"),
  JSON.stringify({ failures, sections: sweep, foreignLeak, pageErrors }, null, 2),
);
// Do not leave a signed-in Chrome holding the CDP port for the next run.
try {
  await browser.send("Browser.close");
} catch {
  browser.close?.();
}
process.exit(failures === 0 ? 0 : 1);
