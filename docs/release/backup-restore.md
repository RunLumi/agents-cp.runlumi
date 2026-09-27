# Backup and restore guide

## The measured position

**A rehearsal has now been run, and it passes.** `pnpm verify:restore` builds a
populated D1 through `wrangler`, exports it with `wrangler d1 export`, restores the
dump into an empty database, and verifies the result. The script is
`apps/api/scripts/p09-restore-rehearsal.mjs`, it is re-runnable, and it is
non-destructive: it moves your local D1 state aside and puts it back, which is tested.

| Step | Measured (3 runs) |
|---|---|
| export | 2.05 – 2.27 s (195 KiB dump) |
| restore | 157 – 264 ms |
| verify | 151 – 218 ms |
| **RTO, recovery path** | **2.39 – 2.62 s** |
| whole rehearsal, including building the fixture | ~12 s |

**These are not a production RTO, and the script says so in its own output.** The
database measured is 195 KiB with two organizations. Every figure scales with size, and
the restore step scales worst because it replays a text dump. What the rehearsal
establishes is that **the path works and roughly what it costs per megabyte** — which
is a real measurement, and is not the same claim as a production RTO.

**RPO.** A logical export is a consistent point-in-time image, so nothing inside the
snapshot is lost: 0 rows. The recoverable-loss window is the *interval between exports*,
which is an operational decision, not a platform limit. D1 Time Travel is a separate
mechanism and was **not** exercised here.

## Why the verification step is the whole point

The obvious rehearsal migrates a database, exports it, restores it, and compares row
counts. That version proves almost nothing, because the failure that matters is a
restore that **loads but whose triggers are missing** — a database that accepts a
revoked credential being reactivated, because the trigger that refused it did not come
back with the data. Every row is present, `integrity_check` says `ok`, and the counts
match. Only an invariant suite can see it.

So the verification step is the 125 storage invariants run against the **restored**
file, using `P07_SCHEMA_DB` to make the harness skip migrations and the seed. That mode
exists because of this line: every number the harness had ever produced came from the
freshly-migrated path, which is structurally incapable of detecting a lossy restore.

The rehearsal also asserts the failure directly, as a sequence, because the invariant
is about what happens *after* a revoke:

```
revoke the seeded API key with a reason   -> accepted   (legal)
then blank the reason                     -> refused    (the trigger survived)
```

## The rehearsal proves it can fail

A verification step that has only ever printed PASS has not shown that it can fail —
which is the confusion this repository spent two phases removing from its other
verifiers. So step 6 of the script drops a trigger from a **copy** of the restored
file and requires the suite to notice:

```
PASS  a restore missing a trigger is DETECTED
      suite reported 123/125; failing: revoking a key without a reason is refused,
      a blocked install without a reason is refused
```

The damaged copy has every row, a clean `integrity_check`, and matching row counts. It
is not a database you could serve, and the suite says so. This runs **by default**;
`--no-fault-injection` skips it, and nothing should.

## How the script stays honest

Four bugs in this rehearsal were reporting success while measuring nothing, and each is
worth recording because each is the same shape as a bug found earlier in the phase:

- `--emit-db` printed the destination path and wrote to the throwaway workdir file, so
  it "succeeded" while producing a **zero-byte database**. A mode that reports success
  and produces nothing is worse than a mode that fails.
- The restore verdict tested the whole matched line against `^\d+/\d+$`, which a
  **passing** run fails — so a correct restore was reported as a failed rehearsal. A
  verdict check that inverts on success is worse than no verdict check.
- The verify timer started *after* verification, reporting `verify 0 ms`. A fabricated
  timing in the one document whose value is that its numbers are real.
- The first version used the default `.wrangler/state`, so a second run inherited the
  first run's rows and died on `UNIQUE constraint failed: users.email`. A rehearsal you
  can only run once, in a clean checkout, is not one you can rely on.

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

## Running it

```bash
pnpm verify:restore              # the whole thing, ~12 s
pnpm verify:restore -- --keep    # leave the dump and the restored file for inspection
```

It needs `wrangler` (a devDependency of `apps/api`) and nothing else — no Cloudflare
account, no remote database. Everything runs against `--local`.

What it does, in order:

1. `wrangler d1 migrations apply DB --local` — all 20 migrations, through wrangler.
2. `wrangler d1 execute DB --local --file seed.sql` — the harness's own fixture, handed
   over as SQL so the rehearsal's data and its verification cannot drift apart.
3. `wrangler d1 export DB --local --output backup.sql` — the real export path.
4. `sqlite3 restored.db < backup.sql` — restore into an empty database.
5. Six checks, then the fault injection.

The checks:

| Check | What it catches |
|---|---|
| the restored database carries its schema | a dump that lost DDL |
| `PRAGMA integrity_check` is clean | a truncated or corrupt dump |
| `PRAGMA foreign_key_check` is empty | orphans the restore introduced |
| every table has the same row count as the live source | rows silently dropped |
| **the 125 invariants pass against the restored file** | **a trigger that did not come back** |
| a revoked key's reason cannot be blanked | the same, asserted directly |

The row-count comparison is against the **live source**, read from the local D1 file,
not against a remembered number — so a seed change cannot make it quietly wrong. (It
reads the file for counting only; wrangler still builds the database and still performs
the export, which is the part that has to match production.)

### What is still unmeasured

The rehearsal fills in the numbers that were placeholders. These remain open, and each
says what it would take:

| Still unknown | Why | What it would take |
|---|---|---|
| **Production RTO** | The measured database is 195 KiB. Timings scale with size, and the restore scales worst. | Re-run against a production-shaped export, or extrapolate per MB and say that is what you did |
| **Export interval, and therefore real RPO** | An operational decision, not a platform property | Pick a cadence, and note that RPO equals it |
| **D1 Time Travel** | A separate mechanism from a logical export, not exercised here | A `--remote` Time Travel restore into a scratch database |
| **`wrangler d1 export --remote`** | Needs a Cloudflare account and a real database | One run against a non-production remote D1 |
| **R2 restore** | Deliberately excluded; artifacts are 35-day-ephemeral and a stale bucket is worse than none | A bucket-level restore, once there is a bucket worth restoring |
| **Restore under load** | The export is a consistent snapshot, but its effect on production latency is unmeasured | A staging run with traffic |

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

- **The RTO is for a 195 KiB database, not production.** Stated at the top and printed
  by the script itself. Re-run against a production-shaped export before quoting a
  number to anyone.
- **Time Travel and `--remote` export are unexercised.** Both need a Cloudflare
  account. The logical-export path is proven; the platform's own point-in-time
  mechanism is not.
- **R2 restore is not covered.** Deliberately — artifacts are 35-day-ephemeral, and a
  stale artifact bucket is worse than none. The failure mode (a grant whose key is
  absent) is asserted to fail closed in the R2 failure-injection tests, but a
  bucket-level restore has not been rehearsed.
- **The fixture is two organizations.** The invariants are what prove the restore, not
  the row count, but a larger dataset would also exercise the export's own limits.
