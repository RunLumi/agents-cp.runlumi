#!/usr/bin/env node
// P08-CR-003 reproducer — does a credential-mode-only PATCH persist what it reports?
//
// CLAIM UNDER TEST
//
// P08-CG "Transition rules" 5 and the route comment say a credential-mode-only change
// "still writes ... the stage is unchanged and the version still moves". Source inspection
// of `advance_adoption_stage` (`StageTransition::Unchanged`) says otherwise: the batch holds
// the version guard and the event/audit/outbox rows but no UPDATE, while the response and the
// stored idempotency body claim the new mode and `version + 1`. This probe measures that on a
// real Worker and real D1 instead of trusting the source reading.
//
// EXPECTED RESULT BEFORE THE FIX: the "persisted" and "chained" assertions FAIL, which is the
// preserved failing evidence. After the fix every assertion passes. The positive controls
// (create, a real stage advance, readback) must pass in BOTH states, otherwise a failure
// below proves nothing about the Unchanged branch.
//
// WHAT IS MEASURED, NOT INFERRED
//
//   response body  vs  D1 row  vs  GET list readback  vs  idempotent replay body.
//
// Every comparison reads D1 directly through wrangler; a status code is never the evidence.
//
// WHAT THIS DOES NOT COVER (stays UNPROVEN here)
//
//   * the workspace_bound / managed_policy stages, which need a live P03 project and device
//     binding. The Unchanged branch is stage-independent, so account_optional reproduces the
//     defect; the org_managed_credential success path at a managed stage is a separate control.
//   * the production desktop client path. Run the Electron journey against the same Worker
//     to show the client observes the same mismatch before the fix.
//
// Usage (DO NOT start a Worker of your own on the port it prints):
//   node apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs

import { runProbe } from "./lib/smoke-harness.mjs";

const ID_PATTERN = /^wst_[0-9a-f]{32}$/;
const MODE_ONLY_MODE = "metadata_only";

await runProbe("P08-CR-003 credential-mode-only persistence", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "P08CR003_PERSIST_TO", portEnvVar: "P08CR003_PORT" });

  probe.stage = "fixtures";
  const owner = await probe.authenticatedUser("Owner");
  const org = await probe.createOrganization(owner.jar, "CR003 Org", `cr003-org-${probe.nonce}`);
  const member = await probe.authenticatedUser("Member");
  await probe.inviteAndAccept(owner, member, org.orgId, "member");
  const outsider = await probe.authenticatedUser("Outsider");
  const otherOrg = await probe.createOrganization(
    outsider.jar,
    "CR003 Other Org",
    `cr003-other-${probe.nonce}`,
  );

  const bindings = `/api/v1/orgs/${org.orgId}/adoption/bindings`;
  const patchBody = (stage, mode, version) => ({
    stage,
    ...(mode === undefined ? {} : { credential_mode: mode }),
    version,
    client_protocol_major: 1,
    policy_schema_version: 1,
    client_app_version: "1.0.0",
  });
  const readRow = async (id, label) => {
    if (!ID_PATTERN.test(id)) throw new Error(`${label}: refusing to query a malformed id`);
    const rows = await d1Rows(
      `SELECT stage, ownership, credential_mode, version, reversion_count, updated_at ` +
        `FROM workspace_adoption_states WHERE adoption_state_id = '${id}'`,
      label,
    );
    return rows[0];
  };
  const countRows = async (id, table, label) => {
    const rows = await d1Rows(
      `SELECT COUNT(*) AS n FROM ${table} WHERE adoption_state_id = '${id}'`,
      label,
    );
    return Number(rows[0]?.n ?? -1);
  };
  const readBack = async (id) => {
    const list = await request(owner.jar, "GET", `${bindings}?limit=100`);
    const items = list.payload?.items ?? list.payload?.bindings ?? list.payload?.data ?? [];
    return { list, entry: items.find((item) => item.adoption_state_id === id) };
  };

  // --- positive controls: the route works before the defect is interpreted ------------------
  probe.stage = "controls";
  const created = await request(owner.jar, "POST", bindings, {
    installation_id: `inst_cr003${probe.nonce}`.slice(0, 40),
    workspace_key: `cr003-workspace-${probe.nonce}`.slice(0, 60),
    display_name: "CR003 workspace",
    stage: "local_unmanaged",
    credential_mode: "local_credential",
    client_protocol_major: 1,
    policy_schema_version: 1,
    client_app_version: "1.0.0",
  }, browserMutation(owner.jar, "create"));
  expectStatus("control: a local adoption record is created", created, [200, 201]);
  const id = created.payload?.adoption_state_id;
  if (!ID_PATTERN.test(id ?? "")) {
    probe.fail("control: create returned an adoption_state_id", JSON.stringify(created.payload));
    return;
  }
  const afterCreate = await readRow(id, "row after create");
  expect(
    "control: D1 holds version 1 / local_credential / local_unmanaged",
    afterCreate?.version === 1 &&
      afterCreate?.credential_mode === "local_credential" &&
      afterCreate?.stage === "local_unmanaged",
    JSON.stringify(afterCreate),
  );

  const advance = await request(
    owner.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("account_optional", "local_credential", 1),
    browserMutation(owner.jar, "advance-1"),
  );
  expectStatus("control: a real stage advance succeeds", advance, 200);
  const afterAdvance = await readRow(id, "row after advance");
  expect(
    "control: the advance is persisted (stage account_optional, version 2)",
    afterAdvance?.stage === "account_optional" && afterAdvance?.version === 2,
    JSON.stringify(afterAdvance),
  );

  // --- the reproducer ---------------------------------------------------------------------
  probe.stage = "mode-only";
  const modeKey = probe.idempotencyKey("mode-only");
  const modeRequest = patchBody("account_optional", MODE_ONLY_MODE, 2);
  const first = await request(owner.jar, "PATCH", `${bindings}/${id}`, modeRequest, {
    "X-CSRF-Token": owner.jar.cookies.get("lumi_csrf") ?? "",
    "Idempotency-Key": modeKey,
  });
  expectStatus("mode-only PATCH is accepted", first, 200);
  const stored = await readRow(id, "row after mode-only PATCH");
  const eventsAfterFirst = await countRows(id, "adoption_stage_events", "events after first");
  console.log(`  INFO  response=${JSON.stringify(probe.sanitize(first.payload))}`);
  console.log(`  INFO  d1_row=${JSON.stringify(stored)}`);

  expect(
    "PERSISTED: D1 credential_mode is the requested mode",
    stored?.credential_mode === MODE_ONLY_MODE,
    `d1=${stored?.credential_mode} requested=${MODE_ONLY_MODE}`,
  );
  expect(
    "PERSISTED: D1 version moved to 3 and the stage stayed account_optional",
    stored?.version === 3 && stored?.stage === "account_optional",
    JSON.stringify(stored),
  );
  expect(
    "RESPONSE == STORED: the response mode and version equal the D1 row",
    first.payload?.credential_mode === stored?.credential_mode &&
      first.payload?.version === stored?.version,
    `response=${first.payload?.credential_mode}@${first.payload?.version} d1=${stored?.credential_mode}@${stored?.version}`,
  );

  const { list, entry } = await readBack(id);
  expectStatus("readback: the binding list is served", list, 200);
  expect(
    "READBACK == STORED: the list shows the stored mode and version",
    entry?.credential_mode === stored?.credential_mode && entry?.version === stored?.version,
    `list=${entry?.credential_mode}@${entry?.version} d1=${stored?.credential_mode}@${stored?.version}`,
  );

  // --- idempotent replay ------------------------------------------------------------------
  probe.stage = "replay";
  const replay = await request(owner.jar, "PATCH", `${bindings}/${id}`, modeRequest, {
    "X-CSRF-Token": owner.jar.cookies.get("lumi_csrf") ?? "",
    "Idempotency-Key": modeKey,
  });
  expectStatus("replay with the same key and body is served", replay, 200);
  const afterReplay = await readRow(id, "row after replay");
  const eventsAfterReplay = await countRows(id, "adoption_stage_events", "events after replay");
  expect(
    "REPLAY IDENTICAL: the replayed body equals the first body",
    JSON.stringify(replay.payload) === JSON.stringify(first.payload),
    `first=${JSON.stringify(probe.sanitize(first.payload))} replay=${JSON.stringify(probe.sanitize(replay.payload))}`,
  );
  expect(
    "REPLAY == STORED: the replayed mode and version equal the D1 row",
    replay.payload?.credential_mode === afterReplay?.credential_mode &&
      replay.payload?.version === afterReplay?.version,
    `replay=${replay.payload?.credential_mode}@${replay.payload?.version} d1=${afterReplay?.credential_mode}@${afterReplay?.version}`,
  );
  expect(
    "REPLAY writes nothing: row and event count are unchanged",
    JSON.stringify(afterReplay) === JSON.stringify(stored) && eventsAfterReplay === eventsAfterFirst,
    `events ${eventsAfterFirst} -> ${eventsAfterReplay}`,
  );

  // --- chaining: the client's next PATCH uses the version the response told it ------------
  probe.stage = "chained";
  const chained = await request(
    owner.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("device_enrolled", MODE_ONLY_MODE, first.payload?.version ?? 3),
    browserMutation(owner.jar, "advance-2"),
  );
  expectStatus("CHAINED: the next advance using the response version succeeds", chained, 200);
  const afterChain = await readRow(id, "row after chained advance");
  expect(
    "CHAINED: the advance keeps the stored mode and reaches device_enrolled at version 4",
    afterChain?.stage === "device_enrolled" &&
      afterChain?.credential_mode === MODE_ONLY_MODE &&
      afterChain?.version === 4,
    JSON.stringify(afterChain),
  );

  // --- late replay: the stored response stays the committed version while the row moves on --
  // A replay of the mode-only request after a newer write must return what THAT request
  // committed (version 3), not the current row. A GET may legitimately be newer.
  probe.stage = "late-replay";
  const lateReplay = await request(owner.jar, "PATCH", `${bindings}/${id}`, modeRequest, {
    "X-CSRF-Token": owner.jar.cookies.get("lumi_csrf") ?? "",
    "Idempotency-Key": modeKey,
  });
  expectStatus("a late replay of the mode-only request is served", lateReplay, 200);
  expect(
    "LATE REPLAY STABLE: the replay still equals the first response (committed version 3)",
    JSON.stringify(lateReplay.payload) === JSON.stringify(first.payload) &&
      lateReplay.payload?.version === 3,
    `first=${first.payload?.version} late=${lateReplay.payload?.version}`,
  );
  const lateRead = await readBack(id);
  expect(
    "NEWER GET: the list legitimately shows the newer version, not the replayed one",
    lateRead.entry?.version === afterChain?.version && afterChain?.version > 3,
    `list=${lateRead.entry?.version} d1=${afterChain?.version}`,
  );

  // --- same-mode no-op (D-a): nothing written, nothing emitted, idempotency retained ------
  probe.stage = "noop";
  const noopKey = probe.idempotencyKey("noop");
  const noopRequest = patchBody("device_enrolled", MODE_ONLY_MODE, afterChain?.version ?? 4);
  const noopHeaders = {
    "X-CSRF-Token": owner.jar.cookies.get("lumi_csrf") ?? "",
    "Idempotency-Key": noopKey,
  };
  const noopEventsBefore = await countRows(id, "adoption_stage_events", "events before no-op");
  const noop = await request(owner.jar, "PATCH", `${bindings}/${id}`, noopRequest, noopHeaders);
  expectStatus("a same-stage same-mode PATCH is accepted", noop, 200);
  const afterNoop = await readRow(id, "row after no-op");
  const noopEvents = await countRows(id, "adoption_stage_events", "events after no-op");
  expect(
    "NO-OP writes nothing: row unchanged, no version increment, no stage event",
    JSON.stringify(afterNoop) === JSON.stringify(afterChain) && noopEvents === noopEventsBefore,
    `row=${JSON.stringify(afterNoop)} events ${noopEventsBefore} -> ${noopEvents}`,
  );
  expect(
    "NO-OP does not fabricate a version: the body equals the stored row",
    noop.payload?.version === afterNoop?.version &&
      noop.payload?.credential_mode === afterNoop?.credential_mode &&
      noop.payload?.stage === afterNoop?.stage,
    JSON.stringify(probe.sanitize(noop.payload)),
  );
  const noopReplay = await request(owner.jar, "PATCH", `${bindings}/${id}`, noopRequest, noopHeaders);
  expect(
    "NO-OP idempotency retained: the replay is identical",
    noopReplay.status === 200 && JSON.stringify(noopReplay.payload) === JSON.stringify(noop.payload),
    `status=${noopReplay.status}`,
  );

  // --- negative contexts: each must refuse and leave D1 untouched -------------------------
  probe.stage = "negatives";
  const before = await readRow(id, "row before negatives");
  const eventsBefore = await countRows(id, "adoption_stage_events", "events before negatives");
  const unchangedAfter = async (name) => {
    const row = await readRow(id, `row after ${name}`);
    const events = await countRows(id, "adoption_stage_events", `events after ${name}`);
    expect(
      `${name}: D1 row and event count are untouched`,
      JSON.stringify(row) === JSON.stringify(before) && events === eventsBefore,
      JSON.stringify(row),
    );
  };

  const orgManagedLocal = await request(
    owner.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("device_enrolled", "org_managed_credential", before.version),
    browserMutation(owner.jar, "neg-org-managed"),
  );
  expectStatus(
    "org_managed_credential at a local stage is refused",
    orgManagedLocal,
    [409, 422],
    ["credential_mode_requires_managed"],
  );
  await unchangedAfter("org_managed_credential at a local stage");

  const stale = await request(
    owner.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("device_enrolled", "local_credential", before.version - 1),
    browserMutation(owner.jar, "neg-stale"),
  );
  // A lost version guard surfaces through `commit_mutation` as `409` with reason `conflict`
  // (BatchOutcome::GuardLost -> domain_error "conflict"); `version_conflict` is not a reason this
  // route emits. The first draft expected `version_conflict`, which was wrong before and after the fix.
  expectStatus("a stale-version mode-only PATCH is refused", stale, 409, ["conflict"]);
  await unchangedAfter("stale version");

  // A stale same-mode re-assertion is still refused: the guard leads the no-op batch too.
  const staleNoop = await request(
    owner.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("device_enrolled", MODE_ONLY_MODE, before.version - 1),
    browserMutation(owner.jar, "neg-stale-noop"),
  );
  expectStatus("a stale same-mode PATCH is refused", staleNoop, 409, ["conflict"]);
  await unchangedAfter("stale same-mode");

  // A guessed future version is refused against the row the route read, not left to a race
  // with a concurrent writer: no claim, no write, no event.
  const futureVersion = await request(
    owner.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("device_enrolled", "local_credential", before.version + 1),
    browserMutation(owner.jar, "neg-future"),
  );
  expectStatus("a future-version PATCH is refused", futureVersion, 409, ["conflict"]);
  await unchangedAfter("future version");

  const asMember = await request(
    member.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("device_enrolled", "local_credential", before.version),
    browserMutation(member.jar, "neg-member"),
  );
  expectStatus("a plain member cannot change the mode (adoption.manage)", asMember, 403);
  await unchangedAfter("member role");

  const crossOrg = await request(
    outsider.jar,
    "PATCH",
    `/api/v1/orgs/${org.orgId}/adoption/bindings/${id}`,
    patchBody("device_enrolled", "local_credential", before.version),
    browserMutation(outsider.jar, "neg-cross-org"),
  );
  expect(
    "another organization's owner cannot reach the record",
    [403, 404].includes(crossOrg.status),
    `status=${crossOrg.status}`,
  );
  await unchangedAfter("cross-organization owner");

  const crossPath = await request(
    outsider.jar,
    "PATCH",
    `/api/v1/orgs/${otherOrg.orgId}/adoption/bindings/${id}`,
    patchBody("device_enrolled", "local_credential", before.version),
    browserMutation(outsider.jar, "neg-cross-path"),
  );
  expect(
    "the record is not reachable through the other organization's own path",
    crossPath.status === 404,
    `status=${crossPath.status}`,
  );
  await unchangedAfter("other-organization path");

  const stageFive = await request(
    owner.jar,
    "PATCH",
    `${bindings}/${id}`,
    patchBody("history_sync", "org_managed_credential", before.version),
    browserMutation(owner.jar, "neg-stage-five"),
  );
  expect(
    "stage 5 stays refused",
    [409, 422].includes(stageFive.status),
    `status=${stageFive.status} reason=${probe.reasonOf(stageFive)}`,
  );
  await unchangedAfter("stage 5");

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
