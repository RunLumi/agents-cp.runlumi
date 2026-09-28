# V01 — next verification actions

Ordered by what is still unfalsified, not by what is easiest to fix.

## GAP-001 — adoption identifiers carry user content, and nothing says they must not

**Status:** open, needs the deliberate change process, **not** a code change.

`POST /orgs/{org}/adoption/bindings` stores the client's `external_workspace_key` and
`display_name` verbatim. Attacked with eight content classes (`prompt`, POSIX path, Windows
path, private-key body, API key, conversation history, MCP secret, arbitrary note); all eight
are stored, in the client's own organization, and served back by `GET /adoption/bindings` to
every org member.

What *is* enforced, and proven: the key refuses a path, the database refuses a path
independently, and no payload reaches `security_events`.

What is not enforced, and not required: nothing in `f01`–`f26` says an adoption identifier
may not contain text. `display_name` is free text by design. The decision needed is whether
adoption identifiers are opaque, and if so the requirement gets written first and enforced
second — the reverse order is how a verifier ends up weakened to match a probe.

Evidence: `findings/V01-001-…md`, `evidence/v01-001-stored-rows.txt`.

## GAP-004 — `schema:bind-count` proves arithmetic, not correspondence

It checks that each `prepare()` binds as many values as its SQL has placeholders. It cannot see
a statement that has the *right number* of binds in the *wrong slots*, and it did not: V01-008's
`UPDATE_PROJECT_SQL` used `?2..?6` in `SET` and `?1, ?7, ?8` in `WHERE` with `?1` bound to the
project's **name**, and 8-for-8 passed. Every project PATCH was refused with
`409 version_conflict` for the life of the route.

Two cheap additions catch the whole shape: no placeholder may appear in both a `SET` target and a
`WHERE` comparison, and no `SET` target may be a primary key or a tenant column. A placeholder
used for two different columns is malformed whatever the count says.

The stronger property — that the write actually lands and lands in the right columns — is now
covered by `verify:mutating-tenancy`'s per-route positive controls. That is the honest division:
a count proves arithmetic, a probe that requires success proves correspondence.

## GAP-003 — which reauth purpose guards identity linking is unspecified, and the feature is dead until it is

`link_identity_start` requires a grant with purpose `identity_link`; `validate_reauth_purpose`
allows only `passkey_management`, `password_change`, `account_recovery`. No grant with that
purpose can be minted, so `POST /me/identities/link` can never be completed and the
`identity_conflict` guard that implements **FR-F01-012's MUST NOT** is unreachable code.
V01-005. The fix is one line in either of two places, but the two are not equivalent — one
widens what a single security check can authorise, the other reuses an existing purpose — and
`f01` does not say which is intended. Deliberate change process, not a patch.

## GAP-002 — the last-owner rules have no HTTP-layer attack

`f02` requires that removing or demoting the last owner fails transactionally. `can_leave` and
`can_remove_member` are unit-tested, and V01-003 proved `can_change_role` had a real defect
behind a correct-looking test. Nothing attacks the *routes*: can the last owner be demoted,
removed, or made to leave? `smoke:p08` does not reach these routes. Add an owner-actor class to
`verify:privilege-escalation` that tries to end with zero active owners.
## Unattacked, by family

Refreshed after V01-009. Six of the eleven families are now closed or partly closed; the
table below says what is still missing **now**, not what was missing when this list was
first written.

| # | family | what is missing | why it is next |
|---|---|---|---|
| 1 | ~~client privilege escalation~~ | **closed in V01-003** — 46/46 over 7 field classes (org, project, role, policy version, model alias/route, tool capability, entitlement/budget, credential id), graded on the **stored state** and not the status, 4 of 4 mutations detected. M4 was a critical co-owner escalation the probe found by measuring what was stored rather than what was answered. | closed |
| 2 | ~~budget / cost~~ | **the ceiling closed in V01-006** — 27/27, 8 simultaneous reservations for 240 against a limit of 100 grant 3 holding 90, measured not inferred. **Still missing:** usage attribution to org/project/principal/**run**, and whether upstream dispatch was *called* is instrumented nowhere. | Money, and the remaining half is attribution rather than the ceiling. |
| 3 | ~~authentication~~ | **closed in V01-004** — wrong ceremony kind both ways with a control, identity-link conflict, recovery with active sessions; `smoke:passkey` 55/55 -> 76/76. Still open: a revoked **device** driven to a refusal, whether a revoked session's **refresh** token dies with it, the reauth grant's own ceremony kind. | three of nine cases, then the rest |
| 4 | inference streaming | provider faults are unit-tested in Rust (`p09_failure_tests`) but never driven through a real Worker: **429, 5xx, malformed chunk, timeout, client disconnect**, and emit-content-then-fail. Four `mock://` fault modes exist and have never been driven over HTTP. | A unit test is not an attack across a router. |
| 5 | ~~D1 / migrations~~ | **closed in V01-007** — 0015 and 0019 with stored idempotency claims, 19/19, both mutations detected first attempt. Still open: only two cut points, no assertion about a backfill's *content*, foreign keys not exercised. | mostly closed |
| 6 | ~~tenant isolation~~ | **mutating half closed in V01-008** (43/43) and the **query-string half closed in `verify:filter-tenancy`** (54/54): 6 filter routes, a foreign keyset cursor and 5 nested paths, graded by searching the whole body for the other org's identifiers. **and the query-string half closed in `verify:filter-tenancy`** (65/65): 6 filter routes, a foreign keyset cursor, 5 nested paths and the audit route's 12 id filters, graded by searching the whole body for the other org's identifiers. **No leak found on any surface.** Still open: the 28 org-scoped routes beyond the 11 driven, and runs/sessions/automations/usage, which are SKIPped for want of a run fixture. |
| ~~6b~~ | ~~tenant isolation — the **audit** route~~ | **closed** — `AuditListQuery`'s twelve id filters are attacked with values that exist in the other org, read out of that org's own audit rows. **Eight driven, no leak**, including through `metadata_json`, which the route returns in full. The remaining four (`run_id`, `agent_session_id`, `tool_call_id`, `device_id`) have no value in either org and are SKIPped for want of a run fixture. |
| 7 | idempotency / races | **the three required cases with no attack anywhere are now closed in V01-009** — same key + incompatible payload, concurrent same-key (6 and 8, one and different payloads), and a key reused by a different principal, all graded on row counts read from D1. **Still missing:** automation **lease contention** (`ux_automation_leases_active` is a partial unique index and the claim runs in the sweep, so it is the budget-ceiling shape again and has never been measured), and **outbox/webhook retry** side effects. | the same shape as V01-006, one layer down |

## New gaps recorded by V01-009

| # | gap | what it is | why it is not a patch |
|---|---|---|---|
| GAP-005 | `devices.rs` and `foundation_checks.rs` also require an `Idempotency-Key` and ignore it | the same defect as V01-009 on two further route modules, found by reading for the pattern rather than by an attack | they need their own probe to know whether their side effects compose safely into one batch. Copying `projects.rs`'s repair would be assuming the answer. `foundation_checks` is development-only, so its severity is lower. |
| GAP-006 | `organizations.rs` invitations use a read-then-write on a deterministic identifier | `find_invitation` after deriving `invitation_id` from the key. A **race**, not an absence — correct in sequence, wrong under concurrency, which is the budget-ceiling shape | it has not been attacked concurrently. Replacing a proven-in-sequence mechanism with an unproven one without an attack would be the wrong repair. |

## Done in V01, for the record

- **V01-001** adoption/privacy at the API and parser layer — 64 injections, 20/20, the three
  real rules proven, GAP-001 recorded for the deliberate change process.
- **V01-002** a verifier measured code that was not on disk — repaired, `buildFreshness()`
  added so it cannot recur silently.
- **V01-003** an admin could mint unlimited co-owners — **critical, fixed**, the original
  attack re-run unchanged at 0 escalated, four of four mutations detected.
- **V01-004** three authentication attacks the family names and nothing had run — 76/76.
- **V01-006** concurrent reservations against a hard budget ceiling — 27/27, and the atomicity
  is measured: 8 for 240 yields 3 grants holding 90. B1 oversells to 240 when the ceiling is
  neutralised, so the assertion is load-bearing.
- **V01-007** the migration ledger had only ever been applied to an empty database — 19/19
  over two populated prior states. That gap is how `teams` stayed unwritable while every gate
  was green.
- **V01-005** the identity-link feature cannot be completed, leaving FR-F01-012's MUST NOT
  enforced by unreachable code — low, fails closed, recorded for the deliberate change process
  as GAP-003. Found while proving the probe can fail: the section had been asserting the
  email conflict while actually measuring the challenge, because both share the reason code
  `identity_conflict`.

## Carried forward from V00, still open

- **14 of the 15 repaired audit call sites still lack individual runtime proof** (plugins ×6,
  internal ×2, plus others). Drive each over HTTP the way `smoke:p08` seeds orgs.
- **`smoke:p08`'s substituted-id set** covers 20 of 23 driven routes; 54 remaining org-scoped
  routes need a seeded resource and 28 are mutating actions.
- **`VI-DATA-001`'s R2 leg** is BLOCKED by local queue delivery, not by the product. Exit 2
  from `smoke:p06` means the harness could not run, not that a check failed.

## Tooling facts established in V01, so nothing rediscovers them

- **D1 refuses a result set wider than 100 columns.** 100 accepted, 101 refused. Documented on
  `smoke-harness.mjs::d1Rows`. Compound SELECT is unrestricted.
- **`npx` is blocked** in this repository by `pkg-age-guard`, so a limit measured through
  `npx wrangler` is a measurement of the guard. Use `apps/api/node_modules/.bin/wrangler`.
- **A restored file must be put back with `cp`, never `mv`** — `mv` preserves the pre-fault
  mtime, the build is skipped, and the next run measures the faulted binary. `buildFreshness()`
  now reports a served Worker that predates its source.
