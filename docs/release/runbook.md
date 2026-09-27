# Operator runbook

For the on-call engineer with a page. The six questions Gate D requires an operator
to be able to answer are the six sections.

## 0. First thirty seconds

Every response body carries `error.request_id`, and that id is the join key to
everything. Grab it first.

```bash
# The id from the failing response or the log line.
REQUEST_ID=req_0123456789abcdef0123456789abcdef
```

```sql
-- Everything one request did, in order.
SELECT event_id, event_type, occurred_at, organization_id, payload
  FROM outbox_events
 WHERE request_id = ?
 ORDER BY occurred_at ASC;
```

That single query answers "which tenant", "what it attempted", and "when it began"
for most pages. Everything below is for when it is not enough.

## 1. What is failing?

Three surfaces, in the order they are worth checking.

**A failing request.** The error `code` is a stable enum, not prose. The `details`
map carries `reason`, which is finer-grained and is what you branch on.

```sql
-- Recent security events, which is where denials and refusals land.
SELECT event_id, event_type, organization_id, occurred_at, resource_id, metadata
  FROM security_events
 ORDER BY occurred_at DESC
 LIMIT 100;
```

**A failing job.** Jobs are durable in `queue_job_envelopes`, so a "lost" job is
visible rather than merely missing.

```sql
-- Everything not in a terminal state, oldest first.
SELECT job_id, job_type, org_id, subject_id, state, attempt,
       next_attempt_at, last_error_code, lease_expires_at, updated_at
  FROM queue_job_envelopes
 WHERE state NOT IN ('succeeded', 'dead_letter', 'cancelled')
 ORDER BY next_attempt_at ASC
 LIMIT 200;
```

**A dead-lettered job.** These are terminal and visible in Lumi, not only in the
Cloudflare dashboard — `JOBS_DLQ_NAME` is consumed and writes `dead_letter` with the
code `queue_dead_lettered`.

```sql
SELECT job_id, job_type, org_id, subject_id, attempt, last_error_code, updated_at
  FROM queue_job_envelopes
 WHERE state = 'dead_letter'
 ORDER BY updated_at DESC
 LIMIT 200;
```

> Before P09 this was a hole: the jobs dead-letter queue was declared and never
> read, so these rows never appeared and only the Cloudflare dashboard showed the
> failure. If you are reading this during an incident and find nothing here for a
> job you know failed, check the dashboard.

## 2. Which tenant, provider, or resource?

Every durable row carries `org_id` **except** the staff and platform tables, where
`organization_id` names the *customer being acted on* rather than a caller scope
(`support_grants`, `kill_switches`). That distinction is real and it is why a naive
`org_id` scan historically missed four tables; see the schema map.

```sql
-- One organization's whole footprint, for a support conversation.
SELECT 'runs' AS kind, COUNT(*) FROM runs WHERE org_id = ?
UNION ALL SELECT 'usage_events', COUNT(*) FROM usage_events WHERE org_id = ?
UNION ALL SELECT 'cost_records', COUNT(*) FROM cost_records WHERE org_id = ?
UNION ALL SELECT 'webhook_deliveries', COUNT(*) FROM webhook_deliveries WHERE org_id = ?
UNION ALL SELECT 'inference_requests', COUNT(*) FROM inference_requests WHERE org_id = ?
UNION ALL SELECT 'automation_occurrences', COUNT(*) FROM automation_occurrences WHERE org_id = ?;
```

**Provider health** is per provider and per model, not per tenant:

```sql
SELECT provider_id, model_id, state, detail, updated_at
  FROM provider_health
 ORDER BY updated_at DESC;
```

A provider in a failed state with a rising `consecutive_failures` is the answer to
"which provider" far more often than a tenant is.

## 3. When did it begin?

```sql
-- The first occurrence of an event type in a window, then its frequency by hour.
SELECT strftime('%Y-%m-%dT%H:00', occurred_at) AS hour, COUNT(*) AS n
  FROM security_events
 WHERE event_type = ?
   AND occurred_at >= ?
 GROUP BY hour
 ORDER BY hour ASC;
```

The hourly histogram is the useful shape: a step change is a deploy, a ramp is a
tenant's growth, and a spike with no ramp is an attack or a retry storm.

**Cross-reference the deploy.** Almost every "it started at 14:05" is a deploy at
14:00. Check the Worker version before investigating further.

## 4. What is the blast radius?

Order these cheapest to most expensive. Stop when one answers "yes, and it is
bounded".

**Is it one tenant?**

```sql
SELECT organization_id, COUNT(*) AS n
  FROM security_events
 WHERE event_type = ? AND occurred_at >= ?
 GROUP BY organization_id
 ORDER BY n DESC;
```

One organization with all of them is a tenant problem. Many organizations with the
same shape is ours.

**Is it one provider?** See `provider_health` above.

**Is it one version of the Worker?** Compare the first occurrence against the last
deploy. If they coincide, it is the deploy until proven otherwise.

**Is it a data problem?** For spend, the honest blast radius is the reservation, not
the estimate:

```sql
-- Live holds right now. This is what is actually consuming budget.
SELECT COUNT(*) AS holds, COALESCE(SUM(reserved_minor), 0) AS minor
  FROM budget_reservations
 WHERE status = 'reserved' AND expires_at > ?;
```

If a hold is stuck at `reserved` with an expiry in the past, it is not spending —
admission already ignores it — but it will not clear on its own either, and the
scheduled sweep will expire it. See §6.

**Is it cross-tenant?** If you suspect it, do not go looking through the API. Run the
audit:

```bash
cargo test -p lumi-agents-control-plane-api --lib security::tenant_audit
```

It classifies all 421 statements touching a tenant-owned table and fails if any is
unclassified or contradicts its class. A green run is evidence the *statements* are
sound; it is not evidence the *routes* pass the right ids (see the threat model).

## 5. What changed?

```sql
-- One row's history. The `version` column is the optimistic-concurrency guard, so
-- it only moves on a real change.
SELECT version, state, updated_at, payload
  FROM outbox_events
 WHERE subject_id = ?
 ORDER BY version DESC;
```

Then answer these three, in order:

1. **Was there a deploy?** Check the version, and the time.
2. **Was there a config change?** `LUMI_PROVIDER_ALLOWLIST`, `WEBHOOK_SECRET_KEY`,
   `ENVIRONMENT`, and the sweep limits are the ones that change behaviour without a
   deploy.
3. **Was there a migration?** All 18 are forward-only and create tables; see the
   schema map. A migration cannot rewrite existing data, so if data changed, a
   migration did not do it.

## 6. What is the safest rollback or kill switch?

**Ranked least to most destructive.** Prefer the first thing that works.

| Situation | Action | Blast radius | Reversible |
|---|---|---|---|
| One provider misbehaving | Disable the provider in the catalog, or narrow its route | That provider | Yes |
| One plugin version dangerous | Quarantine `package@version` | That package | Yes — lift the quarantine |
| One automation misfiring | Soft-delete the automation | That automation | Partly — recreate |
| One tenant misbehaving | Suspend the organization | That tenant | Yes |
| One machine credential compromised | Revoke the key | That key | No — and that is correct |
| A feature is wrong everywhere | Feature flag off | That feature | Yes — flags are checked on every resolution |
| A route is wrong everywhere | Roll back the Worker | Everything on that route | Yes — previous version |
| Last resort | Engage a kill switch | One target class, org or global | Yes — lift it |

**Kill switches** are the surgical instrument, and they are the right answer more
often than a deploy rollback. They take one target, require a reason, and cannot be
re-engaged in place — lifting is a separate, audited act.

```sql
SELECT kill_switch_id, target_class, target_ref, scope, organization_id,
       reason, engaged_by_staff_principal_id, engaged_at, expires_at, state
  FROM kill_switches
 ORDER BY engaged_at DESC;
```

**Organization before global.** Both rows are returned by the read and the narrow one
is evaluated last, so a caller that stops at the first engaged row reports the
organization-scoped decision. That ordering is the whole point: a rollback can
target one org *before* anyone reaches for a global disable.

**Worker rollback** is the blunt instrument and the schema permits it. No migration
from P02 onward alters a table an earlier phase created, so rolling back the Worker
needs no down-migration. The newer tables stay in place, harmless and unread.

**Feature flags resolve on every call**, and expiry is checked *before* the enabled
flag, so an expired flag reports `expired` rather than "off" and leaving an operator
to guess. A flag must carry an expiry: this is not a permanent configuration store.

## Routine sweeps

Three run on the cron trigger, each bounded, each re-entrant. A missed tick loses no
work.

| Sweep | Bound | What it does |
|---|---|---|
| Outbox retry | per tick | Publishes due events. At-least-once; consumers dedupe by event id |
| Automation due + lease expiry | 50 | The authoritative clock for automations |
| Budget expiry | 50 orgs × 50 holds | Expires holds whose request died. Not a spend control — admission already ignores an expired hold — but the only way a hold reaches a terminal state |

Retry budgets are all finite and all bounded: outbox 6 attempts / 900 s cap,
automations 8, data jobs 5, webhooks `max_attempts ∈ [1, 8]`, provider `max_retries
≤ 3` with at most 7 fallbacks. A poison message ends in a visible `dead_letter`. It
does not loop.

## Reading a stream failure

A provider stream cut short before its terminal marker is **not** a success. Before
P09 it was: the run was recorded `completed`, the reservation was **committed** at
the full upper bound, and `usage.recorded` plus `inference.completed` were emitted —
overcharging the tenant and asserting something false in the audit trail.

Now a short stream releases the reservation like a timeout does, and the body ends
with an `error` frame so a client never has to infer completion from the body simply
ending. `may_complete()` gates the terminal decision.

**Release-note consequence:** an endpoint that ends SSE *without* `data: [DONE]` is
now `upstream_invalid_response` rather than `completed`. That is the correct protocol
reading, but it is a behaviour change for any non-conforming provider.
