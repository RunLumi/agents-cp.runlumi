# Remaining full-goal gates

This is a closure checklist, not completion certification. The full objective is
`docs/prompts/goal-desktop-backend-e2e.md`; partial evidence in README and reports
does not remove requirements below. Claude implements; Codex reviews feedback and
independently verifies. Current work is dirty and based on parent e7ad897/client
2a49525; phase-head CI and later dirty-runtime evidence are different claims.

| Requirement family | Current full-family verdict | Evidence still required |
|---|---|---|
| A: account and existing local state | UNPROVEN | Exact candidate matrix neither/ZCode-only/Lumi-only/both, old BYOK state, offline existing session, cancel/failure/expiry, org-switch authority; preserve underlying provider credentials with Lumi-first entry |
| B: device lifecycle | UNPROVEN | Exact current runtime interruption/retry, expiry/replay/wrong proof/denial, short-lived exchange and recovery, minimum version; revoked restart and independent hostile stored-state controls |
| C: workspace adoption | UNPROVEN | Every reachable ladder rollback, policy expiry/schema/min-version enforcement at runtime, local session/secret usability, explicit credential choices and consent, tenant/non-disclosure controls |
| D: inference and tools | UNPROVEN | Streaming/nonstreaming cancellation, disconnect, before/after-output faults, timeout/settlement/retry counts; browser/computer/MCP runtime seams or evidenced NOT_APPLICABLE; web run/usage/audit correlation |
| E: automation | UNPROVEN | Real queue serialization/dispatch, due/claim/start/run/renew/settle, actual output/side effect, two eligible clients demonstrably contend, stale fence/restart/expiry/revocation/entitlement/off-peak, interrupted migration and rollback |
| Local preservation and compatibility | UNPROVEN | Supported desktop release with additive backend, candidate pair, old SQLite/downgrade/remote/MCP/multiple-workspace state; exact profiles and retained originals after recovery |
| External provider | BLOCKED | Approved test credential and spend cap if available; local controlled mock evidence never substitutes for this |
| Sensitivity obligations | UNPROVEN | Real valid faults for tenant scope, revocation, tool deny, budget settlement and local-state preservation; positive controls and restored exact source/artifacts |
| UI/performance | UNPROVEN | Current rebuilt desktop+narrow/focus/accessibility/reduced-motion/async states, startup/navigation/refresh/IPC measurements and bundle impact |
| Reproducible delivery | UNPROVEN | Clean checkout one-command exact pair install/build/Electron/Agent/Worker, owned cleanup/redacted diagnostics, platform/keychain/display prerequisites |
| Quality | UNPROVEN | Both exact candidate heads' required format/lint/types/unit/build/architecture/provenance, standalone Main errors resolved/understood, WASM/dry-run; hosted checks on final heads |
| Git/PR/recovery documentation | UNPROVEN | Phase-scoped parent+child commits/PRs with DCO/template handoffs, accepted contract changes, recovery/compatibility/operator docs, dependency-ordered authorized merges and remote main readback, final tested merged-client gitlink PR |

Phase 1 drafts: parent [#51](https://github.com/RunLumi/agents-cp.runlumi/pull/51)
and child [#39](https://github.com/RunLumi/LumiAgents/pull/39). The delivery ledger
is in `docs/implementation/desktop-e2e/plan.md`. They freeze earlier committed
boundaries, not current pending implementation. No deployment or full A–E verdict
follows from those PR checks. Do not mark the goal complete until each explicit
objective obligation has exact current evidence, not merely this family table.
