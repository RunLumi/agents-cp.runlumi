# Architecture map

What the system is, at the level a new engineer needs to be productive and an
incident responder needs to navigate it.

## The shape

```text
                    ┌───────────────────────────────┐
   browser  ──────▶ │  Edge: SPA (static, Vite)     │
                    │  React 19 · TS 7 · Tailwind 4 │
                    └───────────────┬───────────────┘
                                    │  /api/v1/*   (session cookie or
                                    │               lumik_ bearer)
                    ┌───────────────▼───────────────┐
                    │  Worker (Rust · wasm32)         │
                    │                               │
                    │  http/      middleware, auth   │
                    │  routes/    thin · 31 modules  │
                    │  modules/   domain decisions   │
                    │  repositories/ SQL + mapping   │
                    │  adapters/  platform edges     │
                    │  core/      primitives         │
                    └───┬───────────┬───────────┬────┘
                        │           │           │
              ┌─────────▼──┐  ┌─────▼─────┐  ┌──▼──────────┐
              │ D1         │  │ Queues    │  │ R2          │
              │ 107 tables │  │ outbox    │  │ exports     │
              │ 190 indexes│  │ jobs      │  │ (private)   │
              │ 66 triggers│  │ + 2 DLQs  │  │             │
              └────────────┘  └─────┬─────┘  └─────────────┘
                                    │
                        ┌───────────▼───────────┐
                        │ third-party providers │
                        │ (allowlisted hosts)   │
                        └───────────────────────┘
```

## Layering, and why it is this way

The dependency arrow points one way: `core` knows nothing, `adapters` know about the
platform, `repositories` own SQL, `modules` decide, `routes` translate. A route that
contains a decision is a route that cannot be tested without a Worker.

| Layer | Count | Owns | Never does |
|---|---|---|---|
| `core/` | primitives | IDs, timestamps, errors, events, pagination, idempotency, credential hashing | Anything platform-specific |
| `adapters/` | 8 modules | D1, R2, Queues, R2 artifact store, webhooks (incl. DoH resolver), email, providers, password | Deciding anything |
| `repositories/` | 21 modules | Every SQL string and row mapping | Authorizing. It takes trusted values and binds them |
| `modules/` | 20 modules | Pure decisions: authorization, budgets, tool policy, run state, entitlement, data governance, plugins, staff, rollouts, machine identity | Touching D1 or HTTP |
| `routes/` | 31 modules | Parse, authorize, delegate, project | Deciding, or building SQL |
| `http/` | middleware + auth | Request context, session resolution, `require_machine`, `require_staff` | Business rules |
| `jobs/`, `consumers/` | 6 modules | Queue handlers and cron sweeps | Deciding |

## The request path

```text
request
  → http/middleware      assign a request_id + correlation_id, reject oversized bodies
  → http/auth            session cookie OR lumik_ bearer OR staff credential
                          → one of three ACTOR TYPES, never merged (ADR 0007)
  → routes/*             validate at the boundary · authorize · delegate · project
  → modules/*            decide. Pure. No D1, no HTTP, no clock.
  → repositories/*       prepare SQL with bound parameters, map rows
  → D1
```

**Three actor types, three decision functions, no conversions.** This is ADR 0007's
load-bearing claim and it is a compile-time fact: `Principal`/`authorize` are
untouched, and there is no expression of `ApiKeyScope` or `StaffRole` that becomes a
`MembershipRole`. A machine or staff caller cannot reach a route that only calls
`authorize`, because those handlers take `Option<&Principal>` and there is no
conversion into one.

## The async path

Two queues carry **different envelopes**, and they are told apart before any decode:

| Queue | Envelope | Consumer |
|---|---|---|
| `lumi-agents-outbox` | `EventEnvelope` — the business event | Outbox consumer, dedupes by event id |
| `lumi-agents-jobs` | `QueueJobEnvelope` — job id, dedupe key, generation, lease version | Routed on `job_type` |
| `*-dlq` (both) | same as its parent | Terminal, recorded durably before ack |

Decoding one as the other would let a source event's delivery status be mistaken for
job or webhook delivery state, so the split happens first — and there is a test
proving neither envelope can be read as the other.

`workers-rs` generates a single `#[event(queue)]` per crate, so the P01 outbox, the
P06 jobs, and the two dead-letter consumers share one handler and branch on which
queue the batch arrived on.

**Every state change on the async path is a compare-and-set** on version or on the
observed state, and the outbox attempt is recorded in the **same D1 batch** as the
transition. A `running` job row is therefore never durably observable, and a lost
guard rolls the side effect back with it.

## Storage

D1 is the source of truth; Queues are at-least-once and every consumer deduplicates.
R2 holds only export artifacts, in a **private** bucket, reachable only through a
single-use expiring download grant (ADR 0006).

18 migrations, 107 tables, 190 indexes, **66 triggers**. The trigger count is the
headline: an invariant enforced only in Rust is one code path away from being
bypassed. The full map, including what each trigger class refuses, is in
`schema-migration-map.md`.

## The scheduled path

One cron, every minute, running three bounded sweeps:

1. **Outbox retry** — publish due events.
2. **Automation due + lease expiry** — the authoritative clock. Advances
   `schedule_cursor_at` and expires leases from D1 state, so a missed tick loses no
   work and a late tick does not double-dispatch.
3. **Budget expiry** — expire holds whose request died. Not a spend control (admission
   already ignores an expired hold); it is the only way such a hold reaches a
   terminal state.

All three are re-entrant and bounded. A missed tick loses nothing.

## Frontend

Route-level code splitting, one chunk per Settings surface. No barrel files, no
global server-state store, shallow provider nesting. Decoders are **allowlists**
that copy named fields and never spread, so a future server revision that started
adding a field to a projection could not reach component state.

`apps/web/src/components/ui` does not exist in this repository. The P07 surfaces
build their primitives from the existing `globals.css` tokens, so no component
library was added and no Radix package exists anywhere.

## What is deliberately absent

| Absent | Why |
|---|---|
| F06 — domains, SSO, SCIM | P2. The entitlement keys already exist (`sso.enabled`/`scim.enabled` defaulting `false`), so the gating seam is complete without schema. Frozen in full in the P07 gate. |
| An internal operations console | P07 gate decision 4. The staff boundary, grants, flags, and kill switches are implemented and tested at the API and domain layers; no staff user exists to need a UI. |
| A second queue entry point | `workers-rs` hard-codes one. P07 reuses the P06 envelope rather than adding a macro. |
| An async runtime | Not supported on Workers, and nothing here needs one. |
| A down-migration | Every migration from P02 onward creates tables rather than altering them, so a rollback is a **Worker** rollback. See the schema map. |

## Where to start reading

| Question | File |
|---|---|
| What can this caller do? | `apps/api/src/modules/authorization.rs` |
| Why can't a machine inherit an owner's permissions? | `docs/adr/0007-three-actor-kinds.md` |
| What does a tenant-owned row look like? | `apps/api/src/security/tenant_audit.rs` |
| What can never leak? | `apps/api/src/security/secret_canary.rs` |
| What can't we accept from outside? | `apps/api/scripts/p07-schema-invariants.mjs` |
| Where does outbound traffic go? | `apps/api/src/core/egress.rs`, `adapters/webhooks/outbound.rs` |
| How does a run get authorized and charged? | `modules/budgets.rs`, `modules/tool_policy.rs`, `routes/inference.rs` |
| What is retained, and for how long? | `docs/release/data-retention-map.md` |
| It is 3am and something is broken | `docs/release/runbook.md` |
