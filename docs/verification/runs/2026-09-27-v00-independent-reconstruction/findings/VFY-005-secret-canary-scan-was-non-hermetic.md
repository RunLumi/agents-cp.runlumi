# Finding VFY-005 — The secret canary's committed-literal scan is non-hermetic and fails on any machine that has run a local D1

## Status

**closed by this campaign** (verification-infrastructure repair, see Closure evidence)

## Severity

medium (a false FAIL in a Tier-0 gate)

## Affected claim

- Claim ID: `VI-SEC-001`, `VI-TEST-001`
- Source requirement: `docs/verification/proof-obligations.md` "Secrets … Include runtime
  redaction evidence"; `docs/verification/contracts/core-invariants-v1.yaml` `VI-TEST-001`
  ("Critical verification is sensitive to representative dangerous implementation faults")
- Risk tier: 0 for the invariant being protected; the defect is in the verifier

## Statement

`apps/api/scripts/p09-secret-canary.mjs` scanned `apps/` and `docs/` for committed
credential-shaped literals while excluding `node_modules/`, `dist/`, and `target/`, but **not**
`.wrangler/`. Wrangler keeps the local D1 SQLite file there, and that database legitimately
contains argon2id hashes for whatever fixture a developer or a smoke test just registered. The
scan therefore reported uncommitted local state as "committed secrets", making the gate's
verdict depend on untracked files.

## Reproducer

### Preconditions

```bash
pnpm db:migrate:local   # creates apps/api/.wrangler/**/D1DatabaseObject/*.sqlite
# then register a password user (any smoke, or the browser probe)
```

### Action

```bash
pnpm canary:p09
```

### Expected

The case's verdict depends only on committed content.

### Actual

```text
FAIL  no secret-shaped literal is committed outside the reviewed fixtures
      apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/e7352547….sqlite:784
        looks like a committed argon2id hash
      …:785 looks like a committed argon2id hash
      …:786 looks like a committed argon2id hash
14/15 canaries held
```

On a fresh CI checkout the same file has never been produced, so CI has never exercised this
case's failure mode. `.wrangler/` is listed in `.gitignore:9`:

```bash
git check-ignore -v apps/api/.wrangler/state
# .gitignore:9:.wrangler/	apps/api/.wrangler/state
```

## Why it matters

This is the same class of defect the verification system warns about: a gate whose verdict
depends on the machine rather than on the repository. It produces a **false failure** today
(annoying, and it teaches developers to ignore the gate) and it means the case is untested in
the one direction that matters. Had the corpus instead contained a *real* committed secret in
a generated directory, the same blind spot would have been a false pass.

## Root cause

The exclusion list was hand-written and drifted from `.gitignore`. The file's own design
notes anticipate "false passes from an empty corpus" and "a vacuous detector" but had no case
covering the *corpus definition* itself.

## Repair (applied in this campaign)

1. Introduced `GENERATED_TREES` + `isGeneratedTree()` in
   `apps/api/scripts/p09-secret-canary.mjs`, used by both the extension-filtered `sources()`
   and the committed-literal scan. Keeps the exclusion in step with `.gitignore`
   (`node_modules`, `dist`, `target`, `.wrangler`, `coverage`, `.vite`).
2. Extracted `committedLiteralHits(roots, reviewed)` and `LITERAL_FORMS` so the detector can
   be run against a *planted* corpus.
3. Added the case
   **`the committed-literal scan skips generated state but still catches a real one`**, which
   plants the same credential-shaped literal twice — once inside
   `<tmp>/apps/api/.wrangler/state/v3/d1.sqlite` and once in
   `<tmp>/apps/api/src/leak.ts` — and requires the first to be ignored and the second to be
   reported. That is the "corpus is right" control the file was missing, and it fails in both
   directions.

## Verifier sensitivity (the repair is not vacuous)

Two mutations, run in place and reverted:

| Mutation | Result |
|---|---|
| drop `".wrangler"` from `GENERATED_TREES` | `FAIL … a planted credential inside generated state is reported, so the scan is non-hermetic` (13/15) |
| `isGeneratedTree()` returns `true` unconditionally | `FAIL … a planted credential in ordinary source is NOT reported, so excluding generated state has turned the scan off` (10/15) — and the pre-existing empty-corpus case also fires |

Both were killed **for the intended reason**.

## Closure evidence

- fix commit: _pending_ (working tree change to `apps/api/scripts/p09-secret-canary.mjs`)
- original reproducer: `pnpm db:migrate:local && pnpm canary:p09`
- before: `FAIL no secret-shaped literal is committed outside the reviewed fixtures` (3 hits in `.wrangler/…/D1DatabaseObject/*.sqlite`)
- after: `15/15 canaries held across 148 web and 172 api sources` with the local D1 present
- focused regression: the new case, proven sensitive in both directions above
- affected proofs: `VI-SEC-001`, `VI-TEST-001`
- broader gate: `pnpm check` green (format, lint, typecheck, 798 web + 980 Rust + 11 integration
  tests, `schema:p07` 125/125, `canary:p09` 15/15, `schema:null-check`, clippy `-D warnings`,
  `wasm32-unknown-unknown` check)
