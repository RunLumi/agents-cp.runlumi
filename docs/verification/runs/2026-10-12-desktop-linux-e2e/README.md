# Desktop ↔ control-plane E2E on Linux — 2026-10-12 evidence

Authority: `docs/prompts/goal-desktop-backend-e2e.md`. Verdicts use PASS / FAIL / UNPROVEN /
BLOCKED / NOT_APPLICABLE. Historical evidence in `../2026-10-07-desktop-managed-e2e/` is not
re-certified here. Every claim below was exercised through the **actual Electron app**
(Main → Host → Agent) against a fresh local Worker/D1 unless the row says otherwise.

## Environment and provenance

- Ubuntu 22.04, Node 24.14.0, pinned pnpm (parent 12.5.1, client 10.33.2), Rust stable +
  wasm32, worker-build 0.8.7, Electron 44 (lazy download), Xvfb, private D-Bus,
  gnome-keyring Secret Service owned per run (`scripts/integration/linux-desktop-session.sh`;
  Electron selects `gnome_libsecret`, the product refuses `basic_text`), Chrome stable.
- Parent: main `f73e3efae62be0f82ad2dc25f8fcee88d868e11d` (includes #62, #63) plus the
  coordinator branch commits listed in the pin PR. Client: LumiAgents PR #49 head
  `f3d31d5589d8d066b56d61f3ef534ab473e25d81` (earlier journeys ran on `06e2483a`/`df54988e`;
  the full-gate run on the final candidate is recorded below).
- These are **local runs on a candidate pair** (submodule override, so `reproducible: false`).
  The clean exact-pair replay is recorded in the pin PR after LumiAgents#49 merges.
- No external provider was called; inference used the Worker's development-only `mock://`
  routes and a loopback personal-provider stub. External-provider proof is **BLOCKED** (no
  approved credential or spend cap).

## Claim matrix

| ID | Requirement | Verdict | Evidence |
|---|---|---|---|
| A1 | Fresh entry: Lumi sign-in, API key, Continue locally; no Z.ai/BigModel OAuth buttons | PASS | account journey; LumiAgents `df54988e` UI test |
| A2 | Provider OAuth still reachable from Model Provider settings | PASS (component) | LumiAgents `df54988e` (`startLogin("zai")`); runtime click would call the external provider |
| A3 | Local/offline startup, existing local work without account/network | PASS | local-preservation (control plane unreachable); revocation (local automation via personal stub) |
| A4 | Real auth: PKCE + browser approval; cancel, unapproved, expired, wrong code | PASS | account, account-failures |
| A5 | Session expiry across restart; logout removes own session | PASS | account-failures, account |
| A6 | Org choice never carries authority or adopts a workspace | PASS | multi-org |
| A7 | Secure custody: no plaintext session/device/lease secret at rest; OS-encrypted vault | PASS | revocation secret sweep (scanner control first); account (vault ciphertext) |
| B1 | Proof-of-possession enrollment, approval, policy, refresh | PASS | account; module gate `lumi-account.mjs` |
| B2 | Interrupted enrollment resumes without duplicates | PASS | account-failures (SIGKILL mid-enrollment) |
| B3 | Expiry/replay/wrong-proof/recovery refusals | PASS (transport) | module gate `lumi-account.mjs`; Electron recovery after Worker-side expiry in adoption-policy |
| B4 | Revocation refuses new managed execution at UI and host seam; restart cannot restore | PASS | revocation |
| B5 | Minimum client version (P03 token-exchange enforcement) | PASS | adoption-policy |
| C1 | Explicit one-workspace binding; second workspace stays local | PASS | account, adoption-policy |
| C2 | Server-owned ladder; UI rollback from every reachable stage with storage readback | PASS | adoption-policy, account |
| C3 | Runtime policy enforcement (managed route disabled) | PASS | adoption-policy |
| C4 | Credential choices recorded exactly; metadata-only sends no secret | PASS | adoption-policy; revocation wire sweep |
| C5 | No history sync / bulk upload; adoption traffic carries no local path | PASS | revocation wire sweep (path allowed only in managed inference model context) |
| D1 | Streamed managed turn, usage attributed, prompt not stored | PASS | account, managed-faults |
| D2 | Non-streaming managed inference through the desktop | UNPROVEN | the desktop Agent always streams; Worker non-stream path covered by `pnpm smoke:p05`/P04 probes only |
| D3 | Failure before/after output, timeout, user cancel; bounded attempts; reservations settled | PASS | managed-faults (cancel settles via Worker watchdog ≈107 s) |
| D4 | Tool allow / deny / exact per-use approval; changed arguments cannot reuse approval | PASS | account (Write), `p05-smoke` changed-arguments attack |
| D5 | MCP enforcement | PASS | mcp journey (approved once; org deny, approval deny, revocation → no effect) |
| D6 | Browser enforcement | UNPROVEN at full runtime | component proof LumiAgents `c261135a`; mock cannot drive the `js` tool |
| D7 | Computer use | NOT_APPLICABLE | device reports `computer_use: false`; `packages/zcode-cua` placeholder |
| D8 | Web runs/usage/audit show the desktop run; other tenant sees nothing | PASS | managed-faults web observation |
| E1 | Preview/cancel writes nothing; explicit adoption | PASS | automation (adopt stage) |
| E2 | Scheduler claim → start → run → settle; renewal | PASS | automation (in-flight lease renewed to version 2) |
| E3 | Two-client race: exactly one executes; loser gets frozen `occurrence_already_claimed` | PASS | automation race rounds 1–2 |
| E4 | Restart, lost start → ambiguous, needs reconciliation | PASS | automation restart stage |
| E5 | Entitlement loss blocks with no lease/attempt/run | PASS | automation faults |
| E6 | After entitlement restore the automation executes again | PASS after fix | FAILed twice: the device token was never rotated, so each client stopped polling 15 min after enrollment (LumiAgents `f3d31d55` fixes it; rotation tests 2/4 → 4/4); passes on the rotating client |
| E7 | Off-peak refusal | UNPROVEN at runtime | component: LumiAgents `17a86027`; the journey never makes an occurrence off-peak |
| E9 | Expired/stale lease after thaw; lease loss stops the handler | PASS | automation faults (late renew/settle change nothing; journal `lease_lost`) |
| E10 | Stale fence with a live lease; fence entropy/monotonicity | PASS (component) / UNPROVEN (HTTP runtime) | `guard:probe` evaluates every lease guard in permit and abort states; the raw lease token never leaves Main |
| E8 | Local scheduler never runs adopted originals; originals preserved | PASS | local-preservation, automation |
| X1 | External provider round trip | BLOCKED | no approved credential/spend cap |

## Sensitivity (disposable worktrees, `scripts/integration/desktop-sensitivity.mjs`)

| Fault | Boundary | Result |
|---|---|---|
| S1 | P08 rollback tenant scope (`org_id` predicate made vacuous, binds intact) | DETECTED — `foreign organization rollback refused` |
| S2 | Revocation takes effect (status + tokens) | DETECTED — `revoked seam must refuse` |
| S3 | Server honours a human tool denial | DETECTED — `denied tool call is settled without execution` |
| S4 | Managed reservation release (reconcile statement) | DETECTED — `reservation settled` |
| S5 | Adopted originals never run locally (query exclusion + tasks-index trigger) | DETECTED — `adopted original` |

Earlier definitions that stayed UNDETECTED or INVALID are kept in their summaries: they showed
defense in depth (every device route re-checks revocation; Core and the server independently
backstop a desktop deny flip; a trigger backs the scheduler exclusion) or harness faults that
were repaired (shared client reinstall, socket path length, D1 flake).

## Findings and limitations

- **Fixed defect:** the desktop never rotated its 15-minute device token; managed scheduling
  stopped silently 15 minutes after enrollment or recovery (LumiAgents `f3d31d55`).
- **Spec gap (not fixed here):** an unclaimed `dispatching` occurrence has no claim deadline, so
  under `overlap_policy=skip` it blocks successors until a device claims it (P06-CG allows
  `dispatching → missed` but defines no deadline) — candidate P06 change request.

- Managed cancel settles through the Worker watchdog (route deadline + 2 s), not immediate
  disconnect detection, in local workerd.
- The Agent retries a retryable managed failure up to 10 times with backoff (observed 7).
- MCP tool calls are always per-use approval; an org denial reaches the Agent as
  `approval_already_resolved`; a run whose device is revoked mid-approval stays `running`.
- Pre-existing: `desktopResourceTelemetry.test.ts` fails 22/27 on Linux at the untouched base.
