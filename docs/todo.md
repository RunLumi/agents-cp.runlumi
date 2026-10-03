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
