# /goal — V00 Independent Reconstruction

## Mission

Reconstruct what the completed repository must prove without inheriting implementer assumptions.

Do not begin with `docs/implementation/gates/**`, handoffs, STATUS, or test counts.

This phase is primarily reconstruction, but if you discover a clear defect in the **verification infrastructure itself** (broken command, stale fixture, non-rerunnable probe, invalid harness setup) and fixing it does not change product requirements, preserve the failure and repair it immediately before continuing.

## Read first

- `AGENTS.md`
- `docs/specs/**`
- relevant `docs/adr/**`
- `docs/contracts/**`
- `docs/verification/**`
- `DESIGN.md` + relevant screens for UI

## Work

1. Enumerate implemented feature areas and applicable acceptance criteria.
2. Convert them to falsifiable claims.
3. Classify Tier 0-3.
4. List dangerous plausible failure modes for Tier 0/1.
5. Assign minimum V0-V5 proof.
6. Pick the cheapest verifier capable of falsifying each claim.
7. Mark claims requiring real Worker, browser, desktop, or provider environment.
8. Only now inspect implementation tests/handoffs/gates.
9. Map evidence without force-fitting.
10. Repair clear verification-infrastructure defects discovered while building/running the matrix, preserving before/after evidence.
11. Verdict each claim PASS/FAIL/UNPROVEN/BLOCKED/N/A.

## For every PASS candidate ask

- Could implementation and test share the same wrong assumption?
- Does the verifier cross the claimed security/runtime boundary?
- Could a mock make the property true by construction?
- Does it prove side effects or only response shape?
- What happens on tenant substitution, replay, retry, race, stale state, timeout, partial failure?
- What evidence would make this claim false?

## Output

Create:

- a verification-run record;
- a claim-evidence matrix;
- list of missing external proofs;
- ordered next verification actions.

## Stop conditions

Never invent PASS when:

- external consumer unavailable;
- browser not actually exercised;
- authorization mocked away;
- runtime/provider behavior inferred from pure domain code;
- migration inferred without applying it;
- requirement ambiguity materially changes behavior.
