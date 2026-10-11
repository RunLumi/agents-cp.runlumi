import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync, createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
const root = resolve(import.meta.dirname, "../..");
const requireWeb = createRequire(resolve(root, "apps/web/package.json"));
const requireClient = createRequire(resolve(root, "integrations/lumi-agents/package.json"));
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
  root: resolve(root, "integrations/lumi-agents"),
  ssr: { noExternal: true },
  build: {
    ssr: resolve(
      root,
      "integrations/lumi-agents/packages/services/src/lumi-account/hostTransport.ts",
    ),
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
  root: resolve(root, "integrations/lumi-agents"),
  ssr: { noExternal: true },
  build: {
    ssr: resolve(
      root,
      "integrations/lumi-agents/packages/services/src/lumi-account/deviceTransport.ts",
    ),
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
try {
  await probe.setup({ persistEnvVar: "DE2E_ACCOUNT_PERSIST", portEnvVar: "DE2E_ACCOUNT_PORT" });
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
  probe.expect("wrong device proof cannot recover token", true);
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
  probe.expect("expired recovery challenge is refused", true);
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
  probe.expect("consumed recovery challenge cannot replay", true);
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
  const projectSlug = `desktop-${probe.nonce.slice(0, 20)}`;
  const projectResult = await probe.request(
    owner.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    { name: "Desktop managed project", slug: projectSlug, visibility: "org" },
    probe.browserMutation(owner.jar, "desktop-managed-project"),
  );
  probe.expectStatus("create project for explicit workspace adoption", projectResult, [201]);
  const projectId = projectResult.payload?.id ?? projectResult.payload?.project?.id;
  assert.match(projectId, /^prj_[0-9a-f]{32}$/);
  const clientProjects = await transport.listProjects(org.orgId);
  probe.expect(
    "actual client lists the authorized project",
    clientProjects.some((project) => project.id === projectId && !project.archived),
  );
  const installationId = randomBytes(32).toString("hex");
  const workspaceKey = randomBytes(32).toString("hex");
  const privateWorkspacePath = "/Users/private/Customer Project";
  const workspaceDisplayName = "Customer Project";
  const workspaceBinding = await device.createWorkspaceBinding({
    projectId,
    workspaceIdentity: workspaceKey,
    displayName: workspaceDisplayName,
    environmentType: "local",
  });
  probe.expect(
    "P03 device transport binds only the opaque workspace key",
    workspaceBinding.workspaceIdentity === workspaceKey &&
      !JSON.stringify(workspaceBinding).includes(privateWorkspacePath),
  );
  await device.acknowledge((await device.policy()).policy_version);
  const adoption = await transport.createAdoptionRecord(
    {
      orgId: org.orgId,
      installationId,
      workspaceKey,
      displayName: workspaceDisplayName,
      projectId,
      deviceId: info.id,
      clientAppVersion: "3.14.3",
    },
    randomUUID(),
  );
  probe.expect(
    "P08 real client creates local-only stage with selected project/device",
    adoption.stage === "local_unmanaged" &&
      adoption.ownership === "local_unmanaged" &&
      adoption.projectId === projectId &&
      adoption.deviceId === info.id,
  );
  const skippedStage = await probe.request(
    owner.jar,
    "PATCH",
    `/api/v1/orgs/${org.orgId}/adoption/bindings/${adoption.adoptionStateId}`,
    {
      stage: "managed_policy",
      credential_mode: "local_credential",
      version: adoption.version,
      client_protocol_major: 1,
      policy_schema_version: 1,
      client_app_version: "3.14.3",
    },
    probe.browserMutation(owner.jar, "p08-stage-skip"),
  );
  probe.expectStatus("server refuses a client stage skip", skippedStage, [409]);
  let adoptionState = adoption;
  for (const stage of [
    "account_optional",
    "device_enrolled",
    "workspace_bound",
    "managed_policy",
  ]) {
    if (stage === "workspace_bound" || stage === "managed_policy") {
      const policy = await device.policy();
      await device.acknowledge(policy.policy_version);
    }
    adoptionState = await transport.advanceAdoptionRecord(
      {
        orgId: org.orgId,
        adoptionStateId: adoption.adoptionStateId,
        stage,
        version: adoptionState.version,
        clientAppVersion: "3.14.3",
      },
      randomUUID(),
    );
    const storedAdoption = await probe.d1Rows(
      `SELECT stage, ownership, bound_project_id, bound_device_id, external_workspace_key FROM workspace_adoption_states WHERE adoption_state_id = '${adoption.adoptionStateId}'`,
      `stored P08 stage ${stage}`,
    );
    probe.expect(
      `P08 ${stage} is server-owned and stored`,
      storedAdoption[0]?.stage === stage &&
        storedAdoption[0]?.bound_project_id === projectId &&
        storedAdoption[0]?.bound_device_id === info.id &&
        storedAdoption[0]?.external_workspace_key === workspaceKey &&
        storedAdoption[0]?.ownership ===
          (stage === "workspace_bound" || stage === "managed_policy"
            ? "org_managed"
            : "local_unmanaged"),
    );
  }
  await device.deleteWorkspaceBinding(workspaceBinding.id);
  const rolledBack = await transport.rollbackAdoptionRecord(
    {
      orgId: org.orgId,
      adoptionStateId: adoption.adoptionStateId,
      version: adoptionState.version,
    },
    randomUUID(),
  );
  probe.expect(
    "P08 rollback returns local ownership without touching workspace content",
    rolledBack.stage === "local_unmanaged" && rolledBack.ownership === "local_unmanaged",
  );
  const localBindingRows = await probe.d1Rows(
    `SELECT binding_id FROM workspace_bindings WHERE binding_id = '${workspaceBinding.id}' AND removed_at IS NULL`,
    "verify P03 workspace binding removed",
  );
  probe.expect("P03 binding removed on rollback", localBindingRows.length === 0);
  const retainedBindings = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM workspace_bindings WHERE binding_id = '${workspaceBinding.id}' AND removed_at IS NOT NULL`,
    "verify removed P03 binding retained for history",
  );
  probe.expect(
    "removed P03 binding preserves historical identity",
    Number(retainedBindings[0]?.n) === 1,
  );
  const rollbackRow = await probe.d1Rows(
    `SELECT stage, ownership, reversion_count FROM workspace_adoption_states WHERE adoption_state_id = '${adoption.adoptionStateId}'`,
    "verify P08 rollback stored",
  );
  probe.expect(
    "P08 rollback state and history are durable",
    rollbackRow[0]?.stage === "local_unmanaged" &&
      rollbackRow[0]?.ownership === "local_unmanaged" &&
      Number(rollbackRow[0]?.reversion_count) === 1,
  );
  console.log(
    "PASS actual P03/P08 client transport bind, staged adoption, policy acknowledgement and rollback",
  );
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
} finally {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        verdict: completed ? "PASS" : "FAIL",
        control_plane_sha: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        control_plane_dirty:
          execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
            cwd: root,
            encoding: "utf8",
          }).trim() !== "",
        lumi_agents_sha: execFileSync(
          "git",
          ["-C", resolve(root, "integrations/lumi-agents"), "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim(),
        lumi_agents_dirty:
          execFileSync(
            "git",
            [
              "-C",
              resolve(root, "integrations/lumi-agents"),
              "status",
              "--porcelain",
              "--untracked-files=normal",
            ],
            { encoding: "utf8" },
          ).trim() !== "",
        assertions: probe.passes,
        failures: probe.failures,
      },
      null,
      2,
    ) + "\n",
  );
  probe.cleanup();
}
