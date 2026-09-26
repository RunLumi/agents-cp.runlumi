/**
 * Adoption & migration — the organization section (P08-FE-01, P08-FE-02).
 *
 * Frozen contract: `docs/implementation/gates/P08-CG.md`, implemented in
 * `apps/api/src/routes/migration.rs`.
 *
 * The panel answers two questions and refuses to answer a third:
 *
 * 1. **Where is this organization in the migration?** The stage ladder per
 *    workspace, the distribution across stages, and the client versions in play.
 * 2. **What is stuck, and what does the user do about it?** The remediation list,
 *    with one action per problem and the consequence of it stated.
 *
 * It deliberately does NOT show, offer, or imply a way to upload local content.
 * There is no key field, no file field, no prompt field, and no "import
 * everything" affordance anywhere in this surface. The credential control is a
 * three-way mode choice whose least-safe option says in words that it copies the
 * key. That omission is the feature: an adoption surface that made uploading the
 * easy path would be a big-bang migration wearing a wizard's clothes.
 *
 * Load behaviour follows the other panels: one abortable load, a generation
 * counter so a late response cannot overwrite a newer one, a stale marker instead
 * of a flash of empty, and a tenant reset on org change so no other
 * organization's data is ever on screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiClientError } from "@/lib/errors";
import {
  defaultAdoptionApi,
  type AdoptionApi,
  type AdoptionStage,
  type AdoptionSummary,
  type Compatibility,
  type WorkspaceAdoption,
} from "./api";
import {
  credentialModeDetail,
  credentialModeLabel,
  credentialModeTone,
  hasAdoptionProblem,
  ownershipLabel,
  problemCodesFor,
  remediationRows,
  remediationTone,
  stageCountRows,
  stageLadder,
  stageTone,
} from "./helpers";
import {
  Code,
  DateTime,
  DefinitionRow,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Notice,
  PermissionState,
  Pill,
  StageLadder,
  Surface,
  SurfaceHeader,
  dangerButtonClass,
  ghostButtonClass,
  secondaryButtonClass,
} from "./ui";

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T; stale: boolean }
  | { kind: "error"; error: unknown }
  | { kind: "permission" };

/** The sections, in the order an operator reads them. */
const TABS = [
  { id: "workspaces", label: "Workspaces" },
  { id: "remediation", label: "Remediation" },
  { id: "compatibility", label: "Compatibility" },
] as const;
type AdoptionTab = (typeof TABS)[number]["id"];

export interface AdoptionPanelProps {
  orgId: string;
  /**
   * Optional client. When omitted, the feature-local client bound to the
   * implemented P08 routes is used.
   */
  api?: AdoptionApi;
  /** Convenience only. Authorization is enforced server-side on every call. */
  canManage?: boolean;
}

export function AdoptionPanel({ orgId, api, canManage = false }: AdoptionPanelProps) {
  const clientRef = useRef<AdoptionApi | null>(null);
  const client = api ?? (clientRef.current ??= defaultAdoptionApi);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const [summary, setSummary] = useState<LoadState<AdoptionSummary>>({ kind: "loading" });
  const [compatibility, setCompatibility] = useState<LoadState<Compatibility>>({
    kind: "loading",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<AdoptionTab>("workspaces");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    const current = ++generation.current;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setRefreshing(true);
    setActionError(null);

    // The compatibility call is independent of the tenant load, so the two settle
    // separately. A control plane that cannot answer the public compatibility
    // question should not hide the organization state, and vice versa.
    const [summaryResult, compatibilityResult] = await Promise.all([
      settle<AdoptionSummary>(() => client.getSummary(orgId, active.signal)),
      settle<Compatibility>(() => client.getCompatibility(active.signal)),
    ]);
    if (current !== generation.current || active.signal.aborted) return;
    setSummary(summaryResult);
    setCompatibility(compatibilityResult);
    setRefreshing(false);
  }, [client, orgId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
  }, [load]);

  // An org switch must not leave another tenant's data on screen.
  useEffect(() => {
    setSummary({ kind: "loading" });
    setCompatibility({ kind: "loading" });
    setSelected(null);
    setActionError(null);
  }, [orgId]);

  const rows = useMemo(() => {
    if (summary.kind !== "ready") return [];
    return summary.data.bindings;
  }, [summary]);

  const counts = useMemo(() => {
    if (summary.kind !== "ready") return [];
    return stageCountRows(summary.data.stage_counts);
  }, [summary]);

  const remediationList = useMemo(() => {
    if (summary.kind !== "ready") return [];
    return remediationRows(summary.data.remediations, summary.data.derived_remediations);
  }, [summary]);

  const current = useMemo(
    () => rows.find((row) => row.adoption_state_id === selected) ?? null,
    [rows, selected],
  );

  async function run(idempotencyKey: string, action: () => Promise<unknown>) {
    setBusy(idempotencyKey);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold tracking-[0.1em] text-[var(--lumi-blue)]">
            ADOPTION &amp; MIGRATION
          </p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.03em] text-[var(--civic-navy)]">
            Where this organization is in the move to Lumi Agents
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-[var(--muted-strong)]">
            Every workspace here started on somebody's own machine. A workspace becomes
            organization-managed only when someone explicitly binds it to a project, and it can be
            returned to local-only at any time. Lumi Agents never uploads a local key, a prompt, a
            file, or an automation without a specific choice.
          </p>
        </div>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => void load()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {actionError ? (
        <ErrorNotice
          error={actionError}
          title="That change was not applied"
          onRetry={() => void load()}
        />
      ) : null}

      <nav
        aria-label="Adoption sections"
        className="flex gap-1 overflow-x-auto border-b border-[var(--border)]"
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={tab === entry.id ? "page" : undefined}
            onClick={() => setTab(entry.id)}
            className={[
              "-mb-px min-h-11 shrink-0 border-b-2 px-3 text-sm font-medium whitespace-nowrap outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2",
              tab === entry.id
                ? "border-[var(--lumi-blue)] text-[var(--civic-navy)]"
                : "border-transparent text-[var(--muted-strong)] hover:bg-[var(--panel-hover)] hover:text-[var(--civic-navy)]",
            ].join(" ")}
          >
            {entry.label}
            {entry.id === "remediation" &&
            summary.kind === "ready" &&
            summary.data.counts.open_remediations > 0 ? (
              <span className="ml-2 rounded-full bg-[var(--danger)]/10 px-1.5 py-0.5 text-xs font-semibold text-[var(--danger)]">
                {summary.data.counts.open_remediations}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {tab === "workspaces" ? (
        <WorkspacesTab
          state={summary}
          rows={rows}
          counts={counts}
          current={current}
          problems={
            summary.kind === "ready" && current
              ? problemCodesFor(summary.data.derived_remediations, current.adoption_state_id)
              : []
          }
          canManage={canManage}
          busy={busy}
          onSelect={setSelected}
          onAdvance={(key, workspace, stage) =>
            run(key, () =>
              client.advanceStage(
                orgId,
                workspace.adoption_state_id,
                { stage, version: workspace.version },
                key,
              ),
            )
          }
          onRollback={(key, workspace) =>
            run(key, () =>
              client.rollback(orgId, workspace.adoption_state_id, workspace.version, key),
            )
          }
          onRetry={() => void load()}
        />
      ) : null}

      {tab === "remediation" ? (
        <RemediationTab
          state={summary}
          rows={remediationList}
          canManage={canManage}
          busy={busy}
          onResolve={(key, remediationId, version) =>
            run(key, () => client.resolveRemediation(orgId, remediationId, version, key))
          }
          onRetry={() => void load()}
        />
      ) : null}

      {tab === "compatibility" ? <CompatibilityTab state={compatibility} /> : null}
    </div>
  );
}

async function settle<T>(load: () => Promise<T>): Promise<LoadState<T>> {
  try {
    return { kind: "ready", data: await load(), stale: false };
  } catch (error) {
    if (
      error instanceof ApiClientError &&
      (error.status === 403 || error.code === "permission_denied")
    ) {
      return { kind: "permission" };
    }
    return { kind: "error", error };
  }
}

export function WorkspacesTab({
  state,
  rows,
  counts,
  current,
  problems,
  canManage,
  busy,
  onSelect,
  onAdvance,
  onRollback,
  onRetry,
}: {
  state: LoadState<AdoptionSummary>;
  rows: WorkspaceAdoption[];
  counts: { stage: AdoptionStage | null; label: string; count: number }[];
  current: WorkspaceAdoption | null;
  /** The open problem codes the server derived for `current`. */
  problems: string[];
  canManage: boolean;
  busy: string | null;
  onSelect: (id: string) => void;
  onAdvance: (key: string, workspace: WorkspaceAdoption, stage: AdoptionStage) => void;
  onRollback: (key: string, workspace: WorkspaceAdoption) => void;
  onRetry: () => void;
}) {
  if (state.kind === "loading") return <LoadingRows label="Loading adoption state…" />;
  if (state.kind === "permission") return <PermissionState resource="adoption state" />;
  if (state.kind === "error") {
    return (
      <div className="p-5">
        <ErrorNotice
          error={state.error}
          title="Adoption state could not be loaded"
          onRetry={onRetry}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {state.kind === "ready" && state.data.counts.adopted_workspaces === 0 ? (
        <Notice tone="info">
          Nothing has been adopted yet, and that is a supported state. Every workspace in this
          organization still runs locally, and nothing about it has been uploaded. When someone is
          ready, binding a workspace is a deliberate step they take and can undo.
        </Notice>
      ) : null}

      <Surface ariaLabel="Workspaces by adoption stage">
        <SurfaceHeader
          title="Workspaces by stage"
          description="The distribution across the six stages. A stage moves one step at a time, and only when someone asks for it."
        />
        <dl className="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-6">
          {counts.map((entry) => (
            <div key={entry.stage} className="bg-[var(--panel)] px-4 py-3">
              <dt className="text-[11px] font-semibold tracking-[0.08em] text-[var(--muted)] uppercase">
                {entry.label}
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-[var(--civic-navy)]">
                {entry.count}
              </dd>
            </div>
          ))}
        </dl>
      </Surface>

      <Surface ariaLabel="Adopted workspaces">
        <SurfaceHeader
          title="Workspaces"
          description="Each row is one workspace on one machine. The reference column is the machine's own opaque identifier; Lumi Agents never receives a filesystem path."
        />
        {rows.length === 0 ? (
          <EmptyState
            title="No workspaces have been adopted"
            copy="A workspace appears here after someone signs in and chooses to bind it. Until then it runs entirely locally."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <caption className="sr-only">Adopted workspaces</caption>
              <thead className="bg-[var(--panel-hover)] text-xs text-[var(--muted)]">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Workspace
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Stage
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Owner
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Credential
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Client
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Project
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((workspace) => (
                  <tr
                    key={workspace.adoption_state_id}
                    className={
                      current?.adoption_state_id === workspace.adoption_state_id
                        ? "bg-[var(--lumi-blue-soft)]/55"
                        : "bg-[var(--panel)]"
                    }
                  >
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => onSelect(workspace.adoption_state_id)}
                        aria-pressed={current?.adoption_state_id === workspace.adoption_state_id}
                        aria-label={`View ${workspace.display_name}`}
                        className="max-w-[20rem] text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      >
                        <span className="block font-medium text-[var(--civic-navy)]">
                          {workspace.display_name}
                        </span>
                        <span className="mt-1 block font-mono text-xs text-[var(--muted)]">
                          {workspace.adoption_state_id}
                        </span>
                      </button>
                    </td>
                    <td className="px-5 py-4">
                      <Pill tone={stageTone(workspace.stage)}>
                        {workspace.stage ?? "unrecognized"}
                      </Pill>
                    </td>
                    <td className="px-5 py-4 text-xs text-[var(--muted-strong)]">
                      {workspace.ownership ? ownershipLabel(workspace.ownership) : "unrecognized"}
                    </td>
                    <td className="px-5 py-4">
                      <Pill tone={credentialModeTone(workspace.credential_mode)}>
                        {workspace.credential_mode
                          ? credentialModeLabel(workspace.credential_mode)
                          : "unrecognized"}
                      </Pill>
                    </td>
                    <td className="px-5 py-4 text-xs tabular-nums text-[var(--muted-strong)]">
                      v{workspace.client_app_version} · p{workspace.client_protocol_major} · s
                      {workspace.policy_schema_version}
                    </td>
                    <td className="px-5 py-4 text-xs text-[var(--muted-strong)]">
                      {workspace.bound_project_id ? (
                        <Code>{workspace.bound_project_id}</Code>
                      ) : (
                        <span className="text-[var(--muted)]">not bound</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-xs text-[var(--muted)]">
                      <DateTime value={workspace.updated_at} label="never updated" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {current ? (
        <WorkspaceDetail
          workspace={current}
          problems={problems}
          canManage={canManage}
          busy={busy}
          onAdvance={onAdvance}
          onRollback={onRollback}
        />
      ) : null}
    </div>
  );
}

export function WorkspaceDetail({
  workspace,
  problems,
  canManage,
  busy,
  onAdvance,
  onRollback,
}: {
  workspace: WorkspaceAdoption;
  /** The open problem codes the server derived for this workspace. */
  problems: string[];
  canManage: boolean;
  busy: string | null;
  onAdvance: (key: string, workspace: WorkspaceAdoption, stage: AdoptionStage) => void;
  onRollback: (key: string, workspace: WorkspaceAdoption) => void;
}) {
  const steps = stageLadder(workspace.stage);
  const next = workspace.stage ? (steps.find((step) => !step.reached)?.stage ?? null) : null;
  const problem = hasAdoptionProblem(workspace, problems);

  return (
    <Surface ariaLabel={`Workspace ${workspace.display_name}`}>
      <SurfaceHeader
        title={workspace.display_name}
        description="Where this workspace sits in the adoption path, and what the next step would do."
        actions={
          canManage ? (
            <>
              {next ? (
                <button
                  type="button"
                  className={primaryButtonClassLocal}
                  disabled={busy !== null}
                  onClick={() => onAdvance(idempotencyKey(), workspace, next)}
                >
                  {busy !== null
                    ? "Applying…"
                    : `Move to ${steps.find((step) => step.stage === next)?.label}`}
                </button>
              ) : null}
              {workspace.is_adopted ? (
                <button
                  type="button"
                  className={dangerButtonClass}
                  disabled={busy !== null}
                  onClick={() => onRollback(idempotencyKey(), workspace)}
                >
                  Return to local only
                </button>
              ) : null}
            </>
          ) : (
            <Pill tone="neutral">Read only</Pill>
          )
        }
      />
      <div className="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.08em] text-[var(--muted)] uppercase">
            The path, in order
          </p>
          <div className="mt-2">
            <StageLadder steps={steps} />
          </div>
        </div>
        <div>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <DefinitionRow label="Owner">
              {workspace.ownership ? ownershipLabel(workspace.ownership) : "unrecognized"}
            </DefinitionRow>
            <DefinitionRow label="Credential">
              {workspace.credential_mode ? (
                <>
                  <Pill tone={credentialModeTone(workspace.credential_mode)}>
                    {credentialModeLabel(workspace.credential_mode)}
                  </Pill>
                  <span className="mt-1 block text-xs text-[var(--muted-strong)]">
                    {credentialModeDetail(workspace.credential_mode)}
                  </span>
                </>
              ) : (
                "unrecognized"
              )}
            </DefinitionRow>
            <DefinitionRow label="Project">
              {workspace.bound_project_id ? <Code>{workspace.bound_project_id}</Code> : "not bound"}
            </DefinitionRow>
            <DefinitionRow label="Device">
              {workspace.bound_device_id ? <Code>{workspace.bound_device_id}</Code> : "not bound"}
            </DefinitionRow>
            <DefinitionRow label="Machine reference">
              {/* The client's own opaque identifiers. Deliberately shown as
                  identifiers and never as anything resembling a location. */}
              <Code>{workspace.external_workspace_key}</Code>
            </DefinitionRow>
            <DefinitionRow label="Rollbacks">
              {workspace.reversion_count === 0
                ? "none"
                : `${workspace.reversion_count} — last from ${
                    workspace.rolled_back_from_stage ?? "an earlier stage"
                  }`}
            </DefinitionRow>
            <DefinitionRow label="Adopted">
              <DateTime value={workspace.created_at} />
            </DefinitionRow>
            <DefinitionRow label="Last change">
              <DateTime value={workspace.updated_at} />
            </DefinitionRow>
          </dl>
          {!problem && workspace.is_adopted ? (
            <div className="mt-4">
              <Notice tone="success">
                This workspace is adopted and nothing is wrong with it.
              </Notice>
            </div>
          ) : null}
        </div>
      </div>
    </Surface>
  );
}

export function RemediationTab({
  state,
  rows,
  canManage,
  busy,
  onResolve,
  onRetry,
}: {
  state: LoadState<AdoptionSummary>;
  rows: ReturnType<typeof remediationRows>;
  canManage: boolean;
  busy: string | null;
  onResolve: (key: string, remediationId: string, version: number) => void;
  onRetry: () => void;
}) {
  if (state.kind === "loading") return <LoadingRows label="Loading remediation…" />;
  if (state.kind === "permission") return <PermissionState resource="adoption remediation" />;
  if (state.kind === "error") {
    return (
      <div className="p-5">
        <ErrorNotice
          error={state.error}
          title="Remediation could not be loaded"
          onRetry={onRetry}
        />
      </div>
    );
  }

  const open = rows.filter((row) => row.open);
  const resolved = rows.filter((row) => !row.open);

  return (
    <div className="space-y-5">
      <Notice tone="info">
        A workspace that has adopted nothing is never listed here. Remediations are derived from
        what Lumi Agents can observe, and they appear only once a workspace is actually managed.
      </Notice>

      <Surface ariaLabel="Open remediation">
        <SurfaceHeader
          title="Needs attention"
          description="One action per problem. Nothing here can change a local workspace: every item is about what the organization can see, not about what is on the machine."
        />
        {open.length === 0 ? (
          <EmptyState
            title="Nothing needs attention"
            copy="Every managed workspace in this organization has a current client, an acknowledged policy, and a credential mode somebody chose."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {open.map((row) => (
              <li
                key={row.key}
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={remediationTone(row)}>
                      {row.unrecognized ? "unrecognized" : "open"}
                    </Pill>
                    <p className="text-sm font-semibold text-[var(--civic-navy)]">{row.label}</p>
                  </div>
                  {row.remedyAction ? (
                    <p className="mt-1 text-sm leading-5 text-[var(--muted-strong)]">
                      {row.remedyAction}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {row.code ?? row.rawCode}
                    {row.stageLabel ? ` · ${row.stageLabel}` : ""}
                    {row.workspaceId ? ` · ${row.workspaceId}` : ""}
                  </p>
                </div>
                {canManage && !row.unrecognized && !row.key.startsWith("derived:") ? (
                  <button
                    type="button"
                    className={ghostButtonClass}
                    disabled={busy !== null}
                    onClick={() => onResolve(idempotencyKey(), row.key, row.version)}
                  >
                    Mark resolved
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Surface>

      {resolved.length > 0 ? (
        <Surface ariaLabel="Resolved remediation">
          <SurfaceHeader
            title="Resolved"
            description="Kept so the history of a migration is readable. A resolved row records who resolved it and when; it never records a note."
          />
          <ul className="divide-y divide-[var(--border)]">
            {resolved.map((row) => (
              <li
                key={row.key}
                className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm text-[var(--civic-navy)]">{row.label}</p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">{row.code ?? row.rawCode}</p>
                </div>
                <DateTime value={row.resolvedAt} label="no resolution time recorded" />
              </li>
            ))}
          </ul>
        </Surface>
      ) : null}
    </div>
  );
}

export function CompatibilityTab({ state }: { state: LoadState<Compatibility> }) {
  if (state.kind === "loading") return <LoadingRows label="Loading compatibility…" rows={2} />;
  if (state.kind === "error") {
    return (
      <div className="p-5">
        <ErrorNotice
          error={state.error}
          title="The compatibility answer could not be read"
          onRetry={() => undefined}
        />
      </div>
    );
  }
  if (state.kind === "permission") return <PermissionState resource="compatibility" />;

  const { data } = state;
  return (
    <div className="space-y-5">
      <Surface ariaLabel="Client compatibility">
        <SurfaceHeader
          title="What this control plane supports"
          description="A client outside these ranges keeps running locally. It simply does not receive organization policy, credentials, or budgets — which is what makes the upgrade a choice rather than a wall."
        />
        <dl className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
          <DefinitionRow label="Contract version">
            <Code>{data.contract_version}</Code>
          </DefinitionRow>
          <DefinitionRow label="Client protocols">
            <Code>{data.supported_protocols.join(", ")}</Code>
          </DefinitionRow>
          <DefinitionRow label="Policy schema versions">
            <Code>{data.supported_policy_schema_versions.join(", ")}</Code>
          </DefinitionRow>
          <DefinitionRow label="Minimum client build">
            <Code>{data.min_client_app_version}</Code>
          </DefinitionRow>
          <DefinitionRow label="Local-only clients">
            <Pill tone="success">{data.local_only_eligible ? "supported" : "not supported"}</Pill>
          </DefinitionRow>
          <DefinitionRow label="History sync (stage 5)">
            <Pill tone={data.history_sync_eligible ? "info" : "neutral"}>
              {data.history_sync_eligible ? "available" : "not available yet"}
            </Pill>
          </DefinitionRow>
        </dl>
        {!data.history_sync_eligible ? (
          <div className="px-5 pb-4">
            <Notice tone="info">
              History sync is off. It is the last stage of the adoption path and stays off until the
              retention controls it depends on are mature, so no workspace can record consent to
              upload it has not been offered.
            </Notice>
          </div>
        ) : null}
      </Surface>

      <Surface ariaLabel="Never uploaded">
        <SurfaceHeader
          title="What is never uploaded"
          description="Not a policy statement; these have nowhere to go in the schema. There is no column for a prompt, a file, a path, an automation body, or a secret."
        />
        <ul className="grid gap-2 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            "Local API keys",
            "Historical prompts",
            "Files and workspace contents",
            "Local automations",
            "MCP credentials",
            "Filesystem paths",
          ].map((entry) => (
            <li
              key={entry}
              className="rounded-lg border border-[var(--border)] bg-[var(--panel-hover)] px-3 py-2 text-sm text-[var(--civic-navy)]"
            >
              {entry}
            </li>
          ))}
        </ul>
      </Surface>
    </div>
  );
}

const primaryButtonClassLocal =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--lumi-blue)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-button)] outline-none transition hover:bg-[var(--lumi-blue-hover)] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * An idempotency key per user action.
 *
 * Every adoption mutation is a compare-and-set server-side, so a retried click
 * replays the stored success rather than applying the change twice. A key is
 * minted per action rather than per render so two clicks are two attempts and one
 * click retried is one.
 */
function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p08-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
