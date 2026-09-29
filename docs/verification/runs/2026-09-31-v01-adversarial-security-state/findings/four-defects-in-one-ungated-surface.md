# Four defects in one ungated surface — `/api/v1/internal/**` has never worked

- **Record type:** campaign finding (the parent of V01-034, V01-035, V01-036, V01-037)
- **Verdict:** four FAILs found, four fixed, four closed
- **Severity of the aggregate:** **CRITICAL** — the platform could not arm a kill switch, roll a
  feature flag, or audit its own actions, and the authentication protecting that surface did not
  check the credential it was given

## The claim, stated once

A single platform surface — the four `/api/v1/internal/**` write routes — carried **four independent
defects at the same time**, stacked, in the same few functions, and **no gate anywhere in the
repository touched it**. The route answered `503`, which is what a transient store fault looks like,
so nothing distinguished "broken since it was written" from "temporarily unavailable".

## The four, in the order the request reaches them

| # | defect | where it fires | symptom |
|---|---|---|---|
| V01-036 | `OrganizationId::new("")` — the empty organization the schema *defines* is not a valid id | before any statement is prepared | `503` |
| V01-035 | `actor_type = 'staff'` violates `security_events`' CHECK | inside the batch | `503` |
| V01-037 | `event_id` built as `evt_` for a column requiring `sec_` | inside the batch | `503` |
| V01-033 (6th) | `vec![lift, guard]` — the guard is handed the version the lift already replaced | inside the batch | `409` |

All four are `50`-line functions in one file, and the ordering matters: **the outermost defect masked
the other three.** V01-036 fires before a statement is prepared, so V01-035's CHECK violation and
V01-037's id violation were both *unreachable* until it was fixed. Three repairs to one route
produced no observable change, which is what finally made "this is not one bug" the only hypothesis
left.

## And the surface's authentication did not check anything

**V01-034** is separate and worse: `require_staff` resolved a presented `lumi_staff_` token by its
16-hex **lookup prefix** and never compared the presented secret against the stored
`credential_hash`. Any well-formed `lumi_staff_<known-prefix>_<any-43-char-base64url>` authenticated
as the principal owning that prefix. The two refusals also *differed* — a wrong secret answered
`200`, an unknown prefix `401` — so the endpoint was an existence oracle for staff principals as
well as an unauthenticated one.

So the honest summary of this surface before the repairs: **the platform's internal control plane
was reachable with a guessed prefix, and even with a correct credential it could not do anything.**

## Why nothing caught it — the four reasons, each a lesson about coverage

1. **No gate drives `/api/v1/internal/**`.** It is staff-authenticated and no probe could mint a
   staff principal, because the minting path is a `staff_principals` row and nothing wrote one. A
   route family with no gate does not fail once; it fails four times over and reports one symptom.
2. **Reads work.** `list_flags` answers `200` to the very token that cannot write, so a probe that
   *reads* the surface sees a healthy family.
3. **The failing status is `503`.** Every one of these is reported as a store fault, so the correct
   operator response — retry — is also the wrong one, and a permanently broken route presents as an
   intermittently flaky one.
4. **`'support'` sits in the CHECK list.** It reads like the staff value. A reader — human or model —
   auditing "is there a staff actor type?" finds one.

## What the campaign got wrong, and it is the more useful half

**Four repairs, and the first three were each incomplete, because the localisation method was
unsound in a way that is easy to miss.**

V01-035's record states the batch "commits successfully in the database". **That was wrong.** To
localise it I reproduced the batch by hand, in one transaction, against a copy of the probe's own
database — and **hand-wrote every id**. The product writes an `evt_` id; I wrote a plausible `sec_`
one. My reproduction was faithful in *shape* and wrong in *value*, so it agreed with a batch that
cannot commit.

> When reproducing a statement by hand to find a cause, every value must come from the product's own
> generator. A plausible value is a guess, and a guess that happens to be valid tests a statement the
> product never sends.

The same flaw sits one step earlier. V01-035's two-variable experiment held `actor_type` as the only
variable and varied it, which correctly established that `'staff'` is refused — and never asked
whether the *rest* of the statement was valid. **A two-variable experiment proves the variable
matters; it does not prove nothing else does.**

Three compounding harness faults turned that into five wasted repairs:

- `commit_scoped_mutation` **has** been reporting SQLite's own message through `report_error` since
  an earlier round — and the harness printed the Worker's log only on a **bail**. A failing case is
  not a bail. So the cause was available and unreachable simultaneously, and the sheet said "the
  route is broken" five times. **A verdict with no cause is the same failure as a verdict with no
  evidence.**
- The original V01-033 sweep looked for `vec![update, guard]` and `vec![statement, guard]` — four
  **variable names**. `vec![lift, guard]` could not match. **A scan over a naming convention is a
  scan over a convention.**
- `verify:filter-tenancy` is named `V01 filter/pagination/nested`, and the harness put the probe name
  into a filesystem path, so the **documented command could not start at all**. It had a recorded
  65/65 baseline and four detected mutations because its sensitivity script exports
  `V01_FILTER_PERSIST_TO` and takes a different branch. A gate that only runs when an undocumented
  environment variable is set provides no evidence to anyone who follows the documentation.

## Standing coverage this bought

| check | what it now catches | proof |
|---|---|---|
| `security::actor_type_correspondence` | a hard-coded `actor_type` the ledger refuses, matched by **position** in the INSERT's `VALUES` tuple — the shape that hid V01-035 | `evidence/v01-035-actor-type-sensitivity.sh`, M1 (the writer) and M2 (the ledger) both DETECTED |
| `verify:staff-credential` | a forged staff secret, and all four internal writers, driven with **legitimate** and **forged** credentials in one run | 22/22, and the four assertions per case are the same shape `verify:path-id-tenancy` uses |
| the harness | a failing case with no printed cause | the `finish()` change; the sheet now names the SQLite error |

The V01-035 check has a stated limit, in the file and not only here: three of the four sites in this
repository **bind** `actor_type` rather than hard-coding it, and a static scan cannot follow a bind.
Its power is exactly "a hard-coded literal the schema refuses" — a real class, not a general proof,
and it counts the binds it could not grade so the sheet never implies coverage it does not have.

## The generalisable finding

**A surface can be simultaneously non-functional and unverified, and the two facts reinforce each
other.** The absence of a gate is not merely a missing test; it is the *mechanism* by which four
defects coexist in fifty lines of code, and the reason the first one's fix appeared to change
nothing.

The general shape is: **when a repair to a route produces no observable change, that is evidence
about the localisation, not about the repair.** Three of the four conclusions in this round were
wrong in exactly that way, and in each case the instrument — a hand-written reproduction, a
two-variable experiment, a name-based scan — was the thing at fault rather than the product.

## Closure evidence

`verify:staff-credential` **9/19 with 2 skipped → 22/22 with 0 skipped**, exit 0, the probe
unchanged across the repair except for three *probe* fixes recorded in the file. Pre-fix sheet:
`evidence/v01-staff-credential-pre-fix.txt`. Post-fix: `…-post-fix.txt`.

Re-run after the repairs, none of it concurrent:

```
pnpm check                            exit 0, 1029 tests
verify:staff-credential               22/22
verify:idempotency                    47/47     (prepare_scoped_mutation serves 31 call sites)
verify:path-id-tenancy               198/198
smoke:p08                             47/47
verify:privilege-escalation           96/96
verify:secret-tenancy                 32/32
verify:budget-concurrency             28/28
verify:lease-contention               62/62
verify:filter-tenancy                 65/65     (from the documented command, which never ran before)
verify:collection-tenancy             54/54
verify:mutating-tenancy               43/43
p08:invariants                        17/17
guard:probe                           15/15
verify:restore                         6/6      (the rebuild kept both immutability triggers)
schema:bind-count                     462 prepare() calls clean
verify:migration-prior-state          exit 0   (0022 applies to a POPULATED security_events)
```

Sensitivity for the new standing check: `evidence/v01-035-actor-type-sensitivity.txt`, **2
detected, exit 0** — after four harness bugs in the proof itself, each of which had silently
converted a real detection into a no-verdict. Those four are catalogued in the script's header,
because a sensitivity harness that cannot report a detection is worse than none: it looks like
coverage.
