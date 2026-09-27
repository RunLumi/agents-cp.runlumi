# Integration Gate — P09-IG

## Goal

Prove the system can be trusted in production, or say precisely where it cannot.

**Exit decision: PASS WITH FOLLOW-UP.**

The template's bar: a phase cannot exit on "PASS WITH FOLLOW-UP" if a follow-up is
security-critical, tenant-isolation-critical, data-loss-critical, or
contract-breaking. Every one of the seven follow-ups below is a **rehearsal, a
browser, a staging deploy, a metrics pipeline, a downstream host, or a Change
Request**. None is a known defect in a release-bar category.

This is deliberately "a smaller reversible release over a larger impressive one with
unknown failure modes". The untested surface here is a rehearsal and a browser, not
tenant isolation or money.

## Preconditions

- [x] required packets merged — SEC-01/02/03, REL-01, PERF-01, OPS-01, QA-01
- [x] contract version is current — no frozen contract was changed. One frozen
      *artifact* was completed (below), which is argued explicitly rather than buried
- [x] migrations applied in test environment — all 18, in order, by the schema harness
- [x] no known contract drift — `pnpm check` green; 421 statements classified
- [x] shared-file owner confirms integration branch/main is coherent — this phase
      touched no other phase's contract, and the two `lib.rs` changes are in the
      coordinator's own file

## The three automated audits, and why they are audits

The phase's central decision: **134k lines of Rust cannot be reviewed by hand in the
time available, and "we read it and it looked fine" is not evidence.** So each
workstream became a mechanical check that fails when the property stops holding.

| Audit | Cases | Wired into |
|---|---|---|
| `security::tenant_audit` | 421 statements classified, 0 unclassified, 10 tests | `pnpm test` |
| `security::secret_canary` (Rust) | 32 cases over 11 canary constants | `pnpm test` |
| `scripts/p09-secret-canary.mjs` | 14 cases over 141 web + 166 API sources | `pnpm test` |
| `scripts/p07-schema-invariants.mjs` | 97 storage invariants | `pnpm test` |
| `apps/api/tests/egress_corpus.rs` | 70 hostile inputs, 11 tests | `cargo test` |
| `security::release_docs` | 2 documents vs. the code | `pnpm test` |

**Every one of them was proven able to fail.** The secret canaries were broken four
ways and each was caught — twice, independently, for the two Rust breaks. The
cross-tenant cases were verified to fail when their `org_id` predicate is deleted
(97/97 → 94/97). The egress corpus asserts the *current* behaviour in both
directions, so it cannot silently tighten either.

## What the audits found

Eleven real defects. Each found by a test, not by review. All fixed, all pinned.

### Release-bar categories

**1. The plugin detail page would have rendered nothing.** `install_json` omitted
`blocked_reason`, which the browser's decoder *requires*; the detail decoder returned
`undefined` and the page rendered nothing — with no error anywhere. Two
implementations of one wire contract in two languages have no shared compiler, so the
frozen fixture is now what holds them together: the Rust side pins its key set to it,
the TypeScript side decodes it and requires an exact match.

**2. A documented manifest form was unusable.** `rejects_destination` split on `://`
first, and a `*.suffix` pattern has no scheme, so every wildcard destination was
classified as unparseable and the whole plugin report was refused — for a form the
field's own documentation promises. The suffix is now the host that gets evaluated,
and a pattern rooted at a private or loopback name is refused the same way an exact
literal is.

**3. The expansion refusal rendered as a code and a JSON blob.** The client compared
the stored reason to the *bare* event id, which the server never writes: it writes the
id plus a JSON summary. Every real expansion therefore fell through to the generic
branch, and the reviewer saw
`Recorded reason: plugin.permission_expansion_detected.v1 {"expands":true,…}` at the
one moment they most needed a sentence.

**4. Ten secret-bearing records had a `derive(Debug)`** that would print the hash — a
panic message, an `unwrap()`, a test failure, and a log line from production. All now
hand-written and redacting with `finish_non_exhaustive`, so adding a column later
cannot start printing without a deliberate edit.

**5. A dead-lettered job was invisible.** `JOBS_DLQ_NAME` was declared in
`wrangler.jsonc` with a consumer attached and had **zero references in Rust**. A
poison `webhook.deliver` that exhausted its retries fell through to the outbox
consumer, failed to decode as a business event, and was acknowledged as an invalid
message. `consumers::dead_letter_statement` had zero callers. FR-F21-009 was not
satisfied and only the Cloudflare dashboard showed the failure. This is a Gate D
failure the phase *found* and *fixed*.

### Also found

**6. A truncated stream was recorded as a successful run.** The most serious defect
in the phase. A provider body that closed without `data: [DONE]` — connection cut
between frames, upstream fault, an intermediary dropping the tail — was recorded as
`response_state = 'completed'` with the **budget reservation committed at the full
upper bound**, plus a `usage_events` row estimated at the reservation, plus
`usage.recorded` and `inference.completed`. So: the tenant was overcharged for output
that never arrived, the money was immutable by design, and the audit trail asserted
something false. The decoder had always known; nothing read it at the end. Now
`may_complete()` gates the terminal decision and a short stream releases the
reservation, exactly as a timeout already did.

**7. An unguarded webhook write.** `RECORD_TERMINAL_FAILURE_SQL` was
`WHERE endpoint_id = ?1` with no guard while every sibling transition in that file
was compare-and-set, so a re-driven delivery incremented the counter twice and could
disable an endpoint that had already recovered.

**8. SQL that hid from the audit.** `policy_conflicts` held its SQL as an inline
literal inside the function, invisible to the tenant audit *and* to the repository's
own hand-enumerated org-binding test. The F25-004 conflict query was outside both.

**9. Four tenant tables were never audited at all.** The tenant column has two
spellings — `0011` and `0018` wrote `organization_id`, everything else `org_id` — so
a single-spelling scan silently excluded `idempotency_records`, `outbox_events`,
`support_grants`, and `kill_switches`. That is the whole P01 idempotency/outbox tenant
surface and the P07 grant/kill-switch surface, whose queries nothing was verifying.

**10. The provider URL validator read a different host than the transport dialled.**
It hand-split on `://` and handed the substring to `IpAddr::from_str`, while the
runtime's `Url::parse` folds `0177.0.0.1`, `2130706433`, and `127.1` to `127.0.0.1`. So
the range check read a public-looking string and passed. It was a defence-in-depth
layer, and the control — an operator-owned, exact-host, empty-by-default allowlist —
held. But it was a real fail-open.

**11. The webhook IPv6 range table was dead code.** `url` returns IPv6 hosts
bracketed, so `parse::<IpAddr>()` always failed and `is_blocked_v6` was unreachable.
`https://[::1]/hook` was rejected — for the right answer, by the DNS-name syntax check.
The test passed the whole time, testing nothing.

## The three concepts the audit forced into existence

Each is a distinction the code did not have and the audit could not avoid making.
That is the strongest signal in this phase that the audit was worth writing.

**A platform table is not a tenant table.** `support_grants.organization_id` and
`kill_switches.organization_id` name the **customer** a staff principal acts on, not a
caller scope. A staff principal is not a member of any organization, so "bound the
caller's tenant" is not a property those tables can have. Their isolation is the staff
boundary, which is now its own class with its own test: the platform tables are named
from no other module, and the `/api/v1/internal/*` prefix is asserted against the
mounted constants rather than a comment.

**Two statements must cross tenants, and both must be bounded.** The queue dispatcher
serves every organization, and the idempotency expiry purge deletes dead rows. They
are the only two, and the class requires a `LIMIT` — because an unbounded cross-tenant
statement is a table lock waiting for load.

**A credential lookup is a boundary, not a hole.** `KEY_BY_PREFIX_SQL` has no org
predicate and must not: a key is found by a 12-hex prefix from 32 CSPRNG bytes, and
the secret half is then verified in constant time. There is nothing for a caller to
tamper with. Requiring a predicate there would be requiring a bug.

## The frozen artifact that was completed, not changed

`p07-cg-v1` freezes the *existence* of the plugin-install fixture. That block now
carries the full detail projection with its nulls spelled out, and states the
`review_reason` wire format as a format rather than only as an example.

Both exist so that two implementations of one wire contract, in two languages with no
shared compiler, are held together by a document instead of by luck. **No frozen
behavior changed and no Change Request is needed** — but the boundary is arguable, so
it is argued here rather than buried: the alternative was leaving a cross-language
contract unpinned after defect #1.

## Performance

Measured, and `pnpm build` is in CI so a regression is a red build.

| Budget | Limit | Measured |
|---|---|---|
| Initial JS | 170 KiB gzip | **100.11 KiB** |
| Initial CSS | 35 KiB gzip | **8.72 KiB** |
| Largest route chunk | 80 KiB gzip | **40.17 KiB** |
| P07 chunks | 80 KiB gzip | 16.55 / 16.71 KiB |

Hardening cost **0 bytes** of initial JS and CSS — the audit modules are host-only.
Worker upload grew 3.4 KiB gzip (+0.15%) for two correctness fixes. **No budget was
raised to make a number pass.**

**Not measured, and stated as such:** LCP, INP, CLS, Worker p50/p95, D1 query count
and latency, TTFT, streaming memory, fallback latency. Each needs a deployed
environment. This is the largest gap in the evidence and it is why the Performance
gate is qualified rather than passed outright.

## The gates

| Gate | Verdict | Note |
|---|---|---|
| A — Functional | **PASS** | All P0 phases. 934 Rust + 11 corpus + 720 web tests |
| B — Security | **PASS** | Eleven defects found and fixed; all five release-bar categories have named evidence |
| C — Performance | **PASS on budgets, INCOMPLETE on field metrics** | The one qualified gate |
| D — Operations | **PASS, after fixing two failures this phase found** | DLQ invisibility and the leaked hold |
| E — Rollback | **PASS** | Except a restore rehearsal, which was not run |

## Exit decision

**PASS WITH FOLLOW-UP.**

| # | Follow-up | Why it is not blocking |
|---|---|---|
| 1 | Backup/restore rehearsal — no measured RPO or RTO | The mechanism is sound and the invariant harness is the verification step. What is missing is the run. **Do this first.** |
| 2 | A browser pass over every surface, desktop and narrow, with focus and async states | P06, P07, and P09 all carry this. Async states are unit-tested; a keyboard trap was found and fixed |
| 3 | Staging deploy to measure the field metrics | Bundle budgets are measured and gated; field metrics are unknown, not regressed |
| 4 | A metrics pipeline: `logpush`, alerts on the eight stable codes, a dashboard | Every operator query runs against D1 today. What is missing is a place to look |
| 5 | LumiAgents implementation of `/plugin-reports` and `/machine/whoami` | Both server-side contracts exist and are tested |
| 6 | Change Requests for the plugin declaration filter and the `security_events` metadata allow-list | Both frozen-contract-adjacent, both documented with their risk |
| 7 | D1-specific integration tests via `wrangler dev --local` | Every such property is proven at the statement level; a D1 `PreparedStatement` cannot be constructed on the host |

## The honest summary

The evidence is strong where it can be produced without a deployed environment, and
**absent** where it cannot. That split is the finding, and it is the reason this is
PASS WITH FOLLOW-UP rather than PASS.

The most valuable single thing this phase produced is not a fix. It is the discovery
that the existing tenant-isolation tests were **hand-enumerated lists** — good tests,
covering four repositories, missing four tables and one inline SQL literal — and that
a mechanical audit over the whole tree finds what a list cannot. The same argument
applies to the secret canaries: ten `derive(Debug)` impls sat in files whose *domain*
twin one layer up already redacted correctly, and no reviewer had flagged them
because the pattern is right everywhere else in the file.
