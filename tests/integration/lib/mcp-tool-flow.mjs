// Identity derivation and public-route provisioning for the managed MCP journey (DE2E-QA-MCP).
//
// Everything that grants authority goes through the routes an organization admin uses: tool review,
// MCP registration + review, tool policy and agent definition. D1 is only READ to prove state.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_TOOL_MODEL_NAME, MCP_TOOL_STABLE_NAME } from "./mcp-stub-server.mjs";

export const MCP_CAPABILITY_ID = "cap_52400cf9b2bed9c8d552ddd56538c481";
export const MOCK_CALL_MARKER = "lumi-mock-call:";

/**
 * Bundle the client's real Core + MCP adapter (from source, read-only) and derive the identity of
 * `mcp__<server>__<tool>` by connecting the product adapter to the same stub server.
 */
export async function buildMcpIdentity({
  root,
  outDir,
  serverName,
  config,
  toolModelName = MCP_TOOL_MODEL_NAME,
  stableName = MCP_TOOL_STABLE_NAME,
  stringProperties = ["note"],
}) {
  const client = join(root, "integrations/lumi-agents");
  const packages = join(client, "apps/zcode-cli/packages");
  const requireClient = createRequire(join(client, "package.json"));
  const { build } = await import(pathToFileURL(requireClient.resolve("vite")).href);
  await build({
    configFile: false,
    logLevel: "warn",
    root: client,
    ssr: { noExternal: true },
    // Only the client's workspace sources are bundled. Third-party packages (some carry native
    // binaries, e.g. koffi) stay external and load from the client's own install by absolute path.
    plugins: [
      {
        name: "lumi-external-node-modules",
        enforce: "pre",
        async resolveId(source, importer, options) {
          if (!importer || source.startsWith("\0") || source.startsWith("@zcode/")) return null;
          if (source.startsWith(".") || source.startsWith("/")) return null;
          if (source.startsWith("node:")) return { id: source, external: true };
          const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
          if (
            resolved &&
            !resolved.external &&
            resolved.id.includes("/node_modules/") &&
            !resolved.id.includes("/node_modules/@zcode/")
          )
            return { id: resolved.id, external: "absolute" };
          return null;
        },
      },
    ],
    resolve: {
      alias: [
        { find: /^@zcode\/core$/, replacement: join(packages, "core/src/index.ts") },
        { find: /^@zcode\/contracts$/, replacement: join(packages, "contracts/src/index.ts") },
        {
          find: /^@zcode\/adapters\/mcp$/,
          replacement: join(packages, "adapters/src/mcp/index.ts"),
        },
      ],
    },
    build: {
      ssr: resolve(root, "tests/integration/lib/mcp-tool-identity.entry.ts"),
      outDir,
      emptyOutDir: true,
      rollupOptions: { output: { format: "cjs", entryFileNames: "mcp-tool-identity.cjs" } },
    },
  });
  const loaded = createRequire(import.meta.url)(join(outDir, "mcp-tool-identity.cjs"));
  const derived = await loaded.deriveMcpIdentity(serverName, config);
  const entry = derived.entries.find((item) => item.name === toolModelName);
  assert.ok(
    entry,
    `real adapter registered ${toolModelName}: ${JSON.stringify(derived.entries.map((e) => e.name))} status=${derived.status}`,
  );
  const { identity } = entry;
  assert.equal(identity.name, stableName);
  assert.equal(identity.source, "custom");
  assert.equal(identity.riskClass, "mcp");
  assert.deepEqual([...identity.capabilityIds], [MCP_CAPABILITY_ID]);
  assert.equal(identity.catalogued, false, "an unreviewed MCP tool is uncatalogued locally");
  for (const property of stringProperties)
    assert.equal(
      entry.inputSchema?.properties?.[property]?.type,
      "string",
      `model-facing schema declares a string ${property}`,
    );
  const descriptor = derived.descriptors.find(
    (item) => `mcp__${item.serverName}__${item.toolName}` === toolModelName,
  );
  return { identity, descriptor, inputSchema: entry.inputSchema };
}

export const BROWSER_POLICY = {
  allowed_domains: [],
  blocked_domains: [],
  allow_download: false,
  allow_upload: false,
  allow_authenticated: false,
  allow_clipboard: false,
  external_submit: "require_per_use_approval",
};
const COMPUTER_POLICY = {
  allow_accessibility: false,
  allow_screen_capture: false,
  allow_keyboard_mouse: false,
  allow_shell_escalation: false,
  allowed_applications: [],
};

function orgRequest(probe, fixture, orgId) {
  return async (method, path, body, key, label, status) => {
    const send = () =>
      probe.request(
        fixture,
        method,
        `/api/v1/orgs/${orgId}${path}`,
        body,
        method === "GET" ? undefined : probe.browserMutation(fixture, key),
      );
    // A read is retried once on a local transport hiccup (shared, loaded machine); a mutation never is.
    const result =
      method === "GET"
        ? await send().catch(async (error) => {
            if (!/transport failure/.test(String(error?.message))) throw error;
            await new Promise((done) => setTimeout(done, 2_000));
            return send();
          })
        : await send();
    probe.expectStatus(label, result, status);
    return result.payload;
  };
}

/**
 * Review the exact runtime MCP tool descriptor, register its stdio server, approve the server, and
 * create an agent allowed to use only that tool. Policy is set separately per stage.
 */
export async function provisionMcpPlane({
  probe,
  fixture,
  orgId,
  projectId,
  identity,
  script,
  agentName = "Electron managed MCP agent",
}) {
  const request = orgRequest(probe, fixture, orgId);
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
    "mcp-tool-review",
    "review the exact runtime MCP tool descriptor",
    201,
  );
  const toolId = tool?.tool_id ?? tool?.id;
  assert.match(toolId, /^tool_[0-9a-f]{32}$/);
  const created = await request(
    "POST",
    "/mcp",
    {
      source: "custom",
      transport: "stdio",
      command_metadata: { command: "node", arguments: [script.split("/").pop()] },
      tool_fingerprint: identity.fingerprint,
    },
    "mcp-registration",
    "register the stdio MCP server bound to the reviewed tool fingerprint",
    201,
  );
  const mcpId = created?.mcp_id ?? created?.id;
  assert.match(mcpId, /^mcp_[0-9a-f]{32}$/);
  assert.equal(created.policy_status, "pending_review", "a new MCP registration is unreviewed");
  const approved = await request(
    "PATCH",
    `/mcp/${mcpId}`,
    { version: created.version, policy_status: "approved" },
    "mcp-registration-approve",
    "approve the MCP registration",
    200,
  );
  assert.equal(approved.policy_status, "approved");
  const agent = await request(
    "POST",
    "/agents",
    {
      name: agentName,
      project_id: projectId,
      default_model_alias: "coding-tools",
      allowed_tool_ids: [toolId],
    },
    "mcp-tool-agent",
    "create agent allowed to use only the reviewed MCP tool",
    201,
  );
  assert.match(agent?.id, /^agd_[0-9a-f]{32}$/);
  return { toolId, mcpId, agentId: agent.id };
}

/** Replace the organization tool policy through the public route; returns the stored policy. */
export async function putToolPolicy({
  probe,
  fixture,
  orgId,
  toolId,
  mcpId,
  mode,
  label,
  browser = BROWSER_POLICY,
}) {
  const request = orgRequest(probe, fixture, orgId);
  const current = await request("GET", "/policy/tools", undefined, "", "read tool policy", 200);
  const version = current?.version ?? current?.policy?.version ?? 0;
  const allow = mode !== "deny_mcp";
  const body = {
    schema_version: 1,
    default_posture: "deny",
    default_approval_mode: "none",
    tool_ids: [toolId],
    mcp_ids: allow ? [mcpId] : [],
    denied_mcp_ids: allow ? [] : [mcpId],
    tool_approval_modes: { [toolId]: mode === "per_use" ? "per_use" : "none" },
    browser,
    computer: COMPUTER_POLICY,
    version,
  };
  return request("PUT", "/policy/tools", body, `mcp-policy-${label}`, `tool policy: ${label}`, 200);
}

export const mcpPrompt = (label) =>
  `Call the benign MCP note tool (${label}). ${MOCK_CALL_MARKER}${MCP_TOOL_MODEL_NAME} then report.`;
