# Desktop E2E continuation — resume checkpoint (Claude coordinator)

Authority: `docs/prompts/goal-desktop-backend-e2e.md`. This checkpoint records state; it does
not certify any claim. Verify every line before trusting it on resume.

Updated 2026-10-12 (UTC).

## Delivery ledger

| Phase | Repository | PR | State |
|---|---|---|---|
| DE2E-SRV-01 race loser, device-audit project, web audit log | agents-cp.runlumi | [#62](https://github.com/RunLumi/agents-cp.runlumi/pull/62) | **Merged** `fd6b75771235f6889245d041f4083a6f0ca0600c`; main pipeline quality + migrations + deploy + production smoke succeeded |
| DE2E-QA-01 Linux gate, journeys, sensitivity | agents-cp.runlumi | [#63](https://github.com/RunLumi/agents-cp.runlumi/pull/63) | open, branch `codex/de2e-desktop-gate` |
| DE2E-CLI-01..04 desktop fixes | LumiAgents | [#49](https://github.com/RunLumi/LumiAgents/pull/49) | open at `06e2483a84782bf0786adb19ee2121b64125810e`; **DCO red until a human signs off** (CONTRIBUTING forbids tool sign-off) |
| Pin merged client + clean paired evidence | agents-cp.runlumi | pending | after #49 merges |

Old-machine artifacts (supervisor resume, run20/21/22 logs, three-way reports) are unavailable
here; historical verdicts in `docs/verification/runs/2026-10-07-desktop-managed-e2e/` stand.

## Branches and worktrees (relative to the parent root's parent directory)

| Repo | Branch | Location | Purpose |
|---|---|---|---|
| parent | `codex/de2e-integration` | root | local integration candidate (merges, all harness commits) |
| parent | `codex/de2e-desktop-gate` | `de2e-worktrees/gate` | PR #63 head (cherry-picks, no gitlink change) |
| parent | `codex/de2e-mcp-journey` | `de2e-worktrees/mcp` | MCP journey (merged into integration) |
| child | `codex/desktop-e2e-continuation` | `de2e-worktrees/client` | PR #49 head |

The root submodule is detached at the client PR head `06e2483a` and built for local runs.

## Local evidence (dirty integration candidates; not certification)

| Journey | Latest local verdict |
|---|---|
| module adoption/account/device | PASS |
| account | PASS |
| account-failures | PASS (7) |
| revocation incl. secret sweep + BYOK preservation | PASS (9) |
| managed-faults incl. web observation + tenant non-disclosure | PASS (9) |
| adoption-policy | min-version and earlier steps PASS; recovery step repaired by client CLI-03 + journey fix, rerun pending |
| multi-org | PASS (3) |
| mcp | PASS (allow, org deny, approval deny, revocation); computer NOT_APPLICABLE; browser runtime UNPROVEN |
| automation (journey E) | onboard/adopt/race round 1 PASS (frozen loser reason at runtime); round 2 timed out under load; rerun in progress |

Sensitivity (disposable worktrees): S1 tenant, S2 revocation, S3 tool denial (server resolution),
S4 budget settlement (reconcile release), S5 local preservation (query exclusion + trigger) all
DETECTED for the intended reason after earlier UNDETECTED/INVALID definitions were corrected;
final-pair rerun pending.

## Next commands

```sh
node scripts/integration/desktop-sensitivity.mjs        # final pair
LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs   # after the pin (clean pair)
```

Blockers: human DCO sign-off for LumiAgents#49; external-provider proof BLOCKED (no approved
credential/spend cap).
