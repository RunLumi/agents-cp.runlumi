# verify:path-id-tenancy — the 48 one-path-id routes, and a gate that was measuring its own control

- **Claim:** for every org-scoped route taking exactly one resource id, another organization's id is
  refused, the refusal does not distinguish "exists elsewhere" from "exists nowhere", and the other
  organization's row is untouched.
- **Verdict:** PASS for 13 routes, **every assertion at full strength** · credited by name for the remaining 41
  for the remaining 39
- **Sensitivity:** `evidence/v01-path-id-sensitivity.sh` — **M1 detected, M2 declared KNOWN MISSED, exit 0**
- **Discovered while building it:** one probe defect that would have produced a falsely clean sheet on
  most routes, and one general harness defect

## Why these routes needed their own gate

`smoke:p08` reports org-scoped routes with no handler-level evidence, grouped by shape. The largest group
was 48 routes taking **exactly one resource id**, and they were unreachable by the gates that existed:

- a **collection** route has no request that should be refused, so a substitution cannot reach it
  (`verify:collection-tenancy`'s subject);
- a **nested** route needs both a parent and a child;
- a one-path-id route's whole tenancy claim is reached by **substituting the id**, and nothing else.

And the claim is two claims that look like one:

> A substitution defect and a non-disclosure defect are the **same observation**. A scoped lookup that
> forgets `org_id` returns **404**, which is exactly what a request for an id that exists nowhere
> returns. Only a probe that asks for a phantom can tell them apart.

## Four assertions per route

| | assertion | what it rules out |
|---|---|---|
| 1 | **CONTROL** — the organization's OWN id is answered **2xx** | a route that refuses its own resource, which makes every refusal below vacuous |
| 2 | **ATTACK** — the other organization's id is refused | the claim itself |
| 3 | **NON-DISCLOSURE** — a well-formed id existing NOWHERE answers **identically** | an existence oracle across tenants |
| 4 | **STORED** — the other organization's row is byte-identical afterwards, read from D1 | a refusal that changed something anyway |

The control is asserted at **full 2xx strength**, not "not 5xx", because "not 5xx" passes for a route
that answers 404 for its own resource. V01-030 is what that costs: six cross-tenant rows reporting `PASS`
for a route its own owner could not use.

**Result: 162/162, exit 0, 45 named skips.** `smoke:p08`'s unproven count moved **69 → 60** and
stayed 47/47.

## The defect this gate had in its first form: it was replaying its own control

The single most consequential thing in the file, and it is not a product defect.

All three requests originally shared **one `Idempotency-Key`**. On an idempotent route the control claims
the key and stores *its own* response, and the attack and the phantom then receive `Ok(replay)` — the
control's `200`, verbatim, body and all. `resume` showed it exactly:

```
ATTACK  /service-accounts/{service_account_id}/resume  →  200 {"service_account_id":"svc_e8b006d…"}
```

`svc_e8b006d…` is **Alice's own** account, because that is what the control had stored. Bravo's row was
untouched, the stored-state assertion passed, the non-disclosure comparison passed, and the sheet said
**granted**.

A replayed `2xx` is indistinguishable from a granted `2xx` by status, by body, and by a stored-state
assertion that correctly finds nothing changed. V01-009 counted 81 idempotency call sites, so **most of
this gate's routes were being measured against their own control**, and the fix is one label per request:

> **An attack that reuses the control's idempotency key is not an attack.**

This is the campaign's recurring failure in its purest form — a silent pass — and it was found because the
gate insisted its controls work and would not let a red control be papered over. It is also the third
distinct mechanism by which a replay has nearly cost this campaign a finding, after a spent re-auth grant
and a stored read-back.

## The phantom was malformed, and that read as an existence oracle

The phantom has no row, so a version looked up **for it** falls back to `0`, and `version: 0` is a `422`.
The first version produced `foreign=200 phantom=422`, and the non-disclosure assertion reported an
existence oracle — when the only thing that differed between the two requests was a field neither should
have carried.

The fix is experimental design, not a patch: **the phantom is sent the attack's body, byte for byte**, so
the two requests differ in exactly one thing, the id. The campaign has now paid for this three times — a
`whe_` + 26-zeros phantom against a 32-hex id, a 422 from two mis-named re-auth fields, and this — and
the rule is always the same: *a phantom that is malformed is not a phantom, and a refusal that is
malformed is not a refusal.*

## A general harness defect: a refused query was an empty result set

`wrangler d1 execute --json` reports a statement D1 **refused** as `{"results": [], "success": false,
"error": {...}}` — and for at least one invocation still exits `0`, so `runWrangler` did not throw. So
`d1Rows` returned `[]` and a probe read it as *there is no such row*.

The invitation fixture spent a run that way: it asked for a `version` column that `invitations` does not
have, the statement was refused, and the probe reported `A=undefined` for a row `wrangler` returned a
moment earlier. `parseD1Json` now **raises** a refused statement, for every probe in the repository:

> An instrument that reports an absence it did not measure is the failure this campaign keeps meeting in
> a new place.

And the sibling bug in the same fixture is the purest version of it:

```js
d1Rows(`SELECT …`)[0]     // d1Rows is ASYNC
```

`Promise[0]` is `undefined` — no exception, no warning, and a fixture reporting "there is no row" for a
row that existed. An expression that evaluates cleanly and yields nothing is the hardest kind of emptiness
to see, because nothing reports it.

## Three UNPROVEN items, and all three were this file's fault

Recorded in full because **none of them was a product defect**, and the two mechanisms are the
campaign's recurring failure wearing new clothes. All three are resolved and **no entry carries a
degraded control any more.**

**Two were real, and the gate's control is what proved it — V01-033.** `service-accounts/{id}` PATCH and
`/suspend` answered `409 version_conflict` on the organization's OWN record at the version D1 had just
reported. The batch was `vec![update, guard]`: the update sets `version = version + 1` and the guard then
asserts the row is still at the pre-write version, so it always aborted. **The routes could never
succeed**, and they reported a concurrency problem. Proved with a two-order experiment on a copy of the
real database and fixed by putting the guard first — the order 26 of the 33 version-guard batches already
use. See the V01-033 record.

**One was this file's own ordering.** `credentials/{id}/rotate` answered `404` for a credential D1 showed
as user-owned in the same organization. The credential's `status` was `'revoked'` — because **the revoke
control had just revoked it**, and `find_credential_for_owner` filters `status <> 'revoked'`. The rotate
control was measuring the revoke control's success.

Reordering the controls would not have fixed it: the destructive one is still destructive wherever it
sits. **Every control now creates its own row**, so the controls are independent by construction rather
than by luck of ordering. That is the same defect as the shared `Idempotency-Key`, one layer up:

> **A control that shares mutable state with the next case is measuring the previous case.**

With a fresh row, `rotate` answered `422`: `RotateCredentialRequest` declares `label` and `secret` both
optional, so `{}` parses and the route then refuses — because a rotation without a new secret is not a
rotation. Optional in the struct, required in the handler; a real contract wrinkle, named rather than
worked around.

The markers were **removed** rather than left behind, both times:

> A degraded check that no longer needs degrading is a check quietly under-claiming, which is the same
> failure in the opposite direction.


## A structural finding about sessions, credited with a question rather than a shrug

`login_sessions` has `user_id` and `device_label` and **no `org_id`**. The `{org_id}` in
`/orgs/{org}/sessions/{session_id}` scopes *whose* sessions you may see rather than owning the row, and
the list route returns only **device** sessions — the caller's own password session is not among them.

So the substitution is real but on a **different axis** — "Alice closing *Bob's* session", not "Alice
addressing Bravo's session" — and both session paths are credited with the *design question* rather than
"not yet": **is `close` scoped to the caller or to the organization?** Asserting it with an org-scoped
fixture would be the wrong shape, and the first attempt to do so produced an empty array and a fixture
reporting no session.

## Sensitivity: the claim lives in a comparison

| | mutation | result |
|---|---|---|
| M1 | `find_membership_by_id` stops filtering on `org_id`, `?1` still bound | **DETECTED** — by **NON-DISCLOSURE** on both `members/{member_id}` PATCH and DELETE |
| M2 | `REMOVE_MEMBERSHIP_SQL` stops filtering on `org_id`, `?3` still bound | **KNOWN MISSED — deliberately** |

M1 mutates the statement that **carries the claim**: both handlers resolve the target through that lookup
before any `UPDATE` runs, so a foreign id that resolves *is* the attack. It is detected by the
non-disclosure assertion — the foreign id resolves and answers differently from the phantom — and **not**
by the attack assertion, because the route still refuses the write. A mutation that leaves the write
refused and only changes what the refusal reveals is invisible to a status-based gate and obvious to a
comparison-based one.

M2 is the same finding as FR-F02-006's M3 and is declared rather than reported: `change_role` and
`remove_member` resolve the target through the M1 lookup **first**, so their `org_id` predicates are
defence in depth with no route exercising them. It names the two statements a reviewer must protect and
says why, which is worth more than a false detection.

Every mutation keeps every placeholder and every bind, so `pnpm schema:bind-count` stays **green** — a
mutation the count check could see would not be testing a tenancy claim.

## What this gate does not cover

- **36 of the 54** one-path-id paths are credited: 9 to `verify:secret-tenancy`, 4 to
  `verify:mutating-tenancy` / `verify:usage-attribution`, and **23 named with the specific fixture each
  needs** (a pending approval, a draft route, a run with artifacts, a plugin awaiting approval, a team, a
  completed export whose body is in R2…). The credit table is in the probe and each reason is a sentence,
  not a shrug, so the work remaining is named rather than absent.
- The 2 **nested** routes (`{team_id}/members`, `{plugin_id}/…`) need a parent *and* a child, and are not
  in this gate's denominator.
- **No mutation removes a degraded control's guard** — there are no degraded controls left, and the three that existed are recorded above with what each turned out to be.
- The probe derives every id and every version from **D1**, never from a response envelope. Three
  envelopes were guessed wrong and read `undefined` before that change; the database is the authority for
  what a version is, and a fixture that reads it cannot be wrong about it.
