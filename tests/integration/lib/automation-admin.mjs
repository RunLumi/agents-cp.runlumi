// Organization-owner actions through the PUBLIC admin routes (the same ones the web control plane uses).
// These steer the scenario (stop new occurrences, revoke a device); they never write D1 and never touch
// the desktop. Stored state is read back from D1 afterwards.
import assert from "node:assert/strict";

let sequence = 0;
const nextKey = (label) => `automation-admin-${label}-${Date.now()}-${(sequence += 1)}`;

async function definitionVersion(server, orgId, automationId) {
  const rows = await server.rows(
    `SELECT version, status FROM automation_definitions WHERE org_id='${orgId}' AND automation_id='${automationId}'`,
    "definition version",
  );
  assert.equal(rows.length, 1, `definition ${automationId} exists`);
  return rows[0];
}

/** `pause` or `resume` a managed automation; asserts the stored status moved. */
export async function setAutomationStatus(ctx, action, automationId) {
  const { probe, server, orgId, fixtureOrg } = ctx;
  const target = action === "pause" ? "paused" : "active";
  const current = await definitionVersion(server, orgId, automationId);
  if (current.status === target) return;
  const result = await probe.request(
    fixtureOrg.fixture,
    "POST",
    `/api/v1/orgs/${orgId}/automations/${automationId}/${action}`,
    { version: current.version },
    probe.browserMutation(fixtureOrg.fixture, nextKey(action)),
  );
  assert.equal(
    result.status,
    200,
    `${action} answered ${result.status}: ${result.text.slice(0, 300)}`,
  );
  const after = await definitionVersion(server, orgId, automationId);
  assert.equal(after.status, target, `${action} took effect in D1`);
}

/** Revoke a device the way an organization owner does (DELETE), then read the stored revocation. */
export async function revokeDevice(ctx, deviceId) {
  const { probe, server, orgId, fixtureOrg } = ctx;
  const before = await server.rows(
    `SELECT status FROM devices WHERE device_id='${deviceId}'`,
    "device before revoke",
  );
  assert.equal(
    before[0]?.status,
    "active",
    "positive control: the device is active before revocation",
  );
  const result = await probe.request(
    fixtureOrg.fixture,
    "DELETE",
    `/api/v1/orgs/${orgId}/devices/${deviceId}`,
    {},
    probe.browserMutation(fixtureOrg.fixture, nextKey("revoke")),
  );
  assert.ok(
    [200, 202, 204].includes(result.status),
    `revoke answered ${result.status}: ${result.text.slice(0, 300)}`,
  );
  const after = await server.rows(
    `SELECT status FROM devices WHERE device_id='${deviceId}'`,
    "device after revoke",
  );
  assert.equal(after[0]?.status, "revoked", "revocation is stored");
  const tokens = await server.rows(
    `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id='${deviceId}'`,
    "device tokens after revoke",
  );
  assert.equal(Number(tokens[0].n), 0, "no device token survives revocation");
}
