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

Read the [runtime proof catalog and verifier lessons](runtime-proofs.md) before choosing runtime gates or writing/changing probes and mutation harnesses. It retains command prerequisites, historical blockers, and known false-verdict failure modes; its recorded PASS counts require fresh verification against the current head and environment.

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

## Evaluating agent guidance and workflows

Use this protocol when claiming that a prompt, skill, tool description, or agent workflow improves task quality, cost, or latency. Routine clarification and document relocation can be validated by consistency, discoverability, and preservation checks; they do not by themselves prove better agent performance.

1. Define one objective, the permitted edit surface, representative tasks, and the quality floor before tuning. Use redacted real defects/review feedback plus ordinary tasks and relevant hard cases; do not sample only failures of the current model. Follow retention and privacy rules when using traces.
2. Freeze task inputs, checkable expected outcomes/rubric, runner, and baseline revision/configuration. Grade deterministic invariants with executable checks. For subjective quality, calibrate a grader on reviewed examples, check that identical outputs receive consistent verdicts, and blind/randomize baseline-vs-candidate order. The producing agent's own completion report is not an independent grade.
3. Split tuning cases from independent validation cases before editing. The optimizer may inspect tuning traces; keep validation answers/traces out of its prompts, tools, and tuning workspace. If isolation is unavailable or cases have already been inspected, disclose that limitation and leave the generalization claim UNPROVEN. Do not turn individual failure text or reference answers into instructions.
4. Run baseline and candidate in fresh, equivalent environments with pinned model/harness settings and separate state. Vary one causal change at a time. Record per-case results, errors, elapsed time, and token/cost metrics when available. Diagnose timeouts, truncated output, stale artifacts, and grader defects separately from task failures.
5. For stochastic scores, repeat enough to distinguish a meaningful gain from measured variation; report cases, repetitions, uncertainty, and missing metrics. A gain on tuning cases alone does not justify adoption. Keep a candidate only when independent validation meets the objective and the quality floor; undo only the candidate's own edits if it regresses. Stop tuning when gains cannot be distinguished from noise and investigate the remaining failures.

If a case or grader contradicts an authoritative requirement, preserve the original failure and justify its repair from that requirement, version the evaluation, and rerun both baseline and candidate. Never relax security/financial gates or add artificial failures to create scoring headroom. Require a fresh independent set before claiming generalization after validation cases influence further tuning.

Store the objective, case/rubric versions, split and isolation method, baseline/candidate SHAs or patch fingerprints, model/harness configuration, redacted per-case evidence, decision, and limitations in the relevant verification run or engineering-practice review. No benchmark gain is a substitute for the product's required runtime and security proofs.

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

## Runs

`runs/` holds one directory per campaign: a verification-run record, a claim-evidence matrix,
the list of external proofs still owed, ordered next actions, findings, and the exact evidence
the verdicts rest on. Each run is pinned to a commit SHA, so a PASS can be re-derived rather
than inherited.

Read the most recent run's `verification-run.md` before starting a new campaign: it is the
baseline to attack, not a summary to agree with.

| Run | Commit | Verdict |
|---|---|---|
| [`2026-09-27-v00-independent-reconstruction`](runs/2026-09-27-v00-independent-reconstruction/verification-run.md) | `ecbdac1` → `ece860b` | **FAIL → repaired.** At `ecbdac1`: passkey ceremonies panicked on the Worker runtime and self-service onboarding was blocked. All seven findings are now closed — see [`repair-closure.md`](runs/2026-09-27-v00-independent-reconstruction/repair-closure.md). No Tier-0 or Tier-1 claim remains FAIL. |


A run may carry a `repair-closure.md`. It is the post-repair half of that run: what each finding
became, the evidence that moved each verdict, and any **verifier** defects found while repairing.
Read it after the run record, not instead of it — the run record's "before" tables are deliberately
left intact, because a verification record that silently rewrites its own baseline is not a record
of anything. The verdict table to quote is always the post-repair one.

## References

- NIST SSDF — https://csrc.nist.gov/pubs/sp/800/218/final
- OWASP ASVS — https://owasp.org/projects/asvs
- Pact — https://docs.pact.io/
- Cloudflare Workers testing — https://developers.cloudflare.com/workers/testing/
- Playwright accessibility — https://playwright.dev/docs/accessibility-testing
- cargo-mutants — https://mutants.rs/
