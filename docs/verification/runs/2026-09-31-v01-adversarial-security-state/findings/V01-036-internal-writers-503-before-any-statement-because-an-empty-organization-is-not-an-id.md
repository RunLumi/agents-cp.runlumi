# V01-036 — every platform-internal write route 503s before it runs a single statement

- **Claim ID:** V01-036
- **Family:** Authentication / availability (found while attacking V01-034, after repairing V01-035)
- **Severity:** **HIGH**
- **Status:** OPEN — recorded **before** repair
- **Verdict:** FAIL

## Claim

`POST /api/v1/internal/feature-flags` and the other three internal writers answer
`503 service_unavailable` **before any SQL executes**. `prepare_scoped_mutation` builds an
`OrganizationId` from the organization argument with `OrganizationId::new(org_id)`, and the four staff
routes pass `""`. `ResourceId::new` splits on `_`, so the empty string has no separator and returns
`CoreError::InvalidResourceId` — which the caller maps to `service_unavailable`.

This is the **first** of three stacked reasons the internal write surface has never worked, and it is
the one that fires first, so it masked V01-035 entirely.

## Setup

`apps/api/src/routes/internal.rs`, the four writers, each of which opens its batch the same way:

| handler | line | call |
|---|---|---|
| `create_flag` | 262 | `prepare_scoped_mutation(..., staff_principal_id, `**`""`**`, ...)` |
| `patch_flag` | 368 | same |
| `create_kill_switch` | 522 | same |
| `lift_kill_switch` | 613 | same |

The chain, in `apps/api/src/routes/usage.rs:132`:

```rust
let scope = IdempotencyScope::new(
    ActorId::new(scope_actor).map_err(|_| service_unavailable(context))?,
    Some(OrganizationId::new(org_id).map_err(|_| service_unavailable(context))?),
    method,
    path,
)
```

`apps/api/src/core/identifiers.rs:17`:

```rust
let (prefix, uuid) = value.split_once('_').ok_or(CoreError::InvalidResourceId)?;
```

`"".split_once('_')` is `None`. The `?` fires, the handler returns `503`, and no statement is prepared.

## Action

`verify:staff-credential`'s control case creates a feature flag with a **legitimate** staff token and
asserts `2xx` and that the row exists in D1. It answers `503`.

Measured on the probe's own database, holding everything else constant:

| check | result |
|---|---|
| `staff_principals` row for the token's principal | present, `engineering`, active |
| `GET /internal/feature-flags` with the correct secret | **200** — the credential and the route are fine |
| `INSERT INTO feature_flags (...)` with the handler's exact values | **accepted** |
| `INSERT INTO security_events (...)` with `actor_type = 'staff'`, post-0022 | **accepted** |
| `POST /internal/feature-flags` | **503** |

Both statements succeed in isolation and the request still fails, which places the failure **before
the batch** — the only code that runs before the batch is the scope construction.

## Actual

All four internal write routes answer `503`. Zero statements execute.

## Root cause

**`''` is the designed representation of "no organization", and the type layer refuses it.**

`idempotency_records.organization_id` is declared:

```sql
organization_id TEXT NOT NULL DEFAULT '' CHECK (length(organization_id) <= 255)
```

`NOT NULL` with `DEFAULT ''`: the schema deliberately encodes "no organization" as the **empty
string**, not as NULL. Migration 0020 is the null-safety pass that settled this. All four staff routes
pass `""` for exactly that reason, and the other 27 call sites pass a real `org_` id.

`prepare_scoped_mutation` then converts that `""` into `OrganizationId::new("")`, and
`OrganizationId` is a `resource_id_type!` — a validated opaque id with a mandatory `prefix_32hex`
shape. **The type has no representation for "no organization" at all**, so the conversion cannot
succeed for the one value the schema and every caller use for exactly this case.

The error is mapped to `service_unavailable`, which is why the symptom reads as a transient store
fault rather than as a rejected argument: a caller has no way to tell "your organization id was
malformed" from "the database is down", and a malformed organization id is the actual cause.

## Why this is the most valuable of the three

It is upstream of the other two. With this defect present, V01-035's audit-CHECK failure is
**unreachable** — the request dies before the batch is built — and V01-033's guard-ordering failure in
`patch_flag` is likewise unreachable. All three were live at once, stacked, in one surface, and the
outermost one hid the two behind it.

That ordering is the finding. A single 503 with a single cause would have been a bug. A 503 with
**three** independent causes, where fixing any one of them changes nothing observable, is a coverage
statement: this surface had no gate, and a route family with no gate does not fail once, it fails
three times over and reports one symptom.

## Impact

- The platform cannot arm or lift a kill switch, and cannot roll a feature flag out or back, through
  its own API. Its only recourse is direct database writes, which bypass the audit trail ADR 0007
  requires.
- Every failure is reported as `503 service_unavailable`, so an operator's correct response — retry —
  is also the wrong one, and a permanently broken route looks like an intermittently flaky one.
- **The V01-034 write half was masked by this.** A forged staff credential reaching a write route
  would have appeared to fail safely, and it failed for a reason that had nothing to do with the
  credential. Only after this is fixed can the forged-write case be measured at all.

## Regression gap

- No test called `prepare_scoped_mutation` with an empty organization, because the four staff routes
  are the only callers that do and no gate drives them.
- **No standing check ties a call site's argument to what the type accepts.** The general shape here is
  the same as V01-035's: a value crosses a boundary — a `&str` into a validated id type — and nothing
  at the boundary asks whether the two agree. The cheap form of that check is a unit test per distinct
  argument shape, and there is none.
- `IdempotencyScope::new` takes `Option<OrganizationId>`, so the *scope* layer was always ready for
  "no organization". The unwrapping happens one line earlier, in a helper whose signature takes
  `&str` and therefore cannot express the case at all. A `&str` parameter where the domain has three
  states — an id, none, or invalid — is the shape that hides this.

## Repair (recorded on closure, not now)

`prepare_scoped_mutation` must treat an empty organization as `None` rather than as a malformed id,
because that is what the schema's `DEFAULT ''`, all four callers, and `IdempotencyScope`'s own
`Option` already mean. An empty string is a **valid** value at that boundary, not an invalid one, and
the fix belongs where the boundary is rather than in four call sites — a call-site fix would leave the
type able to reject the schema's own default, which is the defect.

Intended behaviour is already specified, so this is an implementation defect and not a requirement
change.
