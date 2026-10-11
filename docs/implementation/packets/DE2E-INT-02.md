# DE2E-INT-02 — Device lifecycle and policy in desktop main
Status: in_progress; owner: goal coordinator.
Depends: merged P03-CG p03-cg-v1 and P08-CG p08-cg-v1, client account owner.
Read F19, F26, gate/current CRs before changing behavior. No new wire contract.

## Outcome
After account sign-in, user selects an active org and explicitly enrolls this
device. Main generates Ed25519 key; approved public key only goes to server.
Private key and short-lived device token stay in OS-encrypted main custody.
Device refresh/policy/ack is wired and respects expiry/revocation; enrollment
alone never converts a workspace. Restart resumes lifecycle, no duplicate device.

## Write surface
Client lumi-account transport/owner/commands and shared safe account projection,
new main lumiDeviceVault/lumiDeviceOwner files + tests, client account spec;
General Lumi section + EN/ZH locale. Parent only tests/integration desktop probes,
this packet, integration plan and CR if a actual frozen-contract gap is found.
Existing backend changes only via dedicated repair packet after reproducer.

## State ownership
Main device owner owns one origin/org-bound enrollment/device state; encrypted
vault is its persistence adapter. Renderer sees safe ID/status/policy metadata.
Generate → persist pending identity → POST anonymous enrollment → explicit
human approval through existing session/CSRF/idempotency → server challenge →
sign in main → complete → persist returned device token → fetch/ack policy.
Do not route private key, token or signature authority through generic renderer
credential RPC. Token refresh signs actual nonce; revocation denies refresh and
execution after a positive pre-revocation control. Do not delete local files.

## Acceptance/proof
Actual Electron enrollment with Worker/D1, restart, retry/replay/expiry, org
substitution, revoked token/policy/refresh negative, policy audience/expiry,
server-stored device/key/audit readback. Local workspace stays local. Provider
login unchanged. Static/unit tests support but do not replace actual IPC/runtime.

## Resume checkpoint

2026-10-07 continuation: client recovery command remains host-owned and UI
requires explicit confirmation. Focused client typecheck PASS; full lint exits 0
with 70 pre-existing warnings. Architecture changed-module check PASS (0
violations). Parent Worker/D1 `tests/integration/lumi-account.mjs` PASS on fresh 25-migration D1:
exact returned-token hash present before expiry; expired token and anonymous
nonce refused; anonymous human-challenge mint refused; bad key proof refused;
expired/replayed challenges refused; successful rotation stored exactly one live
token and audit event; revoked policy/refresh refused; logout refused account
reads. This proves backend/client transport only; actual Electron recovery button,
workspace binding, managed inference/tool broker, scheduler, and full goal remain
unproven. Next: inspect guarded module context for per-workspace identity and
frozen P08/P05 contracts, then implement one explicit workspace binding slice.
2026-10-07: account Electron→browser→Worker→OS-vault→restart→logout PASS in
preceding packet. Begin by reading exact device route response shapes and
host-only public transport surface; pending key must be persisted before network
side effects. Current full client main/renderer type baseline still unproven.

Checkpoint 2026-10-07: exact device route/response shapes read; client transport
implemented begin/challenge/complete/policy/ack/nonce-refresh with private token
and no human cookies. Human account approve method includes CSRF/idempotency.
Real Worker/D1 probe PASS, test-results/device-client-runtime.log: positive
pre-revoke enrollment/key proof/policy/ack/refresh, revoked policy+nonce-refresh
refused and D1 device status revoked. Client root typecheck/architecture/focused
lint PASS. No main device persistence/UI yet, so restart/actual Electron device
proof not achieved. Next implement OS-encrypted pending-key/device custody,
main device owner and explicit org enrollment UI, then full lifecycle harness.
Important open question: post-expiry token recovery requires contract analysis,
because nonce currently requires a live device token. Do not relax anonymous
nonce protection or invent a duplicate reenrollment workaround.

2026-10-07 actual Electron lifecycle checkpoint: client commit 1b190c6 adds
main origin/org/user-bound encrypted Ed25519/token vault, serial owner,
renderer-safe explicit org enrollment/confirmation/resume/policy/refresh UI.
Client types and focused lint PASS, architecture 0 violations, 13 tests PASS.
Actual new desktop build PASS. Harness electron-device-e2e.log PASS exit 0:
UI starts PKCE → browser approval → enrollment/proof/policy/refresh → D1 active
org device → OS ciphertext → restart same device/no duplicate → server revoke
→ Electron sync refusal → logout removes own human session. Device key record
remains for deliberate recovery; provider credentials unaffected.
Owned app/Chrome/Worker stopped; evidence temp profile lumi-electron-account-
W9PNUL retained. Prior automatic approval review usage-limit failure did not
execute harness edits/build; resumed approved commands executed successfully.
User now explicitly authorizes documentation, both PR creation and merge after
full goal gates PASS. Do not merge partial closure or infer secret provisioning.
Still incomplete: token-expiry recovery (live token nonce contract gap), heartbeat,
enrollment interruption/replay/expired scenarios, per-runtime policy enforcement,
workspace adoption/rollback, managed inference/tools/automation, primary passkey,
provider account matrix, negative IPC runtime/fault sensitivity and full type
baseline. Next first unmet slice: expiry recovery contract decision + heartbeat,
then actual workspace/project binding through frozen P03/P08 resources.

P03-CR-002 backend implementation started in isolated parent worktree. Added
0025 migration (challenge hash/org/device/requester/expiry/consume only), repo
statements, two org-scoped session+CSRF routes, D1 batch guard/consume/token
rotation/audit and route registration. Routine authenticated nonce endpoint
unchanged. First cargo check found seconds type i64/u32 and String/&str time
comparison; exact compiler fixes applied, repair check running. Next prove
challenge/expiry/replay/role/revoke guards with real Worker/D1, including fault
sensitivity, before client recovery wiring. No PR/merge yet.
