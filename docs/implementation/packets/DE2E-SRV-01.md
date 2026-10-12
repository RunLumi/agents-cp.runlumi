# Work Packet — DE2E-SRV-01: race-loser refusal, pre-start refusal codes, web audit view

## Metadata

- Phase: Desktop ↔ control-plane E2E (DE2E), server/web lane
- Lane: BE + FE + QA
- Status: review
- Owner: DE2E server/web worker (coordinator: DE2E parent session)
- Depends on: P02-CG (`p02-cg-v2`, freeze `ba35fb6`/`0290e68`), P05-CG (`p05-cg-v1`, freeze `b5a5ea8`), P06-CG (`p06-cg-v1`, freeze `11341a5`, recorded `c71a774`)
- Blocks: client classification of pre-start refusals (`automationOccurrenceDriver.ts`); journey D web observation (claim matrix D9, E4, E7)
- Specs: F15, F16 (FR-F16-001/003), F22 (IA "Audit Log", FR-F22-001..009)
- ADRs: none changed
- Contract version / Contract Gate commit: base `febc39d` + `7df0fee`; contracts as listed above. No frozen contract changes; no change request.

## Outcome

A device that loses an automation claim — concurrently or sequentially — always receives the frozen
`409 occurrence_already_claimed` and never the raw lease token, proven at the HTTP/Worker level. The
client has an exact table of which start/claim refusals prove that no start happened. Organization
admins can read the audit trail in the web control plane and match a desktop managed run by run,
request, correlation, device and project id.

## In scope

- Worker-level regression for the sequential race loser (`verify:lease-contention`).
- Pre-start refusal-code audit (table below).
- Org audit log page; run id in the usage events table; occurrence project id on device audit rows.

## Explicitly out of scope

- `tests/integration/**`, `scripts/integration/**`, the desktop client.
- Changing which roles hold `audit.read` (see "Findings").
- Audit CSV/JSON export (F16 P1).

## Write surface

```text
apps/api/src/routes/automations.rs
apps/api/scripts/v01-lease-contention-probe.mjs
apps/web/src/features/audit/**
apps/web/src/lib/api.ts
apps/web/src/components/icons.tsx
apps/web/src/features/organizations/org-dashboard.tsx
apps/web/src/features/usage/budget-cards.tsx
docs/implementation/packets/DE2E-SRV-01.md
```

Shared files requiring coordinator approval: none edited. `docs/verification/runtime-proofs.md:38`
still describes the old lease-contention rule ("no losing response carrying the winner's lease id");
it is outside this surface and should be updated by the coordinator to "the lease id only as the
contract's `existing_lease_id` projection".

## Frozen contracts consumed

- API: P06-CG lease semantics (`P06-CG.md:245`), `p06-contracts-v1.json` `concurrent_claim.loser_reason`;
  P02-CG `GET /orgs/:org_id/audit` (`audit.read`, cursor/filter, `Page<AuditEvent>`).
- Error semantics: P06-CG "Error semantics" list.
- Audit: F16 FR-F16-001; P05-CG §audit ("Audit metadata excludes prompt/response/tool-argument bodies").

## Pre-start refusal codes (claim and start)

Envelope: `{"error":{"code":<generic>,"details":{"reason":<stable code>}}}`. Clients must branch on
`details.reason`. Source: `apps/api/src/routes/automations.rs` `claim_occurrence`/`start_occurrence`,
`routes/authorization.rs` `authorize_device`, `routes/devices.rs` `require_device`,
`jobs/automations.rs` `dispatch_block`.

### Spelling of the policy-staleness code

The frozen P06-CG error list ("Stable machine-readable reasons include …") contains **neither**
`automation_policy_stale` nor `policy_snapshot_stale`. The server emits only `policy_snapshot_stale`
(`jobs/automations.rs:364`, 409). `automation_policy_stale` does not exist anywhere in the server or
the contracts. The server is therefore not deviating from a frozen spelling and is unchanged; the
client must match `policy_snapshot_stale`.

### Claim (`POST /devices/automation-occurrences/{id}/claim`)

A claim never starts a run. The claim's writes (CAS, lease, attempt, outbox, audit) are one atomic D1
batch, so **every non-201 claim response means no lease was granted by this request and nothing
started**. Nothing needs releasing. A transport failure on claim may leave an unknown lease; it
expires pre-start and the server re-queues it (start requires the token, so no start can have happened).

| HTTP | reason | Meaning |
| --- | --- | --- |
| 401 | `device_token_expired` | missing/invalid/expired/revoked device token |
| 403 | `device_revoked`, `device_not_approved`, `organization_not_active` | device/membership/org gate |
| 404 | `resource_not_found` | device's org row missing (`authorize_device`) |
| 404 | `occurrence_not_found` | unknown or other-tenant occurrence (indistinguishable) |
| 422 | `occurrence_id_invalid` | malformed id |
| 409 | `occurrence_already_claimed` (+ optional same-org `existing_lease_id`) | lost race, sequential or concurrent |
| 409 | `occurrence_ambiguous` | awaiting reconciliation |
| 409 | `automation_invalid_state` | terminal/other non-claimable state |
| 404 | `automation_not_found` | automation gone |
| 409 | `organization_suspended`, `organization_not_found`, `organization_pending_deletion` | `dispatch_block`; unreachable in practice (see note) |
| 409 | `execution_principal_unavailable` | principal's membership inactive |
| 409 | `policy_snapshot_stale` | org policy version below the automation's required version |
| 403 | `entitlement_not_granted`, `entitlement_grace_expired` | license/entitlement |
| 409 | `entitlement_limit_exceeded` | over `automations.max_active` |
| 409 | `workspace_binding_unresolved`, `workspace_binding_ambiguous` | no/several bindings for the project |
| 409 | `occurrence_lease_expired` | `max_start_attempts` exhausted |
| 503 | — (`service_unavailable`) | store error; no lease granted by this request |

### Start (`POST /devices/automation-occurrences/{id}/start`)

Order of checks: device auth → occurrence → lease (owned, active) → token → fence → **idempotent
run-link discovery** (an existing link for this attempt returns `200` with the same grant) → state
must be `leased` → `dispatch_block` → agent/binding → one atomic batch (guards + run + link + CAS +
attempt + outbox + audit).

| reason | Returned before any write? | Proves this attempt did NOT start? |
| --- | --- | --- |
| `device_token_expired` (401) | yes | **only if no earlier start for this lease could have committed** (checked before link discovery) |
| `device_revoked`, `device_not_approved`, `organization_not_active` (403) | yes | same caveat as above |
| `resource_not_found` (404, org row) / `occurrence_not_found` / `lease_not_found` (404) | yes | same caveat |
| `lease_fence_invalid` (409) before link discovery (inactive lease, token/fence mismatch) | yes | same caveat |
| `automation_invalid_state` (409) | yes, after link discovery | yes — no run link for this attempt |
| `automation_not_found` (404) | yes, after link discovery | yes |
| `execution_principal_unavailable` (409) | yes, `dispatch_block` | yes |
| `policy_snapshot_stale` (409) | yes, `dispatch_block` | yes |
| `entitlement_not_granted`, `entitlement_grace_expired` (403) | yes, `dispatch_block` | yes |
| `entitlement_limit_exceeded` (409) | yes, `dispatch_block` | yes |
| `organization_suspended`, `organization_not_found` (409), `organization_pending_deletion` (409) | yes, `dispatch_block` | yes, but unreachable in practice (see note) |
| `workspace_binding_unresolved`, `workspace_binding_ambiguous` (409) | yes | yes |
| `lease_fence_invalid` (409) from the batch guard with no link found | batch rolled back | yes — the batch is atomic and no link exists |
| `device_not_eligible` | **never returned by claim or start** | n/a — only automation create/patch target validation (`automations.rs:614`) |
| 503 `service_unavailable`, transport error, timeout | unknown | **ambiguous** — retry `start` (idempotent) while the lease is live, or call `release`: it refuses (`automation_invalid_state`) if a run link exists and succeeds only when the server proves no start |

Cross-check with the client worker's release list (`device_token_expired, device_revoked,
device_not_approved, organization_not_active, device_not_eligible, organization_suspended,
organization_not_found, organization_pending_deletion, execution_principal_unavailable,
policy_snapshot_stale, entitlement_not_granted, entitlement_grace_expired,
entitlement_limit_exceeded`):

- All are returned by `start_occurrence` before any write **except `device_not_eligible`**, which
  start never returns (harmless to keep, but it is dead).
- The four auth-gate codes (`device_token_expired`, `device_revoked`, `device_not_approved`,
  `organization_not_active`) are returned **before** run-link discovery. They prove "not started"
  only for a first start attempt; after an earlier start whose response was lost they are ambiguous.
  The remaining `dispatch_block` codes are returned after link discovery and do prove no run link for
  the attempt.
- Note: `organization_suspended`, `organization_not_found` and `organization_pending_deletion` are
  unreachable at claim/start because `authorize_device` already refuses a non-active org with
  `organization_not_active` (403) and a missing org with `resource_not_found` (404). The client should
  also treat `resource_not_found` from the auth gate like the other auth-gate refusals.
- Missing from the client list but provably not started: `automation_invalid_state`,
  `automation_not_found`, `workspace_binding_unresolved`, `workspace_binding_ambiguous`, and the
  guard-path `lease_fence_invalid` (first attempt only, as it shares a code with the pre-discovery
  fence refusal).

## Acceptance criteria

- [x] Sequential loser: 409 `occurrence_already_claimed`, no `lease_token`, `existing_lease_id` only for
      the same-org winner; foreign device gets the absent-occurrence 404 (P06-CG:245).
- [x] Regression fails on pre-fix code and passes after.
- [x] Refusal-code table delivered (above).
- [x] Audit view: route-level lazy, server-paginated, URL-backed filters, full ids, actor kind, device,
      project, resource, correlation/request/run, time; loading/empty/error/permission states;
      keyboard; 390px layout (F22 FR-F22-002/003/004/007/008, F16 FR-F16-003).
- [x] Tenant isolation of the audit route proven at runtime.

## Tests

- [x] unit — `routes::automations::tests::device_audit_metadata_carries_the_occurrence_project_without_dropping_fields`; Vitest `features/audit/audit.test.tsx` (12 tests)
- [x] integration — `pnpm verify:lease-contention` (69/69 post-fix; 64/69 with 5 FAIL on pre-fix source)
- [x] cross-tenant negative — browser/API harness: org B owner on org A's audit path → 404 `resource_not_found`, no org A ids; also covered by `smoke:p08` (`p08-tenancy-smoke.mjs:68`) and `verify:filter-tenancy` audit filters
- [x] browser/UX — real Worker + Vite + headless Chrome, 40/40 checks, screenshots under `test-results/de2e-srv-01/`
- [ ] performance — audit chunk is lazy; no new dependency; budgets not separately measured

## Security checklist

- [x] tenant scope preserved (route unchanged; server-side `authorize_org` + mandatory org predicate)
- [x] authorization centralized (UI only renders the server's 403)
- [x] no secret/token leakage (lease token never in loser bodies; metadata not rendered)
- [x] no raw sensitive body logging
- [x] idempotency/concurrency considered (race loser, start idempotency in the table)
- [x] not applicable: destructive actions (view is read-only)

## Findings for the coordinator

1. Device-token audit rows are written with `actor_type = system` plus `device_id`; the
   `security_events` CHECK has no `device` value. The UI labels these "Device". Changing the stored
   actor type needs a migration and is out of scope.
2. `audit.read` is held by owner, admin **and viewer** but not member
   (`modules/authorization.rs:613-619`). P02-CG says viewer = "the same read set" as member, which
   lists no `audit.read`. Ambiguous contract text; not changed here.
3. `docs/verification/runtime-proofs.md:38` needs the wording update noted above.
4. Pre-existing: at 390px the shell header's "New organization" and "Sign out" buttons overlap
   (`06-audit-narrow-390.png`); not introduced by this packet.

## Handoff

Screen references: `docs/screens/lumi_budget_activity.webp` (filter row + dense table + pagination;
Audit Log placed above Settings in the nav) and `docs/screens/lumi_export_history.webp` (empty
state). No audit-specific screen exists. Deviations: no search box or column sorting because the
API offers neither (newest-first only); cursor pagination is Newer/Older because the API is
cursor-based and gives no total.

## Resume checkpoint

- Updated on / owner: 2026-10-12, DE2E server/web worker
- First unmet acceptance criterion: none; awaiting coordinator review and delivery.
