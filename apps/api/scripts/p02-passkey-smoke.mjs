#!/usr/bin/env node
// P02 passkey ceremony runtime probe.
//
// WHY THIS EXISTS
//
// F01 makes passkeys the PRIMARY authentication method, and until V00-2026-09-27
// nothing in this repository exercised a WebAuthn ceremony against a real
// Worker. That gap hid a critical defect: `passkey_auth::types::now_secs()`
// called `std::time::SystemTime::now()`, which is `unsupported()` and panics on
// `wasm32-unknown-unknown`, so all eight ceremony endpoints returned HTTP 500 in
// production while the host unit tests, the WASM type check, and four runtime
// smokes were all green. See
// `docs/verification/runs/2026-09-27-v00-independent-reconstruction/findings/VFY-001-passkey-ceremony-panics-on-worker-runtime.md`
// and `docs/adr/0008-vendored-passkey-auth-wasm-clock.md`.
//
// WHAT IS AND IS NOT FAKED
//
// The crypto is real. This script generates a P-256 key with node:crypto, builds
// the authenticator data structures the WebAuthn spec defines, and signs the
// authentication assertion with ES256 exactly as a CTAP2 authenticator would. The
// server does real CBOR/COSE parsing and real signature verification inside the
// Worker. Nothing about the verification path is stubbed.
//
// What a real authenticator does that this does not: hold the private key
// internally, and refuse to sign without user presence. Those are authenticator
// properties, not server properties, and they sit outside the control plane's
// boundary. The complementary check — a genuine CTAP2 virtual authenticator
// driving the real UI — is `apps/api/scripts/browser-probe.mjs`. This probe and
// that one are the two halves of the same claim: the hostile matrix lives here
// because it is hermetic and fast, and the real authenticator lives there because
// only a browser can provide one.
//
// It is self-contained: a fresh local D1 persist directory, all migrations, its
// own development Worker, removed on exit.
//
// Usage:
//   node apps/api/scripts/p02-passkey-smoke.mjs
//   P02_PASSKEY_API_BASE=http://127.0.0.1:8787 node apps/api/scripts/p02-passkey-smoke.mjs
//
// Environment:
//   P02_PASSKEY_API_BASE       drive an already-running Worker (skips D1 assertions)
//   P02_PASSKEY_PORT           local Worker port (default: an available port)
//   P02_PASSKEY_PERSIST_TO     use a specific fresh local persist directory
//   P02_PASSKEY_KEEP_PERSIST=1 retain the directory for debugging
//   P02_PASSKEY_FORWARD_VARS=1 pass WEBAUTHN_RP_ID / WEBAUTHN_RP_NAME /
//                              WEBAUTHN_ORIGINS to the spawned Worker as
//                              `--var`, so the Worker and the client below run
//                              the same pairing (e.g. the production values)
//
// Exits non-zero if any case does not behave as declared.

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as signOneShot,
} from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// The development Worker configures the relying party from `WEBAUTHN_RP_ID` /
// `WEBAUTHN_ORIGINS`, defaulting to `localhost` and `http://localhost:5173`
// (see `app::router`). The origin below MUST match: a mismatch would be refused
// for the right reason and read as a pass for the wrong one.
const RP_ID = process.env.WEBAUTHN_RP_ID ?? "localhost";
const ORIGIN = process.env.WEBAUTHN_ORIGINS?.split(",")[0]?.trim() ?? "http://localhost:5173";

// The password these probes configure on their throwaway account. Named once, so the
// probe that sets it and the probe that signs in with it cannot drift into using two
// different values and failing for a reason unrelated to the claim under test.
const PROBE_PASSWORD = "correct horse battery staple 42";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, "..");
// Resolvable from outside this tree, so the mutation campaign can run the probe
// against a mutated copy of the repository that carries no `node_modules` of its
// own. Defaults to the real one next to this file.
const wranglerBin =
  process.env.P02_PASSKEY_WRANGLER ?? path.join(apiDir, "node_modules/.bin/wrangler");

const failures = [];
const passes = [];
const services = [];
let persistDir = null;
let ownsPersistDir = false;
let baseUrl = process.env.P02_PASSKEY_API_BASE ?? null;
let worker = null;

function pass(label, detail = "") {
  passes.push(label);
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  failures.push({ label, detail });
  console.log(`FAIL  ${label} — ${detail}`);
}

function expect(label, condition, detail = "") {
  if (condition) pass(label, detail);
  else fail(label, detail || "the condition was false");
  return Boolean(condition);
}

/** Failure text must never carry a cookie, code, challenge, or token. */
function redact(value) {
  return String(value ?? "")
    .replace(/(lumi_session|lumi_csrf)=[^;,\s"]+/g, "$1=<redacted>")
    .replace(
      /"(device_code|code|challenge|token|user_code|user_handle)"\s*:\s*"[^"]*"/gi,
      '"$1":"<redacted>"',
    )
    .slice(0, 240);
}

// --- minimal CBOR, only what an `attestation: "none"` object needs -------------
//
// The attestation object is a map with exactly three keys, so a general encoder
// would be more code than these five helpers. Integers and byte strings are the
// only types involved; the COSE curve parameter -7 is the one negative integer.
const cborBytes = (bytes) => {
  const head = bytes.length;
  if (head < 24) return Buffer.concat([Buffer.from([0x40 | head]), bytes]);
  if (head < 0x100) return Buffer.concat([Buffer.from([0x58, head]), bytes]);
  if (head < 0x1_0000) return Buffer.concat([Buffer.from([0x59, head >> 8, head & 0xff]), bytes]);
  throw new Error(`byte string too long for this encoder: ${head}`);
};
const cborUint = (value) => {
  if (value < 24) return Buffer.from([value]);
  if (value < 0x100) return Buffer.from([0x18, value]);
  if (value < 0x1_0000) return Buffer.from([0x19, value >> 8, value & 0xff]);
  throw new Error(`integer too large for this encoder: ${value}`);
};
const cborNegInt = (magnitude) => Buffer.from([0x20 | (magnitude - 1)]);
const cborText = (value) =>
  Buffer.concat([Buffer.from([0x60 | value.length]), Buffer.from(value, "utf8")]);
const cborMap = (entries) =>
  Buffer.concat([Buffer.from([0xa0 | entries.length]), ...entries.flat()]);
const cborAttestationNone = (authData) =>
  cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authData)],
  ]);

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const b64urlToBytes = (value) => Buffer.from(value, "base64url");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

/** COSE_Key for an ES256 public key: {1:2, 3:-7, -1:1, -2:x, -3:y}. */
function coseEs256(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  return cborMap([
    [cborUint(1), cborUint(2)],
    [cborUint(3), cborNegInt(7)],
    [cborNegInt(1), cborUint(1)],
    [cborNegInt(2), cborBytes(b64urlToBytes(jwk.x))],
    [cborNegInt(3), cborBytes(b64urlToBytes(jwk.y))],
  ]);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

function authenticatorData({ rpId, credentialId, coseKey, flags, signCount = 0 }) {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount, 0);
  const head = Buffer.concat([sha256(Buffer.from(rpId, "utf8")), Buffer.from([flags]), counter]);
  // AT (attested credential data) is only present on registration, and only when
  // the flags say so. A caller that omits it must not silently send it anyway.
  if ((flags & FLAG_AT) === 0) return head;
  const aaguid = Buffer.alloc(16); // what a software authenticator reports
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length, 0);
  return Buffer.concat([head, aaguid, length, credentialId, coseKey]);
}

function clientData({ type, challenge, origin }) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
}

/**
 * Build an `AuthenticationResponse` the way a CTAP2 authenticator would.
 *
 * Module-level rather than a closure inside one probe because two ceremonies need
 * it now: sign-in, and the reauth ceremony that revoking a credential requires.
 * `challenge` is passed in rather than captured, because a fresh ceremony has a
 * fresh challenge and reusing the previous one is precisely the substitution the
 * server must refuse.
 */
function buildAssertion(authenticator, overrides = {}, challenge) {
  const credentialId = overrides.credentialId ?? authenticator.credentialId;
  const authData =
    overrides.authData ??
    authenticatorData({
      rpId: overrides.rpId ?? RP_ID,
      credentialId,
      coseKey: Buffer.alloc(0),
      flags: FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS,
      signCount: overrides.signCount ?? 1,
    });
  const client = clientData({
    type: "webauthn.get",
    challenge: overrides.challenge ?? challenge,
    origin: overrides.origin ?? ORIGIN,
  });
  const signature =
    overrides.signature ?? signEs256(authenticator.privateKey, authData, sha256(client));
  return {
    id: b64url(credentialId),
    raw_id: b64url(credentialId),
    authenticatorData: b64url(authData),
    signature: b64url(signature),
    clientDataJSON: b64url(client),
    ...(overrides.userHandle ? { userHandle: b64url(Buffer.from(overrides.userHandle)) } : {}),
  };
}

function signEs256(privateKey, authData, clientDataHash) {
  return signOneShot("sha256", Buffer.concat([authData, clientDataHash]), {
    key: createPrivateKey({
      key: privateKey.export({ type: "pkcs8", format: "pem" }),
      format: "pem",
    }),
    // WebAuthn ES256 signatures are raw r||s, not DER.
    dsaEncoding: "ieee-p1363",
  });
}

// --- HTTP ---------------------------------------------------------------------

class Jar {
  cookies = new Map();
  absorb(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const [pair] = value.split(";");
      const at = pair.indexOf("=");
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  csrf() {
    return this.cookies.get("lumi_csrf") ?? "";
  }
}

async function call(jar, method, urlPath, body, extraHeaders = {}) {
  const headers = { Accept: "application/json", ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  const csrf = jar.csrf();
  if (csrf && method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  jar.absorb(response);
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = { raw };
  }
  return { status: response.status, body: payload, raw };
}

const reasonOf = (result) =>
  result.body?.error?.details?.reason ?? result.body?.error?.code ?? null;

/** A 4xx/5xx is only meaningful with a stable machine-readable reason attached. */
function refusedWithReason(result) {
  return result.status >= 400 && result.status < 500 && typeof reasonOf(result) === "string";
}

// --- infrastructure -----------------------------------------------------------

function runWrangler(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(wranglerBin, args, {
      cwd: apiDir,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${label} failed (${code}): ${redact(output.slice(-2000))}`)),
    );
  });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startWorker(port) {
  const args = [
    "dev",
    "--env",
    "development",
    "--local",
    "--port",
    String(port),
    "--persist-to",
    persistDir,
    "--show-interactive-dev-session=false",
  ];
  // `wrangler dev` does not surface the process environment as Worker vars, so
  // driving the Worker with a non-default relying-party pairing needs an
  // explicit `--var` passthrough. Opt-in, so a mismatch between the Worker's
  // pairing and the client's stays expressible — that mismatch is the control
  // which proves this suite notices a pairing change at all.
  if (process.env.P02_PASSKEY_FORWARD_VARS === "1") {
    for (const name of ["WEBAUTHN_RP_ID", "WEBAUTHN_RP_NAME", "WEBAUTHN_ORIGINS"]) {
      const value = process.env[name];
      if (value) args.push("--var", `${name}:${value}`);
    }
  }
  const child = spawn(wranglerBin, args, {
    cwd: apiDir,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-16_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    output = `${output}\n${error.message}`.slice(-16_000);
  });
  services.push({
    child,
    label: "Worker",
    get output() {
      return output;
    },
  });
  return child;
}

async function waitForHealth(child) {
  // Generous on purpose: a cold `wrangler dev` may trigger `worker-build
  // --release`, which takes well over a minute. A 40 s budget made this probe
  // fail for "the Worker is still compiling", which is not a verdict.
  let lastError = "never attempted";
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `Worker exited (${child.exitCode}): ${redact((services.at(-1)?.output ?? "").slice(-2000))}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok && (await response.json()).status === "ok") return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "connection error";
    }
    await delay(250);
  }
  throw new Error(`Worker did not become healthy: ${redact(lastError)}`);
}

async function setupInfrastructure() {
  if (baseUrl) {
    console.log(`Using an external Worker at ${baseUrl}; D1-dependent cases are skipped.`);
    return;
  }
  if (process.env.P02_PASSKEY_PERSIST_TO) {
    persistDir = path.resolve(process.env.P02_PASSKEY_PERSIST_TO);
    await mkdir(persistDir, { recursive: true });
  } else {
    persistDir = await mkdtemp(path.join(os.tmpdir(), "lumi-p02-passkey-"));
    ownsPersistDir = true;
  }
  const port = process.env.P02_PASSKEY_PORT
    ? Number(process.env.P02_PASSKEY_PORT)
    : await availablePort();
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`P02_PASSKEY_PORT is invalid: ${process.env.P02_PASSKEY_PORT}`);
  }
  baseUrl = `http://127.0.0.1:${port}`;

  await runWrangler(
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--env",
      "development",
      "--persist-to",
      persistDir,
    ],
    "passkey smoke fresh D1 migration",
  );
  pass("fresh D1 applies every migration");

  worker = startWorker(port);
  await waitForHealth(worker);
  pass("development Worker is healthy", baseUrl);
}

function stopAll() {
  for (const service of services) {
    try {
      if (process.platform === "win32") service.child.kill();
      else process.kill(-service.child.pid, "SIGKILL");
    } catch {
      try {
        service.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * One SELECT, parsed out of `wrangler d1 execute --json`.
 *
 * The existing D1 helpers in this file were written for the ceremony tables, and every
 * read-back added for V01 wanted a plain count or a single column. Rather than grow three
 * near-identical parsers, this is the one shape those reads need.
 */
async function runWranglerJson(sql, label) {
  const output = await runWrangler(
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--env",
      "development",
      "--persist-to",
      persistDir,
      "--json",
      "--command",
      sql,
    ],
    label,
  );
  for (const open of ["[", "{"]) {
    const start = output.indexOf(open);
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(output.slice(start));
      const statements = Array.isArray(parsed) ? parsed : [parsed];
      return statements.flatMap((statement) =>
        Array.isArray(statement?.results) ? statement.results : [],
      );
    } catch {
      // Whatever that brace belonged to was not the payload. Try the next form.
    }
  }
  fail(`${label}: no JSON in the wrangler output`, redact(output.slice(-400)));
  return [];
}

// --- registration -------------------------------------------------------------

async function probeRegistration() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = createHash("sha256")
    .update(publicKey.export({ format: "jwk" }).x)
    .digest();
  const email = `passkey-${Date.now()}@example.test`;
  const jar = new Jar();

  const started = await call(jar, "POST", "/api/v1/auth/passkey/signup/start", {
    email,
    display_name: "Passkey Smoke",
  });
  if (
    !expect(
      "registration ceremony start returns server-generated options",
      started.status === 201,
      `status=${started.status} ${redact(started.raw)}`,
    )
  ) {
    return null;
  }
  const ceremonyId = started.body.ceremony_id;
  const options = started.body.public_key;
  expect(
    "the ceremony is server-issued and challenge-bound",
    typeof ceremonyId === "string" &&
      ceremonyId.startsWith("cer_") &&
      typeof options?.challenge === "string",
    `ceremony=${String(ceremonyId).slice(0, 12)}… challenge=${typeof options?.challenge}`,
  );
  expect(
    "registration requires user verification and a discoverable credential (F01-004)",
    options?.authenticatorSelection?.userVerification === "required" &&
      options?.authenticatorSelection?.residentKey === "required",
    JSON.stringify(options?.authenticatorSelection),
  );
  expect(
    "registration does not force a platform authenticator (F01-004)",
    options?.authenticatorSelection?.authenticatorAttachment === undefined,
    String(options?.authenticatorSelection?.authenticatorAttachment),
  );
  expect(
    "registration asks for no attestation (F01-004 default policy)",
    options?.attestation === "none",
    String(options?.attestation),
  );

  const buildRegistration = (overrides = {}) => {
    const authData =
      overrides.authData ??
      authenticatorData({
        rpId: overrides.rpId ?? RP_ID,
        credentialId,
        coseKey: coseEs256(publicKey),
        flags: FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT,
      });
    return {
      id: b64url(credentialId),
      raw_id: b64url(credentialId),
      transports: ["internal"],
      attestationObject: b64url(cborAttestationNone(authData)),
      clientDataJSON: b64url(
        clientData({
          type: "webauthn.create",
          challenge: overrides.challenge ?? options.challenge,
          origin: overrides.origin ?? ORIGIN,
        }),
      ),
    };
  };
  const credential = buildRegistration();

  // --- hostile: the ceremony is bound to its own challenge, origin, and RP ----
  const attacks = [
    [
      "a challenge the server never issued is refused",
      buildRegistration({ challenge: b64url(Buffer.alloc(32, 7)) }),
    ],
    [
      "an origin outside the configured allowlist is refused",
      buildRegistration({ origin: "https://evil.example" }),
    ],
    [
      "authenticator data bound to another relying party is refused",
      buildRegistration({ rpId: "evil.example" }),
    ],
    [
      "missing required user verification is refused",
      buildRegistration({
        // Same RP and challenge, but the UV bit is clear.
        authData: authenticatorData({
          rpId: RP_ID,
          credentialId,
          coseKey: coseEs256(publicKey),
          flags: FLAG_UP | FLAG_BE | FLAG_BS | FLAG_AT,
        }),
      }),
    ],
    [
      "a raw_id that does not match the credential id is refused",
      { ...credential, raw_id: b64url(Buffer.alloc(32, 9)) },
    ],
    [
      "a response with no attested credential data is refused",
      buildRegistration({
        authData: authenticatorData({
          rpId: RP_ID,
          credentialId,
          coseKey: coseEs256(publicKey),
          flags: FLAG_UP | FLAG_UV,
        }),
      }),
    ],
  ];
  for (const [label, body] of attacks) {
    const result = await call(jar, "POST", "/api/v1/auth/passkey/signup/complete", {
      ceremony_id: ceremonyId,
      credential: body,
    });
    expect(label, refusedWithReason(result), `status=${result.status} reason=${reasonOf(result)}`);
  }

  // A refused attempt records a failure but must not consume the ceremony, so the
  // honest attempt below has to succeed. That is the property under test.
  const completed = await call(jar, "POST", "/api/v1/auth/passkey/signup/complete", {
    ceremony_id: ceremonyId,
    credential,
  });
  if (
    !expect(
      "a correct registration completes and establishes a session",
      completed.status === 200 || completed.status === 201,
      `status=${completed.status} ${redact(completed.raw)}`,
    )
  ) {
    return null;
  }
  expect("registration establishes a real session cookie", jar.cookies.has("lumi_session"));
  expect(
    "the created account is returned unverified, so a verification step is required",
    completed.body?.user?.email_verified === false,
    JSON.stringify(completed.body?.user?.email_verified),
  );
  expect(
    "a verification challenge is issued with the account",
    typeof completed.body?.verification?.challenge_id === "string",
    redact(JSON.stringify(completed.body?.verification?.challenge_id)),
  );

  const replay = await call(jar, "POST", "/api/v1/auth/passkey/signup/complete", {
    ceremony_id: ceremonyId,
    credential,
  });
  expect(
    "a consumed registration ceremony cannot be replayed",
    refusedWithReason(replay),
    `status=${replay.status} reason=${reasonOf(replay)}`,
  );

  // --- hostile: the same authenticator cannot be registered twice -------------
  const secondStart = await call(new Jar(), "POST", "/api/v1/auth/passkey/signup/start", {
    email: `other-${Date.now()}@example.test`,
    display_name: "Passkey Smoke",
  });
  if (secondStart.status === 201) {
    const second = await call(new Jar(), "POST", "/api/v1/auth/passkey/signup/complete", {
      ceremony_id: secondStart.body.ceremony_id,
      credential: {
        ...credential,
        clientDataJSON: b64url(
          clientData({
            type: "webauthn.create",
            challenge: secondStart.body.public_key.challenge,
            origin: ORIGIN,
          }),
        ),
      },
    });
    expect(
      "an already-registered authenticator cannot be enrolled again",
      second.status === 409,
      `status=${second.status} reason=${reasonOf(second)}`,
    );
  } else {
    expect(
      "an already-registered authenticator cannot be enrolled again",
      false,
      `the second ceremony could not start: status=${secondStart.status}`,
    );
  }

  return { privateKey, credentialId, email };
}

// --- authentication -----------------------------------------------------------

async function probeAuthentication(authenticator) {
  const jar = new Jar();
  const started = await call(jar, "POST", "/api/v1/auth/passkey/login/start", {});
  if (
    !expect(
      "discoverable login ceremony start returns server-generated options",
      started.status === 201,
      `status=${started.status} ${redact(started.raw)}`,
    )
  ) {
    return;
  }
  const ceremonyId = started.body.ceremony_id;
  const options = started.body.public_key;
  expect(
    "a discoverable login omits allowCredentials (F01-005)",
    options?.allowCredentials === undefined,
    JSON.stringify(options?.allowCredentials),
  );
  expect(
    "login requires user verification",
    options?.userVerification === "required",
    String(options?.userVerification),
  );

  const assertion = (overrides = {}) => buildAssertion(authenticator, overrides, options.challenge);
  const good = assertion();

  const flipLastByte = (bytes) =>
    Buffer.concat([
      bytes.subarray(0, bytes.length - 1),
      Buffer.from([bytes[bytes.length - 1] ^ 0xff]),
    ]);

  const attacks = [
    [
      "an assertion with a corrupted signature is refused",
      assertion({
        signature: flipLastByte(good.signature ? b64urlToBytes(good.signature) : Buffer.alloc(64)),
      }),
    ],
    [
      "an assertion over a challenge the server never issued is refused",
      assertion({ challenge: b64url(Buffer.alloc(32, 11)) }),
    ],
    [
      "an assertion from an unlisted origin is refused",
      assertion({ origin: "https://evil.example" }),
    ],
    ["an assertion bound to another relying party is refused", assertion({ rpId: "evil.example" })],
    [
      "an assertion naming an unknown credential is refused",
      assertion({ credentialId: createHash("sha256").update("unknown").digest() }),
    ],
    [
      "an assertion claiming a different user handle is refused",
      assertion({ userHandle: "usr_0000000000000000000000000000dead" }),
    ],
    [
      "an assertion missing required user verification is refused",
      assertion({
        authData: authenticatorData({
          rpId: RP_ID,
          credentialId: authenticator.credentialId,
          coseKey: Buffer.alloc(0),
          flags: FLAG_UP | FLAG_BE | FLAG_BS,
          signCount: 1,
        }),
      }),
    ],
  ];
  for (const [label, body] of attacks) {
    const result = await call(jar, "POST", "/api/v1/auth/passkey/login/complete", {
      ceremony_id: ceremonyId,
      credential: body,
    });
    expect(label, refusedWithReason(result), `status=${result.status} reason=${reasonOf(result)}`);
  }

  const completed = await call(jar, "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: ceremonyId,
    credential: good,
  });
  if (
    !expect(
      "a correct assertion signs in with no email and no password",
      completed.status === 200,
      `status=${completed.status} ${redact(completed.raw)}`,
    )
  ) {
    return;
  }
  expect("passkey sign-in establishes a real session", jar.cookies.has("lumi_session"));

  const me = await call(jar, "GET", "/api/v1/me");
  expect(
    "the passkey session resolves /api/v1/me for its own account",
    me.status === 200,
    `status=${me.status} reason=${reasonOf(me)}`,
  );

  // --- hostile: replay, with the sign counter ADVANCED ------------------------
  //
  // This case was silently wrong until V00's mutation campaign ran. Replaying the
  // IDENTICAL assertion -- same sign counter -- is refused with
  // `passkey_counter_regression`, which is a real defence but the WRONG ONE: it
  // is a property of the credential, not of the ceremony. Reusing the counter
  // meant the probe could not distinguish ceremony consumption from counter
  // checking, and a mutation that disabled `ensure_pending` outright still left
  // every check green.
  //
  // A real authenticator increments its signature counter on every assertion, so
  // the honest replay carries `signCount + 1`. Nothing but the ceremony's consumed
  // state can refuse that, which is exactly the invariant F01 FR-F01-010 claims.
  // The refusal reason is asserted explicitly, so a future run that passes for
  // the wrong reason shows up in the output instead of hiding behind a green tally.
  const advanced = assertion({ signCount: 2 });
  const replay = await call(jar, "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: ceremonyId,
    credential: advanced,
  });
  const replayRefused = refusedWithReason(replay);
  expect(
    "a consumed login ceremony cannot be replayed with a fresh sign counter",
    replayRefused,
    `status=${replay.status} reason=${reasonOf(replay)}`,
  );
  if (replayRefused) {
    expect(
      "the replay is refused as a consumed ceremony, not as a stale counter",
      reasonOf(replay) !== "passkey_counter_regression",
      `reason=${reasonOf(replay)} -- if this is passkey_counter_regression the probe is ` +
        "measuring the credential's counter rather than the ceremony's consumed " +
        "state, and the ceremony invariant is UNPROVEN",
    );
  }

  // --- hostile: revocation ends the session ---------------------------------
  const sessions = await call(jar, "GET", "/api/v1/account/sessions");
  const sessionId = sessions.body?.items?.[0]?.session_id;
  if (
    expect(
      "the passkey session is listed in the account session inventory",
      typeof sessionId === "string",
      `sessions=${sessions.body?.items?.length}`,
    )
  ) {
    const revoked = await call(jar, "DELETE", `/api/v1/account/sessions/${sessionId}`);
    expect(
      "the session can be revoked",
      revoked.status === 204 || revoked.status === 200,
      `status=${revoked.status} reason=${reasonOf(revoked)}`,
    );
    const after = await call(jar, "GET", "/api/v1/me");
    expect(
      "a revoked session can no longer authenticate",
      after.status === 401,
      `status=${after.status}`,
    );
  }
}

// --- expiry -------------------------------------------------------------------

// --- revoked credential, and the lockout guard in front of it -------------------
//
// F01 requires that a revoked authenticator can no longer authenticate, and the
// objective for this probe names "unknown/revoked credential" as a required case.
// "Unknown" is covered; "revoked" was not, and it is the more interesting half:
// an unknown credential is refused by not existing, while a revoked one still
// exists and still verifies cryptographically. Only the revocation state can
// refuse it, so the test has to reach that state through the real route.
//
// Revocation is not a bare DELETE. It requires a reauth grant, and the last
// login method is protected so an account cannot be locked out of itself. Both of
// those are properties worth proving on the way to the revocation, because each is
// a way the endpoint could be wrong in the permissive direction.

async function probeRevokedCredential(authenticator) {
  const jar = new Jar();

  // Establish a fresh session first: revocation needs an authenticated, CSRF-
  // carrying caller, and a brand-new Jar is the honest way to be sure the session
  // under test is the one we just proved works.
  const started = await call(jar, "POST", "/api/v1/auth/passkey/login/start", {});
  if (started.status !== 201) {
    fail("the revocation probe could not start a ceremony", `status=${started.status}`);
    return;
  }
  const signed = await call(jar, "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: started.body.ceremony_id,
    credential: buildAssertion(authenticator, { signCount: 3 }, started.body.public_key.challenge),
  });
  if (signed.status !== 200) {
    fail(
      "the revocation probe could not sign in",
      `status=${signed.status} reason=${reasonOf(signed)}`,
    );
    return;
  }

  const listed = await call(jar, "GET", "/api/v1/account/passkeys");
  const credential = listed.body?.items?.find((item) => item.passkey_id);
  if (
    !expect(
      "the registered passkey appears in the account's credential inventory",
      Boolean(credential),
      `items=${listed.body?.items?.length}`,
    )
  ) {
    return;
  }
  const passkeyId = credential.passkey_id;

  // --- revocation requires a reauth grant -------------------------------------
  const noGrant = await call(jar, "DELETE", `/api/v1/account/passkeys/${passkeyId}`, {
    reauth_grant_id: "reauth_00000000000000000000000000000000",
    reauth_token: "0".repeat(64),
  });
  // The reason matters as much as the refusal. `revoke_passkey` evaluates
  // `can_revoke_passkey` BEFORE it consumes the grant, so with one passkey and no
  // password a fabricated grant is refused with 409 `last_login_method_required` --
  // and a bare "was it refused?" check then passes for the WRONG reason, which is
  // the false positive this probe exists to catch elsewhere. The grant-specific
  // refusal is asserted again below, once a password exists and the lockout guard no
  // longer short-circuits.
  expect(
    "the lockout guard answers before the grant is examined, and names itself",
    reasonOf(noGrant) === "last_login_method_required",
    `status=${noGrant.status} reason=${reasonOf(noGrant)}`,
  );

  /**
   * One full reauth cycle: start a ceremony, assert against it, and read the grant
   * that COMPLETE issues.
   *
   * The start response is a `CeremonyStartResponse` -- `ceremony_id`, `expires_at`,
   * `public_key` -- and carries no grant. The grant is minted at completion and
   * returned as `{ grant: { grant_id, token, expires_at } }`. An earlier version of
   * this probe looked for `grant_id` in the START response, found none, and reported
   * "returned no grant", which reads as a product failure and was a harness fault
   * wearing a product label.
   */
  const reauth = async (purpose, signCount) => {
    const start = await call(jar, "POST", "/api/v1/account/reauth/passkey/start", { purpose });
    if (start.status !== 200 && start.status !== 201) {
      return { error: `reauth start status=${start.status} reason=${reasonOf(start)}` };
    }
    const options = start.body?.public_key;
    if (!options?.challenge || !start.body?.ceremony_id) {
      return {
        error: `reauth start returned no ceremony: ${JSON.stringify(start.body).slice(0, 200)}`,
      };
    }
    const complete = await call(jar, "POST", "/api/v1/account/reauth/passkey/complete", {
      ceremony_id: start.body.ceremony_id,
      credential: buildAssertion(authenticator, { signCount }, options.challenge),
    });
    if (complete.status !== 200 && complete.status !== 201) {
      return { error: `reauth complete status=${complete.status} reason=${reasonOf(complete)}` };
    }
    const grant = complete.body?.grant;
    if (!grant?.grant_id || !grant?.token) {
      return {
        error: `reauth complete returned no grant: ${JSON.stringify(complete.body).slice(0, 200)}`,
      };
    }
    return { grantId: grant.grant_id, token: grant.token };
  };

  // --- the last login method is protected -------------------------------------
  const first = await reauth("passkey_management", 11);
  if (first.error) {
    fail("the revocation probe could not obtain a reauth grant", first.error);
    return;
  }
  const locked = await call(jar, "DELETE", `/api/v1/account/passkeys/${passkeyId}`, {
    reauth_grant_id: first.grantId,
    reauth_token: first.token,
  });
  expect(
    "the only login method cannot be revoked, so an account cannot lock itself out",
    locked.status === 409,
    `status=${locked.status} reason=${reasonOf(locked)}`,
  );
  expect(
    "the lockout refusal names the reason a user can act on",
    reasonOf(locked) === "last_login_method_required",
    `reason=${reasonOf(locked)}`,
  );

  // --- a password exists, so the passkey is now removable ----------------------
  // `validate_reauth_purpose` accepts exactly `passkey_management`,
  // `password_change`, and `account_recovery`. A guess of a fourth name --
  // `password_management` -- was correctly refused with 422 `purpose_invalid`,
  // which is a good sign about the server and a sign the probe was reading the
  // contract from imagination.
  const second = await reauth("password_change", 12);
  if (second.error) {
    fail("the revocation probe could not obtain a second reauth grant", second.error);
    return;
  }
  const password = await call(jar, "POST", "/api/v1/account/password", {
    password: PROBE_PASSWORD,
    reauth_grant_id: second.grantId,
    reauth_token: second.token,
  });
  expect(
    "a password can be configured with a reauth grant",
    password.status === 200 || password.status === 201 || password.status === 204,
    `status=${password.status} reason=${reasonOf(password)}`,
  );
  if (password.status >= 400) return;

  // A password now exists, so the lockout guard passes and a fabricated grant is
  // refused by the GRANT check. This is the assertion that actually proves a reauth
  // grant is required, and it is only reachable from here.
  const stillNoGrant = await call(jar, "DELETE", `/api/v1/account/passkeys/${passkeyId}`, {
    reauth_grant_id: "reauth_00000000000000000000000000000000",
    reauth_token: "0".repeat(64),
  });
  expect(
    "a fabricated reauth grant is refused once the lockout guard no longer applies",
    refusedWithReason(stillNoGrant) && reasonOf(stillNoGrant) !== "last_login_method_required",
    `status=${stillNoGrant.status} reason=${reasonOf(stillNoGrant)}`,
  );

  const third = await reauth("passkey_management", 13);
  if (third.error) {
    fail("the revocation probe could not obtain a third reauth grant", third.error);
    return;
  }
  const revoked = await call(jar, "DELETE", `/api/v1/account/passkeys/${passkeyId}`, {
    reauth_grant_id: third.grantId,
    reauth_token: third.token,
  });
  if (
    !expect(
      "a credential can be revoked once another login method exists",
      revoked.status === 200 || revoked.status === 204,
      `status=${revoked.status} reason=${reasonOf(revoked)}`,
    )
  ) {
    return;
  }

  // --- the revoked credential must no longer authenticate ---------------------
  //
  // The assertion is cryptographically VALID: same key, correct challenge, correct
  // origin, advanced sign counter. The only thing that can refuse it is the
  // revocation state, which is what makes this the revoked-credential case rather
  // than a repeat of the unknown-credential case.
  const afterStart = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/start", {});
  const afterComplete = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: afterStart.body?.ceremony_id,
    credential: buildAssertion(
      authenticator,
      { signCount: 2000 },
      afterStart.body?.public_key?.challenge,
    ),
  });
  expect(
    "a REVOKED credential cannot authenticate, even with a valid signature",
    afterComplete.status >= 400,
    `status=${afterComplete.status} reason=${reasonOf(afterComplete)}`,
  );
  expect(
    "the refusal is not a signature failure, so it is the revocation that refused it",
    reasonOf(afterComplete) !== "passkey_signature_invalid",
    `reason=${reasonOf(afterComplete)} -- passkey_signature_invalid would mean the probe ` +
      "built a bad assertion and proved nothing about revocation",
  );

  // Handed to the identity-substitution probe, which cannot use the passkey this one
  // just revoked and must therefore sign in with the password configured above.
  return { email: authenticator.email, password: PROBE_PASSWORD };
}

// --- client-supplied identity is never authority -------------------------------
//
// The objective names `user_id` substitution as a required case. The property is:
// a client cannot assert who it is. Two halves, both falsifiable:
//
//   1. No header changes the identity the session resolves to. `/api/v1/me` is
//      derived from the session row, so sending identity-asserting headers with a
//      fabricated principal must return the same user.
//   2. `x-org-id` IS a header the server reads -- as a mismatch guard in
//      `authorize_org` -- so disagreeing with the path is a real, observable
//      behaviour rather than a header nobody reads. A test that sends a header the
//      server ignores would pass by construction and prove nothing.

async function probeIdentitySubstitution(identity) {
  const jar = new Jar();
  // Signs in with the PASSWORD the revocation probe configured, not with the passkey.
  // Two reasons, and the second is the important one:
  //
  //   1. By this point the passkey has been revoked -- deliberately, by the previous
  //      probe -- so a passkey sign-in here would fail and this probe would report a
  //      harness fault where the product was behaving exactly as specified.
  //   2. The probes must not depend on each other's side effects. A verifier that only
  //      works because of what an earlier stage left behind is testing the earlier
  //      stage as much as the claim.
  const signed = await call(jar, "POST", "/api/v1/auth/password/login", {
    email: identity.email,
    password: identity.password,
  });
  if (signed.status !== 200) {
    fail(
      "the identity-substitution probe could not sign in",
      `status=${signed.status} reason=${reasonOf(signed)}`,
    );
    return;
  }
  const baseline = await call(jar, "GET", "/api/v1/me");
  const me = baseline.body?.user;
  if (
    !expect(
      "the passkey session resolves an identity to start from",
      baseline.status === 200 && typeof me?.id === "string",
      `status=${baseline.status}`,
    )
  ) {
    return;
  }

  const impostor = "usr_0000000000000000000000000000dead";
  const headers = {
    "X-User-ID": impostor,
    "X-Actor-ID": impostor,
    "X-Principal-ID": impostor,
    "X-Sub": impostor,
  };
  const spoofed = await call(jar, "GET", "/api/v1/me", undefined, headers);
  expect(
    "identity-asserting headers do not change who the session is",
    spoofed.status === 200 && spoofed.body?.user?.id === me.id,
    `asked as ${impostor}, resolved as ${spoofed.body?.user?.id} (real ${me.id})`,
  );
  expect(
    "no identity-asserting header widens the session's organizations",
    Array.isArray(spoofed.body?.organizations) &&
      spoofed.body.organizations.length === baseline.body.organizations.length,
    `before=${baseline.body?.organizations?.length} after=${spoofed.body?.organizations?.length}`,
  );

  // A fabricated org on a real, read-only, org-scoped route. The mismatch guard
  // in `authorize_org` fires before any lookup, so this must be refused rather than
  // answered -- and refused for a reason that names the mismatch.
  const fabricated = await call(
    jar,
    "GET",
    "/api/v1/orgs/org_0000000000000000000000000000dead/settings/data",
    undefined,
    { "X-Org-ID": "org_0000000000000000000000000000dead" },
  );
  expect(
    "a client-asserted organization the session does not belong to is refused",
    fabricated.status === 403 || fabricated.status === 404,
    `status=${fabricated.status} reason=${reasonOf(fabricated)}`,
  );
  expect(
    "the organization context mismatch is named, not reported as a bare denial",
    reasonOf(fabricated) === "org_context_mismatch" ||
      reasonOf(fabricated) === "organization_not_accessible" ||
      reasonOf(fabricated) === "not_found",
    `reason=${reasonOf(fabricated)}`,
  );
}

async function probeExpiredCeremony() {
  const jar = new Jar();
  const started = await call(jar, "POST", "/api/v1/auth/passkey/login/start", {});
  if (started.status !== 201) {
    fail("the expiry probe could not start a ceremony", `status=${started.status}`);
    return;
  }
  const ceremonyId = started.body.ceremony_id;
  if (!(await expireCeremonyInD1(ceremonyId))) {
    console.log("SKIP  expired-ceremony case (no D1 access in external-worker mode)");
    return;
  }
  // The credential material below is irrelevant: expiry must be decided before
  // any verification is attempted, so a refusal is the proof.
  const result = await call(jar, "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: ceremonyId,
    credential: {
      id: b64url(Buffer.alloc(32, 5)),
      raw_id: b64url(Buffer.alloc(32, 5)),
      authenticatorData: b64url(Buffer.alloc(37)),
      signature: b64url(Buffer.alloc(64)),
      clientDataJSON: b64url(Buffer.from("{}")),
    },
  });
  expect(
    "an expired ceremony is refused with a stable reason",
    refusedWithReason(result),
    `status=${result.status} reason=${reasonOf(result)}`,
  );
}

async function expireCeremonyInD1(ceremonyId) {
  if (!persistDir) return false;
  const outcome = await new Promise((resolve) => {
    const child = spawn(
      wranglerBin,
      [
        "d1",
        "execute",
        "DB",
        "--local",
        "--env",
        "development",
        "--persist-to",
        persistDir,
        "--command",
        `UPDATE webauthn_ceremonies SET expires_at = '2000-01-01T00:00:00.000Z' WHERE ceremony_id = '${ceremonyId}';`,
      ],
      { cwd: apiDir, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("close", (code) => resolve({ code, text }));
  });
  if (outcome.code !== 0) {
    console.log(`SKIP  could not expire a ceremony in D1: ${redact(outcome.text.slice(-400))}`);
    return false;
  }
  return true;
}

// --- ceremony kind ---------------------------------------------------------------
// The family requires "wrong ceremony kind". The probe had zero mentions of it.
//
// A ceremony id is a bearer token for a *kind* of ceremony, and `ensure_pending` compares
// the stored kind against the kind the completing route expects. The attack is the obvious
// one, and it is the important one: a ceremony id minted for a LOGIN is presented at the
// SIGNUP endpoint. If the kind is not checked there, a token that is only valid for
// proving possession of a credential becomes one that is valid for creating an account --
// and the request already carries a correctly signed credential, because the attacker
// made it.
//
// Each direction is paired with a control that uses the *same kind of payload* against the
// *correct* kind of ceremony. Without the control, a refusal could be the payload being
// wrong, and the section would report a product defence it never tested.

/** A fresh software authenticator, for the control that must succeed. */
function newAuthenticator(label) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = createHash("sha256")
    .update(`${label}-${Date.now()}-${Math.random()}`)
    .digest();
  return { privateKey, credentialId, coseKey: coseEs256(publicKey) };
}

/** A `RegistrationResponse`, exactly as the registration section builds it. */
function buildRegistration(ceremony, auth) {
  const authData = authenticatorData({
    rpId: RP_ID,
    credentialId: auth.credentialId,
    coseKey: auth.coseKey,
    flags: FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT,
  });
  const client = clientData({
    type: "webauthn.create",
    // The ceremony's challenge lives at `body.public_key.challenge`; `body.challenge`
    // is not where it is, and an undefined challenge produces a clientDataJSON that does
    // not match the ceremony -- which reads as a credential rejection.
    challenge: ceremony?.public_key?.challenge,
    origin: ORIGIN,
  });
  return {
    id: b64url(auth.credentialId),
    raw_id: b64url(auth.credentialId),
    transports: ["internal"],
    attestationObject: b64url(cborAttestationNone(authData)),
    clientDataJSON: b64url(client),
  };
}

async function probeCeremonyKind() {
  // --- control: the payload and the flow are correct -------------------------
  // Established FIRST, so that every refusal below is known to be about the kind rather
  // than about a malformed request. If this control does not hold, the section cannot
  // distinguish the two and says so instead of guessing.
  const controlAuth = newAuthenticator("kind-control");
  const controlEmail = `kind-control-${Date.now().toString(36)}@example.test`;
  const controlStart = await call(new Jar(), "POST", "/api/v1/auth/passkey/signup/start", {
    email: controlEmail,
    display_name: "Kind Control",
  });
  const controlId = controlStart.body?.ceremony_id;
  if (
    !expect(
      "a signup ceremony starts, so there is a kind to misuse",
      controlStart.status >= 200 && controlStart.status < 300 && typeof controlId === "string",
      `status=${controlStart.status} ceremony=${controlId ?? "none"} reason=${reasonOf(controlStart)}`,
    )
  ) {
    return;
  }
  const controlComplete = await call(new Jar(), "POST", "/api/v1/auth/passkey/signup/complete", {
    ceremony_id: controlId,
    credential: buildRegistration(controlStart.body, controlAuth),
  });
  const controlHolds = controlComplete.status >= 200 && controlComplete.status < 300;
  expect(
    "CONTROL: a signup ceremony completes with a registration payload, so the flow and the payload are both sound",
    controlHolds,
    `status=${controlComplete.status} reason=${reasonOf(controlComplete)}`,
  );
  if (!controlHolds) {
    expect(
      "the wrong-kind attacks below are not run, because a refusal could not be attributed to the kind",
      false,
      "the control did not hold",
    );
    return;
  }

  // --- attack 1: a LOGIN ceremony presented at the SIGNUP endpoint -------------
  // The body is empty on purpose: `passkey_login_start` takes `EmptyRequest` with
  // `deny_unknown_fields`, so a login ceremony names no account at all. That makes the
  // attack cleaner than it first looked -- the token is not account-bound, so it is not
  // even specific enough to be replayed against a particular user, and the only thing
  // standing between it and account creation is the kind check.
  const loginAuth = newAuthenticator("kind-login");
  const loginStart = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/start", {});
  const loginCeremonyId = loginStart.body?.ceremony_id;
  if (
    !expect(
      "a login ceremony starts, so a login ceremony id exists to misuse",
      typeof loginCeremonyId === "string",
      `status=${loginStart.status} ceremony=${loginCeremonyId ?? "none"}`,
    )
  ) {
    return;
  }

  const passkeysBeforeRows = await runWranglerJson(
    "SELECT COUNT(*) AS n FROM passkey_credentials",
    "count passkey credentials before the wrong-kind attempt",
  );
  const passkeysBefore = Number(passkeysBeforeRows[0]?.n ?? -1);

  const loginAtSignup = await call(new Jar(), "POST", "/api/v1/auth/passkey/signup/complete", {
    ceremony_id: loginCeremonyId,
    credential: buildRegistration(loginStart.body, loginAuth),
  });
  expect(
    "a LOGIN ceremony id is refused at the SIGNUP endpoint, so a sign-in token cannot create an account",
    refusedWithReason(loginAtSignup),
    `status=${loginAtSignup.status} reason=${reasonOf(loginAtSignup)}`,
  );

  // A login ceremony names no account, so "no user with this email" is not even a
  // question worth asking. The durable part of the damage would be an ENROLLED passkey, so
  // that is what is checked -- against a baseline taken immediately before the attempt.
  // The probe's own registration section has already created a credential by now, so an
  // assumed count would make the assertion true or false for the wrong reason.
  const passkeysAfter = await runWranglerJson(
    "SELECT COUNT(*) AS n FROM passkey_credentials",
    "count passkey credentials after the wrong-kind signup",
  );
  expect(
    "the refused wrong-kind signup added no credential, so a registration token cannot enrol a passkey",
    Number(passkeysAfter[0]?.n ?? -1) === passkeysBefore,
    `passkey_credentials ${passkeysBefore} -> ${passkeysAfter[0]?.n ?? "unknown"}`,
  );

  // --- attack 2: a SIGNUP ceremony presented at the LOGIN endpoint -------------
  // The same kind of mistake from the other side. An assertion signed by a real key, at
  // a route that expects an assertion, against a ceremony that is not a login ceremony.
  const otherAuth = newAuthenticator("kind-signup");
  const otherEmail = `kind-signup-${Date.now().toString(36)}@example.test`;
  const otherStart = await call(new Jar(), "POST", "/api/v1/auth/passkey/signup/start", {
    email: otherEmail,
    display_name: "Kind Signup",
  });
  const otherCeremonyId = otherStart.body?.ceremony_id;
  if (typeof otherCeremonyId !== "string") {
    expect(
      "a second signup ceremony starts, for the reverse direction",
      false,
      `status=${otherStart.status} reason=${reasonOf(otherStart)}`,
    );
    return;
  }

  const signupAtLogin = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: otherCeremonyId,
    credential: buildAssertion(otherAuth, {}, otherStart.body?.public_key?.challenge),
  });
  expect(
    "a SIGNUP ceremony id is refused at the LOGIN endpoint, so a registration token cannot authenticate a session",
    refusedWithReason(signupAtLogin),
    `status=${signupAtLogin.status} reason=${reasonOf(signupAtLogin)}`,
  );
}

// --- identity-link conflict -------------------------------------------------------
// The family requires "identity-link conflict" and the probe had zero mentions of it.
//
// The surface is `POST /api/v1/me/identities/link`: a verified user claiming another
// email address. The claim that matters is not the status code -- it is whether claiming
// someone else's address links the caller's session to that person's identity, or silently
// attaches an authenticator to the other account. Both are read back from D1.

async function probeIdentityLinkConflict(identity) {
  // A second, real, verified user whose email is the one Mallory will try to claim.
  const victim = `victim-${Date.now().toString(36)}@example.test`;
  const victimJar = new Jar();
  const victimPassword = "victim-password-long-enough-1234";
  const victimSignup = await call(victimJar, "POST", "/api/v1/auth/password/signup", {
    email: victim,
    display_name: "Link Victim",
    password: victimPassword,
  });
  // `POST /auth/signup` answers with a verification challenge; `verify-email` takes
  // `{ challenge_id, code }` and not `{ email, code }`. The first version of this section
  // guessed both and the victim simply never became verified, so the read-back it asserted
  // afterwards was asserting nothing.
  const verification = await call(victimJar, "POST", "/api/v1/auth/verify-email", {
    challenge_id: victimSignup.body?.verification?.challenge_id ?? victimSignup.body?.challenge_id,
    code: victimSignup.body?.verification?.development_code ?? victimSignup.body?.development_code,
  });
  expect(
    "the second identity is verified, so it is a real account and not a pending shell",
    verification.status === 200,
    `signup=${victimSignup.status} verify=${verification.status} reason=${reasonOf(verification)}`,
  );
  await call(victimJar, "POST", "/api/v1/auth/password/login", {
    email: victim,
    password: victimPassword,
  });
  const victimBefore = await call(victimJar, "GET", "/api/v1/me");
  const victimId = victimBefore.body?.user?.id;
  if (
    !expect(
      "a second verified identity exists to be attacked",
      victimBefore.status === 200 && typeof victimId === "string",
      `status=${victimBefore.status} id=${victimId ?? "none"}`,
    )
  ) {
    return;
  }
  const victimIdentitiesBefore = await runWranglerJson(
    `SELECT COUNT(*) AS n FROM identities WHERE user_id = '${victimId}'`,
    "count the victim's identities before the link attempt",
  );

  // The attacker: a verified user of their own, attempting to claim the victim's address.
  const jar = new Jar();
  const signed = await call(jar, "POST", "/api/v1/auth/password/login", {
    email: identity.email,
    password: identity.password,
  });
  if (signed.status !== 200) {
    fail(
      "the identity-link probe could not sign in",
      `status=${signed.status} reason=${reasonOf(signed)}`,
    );
    return;
  }
  const me = (await call(jar, "GET", "/api/v1/me")).body?.user;
  if (!expect("the link attacker has a session", typeof me?.id === "string", `id=${me?.id}`)) {
    return;
  }

  // --- the CHALLENGE, not the email ------------------------------------------
  //
  // A first version of this section claimed to attack the "identity-link conflict" and
  // posted a dummy challenge, then read the `403 identity_conflict` as proof. It is not
  // proof of that at all. `link_identity` uses the same reason code for two different
  // things, and the one that fires for a bad challenge is:
  //
  //     "identity_conflict", "The identity link challenge is invalid or expired."
  //
  // The EMAIL conflict -- "That identity is already linked to an account." -- lives in
  // `link_identity_start`, and that route cannot be reached: it requires a reauth grant
  // with purpose `identity_link`, and `validate_reauth_purpose` allows only
  // `passkey_management`, `password_change` and `account_recovery`. No such grant can be
  // minted. So the email-conflict guard is unreachable code, and FR-F01-012's MUST NOT is
  // enforced by a check that cannot run. V01-005.
  //
  // What IS reachable, and is a real attack the family did not name, is the challenge
  // itself: `link_identity` checks the challenge's kind AND that it belongs to the caller.
  // A challenge minted for one user must not complete a link for another.
  const link = await call(jar, "POST", "/api/v1/me/identities/link", {
    challenge_id: "idn_unused",
    code: "unused",
  });
  expect(
    "a link attempt with no valid challenge is refused",
    link.status >= 400,
    `status=${link.status} reason=${reasonOf(link)}`,
  );

  // The precondition, asserted rather than assumed, so the scope of what this section can
  // reach is visible in the output instead of only in a comment.
  const reauthPurpose = await call(jar, "POST", "/api/v1/account/reauth/password", {
    purpose: "identity_link",
    password: identity.password,
  });
  expect(
    "a reauth grant for purpose `identity_link` cannot be minted, so the EMAIL-conflict guard is unreachable and its claim is UNPROVEN rather than proven",
    reauthPurpose.status >= 400,
    `status=${reauthPurpose.status} reason=${reasonOf(reauthPurpose)}`,
  );

  // And the precondition, asserted rather than assumed, so the scope of the claim above
  // is visible in the output rather than only in a comment.

  // The load-bearing read-back: the victim must be untouched, and the attacker must not
  // have gained a path to them. A 4xx from a missing-parameter check says nothing about
  // what happens when the parameters are real.
  const victimAfter = await call(victimJar, "GET", "/api/v1/me");
  expect(
    "the victim's session still resolves to the victim after the link attempt",
    victimAfter.status === 200 && victimAfter.body?.user?.id === victimId,
    `resolved as ${victimAfter.body?.user?.id} (real ${victimId})`,
  );
  const victimIdentitiesAfter = await runWranglerJson(
    `SELECT COUNT(*) AS n FROM identities WHERE user_id = '${victimId}'`,
    "count the victim's identities after the link attempt",
  );
  expect(
    "no identity was attached to the victim by the attacker's link attempt",
    Number(victimIdentitiesAfter[0]?.n ?? 0) === Number(victimIdentitiesBefore[0]?.n ?? 0),
    `${victimIdentitiesBefore[0]?.n} -> ${victimIdentitiesAfter[0]?.n}`,
  );
}

// --- recovery with active sessions -------------------------------------------------
// The family requires "recovery with active sessions". The probe had one mention of
// "recovery" and it was about last-login-method removal, which is a different thing.
//
// The claim: completing a password recovery invalidates the sessions that existed before
// it. If it does not, then compromising one session is enough to outlive a user's
// password change -- the change becomes advisory, which is the specific thing a user is
// doing it to prevent.

async function probeRecoveryWithActiveSessions(authenticator) {
  const email = `recovery-${Date.now().toString(36)}@example.test`;
  const password = "recovery-password-long-enough-1";
  const victimJar = new Jar();

  const signup = await call(victimJar, "POST", "/api/v1/auth/password/signup", {
    email,
    display_name: "Recovery Subject",
    password,
  });
  const userId = signup.body?.user?.id;
  if (!expect("the recovery subject signs up", typeof userId === "string", `id=${userId}`)) {
    return;
  }
  await call(victimJar, "POST", "/api/v1/auth/verify-email", {
    challenge_id: signup.body?.verification?.challenge_id ?? signup.body?.challenge_id,
    code: signup.body?.verification?.development_code ?? signup.body?.development_code,
  });

  // A SECOND, already-authenticated session, held by "the attacker". This is the
  // session the recovery must terminate. It is a real session on a real account.
  const attackerJar = new Jar();
  const attackerLogin = await call(attackerJar, "POST", "/api/v1/auth/password/login", {
    email,
    password,
  });
  const attackerSessionBefore = await call(attackerJar, "GET", "/api/v1/me");
  if (
    !expect(
      "a second session is established before the recovery, so there is something to terminate",
      attackerSessionBefore.status === 200 && attackerSessionBefore.body?.user?.id === userId,
      `status=${attackerSessionBefore.status}`,
    )
  ) {
    return;
  }

  // The owner recovers: forgot, then reset with a NEW password.
  const forgot = await call(victimJar, "POST", "/api/v1/auth/password/forgot", { email });
  expect(
    "a recovery can be started for the account",
    forgot.status >= 200 && forgot.status < 300,
    `status=${forgot.status} reason=${reasonOf(forgot)}`,
  );
  // `password/forgot` answers `{ challenge_id, expires_at, development_code }` and
  // `password/reset` takes `{ challenge_id, code, password }`. There is no `token` field
  // on either. Reading one is not a small slip: the reset is then refused, and every
  // assertion after it measures a session that was never revoked -- which reads exactly
  // like a serious authentication defect and is entirely a probe bug.
  const recoveryChallengeId = forgot.body?.challenge_id;
  const recoveryCode = forgot.body?.development_code;
  if (
    !expect(
      "the recovery challenge and code are available to finish the ceremony",
      typeof recoveryChallengeId === "string" && typeof recoveryCode === "string",
      `challenge=${recoveryChallengeId ?? "none"} code=${recoveryCode ? "present" : "none"} body=${redact(JSON.stringify(forgot.body).slice(0, 200))}`,
    )
  ) {
    return;
  }

  const resetBody = {
    challenge_id: recoveryChallengeId,
    code: recoveryCode,
    password: "recovered-password-long-enough-2",
  };
  const reset = await call(victimJar, "POST", "/api/v1/auth/password/reset", resetBody);
  if (
    !expect(
      "the recovery completes and the password is replaced",
      reset.status >= 200 && reset.status < 300,
      `status=${reset.status} reason=${reasonOf(reset)} sent=${redact(JSON.stringify({ ...resetBody, code: "present" }))} body=${redact(JSON.stringify(reset.body).slice(0, 220))}`,
    )
  ) {
    // Everything below asserts the CONSEQUENCE of the reset. Without it they would report
    // that the old session and the old password still work, which is true and means
    // nothing: nothing was changed, so nothing was revoked.
    expect(
      "the session and password checks below are not run, because the recovery did not complete",
      false,
      "skipped after a refused reset",
    );
    return;
  }

  // --- hostile: REPLAY the completed recovery (V04-009) ---------------------------------
  //
  // `smoke:passkey` proved replay for registration and for login. Recovery had no such case, and the
  // reason was structural rather than an oversight in the probe: `ensure_pending` -- the shared
  // route-level guard -- is called for PasskeySignup, PasskeyLogin, PasskeyAdd and Reauthenticate, and
  // for NONE of recovery. Recovery therefore has ONE defence, `consume_recovery`'s compare-and-set,
  // where its four siblings have two. That makes this the cheapest possible replay probe to give
  // teeth to, and it is also the most valuable: recovery is the ceremony that changes a password.
  //
  // The refusal reason CANNOT be used to prove which defence fired. `consume_recovery` returning false
  // yields `generic_recovery_failure`, whose reason is the deliberately undifferentiated
  // `recovery_invalid` -- correct, since distinguishing "already consumed" from "never existed" would
  // be an oracle, but it means a green status proves nothing on its own.
  //
  // So the assertions are on STORED EFFECT. The replay carries a DIFFERENT new password: if the
  // compare-and-set were removed the replay would succeed and the account's password would change,
  // which the two follow-up logins below would see. A refusal asserted only by status would pass on a
  // product that accepted the replay and then failed for an unrelated reason.
  const replayPassword = "replayed-password-long-enough-3";
  const replay = await call(victimJar, "POST", "/api/v1/auth/password/reset", {
    challenge_id: recoveryChallengeId,
    code: recoveryCode,
    password: replayPassword,
  });
  expect(
    "a consumed recovery ceremony cannot be replayed with the same challenge and code",
    replay.status >= 400,
    `status=${replay.status} reason=${reasonOf(replay)}`,
  );
  expect(
    "and the replay is refused as `recovery_invalid` -- the same undifferentiated answer a wrong code " +
      "gets, so consuming a ceremony is not distinguishable from never having started one",
    reasonOf(replay) === "recovery_invalid",
    `reason=${reasonOf(replay) ?? "none"}`,
  );
  const recoveredStillWorks = await call(new Jar(), "POST", "/api/v1/auth/password/login", {
    email,
    password: "recovered-password-long-enough-2",
  });
  expect(
    "and the password set by the ORIGINAL recovery still authenticates, so the replay changed nothing",
    recoveredStillWorks.status === 200,
    `status=${recoveredStillWorks.status}`,
  );
  const replayDidNotTake = await call(new Jar(), "POST", "/api/v1/auth/password/login", {
    email,
    password: replayPassword,
  });
  expect(
    "and the password carried by the replay does NOT authenticate -- the state assertion that a " +
      "removed compare-and-set would fail, since accepting the replay would have set exactly this",
    replayDidNotTake.status >= 400,
    `status=${replayDidNotTake.status}`,
  );

  // The claim. The pre-recovery session must be dead.
  const attackerSessionAfter = await call(attackerJar, "GET", "/api/v1/me");
  expect(
    "a session established before the recovery no longer authenticates afterwards",
    attackerSessionAfter.status === 401 || attackerSessionAfter.status === 403,
    `status=${attackerSessionAfter.status} resolved=${attackerSessionAfter.body?.user?.id ?? "nobody"}`,
  );

  // And the old password is genuinely dead, so the recovery was a change and not a
  // second password. Without this the session revocation could be an artefact of the
  // session table being cleared for unrelated reasons.
  const oldPassword = await call(new Jar(), "POST", "/api/v1/auth/password/login", {
    email,
    password,
  });
  expect(
    "the pre-recovery password no longer authenticates",
    oldPassword.status >= 400,
    `status=${oldPassword.status}`,
  );

  const newPassword = await call(new Jar(), "POST", "/api/v1/auth/password/login", {
    email,
    password: "recovered-password-long-enough-2",
  });
  expect(
    "the new password does authenticate, so the recovery took effect",
    newPassword.status === 200,
    `status=${newPassword.status}`,
  );
}

// --- V05: the two ceremony kinds the replay closure did not cover --------------
//
// Replay is proven above for signup, login, and recovery. `PasskeyAdd` and
// `Reauthenticate` complete through the same `ensure_pending` +
// `consume_ceremony` guards, but "same code path" is an inference, and this
// suite exists so the attack is run rather than inherited. Both ceremonies are
// driven end to end first, because a consumed-ceremony refusal is only
// meaningful if completing the ceremony really did its job: the step-up minted
// a grant that starts a passkey-add, and the second passkey reached the
// inventory. The reauth replay carries an ADVANCED sign counter so a counter
// refusal can never stand in for the consumed-ceremony refusal — the same
// isolation the login replay above uses.

async function probeAddAndReauthReplay() {
  const auth = newAuthenticator("v05-primary");
  const email = `add-reauth-${Date.now().toString(36)}@example.test`;
  const jar = new Jar();

  const signup = await call(jar, "POST", "/api/v1/auth/passkey/signup/start", {
    email,
    display_name: "V05 Add Reauth",
  });
  if (
    !expect(
      "the add/reauth replay probe starts from a fresh signup ceremony",
      signup.status === 201,
      `status=${signup.status} reason=${reasonOf(signup)}`,
    )
  ) {
    return;
  }
  const signedUp = await call(jar, "POST", "/api/v1/auth/passkey/signup/complete", {
    ceremony_id: signup.body.ceremony_id,
    credential: buildRegistration(signup.body, auth),
  });
  if (
    !expect(
      "CONTROL: the fresh identity completes signup, so refusals below are about ceremony state",
      signedUp.status >= 200 && signedUp.status < 300,
      `status=${signedUp.status} reason=${reasonOf(signedUp)}`,
    )
  ) {
    return;
  }

  // --- Reauthenticate: complete, use the grant, then replay --------------------
  const reauthStart = await call(jar, "POST", "/api/v1/account/reauth/passkey/start", {
    purpose: "passkey_management",
  });
  if (
    !expect(
      "a passkey step-up ceremony starts for a session holding a passkey",
      reauthStart.status === 201 && typeof reauthStart.body?.ceremony_id === "string",
      `status=${reauthStart.status} reason=${reasonOf(reauthStart)}`,
    )
  ) {
    return;
  }
  const reauthComplete = await call(jar, "POST", "/api/v1/account/reauth/passkey/complete", {
    ceremony_id: reauthStart.body.ceremony_id,
    credential: buildAssertion(auth, { signCount: 5 }, reauthStart.body.public_key.challenge),
  });
  const grant = reauthComplete.body?.grant;
  if (
    !expect(
      "CONTROL: the step-up completes and mints a usable grant",
      reauthComplete.status >= 200 &&
        reauthComplete.status < 300 &&
        typeof grant?.grant_id === "string" &&
        typeof grant?.token === "string",
      `status=${reauthComplete.status} reason=${reasonOf(reauthComplete)}`,
    )
  ) {
    return;
  }
  const replayReauth = await call(jar, "POST", "/api/v1/account/reauth/passkey/complete", {
    ceremony_id: reauthStart.body.ceremony_id,
    // An ADVANCED counter: a refusal naming the counter instead of the consumed
    // ceremony would mean the replay was stopped by the wrong defence, which is
    // a different invariant.
    credential: buildAssertion(auth, { signCount: 6 }, reauthStart.body.public_key.challenge),
  });
  expect(
    "a consumed REAUTHENTICATE ceremony cannot be replayed",
    replayReauth.status === 401 && reasonOf(replayReauth) === "ceremony_invalid",
    `status=${replayReauth.status} reason=${reasonOf(replayReauth)}`,
  );

  // --- PasskeyAdd: complete, verify the credential landed, then replay ---------
  const addStart = await call(jar, "POST", "/api/v1/account/passkeys/register/start", {
    label: "V05 second",
    reauth_grant_id: grant.grant_id,
    reauth_token: grant.token,
  });
  if (
    !expect(
      "CONTROL: the step-up grant starts a passkey-add ceremony",
      addStart.status === 201,
      `status=${addStart.status} reason=${reasonOf(addStart)}`,
    )
  ) {
    return;
  }
  const secondAuth = newAuthenticator("v05-second");
  const addComplete = await call(jar, "POST", "/api/v1/account/passkeys/register/complete", {
    ceremony_id: addStart.body.ceremony_id,
    credential: buildRegistration(addStart.body, secondAuth),
  });
  if (
    !expect(
      "CONTROL: the second passkey completes registration",
      addComplete.status >= 200 && addComplete.status < 300,
      `status=${addComplete.status} reason=${reasonOf(addComplete)}`,
    )
  ) {
    return;
  }
  const inventory = await call(jar, "GET", "/api/v1/account/passkeys");
  expect(
    "CONTROL: the added credential is in the inventory, so the add really happened",
    (inventory.body?.items?.length ?? 0) >= 2,
    `items=${inventory.body?.items?.length}`,
  );
  const replayAdd = await call(jar, "POST", "/api/v1/account/passkeys/register/complete", {
    ceremony_id: addStart.body.ceremony_id,
    credential: buildRegistration(addStart.body, secondAuth),
  });
  expect(
    "a consumed PASSKEY-ADD ceremony cannot be replayed",
    replayAdd.status === 401 && reasonOf(replayAdd) === "ceremony_invalid",
    `status=${replayAdd.status} reason=${reasonOf(replayAdd)} -- credential_conflict would mean the ` +
      "replay reached the duplicate-credential check, i.e. the consumed-state guard did not refuse it",
  );

  // --- the signature counter is enforced at the stored boundary ----------------
  // The server stored counter 5 from the step-up control above (the replay was
  // refused before anything could move it). An assertion signing counter 5 on a
  // FRESH login ceremony must be refused for the counter, and counter 6 must be
  // accepted: together they locate the enforced boundary at the stored value
  // without reading the database, so the case is self-proving on both sides.
  const staleStart = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/start", {});
  const stale = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: staleStart.body?.ceremony_id,
    credential: buildAssertion(auth, { signCount: 5 }, staleStart.body?.public_key?.challenge),
  });
  expect(
    "an assertion repeating the stored sign counter is refused as a counter regression",
    stale.status === 401 && reasonOf(stale) === "passkey_counter_regression",
    `status=${stale.status} reason=${reasonOf(stale)}`,
  );
  const freshStart = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/start", {});
  const fresh = await call(new Jar(), "POST", "/api/v1/auth/passkey/login/complete", {
    ceremony_id: freshStart.body?.ceremony_id,
    credential: buildAssertion(auth, { signCount: 6 }, freshStart.body?.public_key?.challenge),
  });
  expect(
    "CONTROL: an assertion advancing the counter by one signs in, so the refusal above was the counter",
    fresh.status === 200,
    `status=${fresh.status} reason=${reasonOf(fresh)}`,
  );
}

// --- control ------------------------------------------------------------------

/**
 * The probes above would all "pass" if every request failed. Two controls make
 * that impossible: a live health check afterwards, and a control case asserting
 * the CBOR encoder this script relies on actually decodes as the three-key map
 * the server expects.
 */
function probeControlCases() {
  const authData = authenticatorData({
    rpId: RP_ID,
    credentialId: createHash("sha256").update("control").digest(),
    coseKey: Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26]),
    flags: FLAG_UP | FLAG_UV | FLAG_AT,
  });
  const encoded = cborAttestationNone(authData);
  expect(
    "the CBOR encoder produces a 3-key map whose authData round-trips",
    encoded[0] === 0xa3 && encoded.subarray(encoded.length - authData.length).equals(authData),
    `first byte=0x${encoded[0].toString(16)} length=${encoded.length}`,
  );

  const client = clientData({ type: "webauthn.get", challenge: "abc", origin: ORIGIN });
  const parsed = JSON.parse(client.toString("utf8"));
  expect(
    "clientDataJSON carries exactly the fields WebAuthn requires",
    parsed.type === "webauthn.get" &&
      parsed.challenge === "abc" &&
      parsed.origin === ORIGIN &&
      parsed.crossOrigin === false,
    JSON.stringify(parsed),
  );
}

// --- run ----------------------------------------------------------------------

async function main() {
  console.log(`P02 passkey ceremony probe — relying party "${RP_ID}", origin "${ORIGIN}"\n`);
  probeControlCases();
  await setupInfrastructure();

  const authenticator = await probeRegistration();
  if (authenticator) await probeAuthentication(authenticator);
  // V05: replay for the two ceremony kinds the closure above did not cover, plus
  // the counter boundary. Self-contained identity, so it does not depend on the
  // revocation state the probes below establish.
  await probeAddAndReauthReplay();
  // These two mutate and then depend on the account's credential state, so they
  // run AFTER the sign-in probes, which need that credential to be usable.
  const afterRevocation = authenticator ? await probeRevokedCredential(authenticator) : null;
  // The identity probe revives nothing; it only reads, so it can run last and its
  // verdict is unaffected by the revocation above.
  if (afterRevocation) await probeIdentitySubstitution(afterRevocation);
  await probeExpiredCeremony();

  // V01: the three attacks the family names that this probe had never run. All three
  // need only the ceremony and session state the sections above already established, and
  // all three read their verdicts from the database or from a second session rather than
  // from the response that carried the attack.
  await probeCeremonyKind();
  if (afterRevocation) await probeIdentityLinkConflict(afterRevocation);
  await probeRecoveryWithActiveSessions(authenticator);

  // The Worker must still be serving: a probe that ends with the runtime dead
  // has not proved anything about the ceremonies it ran before that.
  const health = await call(new Jar(), "GET", "/api/health");
  expect(
    "the Worker is still serving after the ceremony probes",
    health.status === 200,
    `status=${health.status}`,
  );
}

try {
  await main();
} catch (error) {
  fail("probe harness", redact(error?.stack ?? error));
} finally {
  stopAll();
  if (ownsPersistDir && process.env.P02_PASSKEY_KEEP_PERSIST !== "1" && persistDir) {
    await rm(persistDir, { recursive: true, force: true });
  }
}

console.log(`\n${passes.length}/${passes.length + failures.length} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} case(s) failed:`);
  for (const item of failures) console.error(`  - ${item.label}: ${item.detail}`);
  process.exitCode = 1;
}
