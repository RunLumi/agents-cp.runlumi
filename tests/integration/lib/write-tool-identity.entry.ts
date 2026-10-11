// Bundle entry for the Electron tool-flow harness (never shipped).
//
// The identity the server catalog must hold is the one the REAL built-in `Write`
// descriptor derives in Core's own registry, not a hand-copied name/fingerprint.
// Importing the product modules keeps the review row and the runtime in lockstep:
// any descriptor change moves the fingerprint and the managed gate then denies the
// call as uncatalogued, which the harness would report instead of hiding.
import {
  createToolRegistry,
  registerBuiltInTools,
  resolveManagedToolIdentity,
} from "@zcode/core";

const registry = createToolRegistry();
registerBuiltInTools(registry, { allowedTools: ["Write"], silentDuplicateWarnings: true });
const entry = registry.get("Write");
if (!entry) throw new Error("Write is not a registered built-in tool");

export const identity = resolveManagedToolIdentity(entry);
export const inputProperties = Object.keys(
  (entry.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
);
