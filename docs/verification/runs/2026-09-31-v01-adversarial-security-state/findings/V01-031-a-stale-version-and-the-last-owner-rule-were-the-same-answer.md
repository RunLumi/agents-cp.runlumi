# V01-031 — a stale version and the last-owner rule were the same answer

- **Claim:** `PATCH /api/v1/orgs/{org}/members/{id}` and `DELETE` on the same path report the reason a
  request was refused accurately.
- **Severity:** MEDIUM. Not a confidentiality or availability hole — the write is correctly refused
  either way. It is a **wrong-reason** defect on a security-relevant rule, which sends an operator and a
  client to the wrong conclusion.
- **Verdict:** FAIL at discovery, PASS after repair
- **Discovered by:** the GAP-002 attack (the last-owner class added to `verify:privilege-escalation`)
- **Regression gap:** none; the C2/C3 controls in that probe exercise both answers, and the mutation below
  shows the guard is load-bearing

## Setup

- Alice creates `duo`; Bob is invited as a plain member. Alice is the only active owner.
- Alice sends `PATCH /api/v1/orgs/{duo}/members/{bob}` with `{"role": "owner"}` — **promoting** Bob, which
  *increases* the owner count from one to two.

## Action

Promote a plain member to owner.

## Expected

`2xx`, and afterwards two active owners. FR-F02-006 requires ownership transfer to be possible, and
nothing in FR-F02-005 forbids adding an owner.

## Actual

```
409 conflict
"The last active owner cannot be demoted."
details.reason = "last_owner_required"
```

**The request was not a demotion.** It could not have been one: the target's stored role was `member`.

## Root cause

`CHANGE_ROLE_SQL` puts the last-owner guard in the `WHERE` clause:

```sql
WHERE membership_id = ?1 AND org_id = ?2 AND status = 'active' AND version = ?5
  AND ( role <> 'owner' OR ?3 = 'owner' OR (SELECT COUNT(*) … > 1) )
```

The guard is **correct** — it refuses only when the current role is owner, the new role is not, and no
other owner exists. The defect is downstream of it:

`OrganizationRepository::change_role` returns `worker::Result<bool>`, where `false` means *"no row
matched"*. The handler translated that single `false` into `last_owner_required`.

"No row matched" has two causes, and the SQL cannot distinguish them:

1. the last-owner guard refused, or
2. **`version = ?5` did not match** — an ordinary lost race or a stale client read.

The probe sent `version: 0` against a stored version of 1, so it hit (2) and was told (1). **The more
alarming of the two answers was the wrong one**, and it is the wrong one twice over: the client is told a
domain rule stopped it when a refresh would have let it through, and an operator reading the log is sent
to investigate ownership when the cause was a concurrent write.

`remove_member` has the identical collapse, and there the window is narrower but real: `DELETE` carries
no client version, so it passes the version the handler just read, and the only way to lose the race is a
concurrent write between that read and the update.

## Why the unit tests did not catch it

`can_leave` and `can_remove_member` are pure functions over `(role, owner_count)` and are correct. The
defect is in the **wiring** — the translation from "no row matched" to a reason — which no unit test of
the pure function can reach. V01-003 already established that pattern in this codebase: a correct-looking
test sitting on top of a real defect.

## Fix

Both handlers now distinguish the two, following the convention `ai_catalog.rs` already uses for
`version_conflict`:

- **`change_role`** compares `body.version` against `target.version` — the row the handler has *already
  read* — and returns `version_conflict` before attempting the update. After that, a `false` can only mean
  the guard refused.
- **`remove_member`** re-reads the membership **on the failure path only** and reports `version_conflict`
  when the version moved. One extra query, and only when something has already gone wrong.

## Evidence that the repair is the repair

The identical request, before and after:

| | status | message | `details.reason` |
|---|---|---|---|
| before | 409 | "The last active owner cannot be demoted." | `last_owner_required` |
| after | 409 | "This membership changed. Refresh and try again." | `version_conflict` |

Nothing about the request changed. Only the accuracy of the answer did — and that is the whole claim, so
the changed answer **is** the proof.

## Closure evidence

`pnpm verify:privilege-escalation`, with the new GAP-002 class in place:

```
68/68 V01 privilege-escalation cases hold      exit 0
  last-owner  409  refused  demote
  last-owner  409  refused  remove
  last-owner  409  refused  leave
```

`pnpm check` exit 0, 1027 tests. Evidence: `evidence/v01-031-pre-repair.txt` and
`evidence/v01-031-post-repair.txt`.

## The fixture bug this exposed, which is worth more than the fix

The probe sent `version: 0` — a guess — and for four runs read the resulting 409 as *"the last-owner rule
refuses a promotion"*. It was not refusing a promotion; it was refusing a stale version and calling it
something else. Two lessons, and they are the same lesson:

> **A fixture that guesses a version cannot tell a domain rule from a lost race.** So it will happily
> report a security rule as broken, or a defect as a rule, and both readings will look like findings.

That is the mirror image of V01-030, where a *route* that refused everyone made every cross-tenant
assertion pass. Here a *fixture* that guessed wrong made a correct route look broken. In both cases the
instrument was the thing that needed the control, and in both cases the control is the same shape: assert
the precondition is what the test assumes it is. The class now reads `membership.version` out of D1 and
sends that.

And the second lesson is about the probe crashing: the new attack rows initially omitted `grade`, and the
verbose table does `a.grade.padEnd(17)`. So after **64 assertions had passed and 4 failed**, the probe
died with `Cannot read properties of undefined` and the whole sheet was replaced by a harness failure.
An optional-looking field in a reporting structure is load-bearing the moment something reads it.
