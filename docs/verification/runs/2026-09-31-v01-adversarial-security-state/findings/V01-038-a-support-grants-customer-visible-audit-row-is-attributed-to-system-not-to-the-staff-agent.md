# V01-038 — a support grant's customer-visible audit row is attributed to `system`, not to the staff agent

- **Claim ID:** V01-038
- **Family:** Authentication / audit attribution
- **Severity:** **HIGH**
- **Status:** CLOSED — recorded before repair, updated with root cause, fix, and proof
- **Verdict:** FAIL → **PASS** (rows now `actor_type = 'staff'`; probe 37/37)

## Claim

`POST /api/v1/internal/support-grants` and its revoke **do** write the customer-visible audit row that
ADR 0007 requires — and the row records `actor_type = 'system'` with a **NULL `actor_id`**. The staff
principal's id is present only inside the row's `metadata_json`.

So the customer's own audit view shows an **unattributable system action on their own organization**,
which is the exact outcome the requirement exists to prevent.

## Setup

`apps/api/src/routes/internal.rs`, `create_grant`. The audit row is built with a comment that states
the purpose correctly:

```rust
// F24-003: a grant creates a CUSTOMER-VISIBLE event, not only a platform one.
// The customer's own audit view is what makes a support session
// reconstructable without trusting platform logs, so the row is written with
// the organization's scope.
let audit = crate::routes::support::security_event_statement(
    database,
    &context,
    None,                              // <-- no Principal
    Some(organization.as_str()),
    SecurityEventId::generate(),
    "support_grant.issued",
    "support_grant",
    Some(&grant_id),
    "success",
    &json!({
        "staff_principal_id": staff.actor.staff_principal_id.as_str(),
        ...
    }),
)?;
```

And `security_event_statement_with_context` in `apps/api/src/routes/support.rs` derives the actor type
from **one thing only** — whether a `Principal` was passed:

```rust
BindValue::Text(if principal.is_some() { "user" } else { "system" }),
```

`actor_id` and `effective_user_id` are likewise `principal.map(...)`, so both are NULL here.

## Action

`verify:staff-credential`'s R3/R4/R5, driven with a **legitimate** staff token against a **real**
organization:

| check | result |
|---|---|
| R3 the grant is created and stored | `201`, `sgr_…` row present, `organization_id` correct |
| R4 the grant is revoked and stored | `2xx`, `revoked_at` set, `version + 1` |
| R5 an audit row per grant write | **present** — two rows, two distinct actions |
| R5 **every one attributed to a staff actor** | **`actorTypes=["system"]`** |

The last row is the finding. The rows exist — which is why no status-based check, and no count, would
ever have reported this — and they name nobody.

The actions are `support_grant.issued` and `support_grant.revoked`. Read out of D1 after the run:

```
grant_id                 organization_id                 version
sgr_4fc94dc0609c439a…    org_bf898338413aa8cc17e8d…     1
```

and the corresponding `security_events` rows carry `actor_type = 'system'`, `actor_id = NULL`.

## Actual

The customer's own audit view — the one ADR 0007 names as the thing that makes a support session
reconstructable "without trusting platform-side logs" — reports an action by an unnamed system. The
staff principal's id is one JSON field away, in a column no query would join on.

## Root cause

**`actor_type` is derived from a parameter's presence rather than from who acted, and the parameter
cannot represent a staff actor at all.**

`security_event_statement*` takes `principal: Option<&Principal>`. ADR 0007 is explicit that a staff
actor is a **different actor kind** that must not be expressed as a human `Principal` — "A
`StaffRole` never converts to a `MembershipRole` and a `MembershipRole` never satisfies a
`StaffPermission`", and `MachineActor`/`StaffActor` "must not be constructible from a" `Principal`.

So the boundary has three real states — a user acted, a machine acted, a staff member acted — and the
signature has two. A staff caller passes `None`, and `None` means `system`.

This is the **same shape as V01-036**, and that is the generalisable finding: *a boundary whose
parameter cannot express a domain case will map that case onto whatever value it does have.* There it
mapped "no organization" onto an invalid id; here it maps "a staff member" onto "the system".

Note what the code gets right and still gets wrong: it writes the row with the **organization's**
scope specifically so the customer can see it, and it puts `staff_principal_id` in the metadata. Both
are the instinct doing its job. The attribution column is the part that cannot be right, and the
metadata is a workaround for a type that could not say the truth.

## Impact

- **Accountability, on the surface ADR 0007 exists to create.** A customer reviewing their own audit
  trail cannot distinguish a support agent's access from an automated platform action. The metadata
  field makes it *recoverable* by someone who knows to look, which is a weaker property than
  *attributable*.
- **It is invisible to every check that counts rows or reads statuses.** The row is present, the
  status is `2xx`, the action name is right. Only reading `actor_type` sees it — which is why the
  assertion that found it is on the **value of the column**, and why the first version of that
  assertion guessed the action *name* and nearly reported a working audit trail as missing.
- **`revoke_grant` has the same shape**, so a grant's whole lifecycle is unattributed.

## Regression gap

- No assertion anywhere read `security_events.actor_type` for a support grant. `verify:adoption-privacy`
  reads `security_events` to assert that nothing sensitive *reaches* it; nothing read what it *says*.
- `security::actor_type_correspondence` (added this round for V01-035) checks the **writer against the
  ledger** — is this value permitted? — and would happily pass `'system'`, because `'system'` **is**
  permitted. It is a schema-conformance check, not an attribution check, and this defect is in the
  gap between them. Recorded rather than papered over: the check's stated limit is "a hard-coded
  literal the schema refuses", and `'system'` is not refused.
- ADR 0007's MUST is written in prose ("a staff audit event is written … so a support session is
  reconstructable") and nothing measured the *purpose*. A requirement stated as an outcome rather than
  as a column is not directly assertable, which is a general hazard in this repository's specs.

## Fix

`apps/api/src/routes/support.rs`. `actor_type` now comes from **the actor**, with three branches
matching ADR 0007's three actor kinds:

```rust
let (actor_type, actor_id, effective_user_id) = match (principal, staff_principal_id) {
    (Some(value), _)      => ("user",  Text(value.user_id), Text(value.user_id)),
    (None, Some(staff_id)) => ("staff", Text(staff_id),      Null),
    (None, None)          => ("system", Null,               Null),
};
```

`effective_user_id` stays NULL for a staff actor deliberately: a staff member is not acting **as** a
customer, and the `usr_`/`stf_` distinction is the whole point of the column.

`security_event_statement*` grew a `staff_principal_id: Option<&str>` parameter on both arities, and
the two grant call sites pass `Some(staff.actor.staff_principal_id.as_str())`. **Not** by synthesising
a `Principal` — that is the conflation ADR 0007 forbids, and it would have put a `usr_`-shaped
identity into a row whose `actor_type` says `staff`.

The short wrapper grew the parameter too, rather than routing the grants through the 15-argument
form: the wrapper exists so the common case does not have to name four correlation ids it does not
have, and a 15-argument call is a worse answer than one more parameter.

The compiler found the 55 call sites that needed the argument, which is the argument for encoding the
actor at the boundary rather than deriving it: **this change was type-checked, not searched for.**

## Regression proof

`verify:staff-credential` R3/R4/R5, which now also cover the two grant writes and the two reads, so
**all six** `/api/v1/internal/**` routes are measured. **33/35 → 37/37, exit 0, 0 skipped.**

R5's second assertion is the one that found this, and it is deliberately on the **value of the
column** rather than on a count or a status:

```
R5: and every one of those rows is attributed to a STAFF actor  — actorTypes=["staff"]
```

Read straight out of D1 rather than through the probe's own reader:

```
support_grant.issued|staff|stf_5bd678ba1329340777ee81033d1b8dcb|org_919136a4398d2784cdd6ef227033e505
support_grant.revoked|staff|stf_5bd678ba1329340777ee81033d1b8dcb|org_919136a4398d2784cdd6ef227033e505
```

`org_id` is the real customer — so the row is customer-visible, as F24-003 requires — and it now names
who. All three actor kinds appear in one run's audit trail: `staff` 6, `user` 2, `anonymous` 2.

## A probe bug worth recording, because it nearly hid the finding

R5's first version asserted the action names `support_grant.created` and `support_grant.revoked`.
The product writes `support_grant.**issued**` and `.revoked`, so the assertion **failed while the
audit trail was working perfectly** — and its failure message is a list of the actions that were
actually written.

I fixed it by deriving the expectation instead of naming strings: one row per grant write that
*succeeded*, all actions distinct, all `actor_type = 'staff'`. A hard-coded action name passes a
rename and fails a working system, which is the worst of both.

## Re-run after the fix

`pnpm check` exit 0, 1029 tests. `verify:adoption-privacy` 20/20 (it reads `security_events` to assert
nothing sensitive *reaches* it), `verify:idempotency` 47/47, `smoke:p08` 47/47,
`verify:path-id-tenancy` 198/198, `verify:privilege-escalation` 96/96, `verify:secret-tenancy` 32/32,
`verify:budget-concurrency` 28/28, `verify:lease-contention` 62/62, `verify:usage-attribution` 43/43.
The change touched **55 audit call sites across 12 route files**, so the sweep is the proof that
nothing else moved.

## Residual risk, stated rather than implied

The **grant-use** path — the "and on every use" half of ADR 0007's MUST — is still unmeasured.
`/api/v1/internal/support-grants` has only `POST` and `{id}/revoke` in the router, so the use of a
grant happens on some *other* route, and no probe drives it. That is a real hole in the same MUST, and
it is the next thing to attack.
