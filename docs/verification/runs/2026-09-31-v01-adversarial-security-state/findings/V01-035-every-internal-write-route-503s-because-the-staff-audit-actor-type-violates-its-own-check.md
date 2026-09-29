# V01-035 — every platform-internal write route has never worked: the staff audit insert violates its own schema

- **Claim ID:** V01-035
- **Family:** Authentication / audit (discovered while attacking V01-034)
- **Severity:** **HIGH**
- **Status:** OPEN — recorded **before** repair
- **Verdict:** FAIL

## Claim

Every `/api/v1/internal/**` route that **writes** answers `503`. The `staff_audit` helper inserts
`actor_type = 'staff'`, and `security_events.actor_type` is CHECK-constrained to
`('user', 'service_account', 'support', 'system', 'anonymous')`. The insert is refused, the batch
aborts, and the caller is told the store is unavailable.

**Platform feature flags cannot be created or patched, and kill switches cannot be created or
lifted.** The platform has no working control over its own rollouts or its own kill switches.

## Setup

Found while building `apps/api/scripts/v01-staff-credential-probe.mjs`, whose control case creates a
feature flag with a real staff token. The create answered:

```
503  {"error":{"code":"...","message":"The usage store is unavailable."}}
```

`store_unavailable` is what a failed batch reports, so the refusal is in the batch, not the request.

The four affected handlers are every writer in `apps/api/src/routes/internal.rs` that calls
`staff_audit`:

| handler | route | verb |
|---|---|---|
| `create_flag` | `/api/v1/internal/feature-flags` | POST |
| `patch_flag` | `/api/v1/internal/feature-flags/{flag_key}` | PATCH |
| `create_kill_switch` | `/api/v1/internal/kill-switches` | POST |
| `lift_kill_switch` | `/api/v1/internal/kill-switches/{key}` | POST |

There is no fifth: `staff_audit` is called from exactly these four, and the read routes
(`list_flags`, kill-switch reads) do not write, which is why reads answer `200` and the defect is
invisible to anyone who only reads.

## Action

Two-variable experiment on a **copy of the real database**, holding every other value constant —
including the same `stf_`-prefixed `actor_id` — and changing only `actor_type`:

```sql
INSERT INTO security_events (event_id, org_id, actor_type, actor_id, ... )
VALUES (?1, NULL, ?2, ?3, ...)
```

| `actor_type` | result |
|---|---|
| `'staff'` | **REFUSED** — `CHECK constraint failed: actor_type IN ('user', 'service_account', 'support', 'system', 'anonymous')` |
| `'support'` | ACCEPTED |
| `'system'` | ACCEPTED |

The product's own literal is the only one of the three that the schema refuses, and the failure is
in a `CHECK` on a column the product does not own the definition of.

## Actual

All four write routes answer `503`. The four `staff_audit` call sites are the only writers of that
column value, so there is no path by which a staff audit event has ever been written.

## Root cause

**P07 added a third actor kind and did not extend `security_events.actor_type` to name it.**

- `security_events` and its CHECK are declared in `apps/api/migrations/0002_p02_identity_organizations.sql`.
- `staff_principals`, `StaffActor`, and the whole `/api/v1/internal/**` surface arrive in
  `apps/api/migrations/0018_p07_platform_operations.sql` — **sixteen migrations later**.
- `docs/adr/0007-three-actor-kinds.md` establishes three actor kinds (`Principal`, `MachineActor`,
  `StaffActor`) and carries the MUST: *"A staff audit event is written on grant creation and on
  every use."*
- The 0002 CHECK still enumerates the pre-P07 world, and one of its five values — `'support'` — is
  a **`StaffRole`, not an actor kind**. It reads like the staff value and is not.

So the MUST and the schema are in direct conflict, and the code lost: the audit event the ADR
requires is unwritable.

## Why this was never noticed

Three reinforcing reasons, each worth naming because each is a lesson about coverage rather than
about this one table:

1. **The family has no gate.** `/api/v1/internal/**` is staff-authenticated, no probe could mint a
   staff principal, and so nothing drove it. That is the same gap V01-033 found **three permanently
   dead routes** in — two of which (`patch_flag`, and the plugin-policy writes) are in this file or
   its sibling. The routes were dead for two independent reasons and no run could see either.
2. **Reads work.** `list_flags` answers `200` to the same token, so a probe that reads the feature-flag
   surface sees a healthy route family.
3. **`'support'` in the CHECK list is a convincing false positive.** A reader — human or model —
   checking "is there a staff-ish actor type?" finds one.

## Impact

- **Availability of the platform control surface.** No feature flag can be rolled out or rolled back
  through the API, and no kill switch can be armed or lifted. An operator's only recourse is direct
  database writes, which bypass the audit trail the ADR requires.
- **Audit.** Since the batch aborts, no `security_events` row is written at all — not a wrong one, not
  a degraded one. The platform's own actions are unaudited, in the one place the ADR says they must
  not be.
- **It masked V01-034.** A forged staff secret could reach a write route and *appear* to succeed
  while the batch then aborted on the audit insert. The 503 is the only reason the write half of
  V01-034 is a 503 rather than a state change — which is luck, not design.

## Regression gap

- No test inserted a `security_events` row with `actor_type = 'staff'`. The existing test at
  `platform_ops.rs:843` asserts `credential_hash.len() == 64`; nothing asserts that the audit
  statement a handler builds is *accepted by the schema*.
- **Nothing in the repository ties an `actor_type` literal in Rust to the CHECK in the ledger.** That
  is a standing, cheap, class-closed check: enumerate every `actor_type` literal the code can write
  and assert the set is a subset of what the migration permits. It is the schema-side twin of GAP-004's
  bind-correspondence check, and it would have caught this the day it was written.
- No gate drives `/api/v1/internal/**`.

## Repair (recorded on closure, not now)

The intended behaviour is already specified, so this is an implementation defect and **not** a
requirement change: ADR 0007's MUST is that a staff audit event is written, and the code writes one.
The schema is what is behind.

The repair is a **new, additive migration** extending the `actor_type` CHECK to include `'staff'`.
It is additive rather than a rewrite because the migration ledger is append-only, and it must **not**
be "fixed" by writing `'support'` instead: `'support'` is a `StaffRole`, and labelling a `security`
or `engineering` staff member's action as `support` would make the audit trail misstate the actor
kind — satisfying the CHECK by destroying the property the ADR is protecting.

No ADR is rewritten: ADR 0007 already states the correct rule. The change is recorded there as a
consequence, because a schema that predates the third actor kind is exactly the kind of drift a
future reader needs warned about.
