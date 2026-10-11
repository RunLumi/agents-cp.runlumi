import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "../.."),
  client = resolve(root, "integrations/lumi-agents");
const requireClient = createRequire(resolve(client, "package.json"));
const { build } = await import(pathToFileURL(requireClient.resolve("vite")).href);
const out = resolve(root, "test-results/client-tool-admission");
await build({
  configFile: false,
  logLevel: "warn",
  root: client,
  ssr: { noExternal: true },
  build: {
    ssr: resolve(client, "packages/services/src/lumi-account/deviceTransport.ts"),
    outDir: out,
    rollupOptions: { output: { entryFileNames: "device.mjs" } },
  },
});
const accountOut = resolve(out, "account-catalog");
await build({
  configFile: false,
  logLevel: "warn",
  root: client,
  ssr: { noExternal: true },
  build: {
    ssr: resolve(client, "packages/services/src/lumi-account/hostTransport.ts"),
    outDir: accountOut,
    rollupOptions: { output: { entryFileNames: "account.mjs" } },
  },
});
let coreModule, approvalModule;
if (process.env.P05_PROBE_AUTOMATIC_RESULT === "1") {
  const coreOut = resolve(out, "core-result");
  await build({
    configFile: false,
    logLevel: "warn",
    root: client,
    ssr: { noExternal: true },
    resolve: {
      alias: [
        {
          find: /^@zcode\/core$/,
          replacement: resolve(client, "apps/zcode-cli/packages/core/src/index.ts"),
        },
        {
          find: /^@zcode\/contracts$/,
          replacement: resolve(client, "apps/zcode-cli/packages/contracts/src/index.ts"),
        },
      ],
    },
    build: {
      ssr: resolve(client, "apps/zcode-cli/packages/bootstrap/test/integration-managed-result.ts"),
      outDir: coreOut,
      rollupOptions: { output: { format: "cjs", entryFileNames: "core-result.cjs" } },
    },
  });
  coreModule = resolve(coreOut, "core-result.cjs");
  const approvalOut = resolve(out, "approval-wait");
  await build({
    configFile: false,
    logLevel: "warn",
    root: client,
    ssr: { noExternal: true },
    build: {
      ssr: resolve(client, "packages/desktop/src/main/lumiManagedApprovalWait.ts"),
      outDir: approvalOut,
      rollupOptions: { output: { entryFileNames: "approval-wait.mjs" } },
    },
  });
  approvalModule = resolve(approvalOut, "approval-wait.mjs");
}
const child = spawn(process.execPath, [resolve(root, "apps/api/scripts/p05-smoke.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    P05_PROBE_EXECUTION_CLAIM: "1",
    P05_CLIENT_DEVICE_MODULE: resolve(out, "device.mjs"),
    P05_CLIENT_ACCOUNT_MODULE: resolve(accountOut, "account.mjs"),
    ...(coreModule ? { P05_CLIENT_CORE_RESULT_MODULE: coreModule } : {}),
    ...(approvalModule ? { P05_CLIENT_APPROVAL_WAIT_MODULE: approvalModule } : {}),
    P05_CLIENT_ARGUMENTS_MODULE: resolve(
      client,
      "apps/zcode-cli/packages/core/dist/tool/executor/managed-arguments.js",
    ),
  },
});
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
});
process.exitCode = code;
