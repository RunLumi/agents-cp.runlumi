# Journeys A–D: remaining proof obligations (2026-10-09)

Derived from `docs/prompts/goal-desktop-backend-e2e.md` (Lumi-first decision of
2026-10-08), client specs 04/05/06, `docs/verification/runtime-proofs.md` and
`proof-obligations.md`. Read-only pass: nothing was built or run, no personal
store was read. Handoff PASS claims and test counts were not inherited; every
verdict below comes from source or artifact text read in this pass.

Vocabulary: PASS / FAIL / UNPROVEN / BLOCKED / NOT_APPLICABLE only.
Closure: RERUN (existing verifier, fresh run), NEW-TEST, IMPL (product change first),
BLOCKED (external dependency).

## 0. Identity, scope and standing caveats

- Parent full base `e7ad897a7f400048df17100594ef86b3788ea0f1` (read this session via
  `git rev-parse HEAD`). Working tree is dirty: 40+ modified/staged paths at session
  start (api devices/inference/budget/migration/tools/automations routes and
  repositories, staged migration 0025, desktop-e2e plan/gates/packets/specs).
- Client full base `2a495254f0018644d24c9c1e5c5210bb7a30075c`, taken from the campaign
  reports. I could not re-read the client HEAD or its dirty state here (git on the
  submodule gitdir is approval-gated and outside the allowed read root), so the
  client's current identity is **UNPROVEN**. Both reports mark client and parent dirty.
  The dirty source is bound only by `evidence/*source-manifest*.json`; I did not
  re-hash it.
- **G1 Isolation (invalidates the old claim).** All Electron reports
  (`evidence/run-scoped-tools-report.json` 2026-10-08 17:06,
  `lumi-restored-tools-report.json` 17:10) predate
  `tests/integration/lib/lumi-child-env.mjs` (2026-10-09 07:42:27) and the harness edit
  (07:42:46). The new file's own header says the Agent resolves its session store from
  `HOME`, so earlier runs used the operator's HOME for the Agent store. Full
  isolation is UNPROVEN for every Electron-derived row; no such row below is credited
  PASS. Rows marked "observed 2026-10-08" are historical observations only. The
  post-fix harness has not run. macOS Keychain is still not isolated by the
  `HOME`/XDG overrides (safeStorage uses the app-name keychain item); that needs
  its own check before "no personal state" is claimed.
- **G2 Report shape.** The reports carry verdict, two SHAs, two dirty booleans,
  assertion labels and retries. The goal also requires protocol/schema versions,
  platform/app build, command, fixtures, controls and evidence paths. The Worker log
  says "28 migration rows" while the README says 26 and the recovery candidate 25, so
  no artifact pins the migration list. UNPROVEN until the manifest is added.
- **G3 Fixture shortcuts.** Synthetic accounts are verified with the development
  email code (`desktop-account-electron.mjs:211-221`). That is acceptable as seeding
  only. Desktop sign-in itself is browser password plus PKCE.
- **G4 Provider.** Every managed turn uses a development `mock://` provider. This
  proves Worker routing and stored effects, not a provider response. The controllable
  HTTP provider is BLOCKED (`evidence/provider-probe-corrected.log`: zero requests at
  all four address classes).
- **G5 Stale backend probes.** `docs/verification/runs/2026-09-31-v01-*` (revoked
  device, device idempotency, path-id tenancy, usage attribution, inference failure)
  and the `p03-smoke` / `p05-smoke` scripts have no retained log at the current
  head. They predate migrations 0025–0027 and the edits to
  `routes/devices.rs` and `routes/inference.rs`. Per `proof-obligations.md` expiry,
  they are not credited. Rerunning them is the cheapest RERUN closure.
- **G6 Observability.** `harness probe.d1Rows` reads D1 (good). Desktop→Worker traffic
  is never captured, so wire-level claims (what bounded metadata is sent, no
  telemetry) have no instrument today.

Family verdicts: **A UNPROVEN, B UNPROVEN, C UNPROVEN (contains one FAIL item), D UNPROVEN.**
No family headline PASS is permitted.

### Coordinator decisions after review

- Current-candidate backend `p02-passkey-smoke.mjs` rerun completed91/91 checks
  on fresh local D1/real Worker; log `evidence/passkey-current-candidate-runtime.log`.
  This is signed assertion/attestation server admission and hostile/recovery
  proof, not CTAP2 browser UI or Electron primary-passkey approval. Keep A10's
  desktop path UNPROVEN until its actual browser/desktop journey runs.
- F01 explicitly defines passkey as the primary path and password as fallback;
  this is not an open preference question. Desktop browser approval must gain a
  passkey journey; password evidence remains fallback evidence.
- The goal's organization creation/select UI obligation may use the real web
  control plane for creation and desktop for selection. API fixture creation
  alone does not prove that UI journey or organization switching.
- Development-only controlled stream faults are within the authorized local
  integration scope, subject to existing provider/egress rules and spec-first
  implementation. No production policy relaxation or external spend is inferred.
- No inspection, migration or deletion of personal Agent-store data is
  authorized. Previous HOME-related results cannot certify isolation; new
  profile-confined runtime proof is required. Native OS keychain access remains
  the approved encryption boundary and must not be replaced with plaintext.
- C6a remains a required implementation obligation. Reuse the frozen credential
  choices and document any changed client contract deliberately; the goal does
  not authorize hidden credential export or removal of the requirement.

## A. Local-first startup, account, organization

**A1 Lumi-first startup; z.ai/BigModel OAuth hidden; explicit local continuation.**
UNPROVEN (RERUN + NEW-TEST).
- Evidence: `desktop-account-electron.mjs:147-177` asserts "Welcome to Lumi Agents",
  no button matching `/sign in.*(z.ai|bigmodel)|log in.*(…)/i`, 320 px with no
  horizontal overflow, real Tab focus with `:focus-visible` and non-`none` box-shadow,
  then "Continue locally". Source: `WelcomeScreen.tsx:292-323`. Observed 2026-10-08.
- Gap: the regex matches button text only, and only on the startup screen. The
  decision also covers "general account entry" and the session-expired entry reason.
  README itself says ring prominence failed visual review and the repair is
  unrebuilt. G1 applies.
- Missing: after the isolated rerun, enumerate all buttons/links on startup, Settings →
  General and the session-expired entry, and assert against an explicit allow-list
  (Lumi sign-in, Use API key, Continue locally). Capture the focus ring after the
  repair and compare computed ring width against a threshold.

**A2 Restored session does not reopen entry; signed-out startup.** UNPROVEN (RERUN).
- Evidence: `start({expectRestoredAccount:true})` throws if "Continue locally"
  appears (`:149-150`, used at `:995`, `:1122`); reducer test
  `lumiAccountFlow.test.ts` "restore with a session lands signed-in". Observed
  2026-10-08. G1 applies.

**A3 Failed / cancelled / expired sign-in.** UNPROVEN (NEW-TEST).
- Evidence: reducer tests only (`lumiAccountFlow.test.ts`: cancel, error code,
  stale result). Adapter-level reuse and "cannot reuse completed flow" in
  `lumi-account.mjs:81`. No Electron run exercises any failure path.
- Missing: Electron probe: begin → Cancel in the app → assert no vault file and the
  device-code row not approved; begin → force `expires_at` in D1 → "I approved" → UI
  shows the stable error code and Retry, no vault; third attempt succeeds (positive
  control).

**A4 Session expiry and sign-out.** UNPROVEN (NEW-TEST).
- Evidence: logout removes the vault file (`:1148-1155`, UI text "Sign in to Lumi");
  adapter `signOut()` then `readAccount` 401 (`lumi-account.mjs:441-442`).
- Gap: Electron never asserts the server session is revoked. Expiry is never driven.
- Missing: force-expire the human session row; trigger the next account read; assert
  signed-out UI, cleared vault, retained device record, and unchanged provider
  credential store (hash before/after).

**A5 Provider isolation matrix (ZCode-only / Lumi-only / both / neither).**
UNPROVEN (NEW-TEST). Highest-value A gap.
- Evidence: reducer test "logout clears the Lumi projection only"; spec 04 prose.
  The Electron harness (read in full, 1193 lines) never seeds or asserts any provider
  credential, active provider or BYOK key.
- Missing: four owned synthetic profiles. Seed a synthetic ZCode credential record and
  a BYOK key (no real provider tokens). In each, run Lumi login, enroll, logout and
  revoke. Assert the credential-store bytes and active-provider setting are unchanged.
  Assert, via the wire capture in G6, that no request to the Worker carries a ZCode
  credential or the provider key. Positive control: the Lumi-only profile shows
  zero provider-credential records and the Lumi session still works.

**A6 Local/BYOK preserved; second workspace stays local.** UNPROVEN (NEW-TEST).
- Evidence: only `local-only.txt` bytes unchanged (`:42-44`, `:580`, `:1015`).
  Spec 05 acceptance requires "run a second workspace locally"; no such step exists.
- Missing: open a second workspace and complete a local BYOK turn (a loopback HTTP
  provider is fine on the desktop side) before bind, while bound and after rollback.
  Assert D1 gains zero `inference_requests` for it and its UI shows local ownership.

**A7 Existing workspace/session opens with no account and no network.**
UNPROVEN (NEW-TEST).
- Evidence: none for A. `desktop-automation-local-preservation.mjs` covers only
  automations (journey E).
- Missing: seed a pre-org session history (reuse the `seed-local-automations.mts`
  approach), point `LUMI_CONTROL_PLANE_ORIGIN` at a closed port, open it, assert the
  messages read back from client SQLite.

**A8 Org select/create; switching never adopts or retains another org's authority.**
UNPROVEN (NEW-TEST).
- Evidence: one org per run. A selector exists (`LumiWorkspaceSection.tsx:160`).
  I found no desktop org-creation UI; the fixture creates orgs through the API.
- Missing: two-org user. Select org A, bind and run; switch to org B. Assert no
  adoption, device or binding authority is reused (D1 `devices` per org, managed run
  with org-A context refused while B is selected). Decision for the supervisor:
  whether "create" via desktop UI is required or the web control plane suffices.

**A9 Secret custody (no token in renderer persistence, logs, URLs, reports).**
UNPROVEN (NEW-TEST).
- Evidence: vault file has `ciphertext` and lacks the string `lumi_session`
  (`:1112-1120`); workspace vault has no path (`:1104-1111`); raw prompt absent from
  app log (`:1156-1160`).
- Gap: the app log is written already redacted (`:1167`), and registered secrets
  are never searched for. Renderer storage is never dumped.
- Missing: after the journey, grep the whole owned profile tree (excluding the
  ciphertext vault) and the redacted/raw logs for every registered secret (cookie
  value, device token, org credential), and dump renderer localStorage/IndexedDB via CDP.

**A10 Primary supported auth path.** UNPROVEN (NEW-TEST).
- Evidence: Electron approval uses browser password sign-in. The runtime-proof
  catalog calls the web journey passkey-first (`smoke:browser`, CTAP2 authenticator).
  I did not confirm which path the product designates as primary.
- Missing: confirm the designation; if passkey is primary, drive `/desktop` approval
  with the existing CDP virtual authenticator.

## B. Device enrollment and lifecycle

**B1 Key in host owner, proof of possession, explicit confirmation, membership
check.** UNPROVEN (RERUN + NEW-TEST).
- Evidence: Electron "Confirm and enroll this device" then D1 `devices` row with the
  right org and `active` (`:476-490`). Adapter proves ed25519 challenge/complete
  (`lumi-account.mjs:98-114`). Vault encryption unit-tested with injected crypto
  (`lumiDeviceVault.test.ts`). Observed 2026-10-08.
- Missing: removed-member enrollment refused (stored state: no `devices` row, no
  token); private key never present in renderer or plaintext on disk.

**B2 Approval, polling, challenge/completion, token exchange, refresh, heartbeat,
version compatibility through real transport.** UNPROVEN (NEW-TEST).
- Evidence: "Refresh device token" click and the absence of the text "Device
  action failed" (`:491-503`). That is a UI-text check with no stored-state readback.
  Heartbeat has unit coverage only (`deviceHeartbeat.test.ts`).
- Missing: D1 readback that `device_tokens` rotates to exactly one live token per
  refresh; heartbeat row/capabilities after enrollment. Version: set the org
  `min_client_version` above the app version (`PUT /orgs/{id}/device-policy`); assert
  enrollment, refresh and policy are refused (backend `routes/devices.rs:1005,1193,1347`)
  and recover when lowered.

**B3 Interrupted / retried / resumed enrollment, no duplicate device or secret.**
UNPROVEN (NEW-TEST).
- Evidence: restart after a *completed* enrollment keeps one device
  (`:1126-1131`). Pending-identity persistence is unit-tested only.
  `verify:device-idempotency` has no current-head log (G5).
- Missing: SIGKILL the app (a) after begin, (b) after approval, (c) after token
  receipt but before persist; restart; assert one `device_enrollments` lineage, one
  `devices` row, one key fingerprint, one live token.

**B4 Expiry, replay, wrong proof, cancelled/denied enrollment.** UNPROVEN
(RERUN + NEW-TEST).
- Evidence: adapter recovery cases only: zero-signature → 403, expired challenge →
  409, replay → 409 (`lumi-account.mjs:183-248`). The three
  `probe.expect("…", true)` lines (`:199`, `:228`, `:248`) are vacuous. They assert
  nothing; only the `assert.rejects` status checks carry weight, with no stored-state
  readback.
- Gap: no enrollment-stage hostile run at the current head (G5); none through Electron.
- Missing: RERUN `p03-smoke`, `verify:revoked-device` (denied enrollment D1–D3) and
  `verify:device-idempotency` at the current head. Replace the three vacuous expects
  with readbacks (challenge `consumed_at` still null after wrong proof; token set
  unchanged). Electron: web-side deny → desktop shows denial, no vault device record.

**B5 Revocation: running desktop loses policy refresh, token minting and new managed
execution; restart cannot restore.** UNPROVEN (NEW-TEST). Highest-value B gap.
- Evidence: Electron revokes via API (204) then "Sync policy" shows "Device action
  failed" (`:1132-1146`). Adapter: policy and refresh refused 401/403 and D1 status
  `revoked` (`lumi-account.mjs:420-440`).
- Gap: Electron revocation is not read back from D1; the UI text accepts any error;
  no managed run is attempted afterward; the restart comes *before* the revoke, so
  "restart cannot restore" has no test.
- Missing: after revoke, (1) attempt a managed turn in the UI and assert refusal
  before dispatch (no new `inference_requests`/reservation rows), (2) D1
  `devices.status='revoked'` and zero live tokens, (3) restart: record kept but sync,
  refresh and managed turn still refused, no silent re-enroll, local turn still
  works, (4) revoke during a pending approval or running stream: run settles
  cancelled and the tool handler never runs.

**B6 Expired-token recovery (P03-CR-002).** UNPROVEN (NEW-TEST).
- Evidence: adapter only, with human-authorized challenge, anonymous nonce closed,
  rotation, one audit row (`lumi-account.mjs:154-273`). Main command test
  (`lumiAccountCommands.test.ts:90`). Migration 0025 is staged, not committed.
- Missing: Electron: expire the token in D1; UI shows paused managed state; managed
  turn refused; explicit recover click; D1 shows challenge consumed, one live token,
  `device.token_recovered.v1` count 1; a different key fails.

## C. Workspace adoption, policy, credentials

**C1 One workspace/org/project; exact bounded metadata shown; ladder one step at a
time.** UNPROVEN (RERUN + NEW-TEST).
- Evidence: project select, bind, then each ladder button; D1 one `workspace_bindings`
  row, 64-hex `workspace_identity` not containing the path, `display_name`,
  `workspace_adoption_states` stage and ownership (`:504-580`). Observed 2026-10-08.
- Gap: the preview text is never compared with what is actually sent; only stored
  columns are read.
- Missing: loopback recording proxy in front of the Worker (harness already fronts
  the web with Vite); assert request bodies equal the previewed metadata and contain
  no path, content or secret.

**C2 Ownership and credential mode consistent in desktop and web.** UNPROVEN
(NEW-TEST). The browser is used only for the approval page. I did not inspect the
web routes for an adoption/ownership surface. Missing: headless Chrome as the org
owner reading the same adoption state; if the web shows none, that is a spec decision.

**C3 Resumable state across restarts without changing server versions.**
UNPROVEN (NEW-TEST). Evidence: after restart only `adoptionRows.length === 1`
(`:1001-1007`). Missing: record `version` and `stage` before/after restart, and
restart at each intermediate stage, not only the final one.

**C4 Policy snapshot fetch, validate, acknowledge.** UNPROVEN (NEW-TEST).
- Evidence: "Apply managed policy" click. The ordering "policy-ack" is asserted on
  fakes only (`lumiWorkspaceOwner.test.ts:240`). No Electron D1 readback of the
  acknowledgement.
- Missing: D1 ack for the current policy version after Apply; republish policy; a
  managed turn before re-sync is refused (`lumi_managed_policy_stale`), then accepted
  after sync.

**C5 Expiry, minimum client version, schema compatibility, stale policy enforced at
the runtime seam.** UNPROVEN (NEW-TEST). Highest-value C gap.
- Seam: `lumiAccountOwner.ts:204-242` `authorizeManagedRequest` (every physical
  request) → `lumiWorkspaceAuthorization.ts:11-47` (stage, ownership, binding,
  device, org, key, `expiresAt <= now`) and the snapshot id/version comparison.
- Evidence: `lumiWorkspaceOwner.test.ts` covers only the positive path. No test
  exercises `lumi_managed_policy_stale` or `lumi_managed_workspace_refused` (the only
  other hit is a stub in the automation runtime test).
- Client minimum version: `deviceHeartbeatPolicy.ts:92` parses `minClientVersion` and
  nothing consumes it. Server enforcement exists at `routes/devices.rs:1005,1193,1347`,
  and whether the P05 start path re-checks it is UNPROVEN.
- Spec 05 acceptance explicitly requires mutating project, workspace key, org,
  device, policy version and authorization state, each refusing before dispatch. No
  retained run does this.
- Missing: one Electron probe, one mutation per row (each with an in-session
  positive control run first): expire the policy in D1; republish a new version;
  revoke the device; remove membership; change the project; clear the mapping vault
  entry; raise `min_client_version`. Assert a stable refusal code in the UI and zero
  new `inference_requests`/reservations/provider dispatch (D1 counts; `mock://` has
  no request counter and the HTTP provider is BLOCKED).

**C6a Offer the frozen credential choices (local / metadata-only / org-managed).**
**FAIL** by source inspection of the current dirty tree (no runtime).
- `adoptionTransport.ts:263,302` hardcode `credential_mode: "local_credential"`; no
  `packages/ui` file references the other modes. The harness sets org policy
  `credential_mode: "organization_only"` through the API instead.
- Missing: IMPL after a spec/CR decision (the P08 modes are frozen): UI choice with
  consent and destination text, then a Electron test per mode.

**C6b Org provider secret never reaches the desktop; metadata-only sends no secret.**
UNPROVEN (NEW-TEST). The org mock credential is registered only for redaction
(`:283-284`); nothing searches profile or logs for it. Covered by the A9 profile
sweep plus the wire capture.

**C7 Roll back/unbind through the UI at each reachable stage; local state read
back.** UNPROVEN (NEW-TEST).
- Evidence: rollback from managed stage and a second unbind at stage 0
  (`:1009-1036`, `:1094`); D1 binding `removed_at`, adoption stage
  `local_unmanaged`, history run retained; sentinel bytes unchanged. Observed
  2026-10-08. Ordering `p03-delete → p08-rollback` is unit-tested only.
- Gap: stages `account_optional`, `device_enrolled`, `workspace_bound` are never
  rolled back; "reopening the session" and credential usability are never read; no
  interrupted rollback.
- Missing: loop over every stage with D1 `reversion_count` and binding readback plus a
  client-SQLite read of a seeded session; SIGKILL between P03 delete and P08 rollback,
  restart, assert the UI stays local-only and reconciles.

**C8 History sync disabled; no bulk upload or hidden telemetry.** UNPROVEN
(NEW-TEST). Evidence: prompt absent from six D1 tables (`:686-719`),
`verify:adoption-privacy` has no current-head log (G5). Missing: the G6 wire capture
for the whole journey: route/method allow-list, sentinel scan of bodies (path,
file content, prompt, local secret), zero stage-5 requests.

**C9 Cross-tenant negatives on Electron-created resources.** UNPROVEN (NEW-TEST).
- Evidence: removed binding cannot create a session: 404 with reason
  `workspace_binding_not_found`, session count unchanged (`:1044-1070`); the
  positive control is the earlier successful run. Observed 2026-10-08.
- Missing: a second org's owner attacks the binding, adoption, run and device IDs the
  journey created; compare against an unknown-ID answer (non-disclosure) and read the
  rows back unchanged. The own-org read is the positive control.

## D. Managed inference, tools, usage, audit

**D1 Real request through the bound workspace; context propagated; client IDs never
authority.** UNPROVEN (RERUN + NEW-TEST).
- Evidence: run row (state, alias, device, project), `inference_requests` (org, project,
  run, session, agent session, device, `completed`), `usage_events` (org, project,
  device) (`:644-683`); `execution-claim-worker-runtime.log:115` "chat P05 device
  substitution denied — 403 resource_scope_mismatch". Observed 2026-10-08.
- Gap: `principal_user_id` is selected (`:655`) but never asserted; policy snapshot
  id/version on the run is not asserted.
- Missing: assert principal and policy id/version. Replay the desktop's own bearer
  (via the proxy) with swapped run/org/device headers; expect refusal and unchanged
  rows.

**D2 Streaming and non-streaming.** UNPROVEN (NEW-TEST). Evidence is a streamed turn
only. I did not locate where the Agent adapter chooses stream vs non-stream, so
NOT_APPLICABLE cannot be claimed. Missing: locate the seam; run a non-streaming
managed turn if one exists, otherwise cite the code as NOT_APPLICABLE.

**D3 Cancellation / disconnect.** BLOCKED for mid-stream cancel; otherwise UNPROVEN.
- `p05-smoke` limitation: no `request_cancelled` row observed for passive disconnect
  (`approval-wait-runtime.log:301`). The `mock://` adapter has fail, timeout, tool and
  post-output-failure variants (`providers.rs:288-296`) but no controllable slow
  stream, and the HTTP provider is blocked (G4).
- Missing: a development-only slow-stream mock variant (IMPL, supervisor decision) so a
  user Cancel in Electron lands mid-stream. Assert the request becomes terminal, the
  reservation is not left `reserved`, and the run is `cancelled`.

**D4 Failure before output, output then failure, timeout; reservations settle;
retries bounded; failures rendered.** UNPROVEN (NEW-TEST).
- Evidence: none through the desktop. `verify:inference-failure` (backend,
  direct HTTP) has no current-head log (G5). The Electron run creates a budget
  (`:382-398`) but never reads `budget_reservations`.
- Missing: three extra Electron routes on the existing alias pattern (`mock://lumi-fail`,
  `lumi-timeout`, `lumi-post-output-failure`; route `max_retries: 0` is already the
  fixture's choice). Per turn assert UI error and recovery, a terminal request,
  reservation `released`/`committed` (never `reserved`), provider attempt count 1,
  usage row correct. Positive control: the success run in the same org.

**D5 Usage attributed to the right org/project/principal/run.** UNPROVEN (RERUN).
- Evidence: Electron asserts org, project and device on usage rows only (`:668-676`).
  `verify:usage-attribution` had one named SKIP (no managed run) and is stale (G5).
- Missing: assert principal and run on the usage row; RERUN the probe now that a
  managed run fixture exists.

**D6 Managed tool allow / deny / approval-required with side effects.** UNPROVEN
(RERUN). The Electron probe covers this at its observed scope:
- Evidence: reviewed descriptor, pending approval (`per_use`, `filesystem_write`),
  no file while pending, approved: exact file bytes, one `tool_call_refs` row
  `completed`, `execution_started_at` set, approval `consumed_at`, one
  `tool.result.v1` audit row; denied: file absent, `execution_started_at` null,
  `consumed_at` null, run terminal (`:896-988`). The harness answers the Agent's own
  local "Allow only this time" prompt and resolves the managed approval over the API
  as a human session. Observed 2026-10-08, G1 applies.
- Missing for "allow without approval": no run exercises an `allow` decision with no
  approval (only per-use). Add one tool/route with `approval_mode` none.

**D7 Approval bound to exact tool/action/arguments/run.** UNPROVEN (NEW-TEST).
- Evidence: Core regressions (`arguments-*` logs) and backend canonical hash binding
  (`execution-claim-worker-runtime.log`: "decision carries server-owned canonical
  argument binding"); the Electron arguments are fixed.
- Gap: I found no retained check that a grant decided on one argument digest refuses a
  claim with a different digest while leaving the grant unconsumed.
- Missing: Worker/D1 hostile test through the production adapter (approve digest H1,
  claim H2 → refused, grant unconsumed, one positive control with H1); an Electron
  second turn with different arguments needs a fresh pending approval and no file.

**D8 Browser / computer / MCP enforcement and execution.** UNPROVEN. Not
NOT_APPLICABLE: the client has a browser broker.
- Evidence: `approval-wait-runtime.log:296-300`: no public browser/CUA execution
  endpoint; browser decision `deny reason=capability_not_defined`; the MCP and generic
  privileged result probes get `422 tool_execution_not_started`. The probe predates the
  migration-0027 claim requirement, so it is a stale verifier rather than a product
  verdict.
- Missing: update `apps/api/scripts/p05-smoke.mjs` to obtain the preflight claim before
  reporting, then grade MCP deny/expiry/revocation. Seed a browser capability through
  a legitimate path, or record NOT_APPLICABLE with evidence per surface.

**D9 Web control plane shows run, usage, audit with matching correlation IDs and
tenant context.** UNPROVEN (NEW-TEST).
- Evidence: D1 audit rows correlate to the run and request ID is queryable at the API
  (`approval-wait-runtime.log:286-288`, `p05-smoke`), for the smoke's run, not the
  Electron run. The browser is never pointed at runs/usage/audit pages. I did not
  inspect those web routes.
- Missing: headless Chrome as the org owner opens the pages for the Electron run's
  IDs and asserts the IDs, device, project and request correlation; the other org's
  owner sees nothing (non-disclosure). Sensitive content stays absent from all of it.

**D10 Budget and reservation settlement under real desktop traffic.** UNPROVEN
(NEW-TEST). Same instrument as D4; no readback exists in the Electron run.

## Hostile / sensitivity obligations tied to A–D

Existing sensitivity proofs cover components: transport run-binding
(`tool-broker-sensitivity-*`), tool context (`tool-context-sensitivity.json`),
argument ownership, capability claim, result CAS, approval deadline, admission. None
faults the Electron verifier itself. Valid, positive-controlled faults still owed,
each in a disposable worktree with a restored rebuild:

1. S1 tenant: drop org scoping on a lookup the journey uses; the C9 probe must fail
   on non-disclosure.
2. S2 revocation: skip the device-status check in Main's lease or the Worker's
   run start; the B5 probe must fail on a post-revoke managed turn.
3. S3 tool denial: let the Core gate proceed on `deny`; D6's "file absent" must fail.
4. S4 budget settlement: skip the reservation release in the failure path; D4 must see
   a stranded `reserved` row.
5. S5 local-state preservation: make rollback delete or rewrite a local file or
   session; C7 must fail on the client-SQLite read.

A compile error or a probe that never started does not count as detection.

## Recommended next packet (bounded)

One coordinator-owned packet, e.g. `DE2E-QA-AD-01`, write surface limited to
`tests/integration/**` (new probe plus `lib/`), the evidence directory, and one
dev-only `mock://` variant if approved. Order by cost and by rows flipped:

1. **Baseline rerun (RERUN, no new code).** After the harness fix lands, freeze a
   manifest (parent and client full SHAs, per-file hashes of the dirty set, migration
   list hash, app version, command, platform, profile path on the SSD) and rerun
   `desktop-account-electron.mjs` once. Add a positive control that
   `profile/home/.zcode/cli/db/db.sqlite` exists after the run (proves the Agent used
   the isolated HOME without reading anything personal). Also RERUN `p03-smoke`,
   `verify:revoked-device`, `verify:device-idempotency`, `verify:usage-attribution`,
   `verify:inference-failure` at that head. Flips back: A1 A2 B1 C1 C7(part) D1 D6 and
   G1/G5 from UNPROVEN to gradeable.
2. **Wire-capture proxy + profile secret sweep (new `lib/`, small).** Unlocks A5, A9,
   C1, C6b, C8, D1 (header swap).
3. **One negative-matrix Electron probe** (`desktop-negatives-electron.mjs`, reusing
   `lib/lumi-desktop-app.mjs` and `lib/lumi-desktop-onboarding.mjs`), in this order:
   B5 post-revoke and restart; C5 mutation matrix with D1 zero-dispatch readback;
   A3/A4 cancel and expiry; D4/D10 fail, timeout, post-output-failure with reservation
   readback; B3 kill-mid-enrollment; C7 all-stage rollback; B6 recovery.
4. **Provider-isolation matrix** (A5/A6/A7) as a separate small probe: four synthetic
   profiles. It needs no Worker for A7.
5. **Sensitivity S1–S5** after the probes have a green baseline.

Not in this packet: C6a (needs a spec/CR decision, then IMPL), D3 mid-stream cancel
(needs the dev slow-stream mock or a reachable HTTP provider, BLOCKED today), D8
(update the stale `p05-smoke` flow first), external-provider proof (BLOCKED, needs
approved credentials and a spend cap), web-page observation D9 (confirm the routes
exist first).

Decisions needed from the supervisor: (a) whether desktop org-creation is required,
(b) the designated primary sign-in path (A10), (c) approval of a dev-only slow-stream
mock, (d) whether to inspect or clean up personal Agent-store residue left by
pre-fix runs. I did not read it.
