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
  const child = spawn(
    wranglerBin,
    [
      "dev",
      "--env",
      "development",
      "--local",
      "--port",
      String(port),
      "--persist-to",
      persistDir,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: apiDir,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
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

  const assertion = (overrides = {}) => {
    const authData =
      overrides.authData ??
      authenticatorData({
        rpId: overrides.rpId ?? RP_ID,
        credentialId: overrides.credentialId ?? authenticator.credentialId,
        coseKey: Buffer.alloc(0),
        flags: FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS,
        signCount: overrides.signCount ?? 1,
      });
    const client = clientData({
      type: "webauthn.get",
      challenge: overrides.challenge ?? options.challenge,
      origin: overrides.origin ?? ORIGIN,
    });
    const signature =
      overrides.signature ?? signEs256(authenticator.privateKey, authData, sha256(client));
    return {
      id: b64url(overrides.credentialId ?? authenticator.credentialId),
      raw_id: b64url(overrides.credentialId ?? authenticator.credentialId),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
      clientDataJSON: b64url(client),
      ...(overrides.userHandle ? { userHandle: b64url(Buffer.from(overrides.userHandle)) } : {}),
    };
  };
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
  await probeExpiredCeremony();

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
