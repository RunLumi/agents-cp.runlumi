#!/usr/bin/env node
// V01 Budget / cost — attempt to overspend a hard budget under concurrency.
//
// WHY THIS ATTACK IS SHAPED THE WAY IT IS
//
// The ceiling lives in a conditional INSERT (INSERT_RESERVATION_IF_AVAILABLE_SQL in
// `apps/api/src/repositories/budgets.rs`): a single statement whose NOT EXISTS subquery
// compares `limit_minor` against committed usage plus the *outstanding* reservations
// (`reserved_minor - committed_minor`, status 'reserved', not yet expired).
//
// Putting the check in SQL is the right design and it is the only design that can be
// correct under concurrency, because a read-then-write in Rust cannot be. But "the check is
// in one statement" is a claim about the code, and the code is not the system. D1 wraps a
// batch in a transaction, and a deferred transaction lets two writers both read before
// either writes. Whether this particular statement is serialised is a property of the
// runtime, and it has to be measured.
//
// So the attack is: fire N reservations CONCURRENTLY, each asking for an amount such that
// all N together exceed the limit and fewer than N fit, and then read the invariant out of
// the database. Not the statuses -- the statuses can be right while the state is wrong,
// and a probe that checks statuses is checking the easy half.
//
// THE INVARIANT, STATED ONCE
//
//   For a hard budget: SUM(reserved_minor - committed_minor) over live 'reserved' rows
//   must never exceed limit_minor.
//
// Checked after the concurrent burst, and again after a reconcile releases capacity, so
// the ceiling is shown to hold over time and not merely at one instant.
//
// WHAT IS FIXTURED, AND WHAT THAT DOES NOT PROVE
//
// The reservation route requires an `inference_requests` row belonging to the calling
// device, and the only way to create one is `POST /api/v1/inference/responses`, which needs
// an agent, a binding, a published route and a session -- p05's whole fixture chain. The
// claim under test is the CEILING ARITHMETIC AND ITS ATOMICITY, and the inference row is a
// precondition, not the subject, so it is inserted directly and labelled as a fixture.
//
// What that costs: this probe does not prove the reservation is correctly correlated with a
// real inference. p05 covers that correlation (it asserts
// `reservation.run_id === created.runId` and the same for `usage`). Between them the two
// probes cover the claim; neither covers both alone, and that is stated rather than
// blurred.

import { createHash } from "node:crypto";

import { runProbe } from "./lib/smoke-harness.mjs";

/**
 * A well-formed opaque id: a 4-character prefix and 32 hex characters, 36 in total.
 *
 * The schema constrains every one of these (`length = 36 AND substr(id, 1, 4) = 'rte_'`),
 * so they cannot be built by concatenating whatever is to hand. Derived from the probe's
 * nonce so two runs never collide, and padded from a digest so the length is always right
 * whatever the nonce happens to be.
 */
function opaqueId(prefix, seed, nonce) {
  return prefix + createHash("sha256").update(`${seed}-${nonce}`).digest("hex").slice(0, 32);
}

/** The machine reason from an error envelope, or null. The harness has no `reason` field. */
const reasonOf = (result) =>
  result?.payload?.error?.details?.reason ?? result?.payload?.error?.code ?? null;

await runProbe("V01 budget-concurrency", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_BUDGET_PERSIST_TO", portEnvVar: "V01_BUDGET_PORT" });

  // --- fixtures --------------------------------------------------------------
  probe.stage = "fixtures";
  const owner = await probe.authenticatedUser("Budget Owner");
  const org = await probe.createOrganization(owner.jar, "Budget Org", `budget-org-${probe.nonce}`);

  const budget = await request(
    owner.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/budgets`,
    {
      scope_type: "organization",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2027-01-01T00:00:00.000Z",
      limit_minor: 100,
      hard: true,
      currency: "USD",
    },
    browserMutation(owner.jar, "v01-budget"),
  );
  const budgetId = budget.payload?.budget?.budget_id ?? budget.payload?.budget_id;
  probe.expect(
    "a hard organization budget exists with a limit of 100",
    typeof budgetId === "string" && budget.status < 300,
    `status=${budget.status} budget_id=${budgetId ?? "none"} body=${JSON.stringify(budget.payload).slice(0, 200)}`,
  );
  if (typeof budgetId !== "string") {
    probe.finish(2, "the budget fixture could not be created, so no attack is possible");
    return;
  }

  // --- the device ------------------------------------------------------------
  // A device is required because the reservation endpoint is device-authenticated
  // (`require_accounting_service` -> `authorize_device`). The chain is the one p05 uses:
  // begin enrollment, approve as the org owner, poll for the proof challenge, sign it.
  probe.stage = "device";
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { createHash } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyFingerprint = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const device = {
    label: "V01 budget device",
    publicKeyPem,
    keyFingerprint,
    sign: (message) => sign(null, Buffer.from(message), privateKey).toString("hex"),
  };

  const enrollment = await request(probe.client(), "POST", "/api/v1/devices/enrollments", {
    org_slug: `budget-org-${probe.nonce}`.slice(0, 63),
    public_key: device.publicKeyPem,
    key_fingerprint: device.keyFingerprint,
    device_name: device.label,
    platform: "darwin-arm64",
    app_version: "0.5.0",
  });
  const enrollmentId = enrollment.payload?.enrollment_id;
  if (
    !expect(
      "a device enrollment can be begun",
      enrollment.status === 201 && typeof enrollmentId === "string",
      `status=${enrollment.status} body=${JSON.stringify(enrollment.payload).slice(0, 200)}`,
    )
  ) {
    probe.finish(2, "the device fixture could not be enrolled, so no reservation is possible");
    return;
  }

  const slug = `budget-org-${probe.nonce}`.slice(0, 63).replace(/-+$/, "");
  const approve = await request(
    owner.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/devices/enrollments/${enrollmentId}/approve`,
    {},
    browserMutation(owner.jar, "v01-approve"),
  );
  expectStatus("the org owner approves the device enrollment", approve, [200, 201]);

  const status = await request(
    probe.client(),
    "GET",
    `/api/v1/devices/enrollments/${enrollmentId}`,
  );
  expect(
    "the approved enrollment releases a proof challenge",
    status.status === 200 &&
      status.payload?.status === "approved" &&
      typeof status.payload?.challenge === "string",
    `status=${status.status} enrollment_status=${status.payload?.status}`,
  );
  if (typeof status.payload?.challenge !== "string") {
    probe.finish(2, "no proof challenge, so the device cannot be completed");
    return;
  }

  const complete = await request(
    probe.client(),
    "POST",
    `/api/v1/devices/enrollments/${enrollmentId}/complete`,
    { signature: device.sign(status.payload.challenge) },
  );
  const deviceToken = complete.payload?.device_token;
  const deviceId = complete.payload?.device?.id;
  if (
    !expect(
      "the device completes enrollment and receives a token",
      typeof deviceToken === "string" && typeof deviceId === "string",
      `status=${complete.status} body=${JSON.stringify(complete.payload).slice(0, 200)}`,
    )
  ) {
    probe.finish(2, "the device fixture has no token, so no reservation is possible");
    return;
  }
  const deviceHeaders = (extra = {}) => ({
    Authorization: `DeviceToken ${deviceToken}`,
    ...extra,
  });

  // --- the inference-request fixture, stated as a fixture ---------------------
  //
  // `inference_requests` has four NOT NULL foreign keys -- `principal_user_id` to
  // `users`, `route_id` to `routes`, `route_version_id` to `route_versions` -- and
  // `response_state` is a closed vocabulary that does NOT include the obvious "pending":
  // the values are `not_dispatched`, `dispatched_no_output`, `stream_committed`,
  // `completed`, `failed`. `not_dispatched` is the semantically correct one here and is also
  // the instrument for requirement 1: a reservation exists precisely so a request that has
  // NOT been dispatched can hold budget before it is.
  probe.stage = "inference-fixture";
  const now = "2026-09-28T00:00:00.000Z";
  const routeId = opaqueId("rte_", "route", probe.nonce);
  const routeVersionId = opaqueId("rtv_", "route-version", probe.nonce);

  const d1 = async (label, command) =>
    probe.runWrangler(
      [
        "d1",
        "execute",
        "DB",
        "--local",
        "--env",
        "development",
        "--persist-to",
        probe.persistDir,
        "--command",
        command,
      ],
      label,
    );

  await d1(
    "V01 seed the route fixture",
    `INSERT INTO routes (route_id, org_id, alias, display_name, strategy, lifecycle, ` +
      `created_by_user_id, created_at, updated_at) VALUES ('${routeId}', '${org.orgId}', ` +
      `'v01-fixture', 'V01 fixture route', 'fixed', 'published', '${owner.user.id}', ` +
      `'${now}', '${now}')`,
  );
  await d1(
    "V01 seed the route-version fixture",
    `INSERT INTO route_versions (route_version_id, route_id, org_id, version_number, ` +
      `config_json, config_hash, created_by_user_id, created_at, published_at) VALUES ` +
      `('${routeVersionId}', '${routeId}', '${org.orgId}', 1, ` +
      `'{"strategy":"fixed","candidates":[]}', ` +
      `'${"a".repeat(64)}', '${owner.user.id}', '${now}', '${now}')`,
  );

  const requestIds = [];
  for (let i = 0; i < 8; i += 1) {
    requestIds.push(opaqueId("req_", `inference-${i}`, probe.nonce));
  }
  const values = requestIds
    .map(
      (rid) =>
        `('${rid}', '${org.orgId}', '${owner.user.id}', '${routeId}', '${routeVersionId}', ` +
        `'v01-fixture', '${deviceId}', 'not_dispatched', 0, '${now}', 'inference')`,
    )
    .join(",\n  ");
  await d1(
    "V01 seed the inference-request fixtures",
    "INSERT INTO inference_requests (request_id, org_id, principal_user_id, route_id, " +
      "route_version_id, model_alias, device_id, response_state, fallback_count, " +
      "started_at, source) VALUES\n  " +
      values,
  );

  const seeded = await d1Rows(
    `SELECT COUNT(*) AS n FROM inference_requests WHERE org_id = '${org.orgId}' AND device_id = '${deviceId}'`,
    "V01 count the seeded inference requests",
  );
  expect(
    "the inference-request fixtures are in place, so a refusal below is about the ceiling and not about a missing precondition",
    Number(seeded[0]?.n ?? 0) === requestIds.length,
    `seeded=${seeded[0]?.n ?? "unknown"} of ${requestIds.length}`,
  );

  // --- the invariant, read from the database ---------------------------------
  const outstanding = async () => {
    const rows = await d1Rows(
      `SELECT COALESCE(SUM(COALESCE(reserved_minor, 0) - COALESCE(committed_minor, 0)), 0) AS held,
              COUNT(*) AS reservations
       FROM budget_reservations
       WHERE org_id = '${org.orgId}' AND status = 'reserved'`,
      "V01 outstanding reservations",
    );
    return { held: Number(rows[0]?.held ?? 0), count: Number(rows[0]?.reservations ?? 0) };
  };

  const before = await outstanding();
  expect(
    "nothing is reserved before the attack",
    before.count === 0 && before.held === 0,
    `held=${before.held} count=${before.count}`,
  );

  // === the attack ============================================================
  // 8 concurrent requests, 30 each, against a limit of 100. Three fit (90). The burst
  // asks for 240 -- so a system that checks the ceiling without serialising will grant
  // eight and hold 240 against a limit of 100.
  probe.stage = "concurrent-burst";
  const AMOUNT = 30;
  const CONCURRENCY = 8;
  const expiry = "2026-09-29T00:00:00.000Z";

  const burst = await Promise.all(
    requestIds.map((rid, i) =>
      request(
        null,
        "POST",
        `/api/v1/devices/${org.orgId}/budgets/${budgetId}/reservations`,
        { request_id: rid, reserved_minor: AMOUNT, expires_at: expiry },
        deviceHeaders({ "Idempotency-Key": `v01-burst-${i}-${probe.nonce}` }),
      ),
    ),
  );

  const statuses = burst.map((r) => r.status);
  const granted = statuses.filter((s) => s >= 200 && s < 300).length;
  const denied = statuses.filter((s) => s >= 400 && s < 500).length;
  const faulted = statuses.filter((s) => s >= 500).length;
  console.log(
    `\n  ${CONCURRENCY} concurrent reservations of ${AMOUNT} against a limit of 100:` +
      ` ${granted} granted, ${denied} denied, ${faulted} 5xx`,
  );
  console.log(`  status distribution: ${[...new Set(statuses)].sort().join(" ")}`);

  // The burst must actually grant something, or the ceiling assertion below passes
  // VACUOUSLY.
  //
  // Found by B1 in the sensitivity proof: deleting the ceiling clause left invalid SQL, so
  // all eight requests answered 5xx, nothing was reserved, and "outstanding reservations
  // stay within limit_minor" reported PASS on `0 reservations hold 0`. A budget gate that
  // passes because the budget was never consulted is worse than no gate, because the
  // number next to it looks like a measurement.
  expect(
    "the burst granted at least one reservation, so the ceiling assertion below is measuring a budget and not an absence",
    granted > 0,
    granted > 0
      ? `${granted} of ${CONCURRENCY} granted against a limit of 100`
      : `nothing was granted (${CONCURRENCY - denied - faulted} unexpected, ${faulted} were 5xx) -- the ceiling assertion below would pass vacuously`,
  );

  // THE CLAIM. Read from the database, after the burst has fully settled.
  const after = await outstanding();
  expect(
    "concurrent reservations do not collectively exceed the hard limit: outstanding reservations stay within limit_minor",
    after.held <= 100,
    after.held <= 100
      ? `8 concurrent requests asked for 240 against a limit of 100; ${after.count} reservations hold ${after.held}`
      : `OVERSOLD: ${after.count} reservations hold ${after.held} against a limit of 100`,
  );

  expect(
    "the burst is refused by a budget decision, not answered by a store fault",
    faulted === 0,
    faulted === 0 ? "no 5xx" : `${faulted} of ${CONCURRENCY} were 5xx`,
  );

  // A denial must leave no trace. A refused request that still wrote a reservation would
  // make the ceiling arithmetic count a hold that no caller can use.
  const perRequest = await d1Rows(
    `SELECT reservation_id, request_id, status, reserved_minor, committed_minor
     FROM budget_reservations WHERE org_id = '${org.orgId}' ORDER BY request_id`,
    "V01 every reservation row the burst produced",
  );
  expect(
    "a denied reservation leaves no row, so the ceiling only counts holds a caller can use",
    perRequest.length === granted,
    `${perRequest.length} rows for ${granted} grants (denied: ${CONCURRENCY - granted})`,
  );

  // --- requirement 1: hard denial before upstream dispatch --------------------
  // The instrument: a reservation is the gate in front of dispatch, and a committed
  // reservation is the evidence that a caller got past it. So the question is whether a
  // DENIED caller can reach a committed reservation, and whether a granted one that then
  // fails can be reconciled and its capacity reclaimed.
  probe.stage = "release-and-reuse";
  const held = perRequest.filter((r) => r.status === "reserved");
  if (held.length === 0) {
    expect(
      "the burst granted at least one reservation, so release and reuse can be tested",
      false,
      "nothing was granted",
    );
  } else {
    // Address the RESERVATION, not the request it was made for. Passing a request_id here
    // is refused with `reservation_id_invalid`, which reads like a broken route and is
    // entirely a probe bug.
    const releaseId = held[held.length - 1].reservation_id;
    const reconcile = await request(
      null,
      "POST",
      `/api/v1/devices/${org.orgId}/budgets/${budgetId}/reservations/${releaseId}/reconcile`,
      // The reconcile vocabulary is committed | released | expired. "failed" is not in it --
      // a dispatch that failed releases its hold, it does not mark the hold as failed.
      { status: "released" },
      deviceHeaders({ "Idempotency-Key": `v01-release-${probe.nonce}` }),
    );
    expectStatus(
      "a granted reservation can be released when the work it held for fails",
      reconcile,
      [200, 204],
    );

    const afterRelease = await outstanding();
    expect(
      "releasing a reservation returns its capacity, so a failed dispatch does not permanently consume the budget",
      afterRelease.held < after.held,
      `held ${after.held} -> ${afterRelease.held} after releasing ${releaseId}`,
    );

    // And the freed capacity is genuinely usable, which is the part a "status was 204"
    // check would miss. The retry uses one of the request ids the burst was DENIED for --
    // the same inference, tried again. A brand-new request id is refused with
    // `request_id_invalid`, which is correct (a reservation must be correlated with a real
    // inference request) and is not this test.
    const deniedIds = requestIds.filter((rid) => !perRequest.some((row) => row.request_id === rid));
    if (deniedIds.length === 0) {
      expect(
        "the burst denied at least one request id, so the freed capacity can be retried",
        false,
        `all ${requestIds.length} were granted`,
      );
    } else {
      const reused = await request(
        null,
        "POST",
        `/api/v1/devices/${org.orgId}/budgets/${budgetId}/reservations`,
        { request_id: deniedIds[0], reserved_minor: AMOUNT, expires_at: expiry },
        deviceHeaders({ "Idempotency-Key": `v01-reuse-${probe.nonce}` }),
      );
      expect(
        "a request denied during the burst can reserve the capacity freed by a failed one",
        reused.status >= 200 && reused.status < 300,
        `request_id=${deniedIds[0]} status=${reused.status} reason=${reasonOf(reused)}`,
      );
    }
  }

  // --- a reservation must be correlated with a real inference ----------------
  // The statement requires `EXISTS (SELECT 1 FROM inference_requests r WHERE r.request_id
  // = ?2 AND r.org_id = ?3)`. A reservation is a claim about a specific request's cost, so
  // a request the server has never seen must not be reservable: otherwise a caller can
  // manufacture holds against inference that does not exist, which converts the budget from
  // a cost control into a deny-list of arbitrary keys.
  //
  // Found by B3 in the sensitivity proof -- removing the correlation changed nothing the
  // probe could see, because every request it made happened to have a real inference row.
  // That is the probe attacking only the happy path of a clause whose whole purpose is the
  // unhappy one.
  probe.stage = "uncorrelated-reservation";
  const uncorrelated = await request(
    null,
    "POST",
    `/api/v1/devices/${org.orgId}/budgets/${budgetId}/reservations`,
    {
      request_id: opaqueId("req_", "no-inference", probe.nonce),
      reserved_minor: 1,
      expires_at: expiry,
    },
    deviceHeaders({ "Idempotency-Key": `v01-uncorrelated-${probe.nonce}` }),
  );
  expect(
    "a reservation for a request the server has never seen is refused, so a caller cannot manufacture holds against inference that does not exist",
    uncorrelated.status >= 400 && uncorrelated.status < 500,
    `status=${uncorrelated.status} reason=${reasonOf(uncorrelated)}`,
  );
  const uncorrelatedRows = await d1Rows(
    `SELECT COUNT(*) AS n FROM budget_reservations WHERE org_id = '${org.orgId}' AND request_id = '${uncorrelated.payload?.reservation?.request_id ?? "none"}'`,
    "V01 did the uncorrelated reservation leave a row",
  );
  expect(
    "the refused uncorrelated reservation left no row",
    Number(uncorrelatedRows[0]?.n ?? 0) === 0,
    `rows=${uncorrelatedRows[0]?.n ?? "unknown"}`,
  );

  // --- requirement 5: unavailable authoritative budget state ------------------
  // What happens when the budget itself is not there. The route answers
  // `not_found`, which for a cross-tenant caller is indistinguishable from an absent
  // resource -- the correct shape, since a budget in another tenant must not be
  // distinguishable from one that does not exist.
  probe.stage = "unavailable-budget";
  const stranger = await request(
    null,
    "POST",
    `/api/v1/devices/${org.orgId}/budgets/bud_00000000000000000000000000000000/reservations`,
    { request_id: opaqueId("req_", "none", probe.nonce), reserved_minor: 1, expires_at: expiry },
    deviceHeaders({ "Idempotency-Key": `v01-none-${probe.nonce}` }),
  );
  expect(
    "a reservation against a budget that does not exist is refused, not treated as unlimited",
    stranger.status >= 400 && stranger.status < 500,
    `status=${stranger.status} reason=${reasonOf(stranger)}`,
  );

  const final = await outstanding();
  console.log(
    `\n  final: ${final.count} reservations holding ${final.held} against a limit of 100`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
