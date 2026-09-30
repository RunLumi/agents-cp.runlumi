# V01-045 — `security::repository_liveness` enforced one direction of staleness, and it was the wrong one

**Severity: MEDIUM (verifier) · Status: CLOSED · Class: verifier weakness, found by reading the check the class it belongs to**

## The defect

`security::repository_liveness` exists because four capabilities were built completely and wired to
nothing (V01-041, V01-042, V01-043, and the support-grant case behind V01-040). Its list,
`REVIEWED_UNCALLED`, is a decision record: every `pub` repository function must have a non-test
caller, or appear on the list with a reason.

It enforced **one** staleness rule:

> an entry naming a function that no longer **exists** is refused

and it enforced it explicitly, because a previous version computed the stale set and asserted
nothing about it.

It enforced **no** rule for the other direction — an entry whose function has since been **called** —
and that is the direction that produces a false assurance rather than a stale footnote.

## What the gap hid

Four entries, the statement twins of findings this same campaign had just closed:

| entry | wired by |
|---|---|
| `deny_enrollment_statement` | V01-041 (device-enrollment denial) |
| `insert_quarantine_statement` | V01-043 (plugin quarantine lever) |
| `lift_quarantine_statement` | V01-043 |
| `list_quarantines` | V01-043 |

All four sat labelled `UNTRIAGED` — which asserts *"this function is unreviewed"* — while being called
from routes. They became wired in the very commits that recorded the findings, and the check that
exists to catch exactly this said nothing, because it only ever asked whether a listed name still
existed.

**An exclusion for a function that is now called is worse than no exclusion.** It records "examined
and accepted" for something nobody examined, and it hides the *next* genuine finding: a reader has
already seen the name on the list and will not re-derive that it is unreviewed. A list that reads as
complete is a stronger false signal than one that reads as incomplete.

## The rule is narrower than "is it called", and the first attempt was wrong

My first version of the new assertion flagged **any** listed function that is called. That is
incorrect, and it would have converted the check into "the list must be empty":

`deny_enrollment` carries the reason *"V01-041, now called: POST .../enrollments/{id}/deny"*. That is
a **record** — the finding, the fix, and the route that closed it. Deleting it would erase why the
class found anything at all, and the list's own header says these entries are how a name becomes a
decision.

The distinction is not *is the function called* but **what its reason says**. A resolved entry records
a fix; a live exclusion justifies an absence. So the assertion is on entries whose reason is still a
justification — concretely, `UNTRIAGED` — **and** whose function is called:

```rust
REVIEWED_UNCALLED
    .iter()
    .filter(|(name, reason)| called.contains(*name) && reason.trim() == "UNTRIAGED")
```

It found exactly the four, and they are now labelled with the route that resolved them, beside their
already-recorded handler twins.

## Two harness faults, both caught by guards rather than by reasoning

**M4's mutation matched a prefix.** The regex spanned a multi-line tuple, but the entry is
single-line, so it replaced the opening of the entry and appended a stray fragment. The file still
compiled, the test still passed, and the case reported **MISSED** — a verdict about a mutation that
never happened. The fix: anchor on the whole tuple, assert the name appears exactly once with the
new reason, and **re-check the effect from outside the mutation**, because `cmp` only proves bytes
changed and a mis-anchored edit satisfies that too.

**M4's verifier could not run.** The effect check was a `python3 -c` whose regex contained `\n`; the
shell expands backslash escapes inside a double-quoted `-c` argument, so it became a **real newline
inside a Python string literal** and died with a `SyntaxError`. M4's mutation and M4's verifier were
failing for two different quoting reasons inside the same case. Written as a heredoc now.

That second fault is the one worth generalising: **a verifier that cannot run cannot report**, and it
must be distinguished from a verifier that ran and said MISSED. The first is a harness fault, the
second is a finding.

## Sensitivity

`evidence/v01-liveness-reverse-rule-sensitivity.sh` — **M4 DETECTED, M5 a declared KNOWN MISSED,
restored tree green.**

- **M4** relabels a resolved entry back to `UNTRIAGED` while its function *is* called: the exact
  shape the rule exists to catch, and how the gap arose. **DETECTED.**
- **M5** deletes the assertion entirely, restoring the original one-direction check. **MISSED, and
  declared**: no self-contained assertion can detect its own removal. Recording it is more useful
  than a mutation that appears to pass.

The mutation is additive. In a statically linked language, removing a function's only caller almost
always fails to compile, so such a mutation measures the compiler rather than the check — and adding
an unwired capability is also the historical shape of all four findings in this class.

## Regression proof

`cargo test --workspace repository_liveness` passes; `pnpm check` exit 0, **1030 tests**.

## The lesson

**A check that describes a rule it does not enforce is worse than one that omits it, because a reader
trusts the prose.** This check enforced the "gone" direction loudly, in a comment explaining why the
first version had to assert rather than merely document — and the "now called" direction was absent
from the prose entirely, so nobody looked for it. The four entries it hid were closed findings from
**this same campaign**, which is the strongest possible evidence that a check's coverage is not
implied by the class of defect it was built for.
