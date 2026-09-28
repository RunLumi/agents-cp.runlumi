#!/usr/bin/env node
// V01-016 — a REVOKED device must be refused, and must not be able to mint a new token.
//
// WHY THIS IS UNPROVEN TODAY
//
// The run record lists "a revoked device driven to a refusal" as UNPROVEN: `p03` and `p05`
// mention device revocation, and neither attacks it. Revocation is the only way a device
// credential ends, so the claim that it ends is Tier-0 and it had no runtime evidence at all.
//
// THE SHARPEST VERSION OF THE CLAIM IS NOT "THE OLD TOKEN STOPS WORKING"
//
// A revocation that only kills the token it already knows about is escapable. The device routes
// include `GET /api/v1/devices/token/nonce` and `POST /api/v1/devices/token`, and the refresh
// mints a NEW secret in exchange for a proof of possession over a fresh nonce. So the attack is
// not one call after revocation but three:
//
//   A. a plain device-authenticated READ (`GET /api/v1/devices/policy`) must be refused;
//   B. the NONCE must be refused, because it is the first step of a credential mint;
//   C. the REFRESH must be refused, with a REAL signature over a REAL nonce and a real
//      `device_id`, so that a refusal cannot be an artefact of a missing or bad parameter.
//
// C is the one that matters. It is driven with the same private key that enrolled the device,
// over a nonce the server itself issued. If it ever answers 2xx, revocation did not end the
// credential — it rotated it.
//
// EVERY LEG IS CONTROLLED BY A SUCCESS BEFORE THE REVOCATION
//
// A refusal proves nothing on its own: a route that always answers 401 would pass this whole
// probe. So before revoking, all three calls are made and must succeed, including a full
// nonce-then-refresh round trip that yields a real second token. If any of them does not work
// first, the probe stops rather than reporting a refusal it cannot interpret — which is the same
// rule that made `verify:adoption-privacy`'s "0 hits" meaningless, and the rule that
// `verify:mutating-tenancy` follows with its per-route positive controls.
//
// WHY THE MECHANISM MATTERS AS MUCH AS THE OUTCOME
//
// Reading the code says the refusal is caused by DELETION and nothing else.
// `DEVICE_TOKEN_BY_HASH_SQL` selects from `device_tokens` only — it does not join `devices` and
// does not consult `status`. And in the whole crate there is exactly one `DELETE FROM
// device_tokens`, in the same batch that sets `status = 'revoked'`.
//
// So the claim is true, and it is true by exactly one mechanism with no second check. That is a
// real fragility worth recording rather than a defect to invent: any future path that sets a
// device to a non-active status without deleting its tokens would leave a live credential, and
// nothing in the authentication query would notice. The probe therefore establishes the claim at
// runtime AND records the coupling structurally, clearly labelled as a source fact, because
// "there is no second check" is not something a response can demonstrate.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./lib/smoke-harness.mjs";

// Resolved from this file, not from the working directory, so the structural check below finds
// the same source whatever the cwd is. The convention is `p02-guard-probe.mjs`'s, and its
// comment is the right framing for what these two assertions do: a test that reads the value it
// is checking is circular, whereas reading the CONSTANT and then asking a real database and a
// real Worker whether reality agrees with it is not.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const deviceRepositorySource = join(scriptDir, "..", "src", "repositories", "devices.rs");

/**
 * The device routes are authenticated by `Authorization: DeviceToken <token>` and never read a
 * session cookie. A jar that could contribute a cookie would let a browser session ride along on
 * a request that is supposed to be device-authenticated, and the case would then prove nothing
 * about the device boundary at all.
 */
const anonJar = () => ({ header: () => "" });

await runProbe("V01 revoked device", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_REVOKE_PERSIST_TO", portEnvVar: "V01_REVOKE_PORT" });

  // --- a real device identity: ed25519 keypair, real signature ---------------
  // The refresh leg signs a server-issued nonce with this key, so the private key has to be the
  // real one: a stand-in signer would make leg C untestable rather than easy.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const device = {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyFingerprint: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    sign: (message) => sign(null, Buffer.from(message), privateKey).toString("hex"),
  };

  // --- fixtures: a real enrolled, approved, completed device -----------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const org = await probe.createOrganization(alice.jar, "Alice Org", `v01-rev-${probe.nonce}`);
  const orgSlug = (
    await d1Rows(`SELECT slug FROM organizations WHERE org_id = '${org.orgId}'`, "V01 the org slug")
  )[0]?.slug;
  const admin = { jar: alice.jar, orgId: org.orgId, orgSlug };
  expect(
    "CONTROL: the organization's slug is known, so a device can be enrolled against it",
    typeof orgSlug === "string" && orgSlug.length > 0,
    `slug=${orgSlug ?? "none"}`,
  );

  const enrollment = await request(anonJar(), "POST", "/api/v1/devices/enrollments", {
    org_slug: orgSlug,
    public_key: device.publicKeyPem,
    key_fingerprint: device.keyFingerprint,
    device_name: "V01 revoked device",
    platform: "darwin-arm64",
    app_version: "0.5.0",
  });
  const enrollmentId = enrollment.payload?.enrollment_id;
  expect(
    "CONTROL: an enrollment begins",
    enrollment.status === 201 && typeof enrollmentId === "string",
    `status=${enrollment.status} body=${probe.brief(enrollment.payload, 200)}`,
  );
  if (typeof enrollmentId !== "string") {
    probe.finish(2, "no enrollment, so no device, so nothing to revoke. A harness outcome.");
    return;
  }
  const approval = await request(
    admin.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/devices/enrollments/${enrollmentId}/approve`,
    {},
    browserMutation(admin.jar, "v01-rev-approve"),
  );
  expectStatus("CONTROL: the enrollment is approved", approval, [201]);
  const challenge = await request(anonJar(), "GET", `/api/v1/devices/enrollments/${enrollmentId}`);
  if (typeof challenge.payload?.challenge !== "string") {
    probe.finish(2, "no proof challenge, so no device token. A harness outcome.");
    return;
  }
  const completed = await request(
    anonJar(),
    "POST",
    `/api/v1/devices/enrollments/${enrollmentId}/complete`,
    { signature: device.sign(challenge.payload.challenge) },
  );
  const token = completed.payload?.device_token;
  const deviceId = completed.payload?.device?.id ?? completed.payload?.device?.device_id;
  expect(
    "CONTROL: the enrollment completes and yields a real device token",
    completed.status === 201 && typeof token === "string" && typeof deviceId === "string",
    `status=${completed.status} body=${probe.brief(completed.payload, 200)}`,
  );
  if (typeof token !== "string" || typeof deviceId !== "string") {
    probe.finish(2, "no device token, so nothing to revoke. A harness outcome.");
    return;
  }
  probe.registerSecret(token);
  const auth = { Authorization: `DeviceToken ${token}` };

  // --- the three device-authenticated calls, BEFORE any revocation ------------
  // All three must work first. A refusal after revocation that cannot be read against a
  // success before it is not evidence of anything.
  probe.stage = "before-revocation";
  const readPolicy = () => request(anonJar(), "GET", "/api/v1/devices/policy", undefined, auth);
  const fetchNonce = () =>
    request(anonJar(), "GET", "/api/v1/devices/token/nonce", undefined, auth);
  /** A full refresh round trip: a server nonce, then a real signature over it. */
  const refresh = async () => {
    const nonceResponse = await fetchNonce();
    const nonce = nonceResponse.payload?.nonce;
    if (typeof nonce !== "string") {
      return { nonceResponse, response: nonceResponse, minted: false };
    }
    const response = await request(
      anonJar(),
      "POST",
      "/api/v1/devices/token",
      {
        device_id: deviceId,
        nonce,
        signature: device.sign(nonce),
        app_version: "0.5.0",
      },
      auth,
    );
    return {
      nonceResponse,
      response,
      nonce,
      minted: typeof response.payload?.device_token === "string",
    };
  };

  // The ANONYMOUS leg, which is the other half of V01-019. Before the fix this route took no
  // `HeaderMap` at all, so a caller with NO credential received a fresh 64-hex server-issued
  // secret. The revoked-device leg alone would not have caught that -- a revoked device still
  // *had* a credential once -- so the two are separate assertions and both are required.
  const anonymousNonce = () =>
    request(anonJar(), "GET", "/api/v1/devices/token/nonce", undefined, {});
  const anonymousBefore = await anonymousNonce();
  console.log(
    `  anonymous GET /devices/token/nonce (before revocation) -> ${anonymousBefore.status}`,
  );

  const policyBefore = await readPolicy();
  const refreshBefore = await refresh();
  console.log(
    `\n  before revocation:\n` +
      `    GET  /devices/policy        -> ${policyBefore.status}\n` +
      `    GET  /devices/token/nonce   -> ${refreshBefore.nonceResponse.status} ` +
      `(nonce ${typeof refreshBefore.nonce === "string" ? "issued" : "absent"})\n` +
      `    POST /devices/token         -> ${refreshBefore.response.status} ` +
      `minted=${refreshBefore.minted}`,
  );
  expect(
    "V01-019: a caller with NO credential at all is refused a nonce, before and after any revocation",
    anonymousBefore.status >= 400 && anonymousBefore.status < 500,
    `an anonymous GET /devices/token/nonce answered ${anonymousBefore.status} ` +
      `body=${probe.brief(anonymousBefore.payload, 200)}; before the fix this route took no ` +
      `HeaderMap and minted server-issued secret material for anyone who asked`,
  );
  expect(
    "the anonymous refusal carries a stable code, and never a nonce",
    typeof anonymousBefore.payload?.error?.code === "string" &&
      typeof anonymousBefore.payload?.nonce !== "string",
    `status=${anonymousBefore.status} code=${anonymousBefore.payload?.error?.code ?? "none"} ` +
      `nonce=${typeof anonymousBefore.payload?.nonce === "string" ? "PRESENT" : "absent"}`,
  );
  expect(
    "CONTROL: a device-authenticated READ works before revocation",
    policyBefore.status === 200,
    `status=${policyBefore.status} body=${probe.brief(policyBefore.payload, 200)}`,
  );
  // 200, not 201: the refresh replaces an existing credential rather than creating a new
  // resource, so it is not a creation. Written as a set because guessing the wrong member of it
  // is how the first run of this probe refused to grade for a reason that had nothing to do with
  // revocation.
  expect(
    "CONTROL: the device can fetch a nonce and exchange it for a REAL second token before revocation, so a refusal after it is attributable to the revocation",
    refreshBefore.minted === true &&
      (refreshBefore.response.status === 200 || refreshBefore.response.status === 201),
    `nonce status=${refreshBefore.nonceResponse.status}, refresh status=${refreshBefore.response.status}, ` +
      `minted=${refreshBefore.minted} body=${probe.brief(refreshBefore.response.payload, 200)}`,
  );
  if (refreshBefore.minted !== true) {
    probe.finish(
      2,
      "the pre-revocation refresh did not mint a token, so a post-revocation refusal would be \n" +
        "uninterpretable. Refusing to grade it rather than reporting a false pass.",
    );
    return;
  }
  const secondToken = refreshBefore.response.payload.device_token;
  probe.registerSecret(secondToken);
  const secondAuth = { Authorization: `DeviceToken ${secondToken}` };

  // --- revoke, and read the stored state -------------------------------------
  probe.stage = "revoke";
  const beforeRevoke = (
    await d1Rows(
      `SELECT device_id, status, revoked_at FROM devices WHERE device_id = '${deviceId}'`,
      `V01 device ${deviceId}`,
    )
  )[0];
  const tokensBefore = await d1Rows(
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id = '${deviceId}'`,
    `V01 tokens for ${deviceId}`,
  );
  const revoke = await request(
    admin.jar,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${deviceId}`,
    {},
    browserMutation(admin.jar, "v01-rev-revoke"),
  );
  const afterRevoke = (
    await d1Rows(
      `SELECT device_id, status, revoked_at FROM devices WHERE device_id = '${deviceId}'`,
      `V01 device ${deviceId}`,
    )
  )[0];
  const tokensAfter = await d1Rows(
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id = '${deviceId}'`,
    `V01 tokens for ${deviceId}`,
  );
  console.log(
    `\n  revocation: status=${revoke.status}\n` +
      `    stored: device status ${beforeRevoke?.status} -> ${afterRevoke?.status}, ` +
      `revoked_at=${afterRevoke?.revoked_at ?? "null"}\n` +
      `    stored: token rows ${tokensBefore[0]?.n} -> ${tokensAfter[0]?.n}`,
  );
  expect(
    "CONTROL: the revocation took effect in the DATABASE -- status is revoked and every token row for the device is gone",
    afterRevoke?.status === "revoked" && Number(tokensAfter[0]?.n) === 0,
    `status=${afterRevoke?.status} revoked_at=${afterRevoke?.revoked_at ?? "null"} ` +
      `token rows ${tokensBefore[0]?.n} -> ${tokensAfter[0]?.n}`,
  );
  if (afterRevoke?.status !== "revoked" || Number(tokensAfter[0]?.n) !== 0) {
    probe.finish(
      2,
      "the revocation did not reach the stored state the claim depends on, so the refusals below \n" +
        "would be measuring something other than a revoked device.",
    );
    return;
  }

  // --- THE CLAIM: a revoked device is refused, and cannot mint ----------------
  probe.stage = "after-revocation";
  const policyAfter = await readPolicy();
  const refreshAfter = await refresh();
  const policySecondToken = await request(
    anonJar(),
    "GET",
    "/api/v1/devices/policy",
    undefined,
    secondAuth,
  );
  const anonymousAfter = await anonymousNonce();
  console.log(
    `    anonymous GET /devices/token/nonce (after revocation)  -> ${anonymousAfter.status}`,
  );
  expect(
    "V01-019: the anonymous caller is still refused after the revocation, so the refusal is the route's own gate and not a side effect of the device being revoked",
    anonymousAfter.status >= 400 && anonymousAfter.status < 500,
    `an anonymous GET /devices/token/nonce answered ${anonymousAfter.status} ` +
      `body=${probe.brief(anonymousAfter.payload, 200)}`,
  );
  console.log(
    `\n  after revocation:\n` +
      `    GET  /devices/policy (first token)  -> ${policyAfter.status}\n` +
      `    GET  /devices/token/nonce (first)   -> ${refreshAfter.nonceResponse.status}\n` +
      `    POST /devices/token (first)         -> ${refreshAfter.response.status} minted=${refreshAfter.minted}\n` +
      `    GET  /devices/policy (second token) -> ${policySecondToken.status}`,
  );
  for (const r of [
    policyAfter,
    refreshAfter.nonceResponse,
    refreshAfter.response,
    policySecondToken,
  ]) {
    expect(
      `the revoked device is refused: ${r.method} ${r.path}`,
      r.status >= 400,
      `status=${r.status} body=${probe.brief(r.payload, 200)}`,
    );
  }
  expect(
    "a revoked device cannot MINT a new token: the refresh did not return a device_token even with a real nonce and a real signature",
    refreshAfter.minted !== true,
    `refresh status=${refreshAfter.response.status} minted=${refreshAfter.minted} ` +
      `body=${probe.brief(refreshAfter.response.payload, 200)} -- if this minted, the ` +
      `revocation rotated the credential instead of ending it`,
  );
  expect(
    "a refusal after revocation is an explicit 4xx with a stable error code, never a 2xx and never a bare 500",
    [policyAfter, refreshAfter.response].every(
      (r) => r.status >= 400 && r.status < 500 && typeof r.payload?.error?.code === "string",
    ),
    `policy=${policyAfter.status}/${policyAfter.payload?.error?.code ?? "no code"} ` +
      `refresh=${refreshAfter.response.status}/${refreshAfter.response.payload?.error?.code ?? "no code"}`,
  );
  expect(
    "the refusals do not leak the device's stored detail",
    !JSON.stringify([policyAfter, refreshAfter.response, policySecondToken]).includes(deviceId) ||
      refreshAfter.nonceResponse.status < 400,
    `the device id ${deviceId} appears in a refused body, so the refusal discloses which device was presented`,
  );

  // --- the mechanism, as a clearly-labelled structural fact -------------------
  //
  // A response cannot demonstrate the ABSENCE of a check, so this one is a source fact and is
  // labelled as such. It is here because the runtime evidence above attributes the refusal to
  // the token rows disappearing; if a second check existed, the fragility claim would be wrong.
  let authSql = "";
  let tokenDeletes = 0;
  let revokedWrites = 0;
  try {
    const repo = readFileSync(deviceRepositorySource, "utf8");
    const match = repo.match(/const DEVICE_TOKEN_BY_HASH_SQL: &str = r#"([\s\S]*?)"#;/);
    authSql = match?.[1] ?? "";
    tokenDeletes = (repo.match(/DELETE FROM device_tokens/g) ?? []).length;
    revokedWrites = (repo.match(/SET status = 'revoked'/g) ?? []).length;
  } catch (error) {
    console.log(`  the structural check could not read the source: ${error.message}`);
  }
  console.log(
    `\n  mechanism: the device-token lookup ${/FROM\s+devices/i.test(authSql) ? "DOES" : "does NOT"} ` +
      `reference the devices table; ${tokenDeletes} DELETE FROM device_tokens statement(s) and ` +
      `${revokedWrites} writer(s) of status = 'revoked' exist in the device repository`,
  );
  expect(
    "STRUCTURAL: the device-token lookup does not join devices, so the refusal above is attributable to the token rows being deleted and there is no second status check",
    authSql.length > 0 && !/FROM\s+devices/i.test(authSql),
    `DEVICE_TOKEN_BY_HASH_SQL = ${JSON.stringify(authSql.replace(/\s+/g, " ").trim().slice(0, 160))}`,
  );
  expect(
    "STRUCTURAL: revocation and token deletion are coupled -- one statement writes status = 'revoked' and one deletes the tokens, in the same batch",
    tokenDeletes === 1 && revokedWrites === 1,
    `${tokenDeletes} DELETE FROM device_tokens and ${revokedWrites} status='revoked' writers; any ` +
      `count other than 1 and 1 means the coupling this claim rests on is not what it was read to be`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
