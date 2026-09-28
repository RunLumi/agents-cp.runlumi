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
| Budget / cost | `smoke:p05` — 36 budget mentions, 19 "reconcil" | **overspend** under concurrency: 0 mentions. **usage attribution** to org/project/principal/run: 0 mentions. Concurrency appears 3×, lease 1×. Whether upstream dispatch was *called* is not instrumented anywhere. |
| Inference streaming | Rust unit tests (`p09_failure_tests`) | No HTTP-level provider-fault attack. 429 / 5xx / malformed chunk / timeout / client disconnect are not driven through a real Worker. |
| Idempotency / races | `smoke:p05`, `guard:probe` (13/13) | Concurrent same-key requests, and automation **lease contention** (1 mention, not a contention test). |
| D1 / migrations | `schema:p07` 125/125, `p08:invariants` 17/17, `verify:restore` | **Representative prior state** — every run is a fresh database. A migration that only works on empty tables is not tested. |
| Adoption / privacy | `p08:invariants` at the **durable schema** layer | The **API and parser** layer is unattacked. The schema refuses a free-text telemetry reason and one containing a path; nothing shows what the *client* is told when the API accepts one and the batch then refuses it. |

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
