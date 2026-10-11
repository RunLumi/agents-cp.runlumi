// Server-side provisioning and public-API approval helpers for the Electron
// managed tool flow (P04-CR-002 / DE2E-INT-04).
//
// Everything here goes through the same public routes an organization admin uses:
// catalog, route, tool review, tool policy, agent definition and approval
// resolution. There is no direct handler call and no D1 seeding of authority; D1
// is only READ to prove stored state.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const TOOL_ALIAS = "coding-tools";
export const MOCK_WRITE_MARKER = "lumi-mock-write:";
export const MOCK_WRITE_BASENAME_PREFIX = "lumi-e2e-fixture-";
export const MOCK_WRITE_CONTENT = "lumi mock tool fixture content\n";

/** Build the real Core descriptor bundle and return the identity the Write tool derives. */
export async function buildWriteIdentity(root, outDir) {
  const client = join(root, "integrations/lumi-agents");
  const requireClient = createRequire(join(client, "package.json"));
  const { build } = await import(pathToFileURL(requireClient.resolve("vite")).href);
  const core = join(client, "apps/zcode-cli/packages/core/src/index.ts");
  const contracts = join(client, "apps/zcode-cli/packages/contracts/src/index.ts");
  await build({
    configFile: false,
    logLevel: "warn",
    root: client,
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^@zcode\/core$/, replacement: core },
        { find: /^@zcode\/contracts$/, replacement: contracts },
      ],
    },
    build: {
      ssr: resolve(root, "tests/integration/lib/write-tool-identity.entry.ts"),
      outDir,
      emptyOutDir: true,
      rollupOptions: { output: { format: "cjs", entryFileNames: "write-tool-identity.cjs" } },
    },
  });
  const loaded = createRequire(import.meta.url)(join(outDir, "write-tool-identity.cjs"));
  const { identity, inputProperties } = loaded;
  assert.equal(identity.name, "Write");
  assert.equal(identity.source, "built_in");
  assert.equal(identity.riskClass, "filesystem_write");
  assert.ok(identity.capabilityIds.length >= 1, "Write requires a filesystem capability");
  assert.ok(
    inputProperties.includes("file_path") && inputProperties.includes("content"),
    "Write descriptor exposes file_path/content",
  );
  return identity;
}

/** Provider + model + credential + published route for the development-only tool fixture. */
export async function provisionToolRoute({ probe, fixture, orgId }) {
  const call = async (method, path, body, key, label, status = 201) => {
    const result = await probe.request(
      fixture,
      method,
      `/api/v1/orgs/${orgId}${path}`,
      body,
      probe.browserMutation(fixture, key),
    );
    probe.expectStatus(label, result, status);
    return result.payload;
  };
  const providerPayload = await call(
    "POST",
    "/catalog/providers",
    {
      provider_key: "electron-mock-tool",
      display_name: "Electron controlled tool provider",
      adapter: "mock",
      endpoint_url: "mock://lumi-tool",
    },
    "electron-tool-provider",
    "create development-only controlled tool provider",
  );
  const providerId = providerPayload?.provider?.provider_id;
  assert.match(providerId, /^prv_[0-9a-f]{32}$/);
  const modelPayload = await call(
    "POST",
    "/catalog/models",
    {
      provider_id: providerId,
      provider_model_id: "mock-tool",
      display_name: "Electron controlled tool model",
      capabilities: ["text", "tools"],
      max_input_tokens: 1_000_000,
      max_output_tokens: 8_192,
      pricing_version: "electron-e2e-tool-v1",
    },
    "electron-tool-model",
    "create tool-capable controlled model",
  );
  const modelId = modelPayload?.model?.model_id;
  assert.match(modelId, /^mdl_[0-9a-f]{32}$/);
  const secret = `electron-${probe.nonce}-tool-credential`;
  probe.registerSecret(secret);
  const credentialPayload = await call(
    "POST",
    "/credentials",
    {
      provider_id: providerId,
      owner_type: "organization",
      label: "Electron controlled tool provider",
      secret,
    },
    "electron-tool-credential",
    "create controlled tool provider credential",
  );
  const credentialId = credentialPayload?.credential?.credential_id;
  assert.match(credentialId, /^cred_[0-9a-f]{32}$/);
  const config = {
    strategy: "fixed",
    candidates: [
      {
        provider_id: providerId,
        model_id: modelId,
        weight: 100,
        timeout_ms: 5000,
        max_retries: 0,
        credential_id: credentialId,
      },
    ],
  };
  const route = await call(
    "POST",
    "/routes",
    {
      alias: TOOL_ALIAS,
      display_name: "Electron controlled tool route",
      strategy: "fixed",
      config,
    },
    "electron-tool-route",
    "create controlled tool route",
  );
  const routeId = route?.route?.route_id;
  assert.match(routeId, /^rte_[0-9a-f]{32}$/);
  await call(
    "POST",
    `/routes/${routeId}/publish`,
    { version: route.route.version, config },
    "electron-tool-route-publish",
    "publish controlled tool route",
    200,
  );
  return { providerId, modelId };
}

/**
 * Review the exact runtime Write descriptor, allow it by policy with per-use
 * approval, and create an agent permitted to use only that reviewed tool.
 */
export async function provisionToolPlane({ probe, fixture, orgId, projectId, identity }) {
  const request = async (method, path, body, key, label, status) => {
    const result = await probe.request(
      fixture,
      method,
      `/api/v1/orgs/${orgId}${path}`,
      body,
      probe.browserMutation(fixture, key),
    );
    probe.expectStatus(label, result, status);
    return result.payload;
  };
  const tool = await request(
    "POST",
    "/tools",
    {
      name: identity.name,
      source: identity.source,
      risk_class: identity.riskClass,
      capability_ids: [...identity.capabilityIds],
      fingerprint: identity.fingerprint,
    },
    "electron-write-tool",
    "review the exact runtime Write descriptor",
    201,
  );
  const toolId = tool?.tool_id ?? tool?.id;
  assert.match(toolId, /^tool_[0-9a-f]{32}$/);
  await request(
    "PUT",
    "/policy/tools",
    {
      schema_version: 1,
      default_posture: "deny",
      default_approval_mode: "none",
      tool_ids: [toolId],
      mcp_ids: [],
      tool_approval_modes: { [toolId]: "per_use" },
      browser: {
        allowed_domains: [],
        blocked_domains: [],
        allow_download: false,
        allow_upload: false,
        allow_authenticated: false,
        allow_clipboard: false,
        external_submit: "require_per_use_approval",
      },
      computer: {
        allow_accessibility: false,
        allow_screen_capture: false,
        allow_keyboard_mouse: false,
        allow_shell_escalation: false,
        allowed_applications: [],
      },
      version: 0,
    },
    "electron-write-policy",
    "allow Write only with per-use approval",
    200,
  );
  const agent = await request(
    "POST",
    "/agents",
    {
      name: "Electron managed tool agent",
      project_id: projectId,
      default_model_alias: TOOL_ALIAS,
      allowed_tool_ids: [toolId],
    },
    "electron-tool-agent",
    "create agent allowed to use only the reviewed Write tool",
    201,
  );
  const agentId = agent?.id;
  assert.match(agentId, /^agd_[0-9a-f]{32}$/);
  return { toolId, agentId };
}

export function fixtureTarget(workspacePath, label, nonce) {
  return join(workspacePath, `${MOCK_WRITE_BASENAME_PREFIX}${label}-${nonce.slice(0, 12)}.txt`);
}

export function toolPrompt(path) {
  return `Write the fixture file ${MOCK_WRITE_MARKER}${path} then report.`;
}

/** Newest run of an agent as stored by the Worker, once it exists. */
export async function waitForRun({ probe, orgId, agentId }) {
  const rows = await probe.waitForD1(
    "managed tool run starts",
    `SELECT run_id, state FROM runs WHERE org_id = '${orgId}' AND agent_definition_id = '${agentId}' ORDER BY created_at DESC LIMIT 1`,
    (result) => result.length === 1,
    60_000,
  );
  return rows[0];
}

/** Poll the public approval list until this run has a pending approval. */
export async function waitForPendingApproval({
  probe,
  fixture,
  orgId,
  runId,
  diagnose,
  onPoll,
  timeoutMs = 120_000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (onPoll) await onPoll();
    const result = await probe.request(
      fixture,
      "GET",
      `/api/v1/orgs/${orgId}/approvals?status=pending&run_id=${runId}`,
    );
    probe.expectStatus("list pending approvals for the managed tool run", result, 200);
    const items = result.payload?.items ?? result.payload?.data ?? [];
    if (items.length > 0) {
      assert.equal(items.length, 1, "exactly one pending approval for the single tool call");
      return items[0];
    }
    await delay(500);
  }
  const screen = diagnose ? await diagnose().catch(() => "") : "";
  throw new Error(
    `no pending approval appeared for the managed tool call${screen ? `; renderer shows: ${screen}` : ""}`,
  );
}

export async function resolveApproval({ probe, fixture, orgId, approval, decision, reason }) {
  const result = await probe.request(
    fixture,
    "POST",
    `/api/v1/orgs/${orgId}/approvals/${approval.id}/resolve`,
    { decision, version: approval.version, ...(reason ? { reason } : {}) },
    probe.browserMutation(fixture, `electron-approval-${decision}-${approval.id}`),
  );
  probe.expectStatus(`resolve approval ${decision}`, result, 200);
  return result.payload;
}
