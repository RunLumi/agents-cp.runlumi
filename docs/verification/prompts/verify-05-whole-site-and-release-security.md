# /goal — V05 Whole-Site Review and Release Security Gate

## Mission

Review the **entire shipped surface** — every web screen, every API surface, and every authentication
path — and issue a release decision. **Security comes first and is a gate, not a section.**

This is an *iterative closure loop*: repair what is clearly in scope, re-run the proof, and keep going
until the candidate is genuinely releasable or a real FAIL/UNPROVEN condition remains. A review that
only reports is half the job.

It exists because a completed campaign (`V04`) closed with **FAIL** and left two specific gaps that no
existing gate covers, both measured rather than assumed:

1. **Every WebAuthn ceremony ever verified ran on localhost.** Production declares
   `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` as `agents-cp.runlumi.app`. That pairing is exercised by
   **nothing** — not because a gate is missing, but because no gate can reach a public hostname.
   Authentication is a Tier-0 claim resting on a configuration real users do not have.
2. **The browser probe visits 4 URLs against 18 feature areas.** `org/{slug}`,
   `org/{slug}/models`, `org/{slug}/settings/data`, `org/{slug}/webhooks`. There are **12** screen
   references in `docs/screens/` and **zero** are compared. "The browser journey is green" is a
   statement about four panels.

## Order of work

Do not start at the UI. Work in this order, and do not reorder it for a prettier report.

### 1. WebAuthn in the deployed configuration

The surface is twelve routes in `apps/api/src/app.rs:140-175` and `:550-583`: signup, login, add,
re-auth, revoke/rename, plus the password paths that sit beside them.

Five ceremony kinds exist: `PasskeySignup`, `PasskeyLogin`, `PasskeyAdd`, `Reauthenticate`, and
**recovery**. Establish, with runtime evidence in the configuration that will actually ship:

- the **RP ID and accepted origins** are the deployed ones, not `localhost`;
- an **origin mismatch** and an **RP ID mismatch** are refused, and the refusal is distinguishable
  from a wrong credential;
- a **consumed ceremony cannot be replayed** for **all five** kinds. `smoke:passkey` covers
  registration and login; recovery's replay proof exists but was added late — confirm it still runs;
- the **signature counter** is checked, and a replay is refused as a *consumed ceremony* rather than
  for the wrong reason;
- **revocation** is immediate: a revoked passkey, session and device all stop authenticating, and the
  **anonymous** leg is asserted both before and after, because a revoked credential once existed;
- **step-up / re-auth** gates the operations that require it.

Then prove the configuration is **not silently wrong**. Two facts to check, both load-bearing:

- `WebAuthnConfig::new` (`adapters/webauthn.rs:38`) **fails loudly** on a missing or malformed
  `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS`.
- but `app.rs:75-109` constructs the two environments **differently**: `development` **defaults** to
  `localhost` / `http://localhost:5173`, while every other environment passes `Option<String>` through
  `.ok().map(WebAuthnAdapter::new)`.

So a production deployment missing those vars yields `state.webauthn = None` — **passkeys silently
disabled rather than a Worker that refuses to boot.** Determine and record which it is, and whether a
passkey route with no adapter answers something unambiguous. A control plane that answers "passkeys
unavailable" and a control plane that has silently forgotten them must not look the same.

If a public hostname is genuinely unreachable from the verification host, say so as a **measured
BLOCKED** with the cause, name exactly what could not be exercised, and **do not widen a probe's
reach to manufacture a result**. A red sheet from a probe that cannot reach the target is meaningless,
and the verdict and the early bail must live in separate statements so that widening can never delete
the line between "the product failed" and "the probe could not run".

### 2. Security gate — must pass before any UI verdict

This is a gate. If a Tier-0 claim is FAIL, UNPROVEN or BLOCKED, the run stops here and the UI review
becomes a note rather than the headline.

- **Tenant isolation** — for representative resources: seed two organizations, substitute every id
  class (project, device, credential, run, export, automation, policy, membership), and prove a
  foreign id is answered **identically** to one that exists nowhere.
- **Authentication and session integrity** — the ceremony work above, plus expiry, revocation, recovery,
  and identity-link conflict.
- **Secret non-disclosure** — absent from responses, logs, audit rows, outbox envelopes and traces.
  Grade on the **stored record**, never on the status code.
- **Budget enforcement** — hard denial **before** upstream dispatch; concurrency holds the ceiling;
  no fallback after committed output.
- **Destructive operations** — authorization **and** idempotency, evidenced on stored state.
- **Destructive authorization** — a refusal must not double as an existence oracle.

### 3. Capability reachability sweep

This is the class that produced three HIGH findings in `V04`, and it is cheap, so it is not optional.

For every guard, policy field, and read-path in the codebase, ask two questions — **not** "does this
exist?" but:

- **Is it consulted** on a real request path? A function that is *called* behind a condition that can
  never hold is dead: `is_run_source` and `version_at_least` at a consumed-ceremony site were both
  live calls that could never execute.
- **Can it be set?** A field that is parsed, stored and never consulted looks exactly like one that is
  enforced. A field no API accepts and no writer populates is a control nobody can operate.

Classify every finding by failure direction, because the direction decides the severity:

| shape | example | severity |
|---|---|---|
| **fail-open, inert** | a control that cannot be *armed* (minimum client version) | dangerous — a real bypass of a control that exists on paper |
| **fail-closed, unreachable** | a control that cannot be *reached* (browser-use policy behind a catalogue with no writer) | capability absent, not a breach |
| **fail-closed and settable** | a rejected unknown field (`deny_unknown_fields`) | correct behaviour; say so |

And separate **coverage gaps** from **capability gaps**. In `V04`, three of fifteen "unproven" rows
turned out to be missing capabilities and two more were implemented and merely *unlocated*.
**"Unproven" was partly a claim that the verifier had not looked.** Never record a row as unproven
without first answering *does a route exist that makes this reachable?*

### 4. Whole-site review

Enumerate the site before reviewing it. There are **18 feature areas** under `apps/web/src/features/`
(`account`, `adoption`, `auth`, `automations`, `billing`, `data-governance`, `devices`, `identity`,
`models`, `notifications`, `organizations`, `plugins`, `policy`, `projects`, `runs`, `tools`, `usage`,
`webhooks`) and **12** screen references in `docs/screens/`.

For **every** area, with a real browser: loading, empty, success, permission denied, server error,
retry/recovery, keyboard navigation, visible focus, narrow layout (390px), destructive confirmation,
and one-time secret lifecycle where one exists.

Then compare **every changed surface** against `DESIGN.md` and the matching `docs/screens/**`
reference. Open the images — reading filenames is not inspection. Twelve references exist and **none**
is currently compared.

Accessibility scanners are incomplete. Pair them with keyboard, focus and manual checks on critical
paths, and state which critical paths you actually walked.

### 5. Release verdict

Only after the above.

## Discipline that earns its keep

These are not stylistic preferences. Each one caught a false verdict in a completed campaign, and each
cost real time to learn.

- **Pair every negative assertion with a positive control** that proves the instrument can register a
  signal. The strongest available design: configure the allowlists **populated** and every toggle
  **off**, so an *unconsulted* field yields **allow**, not deny — and each denial is attributable to its
  own field.
- **A green control means nothing if it could be green without the case.** Assert the case under test
  appears **by name** in the control's output. A control reported `76/76` for a tree that did not
  contain the assertions being measured, and a mutant over that tree agreed — which produced a
  confident, wrong conclusion about a fourth defence.
- **Prove each gate you rely on can fail.** A green gate nobody has watched fail is an assumption. For
  a security gate, one targeted mutation per family, and the mutation must break **the claim**, not
  the statement: deleting a predicate that removes a bind makes D1 refuse the query, both probes answer
  `503`, and the mutant reads MISSED on a build that cannot execute the SQL.
- **A check that describes a rule it does not enforce is worse than one that omits it.** Anchor what
  you assert. Probes indent their result lines; wrangler prefixes compiler output with
  `[custom build] `. An over-tight anchor and a build failure both read as something else entirely.
- **Exit codes are load-bearing.** **1** = a check did not hold. **2** = the harness could not run.
  Collapsing them lets a broken probe read as a detected defect. A browser run with no browser exits
  **2**, never 0.
- **Restore with `cp` plus `touch`**, never `cp -p`: an mtime-preserving restore makes a build skip the
  rebuild and ship the fault while the sheet reads green. Trap `EXIT`, `INT`, `TERM` and `HUP`, and
  re-raise through `exit`. Check the tree against an independent reference (`git diff --quiet`) before
  snapshotting and after every restore — a snapshot taken with the fault already applied launders it
  into the baseline.
- **Let a long run finish.** Killing corrupts a harness's own restore discipline. A held port *hangs*
  rather than erroring, which is worse than a false exit 2 because nothing downstream is reached —
  check the port before starting, not after the run dies.

## Operating authority

Exercise senior judgment on routine calls without asking: which harness to use, which surface to attack
first, how to decompose a claim, where a regression check belongs, and whether a defect is worth
repairing now or recording as accepted residual risk.

That authority does **not** extend to: weakening a spec, requirement or existing verifier to obtain
green; replacing a real browser or Worker/D1 check with a mock or static markup; editing a frozen
contract outside the deliberate change process; or converting an UNPROVEN or BLOCKED claim into a
PASS. Those require the deliberate process regardless of delegation.

## Verdict discipline

Verdicts are **PASS**, **FAIL**, **UNPROVEN**, **BLOCKED**, **NOT_APPLICABLE**. Never turn UNPROVEN into
PASS for security, tenant isolation, authentication, data loss, budgets or compatibility. **BLOCKED**
means a measured environmental cause, not an unexamined gap. **NOT_APPLICABLE** means demonstrably out
of scope, and you must say why.

Grade on observable state and stored records, not status codes. A test count is telemetry, not proof;
every critical PASS names the claim and the evidence that demonstrates it. An instrument that did not
run is **UNMEASURED**, not a measured zero.

Do not use a total test count as the release verdict.

## Pin the candidate

Record before judging: commit SHA; Worker runtime and toolchain; migration head; web build artifact;
contract versions; **the RP ID and origins the candidate is configured with**; desktop client versions
tested; provider, billing and webhook sandbox versions. If the candidate moves, say so and state what
was and was not re-run — a pin voided by your own repair is the system working, not a nuisance.

## Repair loop

For each repairable failure: preserve the failing evidence **first**, fix the root cause, add or
strengthen regression proof at the right layer, then re-run the original reproducer **and** the
affected gates. A finding closes only when the reproducer no longer reproduces, the regression proof
passes, no spec or contract was weakened, and the broader gate stays green.

Stop only when: a requirement or contract must change and needs deliberate approval; a required
external system cannot be exercised; a safety-critical proof is genuinely unavailable; the remaining
defect is outside the authorized scope; or continuing would hide rather than solve the problem.

## Output

An evidence record, not persuasive prose. Write it under
`docs/verification/runs/<date>-v05-whole-site-and-release-security/` and include:

- commit, environment, and the WebAuthn configuration in force;
- verdict, and the Tier-0 summary;
- the security gate result **as a gate**, pass or fail, before the UI findings;
- per-area site coverage, naming which of the 18 areas and which of the 12 screen references were
  actually visited or compared — and which were not;
- every finding classified by failure direction (fail-open / fail-closed-unreachable /
  fail-closed-settable) and by kind (coverage gap / capability gap / harness defect);
- sensitivity evidence for each gate you relied on, with a mutation per family;
- unresolved findings, accepted residual risks, external unknowns, migration/rollback, and limitations;
- evidence paths, with every command rerunnable as written.

End by answering:

> **What important thing do we still not know?**