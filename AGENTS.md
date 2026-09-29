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
| `pnpm verify:budget-concurrency` | a hard budget's ceiling holds under concurrency: 8 simultaneous reservations for 240 against a limit of 100 grant 3 and hold 90, a released hold returns its capacity, and a denied request can then reserve it. The atomicity is **measured**, not inferred from the SQL being one statement. **Its fixtures are relative to the clock, and a control asserts the reservation expiry is in the FUTURE** -- it once used a literal date, and when that date passed every reservation was refused, nothing was held, and the ceiling assertion passed *vacuously*: this gate read 27/27 at 23:59 and 23/25 at 00:36 with no code change. **A fixture that makes nothing happen is the case where asking whether it happened is worth most** | nothing; it starts its own D1 and Worker |
| `pnpm verify:mutating-tenancy` | the **write** half of tenant isolation, which every other gate only reads: 11 mutations from another organization's owner and from a plain member of the same one, across role, capability, project, budget and org. Graded on the **stored state** read from D1, because the handler this probe exists for answers 200 and passes every status-based gate. Includes a per-route **positive control** — a probe in which every body is malformed would otherwise report a perfect sheet, and the control is what found the never-working project PATCH (V01-008) | nothing; it starts its own D1 and Worker |
| `pnpm verify:idempotency` | that a retried mutation is still ONE mutation: a replayed request returns the first response, a same-key different-body is a conflict, and 6 or 8 *simultaneous* requests on one key create exactly one row. Graded on **row counts read from D1**, never on status, and every case carries a control proving the route honours keys at all. It is also the **only** gate for `delete_project_binding`, whose replay used to answer `404` for a delete that had already succeeded -- indistinguishable from a different-key call, which is exactly what the case asserts against | nothing; it starts its own D1 and Worker |
| `pnpm verify:filter-tenancy` | that a hostile value in a **query string** leaks nothing, which is the tenant failure the path-substitution probes structurally cannot reach: the org in the path is correct, so every org check passes and the only boundary left is whether the WHERE clause ANDs the filter with `org_id`. 6 filter routes, a foreign keyset cursor, 5 nested paths and the audit route's **12 id filters**, graded by searching the full serialised body for **every identifier belonging to the other org** | nothing; it starts its own D1 and Worker |
| `pnpm verify:inference-failure` | that a **failed or abandoned** inference leaves nothing behind: after every outcome — success, fail-before-output, timeout, output-then-fail, and a client that disconnects mid-stream — the reservation is not left `reserved` and the request reaches a terminal state. This is the money half of both the streaming and budget families, and it is graded on two D1 tables, never on the response. Every case carries an ordered positive control, because "the reservation was released" is vacuous if none was taken | nothing; it starts its own D1 and Worker |
| `pnpm verify:provider-faults` | **BLOCKED in this environment — exits 2, not 0, and the blocker is MEASURED across three address classes (V01-026).** Runs a real HTTP server that COUNTS the requests reaching it, so 429, 5xx and a genuinely malformed chunk can be driven and "the provider was called once, and not retried" is a measurement rather than an inference. The server binds `0.0.0.0` and the probe sweeps every address available — `127.0.0.1` **0 calls**, `localhost` **0 calls**, and the machine's own routable `192.168.1.4` **0 calls** — so this is not loopback refusal and not name resolution: the Worker's runtime cannot open an outbound socket to **any** address on its own host. A red sheet from this probe would be three product failures for an environment that cannot run it, and widening the probe's reach nearly caused exactly that: an intermediate version exited **1** with six true-and-meaningless failures because the control's early `BLOCKED` bail had been moved out from under its verdict. **Widening a probe can delete the exit that separates "the product failed" from "the probe could not run"; the verdict and the bail now live in separate statements.** | a Worker that can reach a socket it does not share a kernel with; the provider allowlist must name the host, which the harness passes as a `--var` |
| `pnpm verify:attempt-exhaustion` | **is the retry bound _enforced_, or only unreachable?** claim, wait out the 30s TTL (the schema's floor), let the sweep expire the lease, claim again with `max_start_attempts: 1`. That is the attack which separates a dead counter from an unenforced bound. Reports **49/49, exit 0, 0 skipped**, and it found the two largest defects of the round: **V01-023** (high -- `start_occurrence` could **never** succeed, because one of its four batch guards asserted a run link *exists* and `guard!`'s `NOT EXISTS` inverted it, so it aborted precisely when there was no link) and **V01-025** (`claim_occurrence` consumed an attempt and a lease for an occurrence the product would then refuse to start, permanently exhausting a `max_start_attempts: 1` budget). The organization's entitlement is **revoked for the attack and restored for the control**, so the two rows differ in exactly one thing: attack claim `403`, `attempt` 0, no lease, occurrence still claimable; control claim `201`, start `201`, a real `run_id`. **V01-013/V01-014 are closed**, `GAP-008` is closed, and the guard polarity that hid V01-023 is pinned by `guard:probe` | nothing; it starts its own D1 and Worker |
| `pnpm verify:device-idempotency` | **do the device routes honour an `Idempotency-Key`?** Each case ends with a **different-key** call as a positive control, comparing answers while **ignoring `request_id`** — so "the route refuses repeats for an unrelated reason" cannot pass as "the key was honoured". Graded on stored state: device rows, audit rows, token counts, `revoked_at`. Reports **23/23**: BOTH routes are repaired, and `approve_enrollment` is the fifth instance of the V01-009 family -- it required an `Idempotency-Key`, **bound it to nothing**, and then refused a retry at a pending-status check, so a client that timed out got `409` for a request that had already created its device. Its different-key control answered the *identical* `409`, which is what proved the key was irrelevant. A unit test now fails the build if any line in `apps/api/src/routes` **begins** with `idempotency_key(` -- a statement test, not a substring test, because the discarded form is a substring of the correct `let key =` one and a substring inventory once reported 76 sites where there were 3. It reads the directory so a new module is covered without editing the test, and asserts its own vacuity (>= 20 modules, >= 70 call sites) **before** a verdict, because a scan that read nothing would otherwise pass and claim the class closed | nothing; it starts its own D1 and Worker |
| `pnpm verify:revoked-device` | **does revocation actually end a device credential?** A read, the nonce, and a full refresh signed over a real server-issued nonce — every leg controlled by a success **before** the revocation, including a real pre-revocation token mint, so a post-revocation refusal is attributable rather than just a route that never worked. Reports **29/29, exit 0**; `V01-019` is closed, and the **anonymous** leg is asserted before *and* after the revocation, because a revoked device still once had a credential and so cannot stand in for a caller with none | nothing; it starts its own D1 and Worker |
| `pnpm verify:invitation-race` | **can one address be invited twice, and what happens under concurrency?** 11 requests over a control, a sequential duplicate, six concurrent on one key and four concurrent on four keys; every count read from D1 and the audit count compared against the row count. **23/23** — it exists because `GAP-006` had to be falsified rather than assumed | nothing; it starts its own D1 and Worker |
| `pnpm verify:usage-attribution` | **is usage charged to the right org, project, principal and run?** Two organizations, a real inference in each, then every `usage_events` row checked for INTERNAL CONSISTENCY — the project, principal, credential and run it names all belong to the org it names — and every row one org wrote searched for **any** identifier of the other. A cross-tenant attribution is invisible to every status code, so the verdict is read from the rows, not the responses. 1 named SKIP: the `run_id` leg needs a *managed* run, which no probe builds | nothing; it starts its own D1 and Worker |
| `pnpm verify:lease-contention` | **automation lease contention, the required case with zero coverage before this round.** Two real devices, real ed25519 device proofs, a real automation, a real `run_now` occurrence. 8 simultaneous claims on one occurrence, and 2 devices racing for another: **exactly one winner, exactly one active lease, `state_version` advanced once, one attempt row, no losing response carrying the winner's lease id or raw token**, and the token is never persisted. Graded on D1 rows | nothing; it starts its own D1 and Worker |
| `pnpm verify:migration-prior-state` | the ledger applies to **populated** tables, not empty ones: the rows 0015 seeds by design survive 0016–0021, a stored idempotency claim survives 0020's rewrite, and `p08-invariants` still reports 17/17 on that path. Every existing migration gate starts from zero rows, and that is how `teams` stayed unwritable while all of them were green | nothing; ~60s |
| `pnpm schema:bind-count` | every `prepare()` binds as many values as its SQL has placeholders, so D1 cannot reject a statement at execution time | nothing |
| `pnpm verify:campaign-selftest` | the mutation campaign can still recognise a clean, a failing, and an absent verdict from each runtime probe it drives | nothing |
| `pnpm verify:campaign-preflight` | every campaign case's fault still occurs in the source it names, and applying it changes that source — so a case cannot fault nothing and spend a twenty-minute run discovering it | nothing |
| `pnpm verify:collection-tenancy` | **can Org A's COLLECTION routes leak Org B's data?** The tenant failure the path-substitution probes structurally cannot reach: a `WHERE` clause that forgot `org_id` returns a perfectly authorised `200` carrying another tenant's rows, so no status and no shape is wrong. Two organizations, Bravo's identifiers read back **out of D1** and asserted non-empty, then **30** collection routes fetched as Alpha and each whole body searched for all of them. **54/54, exit 0, 0 leaks.** It refuses three things: it takes the method classification from the product's own `405` rather than from a static parse of `app.rs` (which gets 7 routes wrong), it names 9 routes `NOT_APPLICABLE` with their status instead of passing them, and a **positive-match control** requires the same search to FIND Alpha's own project id -- so "found nothing" means absent rather than incapable. The router is the denominator, so a new collection route fails the run until it is covered or credited | nothing; it starts its own D1 and Worker |
| `pnpm verify:secret-tenancy` | **that a secret cannot cross a tenant boundary — and that the route works at all.** Two organizations, real secrets, real rotations, and every cross-tenant attempt graded on **Bravo's stored rows in D1**, not on the status. It is the only gate for the webhook secret family, and it exists because of V01-030: D1 delivers an `INTEGER` column to the Worker as a JavaScript number, so a struct field typed `bool` could never be decoded — and the failure fired **only when the row existed**, so every cross-tenant probe passed while the owner's own request 503'd. Six rows were reporting `PASS` while measuring the absence of a row rather than a refusal of a resource. **Its positive control is the gate**: a red control means the rest of the sheet is a statement about a route that refuses everyone, so the control runs FIRST and the probe exits 1 on it. Reports **32/32, exit 0, 1 named SKIP** | nothing; it starts its own D1 and Worker |
| `pnpm verify:path-id-tenancy` | **the 48 one-path-id org-scoped routes, attacked by substitution** — the largest group `smoke:p08` reports as unproven, and the one a leak probe structurally cannot reach, because a scoped lookup that forgets `org_id` returns **404**, which is exactly what a request for an id that exists nowhere returns. **Four assertions per route**: the organization's OWN id is answered **2xx** (not "not 5xx" — that passes for a route refusing its own resource, which is V01-030's vacuity); the other organization's id is refused; a well-formed id existing NOWHERE answers **identically**; and the other organization's row is **byte-identical afterwards, read from D1**. **198/198, exit 0, 40 named skips**, and `smoke:p08`'s unproven count moved **69 → 60**. **Every assertion is at full strength and no entry carries a degraded control.** Three did once, and all three were resolved: two were a real defect (V01-033, below) and one was the gate's own ordering — the revoke control had revoked the shared credential, so the rotate control was refused `404` for an already-revoked row. **Every control now creates its own row**, so controls are independent by construction rather than by luck of ordering. It now covers **18 routes**, the `automations` family included, which needed an `automations.max_active` entitlement (`entitlement_grants` is **empty in every seeded database**, so without it every create is refused for a reason unrelated to tenancy), a project and an agent, and — for `resume` — a **prior state** rather than merely a prior row, since the handler transitions `"paused" -> "active"` and refuses an automation that is not already paused. Building it found that its own first version **shared one `Idempotency-Key` across the control, the attack and the phantom**, so on an idempotent route the attack received the control's own `200` verbatim — Bravo's row untouched, every assertion passing, sheet saying *granted*: **an attack that reuses the control's idempotency key is not an attack**. **Its controls also found V01-033**: a `version` guard placed **after** the statement it guards evaluates a version the batch has already bumped, so it always aborts and the caller reports `version_conflict` — a **permanently dead route that reads as a concurrency problem**. Proved with a two-order experiment on a copy of the real database: update-then-guard trips, guard-then-update succeeds, version 1 → 2, nothing else differing. Two `machine_identity` routes fixed. **The same reorder applied to `budgets.rs:1403` on the same reasoning regressed `verify:budget-concurrency` 28/28 → 25/28 and was reverted** — so the pattern is not the diagnosis, and **"the guard follows a writer" is a defect only where the guard asserts something the writer invalidates**, which has to be established per site | nothing; it starts its own D1 and Worker |
| `pnpm verify:staff-credential` | **is a staff credential's secret actually checked, and can the platform's own control surface do anything?** It exists because `/api/v1/internal/**` had **no gate at all** and turned out to carry **four independent defects at once**, stacked on the same four write routes, plus an authentication bypass in front of them. **V01-034 (CRITICAL):** `require_staff` resolved a `lumi_staff_` token by its 16-hex **lookup prefix** and never compared the presented secret against the stored `credential_hash` — `StaffKey::secret()` had **no non-test caller in the tree** — so any well-formed `lumi_staff_<known-prefix>_<any-43-char-base64url>` authenticated as that principal, and a wrong secret (`200`) and an unknown prefix (`401`) answered **differently**, making the endpoint an existence oracle too. The machine path **eleven lines above** does the comparison and explains why. **V01-035:** `staff_audit` wrote `actor_type = 'staff'` into a CHECK that enumerated the pre-P07 world, so every internal write aborted its batch — P07 added a third actor kind **sixteen migrations** after the table and nothing extended it, making ADR 0007's MUST unsatisfiable. **V01-036:** `prepare_scoped_mutation` built `OrganizationId::new("")` from the four staff routes' `""`, which can never parse — while the schema says `organization_id TEXT NOT NULL DEFAULT ''`, so `''` is the **designed** "no organization". **V01-037:** `staff_audit` built `event_id` as `evt_` for a column CHECKed for `sec_` — the **sixteenth** site of a class `routes/support.rs` had already fixed **fifteen** times with a `SecurityEventId` type that this one function **bypassed**. The fixture provisions a **legitimate** staff principal by inserting a row with a real `sha256` hash, so the product's own verifier is what is attacked; the forged token is **well-formed by construction**, because a malformed one being refused proves nothing. **Its control runs FIRST and a red control stops the probe** — without it every refusal is satisfied by a route that refuses everyone. The write case is graded on the **stored row in D1**, and cases whose fixture could not be built are **SKIP with the cause named** rather than run against nothing. **V01-038:** the support-grant rows *were* written — and said `actor_type = 'system'` with a **NULL `actor_id`**, so the customer's own audit view, the one ADR 0007 names as what makes a support session reconstructable *without trusting platform-side logs*, showed an **unattributable action on their own organization**. `security_event_statement*` takes `Option<&Principal>`, so the boundary had **two** states where ADR 0007's domain has **three**, and a staff caller passed `None` — which rendered as `system`. A staff actor is deliberately not a `Principal`, so the correct call was **inexpressible**; `actor_type` now comes from the actor, with three branches, and `effective_user_id` stays NULL because a staff member is not acting as a customer. **That is the one defect in the set no status code and no row count could ever have found** — the route is `2xx` and the row exists — so the assertion that caught it reads the **value of a column**. **All six** `/api/v1/internal/**` routes are measured: two reads, four writes, and `GET /feature-flags/{key}` is asserted **`405`** because the route is PATCH-only. **V01-039:** a machine key that **authenticated successfully** and was then denied for its **scope** was answered `401 "Authentication is required."" — `machine_denial` mapped eleven reasons to `AuthenticationRequired`, eight of which are authorization outcomes, and the same body carried `details.reason = "scope_denied"`, so **the code field and the reason field contradicted each other**. Split by what the reason *is*: credential state stays `401`, the six authorization reasons move to `403`. The obvious defence — *"`401` discloses less than `403`"* — **does not hold, and the response is what shows it**: the `401` already returned `details.reason`, so anyone who could read it could already tell a scope denial from a bad credential, and the `401` only added a false statement about the category. A machine client that treats `401` as *re-authenticate* loops forever against a scope problem, and it **collapses the boundary ADR 0007 exists to keep**. It also cost this probe real time: a control asserted a minted key would work on a customer route, got `401`, and the natural reading was *"machine keys do not authenticate anywhere"* — a critical-sounding conclusion that was entirely wrong. **ADR 0007's three boundaries are now measured at the HTTP layer, which they never were:** a staff token on a customer org-scoped route is refused with the **same** answer as for an organization that does not exist (so it is not a cross-tenant existence oracle), a machine key is refused on a staff route, and a customer session is refused on a staff route. **Machine identity has exactly one accepting route** — `/api/v1/machine/whoami`, the only handler calling `require_machine` — which is why the machine control uses it: it is the only place a machine credential can be shown to be **live**, and without that control a boundary that holds and a dead credential are indistinguishable. **46/46, exit 0, 0 skipped.** Reads work throughout, which is why nothing noticed: `list_flags` answers `200` to the very token that cannot write. Companion: `security::actor_type_correspondence`, a standing check that reads every `actor_type` literal the code can write — matched by **position** in the INSERT's `VALUES` tuple, the shape that hid V01-035 — and asserts the **whole ledger** permits it, counting the `?n` binds it cannot follow rather than implying coverage it lacks | nothing; it starts its own D1 and Worker |
| `pnpm verify:webhook-fanout` | **that a committed business event reaches a SUBSCRIBED webhook endpoint.** `fan_out_event_statement` — "Fan one committed business event out to every enabled endpoint in the SAME organization that subscribes to the exact event type" — has **no caller**, and neither has the whole notification cluster beside it, while the delivery side is fully wired and fully exercised. **19/19, exit 0**, and the finding is a **confirmed absence rather than a static "no caller" read**: four controls first (W0 the subscribed types are string literals in the outbox registry, read from source; W1 the subscription is *persisted*, since the exact-match check lives in SQL; W2 `test_webhook` **does** create a delivery row, in a real state; W4 the business event **was** emitted to the outbox), then W5 asserts no delivery — as a **DELTA from the control, never an absolute**, so running the control twice cannot turn a broken fan-out into a pass. Stored end state: the event is in `outbox_events`, the endpoint is subscribed to it, and the only two deliveries are `test_webhook` and its replay. **The delivery path is not evidence the feature works**: `insert_queue_job_statement` has four callers and only two are webhook deliveries, both operator-initiated against an endpoint the caller already named, so signing, retry, dead-letter and replay all run while **no event has ever been delivered to a subscriber**. W6 shows replay works, which is what makes this *"no event is ever fanned out"* rather than *"the recovery path is broken"*. **Left unrepaired on purpose** — adding the fan-out to ~22 route files' transactions is a feature decision (which events are eligible, whether `webhook.*` may reach a customer endpoint, how fan-out order meets FR-F17-007), and the state is fail-closed | nothing; it starts its own D1 and Worker |
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
| `verify:usage-attribution` | `evidence/v01-usage-sensitivity.sh` — **2/2, exit 0.** M1 makes `find_run` *bind* `org_id` but stop filtering on it, so a foreign run resolves and is refused differently (`403 resource_scope_mismatch` vs the phantom's `404 run_not_found`). **The escalation case still passes** — it accepts any non-2xx with zero usage rows, so it is blind to *which* refusal by construction — and only the non-disclosure control sees it. That is the finding: the "denial leaks no existence" requirement rests on a single assertion, and without it this gate would have reported a clean `run_id` boundary while the boundary was gone. M2 nulls the usage row's `run_id`, which breaks nothing observable and is caught only by the "at least one row carries a `run_id`" control. The **first M1 was invalid and is the better half**: deleting `AND org_id = ?2` also removed a placeholder, so D1 refused the statement, *both* probes answered `503`, the control passed and the mutation read MISSED — a correct-shaped pass on a build that cannot execute the query. `assert_changed` could not catch it; the file had changed. **A mutation must break the claim, not the statement** |
| `verify:collection-tenancy` | `evidence/v01-collection-sensitivity.sh` — **2/2, exit 0.** A leak gate that has never seen a leak is the most dangerous kind of assumption, because its failure mode is a *silent* pass. **M1** makes `AGENTS_PAGE_SQL` *bind* `org_id` but stop filtering on it -- the bind stays so the statement stays valid and only the scoping goes -- and the probe names the three leaked identifiers. **M2** breaks the positive-match control's own search with every needle intact, which is the only way to show a control is a control. The run also recorded two harness defects worth more than the verdicts: the needle went through `grep -E` where `{org_id}` is an interval metacharacter, so a **real three-identifier leak was graded MISSED** -- worse than a harness that cannot detect, because the evidence sits three lines above the verdict that denies it; and the first M2 removed Org A's project, which the probe *did* detect but by the needle control, so the case asserted one particular assertion rather than the one under test. The harness also refuses to start if either detection needle already appears on a `FAIL` line in the green baseline |
| `verify:lease-contention` | `evidence/v01-lease-sensitivity.sh` — the **compare-and-set**, not the unique index, is what carries the exclusivity claim, and the proof shows both halves. **M1** removes `state_version + 1` while the `WHERE` still reads the version: the run **fails CLOSED** — zero leases, all eight racers refused, the occurrence left `pending` — and it is the *counter* assertion that sees it, since a lease count alone would not. **M2** removes the partial unique index's coverage of `state = 'active'`: a **KNOWN MISSED**, because with the CAS intact exclusivity held perfectly. That is the finding, not a weak mutation — it identifies which statement a reviewer must protect, and it means a future path that inserts a lease without the CAS has no protection from this proof at all. **M3** drops the lease insert from the claim's batch: a `201` that looks perfect with no lease at all |
| `verify:path-id-tenancy` | `evidence/v01-path-id-sensitivity.sh` — **1 detected, 1 declared KNOWN MISSED, exit 0.** **M1** removes `org_id = ?1` from `find_membership_by_id` with `?1` **still bound**, so the statement stays valid and only the scoping goes. It is detected by the **NON-DISCLOSURE** assertion and **not** by the attack assertion: the foreign membership now resolves, but the `UPDATE`'s own `org_id` predicate still refuses the write — so the route refuses exactly as before and reveals *more*. A mutation that leaves the write refused and only changes what the refusal reveals is invisible to a status-based gate and obvious to a comparison-based one. **M2** removes the same predicate from `REMOVE_MEMBERSHIP_SQL` and is a **declared** known miss: both handlers resolve the target through M1's lookup *before* their `UPDATE` runs, so that predicate is defence in depth with no route exercising it — which names the two statements a reviewer must protect. Every mutation keeps every placeholder and every bind, so `schema:bind-count` stays green |
| `verify:privilege-escalation` (ownership-transfer class) | `evidence/f02-006-sensitivity.sh` — **4 detected, 1 declared KNOWN MISSED, exit 0.** **M4 is how V01-032 was found**: removing the handler's active-target check left the transfer refused but the statement had already **demoted the sole owner** — the run's own database came back with `active owners: 0`, from a request that was REFUSED. A status is evidence about the request, never about the state it left behind, and this is that gap on the *write* side where GAP-002 found it on the *read* side. Fixed with an `EXISTS` on the target's eligibility that reuses `?1`/`?2`, so `schema:bind-count` stays green; the same mutation now leaves the owner in place. **M5** drops `CONSUME_REAUTH_SQL`'s `expires_at > ?6` and the expired-grant case answers `200`. Attacks `f02` FR-F02-006's four requirements over real HTTP, and the interesting case is **T2a vs T2b**: a target that exists in another organization against one that exists in neither, asserting the two *answers* are identical rather than that both were refused. **M1 removes the `org_id` filter from `find_membership_by_id` and the two diverge — 409 vs 403. Both are still refusals**, so a probe asserting "not 2xx" passes through the entire mutation while the route is an existence oracle across tenants: the claim lives in a *comparison*, not in an outcome. **M2 disables the re-auth guard** and T3 answers `200 granted`. **M3 is a deliberate KNOWN MISSED**: `TRANSFER_OWNERSHIP_SQL`'s own `org_id` predicate is unreachable because the handler's org-scoped lookup returns 404 *before* the UPDATE, so the probe is clean — and that names the statement a reviewer must protect as the only thing between a future refactor and a cross-tenant ownership write. Every mutation keeps the placeholder count, so `schema:bind-count` stays green throughout |
| `verify:privilege-escalation` (last-owner class) | `evidence/v01-031-sensitivity.sh` — **2/2, exit 0.** The new GAP-002 class attacks `f02` FR-F02-005 over real HTTP, and both mutations are `1 = 1` in place of the guard's first predicate so **`pnpm schema:bind-count` stays green throughout** — which is the point: the count check is blind to this class, so a mutation it could see would not be testing the right thing. **M1** makes `CHANGE_ROLE_SQL`'s guard always pass: the last owner demotes themselves (`200`) and then leaves (`204`), and the stored-state assertion reports **`owners after=[]`** — the organization has *no* active owner, which is the invariant itself. **M2** does the same to `REMOVE_MEMBERSHIP_SQL`: the last owner is removed (`204`). The interesting half of M1 is not the 200 but the empty owner list: a probe grading on status alone would have seen two successful-looking responses and had to reason about whether they were permitted. The script also **rebuilds after its final restore**, because a sensitivity run that restores the source and leaves a binary built from the faulted source looks exactly like a repair that did not work |
| `verify:secret-tenancy` | `evidence/v01-secret-sensitivity.sh` — **2/2, exit 0.** M1 reverts V01-030's `sql_bool` annotation, and the **positive control** goes red (`30/32`), which is the proof that the control is load-bearing rather than decorative. M2 removes `AND org_id = ?1` from `ENDPOINT_BY_ID_SQL` while **keeping `?1` bound**, so the statement stays valid and only the scoping goes — the attack then answers `200` and **Bravo's stored version advances `1 → 2`**, read from D1. M2 is the proof that **could not be written before the repair**: while the control was red, a foreign endpoint produced no row, so the attack rows passed for the same reason the owner was refused, and the gate could not show it detects a tenancy fault at all. Fixing the reason is what made the detection demonstrable |
| `smoke:passkey` | each of its two dependency patches reverted individually; the probe fails (5/7 and 33/35 against 55/55). The denominators are smaller because the probe returns early once a core step fails, so the later checks are never reached rather than passing |
| `smoke:passkey` (revocation) | `evidence/vfy-revoked-credential-sensitivity.sh` — the `revoked_at` filter in the login path reverted; a revoked credential then authenticates with 200 and the probe reports 54/55 |
| `guard:probe` | `evidence/vfy004-guard-sensitivity.sh` — five targeted reverts, all detected — plus campaign case `GUARD-2`, which reverts `is_guard_abort` to the pre-VFY-004 substring matcher. The probe verifies the list behaviourally against real SQLite and the function's use of the list structurally; it does not execute the Rust function, so run-time evidence for the match itself comes from `smoke:p05` and `GUARD-1` |
| `smoke:browser` | `evidence/vfy-browser-sensitivity.sh` — run against the pre-repair product, where it reports 12 named failures |
| `smoke:p05` | `verify:mutation` case `GUARD-1` — the reservation sentinel bypassed |
| `verify:idempotency` | `evidence/v01-009-sensitivity.sh` — four mutations, all detected. M1 re-introduces the pre-repair defect verbatim; M2 re-introduces the ordering fault the repair itself introduced; M3 removes **only** the guard statement, leaving the claim, the scope, the fingerprint and the `UNIQUE` constraint all intact, and reports 15 failing cases; M4 returns a stored body that differs from the live one. One honest **KNOWN MISSED** is recorded rather than dropped: the 8-way same-payload burst is satisfied by `UNIQUE (org_id, slug)` with or without a claim, which is the whole reason the payload-varying case is the one that finds the defect |
| `verify:staff-credential` | `evidence/v01-035-actor-type-sensitivity.sh` — **2 detected, exit 0**, and the four harness bugs in the proof itself are the more useful half. **M1** makes the WRITER emit `'staff_operator'`; **M2** removes `'staff'` from the LEDGER. Attacking both files matters: they are the two halves of the class, and a check that catches only one is half a check. The four bugs each **silently converted a real detection into a no-verdict**, which is worse than a MISSED because a MISSED is at least on the sheet: `assert_changed` returned non-zero and the caller wrapped it in `if`, so a mutation that faulted **nothing** appended no verdict and the run still printed *every reachable mutation detected*; `cargo test` exits **101 for a failing assertion as well as for a compile error**, so exit code alone reported every detection as a harness failure; the compile-error pattern `^error:` also matches cargo's own `error: test failed, to rerun pass ...`; and `git diff` **cannot see an untracked file**, so `assert_changed` could never pass for migration 0022 on its first run. The lesson generalises past this script: **a sensitivity harness must not be able to report a verdict for a run it did not perform** |
| `verify:filter-tenancy` | `evidence/v01-filter-sensitivity.sh` — four mutations, all detected, each printing the identifiers it leaked. M1 drops `WHERE org_id = ?1` from `AGENTS_PAGE_SQL` with the bind list and every other predicate untouched. M2 drops it from all three project-page statements, **including the inline one inside `list_projects_unrestricted`**, which a scan of named constants misses because it is the path every owner takes. M3 removes `readable_project`'s handler-level org filter while `PROJECT_BY_ID_SQL` stays unchanged and correctly classified as `ReturnsOrg`, so the tenant audit sees nothing at all. M4 turns the audit list's org predicate into a disjunction — the realistic single-character regression, and the one that keeps the bind count identical, which is why it can ship |
| `verify:inference-failure` | `evidence/v01-infer-sensitivity.sh` — three mutations, all detected. M1 drops the reservation update from `finalize_request`'s batch, so the request finalises correctly and the **success** case is the one that reports stranded money. M2 drops the request state write from the same batch — the money is released and the run never closes, which a money-only gate would score as a clean pass. M3 breaks the compare-and-set in `UPDATE_BUDGET_RESERVATION_SQL` with a one-token change, and that guard is what stops a late finaliser overwriting a COMMITTED reservation with RELEASED |
| `smoke:p08` | `verify:mutation` case *"a project grant list is served without the project being org-scoped"* — the handler's organization check removed while **every SQL statement stays unchanged and correctly classified**. It is the only `VI-TEN-001` case that removes nothing from SQL, which is the whole point: the two cases above it drop a predicate from a statement, the tenant audit sees those, and it cannot see this |
| `verify:privilege-escalation` | `evidence/v01-003-sensitivity.sh` — four cases, all detected. M4 re-introduces the critical co-owner defect verbatim and the probe reports `403 REFUSED → 200 ESCALATED`; the run verifies the source returned to its **snapshot**, not to `HEAD`, because the repair is itself an uncommitted change and "differs from HEAD" cannot tell a failed restore from a repair |
| `verify:adoption-privacy` | `evidence/v01-001-sensitivity.sh` — M1 removes the path refusal at the API and M2 copies the client's workspace key into the audit row; both detected |
| `verify:budget-concurrency` | `evidence/v01-006-sensitivity.sh` — B1 makes the ceiling unreachable and the burst oversells to 240 against a limit of 100; B2 stops the released hold from being reclaimed. B3 is an **expected MISSED**: the route resolves the inference request before the statement runs, so the SQL clause is a second line for the same rule |
| `verify:migration-prior-state` | `evidence/v01-007-sensitivity.sh` — M1 deletes the seeded plans inside the window and M2 deletes the stored claims before 0020's rewrite; both detected, **on the first attempt** |
| `verify:mutating-tenancy` | `evidence/v01-008-sensitivity.sh` — P1 re-introduces the `SET`/`WHERE` placeholder defect verbatim, with a bind list whose *count* is still right, and the probe reports the same 409 the product did; P2 puts `default_model_route` back into the `SET`; P3 drops the optimistic version comparison while keeping the placeholder count |
| `smoke:passkey` | the three authentication attacks V01 added — wrong ceremony kind, identity-link conflict, recovery with active sessions — have their own proof in `evidence/v01-004-sensitivity.sh`. A2 is detected: removing the revoke statement from `password_reset`'s batch makes a pre-recovery session answer 200, which is the exact shape of a critical authentication defect. **A1 and A3 are honest MISSEDs** — two independent gates refuse a wrong-kind ceremony, and the email-conflict guard is unreachable (V01-005) |

A **documented command that cannot start** is a gate that provides no evidence to anyone who follows
the documentation. `verify:filter-tenancy` is called `V01 filter/pagination/nested`, and the harness put
the probe name straight into a filesystem path, so `pnpm verify:filter-tenancy` died with `ENOENT` on
`mkdtemp` **before running a single case**. It went unnoticed because that gate's sensitivity script
exports `V01_FILTER_PERSIST_TO`, which takes a different branch in `setup()` — so the probe had a
recorded **65/65** baseline and four detected mutations, all of them real, while the command printed in
this file could not run. The failure mode is a clean **exit 2**, which reads like "the harness could not
run" rather than "this command has never worked". Names are now sanitised into a path segment, and
`pnpm verify:filter-tenancy` reports **65/65 from the documented command** — the same meaning the
sensitivity harness measured.

And a **verdict with no cause is the same failure as a verdict with no evidence**:
`commit_scoped_mutation` has reported SQLite's own message through `report_error` since an earlier
round, and the harness printed the Worker's log only on a **bail** — while a failing case is not a
bail. So four defects in one surface produced five repairs, and the sheet said *the route is broken*
five times while the actual CHECK violation sat unread in a log nobody printed. `finish()` now reads
the log before stopping services and prints the lines naming a cause whenever a case failed, including
an explicit line saying so when there are none.

**A boundary whose parameter cannot express a domain case will map that case onto whatever value it
does have** — and it will do so silently, in a column rather than in a status. Twice in one round, and
the two are the same defect wearing different clothes. V01-036: `prepare_scoped_mutation` took
`org_id: &str` and turned the schema's own `DEFAULT ''` into an invalid id, so every platform-internal
write answered `503` before a statement was prepared. V01-038:
`security_event_statement*` took `Option<&Principal>`, and ADR 0007 establishes **three** actor kinds —
so a **staff** actor passed `None`, which rendered as `actor_type = 'system'` on the customer-visible
row ADR 0007 requires. The count of states a signature can express is worth reading against the count
the domain has, and the fix in both cases belongs **at the boundary**: in V01-038 the compiler found
all **55** call sites needing the new argument, so the change was type-checked rather than searched
for.

**A capability can be built completely and wired to nothing — and fixing one instance does not close the
class.** Four times now, and the pattern is exact every time: a schema column, a correct statement, a
repository method, a unit test over that statement's SQL, and **no route**. `pnpm check` was green
throughout.

| | capability | enforcement | lever |
|---|---|---|---|
| V01-040 | support-grant **use** | not implemented | not implemented |
| V01-041 | device-enrollment **denial** | — | added: a pending enrollment could be **approved but never denied**, so a human control had an affirmative branch and no negative one |
| V01-042 | idempotency-record **purge** | — | added: a bounded, indexed, validated purge with **no caller**, in a sweep running every minute |
| V01-043 | plugin **quarantine** | enforced on **four** paths | added: the platform could detect, report and refuse — and never *make* a quarantine |

The last is the worst shape: **neither direction existed.** A kill switch with no lever is not a control
that is weak, it is a control that cannot be operated during the incident it exists for. ADR 0007 puts
quarantine deliberately in staff hands, the role holds `PluginQuarantine`, and there was nothing to
exercise it with.

**`security::repository_liveness` is the repair, and it is a check rather than a fix.** Every `pub` fn in
`repositories/` must have a non-test caller, or be on `REVIEWED_UNCALLED` **with a reason**. The
unexamined scan that motivated it listed 53 names; the list turns them into 53 recorded decisions, and
two of the four findings were sitting in that output. Entries are labelled resolved, deliberately out of
band, a known gap, examined, or **`UNTRIAGED`** — the untriaged remainder say so rather than carry an
invented justification, because *53, of which 48 are untriaged* is a to-do list and an absent list is a
false assurance.

Three things about the check that are worth more than the check:

- **A stale entry is refused**, so the list cannot grow into a permission slip. The check *documented*
  that rule and did not apply it — it computed the stale set and asserted nothing — and then three
  entries went stale within the hour, because the very commit that found V01-043 wired those routes.
  **A check that describes a rule it does not enforce is worse than one that omits the rule, because a
  reader trusts the prose.**
- **It is a liveness check, and says so.** A function called once from dead code passes; a
  macro-generated call is invisible; a name collision would be a false pass. It would not have caught any
  of the four on its own — it caught V01-043 by being *run once by hand*. What it does is make the next
  one impossible to add without a decision.
- **It flagged its own author's work.** With the quarantine handlers written but unrouted, clippy
  reported the path constants and the request body as never used — correctly, because an unrouted `pub`
  handler in a `pub(crate)` module chain is unreachable. The check added hours earlier caught the commit
  that added it.

Sensitivity: **M1, M2, M3 all detected.** M1 *adds* an unwired capability rather than removing a caller,
because two earlier attempts at the latter **broke the build** — in a statically linked language,
removing the only call to a function almost always fails to compile, so such a mutation measures the
compiler rather than the check, and adding one is also the historical shape of all four findings.

**The check then enforced one direction of staleness and it was the wrong one** (V01-045). It refused
an entry naming a function that no longer **exists** — loudly, in a comment explaining why the first
version had to assert rather than merely document — and it enforced nothing for the other direction:
an entry whose function has since been **called**. Four entries hid there, and all four were closed
findings from this same campaign: `deny_enrollment_statement` (V01-041) and the three quarantine
statements (V01-043), each labelled `UNTRIAGED` — which asserts *"unreviewed"* — while routed. They
became wired in the very commits that recorded the findings.

**An exclusion for a function that is now called is worse than no exclusion**: it records "examined
and accepted" for something nobody examined, and it hides the next genuine finding, because a reader
has already seen the name and will not re-derive that it is unreviewed. The rule is **not** "is it
called" — a resolved entry like `deny_enrollment` ("V01-041, now called: POST .../deny") is a
*record*, and deleting it would erase why the class found anything at all. The distinction is **what
the reason says**: a record states a fix, a justification states an absence. So the assertion is on
`UNTRIAGED`-and-called, and it found exactly the four.

Sensitivity: **M4 detected, M5 a declared KNOWN MISSED** (no self-contained assertion can detect its
own removal). Two harness faults surfaced first, both worth the naming. M4's *mutation* matched a
prefix of a single-line tuple, so the file still compiled, the test still passed, and the case
reported MISSED for a run that never happened — fixed by anchoring the whole tuple and **re-checking
the effect from outside the mutation**, because `cmp` only proves bytes changed. M4's *verifier* was a
`python3 -c` whose regex contained `\n`; the shell expands backslash escapes inside a double-quoted
`-c` argument, so it became a real newline inside a Python string literal and died with a
`SyntaxError` — **a verifier that cannot run cannot report**, and it must be distinguished from one
that ran and said MISSED.

**A narrowed finding is not a closed one, and re-running it is the cheapest closure available.**
Two records sat open past the point where their own text contained the answer. **V01-029**
(`rotate_webhook_secret` answering `503` to the owner, high) had been narrowed with care: the 503
arrives with **no `idempotency_records` row**, so the failure is *before* the claim, and
`authorize_org` was the prime suspect as the only step taking a **resource context** that
`create_webhook` — which works — does not. The next action was named: *one instrumented run*. **It
had already been repaired, by V01-028's bind-order fix**, sitting in the tree the whole time. Nothing
found it, because checking meant **running** something and the record read as work in progress.
**V01-015** said *HALF repaired, 21/23*, with `approve_enrollment` "blocked on V01-020"; V01-020
resolved, and it is now **23/23**.

Both closed by adding **one assertion to a probe that already built the fixture** — the webhook
fan-out class needed a real endpoint for an unrelated reason, and that endpoint is exactly what
V01-029 required. A record narrowed to a single candidate should carry the assertion that settles it,
because **a fixture one class pays for is what lets another class's finding close in minutes** — and
a finding whose next action is "run it" is a finding that will not be run.

**A documented, tested helper with no caller is a durable false signal.** ADR 0007 requires a staff
audit event on grant creation **and on every use**. The *use* half does not exist: no route consumes a
grant, and `PlatformOperationsRepository::find_grants_for_staff_and_org` — whose doc comment reads *"the
grant read **every customer-context request uses**"* — has no non-test caller. A second comment repeats
the claim and a unit test asserts the SQL's predicates, so the **scoping** is verified while the
**existence of a caller** is not: *a test over a string constant cannot report that nothing calls the
function that owns it.* A reviewer reading that code sees a documented, tested, correctly-scoped grant
read and concludes the mechanism is done — which is more durable than a missing function would be.
The current state is **fail-closed with no fail-open path** (staff cannot reach customer context at all,
granted or not), so this is recorded as **UNPROVEN and deliberately unrepaired**: implementing staff
access to customer context is a feature needing its own spec and ADR, and editing the requirement to
match the code is the one move the campaign forbids. The cheap generalisation is a standing check that
every `pub` repository function has a non-test caller — with its limit stated: it proves a function is
*called*, not that it is called correctly, so it is a liveness check, not a correctness check.

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

A sensitivity harness that snapshots source files will **revert any edit made to those files while it is running**, because its EXIT trap restores from the snapshot. That bit here: a `clippy` fix to a snapshotted file was silently undone by a trap firing twenty minutes later, and the only symptom was a build that had passed twice. So a harness that snapshots is a reason not to edit the tree underneath it, and if the tree is edited anyway, the result must be re-checked after the run rather than assumed. Two more of the same kind, in the same script: `find -exec` cannot invoke a shell function, so a migration comparison built on one silently produced nothing; and a fingerprint written by the *previous* case's restore is not a fingerprint of *now*, so a real migration edit reported as "nothing changed". Both are false MISSEDs manufactured by the harness that exists to prevent them.

And an **EXIT trap does not run when the harness is killed by a signal**: `trap ... EXIT` fires for a normal exit, not for an unhandled `SIGTERM`, so a `pkill` leaves every deliberate fault applied. That is how a mutation script left `let mut writes = vec![claim, cas /*, lease */, record]` in a source file, which made every automation claim answer `503` with no lease and sent me looking for a product regression that did not exist. A harness that deliberately faults source files must therefore handle `INT`/`TERM`/`HUP` and re-raise through `exit` so the restore actually runs — and it must not rely on that alone: an independent check at startup (`git diff --quiet` before snapshotting) is what turns a missed trap from dangerous into harmless, because the trap is best-effort and the check is the authority.

The worst variant of that is a **commit made while the harness is mutating**: a `git add -A` staged a deliberate fault, so the fault went into a commit, and then the obvious repair — `git checkout -- <file>` — restored **the fault** and reported the tree clean, because `git diff` only compares the working tree to the index and the index now agrees with the fault. It is permanent, it is invisible to every file-content check, and it was found here only because a baseline that was supposed to fail on two known assertions instead failed on seven others — a symptom the campaign record did not contain, which is the only reason anyone looked. So a snapshotting harness must also record `HEAD` when it snapshots and verify at exit that **`HEAD` has not moved**: a commit during a mutation run has captured the fault, and the run's verdicts are void until a human undoes it. The general rule is that a verdict is only worth what its reference is worth, and here the reference was the thing under test.

A snapshotting harness has no way to know what "clean" means, because the snapshot is the only reference it has. So a fault **already present when the snapshot is taken** is laundered into the baseline, and every later compare and every restore is faithfully correct about a wrong reference. That is not hypothetical here: three sensitivity runs each printed `restored both source files`, every comparison passed, every mutation read DETECTED — and the mutation was still in the tree at the end, because the snapshot it restored to had been taken with the fault already applied. The only thing that caught it was a `git diff` after a run whose verdicts all read DETECTED. So a harness that snapshots must check the tree against an **independent** reference — `git diff --quiet` on the files it will mutate, at snapshot time *and* after every restore — and must scope that check to its own files, because unrelated uncommitted work is not a finding. A verdict is only worth what its reference is worth.

A probe also cannot set a Worker variable by assigning to `process.env`: `wrangler dev` does not surface the process environment as Worker vars, so the var is silently absent and the Worker behaves as if it were never set. `smoke-harness.mjs` grows a `setWorkerVars` passthrough that becomes `--var NAME:VALUE` on the `wrangler dev` command line. That is a **test affordance in the test harness** and must stay one — a probe that needed a production guard relaxed in order to run would be replacing production security semantics with test-only logic. Naming a host the operator has chosen is what `LUMI_PROVIDER_ALLOWLIST` is for; disabling the SSRF check to make a test pass would not be.

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
