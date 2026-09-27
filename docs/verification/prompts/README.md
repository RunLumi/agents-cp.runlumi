# Verification Prompt Library

These prompts are for **independent verification after implementation exists**.

They differ from `docs/prompts/goal-*.md`:

- implementation prompts optimize for creating;
- verification prompts optimize for disproving unjustified confidence.

## Recommended order

1. `verify-00-independent-reconstruction.md`
2. `verify-01-adversarial-security-state.md`
3. `verify-02-runtime-browser-operations.md`
4. `verify-03-test-strength-mutation.md`
5. `verify-04-release-and-repair.md`

Use `repair-findings.md` only after defects are recorded.

## Discipline

A verifier must:

- derive obligations from specs/contracts before trusting handoffs;
- prefer executable checks over LLM judgment;
- distinguish PASS from UNPROVEN;
- never weaken a verifier/spec/contract to make code pass;
- preserve failing evidence;
- explicitly name external claims it cannot exercise.

Output is an evidence record, not persuasive prose.
