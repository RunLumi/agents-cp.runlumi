# Release checklist

The gates from `plan09` §3, with the evidence and the honest verdict. **This release
is a PASS WITH FOLLOW-UP.** The follow-ups are named, and none is security-critical,
tenant-isolation-critical, data-loss-critical, or contract-breaking — which is the bar
`templates/integration-gate.md` sets for a phase to exit on anything other than a
plain PASS.

## Gate A — Functional: all P0 acceptance criteria pass

**PASS.**

| Phase | Evidence | Verdict |
|---|---|---|
| P01 foundation | Outbox + idempotency, both durable and CAS-guarded | PASS |
| P02 identity/org/authz | The central `authorize`; untouched since, per ADR 0007 | PASS |
| P03 devices/projects/policy | Enroll → bind → ack; consumed-state makes a one-time token non-replayable | PASS |
| P04 AI platform | Catalog, encrypted credentials, compiled routes, bounded retry/fallback | PASS |
| P05 runs/tools/usage | Run state machine, tool policy, budgets, usage | PASS |
| P06 automations/events/billing/data | 22 routes, merged job queue, 72-class data registry | PASS |
| P07 enterprise/admin/plugins | 22 routes, 3 actor types, plugin governance, staff boundary | PASS |

**P08 is not built** and is not required for a P0 gate. The server-side seams for it
(`/plugin-reports`, `/machine/whoami`) exist and are tested; no LumiAgents repository
was touched. See `known-limitations.md`.

**934 Rust tests · 11 egress-corpus tests · 720 web tests · 97 storage invariants ·
14 secret canaries.** `pnpm check` exits 0.

## Gate B — Security: no known critical/high issue

**PASS.** Six real defects were found by the three audits and fixed. None was
security-critical in the sense of "an attacker with no credential reaches data", and
each is closed by a test that fails if the property regresses.

| Finding | Severity | Status |
|---|---|---|
| Plugin detail projection omitted `blocked_reason` that the browser's decoder requires — the page rendered nothing, with no error | High (availability + a silent contract break) | Fixed, pinned on both sides |
| A documented `*.suffix` manifest form was unrefusable, so any plugin using it could not be reported at all | Medium (governance) | Fixed |
| The expansion refusal rendered as a raw event id plus a JSON blob to the reviewer who most needed a sentence | Medium (governance) | Fixed |
| 10 secret-bearing records had a `derive(Debug)` that would print the hash | Medium (secret exposure, one log line away) | Fixed, all 32 canaries green |
| The provider URL validator read a different host than the transport dialled (`0177.0.0.1` → `127.0.0.1`) | Medium (defence-in-depth; the allowlist held) | Fixed |
| The webhook IPv6 range table was unreachable dead code | Low (right answer, wrong reason) | Fixed |
| `RECORD_TERMINAL_FAILURE_SQL` had no compare-and-set, so a replay could double-count and auto-disable a recovered endpoint | Medium (availability) | Fixed |
| The jobs dead-letter queue was declared and never read — a poisoned job vanished | High (F21-009 failing outright) | Fixed |
| Four P07 permissions were in `Permission` but not `role_allows`, so only Owner had them | Medium (authorization) | Fixed in P07 |
| `block` wrote its reason only to the audit event, leaving `blocked_reason` empty | Medium (the fact an operator needs) | Fixed in P07 |

**The five release-bar categories, each with its evidence:**

- **Tenant isolation** — 421 SQL statements classified, 0 unclassified, every chain
  bottoming out in a real boundary. `security::tenant_audit`, 10 tests.
- **Authentication/session integrity** — unchanged since P02; P07 added a third actor
  type that cannot reach a human-only route (ADR 0007, a compile-time fact).
- **Secret exposure** — 46 canary cases across Rust and the workspace, both halves
  proven able to fail by planting four separate leaks.
- **Remote-code / tool policy bypass** — F13 default-deny is the *absence* of a
  registration row, so there is no path where an un-registered tool runs.
- **Irrecoverable data loss** — `usage_events` has no UPDATE and no DELETE trigger.
  A cost record cannot be rewritten, by anyone, including a migration.

**Residual, accepted:** the plugin declaration filter accepts 41 inputs the fetch
guards refuse, and `security_events.metadata` is unsanitized. Both are documented in
`known-limitations.md` with the reason each was not fixed in this packet. Neither is
an SSRF and neither carries a secret today.

## Gate C — Performance: no unexplained regression

**PASS on what is measurable. INCOMPLETE on field metrics — this is the main
follow-up.**

| Budget | Limit | Measured | |
|---|---|---|---|
| Initial JS | 170 KiB gzip | **100.11 KiB** | PASS |
| Initial CSS | 35 KiB gzip | **8.72 KiB** | PASS |
| Largest route chunk | 80 KiB gzip | **40.17 KiB** | PASS |
| P07 chunks | 80 KiB gzip | 16.55 / 16.71 KiB | PASS |

**Hardening cost 0 bytes of initial JS and 0 of CSS** — the audit modules are
host-only test code. Worker upload grew 3.4 KiB gzip (+0.15%) for the dead-letter
consumer and the budget sweep, both correctness fixes.

**No budget was raised to make a number pass.** LCP, INP, CLS, Worker p50/p95, D1
query count and latency, TTFT, streaming memory, and fallback latency are **not
measured** and need a staging deploy. `performance.md` lists what each would take.

## Gate D — Operations: failures are observable and actionable

**PASS, after two fixes this phase found it was missing.**

| Question | Answered by |
|---|---|
| What is failing? | Stable `error.code` + `details.reason`; three pinned log codes; `security_events` by type |
| Which tenant/provider/resource? | Every durable row carries `org_id`, except the two platform tables where it names the *customer*; `provider_health` per provider and model |
| When did it begin? | Hourly histogram from `occurred_at`, cross-referenced against the last deploy |
| Blast radius? | `GROUP BY organization_id`; live budget holds rather than estimates |
| What changed? | Row `version` history, deploy time, config change, migration (which cannot have rewritten data) |
| Safest rollback or kill switch? | Ranked table in `runbook.md`; kill switches are surgical and cannot be re-engaged in place |

**This gate was FAILING at the start of P09 and is why.** The jobs dead-letter queue
was declared, had a consumer attached, and was never read — so a tenant's
dead-lettered webhook was invisible in Lumi and only the Cloudflare dashboard showed
it. FR-F21-009 was not satisfied. Fixed, with the routing order, the
record-before-acknowledge, and the redeliver-on-store-failure all pinned.

**Also fixed:** `expire_reservations_statement` had zero callers, so a hold leaked by
a crash never reached a terminal state and an operator summing `status = 'reserved'`
saw a phantom hold forever. Not a spend leak — admission already ignores an expired
hold — but it is exactly the signal needed to tell "someone is spending" from "a
Worker died an hour ago".

## Gate E — Rollback: paths are tested, not theoretical

**PASS.**

| Path | Mechanism | Evidence |
|---|---|---|
| Worker deployment | Cloudflare version rollback, no down-migration needed | `pnpm build` dry-run; schema is forward-only |
| DB migration compatibility | Every migration from P02 onward creates tables | Asserted in `schema-migration-map.md`; the direction that matters is tested by the schema harness, which applies all 18 in order |
| Policy/route versions | Optimistic concurrency on `version`; a stale write is a 409, never a lost update | Pinned per repository |
| Provider kill switch | Disabling a provider or narrowing its route; `LUMI_PROVIDER_ALLOWLIST` is operator-owned, exact-host, empty by default | `core/egress.rs` + the corpus |
| Client compatibility window | Additive-within-`v1`; the app and API ship together; decoders are allowlists | `compatibility-matrix.md` |

**The rollback that was not tested:** a real restore rehearsal. `backup-restore.md`
describes the procedure and states plainly that no RPO or RTO has been measured. The
design makes a restore likely to succeed — FK cascades, latched terminal states,
append-only cost records — but a design argument is not a rehearsal.

## Rollout

**A smaller reversible release, per the release principle.**

1. **Pre-flight:** `pnpm check` green; apply migrations; confirm the 97 invariants
   against the target database (`node apps/api/scripts/p07-schema-invariants.mjs`) —
   this is the step that catches a restored database whose triggers are missing.
2. **Deploy** the Worker. Old and new are schema-compatible in both directions.
3. **Watch, in this order, for one hour:** error rate by code, dead-letter count,
   queue lag, `automation_sweep_failed`, provider health.
4. **Confirm** the sweeps ran: outbox retry, automation due/lease, budget expiry. A
   backlog drains; do not bulk-advance it.
5. **Roll back** on any unexplained error-rate step. It is a version rollback, not a
   migration reversal.

## The follow-ups, named

Not release-blocking, and each with an owner-shaped next action.

| # | Follow-up | Why it is not blocking |
|---|---|---|
| 1 | **Backup/restore rehearsal.** No measured RPO or RTO. | The design is sound and the invariant harness is the verification step; what is missing is the run, not the mechanism. **Do this first.** |
| 2 | **A browser pass** over every surface at desktop and narrow widths, with focus and async states. P06, P07, and P09 all carry this. | Async states are unit-tested and a keyboard trap was found and fixed; nothing is *believed* broken. |
| 3 | **Staging deploy** to measure LCP/INP/CLS, Worker p50/p95, D1 latency, TTFT, and fallback latency. | The bundle budgets are measured and gated; the field metrics are unknown, not regressed. |
| 4 | **A metrics pipeline** — `logpush`, alerts on the eight stable codes, a dashboard for the eight queries in `slo-and-dashboards.md`. | Every query an operator needs runs today against D1. What is missing is a place to look at them. |
| 5 | **LumiAgents** implementation of `/plugin-reports` and `/machine/whoami`. | Both server-side contracts exist and are tested. |
| 6 | **A Change Request** for the plugin declaration filter, and one for the
`security_events` metadata allow-list. | Both are frozen-contract-adjacent and both are documented with the risk. |
| 7 | **D1-specific integration tests** via `wrangler dev --local`: real CAS refusal, real unique-index rejection, and the dead-letter branch end to end. | Every one of those properties is proven at the statement level; a D1 `PreparedStatement` cannot be constructed on the host. |

## The honest summary

The evidence is strong on the things that can be proven without a deployed
environment, and it is **absent** on the things that cannot. That split is deliberate
and it is the reason this is PASS WITH FOLLOW-UP rather than PASS: a release whose
untested surface is a *rehearsal* and a *browser* is a smaller reversible release,
which is what the goal prompt asks for. A release whose untested surface were tenant
isolation or money would not be shippable at any deadline.
