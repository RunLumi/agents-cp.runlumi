# V04-002 — the queue path could not construct the Worker at all

**Severity: HIGH. A real product defect, found by re-running a gate whose blocker had been assumed
rather than measured. Repaired; root cause confirmed by the fix changing the measured outcome.**

## The defect

`apps/api/sentry-entry.mjs:50` (pre-fix):

```js
async queue(batch, env) {
  return new RustWorker(undefined, env).queue(batch);
}
```

`WorkerEntrypoint` is imported from `cloudflare:workers`, and workerd's constructor **requires
parameter 1 to be an Object**. The handler passed a literal `undefined`, so the first real queue
message threw:

```
TypeError: Failed to construct 'WorkerEntrypoint': constructor parameter 1 is not of type 'Object'.
```

The two sibling handlers both pass `ctx`, which is why only the queue path failed:

```js
async fetch(request, env, ctx)     { return new RustWorker(ctx, env).fetch(request); }
async scheduled(event, env, ctx)    { return new RustWorker(ctx, env).scheduled(event); }
```

It is an **uncaught async exception**, so it takes down the isolate handling the batch.

## Why the stack blamed Sentry, and why that was a red herring

Every visible frame was inside the bundled `sentry-entry.js`, inside `@sentry/cloudflare`'s
`wrapQueueHandler` — so the first reading was "the observability SDK is crashing". It is not. The
throw originates in this repository's own handler, which Sentry merely wraps:

```
at Object.apply (.../sentry-entry.js:19650)      <- Sentry's wrapper calling our handler
at new S (.../sentry-entry.js:22128)
    TypeError: Failed to construct 'WorkerEntrypoint': constructor parameter 1 is not of type 'Object'
```

**A stack that names a third-party dependency is a claim about that dependency, not a conclusion.**
The frames had to be read to the frame that constructs the object, and that frame is the queue
handler above.

## Why it survived an entire adversarial campaign

`verify:webhook-fanout` passes, and it exercises outbox routing — so it looks like the async path is
covered. It is not: that gate asserts on `outbox_events` rows and replays over HTTP. **`smoke:p06` is
the only probe that publishes a job and waits for the queue to deliver it**, and it was recorded as
BLOCKED for an environment reason. Every other async gate asserts the *row*, never the *delivery*.

So: a 2xx-behaving queue path, a passing webhook gate, and a data-governance gate blamed on the
environment. Nothing in the suite could see this.

## Evidence: the fix changed the measured outcome

Same probe, same fixture, one-line change, three separate measurements:

| | pre-fix | post-fix |
|---|---|---|
| `WorkerEntrypoint` errors in the Worker log | **11** | **0** |
| outbox consumer `{"action":"published"}` lines | 0 | **8** |
| outbox consumer `{"action":"delivered"}` lines | 0 | **8** |
| `p06_queue_routed:outbox` / `:jobs` consumer diagnostics | never appeared | appeared |

This is the strongest available form of proof available here: the defect is gone, and a **consumer now
runs** where before the isolate died on the first message.

**CORRECTED, because the first version of this claim was too strong.** The eight `delivered` lines are
the **outbox** consumer's own audit lines — `delivery_status = 'delivered'` is written by
`modules/outbox/consumer.rs:108` calling `mark_delivered` — so they prove the *outbox* consumer handed
events to a queue. They do **not** prove that the **jobs** queue consumer delivered, and a later,
cleaner run of the same probe did not print `p06_queue_routed:jobs` at all. Local delivery to that
consumer is intermittent. A status code could not have shown any of this; a log count could.

## The repair

```js
// Cloudflare's ExportedHandler passes an ExecutionContext as the THIRD argument of `queue`.
async queue(batch, env, ctx) {
  return new RustWorker(ctx, env).queue(batch);
}
```

One parameter, forwarded exactly as the two sibling handlers already do. No ADR change: ADR 0009
records the decision to expose `fetch`/`queue`/`scheduled` through this entry and says nothing about
the context argument, so this is a repair to code that diverged from the ADR, not a change to it.

## What is still open, and is now measured rather than assumed

The export job **still** does not reach a terminal state. With the crash gone, the gate's own
diagnostics finally ran and report the real position:

```
envelope  [{"job_type":"export.run","state":"queued","attempt":1}]
outbox    [{"event_type":"export.requested.v1","delivery_status":"delivered"}]
export_jobs row: {"state":"requested","attempt":0,"failure_code":null}
```

So: the **outbox** queue delivers, and the **jobs** consumer is invoked (`p06_queue_routed:jobs`
appears) — but the `export.run` envelope is not advanced past `queued`. That is a **narrower** problem
than "the queue does not deliver", and it is the first time anyone has measured it.

**The R2 leg of VI-DATA-001 therefore remains BLOCKED — but the recorded reason was wrong.** It was
"the local queue simulator did not hand the job to the consumer in a form it could read". In fact
the consumer was handed nothing at all, because the Worker could not start. The true residual is
"the jobs consumer is invoked and the envelope does not advance", which is a different question and
belongs to whoever picks it up.

`AGENTS.md` carries the old explanation. **It is not edited here** — AGENTS.md is this repository's
operating contract, and the objective forbids editing a contract as a side effect of verification.
The correction is recorded here and the user should decide whether to amend it.
