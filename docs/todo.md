# Product and Engineering To-do

- [ ] **Explore protocol-first extensibility and live updates**
  - Evaluate a versioned LumiAgents server/client protocol that can support independent, polished custom frontends. Use OpenCode and OpenChamber as references, without assuming Lumi should adopt their protocol.
  - Define how saved changes to skills, agents, MCP servers, and plugins can take effect without restarting the app, including validation, policy/approval checks, rollback, and behavior for active sessions.
  - Prototype one alternate client and one live extension update against a versioned contract before committing to product scope.
  - Related contracts: [F13 — Tools, MCP, Browser & Computer Use Policies](specs/f13-tools-mcp-browser-computer-use-policies.md), [F25 — Plugins, Extensions & Organization Catalog Policy](specs/f25-plugins-extensions-organization-catalog-policy.md), and [Plan 08 — LumiAgents integration, migration, adoption](implementation/plan08-lumiagents-migration-adoption.md).

The items below are the deliberately-open verification findings — every one is
fail-closed today, re-derived and recorded with its failure direction in the
[2026-10-03 audit record](verification/runs/2026-10-03-audit-whole-repo/audit-record.md)
and at its finding's source in the verification runs. Each needs a product
decision before code: implementing them without that decision would invent
policy the specs do not state, which is the defect class the verification
system exists to catch.

- [ ] **Wire the provider-entitlement projection writer (V01-050, HIGH)**
  - `provider_entitlement_projections` has exactly one `INSERT`
    (`upsert_provider_projection_statement`) and it has **no caller**, and no migration
    seeds the table — so `GET /api/v1/orgs/{org_id}/entitlements/provider`
    (`routes/billing.rs`) answers `200` with an `Unknown` projection forever. This is
    the V01-030 shape on a customer surface: a success status over a thing that can
    never exist, indistinguishable from correct behavior by any status-based check.
  - Fail direction: fail-closed presenting as success — no data exposure, but the
    endpoint can never say anything true.
  - Next step: a short provider-sync design — what observes the payment provider, on
    what cadence, and how projection rows relate to the provider event ledger — then
    wiring the upsert is a one-call-site change with the sync job as its only writer.
  - Related contracts: [F18 — Billing, Plans, Entitlements & Licensing](specs/f18-billing-plans-entitlements-licensing.md) and [ADR 0007 — three actor kinds](adr/0007-three-actor-kinds.md).

- [ ] **Trigger webhook fan-out for committed business events (V01-046)**
  - `fan_out_event_statement` (+ `fan_out_count` and the notification cluster beside
    it) has **no caller**: a committed business event is never delivered to a
    subscribed endpoint. The delivery machinery that IS live (signing, retry,
    dead-letter, replay) runs only for operator-initiated sends
    (`test_webhook` and its replay — `verify:webhook-fanout` 19/19 proves exactly
    this, as a delta from controls rather than an assumed absence).
  - Fail direction: fail-closed — no event is ever delivered to a subscriber, so no
    policy is bypassed; the feature simply does not exist end to end.
  - Next step: decide which events are eligible for fan-out, whether `webhook.*`
    events may reach customer endpoints at all, and how fan-out ordering meets
    FR-F17-007 — then add the call to the committing transactions (~22 route
    files). The eligibility decision is the spec work; the wiring is mechanical
    after it.
  - Related contracts: [F17 — Notifications, Webhooks & Event Delivery](specs/f17-notifications-webhooks-events.md).

- [ ] **Implement the `'run'` usage writer (V01-047)**
  - The `usage_events.source` CHECK was widened to admit `'run'`, the read paths
    (`list_usage` / `summarize_usage`) `UNION ALL` a `run_usage_events` table that
    nothing writes, and `UsageSource::Run` is constructed only in tests — so
    `is_run_source()` is called from five production sites and is structurally
    incapable of being true. A missing half of a symmetric pair is invisible by
    construction: the populated half answers for the empty one.
  - Fail direction: fail-closed, half-built — reads are wired, writes are not, and
    every rollup read returns nothing.
  - Next step: a money decision — what counts as billable non-inference usage —
    per [P05-CR-002](implementation/change-requests/P05-CR-002.md) §7/§8, which
    commits to the second source in the present tense and says it `must use` the
    same cost rules. The writers follow from that decision; until then the empty
    table is the honest state.
  - Related contracts: [F12 — Usage Metering, Quotas, Budgets & Cost Controls](specs/f12-usage-metering-quotas-budgets-cost-controls.md), [P05-CR-002](implementation/change-requests/P05-CR-002.md).

- [ ] **Design and implement the staff grant-use surface (V01-040)**
  - ADR 0007 requires a support grant to be audited **on creation and on every
    use**. The *use* half does not exist: no route consumes a grant, and
    `find_grants_for_staff_and_org` — documented as "the grant read every
    customer-context request uses" — has no non-test caller. Staff cannot reach
    customer context at all today, granted or not.
  - Fail direction: fail-closed, absent — there is no fail-open path (staff cannot
    reach customer context), so the gap is a missing capability, not a breach.
  - Next step: a support-session spec/ADR (how a staff principal enters customer
    context, what a grant authorizes, how every use is audited per ADR 0007's
    three-actor model), then the grant consumption route and the writer for the
    audit trail. The existing V01-035–V01-039 repairs already enforce the staff
    boundary and actor attribution the spec will build on.
  - Related contracts: [ADR 0007 — three actor kinds](adr/0007-three-actor-kinds.md), [F24 — Admin, Support, Abuse & Feature Rollouts](specs/f24-admin-support-abuse-feature-rollouts.md), [F16 — Audit Logs, Security Events & Support Access](specs/f16-audit-security-events-support-access.md).

## Desktop ↔ control-plane E2E — human hand-off (2026-10-12)

Authority: [goal prompt](prompts/goal-desktop-backend-e2e.md). Claim matrix and evidence:
[2026-10-12 evidence record](verification/runs/2026-10-12-desktop-linux-e2e/README.md). Resume
state: [checkpoint](implementation/desktop-e2e/continuation-20261011-checkpoint.md).

### Where things stand

- **Merged and deployed (agents-cp):** #62 (server fixes), #63 (Linux gate + journeys), #65
  (stale-fence probe), #66–#68 (browser proof, fail-closed journey, D2 evidence), #69 (pin).
  `main` pins LumiAgents `a1c6dde8`; every `main` merge passed quality and `Deploy production`.
- **Merged (LumiAgents):** #49 → `a1c6dde8` (Linux desktop fixes, revoked state, token rotation,
  managed browser fail-closed); #50 → `d97e39e2` (DCO job temporarily disabled).
- **Clean paired gate** on parent `36bf777` + client `a1c6dde8` (`reproducible: true`): every
  Electron journey PASS except **automation = UNPROVEN** (items below). Gate verdict FAIL
  because it requires PASS for every journey.
- **Not done:** external-provider proof, managed browser as a working feature, D2, the open
  automation items, a sensitivity rerun on the final pair, and any desktop release.
  **Do not call the E2E complete until every item marked "required" below is closed.**

### How to run the proof

Linux needs Xvfb, dbus, gnome-keyring and secret-tool, plus Node 24 on PATH (the gate refuses
other Node versions). macOS needs a logged-in session with Keychain.

```sh
git submodule update --init --recursive
LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs   # full clean pair
LUMI_INTEGRATION_DESKTOP=1 LUMI_DESKTOP_JOURNEYS=browser,mcp node scripts/integration/lumi-agents.mjs  # subset
node scripts/integration/desktop-sensitivity.mjs                     # fault injection
```

A submodule HEAD that differs from the gitlink is refused unless `LUMI_AGENTS_DIR` is set. That
is a local override and gives `reproducible: false`, which is not release evidence.

### Required to complete the E2E (in order)

- [ ] **1. Restore DCO in LumiAgents** (owner, licensing — ADR 0001, `CONTRIBUTING.md`)
  - Set a real git identity first; the commits so far use the machine's `Ubuntu` user.
  - The human author adds a verified same-author retrospective attestation in
    `docs/licensing/dco-attestations.json` for each unsigned commit merged while DCO was off:
    `1433897a 17a86027 53568365 df54988e c261135a d5372225 06e2483a f3d31d55 91db7fb4 e9c1ffc2`
    (#49) and `6c5c5cc8` (#50), plus any later ones.
  - Then delete the `if: ${{ false }}` line on the `dco` job in
    `.github/workflows/dco-license.yml`. Done when the `main` push check is green.
  - Also consider branch protection with required checks on LumiAgents `main`. There is none
    today, which is why a red `dco` check could not block a merge
    (`docs/licensing/COMPLIANCE.md` §9).

- [ ] **2. Decide and build P05-CR-005 steps 2–3: managed browser use that works** (P05 contract owner)
  - Today browser commands in a managed session fail closed: the org policy cannot be bypassed,
    but managed desktop browser use is unavailable.
  - Proposal: [P05-CR-005](implementation/change-requests/P05-CR-005.md). It covers a child tool
    decision per browser command under the parent call's grant, a Main gate adapter over the device
    transport, and server evaluation that only narrows.
  - Done when `tests/integration/desktop-browser-electron.mjs` is changed back to require
    **1 hit when allowed** and **0 hits when the domain is blocked**, and it passes on the gate.
    `f3d31d55` vs `e9c1ffc2` is the existing fault/control pair.

- [ ] **3. Decide how D2 (non-streaming managed inference) is reachable** (product/spec)
  - Two runtime attempts sent no non-stream managed request: composer `/compact`, and Workspace
    Memory extraction, including after a restart. Managed authority covers only the single prompt
    from the managed-run panel.
  - Decide whether follow-up turns, compaction or memory extraction should run under managed
    authority. Then add a journey that grades the `stream` flag on the wire plus D1 settlement.
    The draft probe was not committed: route the app through `startSecretSweepProxy` and record
    only `{stream}` for `POST /api/v1/inference/*`.

- [ ] **4. External provider round trip (X1)** (needs separate authorization)
  - Approve one provider credential with a hard spend cap and secure custody. Run the managed turn
    and the automation schedule stage against it instead of `mock://` and the loopback stub.
  - Never commit or log the credential. Record cost and request ids.

- [ ] **5. Close the automation (journey E) UNPROVEN items**
  - *Renewal during a long run:* PASS on earlier runs, not observed on the final pair. Rerun the
    automation journey; if it is timing-dependent, lengthen the slow route or assert renewal
    explicitly.
  - *Off-peak refusal:* the Worker only creates `off_peak_mode: "normal"` occurrences, so it is
    unreachable at runtime. Either decide off-peak is out of scope (record NOT_APPLICABLE in the
    spec) or build off-peak scheduling, then extend the journey.
  - *Fence entropy/monotonicity and stale fence through the app:* proven at Worker HTTP
    (`verify:lease-contention` 72/72). The raw lease token never leaves Main, so decide whether that
    Worker-level proof is accepted for the claim, or add a test-only Main hook (harness only, never
    production).

- [ ] **6. Rerun sensitivity on the final pair**
  - `node scripts/integration/desktop-sensitivity.mjs` with the pinned client. S1–S6 must be
    DETECTED for the intended reason; a build failure is not detection. Record the result in the
    evidence record.

- [ ] **7. Final certification run**
  - After 1–6, run the full gate on the new pinned pair from a clean checkout. Record the SHAs,
    versions, command and verdict, and split the proof into local, hosted CI, merged, deployed and
    release.
  - A desktop release or store submission needs its own authorization and runbook; it is not part
    of this proof.

### Follow-ups (not blocking the E2E claim)

- [ ] **P06 change request: claim deadline for `dispatching` occurrences.** An unclaimed
  `dispatching` occurrence never expires, so under `overlap_policy=skip` it blocks successors.
  P06-CG allows `dispatching → missed` but defines no deadline.
- [ ] **Tool-policy change → device policy snapshot.** A tool policy PUT issues no new snapshot.
  Tightening applies at once; loosening (a newly reviewed tool) waits for the device's next
  refresh (token rotation ≤10 min). Decide whether the PUT should refresh snapshots.
- [ ] **MCP journey flake under load.** One gate run hit an unexplained `lumi_request_refused`;
  standalone runs pass 7/7, and the gate runs journeys sequentially.
- [ ] **`desktopResourceTelemetry.test.ts` fails 22/27 on Linux** at the untouched LumiAgents base.
  It also breaks the client pre-push hook, so pushes used `--no-verify`.
- [ ] **Housekeeping:** remove local worktrees under `../de2e-worktrees/` (client, gate, mcp,
  dco-off, todo) and merged `codex/de2e-*` branches once nothing references them.

Not applicable on this build (no action unless the product changes): computer use
(`packages/zcode-cua` is a fail-closed placeholder; the device reports `computer_use: false`).
