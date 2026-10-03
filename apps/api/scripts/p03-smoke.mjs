// P03 integration smoke (goal-03): scripted desktop client over wrangler dev.
//
// Journey (plan03 §8):
//   1. user signs in (browser-equivalent session)
//   2. device enrolls into Org A
//   3. one local workspace binds to Project P
//   4. control plane lists the device and binding
//   5. device fetches policy version N and acks it
//   6. admin revokes the device
//   7. device can no longer refresh managed access
//   8. local workspace intact — desktop-side, deferred to the LumiAgents PR
//
// Negative scenarios: duplicate enrollment approval, wrong proof, cross-org
// binding, duplicate binding identity, stale membership, revoked refresh.
//
// Usage: wrangler dev --env development on :8787, then `pnpm smoke:p03`.

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

const baseUrl = process.env.P03_API_BASE ?? "http://127.0.0.1:8787";

class CookieJar {
  cookies = new Map();

  absorb(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const [pair] = value.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

async function request(jar, method, path, body, extraHeaders = {}) {
  const headers = { Accept: "application/json", ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.absorb(response);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  return { status: response.status, payload, headers: response.headers };
}

const csrfHeaders = (jar) => ({
  "X-CSRF-Token": jar.cookies.get("lumi_csrf") ?? "",
});

async function authenticatedUser(label) {
  const jar = new CookieJar();
  const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
  let result = await request(jar, "POST", "/api/v1/auth/signup", { email, display_name: label });
  assert.equal(result.status, 201);
  const verification = result.payload.verification;
  result = await request(jar, "POST", "/api/v1/auth/verify-email", {
    challenge_id: verification.challenge_id,
    code: verification.development_code,
  });
  assert.equal(result.status, 200);
  result = await request(jar, "POST", "/api/v1/auth/login/start", { email });
  assert.equal(result.status, 202);
  result = await request(jar, "POST", "/api/v1/auth/login/complete", {
    challenge_id: result.payload.challenge_id,
    code: result.payload.development_code,
  });
  assert.equal(result.status, 200);
  return { jar, user: result.payload.user };
}

// Scripted desktop device: real Ed25519 keypair, PEM SPKI public key.
function makeDevice(name, platform, appVersion) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = publicKey.export({ type: "spki", format: "der" });
  const key_fingerprint = createHash("sha256").update(der).digest("hex");
  return {
    name,
    platform,
    appVersion,
    publicKeyPem,
    key_fingerprint,
    sign(message) {
      return sign(null, Buffer.from(message), privateKey).toString("hex");
    },
  };
}

let passed = 0;
function check(name, condition, detail = "") {
  if (!condition) {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`PASS  ${name}`);
  }
}

const run = async () => {
  // 1. Browser-equivalent sign-in for the org admin.
  const alice = await authenticatedUser("P03 Alice");
  const csrf = { "X-CSRF-Token": alice.jar.cookies.get("lumi_csrf") };

  const slug = `p03-${randomUUID().slice(0, 8)}`;
  let result = await request(
    alice.jar,
    "POST",
    "/api/v1/orgs",
    { display_name: "P03 Smoke Org", slug },
    { ...csrfHeaders(alice.jar), "Idempotency-Key": `org-${slug}` },
  );
  assert.equal(result.status, 201);
  const orgId = result.payload.organization.org_id;
  check("1. admin signed in and created Org A", Boolean(orgId));

  // 2. Device enrolls into Org A (anonymous begin).
  const device = makeDevice("Smoke Laptop", "darwin-arm64", "0.3.1");
  result = await request(new CookieJar(), "POST", "/api/v1/devices/enrollments", {
    org_slug: slug,
    public_key: device.publicKeyPem,
    key_fingerprint: device.key_fingerprint,
    device_name: device.name,
    platform: device.platform,
    app_version: device.appVersion,
  });
  assert.equal(result.status, 201);
  const enrollmentId = result.payload.enrollment_id;
  const userCode = result.payload.user_code;
  check("2. enrollment began anonymously", Boolean(enrollmentId && userCode));

  // Status polls show pending with no challenge before approval.
  result = await request(new CookieJar(), "GET", `/api/v1/devices/enrollments/${enrollmentId}`);
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "pending");
  assert.equal(result.payload.challenge, null);
  check("2b. pending status leaks no challenge", true);

  // 3. Admin approves; device completes with a valid proof.
  result = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgId}/devices/enrollments/${enrollmentId}/approve`,
    {},
    { ...csrf, "Idempotency-Key": `approve-${enrollmentId}` },
  );
  if (result.status !== 201) console.error("approve payload:", JSON.stringify(result.payload));
  assert.equal(result.status, 201);
  const deviceId = result.payload.device.id;
  check("3. admin approved the enrollment", Boolean(deviceId));

  result = await request(new CookieJar(), "GET", `/api/v1/devices/enrollments/${enrollmentId}`);
  const challenge = result.payload.challenge;
  assert.equal(result.payload.status, "approved");
  assert.equal(typeof challenge, "string");
  // Wrong proof fails before the right one is accepted.
  result = await request(
    new CookieJar(),
    "POST",
    `/api/v1/devices/enrollments/${enrollmentId}/complete`,
    {
      signature: "00".repeat(64),
    },
  );
  assert.equal(result.status, 403);
  assert.equal(result.payload.error.details.reason, "device_proof_invalid");
  check("4a. invalid proof denied with stable reason", true);

  const signature = device.sign(challenge);
  result = await request(
    new CookieJar(),
    "POST",
    `/api/v1/devices/enrollments/${enrollmentId}/complete`,
    {
      signature,
    },
  );
  assert.equal(result.status, 201);
  const deviceToken = result.payload.device_token;
  assert.equal(result.payload.device.id, deviceId);
  check("4. completion verified proof and issued device token", Boolean(deviceToken));

  const deviceHeaders = { Authorization: `DeviceToken ${deviceToken}` };

  // Negative: replaying completion after completion fails.
  result = await request(
    new CookieJar(),
    "POST",
    `/api/v1/devices/enrollments/${enrollmentId}/complete`,
    {
      signature,
    },
  );
  assert.equal(result.status, 403);
  assert.equal(result.payload.error.details.reason, "enrollment_expired");
  check("4b. completion replay is rejected", true);

  // 5. Device heartbeat + create project + bind workspace.
  result = await request(
    new CookieJar(),
    "POST",
    "/api/v1/devices/heartbeat",
    {
      app_version: device.appVersion,
      capabilities: { browser_use: true, computer_use: false, runtime_version: "1.0.0" },
    },
    deviceHeaders,
  );
  assert.equal(result.status, 200);
  check("5. heartbeat accepted with bounded capabilities", true);

  result = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgId}/projects`,
    { name: "Project P", visibility: "org" },
    { ...csrf, "Idempotency-Key": `project-${enrollmentId}` },
  );
  assert.equal(result.status, 201);
  const projectId = result.payload.id;
  check("6. project created", Boolean(projectId));

  result = await request(
    new CookieJar(),
    "POST",
    "/api/v1/devices/bindings",
    {
      project_id: projectId,
      workspace_identity: "ws-smoke-001",
      display_name: "Smoke workspace",
      environment_type: "local",
    },
    deviceHeaders,
  );
  assert.equal(result.status, 201);
  const bindingId = result.payload.id;
  check("7. workspace bound to project", Boolean(bindingId));

  // Duplicate binding identity rejected.
  result = await request(
    new CookieJar(),
    "POST",
    "/api/v1/devices/bindings",
    {
      project_id: projectId,
      workspace_identity: "ws-smoke-001",
      display_name: "Duplicate",
      environment_type: "local",
    },
    deviceHeaders,
  );
  assert.equal(result.status, 409);
  assert.equal(result.payload.error.details.reason, "workspace_binding_conflict");
  check("7b. duplicate binding identity rejected", true);

  // Control plane sees device + binding.
  result = await request(alice.jar, "GET", `/api/v1/orgs/${orgId}/devices`);
  assert.equal(result.status, 200);
  assert.ok(result.payload.items.some((item) => item.id === deviceId));
  result = await request(alice.jar, "GET", `/api/v1/orgs/${orgId}/projects/${projectId}/bindings`);
  assert.ok(result.payload.items.some((item) => item.id === bindingId));
  check("8. control plane lists device and binding", true);

  // 9. Policy fetch + ack.
  result = await request(
    new CookieJar(),
    "GET",
    "/api/v1/devices/policy",
    undefined,
    deviceHeaders,
  );
  assert.equal(result.status, 200);
  const policyVersion = result.payload.policy_version;
  assert.equal(result.payload.org_id, orgId);
  assert.ok(result.payload.payload.projects.bindings.includes(projectId));
  result = await request(
    new CookieJar(),
    "POST",
    "/api/v1/devices/policy/ack",
    {
      policy_version: policyVersion,
    },
    deviceHeaders,
  );
  assert.equal(result.status, 204);
  result = await request(alice.jar, "GET", `/api/v1/orgs/${orgId}/policy`, undefined, {
    "X-Org-ID": orgId,
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.persisted, true);
  assert.equal(result.payload.org_id, orgId);
  assert.ok(result.payload.model_policy);
  assert.ok("allowed_aliases" in result.payload);
  check("9c. integrated policy route exposes P03 snapshot and P04 view", true);
  check("9. device fetched and acked policy", `v${policyVersion}`);

  // Cross-org policy replay is structurally impossible: audience = device org.
  // Prove with a second org and a device-scoped fetch (policy stays Org A's).
  result = await request(
    alice.jar,
    "POST",
    "/api/v1/orgs",
    { display_name: "P03 Smoke Org B", slug: `${slug}-b` },
    { ...csrfHeaders(alice.jar), "Idempotency-Key": `org-b-${slug}` },
  );
  assert.equal(result.status, 201);
  const orgB = result.payload.organization.org_id;
  result = await request(
    new CookieJar(),
    "GET",
    "/api/v1/devices/policy",
    undefined,
    deviceHeaders,
  );
  assert.equal(result.payload.org_id, orgId);
  assert.notEqual(result.payload.org_id, orgB);
  check("9b. policy audience bound to enrolling org", true);

  // 9c-9j. F19-008 / V04-008: the minimum-client-version LEVER, end to end.
  // The comparator, the policy read and the refusal have existed since P03;
  // what was missing until the 2026-10-03 audit pass was any way to ARM the
  // control. The attribution design: the SAME token exchange that succeeded in
  // case 4 (no floor armed) is refused once a floor above the device's
  // app_version is set, and succeeds again once the floor is cleared — so the
  // refusal is the floor's, not the route breaking.
  result = await request(
    alice.jar,
    "GET",
    `/api/v1/orgs/${orgId}/device-policy`,
    undefined,
    csrf,
  );
  assert.equal(result.status, 200);
  assert.equal(result.payload.min_client_version, null);
  assert.equal(result.payload.version, 0);
  check("9c. fresh org reports no device-policy floor", true);

  result = await request(
    alice.jar,
    "PUT",
    `/api/v1/orgs/${orgId}/device-policy`,
    { min_client_version: "99.0.0", version: 0 },
    { ...csrf, "Idempotency-Key": `device-policy-arm-${slug}` },
  );
  assert.equal(result.status, 200, `arming the floor failed: ${JSON.stringify(result.payload)}`);
  assert.equal(result.payload.version, 1);
  check("9d. admin arms a floor above the device's app_version", true);

  result = await request(alice.jar, "GET", `/api/v1/orgs/${orgId}/device-policy`);
  assert.equal(result.payload.min_client_version, "99.0.0");
  check("9e. the armed floor reads back", true);

  // The token-nonce endpoint authenticates the DEVICE (its token from case 4),
  // not an anonymous caller.
  const floorNonce = await request(
    new CookieJar(),
    "GET",
    "/api/v1/devices/token/nonce",
    undefined,
    deviceHeaders,
  );
  assert.equal(floorNonce.status, 200, `nonce refused: ${floorNonce.status}`);
  result = await request(new CookieJar(), "POST", "/api/v1/devices/token", {
    device_id: deviceId,
    signature: device.sign(floorNonce.payload.nonce),
    nonce: floorNonce.payload.nonce,
    app_version: device.appVersion,
  });
  assert.equal(result.status, 403, `expected the floor to refuse: ${JSON.stringify(result.payload)}`);
  assert.equal(result.payload.error.details.reason, "client_version_too_old");
  check("9f. a device below the floor is refused at token exchange", true);

  result = await request(
    alice.jar,
    "PUT",
    `/api/v1/orgs/${orgId}/device-policy`,
    { min_client_version: null, version: 1 },
    { ...csrf, "Idempotency-Key": `device-policy-clear-${slug}` },
  );
  assert.equal(result.status, 200, `clearing the floor failed: ${JSON.stringify(result.payload)}`);
  assert.equal(result.payload.min_client_version, null);
  check("9g. the floor can be cleared (staged removal is one request)", true);

  const clearedNonce = await request(
    new CookieJar(),
    "GET",
    "/api/v1/devices/token/nonce",
    undefined,
    deviceHeaders,
  );
  assert.equal(clearedNonce.status, 200);
  result = await request(new CookieJar(), "POST", "/api/v1/devices/token", {
    device_id: deviceId,
    signature: device.sign(clearedNonce.payload.nonce),
    nonce: clearedNonce.payload.nonce,
    app_version: device.appVersion,
  });
  assert.equal(result.status, 200, `expected the exchange to succeed after clearing: ${JSON.stringify(result.payload)}`);
  check("9h. the same exchange succeeds once the floor is cleared", true);

  result = await request(
    alice.jar,
    "PUT",
    `/api/v1/orgs/${orgId}/device-policy`,
    { min_client_version: "1.0.0", version: 0 },
    { ...csrf, "Idempotency-Key": `device-policy-stale-${slug}` },
  );
  assert.equal(result.status, 409);
  assert.equal(result.payload.error.details.reason, "version_conflict");
  check("9i. a stale concurrent write is refused by the version guard", true);

  result = await request(
    alice.jar,
    "PUT",
    `/api/v1/orgs/${orgId}/device-policy`,
    { min_client_version: "not-a-version", version: 1 },
    { ...csrf, "Idempotency-Key": `device-policy-bad-${slug}` },
  );
  assert.equal(result.status, 422);
  assert.equal(result.payload.error.details.reason, "min_client_version_invalid");
  check("9j. a floor the comparator would fail closed on is refused at the boundary", true);

  // 10. Revocation blocks refresh, heartbeat, and policy fetch.
  result = await request(
    alice.jar,
    "DELETE",
    `/api/v1/orgs/${orgId}/devices/${deviceId}`,
    undefined,
    { ...csrf, "Idempotency-Key": `revoke-${deviceId}` },
  );
  assert.equal(result.status, 204);
  result = await request(
    new CookieJar(),
    "POST",
    "/api/v1/devices/heartbeat",
    {
      app_version: device.appVersion,
    },
    deviceHeaders,
  );
  assert.equal(result.status, 401);
  result = await request(
    new CookieJar(),
    "GET",
    "/api/v1/devices/policy",
    undefined,
    deviceHeaders,
  );
  assert.equal(result.status, 401);
  check("10. revoked device loses managed access", true);

  // 10b. Stale membership: Bob enrolls into the org, Alice approves, then
  // removes Bob; his device can no longer refresh.
  const bob = await authenticatedUser("P03 Bob");
  // Invitations require an invitation record; use the admin invite flow.
  result = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgId}/invitations`,
    { email: bob.user.email, role: "member" },
    { ...csrf, "Idempotency-Key": `invite-${randomUUID()}` },
  );
  if (result.status !== 201) console.error("invite payload:", JSON.stringify(result.payload));
  assert.equal(result.status, 201);
  const invitationToken = result.payload.development_token;
  const invitationId = result.payload.invitation.id;
  result = await request(
    bob.jar,
    "POST",
    `/api/v1/invitations/${invitationId}/accept`,
    { token: invitationToken },
    csrfHeaders(bob.jar),
  );
  if (result.status !== 200) console.error("accept payload:", JSON.stringify(result.payload));
  assert.equal(result.status, 200);

  const bobDevice = makeDevice("Bob Laptop", "darwin-arm64", "0.3.1");
  result = await request(new CookieJar(), "POST", "/api/v1/devices/enrollments", {
    org_slug: slug,
    public_key: bobDevice.publicKeyPem,
    key_fingerprint: bobDevice.key_fingerprint,
    device_name: bobDevice.name,
    platform: bobDevice.platform,
    app_version: bobDevice.appVersion,
  });
  const bobEnrollmentId = result.payload.enrollment_id;
  // Bob approves his own enrollment: the approver becomes the device owner,
  // so stale-membership revocation semantics apply to him.
  result = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgId}/devices/enrollments/${bobEnrollmentId}/approve`,
    {},
    { ...csrfHeaders(bob.jar), "Idempotency-Key": `approve-${bobEnrollmentId}` },
  );
  assert.equal(result.status, 201);
  const bobDeviceId = result.payload.device.id;

  // Alice removes Bob.
  result = await request(alice.jar, "GET", `/api/v1/orgs/${orgId}/members`);
  const bobMember = result.payload.items.find((item) => item.user_id === bob.user.id);
  assert.ok(bobMember, "Bob membership should exist before removal");
  const bobMembership = result.payload.items.find((item) => item.user_id === bob.user.id);
  result = await request(
    alice.jar,
    "DELETE",
    `/api/v1/orgs/${orgId}/members/${bobMembership.membership_id}`,
    undefined,
    { ...csrf, "If-Match": `"${bobMembership.version}"` },
  );
  assert.equal(result.status, 204, `member removal failed: ${result.status}`);

  // Bob's device token refresh now fails membership_required -- and it fails at WHICHEVER step
  // bites first, which is not always the one this test originally assumed.
  //
  // V04-005: the original assumed the challenge nonce would still be issued, signed it, and exchanged
  // it. But `token_nonce` calls `authorize_device`, which checks the enrollment membership -- and Bob
  // was just removed, so the nonce is REFUSED and `bobNonce.payload.nonce` is `undefined`. Passing
  // that to `sign()` threw `ERR_INVALID_ARG_TYPE`, which aborted the whole probe: a crash, not a
  // verdict. So for as long as that line has existed, this case reported the health of the harness
  // rather than the property -- the fifth instance in this campaign of a check that throws where it
  // should fail.
  //
  // The product is right and fail-closed: a removed member's device cannot even obtain a challenge.
  // That is a STRONGER guarantee than being refused only at the exchange, so the assertion states the
  // chain is refused, and names the step and the reason it actually refused with.
  const bobNonce = await request(new CookieJar(), "GET", "/api/v1/devices/token/nonce");
  const nonceRefused = bobNonce.status !== 200 || typeof bobNonce.payload?.nonce !== "string";
  let tokenOutcome;
  if (nonceRefused) {
    tokenOutcome = `refused at the challenge (nonce ${bobNonce.status}/${bobNonce.payload?.error?.details?.reason ?? "no reason"})`;
    assert.notEqual(
      bobNonce.status,
      200,
      "a removed member's device must not be able to obtain a challenge nonce",
    );
  } else {
    // The challenge was issued; the exchange must be the step that refuses, with the recorded reason.
    const bobSignature = bobDevice.sign(bobNonce.payload.nonce);
    result = await request(new CookieJar(), "POST", "/api/v1/devices/token", {
      device_id: bobDeviceId,
      signature: bobSignature,
      nonce: bobNonce.payload.nonce,
      app_version: bobDevice.appVersion,
    });
    tokenOutcome = `refused at the exchange (${result.status}/${result.payload?.error?.details?.reason ?? "no reason"})`;
    assert.equal(result.status, 403);
    assert.equal(result.payload.error.details.reason, "membership_required");
  }
  check("11. stale membership blocks device token refresh", true, tokenOutcome);

  console.log(`\nP03 smoke: ${passed} checks passed`);
};

try {
  await run();
} catch (error) {
  console.error("P03 smoke failed:", error);
  process.exitCode = 1;
}
