# /goal — Repair Verified Findings

## Mission

Fix verified defects without weakening the contract or hiding the evidence that found them.

## Loop

For each accepted finding:

1. reproduce unchanged;
2. reduce to smallest failing boundary;
3. classify root cause:
   - implementation;
   - spec;
   - contract;
   - verifier;
   - migration/data;
   - environment/tooling;
4. identify the false load-bearing assumption;
5. fix cause with the smallest coherent change;
6. add/strengthen regression evidence at the cheapest correct layer;
7. re-run original reproducer;
8. re-run affected proof obligations;
9. re-run broader checks in the dependency cone;
10. if verifier was weak, run targeted mutation/fault proof;
11. record before/after evidence.

## Rules

- Do not edit spec/frozen contract merely because implementation is expensive to fix.
- Genuine requirement change uses the deliberate change process.
- Do not make security tests pass by changing expected errors without contract change.
- Do not suppress errors that must remain visible.
- Do not broaden retries to hide reliability failures.
- Do not add mocks that bypass the failed production boundary.
- Do not mix unrelated cleanup.

## Regression capsule

Preserve:

- minimal input/state;
- expected result;
- previous wrong result;
- root cause;
- fix commit;
- verifier path;
- affected invariant IDs.

Repair is complete only when independent verification can close the finding.
