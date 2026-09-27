# Finding VFY-009 — The P06 job queue has a consumer and no producer, so no export or deletion has ever run

## Status

partially closed — the producer and the routing are repaired; the R2 leg is unproven here

## Severity

critical

## Affected claim

- Claim ID: `VI-DATA-001` (Tier 0)
- Source requirement: `docs/specs/f20-data-governance-export-deletion-retention.md`
  FR-F20-003 ("User can export personal account data and organization-owned data"),
  FR-F20-004 ("Authorized org admin can request async export"), FR-F20-005 ("Deletion pipelines
  are asynchronous and idempotent"), FR-F20-007 ("Deleting DB metadata is insufficient if
  object/blob copies remain")
- Risk tier: 0 (existential)

## Statement

An export request writes three things in one D1 transaction: the `export_jobs` row, a
`queue_job_envelopes` row of type `export.run`, and an `outbox_events` row. The first two are
correct and durable. **Nothing ever sends the second to the queue it names.**

`JOBS_QUEUE` is declared in `wrangler.jsonc` as a producer binding in all three environments, has
a consumer attached, and a handler that routes on `batch.queue()`. But:

```
$ grep -rn "JOBS_QUEUE" apps/api/src --include='*.rs'
apps/api/src/lib.rs:56:    env.var("JOBS_QUEUE_NAME")
apps/api/src/consumers/webhooks.rs:3://! P06 job messages travel on a separate `JOBS_QUEUE`/`JOBS_DLQ` binding ...
apps/api/src/routes/webhooks.rs:16:// `JOBS_QUEUE` handler that reference this module are not wired yet ...
```

The binding is **never obtained**. `env.queue(...)` is called in exactly two places in the whole
codebase, and both ask for `OUTBOX_QUEUE`. There was also no query that could find a due
envelope: `queue_job_envelopes` had an INSERT, a by-dedupe lookup, a claim, and a settle, and
nothing that asked "what is waiting to be sent?".

So a job was written, never dispatched, and never run — in local development and in production
alike. The whole asynchronous half of F20 was dead.

### The second half: the handler could not have routed a job even if one had arrived

`p06_jobs_queue_name` falls back to `"lumi-agents-jobs"` when the `JOBS_QUEUE_NAME` var is
unset, and **that var was declared in no environment**. The fallback happens to be correct for
production (`lumi-agents-jobs`) and wrong for development (`lumi-agents-jobs-development`), so in
development every job message compared unequal, fell through to `consume_p01_outbox`, was decoded
as a business `EventEnvelope`, rejected, and acknowledged. A job delivered to the wrong queue was
indistinguishable from a job that never arrived.

### The third half: nothing said any of this

`run_scheduled_sweep` reported one failure string, `outbox_retry_sweep_failed`, for a fault in
either half. The dispatcher added below had no log at all. A queue that cannot say what it did is
indistinguishable from a queue that is not running, which is the condition this finding existed
for.

## Reproducer

### Preconditions

A built Worker and a fresh local D1.

### Before

```bash
pnpm build
node apps/api/scripts/p06-data-smoke.mjs
```

```
PASS  request an organization export  — status=201
...
P06 probe harness failure: the export job reaches a terminal state did not reach the expected state within 120000ms
```

The durable state says why:

```bash
sqlite3 …/miniflare-D1DatabaseObject/*.sqlite \
  "SELECT job_type, state, attempt FROM queue_job_envelopes;
   SELECT export_id, state, attempt FROM export_jobs;"
```

```
export.run|queued|1
exp_e68d0b9336514f708be7dcb739de1b01|requested|0
```

`attempt = 1` is the INSERT default, not a delivery: the job was never claimed, so no consumer
ever saw it.

### After

```
$ node apps/api/scripts/p06-data-smoke.mjs
  PASS  request an organization export  — status=201
  ...
BLOCKED: the export was created and durably enqueued, but the local queue
simulator did not hand the job to the consumer in a form it could read, so the
R2 leg of VI-DATA-001 cannot be decided here.
  envelope  [{"job_type":"export.run","state":"queued","attempt":1}]
  outbox    [{"event_type":"export.requested.v1","delivery_status":"delivered"}]
26/26 P06 data-governance cases hold, 1 leg blocked by the environment
```

And in the Worker log, the producer and the routing are now both visible:

```
p06_queue_routed:outbox
p06_queue_routed:jobs
[wrangler:info] QUEUE lumi-agents-jobs-development 1/1 (16ms)
```

The message is published and delivered. What is still unproven is whether the delivered **body**
survives the local queue intact: the consumer's own routing line reports the jobs route, it
receives one message, and the body it decodes carries no `job_type`, so it acknowledges the
message and the job stays `requested`. That is a property of the local simulator that this
environment cannot settle, and it is why the R2 leg is reported BLOCKED rather than passed.

## The repair

1. **`QUEUE_ENVELOPES_DUE_SQL` + `list_due_queue_envelopes`** — the missing read. Bounded, oldest
   first, and only `queued` or `retry_wait` rows whose `next_attempt_at` has arrived.
2. **`QueueEnvelopeDispatchRow::to_message`** — the missing conversion. It fills
   `payload.export_id` / `payload.deletion_id` from the row's subject, because the handler reads
   the subject out of `payload` and not out of `payload_ref`; a message carrying only the
   reference would decode cleanly and then run nothing. A subject type that is not a data job is
   **refused** rather than published, for the same reason.
3. **`dispatch_due_data_jobs`** — the missing producer, called from `run_scheduled_sweep`
   immediately after the outbox sweep. This is the same shape the outbox already uses: a mutation
   commits its envelope inside its own transaction, and the sweep turns a durable record into a
   delivery. Failures are per-envelope; one unmappable row must not strand every job behind it.
4. **`JOBS_QUEUE_NAME` declared** in all three environments, so the handler routes on the queue
   that environment actually binds instead of on an environment-blind fallback.
5. **The queue stopped being mute.** `p06_queue_routed:<route>` per batch;
   `p06_data_job_outcome:<outcome>` per data job; the sweep distinguishes a due-envelope read
   failure from an outbox failure; a missing `JOBS_QUEUE` binding and an empty due set are each
   reported. All bounded, all free of identifiers.

`QUEUE_ENVELOPES_DUE_SQL` is registered in the tenant audit as `Class::PlatformSweep` — it
deliberately crosses tenants, because the cron serves every tenant at once, and the `LIMIT` is
what makes that safe. Labelling it `OrgBound` was rejected by the audit's own
`every_classification_is_true_of_the_statement_it_labels` check, which is that check doing its
job.

## Regression proof

Four unit tests in `repositories::data_governance::tests`, each aimed at a way this could rot
again:

- an export row becomes a message the consumer's **own** `validate()` accepts — the consumer's
  gate, not a re-implementation of it, because the two live in different modules;
- a deletion row carries the deletion id and not the export id;
- a non-data subject type is refused rather than published;
- the row struct deserializes from exactly the column list the due query selects — a column
  renamed on either side is a runtime failure, not a compile error.

Plus the dedupe-key assertion inside the first test: the consumer looks its row up by a key it
*derives* from the job type and subject id, so a producer carrying any other key would publish a
message the consumer cannot find — the silent failure this finding was.

## Residual risk

- **The R2 leg of `VI-DATA-001` is UNPROVEN.** The export request, the durable rows, the CSRF and
  permission checks are proven; the object write and the streamed download are not, because the
  local queue does not deliver a published body intact. This needs an environment whose queue
  does. It is named in `missing-external-proofs.md`.
- **`commit_mutation` still discards its batch error**, so any future D1 fault on a mutation route
  reports `409 conflict`. Fixing that means deciding what such a route should say, which is a
  contract question, not a bug fix. Recorded, not done.
- **Only the data job types are dispatched.** `automation.*` and `webhook.deliver` envelopes share
  the table and are skipped by the sweep, deliberately, so this cannot double-deliver work their
  own subsystems already publish. Whether they have producers of their own is outside what this
  campaign established.
