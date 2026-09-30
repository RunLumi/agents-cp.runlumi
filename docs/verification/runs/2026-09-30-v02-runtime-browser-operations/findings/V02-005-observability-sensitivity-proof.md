# V02-005 — the observability gate, watched to fail

**Sensitivity proof for V02-004 · `evidence/v02-004-observability-sensitivity.sh` · Verdict: M1 DETECTED**

## The result

| | case | verdict |
|---|---|---|
| baseline | unmutated | exit 0 — 26 pass, 0 fail, **1 unmeasured** |
| **M1** | the `security_events` INSERT binds the wrong value into the `request_id` slot | **DETECTED** — exit 1, 24 pass, **2 fail**, 1 unmeasured |

The two failures were exactly the two security-event correlation legs:

```
FAIL  C1 LEG 'audit/security event': a security_events row carries THIS request's id
FAIL  C1: the security event names the operation, so the row is about this and not a coincidence
```

So the gate can tell the difference between "a security event was written" and "a security event was
written **about the request that caused it**" — which is the entire claim V02-004 makes, and which a
row-counting gate could not.

## The mutation, and why not an easier one

`apps/api/src/routes/support.rs` binds `received_at` (the line two below) into the `request_id`
slot: a copy-paste between two adjacent binds.

Two properties make it the right fault rather than a convenient one:

- **The bind count is unchanged**, so `pnpm schema:bind-count` stays green. That check is blind to
  this whole class — which is the point. A mutation it *could* see would not be testing the right
  thing.
- **Binding `correlation_id` instead would have been a weak mutation.** For this request
  `correlation_id == request_id` — the `http_request` log line shows them equal — so a probe
  searching on `request_id OR correlation_id`, which is exactly what the outbox leg does, would still
  have found the row and reported MISSED. **A mutation chosen because it is easy to apply is often a
  mutation that changes nothing.**

The row still **exists** after M1. It is not a missing-write fault, so a gate that counted rows
rather than following the id would be unaffected.

## The guard caught its own wrong assumption, twice, and that is the better half

**First INVALID — the artefact check looked in the wrong place.** The script verified the fault had
reached the Worker by looking for a wasm newer than the mutation under
`apps/api/.wrangler/tmp`. That directory is a **leftover cache**: it held several hundred `dev-*`
directories whose newest entry was **nine hours** older than the run, while
`apps/api/build/index_bg.wasm` carried the current minute. The dev log says plainly
`Running: worker-build --release`, and that is what writes `build/`.

The run reported **INVALID**, not MISSED. That distinction is the whole reason the guard was written
to refuse when it cannot *prove* arrival: a guard that assumed the restart rebuilt the Worker would
have reported MISSED for a fault that never arrived, and a MISSED is indistinguishable from "this
gate cannot detect the class". **It cost minutes rather than being filed as evidence.**

**Second INVALID — the same class, in the exit status.** The script's ending was
`grep MISSED → exit 1; else exit 0`, so the all-INVALID sheet **exited 0** — a clean success for a
run in which nothing was measured. I wrote that guard, and the script around it then reported
success anyway.

> **A guard is only as good as the exit status of the thing that reads it.**

INVALID now dominates MISSED, so a sheet containing an unmeasurable case cannot be filed as a
finding about the gate. Verified by extracting the real decision block from the script and running
it against three synthetic sheets — testing the script's own text, not a copy of it:

```
DETECTED               -> exit 0
MISSED                 -> exit 1
INVALID                -> exit 2
```

## Four more harness faults, all from writing this script

- **The repo root is five levels up, not four.** The script lives at
  `docs/verification/runs/<run>/evidence/`, so `../../../..` resolves to `docs/` — every path below it
  wrong, while the script still reported a run. A path error that produces a plausible-looking
  failure is worse than one that produces an error.
- **A separate `wrangler deploy --dry-run` build step doubled the run for no extra evidence.** It
  proved the source *compiles*, which is a different question from whether the binary `wrangler dev`
  is *serving* was rebuilt after the fault.
- **Rustc diagnostics are grepped from the dev log, not inferred from an exit code**, because cargo
  exits 101 for a failing assertion as well as for a compile error.
- **Restoring the source is not restoring the world.** `wrangler dev` keeps serving the binary it
  built, so a script that restores the file and exits leaves `pnpm dev` answering from faulted code —
  and every later gate in the session silently inherits a mutated product. That is the V01-046 shape:
  a restored file and a live fault quietly disagreeing, with nothing in the output to say so. The exit
  path now rebuilds from the restored source and waits for the Worker to answer, and says loudly if
  it cannot.

## A content hash would have been the wrong signal

Both `.wrangler/tmp` build directories serve the **same hash filename** for different content, so a
hash-based "did the served artefact change" check reports *no change* while the code changes
completely. mtime is the only signal that works here, and the run records which path it used.

## What the baseline's UNMEASURED was, and why it is correct

The baseline was 26 pass / 0 fail / **1 unmeasured** rather than 28/0/0. The unmeasured leg is
`request`/`response`: the `http_request` log line. It depends on a harness-supplied log location, and
the restart truncated the previous log, so the request id genuinely was not findable.

**That is the designed behaviour, not a regression.** A measurement that cannot be taken is reported
UNMEASURED and never as a pass — and it is the one place in V02-004 where a harness limitation can
be mistaken for product evidence if the discipline is not held.

## Verification state after the run

- `apps/api/src/routes/support.rs` restored: `cmp` against the snapshot **and** `git diff` both clean.
- **HEAD unmoved** (`11936dd`) — verified at exit, because a commit during a mutation run captures
  the fault permanently.
- The Worker was rebuilt from the restored source, and the stack was confirmed serving
  (`api=401`, which is the correct unauthenticated answer) before anything else was run.