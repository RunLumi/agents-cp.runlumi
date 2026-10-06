import assert from "node:assert/strict";
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
  await transport.signOut();
  await assert.rejects(transport.readAccount(), (e) => e.status === 401);
  assert.equal(probe.failures.length, 0);
  console.log("PASS actual backend logout ends client access");
} finally {
  probe.cleanup();
}
