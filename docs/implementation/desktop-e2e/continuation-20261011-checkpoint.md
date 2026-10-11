# Desktop E2E continuation — resume checkpoint (2026-10-11, Claude coordinator)

Authority: `docs/prompts/goal-desktop-backend-e2e.md`. This checkpoint records current state;
it does not certify any claim. Verify every line below before trusting it on resume.

## Baseline (read back from remotes on 2026-10-11)

- Parent main `febc39dbadfb9421fb5fd903c93fcaac0af65386` (#59, #60 merged); gitlink
  `ac011fce8d6273a1218022de17fdeafec7a59ba9` = LumiAgents main (#48 merged).
- Old-machine artifacts (`supervisor-current-resume.md`, run20/21/22 logs, three-way
  reports) are **unavailable** on this machine. Historical verdicts in
  `docs/verification/runs/2026-10-07-desktop-managed-e2e/` stay as recorded.

## Branches and worktrees

| Repo | Branch | Path | Owner | Head |
|---|---|---|---|---|
| parent | `codex/desktop-e2e-linux-gate` | repository root | coordinator (harness, docs, pin) | Linux gate commit |
| parent | `codex/de2e-race-loser-refusal` | `../de2e-worktrees/server` (sibling of the root) | server/web worker (DE2E-SRV-01) | race fix `7df0fee` + worker commits |
| child | `codex/desktop-e2e-continuation` | `../de2e-worktrees/client` | client worker (DE2E-CLI-01) | `1433897a` + worker commits |

The submodule checkout in the root is detached at `1433897a` for coordinator runs.

## Environment (Linux, Ubuntu 22.04)

Node 24.14.0 (nvm), pinned pnpm under `test-results/pnpm-tools`, Rust stable + wasm32,
worker-build 0.8.7, Xvfb, dbus-run-session, gnome-keyring + libsecret, Google Chrome stable.
A user-level pnpm rc sets `ignore-scripts=true`; desktop mode opts into the client's
`allowBuilds` hooks explicitly.

## Evidence so far (local, dirty or branch heads; not CI, not merged)

- Module gate PASS on the clean pinned pair (`febc39d` + `ac011fce`).
- Actual Electron account journey (`desktop-account-electron.mjs`) PASS on Linux with the
  owned keystore after two repairs: lazy electron-updater (child `1433897a`) and explicit
  `gnome-libsecret` selection (parent harness). Parent was dirty (race fix) for that run.
- Independent review matrix: 17 ranked journey gaps; race loser FAIL (fixed on branch,
  runtime proof pending); client pre-start refusal misclassification; web audit view missing.

## Next commands

```sh
LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs   # Linux re-enters an owned session
scripts/integration/linux-desktop-session.sh <state-dir> node tests/integration/desktop-automation-electron.mjs
```

Open: journeys E (automation) on Linux, revocation-after-revoke turn + restart, policy
mutations, failure/cancel modes, provider preservation, web observation, wire/secret sweep,
all-stage rollback, sensitivity faults, CI desktop job, PRs and paired pin.
