# DE2E-INT-03 — Explicit per-workspace adoption and rollback

Status: in_progress; owner: goal coordinator. Repositories: LumiAgents
client and control-plane runtime probes. Depends: DE2E-INT-02 device
lifecycle/policy, frozen P03-CG v1 and P08-CG v1.

## Read before implementation

Read client AGENTS.md, architecture-governance skill, DESIGN.md, target module
contexts, the new `docs/specs/lumi-agents/05-workspace-adoption-runtime.md`,
P03/P08 gates and fixtures, current CRs, and runtime-proof contracts. No
`docs/screens/` directory exists; inspect the real General settings screen at
`test-results/electron-profile/account-settings.png` (temporary evidence) and
follow the existing Settings layout. Read parent P08 route implementations and
P03 device-binding handlers;
the existing P08 CLI wizard is a contract seam, not desktop/runtime evidence.

## Current gap

The client exposes `P08AdoptionWizard` only under the CLI contracts package and
has no real HTTP transport or Electron workspace command. The Desktop settings
page already knows the active workspace identity/path, while the existing
Lumi panel is global and has no workspace scope. P03 `WorkspaceBinding` and P08
`AdoptionState` are separate server resources. P08 creation accepts project
and device IDs at stage 0; its frozen stage-update request cannot add them later.
The adapter must make that sequencing explicit and resumable without changing
the frozen wire contract or claiming ownership before the requested transition.

## Design decision

Main derives a stable opaque workspace key from the existing canonical identity
using a main-owned secret, stores that mapping in its dedicated encrypted
workspace owner, and sends no path to the server. P03 binding uses that opaque
key. P08 rows carry only the opaque installation/workspace reference, display
name, project/device and client compatibility facts. Server-returned ownership
is the only ownership label. A user action advances one P08 stage; retry reads
server state and reuses idempotency. Rollback removes P08 authority and the
matching P03 binding, with local data untouched.

## Write surface

Client: `docs/specs/lumi-agents/05-workspace-adoption-runtime.md`;
`packages/services/src/lumi-account/**` fixed-route P03/P08 transport and owner
ports; one dedicated main workspace-mapping vault/owner; existing shared
Lumi-account command/projection; `packages/ui/src/SettingsPage.tsx` and a
workspace-scoped Lumi panel plus EN/ZH strings; focused tests and actual Electron
harness. Add module contracts/dependency declarations only if architecture
context requires them. Do not change provider OAuth or P08/P03 wire behavior.

Control plane: only the parent real Worker/D1 probe, integration runner, this
packet and the desktop-e2e plan. Backend behavior changes require a separate
reproducer and accepted Change Request before touching implementation.

## State order

```text
local workspace identity
  → main-owned opaque mapping (never uploaded as a path)
  → explicit user review/confirmation
  → P03 device/project workspace binding
  → P08 local_unmanaged record, then user-requested successor only
  → server readback and policy acknowledgement
  → visible server-owned ownership projection
  → later managed-runtime packet may consume the binding
```

The first user action must be idempotent across a dropped response. Because
P08's frozen POST establishes stage 0 and the frozen PATCH cannot add project or
device IDs, the adapter may create stage 0 with the already reviewed binding
identifiers and then advance only to the successor the user explicitly chose.
It must not skip stages or render `org_managed` until the server returns
`workspace_bound` or later.

## Acceptance

- Real Electron confirmation sends only the bounded previewed metadata; prove
  paths, credentials, prompts and files are absent from HTTP, D1 and logs.
- Only the chosen workspace binds. A second workspace starts and executes local
  work unchanged, with the existing provider login and BYOK selection intact.
- Restart reads server state and resumes without duplicate mapping, P03 binding,
  P08 row or audit event.
- Negative org/project/device substitutions, duplicate identity, lost response,
  expired/revoked device, stale policy, and unsupported compatibility fail
  closed before managed execution.
- Rollback reads both P03/P08 state, removes the remote binding/ownership,
  preserves local files/session/provider credentials, and remains retryable.
- P08 stage 5 is absent from UI and transport construction.
- Record local checks, actual Electron/Worker/D1 evidence, mutation sensitivity,
  both repository SHAs, and remaining provider/scheduler proofs separately.

## Resume checkpoint

2026-10-07: parent Worker/D1 real transport journey PASS on fresh 25-migration
D1: actual Lumi account/device transports created a P03 project binding using
only the opaque workspace key, created P08 stage 0, the server rejected a
direct stage skip (409), each successor returned server-owned stage/ownership,
policy was acknowledged before the managed stages, and rollback removed the
P03 binding while retaining the P08 local row and incrementing reversion history.
The test is tests/integration/lumi-account.mjs; the account report records
parent HEAD e7ad897a7f400048df17100594ef86b3788ea0f1 and client HEAD
2a495254f0018644d24c9c1e5c5210bb7a30075c, with dirty flags true.

Actual Electron/isolated Chrome/Worker/D1 journey PASS from
tests/integration/desktop-account-electron.mjs. Report:
/var/folders/zz/jzz3w1rj5lq21d_7c0nkc31m0000gn/T/lumi-electron-account-3KWEVO/evidence/result.json.
It exercised real UI sign-in, device enrollment/refresh, selected-project workspace
bind, three explicit P08 transitions to workspace_bound, restart/readback with
no duplicate, rollback to local, unchanged sentinel file, encrypted workspace
mapping with no path in plaintext, revocation refusal and logout. Screenshots
workspace-selection.png and workspace-bound-local-stage.png were visually
checked against DESIGN.md; no docs/screens/ directory exists. Both repos were
dirty during this proof, so it is runtime PASS on this working tree, not a clean
checkout or reproducible pair claim.

Implementation now exists in the client main owner, service transports, vault,
IPC and General Settings UI. Focused client suite: 14/14 PASS; root typecheck
PASS; touched-file format PASS; architecture:check --changed PASS, 0
violations. Desktop build:no-runtime-assets PASS. Full-repository fmt:check
remains baseline-dirty and is not claimed.

The one-command clean runner is still BLOCKED during dependency installation:
online tarballs timed out and explicit offline mode reports a missing
emoji-regex@10.6.0 snapshot. A retry temporarily removed the isolated
worktree's generated pnpm virtual store; the exact-lockfile original package
tree restored local test execution, with its clean SHA verified. Do not call this
a product failure or modify lockfiles to mask the store miss.

Next: remove temporary test diagnostics, add/fix focused transport invariants,
then trace DE2E-INT-04 per-request run/session/model auth and tool broker against
P04/P05 contracts before starting managed inference wiring. Scheduler/automation,
legacy provider matrix, primary passkey, clean-checkout/hosted CI evidence,
full security mutation gates, both PRs and merge remain outstanding.
