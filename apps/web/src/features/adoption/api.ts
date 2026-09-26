/**
 * P08 adoption client.
 *
 * Built against the IMPLEMENTED backend (`apps/api/src/routes/migration.rs`,
 * contract gate `p08-cg-v1`) and the frozen fixture
 * `docs/implementation/fixtures/p08-contracts-v1.json`.
 *
 * Four deliberate rules shape this module, and each exists because a migration
 * UI is where a privacy leak would be least expected:
 *
 * 1. **Nothing here sends local content.** There is no request type with a field
 *    for a prompt, a file, a path, a secret, or an automation body. The
 *    credential call sends a *mode*; the telemetry call sends a stage, a result,
 *    and an optional reason from the frozen vocabulary; the import call sends a
 *    description of what a local automation needs, not the automation. The
 *    module is the second half of the server's guarantee, and a future field
 *    added here would be a reviewable diff.
 * 2. **Every decoder is an ALLOWLIST.** It copies named fields out of the wire
 *    object and never spreads it, so a key the server adds later cannot reach
 *    component state.
 * 3. **Unknown enum values decode to `null`, never to a default.** A stage or
 *    remediation code this build does not know must render as "unrecognized" —
 *    never as a stage Lumi claims the user reached.
 * 4. **The transport is feature-local**, reusing `@/lib/errors` for every failure
 *    path so `presentApiError` still owns the shared presentation. The shape
 *    matches `features/data-governance/api.ts` exactly so the two can be merged
 *    behind one export when that is worth doing.
 */

import { apiErrorFromEnvelope, makeInvalidResponseError, makeTransportError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Frozen vocabulary
// ---------------------------------------------------------------------------

/**
 * The F26 stages, in adoption order. The order is the whole point: it is the
 * ladder a user walks up one rung at a time, and the panel renders it as such
 * rather than as a status.
 */
export const ADOPTION_STAGES = [
  "local_unmanaged",
  "account_optional",
  "device_enrolled",
  "workspace_bound",
  "managed_policy",
  "history_sync",
] as const;
export type AdoptionStage = (typeof ADOPTION_STAGES)[number];

export const OWNERSHIP_STATES = ["local_unmanaged", "org_managed"] as const;
export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

/**
 * Credential modes, in escalation order: the safest is first and the only one
 * that copies a secret is last. The wizard offers them in this order so the
 * default position and the risky position are both explicit.
 */
export const CREDENTIAL_MODES = [
  "local_credential",
  "metadata_only",
  "org_managed_credential",
] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

export const TELEMETRY_RESULTS = [
  "started",
  "completed",
  "skipped",
  "failed",
  "declined",
  "rolled_back",
] as const;
export type TelemetryResult = (typeof TELEMETRY_RESULTS)[number];

export const REMEDIATION_CODES = [
  "client_outdated",
  "protocol_unsupported",
  "policy_sync_failed",
  "credential_missing",
  "capability_unsupported",
  "workspace_unbound",
] as const;
export type RemediationCode = (typeof REMEDIATION_CODES)[number];

export const REMEDIES = [
  "upgrade_client",
  "reconnect_device",
  "rebind_workspace",
  "choose_credential_mode",
  "review_tool_policy",
  "dismiss",
] as const;
export type Remedy = (typeof REMEDIES)[number];

export const IMPORT_CONFLICT_CODES = [
  "automation_not_available",
  "automation_limit_reached",
  "tool_not_permitted",
  "model_capability_unavailable",
  "off_peak_not_entitled",
  "workspace_unbound",
  "local_credential_not_permitted",
] as const;
export type ImportConflictCode = (typeof IMPORT_CONFLICT_CODES)[number];

/** `MAX_IMPORT_CANDIDATES` in `modules/migration`. */
export const MAX_IMPORT_CANDIDATES = 50;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CompatibilityClientVerdict {
  state: string | null;
  mode: string | null;
  local_only_available: boolean;
  managed_allowed: boolean;
  reason: string | null;
  min_client_app_version: string | null;
}

export interface Compatibility {
  contract_version: string;
  supported_protocols: number[];
  supported_policy_schema_versions: number[];
  min_client_app_version: string;
  local_only_eligible: boolean;
  history_sync_eligible: boolean;
  client: CompatibilityClientVerdict | null;
  stages: AdoptionStage[];
}

export interface WorkspaceAdoption {
  adoption_state_id: string;
  org_id: string;
  external_installation_id: string;
  external_workspace_key: string;
  display_name: string;
  bound_project_id: string | null;
  bound_device_id: string | null;
  stage: AdoptionStage | null;
  ownership: OwnershipState | null;
  credential_mode: CredentialMode | null;
  rolled_back_from_stage: AdoptionStage | null;
  client_protocol_major: number;
  policy_schema_version: number;
  client_app_version: string;
  reversion_count: number;
  is_adopted: boolean;
  is_managed: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Remediation {
  remediation_id: string;
  adoption_state_id: string | null;
  device_id: string | null;
  code: RemediationCode | null;
  /** The stored code, even when this build does not recognize it. */
  raw_code: string;
  remedy: Remedy | null;
  stage: AdoptionStage | null;
  state: "open" | "resolved" | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DerivedRemediation {
  adoption_state_id: string;
  code: RemediationCode | null;
  raw_code: string;
  remedy: Remedy | null;
  stage: AdoptionStage | null;
}

export interface StageCount {
  stage: AdoptionStage | null;
  raw_stage: string;
  count: number;
}

export interface EventCount {
  stage: AdoptionStage | null;
  raw_stage: string;
  result: TelemetryResult | null;
  raw_result: string;
  count: number;
}

export interface AdoptionSummary {
  org_id: string;
  contract_version: string;
  compatibility: {
    supported_protocols: number[];
    supported_policy_schema_versions: number[];
    local_only_eligible: boolean;
    history_sync_eligible: boolean;
  };
  counts: {
    adopted_workspaces: number;
    managed_workspaces: number;
    open_remediations: number;
  };
  stage_counts: StageCount[];
  event_counts: EventCount[];
  bindings: WorkspaceAdoption[];
  remediations: Remediation[];
  derived_remediations: DerivedRemediation[];
  actor_role: string;
}

export interface ImportPreviewItem {
  local_key: string;
  importable: boolean;
  conflicts: { code: ImportConflictCode | null; raw_code: string; subject: string | null }[];
}

export interface ImportPreview {
  org_id: string;
  tool_policy_scope: string;
  model_capability_check: string;
  items: ImportPreviewItem[];
  importable_count: number;
  blocked_count: number;
  commit_ready: boolean;
  local_automations_modified: boolean;
}

/** One local automation, described. There is deliberately nowhere to put a body. */
export interface ImportCandidate {
  local_key: string;
  schedule_kind: "one_time" | "cron" | "interval" | "manual";
  required_tools?: string[];
  required_model_capabilities?: string[];
  uses_off_peak?: boolean;
  credential_mode: CredentialMode;
}

export interface AdvanceStageInput {
  stage: AdoptionStage;
  credential_mode?: CredentialMode;
  client_protocol_major?: number;
  policy_schema_version?: number;
  client_app_version?: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Contract error
// ---------------------------------------------------------------------------

/**
 * A response did not match the frozen contract.
 *
 * A distinct type from `ApiClientError` on purpose: this one means the control
 * plane and this build disagree, which is an operator problem, and the panel
 * renders it differently from a request that simply failed.
 */
export class AdoptionContractError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`adoption contract mismatch at ${field}`);
    this.name = "AdoptionContractError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface P08RequestOptions extends Omit<RequestInit, "body" | "method"> {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && value.length <= 256 ? value : undefined;
}

function normalizeRequestId(value: string | null): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 160 ? normalized : undefined;
}

function isRetryableStatus(status: number, code: string | undefined, retrySafe: boolean): boolean {
  if (!retrySafe) return false;
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    code === "idempotency_in_progress"
  );
}

function readApiErrorCode(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

async function requestJson<T>(
  path: string,
  options: P08RequestOptions,
  decode: (value: unknown) => T,
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (!isSafeMethod(method)) {
    const csrf = readCookie("lumi_csrf");
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  const { body, idempotencyKey: _key, ...requestInit } = options;
  const init: RequestInit = {
    ...requestInit,
    method,
    headers,
    credentials: "include",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const retrySafe = isSafeMethod(method) || options.idempotencyKey !== undefined;

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw makeTransportError(cause, options.signal ?? undefined, { retryable: retrySafe });
  }

  const requestId = normalizeRequestId(response.headers.get("X-Request-ID"));
  let responseText: string;
  try {
    responseText = await response.text();
  } catch (cause) {
    throw makeTransportError(cause, options.signal ?? undefined, {
      requestId,
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let payload: unknown;
  let validJson = responseText.length > 0;
  if (validJson) {
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch {
      validJson = false;
    }
  }
  if (!response.ok) {
    const apiCode = readApiErrorCode(payload);
    throw apiErrorFromEnvelope(
      response.status,
      validJson ? payload : undefined,
      requestId,
      isRetryableStatus(response.status, apiCode, retrySafe),
    );
  }
  if (response.status === 204) return undefined as T;
  let decoded: T;
  try {
    decoded = decode(payload);
  } catch (cause) {
    if (cause instanceof AdoptionContractError) throw cause;
    throw makeInvalidResponseError({ requestId, status: response.status });
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Allowlist decoders
// ---------------------------------------------------------------------------

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdoptionContractError(field);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string") throw new AdoptionContractError(field);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) throw new AdoptionContractError(field);
  return normalized;
}

function readOptionalString(value: unknown, field: string, max = 256): string | null {
  if (value === null || value === undefined) return null;
  return readString(value, field, max);
}

function readTimestamp(value: unknown, field: string): string {
  const raw = readString(value, field, 64);
  if (Number.isNaN(Date.parse(raw))) throw new AdoptionContractError(field);
  return raw;
}

function readVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AdoptionContractError(field);
  }
  return value;
}

function readCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AdoptionContractError(field);
  }
  return value;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AdoptionContractError(field);
  return value;
}

function readNumberList(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new AdoptionContractError(field);
  return value.map((item, index) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item)) {
      throw new AdoptionContractError(`${field}[${index}]`);
    }
    return item;
  });
}

/**
 * Strict enum read: a required value outside the frozen set fails the response.
 *
 * Used only where the server cannot honestly continue — a stage, a mode, a
 * result — so a mismatch is an operator problem rather than a display detail.
 */
function readEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new AdoptionContractError(field);
  }
  return value as T[number];
}

/**
 * Lenient enum read: a value outside the frozen set decodes to `null` alongside
 * the raw string.
 *
 * This is the fail-closed direction for honesty fields. A remediation or stage
 * code this build does not recognize must still render — as "unrecognized", with
 * the raw value available for support — and never as a state Lumi claims the
 * user is in.
 */
function readKnownEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export function decodeCompatibility(value: unknown): Compatibility {
  const record = objectValue(value, "compatibility");
  const clientRecord = record.client;
  const client =
    typeof clientRecord === "object" && clientRecord !== null && !Array.isArray(clientRecord)
      ? {
          state: readOptionalString(
            (clientRecord as Record<string, unknown>).state,
            "client.state",
            64,
          ),
          mode: readOptionalString(
            (clientRecord as Record<string, unknown>).mode,
            "client.mode",
            64,
          ),
          local_only_available:
            (clientRecord as Record<string, unknown>).local_only_available === true,
          managed_allowed: (clientRecord as Record<string, unknown>).managed_allowed === true,
          reason: readOptionalString(
            (clientRecord as Record<string, unknown>).reason,
            "client.reason",
            96,
          ),
          min_client_app_version: readOptionalString(
            (clientRecord as Record<string, unknown>).min_client_app_version,
            "client.min_client_app_version",
            64,
          ),
        }
      : null;
  return {
    contract_version: readString(record.contract_version, "contract_version", 64),
    supported_protocols: readNumberList(record.supported_protocols, "supported_protocols"),
    supported_policy_schema_versions: readNumberList(
      record.supported_policy_schema_versions,
      "supported_policy_schema_versions",
    ),
    min_client_app_version: readString(record.min_client_app_version, "min_client_app_version", 64),
    local_only_eligible: readBoolean(record.local_only_eligible, "local_only_eligible"),
    history_sync_eligible: readBoolean(record.history_sync_eligible, "history_sync_eligible"),
    client,
    stages: (() => {
      if (!Array.isArray(record.stages)) throw new AdoptionContractError("stages");
      return record.stages.map((stage, index) =>
        readEnum(stage, ADOPTION_STAGES, `stages[${index}]`),
      );
    })(),
  };
}

export function decodeWorkspaceAdoption(value: unknown): WorkspaceAdoption {
  const record = objectValue(value, "binding");
  return {
    adoption_state_id: readString(record.adoption_state_id, "adoption_state_id", 64),
    org_id: readString(record.org_id, "org_id", 64),
    // The client's own opaque identifiers. They are not paths, and the panel
    // never renders them as anything but an identifier.
    external_installation_id: readString(
      record.external_installation_id,
      "external_installation_id",
      128,
    ),
    external_workspace_key: readString(
      record.external_workspace_key,
      "external_workspace_key",
      256,
    ),
    display_name: readString(record.display_name, "display_name", 120),
    bound_project_id: readOptionalString(record.bound_project_id, "bound_project_id", 64),
    bound_device_id: readOptionalString(record.bound_device_id, "bound_device_id", 64),
    stage: readKnownEnum(record.stage, ADOPTION_STAGES),
    ownership: readKnownEnum(record.ownership, OWNERSHIP_STATES),
    credential_mode: readKnownEnum(record.credential_mode, CREDENTIAL_MODES),
    rolled_back_from_stage: readKnownEnum(record.rolled_back_from_stage, ADOPTION_STAGES),
    client_protocol_major: readCount(record.client_protocol_major, "client_protocol_major"),
    policy_schema_version: readCount(record.policy_schema_version, "policy_schema_version"),
    client_app_version: readString(record.client_app_version, "client_app_version", 32),
    reversion_count: readCount(record.reversion_count, "reversion_count"),
    is_adopted: record.is_adopted === true,
    is_managed: record.is_managed === true,
    version: readVersion(record.version, "version"),
    created_at: readTimestamp(record.created_at, "created_at"),
    updated_at: readTimestamp(record.updated_at, "updated_at"),
  };
}

export function decodeRemediation(value: unknown): Remediation {
  const record = objectValue(value, "remediation");
  const rawCode = readString(record.code, "code", 64);
  const rawRemedy = readString(record.remedy, "remedy", 64);
  return {
    remediation_id: readString(record.remediation_id, "remediation_id", 64),
    adoption_state_id: readOptionalString(record.adoption_state_id, "adoption_state_id", 64),
    device_id: readOptionalString(record.device_id, "device_id", 64),
    code: readKnownEnum(rawCode, REMEDIATION_CODES),
    raw_code: rawCode,
    remedy: readKnownEnum(rawRemedy, REMEDIES),
    stage: readKnownEnum(record.stage, ADOPTION_STAGES),
    state: readKnownEnum(record.state, ["open", "resolved"] as const),
    resolved_by_user_id: readOptionalString(record.resolved_by_user_id, "resolved_by_user_id", 64),
    resolved_at:
      record.resolved_at === null || record.resolved_at === undefined
        ? null
        : readTimestamp(record.resolved_at, "resolved_at"),
    version: readVersion(record.version, "version"),
    created_at: readTimestamp(record.created_at, "created_at"),
    updated_at: readTimestamp(record.updated_at, "updated_at"),
  };
}

export function decodeDerivedRemediation(value: unknown): DerivedRemediation {
  const record = objectValue(value, "derived_remediation");
  const rawCode = readString(record.code, "derived.code", 64);
  const rawRemedy = readString(record.remedy, "derived.remedy", 64);
  return {
    adoption_state_id: readString(record.adoption_state_id, "derived.adoption_state_id", 64),
    code: readKnownEnum(rawCode, REMEDIATION_CODES),
    raw_code: rawCode,
    remedy: readKnownEnum(rawRemedy, REMEDIES),
    stage: readKnownEnum(record.stage, ADOPTION_STAGES),
  };
}

export function decodeAdoptionSummary(value: unknown): AdoptionSummary {
  const record = objectValue(value, "adoption");
  const compatibilityRecord = objectValue(record.compatibility, "adoption.compatibility");
  const counts = objectValue(record.counts, "adoption.counts");
  if (!Array.isArray(record.bindings)) throw new AdoptionContractError("bindings");
  if (!Array.isArray(record.remediations)) throw new AdoptionContractError("remediations");
  if (!Array.isArray(record.derived_remediations))
    throw new AdoptionContractError("derived_remediations");
  if (!Array.isArray(record.stage_counts)) throw new AdoptionContractError("stage_counts");
  if (!Array.isArray(record.event_counts)) throw new AdoptionContractError("event_counts");
  return {
    org_id: readString(record.org_id, "org_id", 64),
    contract_version: readString(record.contract_version, "contract_version", 64),
    compatibility: {
      supported_protocols: readNumberList(
        compatibilityRecord.supported_protocols,
        "compatibility.supported_protocols",
      ),
      supported_policy_schema_versions: readNumberList(
        compatibilityRecord.supported_policy_schema_versions,
        "compatibility.supported_policy_schema_versions",
      ),
      local_only_eligible: readBoolean(
        compatibilityRecord.local_only_eligible,
        "compatibility.local_only_eligible",
      ),
      history_sync_eligible: readBoolean(
        compatibilityRecord.history_sync_eligible,
        "compatibility.history_sync_eligible",
      ),
    },
    counts: {
      adopted_workspaces: readCount(counts.adopted_workspaces, "counts.adopted_workspaces"),
      managed_workspaces: readCount(counts.managed_workspaces, "counts.managed_workspaces"),
      open_remediations: readCount(counts.open_remediations, "counts.open_remediations"),
    },
    stage_counts: record.stage_counts.map((entry, index) => {
      const item = objectValue(entry, `stage_counts[${index}]`);
      const raw = readString(item.stage, `stage_counts[${index}].stage`, 64);
      return {
        stage: readKnownEnum(raw, ADOPTION_STAGES),
        raw_stage: raw,
        count: readCount(item.count, `stage_counts[${index}].count`),
      };
    }),
    event_counts: record.event_counts.map((entry, index) => {
      const item = objectValue(entry, `event_counts[${index}]`);
      const rawStage = readString(item.stage, `event_counts[${index}].stage`, 64);
      const rawResult = readString(item.result, `event_counts[${index}].result`, 64);
      return {
        stage: readKnownEnum(rawStage, ADOPTION_STAGES),
        raw_stage: rawStage,
        result: readKnownEnum(rawResult, TELEMETRY_RESULTS),
        raw_result: rawResult,
        count: readCount(item.count, `event_counts[${index}].count`),
      };
    }),
    bindings: record.bindings.map(decodeWorkspaceAdoption),
    remediations: record.remediations.map(decodeRemediation),
    derived_remediations: record.derived_remediations.map(decodeDerivedRemediation),
    actor_role: readString(record.actor_role, "actor_role", 32),
  };
}

export function decodeImportPreview(value: unknown): ImportPreview {
  const record = objectValue(value, "import_preview");
  if (!Array.isArray(record.items)) throw new AdoptionContractError("items");
  return {
    org_id: readString(record.org_id, "org_id", 64),
    tool_policy_scope: readString(record.tool_policy_scope, "tool_policy_scope", 64),
    model_capability_check: readString(record.model_capability_check, "model_capability_check", 64),
    items: record.items.map((entry, index) => {
      const item = objectValue(entry, `items[${index}]`);
      if (!Array.isArray(item.conflicts)) {
        throw new AdoptionContractError(`items[${index}].conflicts`);
      }
      return {
        local_key: readString(item.local_key, `items[${index}].local_key`, 64),
        importable: item.importable === true,
        conflicts: item.conflicts.map((conflict, conflictIndex) => {
          const entryValue = objectValue(conflict, `items[${index}].conflicts[${conflictIndex}]`);
          const raw = readString(
            entryValue.code,
            `items[${index}].conflicts[${conflictIndex}].code`,
            96,
          );
          return {
            code: readKnownEnum(raw, IMPORT_CONFLICT_CODES),
            raw_code: raw,
            subject: readOptionalString(
              entryValue.subject,
              `items[${index}].conflicts[${conflictIndex}].subject`,
              64,
            ),
          };
        }),
      };
    }),
    importable_count: readCount(record.importable_count, "importable_count"),
    blocked_count: readCount(record.blocked_count, "blocked_count"),
    commit_ready: record.commit_ready === true,
    local_automations_modified: readBoolean(
      record.local_automations_modified,
      "local_automations_modified",
    ),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function adoptionPath(orgId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/adoption`;
}

function bindingsPath(orgId: string): string {
  return `${adoptionPath(orgId)}/bindings`;
}

function bindingPath(orgId: string, adoptionStateId: string): string {
  return `${bindingsPath(orgId)}/${encodeURIComponent(adoptionStateId)}`;
}

function signalOf(signal?: AbortSignal): P08RequestOptions {
  return signal ? { signal } : {};
}

/**
 * The unauthenticated compatibility answer.
 *
 * This call deliberately has no credentials requirement and no organization: it
 * is how a local client that has never signed in finds out whether this control
 * plane can manage it. `withCredentials` is therefore left off, and the panel
 * calls it on mount so an operator can see the supported range without a
 * session.
 */
export async function fetchCompatibility(signal?: AbortSignal): Promise<Compatibility> {
  return requestJson<Compatibility>("/api/v1/compatibility", signalOf(signal), decodeCompatibility);
}

export async function fetchAdoptionSummary(
  orgId: string,
  signal?: AbortSignal,
): Promise<AdoptionSummary> {
  return requestJson<AdoptionSummary>(adoptionPath(orgId), signalOf(signal), decodeAdoptionSummary);
}

/**
 * Move one workspace to its next stage, or change only its credential mode.
 *
 * `idempotencyKey` is required because the server makes every adoption mutation a
 * compare-and-set: a retried request replays the stored success rather than
 * re-applying the change, and a stale `version` is refused instead of winning.
 */
export async function advanceAdoptionStage(
  orgId: string,
  adoptionStateId: string,
  input: AdvanceStageInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<WorkspaceAdoption> {
  return requestJson<WorkspaceAdoption>(
    bindingPath(orgId, adoptionStateId),
    { method: "PATCH", body: input, idempotencyKey, ...signalOf(signal) },
    decodeWorkspaceAdoption,
  );
}

/**
 * Return one workspace to unmanaged local operation.
 *
 * The call is named `rollbackAdoption` rather than `unbind` because what it does
 * is return the workspace to the state F26 stage 0 describes, and the local copy
 * is never touched — there is no parameter through which the control plane could
 * reach it.
 */
export async function rollbackAdoption(
  orgId: string,
  adoptionStateId: string,
  version: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<WorkspaceAdoption> {
  return requestJson<WorkspaceAdoption>(
    `${bindingPath(orgId, adoptionStateId)}/rollback`,
    { method: "POST", body: { version }, idempotencyKey, ...signalOf(signal) },
    decodeWorkspaceAdoption,
  );
}

export async function resolveRemediation(
  orgId: string,
  remediationId: string,
  version: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<{ remediation_id: string; state: string; code: string; version: number }> {
  return requestJson(
    `${adoptionPath(orgId)}/remediations/${encodeURIComponent(remediationId)}/resolve`,
    { method: "POST", body: { version }, idempotencyKey, ...signalOf(signal) },
    (value) => {
      const record = objectValue(value, "resolve");
      return {
        remediation_id: readString(record.remediation_id, "remediation_id", 64),
        state: readString(record.state, "state", 32),
        code: readString(record.code, "code", 64),
        version: readVersion(record.version, "version"),
      };
    },
  );
}

/**
 * Record one stage/result pair.
 *
 * The body is built here rather than at the call site so the closed field list is
 * enforced in one place: a caller physically cannot add a sixth key without
 * changing this signature, and the server rejects it anyway.
 */
export async function recordStageEvent(
  orgId: string,
  report: {
    stage: AdoptionStage;
    result: TelemetryResult;
    reason_code?: string;
    protocol_major?: number;
    policy_schema_version?: number;
    app_version?: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = { stage: report.stage, result: report.result };
  if (report.reason_code !== undefined) body.reason_code = report.reason_code;
  if (report.protocol_major !== undefined) body.protocol_major = report.protocol_major;
  if (report.policy_schema_version !== undefined) {
    body.policy_schema_version = report.policy_schema_version;
  }
  if (report.app_version !== undefined) body.app_version = report.app_version;
  await requestJson<null>(
    `${adoptionPath(orgId)}/telemetry`,
    {
      method: "POST",
      body,
      ...signalOf(signal),
    },
    () => null,
  );
}

/**
 * Preview an automation import without importing anything.
 *
 * `adoptionStateIds` names the workspaces these automations would run in, and the
 * server checks each one against its own record rather than trusting the claim.
 */
export async function previewAutomationImport(
  orgId: string,
  candidates: ImportCandidate[],
  adoptionStateIds: string[],
  stage: AdoptionStage,
  signal?: AbortSignal,
): Promise<ImportPreview> {
  if (candidates.length > MAX_IMPORT_CANDIDATES) {
    throw new AdoptionContractError("candidates");
  }
  return requestJson<ImportPreview>(
    `${adoptionPath(orgId)}/automation-imports/preview`,
    {
      method: "POST",
      body: {
        candidates: candidates.map((candidate) => ({
          local_key: candidate.local_key,
          schedule_kind: candidate.schedule_kind,
          required_tools: candidate.required_tools ?? [],
          required_model_capabilities: candidate.required_model_capabilities ?? [],
          uses_off_peak: candidate.uses_off_peak ?? false,
          credential_mode: candidate.credential_mode,
        })),
        adoption_state_ids: adoptionStateIds,
        stage,
      },
      ...signalOf(signal),
    },
    decodeImportPreview,
  );
}

// ---------------------------------------------------------------------------
// The client the panel depends on
// ---------------------------------------------------------------------------

/**
 * The adoption surface, as an interface.
 *
 * Every method takes an `orgId` and returns a decoded, allowlisted value. The
 * panel depends on this rather than on the module functions so a test can supply
 * a fake and assert what the panel renders without a network, and so the
 * coordinator can pass a client that also records telemetry without the
 * decoders changing.
 */
export interface AdoptionApi {
  /** The unauthenticated compatibility answer. */
  getCompatibility(signal?: AbortSignal): Promise<Compatibility>;
  getSummary(orgId: string, signal?: AbortSignal): Promise<AdoptionSummary>;
  advanceStage(
    orgId: string,
    adoptionStateId: string,
    input: AdvanceStageInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceAdoption>;
  rollback(
    orgId: string,
    adoptionStateId: string,
    version: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceAdoption>;
  resolveRemediation(
    orgId: string,
    remediationId: string,
    version: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ remediation_id: string; state: string; code: string; version: number }>;
  previewImport(
    orgId: string,
    candidates: ImportCandidate[],
    adoptionStateIds: string[],
    stage: AdoptionStage,
    signal?: AbortSignal,
  ): Promise<ImportPreview>;
}

export const defaultAdoptionApi: AdoptionApi = {
  getCompatibility: (signal) => fetchCompatibility(signal),
  getSummary: (orgId, signal) => fetchAdoptionSummary(orgId, signal),
  advanceStage: (orgId, adoptionStateId, input, idempotencyKey, signal) =>
    advanceAdoptionStage(orgId, adoptionStateId, input, idempotencyKey, signal),
  rollback: (orgId, adoptionStateId, version, idempotencyKey, signal) =>
    rollbackAdoption(orgId, adoptionStateId, version, idempotencyKey, signal),
  resolveRemediation: (orgId, remediationId, version, idempotencyKey, signal) =>
    resolveRemediation(orgId, remediationId, version, idempotencyKey, signal),
  previewImport: (orgId, candidates, adoptionStateIds, stage, signal) =>
    previewAutomationImport(orgId, candidates, adoptionStateIds, stage, signal),
};
