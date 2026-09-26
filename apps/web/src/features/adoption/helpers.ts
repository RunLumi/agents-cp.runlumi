/**
 * Adoption presentation helpers.
 *
 * Pure functions, so the copy and the ordering rules are testable without a
 * renderer. Three rules carry the product decision:
 *
 * 1. **A local workspace has nothing to remediate.** The wording is checked
 *    here rather than in the panel so "you have nothing to fix" is a fact with a
 *    test, not a branch someone can forget.
 * 2. **An unrecognized code is shown as unrecognized.** Never as a known state.
 *    A control plane newer than this build must not be able to make the panel
 *    claim a user reached a stage they did not.
 * 3. **The stage ladder is the reading order.** Stages render in adoption order
 *    with the current one marked, never sorted alphabetically, because the order
 *    is the thing F26 is about.
 */

import type { Tone } from "./ui";
import {
  ADOPTION_STAGES,
  REMEDIES,
  REMEDIATION_CODES,
  type AdoptionStage,
  type CredentialMode,
  type ImportConflictCode,
  type OwnershipState,
  type Remediation,
  type RemediationCode,
  type Remedy,
  type WorkspaceAdoption,
} from "./api";

/** One rung of the stage ladder, ready to render. */
export interface StageStep {
  stage: AdoptionStage;
  label: string;
  /** The plain-language sentence explaining what this stage means. */
  description: string;
  reached: boolean;
  current: boolean;
  /**
   * Whether reaching this stage would hand the workspace to an organization.
   * The panel marks that rung distinctly, because it is the one irreversible-feeling
   * step in a process the user should be able to back out of at any time.
   */
  managed: boolean;
}

const STAGE_LABELS: Record<AdoptionStage, string> = {
  local_unmanaged: "Local only",
  account_optional: "Account",
  device_enrolled: "Device enrolled",
  workspace_bound: "Workspace bound",
  managed_policy: "Managed policy",
  history_sync: "History sync",
};

const STAGE_DESCRIPTIONS: Record<AdoptionStage, string> = {
  local_unmanaged: "Runs entirely on this machine. Nothing about it is in the cloud.",
  account_optional: "You are signed in. Your workspaces and sessions stay local.",
  device_enrolled: "This device is enrolled and has a policy. No workspace is bound yet.",
  workspace_bound: "You chose which project this workspace belongs to.",
  managed_policy: "This project uses the organization's models, tools, and budgets.",
  history_sync: "Optional, chosen by you. Nothing is uploaded without asking.",
};

const OWNERSHIP_LABELS: Record<OwnershipState, string> = {
  local_unmanaged: "Local",
  org_managed: "Organization managed",
};

const CREDENTIAL_MODE_LABELS: Record<CredentialMode, string> = {
  local_credential: "Local key",
  metadata_only: "Metadata only",
  org_managed_credential: "Organization credential",
};

const CREDENTIAL_MODE_DETAIL: Record<CredentialMode, string> = {
  local_credential: "Your key never leaves this machine. Nothing is uploaded.",
  metadata_only: "The organization records which provider you use, and nothing else.",
  org_managed_credential: "The key is copied into the organization's credential store.",
};

const REMEDIATION_LABELS: Record<RemediationCode, string> = {
  client_outdated: "Client is out of date",
  protocol_unsupported: "Client version is not supported",
  policy_sync_failed: "Policy has not synced",
  credential_missing: "No credential chosen",
  capability_unsupported: "A required capability is not permitted",
  workspace_unbound: "Workspace is not bound to a project",
};

const REMEDY_LABELS: Record<Remedy, string> = {
  upgrade_client: "Upgrade the client",
  reconnect_device: "Reconnect the device",
  rebind_workspace: "Bind the workspace",
  choose_credential_mode: "Choose a credential mode",
  review_tool_policy: "Review tool policy",
  dismiss: "Dismiss",
};

const REMEDY_ACTIONS: Record<Remedy, string> = {
  upgrade_client: "Install a current Lumi Agents build, then reopen the workspace.",
  reconnect_device: "Sign out of the device and sign in again so it fetches a fresh policy.",
  rebind_workspace: "Choose a project for this workspace to finish adopting it.",
  choose_credential_mode:
    "Decide whether this workspace keeps its own key or uses the organization's.",
  review_tool_policy: "An administrator can widen the organization's tool policy.",
  dismiss: "Nothing is required. This is recorded so the history is complete.",
};

const CONFLICT_LABELS: Record<ImportConflictCode, string> = {
  automation_not_available: "The organization cannot run automations right now.",
  automation_limit_reached: "The organization is already at its active automation limit.",
  tool_not_permitted: "The organization's tool policy does not allow a required tool.",
  model_capability_unavailable: "No organization model route provides a required capability.",
  off_peak_not_entitled: "The organization is not entitled to off-peak execution.",
  workspace_unbound: "The workspace is not bound to a project yet.",
  local_credential_not_permitted:
    "The organization does not permit automations that run on a local key.",
};

export function stageLabel(stage: AdoptionStage): string {
  return STAGE_LABELS[stage];
}

export function stageDescription(stage: AdoptionStage): string {
  return STAGE_DESCRIPTIONS[stage];
}

export function ownershipLabel(ownership: OwnershipState): string {
  return OWNERSHIP_LABELS[ownership];
}

export function credentialModeLabel(mode: CredentialMode): string {
  return CREDENTIAL_MODE_LABELS[mode];
}

export function credentialModeDetail(mode: CredentialMode): string {
  return CREDENTIAL_MODE_DETAIL[mode];
}

export function conflictLabel(code: ImportConflictCode, subject: string | null): string {
  const base = CONFLICT_LABELS[code];
  return subject ? `${base} (${subject})` : base;
}

export function remedyLabel(remedy: Remedy): string {
  return REMEDY_LABELS[remedy];
}

export function remedyAction(remedy: Remedy): string {
  return REMEDY_ACTIONS[remedy];
}

export function remediationLabel(remediation: {
  code: RemediationCode | null;
  raw_code: string;
}): string {
  if (remediation.code) return REMEDIATION_LABELS[remediation.code];
  // Fail closed and say so. A code this build does not know is reported as
  // unrecognized rather than mapped onto the nearest label we happen to have.
  return `Unrecognized (${remediation.raw_code})`;
}

/** Build the ladder for one workspace's current position. */
export function stageLadder(current: AdoptionStage | null): StageStep[] {
  const reachedIndex = current ? ADOPTION_STAGES.indexOf(current) : 0;
  return ADOPTION_STAGES.map((stage, index) => ({
    stage,
    label: STAGE_LABELS[stage],
    description: STAGE_DESCRIPTIONS[stage],
    reached: index <= reachedIndex,
    current: index === reachedIndex,
    managed: index >= ADOPTION_STAGES.indexOf("workspace_bound"),
  }));
}

/**
 * Whether this workspace is showing any kind of problem.
 *
 * The single most important presentation rule in P08: a workspace that has
 * adopted nothing is not showing a problem. Doing nothing is a supported state,
 * and telling a user their local-only workspace needs attention would make the
 * whole migration feel like nagging.
 */
export function hasAdoptionProblem(
  workspace: Pick<WorkspaceAdoption, "is_adopted" | "is_managed">,
  openProblemCodes: readonly string[] = [],
): boolean {
  if (!workspace.is_adopted) return false;
  if (!workspace.is_managed) return false;
  return openProblemCodes.length > 0;
}

/**
 * The open problem codes the server derived for one workspace.
 *
 * Keyed on the adoption record rather than the workspace name or display label,
 * because those are client-chosen strings and this has to line up with what the
 * server reported.
 */
export function problemCodesFor(
  derived: readonly { adoption_state_id: string; raw_code: string }[],
  adoptionStateId: string,
): string[] {
  return derived
    .filter((entry) => entry.adoption_state_id === adoptionStateId)
    .map((entry) => entry.raw_code);
}

/** One row of the remediation list, already resolved to copy. */
export interface RemediationRow {
  key: string;
  code: RemediationCode | null;
  rawCode: string;
  label: string;
  remedy: Remedy | null;
  remedyLabel: string | null;
  remedyAction: string | null;
  stage: AdoptionStage | null;
  stageLabel: string | null;
  open: boolean;
  resolvedAt: string | null;
  version: number;
  workspaceId: string | null;
  /** True when this build does not recognize the stored code. */
  unrecognized: boolean;
}

function toRow(remediation: Remediation, fallbackWorkspace: string | null): RemediationRow {
  return {
    key: remediation.remediation_id,
    code: remediation.code,
    rawCode: remediation.raw_code,
    label: remediationLabel(remediation),
    remedy: remediation.remedy,
    remedyLabel: remediation.remedy ? REMEDY_LABELS[remediation.remedy] : null,
    remedyAction: remediation.remedy ? REMEDY_ACTIONS[remediation.remedy] : null,
    stage: remediation.stage,
    stageLabel: remediation.stage ? STAGE_LABELS[remediation.stage] : null,
    open: remediation.state === "open",
    resolvedAt: remediation.resolved_at,
    version: remediation.version,
    workspaceId: remediation.adoption_state_id ?? fallbackWorkspace,
    unrecognized: remediation.code === null,
  };
}

/**
 * The remediation list, open first and then in the frozen operator order.
 *
 * Derived remediations are folded in because they describe a problem the operator
 * can act on right now, while a stored row is a record of one. Both are shown and
 * they are distinguishable, because conflating "here is something to do" with
 * "here is what we recorded" would be its own kind of dishonesty.
 */
export function remediationRows(
  remediations: readonly Remediation[],
  derived: readonly {
    adoption_state_id: string;
    code: (typeof REMEDIATION_CODES)[number] | null;
    raw_code: string;
    remedy: Remedy | null;
    stage: AdoptionStage | null;
  }[],
): RemediationRow[] {
  const recorded = remediations.map((remediation) => toRow(remediation, null));
  const derivedRows: RemediationRow[] = derived.map((entry) => ({
    key: `derived:${entry.adoption_state_id}:${entry.raw_code}`,
    code: entry.code,
    rawCode: entry.raw_code,
    label: remediationLabel(entry),
    remedy: entry.remedy,
    remedyLabel: entry.remedy ? REMEDY_LABELS[entry.remedy] : null,
    remedyAction: entry.remedy ? REMEDY_ACTIONS[entry.remedy] : null,
    stage: entry.stage,
    stageLabel: entry.stage ? STAGE_LABELS[entry.stage] : null,
    open: true,
    resolvedAt: null,
    version: 0,
    workspaceId: entry.adoption_state_id,
    unrecognized: entry.code === null,
  }));
  const rank = (code: RemediationCode | null): number => {
    if (!code) return REMEDIATION_CODES.length;
    return REMEDIATION_CODES.indexOf(code);
  };
  return [...recorded, ...derivedRows].sort((left, right) => {
    if (left.open !== right.open) return left.open ? -1 : 1;
    const byCode = rank(left.code) - rank(right.code);
    if (byCode !== 0) return byCode;
    return left.key.localeCompare(right.key);
  });
}

/**
 * The stage-count table.
 *
 * Every known stage appears even when its count is zero, because "nobody is at
 * stage 3" is information and omitting the zero would hide it.
 *
 * A stage this build does not recognize is appended rather than dropped. Dropping
 * it would make the visible counts disagree with the organization's actual
 * state, which is the one number an operator is entitled to trust — and the
 * total would quietly stop matching the row count in the table below it.
 */
export function stageCountRows(
  counts: readonly { stage: AdoptionStage | null; raw_stage: string; count: number }[],
): { stage: AdoptionStage | null; label: string; count: number }[] {
  const byStage = new Map<string, number>();
  for (const entry of counts) byStage.set(entry.raw_stage, entry.count);
  const rows = ADOPTION_STAGES.map((stage) => ({
    stage: stage as AdoptionStage | null,
    label: STAGE_LABELS[stage],
    count: byStage.get(stage) ?? 0,
  }));
  for (const [raw, count] of byStage) {
    if ((ADOPTION_STAGES as readonly string[]).includes(raw)) continue;
    rows.push({ stage: null, label: `${raw} (unrecognized)`, count });
  }
  return rows;
}

/** The tone a stage pill should carry. */
export function stageTone(stage: AdoptionStage | null): Tone {
  if (stage === null) return "neutral";
  if (stage === "history_sync" || stage === "managed_policy") return "success";
  if (stage === "workspace_bound" || stage === "device_enrolled") return "info";
  return "neutral";
}

/** The tone a credential mode should carry; the copying mode is the loud one. */
export function credentialModeTone(mode: CredentialMode | null): Tone {
  if (mode === "org_managed_credential") return "warning";
  if (mode === "metadata_only") return "info";
  return "neutral";
}

/** The tone a remediation row should carry. */
export function remediationTone(row: Pick<RemediationRow, "open" | "unrecognized">): Tone {
  if (row.unrecognized) return "warning";
  return row.open ? "danger" : "neutral";
}

export { REMEDIES, REMEDIATION_CODES };
