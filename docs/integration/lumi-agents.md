# LumiAgents integration

`integrations/lumi-agents` is a pinned Git submodule, not part of this pnpm or
Cargo workspace. See [ADR 0011](../adr/0011-pinned-cross-repository-integration.md).

## Current client source pin

The gitlink selects LumiAgents main `ac011fce8d6273a1218022de17fdeafec7a59ba9`,
including [PR #48](https://github.com/RunLumi/LumiAgents/pull/48), whose resolution
preserves the newer v3.15.1 and session/vault/paging fixes. Integration uses this
exact commit; updating the pin requires a new paired runtime test. The source pin
does not certify the full Electron E2E goal. See the
[PR #59 review record](../verification/pr59-reconciliation-20261011.md).

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

The filtered module gate uses pnpm's isolated linker to avoid the documented
[hoisted-copy race](https://github.com/pnpm/pnpm/issues/12880), also affected by
[patch working-directory changes](https://github.com/pnpm/pnpm/issues/13627).
The package manager and dependency versions remain frozen. This command does
not modify the client's `.npmrc`; desktop mode retains its configured install
layout and native hooks. Changing between module and desktop modes may require
pnpm to rebuild the ignored dependency layout; preserve source changes.

## Proof boundary

## Desktop bootstrap entrypoint

Desktop mode installs both frozen lockfiles, enables the client's own `allowBuilds`
Electron/native hooks (even when a user-level pnpm config sets `ignore-scripts`),
builds current-host runtime assets and both apps, then runs the contract and
account/device gates followed by every actual Electron journey:

```sh
LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs
```

| Journey | Script | Claims (each after its positive control) |
|---|---|---|
| account | `desktop-account-electron.mjs` | Lumi-first entry, PKCE + browser approval, enrollment, streamed managed turn, tool allow/deny, bind/rollback/rebind, restart, revoked sync, logout |
| account-failures | `desktop-account-failures-electron.mjs` | cancelled/unapproved/expired/wrong-code sign-in, killed enrollment resumes without duplicates, server session expiry across restart |
| revocation | `desktop-revocation-electron.mjs` | revoke refuses new managed execution at the UI and host seam, restart cannot restore authority, local work continues |
| managed-faults | `desktop-managed-faults-electron.mjs` | failure before/after output, timeout, user cancel, bounded attempts, settled reservations, recovery |
| local-preservation | `desktop-automation-local-preservation.mjs` | scheduler keeps local automations, leaves adopted originals untouched, offline control plane |
| automation | `desktop-automation-electron.mjs` | journey E preview/adopt/schedule/race/restart/faults |

`LUMI_DESKTOP_JOURNEYS=account,revocation` limits a diagnostic run; the report
records the narrowed scope and it is not a full-gate result. Every journey must
report PASS for exactly the recorded parent and client SHAs.

Prerequisites: Node 24, Rust stable with `wasm32-unknown-unknown`, worker-build
0.8.x, Google Chrome (browser approval), and a native display plus keystore.

- **macOS:** a logged-in desktop session and the login Keychain.
- **Linux (validated on Ubuntu 22.04):** `xvfb`, `dbus` (`dbus-run-session`),
  `gnome-keyring`, `libsecret-tools` and the Electron runtime libraries (`libgtk-3-0`,
  `libnss3`, `libgbm1`, `libasound2`); `libssl-dev`/`pkg-config` to build
  worker-build. The runner re-enters itself through
  `scripts/integration/linux-desktop-session.sh`, which starts a private D-Bus bus,
  an Xvfb display and a gnome-keyring Secret Service whose data lives only under the
  run's output, unlocked with a synthetic password, health-checked and removed
  afterwards. Electron selects `--password-store=gnome-libsecret`; the product
  refuses `basic_text`, and so does the gate. Personal keyrings, displays and
  session buses are never used.

Missing native prerequisites produce BLOCKED rather than a skip/PASS. Remote-platform
release archives are outside this local gate. Older dated evidence remains in
the verification run directory; it is not current proof.

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
