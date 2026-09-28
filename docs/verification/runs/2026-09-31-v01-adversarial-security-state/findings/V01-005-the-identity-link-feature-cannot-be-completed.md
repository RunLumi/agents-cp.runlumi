# V01-005 — the identity-link feature cannot be completed, so FR-F01-012's MUST NOT is enforced by unreachable code

## Status

open — needs the deliberate change process, not a patch. **No MUST is violated.**

## Severity

**low.** It is a dead-end feature, not a hole. The product fails closed on every path.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-AUTH-002` (new) |
| **Setup** | real Worker, fresh local D1, a real verified user with a real password, and a second real verified account whose address is the one under attack. |
| **Action** | `POST /api/v1/account/reauth/password` with `purpose: "identity_link"`, then the identity-link ceremony. |
| **Expected** | a reauth grant for purpose `identity_link` can be minted, so `POST /me/identities/link/start` can be reached and the email-conflict guard can run. |
| **Actual** | `422 purpose_invalid`. No grant with that purpose can be minted by any route. |
| **Evidence** | `evidence/v01-005-identity-link.txt` |
| **Verdict** | **UNPROVEN** for the email-conflict claim, and **FAIL (functional)** for the feature. |
| **Regression gap** | none; the guard is unreachable, so no test can cover it until the feature is reachable |
| **Severity** | low |

## The defect

`link_identity_start` requires a reauth grant whose purpose is exactly `identity_link`:

```rust
// apps/api/src/routes/auth.rs:558
.consume_reauth(
    &body.reauth_grant_id,
    authenticated.principal.user_id.as_str(),
    authenticated.principal.session_id.as_str(),
    "identity_link",        // <-- the required purpose
    &reauth_hash,
    &context.received_at,
)
```

Both routes that mint a grant validate the purpose against the same closed vocabulary:

```rust
// apps/api/src/routes/authenticators.rs:1789
fn validate_reauth_purpose(purpose: &str, context: &RequestContext) -> Result<(), ApiError> {
    if matches!(
        purpose,
        "passkey_management" | "password_change" | "account_recovery"
    ) {
        Ok(())
    } else {
        Err(validation_error(context, "purpose_invalid", "Choose a supported security-check purpose."))
    }
}
```

`identity_link` is not in that list. `validate_reauth_purpose` is called by
`reauth_password` (line 1628) and by `reauth_passkey_start` (line 1466), so **no route can
ever produce a grant with purpose `identity_link`.** The grants table's own constraint is
permissive — `CHECK (length(purpose) BETWEEN 1 AND 64)` — so the value would be storable; it
is simply unreachable through the API.

Therefore:

- `POST /api/v1/me/identities/link/start` always answers `403 reauthentication_required`.
- `POST /api/v1/me/identities/link` can never be reached with a challenge the caller owns,
  because no such challenge can be minted.
- The guard that implements **FR-F01-012's MUST NOT** — *"Conflicting verified
  email/provider identities MUST NOT auto-merge accounts without an explicit safe merge
  flow"* — is at `auth.rs:542-551`:

  ```rust
  if repository
      .find_user_by_email(email.as_str())
      .await
      .map_err(|error| database_error(&context, error))?
      .is_some()
  {
      return Err(domain_error(
          &context,
          ApiErrorCode::Conflict,
          "identity_conflict",
          "That identity is already linked to an account.",
      ));
  }
  ```

  …and it sits in the route that cannot be entered.

## Why the severity is low, stated precisely

`FR-F01-012` is **two** requirements, and they have different force:

> A logged-in user **MAY** attach another login identity only after recent reauthentication.
> Conflicting verified email/provider identities **MUST NOT** auto-merge accounts without an
> explicit safe merge flow.

- The **MAY** is not satisfiable. The feature cannot be completed. That is a functional
  defect: a user who reaches the link-identity screen can never finish, and the screen is in
  the router at `app.rs:184` and `app.rs:187`, so it looks available.
- The **MUST NOT** is **satisfied** — vacuously, but satisfied. Every path fails closed, and
  the guard that would enforce it is present and correct in its logic. Nothing merges.

So no MUST is violated and no account can be taken over. What is lost is a capability, and
what is lost with it is **the only runtime evidence that the guard exists**. A check that
cannot run has never been tested, and this campaign exists because untested checks are where
defects live.

## What the probe does and does not claim, after two corrections

This section was wrong twice before it was right, and both corrections are worth recording
because the first version was a **green assertion that tested nothing**.

**First version.** Posted a dummy challenge to `POST /me/identities/link` and read the
`403 identity_conflict` as proof the email conflict was enforced. It is not. `link_identity`
uses the **same reason code for two different conditions**:

| reason code | message | what actually failed |
|---|---|---|
| `identity_conflict` | "The identity link challenge is invalid or expired." | the challenge |
| `identity_conflict` | "That identity is already linked to an account." | the email conflict |

The dummy challenge hit the first. The second lives in `link_identity_start`. So the section
asserted a claim about the email conflict while measuring the challenge — and the A3
sensitivity case, which deletes the email-conflict guard, would have changed nothing, which
is exactly what it did. A verifier that reports PASS on a condition it did not test is worse
than one that reports nothing, because it removes the reason to look.

**Second version.** Added a reauth grant to reach the real guard. It could not be minted,
which is this finding.

**Third version, current.** The section is relabelled to say what it actually attacks — the
**challenge** — and it asserts the precondition it cannot get past, so the output states the
limit of its own scope rather than hiding it in a comment:

```
PASS  a link attempt with no valid challenge is refused — status=403 reason=identity_conflict
PASS  a reauth grant for purpose `identity_link` cannot be minted, so the EMAIL-conflict
      guard is unreachable and its claim is UNPROVEN rather than proven — status=422
      reason=purpose_invalid
PASS  the victim's session still resolves to the victim after the link attempt
PASS  no identity was attached to the victim by the attacker's link attempt — 1 -> 1
```

The victim read-backs are still real evidence: a second verified account is unaffected, and
its identity count does not move. And `link_identity` genuinely does check the challenge's
**kind** and its **ownership** (`challenge.user_id != principal.user_id`), so the section's
assertion is a claim the code does enforce.

## The decision this needs, and it is not a patch

Two ways to make the feature reachable, and they are not equivalent:

1. **Add `identity_link` to `validate_reauth_purpose`.** One line. Makes the MAY satisfiable
   and puts the MUST NOT's guard back under test. It also widens the vocabulary every reauth
   route accepts, which is a real (small) expansion of what a session can do without a
   separate check.
2. **Let `link_identity_start` accept `passkey_management`.** Also small, and it reuses an
   existing, already-attested purpose rather than inventing a third meaning for the
   security check.

Either way this is a **contract question before it is a code question**: `f01` does not say
which purpose guards identity linking, and the two options differ in how much authority one
security check confers. Recorded as **GAP-003** for the deliberate change process. No code
change in this campaign.

## What is proven and what is not, in one place

| claim | verdict |
|---|---|
| a wrong-kind ceremony id is refused at the other kind's endpoint | **PASS**, both directions, with a control |
| a link attempt with no valid challenge is refused | **PASS** |
| a challenge's kind and ownership are checked | **PASS** by inspection; the ownership attack is a remaining gap |
| a second verified account is unaffected by a link attempt | **PASS**, read back from D1 |
| a link attempt cannot attach an identity to another account | **UNPROVEN** — the guard is unreachable (this finding) |
| a pre-recovery session does not survive a password recovery | **PASS**, and sensitivity-proven by A2 |
