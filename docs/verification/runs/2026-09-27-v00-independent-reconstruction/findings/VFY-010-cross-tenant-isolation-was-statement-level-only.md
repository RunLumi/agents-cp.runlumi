# Finding VFY-010 — Tier-0 cross-tenant isolation was proven at the SQL layer and almost nowhere else

## Status

partially closed — 16 routes proven, 85 of 104 still without handler-level evidence

## Severity

high

## Affected claim

- Claim ID: `VI-TEN-001` (Tier 0), via its recorded evidence limit
- Source requirement: `docs/contracts/core-invariants-v1.yaml`; `docs/adr/0005-*`;
  `docs/specs/f02-*` FR-F02-002
- Risk tier: 0 (existential — a principal in one tenant reading another's data)

## Statement

`VI-TEN-001`'s statement enumerates its subject directly:

> A principal in org A cannot read or mutate an org B resource by substituting any resource,
> project, credential, device, **export**, run, plugin, **service-account** or **API-key**
> identifier.

The reconstruction passed it, and passed it correctly on the evidence that existed. The tenant
audit proves every SQL statement touching a tenant-owned table is classified as org-bound,
principal-bound, or mechanical. What it states about itself is the whole problem:

> the audit does not prove routes call the right statement

So the guarantee was **statement-level only** for every handler. Two routes had handler-level
evidence, both from `p05-smoke.mjs`. The other **102 org-scoped routes had none** — 104 in total,
one credited, so 103 without it before this finding.

Three of the resource types the claim names by hand — export, plugin, service-account, API-key —
sit entirely in P06–P08, and none of them had a single cross-tenant HTTP assertion anywhere.

### A correction the record needed

The V00 record said `p05-smoke.mjs` "proves cross-tenant negatives for P02–P05 (device, run,
member, session, budget)". Reading the script, that is not what it does. It asserts two
cross-tenant negatives on **one** org-scoped route:

```
2116  const bobReadsA = … GET /api/v1/orgs/${state.orgA.orgId}/runs/${state.mainRun.runId}
2121  assertDenied(bobReadsA, "second user cannot read tenant A run", [403, 404])
2122  const aliceReadsB = … GET /api/v1/orgs/${state.orgB.orgId}/runs/${state.mainRun.runId}
2127  assertDenied(aliceReadsB, "tenant B cannot read tenant A run by ID", [403, 404])
2128  const wrongDevice = … GET /api/v1/devices/runs/${state.mainRun.runId}
2135  assertDenied(wrongDevice, "device B cannot read tenant A run", [401, 403, 404])
```

and the device case is on `/api/v1/devices/runs/…`, which is not org-scoped. The `members` and
`devices` calls around it are legitimate owner operations, not negatives. The claim's evidence
was thinner than the record described, which is why the gap was larger than action 5.1 assumed.

## The verifier, and why it asks each route three times

`apps/api/scripts/p08-tenancy-smoke.mjs`, `pnpm smoke:p08`.

The obvious test is "org A asks for org B, expect a refusal", and it proves nothing. A handler
that never consults the membership table and then fails to find the resource returns the same
`404 resource_not_found` a correct handler returns, and no single-call assertion can separate
them. That is the wrong-reason kill, and `GUARD-2` in the mutation campaign is the same mistake
in a different place.

So each route is asked three times:

| call | who | expected |
|---|---|---|
| 1 | a member of the organization | 2xx — an empty list is still a 200 |
| 2 | a **plain member** of another organization | 404 `resource_not_found` |
| 3 | that other organization's **owner** | 404 `resource_not_found` |

A route counts as proven only when (1) succeeded and both (2) and (3) were refused in the shape
`authorize_org` uses for an inaccessible organization. When (1) is not 2xx there is nothing to
leak and nothing to distinguish, so the route is reported UNPROVEN with the reason rather than
quietly counted as a pass.

## The unproven set is computed, not listed

The router registers **104** org-scoped routes. A hand-written "not covered" list of the other 86
is a list nobody maintains: someone adds a route, the list stays correct, and the new surface has
no evidence while the probe keeps passing. The probe reads `app.rs` instead, so a new route lands
in the unproven bucket by construction and the reported count moves.

It also fails if a route it claims to test is **no longer in the router**, so a stale entry is a
bug in the probe rather than a quiet pass over something that no longer exists.

## Result

```
cross-tenant: 16/18 tested routes proven, 0 leak(s), 2 unproven among those

not proven among the tested routes:
  - /api/v1/orgs/{org_id}/billing/subscription — the member's own call was 404/resource_not_found
  - /api/v1/orgs/{org_id}/entitlements — the member's own call was 422/entitlement_not_granted

org-scoped routes with NO handler-level cross-tenant evidence: 85 of 104
  57 take a resource id, so they need a real resource to substitute
  28 are mutating or id-less actions this probe does not drive
```

Proven: `ai_catalog` catalog / credentials / routes, `audit`, `automations`, `billing`
entitlements/provider, `data_governance` data-policy / deletions / exports, `machine_identity`
api-keys / service-accounts, `migration` adoption/bindings / adoption/remediations, `plugins`
plugins, `webhooks` notification-preferences / webhooks.

The two skips are honest, not convenient: a fresh organization has no subscription and no granted
entitlement, so the member's own call fails before any data could be returned. Seeding a
subscription would turn both into proofs.

## Sensitivity

Evidence: `evidence/vfy010-tenancy-sensitivity.txt`.

`authorize_org` was made to skip the membership lookup and hand every principal a synthetic owner
membership — precisely the defect this claim exists to detect. The probe then reported:

```
cross-tenant: 1/18 tested routes proven, 15 leak(s), 2 unproven among those
```

against `16/18 proven, 0 leaks` on the real code, exiting 1 rather than 0. A sample of what leaked:

```
FAIL  ai_catalog /credentials — a plain member of another org is refused
      LEAK: status=200 body={"items":[],"next_cursor":null,"has_more":false}
```

The fault is reverted; `apps/api/src/routes/authorization.rs` is not modified by the commit that
added the probe.

**One route stayed green under the fault** — `data_governance /deletions`, whose `404` comes from
a second guard. That is why the figure is 15 and not 18, and it is left as it is: a probe that
caught all of them would be worth less than one that catches them for the right reason, and
padding the number would be the same wrong-reason kill in the other direction.

## Residual risk

85 of 104 org-scoped routes still have no handler-level evidence. The 57 that take a resource id
are the larger half and are the next thing worth building: seed one real resource per surface in
org B, then substitute it under org A's path and assert refusal. The 28 mutating and id-less
actions need a body the route will accept, which is per-surface work.

Until then `VI-TEN-001` is PASS **with a recorded and now-measured limit**, and the limit is 85
routes rather than the "P06–P08" the record previously implied.
