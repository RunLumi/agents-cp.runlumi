# DE2E-INT-01 — Host-owned Lumi account alongside provider login

Status: in_progress. Owner: current goal coordinator. Repo: LumiAgents, plus
control-plane integration plan/contract trace only. Depends: merged P02-CG v2,
P08-CG v1. No product contract change approved.

## Outcome / scope
Actual desktop host account service uses device-code S256 login and stores Lumi
session/CSRF in its own secure credential namespace. Existing ZCode/provider
OAuth owner and active-provider behavior remain intact. Safe account projection
crosses IPC; optional org selection cannot adopt workspaces implicitly.

## Write surface
Control plane: docs/implementation/desktop-e2e/**, this packet and goal prompt.
Client: new local integration spec and exact host/shared/service test paths to
be assigned after architecture:context. No client code until ownership is frozen.
No renderer token persistence, generic bearer adapter or rewrite of provider OAuth.

## Acceptance
- ZCode-only/Lumi-only/both/neither account states are independent.
- S256 challenge/verifier, bounded poll/expiry/cancel/stale-result ownership.
- Session/CSRF exchange parsed from actual response; no raw credentials exposed.
- Secure restart restore; logout clears only its own namespace.
- Host transport HTTP controls and client architecture/type/lint checks.
- Actual auth UI/Electron evidence follows FE01/QA01, never credited by unit tests.

## Resume checkpoint
2026-10-07: goal invoked, full A–E outcome active. Parent worktree
/Users/james/.codex/worktrees/desktop-e2e/agents-cp.runlumi, branch
codex/desktop-backend-e2e, base a6de5e0. Client submodule clean at fd977fd;
no previous test counts treated as proof of desktop wiring. Goal copied from
user's untracked docs into isolated worktree; ZCode-login preservation explicit.
Read device_auth.rs: exchange issues cookies, verification_uri /desktop.
Read IOAuthService: existing provider ownership must remain independent.
Next: client freshness/architecture contexts, secure storage and frontend
approval route trace; freeze client spec/paths then implement INT01.
No test processes started; no production operation or PR created for this goal.

Source-trace update: apps/web/src search finds no device-code/user_code approval
consumer; backend verification_uri /desktop is not yet shown to have a working
approval UI. Existing ICredentialService.load(key) is renderer-reachable through
RPC, so storing Lumi secrets via a generic namespaced key alone is insufficient.
Inspect its cipher/repository owner and exposure policy; implement a host-private
credential boundary rather than assuming namespace means secrecy. Both gaps
remain UNPROVEN pending complete trace/runtime reproducer.
