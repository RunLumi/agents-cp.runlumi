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

- Preserve existing ZCode/provider sign-in, refresh, logout, cached-session and
  model access paths. Lumi sign-in is a separate host-owned account context;
  ZCode credentials never become Lumi authority and Lumi logout must not erase
  provider credentials. Test ZCode-only, Lumi-only, both accounts and neither.
  Preserve local BYOK/provider selection under the frozen organization policy.

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
