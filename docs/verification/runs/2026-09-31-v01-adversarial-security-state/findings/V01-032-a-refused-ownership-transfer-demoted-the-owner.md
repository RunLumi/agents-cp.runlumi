# V01-032 — a refused ownership transfer still demoted the owner

- **Claim:** `f02` FR-F02-005 — an organization always has at least one active owner, and a refused
  transfer leaves it untouched.
- **Severity:** MEDIUM. **Latent, not live**: the handler's `target.status != "active"` check runs first
  and prevents it today. It is recorded at MEDIUM rather than LOW because the safety lives entirely in
  one layer, one refactor away from an organization with no owner.
- **Verdict:** FAIL at discovery, PASS after repair
- **Discovered by:** sensitivity case **M4** of the FR-F02-006 proof, added to attack T4
- **Regression gap:** none; the M4 case is the regression test, and it now holds the owner in place

## Setup

- Alice is the sole active owner of an organization. Carol is invited, accepted, then **removed**.
- M4 removes one line: the handler's `if target.status != "active" { return membership_required }`.
- Alice then attempts a transfer of ownership to Carol's **removed** membership.

## Action

Remove the handler's active-target check and retry the transfer.

## Expected

The transfer is refused (Carol is not an active member), and **the organization's ownership is
untouched**.

## Actual

The transfer was refused — and the organization's sole owner had been demoted to `admin`.

Read out of the M4 run's own database, which is the evidence that matters here:

```
org_0c52e8f7c27f2e32ee0d52289bdff3bc
  alice-mumawjmnec2b@example.com | admin | active
  abel-mumawjmnec2b@example.com  | admin | active
  active owners: 0
```

**An organization with no owner at all**, produced by a request that was refused.

## Root cause

`TRANSFER_OWNERSHIP_SQL`:

```sql
UPDATE memberships
SET role = CASE
        WHEN membership_id = ?1 THEN 'owner'     -- the target, IF its row matches
        WHEN role = 'owner'      THEN 'admin'     -- every current owner, UNCONDITIONALLY
        ELSE role
    END, …
WHERE org_id = ?2 AND status = 'active' AND (membership_id = ?1 OR role = 'owner')
```

Three facts compose:

1. the demotion of the current owner is **unconditional** — the `CASE` has no eligibility test;
2. the promotion applies only to a row that matches the `WHERE`; and
3. the repository reports success when **any** row changed (`D1Adapter::changes(&result)? == 1`).

With an ineligible target, row 1 does not match, row 2 matches and is demoted, and row 3 sees one
change and calls it success. The transaction is atomic — it is the *decision* that is not.

## Why this is worse than the missing check it was found with

The refusal looked correct. T4's status assertion was satisfied, and every "was it refused" check in the
sheet was satisfied. Only reading the database showed the invariant gone.

This is the second half of a lesson the campaign has now stated twice from opposite directions:

> A status is evidence about the **request**. It is never evidence about the **state the request left
> behind**, and where the two can come apart, only the second one is the claim.

GAP-002 already forced the same distinction on the *read* side ("fail transactionally" cannot be
expressed in a status). V01-032 is the same gap on the *write* side: the request was refused and the
write still happened.

## Why it is latent, and why MEDIUM rather than LOW

`transfer_ownership` checks `target.status != "active"` before calling the repository, so the ineligible
target never reaches the statement in the current code. Nothing is exploitable today.

But `CHANGE_ROLE_SQL` and `REMOVE_MEMBERSHIP_SQL` **both** carry the "at least one active owner" rule in
their own `WHERE`:

```sql
AND ( role <> 'owner' OR ?3 = 'owner' OR (SELECT COUNT(*) … > 1) )
```

`TRANSFER_OWNERSHIP_SQL` was the only one of the three membership-mutating statements that did not. So
the guarantee FR-F02-005 states is enforced in the **database** for two operations and in a **handler**
for the third. A second caller, a reordering, or a future route that calls
`transfer_ownership` directly would silently produce an ownerless organization — and nothing in the
schema would object.

Recording it as LOW would say "this cannot happen". It can happen; one layer is holding it.

## Fix

An `EXISTS` on the target's eligibility, in the statement's own `WHERE`:

```sql
AND EXISTS (SELECT 1 FROM memberships AS target
            WHERE target.membership_id = ?1 AND target.org_id = ?2 AND target.status = 'active')
```

`?1` and `?2` are already bound, so **no placeholder and no bind is added** —
`pnpm schema:bind-count` stays **green**, which matters: a repair that changed the statement's shape
would have been a different and larger change than the defect needed. With the target ineligible the
statement now matches nothing, the owner is not demoted, `changes` is 0, and the handler's existing
`last_owner_required` refusal answers.

## Proof, from the stored state under the mutation

The same M4 mutation, before and after, read out of each run's own database:

| | `active owners` in Alice's org after a refused transfer to a removed member |
|---|---|
| before | **0** |
| after | **1** |

That is the claim. The refusal is unchanged; the state is not.

`verify:privilege-escalation`: **96/96, exit 0**. `pnpm check` exit 0, 1027 tests.
`schema:bind-count` exit 0. Evidence: `evidence/v01-032-pre-repair.txt`,
`evidence/v01-032-post-repair.txt`, `evidence/f02-006-sensitivity.txt`.

## What the case now proves, which is a different thing from what it proved before

Before the fix, M4 was detected — but by the *reason string* changing, not by any state assertion, and
the state assertion did not exist. After the fix, M4 is still detected (the handler's specific
`membership_required` answer is still load-bearing, and the probe still pins it) **and the organization
keeps its owner**. So the two layers are now independent, and the probe pins both:

- the handler check, by requiring the refusal to name the reason rather than merely exist, and
- the statement's guard, by T4's new stored-state assertion that the organization still has an owner.

A sensitivity case that keeps passing for a different reason is worth noticing; this one changed what it
was sensitive to, and the record says so rather than leaving "M4: DETECTED" to speak for both.

## Stated limits

- The mutation removes the handler check but keeps the statement's `EXISTS`, so this proof does **not**
  exercise the `EXISTS` being removed. The `EXISTS` is covered here only in the sense that M4 can no
  longer reach a bad state through the path that used to produce one. Removing the `EXISTS` as well would
  be the mutation that tests it directly, and it is not written.
- `active owners: 0` was read from a *local* D1 under a deliberately broken build. The invariant is not
  production-verified; it is verified that the statement no longer permits the state.
- Nothing here tests concurrent transfers — two owners transferring to two targets at once. The statement
  has no `state_version` compare-and-set, unlike the automation lease statement, so a lost update is
  conceivable and unattacked.
