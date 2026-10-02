# V04-009 — the recovery ceremony is defended by one layer, tested by none

**Severity: MEDIUM (product/coverage). Not a live vulnerability: the defence is correct by reading and
by its SQL predicate. But it is UNPROVEN at runtime, it is the only ceremony path with no route-level
guard, and the campaign's auth-replay mutant class does not touch it. Found while closing
work item 5.**

## What the three ceremony paths look like

`smoke:passkey` drives replay for **registration** (`p02-passkey-smoke.mjs:638`) and **login**
(`:803`). Recovery has no such case. That absence turned out to be structural rather than an oversight
in the probe.

`ensure_pending` (`routes/authenticators.rs:1693`) is the shared route-level guard — it requires
`status == 'pending'`, a matching `kind`, and an unexpired `expires_at`. It is called for **four**
ceremony kinds:

| ceremony kind | `ensure_pending` at | storage CAS |
|---|---|---|
| `PasskeySignup` | `routes/authenticators.rs:288` | `consume_ceremony` |
| `PasskeyLogin` | `:532` | `consume_ceremony` |
| `PasskeyAdd` | `:1168` | `consume_ceremony` |
| `Reauthenticate` | `:1534` | `consume_ceremony` |
| **recovery** | **nowhere** | `consume_recovery` (`repositories/authenticators.rs:698`, called from `routes/authenticators.rs:979`) |

So registration, login, add-credential and reauthenticate each have **two** independent defences — the
route-level status check and the storage compare-and-set — and VI-AUTH-001 exists precisely because a
single-site mutation there leaves the other standing. Recovery has **one**.

## The one defence is correct

`CONSUME_RECOVERY_SQL` is strictly strong, and stronger than its login twin in one respect:

```sql
UPDATE password_recovery_challenges
SET status = 'consumed', consumed_at = ?2, attempts = attempts + 1
WHERE challenge_id = ?1
  AND code_hash = ?3
  AND status = 'pending'
  AND attempts < 10
  AND expires_at > ?2
```

`AND status = 'pending'` makes it a genuine compare-and-set: the second call matches zero rows, and
`D1Adapter::changes(&result)? == 1` turns that into a refusal. It additionally binds `code_hash` and
bounds attempts, which `CONSUME_CEREMONY_SQL` does not. **There is no vulnerability here** — the
recovery ceremony cannot be replayed.

## Why it is still a finding

Three reasons, and none of them is "the code is wrong":

1. **It is the only ceremony path whose replay defence has never been executed.** `consume_recovery`
   has a unit test over its SQL, which is exactly the shape AGENTS.md calls out for the staff-grant
   read: *"a test over a string constant cannot report that nothing calls the function that owns it."*
   Here the constant is right and the call exists; what is missing is anyone watching a second attempt
   arrive over HTTP.
2. **It is the path that changes an account password.** Of the five ceremony kinds, recovery is the one
   whose successful replay is worth the most to an attacker who captured a challenge and an assertion.
   It is also the one the objective's hard-blocker list names directly: *"auth/recovery replay or
   identity-confusion gap."*
3. **"auth replay mutant killed" does not extend to it.** VI-AUTH-001 removes the login
   `consume_ceremony` CAS and the shared `ensure_pending` status check. Removing those leaves
   `consume_recovery` untouched and fully armed, so a kill for VI-AUTH-001 says nothing about recovery.
   The class is narrower than its name.

## Decided: record, do not repair

Closing this means adding a recovery-replay case to `smoke:passkey`: complete a recovery ceremony,
then re-POST the completion with the same challenge and code, and assert the refusal **names the
consumed state** rather than the attempt bound — the same discipline the login replay case needed when
an identical assertion was refused for the wrong reason (`passkey_counter_regression`).

That is a small change to a probe, and deliberately not made here: the mutation campaign and the
`smoke:passkey` baseline were green within the last hour, `smoke:passkey` owns port 8787 and the D1
lifecycle for the passkey surface, and adding a case to it invalidates a recorded baseline that the
verdict cites. It is recorded as an open coverage gap with its next action named, rather than done
quietly inside a verification campaign.

## A defect this found in the campaign's own case definition

`VI-AUTH-001`'s second anchor is

```
        Ok(D1Adapter::changes(&result)? == 1)
```

and that line occurs **three times** in `repositories/authenticators.rs` — in `consume_ceremony`
(`:453`), `revoke_passkey` (`:568`) and `consume_recovery` (`:716`). The campaign applies faults with
JavaScript `String.replace` against a **string** pattern, which replaces the **first** occurrence
only, so the case is currently aimed correctly — but only because `consume_ceremony` happens to be
defined first. That is targeting by **source order**, which is not a property the case states or
checks.

If those functions are ever reordered or a new one is inserted above them, the case silently disables
`revoke_passkey` or `consume_recovery` instead, the campaign reports a kill, and the kill is for a
fault nobody intended — the same failure as a mutation that breaks the statement instead of the claim,
one level up. This campaign hit the mirror image of it from the other side: a harness of my own
asserted the anchor was unique, refused the mutation, silently degraded a two-site fault to one site,
and returned 76/76 — which is the *expected* single-site result — one step from recording a Tier-0
mutant survivor that did not exist.

The fix for the case is to anchor on something unambiguous (the `UPDATE webauthn_ceremonies` statement
or the function header above it). The fix for harnesses in general is the one this campaign has now
learned twice: **assert what the mutation actually changed, by name, and never let a partially applied
fault report a verdict.**