# DE2E-FE-01 — Browser desktop-login approval
Status: in_progress. Owner: goal coordinator. Depends: merged P02-CG v2.
Read F01, P02/P03 identity distinctions, DESIGN.md. Screen reference visually
inspected: docs/screens/lumi_account.webp; adapt its account/security hierarchy
into a focused approval page, no unrelated account dashboard redesign.
Write surface: apps/web/src/app.tsx, features/auth/desktop-approval.tsx,
lib/api.ts (one auth helper), meaningful auth tests/browser probe additions,
this packet/checkpoint. No device enrollment or API-contract changes.
Acceptance: /desktop retains user_code across primary login, explicit confirmation,
never auto-approves, CSRF existing API client, cancel/error/busy/success states,
keyboard/narrow browser verification; real auth + device exchange later QA.

Checkpoint: /desktop branches only after current primary AuthScreen completes;
code retained in URL, explicit submit approval, current cookie/CSRF client,
204 success/error/busy/cancel/account-switch. Parent typecheck PASS; API tests
13/13 including approval POST DTO/CSRF/204. Real Worker transport probe PASS with
fixture browser approval; actual approval-page browser rendering/interaction is
still UNPROVEN. Parent tests/integration/lumi-account.mjs added to write surface.
Relevant screenshot inspected visually; no Electron/browser screenshots yet.

Browser runtime checkpoint: desktop-approval-browser.mjs launches real Chrome,
Vite and local Worker/D1. Synthetic password account fixture is pre-verified;
UI performs actual password login (no injected session cookies), preserves code,
D1 pending positive control proves no auto-approval, Enter keyboard approves,
then real transport exchanges cookies and reads own account. All PASS.
390x844 screenshots visually inspected; readable/no horizontal overflow.
Evidence test-results/desktop-approval-browser.log and screenshot directory.
This proves password path, not passkey path or OS-keychain/Electron custody.
