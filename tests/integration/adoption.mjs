import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SmokeHarness } from "../../apps/api/scripts/lib/smoke-harness.mjs";
const output = process.env.LUMI_INTEGRATION_OUTPUT;
if (!output || !process.env.LUMI_INTEGRATION_CLIENT_BUNDLE)
  throw new Error("Use the integration runner");
const client = await import(pathToFileURL(process.env.LUMI_INTEGRATION_CLIENT_BUNDLE).href);
const probe = new SmokeHarness({ name: "LumiAgents adoption" });
const results = { verdict: "BLOCKED", assertions: [] };
const appVersion = process.env.LUMI_INTEGRATION_APP_VERSION;
assert.match(appVersion ?? "", /^\d+\.\d+\.\d+/);
function check(name, condition) {
  assert.ok(condition, name);
  results.assertions.push(name);
  console.log(`PASS ${name}`);
}
process.on("exit", () => probe.cleanup());
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
const anon = { header: () => "" };
try {
  delete process.env.LUMI_INTEGRATION_PERSIST;
  delete process.env.LUMI_INTEGRATION_PORT;
  await probe.setup({
    persistEnvVar: "LUMI_INTEGRATION_PERSIST",
    portEnvVar: "LUMI_INTEGRATION_PORT",
  });
  results.verdict = "FAIL";
  check("Worker build freshness established", probe.buildFreshness().ok === true);
  const owner = await probe.authenticatedUser("Integration Owner");
  const org = await probe.createOrganization(
    owner.jar,
    "Integration Alpha",
    `alpha-${probe.nonce}`,
  );
  const other = await probe.authenticatedUser("Integration Other");
  const bravo = await probe.createOrganization(
    other.jar,
    "Integration Bravo",
    `bravo-${probe.nonce}`,
  );
  for (const jar of [owner.jar, other.jar])
    for (const secret of jar.cookies.values()) probe.registerSecret(secret);
  const mutate = (jar, method, path, body, key = randomUUID()) =>
    probe.request(
      jar,
      method,
      path,
      body,
      probe.browserMutation(jar, key, { "Idempotency-Key": key }),
    );
  const payload = (r, status, label) => {
    check(`${label}: HTTP ${status}`, r.status === status);
    return r.payload;
  };
  const project = payload(
    await mutate(owner.jar, "POST", `/api/v1/orgs/${org.orgId}/projects`, {
      name: "Integration",
      slug: "integration",
      visibility: "org",
    }),
    201,
    "create project",
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const enrollment = payload(
    await probe.request(anon, "POST", "/api/v1/devices/enrollments", {
      org_slug: org.slug,
      public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
      key_fingerprint: createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      device_name: "Integration Device",
      platform: "linux-x64",
      app_version: appVersion,
    }),
    201,
    "begin device fixture",
  );
  payload(
    await mutate(
      owner.jar,
      "POST",
      `/api/v1/orgs/${org.orgId}/devices/enrollments/${enrollment.enrollment_id}/approve`,
      {},
    ),
    201,
    "approve device fixture",
  );
  const challenge = payload(
    await probe.request(anon, "GET", `/api/v1/devices/enrollments/${enrollment.enrollment_id}`),
    200,
    "challenge",
  );
  const completed = payload(
    await probe.request(
      anon,
      "POST",
      `/api/v1/devices/enrollments/${enrollment.enrollment_id}/complete`,
      { signature: sign(null, Buffer.from(challenge.challenge), privateKey).toString("hex") },
    ),
    201,
    "complete device",
  );
  probe.registerSecret(completed.device_token);
  const deviceId = completed.device.id;
  const projectId = project.id;
  check(
    "server-issued fixture IDs",
    /^prj_[a-f0-9]{32}$/.test(projectId) && /^dvc_[a-f0-9]{32}$/.test(deviceId),
  );
  const fingerprint = { protocol_major: 1, policy_schema_version: 1, app_version: appVersion };
  let calls = 0;
  let currentVersion;
  function decode(row) {
    const state = client.p08AdoptionStateSchema.parse({
      adoption_state_id: row.adoption_state_id,
      org_id: row.org_id,
      project_id: row.bound_project_id,
      device_id: row.bound_device_id,
      external: {
        installation_id: row.external_installation_id,
        workspace_key: row.external_workspace_key,
      },
      stage: row.stage,
      ownership: row.ownership,
      credential_mode: row.credential_mode,
      version: row.version,
      reversion_count: row.reversion_count,
    });
    currentVersion = state.version;
    return state;
  }
  // Host-owned DTO mapping; all state values come from real HTTP responses.
  const transport = {
    async getCompatibility({ fingerprint: fp }) {
      calls++;
      const row = payload(
        await probe.request(
          anon,
          "GET",
          `${client.buildP08AdoptionPath("compatibility")}?${new URLSearchParams(fp)}`,
        ),
        200,
        "compatibility",
      );
      check("same frozen contract", row.contract_version === client.P08_ADOPTION_CONTRACT_VERSION);
      check(
        "exact v1 protocol/schema ranges",
        JSON.stringify(row.supported_protocols) === "[1]" &&
          JSON.stringify(row.supported_policy_schema_versions) === "[1]",
      );
      const policy = client.p08CompatibilityPolicySchema.parse({
        protocol_major: 1,
        protocol_min: 1,
        protocol_max: 1,
        policy_schema_min: 1,
        policy_schema_max: 1,
        min_client_app_version: row.min_client_app_version,
        local_only_eligible: row.local_only_eligible,
        history_sync_eligible: row.history_sync_eligible,
      });
      check(
        "client and server compatibility agree",
        client.evaluateP08Compatibility(policy, fp) === row.client.state,
      );
      return { policy, verdict: row.client.state, stages: row.stages };
    },
    async createBinding({ orgId, body, idempotencyKey }) {
      calls++;
      return decode(
        payload(
          await mutate(
            owner.jar,
            "POST",
            client.buildP08AdoptionPath("bindings", { orgId }),
            {
              installation_id: body.external.installation_id,
              workspace_key: body.external.workspace_key,
              display_name: "Explicit test workspace",
              project_id: projectId,
              device_id: deviceId,
              stage: body.stage,
              credential_mode: body.credential_mode,
              client_protocol_major: fingerprint.protocol_major,
              policy_schema_version: fingerprint.policy_schema_version,
              client_app_version: fingerprint.app_version,
            },
            idempotencyKey,
          ),
          201,
          "record workspace",
        ),
      );
    },
    async advanceBinding({ orgId, stateId, body, idempotencyKey }) {
      calls++;
      return decode(
        payload(
          await mutate(
            owner.jar,
            "PATCH",
            client.buildP08AdoptionPath("binding", { orgId, stateId }),
            {
              stage: body.stage,
              credential_mode: body.credential_mode,
              version: body.expected_version,
            },
            idempotencyKey,
          ),
          200,
          `advance ${body.stage}`,
        ),
      );
    },
    async rollbackBinding({ orgId, stateId, idempotencyKey }) {
      calls++;
      const state = decode(
        payload(
          await mutate(
            owner.jar,
            "POST",
            client.buildP08AdoptionPath("rollback", { orgId, stateId }),
            { version: currentVersion },
            idempotencyKey,
          ),
          200,
          "rollback",
        ),
      );
      // Required port wrapper, not evidence about local files (never opened here).
      return { state, local_data_modified: false };
    },
  };
  const wizard = new client.P08AdoptionWizard({
    transport,
    fingerprint,
    workspaceKey: "workspace-alpha",
    installationId: "integration-installation-0001",
    nextIdempotencyKey: randomUUID,
  });
  const untouched = new client.P08AdoptionWizard({
    transport,
    workspaceKey: "workspace-personal",
    installationId: "integration-installation-0001",
    nextIdempotencyKey: randomUUID,
  });
  check(
    "local stage zero sends no HTTP",
    wizard.localStage0().ownership === "local_unmanaged" && calls === 0,
  );
  const compatibility = await wizard.checkCompatibility();
  check(
    "compatibility does not adopt",
    compatibility?.verdict === "supported" && wizard.state === undefined,
  );
  const state0 = await wizard.begin({ orgId: org.orgId });
  const stateId = state0.adoption_state_id;
  const readStored = () =>
    probe.d1Rows(
      `SELECT * FROM workspace_adoption_states WHERE adoption_state_id = '${stateId}'`,
      "read adoption",
    );
  check(
    "begin is still local",
    state0.stage === "local_unmanaged" && state0.ownership === "local_unmanaged",
  );
  const beforeSkip = calls;
  await assert.rejects(
    () => wizard.advance({ orgId: org.orgId, stage: "managed_policy", bindingComplete: true }),
    (e) => e.code === "adoption_stage_not_successor",
  );
  check("client rejects skipped stages before HTTP", calls === beforeSkip);
  for (const stage of [
    "account_optional",
    "device_enrolled",
    "workspace_bound",
    "managed_policy",
  ]) {
    const previous = wizard.state.version;
    const state = await wizard.advance({
      orgId: org.orgId,
      stage,
      bindingComplete: true,
      policy: compatibility.policy,
    });
    const [stored] = await readStored();
    const expected = ["workspace_bound", "managed_policy"].includes(stage)
      ? "org_managed"
      : "local_unmanaged";
    check(
      `client and D1 agree on ${stage}`,
      state.stage === stage &&
        stored.stage === stage &&
        state.ownership === expected &&
        stored.ownership === expected &&
        state.version === previous + 1 &&
        stored.version === state.version,
    );
  }
  const before = await readStored();
  const attack = await mutate(
    other.jar,
    "POST",
    client.buildP08AdoptionPath("rollback", { orgId: bravo.orgId, stateId }),
    { version: wizard.state.version },
  );
  check("foreign organization rollback refused", attack.status === 404);
  check(
    "foreign rollback leaves row identical",
    JSON.stringify(await readStored()) === JSON.stringify(before),
  );
  const rollback = await wizard.rollback({ orgId: org.orgId });
  const [stored] = await readStored();
  check(
    "rollback returns client and D1 to local",
    rollback.state.stage === "local_unmanaged" &&
      rollback.state.ownership === "local_unmanaged" &&
      stored.stage === "local_unmanaged" &&
      stored.ownership === "local_unmanaged" &&
      stored.reversion_count === 1 &&
      stored.bound_project_id === null &&
      stored.bound_device_id === null,
  );
  check(
    "second workspace stays local",
    untouched.state === undefined && untouched.localStage0().ownership === "local_unmanaged",
  );
  const rows = await probe.d1Rows(
    `SELECT COUNT(*) AS n FROM workspace_adoption_states WHERE org_id = '${org.orgId}'`,
    "count adoption",
  );
  check("only explicitly selected workspace persisted", rows[0].n === 1);
  const events = await probe.d1Rows(
    `SELECT action FROM security_events WHERE org_id = '${org.orgId}' AND resource_id = '${stateId}'`,
    "audit",
  );
  check(
    "rollback audit persisted",
    events.some((row) => row.action === "adoption.rolled_back"),
  );
  check("fixture/runtime assertions passed", probe.failures.length === 0);
  results.verdict = "PASS";
} catch (error) {
  results.error = probe.redact(error.message);
  console.error(`FAIL ${results.error}`);
  process.exitCode = results.verdict === "BLOCKED" ? 2 : 1;
} finally {
  writeFileSync(join(output, "journey.json"), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(join(output, "worker.log"), probe.workerLog());
  probe.cleanup();
}
