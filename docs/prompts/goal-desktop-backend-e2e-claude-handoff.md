# /goal — Claude Code: finish the current desktop/backend E2E goal

## Human instruction and outcome

You are Claude Code, the primary implementation agent and cross-repository coordinator. Continue the existing LumiAgents desktop/control-plane integration through implementation, independent verification, documentation, focused phase PRs, authorized merges and final paired-SHA readback. Do not restart P00–P09 or stop at the automation slice. All journeys A–E and completion requirements reproduced below remain binding.

The human explicitly authorizes creating PRs and merging both repositories in dependency order after applicable gates pass. Do not ask again for merge permission. This does not authorize deployment, production provisioning, secret custody changes, external provider spending, App Store submission or customer-data operations. Never fabricate a human DCO attestation: inspect each repository's actual governance and identity; finish reviewable changes before requesting any genuinely missing sign-off.

Latest product decision: on fresh app entry, show Lumi Agents login, API-key setup and Continue locally; temporarily hide Z.ai/BigModel OAuth entry buttons. Preserve explicit ZCode/provider OAuth connections in Model Provider settings, BYOK, existing sessions and local-first operation. Signing in must never silently adopt a workspace. Verify both the new default entry and the preserved provider connection route through real supported boundaries.

Use 2–3 Claude agents for independent packets with disjoint ownership. You own integration, shared contracts, the claim ledger and final delivery. Workers must preserve others' edits. Confirm actual task handles before reporting agents as running; use supported task facilities and do not assume detached processes survive their parent session. If unavailable, execute the same packets sequentially and record the limitation.

## Portable bootstrap — fresh machine or existing checkout

Start from a clone of `https://github.com/RunLumi/agents-cp.runlumi.git`. All paths in this prompt are relative to that repository root unless explicitly described as belonging to the child repository. Discover the absolute checkout root with `git rev-parse --show-toplevel`; never assume a username, mounted SSD, OS-specific temporary directory or previous worktree path. Read the repositories' supported-platform/native prerequisites before selecting the runtime environment. Install the pinned toolchains from repository manifests and current setup documentation; do not substitute globally available versions.

Inspect the parent branch, HEAD, remote branches, gitlink and working/index state first. On a clean checkout initialize the independent child with `git submodule update --init --recursive`; on an existing dirty checkout preserve its changes and reconcile explicitly. The desktop repository is `integrations/lumi-agents` relative to the parent root. Keep separate package managers, lockfiles and Git histories. Use `codex/` branches and isolated worktrees or independent clones under a directory you discover/create on this machine, with disjoint write ownership. Do not depend on old machine caches, profiles, keychain entries, temporary prompts, task handles or build artifacts.

Verify GitHub and Claude authentication without printing credentials. Confirm native display, Electron, approved secure storage, loopback networking, Worker/WASM and fresh D1 prerequisites. Document reproducible setup and actionable platform blockers. Use only synthetic test accounts and isolated profiles. Do not silently skip native proof or replace it with a recording host stub.

Retrieve available remote PR/branch state and inspect ancestry before continuing. Historical discovery hints: parent branch `codex/desktop-backend-e2e` at `e7ad897a7f400048df17100594ef86b3788ea0f1`; child branch `codex/lumi-control-plane-e2e` at `2a495254f0018644d24c9c1e5c5210bb7a30075c`; server candidate branch `codex/e2e-phase02-workspace` based on `fe3d6e13c6cb6083cc9fa5ca2e67fefcaa0f83d7`; UI candidate branch `codex/e2e-phase02-lumi-workspace` based on the same child SHA. These branches/commits may not have been pushed. Check remotes rather than assuming they are available. The old native parent HEAD gitlink was `fd977fd06c6d11c0202554d0ae693825a8217879`, differing from its tested dirty child.

**Transfer limitation:** substantial implementation and evidence existed only as uncommitted changes on the previous machine. Pulling this documentation PR does not transfer that WIP. If candidate branches, patches, checkpoints or evidence are absent, record them as unavailable; inspect the current tracked implementation against the complete A–E requirements and implement missing behavior in new packets. Do not block all work waiting for old local files, claim their fixes are present, or invent historical PASS evidence. If an indispensable artifact cannot be reconstructed, ask for that specific artifact while continuing independent work.

Optional old-machine artifacts, if explicitly transferred into this checkout: `supervisor-current-resume.md`, `test-results/client-reconciliation-20261011.json` and `test-results/client-three-way-20261011/{report.json,conflict-blocks.json,REVIEW-QUEUE.md}`. Their old inventory recorded 37 UI-only paths, 147 native-only, 17 identical and 39 modified on both sides; scratch previews had 8 clean textual merges and 31 conflicts/126 blocks. Treat them as dated hints, never mandatory bootstrap inputs or semantic proof. Recreate lane prompts from current contracts instead of expecting previous temporary files.

## Independent submodule workflow on the new machine

For an initial checkout (choose your own destination directory):

```bash
git clone --recurse-submodules https://github.com/RunLumi/agents-cp.runlumi.git
cd agents-cp.runlumi
git submodule status --recursive
git rev-parse HEAD
git -C integrations/lumi-agents rev-parse HEAD
```

The prompt PR must be merged into the chosen parent branch or explicitly checked out before its file is available. Reverify the actual path and URL in `.gitmodules`. If you already cloned without submodules, from the clean parent checkout run:

```bash
git submodule sync --recursive
git submodule update --init --recursive
```

After fetching/pulling a parent update, inspect both repositories for local changes before updating submodules. `git submodule update --init --recursive` checks out the pinned child commit, normally detached HEAD; it does not select the latest child main. Never use `git submodule update --remote` in the required reproducibility gate.

For implementation, first inspect current child state. On a clean child create a named branch from the verified pinned/base commit, for example:

```bash
git -C integrations/lumi-agents switch -c codex/desktop-e2e-continuation
```

Commit and push child changes to **RunLumi/LumiAgents**, then create its own PR there. The parent commit does not contain child source changes: it stores a gitlink SHA. After the child PR is merged, fetch child origin, verify the merge/main SHA and check out that exact commit in a clean integration candidate. Run the paired gate, stage only the intended gitlink with `git add integrations/lumi-agents`, and create a parent PR in **RunLumi/agents-cp.runlumi**. Keep any parent server changes in their dependency-ordered phase PRs. Do not pin an unpublished child commit: a fresh machine must be able to fetch every pinned SHA.

Record and remotely verify parent main SHA, child merged SHA, parent gitlink SHA and tested pair. A detached child checkout is expected for reproducible tests; a named branch is required for ongoing child commits. Preserve independent histories, releases, lockfiles and toolchain versions. A clean-checkout verification should reproduce `git submodule status --recursive` without missing, mismatched or conflicted gitlinks and then pass the documented one-command gate.

## Evidence that must survive continuation

Native run22 terminated UNPROVEN. Optional transferred log: `test-results/native-full-lane3-run22.log`; report: `test-results/t/lumi-automation-a-ReZ7TW/evidence/result.json`. Onboarding, adoption and restart passed for that dirty candidate; schedule, race and faults remained UNPROVEN. No full A–E PASS, clean-checkout paired proof, phase-2 PR/merge or deployment was established.

If the report is available, read it claim by claim; otherwise derive and rerun the obligations from current contracts. Known gaps include one race loser returning `automation_invalid_state` instead of frozen `occurrence_already_claimed`; entitlement loss after adoption; desktop off-peak refusal; committed start with lost response and ambiguous recovery; entropy/fence monotonicity; and stale fence while a lease remains live. A later race round passed, which does not erase the earlier failure. Audit the allowed `existing_lease_id` projection against current frozen contracts and non-disclosure requirements before changing its behavior.

The old uncommitted server candidate changed `claim_target_state` to return `OccurrenceAlreadyClaimed` for Leased/Started and adds a regression test. Narrow Rust checks and formatting passed; the fix has not been ported to native source or runtime-proven there. Previous hostile S4/S5/S6 runs passed 149 claims before this edit; newest full `pnpm check` lacked a verdict because loopback binding hit sandbox EPERM and the retry was aborted. This is not a product PASS or product failure. Re-run appropriate checks with legitimate local runtime permissions.

The UI candidate contains startup `lumiEntryOpened` guard, session/org fences, serialized vault writes, stale device-owner reconciliation, complete-page pagination, timeout/late-result handling and accessibility fixes that differ from native source. Prior typecheck, pre-push and 61 targeted tests passed; UI reports used recording host stubs and do not prove actual Electron IPC/keychain behavior. Standalone Main TypeScript checks still had baseline errors; whole-repository formatting found baseline-wide issues. Do not call either a clean quality PASS or apply drive-by formatting. Resolve exact-head required checks honestly under repository rules.

Preserve run20/21 failing evidence if transferred; if unavailable, state that explicitly and create fresh reproducible evidence. Run20 hit a Miniflare internal D1 error; bounded read-only retries were subsequently added. Run21 exhausted a disposable synthetic mock-provider budget; only that local fixture was raised to 3,000,000 minor units with a 200-request provider ceiling. Run22 passed its fresh slow-run control. Verify independent budget-denial and mutation proofs remain effective; never raise production budgets or weaken enforcement. Improve diagnostics using compact redacted occurrence/lease states rather than serializing tokens, fingerprints or prompt bodies.

## Execute these packets and close the whole goal

1. Coordinator: create/update the delivery plan, packet ownership and claim matrix derived from A–E, then reconcile source in a new stable combined child candidate. Read `docs/implementation/desktop-e2e/plan.md`, DE2E packets and `remaining-goal-gates.md` in the current integration checkout, if tracked; recreate missing follow-on packets from the authoritative plans. Keep historical verdicts intact; add dated current evidence. Reconcile types/transports first, then host authority/fences, renderer/account UI, specs/docs and tests. Keep all verified native functionality and UI/security repairs; do not select one tree wholesale.
2. Server worker: own isolated backend repairs and their tests/docs. Stabilize frozen race refusal across early state read and CAS paths, concurrent claims/jobs, tenant scoping, pending deletion, revoked membership and expired entitlement dispatch. Validate migrations and compatibility; do not edit applied migrations. Port reviewed changes to the coordinator's exact parent candidate through a controlled handoff.
3. Client worker: own the isolated combined child runtime/UI packets. Finish real login/enrollment/adoption/rollback, managed provider/tools and scheduler wiring, stale/restart/ambiguity behavior, secure custody and local-state preservation. Follow child governance/design rather than imposing the parent's UI stack. Exclude scratch `test-results/`, private profiles and generated bundles from commits.
4. Independent reviewer: read-only audit requirements, seams, hostile controls, mutation sensitivity, provenance and delivery order. Derive obligations independently; review critical code and real runtime evidence, not only worker summaries. Report PASS/FAIL/UNPROVEN/BLOCKED/NOT_APPLICABLE with exact claims and artifacts. Coordinator repairs clear failures and reruns original reproducers.
5. Coordinator: close every remaining A–E claim, including managed inference failure/cancel/settlement, real local tool allow/deny/approval, browser/computer/MCP enforcement where supported, matching web audit/usage, existing BYOK/custom MCP/multi-workspace/remote/offline/version behavior and rollback at reachable stages. A passing scheduler journey alone cannot satisfy this goal.

Use narrow reproductions before expensive full runs. Rebuild whenever candidate source changes; verify artifacts actually correspond to tested source. Native prerequisites, loopback sockets, display and approved keychain boundary must be available; report concrete blockers without silently skipping. Test isolated synthetic profiles only and clean only owned resources.

Deliver a documented single command that, from a clean checkout and documented platform prerequisites, installs/builds both pinned repositories, creates fresh Worker/D1 fixtures, launches actual Electron main/renderer/agent, exercises journeys, reads persisted effects, records both full SHAs and redacted evidence, and cleans owned resources. Run it against the final clean exact pair. Demonstrate positive controls and valid deliberate faults for tenant scope, revocation, tool denial, budget settlement and local preservation. Preserve red evidence and prove intended fault detection rather than build failure.

No approved external provider credential/spend cap was supplied. Complete all controllable work; keep the real external-provider round trip BLOCKED until the human provides authorization securely. Never substitute mock proof or call complete E2E while critical claims remain missing.

## Phase delivery, merge and durable documentation

Recheck existing PRs before creating duplicates: parent PR #51 (`https://github.com/RunLumi/agents-cp.runlumi/pull/51`) was OPEN DRAFT at `b7d8fb84251248132456ea5821cc1a69c89e6445`; child PR #39 was already merged. No phase-2 PR existed at the last checkpoint. Verify current status and ancestry rather than assuming those states persist.

Create cohesive phase commits/PRs in both repos with required templates, valid identity/provenance/DCO, packet handoffs, contract changes, migrations, exact tests and compatibility/rollback evidence. Keep failed checks visible and repair them; never weaken gates. Land additive server support before dependent child changes. Verify exact-head local gates and applicable hosted CI/reviews, merge authorized PRs in dependency order, and read back both remote main SHAs. Then pin the merged child in a focused parent gitlink PR, run the clean paired gate, merge and verify the remote gitlink. Revalidate if concurrent main changes affect the tested contract. Do not force-push shared branches or treat two merges as atomic.

Document commands, prerequisites, current verdict matrix, paired SHA provenance, migration/recovery, local rollback, supported-release compatibility, operator troubleshooting and intentional login UX. Separate local/runtime, hosted CI, merged and deployed claims. Existing main workflows may deploy automatically: inspect the release runbook before delivery, preserve configured gates and report actual workflow behavior; this prompt does not authorize an independent manual deployment.

Update the active packet resume checkpoint before interruption/compaction with exact trees, SHAs, dirty state, task handles, evidence, blockers and next commands. On resume independently verify it. Persist until all authorized work is finished; if a real external dependency prevents completion, leave an actionable exact blocker and continue unaffected work. Never report completion just because a session or token budget ends.

Final response must link both repositories' PRs, merged main SHAs and pinned child SHA; give the one-command E2E invocation, claim/evidence matrix, observable user behavior, limits and rollback/recovery. Explicitly distinguish locally proven, CI-proven, merged, deployed and release-certified. An unqualified completion claim requires every critical requirement below to be demonstrably satisfied.

---

## Complete original goal requirements

The following is the full existing goal, preserved verbatim. The continuation instructions above supply current state and the human's explicit PR/merge authorization; all product, security, verification and completion requirements below remain mandatory.

# /goal — Complete LumiAgents desktop ↔ control-plane integration end to end

## Mission

Act as the cross-repository integration coordinator for:

- `RunLumi/agents-cp.runlumi` — Rust Cloudflare Worker and web control plane.
- `RunLumi/LumiAgents` — the actual Electron desktop app and agent runtime.

Deliver a usable managed desktop experience through the real application,
production client adapters, Worker HTTP, persistence, inference and tool runtime.
An existing local user must be able to opt in, enroll one device, bind one
workspace, execute managed work, inspect its results in the control plane, and
return to local mode with existing data intact. A second workspace stays local.

This is a focused integration closure goal, not a concatenation of P00–P09.
Implement missing wiring and repair demonstrated defects; reuse working backend
features and client seams. Do not stop at interfaces, a test adapter, screenshots,
unit tests, a scaffold, or separate backend/client implementations.

## Authority, scope and authorization

Follow both repositories' current AGENTS.md, specs, ADRs, frozen contracts and
packet ownership. This prompt does not override them. The backend remains the
authority for org membership, permissions, policy, budgets and entitlements;
desktop remains the execution surface for local files, shell and native tools.

Invoking this goal authorizes implementation, isolated local test environments,
synthetic fixtures, focused commits and PR creation in both repositories.
Merge, production/staging provisioning or deployment, secret custody changes,
App Store submission and customer-data operations require explicit authorization
in the executing session. Existing authorization in that session remains valid.
Do not wait for approval to complete the reviewable implementation and tests.
If external delivery is unauthorized, finish its artifacts and report exactly
what is ready and what needs authorization; do not claim external completion.

## Read first and establish the actual baseline

1. Read `docs/prompts/README.md`, Plan00, current `STATUS.md`, Plan08, relevant
   P03–P07 integration packets, their gates/fixtures and change requests.
2. Read F01–F05, F07–F13, F15–F16, F18–F19, F21–F23 and F26 as required by the
   journeys below. F06 enterprise identity remains frozen unless separately
   authorized. Read relevant ADRs, including API/testing, actor kinds, private
   exports, deployment and pinned cross-repository integration.
3. Read `docs/verification/README.md`, `plan00-verification-system.md`, runtime
   proof catalog and relevant invariant contracts before designing verifiers.
4. Read `docs/integration/lumi-agents.md` and P08-QA-02. PR #49 introduced a
   pinned module/HTTP/D1 journey; verify its current state rather than inheriting
   its PASS. It does not prove Electron UI, production HTTP adapter wiring,
   desktop persistence, actual inference/tool execution or scheduler adoption.
5. Inspect both checkouts, remote heads, gitlinks, git-common-dir, dirty/index
   state and ongoing processes. Preserve unrelated WIP; use stable isolated
   worktrees. Never silently reset or update a dirty submodule. Do not float
   client main in a required gate; record exact candidate SHAs.
6. In LumiAgents, read its architecture-governance skill and target-module
   context, DESIGN.md, local specs, license/provenance/DCO and upstream rules.
   In the control plane, read DESIGN.md and visually inspect relevant screen
   references before UI changes. Do not impose the control-plane UI stack on
   the desktop repository or combine their package managers/lockfiles.
7. Trace real call paths: renderer → service → Electron host/IPC → client
   transport → Worker, and managed request → agent/runtime → provider/tool.
   Mark each seam implemented, wired, runtime-proven or missing, with paths.
   Check the monthly engineering-review record as required by AGENTS.md.

Produce a concise gap/claim matrix before coding. Missing evidence is UNPROVEN,
not proof that a feature works or does not exist. Resolve stale packet names or
conflicting plan/status claims explicitly; do not rewrite historical packets.

## Execution contract

Create a follow-on implementation plan or extend the existing plan intentionally.
Define packets with repository, owner, dependencies, write surface, frozen gate
commit, acceptance claims and handoff. Map P08-INT-02..06 by behavior; the frozen
stage-5 prohibition remains in force despite any packet name implying sync.
Include backend integration repairs and QA where actual gaps require them.
Only the assigned coordinator edits STATUS.md. Use the change-request template
before changing frozen wire behavior; update specs/ADRs first when necessary.

Keep one authoritative owner for identity/session state, device credentials,
workspace ownership, policy snapshots and scheduler leases. Draw an ownership/
sequence diagram before implementing their asynchronous transitions. Reuse
existing service/IPC/runtime ports and public package entry points; avoid a
parallel session store, policy engine, scheduler or resource vocabulary.

Work autonomously through diagnose → implement → integrate → verify → repair.
Use subagents only when the executing session or applicable instructions permit
delegation; packets must have disjoint ownership. Update the active packet's
resume checkpoint before interruption/compaction and revalidate state on resume.

## Required product journeys

### A. Local-first startup, account and organization

- Launch the real desktop using an isolated copy of representative pre-org
  state. Open an existing workspace/session without an account or network.
- Add optional sign-in using the supported backend authentication contract and
  the desktop/browser callback boundary appropriate to it. Exercise the primary
  supported auth path, session expiry, sign-out and failed/cancelled sign-in.
  Never use development login codes as evidence of a production auth path.
- Select/create an org through the actual UI. Signing in or switching orgs must
  not silently adopt workspaces or retain another org's cached authority.
- Secure session and key material using the desktop's approved storage boundary;
  no token in renderer persistence, logs, URLs, static provider config or reports.
  Use the contract's actual cookie/token/CSRF scheme; do not invent a bearer
  scheme to make Electron requests easier.

### B. Real device enrollment and lifecycle

- Generate the device key in its designated host owner; enroll with real proof
  of possession, explicit user confirmation and current membership checks.
- Wire approval, status polling, challenge/completion, short-lived token exchange,
  refresh, heartbeat and version compatibility to the real client transport.
- Support interrupted/retried/resumed enrollment without duplicate devices or
  secrets. Demonstrate expiry, replay, wrong proof and cancelled/denied enrollment.
- Revoke the device in the control plane. Prove the running desktop loses managed
  policy refresh, token minting and new managed execution; restarting the app
  cannot restore revoked authority. Local personal work remains available.

### C. Explicit workspace adoption, policy and credentials

- Let the user select one workspace, org and project; explain exactly which
  bounded metadata is transmitted. Bind through existing P03/P08 resources and
  advance the frozen adoption ladder one explicit step at a time.
- Show local versus org-managed ownership and credential mode consistently in
  desktop and web. Persist resumable state across real app restarts without
  changing server-owned versions or treating sign-in as ownership conversion.
- Fetch, validate and acknowledge the org/device-bound policy snapshot. Enforce
  expiry, minimum client version, schema compatibility and stale-policy behavior
  at the runtime execution seam; renderer visibility alone is not enforcement.
- Offer the frozen credential choices. Keep local secrets local by default;
  metadata-only mode never transmits secret material. Explicit organization
  credential provisioning uses the existing secure backend path and requires
  clear consent/destination. Never send org provider secrets down to desktop.
- Roll back/unbind through the actual UI after each reachable stage. Verify
  cloud state, cleared binding and local workspace/session/credential usability
  by reading real storage and reopening the session, not a response flag.
- History sync remains disabled under p08-cg-v1. No bulk prompt/file/history
  upload, hidden telemetry or implicit import. Changing this is a separate
  reviewed product/privacy decision, not a prerequisite for this goal.

### D. Managed inference, tools, usage and audit

- From the bound desktop workspace, execute a real agent request through the
  existing managed provider and host adapters. Propagate org/project/device/
  agent-session/run/policy context; client-supplied IDs are never authority.
- Prove non-streaming and streaming responses, cancellation/disconnect, failure
  before output, output then failure and timeouts. Verify reservations settle,
  requests become terminal, retries stay bounded and usage is attributed to the
  right org/project/principal/run. Render failures and recovery in the app.
- Execute a benign local side effect in a disposable workspace through the
  actual managed tool broker. Test allow, deny and approval-required behavior;
  denial must prevent the side effect. Bind approval to the exact tool/action/
  arguments/run as required; changing the request cannot reuse approval.
- Trace browser/computer/MCP enforcement to real entry points. Demonstrate their
  deny/expiry/revocation boundaries and controlled benign execution where those
  surfaces are supported. Unsupported platforms are named NOT_APPLICABLE with
  evidence, never silently credited as covered.
- Observe the resulting run, usage and audit in the web control plane, with
  matching correlation IDs and correct tenant context. No raw sensitive content
  is logged merely to make correlation easier.

### E. Automation and existing-state migration

- In the desktop, preview a local automation import with conflicts and bounded
  metadata. Preview creates nothing; cancellation leaves the local automation
  unchanged. Explicit confirmation creates a managed automation through P06.
- Wire the actual desktop scheduler: due work → authenticated device claim →
  lease/fence → start → real managed run → renew/settle/release. Ensure the local
  and managed schedulers do not execute the same adopted occurrence twice.
- Race two clients/devices for one occurrence; exactly one executes. Restart,
  lease expiry, stale fence, entitlement loss, device revocation and off-peak
  restrictions must match frozen semantics, including ambiguous outcomes.
- Preserve local BYOK, custom MCP, many workspaces, old sessions and supported
  remote workspace behavior. Test unavailable control plane, version mismatch,
  interrupted migration and rollback. Do not upload automation bodies through a
  metadata-only endpoint or delete originals to avoid duplicate execution.

## E2E harness and evidence requirements

Extend the existing pinned integration tooling with a documented one-command
desktop E2E entrypoint. From a clean checkout with documented prerequisites it
must install/build the exact pair, create fresh local test resources, launch the
actual Electron main/renderer and agent process, exercise the UI and runtime,
assert stored effects, preserve redacted diagnostics and clean up only owned
resources. Name platform/native prerequisites; do not silently skip a missing
Electron binary, keychain or display. Never test against a personal profile.

Use real production client code. A test-owned HTTP adapter may help isolate a
contract, but cannot satisfy the desktop wiring gate. Use UI interactions for
user journeys; direct API calls may seed/administer synthetic fixtures and
attack boundaries, not stand in for the whole onboarding UI.

Run a controllable provider on a host reachable by Worker runtime, with measured
request counts and bounded fault injection. A backend mock:// provider proves
only that path. Complete one opt-in real provider round trip if approved test
credentials and a spending cap are available; otherwise mark external-provider
proof BLOCKED while completing all controllable local integration work. Never
relax production egress or authorization to unblock tests.

For each critical claim record PASS, FAIL, UNPROVEN, BLOCKED or NOT_APPLICABLE,
requirements, both full SHAs, clean/dirty state, protocol/schema versions,
platform/app build, command, fixtures, controls and evidence paths. UI captures
support behavior evidence; D1/client SQLite/side-effect readback proves state.
Grade tenant attacks on non-disclosure and stored effects, not status alone.

Fault at least the load-bearing boundaries for tenant scope, revocation, managed
tool denial, budget settlement and local-state preservation in disposable
worktrees. Each valid fault must be detected for the intended reason after its
positive control; compilation failure or a probe that never started is not a
detected security defect. Preserve failing evidence, fix root causes, restore
and rebuild independently, then rerun the original reproducer.

Run relevant narrow tests first, then each repo's required format/lint/types/
unit/build/architecture checks, Worker WASM/dry-run and runtime probes. Validate
desktop and narrow layouts, keyboard/focus, accessibility, loading/empty/error/
permission states and reduced motion for changed UI. Measure startup/navigation,
token refresh/IPC behavior and bundle impact; do not claim latency from build
success or raise a budget to obtain a green result.

## Delivery and exact completion gate

Keep focused PRs in both repositories, with required templates, DCO/provenance,
packet handoffs, contract changes, migration/rollback and reproducible evidence.
Publish a compatibility matrix for current supported desktop release + new
backend and candidate desktop + backend. Land additive server support before
clients depend on it. Retain data compatibility across rollback; do not edit
applied migrations. A gitlink pins a tested pair, not an atomic two-repo merge.

When merge is authorized: verify exact heads/checks, merge in dependency order,
read back both remote main SHAs, update the parent gitlink to the merged client,
rerun the paired gate and finish the pin PR. When deployment is authorized:
follow the runbook, preserve existing resources/keys, serialize delivery, verify
actual upload/version/message and live E2E on synthetic approved accounts.
Store release/signing/provider evidence separately from local and hosted CI.

The goal is implementation-complete only when A–E run through the actual
desktop, supported managed operations enforce the same contracts as the
backend, hostile/state/control tests pass, local data remains usable, checks
pass, and operator/recovery/compatibility documentation and durable evidence
are reviewable. A critical BLOCKED/UNPROVEN claim prevents an unqualified
"complete E2E" verdict. Continue independent work and report the exact remaining
dependency; do not substitute a mock PASS or keep rebuilding a known scaffold.

Final handoff: link both PRs and tested SHAs, E2E command and evidence matrix,
what a user can now do, measured limitations, rollback/recovery procedure and
external approvals/proofs still owed. Say whether the result is locally proven,
CI-proven, merged, deployed or release-certified. Do not collapse those claims.
