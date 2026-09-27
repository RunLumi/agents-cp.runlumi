# SLO and dashboard references

## What exists, and what does not

**Exists:** a stable event taxonomy, a stable error-code vocabulary, request and
correlation ids on every response, and three production log sites that are pinned by
a test. All the queries an operator needs to answer Gate D's six questions are
**SQL against D1**, in `runbook.md`.

**Does not exist:** a metrics pipeline. `wrangler.jsonc` enables Cloudflare
`observability` with `head_sampling_rate: 0.1` and nothing else — no `logpush`, no
Workers Analytics binding, no custom metrics, no alert definitions, and no SLO
targets recorded anywhere in this repository.

That is stated first because a document titled "SLO" that implies dashboards exist
would be the most dangerous artifact in this release. **There are no dashboards
yet.** What follows is the specification for them, derived from queries that are
known to work, so building them is transcription rather than design.

## The three signals in production today

| Signal | Where | Cardinality | Retention |
|---|---|---|---|
| `console_error!` | Workers Logs, 10% head sampling | 3 call sites, each a stable snake_case code | Per Cloudflare plan |
| Workers `observability` | Cloudflare dashboard | Sampled traces | Per Cloudflare plan |
| Everything else | D1 | `outbox_events`, `security_events`, `queue_job_envelopes`, `provider_health` | Until retention |

**The three log sites are pinned** by `security::secret_canary`'s static half, so a
fourth is a deliberate act rather than a stray `dbg!`. That is worth something: three
stable codes are greppable, and a log line containing a value is not.

## Stable codes you can alert on

Every one of these is a `console_error!` code or an `error.details.reason`. They are
the vocabulary; a substring match on free text is not.

| Code | Means | Page? |
|---|---|---|
| `outbox_retry_sweep_failed` | The cron sweep could not publish due events | Yes, if sustained |
| `automation_sweep_failed` | The automation clock is not advancing | **Yes.** Automations stop firing |
| `budget_expiry_sweep_failed` | Expired holds are not being cleared | No — bookkeeping only, and admission is unaffected |
| `p06_data_job_rejected` | A data-job envelope would not decode | Investigate; may be a poison message |
| `p06_job_dead_lettered` | A job exhausted its retries | **Yes.** A tenant's work stopped |
| `webhook_delivery_store_unavailable` | D1 refused a delivery transition | Yes, if sustained |
| `worker_clock_unavailable` | `now_utc()` failed | **Yes.** Every sweep and signature depends on it |
| `platform::sha256_hex failed` | Hashing failed on a request path | **Yes.** Credential verification is broken |

## The dashboards to build, and the query behind each

Every query below is one an operator can run today. Building the dashboard is
transcribing them.

### 1. Request health

```sql
-- Error rate by stable code, hourly. This is the primary "what is failing".
SELECT strftime('%Y-%m-%dT%H:00', occurred_at) AS hour,
       json_extract(metadata, '$.code')      AS code,
       COUNT(*)                             AS n
  FROM security_events
 WHERE event_type LIKE 'api.%'
   AND occurred_at >= datetime('now', '-24 hours')
 GROUP BY hour, code
 ORDER BY hour ASC;
```

### 2. Tenants affected

```sql
-- Blast radius: one org, or many. Most pages are answered by this shape alone.
SELECT organization_id, COUNT(*) AS n
  FROM security_events
 WHERE occurred_at >= datetime('now', '-1 hour')
 GROUP BY organization_id
 ORDER BY n DESC
 LIMIT 50;
```

### 3. Provider health

```sql
-- Which provider is failing, and since when.
SELECT provider_id, model_id, state, detail, updated_at
  FROM provider_health
 ORDER BY updated_at DESC;
```

The state machine is explicit: a provider in a failed state with a rising
`consecutive_failures` is the answer to "which provider" far more often than a tenant
is. Alerts on the *transition into* a failed state, not on the state itself, or it
fires forever.

### 4. Queue lag and depth

```sql
-- Queue lag: the oldest thing still waiting. A rising number is the alarm.
SELECT
  COUNT(*) FILTER (WHERE state IN ('queued', 'retry_wait'))      AS waiting,
  COUNT(*) FILTER (WHERE state = 'running')                      AS running,
  COUNT(*) FILTER (WHERE state = 'dead_letter')                  AS dead,
  MIN(next_attempt_at) FILTER (WHERE state IN ('queued', 'retry_wait')) AS oldest_due
  FROM queue_job_envelopes;
```

Dead letters are the load-bearing column. Before P09 a dead-lettered job never
appeared here at all, because the jobs DLQ was declared and never read.

```sql
-- The dead letters themselves, for the incident.
SELECT job_id, job_type, org_id, subject_id, attempt, last_error_code, updated_at
  FROM queue_job_envelopes
 WHERE state = 'dead_letter'
 ORDER BY updated_at DESC;
```

### 5. Budget denials

```sql
-- Denials by tenant: is one tenant hitting a ceiling, or is the platform wrong?
SELECT org_id, COUNT(*) AS denials
  FROM usage_events
 WHERE recorded_at >= datetime('now', '-1 hour')
   AND estimated_cost_minor = 0
 GROUP BY org_id
 ORDER BY denials DESC
 LIMIT 50;
```

### 6. Security alerts

```sql
-- Refusals by type. A step change here is an attack or a deploy.
SELECT event_type, COUNT(*) AS n, MIN(occurred_at) AS first_seen
  FROM security_events
 WHERE occurred_at >= datetime('now', '-6 hours')
 GROUP BY event_type
 ORDER BY n DESC;
```

Alert on a **rate of change**, not a count. A flat count of denials is normal; a
tenfold jump in an hour is a story.

### 7. Spend integrity

```sql
-- The number that must always be zero. A non-zero value means a charge was
-- written without a reservation, which no code path should permit.
SELECT COUNT(*) AS unreserved_charges
  FROM cost_records
 WHERE budget_id IS NULL AND reservation_id IS NULL;

-- Reservations stuck past their expiry. Before the budget-expiry sweep this grew
-- without bound and an operator could not tell a leaked hold from live spend.
SELECT COUNT(*) AS stale_holds, COALESCE(SUM(reserved_minor), 0) AS minor
  FROM budget_reservations
 WHERE status = 'reserved' AND expires_at <= datetime('now');
```

### 8. Lease and sweep health

```sql
-- A running job past its lease means the worker died mid-flight. The lease
-- expiry sweep reclaims it; a count that only grows means the sweep is failing.
SELECT COUNT(*) AS expired_leases
  FROM automation_leases
 WHERE state = 'running' AND lease_expires_at <= datetime('now');
```

## Proposed SLOs

**Not committed.** These are proposals with no measurement behind them, and
publishing an SLO you have never measured is how you end up paging on noise.

| Indicator | Proposal | Why this shape |
|---|---|---|
| API availability | 99.9% monthly, excluding `503` from our own store being down | The control plane's core promise |
| Authorization correctness | **100%** | Not a percentage target. One wrong authorization is a breach, and the release bar treats it as one |
| Money correctness | **100%** | A wrong charge is a customer incident and is immutable by design. There is no acceptable rate |
| Queue lag (p99) | < 60s | The cron is every minute, so a minute is the natural quantum |
| Dead-letter rate | < 0.1% of jobs | Anything higher is a product problem, not an infra one |
| Restore time | **Unknown** | Not proposed, because no rehearsal has been run. See `backup-restore.md` |

The two 100% rows are deliberately not 99.9%. They are the two places where "almost"
is not a category — and both are enforced structurally rather than by monitoring:
`usage_events` is append-only, and authorization has no code path from one actor type
to another.

## What to build before this document is true

1. **A `logpush` job** to Workers Logs or an aggregator, so the three stable codes are
   queryable without the Cloudflare dashboard and without 10% sampling losing the
   event you need.
2. **Alerts** on the eight codes above. Pages on the four marked Yes.
3. **A dashboard** transcribing the eight queries. They are written; they need a home.
4. **A rehearsal** to put a number against the restore row.
5. **A staging deploy** to measure the field metrics `performance.md` lists as
   unmeasured.
