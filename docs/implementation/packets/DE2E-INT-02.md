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
2026-10-07: account Electron→browser→Worker→OS-vault→restart→logout PASS in
preceding packet. Begin by reading exact device route response shapes and
host-only public transport surface; pending key must be persisted before network
side effects. Current full client main/renderer type baseline still unproven.
