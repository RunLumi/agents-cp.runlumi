# V01-004 — three authentication attacks the family names and nothing had ever run

## Status

**closed** — all three now have runtime evidence; the product holds every one of them

## Severity

none found. The product was correct on every case. This record exists because the *evidence*
was absent, and an absent proof of a Tier-0 claim is itself the finding.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-AUTH-001` (new) |
| **Setup** | real `wasm32` Worker, fresh local D1 with all 21 migrations, a real software CTAP2 authenticator, real passkey registration, real sessions. `smoke:passkey` already drove 55 checks; the family names three more that had **zero** mentions anywhere in the probe. |
| **Action** | see the three cases below. Each reads its verdict from the database or from a second session, not from the response that carried the attack. |
| **Expected** | each case refused, with no durable effect |
| **Actual** | each refused, with no durable effect |
| **Evidence** | `evidence/v01-004-authentication.txt` — `75/75 checks passed`, up from `55/55` |
| **Verdict** | **PASS** for all three, and the probe is now demonstrated to be able to fail (see "proving the probe can fail") |
| **Regression gap** | none for the three cases; two further auth claims remain unaddressed and are listed at the end |
| **Severity** | none |

## The three cases

### 1. Wrong ceremony kind — **PASS**

`ensure_pending` compares the stored ceremony kind against the kind the completing route
expects. A ceremony id is a bearer token for a *kind*, and the attack is to present one kind
at the other kind's route.

**Both directions**, each paired with a control that uses the same payload shape at the
correct kind of ceremony, so a refusal cannot be attributed to a malformed request:

| | |
|---|---|
| control | a SIGNUP ceremony completes with a registration payload — `200` |
| attack A | a **LOGIN** ceremony id at the SIGNUP endpoint — `401 ceremony_invalid` |
| attack B | a **SIGNUP** ceremony id at the LOGIN endpoint — `401 ceremony_invalid` |
| effect | `passkey_credentials 2 → 2` — no credential enrolled |

Two things make attack A stronger than it first looks. `passkey_login_start` takes
`EmptyRequest` and names **no account** — a login ceremony is a discoverable-credential
request, so the token is not account-bound and is not even specific enough to be replayed
against a particular user. The only thing standing between it and account creation is the
kind check.

And the section proves the kind check is what refused it, not the payload: the identical
registration payload succeeds at the signup endpoint thirty lines earlier.

### 2. Identity-link conflict — **PASS**

`POST /me/identities/link` lets a verified user claim another email address. The claim is
not the status code; it is whether the attempt attaches anything to the other account.

- refused with `identity_conflict` — `403`
- the victim's session still resolves to the victim — `usr_5589…c089` both before and after
- the victim's identity count is unchanged — `1 → 1`

The victim is a second real, **verified** account, created and verified by the probe. That
matters: the first version of this section verified the victim with `{ email, code }`, which
`VerifyRequest { challenge_id, code }` does not accept, so the victim never became verified
and the read-back afterwards was asserting nothing about a real account.

### 3. Recovery with active sessions — **PASS**

The claim: completing a password recovery invalidates the sessions that existed before it.
If it does not, a password change is advisory, which is the specific thing a user is doing
it to prevent.

A second, already-authenticated session is established *before* the recovery, held by
"the attacker" — a real session on a real account. Then the owner recovers.

| | |
|---|---|
| pre-recovery session | `200` — established and working |
| recovery completes | `204` |
| **pre-recovery session afterwards** | **`401`, resolves to nobody** |
| pre-recovery password | `401` |
| new password | `200` |

`password_reset` calls `revoke_user_sessions_statement`, so this is the product behaving as
specified, and the attack is what turned a call in the source into evidence about the
system.

The last two rows are the control the first one needs. Without "the new password does
authenticate", a probe that broke recovery entirely would still see 401s everywhere and
report the claim as holding. Without "the pre-recovery password no longer
authenticates", a 401 on the session could be an artefact of something unrelated clearing
the session table.

## Proving the probe can fail

A third attack found earlier in this campaign reported "refused, 0 escalated" against a
product with a critical escalation defect, because the attacker it used could not reach the
layer under test. So the question for a new section is not only "does it pass" but "would it
notice".

**The recovery section demonstrated it, by accident and in the most instructive way
possible.** An earlier version sent `{ token, password }` to `password/reset`. There is no
`token` field on `PasswordResetRequest`, so the reset was refused with 422 — and the three
assertions *after* it kept running. They reported:

```
FAIL  a session established before the recovery no longer authenticates afterwards — status=200
FAIL  the pre-recovery password no longer authenticates — status=200
```

That is the exact shape of a critical authentication defect: sessions survive a password
reset, and the old password still works. It was entirely a probe bug. Nothing had been
changed, so nothing had been revoked, and the probe was reporting the consequence of its own
failed request.

Three changes followed, and the third is the one that matters:

1. The body was corrected to `{ challenge_id, code, password }`.
2. **A refused reset now stops the section.** If the recovery does not complete, the
   consequence checks are not run, and the section says they were skipped. A claim whose
   precondition failed is not a claim that holds.
3. Every prerequisite in these three sections is asserted before the attack that depends on
   it: the ceremony exists, the control completes, the victim is verified, the second
   session is live, the recovery challenge and code are present.

Prerequisite-first is the discipline. The alternative is a probe that reports a product
defect whenever its own setup goes wrong, and a verifier that cries wolf is a verifier that
gets ignored.

## What this cost, and the honest shape of it

Eleven runs. The three sections were written against four request shapes that were guessed
rather than read — `challenge_id`/`response` instead of `ceremony_id`/`credential`, a
nested `response` object that is the *assertion* shape applied to a registration, a
`token` field that exists nowhere, `user_identities` for a table called `identities` — plus
a `runWrangler` in this file that is promise-based where the shared harness's is
synchronous, and a JSON parser that trusted the first `{` in wrangler's output.

Each guess produced a **product-shaped failure**: a 422 that read as a validation defect, a
401 `passkey_invalid` that read as a credential rejection. That is the real cost, and it is
worth stating plainly — a verifier's failures are the part a reader trusts most, so every
guessed field name is a chance to report a defect that does not exist. Read the struct.

## Still unattacked in this family

- **Revoked device.** `smoke:p03` and `smoke:p05` mention device revocation but no attack
  drives a revoked device's request to a refusal.
- **`refresh` and session rotation after revocation.** The recovery section shows a
  pre-recovery session is dead; it does not show whether its *refresh* token is dead, which
  is a different claim and the more likely to be missed.
- **The reauth grant's own ceremony kind.** `consume_reauth_grant` and
  `LinkIdentityStartRequest { email, reauth_grant_id, reauth_token }` mean a reauth grant is
  itself a ceremony. The kind attack above does not cover it.
