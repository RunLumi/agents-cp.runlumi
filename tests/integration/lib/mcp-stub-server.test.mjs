// Focused controls for mcp-stub-server.mjs (DE2E-QA-MCP). Synthetic scratch directories only.
// Run: node --test tests/integration/lib/mcp-stub-server.test.mjs
// The live stub test needs the installed LumiAgents client (MCP SDK, read-only) and is skipped
// when it is absent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  effectLines,
  MCP_EFFECT_PREFIX,
  MCP_SERVER_NAME,
  MCP_TOOL_NAME,
  mcpServerConfig,
  writeMcpStubServer,
  writeProductMcpConfig,
} from "./mcp-stub-server.mjs";

const client = resolve(import.meta.dirname, "../../../integrations/lumi-agents");

test("product MCP config is merged into both real config files without dropping keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-mcp-config-"));
  const workspacePath = join(dir, "workspace");
  const agentHome = join(dir, "home");
  mkdirSync(join(workspacePath, ".zcode"), { recursive: true });
  writeFileSync(
    join(workspacePath, ".zcode", "config.json"),
    JSON.stringify({ keep: 1, mcp: { servers: { other: { type: "stdio", command: "x" } } } }),
  );
  const server = mcpServerConfig({ script: "/s.mjs", effectLog: "/e.log" });
  const written = writeProductMcpConfig({ workspacePath, agentHome, server });
  assert.equal(written.length, 2);
  const workspace = JSON.parse(readFileSync(written[0], "utf8"));
  assert.equal(workspace.keep, 1);
  assert.deepEqual(Object.keys(workspace.mcp.servers).sort(), ["lumistub", "other"]);
  const home = JSON.parse(readFileSync(join(agentHome, ".zcode", "cli", "config.json"), "utf8"));
  assert.equal(home.mcp.servers[MCP_SERVER_NAME].type, "stdio");
  assert.equal(home.mcp.servers[MCP_SERVER_NAME].env.LUMI_MCP_EFFECT_LOG, "/e.log");
});

test("effect lines only count the stub's own prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-mcp-effects-"));
  const log = join(dir, "effects.log");
  assert.deepEqual(effectLines(log), [], "a missing file is zero lines, not an error");
  writeFileSync(log, `noise\n${MCP_EFFECT_PREFIX} {"note":"a"}\n\n${MCP_EFFECT_PREFIX}x\n`);
  assert.equal(effectLines(log).length, 1);
});

test(
  "the stub declares a string note and appends exactly one line per call over real stdio MCP",
  { skip: !existsSync(join(client, "node_modules/.pnpm")) && "client not installed" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "lumi-mcp-stub-"));
    const effectLog = join(dir, "effects.log");
    const { script } = writeMcpStubServer({ client, dir });
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, LUMI_MCP_EFFECT_LOG: effectLog },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buffer = "";
    const waiting = new Map();
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        waiting.get(message.id)?.(message);
      }
    });
    let id = 0;
    const call = (method, params) =>
      new Promise((done) => {
        id += 1;
        waiting.set(id, done);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      const init = await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lumi-test", version: "1" },
      });
      assert.ok(init.result?.serverInfo, JSON.stringify(init));
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
      const list = await call("tools/list", {});
      const tool = list.result.tools.find((item) => item.name === MCP_TOOL_NAME);
      assert.equal(tool?.inputSchema?.properties?.note?.type, "string");
      assert.equal(effectLines(effectLog).length, 0, "listing never calls the tool");
      const result = await call("tools/call", {
        name: MCP_TOOL_NAME,
        arguments: { note: "unit" },
      });
      assert.equal(result.result?.isError ?? false, false, JSON.stringify(result));
      const lines = effectLines(effectLog);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /"note":"unit"/);
    } finally {
      child.kill();
    }
  },
);
