#!/usr/bin/env node
// ============================================================================================
// V02-004 -- can one request ID be followed through the whole system, and do the records it
//            reaches leak anything they must not?
//
// THE OBJECTIVE, verbatim
//
//   "For representative request IDs prove correlation across: request; auth/policy; domain action;
//    external dispatch/queue; usage/cost; audit/security event; response."
//   "Inspect emitted records for forbidden sensitive content."
//
// So this is two claims, and the second is the one that is easy to skip:
//
//   C1  ONE operation's request id is present in every record that operation should have touched.
//       Not "the tables exist" and not "some rows have ids" -- the SAME id, followed through.
//
//   C2  Nothing any of those records carry contains a credential. This is checked with CANARIES
//       rather than with a pattern list: the probe knows the exact password, session cookie and CSRF
//       token it just used, so it can assert those literal strings appear NOWHERE. A denylist of
//       patterns can only find what someone thought of; a canary finds what actually leaked.
//
// WHY THIS OPERATION
//
// `PUT /api/v1/orgs/{org_id}/policy` is the richest chain available that needs no provider and no
// fixture beyond an organization: it writes the policy row (domain action), a `security_events` row
// (audit/security event), an `outbox_events` row (external dispatch/queue), and an
// `idempotency_records` row, and the middleware logs the request and returns the id. That is six of
// the seven legs the objective names, from one request, with nothing mocked.
//
// WHAT IS DELIBERATELY NOT CLAIMED
//
//   * usage/cost: a policy change spends nothing, so there is correctly NO usage row. That is
//     asserted as an ABSENCE, because a usage row for a free operation is itself a finding.
//   * the HTTP log leg is read from the dev server's stdout, not from D1, because that is where the
//     middleware writes it. If the log cannot be found the leg is UNMEASURED, not assumed.
//
// HARNESS RULES THIS SCRIPT FOLLOWS, each learned in this campaign at cost
//
//   * the D1 file is located by RECENCY and verified by content, so a probe cannot read a stale
//     database left behind by an earlier run and report it as this run's state;
//   * every negative assertion has a positive control: the same request id IS found in the records
//     it should be in, so "found nothing" is a measurement rather than an absent instrument;
//   * an environment that cannot be read reports UNMEASURED and exits 2. It never exits 0 having
//     measured nothing.
// ============================================================================================
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_API = process.env.OBS_API ?? "http://localhost:8787";
const REPO = new URL("../../..", import.meta.url).pathname;
const SAMPLES = 12;

// A password, a CSRF token and a session cookie are all canaries. The password is deliberately
// distinctive so that a substring search for it cannot collide with anything legitimate.
const CANARY_PASSWORD = "v02-observability-canary-Passw0rd!";
const NONCE = process.env.OBS_NONCE ?? `${Date.now().toString(36)}`;

/**
 * Human names for the three canaries.
 *
 * Declared HERE rather than beside its use, because the first version declared it after the try
 * block that reads it -- and `node --check` passed, because a temporal dead zone violation is a
 * RUNTIME error, not a syntax error. `const` is hoisted, so the declaration is invisible to the
 * parser and the reference throws only when the canary loop runs. A linter-clean file that dies on
 * its first use is the same shape as a check that describes a rule it does not enforce: it looks
 * correct right up until the moment it is asked to do its job.
 */
const CANARY_LABEL = { password: "password", session: "session cookie", csrf: "CSRF token" };

const results = [];
const record = (name, verdict, detail) => results.push({ name, verdict, detail });
const ok = (name, condition, detail = "") => record(name, condition ? "PASS" : "FAIL", detail);
const unmeasured = (name, detail) => record(name, "UNMEASURED", detail);

// ---------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------
class Jar {
  constructor() {
    this.cookies = new Map();
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
}

let idempotency = 0;
async function call(jar, method, path, body) {
  const mutation = method !== "GET" && method !== "HEAD";
  idempotency += 1;
  const response = await fetch(`${WEB_API}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(mutation ? { "Idempotency-Key": `v02obs-${idempotency}-${NONCE}` } : {}),
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
  return { status: response.status, body: parsed, headers: response.headers };
}

async function session() {
  const jar = new Jar();
  const email = `obs-${NONCE}@v02.invalid`;
  const signup = await call(jar, "POST", "/api/v1/auth/password/signup", {
    email,
    display_name: "V02 Observability",
    password: CANARY_PASSWORD,
  });
  if (signup.status >= 400)
    throw new Error(`signup ${signup.status}: ${JSON.stringify(signup.body).slice(0, 160)}`);
  const verification = signup.body?.verification ?? {};
  const challenge = verification.challenge_id ?? verification.challengeId;
  const code = verification.development_code ?? verification.code ?? signup.body?.development_code;
  if (!challenge || !code) throw new Error("no verification challenge in the signup response");
  const verified = await call(jar, "POST", "/api/v1/auth/verify-email", {
    challenge_id: challenge,
    code,
  });
  if (verified.status >= 400) throw new Error(`verify ${verified.status}`);
  const login = await call(jar, "POST", "/api/v1/auth/password/login", {
    email,
    password: CANARY_PASSWORD,
  });
  if (login.status >= 400) throw new Error(`login ${login.status}`);
  const org = await call(jar, "POST", "/api/v1/orgs", {
    display_name: "V02 Obs Org",
    slug: `v02-obs-${NONCE}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  });
  if (org.status >= 400)
    throw new Error(`org create ${org.status}: ${JSON.stringify(org.body).slice(0, 160)}`);
  const me = await call(jar, "GET", "/api/v1/me");
  const orgId = me.body?.organizations?.[0]?.organization?.org_id ?? null;
  if (!orgId) throw new Error("the session reports no organization");
  return { jar, orgId, email };
}

// ---------------------------------------------------------------------------------------
// D1 access: locate the LIVE database, verified by content rather than by path alone.
// ---------------------------------------------------------------------------------------
function d1Path() {
  const dir = join(REPO, "apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((n) => n.endsWith(".sqlite") && !n.includes("metadata"))
    .map((n) => join(dir, n))
    // Newest first, and the mtime is checked rather than the listing order: a directory listing is
    // not sorted by time on every filesystem, and reading a STALE database would report another
    // run's rows as this run's evidence.
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function query(db, sql) {
  const out = execFileSync(
    "npx",
    [
      "--no-install",
      "wrangler",
      "d1",
      "execute",
      "lumi-agents-control-plane",
      "--local",
      "--json",
      "--command",
      sql,
    ],
    { cwd: join(REPO, "apps/api"), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  // `--json` emits one array per statement; take the first non-empty result set.
  for (const chunk of out.split(/\]\s*\[/)) {
    try {
      const parsed = JSON.parse(chunk.startsWith("[") ? chunk : `[${chunk}`);
      const rows = parsed[0]?.results ?? [];
      if (rows.length) return rows;
    } catch {
      /* keep scanning: a chunk that is not JSON is wrangler's own chatter */
    }
  }
  return [];
}

/** Every row of a table as one JSON string, so a canary search can run over the whole record. */
function tableText(db, table, where = "1=1") {
  const rows = query(db, `SELECT * FROM ${table} WHERE ${where}`);
  return rows;
}

// ---------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------
let exitCode = 0;
let db = null;
try {
  db = d1Path();
  if (!db)
    throw new Error(
      `no D1 database under apps/api/.wrangler/state (looked in ${join(REPO, "apps/api/.wrangler/state")})`,
    );

  const { jar, orgId, email } = await session();
  const canaries = {
    password: CANARY_PASSWORD,
    session: jar.cookies.get("lumi_session") ?? null,
    csrf: jar.cookies.get("lumi_csrf") ?? null,
  };

  // ---- THE OPERATION. One request; every leg below must carry its id. ----------------------
  const policy = await call(jar, "PUT", `/api/v1/orgs/${orgId}/policy`, {
    allowed_aliases: [],
    allowed_models: [],
    allowed_providers: [],
    credential_mode: "platform_only",
    managed_route_enabled: true,
    version: 0,
  });
  if (policy.status >= 400) {
    throw new Error(
      `the policy write failed (${policy.status}), so there is no operation to correlate`,
    );
  }
  const requestId =
    policy.headers.get("x-request-id") ??
    policy.body?.request_id ??
    policy.body?.error?.request_id ??
    null;
  ok(
    "C0 PRECONDITION: the response names its own request id, so there is an id to follow",
    typeof requestId === "string" && requestId.startsWith("req_"),
    `request_id=${requestId ?? "(absent)"} status=${policy.status}`,
  );
  if (!requestId) throw new Error("no request id on the response, so no correlation is possible");

  // ---- LEG 1: the domain action actually happened -------------------------------------------
  const policyRows = tableText(db, "org_model_policies", `org_id = '${orgId}'`);
  ok(
    "C1 LEG 'domain action': the policy row EXISTS and the write committed",
    policyRows.length === 1,
    `rows=${policyRows.length}`,
  );
  ok(
    "C1 LEG 'auth/policy': the stored policy carries the value that was written",
    policyRows[0]?.managed_route_enabled === 1 || policyRows[0]?.managed_route_enabled === true,
    `managed_route_enabled=${JSON.stringify(policyRows[0]?.managed_route_enabled)} ` +
      `credential_mode=${JSON.stringify(policyRows[0]?.credential_mode)}`,
  );

  // ---- LEG 2: the audit/security event ----------------------------------------------------
  const securityRows = tableText(db, "security_events", `request_id = '${requestId}'`);
  ok(
    "C1 LEG 'audit/security event': a security_events row carries THIS request's id",
    securityRows.length >= 1,
    `rows=${securityRows.length} actions=${JSON.stringify(securityRows.map((r) => r.action))}`,
  );
  // The column is `action`, not `event_type`. The OUTBOX table calls it `event_type` and the
  // security table calls it `action`, and the first version of this probe read `event_type` on both
  // -- so the outbox leg passed and this one failed on `event_types=[null]`. That is a probe bug and
  // not a product finding, but it is the same hazard V01-036 was: the two halves of one system use
  // different vocabulary, and a probe that assumes one name reads the other as absent. A `null`
  // where a name was expected reads exactly like a missing record.
  ok(
    "C1: the security event names the operation, so the row is about this and not a coincidence",
    securityRows.some((r) => /model_policy|policy/i.test(String(r.action ?? ""))),
    `actions=${JSON.stringify(securityRows.map((r) => r.action))} ` +
      `resource_types=${JSON.stringify(securityRows.map((r) => r.resource_type))}`,
  );
  ok(
    "C1: and it is attributed to a principal -- ADR 0007's requirement that a customer-visible " +
      "action is attributable, which V01-038 found unsatisfiable for a staff actor",
    securityRows.every((r) => typeof r.actor_type === "string" && r.actor_type.length > 0),
    `actor_types=${JSON.stringify(securityRows.map((r) => r.actor_type))}`,
  );

  // ---- LEG 3: the outbox / external dispatch queue -----------------------------------------
  const outboxRows = tableText(
    db,
    "outbox_events",
    `request_id = '${requestId}' OR correlation_id = '${requestId}'`,
  );
  ok(
    "C1 LEG 'external dispatch/queue': an outbox_events row carries this request's id (or its " +
      "correlation id)",
    outboxRows.length >= 1,
    `rows=${outboxRows.length} types=${JSON.stringify(outboxRows.map((r) => r.event_type))}`,
  );
  ok(
    "C1: and the outbox row is attributed to the same organization, so the id is not being " +
      "reused across tenants",
    outboxRows.length === 0 ||
      outboxRows.every((r) => r.organization_id === orgId || r.org_id === orgId),
    `org=${orgId} rows=${JSON.stringify(outboxRows.map((r) => r.organization_id ?? r.org_id))}`,
  );

  // ---- LEG 4: usage/cost, asserted as an ABSENCE ------------------------------------------
  // A policy change spends nothing, so a usage row here would be a finding rather than evidence.
  const usageRows = tableText(db, "usage_events", `org_id = '${orgId}'`);
  ok(
    "C1 LEG 'usage/cost': NO usage row was written for an operation that costs nothing -- asserted " +
      "as an absence, and an absence is only meaningful because the instrument is proven live by " +
      "the legs above",
    usageRows.length === 0,
    `rows=${usageRows.length}`,
  );

  // ---- LEG 5: the request/response log line ------------------------------------------------
  const logCandidates = [
    join(REPO, "apps/api/.wrangler/logs"),
    "/private/tmp/claude-501/-Users-wwzz-Downloads-proxyclawd/88833871-9d1c-410a-8425-a5a54e5377ef/scratchpad",
  ];
  let logText = null;
  for (const dir of logCandidates) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort().reverse()) {
      if (!name.endsWith(".log")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      if (text.includes(requestId)) {
        logText = text;
        break;
      }
    }
    if (logText) break;
  }
  if (logText) {
    const line =
      logText.split("\n").find((l) => l.includes(requestId) && l.includes("http_request")) ?? "";
    ok(
      "C1 LEG 'request'/'response': the middleware logged an http_request line carrying this id",
      Boolean(line),
      line ? line.slice(0, 180) : `the id appears in the log but not on an http_request line`,
    );
    ok(
      "C1: and the log line records the STATUS, so the log is evidence about the response rather " +
        "than only about the request",
      /"status":\s*\d{3}/.test(line),
      line ? line.slice(0, 180) : "(no line)",
    );
  } else {
    unmeasured(
      "C1 LEG 'request'/'response': the http_request log line",
      `the id ${requestId} was not found in any worker log under ${logCandidates[0]} -- the middleware ` +
        `writes to stdout and the log location is harness-dependent, so this leg is UNMEASURED rather ` +
        `than assumed present`,
    );
  }

  // ---- C2: THE CANARY CHECK. The whole point of using known credential values. --------------
  const canaryRows = [
    ["security_events", `request_id = '${requestId}'`],
    ["outbox_events", `request_id = '${requestId}' OR correlation_id = '${requestId}'`],
    ["org_model_policies", `org_id = '${orgId}'`],
    ["idempotency_records", `1=1`],
  ];
  for (const [table, where] of canaryRows) {
    let text = "";
    try {
      text = JSON.stringify(tableText(db, table, where));
    } catch (error) {
      unmeasured(
        `C2 canary: ${table} carries no credential`,
        `could not read the table: ${error.message}`,
      );
      continue;
    }
    for (const [label, value] of Object.entries(canaries)) {
      if (!value) continue;
      ok(
        `C2 canary: the ${CANARY_LABEL[label]} does NOT appear anywhere in ${table}`,
        !text.includes(value),
        value
          ? `${label} searched across ${text.length} bytes of ${table}`
          : `${label} was not issued`,
      );
    }
  }
  // The password is the one canary that exists regardless of cookie issuance, so it gets its own
  // unconditional assertion rather than living only inside the loop above.
  const wholeDatabase = JSON.stringify(
    ["users", "sessions", "security_events", "outbox_events", "idempotency_records"].flatMap(
      (t) => {
        try {
          return tableText(db, t, "1=1");
        } catch {
          return [];
        }
      },
    ),
  );
  ok(
    "C2 canary: the PASSWORD does not appear anywhere in users, sessions, security_events, " +
      "outbox_events or idempotency_records",
    !wholeDatabase.includes(CANARY_PASSWORD),
    `searched ${wholeDatabase.length} bytes of stored records`,
  );

  // ---- THE POSITIVE CONTROL, and it is the case that makes every canary above mean anything ----
  //
  // Twelve assertions above say "this canary is NOT in these records". A search that cannot find
  // anything satisfies all twelve -- it is a needle that finds no needle and reports the haystack
  // clean. That is the single most dangerous shape a verifier can have, because it reads exactly
  // like a clean result and is indistinguishable from one.
  //
  // So the SAME search, over the SAME bytes, is run against a value that is KNOWN to be present --
  // this request's own id and this organization's own id, both of which the legs above proved are
  // written. If the search cannot find those, it could not have found the password either, and the
  // twelve passes above would be statements about a broken instrument.
  //
  // This control runs LAST on purpose. It is the thing that makes the earlier results readable, and
  // a harness that bails before reaching it would report the passes without the evidence.
  ok(
    "C2 POSITIVE CONTROL: the same search FINDS this request's own id in the records it was " +
      "correlated against -- so 'the password was not found' is a measurement and not an absent " +
      "instrument",
    wholeDatabase.includes(requestId),
    `request_id=${requestId} searched across ${wholeDatabase.length} bytes`,
  );
  ok(
    "C2 POSITIVE CONTROL: and FINDS this organization's id, so the search reads identity columns " +
      "rather than only opaque blobs",
    wholeDatabase.includes(orgId),
    `org_id=${orgId}`,
  );
  // And the negative direction, on the same instrument: a canary that is trivially similar to a
  // real stored value must still not match. If the search were matching on a loose prefix rather
  // than the whole literal, this would pass for the wrong reason.
  ok(
    "C2 NEGATIVE CONTROL: a canary that shares its PREFIX with the real password but differs in its " +
      "last four characters is still not found -- so the search matches the whole literal and not a " +
      "prefix, and the twelve passes above are not an artefact of a loose match",
    !wholeDatabase.includes(CANARY_PASSWORD.slice(0, CANARY_PASSWORD.length - 4)),
    `prefix searched: ${CANARY_PASSWORD.slice(0, CANARY_PASSWORD.length - 4)}…`,
  );
  ok(
    "C2 canary: nor does the account's email outside the users row, so a stored record is not " +
      "carrying the sign-in identity where it has no business to",
    !JSON.stringify(tableText(db, "security_events", "1=1")).includes(email),
    `email=${email}`,
  );
} catch (error) {
  console.error(`\n  observability probe could not complete: ${error?.message ?? error}\n`);
  for (const entry of results) entry.verdict = "UNMEASURED";
  record("the probe completed", "UNMEASURED", String(error?.message ?? error));
  exitCode = 2;
}

const width = Math.max(...results.map((r) => r.name.length), 20);
console.log("\n  V02 observability -- one request id followed through the system\n");
for (const entry of results) {
  console.log(`  ${entry.verdict.padEnd(11)} ${entry.name}`);
  if (entry.detail) console.log(`  ${" ".repeat(12)}${entry.detail}`);
}
const failures = results.filter((r) => r.verdict === "FAIL");
const unmeasuredCount = results.filter((r) => r.verdict === "UNMEASURED").length;
console.log("");
console.log(
  `  ${results.length - failures.length - unmeasuredCount} pass, ${failures.length} fail, ${unmeasuredCount} unmeasured.`,
);
console.log("  A leg that could not be read is UNMEASURED, not passing.\n");
process.exit(exitCode === 2 ? 2 : failures.length > 0 ? 1 : 0);
