import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
const root = resolve(import.meta.dirname, "../..");
const requireWeb = createRequire(resolve(root, "apps/web/package.json"));
// Same client selection as scripts/integration/lumi-agents.mjs, so the SHA recorded below is the
// SHA of the client that was actually built.
const client = resolve(process.env.LUMI_AGENTS_DIR || resolve(root, "integrations/lumi-agents"));
const requireClient = createRequire(resolve(client, "package.json"));
let viteEntry;
try {
  viteEntry = requireWeb.resolve("vite");
} catch {
  viteEntry = requireClient.resolve("vite");
}
const { build } = await import(pathToFileURL(viteEntry).href);
const out = resolve(root, "test-results/lumi-account-client");
await build({
  configFile: false,
  logLevel: "warn",
  root: client,
  ssr: { noExternal: true },
  build: {
    ssr: resolve(client, "packages/services/src/lumi-account/hostTransport.ts"),
    outDir: out,
    rollupOptions: { output: { entryFileNames: "transport.mjs" } },
  },
});
const { LumiAccountHostTransport } = await import(
  pathToFileURL(resolve(out, "transport.mjs")).href
);
await build({
  configFile: false,
  logLevel: "warn",
  root: client,
  ssr: { noExternal: true },
  build: {
    ssr: resolve(client, "packages/services/src/lumi-account/deviceTransport.ts"),
    outDir: resolve(out, "device"),
    rollupOptions: { output: { entryFileNames: "device.mjs" } },
  },
});
const { LumiDeviceHostTransport } = await import(
  pathToFileURL(resolve(out, "device/device.mjs")).href
);
const probe = new SmokeHarness({ name: "desktop account transport" });
const reportPath =
  process.env.LUMI_ACCOUNT_REPORT || resolve(root, "test-results/lumi-account-report.json");
let completed = false;
let failureEvidence = null;
try {
  await probe.setup({ persistEnvVar: "DE2E_ACCOUNT_PERSIST", portEnvVar: "DE2E_ACCOUNT_PORT" });
  // Before any transport is constructed: they bind `fetch` at construction. Observation only;
  // LUMI_PROBE_FRESH_SOCKETS=1 is the diagnostic A/B switch (see lib/request-boundary.mjs).
  probe.attachBoundaryRecorder({ freshSockets: process.env.LUMI_PROBE_FRESH_SOCKETS === "1" });
  const owner = await probe.authenticatedUser("Desktop Account");
  for (const value of owner.jar.cookies.values()) probe.registerSecret(value);
  const transport = new LumiAccountHostTransport(probe.baseUrl);
  const flow = await transport.beginSignIn("Integration Desktop");
  assert.match(flow.userCode, /^[A-Z0-9]{8}$/);
  console.log("PASS actual client starts S256 device authorization");
  const approval = await probe.request(
    owner.jar,
    "POST",
    "/api/v1/auth/device-code/approve",
    { user_code: flow.userCode },
    probe.browserMutation(owner.jar, "desktop-approve"),
  );
  assert.equal(approval.status, 204);
  console.log("PASS browser-session fixture explicitly approves code");
  await transport.completeSignIn();
  const account = await transport.readAccount();
  assert.equal(account.user.id, owner.user.id);
  assert.equal(JSON.stringify(transport), "{}");
  console.log("PASS client exchanges real session cookies and reads own safe account");
  await assert.rejects(transport.completeSignIn());
  console.log("PASS client cannot reuse completed flow");
  const org = await probe.createOrganization(
    owner.jar,
    "Desktop Device Org",
    `device-${probe.nonce}`,
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let deviceCredential = null;
  const device = new LumiDeviceHostTransport(probe.baseUrl, fetch, {
    async load() {
      return deviceCredential;
    },
    async save(value) {
      deviceCredential = value;
    },
  });
  const enrollment = await device.begin({
    org_slug: org.slug,
    public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    key_fingerprint: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    device_name: "Real client device",
    platform: "darwin-arm64",
    app_version: "3.14.3",
  });
  await transport.approveDeviceEnrollment(org.orgId, enrollment.enrollmentId);
  const proof = await device.challenge(enrollment.enrollmentId);
  const info = await device.complete(
    enrollment.enrollmentId,
    sign(null, Buffer.from(proof), privateKey).toString("hex"),
  );
  assert.equal(info.orgId, org.orgId);
  assert.equal(JSON.stringify(device), "{}");
  const policy = await device.policy();
  assert.equal(policy.org_id, org.orgId);
  await device.acknowledge(policy.policy_version);
  await device.refresh("3.14.3", async (nonce) =>
    sign(null, Buffer.from(nonce), privateKey).toString("hex"),
  );
  assert.equal(typeof deviceCredential?.token, "string");
  const expiredDeviceToken = deviceCredential.token;
  // Expire only this synthetic device's token in fresh local D1, preserving the active-device row.
  const tokenRows = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id='${info.id}' AND token_hash='${createHash("sha256").update(expiredDeviceToken).digest("hex")}' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    "pre-expiry token control",
  );
  probe.expect(
    "CONTROL: one live device token exists before forced expiry",
    Number(tokenRows[0]?.n) === 1,
    JSON.stringify(tokenRows),
  );
  probe.runWrangler(
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--env",
      "development",
      "--persist-to",
      probe.persistDir,
      "--command",
      `UPDATE device_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE device_id = '${info.id}'`,
    ],
    "force expiry on owned synthetic device",
  );
  const expiredRows = await probe.d1Rows(
    `SELECT token_hash FROM device_tokens WHERE device_id='${info.id}' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    "confirm token expiry",
  );
  probe.expect("device token is expired in stored D1 state", expiredRows.length === 0);
  const anonymousNonce = await probe.request(
    { header: () => "" },
    "GET",
    "/api/v1/devices/token/nonce",
    undefined,
    {},
  );
  probe.expectStatus("recovery did not reopen anonymous nonce", anonymousNonce, [401]);
  const activeDeviceHeader = { Authorization: `DeviceToken ${expiredDeviceToken}` };
  const deadNonce = await probe.request(
    { header: () => "" },
    "GET",
    "/api/v1/devices/token/nonce",
    undefined,
    activeDeviceHeader,
  );
  probe.expectStatus("expired device token cannot use ordinary refresh nonce", deadNonce, [401]);
  const anonymousChallenge = await probe.request(
    { header: () => "" },
    "POST",
    `/api/v1/orgs/${org.orgId}/devices/${info.id}/recovery-challenges`,
    { device_id: info.id },
    {},
  );
  probe.expectStatus(
    "anonymous caller cannot mint a recovery challenge",
    anonymousChallenge,
    [401],
  );
  // Cross-tenant negatives: a signed-in user of a DIFFERENT organization must not mint a challenge
  // for this org's device, neither through their own org path nor through the device's org path.
  const outsider = await probe.authenticatedUser("Recovery Outsider");
  for (const value of outsider.jar.cookies.values()) probe.registerSecret(value);
  const outsiderOrg = await probe.createOrganization(
    outsider.jar,
    "Recovery Outsider Org",
    `outsider-${probe.nonce}`,
  );
  const outsiderOwnOrg = await probe.request(
    outsider.jar,
    "POST",
    `/api/v1/orgs/${outsiderOrg.orgId}/devices/${info.id}/recovery-challenges`,
    { device_id: info.id },
    probe.browserMutation(outsider.jar, "recovery-outsider-own-org"),
  );
  probe.expectStatus(
    "cross-tenant: foreign device id is not found through the caller's own org",
    outsiderOwnOrg,
    [404],
  );
  const outsiderDeviceOrg = await probe.request(
    outsider.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/devices/${info.id}/recovery-challenges`,
    { device_id: info.id },
    probe.browserMutation(outsider.jar, "recovery-outsider-device-org"),
  );
  probe.expectStatus(
    "cross-tenant: non-member cannot mint a challenge in the device's org",
    outsiderDeviceOrg,
    [403, 404],
  );
  const foreignChallengeRows = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM device_token_recovery_challenges WHERE device_id='${info.id}'`,
    "cross-tenant attempts stored no challenge",
  );
  probe.expect(
    "cross-tenant attempts stored no recovery challenge",
    Number(foreignChallengeRows[0]?.n) === 0,
    JSON.stringify(foreignChallengeRows),
  );
  const expiredChallenge = await transport.createDeviceRecoveryChallenge(org.orgId, info.id);
  probe.expect(
    "human-authorized challenge is bounded",
    Date.parse(expiredChallenge.expiresAt) > Date.now() &&
      Date.parse(expiredChallenge.expiresAt) < Date.now() + 301_000,
  );
  const expiredHash = createHash("sha256").update(expiredChallenge.challenge).digest("hex");
  const badProofMessage = `lumi-device-token-recovery-v1\n${info.id}\n${expiredChallenge.challenge}`;
  await assert.rejects(
    transport.recoverDeviceToken(org.orgId, info.id, {
      challenge: expiredChallenge.challenge,
      signature: "0".repeat(128),
      appVersion: "3.14.3",
    }),
    (e) => e.status === 403,
  );
  // Measure state, not just the status: a refused proof must leave the challenge unconsumed and
  // mint no token.
  const afterWrongProof = await probe.d1Rows(
    `SELECT (SELECT COUNT(*) FROM device_token_recovery_challenges WHERE challenge_hash='${expiredHash}' AND consumed_at IS NULL) AS pending, (SELECT COUNT(*) FROM device_tokens WHERE device_id='${info.id}' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS live`,
    "state after wrong device proof",
  );
  probe.expect(
    "wrong device proof leaves the challenge unconsumed and mints no token",
    Number(afterWrongProof[0]?.pending) === 1 && Number(afterWrongProof[0]?.live) === 0,
    JSON.stringify(afterWrongProof),
  );
  probe.runWrangler(
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--env",
      "development",
      "--persist-to",
      probe.persistDir,
      "--command",
      `UPDATE device_token_recovery_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE challenge_hash = '${expiredHash}' AND device_id = '${info.id}'`,
    ],
    "expire owned synthetic recovery challenge",
  );
  const expiredChallengeRows = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM device_token_recovery_challenges WHERE challenge_hash = '${expiredHash}' AND expires_at <= '2001-01-01T00:00:00.000Z'`,
    "confirm recovery challenge expiry",
  );
  probe.expect("challenge expiry is stored in D1", Number(expiredChallengeRows[0]?.n) === 1);
  await assert.rejects(
    transport.recoverDeviceToken(org.orgId, info.id, {
      challenge: expiredChallenge.challenge,
      signature: sign(null, Buffer.from(badProofMessage), privateKey).toString("hex"),
      appVersion: "3.14.3",
    }),
    (e) => e.status === 409,
  );
  const afterExpiredChallenge = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id='${info.id}' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    "state after expired challenge",
  );
  probe.expect(
    "expired recovery challenge mints no token",
    Number(afterExpiredChallenge[0]?.n) === 0,
    JSON.stringify(afterExpiredChallenge),
  );
  const challenge = await transport.createDeviceRecoveryChallenge(org.orgId, info.id);
  const proofMessage = `lumi-device-token-recovery-v1\n${info.id}\n${challenge.challenge}`;
  const recovered = await transport.recoverDeviceToken(org.orgId, info.id, {
    challenge: challenge.challenge,
    signature: sign(null, Buffer.from(proofMessage), privateKey).toString("hex"),
    appVersion: "3.14.3",
  });
  probe.expect(
    "recovery returns rotated short-lived token",
    typeof recovered.deviceToken === "string" && Date.parse(recovered.expiresAt) > Date.now(),
  );
  await assert.rejects(
    transport.recoverDeviceToken(org.orgId, info.id, {
      challenge: challenge.challenge,
      signature: sign(null, Buffer.from(proofMessage), privateKey).toString("hex"),
      appVersion: "3.14.3",
    }),
    (e) => e.status === 409,
  );
  const afterReplay = await probe.d1Rows(
    `SELECT (SELECT COUNT(*) FROM device_token_recovery_challenges WHERE device_id='${info.id}') AS challenges, (SELECT COUNT(*) FROM device_tokens WHERE device_id='${info.id}' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS live`,
    "state after replayed challenge",
  );
  probe.expect(
    "consumed recovery challenge cannot replay: no challenge left, still one live token",
    Number(afterReplay[0]?.challenges) === 0 && Number(afterReplay[0]?.live) === 1,
    JSON.stringify(afterReplay),
  );
  console.log("PASS actual human-authorized expired-token recovery; anonymous nonce stays closed");
  // Ordinary device transport still holds the pre-recovery token, so directly verify the new token
  // against the real nonce route using the existing proof key, without storing it in a mock.
  const recoveryNonce = await probe.request(
    { header: () => "" },
    "GET",
    "/api/v1/devices/token/nonce",
    undefined,
    { Authorization: `DeviceToken ${recovered.deviceToken}` },
  );
  probe.expectStatus(
    "recovered token re-enters normal authenticated refresh",
    recoveryNonce,
    [200],
  );
  const orgRows = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id='${info.id}' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    "post-recovery token count",
  );
  probe.expect("single live rotated token stored", Number(orgRows[0]?.n) === 1);
  const recoveryAudit = await probe.d1Rows(
    `SELECT action FROM security_events WHERE resource_id='${info.id}' AND action='device.token_recovered.v1'`,
    "recovery audit",
  );
  probe.expect("successful recovery audit stored", recoveryAudit.length === 1);
  await device.adoptRecoveredToken(recovered);
  const recoveredPolicy = await device.policy();
  await device.acknowledge(recoveredPolicy.policy_version);
  console.log("PASS actual device client enrollment/policy/ack/nonce-refresh/recovery");
  const revoke = await probe.request(
    owner.jar,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${info.id}`,
    {},
    probe.browserMutation(owner.jar, "device-revoke"),
  );
  assert.equal(revoke.status, 204);
  await assert.rejects(device.policy(), (e) => e.status === 401 || e.status === 403);
  await assert.rejects(
    device.refresh("3.14.3", async (nonce) =>
      sign(null, Buffer.from(nonce), privateKey).toString("hex"),
    ),
    (e) => e.status === 401 || e.status === 403,
  );
  const rows = await probe.d1Rows(
    `SELECT status FROM devices WHERE device_id = '${info.id}'`,
    "stored revocation",
  );
  assert.equal(rows[0].status, "revoked");
  console.log("PASS revoked client policy/nonce-refresh refused; D1 revoked");
  await transport.signOut();
  await assert.rejects(transport.readAccount(), (e) => e.status === 401);
  assert.equal(probe.failures.length, 0);
  console.log("PASS actual backend logout ends client access");
  completed = probe.failures.length === 0;
} catch (error) {
  // Read the Worker's state BEFORE `finally` kills it. Bounded, read-only, never a replay of the request
  // that failed; the original error is rethrown unchanged so the failure is not softened.
  failureEvidence = await probe.captureFailureEvidence(error).catch((e) => ({
    capture_failed: String(e?.message ?? e).slice(0, 200),
  }));
  console.error(`--- request-boundary evidence ---\n${JSON.stringify(failureEvidence, null, 2)}`);
  throw error;
} finally {
  // Cleanup must run, and a git failure here must not mask the error that got us here.
  try {
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          verdict: completed ? "PASS" : "FAIL",
          control_plane_sha: git(root, "rev-parse", "HEAD"),
          control_plane_dirty:
            git(root, "status", "--porcelain", "--untracked-files=normal") !== "",
          lumi_agents_sha: git(client, "rev-parse", "HEAD"),
          lumi_agents_dirty:
            git(client, "status", "--porcelain", "--untracked-files=normal") !== "",
          assertions: probe.passes,
          failures: probe.failures,
          ...(failureEvidence ? { failure_evidence: failureEvidence } : {}),
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    probe.cleanup();
  }
}
