// Disposable organization for the desktop automation journey (DE2E-INT-05).
//
// Public admin routes create signup, org, project, catalog, policy, agent and budget. A bounded D1
// fixture simulates billing-provider grants for this fresh local org; it does not prove billing.
// Onboarding and execution authority always use real routes. The providers are development mock://, so
// this proves Worker routing and stored effects, never a third-party provider response.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

/** Synthetic billing-provider state only. Product enrollment/claim/start still use real routes.
 * No billing-provider integration is proved by this fixture. It touches only this fresh local org.
 */
export async function grantAutomationFixtureEntitlement(probe, orgId, key, value) {
  assert.match(orgId, /^org_[0-9a-f]{32}$/);
  assert.ok(["automations.max_active", "inference.byok"].includes(key));
  assert.ok(
    (key === "automations.max_active" && value === 5) ||
      (key === "inference.byok" && value === true),
  );
  const grantId = `egr_${randomUUID().replaceAll("-", "")}`;
  const stamp = new Date().toISOString();
  await probe.d1Rows(
    `INSERT INTO entitlement_grants
    (grant_id, org_id, entitlement_key, scope, value_json, source, effective_at, created_at, updated_at)
    VALUES ('${grantId}', '${orgId}', '${key}', 'organization', '${JSON.stringify(value)}',
      'plan', '${stamp}', '${stamp}', '${stamp}')`,
    `synthetic billing fixture ${key}`,
  );
  const stored = await probe.d1Rows(
    `SELECT value_json FROM entitlement_grants
    WHERE grant_id='${grantId}' AND org_id='${orgId}' AND revoked_at IS NULL`,
    `read fixture ${key}`,
  );
  assert.equal(stored.length, 1);
  assert.equal(JSON.parse(stored[0].value_json), value);
  return grantId;
}

/**
 * Synthetic billing-provider fixture, the same class that created the grant: the plan lapses, so the organization's
 * `automations.max_active` grant is revoked. Returns how many live grants were revoked (asserted non-zero).
 */
export async function revokeAutomationFixtureEntitlement(probe, orgId, key) {
  assert.match(orgId, /^org_[0-9a-f]{32}$/);
  assert.ok(["automations.max_active"].includes(key));
  const stamp = new Date().toISOString();
  const live = await probe.d1Rows(
    `SELECT grant_id FROM entitlement_grants WHERE org_id='${orgId}' AND entitlement_key='${key}' AND revoked_at IS NULL`,
    `live ${key} grants`,
  );
  assert.ok(live.length > 0, `a live ${key} grant exists to revoke`);
  await probe.d1Rows(
    `UPDATE entitlement_grants SET revoked_at='${stamp}', updated_at='${stamp}' WHERE org_id='${orgId}' AND entitlement_key='${key}' AND revoked_at IS NULL`,
    `revoke ${key}`,
  );
  const left = await probe.d1Rows(
    `SELECT grant_id FROM entitlement_grants WHERE org_id='${orgId}' AND entitlement_key='${key}' AND revoked_at IS NULL`,
    `remaining ${key} grants`,
  );
  assert.equal(left.length, 0, "no live grant remains");
  return live.length;
}

export const SUCCESS_ALIAS = "coding-default";
export const SLOW_ALIAS = "coding-slow";

/**
 * @param probe       a started SmokeHarness
 * @param options.slowTimeoutMs   upper bound for the hanging provider route (backend max 120000)
 */
export async function provisionOrganization(probe, { slowTimeoutMs = 110_000 } = {}) {
  const fixture = probe.client();
  const email = `automation-${probe.nonce}@example.com`;
  const password = `Lumi-e2e-${randomBytes(18).toString("hex")}!`;
  probe.registerSecret(password);
  const signup = await probe.request(fixture, "POST", "/api/v1/auth/password/signup", {
    email,
    display_name: "Automation Journey",
    password,
  });
  assert.equal(signup.status, 200);
  const verification = signup.payload.verification;
  probe.registerSecret(verification.development_code);
  assert.equal(
    (
      await probe.request(fixture, "POST", "/api/v1/auth/verify-email", {
        challenge_id: verification.challenge_id,
        code: verification.development_code,
      })
    ).status,
    200,
  );
  const org = await probe.createOrganization(
    fixture,
    "Automation Journey Org",
    `automation-org-${probe.nonce}`,
  );
  await grantAutomationFixtureEntitlement(probe, org.orgId, "automations.max_active", 5);
  const call = async (method, path, body, key, label, status = 201) => {
    const result = await probe.request(
      fixture,
      method,
      `/api/v1/orgs/${org.orgId}${path}`,
      body,
      probe.browserMutation(fixture, key),
    );
    probe.expectStatus(label, result, status);
    return result.payload;
  };
  const project = await call(
    "POST",
    "/projects",
    {
      name: "Automation Workspace Project",
      slug: `project-${probe.nonce.slice(0, 18)}`,
      visibility: "org",
    },
    "automation-project",
    "create disposable project",
  );
  const projectId = project?.id ?? project?.project?.id;
  assert.match(projectId, /^prj_[0-9a-f]{32}$/);

  async function route({ alias, adapterEndpoint, providerModelId, key, timeoutMs }) {
    const provider = (
      await call(
        "POST",
        "/catalog/providers",
        {
          provider_key: `automation-${key}`,
          display_name: `Automation ${key} provider`,
          adapter: "mock",
          endpoint_url: adapterEndpoint,
        },
        `automation-${key}-provider`,
        `create controllable ${key} provider`,
      )
    )?.provider;
    assert.match(provider?.provider_id, /^prv_[0-9a-f]{32}$/);
    const model = (
      await call(
        "POST",
        "/catalog/models",
        {
          provider_id: provider.provider_id,
          provider_model_id: providerModelId,
          display_name: `Automation ${key} model`,
          capabilities: ["text", "tools"],
          // The real Desktop Agent sends its whole system/tool catalogue, not just the prompt.
          max_input_tokens: 1_000_000,
          max_output_tokens: 8_192,
          pricing_version: "automation-e2e-v1",
        },
        `automation-${key}-model`,
        `create ${key} model`,
      )
    )?.model;
    assert.match(model?.model_id, /^mdl_[0-9a-f]{32}$/);
    const secret = `automation-${probe.nonce}-${key}-credential`;
    probe.registerSecret(secret);
    const credential = (
      await call(
        "POST",
        "/credentials",
        {
          provider_id: provider.provider_id,
          owner_type: "organization",
          label: `Automation ${key} provider`,
          secret,
        },
        `automation-${key}-credential`,
        `create ${key} credential`,
      )
    )?.credential;
    assert.match(credential?.credential_id, /^cred_[0-9a-f]{32}$/);
    const config = {
      strategy: "fixed",
      candidates: [
        {
          provider_id: provider.provider_id,
          model_id: model.model_id,
          weight: 100,
          timeout_ms: timeoutMs,
          max_retries: 0,
          credential_id: credential.credential_id,
        },
      ],
    };
    const created = (
      await call(
        "POST",
        "/routes",
        { alias, display_name: `Automation ${key}`, strategy: "fixed", config },
        `automation-${key}-route`,
        `create ${key} route`,
      )
    )?.route;
    assert.match(created?.route_id, /^rte_[0-9a-f]{32}$/);
    await call(
      "POST",
      `/routes/${created.route_id}/publish`,
      { version: created.version, config },
      `automation-${key}-publish`,
      `publish ${key} route`,
      200,
    );
    return { providerId: provider.provider_id, modelId: model.model_id, alias };
  }

  const success = await route({
    alias: SUCCESS_ALIAS,
    adapterEndpoint: "mock://lumi-success",
    providerModelId: "mock-success",
    key: "success",
    timeoutMs: 5_000,
  });
  const slow = await route({
    alias: SLOW_ALIAS,
    adapterEndpoint: "mock://lumi-timeout",
    providerModelId: "mock-timeout",
    key: "slow",
    timeoutMs: slowTimeoutMs,
  });

  const current = await probe.request(fixture, "GET", `/api/v1/orgs/${org.orgId}/policy`);
  probe.expectStatus("read organization policy", current, 200);
  const policy = await probe.request(
    fixture,
    "PUT",
    `/api/v1/orgs/${org.orgId}/policy`,
    {
      allowed_aliases: [SUCCESS_ALIAS, SLOW_ALIAS],
      allowed_models: [success.modelId, slow.modelId],
      allowed_providers: [success.providerId, slow.providerId],
      credential_mode: "organization_only",
      managed_route_enabled: true,
      version: current.payload?.version ?? 0,
    },
    probe.browserMutation(fixture, "automation-policy"),
  );
  probe.expectStatus("enable managed policy", policy, 200);
  const agent = await call(
    "POST",
    "/agents",
    { name: "Automation journey agent", project_id: projectId, default_model_alias: SUCCESS_ALIAS },
    "automation-agent",
    "create project-approved agent",
  );
  assert.match(agent?.id, /^agd_[0-9a-f]{32}$/);
  await call(
    "POST",
    "/budgets",
    {
      scope_type: "organization",
      period_start: new Date(Date.now() - 3_600_000).toISOString(),
      period_end: new Date(Date.now() + 86_400_000).toISOString(),
      // Hard cap on MOCK-provider usage only (no external provider, no real spend). Each mock run commits ~12k minor
      // units and the adopted automation fires every minute through a ~45 minute journey: the first 100_000 cap was
      // exhausted after 8 runs (budget.denied -> agent_failed, native-full-lane3-run21), starving the later fault stages.
      limit_minor: 3_000_000,
      currency: "USD",
      hard: true,
    },
    "automation-budget",
    "create bounded budget",
  );
  return { fixture, email, password, org, projectId, agentId: agent.id, success, slow };
}
