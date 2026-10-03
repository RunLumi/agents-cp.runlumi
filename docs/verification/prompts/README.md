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
6. `verify-05-whole-site-and-release-security.md`

`verify-05` is the **whole-site, security-first release gate**. Run it when the question is "can we ship
this", as opposed to "is this subsystem sound". It differs from `verify-04` in three ways: security is a
**gate** rather than a section, so an unproven Tier-0 claim stops the run before any UI verdict; it
requires **every** feature area and **every** `docs/screens/**` reference to be visited or credited,
rather than a representative slice; and it opens with the deployed WebAuthn configuration, which the
earlier campaigns could only exercise on localhost.

`repair-findings.md` is for queued/backlog findings or a dedicated repair pass. The normal verification prompts should **fix verified defects immediately after preserving the failing evidence**, then re-run the relevant proof and continue.

## Discipline

A verifier must:

- derive obligations from specs/contracts before trusting handoffs;
- prefer executable checks over LLM judgment;
- distinguish PASS from UNPROVEN;
- never weaken a verifier/spec/contract to make code pass;
- preserve failing evidence before editing code;
- fix discovered implementation/test/infrastructure defects when the root cause is clear and within scope;
- add or strengthen regression evidence for every meaningful fix;
- re-run the original reproducer and affected proof obligations before continuing;
- explicitly name external claims it cannot exercise.

Output is an evidence record, not persuasive prose.
