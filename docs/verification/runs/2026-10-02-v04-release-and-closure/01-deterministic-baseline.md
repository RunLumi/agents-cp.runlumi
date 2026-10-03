# V04 work item 1 — the deterministic baseline

**Verdict: PASS.** Ten steps, ten exits 0, and each step verified to have *done work* rather than
returning a cached success.

```
  pnpm check (format, lint, typecheck, test, rust) exit=0  17s   119 KB of output
  pnpm build                                     exit=0  12s
  rust WASM check                                exit=0   0s   (cargo fingerprint cache — content-keyed)
  schema bind count                              exit=0   1s   463 prepare() calls, every bind matches
  fresh D1 migration ledger                      exit=0   1s   head 0022 applied, 22 files
  P08 schema invariants                          exit=0   1s   passed: 17  failed: 0
  upgrade path over POPULATED tables             exit=0  67s   (the one that matters: zero-row gates
                                                              are how `teams` stayed unwritable
                                                              while all of them were green)
  restore rejects invalid writes                 exit=0   8s   6/6 rehearsal
  mutation campaign self-test                    exit=0   0s   12/12 verdict-parsing cases
  mutation campaign preflight                    exit=0   0s   13/13 faults still apply to the source
```

## Why a "0s" step is not automatically a pass here

Four steps finished in about a second, and an instrument that did not run is UNMEASURED rather than a
measured zero. Each was opened and checked:

- **rust WASM check, 0s** — cargo's fingerprint cache is content-keyed, so a cache hit *is* the
  proof that this content builds for the WASM target. Legitimate, and stated rather than assumed.
- **schema bind count, 1s** — printed `463 prepare() call(s)` and `every prepare() call binds exactly
  as many values as its SQL has placeholders`. The instrument ran.
- **P08 invariants, 1s** — printed `passed: 17  failed: 0`, including `refused a telemetry reason that
  is free text`. The instrument ran.
- **campaign self-test, 0s** — printed `12/12 verdict-parsing cases hold (parser only; no probe was
  executed)`. The instrument ran, and **it says so**: a parser self-test that ran no probe is
  labelled that way rather than being free to read as a probe result.
- **campaign preflight, 0s** — printed `13/13 cases have a fault that still applies to the source`,
  naming each fault's occurrence count in the file it targets. The instrument ran.

## The one line that looks like a failure and is not

`verify:restore` prints `suite reported 123/125; failing: revoking a key without a reason is refused,
a blocked install without a reason is refused` — and exits **0**.

That is a **deliberate fault injection inside the gate**, and the exit code is correct. Read in
order:

- step 4, the clean path: `the RESTORED database still refuses every invalid write — 125/125`
- step 6, the sensitivity question: `a restore missing a trigger is DETECTED`, and dropping one
  trigger drops the suite to 123/125 with **exactly the two checks that depend on that trigger**

So the 123/125 is the **positive control**: a restore that lost a trigger is caught, and named. A gate
that printed 123/125 and exited 0 *without* that step would be a gate reporting failures as success,
and the difference between those two readings is the whole reason this step was read rather than
skimmed.

## What this step does and does not establish

**Establishes:** the pinned candidate's repository gate, build, WASM target, schema invariants, the
**populated-table** upgrade path, and the restore refusal are all green, and the restore gate is
demonstrably able to detect a lossy restore.

**Does not establish:** anything about a P0 acceptance criterion, a Tier-0 claim, the browser, or
adversarial behaviour. All ten steps are V1/V2-class evidence (static and schema-shaped) plus one
V3 migration proof. `pnpm check` cannot reach a running Worker, by construction.
