/**
 * Pure helpers for the organization audit log (F16 FR-F16-003, F22 "Audit Log").
 *
 * The route is `GET /api/v1/orgs/{org_id}/audit`. Filters are URL-backed
 * (FR-F22-004), so a link to a filtered view — for example every event for one
 * run or one correlation id — is shareable and survives a reload. Only filters
 * the API already accepts exist here; nothing is filtered client-side.
 */

import type { OrgAuditEvent, OrgAuditQuery } from "@/lib/api";
import { ApiClientError } from "@/lib/errors";

export const AUDIT_PAGE_SIZE = 50;

/** Wire names, in the order the filter form shows them. */
export const AUDIT_FILTER_KEYS = [
  "action",
  "outcome",
  "run_id",
  "correlation_id",
  "actor",
  "device_id",
  "project_id",
  "request_id",
  "resource_type",
  "resource_id",
  "from",
  "to",
] as const;

export type AuditFilterKey = (typeof AUDIT_FILTER_KEYS)[number];
export type AuditFilters = Record<AuditFilterKey, string>;

export const AUDIT_OUTCOMES = ["success", "denied", "failure"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** The longest value a filter may carry; the server bounds identifiers well below this. */
const MAX_FILTER_LENGTH = 256;

export function emptyAuditFilters(): AuditFilters {
  return Object.fromEntries(AUDIT_FILTER_KEYS.map((key) => [key, ""])) as AuditFilters;
}

function isOutcome(value: string): value is AuditOutcome {
  return (AUDIT_OUTCOMES as readonly string[]).includes(value);
}

/** Read filters from a location search string. Unknown keys and invalid outcomes are dropped. */
export function auditFiltersFromSearch(search: string): AuditFilters {
  const params = new URLSearchParams(search);
  const filters = emptyAuditFilters();
  for (const key of AUDIT_FILTER_KEYS) {
    const value = (params.get(key) ?? "").trim();
    if (value.length === 0 || value.length > MAX_FILTER_LENGTH) continue;
    if (key === "outcome" && !isOutcome(value)) continue;
    filters[key] = value;
  }
  return filters;
}

/** The search string for a filter set: `""` when nothing is filtered, otherwise `?a=b`. */
export function auditSearchFromFilters(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const key of AUDIT_FILTER_KEYS) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function activeAuditFilterCount(filters: AuditFilters): number {
  return AUDIT_FILTER_KEYS.filter((key) => filters[key].trim().length > 0).length;
}

/** Translate applied filters and a page cursor into the API query. */
export function auditQueryFromFilters(filters: AuditFilters, cursor?: string): OrgAuditQuery {
  const query: OrgAuditQuery = { limit: AUDIT_PAGE_SIZE };
  if (cursor) query.cursor = cursor;
  for (const key of AUDIT_FILTER_KEYS) {
    const value = filters[key].trim();
    if (!value) continue;
    if (key === "outcome") {
      if (isOutcome(value)) query.outcome = value;
      continue;
    }
    query[key] = value;
  }
  return query;
}

/**
 * `<input type="datetime-local">` value (viewer's local time) to the API's UTC
 * timestamp shape (`2026-10-11T16:00:00.000Z`). An unparseable value is `""`.
 */
export function localInputToIso(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** The inverse of {@link localInputToIso}, for showing an applied bound in the form. */
export function isoToLocalInput(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export type ActorTone = "neutral" | "info" | "warning";

export interface ActorKind {
  label: string;
  tone: ActorTone;
}

/**
 * Who acted, in the reader's terms.
 *
 * `security_events.actor_type` has no `device` value: a device-token request
 * that acts without a human principal is recorded as `system` with the device
 * id set. Showing that row as "System" would hide that a desktop did it, so the
 * device id decides. A Lumi staff/support actor stays visibly distinct from a
 * customer actor (F16 acceptance criteria).
 */
export function auditActorKind(
  event: Pick<OrgAuditEvent, "actor_type" | "device_id" | "actor_id" | "effective_user_id">,
): ActorKind {
  switch (event.actor_type) {
    case "user":
      return event.effective_user_id && event.effective_user_id !== event.actor_id
        ? { label: "Human (delegated)", tone: "info" }
        : { label: "Human", tone: "info" };
    case "service_account":
      return { label: "Service account", tone: "neutral" };
    case "staff":
    case "support":
      return { label: "Lumi support", tone: "warning" };
    case "anonymous":
      return { label: "Anonymous", tone: "neutral" };
    case "system":
      return event.device_id
        ? { label: "Device", tone: "neutral" }
        : { label: "System", tone: "neutral" };
    default:
      return { label: event.actor_type || "Unknown", tone: "neutral" };
  }
}

const PROJECT_ID = /^prj_[0-9a-f]{32}$/;

/**
 * The project an event concerns. The route filters on `metadata.project_id`, so
 * that is the only metadata key this surface reads. The rest of `metadata` is
 * never rendered: it is bounded server-side, but an audit viewer has no reason
 * to display free-form fields, and F16 forbids revealing masked material.
 */
export function auditProjectId(event: Pick<OrgAuditEvent, "metadata">): string | null {
  const value = event.metadata["project_id"];
  return typeof value === "string" && PROJECT_ID.test(value) ? value : null;
}

export type AuditOutcomeTone = "success" | "warning" | "danger" | "neutral";

export function auditOutcomeTone(outcome: string): AuditOutcomeTone {
  if (outcome === "success") return "success";
  if (outcome === "denied") return "warning";
  if (outcome === "failure") return "danger";
  return "neutral";
}

export function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function isAuditPermissionFailure(error: unknown): boolean {
  return (
    error instanceof ApiClientError && (error.status === 403 || error.code === "permission_denied")
  );
}

/** Copy for a refused filter, keyed by the route's stable reason. `null` means use the generic error. */
export function auditFilterProblem(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) return null;
  const reason = typeof error.details["reason"] === "string" ? error.details["reason"] : null;
  switch (reason) {
    case "audit_filter_invalid":
      return "One of the identifier filters is not a valid id. Check the run, request, or correlation id and try again.";
    case "audit_time_range_invalid":
      return "The time range is invalid. The start must be before the end.";
    case "audit_outcome_invalid":
      return "The outcome filter is not recognised.";
    case "actor_filter_invalid":
    case "resource_filter_invalid":
      return "Two conflicting filters were supplied. Clear the filters and try again.";
    case "invalid_cursor":
      return "This page is no longer available. Return to the newest events.";
    default:
      return null;
  }
}
