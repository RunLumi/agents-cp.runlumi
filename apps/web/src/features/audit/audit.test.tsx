import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listOrgAudit, type OrgAuditEvent } from "@/lib/api";
import { ApiClientError } from "@/lib/errors";
import { pathForSection, sectionFromPath } from "@/features/organizations/org-dashboard";

import {
  activeAuditFilterCount,
  auditActorKind,
  auditFilterProblem,
  auditFiltersFromSearch,
  auditProjectId,
  auditQueryFromFilters,
  auditSearchFromFilters,
  emptyAuditFilters,
  isAuditPermissionFailure,
  isoToLocalInput,
  localInputToIso,
} from "./audit-helpers";
import { AuditList, AuditTable } from "./audit-panel";

const ORG = "org_0123456789abcdef0123456789abcdef";
const RUN = "run_0123456789abcdef0123456789abcdef";
const DEVICE = "dvc_0123456789abcdef0123456789abcdef";
const PROJECT = "prj_0123456789abcdef0123456789abcdef";
const REQUEST = "req_0123456789abcdef0123456789abcdef";
const CORRELATION = "req_fedcba9876543210fedcba9876543210";
const SECRET_LIKE = "fixture-prompt-text-must-not-render";

function event(overrides: Partial<OrgAuditEvent> = {}): OrgAuditEvent {
  return {
    event_id: "sev_0123456789abcdef0123456789abcdef",
    org_id: ORG,
    actor_type: "system",
    actor_id: null,
    effective_user_id: null,
    session_id: null,
    device_id: DEVICE,
    run_id: RUN,
    agent_session_id: null,
    tool_call_id: null,
    action: "automation.occurrence.started.v1",
    resource_type: "automation_occurrence",
    resource_id: "occ_0123456789abcdef0123456789abcdef",
    outcome: "success",
    reason: null,
    metadata: { project_id: PROJECT, note: SECRET_LIKE },
    request_id: REQUEST,
    correlation_id: CORRELATION,
    created_at: "2026-10-11T16:00:00.000Z",
    ...overrides,
  };
}

describe("audit filters", () => {
  it("round-trips only known filters through the URL and drops invalid outcomes", () => {
    const filters = auditFiltersFromSearch(
      `?run_id=${RUN}&outcome=exploded&unknown=x&correlation_id=%20${CORRELATION}%20`,
    );
    expect(filters.run_id).toBe(RUN);
    expect(filters.correlation_id).toBe(CORRELATION);
    expect(filters.outcome).toBe("");
    expect(activeAuditFilterCount(filters)).toBe(2);
    expect(auditFiltersFromSearch(auditSearchFromFilters(filters))).toEqual(filters);
    expect(auditSearchFromFilters(emptyAuditFilters())).toBe("");
  });

  it("builds a bounded API query with the cursor and only non-empty filters", () => {
    const filters = { ...emptyAuditFilters(), device_id: DEVICE, outcome: "denied" };
    expect(auditQueryFromFilters(filters, "cursor-1")).toEqual({
      limit: 50,
      cursor: "cursor-1",
      device_id: DEVICE,
      outcome: "denied",
    });
    expect(auditQueryFromFilters(emptyAuditFilters())).toEqual({ limit: 50 });
  });

  it("converts local datetime input to the server timestamp shape and back", () => {
    const iso = localInputToIso("2026-10-11T09:30");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isoToLocalInput(iso)).toBe("2026-10-11T09:30");
    expect(localInputToIso("not a date")).toBe("");
  });
});

describe("audit presentation", () => {
  it("labels a device-token system event as Device and keeps Lumi support distinct", () => {
    expect(auditActorKind(event()).label).toBe("Device");
    expect(auditActorKind(event({ device_id: null })).label).toBe("System");
    expect(
      auditActorKind(event({ actor_type: "user", actor_id: "usr_1", effective_user_id: "usr_1" }))
        .label,
    ).toBe("Human");
    expect(auditActorKind(event({ actor_type: "staff", actor_id: "staff_1" })).label).toBe(
      "Lumi support",
    );
  });

  it("reads only a well-formed project id from metadata", () => {
    expect(auditProjectId(event())).toBe(PROJECT);
    expect(auditProjectId(event({ metadata: { project_id: "../../etc" } }))).toBeNull();
    expect(auditProjectId(event({ metadata: {} }))).toBeNull();
  });

  it("renders full correlation identifiers and never the metadata body", () => {
    const rows = [event(), event({ event_id: "sev_1", actor_type: "user", actor_id: "usr_1" })];
    for (const markup of [
      renderToStaticMarkup(<AuditTable events={rows} onFilter={() => undefined} />),
      renderToStaticMarkup(<AuditList events={rows} onFilter={() => undefined} />),
    ]) {
      for (const id of [RUN, DEVICE, PROJECT, REQUEST, CORRELATION]) expect(markup).toContain(id);
      expect(markup).toContain("Device");
      expect(markup).toContain("Human");
      expect(markup).toContain("automation.occurrence.started.v1");
      expect(markup).not.toContain(SECRET_LIKE);
      expect(markup).toContain('dateTime="2026-10-11T16:00:00.000Z"');
    }
  });

  it("gives every identifier an accessible filter action", () => {
    const markup = renderToStaticMarkup(
      <AuditTable events={[event()]} onFilter={() => undefined} />,
    );
    expect(markup).toContain(`aria-label="Show only events for run ${RUN}"`);
    expect(markup).toContain(`aria-label="Show only events for device ${DEVICE}"`);
    expect(markup).toContain(`aria-label="Show only events for correlation ${CORRELATION}"`);
  });

  it("maps refused filters and permission failures to explicit states", () => {
    const filterError = new ApiClientError({
      code: "validation_failed",
      kind: "api",
      status: 422,
      requestId: REQUEST,
      details: { reason: "audit_filter_invalid" },
      retryable: false,
    });
    expect(auditFilterProblem(filterError)).toMatch(/not a valid id/);
    const denied = new ApiClientError({
      code: "permission_denied",
      kind: "api",
      status: 403,
      requestId: REQUEST,
      retryable: false,
    });
    expect(isAuditPermissionFailure(denied)).toBe(true);
    expect(isAuditPermissionFailure(filterError)).toBe(false);
  });
});

describe("audit route", () => {
  it("is a top-level section with its own address", () => {
    expect(sectionFromPath("/org/acme/audit")).toBe("audit");
    expect(pathForSection("acme", "audit")).toBe("/org/acme/audit");
  });
});

describe("listOrgAudit", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the org-scoped route with encoded filters and decodes a page", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ items: [event()], next_cursor: "c2", has_more: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const page = await listOrgAudit(ORG, { limit: 50, run_id: RUN, action: "" });
    expect(page.items[0]?.run_id).toBe(RUN);
    expect(page.next_cursor).toBe("c2");
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/orgs/${ORG}/audit?limit=50&run_id=${RUN}`,
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("rejects a page whose rows lack correlation identifiers", async () => {
    const { correlation_id: _dropped, ...broken } = event();
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ items: [broken], next_cursor: null, has_more: false }), {
        status: 200,
      }),
    );
    await expect(listOrgAudit(ORG, { limit: 50 })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("surfaces a 403 as a permission failure", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "permission_denied",
            message: "denied",
            request_id: REQUEST,
            details: {},
          },
        }),
        { status: 403 },
      ),
    );
    const error = await listOrgAudit(ORG, { limit: 50 }).catch((caught: unknown) => caught);
    expect(isAuditPermissionFailure(error)).toBe(true);
  });
});
