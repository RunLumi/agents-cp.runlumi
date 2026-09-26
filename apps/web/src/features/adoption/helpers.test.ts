/**
 * Adoption presentation tests.
 *
 * The rules under test are product decisions, not formatting:
 *
 * - a workspace that adopted nothing is never shown a problem;
 * - an unrecognized code says so, and is never mapped onto a nearby label;
 * - the stage ladder renders in adoption order with the current rung marked;
 * - open remediations sort above resolved ones, in the frozen operator order.
 */

import { describe, expect, it } from "vitest";

import {
  ADOPTION_STAGES,
  CREDENTIAL_MODES,
  REMEDIATION_CODES,
  type AdoptionStage,
  type Remediation,
  type WorkspaceAdoption,
} from "./api";
import {
  credentialModeDetail,
  credentialModeLabel,
  credentialModeTone,
  hasAdoptionProblem,
  ownershipLabel,
  remediationLabel,
  remediationRows,
  remediationTone,
  stageCountRows,
  stageLadder,
  stageTone,
} from "./helpers";

const ALL_STAGES: readonly AdoptionStage[] = ADOPTION_STAGES;
const STATE = "wst_0123456789abcdef0123456789abcdef";
const NOW = "2026-09-26T00:00:00.000Z";

function workspace(overrides: Partial<WorkspaceAdoption> = {}): WorkspaceAdoption {
  return {
    adoption_state_id: STATE,
    org_id: "org_0123456789abcdef0123456789abcdef",
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

function remediation(overrides: Partial<Remediation> = {}): Remediation {
  return {
    remediation_id: "rem_0123456789abcdef0123456789abcdef",
    adoption_state_id: STATE,
    device_id: null,
    code: "client_outdated",
    raw_code: "client_outdated",
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

describe("hasAdoptionProblem", () => {
  /**
   * The single most important presentation rule in P08. Doing nothing is a
   * supported state; a console that tells a local-only user they have a problem
   * turns a staged migration into nagging.
   */
  it("a workspace that adopted nothing has no problem", () => {
    expect(hasAdoptionProblem(workspace({ is_adopted: false, is_managed: false }))).toBe(false);
  });

  it("an enrolled but unmanaged workspace has no problem yet", () => {
    // It has not asked for managed operation, so a credential or binding problem
    // would be invented.
    expect(
      hasAdoptionProblem(
        workspace({ stage: "device_enrolled", is_adopted: true, is_managed: false }),
        ["credential_missing", "workspace_unbound"],
      ),
    ).toBe(false);
  });
});

describe("stageLadder", () => {
  it("renders the six stages in adoption order", () => {
    const steps = stageLadder("local_unmanaged");
    expect(steps.map((step) => step.stage)).toEqual(ALL_STAGES);
  });

  it("marks only the first rung reached at stage 0", () => {
    const steps = stageLadder("local_unmanaged");
    expect(steps.filter((step) => step.reached)).toHaveLength(1);
    expect(steps[0]?.current).toBe(true);
    expect(steps[1]?.reached).toBe(false);
  });

  it("marks the reached rungs and the current one as the workspace advances", () => {
    const steps = stageLadder("workspace_bound");
    expect(steps.filter((step) => step.reached).map((step) => step.stage)).toEqual([
      "local_unmanaged",
      "account_optional",
      "device_enrolled",
      "workspace_bound",
    ]);
    expect(steps.find((step) => step.current)?.stage).toBe("workspace_bound");
  });

  /**
   * The managed boundary starts at the explicit binding stage. Marking it on the
   * ladder is how a user sees where "the organization takes over" happens before
   * reading any prose.
   */
  it("marks the managed rungs from the binding stage onward", () => {
    const steps = stageLadder("managed_policy");
    const managed = steps.filter((step) => step.managed).map((step) => step.stage);
    expect(managed).toEqual(["workspace_bound", "managed_policy", "history_sync"]);
  });

  it("treats an unrecognized stage as having reached nothing", () => {
    const steps = stageLadder(null);
    expect(steps.filter((step) => step.reached)).toHaveLength(1);
    expect(steps.every((step) => step.label.length > 0 && step.description.length > 0)).toBe(true);
  });
});

describe("remediationLabel", () => {
  it("labels a known code", () => {
    expect(remediationLabel({ code: "client_outdated", raw_code: "client_outdated" })).toBe(
      "Client is out of date",
    );
    expect(remediationLabel({ code: "workspace_unbound", raw_code: "workspace_unbound" })).toBe(
      "Workspace is not bound to a project",
    );
  });

  /**
   * The fail-closed direction. A code this build does not know must be reported
   * as unrecognized rather than mapped onto the nearest label available, because
   * a wrong label is a claim about the user's machine.
   */
  it("says unrecognized for a code it does not know, and keeps the raw value", () => {
    const label = remediationLabel({ code: null, raw_code: "quantum_flux" });
    expect(label).toContain("Unrecognized");
    expect(label).toContain("quantum_flux");
  });
});

describe("remediationRows", () => {
  it("puts open rows above resolved ones, in the frozen operator order", () => {
    const rows = remediationRows(
      [
        remediation({
          remediation_id: "rem_2",
          code: "workspace_unbound",
          raw_code: "workspace_unbound",
          remedy: "rebind_workspace",
          state: "open",
        }),
        remediation({
          remediation_id: "rem_1",
          code: "client_outdated",
          raw_code: "client_outdated",
          remedy: "upgrade_client",
          state: "open",
        }),
        remediation({
          remediation_id: "rem_3",
          code: "policy_sync_failed",
          raw_code: "policy_sync_failed",
          remedy: "reconnect_device",
          state: "resolved",
          resolved_at: NOW,
        }),
      ],
      [],
    );
    expect(rows.map((row) => row.key)).toEqual(["rem_1", "rem_2", "rem_3"]);
    expect(rows[0]?.open).toBe(true);
    expect(rows[2]?.open).toBe(false);
  });

  it("orders by the frozen remediation sequence, not by the raw code string", () => {
    const rows = remediationRows(
      [
        remediation({
          remediation_id: "rem_a",
          code: "workspace_unbound",
          raw_code: "workspace_unbound",
          remedy: "rebind_workspace",
        }),
        remediation({
          remediation_id: "rem_b",
          code: "credential_missing",
          raw_code: "credential_missing",
          remedy: "choose_credential_mode",
        }),
        remediation({
          remediation_id: "rem_c",
          code: "policy_sync_failed",
          raw_code: "policy_sync_failed",
          remedy: "reconnect_device",
        }),
      ],
      [],
    );
    expect(rows.map((row) => row.code)).toEqual([
      "policy_sync_failed",
      "credential_missing",
      "workspace_unbound",
    ]);
  });

  it("pairs a derived row with the action a user can actually take", () => {
    const rows = remediationRows(
      [],
      [
        {
          adoption_state_id: STATE,
          code: "credential_missing",
          raw_code: "credential_missing",
          remedy: "choose_credential_mode",
          stage: "managed_policy",
        },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.remedyLabel).toBe("Choose a credential mode");
    expect(rows[0]?.remedyAction).toContain("its own key");
    expect(rows[0]?.open).toBe(true);
  });

  it("marks a derived row as derived so it cannot be confused with a record", () => {
    const rows = remediationRows(
      [],
      [
        {
          adoption_state_id: STATE,
          code: "client_outdated",
          raw_code: "client_outdated",
          remedy: "upgrade_client",
          stage: "managed_policy",
        },
      ],
    );
    expect(rows[0]?.key.startsWith("derived:")).toBe(true);
  });

  it("flags an unrecognized recorded code", () => {
    const rows = remediationRows(
      [remediation({ code: null, raw_code: "quantum_flux", remedy: null })],
      [],
    );
    expect(rows[0]?.unrecognized).toBe(true);
    expect(remediationTone(rows[0]!)).toBe("warning");
  });

  it("is deterministic, so two reads of the same state render the same list", () => {
    const input = [
      remediation({
        remediation_id: "rem_1",
        code: "client_outdated",
        raw_code: "client_outdated",
        remedy: "upgrade_client",
      }),
      remediation({
        remediation_id: "rem_2",
        code: "policy_sync_failed",
        raw_code: "policy_sync_failed",
        remedy: "reconnect_device",
      }),
    ];
    expect(remediationRows(input, [])).toEqual(remediationRows(input, []));
  });

  it("an empty list is an empty list, not a fabricated problem", () => {
    expect(remediationRows([], [])).toEqual([]);
  });
});

describe("stageCountRows", () => {
  it("shows every stage, including the empty ones", () => {
    // A distribution with gaps is the point: "nobody is at stage 3" is
    // information, and omitting the zero would hide it.
    const rows = stageCountRows([
      { stage: "local_unmanaged", raw_stage: "local_unmanaged", count: 4 },
      { stage: "managed_policy", raw_stage: "managed_policy", count: 1 },
    ]);
    expect(rows).toHaveLength(ADOPTION_STAGES.length);
    expect(rows.map((row) => row.count)).toEqual([4, 0, 0, 0, 1, 0]);
  });

  it("keeps a stage this build does not know, so the counts still add up", () => {
    const rows = stageCountRows([{ stage: null, raw_stage: "stage_9", count: 3 }]);
    const counted = rows.reduce((total, row) => total + row.count, 0);
    expect(counted).toBe(3);
  });
});

describe("tone", () => {
  it("marks a managed stage as success and an unknown one as neutral", () => {
    expect(stageTone("managed_policy")).toBe("success");
    expect(stageTone("history_sync")).toBe("success");
    expect(stageTone("local_unmanaged")).toBe("neutral");
    expect(stageTone(null)).toBe("neutral");
  });

  it("makes the credential mode that copies a secret the loud one", () => {
    // Escalation order is the reason the mode list is ordered: the only mode that
    // copies anything is the one that gets a warning tone.
    expect(credentialModeTone("local_credential")).toBe("neutral");
    expect(credentialModeTone("metadata_only")).toBe("info");
    expect(credentialModeTone("org_managed_credential")).toBe("warning");
    expect(credentialModeTone(null)).toBe("neutral");
  });

  it("makes an open remediation a danger and a resolved one neutral", () => {
    expect(remediationTone({ open: true, unrecognized: false })).toBe("danger");
    expect(remediationTone({ open: false, unrecognized: false })).toBe("neutral");
  });
});

describe("copy", () => {
  it("says in words what each credential mode does with the local key", () => {
    // The copy is the consent surface. A mode label alone does not tell anyone
    // whether their key leaves the machine.
    expect(credentialModeDetail("local_credential")).toContain("never leaves");
    expect(credentialModeDetail("metadata_only")).toContain("nothing else");
    expect(credentialModeDetail("org_managed_credential")).toContain("copied");
  });

  it("has a label for every ownership state and credential mode", () => {
    for (const mode of CREDENTIAL_MODES) {
      expect(credentialModeLabel(mode).length).toBeGreaterThan(0);
      expect(credentialModeDetail(mode).length).toBeGreaterThan(0);
    }
    expect(ownershipLabel("local_unmanaged")).toBe("Local");
    expect(ownershipLabel("org_managed")).toBe("Organization managed");
  });

  it("has a label for every remediation code", () => {
    for (const code of REMEDIATION_CODES) {
      expect(remediationLabel({ code, raw_code: code }).length).toBeGreaterThan(0);
      expect(remediationLabel({ code, raw_code: code })).not.toContain("Unrecognized");
    }
  });
});
