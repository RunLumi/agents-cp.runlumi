# §3 — Capability reachability sweep

The question for every guard, policy field and read path is **not** "does this exist?" but:

1. **Is it consulted on a real request path** (a call behind a condition that can never hold is dead)?
2. **Can it be set** (a field that is parsed, stored and never consulted looks exactly like one that
   is enforced)?

Classified by failure direction, because the direction decides severity: **fail-open inert** (a
control that cannot be armed — dangerous), **fail-closed unreachable** (capability absent, not a
breach), **fail-closed and settable** (correct behaviour).

## Instruments run in this campaign

The two standing checks the repository built for exactly this class, re-run explicitly against the
repaired candidate tree (`evidence/v05-standing-checks.log`, both also inside `pnpm check`, exit 0):

| check | result | what it enforces |
|---|---|---|
| `security::repository_liveness::…every_repository_function_is_called_or_on_the_reviewed_list` | **2/2 passed** | every `pub` repository fn has a non-test caller or a reviewed-list entry; `UNTRIAGED`-and-called is refused, so an entry cannot stay a permission slip after its function gets wired |
| `security::repository_liveness::…every_route_handler_is_routed_or_called_or_on_the_reviewed_list` | *(same 2 tests)* | every handler is mounted or reviewed — no unrouted handler, no dead route |
| `security::guarded_column_writers` (5 tests) | **5/5 passed** | every declared arming dependency (tables a guard reads) is written by application code or recorded as unwritable **with a reason**; comments don't count as writers; the detector carries a positive control |

## The open findings, re-derived rather than inherited

Every entry below was re-checked by grep against this tree in this campaign (callers, writers,
routes), not copied from V04's record. **No new capability of the class was found**: the
handler-inventory check passes, and the product tree is unchanged since V04's final sweep — which is
itself the claim this section verifies rather than assumes.

| finding | surface | consulted? | settable? | direction | state in this campaign |
|---|---|---|---|---|---|
| **V04-008** (HIGH) | `org_device_policy_settings.min_client_version` — comparator (`modules/devices.rs:203`), policy read (`routes/devices.rs:386`) and refusal (`devices.rs:822`) all present | yes, on the device path | **no writer in the tree** — mentions: migration 0007 `CREATE TABLE` + the `SELECT` | **fail-open, inert** — a minimum-client-version control exists on paper and cannot be armed; any syntactically valid `app_version` reaches cloud-managed operations | **OPEN, deliberately unrepaired** (adding a write surface to a device-authorization boundary against a spec sentence naming no route is the deliberate process, not a campaign fix); `guarded_column_writers` enforces the class |
| **V04-010** (HIGH) | browser/computer-use policy — `evaluate_browser_rules`/`evaluate_computer_rules` implement all eleven sub-controls (proven 71/71 in V04 with 2/2 sensitivity) | no — every call is refused `capability_not_defined` first: `capability_definitions` has **no INSERT/UPDATE anywhere** (re-grepped: one SELECT, the CREATE TABLE, one unique index) | no | **fail-closed, unreachable** | **OPEN, deliberately unrepaired** (finding names the small fix: `routes/tools.rs:2247` already projects the `capability_key` spelling) |
| **V01-046** | webhook **fan-out** — `fan_out_event_statement` + `fan_out_count` + notification cluster | no caller (re-grepped) | n/a | **fail-closed, unreachable** — a committed business event is never delivered to a subscriber; the live delivery path is operator-initiated | **OPEN by decision** (wiring = feature decision across ~22 route files); proven rather than assumed by `verify:webhook-fanout` (19/19 incl. delta-based W5) |
| **V01-047** | `'run'` usage **writer** + usage rollups — `is_run_source()` called from five read-path sites, structurally incapable of being true in production | the reads are wired; the writes are not (`UsageSource::Run` constructed only in tests) | no | **fail-closed, half-built** — `usage_events` CHECK admits `'run'`, reads UNION ALL a permanently-empty table | **OPEN by decision** (what counts as billable non-inference usage is a money decision) |
| **V01-050** (HIGH) | `provider_entitlement_projections` — the ONLY INSERT has **no caller**; the table is never seeded; `GET /api/v1/orgs/{org_id}/entitlements/provider` (`routes/billing.rs:633`) reads it | the read is **routed, authenticated, org-scoped** | no | **fail-closed presenting as success** — the endpoint answers `200 {items: []}` forever; V01-030's shape on a customer surface (a success status over a thing that can never exist) | **OPEN** — this is the one member of the family a customer can touch, which is what makes it a finding rather than a note |
| **V01-040** | staff grant **use** (ADR 0007 "grant on every use") | no route consumes a grant; the documented, tested, correctly-scoped `find_grants_for_staff_and_org` has no non-test caller | no | **fail-closed, absent** — staff cannot reach customer context at all (no fail-open path) | **OPEN, deliberately unrepaired** (a feature needing its own spec/ADR); recorded UNTRIAGED-safe by the liveness check |
| **UNTRIAGED ×2** | `budget`, `list_attempts` (repository fns) | no non-declaration occurrence outside prose/strings | — | unknown, uncalled | honestly marked UNTRIAGED by the check, which refuses them the moment they get called without triage |
| **V05-001** (HIGH, repaired) | production WebAuthn config — the guard here is *existence of the adapter* | yes when armed | the candidate's own config **could not arm it** (no vars) | fail-closed, ambiguous signal → silent disable with a lying message | **REPAIRED** (§1) — vars converged + `passkeys_not_configured` distinction, regression-proven |
| **V05-002** (MEDIUM, repaired) | no-adapter passkey answer | — | — | fail-closed but **indistinguishable from a D1 outage** | **REPAIRED** (§1) |

## Coverage gaps vs capability gaps

V04's lesson — "unproven because untested" and "unproven because absent" are indistinguishable from
inside a coverage table — is applied to this campaign's own additions: the PasskeyAdd /
Reauthenticate replay rows were a **coverage gap** (probe missing, product correct — closed by adding
11 checks), while V05-001 was a **capability gap in configuration** (closed by converging config) and
V05-002 a **distinguishability defect** (closed in code). No row in this campaign was recorded
UNPROVEN without first asking *does a route exist that makes this reachable?*

## What this sweep does not claim

- The declared-list checks are liveness/arming checks, not correctness checks: a function being
  called is not the function being called correctly, and the tenant-isolation correctness claims rest
  on §2's runtime gates, not here.
- A capability that is present and merely unwired from a route is still only findable by reading —
  the two standing checks cover the function and column shapes mechanically; this section's
  re-derivation covers the known instances.
