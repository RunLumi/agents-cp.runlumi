# V04-003 — a gate's failure report could not run, so its blocker was never measured

**Severity: MEDIUM. A harness defect, and the reason a real product defect (V04-002) hid behind an
assumed environmental blocker for an entire campaign. Repaired.**

## The defect

`apps/api/scripts/p06-data-smoke.mjs:139`, inside the `catch` that reports the environmental
blocker:

```js
} catch (error) {
  ...
  stopServices();          // <-- ReferenceError
  console.log(`BLOCKED: the export was created and durably enqueued, but ...`);
  ...
}
```

`stopServices` is a method on the harness, not a free function. The bare call threw
`ReferenceError: stopServices is not defined` **from inside the error handler**, so:

1. the `BLOCKED:` message never printed;
2. the envelope and outbox diagnostics that follow it never printed;
3. the gate still exited **2**, which is the same exit code the intended BLOCKED report would have
   produced.

**The gate therefore looked exactly the same whether the blocker was real or imagined.** For as long
as this branch has existed, `smoke:p06`'s recorded reason has been an assumption.

## Why this is worse than a missing message

A gate that cannot print its own failure reason cannot be used as evidence *about anything* — not
about the product and not about the environment. The recorded claim was:

> "the local queue simulator did not hand the job to the consumer in a form it could read, so the R2
> leg of VI-DATA-001 cannot be decided here"

That reads as a careful, specific, measured environmental finding. It was a sentence written inside a
branch that had never executed. It was carried through the V01 campaign, the V02 campaign, and
`AGENTS.md`, where it is cited as the reason a release-gate row is BLOCKED — **on the authority of a
code path that had never run.**

This is the sharpest instance of a pattern this repository already knows: *a verdict with no cause is
the same failure as a verdict with no evidence.* Here it is worse, because the cause was not missing
— it was **stale and specific**, and specific reads as measured.

## The repair and the evidence it produced

```js
probe.stopServices();
```

With the report able to run, the gate immediately produced a diagnostic nobody had ever seen, and that
diagnostic is what exposed V04-002:

```
BLOCKED: the export was created and durably enqueued, but the local queue ...
  envelope  [{"job_type":"export.run","state":"queued","attempt":1}]
  outbox    [{"event_type":"export.requested.v1","delivery_status":"delivered"}]
  the export job reaches a terminal state did not reach the expected state within 120000ms;
  last rows: [{"state":"requested","attempt":0,"failure_code":null}]
27/27 P06 data-governance cases hold, 1 leg blocked by the environment
```

Note the shape of the gate's own summary: **27/27 cases hold, 1 leg blocked**. It is honest about its
own coverage. The problem was never the gate's reasoning — it was that its one report of trouble
could not execute.

## The general lesson, and the check it implies

**A gate's failure path needs the same evidence as its success path.** A success path that is never
exercised is an assumption; so is a failure path. Nothing in `pnpm check`, in CI, or in a recorded
baseline can distinguish a gate whose BLOCKED branch works from one that throws on line 1 of its own
error handler — both produce exit 2 and a plausible line in a findings table.

Two cheap properties would have caught it, and neither exists today:

1. **the failure path must be executed at least once** — the V01 campaign already has a mechanism for
   this shape (`guard:probe`'s sentinel suite proves a refusal is recognised as a refusal rather than
   a store outage), and the same idea applies to a probe's own BLOCKED branch;
2. **no bare identifier may be called that is not in scope** — `node --check` cannot see a
   `ReferenceError` of this kind any more than it can see a temporal-dead-zone use, and the failure
   only appears on the one path that never ran.

Neither is implemented. Recording that as a gap is the honest outcome; the repair above fixes this
instance, not the class.
