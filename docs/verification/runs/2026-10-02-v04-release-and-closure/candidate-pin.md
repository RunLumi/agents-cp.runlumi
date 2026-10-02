# V04 — the candidate under judgement

Pinned **before** any evidence was read, per the release gate's "Pin the candidate" step. A release
decision that cannot name its candidate is a decision about something else.

| | |
|---|---|
| **commit** | `795d403464b0615aa83b440539c3d5ce95deb6b6` (short `795d403`) |
| **branch / tree** | `main`, clean — no uncommitted or staged changes |
| **OS** | Darwin 27.0.0 (macOS) |
| **node / pnpm / cargo** | v24.20.0 / 10.33.0 / 1.98.1 |
| **browser** | Google Chrome 154.0.8037.93 |
| **Worker runtime** | `wrangler dev --env development` (workerd) on a local D1 |
| **migration head** | `0022_p07_staff_actor_type.sql` — 22 migration files |
| **web build** | `vite build` production artefact, served on `vite preview` :4173 with the API proxied to :8787 |
| **contract versions** | in-repo; no external client contract is consumed by this candidate (see the External Lumi Agents verdict) |

## The commits this campaign adds are not part of the candidate

Verification records are committed on top of the candidate as the campaign proceeds, so `HEAD` moves
away from `795d403` while the *product* does not. Measured after the first two record commits:

```
$ git diff --name-only 795d403..HEAD -- apps Cargo.toml Cargo.lock pnpm-lock.yaml
0 files
```

**Every judgement in this campaign is about `795d403`'s product tree.** If that command ever returns
a non-zero count of product files, the candidate has moved and this pin is void — re-pin before
trusting any result, because a verdict about a different tree than the one recorded is a verdict
about nothing.

## THE PIN WENT VOID, exactly as that rule predicts

`454376a` repaired two defects in `apps/api/` (V04-002's queue entrypoint, V04-003's gate failure
report), so the product tree moved and **795d403 is a FAILED candidate**:

> `795d403` ships a HIGH defect: the queue handler cannot construct the Worker, so no queue message
> has ever been delivered. Every async proof taken against it describes a product that cannot consume
> a queue.

That is the release-repair loop working, not a problem with the rule: the loop *expects* the pin to
move when it repairs something, and the rule exists so a reader can tell a re-pinned candidate from a
quietly-changed tree.

**Re-pin 2 — `3d619c9` (the candidate the release verdict is about).** V04-006 and V04-007 changed
`apps/` again: `perf-probe.mjs` (harness) and `billing-panel.test.ts` (a test whose fixture had expired
and taken `pnpm check` red with no product change). Under the rule above the pin is void a second time,
and it is voided in the direction that matters: **V04-007 repaired the repository gate itself**, so the
evidence that said "the gate is green" had to be re-established after it.

**What was re-run against `3d619c9`:** `pnpm check` (exit 0, 48/48 test files, bind-count 463, clippy
clean), `perf:budgets` against the production preview (0 over budget, 1 UNMEASURED), and the gates
touched by V04-005 (`smoke:p03`, 17/17).

**What was NOT re-run after the final re-pin**, and is therefore evidence about an earlier tree:
`pnpm build`, the WASM check, the fresh and populated migration paths, the 25-gate adversarial suite,
and `smoke:browser` 91/91. Those repairs touched `apps/api/sentry-entry.mjs`,
`apps/api/scripts/p03-smoke.mjs` and `apps/api/scripts/p06-data-smoke.mjs` — none of which the
`apps/web` changes can affect — and the release verdict says so rather than implying a single tree
produced every number on it.

## Environment drift from the campaigns this inherits

**Chrome is 154.0.8037.93. V02 recorded 153.0.8010.53.** That is a different browser build than the
one every recorded browser measurement was taken on. It does not invalidate those measurements — they
are honest records of what was measured — but it means **any browser gate re-run here is evidence
about a browser V02 never touched**, and that is worth knowing rather than discovering from a flake.

Nothing else drifted: node, pnpm, cargo, the OS and the migration head are identical to V02's
recorded environment.


---

## Re-pin 4 — `1d3ec1e`

`e55af37` was voided by its own rule the moment a repair landed: `V04-008` (the minimum client version
control has no lever) and its standing check `security::guarded_column_writers`, then `V04-009`
(recovery ceremony replay), then the `FR-F04-007` assertion and `FR-F22-010`/`FR-F21-006`
reclassification in the P0 map.

**What was re-run against `1d3ec1e`, rather than inherited from `e55af37`:**

| proof | result |
|---|---|
| `pnpm check` | **exit 0** — 463 binds, clippy clean, WASM target builds |
| `security::guarded_column_writers` | 5/5, plus sensitivity **2/2 detected** |
| `smoke:passkey` (control leg, twice) | **80/80**, with the new recovery-replay case asserted present |
| `verify:tool-policy-deny` (control leg) | **50/50**, FR-F04-007 asserted present |
| `VI-AUTH-001` | **DETECTED**, control 76/76, exit 0 |
| `V04-009` recovery replay | **DETECTED** with both defences removed, exit 0 |
| `FR-F04-007` discrimination | **DETECTED** against a constant reason, exit 0 |

**What was NOT re-run against `1d3ec1e`:** the 34-gate adversarial and smoke/browser/perf suites, and
the earlier nine mutants. The product code changed in this stretch is confined to
`apps/api/src/security/guarded_column_writers.rs`, `apps/api/src/security/mod.rs`, and **probe scripts
only** — no handler, route, repository, SQL statement or migration was touched after `e55af37`. The
nine earlier kills are therefore carried forward explicitly rather than re-measured, and that is a
judgement about blast radius, not a claim that they were re-verified.
