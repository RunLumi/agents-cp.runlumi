# V01-035 — every platform-internal write route has never worked: the staff audit insert violates its own schema

- **Claim ID:** V01-035
- **Family:** Authentication / audit (discovered while attacking V01-034)
- **Severity:** **HIGH**
- **Status:** CLOSED — recorded before repair, updated with root cause, fix, and proof
- **Verdict:** FAIL → **PASS** (re-attack 401/identical; probe 22/22)

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

## Root cause

P07 added a third actor kind and did not extend the CHECK that names actor kinds. `0002` declared
`security_events`; `0018` added `staff_principals`, `StaffActor`, and the entire
`/api/v1/internal/**` surface sixteen migrations later. Nothing extended the `actor_type` list, so
the MUST in ADR 0007 — *"a staff audit event is written on grant creation and on every use"* — was
unsatisfiable, and the code lost.

## Fix

`apps/api/migrations/0022_p07_staff_actor_type.sql`, additive, because the ledger is append-only and
editing `0002` would fix a fresh database and nothing else. It names `'staff'`.

**Not by writing `'support'`.** `'support'` is in the `0002` list and reads like the answer; it is a
`StaffRole`, not an actor kind. Writing it would record a `security` or `engineering` staff member's
platform action as a *support* action — satisfying the CHECK by making the audit trail misstate the
actor kind, which is the property ADR 0007 exists to protect.

Two things the migration had to get right, and one of them it got wrong first:

- **All nineteen columns.** `0010` appended `run_id`, `agent_session_id`, `tool_call_id` with
  `ALTER TABLE`, so they sit at the END. The first version copied `0002`'s sixteen and failed with
  `no such column: run_id`. The mistake was auditing the ledger for the indexes and triggers the
  rebuild would drop, and not for its columns. **The authority for a rebuild's shape is the live
  schema; the ledger only says what changed.**
- **Four indexes and both immutability triggers, recreated verbatim.** A rebuild that silently lost
  the append-only guarantee on the audit table would be a worse defect than the one being repaired.

Measured on a copy of a real database: identical column list and order, 5 indexes before and after,
2 triggers before and after, and the **only** textual difference in the DDL is the addition of
`'staff'`. Both `BEFORE UPDATE` and `BEFORE DELETE` still abort.

## Regression proof

`security::actor_type_correspondence` — a new standing check in `pnpm check`. It reads the permitted
set from the **whole ledger** (a check that read only `0002` would report `'staff'` as forbidden
forever, i.e. a verifier disagreeing with the database it exists to protect) and every `actor_type`
literal the code can write, matched by **position** in the INSERT's `VALUES` tuple, which is the
shape that hid this defect: the column is named in the column list and the value sits at the same
ordinal, with nothing joining them but the number.

Two assertions: the general one, and a specific one that fails with a message about ADR 0007 rather
than about a set comparison. Vacuity is asserted **before** any verdict — the ledger was read, at
least 100 source files were walked, and at least one literal was found — because a scan that read
nothing reports a clean sheet while measuring nothing.

**Sensitivity:** `evidence/v01-035-actor-type-sensitivity.sh`, **M1 (the writer emits a forbidden
value) and M2 (the ledger loses `'staff'`) both DETECTED**, exit 0. Attacking both files matters: they
are the two halves of the class, and a check that only catches one is half a check.

The check's limit is in the file, not only in the record: three of the four sites **bind**
`actor_type` as `?n` rather than hard-coding it, and a static scan cannot follow a bind. So it counts
the binds it could not grade, and the failure message reports both numbers. Its power is exactly "a
hard-coded literal the schema refuses" — a real class, not a general proof.

## Also closed here

`smoke-harness.mjs` now reads the Worker's log **before** stopping services and prints the lines
naming a cause whenever a case fails — not only on a bail. `commit_scoped_mutation` had been
reporting SQLite's message through `report_error` all along, so the cause of this defect was available
and unreachable at the same time, and the sheet said "the route is broken" five times across four
repairs. **A verdict with no cause is the same failure as a verdict with no evidence.**
