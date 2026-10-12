# Desktop E2E continuation — resume checkpoint (Claude coordinator)

Authority: `docs/prompts/goal-desktop-backend-e2e.md`. This checkpoint records state; it does
not certify any claim. Verify every line before trusting it on resume.

Updated 2026-10-12 (UTC).

## Baseline read back from remotes (2026-10-11)

- Parent main `febc39dbadfb9421fb5fd903c93fcaac0af65386` (#59, #60 merged); gitlink
  `ac011fce8d6273a1218022de17fdeafec7a59ba9` = LumiAgents main (#48 merged).
- Old-machine artifacts (`supervisor-current-resume.md`, run20/21/22 logs, three-way reports)
  are **unavailable** here. Historical verdicts in
  `docs/verification/runs/2026-10-07-desktop-managed-e2e/` stay as recorded.

## Branches, worktrees and owners

| Repo | Branch | Location (relative to the parent root) | Owner | Content |
|---|---|---|---|---|
| parent | `codex/desktop-e2e-linux-gate` | root (switchable) | coordinator | Linux gate first commit |
| parent | `codex/de2e-integration` | root (current) | coordinator | gate + journeys + sensitivity, merges server branch for local runs |
| parent | `codex/de2e-race-loser-refusal` | `../de2e-worktrees/server` | server/web worker DE2E-SRV-01 | race fix, sequential-loser probe, audit view (in progress) |
| child | `codex/desktop-e2e-continuation` | `../de2e-worktrees/client` | client worker DE2E-CLI-01 (done) | lazy updater, pre-start refusal list, off-peak owner, revocation/fresh-entry tests |

The root submodule is detached at the client branch head for coordinator runs. Child commits
carry **no** `Signed-off-by`: CONTRIBUTING requires a human sign-off; the tool never adds one.

## Environment (Linux, Ubuntu 22.04)

Node 24.14.0, pinned pnpm in `test-results/pnpm-tools`, Rust stable + wasm32, worker-build
0.8.7, Xvfb, dbus-run-session, gnome-keyring + libsecret-tools, Google Chrome stable. A
user-level pnpm rc sets `ignore-scripts=true`; desktop mode opts into the client's
`allowBuilds` hooks. Electron 44 downloads lazily via `require('electron')`.

## Local evidence so far (dirty or unpublished heads: not CI, not merged)

| Journey | Latest local verdict | Notes |
|---|---|---|
| module adoption/account/device | PASS | clean pinned pair and candidate pair |
| account (Electron) | PASS | Linux, owned keystore |
| account-failures | PASS (7 claims) | cancel/unapproved/expired/wrong code, killed enrollment, session expiry |
| revocation | PASS (7 claims) | UI + host seam refusal, restart, local work continues |
| managed-faults | PASS for fail/partial/timeout; cancel repaired to wait for Worker watchdog (deadline+grace) | Agent retries a retryable failure ≤10 times (observed 7) |
| adoption-policy | in progress | min-version enforced at token exchange per P03-CG; journey adjusted |
| automation (E) | not yet run on Linux to completion | |
| sensitivity S1–S5 | runner committed; S1 running | INVALID ≠ detected |

## Next commands

```sh
LUMI_AGENTS_DIR=$PWD/integrations/lumi-agents LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs
node scripts/integration/desktop-sensitivity.mjs            # after a desktop gate run
```

Open: web observation journey (after audit view), tool exact-approval/argument reuse,
MCP/browser enforcement or NOT_APPLICABLE evidence, wire/secret sweep, offline/legacy/multi-org,
journey E full run, sensitivity results, PRs (server first), child DCO sign-off by a human,
merge, pin, clean paired replay.
