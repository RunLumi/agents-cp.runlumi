// Focused controls for the race stage's binding-resolution mirror. Pure functions only: no Worker, no Electron.
// Run: node --test tests/integration/lib/automation-race-binding.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { admittedByResolver, assertEachDeviceResolves, classifyDeviceBindings } from "./automation-race-binding.mjs";

const PROJECT = "prj_a";
const A = "dvc_a";
const B = "dvc_b";
const binding = (id, device, extra = {}) => ({
  binding_id: id,
  project_id: PROJECT,
  device_id: device,
  workspace_identity: `ws-${id}`,
  removed_at: null,
  ...extra,
});
const devices = [
  { device_id: A, status: "active" },
  { device_id: B, status: "active" },
];
const eligible = { project_id: PROJECT, target_kind: "eligible_device", target_device_id: null, target_workspace_binding_id: null };

test("a binding-less eligible_device definition is admitted only to devices with exactly one live binding", () => {
  assert.deepEqual(admittedByResolver(eligible, devices, [binding("b1", A), binding("b2", B)]), [A, B]);
  // Marker-only B (no server binding) is not eligible: the marker is never authority.
  assert.deepEqual(admittedByResolver(eligible, devices, [binding("b1", A)]), [A]);
  // Two live bindings are ambiguous; the server never guesses.
  assert.deepEqual(admittedByResolver(eligible, devices, [binding("b1", A), binding("b3", A), binding("b2", B)]), [B]);
  // A removed binding does not count.
  assert.deepEqual(admittedByResolver(eligible, devices, [binding("b1", A), binding("b2", B, { removed_at: "2026-10-09T00:00:00.000Z" })]), [A]);
});

test("a binding for another project does not resolve", () => {
  const other = binding("b2", B, { project_id: "prj_other" });
  assert.deepEqual(admittedByResolver(eligible, devices, [binding("b1", A), other]), [A]);
});

test("a pinned definition is admitted only to the device owning that live binding", () => {
  const pinned = { ...eligible, target_workspace_binding_id: "b1" };
  assert.deepEqual(admittedByResolver(pinned, devices, [binding("b1", A), binding("b2", B)]), [A]);
  assert.deepEqual(admittedByResolver(pinned, devices, [binding("b1", A, { removed_at: "x" }), binding("b2", B)]), []);
});

test("a device-targeted or inactive device is not admitted", () => {
  const onlyB = { ...eligible, target_kind: "device", target_device_id: B };
  const both = [binding("b1", A), binding("b2", B)];
  assert.deepEqual(admittedByResolver(onlyB, devices, both), [B]);
  assert.deepEqual(admittedByResolver(eligible, [devices[0], { device_id: B, status: "revoked" }], both), [A]);
});

test("classifyDeviceBindings reports resolved, unresolved and ambiguous per device", () => {
  const result = classifyDeviceBindings([binding("b1", A), binding("b2", A)], [A, B], PROJECT);
  assert.equal(result[A].status, "ambiguous");
  assert.equal(result[B].status, "unresolved");
});

test("assertEachDeviceResolves returns each device's own binding and names a missing or shared one", () => {
  assert.deepEqual(assertEachDeviceResolves([binding("b1", A), binding("b2", B)], [A, B], PROJECT), { [A]: "b1", [B]: "b2" });
  assert.throws(() => assertEachDeviceResolves([binding("b1", A)], [A, B], PROJECT), /dvc_b has unresolved/);
  assert.throws(
    () => assertEachDeviceResolves([binding("b1", A), binding("b2", B, { workspace_identity: "ws-b1" })], [A, B], PROJECT),
    /own workspace identity/,
  );
});
