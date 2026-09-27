# /goal — V04 Release Verification and Closure

## Mission

Produce release decision from independent evidence, not implementation status. This is an **iterative closure loop**: repair repository defects that are clear and in scope, re-run their proofs, and keep going until the candidate is genuinely PASS or a real FAIL/UNPROVEN condition remains.

## Work

1. Re-run deterministic baseline from clean checkout.
2. Confirm every Tier-0 claim PASS.
3. Map every P0 acceptance criterion to evidence.
4. Re-run repaired/high-risk runtime and adversarial proofs.
5. Confirm representative mutants are killed.
6. Verify fresh + upgrade migrations.
7. Verify browser-critical flows.
8. Verify trace/redaction/failure behavior.
9. Verify actual desktop/client compatibility when required.
10. Review all FAIL/UNPROVEN/BLOCKED claims.
11. For each repairable repository FAIL, preserve its evidence, fix the root cause, add/strengthen regression proof, and re-run the original reproducer plus affected gates.
12. Repeat until no further in-scope repairable failures remain.
13. Record accepted residual risks explicitly.
14. Produce release verdict.

## Evidence hierarchy

Prefer:

1. production-like runtime evidence;
2. deterministic integration/adversarial test;
3. property/unit/component;
4. static analysis;
5. code review;
6. implementation narrative.

Lower layers cannot overrule contradictory higher-layer evidence.

## Verdict

Use only:

- **PASS**
- **FAIL**
- **UNPROVEN**

Do not invent a numeric quality score.

## Release repair rule

Do not stop merely because verification found bugs. Bugs found and correctly repaired are evidence that the verification loop is working.

Stop only when:

- a requirement/contract must change and needs deliberate approval;
- a required external system/consumer cannot be exercised;
- a safety-critical proof remains genuinely unavailable;
- the remaining defect cannot be repaired within the authorized repository/scope;
- continued repair would hide or broaden the original problem rather than solve it.

## Finding closure

A repaired finding closes only when:

- original reproducer no longer reproduces;
- regression test/probe exists at the right layer;
- affected proof obligations pass;
- no spec/contract was silently weakened;
- mutation/fault proof is updated when needed;
- broader release gate remains green.

## Final record

Include commit, environment, verdict, Tier-0 summary, unresolved findings, external unknowns, migration/rollback, browser/runtime, mutation sample, evidence paths, and limitations.

End by answering:

> **What important thing do we still not know?**
