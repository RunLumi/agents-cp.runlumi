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

## Unattacked, by family

| # | family | what is missing | why it is next |
|---|---|---|---|
| 1 | client privilege escalation | **no runtime attack at all.** No probe anywhere attempts a client-supplied role, permission, `org_id`, policy version, or model alias and checks whether the server's authority wins. | A whole Tier-0 family with zero attacks. VFY-011 was exactly this class of defect and was found by accident. |
| 2 | budget / cost | usage attribution to org/project/principal/run: 0 mentions. Concurrent overspend: 0 mentions. Whether upstream dispatch was *called* is instrumented nowhere. | Money, and neither claim has been touched. |
| 3 | authentication | wrong ceremony kind (0 mentions), identity-link conflict (0), recovery with active sessions (the single "recovery" hit is about last-login-method removal, not recovery). | Three named attacks in the family's own list that have never been run. |
| 4 | inference streaming | provider faults are unit-tested in Rust (`p09_failure_tests`) but never driven through a real Worker: 429, 5xx, malformed chunk, timeout, client disconnect. | A unit test is not an attack across a router. |
| 5 | D1 / migrations | every run is a **fresh** database. A migration that only works on empty tables is not tested. | `verify:restore` exists and passes; "representative prior state" does not. |
| 6 | tenant isolation | 82 of 104 org-scoped routes have no handler-level evidence, and **no mutating cross-tenant call is made at all** — every substitution is a GET. No filter, no pagination, no nested route. | The most developed probe in the repo, and it only reads. |

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
