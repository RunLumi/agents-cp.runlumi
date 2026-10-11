# Work Packet — DE2E-QA-01: dispatch guard polarity sensitivity

## Metadata

- Phase: Desktop/backend integration closure
- Lane: QA
- Status: review
- Owner: coordinator
- Depends on: current parent `main` P02 guard-recognition gate
- Blocks: parent source snapshot PR merge
- Specs: F15, F16, F23; P06 automation dispatch eligibility
- ADRs: none; no architecture change
- Contract version / Contract Gate commit: no wire-contract change

## Outcome

Pin the newly added dispatch-time organization, membership and license guard into the existing real-SQLite polarity probe so an inverted or vacuous guard fails the verifier.

## In scope

- Count and attribute the tenth automation-repository `guard!` site.
- Run a positive active-authorization control and negative suspended-org, suspended-membership, stale-license and expired-grace cases against the real migration schema.
- Keep the clean adoption-account-device integration fixture wired to both contract and services package closures, including every required server-projected field.
- Update the runtime-proof catalog with the newly measured claims.

## Explicitly out of scope

- Changing the product guard, authorization policy, API or database schema.
- Claiming the full desktop E2E gate from this focused probe.

## Write surface

```text
apps/api/scripts/p02-guard-probe.mjs
scripts/integration/lumi-agents.mjs
tests/integration/lumi-account.mjs
docs/verification/runtime-proofs.md
docs/implementation/packets/DE2E-QA-01.md
```

## Frozen contracts consumed

- Server-owned organization state, active membership and current license eligibility.
- Existing guard sentinel semantics in `idempotency_records`.

## Acceptance criteria

- [x] Mutation of the new dispatch guard polarity is observed by a real SQLite control/attack pair.
- [x] Test asserts positive control and separate org, membership, license-state and grace-expiry refusals.
- [x] Adoption stage advancement passes the current server-projected credential mode; the client rejects an omitted mode before HTTP.
- [ ] Clean exact-SHA adoption-account-device integration bundles the real client service transport without unresolved workspace aliases.
- [x] Runtime proof documentation reflects the ten measured guard sites.

## Tests

- [x] `node apps/api/scripts/p02-guard-probe.mjs` — 16/16 PASS.
- [x] `node --check apps/api/scripts/p02-guard-probe.mjs` — PASS.
- [ ] Full parent pre-push quality gate — in progress on the PR candidate.
- [x] Not applicable: browser UX and cross-tenant route tests; no user-facing surface or route changed.

## Security checklist

- [x] Tenant scope remains server-authoritative.
- [x] No tokens, prompts or secrets are read or logged.
- [x] Failure requires the exact deliberate SQLite guard abort; unrelated SQL failures do not count.

## Handoff

This packet strengthens the pre-merge verifier for source already under review. It does not establish desktop runtime, production provider or complete A–E evidence.
