# V01-003 — an admin can mint unlimited co-owners, bypassing the security-check-gated ownership transfer

## Status

**closed** — repaired, the original attack re-run unchanged, four mutations detected

## Severity

**critical.** Privilege escalation from `admin` to `owner`, available to every admin in every
organization, defeating both a separate permission and a step-up security check.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-ESC-001` (new — the V00 matrix carries no client-privilege-escalation claim; this family had **no runtime attack at all**) |
| **Setup** | real `wasm32` Worker, fresh local D1 with all 21 migrations, three real signed-in users and two real organizations. Org A: **Alice** (owner), **Mallory** (plain `member`), **Abel** (`admin`). Org B: Bob (owner), with his own service account. Real project, budget and service accounts exist as attack targets. |
| **Action** | 19 attacks across 7 classes, every one read back from D1: org, role, budget, capability, model, credential-id, policy-version. The two that escalated were `PATCH /orgs/{org}/members/{id}` with `{"role":"owner"}`, issued by **Abel, an admin** — once against Mallory (a plain member) and once against Abel himself. |
| **Expected** | an admin cannot create an owner. Becoming an owner is a *transfer*, gated on `org.ownership_transfer` plus a recent security check. |
| **Actual** | both requests answered **200**, and Org A ended the run with **three active owners**: Alice, Mallory (was `member`), Abel (was `admin`). |
| **Evidence** | `evidence/v01-003-escalation-reproducer.txt`, `evidence/v01-003-three-owners.txt` |
| **Verdict** | **FAIL — product defect.** Not a verifier problem, not a spec ambiguity. |
| **Regression gap** | a Rust unit test on the decision, plus the probe attack itself, which must be re-run unchanged |
| **Severity** | critical |

## The stored state, read from D1

```
             email                role   status
--------------------------------  -----  ------
alice-mul6319wa4z7@example.com    owner  active
mallory-mul6319wa4z7@example.com  owner  active     <- was `member`
abel-mul6319wa4z7@example.com     owner  active     <- was `admin`
```

## Root cause: the authorization decision never sees the requested role

`change_role` authorizes with three arguments:

```rust
// apps/api/src/routes/organizations.rs:946
if !crate::modules::memberships::can_change_role(
    actor_role,                                                   // Abel: Admin
    crate::modules::authorization::MembershipRole::parse(&target.role)
        .unwrap_or(crate::modules::authorization::MembershipRole::Viewer),   // Mallory: Member  <-- CURRENT
    crate::modules::authorization::MembershipStatus::parse(&target.status)
        .unwrap_or(crate::modules::authorization::MembershipStatus::Removed),
) {
```

and the function it calls is:

```rust
// apps/api/src/modules/memberships.rs
pub fn can_change_role(
    actor_role: MembershipRole,
    target_role: MembershipRole,
    target_status: MembershipStatus,
) -> bool {
    target_status == MembershipStatus::Active
        && matches!(actor_role, MembershipRole::Owner | MembershipRole::Admin)
        && (actor_role == MembershipRole::Owner || target_role != MembershipRole::Owner)
}
```

**The requested role is not an argument.** `body.role` — parsed into `role` on the line
above, validated, and then handed straight to `repository.change_role(...)` — never
participates in the authorization decision. The guard is evaluated as
`can_change_role(Admin, Member, Active)`, in which the third clause is trivially true.

So the only owner protection the function provides is "an admin may not **re-role somebody
who is already an owner**". It provides nothing at all against **creating** an owner. The
same predicate in `can_remove_member` is correct there, because for removal the target's
*current* role is genuinely the right thing to ask about — which is exactly why the
mis-wiring is invisible on inspection and why the two call sites read alike.

## Why this is an implementation defect and not a spec gap

The requirement is not in `f03` — no MUST there says who may assign `owner`. But the
product's own design answers it, three times over, and no interpretation is required:

1. **`org.ownership_transfer` is a separate permission from `members.manage`.**
   `change_role` requires `Permission::MembersManage`. `transfer_ownership` requires
   `Permission::OrgOwnershipTransfer`. Two permissions for two different operations is a
   statement that they are not the same operation.

2. **The transfer route additionally demands a step-up check.** It returns
   *"Complete a recent security check before transferring ownership."* A capability that
   the product deliberately protects with a fresh security check is not one an admin
   should be able to reach by sending a different HTTP request with a different body.

3. **`role_can_be_invited` refuses `owner` outright** — for *every* actor, owner included.
   The product's position is that `owner` is not an assignable role. `change_role` is the
   same assignment path, and it is the one route where that position is not enforced.

Taken together: owner is **transferred**, never **assigned**. The transfer route's consent
and security-check semantics exist for a reason, and `change_role` walks straight past all
of it.

## Impact

- Any `admin` in any organization can create as many co-owners as they like, at will.
- An `admin` can promote **itself** to owner, which is a complete takeover of an
  organization from its owner.
- The step-up security check on `transfer_ownership` is bypassable, so a stolen admin
  session becomes a stolen organization.
- The audit trail records `membership.role_changed.v1` — an ordinary role edit, not an
  ownership transfer — so the escalation does not look like one in the log either.

## The probe had a gap too, and closing it is what found this

The first version of the probe used only a plain `member` as the attacker, and reported
**16 refused, 0 escalated** — which was true and worthless. The sensitivity proof then
mutated the two domain rules and **neither mutation changed the result**:

```
M1 owner invitable:          MISSED
M2 member may change roles:  MISSED
M3 budget PATCH needs only read: detected
```

The reason is defence in depth: a plain member is refused by
`authorize_org(Permission::MembersManage)` before `can_change_role` is ever called. So the
domain rules were **unexercised**, and a probe reporting on them was reporting on nothing.

An `admin` passes the route check and is still bound by the domain — which makes the admin
the attacker that reaches the second layer. The moment the probe grew a second attacker,
the defect was found. This is the `smoke:p08` lesson at a different layer: *a route that
refuses everyone proves the route's check, and says nothing about the check behind it.*

## Repair, and why the signature changes

The requested role has to become an argument, so the compiler forces every caller to supply
it. Adding a parameter the route could again pass the wrong thing is not enough; renaming
the existing one is, because it makes the previous mistake a type error at the call site
rather than a silent wrong answer.

```rust
pub fn can_change_role(
    actor_role: MembershipRole,
    target_current_role: MembershipRole,
    target_status: MembershipStatus,
    requested_role: MembershipRole,
) -> bool {
    target_status == MembershipStatus::Active
        && matches!(actor_role, MembershipRole::Owner | MembershipRole::Admin)
        && (actor_role == MembershipRole::Owner
            || (target_current_role != MembershipRole::Owner && requested_role != MembershipRole::Owner))
}
```

The existing meaning is preserved — an admin still cannot re-role an existing owner — and
the missing rule is added: an admin cannot *create* an owner. The route passes both roles.

`_` the owner actor keeps full authority, so the transfer path and the last-owner rules are
untouched.

### Regression proof, at the cheapest correct layer

The domain function is the cheapest layer that can express this, so it gets a unit test
that fails on the current signature and passes on the new one — including the case the
current function gets **wrong by accident**:

```rust
#[test]
fn an_admin_cannot_create_an_owner() {
    // The requested role is `owner`; the target is currently a plain member.
    assert!(!can_change_role(
        MembershipRole::Admin, MembershipRole::Member, MembershipStatus::Active,
        MembershipRole::Owner,
    ));
}

#[test]
fn an_admin_still_cannot_re_role_an_existing_owner() {
    assert!(!can_change_role(
        MembershipRole::Admin, MembershipRole::Owner, MembershipStatus::Active,
        MembershipRole::Member,
    ));
}

#[test]
fn an_owner_may_still_change_any_active_members_role() {
    assert!(can_change_role(
        MembershipRole::Owner, MembershipRole::Owner, MembershipStatus::Active,
        MembershipRole::Member,
    ));
}
```

The probe is the second layer and must be re-run **unchanged** — the same 19 attacks, the
same assertions — and must report 0 escalated. Then the sensitivity script is re-run, and
M1 and M2 must now be *detected*, because with the admin attacker they are finally
reachable.

## Closure evidence

### The repair

`can_change_role` now takes the requested role, the parameter is renamed so the previous
mistake is a type error at the call site, and the route passes both roles. The only
behavioural change is that a non-owner admin may no longer **create** an owner; an owner
retains full authority, and an admin may still set `admin`, `member` or `viewer`.

### Regression proof, at the cheapest correct layer

Eight unit tests in `apps/api/src/modules/memberships.rs`, six of them added for this
finding. `an_admin_cannot_create_an_owner` is the regression itself and **fails on the old
three-argument function** — it cannot even be written against it, which is the point of
changing the signature. The others pin the behaviour the repair must not have broken:
an admin may still manage roles up to `admin`; an owner may still change any active member's
role including to owner; an admin still cannot re-role an existing owner; a non-admin actor
is refused for every requested role; an inactive target cannot be re-roled by anyone.

```
running 8 tests
test modules::memberships::tests::an_admin_cannot_create_an_owner ... ok
test modules::memberships::tests::an_admin_may_still_manage_roles_up_to_admin ... ok
test modules::memberships::tests::an_admin_still_cannot_re_role_an_existing_owner ... ok
test modules::memberships::tests::an_inactive_target_cannot_be_re_roleed_by_anyone ... ok
test modules::memberships::tests::an_owner_may_still_change_any_active_members_role_including_to_owner ... ok
test modules::memberships::tests::a_non_admin_actor_is_refused_for_every_requested_role ... ok
test modules::memberships::tests::last_owner_cannot_be_demoted_removed_or_leave ... ok
test modules::memberships::tests::only_non_owner_roles_can_be_invited ... ok

test result: ok. 8 passed; 0 failed
```

### The original attack, re-run unchanged

The same 19 attacks, the same bodies, the same assertions:

```
19 privilege-escalation attacks across 7 classes: org x3, role x8, budget x2,
  capability x2, model x2, credential x1, policy-version x1
  refused 19, accepted-but-inert 0, escalated 0
  status distribution: 403 x14  422 x5

46/46 V01 privilege-escalation cases hold
```

And Org A's memberships, read from D1 after the run:

```
             email                 role
--------------------------------  ------
abel-mul67uuo56v5@example.com     admin
mallory-mul67uuo56v5@example.com  member
alice-mul67uuo56v5@example.com    owner
```

One owner, as there was before the attack. Before the repair this read `owner / owner /
owner`.

The four escalations became four `403`s. Nothing about the attack changed; only what the
server does with it.

### Sensitivity — `evidence/v01-003-sensitivity.sh`, all four detected

| | mutation | targeted attack | clean → broken |
|---|---|---|---|
| **M1** | `role_can_be_invited` allows `owner` | admin invites as owner | `422 REFUSED` → `409 REFUSED` |
| **M2** | route needs only `MembersRead` **and** the domain accepts a `Member` actor | member promotes itself to admin | `403 REFUSED` → `200 ESCALATED` |
| **M3** | budget PATCH needs only `BudgetsRead` | member raises the budget | `403 REFUSED` → `200 ESCALATED` |
| **M4** | `change_role` authorizes on the target's **current** role — the V01-003 defect verbatim | admin promotes itself to owner | `403 REFUSED` → `200 ESCALATED` |

M4 is the one that matters: it re-introduces this exact defect and the probe reports the
escalation. The repair is load-bearing, not cosmetic.

**How a case is graded, and why that changed.** The first version graded each case on one
hand-picked assertion, and two of four read `MISSED`. Neither miss was a weak probe:

- M1 does not escalate, because `invitations` carries its own
  `role IN ('admin','member','viewer')` CHECK. The request travels one layer further and
  the database stops it — visible as `422` → `409`, invisible to an escalation assertion.
- Weakening the route's permission alone does not change anything: an admin already holds
  `MembersRead`, and a member who now reaches `can_change_role` is still refused by it.

So each case now declares the attack it targets and is graded on **whether that attack's
observed behaviour changed** against a baseline measured in the same invocation. A case
graded on a single assertion reports `MISSED` for a real change; a case graded on "anything
failed" reports `DETECTED` for an invisible one.

M2 needed **both** layers weakened, and that is the honest shape of it: the route check and
the domain rule are independent, and a single-layer weakening of the lower one is not
reachable through HTTP. Which is also why the domain rules are proven by unit tests — where
a single weakening *is* visible — rather than by this probe. A probe cannot observe what
two layers of defence absorb between them.

### Two defects the sensitivity harness had, both of which left the product broken

Recorded because a sensitivity harness that can leave a fault in the tree is worse than one
with no sensitivity proof at all.

1. **`$SNAP` was never created.** The script did `mkdir -p "$WORK"` and then `cp` into
   `$WORK/snapshot`, which did not exist. Every `cp` failed, every restore was a no-op, and
   **three deliberate faults stayed compiled into the working tree** across a run that
   reported grades for them. The script printed `RESTORE FAILED` — correctly, and visibly —
   and the tree still carried the faults.
2. **The restore check compared against `HEAD`.** The V01-003 repair is itself an
   uncommitted change, so "differs from `HEAD`" cannot tell "the restore failed" from "the
   repair is present". It reported `DIRTY` on a correct tree and I read the
   `git diff --stat` line count as "just the repair" **without checking**, which is how M1's
   leftover mutation in `memberships.rs` survived into a later baseline.

Both are fixed: the snapshot directory is created and its size verified before anything
runs, the restore is checked against the snapshot rather than `HEAD`, and a content check
(`product_is_clean`) now fails the run if the product is not in the state the script found
it in. That check asserts the specific invariant — `role_can_be_invited` refuses owner, the
V01-003 comment is present, the budget PATCH requires `BudgetsManage` — rather than trusting
a line count.

**A limit worth stating explicitly, because it looks like the check's job and is not.**
`buildFreshness()` said `PASS` on that contaminated run: the artifact genuinely was built
from the source on disk. The source was simply wrong. Build freshness proves the artifact
matches the tree; it cannot tell you the tree is correct. Those are different properties and
only the second one is a reviewer's job.

### Broader gates, on the repaired tree

| gate | result |
|---|---|
| `pnpm check` | exit 0 — 1001 Rust tests, 9 JS, clippy `-D warnings`, `wasm32-unknown-unknown` check |
| `pnpm verify:privilege-escalation` | 46/46, exit 0 |
| `pnpm verify:adoption-privacy` | 20/20, exit 0 |
| `pnpm smoke:p02` | exit 0 — `{"ok":true,…,"owner_membership_id":"mem_…"}` |
| `pnpm smoke:p03` | exit 0 |
| `pnpm smoke:browser` | see `evidence/v01-003-browser.txt` |

### What is still open, and is a real gap

- **`smoke:p08` does not cover this route.** `change_role` is org-scoped and mutating, and
  the V00 record's §7 gap covers org-scoped routes with *no handler-level evidence*. This
  probe now supplies that evidence for `change_role` only.
- **The admin role has no other runtime coverage.** `viewer` and `member` are exercised here
  and in `smoke:p02`; an `admin` actor — the one that found this defect — is exercised only
  by this probe. Any future admin-only path needs the same treatment.
- **The last-owner rules are untested at the HTTP layer.** `f02` requires that removing or
  demoting the last owner fails transactionally, and `can_leave` is unit-tested. Whether the
  *route* refuses a second owner leaving is not attacked by any probe. Recorded as
  GAP-002.
