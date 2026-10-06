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

## Proof boundary

The actual client wizard discovers compatibility, explicitly registers one
workspace, advances through four stages to managed_policy, and rolls back.
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
explicitly non-reproducible; CI refuses them. CI uploads only JSON reports.

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
