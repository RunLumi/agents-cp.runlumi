# V01-027 — a cross-tenant leak gate for the collection routes, and three verifier defects it exposed

## Status

**No product defect found.** 30 org-scoped collection routes were measured for cross-tenant leakage
and **none leaked**. The finding this record exists for is about the *verifier*: the gate took three
attempts to become trustworthy, and each failure mode is one this campaign has already paid for
elsewhere.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-TEN-009` (new) — *Org A's collection responses name nothing belonging to Org B* |
| **Setup** | a real Worker and fresh D1. **Two** organizations, each with a real owner, a real verified session and a real project. Bravo additionally has a real agent. Bravo's identifiers (org, project, user, agent) are read back **out of D1**, not taken from the create responses, and the set is asserted non-empty. |
| **Action** | authenticate as Alpha and `GET` each org-scoped **collection** route: 30 of them. Serialise the whole response body and search it for every Bravo identifier and for Bravo's email address. |
| **Expected** | no Bravo identifier anywhere in any body. |
| **Actual** | **exactly that.** 54/54, exit 0, 30 routes measured, 0 leaks. |
| **Evidence** | `evidence/v01-collection-sensitivity-run.log`, `evidence/v01-collection-tenancy.txt` |
| **Verdict** | **PASS**, and the gate is proven able to fail (below) |
| **Regression gap** | 7 routes are **not GET routes** and 2 have no fixture here; both sets are named with their status, and the coverage assertion fails the run if a new collection route is not added or credited |
| **Severity** | none for the claim |

## Why collections are a different attack, not more of the same

`smoke:p08` computes how many org-scoped routes have no handler-level cross-tenant evidence, and now
prints that set **grouped by shape**, because a count is not a work list. At the start of this round:

| shape | count | what proving it costs |
|---|---|---|
| one path id | 48 | a substituted identifier, and a real parent row per resource |
| **collection (no path id)** | **32** | **nothing but a request and a string search** |
| two path ids (nested) | 4 | both parents |

The 48 and the 4 are substitution attacks and belong with the substitution probes. The 32 are a
different claim entirely. For `/orgs/{org_id}/projects` there is **no request that should be
refused**, so "it answered 403" is not available as evidence, and a route that returns an empty list
has said nothing at all. The claim is narrower and sharper:

> **No identifier belonging to Org B may appear anywhere in the serialised body of Org A's
> collection.**

That catches precisely the failure the path-substitution probes **structurally cannot reach**. A
`WHERE` clause that forgot `org_id` produces a perfectly authorised `200` carrying another tenant's
rows — correct status, correct shape, wrong contents. `verify:filter-tenancy` already grades this way
for six filter routes by searching the serialised body; this gate applies the same method to 30 more,
driven by the router rather than by a hand-kept list.

## Three things the gate refuses to do

**1. It does not trust a static parse of `app.rs` to know which routes are GETs.** The parse decides
`isGet` by looking for `get(` in the route's method text, and it gets seven routes wrong: it believes
`/ownership-transfer`, `/billing/portal-session`, `/leave`, `/plugin-reports` and two adoption reads
are collections, and the product answers every one of them `405 Method Not Allowed`. Classification
is therefore taken **from the response**, and the static list is only the denominator that stops a
route being forgotten. This is "measure, don't read" applied to the probe's own instrumentation — the
parse is a guess about the product and the `405` is the product's answer.

**2. It does not report "no leak" for a route it could not exercise.** Two more answer `404` and
`422` because this probe has no fixture for that resource. They are named `NOT_APPLICABLE` with their
status, which is a different verdict from PASS. A leak gate that silently skips is exactly the
`verify:budget-concurrency` shape: 27/27 with nothing held.

**3. It does not pass on a body that names nothing.** A positive-match control requires the *same*
string search to **find** Org A's own project id in Org A's own `/projects` body. That establishes
"found nothing" means *absent* rather than *incapable*.

## The three defects this took to get right

### 1. The positive-match control could not fail — found by the sensitivity harness, minutes after I wrote it

M2 removes Org A's own project and requires the positive-match control to fail. **It passed.** The
control was:

```js
ownProjects.status === 200 && alphaNeedles.every((v) => ownBody.includes(v))
```

and **`[].every(..)` is `true`**. With the needle set empty, the control passed while proving
nothing at all. The `alphaNeedles.length > 0` term is now load-bearing.

This is the **sixth** vacuous pass this campaign has produced and the first one *caught in the act* by
a proof written for a different purpose — which is the only reliable way to find these. Nothing about
reading the control suggested a problem; the mutation found it in one run.

### 2. A harness that reported a real leak as a MISSED

M1 makes `AGENTS_PAGE_SQL` bind `org_id` but stop filtering on it. The probe did exactly the right
thing:

```
LEAK  /api/v1/orgs/{org_id}/agents -> 200 leaked org=org_8f1d…, project=prj_03ac…, agent=agd_32b6…
```

and its assertion failed. The harness printed **MISSED**, because the needle went through `grep -E`
and `{org_id}` is an interval metacharacter, and then again because the needle was built by
prepending `GET ` to a value that already contained it.

> **A harness that reports a detection as a miss turns a caught defect into a recorded gap.** It is
> worse than a harness that cannot detect, because the failure is invisible in the one place a reader
> looks — the verdict table — while the evidence of the detection sits three lines above it.

Matching is fixed-string now, and it requires a line beginning `FAIL`, because the same needles appear
on `PASS` lines in a green run.

### 3. A sensitivity case that asserted the wrong assertion

The first M2 removed Org A's project. The probe **did** detect it — but by the *needle* control,
which fires first, so the case graded MISSED. That is the same mistake as a control that asserts one
particular wrong answer, committed one level up: the case fails when the harness is wrong and passes
for the wrong reason when the harness is right. M2 now breaks the positive-match control's **own
search**, with every needle intact, which isolates the property under test.

## Sensitivity

`evidence/v01-collection-sensitivity.sh` — **exit 0, 2/2 detected**, baseline green first.

- **M1** — `AGENTS_PAGE_SQL`'s `WHERE org_id = ?1` becomes `WHERE ?1 = ?1`. The bind stays and stays
  bound, so the statement remains valid and only the scoping goes: the realistic form of the
  regression, and the one a reviewer would actually merge. **DETECTED**, with the three leaked
  identifiers named.
- **M2** — the positive-match control's search is broken, every needle intact. **DETECTED**, which is
  the only way to show a control is a control rather than decoration.

The harness also carries an **anti-vacuity guard on itself**: neither detection needle may appear on a
`FAIL` line in the green baseline, or every mutation would be graded `DETECTED` for free. That guard
fired on its first run — correctly, because the needles were appearing on `PASS` lines and the
matching was not yet line-anchored — which is the second time in this campaign that a guard written to
catch a false PASS caught a real defect instead.

## The claim that is now measured, and what is still not

**Measured:** 30 of 32 org-scoped GET collection routes, searched for 4 Bravo identifiers plus
Bravo's email, with a positive-match control and a runtime method classification. Seven routes the
static parse mislabelled are named and excluded as `405`; two are `NOT_APPLICABLE` with their status.

**Not measured, and named rather than counted away:**

- the **48 one-path-id** routes — substitution attacks needing a real parent row per resource;
- the **4 nested** routes — needing both parents;
- the 2 `NOT_APPLICABLE` collections, which need a subscription and a query parameter respectively.

`smoke:p08`'s headline therefore moves from "80 of 104" to a set whose composition is known and whose
next 48 are the substitution work already covered for six families by `verify:filter-tenancy`,
`verify:mutating-tenancy` and `smoke:p08` itself. The remaining gap is smaller and better specified
than it was, and it is the *shape* of the gap that changed — from a number to a work list.
