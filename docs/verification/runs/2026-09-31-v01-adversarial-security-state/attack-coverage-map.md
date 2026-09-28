# V01 — attack coverage map

What each required family already has, and what it does not. Built by reading the probes, not
the records: a family counts as covered only when a *runtime* attack exists, and a Rust unit test
does not count as an attack across a router.

Recalculated from the tree at `de3d559`.

| family | runtime attack today | what is NOT attacked |
|---|---|---|
| Tenant isolation | `smoke:p08` — 20 of 23 driven org-scoped routes, 0 leaks | 82 of 104 org-scoped routes still have no handler-level evidence. No **mutating** cross-tenant call is made at all: every substitution is a GET. No list/**filter** substitution, no **pagination** substitution, no **nested** route. |
| Authentication | `smoke:passkey` — 55/55 | **wrong ceremony kind** (0 mentions), **identity-link conflict** (0), **recovery with active sessions** (the one "recovery" hit is about last-login-method removal, not recovery). |
| Client privilege escalation | **none** | No probe anywhere attempts a client-supplied role, permission, `org_id`, or policy version and checks whether the server's authority wins. |
| Budget / cost | `smoke:p05` — hard-budget denial, correlated reservation, monotonic reconciliation, replay refusal, and **attribution** (it asserts `reservation.org_id`, `reservation.run_id`, `usage.org_id`, `usage.run_id`, `usage.project_id` against the values it seeded) | **Concurrent reservations against a hard ceiling.** The concurrency p05 exercises is `max_concurrent_requests` — a rate limit that denies the second of two simultaneous requests. That is not the same claim as two concurrent requests each passing the budget check and collectively exceeding `limit_minor`, which nothing attacks. |
| Inference streaming | Rust unit tests (`p09_failure_tests`) | No HTTP-level provider-fault attack. 429 / 5xx / malformed chunk / timeout / client disconnect are not driven through a real Worker. |
| Idempotency / races | `smoke:p05`, `guard:probe` (13/13) | Concurrent same-key requests, and automation **lease contention** (1 mention, not a contention test). |
| D1 / migrations | `schema:p07` 125/125, `p08:invariants` 17/17, `verify:restore` | **Representative prior state** — every run is a fresh database. A migration that only works on empty tables is not tested. |
| Adoption / privacy | `p08:invariants` at the **durable schema** layer | The **API and parser** layer is unattacked. The schema refuses a free-text telemetry reason and one containing a path; nothing shows what the *client* is told when the API accepts one and the batch then refuses it. |

## CORRECTION — this map was wrong about budgets, and the error is instructive

The first version of the budget row above read: *"overspend 0 mentions, usage attribution 0
mentions."* Both were false. `smoke:p05` asserts usage attribution directly —
`reservation.org_id === orgA.orgId`, `reservation.run_id === created.runId`,
`usage.org_id === orgA.orgId`, `usage.run_id === created.runId` — and it exercises
concurrency.

The error was a method error, and it is the same one V01-001 caught in a different place:
**I counted keyword occurrences and reported the count as coverage.** "overspend" appears
0 times because the probe says "hard-budget denial" instead. A grep for the word I would
have used found nothing, and I wrote that down as a gap in the product's evidence.

The corrected row distinguishes two claims that are genuinely different:

- **a concurrency limit** — `max_concurrent_requests` denies the second simultaneous
  request. Covered.
- **a budget ceiling under concurrency** — N requests each pass the budget check, and the
  reservations they hold sum to more than `limit_minor`. Not covered by anything.

Only the second is a money claim, and only the second is worth attacking. A map built by
grepping is a list of words, not a list of claims, and it will confidently report a
well-tested property as untested — which is worse than leaving the row blank, because it
sends the next reader looking for a defect that is not there.

## The two facts that shape the order of work

**1. The last three rounds all found defects at the API/batch boundary, not in the domain.**
VFY-008 (six bind/placeholder mismatches), VFY-009 (a job queue with no producer), and the P07
`service-accounts` 503 were all "the request is accepted, the batch refuses it, and the client is
told something misleading". Every one was invisible until an error was made readable.

That makes the adoption/privacy API layer the most promising unattacked surface: its **durable**
constraint is already proven to work, so if the API does not reject the same input first, the
request reaches a batch that will fail — the exact shape of the last three findings.

**2. Nothing has ever attacked client privilege escalation.** The families list eight; this is the
one with no runtime attack at all, and it is a Tier-0 class of defect (VFY-011 was exactly this,
found by accident rather than by attack).

## Order

1. Adoption/privacy at the API and parser layer — cheapest, and the DB already proves the rule.
2. Client privilege escalation over HTTP — a whole Tier-0 family with no attack at all.
3. Budget attribution and concurrent overspend — money, and currently 0 mentions for both.
4. The three missing authentication attacks.
5. Representative-prior-state migrations.
6. The remaining tenant substitutions: mutating, filter, pagination, nested.
