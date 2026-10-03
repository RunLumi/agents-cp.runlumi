# Schema and migration map

Generated from `apps/api/migrations/`. `security::release_docs` asserts this file
names every migration in apply order, so it cannot fall behind the schema.

**22 migrations · 111 tables · 200 indexes · 73 triggers.**

## Why the trigger count is the headline

An invariant enforced only in application code is one code path away from being
bypassed by a migration, a script, a console session, or a future packet. A trigger
is the only thing that still holds when nobody remembers the Rust.

That is what the 73 triggers are for, and why the schema harness
(`apps/api/scripts/p07-schema-invariants.mjs`) asserts each one is **rejected by
the database** rather than by a code path. The shape of those invariants:

- A revoked credential's reason cannot be blanked afterwards. The reason is the
  first thing an incident review asks for, and an earlier trigger watched only
  `UPDATE OF status`, so blanking the reason on an already-revoked row never fired
  it.
- A revoked or rotated key cannot be reactivated in place, so a revocation cannot
  be quietly undone.
- A lifted kill switch cannot be re-engaged in place.
- A support grant must carry a reason and a ticket, must expire, and cannot be
  restored once revoked.
- A feature flag must expire, so this is not a permanent configuration store.
- A published plugin version's manifest, digest, and package cannot be edited in
  place. A version is immutable once published, which is what makes the permission
  diff mean anything.
- A `pending_review` or `blocked` install must carry a reason.
- A completed idempotency record must carry a 2xx status, and a pending one must
  carry a claim token and no result.

## Migration 0020: a CHECK that could not say what it meant

`0001` declares the idempotency record's state as a CHECK:

```sql
CHECK (
    (state = 'pending'    AND response_status IS NULL AND ...)
 OR (state = 'completed' AND response_status BETWEEN 200 AND 299 AND ...)
)
```

The intent is "a completed record has a result". The SQL does not deliver it. With
`response_status` NULL, `BETWEEN 200 AND 299` evaluates to **NULL**, not false; the
`pending` arm is false, so the OR is `0 OR NULL` = NULL; and **a SQLite CHECK
constraint fails only on a definite false — it passes on NULL.** So this row was
accepted:

```sql
INSERT INTO idempotency_records (..., state, response_status, response_body)
VALUES (..., 'completed', NULL, '{}');
```

Probed directly rather than inferred: status 200 accepted, status 500 rejected,
status **NULL accepted**. The record claims a request completed and carries no
result, in the table that makes every mutating route safe to retry. A retrying
client is served a NULL status, and the idempotency layer reports a settled request
that settled to nothing.

This was found by the P09 verification campaign, not by reading. The campaign's
VI-IDEM-001 mutation removed a column from the idempotency upsert's `ON CONFLICT`
clause and **all 97 storage invariants still passed** — because
`grep -c idempotency` on the harness returned `0`. The substrate had no
database-level proof at all. Writing those probes found the NULL hole on the second
case, which is the ordinary shape of this: a coverage gap hides the bug behind it.

**A trigger, not a rebuilt table.** SQLite cannot `ALTER` a CHECK constraint, so
closing this in the table means create-copy-drop-rename — the first migration in
this repository to alter a table created by an earlier phase, and the rollback
argument below depends on no migration doing that. Trading a load-bearing property
for one NULL-safety gap would be a bad trade. A trigger is NULL-safe when written
with explicit `IS NULL` tests, and additive, so old and new Workers stay compatible
in both directions.

The `pending` arm is closed by the same migration, even though the table's CHECK
already got it right, so that a future edit to the CHECK cannot quietly open the
other half.

## Migration 0021: a CHECK that no identifier could satisfy

`adapters::new_resource_id(prefix)` builds `{prefix}_{32 hex}`, so a prefix of N letters
produces N + 1 + 32 characters. Migration `0002` declared:

```sql
teams.team_id                length = 36 AND substr(1, 4) = 'team'
team_members.team_member_id  length = 36 AND substr(1, 5) = 'tmem_'
```

The prefix half matches — `team_` does begin with `team` — but `generated_id("team")` is
**37** characters, and 37 is not 36. Every INSERT failed its CHECK, and because these writes
go through `database.batch`, each failure took its whole transaction with it. So the F03 team
surface has never worked: `POST /orgs/{id}/teams` answered 409, `POST /teams/{id}/members` could
never run, and project access granted through team membership silently never applied, because
`repositories/runs.rs` and `repositories/projects.rs` read a table that was always empty.

The other 82 identifier CHECKs in this schema are written the same way, and 80 of them agree with
the generator. Three spell their prefix with its underscore and are checked at **37** —
`deletion_certificates`, `cost_records` and `credentials` — which is the consistent form. `teams`
and `team_members` were the only two out.

**Why a rebuild and not an edit.** Editing `0002` would fix a fresh database and nothing else: the
ledger records `0002` as applied, so `d1_migrations apply` skips it. Staging, production and every
developer's local state would keep the broken CHECK. A corrective migration is the only form that
reaches them.

**Why the child is rebuilt first.** `team_members` references `teams` on both `team_id` and
`(org_id, team_id)`, both `ON DELETE CASCADE`. Dropping the parent while a child still references
it would cascade-delete that child, so the order in the file is load-bearing rather than cosmetic.

Both tables are empty, and provably so — the CHECK being corrected is what makes the insert
impossible — but the migration still copies rows in full so it is correct for any database that
somehow holds any.

## Rollback is forward-only, and the schema is why

No migration from P02 onward alters a table created by an earlier phase; they
create new ones. Rolling back a release therefore means rolling back the
**Worker**, not the database. `0016`–`0019` add only new tables, so dropping them
is safe and no pre-P07 data is at risk, and `0020` adds only triggers, so dropping
them is safe too and re-opening the NULL hole is the only consequence.

The consequence worth stating rather than hiding: a rollback leaves the newer
tables and triggers in place, harmless and unread, until a forward migration or a
manual drop. That is the correct trade. A down-migration that drops a column a
still-running older Worker reads is far worse than an orphan table.

## The tenant column has two spellings

`0011` and `0018` wrote `organization_id`; every other migration wrote `org_id`.
This is not cosmetic. The P09 tenant audit originally scanned for one spelling and
silently excluded `idempotency_records`, `outbox_events`, `support_grants`, and
`kill_switches` from tenant checking — the whole P01 idempotency/outbox surface and
the P07 grant/kill-switch surface, whose queries nothing was verifying. Both
spellings are recognised now, and the audit test names those four tables
explicitly so the gap cannot reopen unnoticed.

## The table

| Migration | Tables | Indexes | Triggers | What it adds |
|---|---|---|---|---|
| `0001_p01_foundation.sql` | 2 | 2 | 0 | Outbox and idempotency substrate. Both use `organization_id` — the spelling the rest of the schema did not follow, which is why the tenant audit knows both. **Its `completed`-state CHECK had a NULL hole; `0020` closes it.** |
| `0002_p02_identity_organizations.sql` | 12 | 20 | 2 | Identity, organizations, memberships, invitations, teams, projects, access grants. The authorization substrate everything else authorizes against. |
| `0003_p02_auth_rate_limits.sql` | 1 | 1 | 0 | Auth rate limiting. |
| `0004_p02_identity_link_challenges.sql` | 1 | 2 | 0 | Email link challenges. |
| `0005_p02_multiple_email_identities.sql` | 1 | 2 | 0 | Multiple email identities per user. |
| `0006_p02_device_consumed_state.sql` | 1 | 1 | 0 | Device consumed-state, so a one-time enrollment cannot be replayed. |
| `0007_p03_devices_projects_policy.sql` | 9 | 14 | 0 | Devices, enrollments, workspace bindings, policy snapshots and acks. |
| `0008_p02_authenticators.sql` | 4 | 6 | 0 | Authenticators (password, passkey). |
| `0009_p04_ai_platform.sql` | 13 | 18 | 4 | Provider/model catalog, credentials, routes and route versions, policy snapshots. |
| `0010_p05_runs_tools_usage_control.sql` | 16 | 33 | 8 | Runs, sessions, agents, tool calls, approvals, usage, cost records, budgets, rate limits. |
| `0011_p06_automations.sql` | 6 | 18 | 0 | Automations, schedule rules, occurrences, leases, run links. |
| `0012_p06_event_delivery.sql` | 8 | 19 | 6 | Webhook endpoints, secrets, deliveries, attempts, notifications, queue envelopes. |
| `0013_p06_billing_entitlements.sql` | 12 | 13 | 2 | Billing, subscriptions, entitlement definitions and grants, license state and snapshots. |
| `0014_p06_data_governance.sql` | 8 | 18 | 4 | Data governance: policies, export jobs and artifacts, download grants, deletion jobs/tasks/certificates. |
| `0015_p06_baseline_seed.sql` | 0 | 0 | 0 | Baseline seed. No tables — it fills the entitlement definitions the dispatcher needs. |
| `0016_p07_machine_identity.sql` | 2 | 5 | 12 | Machine identity: service accounts and API keys. **12 triggers:** every terminal-state invariant is enforced by the DATABASE, not only by Rust. |
| `0017_p07_plugin_governance.sql` | 7 | 10 | 14 | Plugin governance: publishers, packages, versions, policies, installs, tool registrations, quarantines. **14 triggers.** |
| `0018_p07_platform_operations.sql` | 4 | 8 | 14 | Platform operations: staff principals, support grants, feature flags, kill switches. **14 triggers.** `organization_id` here is the CUSTOMER a staff principal acts on, not a caller scope. |
| `0019_p08_migration_adoption.sql` | 4 | 10 | 3 | Migration adoption: workspace adoption state, stage events, remediation, and the published client-compatibility policy. `client_compatibility_policy` is the only class whose owner scope is Platform and whose sensitivity is Public. |
| `0020_p09_idempotency_null_safety.sql` | 0 | 0 | 4 | **P09. No new tables** — four triggers that close a NULL hole in `0001`'s idempotency CHECK. See below; it was the only migration in the repository that added constraints to an existing table rather than creating a new one, until `0021` below. |
| `0021_p02_team_id_check_correction.sql` | 0 (2 rebuilt) | 2 (recreated) | 0 | **P02 correction.** Rebuilds `teams` and `team_members` with their primary-key CHECK corrected. See below. |
| `0022_p07_staff_actor_type.sql` | 0 (1 rebuilt) | 4 (recreated) | 2 (recreated) | **P07 correction.** Rebuilds `security_events` with `actor_type` extended to name `staff`, the third actor kind from ADR 0007. Net zero for tables, indexes, and triggers — measured, not assumed: the four indexes and two immutability triggers are recreated verbatim, and losing them would have been a worse defect than the one repaired. See below. |
| `0023_p05_capability_catalogue_seed.sql` | 0 | 0 | 0 | **P05 / V04-010 repair.** No new tables — seeds two platform-wide `capability_definitions` rows (`browser`, `computer`; org_id NULL) so the tool-policy evaluator's capability check can pass and the FR-F13-005/006 controls are reachable. `INSERT OR IGNORE`, deterministic ids. |
| `0024_p03_device_policy_version.sql` | 0 | 0 | 0 | **P03 / V04-008 repair.** No new tables — `ALTER TABLE org_device_policy_settings ADD COLUMN version` for the optimistic concurrency of the new `PUT /api/v1/orgs/{org_id}/device-policy` lever. SQLite supports `ADD COLUMN` with a constant DEFAULT; the table was previously unwritten. |

## `0022` — `security_events.actor_type` gains `staff`

`0002` declared the audit table and its CHECK enumerated the pre-P07 world:

```sql
actor_type TEXT NOT NULL CHECK (
    actor_type IN ('user', 'service_account', 'support', 'system', 'anonymous')
)
```

`0018` added `staff_principals`, `StaffActor`, and the whole `/api/v1/internal/**` surface — sixteen
migrations later — and nothing extended the CHECK to name ADR 0007's third actor kind. So the value
the product writes is the one value the schema refuses, and ADR 0007's MUST ("a staff audit event is
written on grant creation and on every use") is unsatisfiable. Every internal write route answered
`503` on the batch that carried the audit row.

`'support'` is in the `0002` list and reads like the answer. It is not: it is a `StaffRole`, not an
actor kind, and writing it would record a `security` or `engineering` staff member's action as a
support action. The value is named, not coerced.

**Why a rebuild.** SQLite cannot `ALTER` a CHECK constraint, and editing `0002` would fix a fresh
database and nothing else — the ledger records it as applied. This is the same shape as `0021`.

**The column list came from the live schema, not from `0002`.** `0010` appended `run_id`,
`agent_session_id`, and `tool_call_id` with `ALTER TABLE`, so the table has nineteen columns and the
three new ones sit at the end. The first version of this migration copied the sixteen columns `0002`
declared and failed with `no such column: run_id`. The failure was loud, which is the good case; the
mistake was auditing the ledger for the indexes and triggers the rebuild would drop and not for its
columns. **The authority for a rebuild's shape is the live schema; the ledger only says what changed.**

**The immutability triggers are recreated verbatim.** `security_events` is append-only, and a rebuild
that silently dropped that guarantee would be a far worse finding than the one it repairs. Both
`BEFORE UPDATE` and `BEFORE DELETE` still abort, and the standalone check for the reconstruction is in
`security::actor_type_correspondence`, which reads the writer and the ledger and compares them.
