# V01-043 — plugin quarantine is enforced everywhere and can be operated nowhere

- **Claim ID:** V01-043
- **Family:** Platform operations / plugin governance (a kill switch with no lever)
- **Severity:** **HIGH**
- **Status:** CLOSED — recorded before repair, updated with root cause, fix, and proof
- **Verdict:** FAIL → **PASS** (operable in both directions; enforcement still UNPROVEN)

## Claim

Plugin quarantine is the platform's control over a **vulnerable plugin version**. The enforcement is
live and thorough — `is_quarantined` is checked on four paths — and **there is no way to place or lift
a quarantine.** No route exists. The three repository methods that would do it have no callers.

A `security`-role staff member holds `StaffPermission::PluginQuarantine` and has nothing to exercise it
with.

## Setup

Every layer below the route exists and is correct:

| layer | evidence |
|---|---|
| permission | `StaffPermission::PluginQuarantine` → `"plugin.quarantine"`, assigned to `StaffRole::Security`, with a unit test asserting the pairing (`modules/staff.rs:926`) |
| schema | `plugin_quarantines` with `reason TEXT NOT NULL CHECK (length BETWEEN 1 AND 500)`, `engaged_by_staff_principal_id TEXT NOT NULL CHECK (length = 36)`, `engaged_at NOT NULL`, `lifted_at` nullable |
| SQL + repository | `insert_quarantine_statement`, `lift_quarantine_statement`, `list_quarantines` |
| **enforcement** | `is_quarantined` called at `routes/plugins.rs:304` (list), `:660` (get), `:852` (install), `:1179` (approval) — and `:849` comments that the check is re-run **at approval, not only at install** |

The schema **requires** a reason and a staff principal, so the domain models attribution exactly as it
does for kill switches. The design is finished.

**And `grep -i quarantine apps/api/src/app.rs` returns nothing.** No route.

The three methods are on the liveness check's reviewed list, untriaged — which is the point at which this
became a finding rather than a to-do item.

## Action

Two levels, because they are different claims.

**1. Operability.** With a legitimate `security`-role staff token: can a quarantine be placed? Can it be
lifted? Can the set be listed? Each graded on the **stored row**, because a `2xx` that ignored the
request would be correct and a row that says otherwise is a breach.

**2. The control itself.** Once a quarantine exists, a **non-privileged** staff role must be refused —
`PluginQuarantine` is assigned to `security` and not to `support`, `finance`, or `engineering`, so a
holder of one of those must not be able to quarantine or lift. Graded on stored state again: a `2xx`
that ignored the permission would be correct.

**3. Non-disclosure.** A refusal must not reveal whether a version is quarantined to a caller with no
right to know.

## Actual

There is no route. Quarantine state is computed, returned in a listing, and enforced on install and on
approval — and can never become true through the API.

## Why this is the worst instance of the class

V01-041's `deny_enrollment` had an affirmative branch and no negative one: the operator could act, in
one direction only. **This has neither branch.** The guard is evaluated on every path and no lever
exists on any of them.

The asymmetry is stark when stated plainly: the platform can *detect* that a plugin version is
quarantined, *report* it to a customer, and *refuse* to install it — and cannot *make* it so.

**ADR 0007** is explicit that this is a platform capability and deliberately not a customer one:

> Platform quarantine of a vulnerable plugin version is a kill switch, and is deliberately not an org
> policy a customer can grant or revoke.

So the authority is deliberately placed in staff hands, the permission is defined and assigned, and the
staff member holding it has no route. The one control whose entire purpose is to be operated by a human
during an incident is the one control a human cannot operate.

## Impact

- **No incident response.** A vulnerable plugin version is discovered; the platform has no API to
  quarantine it. The only recourse is a direct database write, which bypasses the audit trail, records
  no actor, and requires a human to know the table.
- **No false-positive recovery.** Had a version been quarantined by hand, there is no supported way to
  lift it — and a permanent quarantine is its own outage.
- **The permission is inert.** `PluginQuarantine` is granted to the `security` role and tested for, so
  the role model says this authority exists. A role model that grants an authority nothing can exercise
  is worse than one that omits it, because a reader concludes the control is covered.
- **Enforcement without a lever is untested enforcement.** The `is_quarantined` branches have probably
  never been true in any environment, so the code path a customer would hit during a real quarantine is
  the one path with no test.

## Root cause

The same shape as V01-041 and V01-040: **built completely, wired to nothing.** And as V01-042's record
observed, the class was already found once in this codebase — `dispatch_due_data_jobs`'s doc comment
describes it verbatim — fixed in one subsystem, and never swept for. The liveness check is what finally
swept it.

## Regression gap

- `is_quarantined` is called from four places, so the *check* looks well covered. **A test that exercises
  a predicate nobody can make true has not covered anything**, and nothing in the suite noticed that the
  predicate is constant-false in every environment.
- No test asserts that a **route exists** for a capability the permission model grants. The pairing
  test at `modules/staff.rs:926` asserts the permission belongs to the role — and says nothing about
  whether the role can do anything with it.
- The three repository methods have no callers, so the only coverage is over their SQL.

## Fix

Three routes under `/api/v1/internal/`, registered in `app.rs` in one block with the reasoning:

| route | method | permission |
|---|---|---|
| `/api/v1/internal/plugin-quarantines` | GET | `PluginQuarantine` |
| `/api/v1/internal/plugin-quarantines` | POST | `PluginQuarantine` |
| `/api/v1/internal/plugin-quarantines/{quarantine_id}/lift` | POST | `PluginQuarantine` |

`engage_plugin_quarantine` mirrors `create_kill_switch` deliberately: same permission shape, same
`engaged_by_staff_principal_id`, same required reason, same `engaged_at`, same idempotency-claim
position. `plugin_quarantines` was built with the same columns as `kill_switches` for exactly this
reason.

**Three routes, not one.** Adding only the engage lever would reproduce V01-041 exactly. A quarantine
that cannot be lifted is its own outage, and an operator who cannot see the set cannot judge whether a
lift is safe.

Two checks in the engage handler that are not decoration:

- **The version must exist.** `find_version` must return a row. Quarantining a version nobody published
  would create a row `is_quarantined` can never match — a control that looks real and does nothing,
  which is the exact shape of the finding.
- **`deny_unknown_fields`** on the body, so a stray key is a 422 naming the problem rather than a
  silently ignored field.

**One repository addition, and it was needed for a real reason.** `find_quarantine` did not exist. The
lift route has to tell `404` (no such quarantine) from `409` (already lifted), and
`LIFT_QUARANTINE_SQL`'s own `lifted_at IS NULL` guard only covers the second: **an `UPDATE` that matches
zero rows does not abort a D1 batch**, so without the read a lift of a *nonexistent* quarantine would
answer `201`. The batch's guard stays the authority on the transition; the read only classifies the
outcome, so the answer and the write cannot disagree.

## Four mistakes while writing it, each one a repeat of an earlier lesson

Recorded because the repeats are the finding.

1. **I invented `QuarantineRecord` when `PluginQuarantineRecord` already existed** at module level, and
   put the duplicate *inside* an `impl` block. I had read `list_quarantines`'s signature and not the
   type it returns. Then I gave the invented struct eleven columns, one of which (`version_number`)
   belongs to the version, not the quarantine. The existing record has nine and an `is_active()`
   accessor, which the lift route now uses instead of re-deriving `lifted_at.is_none()`.
2. **I invented `denial`**, which is a helper in `devices.rs`, not in `internal.rs`. Three call sites
   failed to resolve before I read the module's own error helpers — which are `kill_switch_error`,
   `staff_error` and `invalid_input`. A local `staff_denial` now sits beside them, and the comment says
   plainly that it is a *second* spelling of a shape `devices.rs` already has, which is a real cost.
3. **`prepare(...)` needs a `?` here.** I wrote the chain without it; `list_quarantines` two methods
   below has it.
4. **I registered the routes last, and clippy caught it.** With the handlers written but unrouted, the
   path constants and the body struct were reported as never used — dead code, correctly, because an
   unrouted `pub` handler in a `pub(crate)` module chain is unreachable.

**That last one is the new standing check doing its job on the same commit that added it.** The check
existed, and it flagged my own work within minutes of writing it.

## What this did NOT get covered, stated rather than implied

**The enforcement path is still unproven.** Driving it needs a quarantinable package **and** a published
version **and** an install attempt — a fixture no probe builds today, and `verify:path-id-tenancy`
credits `/plugins/{package_id}/install` for exactly that reason. So what is proven here is
**operability**: the three routes work, they are permission-gated, and the rows and audit events land.
That the customer-facing install path then refuses is the next piece, and it is the piece that makes the
control worth having.

## Regression proof

`security::repository_liveness` — the standing check this class produced. `pnpm check` exit 0, **1030
tests**, whole suite 0.99s.

**Sensitivity: M1, M2 and M3 all DETECTED**, exit 0 (`evidence/v01-liveness-sensitivity.txt`). **M3 is
new and it is about this finding's own check.** The check *documented* the rule that a stale review
entry must be refused and did not apply it — it computed the stale set, sorted it, and asserted nothing.
Then three entries went stale within the hour, because V01-043 wired the quarantine routes. A check
that describes a rule it does not enforce is worse than one that omits the rule, because a reader trusts
the prose. The rule is now enforced, and M3 — adding an entry for a function that does not exist —
proves the enforced version has teeth.

The three resolved entries are **kept** in the list with their resolution recorded, so the decision stays
visible rather than vanishing when a function gains a caller.

## Re-run after the fix

`pnpm check` exit 0, 1030 tests. `smoke:p08` 47/47, `verify:path-id-tenancy` 199/199,
`verify:staff-credential` 46/46, `verify:revoked-device` 36/36, `verify:privilege-escalation` 96/96.

The new routes are under `/api/v1/internal/` and carry no `{org_id}`, so no tenancy denominator moved —
`smoke:p08` counts org-scoped routes and reported no change, which is the right answer rather than a
convenient one.

## The aggregate, now that four instances are in

| # | capability | enforcement | lever |
|---|---|---|---|
| V01-040 | support grant use | not implemented | not implemented |
| V01-041 | enrollment denial | — | **added** |
| V01-042 | idempotency purge | — | **added** |
| V01-043 | plugin quarantine | enforced on 4 paths | **added, both directions** |

**Three of the four are the same defect, and one sentence covers all of them:**

> A capability was built completely — schema, SQL, repository method, and in two cases a unit test over
> its SQL — and wired to nothing. Fixing one instance did not close the class, because nothing asked the
> question. The repair is a check that asks it.
