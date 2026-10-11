# LumiAgents integration

`integrations/lumi-agents` is a pinned Git submodule, not part of this pnpm or
Cargo workspace. See [ADR 0011](../adr/0011-pinned-cross-repository-integration.md).

## One command from a clean checkout

Prerequisites: Git, Node 24, npm (for isolated pinned pnpm tools),
Rust stable with wasm32-unknown-unknown, and worker-build 0.8.x. Network is needed
for pinned dependencies and tools. No Cloudflare credentials are required.

```sh
node scripts/integration/lumi-agents.mjs
```

`pnpm test:integration:lumi` is equivalent. The runner initializes a missing
submodule, installs each repo's exact pnpm version into ignored test tooling
with lifecycle scripts disabled, and uses frozen lockfiles. It builds web/Worker,
bundles the real client P08AdoptionWizard, migrates fresh local D1, and starts a
local development Worker on an ephemeral port. It never deploys or migrates
remote resources. An existing submodule on a different SHA is refused rather
than reset. Client installation skips lifecycle hooks: this module test needs
no Electron/native assets (the hoisted lockfile may still install other packages).
If both exact-version pnpm stores already contain every locked package,
`LUMI_INTEGRATION_OFFLINE=1` adds pnpm's offline mode; a cache miss is BLOCKED,
never a product failure or a reason to float dependencies.

## Proof boundary

## Desktop bootstrap entrypoint

On macOS with native build tools, a display/keychain, Node 24, Rust/WASM and
worker-build 0.8.x, the desktop mode installs both frozen lockfiles, enables
required Electron/native hooks, builds current-host runtime assets and both
apps, then runs the contract, account/device and actual Electron journeys:

```sh
LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs
```

Every nested build receives its repository's pinned pnpm binary. Remote-platform
release archives are outside this local gate. Missing native prerequisites
produce BLOCKED rather than a skip/PASS. electron-report.json joins the paired
SHA report. This command's current journey scope is explicit in result.json;
full A–E tool/fault/automation/compatibility proof remains required by the goal.
This entrypoint is implemented but clean-install validation is still pending.

For the scoped actual Electron managed-run/rollback/rebind proof, see
[2026-10-07 evidence](../verification/runs/2026-10-07-desktop-managed-e2e/README.md).
It runs the production Desktop/Agent code against fresh Worker/D1, uses
mock:// inference, and records the remaining A–E obligations explicitly.
This separate prepared-build harness is not yet the clean one-command desktop
gate required by the full goal.

The actual client wizard discovers compatibility, explicitly registers one
workspace, advances through four stages to managed_policy, and rolls back.
The account/device transport probe also covers S256 session auth, real device
enrollment/refresh, bounded human-authorized token recovery, challenge expiry
and replay, revocation, and logout. Its standalone `account-report.json` records
named redacted assertions, both repository HEAD SHAs, and dirty-state flags.
Each stage is compared with D1. Another organization's rollback must be refused
and leave the row unchanged; a second workspace must have no cloud record.
Fixtures use real HTTP auth/org/project/device enrollment with an Ed25519 proof.
The host-owned test transport handles cookies/CSRF and maps frozen wire DTOs.

This is not a shipped desktop adapter or Electron UI test. Its required
`local_data_modified: false` port wrapper is not evidence of local file
preservation. Client SQLite migration, full offline startup, packaged app,
inference and older client releases remain outside this proof.

## Evidence

`test-results/lumi-agents/<timestamp>/result.json` records both SHAs, gitlink,
dirty/override flags, package manager pins, verdict and named assertions.
`journey.json` and bounded redacted `worker.log` preserve diagnostics. The runner
cleans up its own Worker and temporary database; it retains reports/build output.
Exit 0 = PASS, 1 = runtime FAIL, 2 = setup/build BLOCKED. Dirty local runs are
explicitly non-reproducible; CI refuses them. CI publishes only JSON reports in the job summary.

## Edit both repos

```sh
LUMI_AGENTS_DIR=/absolute/path/to/client-worktree node scripts/integration/lumi-agents.mjs
# Or create a client branch before editing the submodule:
git -C integrations/lumi-agents switch -c codex/client-change
```

Read both AGENTS.md files. Client changes need their own commit/push/PR. Parent
commits do not publish child source. Never run recursive cleanup over work in progress.

After the client PR merges, fetch and deliberately check out its full SHA in
the clean submodule, `git add integrations/lumi-agents`, commit the pin, and run
the command. Attach evidence with `reproducible: true` to the parent PR.
Do not use `submodule update --remote` in the gate. Preserve compatibility with
released clients and land server support before a client depends on it.

The separate LumiAgents integration workflow has read-only permissions and no
deployment. Requiring it in branch protection is a separate repository setting.
