import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
const root = resolve(import.meta.dirname, "../..");
const requireWeb = createRequire(resolve(root, "apps/web/package.json"));
const { build } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
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
process.on("exit", () => probe.cleanup());
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
  const device = new LumiDeviceHostTransport(probe.baseUrl);
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
  console.log("PASS actual device client enrollment/policy/ack/nonce-refresh");
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
} finally {
  probe.cleanup();
}
