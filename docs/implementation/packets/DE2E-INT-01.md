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
be assigned after architecture:context. Client write surface now frozen for first transport slice: packages/services/src/lumi-account/** and docs/specs/lumi-agents/04-control-plane-account.md. Host transport is never renderer RPC; no custody persistence until Electron secure owner is defined.
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

Checkpoint: client baseline fast-forwarded cleanly from fd977fd to d78e8d5
(only merged monthly guidance). Freshness and architecture services context
read; architecture before/after PASS (0 violations). New client spec defines
independent Lumi account and secure-custody boundary. Memory-only host transport
implements fixed-origin S256 start/exchange, private cookie+CSRF request, expiry
and cancel generation. Four focused tests PASS via Node24/tsx. Files formatted.
Full client typecheck/lint running in task session; logs under client test-results.
Next: inspect results, strengthen stale exchange/logout concurrency, implement
Electron secure owner + service/IPC, browser approval UI, then real HTTP proof.
Goal remains A–E, not complete; no product UI/runtime wiring claimed.
Strict typecheck found nullable first split segment in cookie parser; corrected
without relaxing types. Original failing log preserved in client test-results/
typecheck-int01.log; repair run typecheck-int01-repair.log session 16804.
Logout now captures old request and clears its own session before awaiting,
so late completion cannot erase a newer login. Focused tests still 4/4.
Client logs test-results are untracked (must never stage); lint session is live.

2026-10-07 continuation: prior typecheck repair PASS; full lint 0 errors/70
warnings. Added client main-only lumiSessionVault.ts/.test.ts to write surface
(main owner adapter, not renderer IPC). Source safeStorage documentation checked;
Linux basic_text/unknown and unavailable encryption fail closed. Vault uses
origin-separated encrypted envelope, locked atomic 0600 write, strict schema;
clear affects only own record. Six focused transport/vault tests PASS;
architecture check 0 violations. Tests inject cipher: no OS keychain/Electron
runtime claim. Main TypeScript check and focused lint running; logs under client
test-results/main-vault-typecheck.log and account-vault-lint.log.
Next: connect transport persistence through host-private port, add restart/
logout-race/corrupt-store controls, register safe account service and authorized
main-host messages, implement actual browser /desktop approval and Electron UI.
Main vault and transport currently unwired; goal A–E remains incomplete.

Checkpoint final this continuation: client commits 4cd35b3 + c669db5 (DCO),
new source/spec only, logs NOT staged. Seven focused tests PASS including
corrupt-record byte preservation; focused lint 0 warnings/errors and architecture
0 violations. Root client typecheck (host config) PASS; additional main build
FAIL contains other main-file errors. New fixture Buffer error repaired and
main-vault-typecheck-repair.log has no new transport/vault-file diagnostics.
Do not call remaining errors baseline until control build comparison is done.
Next remains secure vault-to-account persistence/IPC + actual approval UI,
then Electron runtime proof. No read/load secret channel is exposed yet.

Continuation checkpoint: transport now consumes host-private persistence port;
serialized completion/restore/logout prevents stale vault writes from granting
newer authority. Main lumiAccountOwner assembly uses safeStorage + vault after
app.ready, exported transport only through services/node. Safe account projection
filters /me to display user/org fields. Nine focused tests PASS, architecture
0 new violations, root client typecheck PASS and focused lint 0 warnings/errors.
Logs: persistence-typecheck.log, projection-typecheck.log, projection-lint.log.
New main owner is assembly code, NOT registered in app lifecycle or IPC yet.
Next first unmet criterion: authorized safe account RPC registration and actual
/desktop browser approval UI, then UI sign-in and main/host vault runtime proof.
Generated scheduler .js/.d.ts left untracked from main build; never stage them.
No production/customer operation. Goal A–E still active, no E2E completion claim.

2026-10-07 IPC/UI continuation checkpoint: owner registered lazily at app.ready,
main IPC allowlist + managed app main-frame/exact renderer URL gate, preload and
optional IPlatformService bridge. Desktop General settings account panel is
wired through usePlatform, English/Chinese locales, provider OAuth unchanged.
Write surface extended explicitly: client shared lumi-account/index/platform,
client globals.d.ts, desktop main index/commands/ipc, preload index, renderer
platform, UI SettingsPage/account section/locales and existing client account spec.
Root client typecheck PASS after fixing unsupported intl defaultMessage (old log
account-ui-types.log preserved; repair account-ui-types-repair.log). Architecture
0 violations; focused lint 0 errors. Twelve account tests PASS. Renderer/main
full subproject checks still fail on declarations/CSS and other code; no broad
Electron build or visual proof claimed. Main-frame navigation URL gate added.
Real parent Worker/D1 transport probe PASS (account-worker-probe.log): actual
PKCE start, fixture approval, cookie exchange/account, consumed flow refusal,
logout refusal. Fixture uses development auth; not production primary auth/UI.
Next: build/render browser approval and Electron settings, prove production auth
path/custody, resolve full main/renderer build with baseline controls; then device
lifecycle/policy/adoption and managed runtime/scheduler (remaining A–E).

Runtime checkpoint: client UI intl repaired to real lookup-only contract;
root client typecheck PASS. Actual desktop production bundle pipeline PASS
(main/host/preload/renderer); errors from standalone renderer TypeScript still
need baseline comparison, not hidden by bundle success. Electron pinned binary
installer completed, no user profile touched. Native node-pty build session
and agent-runtime-build session are now running (client test-results logs).
Next: inspect live build handles/results, launch actual app with isolated home/
userData/sessionData and runtime, screenshot account Settings, exercise IPC +
real browser approval and secure persistence. Preserve original A–E goal.

Electron runtime checkpoint: pinned binary + agent runtime + node-pty prepared.
Actual app launched in test-results/electron-profile/{home,userData,session};
main/host/renderer all worked. UI Cancel provider flow → Use API key → Skip for
now → Exit onboarding reached local workspace, no injected login state. Settings
→ General rendered real Lumi section; screenshot account-settings.png visually
inspected. Provider login remained visible. Native app was stopped (owned PID
47925 TERM); no ongoing Electron process expected, recheck before new launch.
First node-pty setup ENOENT preserved; rerun with local .bin passed.
Renderer UI/IPC startup proof achieved, NOT Lumi successful sign-in/keychain
proof. Production main/host/preload/renderer build PASS. Browser password
approval proof PASS separately. Next assemble one harness with local Worker,
isolated actual Electron + isolated Chrome, perform Lumi sign-in/persist/restart/
logout, then enrollment/policy/adoption/runtime/scheduler still required.
Browser-opening now explicit button (begin returns URL); 12 focused tests,
architecture and client root typecheck PASS. Current app screenshot predates
that small UI change; rebuild before reusing runtime evidence.

Actual auth closure runtime: desktop-account-electron.mjs + CDP attachPage
connects real app renderer (not a replacement page). New build used. UI creates
PKCE, isolated Chrome password login approves, UI completes with account visible;
OS-encrypted main vault created; app restart restored account; logout deleted
own vault record. PASS exit 0, log test-results/electron-account-e2e.log.
Screenshot visually inspected at temp profile lumi-electron-account-LiDm5y/
evidence/authenticated.png. Both app processes and Chrome/Worker stopped.
This is password auth path only; primary passkey + provider both-account matrix
still owed, along with invalid-sender runtime and full type baseline.
Next DE2E-INT-02 device lifecycle/policy; never shrink full A–E completion.

## Recovery CI diagnostic follow-up — 2026-10-09

Coordinator-owned extension of the account/device recovery packet. Exact base
4f730a52c6ad8b0abde8f204f473315cf399d796; P03/P08 contract behavior unchanged.
Write surface: request-boundary recorder/test, existing smoke-harness hooks,
lumi-account integration exception diagnostics, test script and integration
workflow report publication/explicit diagnostic input, CI handoff. No product
route, auth, migration, submodule SHA or production deploy configuration changes.

Two adoption CI failures lacked Worker liveness evidence before cleanup. This
follow-up records bounded path-only request status/socket counters, process/session
availability, redacted console and one read-only fresh-connection health request.
It rethrows the original error and performs no mutating retry. Default behavior
preserves socket reuse; fresh_sockets is opt-in diagnostic A/B only. Root cause
remains UNPROVEN until real diagnostic evidence discriminates hypotheses.

Independent Node24 bounded test suite PASS8/8; redaction/query canaries and
unavailable-ps control pass. Scoped format and diff-check PASS. Full quality
passed format/web lint/types/unit/schema/canary/recorder/guard then clippy failed
ENOSPC. Original FAIL preserved outside Git. Only owned review-clone target
artifacts moved to SSD; Rust checks rerunning with explicit CARGO_TARGET_DIR.
Rust repair clippy/WASM finished PASS. Together the unchanged candidate has completed the required quality gates; the interrupted run remains preserved as FAIL. Worker diagnostic failure
path and hosted exact-head run remain UNPROVEN; no deploy/merge performed.

Handoff: docs/verification/ci-socket-handoff.md. Reviewer focus: bounded privacy
redaction, original error preservation and diagnostics before Worker cleanup.
Rollback: revert recorder hooks/workflow input/test-script changes; no schema or
resource change. Client compatibility: pinned client unchanged.
