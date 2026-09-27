# Backup and restore guide

## The honest position first

**No automated backup-and-restore rehearsal has been performed.** There is no
exported dump in this repository, no measured RPO, and no measured RTO. This document
describes what a rehearsal would consist of and what the design guarantees and does
not — it does not claim a number nobody measured. A launch deadline is not
mitigation, and an invented RPO is worse than an absent one, because it is believed.

**Recommended posture for first release: do not launch until a rehearsal has been
run and this section has been replaced with measured numbers.** The design below is
what makes that rehearsal likely to succeed; it is not a substitute for it.

## What backs up, and what it costs

| Data | Location | Sensitivity | If lost |
|---|---|---|---|
| Identity, organizations, memberships | D1 | High | Total loss of the control plane's meaning |
| Devices, enrollments, policy acks | D1 | High | Devices must re-enroll |
| Runs, sessions, usage, cost records | D1 | **Irreplaceable** | Money and audit history gone. `usage_events` has no UPDATE **and no DELETE** trigger — deliberately, because a cost record that can be rewritten is not a cost record |
| Credentials (encrypted), providers, routes | D1 | High | BYOK secrets unrecoverable; tenants must re-enter them |
| Budgets, rate limits, reservations | D1 | Medium | Control state; reservations self-expire |
| Webhook endpoints and secrets | D1 | High | Must re-register |
| Export artifacts | R2 (private) | High | Re-run the export; artifacts are 35-day-ephemeral by policy |
| Queue backlog | Queues | Low | Events are in `outbox_events`; a dropped message is re-derived |
| Worker code | Deploy platform | — | Roll back a version |

**The one that cannot be reconstructed is cost and audit history.** Everything else
is either re-enterable by the tenant or derivable. That is why `usage_events` and the
audit tables are the highest-value backup target and the reason they are
append-only.

## Why the schema makes restore easier than it looks

1. **No migration from P02 onward alters a table an earlier phase created.** They
   create new ones. So a restore target can be any migration boundary, and a
   forward-only deploy is compatible with an older schema.
2. **Foreign keys cascade deliberately.** `ON DELETE CASCADE` from organizations to
   its children means a restore cannot leave orphans; a deleted organization takes
   its dependent rows with it.
3. **Terminal states are latched by the database, not by code.** A revoked credential
   cannot be reactivated by a trigger bypass, a lifted kill switch cannot be
   re-engaged in place, and a cost record cannot be edited. So a restored backup
   cannot arrive in a state the application would consider live-but-wrong.
4. **The idempotency table is bounded by TTL** and its sweep exists, so a restored
   snapshot does not carry an unbounded replay window.

## The rehearsal

Run this against a **production-shaped copy**, never production.

### Preconditions

- A D1 export from the live database (or Time Travel).
- A scratch D1 database with the same name shape.
- A scratch Worker deployment with `ENVIRONMENT` **not** `production`, so
  `allow_local_provider_endpoints` stays off and the egress allowlist still applies.
- The R2 bucket: do **not** copy it. Artifacts are 35-day-ephemeral; restoring a
  stale artifact bucket is worse than having none, because a download grant that
  resolves to a missing key must fail closed, and a stale bucket makes that harder
  to test.

### Procedure

```bash
# 1. Establish the baseline you are measuring against.
NOW_BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 2. Export D1.
wrangler d1 export lumi-agents-control-plane --remote --output backup.sql

# 3. Apply the SAME migrations to the scratch database, in order.
for m in apps/api/migrations/*.sql; do
  echo "applying $m"
  sqlite3 scratch.db < "$m"
done

# 4. Load the snapshot.
sqlite3 scratch.db < backup.sql

# 5. Verify the invariants still hold. This is the real test: a restored database
#    that violates a terminal-state trigger is a database you cannot serve.
node apps/api/scripts/p07-schema-invariants.mjs
```

The last step is the one that matters and the one most likely to be skipped. It
proves **97 behaviours are refused by the restored database**, not just by the code
that wrote it. A restore that loads but whose triggers are missing is the failure
mode this catches.

### What to record

| Metric | How |
|---|---|
| **RPO** | `NOW_BEFORE` minus the newest `occurred_at` in `outbox_events`. This is the real data loss window. |
| **RTO — export** | Wall time of the `d1 export`. |
| **RTO — restore** | Wall time of apply + load. |
| **RTO — verify** | Wall time of the invariant run. It is part of recovery, not a luxury. |
| **RTO — total** | The sum. This is the number to put in an SLA, and it is the number nobody has. |
| **Integrity** | 97/97 invariants. Anything less is a failed restore. |

### Verify the invariants that matter most

```sql
-- A revoked credential must still be revoked, with its reason.
SELECT COUNT(*) FROM api_keys
 WHERE status = 'revoked' AND (revoke_reason IS NULL OR revoke_reason = '');
-- Expected: 0. A non-zero result means the restore lost a trigger.

-- A lifted kill switch must still be lifted.
SELECT COUNT(*) FROM kill_switches
 WHERE state = 'lifted' AND lift_reason IS NULL;
-- Expected: 0.

-- A revoked grant must still be revoked, with its reason.
SELECT COUNT(*) FROM support_grants
 WHERE revoked_at IS NOT NULL AND (revoke_reason IS NULL OR revoke_reason = '');
-- Expected: 0.

-- A cost record must be immutable. If this UPDATE succeeds, the triggers are gone.
-- Run it inside a transaction you roll back.
BEGIN;
  UPDATE usage_events SET estimated_cost_minor = 0 WHERE rowid = (SELECT MIN(rowid) FROM usage_events);
ROLLBACK;
-- Expected: the UPDATE must FAIL.
```

## Restore order, if the database is restored but the Worker is not

1. Deploy the **older** Worker first if the backup predates a migration. The schema
   is forward-only, so an older Worker is compatible with a newer schema; the reverse
   is not guaranteed.
2. Apply nothing. The snapshot already contains the schema at the export point.
3. Deploy the newer Worker, and watch the sweeps: outbox retry, automation
   due/lease, budget expiry. They are re-entrant, so a backlog drains.
4. Expect **duplicate** queue deliveries during the gap. Every consumer deduplicates
   by event id or by a compare-and-set, so this is safe by construction — but watch
   the delivery tables for a step rather than a smooth curve.
5. Do **not** bulk-advance delivery or lease state to "clear" the backlog. The
   compare-and-set guards are what make redelivery safe, and bypassing them turns a
   duplicate into a double charge.

## Backups and deletion: the guarantee that is bounded

FR-F20-006 requires that deletion propagate to the backup lifecycle **on schedule**,
and that backups are **not** selectively rewritten when that is operationally unsafe.
So the honest statement is:

> A row deleted from the live database is gone from the live database immediately.
> It may persist in a backup until that backup expires. The real deletion guarantee
> is therefore bounded by the **backup retention window**, not by the deletion job.

Any user-facing or contractual claim about deletion must say so. The
`deletion_certificate` is proof that the live deletion ran; it is not proof that no
copy of the row survives anywhere, and it should not be represented as such.

## Known gaps in this document

- **No measured RPO or RTO.** See the top of this file. This is the single largest
  operational gap in the P09 evidence.
- **No rehearsal has been run.** The procedure above is written to be run, not
  reported as having been run.
- **R2 restore is not covered.** Deliberately — artifacts are 35-day-ephemeral, and a
  stale artifact bucket is worse than none. The failure mode (a grant whose key is
  absent) is asserted to fail closed in the R2 failure-injection tests, but a
  bucket-level restore has not been rehearsed.
- **D1 Time Travel retention is not asserted here.** It is a platform property and
  changes; confirm it against the account's actual configuration rather than
  assuming Cloudflare's default.
