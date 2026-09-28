# V01 — attack coverage map

What each required family already has, and what it does not. Built by reading the probes, not
the records: a family counts as covered only when a *runtime* attack exists, and a Rust unit test
does not count as an attack across a router.

Recalculated from the tree at `875b5ee` plus the V01-009 repair. The previous
revision of this table was written at `de3d559`, before V01-003 through V01-008, and it
credited four families with less than they had and one — inference streaming — with exactly
as little as they still have.
| family | runtime attack today | what is NOT attacked |
|---|---|---|
| Tenant isolation | `smoke:p08` 47/47 (read) · `verify:mutating-tenancy` 43/43 (**write**, graded on stored state) · `verify:filter-tenancy` 65/65 (**query string**, plus a foreign keyset cursor, 5 nested paths and the audit route's 12 id filters) | **No leak found on any surface**, including through the audit route's `metadata_json`, which is returned in full. Still open: 28 org-scoped routes beyond the 11 driven. Runs, sessions, automations and usage — and four of the audit filters — are SKIPped for want of a run fixture, and `members/{id}` has no GET handler at all (405). |
| Authentication | `smoke:passkey` **76/76** | A revoked **device** driven to a refusal; whether a revoked session's refresh token dies with it; the reauth grant's own ceremony kind. | · **written, not yet run:** `verify:revoked-device` (V01-016) — the run record lists 'a revoked device driven to a refusal' as UNPROVEN because `p03` and `p05` only *mention* revocation. The probe's sharp leg is not that the old token stops working but that a revoked device cannot **mint** one: a read, the nonce, and a full refresh with a real signature over a real server nonce, all controlled by a success (including a real pre-revocation mint) before the revocation
| Client privilege escalation | `verify:privilege-escalation` **46/46** over 7 field classes, graded on stored state | 4 of 4 mutations detected. M4 found a **critical** co-owner escalation. GAP-004 remains: `schema:bind-count` proves arithmetic, not correspondence. |
| Budget / cost | `smoke:p05` + `verify:budget-concurrency` **27/27** — the ceiling is **measured** | Usage attribution to org/project/principal/**run**, and whether upstream dispatch was *called* — instrumented nowhere. |
| Inference streaming | `p04-smoke` drives three of the four seeded `mock://` providers over real HTTP, including the no-fallback-after-output claim on an `ordered_fallback` route. `verify:inference-failure` **65/65, 0 skipped** adds the money half: after success, fail-before-output, timeout, output-then-fail and a client disconnect, no reservation is left `reserved` and every request reaches a terminal state, graded on two D1 tables | **429, 5xx and a genuinely malformed chunk remain UNPROVEN (GAP-007).** No seeded provider produces an HTTP status from a real socket, and a probe that runs one — counting every request that reaches it, so "called once, not retried" is a measurement — **exits 2 here**: `wrangler dev` on this machine does not route a Worker's outbound fetch to a host-local endpoint. V01-010 made that blocker *visible*, since the transport error used to be discarded. |
| Idempotency / races | `verify:idempotency` **41/41** (replay, incompatible payload, 6 and 8 concurrent on one key, cross-principal key reuse, graded on **row counts read from D1**) · `verify:lease-contention` **58/60**, 2 FAILs being the open **V01-013** defect asserted on purpose — and the earlier 32/34 was a **partial run**: the probe died in case 1 on a wrong table name and `bail()` exited 1 because failures had already been recorded, so three cases never ran and were silently absent from the denominator | `verify:lease-contention` closes the named case with zero prior coverage: 8 simultaneous claims give **one winner, one active lease, one state transition, one attempt row**, and no loser carrying the winner's lease or raw token. Optimistic concurrency is covered by `verify:mutating-tenancy`. **V01-013:** `TRANSITION_OCCURRENCE_SQL` has no `attempt` in its SET list, so `max_start_attempts` is unenforceable, and a leased occurrence records no `started_at`. Its fix touches a statement shared by four routes . Its fix touches a statement shared by four routes, and a single claim cannot tell *a dead counter* from *a bound that is not enforced* — every claim is attempt 1 whatever the bound is. **V01-014** is that attack: claim, wait out the 30s TTL, let the sweep expire the lease, claim again with `max_start_attempts: 1`, and require a refusal. Written and registered as `verify:attempt-exhaustion`; not yet run |
| D1 / migrations | `schema:p07` 125/125, `p08:invariants` 17/17, `verify:restore`, `verify:migration-prior-state` **19/19** on **populated** prior state | Only two cut points, no assertion about a backfill's *content*, foreign keys not exercised. |
| Adoption / privacy | `verify:adoption-privacy` **20/20** across 8 content classes, at the API **and** the durable schema | GAP-001: adoption *identifiers* may carry user content and no MUST forbids it. That is a spec gap, not a code gap. |

**Six of eight families now have a gate whose failure has been watched.** The map is
recalculated at `875b5ee` + the V01-009 repair.

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
