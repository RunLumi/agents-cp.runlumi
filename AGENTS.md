# AGENTS.md

## Mission

Build the Lumi Agents control plane so it feels immediate, calm, and dependable. Speed, performance, UI/UX quality, security, and maintainability are product requirements, not cleanup work.

This file is the operating contract for coding agents in this repository.

## Functional specifications

`docs/specs/` is the authoritative functional contract for the control plane.

Before implementing or changing a product feature:

1. Read `docs/specs/README.md`.
2. Read the specific `fXX-*.md` feature spec(s) involved.
3. Preserve cross-feature invariants for tenant isolation, authorization, audit, secrets, budgets, device policy and data retention.
4. If implementation requires behavior that contradicts a MUST requirement, update the spec/ADR intentionally before changing code.
5. Do not invent a parallel concept when the spec already defines the resource vocabulary.

Feature work is not done if code exists but the relevant acceptance criteria in `docs/specs` are not demonstrably satisfied.

## Implementation plans

`docs/implementation/` is the execution graph for multi-agent delivery.

Before starting implementation work:

1. Read `docs/implementation/plan00-execution-model.md`.
2. Identify the current phase and exact work packet (`Pxx-MOD/BE/FE/INT/QA-yy`).
3. Stay inside the packet's declared write surface unless the plan explicitly assigns a shared-file edit.
4. Do not begin a dependent packet before its Contract Gate is merged.
5. Frontend should begin from frozen contracts/fixtures rather than waiting for backend completion.
6. Every phase must end with a real vertical integration slice, not only mocks.
7. If work no longer fits the dependency graph, update the implementation plan intentionally instead of creating hidden sequencing assumptions.

The feature specs define **what** must exist. The implementation plans define **how work is partitioned and merged safely**.


For every implementation packet:

- create/fill the work-packet template before coding;
- reference the merged Contract Gate commit/version;
- do not edit `docs/implementation/STATUS.md` unless you are the assigned coordinator;
- use `docs/implementation/templates/change-request.md` for any frozen-contract change;
- complete the handoff section before PR review;
- use the repository PR template as required evidence, not optional prose.

## Goal prompt library

`docs/prompts/` contains the reusable long-horizon `/goal` prompts for executing P00–P09.

Before starting a phase as coordinator:

1. Read `docs/prompts/README.md`.
2. Use the `goal-NN.md` matching the current implementation plan.
3. Treat the goal prompt as an execution wrapper around specs/plans/ADRs, never as a higher-authority source.
4. Do not run a later goal before `docs/implementation/STATUS.md` shows its dependencies are satisfied.
5. Do not concatenate multiple phase goals into one mega-prompt.

The prompt library exists to reduce prompt drift across agents; it does not replace the repository contracts.

## Independent verification

`docs/verification/` is the authoritative post-implementation verification system.

When a phase or release is believed complete:

1. Derive proof obligations from specs, ADRs, and contracts before trusting implementation handoffs or prior PASS evidence.
2. Use only PASS, FAIL, UNPROVEN, BLOCKED, or NOT_APPLICABLE; never convert missing critical evidence into a soft PASS.
3. Security, tenant isolation, authentication, data-loss, budget, and compatibility claims require hostile/runtime evidence, not only unit tests or code review.
4. For load-bearing invariants, verify the verifier with targeted mutation or deliberate fault injection in a disposable worktree.
5. Never weaken a verifier, spec, or frozen contract merely to make implementation pass.
6. Verification is an autonomous repair loop: preserve failing evidence, fix clear in-scope root causes, add/strengthen regression proof, re-run the original reproducer and affected verification, then continue.
7. Keep verification and repair logically separable so failing evidence survives the fix; they do not need to be separate agent sessions.
8. A test count is telemetry, not proof. Every critical PASS must identify the claim and evidence that demonstrates it.

Read `docs/verification/README.md` and `docs/verification/plan00-verification-system.md` before a post-implementation verification campaign.

## Read first

Before changing architecture, dependencies, build tooling, public API contracts, authentication, authorization, persistence, or cross-cutting UI behavior:

1. Read the relevant files in `docs/adr/`.
2. Inspect the existing implementation before proposing abstractions.
3. Prefer the smallest change that satisfies the requirement.
4. Add or update an ADR when a durable architectural decision changes.

## Non-negotiable stack

### Backend

- Rust.
- Cloudflare Workers through `workers-rs`.
- Axum 0.8 using the `worker` crate's `http` + `axum` bridge.
- Target `wasm32-unknown-unknown`.
- No Node backend.
- No Tokio or another native async runtime unless Cloudflare officially supports the exact use case and an ADR records the decision.
- Every dependency must compile for the Worker WASM target.

### Frontend

- React 19.
- Vite 8.
- TypeScript 7 in strict mode.
- Tailwind CSS 4.
- shadcn/ui with **Base UI** primitives.
- **Never introduce Radix UI packages or Radix imports.**
- Prefer Tabler for iconography when icons are needed.
- No Next.js, SSR framework, meta-framework, or CSS-in-JS layer without an ADR.

### Repository

- pnpm workspace for JS/TS.
- Cargo workspace for Rust.
- Do not add Turborepo/Nx until there are enough independent packages/tasks for measured task caching to justify it.

## Architecture

```text
repo/
├── apps/
│   ├── api/      # Rust Worker, HTTP/API boundary
│   └── web/      # Vite SPA, control-plane UI
└── docs/adr/     # durable architectural decisions
```

Keep the root boring. New package boundaries are allowed only when there are at least two real consumers or a clear deployment/security boundary.

Do not create `packages/ui`, `packages/utils`, or generic "shared" packages because code might become reusable someday.

## Backend rules

- Keep route handlers thin.
- Domain rules move outside transport parsing as the product grows.
- Return stable JSON error codes, not strings clients must parse.
- Validate all external input at the boundary.
- Never trust tenant/org/resource IDs from the client as authorization evidence.
- Authorization is enforced server-side.
- Keep request context explicit.
- Prefer stateless request handling.
- Do not hold mutable global state across requests.
- Avoid heavy crates. WASM size is a latency and deployability cost.
- Wrap Cloudflare bindings in small adapters instead of spreading raw `Env` throughout domain code.
- Long-running or retryable work belongs in Queues/Workflows when introduced, not synchronous request handlers.
- Never log secrets, credentials, authorization headers, raw tokens, or sensitive prompts.

## Frontend rules

### Design system and brand assets

- Before creating or changing user-facing UI, read the root `DESIGN.md`. It is the visual source of truth for Lumi's shared identity, color, typography, surfaces, imagery, and motion. Carry its shared design language across product UI; apply landing-page positioning and section-specific guidance only to the landing page.
- Before frontend implementation, inspect `docs/screens/` and open the relevant screen images visually; reading filenames alone is not sufficient. Use them as references for page structure, information hierarchy, density, navigation, and component arrangement.
- Follow `DESIGN.md` when translating screen references into UI. References, including third-party screens, do not override Lumi's design tokens, brand assets, accessibility rules, or the functional contracts in `docs/specs/`. Preserve the relevant layout intent while adapting styling and behavior to these requirements.
- Record the screen reference paths used in the work packet and PR handoff. If no relevant reference exists, state that explicitly and build from the existing UI patterns and `DESIGN.md`.
- Use the existing design tokens and visual rules. Do not introduce a competing palette, theme, typeface, logo treatment, or decorative style. If a needed visual rule is not covered, update `DESIGN.md` with the implementation rather than inventing a lasting convention in code.
- Before changing a logo, favicon, app icon, splash image, or other brand artwork, inspect `brand/` and `brand/README.md`. Reuse the supplied assets: `lumi-logo.svg` for the symbol and `lumi-fulltext.svg` for the wordmark, choosing the black or white variant only when the background requires it.
- Preserve brand artwork's colors, proportions, and transparency. Prefer the supplied SVG; create separate, clearly named derivatives from it only when a platform requires another format or size. Do not redraw, stretch, recolor, or replace the mark with text or an ad-hoc glyph.

### Performance

- No application barrel files.
- Route-level code split once multiple substantive routes exist.
- Avoid dependencies for behavior the platform, React, Base UI, Tailwind, or a few lines of code can provide.
- Keep provider nesting shallow.
- Do not put server state in a global client store by default.
- Measure before adding memoization.
- Avoid broad context providers that invalidate large subtrees.
- Lists that can grow unbounded must paginate or virtualize.
- Expensive visualizations load on demand.
- Never ship a large chart/editor/highlighting library in the initial route unless the route requires it.

### UI/UX

- Prefer dense, quiet, high-information admin UI over decorative dashboards.
- Every interactive element must be keyboard reachable.
- Preserve visible focus states.
- Respect `prefers-reduced-motion`.
- Use semantic HTML first, Base UI for non-trivial interactions, shadcn components for product UI.
- Every async surface needs intentional loading, empty, success, and error states.
- Destructive actions require clear consequence copy and an appropriate confirmation pattern.
- Do not hide essential actions behind hover-only UI.
- Optimistic updates are allowed only when rollback is safe and understandable.
- Use animation sparingly to clarify state or spatial change.
- Never trade contrast, target size, or focus behavior for visual minimalism.
- Before handing off a visual change, render the affected UI in a browser and compare it with the relevant `docs/screens/` references and `DESIGN.md`. Check desktop and narrow layouts, keyboard focus, and applicable async states; include screenshots and explain intentional deviations in the PR evidence.

### shadcn / Base UI

- `apps/web/components.json` is authoritative.
- Generated components live in `apps/web/src/components/ui`.
- Before accepting generated code, verify imports come from `@base-ui/react`, never `@radix-ui/*`.
- Do not mass-add shadcn components.
- Preserve semantic design tokens instead of scattering one-off colors.

## Agent-friendly development

Vite browser error forwarding is enabled so coding agents see runtime browser failures in the terminal.

When debugging:

1. Reproduce.
2. Find the smallest failing boundary.
3. Add a regression test where valuable.
4. Fix the cause, not the symptom.
5. Run the narrowest check first, then `pnpm check`.

Do not rewrite unrelated code during a focused fix.

## Dependency policy

Before adding a runtime dependency, answer:

1. What user or engineering problem does it solve?
2. Can the browser, Rust std, Axum, React, Base UI, Tailwind, or Cloudflare platform solve it already?
3. What is its browser/WASM size cost?
4. What maintenance/security surface does it add?
5. Is it compatible with the runtime?

A dependency that saves ten lines but adds a large transitive tree is usually a bad trade.

Core build tooling is pinned deliberately. Review release notes before upgrades.

## Performance budgets

### Web production baseline

- Initial JS target: <= 170 KiB gzip.
- Initial CSS target: <= 35 KiB gzip.
- New route chunk target: <= 80 KiB gzip unless objectively required.
- CLS: < 0.1.
- INP: < 200 ms p75.
- LCP: < 2.5 s p75, target < 2.0 s for the authenticated shell.
- No application-caused main-thread long task > 200 ms during normal navigation.

### Developer loop

- Keep Vite plugin count minimal.
- Cold Vite startup target: < 1.5 s on a modern development laptop.
- Typical HMR feedback target: < 200 ms.
- Do not enable experimental Vite bundled-dev mode globally without a repository benchmark.

### API

- Health/simple in-memory handler compute target: < 10 ms p95 inside Worker execution.
- Normal control-plane request target: < 200 ms p95 excluding third-party upstream time.
- No blocking I/O.
- Track Worker bundle size and investigate substantial increases before merge.

Budgets become automated CI gates once representative production routes exist.

## Testing

- Rust domain logic: unit tests near the module.
- HTTP behavior: integration tests around router/service boundaries where practical.
- Web logic: Vitest.
- Browser-critical flows: Playwright once real flows exist.
- Test behavior, not implementation details.
- Tests must be isolated and deterministic.
- Multi-tenant features require explicit cross-tenant negative tests.

Do not chase line coverage. Cover security invariants, business rules, critical paths, and expensive regressions.

## Commands

```bash
pnpm dev
pnpm build

pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm rust:check
pnpm check

pnpm ui:add -- button
```

Rust-only:

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --workspace --target wasm32-unknown-unknown
```

## Runtime proofs

`pnpm check` proves compilation, types, unit behaviour, and the schema. It does **not** prove that
the system works inside the Worker runtime or in a browser, and it cannot: it opens neither. These
are the gates that do. Each is self-contained unless noted.

| Command | What it proves | Needs |
|---|---|---|
| `pnpm db:migrate:local` | every migration applies to a real local D1 | — |
| `pnpm smoke:local` | the P01 foundation surface answers | a Worker on `:8787` |
| `pnpm smoke:p02` … `smoke:p05` | the P02–P05 surfaces answer | a Worker on `:8787` |
| `pnpm smoke:passkey` | a real WebAuthn ceremony verifies end-to-end — registration and assertion, with hostile cases for challenge, origin, RP ID, replay, expiry, and revocation | nothing; it starts its own D1 and Worker. Needs `pnpm build` first, or it compiles one |
| `pnpm guard:probe` | a guard sentinel's abort is recognised as a deliberate refusal, not a store outage | nothing; a real SQLite database |
| `pnpm --filter @runlumi/agents-cp-api p08:invariants` | the migration's triggers and constraints refuse what the domain says they refuse | a local D1 |
| `pnpm verify:restore` | a restored database still refuses every invalid write | nothing |
| `pnpm verify:mutation --apply` | every declared Tier-0 invariant is killed by a deliberate fault | **a disposable linked worktree**; it refuses to run against a checkout |
| `pnpm smoke:p06` | the data-governance surface: a real export over HTTP to a real Worker and local D1, its tenant and permission boundaries, and its idempotent replay | a built Worker; **exits 2 here** because the local queue does not deliver a published body, so the R2 leg is BLOCKED |
| `pnpm smoke:p08` | the cross-tenant boundary on the org-scoped routes the earlier gates never reached: a plain member of another organization, and that organization's owner, are both refused | a built Worker |
| `pnpm verify:privilege-escalation` | a plain member and an admin both fail to obtain authority they did not already have, across 7 classes of client-supplied field — org, project, role, policy version, model alias/route, tool capability, entitlement/budget, credential id. Graded on the **stored state**, not the status: a 2xx that ignored the field is correct, a 2xx that granted it is a breach | nothing; it starts its own D1 and Worker |
| `pnpm verify:adoption-privacy` | eight content classes — prompt, POSIX and Windows path, private-key body, API key, conversation history, MCP secret, arbitrary note — against every adoption write surface, proving nothing reaches `security_events` and that a path is refused at the API as well as in the database | nothing; it starts its own D1 and Worker |
| `pnpm verify:budget-concurrency` | a hard budget's ceiling holds under concurrency: 8 simultaneous reservations for 240 against a limit of 100 grant 3 and hold 90, a released hold returns its capacity, and a denied request can then reserve it. The atomicity is **measured**, not inferred from the SQL being one statement | nothing; it starts its own D1 and Worker |
| `pnpm verify:mutating-tenancy` | the **write** half of tenant isolation, which every other gate only reads: 11 mutations from another organization's owner and from a plain member of the same one, across role, capability, project, budget and org. Graded on the **stored state** read from D1, because the handler this probe exists for answers 200 and passes every status-based gate. Includes a per-route **positive control** — a probe in which every body is malformed would otherwise report a perfect sheet, and the control is what found the never-working project PATCH (V01-008) | nothing; it starts its own D1 and Worker |
| `pnpm verify:idempotency` | that a retried mutation is still ONE mutation: a replayed request returns the first response, a same-key different-body is a conflict, and 6 or 8 *simultaneous* requests on one key create exactly one row. Graded on **row counts read from D1**, never on status, and every case carries a control proving the route honours keys at all | nothing; it starts its own D1 and Worker |
| `pnpm verify:filter-tenancy` | that a hostile value in a **query string** leaks nothing, which is the tenant failure the path-substitution probes structurally cannot reach: the org in the path is correct, so every org check passes and the only boundary left is whether the WHERE clause ANDs the filter with `org_id`. 6 filter routes, a foreign keyset cursor, 5 nested paths and the audit route's **12 id filters**, graded by searching the full serialised body for **every identifier belonging to the other org** | nothing; it starts its own D1 and Worker |
| `pnpm verify:inference-failure` | that a **failed or abandoned** inference leaves nothing behind: after every outcome — success, fail-before-output, timeout, output-then-fail, and a client that disconnects mid-stream — the reservation is not left `reserved` and the request reaches a terminal state. This is the money half of both the streaming and budget families, and it is graded on two D1 tables, never on the response. Every case carries an ordered positive control, because "the reservation was released" is vacuous if none was taken | nothing; it starts its own D1 and Worker |
| `pnpm verify:migration-prior-state` | the ledger applies to **populated** tables, not empty ones: the rows 0015 seeds by design survive 0016–0021, a stored idempotency claim survives 0020's rewrite, and `p08-invariants` still reports 17/17 on that path. Every existing migration gate starts from zero rows, and that is how `teams` stayed unwritable while all of them were green | nothing; ~60s |
| `pnpm schema:bind-count` | every `prepare()` binds as many values as its SQL has placeholders, so D1 cannot reject a statement at execution time | nothing |
| `pnpm verify:campaign-selftest` | the mutation campaign can still recognise a clean, a failing, and an absent verdict from each runtime probe it drives | nothing |
| `pnpm verify:campaign-preflight` | every campaign case's fault still occurs in the source it names, and applying it changes that source — so a case cannot fault nothing and spend a twenty-minute run discovering it | nothing |
| `pnpm smoke:browser` | the real journey in a real browser: passkey-first sign-in, a CTAP2 authenticator, email verification, two organizations, switching without stale data, keyboard focus, and a 390 px layout | a Vite dev server on `:5173`, a Worker on `:8787`, and Chrome |

`smoke:p08` asks every route **three** times — as a member, as a plain member of another
organization, and as that other organization's owner — because a handler that skipped the
membership check and then found nothing returns the same 404 a correct handler does, and a
two-call test cannot tell the two apart. It also reads `app.rs` and reports how many org-scoped
routes still have **no** handler-level evidence, so a route added to the router moves that number
instead of quietly inheriting the last one's.

`verify:mutation` is the only command here that deliberately breaks code. It needs roughly **2.4 GB
of scratch space per case**, built under `target/mutation-scratch` — deliberately on the same volume
as the repository rather than in the system temp directory, because a run that fills the system
volume fails its builds and the campaign then reports the mutants as *invalid*, which is a
misdiagnosis of the machine as a property of the code. Set `$P09_SCRATCH` to move the scratch
elsewhere.

The default only helps if the **worktree** is on the same volume. A linked worktree under
`/private/var/folders` puts the scratch there too, and there it failed with **every** case reported
`target file(s) not found in the scratch copy` — the copy silently produced nothing, and a wall of
BLOCKED verdicts looked like a wall of broken mutants. Put both on the volume that has room, and
when a run fails on *every* case at once, believe the machine before the cases. The count is
deliberately not written down here: it moves every time a case is added, and a paragraph that names
it is wrong by the next one.

It refuses to run outside a linked worktree for the same reason:

```bash
git worktree add ../verify HEAD
cd ../verify && pnpm verify:mutation --apply
git worktree remove ../verify
```

`smoke:browser` locates Chrome itself and honours `PROBE_CHROME`. A run with no browser exits **2**,
never 0 — a verifier that could not find its browser has proven nothing. Note the difference between
exit **1** (a check did not hold) and exit **2** (the harness could not run): the first is a
statement about the product, the second is a statement about the harness, and collapsing them would
let a broken probe read as a detected defect.

### Showing that a gate can fail

A gate nobody has watched fail is an assumption. Each runtime gate therefore has a sensitivity
proof, and each proof is rerunnable:

| Gate | Sensitivity proof |
|---|---|
| `smoke:passkey` | each of its two dependency patches reverted individually; the probe fails (5/7 and 33/35 against 55/55). The denominators are smaller because the probe returns early once a core step fails, so the later checks are never reached rather than passing |
| `smoke:passkey` (revocation) | `evidence/vfy-revoked-credential-sensitivity.sh` — the `revoked_at` filter in the login path reverted; a revoked credential then authenticates with 200 and the probe reports 54/55 |
| `guard:probe` | `evidence/vfy004-guard-sensitivity.sh` — five targeted reverts, all detected — plus campaign case `GUARD-2`, which reverts `is_guard_abort` to the pre-VFY-004 substring matcher. The probe verifies the list behaviourally against real SQLite and the function's use of the list structurally; it does not execute the Rust function, so run-time evidence for the match itself comes from `smoke:p05` and `GUARD-1` |
| `smoke:browser` | `evidence/vfy-browser-sensitivity.sh` — run against the pre-repair product, where it reports 12 named failures |
| `smoke:p05` | `verify:mutation` case `GUARD-1` — the reservation sentinel bypassed |
| `verify:idempotency` | `evidence/v01-009-sensitivity.sh` — four mutations, all detected. M1 re-introduces the pre-repair defect verbatim; M2 re-introduces the ordering fault the repair itself introduced; M3 removes **only** the guard statement, leaving the claim, the scope, the fingerprint and the `UNIQUE` constraint all intact, and reports 15 failing cases; M4 returns a stored body that differs from the live one. One honest **KNOWN MISSED** is recorded rather than dropped: the 8-way same-payload burst is satisfied by `UNIQUE (org_id, slug)` with or without a claim, which is the whole reason the payload-varying case is the one that finds the defect |
| `verify:filter-tenancy` | `evidence/v01-filter-sensitivity.sh` — four mutations, all detected, each printing the identifiers it leaked. M1 drops `WHERE org_id = ?1` from `AGENTS_PAGE_SQL` with the bind list and every other predicate untouched. M2 drops it from all three project-page statements, **including the inline one inside `list_projects_unrestricted`**, which a scan of named constants misses because it is the path every owner takes. M3 removes `readable_project`'s handler-level org filter while `PROJECT_BY_ID_SQL` stays unchanged and correctly classified as `ReturnsOrg`, so the tenant audit sees nothing at all. M4 turns the audit list's org predicate into a disjunction — the realistic single-character regression, and the one that keeps the bind count identical, which is why it can ship |
| `verify:inference-failure` | `evidence/v01-infer-sensitivity.sh` — three mutations, all detected. M1 drops the reservation update from `finalize_request`'s batch, so the request finalises correctly and the **success** case is the one that reports stranded money. M2 drops the request state write from the same batch — the money is released and the run never closes, which a money-only gate would score as a clean pass. M3 breaks the compare-and-set in `UPDATE_BUDGET_RESERVATION_SQL` with a one-token change, and that guard is what stops a late finaliser overwriting a COMMITTED reservation with RELEASED |
| `smoke:p08` | `verify:mutation` case *"a project grant list is served without the project being org-scoped"* — the handler's organization check removed while **every SQL statement stays unchanged and correctly classified**. It is the only `VI-TEN-001` case that removes nothing from SQL, which is the whole point: the two cases above it drop a predicate from a statement, the tenant audit sees those, and it cannot see this |
| `verify:privilege-escalation` | `evidence/v01-003-sensitivity.sh` — four cases, all detected. M4 re-introduces the critical co-owner defect verbatim and the probe reports `403 REFUSED → 200 ESCALATED`; the run verifies the source returned to its **snapshot**, not to `HEAD`, because the repair is itself an uncommitted change and "differs from HEAD" cannot tell a failed restore from a repair |
| `verify:adoption-privacy` | `evidence/v01-001-sensitivity.sh` — M1 removes the path refusal at the API and M2 copies the client's workspace key into the audit row; both detected |
| `verify:budget-concurrency` | `evidence/v01-006-sensitivity.sh` — B1 makes the ceiling unreachable and the burst oversells to 240 against a limit of 100; B2 stops the released hold from being reclaimed. B3 is an **expected MISSED**: the route resolves the inference request before the statement runs, so the SQL clause is a second line for the same rule |
| `verify:migration-prior-state` | `evidence/v01-007-sensitivity.sh` — M1 deletes the seeded plans inside the window and M2 deletes the stored claims before 0020's rewrite; both detected, **on the first attempt** |
| `verify:mutating-tenancy` | `evidence/v01-008-sensitivity.sh` — P1 re-introduces the `SET`/`WHERE` placeholder defect verbatim, with a bind list whose *count* is still right, and the probe reports the same 409 the product did; P2 puts `default_model_route` back into the `SET`; P3 drops the optimistic version comparison while keeping the placeholder count |
| `smoke:passkey` | the three authentication attacks V01 added — wrong ceremony kind, identity-link conflict, recovery with active sessions — have their own proof in `evidence/v01-004-sensitivity.sh`. A2 is detected: removing the revoke statement from `password_reset`'s batch makes a pre-recovery session answer 200, which is the exact shape of a critical authentication defect. **A1 and A3 are honest MISSEDs** — two independent gates refuse a wrong-kind ceremony, and the email-conflict guard is unreachable (V01-005) |

Running a gate against the product it is meant to fail on finds defects in the gate itself. It found
three in `smoke:browser`: waits that tested for the repair, a crash on the very state the gate
exists to detect, and an unbounded wait. None was visible while the gate passed.

Three more appeared while the V01 gates were being written, all the same shape — a verdict with no
evidence behind it, and all three of them **trusted** as MISSED rather than suspected:

- a sensitivity script that reverted its fault with `mv`, which preserves the pre-fault mtime, so
  the build was skipped and the next run measured the faulted binary against a clean tree;
- a snapshot directory the script never created, so every restore was a no-op and three deliberate
  faults stayed compiled in — while the script printed `RESTORE FAILED` and the grades carried on;
- `set -uo pipefail`, which does not abort, so three mutations whose asserts failed reported three
  MISSED verdicts for runs that never happened.

A fourth round of the same shape turned up while `verify:idempotency` was being proven, and it
generalises into a rule: **a sensitivity harness must not be able to report a verdict for a run it
did not perform.** Three ways it did, all in one script. A mutation that did not compile left the
probe exiting **2**, and the harness counted that as MISSED — the exit-1-is-the-product /
exit-2-is-the-harness distinction read backwards, so "the gate did not detect it" was really
"nothing was measured". An `exit 1` in the middle of a mutation skipped the restore, so the next
run's snapshot faithfully captured a faulted tree and the repository was left not compiling;
restoration is now an `EXIT` trap, not a line at the end of a case. And `set -u` aborting a helper
on an unbound optional argument left an **empty verdict list** that the trap reported as exit
**0** — success, for a run that never finished. So: build explicitly and abort on failure, restore
in a trap, and treat an empty verdict list as a failure.

Separately, a mutation can be *weak* rather than the harness broken. One returned a stored body
that kept `id` and dropped everything else, and passed only because the assertion compared `id`
alone — the same "satisfied by an unrelated property" trap as `UNIQUE (org_id, slug)` doing
idempotency's job by accident, caught from the other direction.

The third is why a sensitivity harness needs `set -e` **and** an explicit check that the file it
mutated actually changed. The one V01 harness written with both from the start worked first time.
Two more rules the same campaign turned up: capture stderr when driving `wrangler`, because a
`CHECK` failure goes to stderr while the confirmation banner goes to stdout, so a stdout-only capture
reports every failing write as a success; and never let a negative assertion pass on an absence —
assert that the thing happened before asserting the thing did not, or `0 reservations hold 0` reads
as a passing budget gate on a budget that was never consulted.

## Git discipline

- Small cohesive commits.
- No drive-by formatting.
- Never commit secrets, `.dev.vars`, generated Worker output, `dist`, or `node_modules`.
- Do not force-update shared branches.
- Explain architectural trade-offs in the PR, not only what changed.

## Definition of Done

A change is done when:

- behavior matches the requirement;
- server-side security invariants hold;
- keyboard/focus/error/loading behavior is correct for UI work;
- visual UI changes have been compared against the relevant `docs/screens/` references and comply with `DESIGN.md`, with evidence recorded in the handoff;
- relevant tests exist and pass;
- format, lint, typecheck, Rust checks, and build pass;
- performance impact is understood;
- no unnecessary dependency or abstraction was added;
- docs/ADR are updated when durable architecture changed.

If a fast solution makes the system harder to reason about tomorrow, it is not actually fast.
