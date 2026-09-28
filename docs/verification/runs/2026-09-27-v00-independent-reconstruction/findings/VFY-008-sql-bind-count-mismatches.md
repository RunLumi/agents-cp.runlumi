# Finding VFY-008 — Six SQL statements bind the wrong number of values, and one of them made every P06 export and deletion request fail

## Status

closed

## Severity

critical

## Affected claim

- Claim ID: `VI-DATA-001` (Tier 0)
- Source requirement: `docs/specs/f20-data-governance-export-deletion-retention.md`
  FR-F20-003, FR-F20-004, FR-F20-005, FR-F20-007;
  `docs/specs/f15-automations-scheduled-offpeak-tasks.md` FR-F15-004
- Risk tier: 0 (existential — the feature does not work)

## Statement

D1 rejects a prepared statement whose bound-value count does not equal the highest `?N` index in
its SQL, with `Wrong number of parameter bindings for SQL query`. **Six** statements in the
repository did not match, and **five of them were reachable from production code**:

| Statement | Binds | Needs | Reachable from |
|---|---|---|---|
| `data_governance::INSERT_QUEUE_ENVELOPE_SQL` | 12 | 11 | **all four P06 job-creating routes** |
| `data_governance::UPDATE_POLICY_SQL` | 14 | 15 (skipped `?2`) | `PATCH /api/v1/orgs/{org_id}/data-policy` |
| `automations::RENEW_LEASE_SQL` | 6 | 5 | `routes/automations.rs` |
| `automations::SETTLE_LEASE_SQL` | 6 | 5 | `routes/automations.rs` |
| `automations::CLOSE_LEASE_SQL` | 7 | 6 | `routes/automations.rs`, `jobs/automations.rs` |
| `devices::COMPLETE_ENROLLMENT_SQL` | 4 | 3 | `DeviceRepository::complete_enrollment` — **no callers** |

`INSERT_QUEUE_ENVELOPE_SQL` is the severe one. Its SQL reused `?11` for four different columns —
`payload_ref`, `next_attempt_at`, `created_at` **and** `updated_at` — so the timestamps were bound
to a string like `d1:export_jobs/exp_…`, which `queue_job_envelopes`' 24-character `GLOB` check
refuses. The author had bound a twelfth value, `now`, intending a twelfth placeholder. Every
request that creates a P06 job therefore failed inside its D1 batch.

`UPDATE_POLICY_SQL` had the mirror-image fault: its placeholders started at `?3`, skipping `?2`,
so its fourteenth bound value landed on `?14` while the statement's `WHERE version = ?15` had
nothing to bind. `PATCH /api/v1/orgs/{org_id}/data-policy` failed the same way.

The three automation lease statements were each wrong twice: the column they set was numbered one
below the column its predicate compared, so `SET expires_at = ?3` and `WHERE org_id = ?3` bound
the same value to both.

## Why it survived 57 domain tests, 125 storage invariants, and a green suite

None of them execute a `prepare()` through D1. The domain tests call repository functions against
a mock, and the storage invariants apply migrations and write rows through `wrangler d1 execute`
directly. Nothing joined the two halves: the statement's shape was never checked against its
bindings.

It also survived review because the failure presented as a **business conflict**, not a server
fault. `commit_mutation` in `routes/agents.rs` runs the batch, keeps only `result.is_ok()`,
**discards the error**, re-reads the idempotency record, and maps `IdempotencyLookup::Missing` to
`409 conflict`. A failed batch leaves no record, so every server-side fault on a mutation route
was reported to the client as "The request conflicts with current state."

## Reproducer

### Preconditions

A built Worker and a fresh local D1.

### Before

```bash
pnpm build
node apps/api/scripts/p06-data-smoke.mjs     # the probe written for this finding
```

```
FAIL  request an organization export  — status=409 reason=conflict (wanted 201/202)
P06 probe harness failure: no export ID to follow
```

And the underlying error, which the 409 concealed — from a temporary, reverted diagnostic in
`commit_mutation`:

```
dbg_commit_mutation_failed: Some(D1(D1Error { cause: JsValue(Error: Wrong number of parameter bindings for SQL query. ...
```

The static check, which is now a gate:

```bash
pnpm schema:bind-count
```

```
checked 463 prepare() call(s) against their SQL constants
  MISMATCH  src/repositories/data_governance.rs:2035  prepare(INSERT_QUEUE_ENVELOPE_SQL, …) binds 12 value(s) but INSERT_QUEUE_ENVELOPE_SQL needs 11 …
  MISMATCH  src/repositories/data_governance.rs:1400  prepare(UPDATE_POLICY_SQL, …) binds 14 value(s) but UPDATE_POLICY_SQL needs 15 …
  MISMATCH  src/repositories/automations.rs:1788  prepare(RENEW_LEASE_SQL, …) binds 6 value(s) but RENEW_LEASE_SQL needs 5 …
  MISMATCH  src/repositories/automations.rs:1811  prepare(SETTLE_LEASE_SQL, …) binds 6 value(s) but SETTLE_LEASE_SQL needs 5 …
  MISMATCH  src/repositories/automations.rs:1835  prepare(CLOSE_LEASE_SQL, …) binds 7 value(s) but CLOSE_LEASE_SQL needs 6 …
  MISMATCH  src/repositories/devices.rs:404  prepare(COMPLETE_ENROLLMENT_SQL, …) binds 4 value(s) but COMPLETE_ENROLLMENT_SQL needs 3 …

6 statement(s) would be rejected by D1 at execution time.
```

### After

```
$ pnpm schema:bind-count
checked 463 prepare() call(s) against their SQL constants

every prepare() call binds exactly as many values as its SQL has placeholders

$ node apps/api/scripts/p06-data-smoke.mjs
  PASS  request an organization export  — status=201
  PASS  the export is created in the `requested` state, not pre-declared as ready  — state=requested
  ...
26/26 P06 data-governance cases hold, 1 leg blocked by the environment
```

## The repair

Six edits, each the smallest coherent change:

- `INSERT_QUEUE_ENVELOPE_SQL` — the three timestamps get their own `?12`. The twelfth bind the
  author had written is now the placeholder it was written for.
- `UPDATE_POLICY_SQL` — placeholders renumbered `?3..?15` → `?2..?14` so they are contiguous and
  match the fourteen values already bound. The alternative, adding a fifteenth bind, would have
  meant inventing a value the call site does not have.
- `RENEW_LEASE_SQL` / `SETTLE_LEASE_SQL` / `CLOSE_LEASE_SQL` — the SET clause and the two
  predicates renumbered so each column reads its own bound value.
- `COMPLETE_ENROLLMENT_SQL` — the redundant fourth bind removed from
  `DeviceRepository::complete_enrollment`. That function has **no callers**; the live path is
  `complete_enrollment_statements`, which already bound three. The defect was latent, and is
  recorded as such rather than as a runtime failure.

### The check, and its own two defects

`apps/api/scripts/p09-bind-count-scan.mjs` is in `pnpm test` as `pnpm schema:bind-count`. It reads
source, so it verifies arity, not correctness of individual values, and it cannot distinguish a
live statement from one in dead code. Both limits are stated in the file.

Its first two versions were wrong in ways that would have made it worse than useless, and both
were caught by running it rather than reading it:

1. It resolved SQL constants from one global map. **Nine constant names are reused across modules
   with different arity** — `INSERT_EVENT_SQL`, `INSERT_GRANT_SQL`, `INSERT_POLICY_SQL` and six
   others — so it matched calls against other modules' SQL and reported **18** mismatches, of
   which 12 were fiction. Constants are now resolved per file.
2. The bracket walk tested `ch === "([{"`, comparing one character to a three-character string,
   which is never true. Every call returned "no closing bracket", every statement was skipped,
   and the check **reported green having examined zero statements**. A verifier that cannot see
   anything must not be able to pass; `checked N` is now printed so `N == 0` is visible.

A third fault was a false *positive*: `prepare(SQL, &[])` was counted as binding one value,
because the element counter started at one. It is now zero for an empty array.

The scanner is shown to fire: removing one bind from `INSERT_QUEUE_ENVELOPE_SQL` reports that one
mismatch and exits non-zero; restoring it returns to zero.

## Regression proof, at the cheapest correct layer

- **Runtime**: `apps/api/scripts/p06-data-smoke.mjs` drives a real export request over HTTP to a
  real Worker and a real local D1. The 409 becomes a 201 with a durable `export_jobs` row, a
  durable `queue_job_envelopes` row, and a delivered outbox event.
- **Static**: `pnpm schema:bind-count`, 463 statements, sensitivity shown above.
- **Unchanged gates**: `pnpm smoke:p05` 185/0, `pnpm smoke:passkey` 55/55, `pnpm guard:probe`
  13/13, `pnpm check` exit 0.

## Residual risk

`commit_mutation` still discards the batch error, so a future D1 fault on a mutation route will
again present as `409 conflict`. That is VFY-009's second half and is recorded there; fixing it
properly means deciding what a mutation route should say when its own transaction fails, which is
a contract question rather than a bug fix.
