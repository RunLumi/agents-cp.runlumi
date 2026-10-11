# Local control: preferred-model resolution handoff

Lane: read-only investigation (parent). Product, client, Rust, harness, CI, STATUS untouched. No runtime launched.
Parent head `e7ad897` + dirty tree; client `2a495254`. Evidence: `evidence/automation-full-isolated-race-fail.{log,json}`,
`evidence/automation-isolated-schedule-runtime.log`.

## 1. What the failed run actually shows

- `automation-full-isolated-race-fail`: onboard=PASS, adopt=PASS, **schedule=UNPROVEN**, race=FAIL
  (`contested occurrence ended failed`, `automation-stage-race.mjs:204`), restart/faults not run.
- The control claim that PASSed is weaker than the goal. `automation-stage-schedule.mjs:200-215` accepts
  `dispatch_attempts > 0 || run_count > 0 || !!last_error` as "the unmarked control was dispatched locally".
  A row with only `last_error` set (dispatch failed) satisfies it. **This counts an attempt, not completed Agent
  execution, and must not be reported as local personal work being usable.**
- Neither log records the control row's `last_error`, its `automation_runs.error`, or any task for it.
  The text `Automation 无法从目标 Host 解析首选模型` / `Automation 模型选择不可用…` appears in no evidence file (grep over docs/tests).

## 2. Traced path (source-confirmed)

1. Fixture: `tests/integration/lib/seed-local-automations.mts` calls `AutomationRepo.create({title,cronExpr,prompt,workspacePath,recurring})`
   with **no `modelSelection`**. `automationRepo.ts:384` stores `serialize(undefined) ?? "null"` => JSON `"null"` = "follow workspace".
2. Scheduler (`desktop/src/scheduler/index.ts:193-208`) posts `cron-dispatch-request` carrying `automation.modelSelection` (undefined).
   Main forwards it unchanged (`desktopCronScheduler.ts:122-158`).
3. Host `dispatchCronRun` (`desktop/src/host/index.ts:910-941`) -> `resolveAutomationSubmissionModelSelection`
   (`host/automationModelSelection.ts:5-28`). `getModelSelectionForDispatch` returns undefined for `"null"`, so it falls to
   `modelSelectionService.getView().preferredSelection` and **throws `Automation 无法从目标 Host 解析首选模型`** unless that selection
   exists and has `options.reasoningLevel`. The throw happens before `createTask`, so no Agent task exists; the catch marks the run failed
   and the scheduler settles `failed_to_dispatch` -> `markDispatchFailed` (`last_error`).
4. `preferredSelection` (`provider/src/facades.ts:541-552`, `model-selection-config.ts:28-55`) = `configuredDefault`
   (`provider_config.json` `defaultModelSelection`) if selectable, else the first **non-hidden** provider's first model with a top reasoning level,
   else `source:"none"` (no preferredSelection).
5. The managed overlay (`provider/src/lumi-managed-provider-source.ts:60-123`) registers `lumi-managed` as `visibility:"hidden"`, so it is never
   the registry fallback and `isSelectable` rejects it as a configured default. Adoption therefore cannot supply or steal the control's model.
   Correct, and it matches `inference-v1.md:32` ("never silently replaced") and F11 FR-F11-004 ("do not let desktop silently override org policy").

So the control's model comes only from the **local** provider catalog/default in the isolated profile. The harness gives that profile none:
`grep PERSONAL_PROVIDER|provider_config tests/integration scripts` is empty; the only providers configured in the journey are Worker-side
(`create success provider`, routes) for the managed path. Nothing seeds `provider_config.json` (path env `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`,
file name `provider_config.json`, `provider-node/src/runtime-paths.ts`).

## 3. Status of the root-cause claim

- CONFIRMED from source: with no local default and no visible provider/model with a reasoning level, the seeded control cannot be dispatched
  (`preferred` throw), and the stage's assertion still passes. The goal (local personal work usable) cannot be certified by the current check.
- UNPROVEN until read from the retained profile: that this exact message is the control's `last_error` in run `lumi-automation-a-VPdMKK`.
  I could not open the DB (outside the allowed directory, no approval in this session). Alternative causes to exclude with the same read:
  `no local host available` (transient, retried), builtin catalog visible-but-keyless (then dispatch would succeed and fail later in the Agent),
  or the Agent failing on a missing credential after task creation.
- Not the cause of the `race` failure: that is the contested occurrence (other primary's lane).

Supervisor command (read-only, copy first; DB is `home/.zcode/v2/tasks-index.sqlite` with `-wal`):

```bash
P=/Volumes/SSD/agents-cp.runlumi/test-results/t/lumi-automation-a-VPdMKK/home/.zcode/v2
mkdir -p /tmp/lcm && cp "$P"/tasks-index.sqlite* /tmp/lcm/
sqlite3 /tmp/lcm/tasks-index.sqlite "select title,dispatch_status,dispatch_attempts,run_count,last_error from automations where title='Local control';"
sqlite3 /tmp/lcm/tasks-index.sqlite "select dispatch_status,attempts,error,model_selection from automation_runs where automation_id=(select automation_id from automations where title='Local control');"
```

Expected if the diagnosis is right: `last_error`/`error` contains `无法从目标 Host 解析首选模型` and `model_selection` is NULL.

## 4. Smallest correct fix surface (harness/fixture only; product is correct)

Do not change the product resolver, org policy, or add a default org agent. Do not move the control to another workspace.

1. **Seed a synthetic local provider before first launch** (isolated profile only): write `<profile>/home/.zcode/provider_config.json`
   (schemaVersion 1, `config.{providerConfigRules,modelConfigRules,defaultModelSelection}`; build it with the repo's own
   `encodeProviderConfigFile` via `tsx`, like `seed-local-automations.mts` does for `AutomationRepo`, instead of hand-writing JSON) containing
   one personal provider with `baseUrl` = a loopback stub, a dummy `apiKey` (`sk-synthetic-…`, no personal credentials), one model with a reasoning
   level, and `defaultModelSelection` pointing at it. Set `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` and `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` **together**
   (`resolveNodeProviderRuntimePaths` throws if only one is given) in `lumi-child-env.mjs`/`lumi-desktop-app.mjs`, inside the profile.
   Verify the actual env var wiring against `desktopRuntimeEnv.ts` before relying on it.
2. **Loopback stub provider** (new small harness module, e.g. `tests/integration/lib/local-provider-stub.mjs`): an OpenAI-compatible
   `/chat/completions` responder returning a fixed reply and counting requests. No egress, no cost.
3. **Stage schedule**: replace the weak predicate at `automation-stage-schedule.mjs:203` with a completed-execution positive control, evaluated
   **before adoption** and **again after** it: (a) control run `dispatch_status` dispatched, no `last_error`; (b) a task exists for the control
   workspace with an assistant message holding the stub's fixed reply and a terminal marker; (c) stub saw exactly one request per control run;
   (d) after adoption the same control keeps working with the same `defaultModelSelection` bytes (read `provider_config.json` hash before/after),
   and the stub request count for the adopted original stays 0 (only the managed path ran it; its inference goes to Worker `/v1`, not the stub).
4. Keep the second assertion already present (adopted original byte-identical, zero local `automation_runs`). Add: the local control's run and the
   managed run use different `providerId`s (`stub` vs `lumi-managed`), proving managed mode did not replace local BYOK
   (`inference-v1.md:32,64`, F11 FR-F11-004, F26 line 62 "Local BYOK remains available only if org policy permits": the harness org policy must
   keep local BYOK permitted, not be loosened to pass).
5. Report dispatch-only outcomes as UNPROVEN/FAIL, never as the control claim.

Cross-tenant/negative control to keep: seed a second control variant with an explicit `modelSelection` that is not in the catalog and expect the
`模型选择不可用` rejection (no silent fallback), so the fixture cannot pass by the resolver being permissive.

## 5. Order of work for whoever owns the harness

1. Run the Section 3 read to turn the diagnosis from CONFIRMED-in-source into CONFIRMED-in-evidence (no rebuild needed).
2. Implement 4.1-4.2, run only the pre-adoption positive control first (the control must complete with no adoption involved).
3. Then 4.3-4.4 across adoption. If the pre-adoption control fails, the defect is the fixture, not adoption.

## 6. Not done / limits

- No claim about the `race` failure beyond the log; no external provider, personal profile, deploy, or runtime launch.
- Builtin catalog behavior in a keyless isolated profile was not observed; Section 3 read decides whether the failure is the `preferred` throw
  or a later Agent failure.

## 7. Harness intent and checkpoint (primary localcontrol lane, 2026-10-09)

**Diagnosis now CONFIRMED in evidence.** `test-results/local-control-retained-readback.json` (owned synthetic retained profile, selected
columns): `Local control` has `model_selection="null"`, `dispatch_attempts=3`, `run_count=0` and
`last_error="Automation 无法从目标 Host 解析首选模型"`. This is the §2 step 3 throw: the isolated profile has no local default and no visible
provider/model with a reasoning level. The product resolver, org policy and adoption are correct; the defect is the fixture plus the weak
predicate (`dispatch_attempts > 0 || run_count > 0 || !!last_error`).

**Harness-only change.** No product, client, Rust, CI, index, branch or STATUS edit; no full runtime or build launched by this lane.

1. `tests/integration/lib/local-personal-provider.mjs` (NEW): loopback OpenAI-compatible stub (bounded, header names only, no bodies, no real
   key), profile-owned config writer, and the completed-run readback. The config is produced by the repository's own
   `decodeProviderConfigFile` / `encodeProviderConfigFile` through the declared extension below, never hand-written.
2. Declared extension `tests/integration/lib/local-personal-provider.entry.mts` (NEW; same precedent as `seed-local-automations.mts`):
   `write` (validate + encode + write `provider_config.json`), `resolve` (real `NodeProviderRegistryRuntime` + `createNodeModelSelectionFacade`
   preferred-selection read, no Electron), `seed-bad-model` (AutomationRepo with an explicit absent model).
3. Narrow edits: `lumi-child-env.mjs` (pure `localProviderEnv`, builtin and personal env set together, inside the profile),
   `desktop-automation-electron.mjs` (start stub, write config BEFORE first launch, seed `Local preflight` (maxRuns 1, due at launch) and the
   bad-model negative, pre-adoption positive after onboard), `automation-stage-schedule.mjs` (replace the weak predicate; post-adoption positive,
   config hash unchanged, adopted original zero stub requests).

**Invariants.** The control stays in the SAME workspace and its `model_selection` stays `"null"` (follow the Host default) before and after
adoption. The default is a synthetic personal provider, never org/managed and never seeded authority; org policy keeps local BYOK permitted.
PASS needs `automation_runs.dispatch_status=dispatched`, `outcome=succeeded`, `error` NULL AND a `completed` Agent task whose assistant text
holds the stub marker. An attempt, a `last_error` or a dispatched-only row is FAIL/UNPROVEN. Stub counts are bounded (cap, 429 beyond) and
attributed by prompt-marker presence (booleans), never content.

**Checkpoint (implemented, not yet proven in Electron).** Files: NEW `lib/local-personal-provider.{mjs,entry.mts,test.mjs}`; edited
`lib/lumi-child-env.mjs`, `lib/automation-stage-schedule.mjs`, `desktop-automation-electron.mjs`. Local proof:
`node --test tests/integration/lib/local-personal-provider.test.mjs` 9/9 (codec accepts the config; the REAL registry resolves it as preferred
with a reasoning level; the original profile resolves NO preferred selection; the verifier marks the retained failure shape FAILED). Sibling
suites 47 pass / 0 fail. NOT proven: any Electron run, the Agent actually calling the loopback stub, the post-adoption control. UNPROVEN until
the supervisor-owned window runs `--until=schedule`.
Resume: re-read these files, `git status`, the supervisor's window/keystore state; do not trust this checkpoint as runtime proof.
