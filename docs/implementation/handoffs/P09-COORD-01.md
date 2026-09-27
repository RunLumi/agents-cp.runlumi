# P09 work packets — summary

P09 is a hardening phase, not a feature phase, so this is a single coordinator
handoff covering the five workstreams rather than one file per lane. Each section
names the code, the tests, and the findings.

## What exists now that did not before

| Artifact | What it does |
|---|---|
| `apps/api/src/security/tenant_audit.rs` | Classifies all 421 SQL statements touching a tenant-owned table; 10 tests |
| `apps/api/src/security/secret_canary.rs` | 32 runtime + static cases over 11 canary constants |
| `apps/api/scripts/p09-secret-canary.mjs` | 14 cases over 141 web + 166 API sources |
| `apps/api/tests/egress_corpus.rs` | 70 hostile egress inputs, 11 tests |
| `apps/api/src/modules/p09_failure_tests.rs` | 32 failure-injection tests |
| `apps/api/src/security/release_docs.rs` | Keeps two generated release documents from rotting |
| `docs/release/*.md` | Eleven release artifacts |

**All of it runs in `pnpm check`**, so it is a gate rather than a claim.

## Contracts consumed

- `p09` plan, `plan00` execution model, ADR 0001–0007.
- **No frozen contract was changed.** One frozen *artifact* (`p07-contracts-v1.json`)
  was completed so two languages could be held to one document; the reasoning is in
  `P09-IG.md` and in the fixture's own `_note`.

## Contracts produced

- The six-way tenant classification, and the three concepts it forced:
  platform-scoped tables, bounded platform sweeps, and credential lookups as a
  boundary.
- A stable set of log codes, already pinned by a test: `outbox_retry_sweep_failed`,
  `automation_sweep_failed`, `budget_expiry_sweep_failed`, `p06_data_job_rejected`,
  `p06_job_dead_lettered`, `webhook_delivery_store_unavailable`,
  `worker_clock_unavailable`.

## Runtime/deployment impact

- No new bindings. No new secrets. No new env var.
- Worker upload: 2318.19 → 2321.58 KiB gzip (+0.15%) for two correctness fixes.
- Initial JS and CSS: **unchanged, 0 bytes**. The audit modules are `#![cfg(test)]`
  and are not in the bundle.

## Findings

Eleven real defects, each found by a test rather than by review. Full list with
before/after in `gates/P09-IG.md`. The four that changed the security posture:

1. A dead-lettered job was **invisible** — the jobs DLQ was declared and never read,
   so FR-F21-009 was failing outright.
2. A truncated provider stream was recorded as a **successful** run with the budget
   reservation **committed** at the full upper bound. Overcharged the tenant, and the
   money is immutable by design.
3. Ten secret-bearing records had a `derive(Debug)` that would print the hash.
4. Four tenant tables were **never audited** because the tenant column has two
   spellings and the original scan knew one.

## Known limitations

See `docs/release/known-limitations.md`. The two that most deserve a decision:

- **The plugin declaration filter accepts 41 inputs the fetch guards refuse.** Not an
  SSRF — nothing dials a recorded declaration — but a manifest declaring
  `http://0177.0.0.1` is shown to a reviewer as a permitted public destination. It is
  a change to a reviewed P07 surface and a frozen fixture, so it is a coordinator
  decision, not a QA edit.
- **`security_events.metadata` is unsanitized** while `audit.metadata` is. No secret
  reaches it today; the exposure is that a future engineer could add one. Both
  available fixes are a frozen-contract change or a security-allow-list edit.

## Do not assume

- That the tenant audit proves routes are safe. It proves the **statements** are. A
  route passing the wrong id to the right statement is a call-graph property it cannot
  see.
- That 97/97 storage invariants means the system is safe. It means 97 declared
  behaviours match the DDL.
- That `pnpm check` being green means the release is ready. The field metrics and the
  restore rehearsal were not performed, and `docs/release/performance.md` and
  `backup-restore.md` both say so at the top.
- That the audits are the only security control. They are a *floor*, and they were
  written by the same people who wrote the code — which is a real limitation and is
  why the threat model's residual risks are stated rather than waved away.

## Follow-up packets

1. **Backup/restore rehearsal.** First. `docs/release/backup-restore.md` is the
   procedure; it needs running, and its two numbers replacing "unknown".
2. Browser pass over every surface.
3. Staging deploy to measure the field metrics.
4. A metrics pipeline: `logpush`, alerts, a dashboard.
5. Two Change Requests (the plugin declaration filter; the metadata allow-list).
6. D1-specific integration tests via `wrangler dev --local`.
