// Read-only mirror of the backend's server-side device binding resolution (P06-CR-008) for the `race`
// stage. The harness never grants authority: a device's workspace binding is created by the actual UI
// onboarding/adoption flow, and these helpers only READ D1 to prove which devices the server can resolve a
// binding for, and which binding the contested run was finally written with.
//
// Mirror of `DEVICE_DUE_OCCURRENCES_SQL` / `resolve_device_workspace_binding` / `classify_device_bindings`:
//   - pinned definition binding: offered only to the device that owns that live binding;
//   - binding-less definition: offered only to a device with EXACTLY ONE live binding for the project.
// If the backend rule changes, this mirror must change with it; the stage compares its prediction with
// the real outcome (lease, run binding), so a stale mirror fails the run instead of passing silently.

/** `resolved` (one live binding), `unresolved` (none) or `ambiguous` (several), per device. */
export function classifyDeviceBindings(bindings, deviceIds, projectId) {
  const live = (bindings ?? []).filter((row) => row.project_id === projectId && !row.removed_at);
  return Object.fromEntries(
    deviceIds.map((deviceId) => {
      const own = live.filter((row) => row.device_id === deviceId);
      const status = own.length === 0 ? "unresolved" : own.length === 1 ? "resolved" : "ambiguous";
      return [deviceId, { status, bindingIds: own.map((row) => row.binding_id).sort() }];
    }),
  );
}

/** Devices the due predicate admits for a definition, given the live binding rows. Sorted. */
export function admittedByResolver(definition, devices, bindings) {
  const byDevice = classifyDeviceBindings(
    bindings,
    devices.map((device) => device.device_id),
    definition.project_id,
  );
  return devices
    .filter((device) => device.status === "active")
    .filter((device) => definition.target_kind === "eligible_device" || definition.target_device_id === device.device_id)
    .filter((device) => {
      if (definition.target_workspace_binding_id)
        return (bindings ?? []).some(
          (row) =>
            row.binding_id === definition.target_workspace_binding_id &&
            row.device_id === device.device_id &&
            !row.removed_at,
        );
      return byDevice[device.device_id].status === "resolved";
    })
    .map((device) => device.device_id)
    .sort();
}

/**
 * Every enrolled device must hold exactly one live binding for the project, and no binding may be shared.
 * Throws with the observed state otherwise, so a missing UI binding is named instead of guessed around.
 */
export function assertEachDeviceResolves(bindings, deviceIds, projectId) {
  const byDevice = classifyDeviceBindings(bindings, deviceIds, projectId);
  for (const deviceId of deviceIds)
    if (byDevice[deviceId].status !== "resolved")
      throw new Error(
        `device ${deviceId} has ${byDevice[deviceId].status} server workspace binding(s) for ${projectId}: ${JSON.stringify(byDevice[deviceId].bindingIds)}`,
      );
  const ids = deviceIds.map((deviceId) => byDevice[deviceId].bindingIds[0]);
  if (new Set(ids).size !== ids.length) throw new Error(`devices share a workspace binding: ${JSON.stringify(ids)}`);
  const identities = new Set(
    (bindings ?? []).filter((row) => ids.includes(row.binding_id)).map((row) => row.workspace_identity),
  );
  if (identities.size !== ids.length)
    throw new Error(`devices must bind their own workspace identity, saw ${JSON.stringify([...identities])}`);
  return Object.fromEntries(deviceIds.map((deviceId, index) => [deviceId, ids[index]]));
}

/** D1 reads (no writes) of devices and live+removed bindings for the given devices. */
export async function readDeviceBindings(server, orgId, deviceIds) {
  const list = deviceIds.map((id) => `'${id}'`).join(",");
  const devices = await server.rows(
    `SELECT device_id, status FROM devices WHERE org_id='${orgId}' AND device_id IN (${list})`,
    "race devices",
  );
  const bindings = await server.rows(
    `SELECT binding_id, project_id, device_id, workspace_identity, removed_at, created_at
       FROM workspace_bindings WHERE org_id='${orgId}' AND device_id IN (${list})`,
    "race device workspace bindings",
  );
  return { devices, bindings };
}
