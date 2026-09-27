# Repair closure — the V00 findings, discharged

**This document is the post-repair half of the V00 run.** `verification-run.md` recorded what
was true at `ecbdac1`; this records what is true after the repair loop, with the evidence for
each claim re-derived rather than inherited.

The rule applied throughout, from `AGENTS.md` and `docs/verification/README.md`: preserve the
failing evidence, fix the smallest coherent root cause, add or strengthen regression proof at
the cheapest correct layer, re-run the original reproducer **unchanged**, re-run the affected
proof obligations, and confirm the mutation campaign and `pnpm check` are still green.

No spec, frozen contract, or existing verifier was weakened to obtain any of these results.
Where a repair required a durable decision, it is recorded in
[`docs/adr/0008-vendored-passkey-auth-wasm-clock.md`](../../../adr/0008-vendored-passkey-auth-wasm-clock.md).

---

## Headline

| Gate | Before (at `ecbdac1`) | After | Verdict moved |
|---|---|---|---|
| Real-browser journey | **20/23**, 3 FAIL (old probe) | **39/39**, 0 FAIL, exit 0 — and **12 named failures** against the pre-repair product, so it is proven able to fail | `VI-AUTH-001`, `VI-ONBOARD-1`, `VI-UX-001`, `VI-UX-002`, `ROUTE-2` |
| P05 runtime smoke | **175 pass / 1 fail**, exit 1 | **185 pass / 0 fail**, exit 0 | `GUARD-1`, `VI-IDEM-001` |
| Passkey ceremony probe (new) | did not exist | **55/55**, exit 0 | `VI-AUTH-001` |
| Guard-sentinel probe (new) | did not exist | **11/11** across 2 recognised abort texts | `GUARD-1` |
| Mutation campaign | 9/9 KILLED, minimum set incomplete | **11/11 KILLED**, `tally: {"KILLED":11}`, exit 0 | `VI-TEST-001` |
| Worker bundle | `gzip 2393.75 KiB` | `gzip 2395.07 KiB` (**+1.32 KiB**) | budget still within ADR 0004 |

The browser journey went from three failures to zero, and it grew from 23 to 39 checks while
doing so: the repairs added checks, and none of the original 23 were removed. Three of the
fallbacks that made the old run report its failures cleanly are **gone** — a verifier that repairs
its own subject stops being a verifier, and the details are in
[`findings/VFY-002-no-email-verification-step-in-web-ui.md`](findings/VFY-002-no-email-verification-step-in-web-ui.md).

The 20/23 figure is the **old** probe in this run's `evidence/`. The promoted 39-check one was
separately proven able to fail; see [The gate can fail](#the-gate-can-fail) below. That is not a
formality — proving it found two more defects in the gate itself.

---

## The gate can fail

A gate that only ever passes is a script, not a check. The promoted browser journey had never been
run against a product it was supposed to fail on, and running it revealed that **it could not report
three of the defects it was built to find**:

```text
$ sh evidence/vfy-browser-sensitivity.sh
  absent as expected: verifyEmail in apps/web/src/features/auth/auth-screen.tsx
  absent as expected: setShowCreateOrg(true) in apps/web/src/features/organizations/org-dashboard.tsx
  present as expected: min-w-[620px] in apps/web/src/features/organizations/org-dashboard.tsx

FAIL  the verification step renders a submittable form, not a dead end  — {"found":false,…}
FAIL  the one-time code field is named and labelled  — {"found":false,…}
FAIL  submitting the form calls POST /api/v1/auth/verify-email  — no one-time-code input exists
FAIL  the session now reports a verified email  — email_verified=false
FAIL  a control exists to open the create-organization panel again  — {"present":false,…}
FAIL  a SECOND organization can be created through the UI
FAIL  the organization switcher lists both organizations…  — options=0

12/24 browser checks passed
probe exit status: 1
SENSITIVE: the probe failed against ecbdac1, naming VFY-002 and VFY-003.
```

### What that exercise found wrong with the gate

1. **Its waits tested for the repair.** "Did signup succeed?" looked for
   `input[name=one-time-code]`, `#org-switcher`, or the words "create an organization" — **all three
   introduced by the repair**. Against the pre-repair product it timed out and exited **2**, a harness
   fault, where it should have reported a defect. A gate that can only pass on the exact UI it was
   written alongside is not a gate. Both waits are repair-independent now: a terminal state is "the
   signup form is gone, or an alert is showing, or the shell is present".
2. **It crashed on the state it exists to detect.** Having reported that no verification form existed,
   it then called `Object.getOwnPropertyDescriptor(…, "value").set.call(undefined, …)` and died with
   `TypeError: Illegal invocation`, losing every later check. Interactions sit behind an explicit
   form-exists guard now, and the skip is itself reported as a failure.
3. **It ran on forever.** The cross-organization stage had an unbounded wait, turning a run that had
   already named two defects into a 30-minute timeout. Bounded now — and when the switcher is absent,
   `VI-UX-001`/`VI-UX-002` are reported **UNPROVEN** rather than silently skipped, because a verifier
   that cannot reach the state it is testing has proved nothing about it.

None of this was visible while the probe passed 39/39 on the repaired code. All three lived in the
**failure** path, which nothing exercises until something actually breaks.

### What it does not prove, stated plainly

`VFY-007` is **not** demonstrated by that run. The narrow-layout checks come after the
cross-organization checks, and the pre-repair UI cannot reach a second organization, so the journey
stops before the Members table is ever measured — a layout defect masked by a navigation defect. Its
sensitivity rests on the ten component cases in
`apps/web/src/features/organizations/org-dashboard.test.ts`, each verified to fail when its fix is
reverted. One journey cannot prove everything, and overstating it would be worse than the gap.

`VFY-001` is not shown by that run either, because the Worker is deliberately the repaired one so
that the variable under test is the web source. It is proven directly and more sharply by reverting
each of its two patches against `pnpm smoke:passkey`.

`evidence/vfy-browser-sensitivity.sh` is rerunnable: it builds a linked worktree at `ecbdac1`,
asserts the pre-repair source really lacks the fix — two absences and one presence, so a wrong
worktree fails loudly rather than passing vacuously — serves it on its own port, and requires the
promoted probe to exit non-zero with `VFY-002` and `VFY-003` named. Exit **2** is rejected rather than
accepted, because a harness fault says nothing about the product.

---

## Finding-by-finding closure

### VFY-001 — every passkey ceremony returned 500 in the Worker

**Status: CLOSED.** Tier 0, `VI-AUTH-001` FAIL → PASS; `VI-WASM-001` "run" half FAIL → PASS.

The root cause was two defects at the platform boundary inside `passkey-auth` 0.1.3, not one:

1. `types::now_secs()` called `std::time::SystemTime::now()`, which is `unsupported()` and
   **panics** on `wasm32-unknown-unknown`. Called from inside `start_registration` and
   `start_authentication_with_creds`, so the adapter's existing `state.created_at = 0` mitigation
   — which ran *after* the call — could never prevent it.
2. **Found only after (1) was fixed.** `crypto::verify_es256` parsed signatures with
   `EsSig::from_der`, and its module comment stated the error outright: *"The ES256 signature on
   the wire is **DER-encoded**, not raw r||s"*. WebAuthn specifies the opposite — a fixed-length
   `R || S` concatenation, 32 bytes each — and every real authenticator emits that form. A
   DER-only parser rejects 100 % of genuine assertions.

Defect 2 was invisible because the crate's own `es256_round_trip` test signs with `p256` and
serialises with `sig.to_der()`, so it asserted the crate's wrong assumption back at itself. It
surfaced only because the new probe builds authenticator output **to the specification** with
`node:crypto` and `dsaEncoding: "ieee-p1363"`, not to the library's expectation.

**Decision:** [`ADR 0008`](../../../adr/0008-vendored-passkey-auth-wasm-clock.md) — vendor via
`[patch.crates-io]`, patch exactly two functions, both on the platform boundary. Replacing the
crate with `webauthn-rs` was rejected on evidence: it pulls `ring`/`aws-lc-rs`/`x509-parser`
into a Worker already at ~80 % of the 3 MiB free-tier compressed limit, and it would re-open
F01's five required proofs from scratch. Upgrading is impossible — 0.1.3 is the newest published
version, checked against the crates.io API on 2026-09-27.

**F01's five required proofs, all now discharged:**

| # | Requirement | State | Evidence |
|---|---|---|---|
| 1 | compiles for `wasm32-unknown-unknown` | PASS | `cargo check --workspace --target wasm32-unknown-unknown` |
| 2 | Worker dry-run/build succeeds | PASS | `pnpm build` → `Total Upload: 9453.62 KiB / gzip: 2395.07 KiB` |
| 3 | **registration + assertion verify end-to-end with server-side ceremony state** | **PASS** | `pnpm smoke:passkey` — 55/55, real ES256, real CBOR, real D1, real Worker |
| 4 | password KDF fits real Worker CPU/memory | **UNPROVEN — unchanged** | no Argon2id cost measurement inside the Worker CPU limit exists. Recorded in [`next-verification-actions.md`](next-verification-actions.md) — an **in-repo** gap, not an external dependency. This repair does not claim it. |
| 5 | bundle impact acceptable | PASS | `gzip` +1.32 KiB on a 2393.75 KiB baseline; ADR 0004 sets no Worker ceiling and the figure is now recorded in CI |

**Proof 3, in detail.** `apps/api/scripts/p02-passkey-smoke.mjs` builds a real P-256 key with
`node:crypto`, encodes a spec-conformant `attestation: "none"` attestation object, and signs
assertions with ES256. 55 checks covering: ceremony start, F01-004/005 option policy, challenge
substitution, origin substitution, RP-ID substitution, missing user verification, missing
attested credential data, `raw_id` substitution, duplicate-authenticator enrolment, corrupted
signature, unknown credential, user-handle substitution, replay with an **advanced** sign counter,
session revocation, and D1-enforced ceremony expiry.

**Two required cases were missing and are now covered.** The objective for this probe names
"unknown/**revoked** credential" and "`user_id` substitution". Only "unknown" was, and the two gaps
were the ones where the security claim actually lives:

- **Revoked credential.** Only *session* revocation was tested. An unknown credential is refused
  because it does not exist; a **revoked** one still exists and still verifies cryptographically, so
  only the revocation state can refuse it. The probe now reaches that state through the real route —
  a reauth grant, the lockout guard, a configured password, then `DELETE /api/v1/account/passkeys/{id}`
  — and asserts a revoked credential cannot authenticate **even with a valid signature**, with the
  sign counter advanced so the counter check cannot be what refuses it.

  Two properties on the way there are worth their own checks, because each is a way the endpoint
  could be wrong in the permissive direction: the **lockout guard** refuses to remove the last login
  method, and a **fabricated reauth grant** is refused. The second is only reachable once a password
  exists, because `revoke_passkey` evaluates `can_revoke_passkey` *before* consuming the grant — so
  with one passkey a fabricated grant is refused by the lockout guard instead. A bare "was it
  refused?" check passes on either reason, which is why the reason is asserted.

- **Identity substitution.** There was no such case, and a neighbouring check sent `X-User-ID`, a
  header the server never reads — a check that could only ever pass. Replaced by two falsifiable
  halves: `/api/v1/me` must resolve the same user whatever identity headers claim (`X-User-ID`,
  `X-Actor-ID`, `X-Principal-ID`, `X-Sub`), and an org-scoped read must refuse a client-asserted
  `x-org-id`. The second is real rather than vacuous because `x-org-id` **is** read, as a mismatch
  guard in `authorize_org`.

  This case is **not** mutation-detectable and is not described as such: the server reads no
  identity header, so reverting it would mean *adding* the vulnerability. It is a live assertion of a
  property, which is a weaker and honest kind of evidence than a mutation proof.

What the probe does *not* fake, stated plainly: it does not hold the private key internally or
require user presence, because those are authenticator properties outside the control plane's
boundary. The genuine CTAP2 half is `apps/web/scripts/browser-probe.mjs`, which registers a real
`WebAuthn.addVirtualAuthenticator` over CDP. The two are complementary halves of one claim.

**Both patches are load-bearing, proven by reverting each** (all three states re-measured
2026-09-28 against the final probe):

| Reverted | Probe result | Failure reported |
|---|---|---|
| `now_secs` → `SystemTime` | 5/7 | `registration ceremony start … status=500` |
| `verify_es256` → DER only | 33/35 | `a correct assertion signs in … reason=passkey_signature_invalid` |
| neither (both applied) | 55/55 | — |

**Why the denominators are 7 and 35, and not 55.** The probe returns early once a core step fails,
so under a revert the later checks never run and are not counted. A reader comparing `55/55` with
`33/35` could reasonably conclude that twenty checks had disappeared; they were never reached. The
same holds for `5/7`: the ceremony cannot start, so nothing downstream of it executes.

**These figures have been re-measured twice, and the second time they moved.** The first
measurement was against a 34-check probe. Re-measuring then reproduced `33/34` exactly, and the
denominators were correctly attributed to the early return rather than the probe's size. The probe
has since grown to 55 checks — the objective's required "revoked credential" and "`user_id`
substitution" cases were missing and have been added — and re-measuring again gave `55/55`, `5/7`,
and `33/35`.

So the first suspicion of staleness was unfounded and nothing was changed to match it; the second
was founded and the numbers were changed. Both are recorded because "we checked and it was fine"
and "we checked and it was wrong" are different results, and only one of them is an excuse.

**Original reproducer, unchanged.** `evidence/vfy001-repro.sh` reported
`status=500` on both ceremony-start endpoints. After the repair the same script's endpoints
return `201` with a `ceremony_id`, an `expires_at`, and server-generated `public_key` options, and
the Worker log contains zero panics.

Re-run against the final tree, script untouched:

```text
HEAD=fbc730e  at 2026-09-27T16:37:03Z
POST /api/v1/auth/passkey/signup/start        status=201
POST /api/v1/auth/passkey/login/start         status=201
--- actual Worker log ---
[wrangler:info] POST /api/v1/auth/passkey/signup/start 201 Created (101ms)
[wrangler:info] POST /api/v1/auth/passkey/login/start 201 Created (9ms)
```

No panics. The script's own `expected` line says `status=200`, and that expectation is **wrong**:
a ceremony start creates a `webauthn_ceremonies` row, so `201 Created` is the correct answer. The
same mistake was in the promoted browser probe and was fixed there. It is deliberately **left
uncorrected here**, because this script is the record of what was run against `ecbdac1`: editing a
reproducer's expected values after using it as evidence is how a baseline stops being a baseline.

**Gated.** `pnpm smoke:passkey` runs in `.github/workflows/checks.yml` after `pnpm build`.

---

### VFY-002 — no self-service user could ever verify their email

**Status: CLOSED.** Tier 0, `VI-ONBOARD-1` FAIL → PASS.

`verifyEmail()` was exported from `apps/web/src/lib/api.ts` and called from nowhere. The auth
screen rendered a one-time code with no control to submit it, so `email_verified` could never
become true — and because `Permission::requires_verified_email()` refuses every mutating
permission, the first thing a new user tried was refused forever:

```json
{"error":{"code":"permission_denied","message":"Verify your email before creating an organization.",
          "details":{"reason":"email_verification_required"}}}
```

and the UI rendered that as *"Ask an administrator to grant access to this action."*

**Root cause, in two parts.** The missing submit branch was the blocker. The error copy was a
second, independent defect: mapping every 403 to a permissions message meant the one 403 that is
a self-service blocker was reported as something only an administrator could fix.

**Repairs.**

- `apps/web/src/features/auth/email-verification-form.tsx` (new) — the step, extracted as its own
  component. The defect was the *absence* of behaviour, and absence is what a test cannot see; the
  reason it was invisible is that the step lived as anonymous JSX inside a large `useState`
  machine where no test could reach it and no test could fail. It renders a real `<form>` with a
  labelled, named, `autocomplete="one-time-code"` field, a submit that is disabled until a code is
  typed and while the request is in flight, an error rendered as `role="alert"` with the request
  ID per F22-011, and "Skip for now" as a secondary action.
- `auth-screen.tsx` — the `method === "code"` submit branch now calls `verifyEmail`, and the
  orphaned code input that lived outside any form is removed so `id={codeId}` appears exactly once
  and the label association is valid.
- `lib/errors.ts` — `email_verification_required` is matched **before** the generic 403 branch,
  and requires `status === 403` as well as the reason, so a reason echoed on another status cannot
  claim the user should go and verify their email.

**Regression proof, 10 new cases in `auth-screen.test.tsx`,** each confirmed sensitive by
reverting the corresponding fix:

| Mutation | Result |
|---|---|
| submit control removed from the form | 2 tests FAIL |
| the specific 403 branch disabled | 1 test FAIL |
| neither | 10/10 pass |

The disabled-state assertions scope to the opening `<button>` tag and require a real attribute
boundary, because the button's `className` contains `disabled:cursor-not-allowed` and a naive
substring match would pass on an *enabled* button — an assertion worth nothing.

**Behavioural proof in a real browser.** The probe signs up with a password, reads the code the
development build displays, types it, and submits **through the UI**. It observes the request
actually being issued and its status, then confirms `/api/v1/me` reports `email_verified: true`.
The manual `POST /api/v1/auth/verify-email` fallback from the V00 evidence copy is **deleted** — it
had kept the journey alive while the defect stayed invisible in the tally.

---

### VFY-003 — a user with one organization could not create a second

**Status: CLOSED.** `ROUTE-2` FAIL → PASS; the `VI-UX-001` evidence limit is discharged.

`showCreateOrg` was initialised from `me.organizations.length === 0` and only ever set to
`false`, so the create-organization panel was unreachable once a user belonged to any
organization. The API accepted a second one; only the UI hid it. It also made the organization
switcher unreachable in practice, which is why `VI-UX-001` had needed an out-of-band API call to
reach a two-organization state at all.

**Repair.** A "New organization" control beside the organization switcher. F22's information
architecture has no top-level create-organization destination, so inventing a nav item would have
contradicted the spec; the switcher is where "which organization am I in" is already answered. The
control only appears when the user already has an organization, because with none the create panel
is already the whole page. It touches only the latch — the create-organization branch is evaluated
before `load`, so no refetch is triggered and no loading flash occurs. `CreateOrganizationPanel`
now reports *which* organization it created so the shell selects it, because creating one and being
left staring at the previous one is a silent no-op from the user's point of view.

**Regression proof, 8 cases in `org-dashboard.test.ts`,** including two that fail while the latch
exists (verified: removing the control fails 3 of them; restoring `min-w-[620px]` fails 1). The
"is in the header" assertion is structural — between the switcher's closing tag and the content
column — not a character distance, which a single explanatory comment can push past any threshold.
Class assertions strip comments first, because a class named in a comment is not a class on an
element.

**Behavioural proof in a real browser.** The probe now asserts the control exists, opens it, and
creates the second organization **through the UI**, then requires the switcher to list both. The
`POST /api/v1/orgs` fallback is **deleted**.

---

### VFY-004 — a deliberately refused guarded write was reported as a store outage

**Status: CLOSED.** Tier 1, `GUARD-1` FAIL → PASS; `VI-IDEM-001` runtime half FAIL → PASS.

36 guard sentinels across 13 repository modules abort a D1 batch by inserting a deliberately
invalid `idempotency_records` row. The batch error is the only signal that a write was refused
**on purpose** rather than the store being unavailable — and the two must not be confused: a
refusal means "re-read authoritative state and answer", an outage means "fail closed with 503".

Both detectors were case-sensitive substring matches on the pre-`0020` schema's text. Migration
`0020` added `trg_idempotency_pending_has_no_result`, a `BEFORE INSERT` trigger that fires before
the column constraints, so the error for the byte-identical statement changed to text matching
neither half. Every guard in the repository was silently reclassified as a store outage; P06
automation refusals became retryable job failures instead of settled ones.

**The repair is a named list, and that is the substantive point.** `core::idempotency::
GUARD_ABORT_TEXTS` holds exactly **two** entries, and the number is measured rather than
assumed:

- `NOT NULL constraint failed: idempotency_records.principal_id` — schema 0019 and earlier.
  Named down to the **column**, not the table, because the sentinel's only NULL-valued NOT NULL
  column is `principal_id`. A test I wrote first asserted a `NOT NULL` failure on a *different*
  column of the same table was not a guard; it failed, and the fix was to narrow the entry. Naming
  the table would have classified a code bug as a deliberate refusal and handed the caller a
  business answer for a fault.
- `a pending idempotency record carries no result and must hold a claim token` — schema 0020
  onward.

**Why two and not more.** The three `CHECK constraint failed: …` texts on this table are
unreachable: `principal_id TEXT NOT NULL` is a *column* constraint and SQLite evaluates column
constraints before table-level `CHECK`s, so the NOT NULL text always wins. The sibling
`trg_idempotency_completed_requires_status` and its message cannot fire either, because all 37
sentinels set `state = 'pending'`. My first draft of this list carried those three plus one more;
a probe run measured them as dead and they were removed, because dead entries are a liability — a
future reader cannot tell a measured entry from a guessed one, and a guessed one invites "fixing"
the recogniser by matching more.

**The duplicate is gone.** There were two copies of the detector. `repositories/automations.rs`
now delegates to the single definition and `routes/usage.rs`'s private copy is deleted. That is the
actual lesson of VFY-004: two copies cost exactly one migration's worth of drift.

**The over-broad half is also fixed.** `contains("constraint")` accepted a UNIQUE or FOREIGN KEY
violation on **any** table, so an unrelated integrity failure could be answered with business copy.

**New gate: `apps/api/scripts/p02-guard-probe.mjs`, 11/11.** It applies the real migrations to a
real SQLite database, executes the real sentinel, and requires the produced text to be in the
list. It also counts the sentinel sites so a changed shape is noticed, proves the pre-`0020` schema
is still recognised (so a rollback or an older restored backup stays correct), and pins the
negative half against UNIQUE, FOREIGN KEY, missing-table, and wrong-column failures. Wired into
`pnpm test`.

**Sensitivity, all five mutations detected** (`evidence/vfy004-guard-sensitivity.sh`):

| Mutation | Probe |
|---|---|
| the `0020` trigger text removed (exactly the VFY-004 defect) | 8/11, 3 FAIL |
| the pre-`0020` text removed | 9/11, 2 FAIL |
| the old over-broad `["constraint"]` matcher, verbatim | 7/11, 8 FAIL |
| the list emptied | 7/11, 8 FAIL |
| the `0020` column entry widened back to the whole table | 10/11, 1 FAIL |
| restored | 11/11 |

**Runtime effect.** `p05-smoke.mjs` went from 175 pass / 1 fail (`status=503 reason=none`) to
**185 pass / 0 fail**. The extra nine checks are ones the failure had been short-circuiting.

---

### VFY-005 — the secret-canary scan was not hermetic

**Status: CLOSED** in the V00 campaign. Retained here for completeness: the committed-literal scan
skipped generated state but still caught a real leak, proven sensitive by two mutations, and
`canary:p09` is now wired into `pnpm test`.

### VFY-006 — orphaned P02 fixtures contradicted the live contract

**Status: CLOSED** in the V00 campaign. The fixtures were deleted rather than wired up, because
making them executable requires choosing which endpoint each represents — a product-contract
decision, not a verification one.

### VFY-007 — the Members table clipped its role control off a 390 px screen

**Status: CLOSED.** `VI-UX-002` → PASS.

**The metric was the first defect.** V00 used `document.documentElement.scrollWidth`, which
**passed** while the table was clipping, because the clipping happened inside an `overflow-x-auto`
container that absorbs the overflow without propagating it to the document. A document that does
not scroll is not a page whose content is all reachable. The probe now measures **containment** —
for every scroll container, is a control clipped off its own right edge.

**And the replacement metric had the same bug, found by measuring.** The first containment
implementation collected every clipped node and stopped at eight. The Members table produced eight
non-interactive nodes in DOM order — `th`, `tbody`, `tr`, `td` — so the walk ended before it
reached the role `<select>`, and reported *"no interactive control is clipped"* while a control was
clipped by 68 px. That is finding VFY-007's own shape: a truncated sample reading as a clean bill
of health. It now collects only interactive elements, and reports the non-interactive count
separately as context.

**Measured failure, at 390 px with three visible columns:** table wanted 457 px; the role
`<select>` was squeezed to **36 px wide at x=422..458** — entirely outside the viewport, reachable
only by scrolling a container, and below any reasonable touch target.

**Repair.** Three visible columns do not fit 390 px; two do. The Role column folds into the member
cell below `sm`, alongside Status and Joined, leaving **Member + Action**. Nothing is lost: the
folded text is in the DOM at every width, so a screen reader still reads role, status, and join
date — only the layout differs. The select gets `min-w-[8.5rem]`, so the Action column cannot
shrink below the control and the Member cell wraps instead; the rationale is a comment on the
declaration, because `min-w-[8.5rem]` looks like tidying to the next person who sees it. Every
column header carries `scope="col"`.

**After:** headers `["Member", "Action"]`, role control at **x=225..361, 136×44 px**, fully inside
the viewport, meeting the 44×44 touch target `AGENTS.md` requires.

**Regression proof, 10 cases in `org-dashboard.test.ts`**, each verified to fail when its
corresponding fix is reverted.

---

## What the repairs cost, measured against ADR 0004's budgets

| Budget (`AGENTS.md` / ADR 0004) | Before | After | Delta | Target | Status |
|---|---:|---:|---:|---:|---|
| Worker compressed | 2393.75 KiB | **2395.07 KiB** | +1.32 KiB | — (no ceiling set) | ~80 % of Cloudflare's 3 MiB free-tier limit; **the threshold is a cost decision nobody has made** |
| Web initial JS | 100.16 KiB gzip | **100.75 KiB gzip** | +0.59 KiB | ≤ 170 KiB | within budget |
| Web CSS | 8.83 KiB gzip | **8.89 KiB gzip** | +0.06 KiB | ≤ 35 KiB | within budget |
| Largest route chunk | 40.17 KiB gzip | **40.17 KiB gzip** | 0 | ≤ 80 KiB | within budget |

The +0.59 KiB of initial JS is the extracted `EmailVerificationForm` plus the error-presentation
branch — both shipped to every route, because the auth screen is in the initial chunk. It buys the
ability to test the surface at all, which is worth more than 0.59 KiB.

`js-sys` was already in the graph through `wasm-bindgen`/`worker`, so the two-function passkey
patch costs ~1 KiB rather than a dependency tree. **That measurement is the reason ADR 0008
rejected `webauthn-rs`**, which would have pulled `ring`/`aws-lc-rs`/`x509-parser` into a Worker
already at 80 % of the compressed limit.

### A budget gate was deliberately not added

`next-verification-actions.md` action 6 asks for a CI budget job. It is **not** done, and the reason
is on the record rather than in a TODO: choosing the *threshold* is a product and cost decision,
not a verification one. `AGENTS.md` forbids inventing a lasting convention that `DESIGN.md` and
`docs/adr/` do not carry, and a budget invented by the verifier is exactly that. The measurements
above are recorded so the decision has a baseline to start from, and both figures are already
printed by `pnpm build` on every run.

---

## Three verifier defects found while repairing, and fixed

Not product defects. Each was a case of the harness reporting something other than what it
measured, which is worse than a missing check.

1. **The mutation campaign exited 0 next to "0/1 mutations were killed."** A `BLOCKED` or
   `HARNESS_FAULT` verdict left the survivor list empty, so the gate passed. The gate now keys off
   the **tally** — every case must be `KILLED` — and says explicitly that a case which never
   produced evidence is a gap in the campaign, not a clean bill of health.
2. **A missing launcher was reported as a wrong-reason kill.** The passkey case resolved
   `wrangler` as `<cwd>/apps/api/node_modules/.bin/wrangler`; `cwd` is the disposable worktree,
   which has no `node_modules`. The probe died with `spawn … ENOENT` and the case was reported as
   `KILLED_FOR_THE_WRONG_REASON` — a broken campaign reading as a finding about the product. It now
   resolves the binary from the worktree, then from the **main checkout derived from the git common
   dir** (which is where `pnpm install` actually ran), or `$PROBE_WRANGLER`, and reports
   `HARNESS_FAULT` with the list of places it looked if none is found. A `KILLED` verdict also
   carries the verifier's own words, because a verdict that raises a question without the evidence
   to answer it forces a manual re-run in a scratch tree to diagnose — which is exactly what had to
   happen here.
3. **The browser probe could not report its own failure.** Chrome is a child process; if a step
   threw before `browser.close()`, Chrome stayed alive and kept Node's event loop running, so the
   probe **hung for 30 minutes with no output** instead of failing. Teardown is now in a `finally`,
   the process exits explicitly, and a harness fault exits **2** — distinct from **1** for a
   product failure, so a broken probe cannot read as a detected defect.

**The mutation set is now complete.** `docs/verification/proof-obligations.md` names a minimum
set; V00 found two entries missing. Both are now present, and both were killed with the verifier's
own words in the verdict:

| Case | Verifier | Killed by |
|---|---|---|
| `VI-AUTH-001` "accept a consumed auth ceremony" | `smoke:passkey` | `FAIL a consumed login ceremony cannot be replayed with a fresh sign counter — status=200`, i.e. under the fault the replay genuinely succeeded |
| `GUARD-1` "bypass one idempotency guard" | `smoke:p05` | `FAIL managed run start and correlated inference — internal reservation endpoint replays the managed hold (status=503 reason=none)` |

`GUARD-1` is the round trip for VFY-004. Before the fix, that *same* p05 assertion failed with the
*same* 503 — because the guard's abort was classified as a store outage instead of a deliberate
refusal. The two states pin both halves: the abort must be **recognised** in order to be refused,
and refusing it must still **work**.

One thing is recorded as measured rather than as predicted, because the difference matters. The
`GUARD-1` comment originally claimed the bypassed sentinel would let a duplicate reservation commit
twice. The observed symptom is a 503, not a double charge, and the exact propagation was not
traced step by step. The comment now says so. The narrow claim is the one that holds: the guard is
load-bearing, and removing it changes the outcome.

A fourth verifier defect, found by the campaign rather than by me: the passkey probe's replay case
was passing for the **wrong reason**. Replaying an identical assertion is refused with
`passkey_counter_regression` — a property of the credential, not of the ceremony — so a mutation
that disabled ceremony consumption entirely still left every check green. The replay now advances
the signature counter, the way a real authenticator does, and asserts the refusal reason
explicitly so a future run that passes for the wrong reason is visible in the output.

---

## What is still not proven

Nothing below was silently upgraded. Each keeps a named dependency and stays in
[`missing-external-proofs.md`](missing-external-proofs.md).

- **`VI-AUTH-001` / F01 requirement 4** — Argon2id cost inside the Worker's CPU limit. Never
  measured; this repair does not claim it. It is recorded in
  [`next-verification-actions.md`](next-verification-actions.md) under F01's five-check table, not in
  `missing-external-proofs.md`, because it needs no external dependency — it needs someone to run
  Argon2id at the configured parameters inside the Worker and record the number.
- **`VI-MIG-002`, `VI-CON-002`** — need the `RunLumi/LumiAgents` client repository.
- **`VI-OBS-001` V5 half** — needs a staging deploy and protected-content log inspection.
- **AI provider and payment sandbox claims** — need live providers. `LUMI_PROVIDER_ALLOWLIST` is
  empty, so no real upstream inference dispatch is possible from here.
- **Email delivery** — no mailbox.
- **Production-scale restore** — RTO measured on a local database, not at production volume.
- **The Tier-0 cross-tenant gap for P06–P08 routes** (action 5.1) is the largest remaining
  in-repo hole. It needs no external dependency and is the next thing worth building.
