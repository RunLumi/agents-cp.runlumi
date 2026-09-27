# Finding VFY-011 — Any organization could read another organization's project access grants

## Status

closed

## Severity

critical

## Affected claim

- Claim ID: `VI-TEN-001` (Tier 0)
- Source requirement: `docs/contracts/core-invariants-v1.yaml`;
  `docs/specs/f02-*` FR-F02-002; the claim's own wording — "A principal in org A cannot read or
  mutate an org B resource by substituting any … **project** … identifier"
- Risk tier: 0 (existential — cross-tenant data disclosure)

## Statement

`GET /api/v1/orgs/{org_id}/projects/{project_id}/access` — and the two sibling routes the same
handler shape serves — authorized the caller against the **`org_id` in the path** and then read
the grants with **no organization predicate at all**:

```rust
// apps/api/src/routes/projects.rs, before the repair
let access = authorize_org(&state, &headers, &context, &org_id,
                           Permission::ProjectsManage, Some("project"), Some(&project_id)).await?;
let database = database(&state, &context)?;
let grants = ProjectRepository::new(database)
    .list_grants_by_project(&project_id, PAGE_LIMIT_MAX)   // WHERE project_id = ?1
    .await
```

```sql
-- apps/api/src/repositories/projects.rs
SELECT grant_id, project_id, org_id, member_id, team_id, created_at
FROM project_access_grants
WHERE project_id = ?1
```

`authorize_org` proves the caller may act on `org_id`. It says nothing about `project_id`, which
arrives from the path unvalidated. So Carol, who owns org B and passes authorization against org B,
substitutes a project id belonging to org A and reads org A's access grants — **`org_id`,
`member_id` and `team_id` included**. A machine identity in org B obtains the same.

`authorize_org` is called with `Some(&project_id)` as the resource id, which makes the call look
scoped. It is not: that argument becomes `ResourceContext`, and the membership and permission
decisions are made against the **organization**, never against the resource's own `org_id`.

## Why every existing gate was green

- **`security::tenant_audit`** classifies `GRANTS_BY_PROJECT_SQL`. It is a SELECT whose projection
  carries `org_id`, so it is `Class::ReturnsOrg` — true of the statement, and the audit says
  itself that it "does not prove routes call the right statement". VFY-010 is that gap, and this
  finding is the first thing it found.
- **`p05-smoke.mjs`** substitutes across `runs/{run_id}` only.
- **`p08-tenancy-smoke.mjs`** had not been built. VFY-010 recorded it as the largest in-repo gap.

So a Tier-0 claim was carried as PASS on evidence that could not see this, and the record said so
in a limit line nobody had measured.

## Reproducer

`apps/api/scripts/p08-tenancy-smoke.mjs`, reached by building VFY-010's probe. It seeds a real
project in org A and then asks org B's owner for org A's project under org B's path.

### Before

```
FAIL  project /projects/{id}/access — the resource is invisible across the boundary
      LEAK: outsider=404 other-owner=200
cross-tenant: 18/21 routes proven, 1 leak(s), 2 unproven among those
```

exit 1. The `404` for the plain non-member and the `200` for the other owner is the whole defect in
one line: the membership check refused the principal who is not a member, and did nothing for the
one who is a member of the *wrong* organization.

### After

```
PASS  project /projects/{id} — a real org A id is invisible under org B
      owner=200 non-member=404/resource_not_found other-owner=404/not_found
cross-tenant: 19/21 routes proven, 0 leak(s), 2 unproven among those
```

exit 0. The two outsiders are now refused for two different and equally correct reasons — see
"Why the reasons differ" below.

## The repair

The project is resolved through the authorized organization before its grants are read:

```rust
ProjectRepository::new(database)
    .find_project(&project_id)
    .await
    .map_err(|_| service_unavailable(&context))?
    .filter(|project| project.org_id == org_id)
    .ok_or_else(|| deny(&context, ApiErrorCode::NotFound, "not_found", "No such project."))?;
```

This is not a new pattern invented for the fix. It is the same guard three neighbours in the same
file already carry — `patch_project`, `create_grant` and `readable_project` all do
`.filter(|project| project.org_id == org_id)`. `list_grants` was the one that did not, and
`delete_grant` and `delete_project_binding` do the equivalent on the grant and the binding
respectively.

Evidence: `evidence/vfy011-project-access-leak.txt`. The fix is load-bearing: reverting just that
guard turns the probe red again with the leak named (18/21, 1 leak, exit 1).

`pnpm smoke:p05` 185/0 and `pnpm check` exit 0 after the change; p05 exercises the project routes,
so the added lookup is covered by a gate that was already passing.

## Why the reasons differ, and why that is correct

After the repair the two outsiders get different 404 reasons, and the probe's first version called
that a failure:

| caller | reason | why |
|---|---|---|
| plain member of another org | `resource_not_found` | `authorize_org` refused: no membership in that org |
| that org's **owner** | `not_found` | authorization passed; the project is not theirs |

Both are 404, so neither is enumerable. The second tells Carol something she already knows — that
she is a member of org B. The load-bearing assertion is the **first** row, because it is the only
one that can only have come from the membership check. The probe was too strict, not the product
wrong, and it says so where the criterion is defined.

## Two open leads this finding did not chase

Both were hit while trying to seed resources, and neither is claimed as diagnosed:

- **`POST /api/v1/orgs/{org_id}/service-accounts` answers `503` with "The usage store is
  unavailable."** It is a P07 route; the message comes from `routes::usage::service_unavailable`,
  because `machine_identity` reuses `usage::prepare_scoped_mutation` and
  `usage::commit_scoped_mutation`. The underlying D1 error is discarded by both, so the 503 does
  not say what failed. The insert and the audit statement were each reproduced by hand against the
  probe's own database and both succeed, so the failure is elsewhere in the batch. **This is the
  same swallowed-error defect as `commit_mutation` in VFY-008, in a second place.**
- **`POST /api/v1/orgs/{org_id}/teams` answers `409 conflict`** on a fresh organization.
  `commit_scoped_mutation` returns that from exactly one arm — `ScopedMutationCommit::Guarded`,
  which fires when the idempotency claim guard aborts — so on a first-ever team in a first-ever
  organization the claim is reporting itself unguarded. Undiagnosed.

Neither is a claim in this matrix, and neither is asserted to be a defect of any particular kind.
They are recorded because an undiagnosed 503 on a P07 route is itself a finding: the surface cannot
be created through, so its three id-scoped routes have no cross-tenant evidence, and the reason is
not visible to whoever tries.

## Residual risk

VFY-010's 82 remaining routes are unchanged by this finding; one of them, `projects/{id}/access`,
is now closed and the other two project routes are now evidenced. The swallowed-error pattern in
`commit_scoped_mutation` and `prepare_scoped_mutation` is the same class as `commit_mutation` and
is recorded in VFY-008's residual risk; this finding adds a second instance of it.
