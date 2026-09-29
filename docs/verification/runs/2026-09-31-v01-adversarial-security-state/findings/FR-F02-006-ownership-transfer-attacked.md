# FR-F02-006 — ownership transfer, attacked at the HTTP layer

- **Claim:** `f02` FR-F02-006 — owner transfer requires current owner authorization, an active target
  member, recent re-authentication, and a security/audit event.
- **Severity of the gap:** the claim was **UNPROVEN** over HTTP. No defect was found; that is the honest
  result, and it is stated as such rather than dressed up.
- **Verdict:** PASS
- **Attacked by:** the `ownership-transfer` class in `verify:privilege-escalation`
- **Sensitivity:** `evidence/f02-006-sensitivity.sh` — M1 detected, M2 detected, M3 a declared
  KNOWN MISSED

## Why this was worth attacking on its own

The four requirements are enforced in **four different places**, in this order:

| # | requirement | enforced by |
|---|---|---|
| 1 | current owner authorization | `authorize_org(.. Permission::OrgOwnershipTransfer ..)` |
| 2 | target is an **active** member of **this** org | `find_membership_by_id(&org_id, ..)` then a `status == 'active'` check |
| 3 | recent re-authentication | `consume_reauth(.. "ownership_transfer" ..)` |
| 4 | a security/audit event | `security_statement(.. "organization.ownership_transferred.v1" ..)` |

A pure function of (actor role, target status) would be correct and tell us nothing about the wiring —
and V01-003 already established in this codebase that a correct-looking unit test sat on top of a real
defect. So the attack is four requests plus a control.

## The attacks

| | request | answer | requirement |
|---|---|---|---|
| T1 | a plain **member** of org A transfers to an admin in org A | `403` | 1 |
| T2a | the **owner** of org A targets a membership that exists in **org B** | `404 resource_not_found` | 2 |
| T2b | the **owner** of org A targets a membership that exists in **neither** org | `404 resource_not_found` | 2 |
| T3 | the owner makes a valid-shaped transfer with **no re-auth grant** | `403 reauthentication_required` | 3 |
| **C** | the owner transfers to an **active member of their own org** with a **fresh grant** | **`200`** | all four |

The control is what makes the four refusals mean something: with the roles and the grant correct, the
same route answers 200, so the refusals are the rules rather than a route that refuses everything. After
the control the assertions are read from **D1**, not from the response —

- the stored roles moved: the target is now `owner`, the previous owner is now `admin` (which is what
  `TRANSFER_OWNERSHIP_SQL` specifies), and
- a `security_events` row with `organization.ownership_transferred.v1` exists, which is requirement 4 and
  the one thing no status code can attest to.

`verify:privilege-escalation`: **82/82, exit 0.**

## T2a vs T2b is the case worth having

The objective asks to *prove denial does not leak unintended existence*. Both refusals are non-2xx, so a
probe asserting "not 2xx" passes on either. The assertion here compares the two **answers** — status and
`details.reason` — and requires them to be identical. That is the difference between "it refused" and
"it refused without telling me anything."

And it is the only assertion that found the mutation:

> **M1, with the org filter removed from `find_membership_by_id`: T2a answers 409 and T2b answers 403.
> Both are still refusals. The route had become an existence oracle across tenants, and only the
> comparison saw it.**

A probe grading on "was it refused" would have reported 82/82 through that entire mutation. This is the
clearest instance in the campaign of a claim that lives in a *comparison* rather than in an outcome.

## Sensitivity: 2 detected, 1 declared KNOWN MISSED

| | mutation | result |
|---|---|---|
| M1 | `find_membership_by_id` stops filtering on `org_id` (bind kept) | **DETECTED** — by the non-disclosure assertion, T2a 409 vs T2b 403 |
| M2 | the re-auth guard in the handler no longer refuses | **DETECTED** — T3 answers `200 granted` |
| M3 | `TRANSFER_OWNERSHIP_SQL` stops filtering on `org_id` | **KNOWN MISSED — deliberately** |

Every mutation changes no placeholder and removes no bind, so `pnpm schema:bind-count` stays **green**
throughout. That is deliberate: the count check is blind to this class, and a mutation it could see
would not be testing this class.

### Why M3 is a KNOWN MISSED, and why that is the finding

`transfer_ownership` looks the target up with `find_membership_by_id(&org_id, ..)` and returns **404
before the UPDATE runs**. A foreign target therefore cannot reach `TRANSFER_OWNERSHIP_SQL` at all, so
removing that statement's `org_id` predicate changes nothing observable — the probe reports a clean
82/82.

That is not a weak mutation; it identifies **which statement carries the claim**. The handler's
org-scoped lookup is what enforces requirement 2 today, and the UPDATE's own `org_id` predicate is
defence in depth with no route exercising it. Recorded so a reviewer protects it knowingly: it is the
only thing standing between a future refactor that reorders those two steps and a cross-tenant
ownership write. Reporting M3 as DETECTED would be false, and dropping it would be the campaign's
recurring mistake of leaving an unexplained absence.

## Two fixture facts that decided whether this measured anything

**The re-auth grant is single-use, and it is consumed before the target is looked up.** So every attempt
gets its own `freshReauth()`. A block that reused one grant would have had every later attempt fail at
`reauthentication_required` — reporting a domain refusal for what is really a spent token. This is
V01-031's lesson from the other side: a fixture that reuses a consumed credential cannot tell a domain
rule from its own exhaustion.

**The grant fields are renamed on the way out, and the first run got this wrong.** `POST /account/reauth`
returns `{ grant_id, token }`; `TransferOwnershipRequest` declares `reauth_grant_id` and `reauth_token`.
Spreading the response produced a body missing two required fields, and **every** transfer in the block
answered 422 — including the control, which is what exposed it.

The danger was not the failing control. It was that **T1, T2a and T2b all "passed"** — each asserted
"not 2xx", and a 422 is not 2xx. Three refusals were being reported for a malformed body, measuring
nothing about tenancy. The fix that matters is a standing guard in the probe:

> **A 422 is a rejected request, not a refused one, and the cases now assert their status is not 422.**

This is the third time this campaign has had a malformed or mis-shaped request look like a working
refusal — after a `version: 0` guess (V01-031) and a truncated console read. The generalisation is the
one worth keeping: *an absence of success is not evidence of a rule*, and the fix is always to assert
the shape of the refusal, not merely its presence.

## Stated limits

- The attacks run in sequence on shared fixtures, so on a failing product an early grant contaminates the
  later ones — under M2, T3 succeeds and the control then fails because Mallory is already the owner. That
  is acceptable for a sensitivity proof (the run is red) but it means a single red row does not identify
  which requirement broke. Per-attempt re-seeding is the first change to make if this is ever graded
  per-attack.
- Requirement 2's **"active"** half is only attacked in the positive direction: the control's target *is*
  active, and T2's targets do not exist at all. A transfer to a **removed** member is not attacked, so the
  `status != 'active'` branch has no handler-level evidence. It has one in the `change_role` family and
  needs its own fixture here.
- Nothing asserts the **ordering** the spec implies — that re-authentication must be recent rather than
  merely present. `consume_reauth` enforces a TTL, and an expired grant is not attacked; T3 uses a grant
  that never existed, which is a weaker condition than a stale one.
