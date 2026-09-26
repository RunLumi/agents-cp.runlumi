/**
 * Adoption API decoder tests.
 *
 * The emphasis is on the two failure directions that matter for a migration
 * surface:
 *
 * - **A decoder must never spread.** A field the server adds later cannot reach
 *   component state, so an allowlist violation is a test failure rather than a
 *   surprise in a panel.
 * - **An unrecognized value must decode to `null`, never to a default.** A
 *   control plane newer than this build must not be able to make the console
 *   claim a user reached a stage they did not, or that a workspace has no
 *   problem when it has one.
 */

import { describe, expect, it } from "vitest";

import {
  AdoptionContractError,
  ADOPTION_STAGES,
  CREDENTIAL_MODES,
  IMPORT_CONFLICT_CODES,
  REMEDIATION_CODES,
  decodeAdoptionSummary,
  decodeCompatibility,
  decodeImportPreview,
  decodeRemediation,
  decodeWorkspaceAdoption,
  type AdoptionSummary,
  type Compatibility,
  type ImportPreview,
  type Remediation,
  type WorkspaceAdoption,
} from "./api";

const ORG = "org_0123456789abcdef0123456789abcdef";
const STATE = "wst_0123456789abcdef0123456789abcdef";
const NOW = "2026-09-26T00:00:00.000Z";

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adoption_state_id: STATE,
    org_id: ORG,
    external_installation_id: "0123456789abcdef-inst",
    external_workspace_key: "ws-alpha",
    display_name: "Workspace Alpha",
    bound_project_id: null,
    bound_device_id: null,
    stage: "local_unmanaged",
    ownership: "local_unmanaged",
    credential_mode: "local_credential",
    rolled_back_from_stage: null,
    client_protocol_major: 1,
    policy_schema_version: 1,
    client_app_version: "0.4.0",
    reversion_count: 0,
    is_adopted: false,
    is_managed: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function remediation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remediation_id: "rem_0123456789abcdef0123456789abcdef",
    adoption_state_id: STATE,
    device_id: null,
    code: "client_outdated",
    remedy: "upgrade_client",
    stage: "managed_policy",
    state: "open",
    resolved_by_user_id: null,
    resolved_at: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("decodeCompatibility", () => {
  const payload = {
    contract_version: "p08-cg-v1",
    supported_protocols: [1],
    supported_policy_schema_versions: [1],
    min_client_app_version: "0.4.0",
    local_only_eligible: true,
    history_sync_eligible: false,
    client: null,
    stages: [...ADOPTION_STAGES],
  };

  it("decodes the frozen range", () => {
    const decoded = decodeCompatibility(payload);
    expect(decoded.contract_version).toBe("p08-cg-v1");
    expect(decoded.supported_protocols).toEqual([1]);
    expect(decoded.local_only_eligible).toBe(true);
    expect(decoded.history_sync_eligible).toBe(false);
    expect(decoded.client).toBeNull();
  });

  it("echoes a client verdict when the client sent a fingerprint", () => {
    const decoded = decodeCompatibility({
      ...payload,
      client: {
        state: "upgrade_required",
        mode: "local_only",
        local_only_available: true,
        managed_allowed: false,
        reason: "client_upgrade_required",
        min_client_app_version: "0.4.0",
      },
    });
    expect(decoded.client?.state).toBe("upgrade_required");
    expect(decoded.client?.mode).toBe("local_only");
    expect(decoded.client?.managed_allowed).toBe(false);
    // The guarantee, as the client sees it: local-only is always available.
    expect(decoded.client?.local_only_available).toBe(true);
  });

  it("refuses a response that is missing a frozen field", () => {
    const { history_sync_eligible: _missing, ...incomplete } = payload;
    expect(() => decodeCompatibility(incomplete)).toThrow(AdoptionContractError);
  });

  it("refuses a stage list this build does not know", () => {
    expect(() =>
      decodeCompatibility({ ...payload, stages: [...ADOPTION_STAGES, "stage_9"] }),
    ).toThrow(AdoptionContractError);
  });

  it("never carries a field the wire did not declare", () => {
    const decoded = decodeCompatibility({
      ...payload,
      secret_database_url: "postgres://should-never-be-here",
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(Object.keys(payload).sort());
  });
});

describe("decodeWorkspaceAdoption", () => {
  it("decodes a stage-0 workspace", () => {
    const decoded = decodeWorkspaceAdoption(binding());
    expect(decoded.stage).toBe("local_unmanaged");
    expect(decoded.is_adopted).toBe(false);
    expect(decoded.is_managed).toBe(false);
    expect(decoded.credential_mode).toBe("local_credential");
  });

  it("decodes a managed workspace and keeps the rollback history", () => {
    const decoded = decodeWorkspaceAdoption(
      binding({
        stage: "local_unmanaged",
        ownership: "local_unmanaged",
        credential_mode: "local_credential",
        rolled_back_from_stage: "workspace_bound",
        reversion_count: 2,
        is_adopted: true,
        is_managed: false,
      }),
    );
    expect(decoded.rolled_back_from_stage).toBe("workspace_bound");
    expect(decoded.reversion_count).toBe(2);
    // A rolled-back workspace was adopted once, so it is not "never adopted".
    expect(decoded.is_adopted).toBe(true);
  });

  /**
   * The fail-closed direction: an unknown stage renders as unrecognized rather
   * than being coerced to the nearest stage this build knows.
   */
  it("decodes an unknown stage to null and keeps the honest booleans", () => {
    const decoded = decodeWorkspaceAdoption(
      binding({ stage: "stage_9", ownership: "org_managed", is_managed: true }),
    );
    expect(decoded.stage).toBeNull();
    expect(decoded.is_managed).toBe(true);
  });

  it("refuses a malformed identifier, version, or timestamp", () => {
    expect(() => decodeWorkspaceAdoption(binding({ adoption_state_id: "" }))).toThrow(
      AdoptionContractError,
    );
    expect(() => decodeWorkspaceAdoption(binding({ version: 0 }))).toThrow(AdoptionContractError);
    expect(() => decodeWorkspaceAdoption(binding({ created_at: "yesterday" }))).toThrow(
      AdoptionContractError,
    );
  });

  it("never carries a field the wire did not declare", () => {
    const decoded = decodeWorkspaceAdoption(
      binding({ workspace_path: "/Users/someone/code" }),
    ) as unknown as Record<string, unknown>;
    expect(decoded.workspace_path).toBeUndefined();
  });
});

describe("decodeRemediation", () => {
  it("decodes an open remediation", () => {
    const decoded = decodeRemediation(remediation());
    expect(decoded.code).toBe("client_outdated");
    expect(decoded.remedy).toBe("upgrade_client");
    expect(decoded.state).toBe("open");
    expect(decoded.resolved_at).toBeNull();
  });

  it("keeps an unrecognized code and remedy readable instead of guessing", () => {
    const decoded = decodeRemediation(
      remediation({ code: "quantum_flux", remedy: "reticulate_splines" }),
    );
    expect(decoded.code).toBeNull();
    expect(decoded.remedy).toBeNull();
    expect(decoded.raw_code).toBe("quantum_flux");
  });

  it("refuses a remediation with no code at all", () => {
    expect(() => decodeRemediation(remediation({ code: null }))).toThrow(AdoptionContractError);
  });
});

describe("decodeAdoptionSummary", () => {
  function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      org_id: ORG,
      contract_version: "p08-cg-v1",
      compatibility: {
        supported_protocols: [1],
        supported_policy_schema_versions: [1],
        local_only_eligible: true,
        history_sync_eligible: false,
      },
      counts: { adopted_workspaces: 1, managed_workspaces: 1, open_remediations: 1 },
      stage_counts: [
        { stage: "local_unmanaged", count: 2 },
        { stage: "managed_policy", count: 1 },
      ],
      event_counts: [{ stage: "managed_policy", result: "declined", count: 1 }],
      bindings: [binding({ is_adopted: true, is_managed: true, stage: "managed_policy" })],
      remediations: [remediation()],
      derived_remediations: [
        {
          adoption_state_id: STATE,
          code: "credential_missing",
          remedy: "choose_credential_mode",
          stage: "managed_policy",
        },
      ],
      actor_role: "admin",
      ...overrides,
    };
  }

  it("decodes the full summary", () => {
    const decoded: AdoptionSummary = decodeAdoptionSummary(summary());
    expect(decoded.counts.managed_workspaces).toBe(1);
    expect(decoded.stage_counts).toHaveLength(2);
    expect(decoded.event_counts[0]?.result).toBe("declined");
    expect(decoded.bindings).toHaveLength(1);
    expect(decoded.remediations[0]?.code).toBe("client_outdated");
    expect(decoded.derived_remediations[0]?.code).toBe("credential_missing");
  });

  /**
   * A stage a newer control plane reports must still be counted. Dropping it
   * would make the distribution disagree with the organization's actual state,
   * which is the one number an operator trusts.
   */
  it("counts a stage this build does not know rather than dropping it", () => {
    const decoded = decodeAdoptionSummary(
      summary({ stage_counts: [{ stage: "stage_9", count: 3 }] }),
    );
    expect(decoded.stage_counts[0]?.stage).toBeNull();
    expect(decoded.stage_counts[0]?.raw_stage).toBe("stage_9");
    expect(decoded.stage_counts[0]?.count).toBe(3);
  });

  it("refuses a summary that is missing a section", () => {
    const { remediations: _missing, ...incomplete } = summary();
    expect(() => decodeAdoptionSummary(incomplete)).toThrow(AdoptionContractError);
  });
});

describe("decodeImportPreview", () => {
  const payload = {
    org_id: ORG,
    tool_policy_scope: "organization",
    model_capability_check: "deferred_to_dispatch",
    items: [
      {
        local_key: "nightly",
        importable: true,
        conflicts: [],
      },
      {
        local_key: "needs-shell",
        importable: false,
        conflicts: [{ code: "tool_not_permitted", subject: "shell" }],
      },
    ],
    importable_count: 1,
    blocked_count: 1,
    commit_ready: false,
    local_automations_modified: false,
  };

  it("decodes a preview and reports the local automations as untouched", () => {
    const decoded: ImportPreview = decodeImportPreview(payload);
    expect(decoded.items).toHaveLength(2);
    expect(decoded.items[1]?.conflicts[0]?.code).toBe("tool_not_permitted");
    expect(decoded.items[1]?.conflicts[0]?.subject).toBe("shell");
    expect(decoded.commit_ready).toBe(false);
    // The server's own claim, decoded rather than assumed.
    expect(decoded.local_automations_modified).toBe(false);
  });

  it("keeps an unrecognized conflict code readable", () => {
    const decoded = decodeImportPreview({
      ...payload,
      items: [
        {
          local_key: "x",
          importable: false,
          conflicts: [{ code: "phase_of_moon", subject: null }],
        },
      ],
    });
    expect(decoded.items[0]?.conflicts[0]?.code).toBeNull();
    expect(decoded.items[0]?.conflicts[0]?.raw_code).toBe("phase_of_moon");
  });
});

describe("the frozen vocabularies", () => {
  it("the stage ladder is the adoption order, not an alphabetical one", () => {
    expect([...ADOPTION_STAGES]).toEqual([
      "local_unmanaged",
      "account_optional",
      "device_enrolled",
      "workspace_bound",
      "managed_policy",
      "history_sync",
    ]);
  });

  it("the credential modes are in escalation order, with the copying mode last", () => {
    expect([...CREDENTIAL_MODES]).toEqual([
      "local_credential",
      "metadata_only",
      "org_managed_credential",
    ]);
  });

  it("the remediation order puts the client ahead of the things it explains", () => {
    // A client that is too old is listed first because fixing it usually fixes
    // the policy sync and the capability complaint that follow.
    expect([...REMEDIATION_CODES]).toEqual([
      "client_outdated",
      "protocol_unsupported",
      "policy_sync_failed",
      "credential_missing",
      "capability_unsupported",
      "workspace_unbound",
    ]);
  });

  it("every import conflict code has a stable snake_case name", () => {
    for (const code of IMPORT_CONFLICT_CODES) {
      expect(code).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("the types the panel depends on", () => {
  it("a workspace and a remediation both carry the fields the detail view reads", () => {
    // A structural check rather than a render: if a decoder drops a field the
    // detail view reads, the panel renders a blank rather than failing loudly,
    // and that is exactly the kind of quiet breakage these assertions exist for.
    const workspace: WorkspaceAdoption = decodeWorkspaceAdoption(binding());
    for (const field of [
      "adoption_state_id",
      "display_name",
      "external_workspace_key",
      "stage",
      "ownership",
      "credential_mode",
      "reversion_count",
      "version",
    ] as const) {
      expect(workspace[field]).toBeDefined();
    }
    const row: Remediation = decodeRemediation(remediation());
    for (const field of ["remediation_id", "raw_code", "remedy", "state", "version"] as const) {
      expect(row[field]).toBeDefined();
    }
  });

  it("the compatibility response always states whether local-only is available", () => {
    // The one field a client may act on without the server's prose.
    const decoded: Compatibility = decodeCompatibility({
      contract_version: "p08-cg-v1",
      supported_protocols: [1],
      supported_policy_schema_versions: [1],
      min_client_app_version: "0.4.0",
      local_only_eligible: true,
      history_sync_eligible: false,
      client: null,
      stages: [...ADOPTION_STAGES],
    });
    expect(typeof decoded.local_only_eligible).toBe("boolean");
  });
});
