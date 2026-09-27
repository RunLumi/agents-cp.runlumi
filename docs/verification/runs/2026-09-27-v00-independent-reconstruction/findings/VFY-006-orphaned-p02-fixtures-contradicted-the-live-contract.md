# Finding VFY-006 — `apps/api/tests/fixtures/p02/*.json` are dead and contradict the live contract

## Status

**closed by this campaign** (verification-infrastructure repair, see Closure evidence)

## Severity

low (misleading evidence, no runtime effect)

## Affected claim

- Claim ID: `VI-CON-001`
- Source requirement: `docs/verification/contract-testing.md` §"What contract tests should
  catch" and the anti-brittleness rule "every fixture has an owner/version"
- Risk tier: 1

## Statement

Five JSON fixtures under `apps/api/tests/fixtures/p02/` are referenced by nothing — no Rust
test, no script, no CI step, no document — and three of them do not match the shape any live
endpoint returns. Their presence under `tests/fixtures/` makes them read as P02 contract
evidence.

## Reproducer

### Action

```bash
grep -rn "tests/fixtures" apps docs .github
# docs/implementation/plan00-execution-model.md:70:QA-A   relevant tests/fixtures only
git log --all -S 'tests/fixtures/p02' --oneline   # no commit ever referenced them
```

### Expected

A fixture under a test directory is either executed or absent.

### Actual

Never referenced. Added dead in `ca8e6cb feat(p02): ship identity and multi-tenant
organization core (#8)`.

Drift against the live contract:

| Fixture | Live contract | Matches? |
|---|---|---|
| `organization.json` wraps in `{"organization": {…}}` | `GET /api/v1/orgs/{org_id}` returns `Json(access.organization)` — the **bare** record (`routes/organizations.rs:330`). `POST /api/v1/orgs` returns `{organization, membership}` (`routes/organizations.rs:208`), which the fixture also lacks. | no |
| `device-auth.json` omits `device_code` | `DeviceCodeResponse` always serializes `device_authorization_id`, `device_code`, `user_code`, `verification_uri`, `expires_at` (`routes/device_auth.rs:53`) | no |
| `user.json` wraps in `{"user": {…}}` | `/api/v1/me` returns `{user, organizations}`; `POST /api/v1/auth/password/signup` returns `{user, verification}` | ambiguous |
| `invitation.json`, `error.json` | not cross-checked — no live consumer in this repository reads them | unknown |

## Why it matters

A fixture is only evidence if a verifier decodes it with the real type. These decode with
nothing, so a future verifier will reasonably treat them as the P02 wire contract and derive
false confidence from a shape the server has never produced. The real P02 contract evidence
in this repository is `apps/api/scripts/p02-smoke.mjs`, which asserts the live shapes and
does run.

## Repair (applied in this campaign)

Deleted `apps/api/tests/fixtures/p02/` (5 files). Nothing referenced them, so no verifier was
weakened. `apps/api/tests/` now contains only `egress_corpus.rs`.

Deleting rather than wiring them up is deliberate: making them executable requires deciding
which endpoint each one represents, which is a product-contract decision this campaign should
not make unilaterally, and the live shapes are already covered by the P02 smoke.

## Regression requirement

None — a dead file cannot regress. If a canonical P02 fixture set is wanted, it must be
**generated from a live response** and consumed by a decoder test that compares the exact key
set both ways, the pattern already used for `docs/implementation/fixtures/p0{6,7,8}-*.json`
(`apps/web/src/features/*/fixture-contract.test.ts`).

## Closure evidence

- fix commit: _pending_ (`git rm -r apps/api/tests/fixtures`)
- original reproducer: `grep -rn "tests/fixtures" apps docs .github`
- after: no matches outside a prose sentence in `plan00-execution-model.md`
- broader gate: `pnpm check` green
