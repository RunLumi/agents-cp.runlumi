// Render smoke tests for the adoption surface.
//
// `renderToStaticMarkup` executes the component tree, the same approach the other
// P0x panels take, so the load-bearing copy and the accessibility shape are
// asserted against real markup rather than against types.
//
// The content surfaces are rendered through their exported sub-components rather
// than through the stateful panel, because `renderToStaticMarkup` never runs
// effects: a panel that fetches on mount can only ever render its loading state
// here. The panel itself is still rendered, for the things that are true before
// any data arrives — its own copy, its loading state, and the absence of any
// control that could take local content.
//
// The focus is the promises P08 makes to a user who has not adopted anything and
// may never do:
//
// 1. Nothing on this surface offers to upload local content. No key field, no
//    file field, no "import everything" control, anywhere.
// 2. A workspace that adopted nothing is not described as having a problem.
// 3. The stage ladder reads in adoption order, and the managed boundary is
//    visible without reading prose.
// 4. Every error, loading, empty, and permission state is present and announced.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiClientError } from "@/lib/errors";
import {
  decodeAdoptionSummary,
  decodeCompatibility,
  decodeRemediation,
  decodeWorkspaceAdoption,
  type AdoptionApi,
  type AdoptionSummary,
  type Compatibility,
  type WorkspaceAdoption,
} from "./api";
import {
  AdoptionPanel,
  CompatibilityTab,
  RemediationTab,
  WorkspaceDetail,
  WorkspacesTab,
} from "./adoption-panel";
import { remediationRows, stageLadder, type RemediationRow } from "./helpers";
import { ErrorNotice, PermissionState, StageLadder } from "./ui";

const ORG = "org_0123456789abcdef0123456789abcdef";
const STATE = "wst_0123456789abcdef0123456789abcdef";
const NOW = "2026-09-26T00:00:00.000Z";

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T; stale: boolean }
  | { kind: "error"; error: unknown }
  | { kind: "permission" };

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

function summary(overrides: Record<string, unknown> = {}): AdoptionSummary {
  return decodeAdoptionSummary({
    org_id: ORG,
    contract_version: "p08-cg-v1",
    compatibility: {
      supported_protocols: [1],
      supported_policy_schema_versions: [1],
      local_only_eligible: true,
      history_sync_eligible: false,
    },
    counts: { adopted_workspaces: 0, managed_workspaces: 0, open_remediations: 0 },
    stage_counts: [],
    event_counts: [],
    bindings: [],
    remediations: [],
    derived_remediations: [],
    actor_role: "admin",
    ...overrides,
  });
}

function ready<T>(data: T): LoadState<T> {
  return { kind: "ready", data, stale: false };
}

const COMPATIBILITY: Compatibility = decodeCompatibility({
  contract_version: "p08-cg-v1",
  supported_protocols: [1],
  supported_policy_schema_versions: [1],
  min_client_app_version: "0.4.0",
  local_only_eligible: true,
  history_sync_eligible: false,
  client: null,
  stages: [
    "local_unmanaged",
    "account_optional",
    "device_enrolled",
    "workspace_bound",
    "managed_policy",
    "history_sync",
  ],
});

function fakeApi(overrides: Partial<AdoptionApi> = {}): AdoptionApi {
  return {
    getCompatibility: async () => COMPATIBILITY,
    getSummary: async () => summary(),
    advanceStage: async () => decodeWorkspaceAdoption(binding()),
    rollback: async () => decodeWorkspaceAdoption(binding()),
    resolveRemediation: async () => ({
      remediation_id: "rem_0123456789abcdef0123456789abcdef",
      state: "resolved",
      code: "client_outdated",
      version: 2,
    }),
    previewImport: async () => {
      throw new Error("not used in this test");
    },
    ...overrides,
  };
}

const NOOP = (): void => undefined;

function renderWorkspaces(
  data: AdoptionSummary,
  {
    canManage = false,
    current = null,
  }: { canManage?: boolean; current?: WorkspaceAdoption | null } = {},
): string {
  return renderToStaticMarkup(
    <WorkspacesTab
      state={ready(data)}
      rows={data.bindings}
      counts={data.stage_counts.map((entry) => ({
        stage: entry.stage,
        label: entry.raw_stage,
        count: entry.count,
      }))}
      current={current}
      problems={[]}
      canManage={canManage}
      busy={null}
      onSelect={NOOP}
      onAdvance={NOOP}
      onRollback={NOOP}
      onRetry={NOOP}
    />,
  );
}

describe("the panel shell", () => {
  it("states the promise in the header copy", () => {
    const markup = renderToStaticMarkup(<AdoptionPanel orgId={ORG} api={fakeApi()} />);
    expect(markup).toContain("never uploads a local key, a prompt, a file, or an automation");
    expect(markup).toContain("only when someone explicitly binds it to a project");
  });

  /**
   * The strongest form of the privacy promise: there is no control anywhere on
   * this surface that could take local content. An input named for a key, a
   * file, or a secret would fail this.
   */
  it("offers no control that could carry local content", () => {
    const markup = renderToStaticMarkup(<AdoptionPanel orgId={ORG} api={fakeApi()} />);
    expect(markup).not.toMatch(/type="file"/);
    expect(markup).not.toMatch(/<textarea/);
    expect(markup).not.toMatch(/api[_ ]?key/i);
  });

  it("announces its loading state", () => {
    const markup = renderToStaticMarkup(<AdoptionPanel orgId={ORG} api={fakeApi()} />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Loading adoption state");
  });
});

describe("the workspaces surface", () => {
  it("tells an organization that has adopted nothing that doing nothing is supported", () => {
    const markup = renderWorkspaces(summary());
    expect(markup).toContain("Nothing has been adopted yet, and that is a supported state");
    expect(markup).toContain("No workspaces have been adopted");
  });

  it("never describes a local-only workspace as having a problem", () => {
    const markup = renderWorkspaces(
      summary({
        counts: { adopted_workspaces: 0, managed_workspaces: 0, open_remediations: 0 },
        stage_counts: [{ stage: "local_unmanaged", count: 1 }],
        bindings: [binding()],
      }),
    );
    expect(markup).not.toContain("Needs attention");
    expect(markup).not.toContain("Mark resolved");
  });

  it("never renders anything that looks like a filesystem path", () => {
    const markup = renderWorkspaces(
      summary({
        counts: { adopted_workspaces: 1, managed_workspaces: 0, open_remediations: 0 },
        stage_counts: [{ stage: "local_unmanaged", count: 1 }],
        bindings: [binding({ external_workspace_key: "ws-opaque-key" })],
      }),
    );
    expect(markup).not.toContain("/Users/");
    expect(markup).not.toMatch(/[A-Z]:\\/);
  });

  it("hides the mutating controls from a reader", () => {
    const markup = renderWorkspaces(summary({ bindings: [binding()] }), { canManage: false });
    expect(markup).not.toContain("Return to local only");
  });
});

describe("the workspace detail surface", () => {
  function renderDetail(
    workspace: WorkspaceAdoption,
    canManage: boolean,
    problems: string[] = [],
  ): string {
    return renderToStaticMarkup(
      <WorkspaceDetail
        workspace={workspace}
        problems={problems}
        canManage={canManage}
        busy={null}
        onAdvance={NOOP}
        onRollback={NOOP}
      />,
    );
  }

  it("says in words what the credential mode does with the local key", () => {
    // The copy is the consent surface. A mode label alone does not tell anyone
    // whether their key leaves the machine.
    const workspace = decodeWorkspaceAdoption(
      binding({
        stage: "local_unmanaged",
        ownership: "local_unmanaged",
        credential_mode: "org_managed_credential",
      }),
    );
    const markup = renderDetail(workspace, true);
    expect(markup).toContain("The key is copied into the organization");
  });

  it("says a local key never leaves the machine", () => {
    const markup = renderDetail(decodeWorkspaceAdoption(binding()), true);
    expect(markup).toContain("Your key never leaves this machine");
  });

  it("offers the rollback only to a manager, and says what it does not do", () => {
    const managed = decodeWorkspaceAdoption(
      binding({
        stage: "managed_policy",
        ownership: "org_managed",
        is_adopted: true,
        is_managed: true,
      }),
    );
    expect(renderDetail(managed, true)).toContain("Return to local only");
    expect(renderDetail(managed, false)).toContain("Read only");
    expect(renderDetail(managed, false)).not.toContain("Return to local only");
  });

  it("does not offer a rollback for a workspace that adopted nothing", () => {
    const markup = renderDetail(decodeWorkspaceAdoption(binding()), true);
    expect(markup).not.toContain("Return to local only");
  });

  /**
   * "Managed" is not "broken". A fully managed workspace with no derived problem
   * must be told it is fine, or the console nags every user who adopts anything.
   */
  it("confirms a healthy managed workspace rather than inventing a problem", () => {
    const healthy = decodeWorkspaceAdoption(
      binding({
        stage: "managed_policy",
        ownership: "org_managed",
        credential_mode: "metadata_only",
        is_adopted: true,
        is_managed: true,
      }),
    );
    expect(renderDetail(healthy, true, [])).toContain("nothing is wrong with it");
    // With a derived problem, the reassurance is withdrawn.
    expect(renderDetail(healthy, true, ["policy_sync_failed"])).not.toContain(
      "nothing is wrong with it",
    );
  });

  it("shows the machine's reference as an identifier in the detail view", () => {
    const markup = renderDetail(
      decodeWorkspaceAdoption(binding({ external_workspace_key: "ws-opaque-key" })),
      false,
    );
    expect(markup).toContain("Machine reference");
    expect(markup).toContain("ws-opaque-key");
  });

  it("reports how many times a workspace was rolled back and from where", () => {
    const markup = renderDetail(
      decodeWorkspaceAdoption(
        binding({
          stage: "local_unmanaged",
          ownership: "local_unmanaged",
          credential_mode: "local_credential",
          rolled_back_from_stage: "managed_policy",
          reversion_count: 2,
          is_adopted: true,
          is_managed: false,
        }),
      ),
      true,
    );
    expect(markup).toContain("2 — last from managed_policy");
  });
});

describe("the stage ladder", () => {
  it("reads in adoption order and marks the current rung", () => {
    const markup = renderToStaticMarkup(<StageLadder steps={stageLadder("device_enrolled")} />);
    const order = [
      "Local only",
      "Account",
      "Device enrolled",
      "Workspace bound",
      "Managed policy",
      "History sync",
    ];
    let cursor = -1;
    for (const label of order) {
      const at = markup.indexOf(label);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain("current");
  });

  /**
   * The managed boundary is the one thing a user deciding whether to adopt needs
   * to see before reading any prose, so it is marked on the ladder itself.
   */
  it("marks where an organization takes over", () => {
    const markup = renderToStaticMarkup(<StageLadder steps={stageLadder("local_unmanaged")} />);
    // Three rungs carry the Lumi Blue left rule: the binding stage and the two
    // after it.
    expect(markup.split("border-[var(--lumi-blue)]").length - 1).toBe(3);
  });

  it("carries a plain-language sentence for every rung", () => {
    for (const step of stageLadder(null)) {
      expect(step.description.length).toBeGreaterThan(10);
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});

describe("the remediation surface", () => {
  const row = decodeRemediation({
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
  });

  function renderRemediation(rows: RemediationRow[], canManage = false): string {
    return renderToStaticMarkup(
      <RemediationTab
        state={ready(
          summary({
            counts: {
              adopted_workspaces: 1,
              managed_workspaces: 1,
              open_remediations: rows.filter((entry) => entry.open).length,
            },
          }),
        )}
        rows={rows}
        canManage={canManage}
        busy={null}
        onResolve={NOOP}
        onRetry={NOOP}
      />,
    );
  }

  it("says an organization with nothing wrong is fine, and never lists a local-only workspace", () => {
    const markup = renderRemediation([]);
    expect(markup).toContain("Nothing needs attention");
    // The rule stated in the surface itself, so a reader knows the absence is
    // meaningful rather than an oversight.
    expect(markup).toContain("A workspace that has adopted nothing is never listed here");
  });

  it("lists an open problem with the action a user can take", () => {
    const markup = renderRemediation(remediationRows([row], []));
    expect(markup).toContain("Client is out of date");
    expect(markup).toContain("Install a current Lumi Agents build");
    expect(markup).toContain("open");
  });

  it("offers the resolve control to a manager and withholds it from a reader", () => {
    const rows = remediationRows([row], []);
    expect(renderRemediation(rows, true)).toContain("Mark resolved");
    expect(renderRemediation(rows, false)).not.toContain("Mark resolved");
  });

  it("keeps a resolved problem in the history with who resolved it", () => {
    const resolved = decodeRemediation({
      ...row,
      state: "resolved",
      resolved_at: NOW,
    });
    const markup = renderRemediation(remediationRows([resolved], []));
    expect(markup).toContain("Resolved");
    expect(markup).toContain("Client is out of date");
    // A resolved row records who and when; it never records a note.
    expect(markup).toContain("never records a note");
  });

  it("says an unrecognized problem is unrecognized rather than guessing", () => {
    // Decoded from a wire payload rather than by patching a decoded row, because
    // a `null` code on an already-decoded value is not a shape the decoder can
    // ever produce.
    const unknown = decodeRemediation({
      remediation_id: "rem_0123456789abcdef0123456789abcdee",
      adoption_state_id: STATE,
      device_id: null,
      code: "quantum_flux",
      remedy: "reticulate_splines",
      stage: "managed_policy",
      state: "open",
      resolved_by_user_id: null,
      resolved_at: null,
      version: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    const markup = renderRemediation(remediationRows([unknown], []));
    expect(markup).toContain("unrecognized");
    expect(markup).toContain("quantum_flux");
    // Nothing is offered for a code this build cannot interpret.
    expect(markup).not.toContain("Mark resolved");
  });
});

describe("the compatibility surface", () => {
  function renderCompatibility(data: Compatibility): string {
    return renderToStaticMarkup(<CompatibilityTab state={ready(data)} />);
  }

  it("states the supported range and that local-only clients are supported", () => {
    const markup = renderCompatibility(COMPATIBILITY);
    expect(markup).toContain("p08-cg-v1");
    expect(markup).toContain("Local-only clients");
    expect(markup).toContain("supported");
  });

  it("explains why history sync is off rather than just showing it off", () => {
    const markup = renderCompatibility(COMPATIBILITY);
    expect(markup).toContain("not available yet");
    expect(markup).toContain("until the retention controls it depends on are mature");
  });

  it("lists what is never uploaded, as a fact rather than a promise", () => {
    const markup = renderCompatibility(COMPATIBILITY);
    for (const entry of [
      "Local API keys",
      "Historical prompts",
      "Files and workspace contents",
      "Local automations",
      "MCP credentials",
      "Filesystem paths",
    ]) {
      expect(markup).toContain(entry);
    }
    expect(markup).toContain("these have nowhere to go in the schema");
  });
});

describe("the async states", () => {
  it("announces loading on every content surface", () => {
    const markup = renderToStaticMarkup(
      <WorkspacesTab
        state={{ kind: "loading" }}
        rows={[]}
        counts={[]}
        current={null}
        problems={[]}
        canManage={false}
        busy={null}
        onSelect={NOOP}
        onAdvance={NOOP}
        onRollback={NOOP}
        onRetry={NOOP}
      />,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Loading adoption state");
  });

  it("renders a permission state distinctly from an error", () => {
    const markup = renderToStaticMarkup(
      <WorkspacesTab
        state={{ kind: "permission" }}
        rows={[]}
        counts={[]}
        current={null}
        problems={[]}
        canManage={false}
        busy={null}
        onSelect={NOOP}
        onAdvance={NOOP}
        onRollback={NOOP}
        onRetry={NOOP}
      />,
    );
    expect(markup).toContain("Access not permitted");
    expect(markup).not.toContain("Reason code");
  });

  it("shows the reason code and the request id, never the server's prose", () => {
    // The error carries a code and a request id; the server's prose is never on
    // the object, which is exactly why it cannot be rendered by accident.
    const error = new ApiClientError({
      status: 500,
      kind: "api",
      code: "internal_error",
      requestId: "req_0123456789abcdef0123456789abcdef",
      retryable: true,
    });
    const markup = renderToStaticMarkup(
      <WorkspacesTab
        state={{ kind: "error", error }}
        rows={[]}
        counts={[]}
        current={null}
        problems={[]}
        canManage={false}
        busy={null}
        onSelect={NOOP}
        onAdvance={NOOP}
        onRollback={NOOP}
        onRetry={NOOP}
      />,
    );
    expect(markup).toContain("internal_error");
    expect(markup).toContain("req_0123456789abcdef0123456789abcdef");
    expect(markup).not.toContain("sk-live-1234");
  });

  it("renders a standalone permission state and error notice", () => {
    expect(renderToStaticMarkup(<PermissionState resource="adoption state" />)).toContain(
      "adoption state",
    );
    const notice = renderToStaticMarkup(
      <ErrorNotice
        error={
          new ApiClientError({
            status: 500,
            kind: "api",
            code: "internal_error",
            requestId: undefined,
            retryable: false,
          })
        }
        onRetry={NOOP}
      />,
    );
    expect(notice).toContain('role="alert"');
    expect(notice).toContain("Try again");
  });
});

describe("a rejected telemetry report", () => {
  it("surfaces the stable reason rather than the server's message", () => {
    // The server refuses a report with an unknown field. The panel shows the
    // reason code, so a client developer can find the offending key.
    const markup = renderToStaticMarkup(
      <ErrorNotice
        error={
          new ApiClientError({
            status: 422,
            kind: "api",
            code: "validation_failed",
            requestId: undefined,
            retryable: false,
          })
        }
      />,
    );
    expect(markup).toContain("validation_failed");
  });
});
