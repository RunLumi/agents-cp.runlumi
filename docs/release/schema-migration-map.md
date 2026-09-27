# Schema and migration map

Generated from `apps/api/migrations/`. `security::release_docs` asserts this file
names every migration in apply order, so it cannot fall behind the schema.

**18 migrations · 107 tables · 190 indexes · 66 triggers.**

## Why the trigger count is the headline

An invariant enforced only in application code is one code path away from being
bypassed by a migration, a script, a console session, or a future packet. A trigger
is the only thing that still holds when nobody remembers the Rust.

That is what the 66 triggers are for, and why the schema harness
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

## Rollback is forward-only, and the schema is why

No migration from P02 onward alters a table created by an earlier phase; they
create new ones. Rolling back a release therefore means rolling back the
**Worker**, not the database. `0016`–`0018` add only new tables, so dropping them
is safe and no pre-P07 data is at risk.

The consequence worth stating rather than hiding: a rollback leaves the newer
tables in place, harmless and unread, until a forward migration or a manual drop.
That is the correct trade. A down-migration that drops a column a still-running
older Worker reads is far worse than an orphan table.

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
| `0001_p01_foundation.sql` | 2 | 2 | 0 | Outbox and idempotency substrate. Both use `organization_id` — the spelling the rest of the schema did not follow, which is why the tenant audit knows both. |
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
