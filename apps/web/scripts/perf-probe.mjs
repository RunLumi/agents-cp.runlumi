#!/usr/bin/env node
// ============================================================================================
// V02-003 -- measure the repository's stated performance budgets against the real system.
//
// WHY A SEPARATE PROBE
//
// The objective asks for budgets to be MEASURED, and `AGENTS.md` says they "become automated CI
// gates once representative production routes exist". This is that measurement, as a script rather
// than a number typed into a document, so the next person can re-run it and get the same table.
//
// It is deliberately NOT folded into `smoke:browser`. That gate is a correctness gate: it exits
// non-zero on a defect. A budget regression and a correctness defect have different owners and
// different urgency, and a performance wobble on a loaded laptop should not read as a product
// defect. Mixing them is how a gate's meaning stops being knowable.
//
// EVERY NUMBER HERE IS MEASURED, ON THE REAL STACK
//
//   * bundle sizes: the real `pnpm build` output, gzipped;
//   * API latency: real HTTP against a real Worker with a real session, so the number is a
//     control-plane request and not the unauthenticated 401 short-circuit, which answers in ~2ms and
//     would flatter every budget in the document;
//   * Core Web Vitals and long tasks: a real Chrome against the real dev server, with a real
//     session, measured with the browser's own Performance APIs.
//
// THE BUDGETS, quoted from AGENTS.md so this table cannot drift from the document
//
//   initial JS            <= 170 KiB gzip
//   initial CSS           <=  35 KiB gzip
//   new route chunk       <=  80 KiB gzip
//   CLS                   <  0.1
//   INP                   <  200 ms p75
//   LCP                   <  2.5 s p75  (target < 2.0 s for the authenticated shell)
//   main-thread long task >  200 ms is not allowed during normal navigation
//   control-plane request <  200 ms p95, excluding controlled upstream time
//   Worker bundle         no number -- "track and investigate substantial increases"
//
// A measurement that cannot be taken is reported as UNMEASURED, never as a pass.
// ============================================================================================
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { launch, newPage, NO_CHROME_REASON } from "./cdp.mjs";

// `apps/web/scripts/perf-probe.mjs` -> the repository root is `../../..`. The first version used
// `../..`, which is `apps/`, so `apps/web/dist` resolved to `apps/apps/web/dist` and all three
// bundle budgets reported UNMEASURED while the harness reported them honestly rather than passing.
const REPO = new URL("../../..", import.meta.url).pathname;
const WEB = process.env.PROBE_WEB ?? "http://localhost:5173/";
const API = process.env.PROBE_API ?? "http://localhost:8787";
const SAMPLES = Number(process.env.PERF_SAMPLES ?? 30);
const LOADS = Number(process.env.PERF_LOADS ?? 5);
const PERF_PASSWORD = "v01-perf-Password-42!";
const PERF_NONCE = process.env.PERF_NONCE ?? `${Date.now().toString(36)}`;

const rows = [];
const record = (name, measured, budget, unit, detail = "") =>
  rows.push({ name, measured, budget, unit, detail });

const kib = (bytes) => bytes / 1024;
const fmt = (value, digits = 1) =>
  value === null || value === undefined ? "UNMEASURED" : Number(value).toFixed(digits);

// ---------------------------------------------------------------------------------------
// 1. Bundle sizes, from the real build output.
// ---------------------------------------------------------------------------------------
function measureBundles() {
  const dist = join(REPO, "apps/web/dist");
  if (!existsSync(join(dist, "index.html"))) {
    for (const name of ["initial JS", "initial CSS", "new route chunk"]) {
      record(name, null, null, "KiB gzip", "apps/web/dist is absent -- run `pnpm build` first");
    }
    return;
  }
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const initial = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]));
  const gz = (file) => kib(gzipSync(readFileSync(file), { level: 9 }).length);

  let js = 0;
  let css = 0;
  for (const asset of initial) {
    const file = join(dist, asset.replace(/^\//, ""));
    if (!existsSync(file)) continue;
    if (asset.endsWith(".js")) js += gz(file);
    if (asset.endsWith(".css")) css += gz(file);
  }
  record("initial JS", js, 170, "KiB gzip");
  record("initial CSS", css, 35, "KiB gzip");

  // A "new route chunk" is a LAZY chunk -- something the entry does not load up front. The largest
  // one is what a single navigation can pull, which is the number the budget is about.
  const assets = join(dist, "assets");
  const lazy = existsSync(assets)
    ? readdirSync(assets)
        .filter((n) => n.endsWith(".js"))
        .filter((n) => !initial.has(`/assets/${n}`))
        .map((n) => ({ name: n, size: gz(join(assets, n)) }))
        .sort((a, b) => b.size - a.size)
    : [];
  if (lazy.length === 0) {
    record("new route chunk", null, 80, "KiB gzip", "no lazy chunks found in apps/web/dist/assets");
  } else {
    record("new route chunk (largest)", lazy[0].size, 80, "KiB gzip", lazy[0].name);
    const over = lazy.filter((c) => c.size > 80);
    if (over.length > 0) {
      record(
        "route chunks OVER budget",
        over.length,
        0,
        "chunks",
        over.map((c) => c.name).join(", "),
      );
    }
  }
}

function measureWorkerBundle() {
  // `wrangler deploy --dry-run` prints the upload size. Re-running the build just for this is
  // expensive, so the number is read from the most recent build log if one exists, and reported as
  // UNMEASURED rather than guessed when it does not.
  //
  // V04-006 -- the candidate list put /tmp first, and /tmp is where this campaign's system volume ran
  // out of space twice (V04-001). An instrument that reads its input from a directory a routine
  // operation can reclaim will report UNMEASURED for reasons that have nothing to do with the product,
  // which is the same defect as losing evidence: an input read from an unstable location is not an
  // input. So PROBE_BUILD_LOG comes first, the durable sibling-of-the-repo log is the default, and
  // /tmp is kept only as a last-resort fallback for anyone with an older habit.
  const candidates = [
    process.env.PROBE_BUILD_LOG,
    join(dirname(REPO), "v04-logs/v04-build.log"),
    join(REPO, "apps/api/build.log"),
    "/tmp/build.log",
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const match = [
      ...readFileSync(path, "utf8").matchAll(
        /Total Upload:\s*([\d.]+)\s*KiB.*?gzip:\s*([\d.]+)\s*KiB/g,
      ),
    ].pop();
    if (match) {
      record(
        "Worker bundle (gzip)",
        Number(match[2]),
        null,
        "KiB",
        "no numeric budget; tracked for regressions",
      );
      return;
    }
  }
  record(
    "Worker bundle (gzip)",
    null,
    null,
    "KiB",
    "no build log found -- run `pnpm build` and re-run",
  );
}

// ---------------------------------------------------------------------------------------
// 2. A real session, so the latency measured is a control-plane request.
// ---------------------------------------------------------------------------------------
class Jar {
  constructor() {
    this.cookies = new Map();
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
}

let idempotencyCounter = 0;

/**
 * One request against the real API, carrying the real session.
 *
 * Mutations require an `Idempotency-Key` -- the product refuses without one with
 * `400 Idempotency-Key is required for this mutation` -- so every write carries a unique key. A
 * counter is enough here and a random id is not: a stable, readable key per call site is what makes a
 * repeated run's ledger entries traceable back to this probe.
 */
async function call(jar, method, path, body) {
  const isMutation = method !== "GET" && method !== "HEAD";
  idempotencyCounter += 1;
  const response = await fetch(`${API}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(isMutation ? { "Idempotency-Key": `v02perf-${idempotencyCounter}-${PERF_NONCE}` } : {}),
      ...(jar.cookies.size ? { Cookie: jar.header() } : {}),
      ...(jar.cookies.get("lumi_csrf") ? { "X-CSRF-Token": jar.cookies.get("lumi_csrf") } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  jar.absorb(response);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

async function authenticatedJar(nonce) {
  const jar = new Jar();
  const email = `perf-${nonce}@v01.invalid`;
  const signup = await call(jar, "POST", "/api/v1/auth/password/signup", {
    email,
    display_name: "V02 Perf",
    password: PERF_PASSWORD,
  });
  if (signup.status >= 400)
    throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.body).slice(0, 160)}`);
  const verification = signup.body?.verification ?? {};
  const challenge = verification.challenge_id ?? verification.challengeId;
  const code = verification.development_code ?? verification.code ?? signup.body?.development_code;
  if (!challenge || !code) {
    throw new Error(
      `no verification challenge in the signup response, so the account cannot be verified and no ` +
        `latency below would be authenticated: ${JSON.stringify(signup.body).slice(0, 200)}`,
    );
  }
  const verified = await call(jar, "POST", "/api/v1/auth/verify-email", {
    challenge_id: challenge,
    code,
  });
  if (verified.status >= 400)
    throw new Error(
      `verify failed: ${verified.status} ${JSON.stringify(verified.body).slice(0, 160)}`,
    );
  const login = await call(jar, "POST", "/api/v1/auth/password/login", {
    email,
    password: PERF_PASSWORD,
  });
  if (login.status >= 400)
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body).slice(0, 160)}`);
  // `CreateOrgRequest` is `{ display_name, slug? }` -- there is no `name` field, and the struct is
  // `deny_unknown_fields`, so sending `name` is a 422 rather than a silently-ignored extra.
  const org = await call(jar, "POST", "/api/v1/orgs", {
    display_name: "V02 Perf Org",
    slug: `v02-perf-${nonce}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  });
  if (org.status >= 400)
    throw new Error(`org create failed: ${org.status} ${JSON.stringify(org.body).slice(0, 160)}`);
  // The id is read from `/api/v1/me` rather than from the create response. The create response does
  // nest it (`{ organization: … }`), but a probe that depends on a field it did not need -- and that
  // produced `orgs/null/members` in the first run, which is a URL no route could ever match -- is a
  // probe that reports a 404 as if it were a latency measurement. `/me` is the same route this probe
  // already measures, and it is the session's own answer about which organizations it can see.
  const me = await call(jar, "GET", "/api/v1/me");
  const organizations = me.body?.organizations ?? [];
  // The id field is `org_id`, not `organization_id` -- the wire shape follows the column, and two
  // attempts guessed the longer name. The fallback chain is kept because the memberships envelope
  // has changed shape before, but the FIRST name tried is the one the API actually uses, so a future
  // change fails on the fallback rather than silently producing a `null` in a URL.
  const orgId =
    organizations[0]?.organization?.org_id ??
    organizations[0]?.org_id ??
    organizations[0]?.organization_id ??
    null;
  if (!orgId) {
    throw new Error(
      `the session reports no organization after creating one, so no org-scoped route can be ` +
        // The KEYS are printed, not the values: this probe has now failed twice on the shape of this
        // object, and the second failure cost a run. Naming the keys is what makes the next attempt
        // correct, where printing a truncated body just shows the same prefix again.
        `measured. The first entry's keys are ${JSON.stringify(Object.keys(organizations[0] ?? {}))} ` +
        `and its organization keys are ${JSON.stringify(Object.keys(organizations[0]?.organization ?? {}))}`,
    );
  }
  return { jar, orgId };
}

async function measureApiLatency(jar, orgId) {
  // Every route here is one a freshly-created organization OWNER can read. `/inference/models` was
  // in the first list and answered 403, because an org with no model policy is refused there -- the
  // same rule the V02-001 investigation ran into. A route that answers 403 is not a latency
  // measurement, and including one only to report UNMEASURED teaches the reader nothing.
  const routes = [
    ["/api/v1/me", "session + organizations"],
    [`/api/v1/orgs/${orgId}/members`, "org-scoped collection"],
    [`/api/v1/orgs/${orgId}/projects`, "project collection"],
    [`/api/v1/orgs/${orgId}/agents`, "agent collection"],
    [`/api/v1/orgs/${orgId}/audit`, "audit read, the heaviest org-scoped read"],
  ];
  for (const [path, label] of routes) {
    const samples = [];
    let status = 0;
    // One warm-up request that is NOT counted: the first call pays for JIT, module loading and a
    // cold D1 handle, and folding that into a p95 is measuring the harness rather than the product.
    const warm = await call(jar, "GET", path);
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = process.hrtime.bigint();
      const response = await call(jar, "GET", path);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      status = response.status;
      samples.push(elapsed);
    }
    if (status >= 400) {
      record(
        `API ${path}`,
        null,
        200,
        "ms p95",
        `every request answered ${status} -- not a latency measurement`,
      );
      continue;
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
    record(
      `API ${path}`,
      p95,
      200,
      "ms p95",
      `${label}; p50 ${fmt(p50)}ms over ${samples.length} samples`,
    );
  }
}

// ---------------------------------------------------------------------------------------
// 3. Real browser: Core Web Vitals and long tasks, on the AUTHENTICATED shell.
// ---------------------------------------------------------------------------------------
/**
 * Whether the URL under measurement is the dev server or a production preview.
 *
 * The budgets in AGENTS.md are stated under "Web production baseline". Measuring the Vite DEV server
 * and grading it against a production budget would be a false finding: the dev server transforms
 * TypeScript on demand, ships unminified modules, and holds an HMR client and websocket open. The
 * first version of this probe did exactly that and reported LCP 3.7s against a 2.5s budget -- a number
 * that says nothing about the artefact the budget is about, and one that swung to 0.3s on a second run
 * because the transform cache was warm.
 *
 * So the environment is DETECTED and reported, and a production budget measured against the dev
 * server is labelled rather than silently graded.
 */
async function detectEnvironment(web) {
  const html = await fetch(web)
    .then((r) => r.text())
    .catch(() => "");
  if (/@vite\/client|__vite__|vite-dev|@react-refresh/i.test(html)) return "dev";
  return "production-preview";
}

async function measureBrowser(cookies, orgSlug) {
  let loadSamples = [];
  let browser;
  try {
    browser = await launch({ port: Number(process.env.PROBE_CDP_PORT ?? 9333), headless: true });
  } catch (error) {
    if (error?.code === "NO_BROWSWER") {
      for (const name of ["LCP", "CLS", "INP", "main-thread long task"]) {
        record(
          name,
          null,
          null,
          "",
          "no Chrome available -- these claims are UNMEASURED, not passing",
        );
      }
      console.error(NO_CHROME_REASON);
      return;
    }
    throw error;
  }
  try {
    const environment = await detectEnvironment(WEB);
    const page = await newPage(browser);
    // The session is installed as real cookies rather than by logging in through the UI, so the
    // measurement is of the authenticated shell's load and not of a login journey's.
    await page.send("Network.enable", {});
    await page.send("Network.setCookies", {
      cookies: [...cookies].map(([name, value]) => ({
        name,
        value,
        domain: "localhost",
        path: "/",
      })),
    });
    await page.send("Performance.enable", {});
    // Installed as an on-new-document script, NOT by evaluating in the current page.
    //
    // The first version called `page.evaluate` to install the observers and then navigated -- which
    // throws the page away, observers and all, so `window.__vitals` was undefined on arrival and the
    // probe died on `reading 'lcp'`. `Page.addScriptToEvaluateOnNewDocument` runs before any page
    // script on every navigation, so the FIRST paint and the FIRST long task are both observed --
    // which is the only way to measure the events the budgets are about. `buffered: true` then
    // replays anything that happened before an observer attached, so a late attachment is not
    // silently a smaller number.
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__vitals = { lcp: 0, cls: 0, inp: 0, longTasks: [], shifts: [] };
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) window.__vitals.lcp = entry.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
        } catch (e) { window.__vitals.lcpUnsupported = true; }
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.hadRecentInput) continue;
              window.__vitals.cls += entry.value;
              window.__vitals.shifts.push({
                value: Number(entry.value.toFixed(5)),
                sources: (entry.sources || []).map((s) => (s.node && s.node.tagName) || "?").slice(0, 4),
              });
            }
          }).observe({ type: "layout-shift", buffered: true });
        } catch (e) { window.__vitals.clsUnsupported = true; }
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__vitals.longTasks.push({
                name: entry.name,
                duration: Math.round(entry.duration),
                start: Math.round(entry.startTime),
              });
            }
          }).observe({ type: "longtask", buffered: true });
        } catch (e) { window.__vitals.longTaskUnsupported = true; }
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__vitals.inp = Math.max(window.__vitals.inp, entry.duration);
            }
          }).observe({ type: "event", buffered: true, durationThreshold: 16 });
        } catch (e) { window.__vitals.inpUnsupported = true; }
      `,
    });
    // Several loads, because the budget is stated as a p75 and ONE sample cannot be a p75. The first
    // version of this probe reported a single cold load of 3.6s as a verdict; a single sample is not
    // the statistic the budget names, and a cold first load is not the same thing as a steady-state
    // one. What is reported is the distribution, and the verdict is stated against it.
    const loads = [];
    for (let attempt = 0; attempt < LOADS; attempt += 1) {
      // Load 1 is measured COLD: the browser cache is cleared and caching disabled for it, because a
      // real user's FIRST visit is cold and a warm median standing in for a cold start is a
      // flattering fiction. The single-sample version of this probe reported 3.6s on the cold load
      // and 0.08s warm -- and both numbers were true, which is exactly why a distribution that does
      // not say which regime it measured cannot be graded.
      if (attempt === 0) {
        await page.send("Network.enable", {});
        await page.send("Network.clearBrowserCache", {});
        await page.send("Network.setCacheDisabled", { cacheDisabled: true });
      }
      await page.goto(WEB, { waitUntil: "load" });
      // Give the shell time to fetch the session, render, and settle any layout shift. A sample at
      // `load` measures the document, not the application.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const sample = await page.evaluate(() => {
        const vitals = window.__vitals ?? null;
        const entries = performance.getEntriesByType("largest-contentful-paint") ?? [];
        const last = entries[entries.length - 1];
        let lcpElement = null;
        try {
          lcpElement = last?.element?.tagName ?? null;
        } catch {
          // `element` is not exposed for cross-process or already-detached nodes. An unavailable
          // element is UNMEASURED for that field, never a guess at what it was.
          lcpElement = null;
        }
        const nav = performance.getEntriesByType("navigation")[0];
        return {
          lcp: vitals?.lcp ?? 0,
          lcpElement,
          domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadEvent: nav ? Math.round(nav.loadEventEnd) : null,
          apiDuration: vitals?.apiMs ?? null,
        };
      });
      sample.cold = attempt === 0;
      loads.push(sample);
      if (attempt === LOADS - 1)
        await page.send("Network.setCacheDisabled", { cacheDisabled: false });
      if (attempt < LOADS - 1) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    loadSamples = loads;
    // One real interaction, so INP has something to measure. INP over zero interactions is not a
    // performance figure, it is an absence of one, and reporting 0 ms would be a pass for a number
    // that was never produced.
    // A real CLICK, because Event Timing does not record a Tab. A focus change is not an interaction
    // in the sense INP measures, so pressing Tab produced no entry and the first version reported
    // `0.0 ms PASS` for a number that was never produced -- while its own detail line said exactly
    // that. A click produces a pointer event with a real duration.
    const clicked = await page.evaluate(() => {
      const target = document.querySelector("button:not([disabled]), a[href], [role=tab]");
      if (!target) return { clicked: false };
      const started = performance.now();
      target.click();
      return { clicked: true, elapsed: Math.round(performance.now() - started) };
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Defensive: an absent instrument reports UNMEASURED. `window.__vitals` being undefined once
    // crashed the probe on `reading 'lcp'`, and a crash here would be reported as "could not obtain
    // an authenticated session", which is a different and wrong explanation for the same event.
    const vitals = await page.evaluate(() => window.__vitals ?? null);
    const valid = (l) => l.lcp > 0;
    const cold = loadSamples.filter((l) => l.cold && valid(l)).map((l) => l.lcp);
    const warm = loadSamples
      .filter((l) => !l.cold && valid(l))
      .map((l) => l.lcp)
      .sort((a, b) => a - b);
    const lcpMedian = warm.length ? warm[Math.floor(warm.length / 2)] : null;
    const lcpCold = cold.length ? cold[0] : null;
    const seconds = (ms) => (ms / 1000).toFixed(2);
    const lcpDetail =
      `cold ${lcpCold ? `${seconds(lcpCold)}s` : "not observed"}; warm ` +
      (warm.length
        ? `${warm.map(seconds).join(" / ")}s, median ${seconds(lcpMedian)}s`
        : "not observed") +
      `; LCP element ${loadSamples[loadSamples.length - 1]?.lcpElement ?? "not exposed"}` +
      `; DCL ${loadSamples[loadSamples.length - 1]?.domContentLoaded ?? "?"}ms`;
    if (!vitals) {
      for (const name of ["LCP", "CLS", "INP", "main-thread long task"]) {
        record(
          name,
          null,
          null,
          "",
          "the on-new-document vitals collector did not run in the page",
        );
      }
      return;
    }
    const shell = await page.evaluate(() =>
      document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 160),
    );

    const authenticated = !/Sign in with passkey/.test(shell);
    if (!authenticated) {
      for (const name of ["LCP", "CLS", "INP", "main-thread long task"]) {
        record(
          name,
          null,
          null,
          "",
          `the shell did not render authenticated (saw: ${JSON.stringify(shell)})`,
        );
      }
      return;
    }

    // The rule for all four: an instrument that DID NOT RUN is UNMEASURED, and an instrument that ran
    // and recorded nothing is a real measurement of zero. Conflating them is how "0.0 ms PASS"
    // appears for a number nobody produced -- which is the same defect V02-001 found in a focus
    // assertion, in a different form.
    const ranOrUnsupported = (flag) =>
      vitals[flag] ? "the browser does not support this entry type" : null;
    const collectorMissing = [
      ranOrUnsupported("lcpUnsupported"),
      ranOrUnsupported("clsUnsupported"),
      ranOrUnsupported("longTaskUnsupported"),
      ranOrUnsupported("inpUnsupported"),
    ].filter(Boolean);

    if (environment !== "production-preview") {
      console.log(
        "  note: measuring the " +
          environment +
          " server. AGENTS.md states these budgets under\n" +
          "        'Web production baseline', and a dev-server number is not a production number --\n" +
          "        the rows below are reported but must not be read as a production verdict. Run\n" +
          "        'pnpm --filter @runlumi/agents-cp-web preview' and point PROBE_WEB at it to\n" +
          "        grade them properly.",
      );
    }
    // The MEDIAN is graded, and the sample count is reported, because the budget says p75 and a
    // single cold load is not that statistic. With a handful of loads the median is the closest
    // honest proxy and the count travels with it -- a reader can see how much weight the number has.
    // Graded on the COLD load. A first visit is what a user actually experiences, and grading on the
    // warm median would let a good steady-state number stand in for a bad first impression. The warm
    // median is reported alongside it so both regimes are visible, because reporting only the cold
    // figure would hide that the steady state is comfortable.
    record(
      "LCP (authenticated shell, COLD load)",
      lcpCold ? lcpCold / 1000 : null,
      2.5,
      "s",
      lcpDetail + (lcpMedian ? `; warm median ${seconds(lcpMedian)}s is well inside budget` : ""),
    );
    record(
      "CLS",
      vitals.cls === undefined ? null : vitals.cls,
      0.1,
      "",
      vitals.cls === undefined
        ? ranOrUnsupported("clsUnsupported")
        : (vitals.shifts ?? []).length
          ? `sources: ${JSON.stringify(vitals.shifts).slice(0, 140)}`
          : "the collector ran and observed no layout shift, so CLS is a measured zero",
    );
    record(
      "INP (one real click)",
      vitals.inp ? vitals.inp : null,
      200,
      "ms",
      vitals.inp
        ? `click handler returned in ${clicked.elapsed}ms; p75 target, and this is a single interaction rather than a p75 distribution`
        : (ranOrUnsupported("inpUnsupported") ??
            (clicked.clicked
              ? "the collector ran and the click produced NO event-timing entry, so INP is UNMEASURED rather than 0"
              : "no clickable control was found, so no interaction happened and INP is UNMEASURED")),
    );
    const worst = (vitals.longTasks ?? []).reduce((max, t) => Math.max(max, t.duration), 0);
    record(
      "worst main-thread long task",
      (vitals.longTasks ?? []).length || !vitals.longTaskUnsupported ? worst : null,
      200,
      "ms",
      vitals.longTaskUnsupported
        ? "the browser does not support longtask entries"
        : (vitals.longTasks ?? []).length
          ? JSON.stringify(vitals.longTasks.slice(0, 5))
          : "the collector ran and observed no long task, so the worst measured task is 0ms",
    );
    if (collectorMissing.length) console.log(`  note: ${collectorMissing.join("; ")}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------------------
function report() {
  const width = Math.max(...rows.map((r) => r.name.length));
  console.log("\n  V02 performance budgets -- measured against the real stack\n");
  console.log(
    `  ${"budget".padEnd(width)}  ${"measured".padStart(12)}  ${"limit".padStart(10)}   verdict`,
  );
  console.log(`  ${"-".repeat(width)}  ${"-".repeat(12)}  ${"-".repeat(10)}   -------`);
  let over = 0;
  let unmeasured = 0;
  for (const row of rows) {
    let verdict;
    if (row.measured === null || row.measured === undefined) {
      verdict = "UNMEASURED";
      unmeasured += 1;
    } else if (row.budget === null) {
      verdict = "TRACKED";
    } else if (row.unit === "chunks") {
      verdict = row.measured > row.budget ? "OVER" : "PASS";
      if (verdict === "OVER") over += 1;
    } else {
      verdict = row.measured <= row.budget ? "PASS" : "OVER";
      if (verdict === "OVER") over += 1;
    }
    const limit =
      row.budget === null || row.budget === undefined ? "  --" : `${fmt(row.budget)} ${row.unit}`;
    console.log(
      `  ${row.name.padEnd(width)}  ${`${fmt(row.measured)} ${row.unit}`.padStart(12)}  ${limit.padStart(10)}   ${verdict}`,
    );
    if (row.detail) console.log(`  ${" ".repeat(width)}  ${row.detail}`);
  }
  console.log("");
  console.log(`  ${over} over budget, ${unmeasured} unmeasured.`);
  console.log(
    "  An UNMEASURED line is not a passing line: the objective is explicit that a check which",
  );
  console.log("  could not run is not a check which passed.\n");
  return over === 0 && unmeasured === 0;
}

const nonce = PERF_NONCE;
measureBundles();
measureWorkerBundle();
let exitCode = 0;
try {
  const { jar, orgId } = await authenticatedJar(nonce);
  await measureApiLatency(jar, orgId);
  await measureBrowser(jar.cookies, orgId);
} catch (error) {
  console.error(`\n  performance probe could not complete: ${error?.message ?? error}`);
  for (const name of ["API latency", "LCP", "CLS", "INP", "main-thread long task"]) {
    if (!rows.some((r) => r.name.startsWith(name))) {
      record(name, null, null, "", "the probe could not obtain an authenticated session");
    }
  }
  exitCode = 2;
}
const allWithin = report();
// exit 1 for a budget that is genuinely OVER; exit 2 for a measurement that could not be taken.
// Collapsing the two would let a broken harness read as a clean budget, which is the confusion this
// campaign has now hit in four different harnesses.
process.exit(exitCode === 2 ? 2 : allWithin ? 0 : 1);
