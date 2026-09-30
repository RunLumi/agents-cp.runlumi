# V01-039 — an authorization failure is reported as an authentication failure

- **Claim ID:** V01-039
- **Family:** Authentication / machine identity
- **Severity:** **MEDIUM** (no confidentiality or availability impact; material diagnostic and
  correctness impact, and it defeats the separate-boundary design)
- **Status:** CLOSED — recorded before repair, updated with root cause, fix, and proof
- **Verdict:** FAIL → **PASS** (a scope denial is now `403`; probe 46/46)

## Claim

A machine API key that **authenticates successfully** and is then **denied for its scope** is answered
`401 authentication_required` — "Authentication is required." The credential was presented, accepted,
and found valid. The refusal is a category error, and it is the product's own words that prove it:

```json
{
  "error": {
    "code": "authentication_required",
    "message": "Authentication is required.",
    "details": { "reason": "scope_denied" }
  }
}
```

**The code field and the reason field in the same body disagree.** The response names a scope denial
and reports an authentication failure in the same breath.

## Setup

`machine_denial` in `apps/api/src/routes/machine_identity.rs`:

```rust
let code = match reason {
    MachineDenyReason::AuthenticationRequired
    | MachineDenyReason::MachineKeyRevoked
    | MachineDenyReason::MachineKeyExpired
    | MachineDenyReason::MachineKeySuspended
    | MachineDenyReason::ScopeDenied                 // <-- authorization
    | MachineDenyReason::ScopeProjectMismatch        // <-- authorization
    | MachineDenyReason::ScopeNetworkUnavailable     // <-- authorization
    | MachineDenyReason::ScopeNetworkDenied          // <-- authorization
    | MachineDenyReason::ScopeModelDenied            // <-- authorization
    | MachineDenyReason::ResourceScopeMismatch       // <-- authorization
        => ApiErrorCode::AuthenticationRequired,
    MachineDenyReason::HumanOnlyAction
    | MachineDenyReason::OrganizationSuspended
    | MachineDenyReason::OrganizationPendingDeletion
    | MachineDenyReason::KillSwitchActive
        => ApiErrorCode::PermissionDenied,
    MachineDenyReason::OrganizationDeleted => ApiErrorCode::NotFound,
};
```

**Eleven** reasons map to 401. Three of them (`Revoked`, `Expired`, `Suspended`) are genuinely
authentication failures and are correctly coded. **Eight are authorization failures** and are not.

## Action

`verify:staff-credential` B2 and the V01-039 case, over real HTTP against a real D1, using **two
identically-shaped keys** so the only variable is the capability:

| key | capability | `GET /api/v1/machine/whoami` |
|---|---|---|
| control | account + key both hold `org.read` | **200** |
| attack | account + key both hold only `projects.read` | **401 `authentication_required`**, `details.reason = "scope_denied"` |

`machine_whoami` calls `require_machine` and then, separately,
`authorize_machine(..., &Permission::OrgRead, ...)`. The 200 on the control proves the whole chain
works: the token parses, the prefix resolves, the constant-time hash comparison passes, the account is
active, the JOIN returns a row, and the authorization succeeds.

The probe also asserts the arithmetic directly, so the hash is not a suspect:

```
prefix=… (len 12) secretLen=43 rowStatus=active storedHash=4009fb37… computedHash=4009fb37… equal=true
```

So the **only** difference between 200 and 401 is a capability the key does not hold.

## Actual

Every scope denial on the machine surface answers `401`. A client cannot distinguish:

- "my credential is invalid, refresh it" — retried with a new credential, which **can never help**;
- "my credential is fine, my scope is too narrow" — fixed by changing the key's capabilities.

Both arrive as the same 401 with the same message, and the only distinguishing information is a
`details.reason` string a client has to know to look for.

## Why this is not a disclosure control

The obvious counter-argument is that `401` discloses less than `403`: a `403` confirms the credential
is real. **That argument does not hold here, and the response body is what shows it.** The current
response *already* returns `details.reason = "scope_denied"` under the 401. Anyone who can read the
401 can already tell a scope denial from a bad credential; the only thing the `401` adds is a false
statement about which category it is. Correcting the code discloses **nothing new**.

That distinction matters, because "401 is safer" is a reasonable-sounding reason to leave a
misclassification in place, and it is the reason this one would have survived review.

## Impact

- **It defeats the design it sits inside.** ADR 0007 exists to keep "who are you" and "what may you do"
  as **separate** authorization boundaries, and its stated cost is that each keeps its own decision
  function. Collapsing a scope denial into an authentication failure re-merges them at the one place a
  client can observe the difference.
- **The error is unactionable.** A machine client that treats 401 as "re-authenticate" will loop
  forever against a scope problem. This is the same class as V01-036's `503` for a rejected argument:
  a status that sends the reader somewhere the answer is not.
- **It is how this probe lost several rounds.** The B2 control asserted a minted key would work on
  `GET /orgs/{id}/projects`; it answered 401, and the natural reading was "machine keys do not
  authenticate anywhere" — a critical-sounding conclusion that was entirely wrong. The real cause was a
  capability the key did not hold, reported as an authentication failure. It took reading
  `authorize_machine` to find the `Permission::OrgRead` the route requires. **A probe that trusted the
  status code would have filed a false CRITICAL.**

## Regression gap

- No test asserted the **code** for a scope denial. Unit tests over `authorize_machine` check the
  `MachineDecision::Deny(reason)`; nothing checked which `ApiErrorCode` each reason becomes.
- `verify:device-idempotency` and the machine-identity family exercise machine keys, but only for
  *accepted* requests. No probe presented a valid key to a route it was not entitled to, so the
  mapping was never observed from outside.
- **Nothing asserted that the `code` and the `details.reason` in the same body agree.** That is a
  cheap, general check, and it is the check that would have caught this: a response whose reason says
  `scope_denied` must not be coded `authentication_required`.

## Fix

`apps/api/src/routes/machine_identity.rs`, `machine_denial`. The mapping is split by what the reason
**is**:

- **credential state** — `AuthenticationRequired`, `MachineKeyRevoked`, `MachineKeyExpired`,
  `MachineKeySuspended` → `401`, unchanged and already correct;
- **authorization** — `ScopeDenied`, `ScopeProjectMismatch`, `ScopeNetworkUnavailable`,
  `ScopeNetworkDenied`, `ScopeModelDenied`, `ResourceScopeMismatch` → `403`, joining the three that
  already were;
- `OrganizationDeleted` → `404`, unchanged.

`ResourceScopeMismatch` was the arguable one and the reasoning is recorded in the source: the key is
already valid, so the caller knows who they are, and the response **already** carried `details.reason`
under the old `401` — so `403` discloses nothing the current answer does not.

## Regression proof

`verify:staff-credential` B1/B2/B3 plus the V01-039 case, **46/46, exit 0, 0 skipped**, from
**33/35** before this round of additions.

The rigour is in the pair: **two identically-shaped keys** whose only difference is one capability.

| key | `GET /api/v1/machine/whoami` |
|---|---|
| control — account and key both hold `org.read` | **200** |
| attack — account and key both hold only `projects.read` | **403 `permission_denied`** |

The 200 on the control is what makes the 403 meaningful: it proves the token parses, the prefix
resolves, the constant-time hash comparison passes, the account is active, the JOIN returns a row, and
the authorization itself succeeds. So the **only** variable is the capability. The probe also asserts
the arithmetic directly, so the hash was never a suspect:

```
prefix=… (len 12) secretLen=43 rowStatus=active storedHash=4009fb37… computedHash=4009fb37… equal=true
```

And the case asserts the **status**, not merely "not 2xx" — a `2xx` would be a breach, `401` was the
defect, and only `403` is correct.

## Three more things this round established about the machine surface

1. **The three actor boundaries hold.** A staff token is refused on a customer org-scoped route with
   the **same** answer as for an organization that does not exist, so a staff token is not a cross-tenant
   existence oracle. A machine key is refused on a staff route. A customer session is refused on a staff
   route. ADR 0007's central claim is now measured rather than assumed.
2. **Machine identity has exactly one accepting route.** `/api/v1/machine/whoami` is the only handler
   in the tree that calls `require_machine`. Worth knowing, and it is why B2's control uses it: it is
   the only place a machine credential can be shown to be live.
3. **A 422 that names its rule is worth having.** Minting a key whose capabilities exceed its account's
   answers `422 "A key's capabilities must be a subset of its service account's capabilities."` — the
   product told the probe exactly what was wrong. That is the contrast the rest of this round lives in:
   the silent 401s cost several rounds, and the one refusal that named its own cause cost none.

## Re-run after the fix

`pnpm check` exit 0, 1029 tests. `verify:secret-tenancy` 32/32, `verify:idempotency` 47/47,
`smoke:p08` 47/47, `verify:path-id-tenancy` 198/198, `verify:privilege-escalation` 96/96,
`verify:device-idempotency` 23/23.

## Severity reassessed to MEDIUM, and why not lower

No confidentiality or availability impact: nothing is granted that should not be, and nothing is
denied that should be allowed. It is material because it is **diagnostic** — a machine client that
treats `401` as "re-authenticate" loops forever against a scope problem — and because it **collapses
the boundary ADR 0007 exists to keep**, at the one point a client can observe the difference. Not
higher, because the response body already carried the correct reason and so leaked nothing new.
