# Plan 00 — Independent Verification System

## Outcome

Given a repository where implementation is believed complete, produce an evidence-backed answer to:

> Which product, security, compatibility, reliability, and UX claims are proven, false, or still unproven?

The system must remain useful even when AI agents wrote both implementation and tests.

## Non-goals

This is not:

- another implementation phase;
- a checklist rewarding test volume;
- 100% line coverage;
- duplicating every implementation test;
- permission to rewrite requirements until code passes.

Verification seeks the **cheapest independent evidence capable of falsifying the claim**.

## Verification graph

For each important requirement:

```text
requirement
→ falsifiable claim
→ plausible failure modes
→ risk tier
→ minimum proof level
→ verifier
→ evidence
→ verdict
→ regression capsule
```

## Risk tiers

### Tier 0 — existential

Failure can cross tenant boundaries, expose credentials, lose customer data, create unauthorized side effects, or create unbounded financial/security impact.

Examples:

- tenant isolation;
- passkey/session/recovery integrity;
- authorization and policy;
- secret/BYOK handling;
- budget-before-dispatch;
- browser/computer/tool policy;
- destructive data operations;
- migration that could upload/destroy local state.

Required: V3 + V4, plus V5 where an external system is load-bearing.

### Tier 1 — contract and money

Failure breaks clients, duplicates operations, corrupts durable state, or misattributes cost.

Examples:

- idempotency/concurrency;
- desktop/API compatibility;
- usage/cost attribution;
- webhook/outbox delivery;
- automation leases;
- billing entitlements;
- route version rollback;
- migrations/constraints.

Required: V2 + V3, with V4 where concurrency or abuse matters.

### Tier 2 — product-critical

Failure blocks a primary journey or creates misleading state.

Examples: org switch, device enrollment, account security, provider/model management, automation/admin/adoption UI.

Required: behavioral tests plus real browser/runtime evidence for critical paths.

### Tier 3 — polish

Lower-impact convenience/display behavior. Focused tests/review are usually sufficient unless regression history says otherwise.

## Campaign V00 — independent reconstruction

Read:

- `AGENTS.md`
- `docs/specs/**`
- `docs/adr/**`
- `docs/contracts/**`
- `DESIGN.md` and relevant screens for UI

Do **not** start with handoffs, STATUS, or integration-gate verdicts.

Output:

- claim-evidence matrix;
- Tier 0/1 inventory;
- dependency map;
- unknown/external obligations;
- verification order.

Exit: every P0 acceptance criterion maps to a claim or is explicitly out of scope.

## Campaign V01 — deterministic integrity

Run:

- format/lint/type/unit;
- Rust host + WASM checks;
- Worker build/dry-run;
- fresh D1 migrations;
- schema/constraint probes;
- contract fixture decoding;
- forbidden dependency/config checks;
- static secret/logging review.

A green `pnpm check` proves baseline integrity, not product correctness.

## Campaign V02 — runtime boundaries

Exercise:

```text
browser/desktop consumer
→ Worker HTTP
→ auth/org/policy
→ domain
→ D1/queue/R2/provider
→ audit/usage/event
→ response
```

Prefer the real Worker build + real local D1 bindings over calling domain functions directly.

Required representative slices:

- signup/login/session revoke;
- org/resource authorization;
- managed inference + budget denial;
- tool policy deny;
- automation/webhook/outbox;
- export/deletion;
- migration/adoption;
- primary web control-plane flows.

## Campaign V03 — adversarial verification

Required attack families:

1. tenant substitution;
2. replay/expiry/revocation;
3. stale org context and privilege escalation payloads;
4. duplicate requests and races;
5. inference failures before/after stream commit;
6. destructive data and migration rollback;
7. malformed/oversized/SSRF-shaped inputs.

Every Tier 0 invariant needs hostile negative evidence.

## Campaign V04 — verify the verifiers

Use targeted mutation/fault injection on load-bearing code.

Prioritize:

- authorization/ownership;
- auth ceremony consumption;
- budgets;
- inference retry/fallback;
- idempotency;
- policy/tool enforcement;
- adoption privacy;
- deletion authorization.

A meaningful survivor is a verification finding.

## Campaign V05 — operational proof

Verify:

- request IDs correlate API/policy/audit/usage/provider events;
- logs omit secrets/sensitive content;
- dependency failures map to stable errors;
- timeouts/retries are bounded;
- rollback/forward-fix is executable;
- previous-state migration works;
- performance budgets are measured.

## Campaign V06 — cross-repository compatibility

The control plane cannot prove desktop behavior by itself.

For `RunLumi/LumiAgents`:

- test the real desktop client against frozen contracts;
- maintain client protocol/schema compatibility matrix;
- run actual device authorization + managed workspace path;
- prove local-only mode survives control-plane unavailability;
- prove no silent prompt/file/secret/history upload.

Unavailable external evidence => **UNPROVEN**, not a fabricated mock PASS.

## Campaign V07 — release decision

Use `release-gate.md`.

Release verdict derives from proof obligations, not test count.

## Frequency

| Verification | PR | Main/nightly | Release |
|---|---:|---:|---:|
| format/lint/type/build | yes | yes | yes |
| focused tests | yes | yes | yes |
| fresh migration | yes | yes | yes |
| changed contracts | yes | yes | yes |
| Worker runtime integration | changed surface | yes | yes |
| cross-tenant matrix | changed surface | yes | yes |
| concurrency/property | focused | yes | yes |
| targeted mutation | selected | bounded | Tier-0 sample |
| browser flows | changed surface | yes | yes |
| previous-version upgrade | no | scheduled | yes |
| desktop compatibility | contract change | scheduled | yes |
| rollback/recovery drill | no | periodic | yes |

## Stop conditions

Stop and create a finding when:

- a critical requirement has no falsifiable interpretation;
- the only way to pass is weakening a requirement;
- a test does not traverse the claimed boundary;
- both sides of an external compatibility test are simulated locally;
- nondeterminism makes results irreproducible;
- a mutation survives because tests assert implementation details;
- proof would require unsafe real customer data/secrets.

## Release-ready threshold

- all Tier 0 claims PASS;
- no Tier 0 UNPROVEN/BLOCKED;
- all P0 acceptance criteria trace to evidence;
- no known contract drift;
- representative dangerous mutants are killed;
- remaining findings have severity/owner/disposition;
- external gaps are named, not hidden by aggregate CI success.
