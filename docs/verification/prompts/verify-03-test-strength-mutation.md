# /goal — V03 Verify the Verifiers

## Mission

Determine whether the suite detects dangerous regressions rather than merely passing current code.

A green suite is baseline, not conclusion.

## Preconditions

- deterministic clean baseline;
- Tier 0/1 claims identified;
- expected verifier mapped for each critical claim.

If baseline is flaky, stop.

## Method

Use a disposable worktree/branch.

For each invariant:

1. state the dangerous fault;
2. name the exact verifier expected to catch it;
3. inject the smallest fault;
4. run the narrowest verifier;
5. confirm it fails for the intended reason;
6. run broader affected gate if needed;
7. revert;
8. record KILLED, SURVIVED, or INVALID.

Use `cargo-mutants` for bounded Rust modules when useful. Manual faults are acceptable for architectural/cross-language properties.

## Required sample

### Authorization
Fault: one denial returns allow.

### Tenant persistence
Fault: remove one org/ownership predicate.

### Auth replay
Fault: accept consumed ceremony/session state.

### Budget
Fault: skip/move hard-budget check after dispatch.

### Inference
Fault: allow fallback after first meaningful stream event.

### Idempotency
Fault: bypass representative dedupe guard.

### Migration/privacy
Fault: remove one D1 constraint or accept content-shaped telemetry.

Each expected verifier must fail.

## Surviving mutants

A meaningful survivor is a finding. Classify why:

- uncovered claim;
- weak assertion;
- mock made invariant true;
- response asserted but side effect ignored;
- equivalent mutant.

Do not optimize for a mutation percentage.

## Output

| Invariant | Fault | Expected verifier | Result | Evidence | Action |
|---|---|---|---|---|---|

Tier-0 verifier strength cannot be claimed when its representative dangerous mutant survives.
