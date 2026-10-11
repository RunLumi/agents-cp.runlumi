# /goal - Claude Code complete desktop/backend E2E

Coordinate RunLumi/agents-cp.runlumi and RunLumi/LumiAgents. Read docs/prompts/goal-desktop-backend-e2e.md fully; every A-E requirement/exit gate binds. Continue this goal, not P00-P09 or only automation.

Follow both AGENTS.md, specs, ADRs, contracts and packet ownership. PRs/merges are authorized after exact-head gates; do not ask again. Deployment/provisioning, custody, provider spend, store submission and customer data need separate authorization. Verify identity/DCO; never invent attestation. Read the release runbook: main deploys automatically.

Root: git rev-parse --show-toplevel; use portable paths/pinned tools. Inspect remotes, ancestry, git-common-dir, branches, index/worktrees, processes and gitlink. Back up WIP; never reset/clean dirty source. Run git submodule update --init --recursive for integrations/lumi-agents. Separate histories/lockfiles/package managers; no floating or unpublished pins.

2026-10-11 baseline; reverify remotes: parent #59/#60 and child #48 merged. #60 fixes filtered installs. Module/account/device proof passed; Electron A-E is incomplete. WIP is published; reverify old PASS/artifacts.

Read prompt README, Plan00/STATUS/Plan08, DE2E plans/packets, specs/gates/CRs, verification guides/runtime-proofs, integration guide and remaining-goal-gates.md. Read child architecture/design/upstream rules and UI references. Derive a claim matrix; trace renderer -> IPC/host -> client -> Worker -> storage/provider/tool. Backend owns authority; host owns credentials. Reuse owners/ports.

Fresh entry: Lumi Agents login, API-key setup, Continue locally; temporarily hide Z.ai/BigModel OAuth buttons. Keep ZCode/provider OAuth in Model Provider settings, BYOK, sessions and offline work. Login/org switch never adopts workspaces or retains foreign authority. No renderer secrets/history sync.

Close every A-E claim via real paths:
A: local/offline startup, real auth/callback, org choice, expiry/logout/cancel and secure custody.
B: proof-of-possession enrollment/approval/resume, refresh/heartbeat/compatibility, expiry/replay/wrong-proof refusal and revocation after restart.
C: explicit one-workspace/project adoption, second workspace local, server-owned stages/versions, scoped policy/credential consent; rollback with storage/session readback.
D: stream/non-stream inference, cancel/disconnect/fault/timeout, retries/budget settlement; tool allow/deny/exact approval, browser/computer/MCP enforcement and tenant-scoped web usage/audit.
E: automation preview/cancel no-write, explicit adoption, scheduler claim/fence/start/renew/settle, two-client race, restart/expiry/stale fence, entitlement/revocation/off-peak/ambiguity; preserve originals and existing-state/remote compatibility.

Use 2-3 agents/disjoint packets if supported; otherwise work sequentially. Coordinator owns contracts/checkpoints. Review independently; preserve newer verified work. Use CRs for frozen changes; never edit applied migrations.

Deliver one clean-checkout command: install/build exact pair, fresh Worker/D1, actual Electron main/renderer/agent, UI journeys, stored effects, owned cleanup. Synthetic isolated profiles only. Controls and valid faults must prove tenancy, revocation, tool denial, budget settlement and local preservation; build failure is not fault detection.

Record PASS/FAIL/UNPROVEN/BLOCKED/NOT_APPLICABLE with full paired SHAs, clean state, versions, commands and redacted evidence. Preserve failures; repair, restore/rebuild, rerun. External-provider proof is BLOCKED without approved credentials/spend cap. Run required checks and UI/performance gates. Land server before client; verify hosted CI, merge, pin merged child, rerun/read back remote SHAs. Document compatibility/rollback; update checkpoints before interruption. Finish controllable work; critical missing proof forbids complete E2E. Final: PRs, SHAs, command, claim matrix, limits; split local, CI, merged, deployed and release proof.
