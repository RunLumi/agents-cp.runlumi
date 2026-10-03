# V04-001 — the machine ran out of space, and the harness lost its own evidence

**Severity: harness defect, not a product finding. The two exit-2s it caused are recorded as
UNPROVEN, not as passes and not as failures.**

## What happened

The first adversarial run got through five gates and then two consecutive gates exited **2**:

```
bind-count          exit=0    0s
collection-tenancy  exit=0   23s     54/54 cases hold
filter-tenancy      exit=0   25s     65/65 cases hold, 9 skipped
path-id-tenancy     exit=2  114s     165 assertions passed, 0 failed, then it died
mutating-tenancy    exit=2  192s     1 assertion passed, 0 failed, then it died
```

Both logs name the same cause:

```
errno: -28, code: 'ENOSPC', syscall: 'write'
```

The **system** volume was 98% full with **326 MiB free**. `/tmp` and `~/.wrangler/logs` both live
there, and the harness wrote every per-gate log to `/tmp` while wrangler wrote its own state and logs
to the same volume.

## The second-order failure, and the part that matters

A machine restart then cleared `/tmp`, and **every per-gate log went with it** — including the two
that carried the ENOSPC. The five verdicts above survive only because they had already been read
into this record.

**A harness that loses its own evidence when the machine is under pressure cannot show what the
machine did.** That is the defect, and it is independent of the disk filling: even without the
restart, a full volume would have truncated the very logs needed to diagnose the fullness. The two
failures compound — the cause destroyed its own proof.

## Why the two exit-2s are UNPROVEN and not FAIL

The exit-2 discipline is doing exactly what it was built for. Both probes reported their partial
progress honestly (`165 assertion(s) passed and 0 failed before it died; every case after the failure
above was NEVER RUN`) rather than reporting a clean sheet from a truncated run. That wording is the
harness telling the truth about its own incompleteness, and it is why a reader can tell "the product
held for 165 assertions, then the machine stopped" apart from "the product held".

Neither is a detection, and neither is a pass. Both are re-run.

## The repair

All three runners write to `$REPO/target/v04-logs` (gitignored, on the repository volume, wiped by a
rebuild rather than by a machine restart), overridable with `V04_LOGDIR`.

`/tmp` is on the system volume, which is also where wrangler writes — and the repository volume is the
one this campaign **already** designates for scratch. The mutation campaign carries a standing
instruction to keep its ~2.4 GB per case off the system volume for exactly this reason; the log
destination was simply inconsistent with it. The fix is consistency, not a new idea.

## What this says about the release candidate, honestly

A machine at 98% with 326 MiB free is an **environment** fact, not a candidate defect, and the
release verdict must not carry it as either. But it is a real risk to the evidence:

- if it recurs, gates will exit 2 again and the correct response is still "UNPROVEN, re-run", never
  "the gate passed" and never "the product failed";
- the volume is shared with every other process on the host, so a full disk is a plausible
  recurrence during a long campaign, and a release decision that depended on a truncated run would
  be a decision about the truncation.

**Mitigation applied:** evidence now lands on a volume with 45 GiB free, and the runner records each
gate's own exit code separately so a partial run is legible rather than ambiguous.

## What was NOT established by the two dead gates

`verify:path-id-tenancy` (198 assertions across 18 one-path-id routes) and `verify:mutating-tenancy`
(the write half of tenant isolation) are **UNPROVEN in this campaign**. Both have recorded baselines
from the merged campaigns, and those records stand as what they are — evidence about the candidate at
that time — but a release decision must rest on this campaign's own run, so both are re-run here.
