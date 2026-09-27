# /goal — V04 Release Verification and Closure

## Mission

Produce release decision from independent evidence, not implementation status.

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
10. Review all UNPROVEN/BLOCKED claims.
11. Record accepted residual risks explicitly.
12. Produce release verdict.

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
