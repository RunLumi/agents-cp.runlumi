// A benign stdio MCP server for the managed MCP journey (DE2E-QA-MCP).
//
// The server is written into the synthetic profile and launched by the product's own MCP adapter
// (configured through the product's real config file). It exposes exactly one tool whose input
// schema declares a string `note` (so the development-only `mock://lumi-tool` provider may call it
// via `lumi-mock-call:<tool name>`). Calling it appends ONE line to an effect file inside the
// profile and returns a short text result. It never reads or writes anything else.
//
// The MCP SDK server is loaded from the already-installed LumiAgents client by absolute path
// (read-only; nothing is installed or built there).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const MCP_SERVER_NAME = "lumistub";
export const MCP_TOOL_NAME = "note";
/** The model-visible name Core registers (`mcp__<server>__<tool>`). */
export const MCP_TOOL_MODEL_NAME = `mcp__${MCP_SERVER_NAME}__${MCP_TOOL_NAME}`;
/** Stable name the managed identity carries (`mcp:<server>:<tool>`). */
export const MCP_TOOL_STABLE_NAME = `mcp:${MCP_SERVER_NAME}:${MCP_TOOL_NAME}`;
export const MCP_EFFECT_PREFIX = "lumi-mcp-effect";

/** Locate `@modelcontextprotocol/server` (+ its zod) inside the client's pnpm store. */
export function locateMcpServerSdk(client) {
  const store = join(client, "node_modules/.pnpm");
  const candidates = readdirSync(store)
    .filter((name) => /^@modelcontextprotocol\+server@\d/.test(name))
    .sort();
  assert.ok(candidates.length >= 1, "client ships @modelcontextprotocol/server");
  const modules = join(store, candidates.at(-1), "node_modules");
  const server = join(modules, "@modelcontextprotocol/server/dist/index.mjs");
  const stdio = join(modules, "@modelcontextprotocol/server/dist/stdio.mjs");
  const zod = join(modules, "zod/index.js");
  for (const path of [server, stdio, zod]) assert.ok(existsSync(path), `missing ${path}`);
  return { server, stdio, zod, version: candidates.at(-1) };
}

/** Write the stub server script into `dir` and return its path. */
export function writeMcpStubServer({ client, dir }) {
  const sdk = locateMcpServerSdk(client);
  const script = join(dir, "lumi-mcp-stub-server.mjs");
  writeFileSync(
    script,
    [
      "// Benign MCP stub for the Lumi managed MCP journey. Appends one line per call.",
      "import { appendFileSync } from 'node:fs';",
      `import { McpServer } from ${JSON.stringify(pathToFileURL(sdk.server).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(sdk.stdio).href)};`,
      `import * as z from ${JSON.stringify(pathToFileURL(sdk.zod).href)};`,
      "const effectLog = process.env.LUMI_MCP_EFFECT_LOG;",
      "if (!effectLog) throw new Error('LUMI_MCP_EFFECT_LOG is required');",
      `const server = new McpServer({ name: ${JSON.stringify(MCP_SERVER_NAME)}, version: '1.0.0' });`,
      "server.registerTool(",
      `  ${JSON.stringify(MCP_TOOL_NAME)},`,
      "  {",
      "    description: 'Append one benign note line to the Lumi e2e effect file.',",
      "    inputSchema: z.object({ note: z.string().max(200) }),",
      "  },",
      "  async ({ note }) => {",
      `    appendFileSync(effectLog, ${JSON.stringify(MCP_EFFECT_PREFIX)} + ' ' + JSON.stringify({ note, pid: process.pid }) + '\\n');`,
      "    return { content: [{ type: 'text', text: 'note recorded' }] };",
      "  },",
      ");",
      "await server.connect(new StdioServerTransport());",
      "",
    ].join("\n"),
  );
  return { script, sdk };
}

/** The stdio server config in the product's MCP config shape. */
export function mcpServerConfig({ script, effectLog }) {
  return {
    type: "stdio",
    command: process.execPath,
    args: [script],
    env: { LUMI_MCP_EFFECT_LOG: effectLog },
    timeoutMs: 20_000,
    enabled: true,
  };
}

/**
 * Configure the server through the product's real config files: the workspace `.zcode/config.json`
 * (`mcp.servers`, project scope; trusted and auto-connected by product decision) and the Agent home
 * `<home>/.zcode/cli/config.json` (user scope). Existing keys in either file are preserved.
 */
export function writeProductMcpConfig({ workspacePath, agentHome, server }) {
  const written = [];
  for (const path of [
    join(workspacePath, ".zcode", "config.json"),
    join(agentHome, ".zcode", "cli", "config.json"),
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    let current = {};
    if (existsSync(path)) current = JSON.parse(readFileSync(path, "utf8"));
    const mcp = { ...(current.mcp ?? {}) };
    mcp.servers = { ...(mcp.servers ?? {}), [MCP_SERVER_NAME]: server };
    const next = { ...current, mcp };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "w" });
    written.push(path);
  }
  return written;
}

/** Lines the stub appended (only lines carrying its prefix count). */
export function effectLines(effectLog) {
  if (!existsSync(effectLog)) return [];
  return readFileSync(effectLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`${MCP_EFFECT_PREFIX} `));
}
