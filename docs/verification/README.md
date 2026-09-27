# Verification System

Status: authoritative post-implementation verification contract

## Purpose

Implementation evidence answers **what the implementation process did**.

Verification answers the harder question:

> **What can an independent verifier actually prove about the system?**

A green build, large test count, handoff, or agent saying "done" is not sufficient. In an AI-heavy SDLC, the dangerous failure mode is **correlated error**: the same mistaken assumption can appear in the implementation, fixture, test, and completion report.

This directory exists to break that correlation.

## Core rule

> No claim without a proof obligation. No PASS without reproducible evidence. No critical invariant is trusted until a verifier has tried to break it.

Verification is an **autonomous closed loop**, not a read-only audit:

```text
verify
→ reproduce failure
→ preserve failing evidence
→ diagnose root cause
→ fix the smallest coherent cause
→ add/strengthen regression evidence
→ re-run the original reproducer
→ re-run affected proof obligations
→ mutation/fault-test the verifier when critical
→ continue verification
```

The default is to fix issues as they are discovered. Separation between verification and repair means **evidence and requirements remain independent**, not that a verifier must stop after writing a bug report.

## Authority

```text
AGENTS.md
  ↓
docs/specs/              what must be true
docs/adr/                why durable choices exist
docs/contracts/          shared protocol contracts
docs/implementation/     implementation graph + implementer evidence
docs/verification/       independent proof + attack + repair system
```

Verification does not silently change specs/contracts to make implementation pass.

## Verdicts

Use only:

- **PASS** — proof obligation satisfied
- **FAIL** — evidence contradicts the claim
- **UNPROVEN** — evidence is insufficient
- **BLOCKED** — verification cannot run because of a named dependency
- **NOT_APPLICABLE** — demonstrably outside scope

Never turn UNPROVEN into PASS for security, tenant isolation, authentication, data loss, budgets, or compatibility.

## Proof levels

| Level | Meaning | Typical evidence |
|---|---|---|
| V0 | Documentary | requirement/ADR/contract traceability |
| V1 | Static | typecheck, lint, compile, schema shape |
| V2 | Isolated behavior | unit/property/component test |
| V3 | Runtime integration | real router/Worker/D1/browser boundary |
| V4 | Adversarial | tenant substitution, replay, races, mutation/fault injection |
| V5 | Operational/external | rollback, canary, observability, real external consumer |

Tier-0 invariants normally require **V3 + V4**. V2 supports the proof but does not replace it.

## Independence protocol

A verifier should:

1. Read relevant specs, ADRs, contracts and this directory.
2. Derive expected behavior and failure modes **before** reading implementation handoffs/evidence.
3. Build a claim-evidence matrix.
4. Inspect implementation only after proof obligations exist.
5. Run the narrowest deterministic checks.
6. Cross production-like boundaries.
7. Attack the highest-risk assumptions.
8. Verify important tests can actually fail via targeted mutation/fault injection.
9. Read existing implementation evidence last and reconcile differences.
10. When a defect is found, record the failing evidence before changing code, then repair and re-verify it.
11. Continue until the claim is proven, explicitly FAIL/UNPROVEN/BLOCKED, or a real stop condition is reached.
12. Record PASS/FAIL/UNPROVEN/BLOCKED/N/A with exact evidence.

This ordering is intentional: reading implementer evidence first anchors the verifier to the implementer's model.

## Good evidence

Evidence should be:

- rerunnable;
- tied to a requirement/invariant;
- minimal enough to explain failure;
- generated against the real implementation surface where practical;
- explicit about commit SHA, environment, fixture/version/seed;
- redacted without destroying the property being proven.

Bad evidence includes:

- test counts without named proof;
- mock-only authorization tests claiming runtime isolation;
- screenshots claiming backend behavior;
- "the code looks correct";
- regenerated fixtures that merely mirror implementation;
- a verifier weakened until the implementation passes.

## Deterministic facts stay deterministic

Use executable assertions for auth, authorization, tenancy, budgets, idempotency, state transitions, migrations, contracts, policy, secret redaction, and retry/fallback boundaries.

LLM graders may help with ambiguous UX/semantic quality. They must not be authority for deterministic security or financial properties.

## Test the tests

For Tier-0/Tier-1 invariants ask:

> If the implementation were wrong in the obvious dangerous way, would our verifier fail?

Use targeted mutation/fault injection in a disposable worktree, e.g.:

- bypass one ownership check;
- accept a consumed auth ceremony;
- move budget denial after upstream dispatch;
- allow fallback after streamed output;
- bypass idempotency;
- remove a D1 constraint;
- allow sensitive telemetry content.

The mutation must be killed by the expected verifier **for the intended reason**.

Do not optimize for a broad mutation percentage. Target load-bearing invariants.

## Cadence

### PR
Fast deterministic checks plus proof obligations touched by the change.

### Main/nightly
Runtime integration, contract/provider checks, concurrency/property tests, bounded mutation campaigns.

### Release
Full `release-gate.md`: browser, migration, rollback, external compatibility, operational proof, unresolved-proof review.

### Production
Convert incidents/near misses/representative traces into regression capsules. Telemetry is a source of tests, not a substitute for tests.

## Start here

1. `plan00-verification-system.md`
2. `contracts/core-invariants-v1.yaml`
3. `prompts/verify-00-independent-reconstruction.md`
4. focused adversarial/runtime/mutation prompts, fixing verified defects along the way
5. `prompts/repair-findings.md` for queued/backlog findings or a dedicated repair pass
6. `release-gate.md`

## References

- NIST SSDF — https://csrc.nist.gov/pubs/sp/800/218/final
- OWASP ASVS — https://owasp.org/projects/asvs
- Pact — https://docs.pact.io/
- Cloudflare Workers testing — https://developers.cloudflare.com/workers/testing/
- Playwright accessibility — https://playwright.dev/docs/accessibility-testing
- cargo-mutants — https://mutants.rs/
