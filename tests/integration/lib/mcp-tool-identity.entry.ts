// Bundle entry for the managed MCP journey harness (never shipped).
//
// The identity the server catalog must hold for `mcp__<server>__<tool>` is the one the REAL Core
// path derives: the product's stdio MCP adapter connects to the same stub server the Desktop Agent
// will launch, lists its tools, `registerMcpTools` registers them into a real ToolRegistry exactly
// as the runtime does (no host managed projection), and `resolveManagedToolIdentity` resolves the
// entry. Nothing is hand-copied, so a descriptor/schema change moves the fingerprint and the
// managed gate then denies the call as uncatalogued, which the journey reports instead of hiding.
import { createToolRegistry, registerMcpTools, resolveManagedToolIdentity } from "@zcode/core";
import { createMcpAdapter } from "@zcode/adapters/mcp";

export async function deriveMcpIdentity(serverName: string, config: Record<string, unknown>) {
  const port = createMcpAdapter();
  try {
    const status = await port.connectServer(serverName, config as never);
    const descriptors = (await port.listTools()).filter((tool) => tool.serverName === serverName);
    const registry = createToolRegistry();
    const registered = registerMcpTools(registry, port, descriptors);
    const entries = registered.map((name) => {
      const entry = registry.get(name);
      if (!entry) throw new Error(`registered MCP tool ${name} is missing from the registry`);
      return {
        name,
        identity: resolveManagedToolIdentity(entry),
        inputSchema: entry.inputSchema,
      };
    });
    return {
      status: (status as { status?: string }).status ?? null,
      descriptors: descriptors.map((tool) => ({
        serverName: tool.serverName,
        toolName: tool.toolName,
        inputSchema: tool.inputSchema,
      })),
      entries,
    };
  } finally {
    await (port as { close?: () => Promise<void> }).close?.();
  }
}
