# Desktop E2E continuation — resume checkpoint (Claude coordinator)

Authority: `docs/prompts/goal-desktop-backend-e2e.md`. This checkpoint records state; it does
not certify any claim. Verify every line before trusting it on resume.

Updated 2026-10-12 (UTC).

## Delivery ledger

| Phase | Repository | PR | State |
|---|---|---|---|
| DE2E-SRV-01 race loser, device-audit project, web audit log | agents-cp.runlumi | [#62](https://github.com/RunLumi/agents-cp.runlumi/pull/62) | **Merged** `fd6b75771235f6889245d041f4083a6f0ca0600c`; main pipeline quality + migrations + deploy + production smoke succeeded |
| DE2E-QA-01 Linux gate, journeys, sensitivity | agents-cp.runlumi | [#63](https://github.com/RunLumi/agents-cp.runlumi/pull/63) | **Merged** `f73e3efae62be0f82ad2dc25f8fcee88d868e11d`; pipeline deploy + smoke succeeded |
| DE2E-QA-02 journey E fixes, revoked-state UI, evidence record | agents-cp.runlumi | branch `codex/de2e-journey-e-evidence` | this PR |
| DE2E-CLI-01..05 desktop fixes (incl. token rotation) | LumiAgents | [#49](https://github.com/RunLumi/LumiAgents/pull/49) | open at `e9c1ffc2f7e98bfe5034d982ff306d5f0f71404e`; **DCO red until a human signs off** (CONTRIBUTING forbids tool sign-off) |
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

The root submodule is detached at the client PR head `f3d31d55` and built for local runs.

## Local evidence (dirty integration candidates; not certification)

| Journey | Latest local verdict |
|---|---|
| module adoption/account/device | PASS |
| account | PASS |
| account-failures | PASS (7) |
| revocation incl. secret sweep + BYOK preservation | PASS (9) |
| managed-faults incl. web observation + tenant non-disclosure | PASS (9) |
| adoption-policy | PASS (8) |
| multi-org | PASS (3) |
| mcp | PASS (7) standalone; one gate run hit an unexplained `lumi_request_refused` under parallel load |
| browser | PASS (fail closed) on LumiAgents `e9c1ffc2` via the gate; FAIL on `f3d31d55` (P05-CR-005) |
| non-stream (D2) | UNPROVEN: no user-reachable managed non-stream path in the app |
| automation (journey E) | no FAIL on `f3d31d55`; verdict UNPROVEN for explicit gaps (off-peak runtime, fence entropy/stale fence at HTTP, external provider BLOCKED) |
| account, revocation (revoked-state UI) | PASS |

Sensitivity (disposable worktrees): S1 tenant, S2 revocation, S3 tool denial (server resolution),
S4 budget settlement (reconcile release), S5 local preservation (query exclusion + trigger) all
DETECTED for the intended reason on the candidate pair (`test-results/sensitivity/2026-10-12T08-19-32.798Z`).

## Next commands

```sh
node scripts/integration/desktop-sensitivity.mjs        # final pair
LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs   # after the pin (clean pair)
```

Blockers: human DCO sign-off for LumiAgents#49; P05-CR-005 decision (browser policy gate); external-provider proof BLOCKED (no approved
credential/spend cap).
