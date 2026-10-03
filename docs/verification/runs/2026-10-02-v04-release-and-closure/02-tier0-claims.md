# V04 work item 2 — the Tier-0 claim list, derived before reading any gate

**Derived from `docs/verification/release-gate.md`'s hard blockers and `docs/specs/README.md`'s
cross-cutting security invariant — not from any campaign's evidence, and not from a list of what
happens to be gated.**

The independence protocol requires the claim and its failure mode to exist before the evidence is
read. Reading the existing gates first would anchor Tier-0 to "what is already covered", which is
the failure mode this whole system exists to prevent: it would make an ungated invariant invisible
precisely because nobody had thought of it.

## The cross-cutting invariant every protected operation must establish

```
principal
+ authenticated session or machine identity
+ active organization context
+ active membership
+ permission decision
+ resource scope/ownership
+ entitlement/budget/policy constraints where applicable
```

and the spec's own sentence: **knowing a `resource_id` is never the same as having permission to use
it.** That is the single most attackable sentence in the specification, and most of the Tier-0 list
below is an instance of it.

## Tier-0 claims

Each is stated as the claim, then as *the obvious dangerous way it could be wrong* — because the
release gate's test-strength question is exactly that, and a Tier-0 proof that cannot answer it is
not a Tier-0 proof.

| # | Tier-0 claim | The obvious wrong implementation | Required proof level |
|---|---|---|---|
| **T0-01** | No cross-tenant read or write is possible through any route | A handler checks membership and then queries by `resource_id` only, so a foreign id resolves | V3 + V4 |
| **T0-02** | A client-supplied org/project/role/credential id is never authority | A field in the body is trusted instead of resolved server-side | V3 + V4 |
| **T0-03** | Authentication cannot be replayed, confused, or bound to the wrong ceremony | A WebAuthn challenge is accepted twice, or a password step-up is reused for a different ceremony | V3 + V4 |
| **T0-04** | Revocation is terminal: a revoked session, device, or authenticator stops working immediately | Revocation is recorded but the authenticating path does not filter on it | V3 + V4 |
| **T0-05** | Secrets never appear in a response body, a log line, a security event, or an audit row | A secret is logged for debugging, or returned once and then re-derivable | V3 + V4 |
| **T0-06** | A hard budget refuses an ordinary inference **before** upstream dispatch | The budget is checked after the call, or an INSERT matching zero rows is not noticed | V3 + V4 |
| **T0-07** | Budget ceilings hold under concurrency, and a released hold returns its capacity | Two concurrent reservations both see the remaining balance | V3 + V4 |
| **T0-08** | Inference never falls back to another route after committed output | A stream-commit guard is evaluated before the commit rather than after | V3 + V4 |
| **T0-09** | A destructive operation requires authorization and is idempotent | The button is hidden in the UI but the endpoint has no authz, or a retry repeats the effect | V3 + V4 |
| **T0-10** | Local-only and adoption paths leak no user content | A path, key, prompt, or conversation history is written to an audit or event row | V3 + V4 |
| **T0-11** | A fresh install and an upgrade both produce a schema that refuses invalid writes | A migration applies cleanly to zero rows and silently does nothing to populated ones | V3 + V4 |
| **T0-12** | Rollback/forward-fix is known for every data-affecting change | A forward fix is written but no run proves it applies | V3 + V4 |
| **T0-13** | Tool, browser and computer-use **denial** is enforced, not merely recorded | The policy evaluates to Deny and the caller proceeds anyway | V3 + V4 |
| **T0-14** | Admin/support authority is bounded and every use is audited with a real actor | A staff principal is authenticated by prefix, or its audit row is unattributable | V3 + V4 |
| **T0-15** | A client cannot override server authorization | A header, cookie field, or body field raises a permission | V3 + V4 |
| **T0-16** | Export and deletion are authorized, idempotent, and every data class has a disposition | Deletion succeeds twice, or a data class is silently retained | V3 + V4 |
| **T0-17** | Outbound retries are bounded and produce no duplicate side effect | A retry loop has no ceiling, or a replay double-charges | V3 + V4 |
| **T0-18** | A meaningful Tier-0 mutant is killed | The suite goes green against a deliberately broken guard | V4 |
| **T0-19** | Stale organization context cannot leak across a switch | A refetch is skipped and the previous org's data stays on screen | V3 + V4 |
| **T0-20** | Machine identity is isolated from customer sessions, and vice versa | A machine key is accepted on a customer route, or a session on a staff route | V3 + V4 |

**Twenty claims, every one requiring V3 + V4.** V2 (unit/property) supports a claim; it never
constitutes one.

## The mutual-exclusion cases that belong to Tier-0 but are easy to miss

These are not separate invariants, but each is a *weaker* form of one above, and a gate that only
tests the strong form can miss the weak one entirely:

- a **cross-tenant read** that returns another tenant's rows is graded differently from one that
  returns a 404 — the first is a leak, the second is correct non-disclosure;
- a **filter value** in a query string that leaks is a different statement from a path id that leaks,
  because the path id passes the org check and only the `WHERE` clause can stop it;
- a **phantom** comparison (a well-formed id existing nowhere) must be answered **identically** to
  a real foreign id, or the route is an existence oracle even though every request is refused;
- a **write** tenancy proof is not established by read proofs, because a handler that skipped the
  membership check and found nothing returns the same 404 a correct handler does;
- a **first-time** record and a **repeat** record take different code paths, and a probe that only
  drives the first one proves nothing about the second.
