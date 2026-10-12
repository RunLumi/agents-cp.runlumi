/**
 * Organization audit log (F22 "Audit Log", F16 FR-F16-001/003).
 *
 * Answers "who did what, to which resource, when, from where, with what
 * outcome" for one organization. The server is the only authority: the route
 * re-checks session, membership and `audit.read` and scopes every query to the
 * path organization, so this panel only renders what it is given and shows an
 * explicit permission state on a 403.
 *
 * Every identifier is rendered in full so a desktop managed run can be matched
 * against its run, request and correlation ids; clicking one narrows the log to
 * it. Event metadata is never rendered beyond the project id the route itself
 * filters on.
 *
 * Primitives are local, following the feature-local precedent in
 * `features/webhooks/ui.tsx`: no shared design-system components are generated
 * in this repository yet, and all styling uses the semantic tokens.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { listOrgAudit, type OrgAuditEvent, type Page } from "@/lib/api";
import { presentApiError } from "@/lib/errors";

import {
  activeAuditFilterCount,
  AUDIT_OUTCOMES,
  AUDIT_PAGE_SIZE,
  auditActorKind,
  auditFilterProblem,
  auditFiltersFromSearch,
  auditOutcomeTone,
  auditProjectId,
  auditQueryFromFilters,
  auditSearchFromFilters,
  emptyAuditFilters,
  formatAuditTime,
  isAuditPermissionFailure,
  isoToLocalInput,
  localInputToIso,
  type AuditFilterKey,
  type AuditFilters,
} from "./audit-helpers";

export interface AuditPanelProps {
  orgId: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; page: Page<OrgAuditEvent>; refreshing: boolean }
  | { kind: "error"; error: unknown };

export function AuditPanel({ orgId }: AuditPanelProps) {
  const [applied, setApplied] = useState<AuditFilters>(() =>
    auditFiltersFromSearch(window.location.search),
  );
  // `cursors[n]` is the cursor that loads page `n`; page 0 has none.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const generation = useRef(0);
  const headingId = useId();

  const cursor = cursors[pageIndex];

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setLoad((previous) =>
      previous.kind === "ready" ? { ...previous, refreshing: true } : { kind: "loading" },
    );
    listOrgAudit(orgId, auditQueryFromFilters(applied, cursor), controller.signal)
      .then((page) => {
        if (current !== generation.current) return;
        setLoad({ kind: "ready", page, refreshing: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || current !== generation.current) return;
        setLoad({ kind: "error", error });
      });
    return () => controller.abort();
  }, [orgId, applied, cursor, reloadKey]);

  // Filters live in the URL so a filtered view is a shareable link. The path is
  // owned by the dashboard; only the query string is replaced here.
  const applyFilters = useCallback((next: AuditFilters) => {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${auditSearchFromFilters(next)}`,
    );
    setApplied(next);
    setCursors([undefined]);
    setPageIndex(0);
  }, []);

  const filterBy = useCallback(
    (key: AuditFilterKey, value: string) => applyFilters({ ...emptyAuditFilters(), [key]: value }),
    [applyFilters],
  );

  function showOlder() {
    if (load.kind !== "ready" || !load.page.next_cursor) return;
    const nextCursor = load.page.next_cursor;
    setCursors((previous) => [...previous.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((index) => index + 1);
  }

  const filterCount = activeAuditFilterCount(applied);

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow)]"
    >
      <div className="border-b border-[var(--border)] px-4 py-4 sm:px-5">
        <h2 id={headingId} className="text-lg font-semibold text-[var(--civic-navy)]">
          Audit log
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-5 text-[var(--muted-strong)]">
          Immutable record of who did what in this organization, from which device, and with what
          outcome. Events cannot be edited or deleted here. Prompts, file contents and secrets are
          never recorded in this view.
        </p>
      </div>

      <AuditFilterForm applied={applied} onApply={applyFilters} />

      <div aria-live="polite" className="sr-only">
        {load.kind === "ready" && !load.refreshing
          ? `${load.page.items.length} audit event${load.page.items.length === 1 ? "" : "s"} shown`
          : ""}
      </div>

      {load.kind === "loading" ? <LoadingRows /> : null}

      {load.kind === "error" ? (
        isAuditPermissionFailure(load.error) ? (
          <div className="p-4 sm:p-5">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-hover)] p-5">
              <p className="text-sm font-semibold text-[var(--civic-navy)]">Access not permitted</p>
              <p className="mt-1 text-sm leading-5 text-[var(--muted-strong)]">
                Your current membership cannot view this organization’s audit log. Ask an owner or
                administrator to review your access.
              </p>
            </div>
          </div>
        ) : (
          <AuditError
            error={load.error}
            onRetry={() => setReloadKey((value) => value + 1)}
            onReset={() => applyFilters(emptyAuditFilters())}
          />
        )
      ) : null}

      {load.kind === "ready" ? (
        load.page.items.length === 0 ? (
          <div className="p-6">
            <p className="text-sm font-semibold text-[var(--civic-navy)]">
              {filterCount > 0 ? "No events match these filters" : "No audit events yet"}
            </p>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-[var(--muted-strong)]">
              {filterCount > 0
                ? "Widen the time range or clear a filter. Identifier filters match exactly."
                : "Membership, device, policy, run and automation activity will appear here as it happens."}
            </p>
            {filterCount > 0 ? (
              <button
                type="button"
                className={`${secondaryButtonClass} mt-4`}
                onClick={() => applyFilters(emptyAuditFilters())}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <div aria-busy={load.refreshing} className={load.refreshing ? "opacity-60" : undefined}>
            <AuditTable events={load.page.items} onFilter={filterBy} />
            <AuditList events={load.page.items} onFilter={filterBy} />
          </div>
        )
      ) : null}

      {load.kind === "ready" && (pageIndex > 0 || load.page.has_more) ? (
        <nav
          aria-label="Audit log pages"
          className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3 sm:px-5"
        >
          <p className="text-xs text-[var(--muted)]">
            Page {pageIndex + 1} · newest first · up to {AUDIT_PAGE_SIZE} per page
            {load.refreshing ? " · updating…" : ""}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={pageIndex === 0 || load.refreshing}
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            >
              Newer
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={!load.page.has_more || load.refreshing}
              onClick={showOlder}
            >
              Older
            </button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

const PRIMARY_FILTERS: { key: AuditFilterKey; label: string; placeholder: string }[] = [
  { key: "action", label: "Action", placeholder: "automation.occurrence.started.v1" },
  { key: "run_id", label: "Run id", placeholder: "run_…" },
  { key: "correlation_id", label: "Correlation id", placeholder: "req_…" },
];

const MORE_FILTERS: { key: AuditFilterKey; label: string; placeholder: string }[] = [
  { key: "actor", label: "Actor id", placeholder: "usr_…" },
  { key: "device_id", label: "Device id", placeholder: "dvc_…" },
  { key: "project_id", label: "Project id", placeholder: "prj_…" },
  { key: "request_id", label: "Request id", placeholder: "req_…" },
  { key: "resource_type", label: "Resource type", placeholder: "automation_occurrence" },
  { key: "resource_id", label: "Resource id", placeholder: "occ_…" },
];

function AuditFilterForm({
  applied,
  onApply,
}: {
  applied: AuditFilters;
  onApply: (next: AuditFilters) => void;
}) {
  const [draft, setDraft] = useState<AuditFilters>(applied);
  const formId = useId();
  // An applied change from outside the form (an id link, a reset) replaces the draft.
  useEffect(() => setDraft(applied), [applied]);

  const moreActive =
    MORE_FILTERS.some(({ key }) => applied[key]) || Boolean(applied.from || applied.to);
  const set = (key: AuditFilterKey, value: string) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  return (
    <form
      aria-label="Filter audit events"
      className="border-b border-[var(--border)] px-4 py-4 sm:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {PRIMARY_FILTERS.map(({ key, label, placeholder }) => (
          <FilterInput
            key={key}
            id={`${formId}-${key}`}
            label={label}
            placeholder={placeholder}
            value={draft[key]}
            onChange={(value) => set(key, value)}
          />
        ))}
        <label className={labelClass} htmlFor={`${formId}-outcome`}>
          Outcome
          <select
            id={`${formId}-outcome`}
            className={inputClass}
            value={draft.outcome}
            onChange={(event) => set("outcome", event.target.value)}
          >
            <option value="">Any outcome</option>
            {AUDIT_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcome[0]?.toUpperCase()}
                {outcome.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="mt-3" open={moreActive}>
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-1 text-sm font-medium text-[var(--lumi-blue)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
          More filters
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {MORE_FILTERS.map(({ key, label, placeholder }) => (
            <FilterInput
              key={key}
              id={`${formId}-${key}`}
              label={label}
              placeholder={placeholder}
              value={draft[key]}
              onChange={(value) => set(key, value)}
            />
          ))}
          <label className={labelClass} htmlFor={`${formId}-from`}>
            From (local time)
            <input
              id={`${formId}-from`}
              type="datetime-local"
              className={inputClass}
              value={isoToLocalInput(draft.from)}
              onChange={(event) => set("from", localInputToIso(event.target.value))}
            />
          </label>
          <label className={labelClass} htmlFor={`${formId}-to`}>
            To (local time)
            <input
              id={`${formId}-to`}
              type="datetime-local"
              className={inputClass}
              value={isoToLocalInput(draft.to)}
              onChange={(event) => set("to", localInputToIso(event.target.value))}
            />
          </label>
        </div>
      </details>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass}>
          Apply filters
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={activeAuditFilterCount(applied) === 0 && activeAuditFilterCount(draft) === 0}
          onClick={() => onApply(emptyAuditFilters())}
        >
          Clear
        </button>
      </div>
    </form>
  );
}

function FilterInput({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={labelClass} htmlFor={id}>
      {label}
      <input
        id={id}
        className={`${inputClass} font-mono text-xs`}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        maxLength={256}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

type FilterBy = (key: AuditFilterKey, value: string) => void;

/** Desktop and tablet: a dense table. Below `md` the stacked list renders instead. */
export function AuditTable({
  events,
  onFilter,
}: {
  events: readonly OrgAuditEvent[];
  onFilter: FilterBy;
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[1040px] text-left text-sm">
        <caption className="sr-only">Audit events, newest first</caption>
        <thead className="bg-[var(--panel-hover)] text-xs text-[var(--muted)]">
          <tr>
            {["Time", "Event", "Actor", "Device", "Project", "Resource", "Correlation"].map(
              (heading) => (
                <th key={heading} scope="col" className="px-4 py-2.5 font-medium">
                  {heading}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)] align-top">
          {events.map((event) => {
            const actor = auditActorKind(event);
            const project = auditProjectId(event);
            return (
              <tr key={event.event_id}>
                <td className="px-4 py-3 text-xs whitespace-nowrap text-[var(--muted-strong)]">
                  <time dateTime={event.created_at}>{formatAuditTime(event.created_at)}</time>
                </td>
                <td className="px-4 py-3">
                  <p className="font-mono text-xs break-all text-[var(--civic-navy)]">
                    {event.action}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    <OutcomePill outcome={event.outcome} />
                    {event.reason ? (
                      <span className="font-mono text-xs text-[var(--muted)]">{event.reason}</span>
                    ) : null}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <Pill tone={actor.tone}>{actor.label}</Pill>
                  {event.actor_id ? (
                    <IdButton
                      value={event.actor_id}
                      label="actor"
                      onClick={() => onFilter("actor", event.actor_id ?? "")}
                    />
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  {event.device_id ? (
                    <IdButton
                      value={event.device_id}
                      label="device"
                      onClick={() => onFilter("device_id", event.device_id ?? "")}
                    />
                  ) : (
                    <Muted>—</Muted>
                  )}
                </td>
                <td className="px-4 py-3">
                  {project ? (
                    <IdButton
                      value={project}
                      label="project"
                      onClick={() => onFilter("project_id", project)}
                    />
                  ) : (
                    <Muted>—</Muted>
                  )}
                </td>
                <td className="px-4 py-3">
                  <p className="text-xs text-[var(--muted-strong)]">{event.resource_type}</p>
                  {event.resource_id ? (
                    <IdButton
                      value={event.resource_id}
                      label="resource"
                      onClick={() => onFilter("resource_id", event.resource_id ?? "")}
                    />
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <CorrelationIds event={event} onFilter={onFilter} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AuditList({
  events,
  onFilter,
}: {
  events: readonly OrgAuditEvent[];
  onFilter: FilterBy;
}) {
  return (
    <ul
      className="divide-y divide-[var(--border)] md:hidden"
      aria-label="Audit events, newest first"
    >
      {events.map((event) => {
        const actor = auditActorKind(event);
        const project = auditProjectId(event);
        return (
          <li key={event.event_id} className="px-4 py-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <OutcomePill outcome={event.outcome} />
              <Pill tone={actor.tone}>{actor.label}</Pill>
              <time dateTime={event.created_at} className="text-xs text-[var(--muted-strong)]">
                {formatAuditTime(event.created_at)}
              </time>
            </div>
            <p className="mt-2 font-mono text-xs break-all text-[var(--civic-navy)]">
              {event.action}
            </p>
            {event.reason ? (
              <p className="mt-1 font-mono text-xs text-[var(--muted)]">{event.reason}</p>
            ) : null}
            <dl className="mt-3 grid gap-2 text-xs">
              {event.actor_id ? (
                <Field label="Actor">
                  <IdButton
                    value={event.actor_id}
                    label="actor"
                    onClick={() => onFilter("actor", event.actor_id ?? "")}
                  />
                </Field>
              ) : null}
              {event.device_id ? (
                <Field label="Device">
                  <IdButton
                    value={event.device_id}
                    label="device"
                    onClick={() => onFilter("device_id", event.device_id ?? "")}
                  />
                </Field>
              ) : null}
              {project ? (
                <Field label="Project">
                  <IdButton
                    value={project}
                    label="project"
                    onClick={() => onFilter("project_id", project)}
                  />
                </Field>
              ) : null}
              <Field label="Resource">
                <span className="text-[var(--muted-strong)]">{event.resource_type}</span>
                {event.resource_id ? (
                  <IdButton
                    value={event.resource_id}
                    label="resource"
                    onClick={() => onFilter("resource_id", event.resource_id ?? "")}
                  />
                ) : null}
              </Field>
              <Field label="Correlation">
                <CorrelationIds event={event} onFilter={onFilter} />
              </Field>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function CorrelationIds({ event, onFilter }: { event: OrgAuditEvent; onFilter: FilterBy }) {
  return (
    <dl className="grid gap-1 text-xs">
      {event.run_id ? (
        <LabeledId label="Run">
          <IdButton
            value={event.run_id}
            label="run"
            onClick={() => onFilter("run_id", event.run_id ?? "")}
          />
        </LabeledId>
      ) : null}
      <LabeledId label="Correlation">
        <IdButton
          value={event.correlation_id}
          label="correlation"
          onClick={() => onFilter("correlation_id", event.correlation_id)}
        />
      </LabeledId>
      {event.request_id !== event.correlation_id ? (
        <LabeledId label="Request">
          <IdButton
            value={event.request_id}
            label="request"
            onClick={() => onFilter("request_id", event.request_id)}
          />
        </LabeledId>
      ) : null}
    </dl>
  );
}

function LabeledId({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
      <dt className="pt-1 text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** A full identifier that narrows the log to itself. Never truncated: ids are matched by eye. */
function IdButton({
  value,
  label,
  onClick,
}: {
  value: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show only events for ${label} ${value}`}
      className="block min-h-6 max-w-full rounded px-0.5 text-left font-mono text-xs break-all text-[var(--lumi-blue)] underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      {value}
    </button>
  );
}

function OutcomePill({ outcome }: { outcome: string }) {
  const tone = auditOutcomeTone(outcome);
  return <Pill tone={tone}>{outcome}</Pill>;
}

type PillTone = "neutral" | "info" | "success" | "warning" | "danger";

function Pill({ children, tone }: { children: ReactNode; tone: PillTone }) {
  const toneClass = {
    neutral: "bg-[var(--panel-strong)] text-[var(--muted-strong)]",
    info: "bg-[var(--lumi-blue-soft)] text-[var(--lumi-blue)]",
    success: "bg-[var(--success)]/10 text-[var(--success)]",
    warning: "bg-[var(--warning)]/15 text-[var(--civic-navy)]",
    danger: "bg-[var(--danger)]/10 text-[var(--danger)]",
  }[tone];
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${toneClass}`}
    >
      {children}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs text-[var(--muted)]">{children}</span>;
}

function LoadingRows() {
  return (
    <div className="p-5" role="status" aria-live="polite" aria-busy="true">
      <p className="text-sm text-[var(--muted-strong)]">Loading audit events…</p>
      <div className="mt-4 space-y-2" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-10 animate-pulse rounded-lg bg-[var(--panel-hover)]" />
        ))}
      </div>
    </div>
  );
}

function AuditError({
  error,
  onRetry,
  onReset,
}: {
  error: unknown;
  onRetry: () => void;
  onReset: () => void;
}) {
  const presentation = presentApiError(error);
  const filterProblem = auditFilterProblem(error);
  return (
    <div className="p-4 sm:p-5">
      <div
        role="alert"
        className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-4 text-sm text-[var(--danger)]"
      >
        <p className="font-semibold">
          {filterProblem ? "The filters were not accepted" : "The audit log could not be loaded"}
        </p>
        <p className="mt-1">{filterProblem ?? presentation.message}</p>
        <p className="mt-1 text-xs opacity-75">
          Nothing was changed. Reason code {presentation.code}
        </p>
        {presentation.requestId ? (
          <p className="mt-1 break-all text-xs opacity-75">Request {presentation.requestId}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {filterProblem ? (
            <button type="button" className={dangerButtonClass} onClick={onReset}>
              Clear filters
            </button>
          ) : (
            <button type="button" className={dangerButtonClass} onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const labelClass = "block text-xs font-medium text-[var(--civic-navy)]";

const inputClass =
  "mt-1.5 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-sm font-normal text-[var(--foreground)] outline-none transition placeholder:text-[var(--muted)] focus-visible:border-[var(--lumi-blue)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2";

const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--lumi-blue)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-button)] outline-none transition hover:bg-[var(--lumi-blue-hover)] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--lumi-blue)]/40 bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--lumi-blue)] outline-none transition hover:border-[var(--lumi-blue)]/60 hover:bg-[var(--lumi-blue-soft)] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const dangerButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--danger)]/40 bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--danger)] outline-none transition hover:bg-[var(--danger)]/5 active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
