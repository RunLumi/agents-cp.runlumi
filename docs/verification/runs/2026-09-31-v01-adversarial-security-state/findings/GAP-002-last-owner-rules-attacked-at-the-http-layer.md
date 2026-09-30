# GAP-002 — the last-owner rules now have an HTTP-layer attack

- **Claim:** `f02` FR-F02-005 — an organization always has at least one active owner, and removing or
  demoting the last owner fails transactionally.
- **Severity:** the claim was **UNPROVEN**; attacking it found V01-031 (MEDIUM)
- **Verdict:** PASS after repair
- **Closed by:** the `last-owner` class in `verify:privilege-escalation`, plus V01-031
- **Regression gap:** none for the three HTTP routes; the pure functions' remaining states are unit-tested

## What was missing

`can_leave` and `can_remove_member` are unit-tested, and V01-003 had already proved that a
correct-looking unit test in this codebase was sitting on top of a real defect. Nothing attacked the
**routes**: could the last owner demote themselves, remove themselves, or leave? `smoke:p08` does not
reach these routes at all.

## The attack

Three requests, each made by the **sole** active owner of a **sole-owner** organization, each followed
by a re-read of the stored state:

| # | request | must be refused | and afterwards |
|---|---|---|---|
| A1 | `PATCH /orgs/{o}/members/{self}` `{"role":"member"}` | yes | ≥1 active owner; own row unchanged |
| A2 | `DELETE /orgs/{o}/members/{self}` | yes | ≥1 active owner; own row unchanged |
| A3 | `POST /orgs/{o}/leave` | yes | ≥1 active owner; own row unchanged |

`f02` says *fail transactionally*, and that is the part a status cannot express: the refusal must have
left **nothing behind**. So each attack is graded on the memberships table read out of D1, not on the
response. The last column is a separate assertion from the second one on purpose — "the org still has an
owner" and "Alice's row is unchanged" are different claims, and a half-applied write fails the second
while passing the first.

Result: `409` on all three, and the organization keeps exactly one active owner with Alice's row
untouched.

## Three controls, because without them this block is V01-030's shape exactly

A sheet of `PASS` rows proves nothing if the fixture never had an owner to lose, or if the route refuses
everything. So:

- **C1 — the solo organization has EXACTLY ONE active owner before the first attack.** If the fixture
  were wrong, all three attacks would be refused for an unrelated reason and every one would pass while
  proving nothing. *The last owner has to BE the last owner.*
- **C2 — the duo organization has EXACTLY TWO**, so the control below removes a real second owner.
- **C3 — with a second active owner present, the SAME demotion SUCCEEDS** and the count moves from two to
  one. Without C3, "every attack was refused" is indistinguishable from "the route refuses everything" —
  which is precisely the failure that let V01-030 report six passing cross-tenant rows for a route its own
  owner could not use.

C3 is the one that carries the weight, and it is also what **found V01-031**: the fixture's attempt to
promote a member to owner was refused, and the reason it reported is in
[`V01-031-a-stale-version-and-the-last-owner-rule-were-the-same-answer.md`](V01-031-a-stale-version-and-the-last-owner-rule-were-the-same-answer.md).

## Sensitivity: 2/2, exit 0

`evidence/v01-031-sensitivity.sh`. Both mutations replace the guard's first predicate with `1 = 1` and
change no placeholder, so `pnpm schema:bind-count` stays **green** throughout — deliberately, because the
count check is blind to this class and a mutation it could see would not be testing the right thing.

| | mutation | result |
|---|---|---|
| M1 | `CHANGE_ROLE_SQL`'s guard always passes | **DETECTED** — `demote` → `200 granted`, `leave` → `204 granted`, and `owners after=[]` |
| M2 | `REMOVE_MEMBERSHIP_SQL`'s guard always passes | **DETECTED** — `remove` → `204 granted` |

**The interesting half of M1 is not the `200`.** It is `owners after=[]`: the stored-state assertion
reports that the organization has *no* active owner at all, which is the invariant FR-F02-005 exists to
hold. A probe grading on status alone would have seen a `200` and a `204` — two successful-looking
responses — and would then have had to reason about whether they were permitted.

## Stated limits

- **The three attacks share one fixture and run in sequence**, so on a *failing* product an early grant
  contaminates the later two: under M1, `remove` is refused with `403` only because the org has already
  lost its owner. That is fine for a sensitivity proof — the run is red and the defect is detected — but
  it means a single red row does not identify which rule broke. Re-seeding per attack would remove the
  cascade and is the first thing to change if this class is ever graded per-attack.
- Only the HTTP routes are attacked. `TransferOwnershipRequest` (FR-F02-006) is a separate requirement —
  current-owner authorization, an active target, recent re-authentication, and a security event — and is
  **not** covered here. It has its own gap and its own attack, and it is not closed.
- `f02` also constrains owner transfer's *order*; nothing here asserts that a transfer is refused when the
  target is not an active member.
