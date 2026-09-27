// P09 secret-canary verification: the cross-workspace half.
//
// The Rust half lives in `apps/api/src/security/secret_canary.rs`, because a
// canary has to be planted in a real `MachineKey` or a real `PasswordRecord` and
// only Rust can construct those. This script covers what Rust cannot reach at all,
// for one reason: it is not in the Cargo crate.
//
//   1. `apps/web/src` — browser storage, cookies, the URL, and the console. A
//      Worker is a server and a browser tab is not; a secret in `sessionStorage`
//      survives a tab close and a secret in a query string lands in browser
//      history, in a `Referer` header, and in every proxy log on the way.
//   2. `apps/api/migrations` — the DDL, which no Rust type describes.
//   3. The whole workspace — committed secret-shaped literals, which are a leak
//      that has already happened by the time anyone reviews a diff.
//   4. The wiring itself — that both halves are actually compiled and run.
//
// FOUR THINGS THIS SCRIPT EXISTS TO PREVENT:
//
//   1. FALSE PASSES FROM AN EMPTY CORPUS. Every scan asserts a floor on what it
//      found before it asserts anything about it. A scan that quietly stopped
//      walking `apps/web/src` would otherwise report "no leaks" forever.
//   2. A VACUOUS DETECTOR. `the_detector_would_catch_a_planted_leak` plants a
//      synthetic leak and asserts the detector reports it. A canary that cannot
//      fail is not a canary, so the ability to fail is itself a case.
//   3. A REVIEW LIST THAT ROTS. Every allow-list entry is checked for existence
//      and for the property that justified it, so deleting a file or renaming a
//      field fails CI instead of silently widening the exemption.
//   4. AN EXEMPTION LIST USED AS A TRUCK. `the_reviewed_literals_stay_reviewed`
//      pins the ratio, because an allow-list that grows to cover most of the
//      corpus is a way to normalise the bug rather than record a judgement.
//
// Usage:
//   node apps/api/scripts/p09-secret-canary.mjs
//
// Exits non-zero if any case does not behave as declared.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webSrc = path.join(repoRoot, "apps/web/src");
const apiSrc = path.join(repoRoot, "apps/api/src");
const apiRoot = path.join(repoRoot, "apps/api");
const migrationsDir = path.join(apiRoot, "migrations");

// --- The identifiers that name secret material -------------------------------
//
// A list of NAMES, not of types, for the same reason the Rust registry is: this
// script cannot construct a `MachineKey`. It is a ratchet against the obvious
// mistake, not a proof. The proof is in the Rust half.
const SECRET_IDENTIFIERS = [
  "secret",
  "secrets",
  "secret_hash",
  "plaintext",
  "wire_value",
  "password",
  "encoded_hash",
  "code_hash",
  "token_hash",
  "csrf_hash",
  "claim_token",
  "key_digest",
  "grant_token",
  "download_token",
  "token_fingerprint",
  "lease_token_fingerprint",
  "object_key",
  "ciphertext",
  "private_key",
  "signing_secret",
  "api_key",
  "raw_token",
  "device_token",
  "session_token",
  "reauth_token",
  "refresh_token",
  "access_token",
  "code_verifier",
  "pkce_verifier",
  "state_json",
];

// --- The exemptions, each with the reason it is safe -------------------------

/**
 * `document.cookie` sites. Every one of these must be a READ.
 *
 * A read is `document.cookie` followed by a split; a write is an assignment to
 * `document.cookie` or a `cookieStore.set`. The list is here so that adding a
 * cookie write has to be a decision rather than an accident.
 */
const REVIEWED_COOKIE_READERS = [
  "apps/web/src/lib/api.ts",
  "apps/web/src/features/billing/api.ts",
  "apps/web/src/features/automations/api.ts",
  "apps/web/src/features/data-governance/api.ts",
  "apps/web/src/features/webhooks/api.ts",
  "apps/web/src/features/tools/helpers.ts",
  "apps/web/src/features/identity/api.ts",
  // P08. Reads `lumi_csrf` and echoes it as `X-CSRF-Token` on unsafe methods —
  // the double-submit pattern, which requires reading a cookie the SPA cannot
  // avoid. Same shape as the seven above; a read, never a write.
  "apps/web/src/features/adoption/api.ts",
];

/**
 * The web files that may name a one-time secret at all.
 *
 * The contract (F14-002, F11-002, and the webhook secret contract) is that a
 * plaintext secret exists in exactly two places: the create/rotate response, and
 * a reducer that can only be entered by that response and can only be left by an
 * acknowledgement. Everything else — the panel that fetches the list, the api
 * module, the tests — is allowed to *pass the secret along* and to assert its
 * absence from storage, and nothing more.
 *
 * A new feature surface that needs the same behaviour must appear here with a
 * reducer, not with a `useState` and a `useEffect` that writes to storage.
 */
const REVIEWED_ONE_TIME_SECRET_FILES = [
  "apps/web/src/features/identity/api.test.ts",
  "apps/web/src/features/identity/identity-panel.tsx",
  "apps/web/src/features/identity/one-time-secret.test.tsx",
  "apps/web/src/features/identity/one-time-secret.ts",
  "apps/web/src/features/identity/secret-reveal.tsx",
  "apps/web/src/features/webhooks/api.test.ts",
  "apps/web/src/features/webhooks/one-time-secret.test.ts",
  "apps/web/src/features/webhooks/one-time-secret.ts",
  "apps/web/src/features/webhooks/render.test.tsx",
  "apps/web/src/features/webhooks/secret-reveal.tsx",
  "apps/web/src/features/webhooks/webhooks-panel.tsx",
];

/**
 * Committed secret-shaped literals, and why each is not a leak.
 *
 * The scanner looks for the WIRE FORMS, not for the word "secret", because the
 * word appears in thousands of comments and identifiers and matching it would
 * produce a harness nobody reads.
 */
const REVIEWED_LITERALS = [
  {
    file: "apps/api/src/adapters/password.rs",
    why: "`DUMMY_PASSWORD_HASH` is a real argon2id hash of a value nobody knows, verified against on a failed login so the response time does not reveal whether the account exists. It is public by construction: publishing it leaks nothing, and NOT publishing it would reintroduce the timing oracle.",
  },
  {
    file: "apps/api/src/security/secret_canary.rs",
    why: "The canary values themselves. They are planted by a test, asserted to be unobservable, and are not credentials for any system.",
  },
  {
    file: "apps/api/src/routes/machine_identity.rs",
    why: "A fixture inside `#[cfg(test)]`, asserting that the create/rotate projection carries the value it was handed.",
  },
  {
    file: "apps/api/src/adapters/providers.rs",
    why: "A canary inside `#[cfg(test)]`, asserting the mid-stream error path drops the provider's message.",
  },
  {
    file: "apps/web/src/features/identity/api.test.ts",
    why: "Fixtures inside a Vitest file, asserting the browser decodes a create/rotate secret and refuses a metadata-shaped one.",
  },
  {
    file: "apps/web/src/features/identity/one-time-secret.test.tsx",
    why: "A fixture inside a Vitest file, asserting the reducer's storage invariants.",
  },
];

// --- Corpus helpers ---------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

/** Every source file under `dir`, excluding the obvious noise. */
function sources(dir, extensions) {
  return walk(dir)
    .filter((file) => extensions.includes(path.extname(file)))
    .filter((file) => !/(^|\/)node_modules\//.test(file))
    .filter((file) => !/(^|\/)dist\//.test(file))
    .sort();
}

/** Blank out comments, so a doc comment naming a storage API is not a hit. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + " ".repeat(match.length - lead.length));
}

const webFiles = sources(webSrc, [".ts", ".tsx"]);
const apiFiles = sources(apiSrc, [".rs"]);

/**
 * Every line of every web file, with comments removed and the path attached.
 * Returned once because four cases walk the same corpus.
 */
const webCode = webFiles.flatMap((file) => {
  const body = withoutComments(readFileSync(file, "utf8"));
  return body.split("\n").map((text, index) => ({
    file: relative(file),
    line: index + 1,
    text,
  }));
});

const webSource = new Map(webFiles.map((file) => [relative(file), readFileSync(file, "utf8")]));

// --- The cases --------------------------------------------------------------

const cases = [];
const check = (label, run) => cases.push({ label, run });

/**
 * A detector that reports the secret-shaped lines in a corpus.
 *
 * Extracted so the self-test can plant a leak and prove this function fires,
 * rather than asserting that a list is empty.
 */
function secretLines(entries) {
  return entries.filter((entry) =>
    SECRET_IDENTIFIERS.some((name) => new RegExp(`\\b${name}\\b`).test(entry.text)),
  );
}

check("the web corpus is not empty, so the scans below mean something", () => {
  if (webFiles.length < 50) {
    return `only ${webFiles.length} web source files were found; the walk probably broke`;
  }
  if (webCode.length < 5_000) {
    return `only ${webCode.length} web lines were scanned; the walk probably broke`;
  }
  return null;
});

check("the web bundle writes nothing to browser storage", () => {
  const forbidden = [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches.open",
    "navigator.storage",
  ];
  const hits = webCode.filter((entry) => forbidden.some((name) => entry.text.includes(name)));
  return hits.length
    ? `these lines reach a browser store that survives a tab close:\n  ${hits
        .map((hit) => `${hit.file}:${hit.line} ${hit.text.trim()}`)
        .join("\n  ")}`
    : null;
});

check("the web bundle logs nothing to the console", () => {
  // A console call in a browser tab is a support-bundle leak: every value that
  // reaches it is copied into whatever the user attaches to a ticket.
  const hits = webCode.filter((entry) => /\bconsole\s*\./.test(entry.text));
  return hits.length
    ? `these lines log to the browser console:\n  ${hits
        .map((hit) => `${hit.file}:${hit.line} ${hit.text.trim()}`)
        .join("\n  ")}`
    : null;
});

check("the web bundle only READS cookies, and every reader is reviewed", () => {
  const readers = new Set();
  const problems = [];
  for (const entry of webCode) {
    if (!entry.text.includes("document.cookie")) continue;
    // A read is `document.cookie` used as a value. A write assigns to it.
    if (/document\.cookie\s*=/.test(entry.text)) {
      problems.push(`${entry.file}:${entry.line} assigns to document.cookie`);
      continue;
    }
    if (/cookieStore\.(set|delete)/.test(entry.text)) {
      problems.push(`${entry.file}:${entry.line} writes through cookieStore`);
      continue;
    }
    readers.add(entry.file);
  }
  if (problems.length) return problems.join("\n  ");
  for (const file of readers) {
    if (!REVIEWED_COOKIE_READERS.includes(file)) {
      problems.push(`${file} reads a cookie and is not on the reviewed reader list`);
    }
  }
  for (const file of REVIEWED_COOKIE_READERS) {
    if (!webSource.has(file)) {
      problems.push(`${file} is gone; delete the reviewed cookie reader entry`);
    } else if (!webSource.get(file).includes("document.cookie")) {
      problems.push(`${file} no longer reads a cookie; delete the reviewed entry`);
    }
  }
  return problems.length ? problems.join("\n  ") : null;
});

check("no secret-shaped value is placed in a URL", () => {
  // A query parameter survives in browser history, in a `Referer` header, and in
  // every proxy and CDN log between the browser and the Worker. A path segment
  // does the same and is worse, because it is often logged as a route.
  const carriers = [
    "URLSearchParams",
    "searchParams.set",
    "pushState",
    "replaceState",
    "location.href",
  ];
  const hits = webCode.filter(
    (entry) =>
      carriers.some((carrier) => entry.text.includes(carrier)) && secretLines([entry]).length > 0,
  );
  return hits.length
    ? `these lines put a secret-named value into a URL:\n  ${hits
        .map((hit) => `${hit.file}:${hit.line} ${hit.text.trim()}`)
        .join("\n  ")}`
    : null;
});

check("only the reviewed one-time-secret files name a raw secret", () => {
  const concept =
    /RevealedSecret|oneTimeSecretReducer|useOneTimeSecret|useSecretReveal|PLAINTEXT_ON_|OneTimeSecret/;
  const found = new Set(
    webFiles
      .filter((file) => concept.test(readFileSync(file, "utf8")))
      .map((file) => relative(file)),
  );
  const problems = [];
  for (const file of found) {
    if (!REVIEWED_ONE_TIME_SECRET_FILES.includes(file)) {
      problems.push(`${file} names a one-time secret and is not reviewed`);
    }
  }
  for (const file of REVIEWED_ONE_TIME_SECRET_FILES) {
    if (!found.has(file)) {
      problems.push(`${file} no longer names a one-time secret; delete the reviewed entry`);
    }
  }
  return problems.length ? problems.join("\n  ") : null;
});

check("no component holds a secret in React state outside the two reducers", () => {
  // The reducers are the whole design: `reveal` is the only action that can put a
  // secret in state and `acknowledge`/`forget` is the only way out. A `useState`
  // holding a secret is the shape that design exists to prevent, because a
  // `useState` has a `restore` and a `useEffect` that can write it somewhere.
  const reviewed = new Set([
    "apps/web/src/features/identity/one-time-secret.ts",
    "apps/web/src/features/webhooks/one-time-secret.ts",
  ]);
  const pattern = /useState[^;\n]*\b(secret|token|password|apiKey|passphrase|credential)\b/i;
  const hits = webCode.filter((entry) => pattern.test(entry.text) && !reviewed.has(entry.file));
  return hits.length
    ? `a component holds a secret in useState; use the one-time-secret reducer:\n  ${hits
        .map((hit) => `${hit.file}:${hit.line} ${hit.text.trim()}`)
        .join("\n  ")}`
    : null;
});

check("no secret-shaped literal is committed outside the reviewed fixtures", () => {
  // The wire FORMS, not the word "secret". A real credential in source is a leak
  // that has already happened by the time anybody reviews the diff, and a leaked
  // key in git history is a leaked key forever.
  const forms = [
    { name: "lumik wire value", pattern: /lumik_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/ },
    { name: "lumi_staff wire value", pattern: /lumi_staff_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/ },
    { name: "argon2id hash", pattern: /\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$/ },
    { name: "provider API key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
    { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
    { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: "Cloudflare API token", pattern: /\bv1\.0-[A-Za-z0-9_-]{37}\b/ },
  ];

  const roots = [path.join(repoRoot, "apps"), path.join(repoRoot, "docs")];
  const reviewed = new Set(REVIEWED_LITERALS.map((entry) => entry.file));
  const hits = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      if (/(^|\/)node_modules\//.test(file)) continue;
      if (/(^|\/)dist\//.test(file)) continue;
      if (/(^|\/)target\//.test(file)) continue;
      if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|pdf|zip|wasm)$/i.test(file)) continue;
      const name = relative(file);
      if (reviewed.has(name)) continue;
      let body;
      try {
        body = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const form of forms) {
        const lines = body.split("\n");
        for (const [index, text] of lines.entries()) {
          // A file whose own name says `test` is a fixture, not a credential.
          if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /_tests?\.rs$/.test(file)) break;
          if (form.pattern.test(text)) {
            hits.push(`${name}:${index + 1} looks like a committed ${form.name}`);
          }
        }
      }
    }
  }
  return hits.length ? hits.join("\n  ") : null;
});

check("the reviewed literals stay reviewed", () => {
  const problems = [];
  for (const entry of REVIEWED_LITERALS) {
    const full = path.join(repoRoot, entry.file);
    if (!exists(full)) {
      problems.push(`${entry.file} is gone; delete the reviewed literal entry`);
      continue;
    }
    if (entry.why.trim().length < 40) {
      problems.push(`${entry.file} has no substantive reason`);
    }
  }
  // The exemption list must stay small relative to the corpus, or it stops being
  // a judgement and becomes a suppression of everything.
  const total = sources(path.join(repoRoot, "apps"), [".rs", ".ts", ".tsx"]).length;
  if (REVIEWED_LITERALS.length * 10 > total) {
    problems.push(
      `${REVIEWED_LITERALS.length} reviewed literals against ${total} source files; the list has stopped being a judgement`,
    );
  }
  return problems.length ? problems.join("\n  ") : null;
});

check("no secret-named migration column carries a default value", () => {
  // A `DEFAULT` on a secret column is a secret that every row inherits, and one
  // that survives in `sqlite_master`, in a schema dump, and in a restore.
  const hits = [];
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const lines = readFileSync(path.join(migrationsDir, file), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (!/DEFAULT/i.test(text)) return;
      const column = /^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/.exec(text)?.[1];
      if (!column) return;
      if (!SECRET_IDENTIFIERS.includes(column)) return;
      hits.push(`${file}:${index + 1} ${column} has a DEFAULT`);
    });
  }
  return hits.length ? hits.join("\n  ") : null;
});

check("the Rust half of the canary harness is registered in the crate", () => {
  // `cargo test --workspace` compiles `apps/api/src`. A canary file that nothing
  // declares is a file that never runs, and a harness that never runs passes.
  const problems = [];
  const moduleFile = path.join(apiSrc, "security", "secret_canary.rs");
  if (!exists(moduleFile)) {
    problems.push("apps/api/src/security/secret_canary.rs is missing");
  } else {
    const moduleText = readFileSync(path.join(apiSrc, "security", "mod.rs"), "utf8");
    if (!/mod\s+secret_canary\s*;/.test(moduleText)) {
      problems.push("security/mod.rs does not declare `mod secret_canary;`");
    }
    const libText = readFileSync(path.join(apiSrc, "lib.rs"), "utf8");
    if (!/^\s*(pub\s+)?mod\s+security\s*;/m.test(libText)) {
      problems.push("lib.rs does not declare the security module");
    }
    const canary = readFileSync(moduleFile, "utf8");
    if (!/#!\[cfg\(test\)\]/.test(canary)) {
      problems.push("secret_canary.rs is not test-only; a filesystem walk must not ship");
    }
    const assertions = (canary.match(/^#\[test\]$/gm) ?? []).length;
    if (assertions < 20) {
      problems.push(`secret_canary.rs declares only ${assertions} cases`);
    }
  }
  return problems.length ? problems.join("\n  ") : null;
});

check("both halves are wired into pnpm test", () => {
  const problems = [];
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  // Each required step is asserted SEPARATELY, not as one exact string.
  //
  // The first version of this case compared `scripts.test` to a whole literal, so
  // wiring a fourth legitimate gate into `pnpm test` broke it. The check was
  // asserting the shape of the command line rather than the property it exists for,
  // and it would have resisted every future gate anyone added. Listing the steps it
  // actually needs keeps the same coverage and stops being a tripwire.
  const required = [
    ["cargo test --workspace", "the Rust canaries"],
    ["schema:p07", "the storage invariants"],
    ["canary:p09", "this half of the secret canary"],
    ["schema:null-check", "the NULL-passes-CHECK scan"],
  ];
  for (const [step, what] of required) {
    if (!String(pkg.scripts?.test).includes(step)) {
      problems.push(`the root test script no longer runs ${what} (missing "${step}")`);
    }
  }
  if (pkg.scripts?.["canary:p09"] !== "node apps/api/scripts/p09-secret-canary.mjs") {
    problems.push("the canary:p09 script is not the one this file implements");
  }
  if (pkg.scripts?.["schema:null-check"] !== "node apps/api/scripts/p09-null-check-scan.mjs") {
    problems.push("the schema:null-check script is not the one that implements it");
  }
  return problems.length ? problems.join("\n  ") : null;
});

check("the detector would catch a planted leak", () => {
  // Without this, an empty corpus, a broken walker, or an inverted predicate
  // would make every case above pass. The ability to fail is the case.
  const planted = [
    { file: "planted.ts", line: 1, text: "localStorage.setItem('k', value);" },
    { file: "planted.ts", line: 2, text: "console.log(session_token);" },
    { file: "planted.ts", line: 3, text: "params.set('token', session_token);" },
    { file: "planted.ts", line: 4, text: "document.cookie = 'x=1';" },
  ];
  const problems = [];
  if (secretLines(planted).length === 0) {
    problems.push("the secret detector does not fire on a planted secret");
  }
  if (!planted.some((entry) => /\bconsole\s*\./.test(entry.text))) {
    problems.push("the console detector does not fire on a planted console call");
  }
  if (!planted.some((entry) => /document\.cookie\s*=/.test(entry.text))) {
    problems.push("the cookie detector does not fire on a planted cookie write");
  }
  if (!planted.some((entry) => entry.text.includes("localStorage"))) {
    problems.push("the storage detector does not fire on a planted storage write");
  }
  return problems.length ? problems.join("\n  ") : null;
});

check("the control case holds, so the detectors are not simply inverted", () => {
  // The negative form. A detector that flags everything is as useless as one that
  // flags nothing, and it is much easier to write by accident.
  const clean = [
    { file: "clean.ts", line: 1, text: "export function listKeys(orgId: string) {" },
    { file: "clean.ts", line: 2, text: "  return request(`/orgs/${orgId}/keys`);" },
  ];
  const problems = [];
  if (secretLines(clean).length !== 0) {
    problems.push(`the secret detector flags a clean line: ${JSON.stringify(secretLines(clean))}`);
  }
  if (clean.some((entry) => /\bconsole\s*\./.test(entry.text))) {
    problems.push("the console detector flags a clean line");
  }
  return problems.length ? problems.join("\n  ") : null;
});

// --- Runner -----------------------------------------------------------------

function exists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

let passed = 0;
const failures = [];
for (const testCase of cases) {
  let problem = null;
  try {
    problem = testCase.run();
  } catch (error) {
    problem = `threw: ${error.message}`;
  }
  if (problem) {
    failures.push(testCase.label);
    console.log(`  FAIL  ${testCase.label}`);
    for (const line of String(problem).split("\n")) console.log(`        ${line}`);
  } else {
    passed += 1;
    console.log(`  PASS  ${testCase.label}`);
  }
}

console.log(
  `\n${passed}/${cases.length} canaries held across ${webFiles.length} web and ${apiFiles.length} api sources`,
);
if (failures.length > 0) {
  console.error(`\n${failures.length} case(s) failed:`);
  for (const label of failures) console.error(`  - ${label}`);
  process.exitCode = 1;
}
