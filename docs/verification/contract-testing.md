# Contract Testing Strategy

## Principle

Not every boundary needs the same contract technique.

Use contract tests to prove independently released components agree on the interactions they actually depend on. Do not use contract tests as a substitute for authorization, persistence, side-effect, or UX verification.

## A. Web consumer <-> control-plane API

Both live in this monorepo.

Prefer:

1. real TS client/decoder tests against minimal fixtures;
2. real Worker route/provider behavior tests;
3. production-like HTTP vertical slices;
4. fixtures containing only fields the web actually consumes.

Consumer-driven contract tooling is optional while both sides move atomically. Its value rises if ownership or release cadence diverges.

## B. Lumi Agents desktop <-> control-plane API

This is cross-repository and independently releasable, so consumer-driven contracts are high value.

Requirements:

- exercise the real desktop API client, not generic fetch;
- record only interactions the desktop truly needs;
- verify them against the real provider implementation;
- version results by client protocol/schema version;
- test local-only/offline behavior in the desktop repository;
- do not assume "latest client".

## C. Worker <-> D1

DDL is a contract.

Verify with:

- fresh migration;
- upgrade from representative prior snapshots;
- direct invalid writes against constraints/triggers;
- transaction/compare-and-set behavior;
- rollback/forward-fix semantics.

Matching Rust structs do not prove SQLite enforces the intended invariant.

## D. Worker <-> AI providers

Verify adapters for:

- request translation;
- allowlisted headers;
- timeout/cancellation;
- streaming decode;
- error classification;
- usage extraction;
- capability mapping.

Use deterministic stubs for exhaustive error matrices. Use bounded live canaries only for assumptions a stub cannot prove. Never use customer prompts/secrets.

## E. Events / queues / webhooks / outbox

Verify:

- event type/version;
- required tenant identity;
- dedupe/idempotency identity;
- retry semantics;
- signatures/timestamps where applicable;
- consumer decoder compatibility.

A producer-only test is incomplete.

## What contract tests should catch

- request shape drift;
- response/error shape drift;
- required field/type/status drift;
- event/message schema drift;
- desktop/control-plane protocol disagreement.

They should not be the primary proof for:

- business side effects;
- authorization correctness;
- persistence;
- complex UI behavior;
- provider internal algorithms.

## Anti-brittleness rules

1. Match only fields consumers need.
2. Prefer type/predicate matchers over volatile exact values.
3. Keep provider state explicit.
4. Test error categories consumers handle.
5. Do not require ordering unless guaranteed.
6. Never bind wire contracts to DB shape.
7. Snapshots are not the sole oracle.
8. Every fixture has an owner/version.
9. Do not silently regenerate fixtures after contract change.

## Current repository guidance

ADR 0005 intentionally avoids premature OpenAPI generation. Preserve that until durable multi-consumer endpoints justify it.

For now:

- `docs/contracts/**` = frozen human-readable protocol;
- fixtures = concrete examples;
- web tests = real client code;
- provider verification = real Worker behavior;
- desktop contracts = independent consumer evidence.

If OpenAPI arrives later, it becomes one contract source, not proof by itself.

## Matrix

| Boundary | Consumer proof | Provider proof | Integration proof |
|---|---|---|---|
| Web -> API | real TS client | Worker route tests | browser/HTTP slice |
| Desktop -> API | real desktop client | provider verification | real device auth/managed run |
| Worker -> D1 | domain expectations | migration/constraints | Worker + local D1 |
| Worker -> provider | adapter expectations | stub/live behavior | bounded streaming canary |
| Worker -> webhook | signed payload | consumer contract | retry/dedupe |
| Queue/outbox | producer schema | consumer decoder | delivery + idempotency |

If exact released versions cannot be shown compatible, verdict is **UNPROVEN**.
