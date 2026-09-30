# V01-040 — ADR 0007's "and on every use" has no implementation

- **Claim ID:** V01-040
- **Family:** Authentication / audit (a written MUST with no implementation)
- **Severity:** **MEDIUM**
- **Status:** OPEN — **not repaired, and deliberately so**
- **Verdict:** **UNPROVEN** — the requirement's second half does not exist to be tested

## The requirement

`docs/adr/0007-three-actor-kinds.md`, under Consequences:

> - **Staff access to a customer organization requires an explicit `SupportGrant`**: named actor,
>   reason/ticket, bounded TTL, and a customer-visible audit event. Default staff mode is metadata and
>   support read-only.
> - A staff audit event is written on **grant creation and on every use**, so a support session is
>   reconstructable from the customer's own audit view without trusting platform-side logs.

**Creation** is implemented and, as of V01-038, correctly attributed. **Use** is not.

## What was measured

| question | answer |
|---|---|
| Is there a route that consumes a grant? | **No.** The router registers `POST /api/v1/internal/support-grants` and `POST /api/v1/internal/support-grants/{grant_id}/revoke`. Nothing else. |
| Does any customer-facing route consult a grant? | **No.** Searching `apps/api/src/routes/` for a grant read outside `internal.rs` returns only `reauth_grant_id` — a re-authentication grant (`rag_`), an unrelated resource. |
| Is there a header or parameter that presents a grant? | **No.** No `X-Support-*` header, no grant parameter on any customer route. |
| Does the repository have the read? | **Yes, and nothing calls it.** `PlatformOperationsRepository::find_grants_for_staff_and_org` exists, and its doc comment says: *"The grant read **every customer-context request uses**."* |

## Root cause of the *misleading* part, which is the actionable half

The repository function's doc comment is **false**, and that is the finding worth acting on:

> The grant read every customer-context request uses. It is scoped by ALL THREE of staff, organization
> and state, because a request that names a different organization must not receive a grant that names
> this one.

No customer-context request uses it. A second comment repeats the claim:

> The grant read is scoped by staff AND organization AND a bound. A request cannot name a grant that
> belongs to another organization.

and a unit test asserts the SQL's predicates — so the *scoping* is verified while the *existence of a
caller* is not. **A test over a string constant cannot report that nothing calls the function that owns
it.**

So a reviewer reading `support.rs` sees a documented, tested, correctly-scoped grant read and
reasonably concludes the mechanism is done. That is a false signal produced by good work on the wrong
claim, and it is more durable than a missing function would be.

## Why this is not repaired here

Implementing staff access to customer context is a **feature**, not a repair. It needs a decision about
which customer routes a grant may reach, what a capability means at that boundary, how the grant is
presented (a header? a token claim? a session?), and what `SupportGrant` capabilities authorise — and
ADR 0007 says each boundary keeps its own decision function, so it is a new authorisation surface with
its own spec, ADR, and implementation packet.

The campaign's rule is explicit: if fixing a claim would require changing a MUST or building against a
frozen contract, stop the claim and use the deliberate change process rather than editing the
requirement to get green. **The requirement is right; the implementation is absent.** Editing the ADR
to match the code would be exactly the prohibited move.

## What is verified, and what is not

**Verified (V01-038 and this round's B1):**

- a support grant is created with a named actor, a reason, a ticket reference, and a bounded TTL;
- creation and revocation each write a `security_events` row carrying `actor_type = 'staff'` and the
  staff principal's id, scoped to the **customer's** organization;
- a staff token is refused on a customer org-scoped route, identically to a request naming an
  organization that does not exist.

So the **negative** half of "staff access requires an explicit grant" holds in the strongest available
form: staff cannot reach customer context **at all**, granted or not. That is the security-relevant
property, and it is safe.

**Not verified, because it does not exist:** that a grant *confers* anything, and that the "every use"
audit event is written.

## The residual that matters

The current state is **fail-closed with no fail-open path**: the safe direction. The risk is not that
staff can reach customer data — it is that the product has a grant lifecycle (create, list, revoke) with
no consumer, which means:

1. **A future route could read a grant without the audit event.** The "every use" MUST would then be
   violated silently, and nothing in the test suite would notice, because the only test over the grant
   read asserts SQL predicates.
2. **Operators can mint and revoke grants that do nothing**, which is worse than not having them: the
   control exists on paper and an incident review would reasonably assume it was exercised.

## The cheap check this suggests, and its honest limit

A standing check that **every `pub` repository function has at least one non-test caller** would have
caught this at the moment the function was written, and it generalises: a documented, tested helper with
no caller is a common way a half-built feature reads as a finished one.

Its limit, stated rather than implied: it says a function is *called*, not that it is called *correctly*
or *for the right reason*, and a function called once from dead code satisfies it. It is a liveness
check, not a correctness check — and the failure it catches (a documented mechanism with no consumer) is
the one that misleads a reader, which is the half of this finding that is actionable today.
