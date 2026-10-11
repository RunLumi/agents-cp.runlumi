#!/usr/bin/env node
// Phase 2 workspace hostile probe — S4 explicit rebind and S5 tombstone removal.
//
// WHAT THIS IS
//
// A real-HTTP, real-Worker, real-D1 probe for two candidate Phase 2 server changes:
//   S4  P08-CR-002  `POST /orgs/{org}/adoption/bindings` with `rebind_version`
//   S5  P03-CR-003  migration 0026: unbinding tombstones a workspace binding (`removed_at`)
// The claims it grades are tabled in docs/verification/phase02-workspace-hostile-probe.md and
// mirrored in CLAIMS below; a unit test keeps the two identical.
//
// HOW A VERDICT IS REACHED
//
//   * Every hostile refusal is ONE request, never retried, graded on stored state measured before
//     and after (adoption row, adoption events, security events, outbox, idempotency records and a
//     digest of every workspace_bindings row). A status code alone is never the verdict.
//   * Every hostile claim rests on a control: either the same route and fixture succeed first, or
//     the same request is refused for a DIFFERENT reason before the state change and for the
//     attributed reason after it. A failed control marks its dependants BLOCKED, not PASS.
//   * Fixtures use public routes only: real users, org, projects, agents, device enrollment with a
//     real Ed25519 proof of possession, device bindings, sessions, runs, automations. D1 is read
//     for evidence. The one D1 write is the `plan` entitlement row that v01-lease-contention-probe
//     seeds so `claim` is not refused for entitlement; it is an entitlement fixture, not execution
//     authority, and the control claim on the live-pinned sibling proves the path is entitled.
//   * Exit 0 only when every table claim PASSed. 1 on any FAIL. 2 on BLOCKED/UNPROVEN/harness failure.
//
// Usage (the harness allocates its own port; never start a Worker on it yourself):
//   node apps/api/scripts/phase02-workspace-hostile-probe.mjs

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ClaimLedger,
  STATUS,
  assertSafeId,
  bindingIdsOf,
  digestFromD1Row,
  digestSql,
  digestsUnchanged,
  isTombstoneTimestamp,
  makeDeviceIdentity,
  policyProjectIds,
  sourceLineContaining,
} from "./lib/phase02-workspace-probe-support.mjs";
import { DISPATCH_GUARD_CLAIMS, runDispatchGuards } from "./lib/phase02-dispatch-guards.mjs";
import { runProbe } from "./lib/smoke-harness.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const automationsRepositorySource = join(scriptDir, "..", "src", "repositories", "automations.rs");

const projectsRouteSource = join(scriptDir, "..", "src", "routes", "projects.rs");

// The one injected fault (see S5-T9). A trigger that aborts the policy-snapshot INSERT, so the
// admin unbind commits and only its post-commit policy refresh fails. It is dropped in `finally`.
const REFRESH_FAULT_TRIGGER = "p02ws_fault_policy_refresh";

const CLAIMS = [
  { id: "S4-C1", text: "real chain reaches rollback with bound ids cleared" },
  { id: "S4-C2", text: "exact-version rebind persists and matches the response" },
  { id: "S4-C3", text: "rebind commits one event of each kind; replay adds nothing" },
  { id: "S4-C4", text: "second rollback clears ids again; P03 binding untouched" },
  { id: "S4-H1", text: "stale rebind_version refused, zero side effects" },
  { id: "S4-H2", text: "non-unbound-local record refused, zero side effects" },
  { id: "S4-H3", text: "revoked device refused only after revocation, zero side effects" },
  { id: "S4-H4", text: "removed / wrong-project / wrong-identity binding refused" },
  { id: "S4-H5", text: "cross-org live binding refused without an existence oracle" },
  { id: "S4-H6", text: "cross-tenant caller cannot rebind another org's record" },
  { id: "S4-H7", text: "transport guards refuse with zero side effects" },
  { id: "S5-C1", text: "binding live before removal; pinned fixtures exist" },
  { id: "S5-T1", text: "DELETE tombstones the row instead of deleting it" },
  { id: "S5-T2", text: "historical references survive with no orphan" },
  { id: "S5-T3", text: "device-initiated removal hides the binding everywhere" },
  { id: "S5-T4", text: "admin-initiated removal tombstones and hides it, incl. policy" },
  { id: "S5-T5", text: "a removed binding authorizes no new session/run/automation" },
  { id: "S5-T6", text: "due work pinned to a removed binding is not offered" },
  { id: "S5-T7", text: "claim of an occurrence pinned to a removed binding is refused" },
  { id: "S5-T8", text: "explicit rebind creates a new id; old id stays tombstoned" },
  {
    id: "S5-T9",
    text: "same-key replay after a post-commit policy refresh failure repairs the policy",
  },
  { id: "S5-H1", text: "other device/org cannot remove; second removal does not re-stamp" },
  ...DISPATCH_GUARD_CLAIMS,
];

const anonJar = () => ({ header: () => "" });

await runProbe("Phase 2 workspace hostile (S4 rebind, S5 tombstone)", async (probe) => {
  const { request, d1Rows, browserMutation, browserHeaders } = probe;
  const ledger = new ClaimLedger(CLAIMS);

  console.log("");
  await probe.setup({ persistEnvVar: "P02WS_PERSIST_TO", portEnvVar: "P02WS_PORT" });

  // ---------------------------------------------------------------- helpers -------------
  let seq = 0;
  const mut = (jar, label) => browserMutation(jar, `${label}-${++seq}`);
  const hex32 = () => randomBytes(16).toString("hex");

  /** One assertion, printed by the harness and recorded against exactly one table claim. */
  const check = (id, name, condition, detail = "") => {
    probe.expect(`${id} ${name}`, Boolean(condition), detail);
    if (condition) ledger.pass(id, name);
    else ledger.fail(id, `${name} -- ${detail}`);
    return Boolean(condition);
  };
  const block = (ids, why) => {
    for (const id of ids) {
      ledger.block(id, why);
      probe.skip(`${id} BLOCKED`, why);
    }
  };
  const statusOk = (res, statuses, reasons = []) => probe.statusIs(res, statuses, reasons);
  const brief = (res) =>
    `status=${res.status} reason=${probe.reasonOf(res)} body=${probe.brief(res.payload, 200)}`;
  const first = async (sql, label) => (await d1Rows(sql, label))[0];
  const count = async (sql, label) => Number((await first(sql, label))?.n ?? -1);

  const snapshot = async (adoptionStateId, orgId, label) =>
    digestFromD1Row(await first(digestSql({ adoptionStateId, orgId }), label));

  /**
   * One refusal, graded on state. `makeRequest` is called exactly once.
   * `ignore` names digest fields this refusal may legitimately move (e.g. a denied-access event).
   */
  async function refusal(id, name, ctx, makeRequest, { statuses, reasons = [], ignore = [] }) {
    const before = await snapshot(ctx.adoptionId, ctx.orgId, `${id} ${name} before`);
    const res = await makeRequest();
    const after = await snapshot(ctx.adoptionId, ctx.orgId, `${id} ${name} after`);
    check(
      id,
      `${name}: refused ${statuses.join("/")}${reasons.length ? ` ${reasons.join("/")}` : ""}`,
      statusOk(res, statuses, reasons),
      brief(res),
    );
    const verdict = digestsUnchanged(before, after, { ignore });
    check(
      id,
      `${name}: stored state unchanged`,
      verdict.unchanged,
      `changed=${JSON.stringify(verdict.changed)} before=${probe.brief(before, 300)} after=${probe.brief(after, 300)}`,
    );
    return res;
  }

  // ---- device identity (real Ed25519 proof of possession) -------------------------------
  async function enrollDevice(admin, label) {
    const identity = makeDeviceIdentity(label);
    const begin = await request(anonJar(), "POST", "/api/v1/devices/enrollments", {
      org_slug: admin.orgSlug,
      public_key: identity.publicKeyPem,
      key_fingerprint: identity.keyFingerprint,
      device_name: `P02WS ${label}`,
      platform: "darwin-arm64",
      app_version: "0.5.0",
    });
    const enrollmentId = begin.payload?.enrollment_id;
    if (begin.status !== 201 || typeof enrollmentId !== "string")
      return { error: `begin ${brief(begin)}` };
    const approve = await request(
      admin.jar,
      "POST",
      `/api/v1/orgs/${admin.orgId}/devices/enrollments/${enrollmentId}/approve`,
      {},
      mut(admin.jar, `approve-${label}`),
    );
    if (approve.status !== 201) return { error: `approve ${brief(approve)}` };
    const challenge = await request(
      anonJar(),
      "GET",
      `/api/v1/devices/enrollments/${enrollmentId}`,
    );
    if (typeof challenge.payload?.challenge !== "string")
      return { error: `challenge ${brief(challenge)}` };
    const done = await request(
      anonJar(),
      "POST",
      `/api/v1/devices/enrollments/${enrollmentId}/complete`,
      { signature: identity.sign(challenge.payload.challenge) },
    );
    const token = done.payload?.device_token;
    const deviceId = done.payload?.device?.id;
    if (done.status !== 201 || typeof token !== "string" || typeof deviceId !== "string") {
      return { error: `complete ${brief(done)}` };
    }
    probe.registerSecret(token);
    return { ...identity, token, deviceId, orgId: admin.orgId };
  }
  const bearer = (device) => ({ Authorization: `DeviceToken ${device.token}` });
  const deviceMut = (device, label) => ({
    ...bearer(device),
    "Idempotency-Key": probe.idempotencyKey(`${label}-${++seq}`),
  });
  const deviceGet = (device, path) => request(anonJar(), "GET", path, undefined, bearer(device));

  async function bindWorkspace(device, projectId, identity, label) {
    const res = await request(
      anonJar(),
      "POST",
      "/api/v1/devices/bindings",
      {
        project_id: projectId,
        workspace_identity: identity,
        display_name: `P02WS ${label}`,
        environment_type: "local",
      },
      bearer(device),
    );
    return { res, id: res.payload?.id };
  }

  // ---- fixtures -------------------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const orgA = await probe.createOrganization(alice.jar, "P02WS Org A", `p02ws-a-${probe.nonce}`);
  const bob = await probe.authenticatedUser("Bob");
  const orgB = await probe.createOrganization(bob.jar, "P02WS Org B", `p02ws-b-${probe.nonce}`);
  const slugOf = async (orgId) =>
    (
      await first(
        `SELECT slug FROM organizations WHERE org_id = '${assertSafeId(orgId, "org")}'`,
        "org slug",
      )
    )?.slug;
  const A = { jar: alice.jar, orgId: orgA.orgId, orgSlug: await slugOf(orgA.orgId) };
  const B = { jar: bob.jar, orgId: orgB.orgId, orgSlug: await slugOf(orgB.orgId) };

  const makeProject = async (admin, name) => {
    const res = await request(
      admin.jar,
      "POST",
      `/api/v1/orgs/${admin.orgId}/projects`,
      { name, slug: `${name}-${probe.nonce}`.toLowerCase().slice(0, 60), visibility: "org" },
      mut(admin.jar, `project-${name}`),
    );
    return res.status === 201 ? res.payload.id : null;
  };
  const PA = await makeProject(A, "p02ws-pa");
  const PA2 = await makeProject(A, "p02ws-pa2");
  const PS = await makeProject(A, "p02ws-ps");
  const PL = await makeProject(A, "p02ws-pl");
  const PC = await makeProject(A, "p02ws-pc");
  const PB = await makeProject(B, "p02ws-pb");
  const dev1 = await enrollDevice(A, "dev1");
  const dev2 = await enrollDevice(A, "dev2");
  const dev3 = await enrollDevice(A, "dev3");
  const devB = await enrollDevice(B, "devB");
  const fixtureOk =
    [PA, PA2, PS, PL, PC, PB].every(Boolean) &&
    [dev1, dev2, dev3, devB].every((d) => d && !d.error);
  console.log(
    `  fixtures: projects ${[PA, PA2, PS, PL, PC, PB].map(Boolean)}; devices ` +
      `${[dev1, dev2, dev3, devB].map((d) => (d?.error ? `ERR(${d.error})` : Boolean(d)))}`,
  );
  if (!fixtureOk) {
    probe.fail(
      "fixtures: public-route fixtures could not be built, nothing below can be interpreted",
    );
    block(
      CLAIMS.map((c) => c.id),
      "fixture chain failed",
    );
    return finish(ledger, probe);
  }

  // =====================================================================================
  // S4 — explicit rebind
  // =====================================================================================
  probe.stage = "s4";
  const installation = `inst_p02ws${probe.nonce}`.slice(0, 40);
  const adoptionBody = (key, extra = {}) => ({
    installation_id: installation,
    workspace_key: key,
    display_name: `P02WS ${key}`.slice(0, 60),
    stage: "local_unmanaged",
    credential_mode: "local_credential",
    client_protocol_major: 1,
    policy_schema_version: 1,
    client_app_version: "1.0.0",
    ...extra,
  });
  const adoptionsPath = `/api/v1/orgs/${A.orgId}/adoption/bindings`;
  const createAdoption = async (key, extra = {}) => {
    const res = await request(
      A.jar,
      "POST",
      adoptionsPath,
      adoptionBody(key, extra),
      mut(A.jar, `adopt-${key}`),
    );
    return { res, id: res.payload?.adoption_state_id };
  };
  const readRow = async (id) =>
    first(
      `SELECT stage, ownership, credential_mode, bound_project_id, bound_device_id, version, ` +
        `reversion_count, rolled_back_from_stage, external_workspace_key FROM workspace_adoption_states ` +
        `WHERE adoption_state_id = '${assertSafeId(id, "adoption")}'`,
      `adoption row ${id}`,
    );
  const patchStage = async (id, stage, version) =>
    request(
      A.jar,
      "PATCH",
      `${adoptionsPath}/${id}`,
      {
        stage,
        version,
        client_protocol_major: 1,
        policy_schema_version: 1,
        client_app_version: "1.0.0",
      },
      mut(A.jar, `patch-${stage}`),
    );
  const rollbackAdoption = async (id, version) =>
    request(A.jar, "POST", `${adoptionsPath}/${id}/rollback`, { version }, mut(A.jar, "rollback"));
  const rebindRequest = (key, { project, device, version, mode = "local_credential" }, headers) =>
    request(
      A.jar,
      "POST",
      adoptionsPath,
      adoptionBody(key, {
        project_id: project,
        device_id: device,
        credential_mode: mode,
        rebind_version: version,
      }),
      headers,
    );
  const rebindMut = (key, args) => rebindRequest(key, args, mut(A.jar, `rebind-${key}`));

  // ---- the shared workspace identity, live in BOTH orgs (the cross-org hostile fixture) ---
  const W = `ws-main-${probe.nonce}`;
  const bMain = await bindWorkspace(dev1, PA, W, "main");
  const bForeign = await bindWorkspace(devB, PB, W, "foreign-same-identity");
  check(
    "S4-C1",
    "control: org A live binding and org B live binding with the SAME workspace identity both created",
    bMain.res.status === 201 && bForeign.res.status === 201,
    `A=${brief(bMain.res)} B=${brief(bForeign.res)}`,
  );

  // ---- S4-C1: the real chain -------------------------------------------------------------
  const main = await createAdoption(W, { project_id: PA, device_id: dev1.deviceId });
  let s4Ready = bMain.res.status === 201 && bForeign.res.status === 201 && main.res.status === 201;
  check(
    "S4-C1",
    "control: adoption record created bound to project and device (stage 0)",
    main.res.status === 201,
    brief(main.res),
  );
  let version = 1;
  if (s4Ready) {
    for (const stage of [
      "account_optional",
      "device_enrolled",
      "workspace_bound",
      "managed_policy",
    ]) {
      const step = await patchStage(main.id, stage, version);
      const ok = check("S4-C1", `control: advance to ${stage}`, step.status === 200, brief(step));
      if (!ok) {
        s4Ready = false;
        break;
      }
      version += 1;
    }
  }
  if (s4Ready) {
    const managed = await readRow(main.id);
    check(
      "S4-C1",
      "control: D1 holds managed_policy / bound ids / expected version",
      managed?.stage === "managed_policy" &&
        managed?.bound_project_id === PA &&
        managed?.bound_device_id === dev1.deviceId &&
        Number(managed?.version) === version,
      probe.brief(managed, 300),
    );

    // H2 (managed + bound): the same well-formed rebind a client would send, at the wrong stage.
    await refusal(
      "S4-H2",
      "rebind at managed_policy with bound ids",
      { adoptionId: main.id, orgId: A.orgId },
      () => rebindMut(W, { project: PA, device: dev1.deviceId, version }),
      { statuses: [409], reasons: ["adoption_rebind_not_allowed"] },
    );

    const rolled = await rollbackAdoption(main.id, version);
    check("S4-C1", "control: rollback is accepted", rolled.status === 200, brief(rolled));
    version += 1;
    const local = await readRow(main.id);
    check(
      "S4-C1",
      "control: rollback cleared both bound ids and returned to local / local_credential",
      local?.stage === "local_unmanaged" &&
        local?.ownership === "local_unmanaged" &&
        local?.credential_mode === "local_credential" &&
        local?.bound_project_id === null &&
        local?.bound_device_id === null &&
        Number(local?.version) === version &&
        Number(local?.reversion_count) === 1 &&
        local?.rolled_back_from_stage === "managed_policy",
      probe.brief(local, 300),
    );
    s4Ready = rolled.status === 200 && local?.bound_project_id === null;
  }
  if (!s4Ready) {
    block(
      ["S4-C2", "S4-C3", "S4-C4", "S4-H1", "S4-H2", "S4-H3", "S4-H4", "S4-H5", "S4-H6", "S4-H7"],
      "the S4 control chain (live binding -> managed -> rollback) did not complete",
    );
  } else {
    const ctx = { adoptionId: main.id, orgId: A.orgId };
    const goodArgs = (v) => ({ project: PA, device: dev1.deviceId, version: v });

    // ---- H1 stale versions --------------------------------------------------------------
    await refusal(
      "S4-H1",
      "stale rebind_version (below)",
      ctx,
      () => rebindMut(W, goodArgs(version - 1)),
      { statuses: [409], reasons: ["version_conflict"] },
    );
    await refusal(
      "S4-H1",
      "stale rebind_version (above)",
      ctx,
      () => rebindMut(W, goodArgs(version + 4)),
      { statuses: [409], reasons: ["version_conflict"] },
    );

    // ---- H2 non-local credential mode in an otherwise valid rebind ----------------------
    await refusal(
      "S4-H2",
      "non-local credential mode in a rebind body",
      ctx,
      () => rebindMut(W, { ...goodArgs(version), mode: "metadata_only" }),
      { statuses: [409], reasons: ["adoption_rebind_not_allowed"] },
    );

    // ---- H4 wrong project: live binding exists only for PA ------------------------------
    await refusal(
      "S4-H4",
      "binding exists for a different project",
      ctx,
      () => rebindMut(W, { project: PA2, device: dev1.deviceId, version }),
      { statuses: [404], reasons: ["workspace_binding_not_found"] },
    );

    // ---- H5 cross-org: org B's project/device/binding all live with the SAME identity ---
    const nonexistent = { project: `prj_${hex32()}`, device: `dvc_${hex32()}` };
    const xProject = await refusal(
      "S4-H5",
      "org B project + org B device named from org A",
      ctx,
      () => rebindMut(W, { project: PB, device: devB.deviceId, version }),
      { statuses: [404] },
    );
    const xDevice = await refusal(
      "S4-H5",
      "org A project + org B device",
      ctx,
      () => rebindMut(W, { project: PA, device: devB.deviceId, version }),
      { statuses: [404] },
    );
    const ghostProject = await refusal(
      "S4-H5",
      "nonexistent project (oracle baseline)",
      ctx,
      () => rebindMut(W, { project: nonexistent.project, device: dev1.deviceId, version }),
      { statuses: [404] },
    );
    const ghostDevice = await refusal(
      "S4-H5",
      "nonexistent device (oracle baseline)",
      ctx,
      () => rebindMut(W, { project: PA, device: nonexistent.device, version }),
      { statuses: [404] },
    );
    check(
      "S4-H5",
      "no existence oracle: a real org B project is refused exactly like a nonexistent project",
      xProject.status === ghostProject.status &&
        probe.reasonOf(xProject) === probe.reasonOf(ghostProject),
      `cross-org=${brief(xProject)} nonexistent=${brief(ghostProject)}`,
    );
    check(
      "S4-H5",
      "no existence oracle: a real org B device is refused exactly like a nonexistent device",
      xDevice.status === ghostDevice.status &&
        probe.reasonOf(xDevice) === probe.reasonOf(ghostDevice),
      `cross-org=${brief(xDevice)} nonexistent=${brief(ghostDevice)}`,
    );
    check(
      "S4-H5",
      "org B holds no adoption row after the cross-org attempts",
      (await count(
        `SELECT COUNT(*) AS n FROM workspace_adoption_states WHERE org_id = '${assertSafeId(B.orgId, "org")}'`,
        "org B adoption rows",
      )) === 0,
    );

    // ---- H6 cross-tenant caller ---------------------------------------------------------
    const crossBody = adoptionBody(W, {
      project_id: PA,
      device_id: dev1.deviceId,
      rebind_version: version,
    });
    await refusal(
      "S4-H6",
      "org B principal on org A's route",
      ctx,
      () => request(B.jar, "POST", adoptionsPath, crossBody, mut(B.jar, "rebind-b-on-a")),
      { statuses: [401, 403, 404], ignore: ["security_events"] },
    );
    await refusal(
      "S4-H6",
      "org B principal on org B's own route (A's record must be unreachable)",
      ctx,
      () =>
        request(
          B.jar,
          "POST",
          `/api/v1/orgs/${B.orgId}/adoption/bindings`,
          crossBody,
          mut(B.jar, "rebind-b-on-b"),
        ),
      { statuses: [404], reasons: ["adoption_not_found"] },
    );

    // ---- H7 transport guards ------------------------------------------------------------
    const full = adoptionBody(W, {
      project_id: PA,
      device_id: dev1.deviceId,
      rebind_version: version,
    });
    await refusal(
      "S4-H7",
      "no CSRF token",
      ctx,
      () =>
        request(A.jar, "POST", adoptionsPath, full, {
          "Idempotency-Key": probe.idempotencyKey(`nocsrf-${++seq}`),
        }),
      { statuses: [403], ignore: ["security_events"] },
    );
    await refusal(
      "S4-H7",
      "no Idempotency-Key",
      ctx,
      () => request(A.jar, "POST", adoptionsPath, full, browserHeaders(A.jar)),
      { statuses: [400, 422], ignore: ["security_events"] },
    );
    await refusal("S4-H7", "rebind_version 0", ctx, () => rebindMut(W, goodArgs(0)), {
      statuses: [422],
    });
    await refusal("S4-H7", "rebind_version negative", ctx, () => rebindMut(W, goodArgs(-3)), {
      statuses: [422],
    });
    await refusal(
      "S4-H7",
      "rebind_version for an unknown workspace",
      ctx,
      () =>
        request(
          A.jar,
          "POST",
          adoptionsPath,
          adoptionBody(`ws-unknown-${probe.nonce}`, {
            project_id: PA,
            device_id: dev1.deviceId,
            rebind_version: 1,
          }),
          mut(A.jar, "rebind-unknown"),
        ),
      { statuses: [404], reasons: ["adoption_not_found"] },
    );

    // ---- C2 / C3: the exact-version rebind, then replay ---------------------------------
    const before = await snapshot(main.id, A.orgId, "pre-rebind");
    const key = probe.idempotencyKey(`rebind-success-${++seq}`);
    const headers = {
      "X-CSRF-Token": A.jar.cookies.get("lumi_csrf") ?? "",
      "Idempotency-Key": key,
    };
    const ok = await rebindRequest(W, goodArgs(version), headers);
    const afterOk = await snapshot(main.id, A.orgId, "post-rebind");
    check("S4-C2", "exact-version rebind answers 200", ok.status === 200, brief(ok));
    const rowOk = await readRow(main.id);
    check(
      "S4-C2",
      "D1 holds the rebound row: ids set, still local, version+1, history retained",
      rowOk?.bound_project_id === PA &&
        rowOk?.bound_device_id === dev1.deviceId &&
        rowOk?.stage === "local_unmanaged" &&
        rowOk?.ownership === "local_unmanaged" &&
        rowOk?.credential_mode === "local_credential" &&
        Number(rowOk?.version) === version + 1 &&
        Number(rowOk?.reversion_count) === 1 &&
        rowOk?.external_workspace_key === W,
      probe.brief(rowOk, 300),
    );
    check(
      "S4-C2",
      "the response equals the stored row (id, ids, version, stage)",
      ok.payload?.adoption_state_id === main.id &&
        ok.payload?.bound_project_id === PA &&
        ok.payload?.bound_device_id === dev1.deviceId &&
        Number(ok.payload?.version) === version + 1 &&
        ok.payload?.stage === "local_unmanaged",
      probe.brief(ok.payload, 300),
    );
    const delta = (field) => Number(afterOk[field]) - Number(before[field]);
    check(
      "S4-C3",
      "exactly +1 stage event, +1 security event, +1 outbox row, +1 idempotency record",
      delta("adoption_events") === 1 &&
        delta("security_events") === 1 &&
        delta("outbox_events") === 1 &&
        delta("idempotency_records") === 1,
      `deltas events=${delta("adoption_events")} security=${delta("security_events")} outbox=${delta("outbox_events")} idem=${delta("idempotency_records")}`,
    );
    const lastSecurity = await first(
      `SELECT action, outcome FROM security_events WHERE resource_id = '${main.id}' ORDER BY created_at DESC, event_id DESC LIMIT 1`,
      "last security event",
    );
    check(
      "S4-C3",
      "the security event is adoption.rebound / success",
      lastSecurity?.action === "adoption.rebound" && lastSecurity?.outcome === "success",
      probe.brief(lastSecurity),
    );
    const lastOutbox = await first(
      `SELECT event_type, instr(envelope_json, '"rebound":true') > 0 AS rebound FROM outbox_events ` +
        `WHERE organization_id = '${A.orgId}' ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
      "last outbox event",
    );
    check(
      "S4-C3",
      "the outbox row is adoption.workspace_recorded.v1 with rebound:true",
      lastOutbox?.event_type === "adoption.workspace_recorded.v1" &&
        Number(lastOutbox?.rebound) === 1,
      probe.brief(lastOutbox),
    );
    const stageEvent = await first(
      `SELECT stage, result FROM adoption_stage_events WHERE adoption_state_id = '${main.id}' ORDER BY created_at DESC, adoption_event_id DESC LIMIT 1`,
      "last stage event",
    );
    check(
      "S4-C3",
      "the stage event is local_unmanaged / completed",
      stageEvent?.stage === "local_unmanaged" && stageEvent?.result === "completed",
      probe.brief(stageEvent),
    );

    // One deliberate idempotent replay and one key-reuse conflict. Single-shot, not retries.
    const replay = await rebindRequest(W, goodArgs(version), headers);
    const afterReplay = await snapshot(main.id, A.orgId, "post-replay");
    check(
      "S4-C3",
      "replay of the same key returns the stored response",
      replay.status === 200 && JSON.stringify(replay.payload) === JSON.stringify(ok.payload),
      `first=${probe.brief(ok.payload, 160)} replay=${probe.brief(replay.payload, 160)}`,
    );
    check(
      "S4-C3",
      "replay changes nothing",
      digestsUnchanged(afterOk, afterReplay).unchanged,
      JSON.stringify(digestsUnchanged(afterOk, afterReplay).changed),
    );
    const conflict = await rebindRequest(W, goodArgs(version + 1), headers);
    const afterConflict = await snapshot(main.id, A.orgId, "post-key-reuse");
    check(
      "S4-C3",
      "same key with a different body is refused 409 and changes nothing",
      conflict.status === 409 && digestsUnchanged(afterReplay, afterConflict).unchanged,
      `${brief(conflict)} ${JSON.stringify(digestsUnchanged(afterReplay, afterConflict).changed)}`,
    );
    version += 1;

    // ---- C4: second rollback --------------------------------------------------------------
    const bindingsBefore = (await snapshot(main.id, A.orgId, "pre-rollback-2")).bindings;
    const rolled2 = await rollbackAdoption(main.id, version);
    const row2 = await readRow(main.id);
    const bindingsAfter = (await snapshot(main.id, A.orgId, "post-rollback-2")).bindings;
    check(
      "S4-C4",
      "a second rollback after rebind is accepted and clears both ids again",
      rolled2.status === 200 &&
        row2?.bound_project_id === null &&
        row2?.bound_device_id === null &&
        Number(row2?.reversion_count) === 2 &&
        Number(row2?.version) === version + 1,
      `${brief(rolled2)} ${probe.brief(row2, 240)}`,
    );
    check(
      "S4-C4",
      "rollback left every P03 binding row byte-identical (the live binding is not removed)",
      bindingsBefore === bindingsAfter,
      `before=${bindingsBefore.slice(0, 120)} after=${bindingsAfter.slice(0, 120)}`,
    );
    const stillLive = await first(
      `SELECT removed_at FROM workspace_bindings WHERE binding_id = '${assertSafeId(bMain.id, "binding")}'`,
      "main binding liveness",
    );
    check(
      "S4-C4",
      "the P03 binding is still live (removed_at NULL) after rollback",
      stillLive?.removed_at === null,
      probe.brief(stillLive),
    );

    // ---- H4 removed binding and wrong identity (own records, never-rolled-back, version 1) -
    const wRm = `ws-removed-${probe.nonce}`;
    const bRm = await bindWorkspace(dev1, PA, wRm, "to-remove");
    const recRm = await createAdoption(wRm);
    if (bRm.res.status === 201 && recRm.res.status === 201) {
      const rmCtx = { adoptionId: recRm.id, orgId: A.orgId };
      await refusal(
        "S4-H4",
        "differential pre-removal: stale version while the binding is live",
        rmCtx,
        () => rebindMut(wRm, { project: PA, device: dev1.deviceId, version: 2 }),
        { statuses: [409], reasons: ["version_conflict"] },
      );
      const del = await request(
        anonJar(),
        "DELETE",
        `/api/v1/devices/bindings/${bRm.id}`,
        undefined,
        bearer(dev1),
      );
      check(
        "S4-H4",
        "control: the device removes the binding (204)",
        del.status === 204,
        brief(del),
      );
      await refusal(
        "S4-H4",
        "correct version, binding now removed",
        rmCtx,
        () => rebindMut(wRm, { project: PA, device: dev1.deviceId, version: 1 }),
        { statuses: [404], reasons: ["workspace_binding_not_found"] },
      );
    } else {
      block(
        ["S4-H4"],
        `removed-binding fixture failed: bind=${brief(bRm.res)} record=${brief(recRm.res)}`,
      );
    }
    const wNone = `ws-never-bound-${probe.nonce}`;
    const recNone = await createAdoption(wNone);
    if (recNone.res.status === 201) {
      await refusal(
        "S4-H4",
        "workspace identity the device never bound",
        { adoptionId: recNone.id, orgId: A.orgId },
        () => rebindMut(wNone, { project: PA, device: dev1.deviceId, version: 1 }),
        { statuses: [404], reasons: ["workspace_binding_not_found"] },
      );
    } else block(["S4-H4"], `never-bound fixture failed: ${brief(recNone.res)}`);

    // ---- H2 stage account_optional (unbound) and stage 0 still bound ---------------------
    const wAcct = `ws-acct-${probe.nonce}`;
    const bAcct = await bindWorkspace(dev1, PA, wAcct, "acct");
    const recAcct = await createAdoption(wAcct);
    if (bAcct.res.status === 201 && recAcct.res.status === 201) {
      const adv = await patchStage(recAcct.id, "account_optional", 1);
      if (adv.status === 200) {
        await refusal(
          "S4-H2",
          "rebind at account_optional (valid live binding)",
          { adoptionId: recAcct.id, orgId: A.orgId },
          () => rebindMut(wAcct, { project: PA, device: dev1.deviceId, version: 2 }),
          { statuses: [409], reasons: ["adoption_rebind_not_allowed"] },
        );
      } else block(["S4-H2"], `could not advance the account_optional fixture: ${brief(adv)}`);
    } else
      block(
        ["S4-H2"],
        `account_optional fixture failed: ${brief(bAcct.res)} ${brief(recAcct.res)}`,
      );
    const wS0 = `ws-s0bound-${probe.nonce}`;
    const bS0 = await bindWorkspace(dev1, PA, wS0, "s0bound");
    const recS0 = await createAdoption(wS0, { project_id: PA, device_id: dev1.deviceId });
    if (bS0.res.status === 201 && recS0.res.status === 201) {
      await refusal(
        "S4-H2",
        "rebind of a stage-0 record that is still bound",
        { adoptionId: recS0.id, orgId: A.orgId },
        () => rebindMut(wS0, { project: PA, device: dev1.deviceId, version: 1 }),
        { statuses: [409], reasons: ["adoption_rebind_not_allowed"] },
      );
    } else block(["S4-H2"], `stage-0 bound fixture failed: ${brief(bS0.res)} ${brief(recS0.res)}`);

    // ---- H3 revoked device: differential ------------------------------------------------
    const wRev = `ws-revoked-${probe.nonce}`;
    const bRev = await bindWorkspace(dev2, PA, wRev, "revoked-device");
    const recRev = await createAdoption(wRev);
    if (bRev.res.status === 201 && recRev.res.status === 201) {
      const revCtx = { adoptionId: recRev.id, orgId: A.orgId };
      await refusal(
        "S4-H3",
        "differential pre-revocation: stale version, device active",
        revCtx,
        () => rebindMut(wRev, { project: PA, device: dev2.deviceId, version: 2 }),
        { statuses: [409], reasons: ["version_conflict"] },
      );
      const revoke = await request(
        A.jar,
        "DELETE",
        `/api/v1/orgs/${A.orgId}/devices/${dev2.deviceId}`,
        {},
        mut(A.jar, "revoke-dev2"),
      );
      const stored = await first(
        `SELECT status FROM devices WHERE device_id = '${dev2.deviceId}'`,
        "device status",
      );
      check(
        "S4-H3",
        "control: the device is revoked in D1",
        revoke.status === 204 && stored?.status === "revoked",
        `${brief(revoke)} status=${stored?.status}`,
      );
      await refusal(
        "S4-H3",
        "correct version, device now revoked",
        revCtx,
        () => rebindMut(wRev, { project: PA, device: dev2.deviceId, version: 1 }),
        { statuses: [404], reasons: ["device_not_found"] },
      );
    } else
      block(["S4-H3"], `revoked-device fixture failed: ${brief(bRev.res)} ${brief(recRev.res)}`);
  }

  // =====================================================================================
  // S5 — tombstone removal
  // =====================================================================================
  probe.stage = "s5";
  // Device tokens live 15 minutes and S4 runs many wrangler reads; renew through the real
  // proof-of-possession refresh (nonce, then a signature over it) before S5 uses them.
  const renewDevice = async (device) => {
    const nonce = await deviceGet(device, "/api/v1/devices/token/nonce");
    const renewed =
      typeof nonce.payload?.nonce === "string"
        ? await request(
            anonJar(),
            "POST",
            "/api/v1/devices/token",
            {
              device_id: device.deviceId,
              nonce: nonce.payload.nonce,
              signature: device.sign(nonce.payload.nonce),
              app_version: "0.5.0",
            },
            bearer(device),
          )
        : nonce;
    if (typeof renewed.payload?.device_token !== "string") {
      probe.fail(
        `${device.label}: device token refresh failed, S5 cannot be interpreted`,
        brief(renewed),
      );
      return false;
    }
    probe.registerSecret(renewed.payload.device_token);
    device.token = renewed.payload.device_token;
    return true;
  };
  for (const device of [dev1, dev3]) {
    if (!(await renewDevice(device))) {
      block(
        CLAIMS.filter((c) => c.id.startsWith("S5-") || c.id.startsWith("S6-")).map((c) => c.id),
        "device token refresh failed",
      );
      return finish(ledger, probe);
    }
  }
  const agentFor = async (projectId, name) => {
    const res = await request(
      A.jar,
      "POST",
      `/api/v1/orgs/${A.orgId}/agents`,
      { name, project_id: projectId },
      mut(A.jar, `agent-${name}`),
    );
    return res.payload?.id ?? res.payload?.agent?.id;
  };
  const agentS = await agentFor(PS, `p02ws-agent-s-${probe.nonce}`);
  const agentL = await agentFor(PL, `p02ws-agent-l-${probe.nonce}`);
  // Entitlement fixture only (same row v01-lease-contention-probe seeds), see the header.
  const grantId = `egr_${createHash("sha256").update(`${probe.nonce}-p02ws`).digest("hex").slice(0, 32)}`;
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  await d1Rows(
    `INSERT INTO entitlement_grants (grant_id, org_id, entitlement_key, scope, value_json, source, effective_at, created_at, updated_at) ` +
      `VALUES ('${grantId}', '${A.orgId}', 'automations.max_active', 'organization', '5', 'plan', '${stamp}', '${stamp}', '${stamp}')`,
    "entitlement fixture",
  );

  const bS5 = await bindWorkspace(dev1, PS, `ws-s5-${probe.nonce}`, "s5-removed");
  const bLive = await bindWorkspace(dev1, PL, `ws-live-${probe.nonce}`, "s5-live-sibling");
  const listIds = async () =>
    bindingIdsOf((await deviceGet(dev1, "/api/v1/devices/bindings")).payload);
  const adminIds = async (projectId) =>
    bindingIdsOf(
      (await request(A.jar, "GET", `/api/v1/orgs/${A.orgId}/projects/${projectId}/bindings`))
        .payload,
    );
  const policyProjects = async () =>
    policyProjectIds((await deviceGet(dev1, "/api/v1/devices/policy")).payload);

  let s5Ready = [bS5.res, bLive.res].every((r) => r.status === 201) && Boolean(agentS && agentL);
  let ids = { session: null, run: null, autoR: null, autoL: null, occR: null, occL: null };
  if (s5Ready) {
    const dl = await listIds();
    const al = await adminIds(PS);
    const pol = await policyProjects();
    check(
      "S5-C1",
      "control: binding is in the device list, the admin project list and the device policy",
      dl.includes(bS5.id) && al.includes(bS5.id) && pol?.includes(PS),
      `device=${dl.includes(bS5.id)} admin=${al.includes(bS5.id)} policy=${JSON.stringify(pol)}`,
    );
    const session = await request(
      anonJar(),
      "POST",
      "/api/v1/devices/sessions",
      {
        project_id: PS,
        agent_definition_id: agentS,
        workspace_binding_id: bS5.id,
        external_id: `p02ws-${probe.nonce}`,
        title: "P02WS pinned session",
      },
      deviceMut(dev1, "session"),
    );
    ids.session = session.payload?.id ?? session.payload?.agent_session_id;
    const run = ids.session
      ? await request(
          anonJar(),
          "POST",
          `/api/v1/devices/sessions/${ids.session}/runs`,
          { execution_mode: "local_only", input_ref: `local://p02ws/${probe.nonce}` },
          deviceMut(dev1, "run"),
        )
      : null;
    ids.run = run?.payload?.id ?? run?.payload?.run_id;
    check(
      "S5-C1",
      "control: a session and a local_only run are created pinned to the live binding",
      session.status === 201 && run?.status === 201,
      `session=${brief(session)} run=${run ? brief(run) : "not attempted"}`,
    );
    const mkAutomation = async (projectId, agentId, bindingId, name) => {
      const res = await request(
        A.jar,
        "POST",
        `/api/v1/orgs/${A.orgId}/automations`,
        {
          name,
          project_id: projectId,
          agent_definition_id: agentId,
          execution_principal: { kind: "user" },
          target: { kind: "eligible_device", workspace_binding_id: bindingId },
          schedule: { kind: "manual" },
          execution_policy: {},
        },
        mut(A.jar, name),
      );
      const id = res.payload?.automation?.automation_id ?? res.payload?.automation_id;
      if (!id) return { res };
      const v = Number(
        (
          await first(
            `SELECT version FROM automation_definitions WHERE automation_id = '${assertSafeId(id, "automation")}'`,
            "automation version",
          )
        )?.version ?? 1,
      );
      const now = await request(
        A.jar,
        "POST",
        `/api/v1/orgs/${A.orgId}/automations/${id}/run-now`,
        { version: v },
        mut(A.jar, `runnow-${name}`),
      );
      return {
        res,
        id,
        occurrence: now.payload?.occurrence?.occurrence_id ?? now.payload?.occurrence_id,
        runNow: now,
      };
    };
    const autoR = await mkAutomation(PS, agentS, bS5.id, `p02ws-auto-removed-${probe.nonce}`);
    const autoL = await mkAutomation(PL, agentL, bLive.id, `p02ws-auto-live-${probe.nonce}`);
    ids = {
      ...ids,
      autoR: autoR.id,
      autoL: autoL.id,
      occR: autoR.occurrence,
      occL: autoL.occurrence,
    };
    check(
      "S5-C1",
      "control: two pinned automations (to-be-removed, live sibling) each have an occurrence",
      Boolean(autoR.id && autoL.id && autoR.occurrence && autoL.occurrence),
      `removed=${autoR.res ? brief(autoR.res) : ""} live=${autoL.res ? brief(autoL.res) : ""}`,
    );
    s5Ready = Boolean(ids.run && ids.occR && ids.occL) && session.status === 201;
  } else {
    probe.fail(
      "S5 fixtures: bindings/agents could not be created",
      `bind=${brief(bS5.res)} live=${brief(bLive.res)} agents=${Boolean(agentS)}/${Boolean(agentL)}`,
    );
    ledger.fail("S5-C1", "S5 fixture bindings or agents could not be created");
  }
  if (!s5Ready) {
    block(
      ["S5-T1", "S5-T2", "S5-T3", "S5-T4", "S5-T5", "S5-T6", "S5-T7", "S5-T8", "S5-T9", "S5-H1"],
      "the S5 positive controls (live binding, pinned run, pinned occurrences) did not complete",
    );
    return finish(ledger, probe);
  }

  // ---- due-list positive control (needs the occurrences dispatched by the real sweep) ------
  const occIn = `'${assertSafeId(ids.occR, "occ")}','${assertSafeId(ids.occL, "occ")}'`;
  const stateOf = async () =>
    d1Rows(
      `SELECT occurrence_id, state, state_version FROM automation_occurrences WHERE occurrence_id IN (${occIn})`,
      "occurrence states",
    );
  let dispatching = false;
  for (let attempt = 0; attempt < 24 && !dispatching; attempt += 1) {
    const rows = await stateOf();
    dispatching = rows.length === 2 && rows.every((row) => row.state === "dispatching");
    if (!dispatching) {
      await probe.triggerSweep();
      await delay(2_000);
    }
  }
  const dueIds = async () => {
    const res = await deviceGet(dev1, "/api/v1/devices/automations/due");
    return {
      res,
      ids: Array.isArray(res.payload?.items)
        ? res.payload.items.map((i) => i.occurrence_id ?? i.id)
        : null,
    };
  };
  let dueControl = false;
  if (dispatching) {
    const due = await dueIds();
    dueControl =
      due.res.status === 200 && due.ids?.includes(ids.occR) && due.ids?.includes(ids.occL);
    check(
      "S5-T6",
      "control: before removal the due list offers BOTH pinned occurrences",
      dueControl,
      brief(due.res),
    );
    // The dispatcher's own durable footprint, measured after two MORE sweeps so a republish or a
    // redelivery would have had the chance to run twice: each job row is terminal `succeeded` (claim
    // and completion landed with the occurrence write), and each occurrence carries exactly ONE
    // `dispatched` lifecycle event at state_version 2 (the version guard and job claim absorb a repeat).
    await probe.triggerSweep();
    await delay(2_000);
    await probe.triggerSweep();
    await delay(2_000);
    const jobsAfter = await d1Rows(
      `SELECT subject_id, state, last_error_code FROM queue_job_envelopes WHERE job_type = 'automation.dispatch' AND subject_id IN (${occIn})`,
      "dispatch jobs after dispatch",
    );
    check(
      "S5-T6",
      "dispatch: both automation.dispatch jobs are succeeded with no error code",
      jobsAfter.length === 2 &&
        jobsAfter.every((j) => j.state === "succeeded" && !j.last_error_code),
      probe.brief(jobsAfter),
    );
    const dispatched = await d1Rows(
      `SELECT o.occurrence_id, o.state_version, (SELECT COUNT(*) FROM outbox_events e WHERE e.event_type = 'automation.occurrence.dispatched.v1' AND instr(e.envelope_json, o.occurrence_id) > 0) AS events FROM automation_occurrences o WHERE o.occurrence_id IN (${occIn})`,
      "dispatched events",
    );
    check(
      "S5-T6",
      "dispatch dedupe: exactly one dispatched event per occurrence and one state_version step",
      dispatched.length === 2 &&
        dispatched.every((r) => Number(r.events) === 1 && Number(r.state_version) === 2),
      probe.brief(dispatched),
    );
    if (!dueControl && due.res.status >= 500) {
      const src = sourceLineContaining(
        readFileSync(automationsRepositorySource, "utf8"),
        "ORDER BY o.scheduled_for_ ",
      );
      console.log(
        `  SOURCE FACT (not a runtime result): ${src ? `repositories/automations.rs:${src.line}: ${src.text}` : "no 'scheduled_for_ ' ORDER BY found"}`,
      );
      console.log(
        `  Worker lines naming a cause:\n${(probe.workerConsole(4000) ?? "")
          .split("\n")
          .filter((l) => /error|no such|SQLITE|p06_/i.test(l))
          .slice(-14)
          .map((l) => `    ${l.slice(0, 220)}`)
          .join("\n")}`,
      );
    }
  } else {
    // The stall is diagnosed from MEASURED queue state, never assumed: where did each occurrence's
    // `automation.dispatch` job envelope stop? The occurrence is never moved by the probe.
    const envelopes = await d1Rows(
      `SELECT subject_id, job_type, state, attempt, lease_version, last_error_code, next_attempt_at FROM queue_job_envelopes WHERE subject_id IN (${occIn})`,
      "dispatch job envelopes",
    );
    // `attempt = 1, lease_version = 0, state = queued` is the INITIAL row written by the producing
    // mutation (INSERT_QUEUE_JOB_SQL). A row alone cannot prove a publish did or did not happen, so
    // the diagnosis only reports whether the row ever left its initial values; the Worker's own
    // `p06_*` lines below are the evidence about publish and consume.
    const untouched =
      envelopes.length === 2 &&
      envelopes.every(
        (e) =>
          e.job_type === "automation.dispatch" &&
          e.state === "queued" &&
          Number(e.attempt) === 1 &&
          Number(e.lease_version) === 0 &&
          !e.last_error_code,
      );
    const diagnosis = untouched
      ? "each automation.dispatch row still has its initial values (queued, attempt 1, lease_version 0, no error): no consumer claim happened"
      : "the job rows left their initial values; inspect state, lease_version, last_error_code and the Worker lines";
    console.log(
      `  Worker p06 lines:\n${(probe.workerConsole(8000) ?? "")
        .split("\n")
        .filter((l) => /p06_/i.test(l))
        .slice(-14)
        .map((l) => `    ${l.slice(0, 220)}`)
        .join("\n")}`,
    );
    block(
      ["S5-T6"],
      `occurrences never reached dispatching through the real sweep within 48s: states=${probe.brief(await stateOf(), 300)} envelopes=${probe.brief(envelopes, 300)}; ${diagnosis}`,
    );
  }

  // ---- T1: device-initiated removal ------------------------------------------------------
  probe.stage = "s5-remove";
  const columns =
    "binding_id, org_id, project_id, device_id, workspace_identity, display_name, environment_type, last_seen_at, created_at";
  const rowBefore = await first(
    `SELECT ${columns}, removed_at FROM workspace_bindings WHERE binding_id = '${assertSafeId(bS5.id, "binding")}'`,
    "S5 binding before",
  );
  const totalBefore = await count(
    "SELECT COUNT(*) AS n FROM workspace_bindings",
    "binding total before",
  );
  const refsBefore = await first(
    `SELECT (SELECT workspace_binding_id FROM runs WHERE run_id = '${assertSafeId(ids.run, "run")}') AS run_ref, ` +
      `(SELECT workspace_binding_id FROM agent_sessions WHERE agent_session_id = '${assertSafeId(ids.session, "session")}') AS session_ref, ` +
      `(SELECT target_workspace_binding_id FROM automation_definitions WHERE automation_id = '${assertSafeId(ids.autoR, "automation")}') AS automation_ref`,
    "references before",
  );
  const sessionCountBefore = await count(
    "SELECT COUNT(*) AS n FROM agent_sessions",
    "sessions before",
  );
  const runCountBefore = await count("SELECT COUNT(*) AS n FROM runs", "runs before");
  const autoCountBefore = await count(
    "SELECT COUNT(*) AS n FROM automation_definitions",
    "automations before",
  );
  check(
    "S5-T1",
    "control: the row is live before removal (removed_at NULL) and every reference points at it",
    rowBefore?.removed_at === null &&
      refsBefore?.run_ref === bS5.id &&
      refsBefore?.session_ref === bS5.id &&
      refsBefore?.automation_ref === bS5.id,
    `${probe.brief(rowBefore, 200)} ${probe.brief(refsBefore, 240)}`,
  );

  const del = await request(
    anonJar(),
    "DELETE",
    `/api/v1/devices/bindings/${bS5.id}`,
    undefined,
    bearer(dev1),
  );
  check("S5-T1", "DELETE /devices/bindings/{id} answers 204", del.status === 204, brief(del));
  const rowAfter = await first(
    `SELECT ${columns}, removed_at FROM workspace_bindings WHERE binding_id = '${bS5.id}'`,
    "S5 binding after",
  );
  const totalAfter = await count(
    "SELECT COUNT(*) AS n FROM workspace_bindings",
    "binding total after",
  );
  const sameColumns = rowAfter && columns.split(", ").every((c) => rowAfter[c] === rowBefore[c]);
  check(
    "S5-T1",
    "the row REMAINS with the same id and every column unchanged except the tombstone",
    Boolean(rowAfter) && sameColumns && totalAfter === totalBefore,
    `after=${probe.brief(rowAfter, 240)} total ${totalBefore}->${totalAfter}`,
  );
  check(
    "S5-T1",
    "removed_at is a 24-character timestamp",
    isTombstoneTimestamp(rowAfter?.removed_at),
    `removed_at=${rowAfter?.removed_at}`,
  );

  // ---- T2: historical references ---------------------------------------------------------
  const refsAfter = await first(
    `SELECT (SELECT workspace_binding_id FROM runs WHERE run_id = '${ids.run}') AS run_ref, ` +
      `(SELECT workspace_binding_id FROM agent_sessions WHERE agent_session_id = '${ids.session}') AS session_ref, ` +
      `(SELECT target_workspace_binding_id FROM automation_definitions WHERE automation_id = '${ids.autoR}') AS automation_ref`,
    "references after",
  );
  check(
    "S5-T2",
    "run, session and automation still carry the original binding id",
    refsAfter?.run_ref === bS5.id &&
      refsAfter?.session_ref === bS5.id &&
      refsAfter?.automation_ref === bS5.id,
    probe.brief(refsAfter, 240),
  );
  const orphans = await first(
    `SELECT (SELECT COUNT(*) FROM runs r LEFT JOIN workspace_bindings b ON b.binding_id = r.workspace_binding_id WHERE r.workspace_binding_id IS NOT NULL AND b.binding_id IS NULL) AS runs, ` +
      `(SELECT COUNT(*) FROM agent_sessions s LEFT JOIN workspace_bindings b ON b.binding_id = s.workspace_binding_id WHERE s.workspace_binding_id IS NOT NULL AND b.binding_id IS NULL) AS sessions, ` +
      `(SELECT COUNT(*) FROM automation_definitions d LEFT JOIN workspace_bindings b ON b.binding_id = d.target_workspace_binding_id WHERE d.target_workspace_binding_id IS NOT NULL AND b.binding_id IS NULL) AS automations`,
    "orphan join",
  );
  check(
    "S5-T2",
    "no orphaned reference in runs, agent_sessions or automation_definitions (join, not PRAGMA)",
    Number(orphans?.runs) === 0 &&
      Number(orphans?.sessions) === 0 &&
      Number(orphans?.automations) === 0,
    probe.brief(orphans),
  );
  const runRead = await deviceGet(dev1, `/api/v1/devices/runs/${ids.run}`);
  check(
    "S5-T2",
    "the run is still readable through the device route with its original binding id",
    runRead.status === 200 && runRead.payload?.workspace_binding_id === bS5.id,
    brief(runRead),
  );

  // ---- T3: hidden everywhere (device-initiated) ------------------------------------------
  const dl2 = await listIds();
  const al2 = await adminIds(PS);
  const pol2 = await policyProjects();
  check(
    "S5-T3",
    "absent from the device list, the admin project list and the device policy bindings",
    !dl2.includes(bS5.id) && !al2.includes(bS5.id) && Array.isArray(pol2) && !pol2.includes(PS),
    `device=${dl2.includes(bS5.id)} admin=${al2.includes(bS5.id)} policy=${JSON.stringify(pol2)}`,
  );
  check(
    "S5-T3",
    "positive control: the live sibling is still listed and still in policy",
    dl2.includes(bLive.id) && Array.isArray(pol2) && pol2.includes(PL),
    `live listed=${dl2.includes(bLive.id)} policy=${JSON.stringify(pol2)}`,
  );

  // ---- T5: nothing new is authorized by the removed binding ------------------------------
  const newSession = await request(
    anonJar(),
    "POST",
    "/api/v1/devices/sessions",
    {
      project_id: PS,
      agent_definition_id: agentS,
      workspace_binding_id: bS5.id,
      external_id: `p02ws-new-${probe.nonce}`,
    },
    deviceMut(dev1, "session-removed"),
  );
  const newRun = await request(
    anonJar(),
    "POST",
    `/api/v1/devices/sessions/${ids.session}/runs`,
    { execution_mode: "local_only", input_ref: `local://p02ws/${probe.nonce}/after` },
    deviceMut(dev1, "run-removed"),
  );
  const newAutomation = await request(
    A.jar,
    "POST",
    `/api/v1/orgs/${A.orgId}/automations`,
    {
      name: `p02ws-auto-after-${probe.nonce}`,
      project_id: PS,
      agent_definition_id: agentS,
      execution_principal: { kind: "user" },
      target: { kind: "eligible_device", workspace_binding_id: bS5.id },
      schedule: { kind: "manual" },
      execution_policy: {},
    },
    mut(A.jar, "automation-removed"),
  );
  check(
    "S5-T5",
    "a new session naming the removed binding is refused 4xx",
    statusOk(newSession, [403, 404, 409, 422]),
    brief(newSession),
  );
  check(
    "S5-T5",
    "a new run on the pre-existing pinned session is refused 4xx",
    statusOk(newRun, [403, 404, 409, 422]),
    brief(newRun),
  );
  check(
    "S5-T5",
    "a new automation targeting the removed binding is refused 4xx",
    statusOk(newAutomation, [403, 404, 409, 422]),
    brief(newAutomation),
  );
  check(
    "S5-T5",
    "no new session, run or automation row was created",
    (await count("SELECT COUNT(*) AS n FROM agent_sessions", "sessions after")) ===
      sessionCountBefore &&
      (await count("SELECT COUNT(*) AS n FROM runs", "runs after")) === runCountBefore &&
      (await count("SELECT COUNT(*) AS n FROM automation_definitions", "automations after")) ===
        autoCountBefore,
  );

  // ---- T6: due list after removal ---------------------------------------------------------
  if (dueControl) {
    const due = await dueIds();
    check(
      "S5-T6",
      "after removal the pinned occurrence is NOT offered",
      due.res.status === 200 && !due.ids?.includes(ids.occR),
      brief(due.res),
    );
    check(
      "S5-T6",
      "positive control: the live-pinned sibling occurrence IS still offered",
      due.ids?.includes(ids.occL),
      `ids=${JSON.stringify(due.ids)}`,
    );
  } else if (dispatching) {
    block(
      ["S5-T6"],
      "the due-list positive control failed, so absence after removal is uninterpretable",
    );
  }

  // ---- T7: claim -------------------------------------------------------------------------
  const claimPath = (occ) => `/api/v1/devices/automation-occurrences/${occ}/claim`;
  const occBefore = await first(
    `SELECT state, state_version FROM automation_occurrences WHERE occurrence_id = '${ids.occR}'`,
    "removed-pinned occurrence before",
  );
  const claimRemoved = await request(
    anonJar(),
    "POST",
    claimPath(ids.occR),
    undefined,
    bearer(dev1),
  );
  const occAfter = await first(
    `SELECT state, state_version FROM automation_occurrences WHERE occurrence_id = '${ids.occR}'`,
    "removed-pinned occurrence after",
  );
  const leases = await count(
    `SELECT COUNT(*) AS n FROM automation_leases WHERE occurrence_id = '${ids.occR}'`,
    "leases on removed-pinned occurrence",
  );
  check(
    "S5-T7",
    "claim of the occurrence pinned to the REMOVED binding is refused (4xx)",
    claimRemoved.status >= 400 && claimRemoved.status < 500,
    brief(claimRemoved),
  );
  check(
    "S5-T7",
    "no lease row and the occurrence state is unchanged",
    leases === 0 && JSON.stringify(occBefore) === JSON.stringify(occAfter),
    `leases=${leases} before=${probe.brief(occBefore)} after=${probe.brief(occAfter)}`,
  );
  const claimLive = await request(anonJar(), "POST", claimPath(ids.occL), undefined, bearer(dev1));
  // The one-time lease token is a credential: register it before anything about the claim is printed.
  if (typeof claimLive.payload?.lease_token === "string")
    probe.registerSecret(claimLive.payload.lease_token);
  check(
    "S5-T7",
    "positive control: the same claim for the LIVE-pinned sibling succeeds (2xx)",
    claimLive.status >= 200 && claimLive.status < 300,
    brief(claimLive),
  );
  const mintedLeaseToken = claimLive.payload?.lease_token;
  check(
    "S5-T7",
    "redaction canary: the minted lease token is registered by the harness and absent from the printable claim text",
    typeof mintedLeaseToken === "string" &&
      mintedLeaseToken.length >= 32 &&
      !probe.redact(claimLive.text).includes(mintedLeaseToken) &&
      !brief(claimLive).includes(mintedLeaseToken),
    "token value never printed",
  );

  // ---- T8: explicit rebind creates a new id ---------------------------------------------
  const identityS5 = rowBefore.workspace_identity;
  const rebound = await bindWorkspace(dev1, PS, identityS5, "s5-rebound");
  const dup = await bindWorkspace(dev1, PS, identityS5, "s5-duplicate-live");
  const pair = await first(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END) AS live FROM workspace_bindings ` +
      `WHERE device_id = '${dev1.deviceId}' AND workspace_identity = '${identityS5.replace(/'/g, "''")}'`,
    "identity pair",
  );
  const dl3 = await listIds();
  check(
    "S5-T8",
    "explicit rebind is 201 with a NEW id; the old id is not reused",
    rebound.res.status === 201 && rebound.id && rebound.id !== bS5.id,
    brief(rebound.res),
  );
  check(
    "S5-T8",
    "a duplicate live bind is 409 workspace_binding_conflict",
    statusOk(dup.res, [409], ["workspace_binding_conflict"]),
    brief(dup.res),
  );
  check(
    "S5-T8",
    "exactly one live and two total rows for the (device, identity) pair",
    Number(pair?.live) === 1 && Number(pair?.total) === 2,
    probe.brief(pair),
  );
  check(
    "S5-T8",
    "the old id stays tombstoned and unlisted; the new id is listed",
    !dl3.includes(bS5.id) && dl3.includes(rebound.id),
    `listed=${JSON.stringify(dl3)}`,
  );

  // ---- T4: admin-initiated removal incl. policy ---------------------------------------
  probe.stage = "s5-admin-remove";
  const bAdmin = await bindWorkspace(dev1, PC, `ws-admin-${probe.nonce}`, "s5-admin-removed");
  const polBeforeAdmin = bAdmin.res.status === 201 ? await policyProjects() : null;
  if (bAdmin.res.status === 201 && polBeforeAdmin?.includes(PC)) {
    const adminDel = await request(
      A.jar,
      "DELETE",
      `/api/v1/orgs/${A.orgId}/projects/${PC}/bindings/${bAdmin.id}`,
      undefined,
      mut(A.jar, "admin-delete"),
    );
    const stored = await first(
      `SELECT removed_at FROM workspace_bindings WHERE binding_id = '${bAdmin.id}'`,
      "admin-removed row",
    );
    const dl4 = await listIds();
    const al4 = await adminIds(PC);
    const pol4 = await policyProjects();
    check(
      "S5-T4",
      "admin DELETE answers 204 and TOMBSTONES the row (not deleted)",
      adminDel.status === 204 && isTombstoneTimestamp(stored?.removed_at),
      `${brief(adminDel)} stored=${probe.brief(stored)}`,
    );
    check(
      "S5-T4",
      "absent from the device list and the admin project list",
      !dl4.includes(bAdmin.id) && !al4.includes(bAdmin.id),
      `device=${dl4.includes(bAdmin.id)} admin=${al4.includes(bAdmin.id)}`,
    );
    check(
      "S5-T4",
      "absent from the DEVICE POLICY projects.bindings",
      Array.isArray(pol4) && !pol4.includes(PC),
      `policy=${JSON.stringify(pol4)}`,
    );
  } else {
    block(
      ["S5-T4"],
      `admin-removal control failed: bind=${brief(bAdmin.res)} policy before=${JSON.stringify(polBeforeAdmin)}`,
    );
  }

  // ---- T9: same-key replay after a post-commit policy refresh failure --------------------
  // The unbind commits, then `refresh_policy_snapshot` runs. If that refresh fails after the commit,
  // the idempotency record already holds a stored success; a retry with the same key must still leave
  // the device policy without the removed binding. The fault is ONE trigger on policy_snapshots (a
  // harness affordance: it changes no product code, grants no authority and is dropped below).
  probe.stage = "s5-refresh-fault";
  const bFault = await bindWorkspace(dev1, PC, `ws-fault-${probe.nonce}`, "s5-refresh-fault");
  const polBeforeFault = bFault.res.status === 201 ? await policyProjects() : null;
  if (bFault.res.status === 201 && polBeforeFault?.includes(PC)) {
    const orgSql = assertSafeId(A.orgId, "org");
    const bindingSql = assertSafeId(bFault.id, "binding");
    const removedEvents = () =>
      count(
        `SELECT COUNT(*) AS n FROM outbox_events WHERE organization_id = '${orgSql}' AND event_type = 'project.binding_removed.v1' AND instr(envelope_json, '${bindingSql}') > 0`,
        "binding_removed events",
      );
    const snapshots = () =>
      count(
        `SELECT COUNT(*) AS n FROM policy_snapshots WHERE org_id = '${orgSql}'`,
        "policy snapshot rows",
      );
    const snapshotsBefore = await snapshots();
    const deleteHeaders = mut(A.jar, "admin-delete-refresh-fault");
    const deletePath = `/api/v1/orgs/${A.orgId}/projects/${PC}/bindings/${bFault.id}`;
    let firstDelete = null;
    let faultError = null;
    try {
      await d1Rows(
        `CREATE TRIGGER ${REFRESH_FAULT_TRIGGER} BEFORE INSERT ON policy_snapshots BEGIN SELECT RAISE(ABORT, 'p02ws injected policy refresh fault'); END`,
        "install refresh fault",
      );
      firstDelete = await request(A.jar, "DELETE", deletePath, undefined, deleteHeaders);
    } catch (error) {
      faultError = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        await d1Rows(`DROP TRIGGER IF EXISTS ${REFRESH_FAULT_TRIGGER}`, "remove refresh fault");
      } catch (error) {
        faultError = `${faultError ?? ""} fault trigger could not be dropped: ${error instanceof Error ? error.message : error}`;
      }
    }
    const triggerLeft = await count(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = '${REFRESH_FAULT_TRIGGER}'`,
      "fault trigger left",
    );
    const storedAfterFirst = await first(
      `SELECT removed_at FROM workspace_bindings WHERE binding_id = '${bindingSql}'`,
      "fault-removed row",
    );
    const polAfterFirst = await policyProjects();
    const faultTook =
      !faultError &&
      triggerLeft === 0 &&
      firstDelete !== null &&
      firstDelete.status >= 500 &&
      isTombstoneTimestamp(storedAfterFirst?.removed_at) &&
      Array.isArray(polAfterFirst) &&
      polAfterFirst.includes(PC);
    const faultDetail = `error=${faultError ?? "none"} first=${firstDelete ? brief(firstDelete) : "not sent"} stored=${probe.brief(storedAfterFirst)} policy=${JSON.stringify(polAfterFirst)} triggerLeft=${triggerLeft}`;
    if (faultTook) {
      check(
        "S5-T9",
        "control: with the refresh faulted the unbind answers 5xx AFTER the tombstone committed, policy still lists the project, and the fault is removed",
        true,
        faultDetail,
      );
      const eventsAfterFirst = await removedEvents();
      const replay = await request(A.jar, "DELETE", deletePath, undefined, deleteHeaders);
      const storedAfterReplay = await first(
        `SELECT removed_at FROM workspace_bindings WHERE binding_id = '${bindingSql}'`,
        "fault-removed row after replay",
      );
      const polAfterReplay = await policyProjects();
      const eventsAfterReplay = await removedEvents();
      const snapshotsAfter = await snapshots();
      check(
        "S5-T9",
        "the same-key replay answers the stored 204",
        replay.status === 204,
        brief(replay),
      );
      check(
        "S5-T9",
        "the committed tombstone is neither undone nor re-stamped",
        storedAfterReplay?.removed_at === storedAfterFirst?.removed_at,
        `${probe.brief(storedAfterFirst)} -> ${probe.brief(storedAfterReplay)}`,
      );
      const repaired = check(
        "S5-T9",
        "after the replay the device policy no longer lists the removed binding's project",
        Array.isArray(polAfterReplay) && !polAfterReplay.includes(PC),
        `policy=${JSON.stringify(polAfterReplay)}`,
      );
      check(
        "S5-T9",
        "no duplicate event: exactly one binding_removed outbox row, and exactly one new policy snapshot for the removal",
        eventsAfterFirst === 1 && eventsAfterReplay === 1 && snapshotsAfter - snapshotsBefore === 1,
        `removed events ${eventsAfterFirst}->${eventsAfterReplay} snapshots ${snapshotsBefore}->${snapshotsAfter}`,
      );
      if (!repaired) {
        const early = sourceLineContaining(
          readFileSync(projectsRouteSource, "utf8"),
          "PreparedScopedMutation::Replay(replay) => return",
        );
        console.log(
          `  SOURCE FACT (not a runtime result): ${early ? `routes/projects.rs:${early.line}: ${early.text}` : "no early replay return found in routes/projects.rs"}`,
        );
      }
    } else {
      block(
        ["S5-T9"],
        `the injected refresh fault did not behave as a post-commit failure, so a replay result would be uninterpretable: ${faultDetail}`,
      );
    }
  } else {
    block(
      ["S5-T9"],
      `refresh-fault control failed: bind=${brief(bFault.res)} policy before=${JSON.stringify(polBeforeFault)}`,
    );
  }

  // ---- H1: other device / other org / second removal -------------------------------------
  probe.stage = "s5-hostile-removal";
  const liveBefore = await first(
    `SELECT removed_at, updated_at FROM workspace_bindings WHERE binding_id = '${bLive.id}'`,
    "live sibling before attacks",
  );
  const byDevice = await request(
    anonJar(),
    "DELETE",
    `/api/v1/devices/bindings/${bLive.id}`,
    undefined,
    bearer(dev3),
  );
  const byOrgB = await request(
    B.jar,
    "DELETE",
    `/api/v1/orgs/${B.orgId}/projects/${PL}/bindings/${bLive.id}`,
    undefined,
    mut(B.jar, "b-deletes-a-binding"),
  );
  const byOrgBOnA = await request(
    B.jar,
    "DELETE",
    `/api/v1/orgs/${A.orgId}/projects/${PL}/bindings/${bLive.id}`,
    undefined,
    mut(B.jar, "b-deletes-a-binding-on-a"),
  );
  const liveAfter = await first(
    `SELECT removed_at, updated_at FROM workspace_bindings WHERE binding_id = '${bLive.id}'`,
    "live sibling after attacks",
  );
  check(
    "S5-H1",
    "another device in the same org cannot remove it (404)",
    byDevice.status === 404,
    brief(byDevice),
  );
  check(
    "S5-H1",
    "an org B admin cannot remove it through org B's path (404) or org A's path (401/403/404)",
    byOrgB.status === 404 && [401, 403, 404].includes(byOrgBOnA.status),
    `${brief(byOrgB)} | ${brief(byOrgBOnA)}`,
  );
  check(
    "S5-H1",
    "the live binding row is unchanged (removed_at NULL, updated_at identical)",
    liveBefore?.removed_at === null && JSON.stringify(liveBefore) === JSON.stringify(liveAfter),
    `${probe.brief(liveBefore)} -> ${probe.brief(liveAfter)}`,
  );
  const stampBefore = await first(
    `SELECT removed_at, updated_at FROM workspace_bindings WHERE binding_id = '${bS5.id}'`,
    "tombstone before 2nd removal",
  );
  const second = await request(
    anonJar(),
    "DELETE",
    `/api/v1/devices/bindings/${bS5.id}`,
    undefined,
    bearer(dev1),
  );
  const stampAfter = await first(
    `SELECT removed_at, updated_at FROM workspace_bindings WHERE binding_id = '${bS5.id}'`,
    "tombstone after 2nd removal",
  );
  check(
    "S5-H1",
    "a second removal of the tombstone is 404 and does not re-stamp removed_at",
    second.status === 404 && JSON.stringify(stampBefore) === JSON.stringify(stampAfter),
    `${brief(second)} ${probe.brief(stampBefore)} -> ${probe.brief(stampAfter)}`,
  );

  // ---- S6: dispatch consumer guards (P06-CR-009) -------------------------------------------
  probe.stage = "s6-dispatch-guards";
  await runDispatchGuards({
    probe,
    check,
    block,
    request,
    mut,
    bearer,
    deviceMut,
    anonJar,
    first,
    d1Rows,
    brief,
    A,
    B,
    dev: dev1,
    project: PL,
    agent: agentL,
    binding: bLive.id,
    renewDevice,
  });

  return finish(ledger, probe);
});

function finish(ledger, probe) {
  console.log("\nClaim ledger (PASS only if every assertion under the claim held):");
  for (const { id, status } of ledger.summary()) {
    const claim = CLAIMS.find((c) => c.id === id);
    console.log(`  ${status.padEnd(8)} ${id}  ${claim.text}`);
  }
  const code = ledger.exitCode();
  const notPassed = ledger
    .summary()
    .filter((c) => c.status !== STATUS.PASS)
    .map((c) => `${c.id}=${c.status}`);
  if (probe.failures.length > 0 && code === 0) {
    probe.finish(1, "an assertion failed outside the claim table");
  }
  // runProbe calls finish(1|0) from the assertion tally when the body returns; the ledger can only
  // make that stricter, never looser.
  if (code !== 0) probe.finish(code, notPassed.length ? `not PASS: ${notPassed.join(", ")}` : "");
}
