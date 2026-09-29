# V01-041 — a pending device enrollment can be approved but never denied

- **Claim ID:** V01-041
- **Family:** Tenant isolation / device enrollment (a security control with no negative branch)
- **Severity:** **HIGH**
- **Status:** CLOSED — recorded before repair, updated with root cause, fix, and proof
- **Verdict:** FAIL → **PASS** (a denied enrollment cannot obtain a credential; probe 36/36)

## Claim

`POST /api/v1/orgs/{org_id}/devices/enrollments/{enrollment_id}/approve` is registered.
**There is no deny route.** The enrollment state machine therefore has an affirmative branch and no
negative one: a human reviewing a device enrollment request can grant access, and can do nothing else.

## Setup

The domain was **built with denial in mind** at every layer below the route:

| layer | evidence |
|---|---|
| schema | `device_enrollments.status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', '**denied**'))` |
| SQL | `DENY_ENROLLMENT_SQL` — `SET status = 'denied', updated_at = ?3 WHERE enrollment_id = ?1 AND org_id = ?2 AND status = 'pending'` |
| repository | `pub async fn deny_enrollment(&self, enrollment_id, org_id, now) -> worker::Result<bool>` |
| sibling route | `POST /api/v1/orgs/{org_id}/devices/enrollments/{enrollment_id}/approve` → `devices::approve_enrollment`, registered at `app.rs:258` |

The statement is **correct**: org-scoped on `org_id` (so it cannot touch another tenant's row) and
guarded on `status = 'pending'` (so it cannot deny a completed enrollment). The repository method wraps
it and returns whether a row changed.

**And it has no caller.** `deny_enrollment` occurs exactly **once** in the entire tree — its own
definition on line 291 of `repositories/devices.rs`. By contrast `approve_enrollment` appears at
`app.rs:258` (route), `routes/devices.rs:1320` (handler), and `routes/devices.rs:1412` (the repository
call). The asymmetry is exact.

## Action

A scan for `pub` repository functions with **zero non-test call sites**, over all of
`apps/api/src/repositories/`: **55 of 568 unique names**, of which this is one. The scan's method and
its two parser faults are recorded below, because both nearly produced a wrong answer.

The load-bearing claim is not "the route exists" but:

> **A denied enrollment can never obtain a device credential.**

That is what a reviewer needs to be able to do, and it is the property a probe must attack: begin an
enrollment, deny it, then attempt completion and require refusal — graded on the stored row, because a
`2xx` that ignored the denial would be correct and a credential issued anyway is a breach.

## Actual

There is no way to deny an enrollment through the API.

## Why it matters

1. **A reviewer who does not recognise the device has no action that records their refusal.** The
   available actions are *approve* and *do nothing*. There is no third option that says "no".
2. **The refusal leaves no evidence.** Nothing writes `denied`, an actor, or a reason. The row either
   lingers `pending` or is later marked `expired` by `expire_enrollment` — which **does** have two
   callers. So the practical outcome is that a human's decision *not* to grant access is recorded
   identically to *nobody ever looked*.
3. **The audit trail is structurally one-sided.** An incident review cannot distinguish "no device asked
   for access" from "a human examined the request and refused it". Every enrollment in the trail is an
   approval; the refusals are invisible by construction rather than by policy.
4. **It is the affirmative half of a human control, with the negative half unreachable.** A control whose
   only branch is "grant" is not a control; it is an approval queue.

## Root cause, and why the spec is not the reason

**The spec is silent.** `FR-F19-001` requires user authentication, active membership, a strong device
credential, device details, and explicit user confirmation — and says nothing about denial. `F16`'s
event-class list names "device enrollment/revocation", and `FR-F16-001` specifies an event's *fields*,
not which events must exist. So no MUST is violated, and this is **not** a spec contradiction.

What requires the route is the code itself: a schema state, a correct statement, a repository method,
and a registered sibling that mirrors it. **The domain was built with denial in mind and the route was
never surfaced** — the same shape as V01-040's `find_grants_for_staff_and_org`, on a **security** path
rather than a support one.

That is why this is a repair rather than a feature: the contract is not invented here, it is read off the
route it mirrors. `approve_enrollment` uses `Permission::DevicesRead` and `require_csrf`, takes its
idempotency claim after authorization and before the state check, and refuses a non-`pending` row with
`409`. A deny route has the same shape with `denied` substituted for `completed`, and the SQL's
`status = 'pending'` guard already enforces the state transition.

**The documentation gap is recorded rather than papered over:** `FR-F19-001` should say that a pending
enrollment can be denied and that the denial is audited. That is a spec amendment to propose, not one
to make silently while fixing a route.

## Regression gap

- **No test could have caught this.** The repository method is correct, and the only test over it is a
  string assertion on the SQL — which passes whether or not anything calls it. *A test over a string
  constant cannot report that nothing calls the function that owns it.*
- No gate drives enrollment denial, because no route exists to drive. `verify:path-id-tenancy` credits
  `/devices/enrollments/{enrollment_id}/approve` as "needs a pending device enrollment" — the **approve**
  path is not handler-level proven either.
- `verify:device-idempotency` exercises `approve_enrollment` and found a real idempotency defect there
  (V01-009), so the affirmative path is attacked and the negative path was never in scope for anyone.

## The two parser faults in the scan that found this, both recorded because each nearly produced a
## wrong finding

**1. A lookbehind that excluded the normal call form.** The first scan used `(?<![\w:.])name\s*\(` to
avoid matching a longer identifier — and the `:` in the class excluded `.method(`, which is **how
repositories are called**. It reported **474 of 568** functions as uncalled, a number so obviously
wrong that it is worth recording: a check whose first output is nonsense is a check nobody will read,
and the right response to "my scan says three quarters of the codebase is dead" is to distrust the
scan, not the codebase.

**2. An ad-hoc shell grep that disagreed with the scan.** A follow-up `grep '\.approve_enrollment('`
reported `approve_enrollment` as having zero callers — **false**, because the route registers it as
`devices::approve_enrollment`. Had that grep been the instrument, this record would have claimed the
*approve* path was also unwired, which would have inverted the finding.

> Two instruments, two different wrong answers, and the more alarming one was the simpler. When a cheap
> check contradicts an expensive one, the cheap one is the suspect — and the asymmetry is not neutral,
> because a check that finds *more* dead code feels more useful and gets believed faster.

## Root cause

**The domain was built with denial in mind and the route was never surfaced.** The schema admits
`'denied'`, `DENY_ENROLLMENT_SQL` sets it correctly (org-scoped on `org_id`, guarded on
`status = 'pending'`), and `deny_enrollment` wraps it. The repository function occurred **exactly once**
in the tree — its own definition.

**The spec is silent, and that is recorded rather than used as an excuse.** `FR-F19-001` requires
authentication, membership, a strong device credential, device details and explicit confirmation — and
says nothing about denial. `F16` names "device enrollment/revocation" as an event class and
`FR-F16-001` specifies an event's *fields*, not which events must exist. So no MUST is violated, and
this is **not** a spec contradiction.

## Fix

`POST /api/v1/orgs/{org_id}/devices/enrollments/{enrollment_id}/deny`, registered in `app.rs` **beside**
`approve` so the pair reads together, with the handler in `routes/devices.rs` immediately before
`approve_enrollment` for the same reason.

The handler mirrors `approve_enrollment` field for field, because a divergent twin is how two branches
of one control drift: the same `Permission::DevicesRead`, the same `require_csrf`, the same idempotency
claim taken **after** authorization and the org check and **before** the state check, and the same `409`
for a row that is no longer pending. It returns through the same `(StatusCode, Json(body))` shape.

**One repository change was needed, and it was a real defect in the existing code.**
`deny_enrollment` *executed* its statement immediately rather than returning a prepared one — so the
denial and the audit event recording it could not commit together. A crash between them leaves a
reviewer having refused access with no record that they did. Added `deny_enrollment_statement`, and
**reimplemented `deny_enrollment` in terms of it** so one SQL and one bind list serve both paths: two
ways to write the same row is the hazard, not the convenience.

The state check is duplicated deliberately. The SQL's own `status = 'pending'` guard already enforces
the transition, but doing it in the handler is what turns "the statement changed nothing" into a stable
`409` rather than a `200` that lies.

## Regression proof

`verify:revoked-device` gains a **denial class** that attacks the claim rather than the route's
existence, because a route returning 2xx proves a handler is wired and says nothing about whether the
credential it should have prevented was prevented.

**29/29 → 36/36, exit 0, 0 skipped**, all of it green on the first run.

| case | what it asserts |
|---|---|
| **D0** | a **second, independent** enrollment begins on its own ed25519 key — nothing above may hand this class a consumed row |
| **D1** | it can be denied, and the **stored** status is `denied`, read from D1 |
| **D2** | completing it is refused `403`, **and no `device_tokens` row exists** for that key fingerprint |
| **D3** | a **different-key** denial of the same row is refused — which proves the state check rather than the `Idempotency-Key` being irrelevant, the exact lesson V01-009's `approve_enrollment` leg turned on |
| **D4** | the denial wrote a customer-visible audit event with `actor_type = 'user'` |

**D2's second half is the load-bearing assertion.** A `2xx` that *ignored* the denial would be a
correct answer, so a status-only check would pass it; a `device_tokens` row is the only thing that
distinguishes "refused" from "issued anyway". Graded on the row, per this campaign's standing rule.

## What this did NOT get covered, stated rather than implied

Adding a route made `verify:path-id-tenancy`'s denominator grow — the gate's closure assertion fired
with `unaccounted for: …/deny`, which is that gate working exactly as designed.

**The route is named, not credited.** `verify:revoked-device` proves assertion **1 of 4** (the own-row
`2xx` control). It does not substitute another organization's id, does not compare a phantom, and does
not read a foreign row back to assert it is unchanged. Crediting four assertions on the strength of one
is the same error as dropping the route from the denominator — both make coverage look larger than it
is.

So both enrollment routes sit in `NOT_YET_SEEDED` with reasons that are now **specific and
achievable**: two organizations, each with a pending enrollment. The old reason ("needs a pending
device enrollment") is stale, because `verify:revoked-device` just proved one is buildable.

`verify:path-id-tenancy` **198/198 → 199/199**, exit 0.

## The spec amendment this finding implies, proposed rather than made

`FR-F19-001` should state that a pending enrollment **can be denied**, and that the denial is audited
with the refusing actor. The schema, the statement, the repository method and now the route all encode
it; only the prose is silent. That is a spec change to propose through the deliberate process — not one
to slip in while fixing a route, which is how a requirement and an implementation stop describing the
same system.

## Re-run after the fix

`pnpm check` exit 0, 1029 tests. `verify:device-idempotency` 23/23, `verify:lease-contention` 62/62,
`smoke:p08` 47/47, `verify:staff-credential` 46/46, `verify:path-id-tenancy` 199/199,
`verify:revoked-device` 36/36.

## How the finding was found, and the part worth copying

A scan for `pub` repository functions with **zero non-test call sites** — motivated directly by
V01-040, which is the same shape on a support path. `deny_enrollment` was the 12th name on a list of
**55**, and the most alarming thing on it.

**Two instruments gave two wrong answers before the right one.** The first scan used
`(?<![\w:.])name\s*\(` to avoid matching a longer identifier — and the `:` excluded `.method(`, which
is *how repositories are called*. It reported **474 of 568** uncalled. A follow-up shell grep then
reported `approve_enrollment` as having zero callers — **false**, because the route registers it as
`devices::approve_enrollment`; had that been the instrument, this record would have claimed the
*approve* path was unwired too, inverting the finding.

> When a cheap check contradicts an expensive one, the cheap one is the suspect. The asymmetry is not
> neutral: a check that finds *more* dead code feels more useful and gets believed faster.

The generalisation is in `AGENTS.md` alongside V01-040's: a documented, tested helper with no caller is
a durable false signal — and on this list it was a **security control with one branch**.
