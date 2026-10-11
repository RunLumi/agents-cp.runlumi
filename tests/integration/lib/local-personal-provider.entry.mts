// Declared extension of local-personal-provider.mjs: the parts that must run through the client's own TypeScript
// (config codec, registry, AutomationRepo). Fixture/readback only; nothing here changes product behaviour.
//
// usage (via runEntry: process.execPath --import <client>/node_modules/tsx/dist/loader.mjs; never the tsx CLI):
//   write <personal-config-path> <spec-json>        validate + encode + write provider_config.json
//   resolve <builtin-config-path> <personal-path>   real registry + facade preferred-selection read (no Electron)
//   seed-bad-model <tasks-index.sqlite> <json>      one automation with an explicit, absent model selection
// Every mode prints one JSON document on stdout. No real credential is ever read or written.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const client = resolve(import.meta.dirname, "../../../integrations/lumi-agents");
const load = (relative: string) => import(pathToFileURL(resolve(client, relative)).href);

interface ProviderSpec {
  providerId: string;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  reasoningValues: string[];
  defaultReasoningLevel: string;
  contextWindow: number;
  maxOutputTokens: number;
}

/** The stored (schemaVersion 1) shape; it is decoded by the repository codec below, so any drift fails loudly. */
function storedConfig(spec: ProviderSpec) {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [spec.providerId],
      providerConfigRules: {
        providerRules: [
          {
            providerId: spec.providerId,
            providerName: spec.providerName,
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: spec.apiKey },
              api: { type: "openai-chat-completions", baseUrl: spec.baseUrl },
              personalModelIds: [spec.modelId],
              modelOrder: [spec.modelId],
              visibility: "visible",
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [
          {
            providerId: spec.providerId,
            modelId: spec.modelId,
            config: {
              enabled: true,
              properties: {
                contextWindow: spec.contextWindow,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: false,
                inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
              },
              optionSpecs: {
                reasoningLevel: { values: spec.reasoningValues, map: "{}" },
                maxOutputTokens: { max: spec.maxOutputTokens },
              },
            },
          },
        ],
      },
      defaultModelSelection: {
        providerId: spec.providerId,
        modelId: spec.modelId,
        options: { reasoningLevel: spec.defaultReasoningLevel },
      },
    },
  };
}

async function write(personalPath: string, raw: string) {
  const { decodeProviderConfigFile, encodeProviderConfigFile } = await load(
    "packages/provider-node/src/index.ts",
  );
  const spec = JSON.parse(raw) as ProviderSpec;
  const decoded = decodeProviderConfigFile(storedConfig(spec));
  const encoded = encodeProviderConfigFile(decoded);
  // Decode the encoded form again: the file we write must itself be loadable by the product.
  decodeProviderConfigFile(encoded);
  await mkdir(dirname(personalPath), { recursive: true });
  await writeFile(personalPath, `${JSON.stringify(encoded)}\n`, { mode: 0o600 });
  return { personalPath, providerId: spec.providerId, modelId: spec.modelId, defaultModelSelection: encoded.config.defaultModelSelection };
}

async function resolveView(builtinPath: string, personalPath: string) {
  const { NodeProviderRegistryRuntime, createNodeModelSelectionFacade } = await load(
    "packages/provider-node/src/index.ts",
  );
  const stored = JSON.parse(await readFile(personalPath, "utf8"));
  const configuredDefault = stored.config?.defaultModelSelection;
  const runtime = new NodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: builtinPath,
    personalFilePath: personalPath,
    personalPollingIntervalMs: false,
    watch: false,
  });
  try {
    await runtime.start();
    const view = createNodeModelSelectionFacade(runtime.registryService).getView(configuredDefault);
    return {
      configuredDefault: configuredDefault ?? null,
      preferredSelection: view.preferredSelection ?? null,
      visibleProviders: view.providers.map((provider: { providerId: string }) => provider.providerId),
    };
  } finally {
    runtime.dispose();
  }
}

async function seedBadModel(dbPath: string, raw: string) {
  const { AutomationRepo } = await load("packages/services/src/node.ts");
  const spec = JSON.parse(raw) as {
    title: string;
    cronExpr: string;
    prompt: string;
    workspacePath: string;
    nextRunAt: number;
    maxRuns?: number;
    modelSelection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
  };
  const repo = new AutomationRepo(dbPath);
  try {
    await repo.ensureReady();
    const row = await repo.create(
      {
        title: spec.title,
        cronExpr: spec.cronExpr,
        prompt: spec.prompt,
        workspacePath: spec.workspacePath,
        recurring: true,
        ...(spec.maxRuns ? { maxRuns: spec.maxRuns } : {}),
        modelSelection: spec.modelSelection,
      },
      { nextRunAt: spec.nextRunAt },
    );
    return { automationId: row.automationId, title: row.title };
  } finally {
    repo.close();
  }
}

const [mode, first, second] = process.argv.slice(2);
let result: unknown;
if (mode === "write" && first && second) result = await write(first, second);
else if (mode === "resolve" && first && second) result = await resolveView(first, second);
else if (mode === "seed-bad-model" && first && second) result = await seedBadModel(first, second);
else throw new Error("usage: local-personal-provider.entry <write|resolve|seed-bad-model> <a> <b>");
process.stdout.write(JSON.stringify(result));
