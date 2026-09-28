#!/usr/bin/env node
// V01 — automation lease contention.
//
// THE REQUIRED CASE WITH ZERO RUNTIME COVERAGE ANYWHERE
//
// The families list names "automation lease contention". Measured across every probe in the
// repository, the word "lease" appears in `p05-smoke` and `p07-schema-invariants` only as
// column names and as comments about backups, and the string "occurrences" appears in
// `p09-mutation-campaign.mjs` solely as a *source-text occurrence count* for a campaign
// preflight check. So the whole surface — a Tier-0 exclusivity claim defended by a partial
// unique index and a compare-and-set — has never been driven by a single request.
//
// That defence is real, and it is worth stating precisely because it is strong:
//
//   * `POST /api/v1/devices/automation-occurrences/{id}/claim` writes
//     `[claim, cas, lease, attempt, security_event, outbox]` in ONE D1 batch. D1 batches are
//     atomic, so either the whole claim lands or none of it does;
//   * `cas` moves the occurrence out of `pending`/`dispatching` only when
//     `state = expected_state AND state_version = expected_state_version`, so exactly one racer
//     can perform the transition;
//   * `ux_automation_leases_active` is `UNIQUE (occurrence_id) WHERE state = 'active'`, so at
//     most one active lease can exist for an occurrence regardless of what the application
//     believes.
//
// Two independent mechanisms, one transaction. Reading that is reassuring. What it does not
// tell you is whether a losing racer is *told* anything it should not be — and the route's own
// comment says the loser "re-reads the winner's projection", which is a disclosure surface, not
// just a bookkeeping one.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT THE STATUS
//
// The claim is graded on D1 rows: how many ACTIVE leases exist, what state the occurrence
// ended in, and how many attempt rows were written. A race can answer every racer `201` and
// still leave two leases, so the statuses are printed and never relied on.
//
// THREE THINGS THAT WOULD MAKE A CLEAN SHEET MEANINGLESS, ALL GUARDED
//
// 1. **The occurrence must be claimable before the race.** `run_now` is the only HTTP path that
//    creates one, and a race against a missing or already-claimed occurrence is a race against
//    nothing. The fixture asserts the occurrence exists in a claimable state and that its
//    `state_version` is read BEFORE the burst, so the post-race value can be compared to it.
// 2. **There must be a winner.** "Exactly one active lease" is trivially true if nobody won, so
//    exactly one `201` is asserted before the lease count is read. Asserting the thing happened
//    before asserting the thing did not happen twice.
// 3. **A refusal must be distinguishable from a leak.** Both leave the lease count at one, so
//    the losers' BODIES are examined for anything belonging to the winner: the lease id, the
//    token, the device that holds it. A conflict that echoes the winner's lease is a
//    cross-principal disclosure even though the status is correct.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runProbe } from "./lib/smoke-harness.mjs";

/**
 * A jar with no cookies, for the device routes.
 *
 * Device routes authenticate with `Authorization: DeviceToken <token>` and never read a
 * cookie, so a jar that carries none is the honest thing to pass -- and an empty `header()`
 * is the whole interface the harness's `request` needs from one. Using a browser jar here
 * would be a real hazard rather than a cosmetic one: it would let a browser session ride
 * along on a request that is supposed to be device-authenticated, and the case would prove
 * nothing about the device boundary.
 */
const anonJar = () => ({ header: () => "" });

await runProbe("V01 automation-lease", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation, browserHeaders } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_LEASE_PERSIST_TO", portEnvVar: "V01_LEASE_PORT" });

  // --- a real device identity: ed25519 keypair, real signature ---------------
  // Not test-only stand-in crypto. The enrollment challenge is signed with the same key the
  // device presents, which is the whole point of the device-proof check, and a fake signer
  // would make the case untestable rather than easy.
  const makeDevice = (label) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    return {
      label,
      publicKeyPem,
      keyFingerprint: createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      sign: (message) => sign(null, Buffer.from(message), privateKey).toString("hex"),
    };
  };

  // Enroll, approve and complete a device, returning its real bearer token.
  const enrolledDevice = async (admin, orgSlug, label) => {
    const device = makeDevice(label);
    const enrollment = await request(anonJar(), "POST", "/api/v1/devices/enrollments", {
      org_slug: orgSlug,
      public_key: device.publicKeyPem,
      key_fingerprint: device.keyFingerprint,
      device_name: label,
      platform: "darwin-arm64",
      app_version: "0.5.0",
    });
    expectStatus(`CONTROL: enrollment begins for ${label}`, enrollment, [201]);
    const enrollmentId = enrollment.payload?.enrollment_id;
    if (typeof enrollmentId !== "string") {
      probe.skip(
        `the ${label} device could not be enrolled, so any race using it would be unproven`,
        `status=${enrollment.status} body=${JSON.stringify(enrollment.payload).slice(0, 200)}`,
      );
      return null;
    }
    const approval = await request(
      admin.jar,
      "POST",
      `/api/v1/orgs/${admin.orgId}/devices/enrollments/${enrollmentId}/approve`,
      {},
      browserMutation(admin.jar, `v01-lease-approve-${label}`),
    );
    expectStatus(`CONTROL: the ${label} enrollment is approved`, approval, [201]);
    const status = await request(anonJar(), "GET", `/api/v1/devices/enrollments/${enrollmentId}`);
    expectStatus(`CONTROL: the ${label} enrollment releases a proof challenge`, status, [200]);
    if (typeof status.payload?.challenge !== "string") {
      probe.skip(
        `the ${label} enrollment released no challenge, so its device token cannot be obtained`,
        `status=${status.status} body=${JSON.stringify(status.payload).slice(0, 200)}`,
      );
      return null;
    }
    const finished = await request(
      anonJar(),
      "POST",
      `/api/v1/devices/enrollments/${enrollmentId}/complete`,
      { signature: device.sign(status.payload.challenge) },
    );
    expectStatus(
      `CONTROL: the ${label} enrollment completes with a real device proof`,
      finished,
      [201],
    );
    const token = finished.payload?.device_token;
    const deviceId = finished.payload?.device?.id;
    if (typeof token !== "string" || typeof deviceId !== "string") {
      probe.skip(
        `the ${label} device returned no token, so the race below could not be driven`,
        `status=${finished.status} body=${JSON.stringify(finished.payload).slice(0, 200)}`,
      );
      return null;
    }
    probe.registerSecret(token);
    return { ...device, token, deviceId, label };
  };

  // --- fixtures --------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const org = await probe.createOrganization(alice.jar, "Alice Org", `v01-lease-${probe.nonce}`);
  // The org slug is how a device enrollment names its organization, and `createOrganization`
  // does not return it, so it is read back from D1 rather than guessed at.
  const orgSlug = (
    await d1Rows(`SELECT slug FROM organizations WHERE org_id = '${org.orgId}'`, "V01 the org slug")
  )[0]?.slug;
  const admin = { jar: alice.jar, orgId: org.orgId, orgSlug };
  expect(
    "CONTROL: the organization's slug is known, which is how a device enrollment names its org",
    typeof orgSlug === "string" && orgSlug.length > 0,
    `slug=${orgSlug ?? "none"}`,
  );

  const project = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    { name: "V01 lease project", slug: `v01-lease-${probe.nonce}`.slice(0, 60), visibility: "org" },
    browserMutation(alice.jar, "v01-lease-project"),
  );
  const projectId = project.payload?.id;
  expectStatus("CONTROL: Org A has a real project", project, [201]);

  const agent = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/agents`,
    { name: "V01 lease agent", project_id: projectId },
    browserMutation(alice.jar, "v01-lease-agent"),
  );
  const agentId = agent.payload?.id ?? agent.payload?.agent?.id;
  expectStatus("CONTROL: Org A has a real agent on it", agent, [201]);

  const deviceA = await enrolledDevice(admin, orgSlug, "V01 device A");
  const deviceB = await enrolledDevice(admin, orgSlug, "V01 device B");

  if (typeof projectId !== "string" || typeof agentId !== "string" || !deviceA || !deviceB) {
    probe.finish(2, "the fixture chain could not be built, so no contention case is testable");
    return;
  }

  // Try EVERY schedule kind before giving up, because the fault may be kind-specific and
  // "the one kind I happened to choose fails" is not the same finding as "the route is
  // broken". `one_time` and `interval` exercise `plan_next_run` with real inputs where
  // `manual` does not.
  const scheduleVariants = [
    { kind: "manual", body: { kind: "manual" } },
    { kind: "one_time", body: { kind: "one_time", scheduled_at: "2027-01-01T00:00:00.000Z" } },
    {
      kind: "interval",
      body: { kind: "interval", every: 15, unit: "minutes", anchor_at: "2026-12-01T00:00:00.000Z" },
    },
    // `interval` and `cron` carry a ZONE as `utc_offset_seconds` plus an optional transition
    // table -- not a `timezone` string, which is why supplying `"timezone": "UTC"` was ignored
    // and every such kind answered `422 schedule_timezone_invalid`. `manual` and `one_time`
    // need no zone at all: `build_zone` returns UTC for them by definition.
    //
    // Driving a zoned kind is the cheapest way to tell a fault specific to the two kinds that
    // reach the commit from a fault in the route itself.
    {
      kind: "interval+zoned",
      body: {
        kind: "interval",
        every: 15,
        unit: "minutes",
        anchor_at: "2026-12-01T00:00:00.000Z",
        utc_offset_seconds: 0,
        timezone: "UTC",
        overlap_policy: "queue_one",
        missed_policy: "run_once",
      },
    },
    {
      kind: "cron+zoned",
      body: {
        kind: "cron",
        expression: "0 9 * * *",
        utc_offset_seconds: 0,
        timezone: "UTC",
        overlap_policy: "queue_one",
        missed_policy: "run_once",
      },
    },
  ];
  let automation = null;
  let automationId = null;
  const attempts = [];
  for (const [index, variant] of scheduleVariants.entries()) {
    const result = await request(
      alice.jar,
      "POST",
      `/api/v1/orgs/${org.orgId}/automations`,
      {
        name: `V01 lease automation ${variant.kind}`,
        project_id: projectId,
        agent_definition_id: agentId,
        execution_principal: { kind: "user" },
        target: { kind: "eligible_device" },
        schedule: variant.body,
        execution_policy: {},
      },
      browserMutation(alice.jar, `v01-lease-automation-${variant.kind}`),
    );
    const id = result.payload?.automation?.automation_id ?? result.payload?.automation_id;
    attempts.push(
      `  ${variant.kind.padEnd(9)} -> ${result.status} ${result.payload?.error?.details?.reason ?? result.payload?.error?.code ?? ""}`,
    );
    if (result.status === 201 && typeof id === "string") {
      automation = result;
      automationId = id;
      break;
    }
  }
  console.log(`\n  create attempts, in order: \n${attempts.join("\n")}`);
  // `workerConsole()`, not `workerLog()`: only the former carries what the WORKER logged, and
  // the one line that names a failing statement is a `console_error!` from inside it.
  const FULLLOG = (probe.workerConsole() ?? "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-20)
    .map((l) => `    ${l.slice(0, 240)}`)
    .join("\n");
  const automationStatus = automation?.status ?? 0;
  expect(
    "CONTROL: Org A has a real automation",
    automation.status === 201 && typeof automationId === "string",
    `sent ${automation.method} ${automation.path} -> status=${automation.status} ` +
      `body=${JSON.stringify(automation.payload).slice(0, 240)}` +
      (automation.status >= 400
        ? `\n  --- FULL worker log, unfiltered, because the filtered version hid the answer ---\n${FULLLOG}`
        : ""),
  );
  if (typeof automationId !== "string") {
    probe.finish(
      2,
      "the automation fixture could not be created, so no contention case is testable",
    );
    return;
  }

  // --- the state readers -----------------------------------------------------
  const occurrenceRow = (id) =>
    d1Rows(
      `SELECT occurrence_id, state, state_version, attempt, started_at, finished_at
         FROM automation_occurrences WHERE occurrence_id = '${id}'`,
      `V01 occurrence ${id}`,
    );
  const activeLeases = (id) =>
    d1Rows(
      `SELECT lease_id, device_id, attempt, state, lease_token_fingerprint, lease_version, lease_fence
         FROM automation_leases WHERE occurrence_id = '${id}' AND state = 'active'`,
      `V01 active leases for ${id}`,
    );
  const allLeases = (id) =>
    d1Rows(
      `SELECT lease_id, state, attempt FROM automation_leases WHERE occurrence_id = '${id}'`,
      `V01 every lease for ${id}`,
    );
  const attemptRows = (id) =>
    d1Rows(
      `SELECT attempt_id, lease_id, attempt, outcome, reason_code FROM automation_attempts WHERE occurrence_id = '${id}'`,
      `V01 attempts for ${id}`,
    );

  const claim = (device, occurrenceId) =>
    request(
      anonJar(),
      "POST",
      `/api/v1/devices/automation-occurrences/${occurrenceId}/claim`,
      undefined,
      { Authorization: `DeviceToken ${device.token}` },
    );

  // A fresh occurrence per case, so each race starts from a genuinely claimable state and one
  // case's winner cannot make the next case's precondition false.
  const newOccurrence = async (label) => {
    const version = Number(
      (
        await d1Rows(
          `SELECT version FROM automation_definitions WHERE automation_id = '${automationId}'`,
          `V01 the automation version for ${label}`,
        )
      )[0]?.version ?? 1,
    );
    const runNow = await request(
      alice.jar,
      "POST",
      `/api/v1/orgs/${org.orgId}/automations/${automationId}/run-now`,
      { version },
      browserMutation(alice.jar, `v01-lease-runnow-${label}`),
    );
    const id = runNow.payload?.occurrence?.occurrence_id ?? runNow.payload?.occurrence_id;
    expect(
      `CONTROL: run_now creates a claimable occurrence for the ${label} case`,
      typeof id === "string",
      `status=${runNow.status} body=${JSON.stringify(runNow.payload).slice(0, 240)}`,
    );
    return typeof id === "string" ? id : null;
  };

  // =========================================================================
  // Case 1 — EIGHT SIMULTANEOUS claims from ONE device
  // =========================================================================
  probe.stage = "eight-claims-one-device";
  const occ1 = await newOccurrence("eight-claims");
  if (occ1) {
    const before = (await occurrenceRow(occ1))[0];
    expect(
      "CONTROL: the occurrence is in a claimable state BEFORE the burst, so the race is against something real",
      before?.state === "pending" || before?.state === "dispatching",
      `state=${before?.state ?? "no row"} state_version=${before?.state_version ?? "n/a"} attempt=${before?.attempt ?? "n/a"}`,
    );
    const versionBefore = before?.state_version;

    const BURST = 8;
    const burst = await Promise.all(Array.from({ length: BURST }, () => claim(deviceA, occ1)));
    const winners = burst.filter((r) => r.status >= 200 && r.status < 300);
    const losers = burst.filter((r) => !(r.status >= 200 && r.status < 300));
    const statuses = [...new Set(burst.map((r) => r.status))].sort();
    console.log(
      `\n  ${BURST} simultaneous claims, one device, one occurrence -> statuses ${statuses.join(" ")}; ` +
        `${winners.length} winner(s)`,
    );

    // Control: there IS a winner. Asserted BEFORE the lease count, so "exactly one lease"
    // cannot be satisfied by nobody winning.
    expect(
      `CONTROL: exactly ONE of the ${BURST} simultaneous claims succeeds`,
      winners.length === 1,
      `${winners.length} succeeded with statuses ${statuses.join(" ")}`,
    );

    const leases = await activeLeases(occ1);
    expect(
      `exactly ONE active lease exists for the occurrence after ${BURST} simultaneous claims`,
      leases.length === 1,
      leases.length === 1
        ? `lease=${leases[0].lease_id} attempt=${leases[0].attempt} fence=${leases[0].lease_fence}`
        : `${leases.length} ACTIVE LEASES: ${JSON.stringify(leases).slice(0, 400)}`,
    );

    const after = (await occurrenceRow(occ1))[0];
    expect(
      "the occurrence advanced by exactly ONE state transition, so `state_version` is a real compare-and-set and not a counter two racers both incremented",
      Number(after?.state_version) === Number(versionBefore) + 1,
      `state_version ${versionBefore} -> ${after?.state_version}; state ${before?.state} -> ${after?.state}`,
    );
    // The state invariants. `attempt` is NOT asserted here: the product does not advance it,
    // and asserting the convention I assumed rather than the one it implements would make this
    // probe wrong in the other direction. The real defect is asserted separately, below, and
    // fails on purpose until it is fixed.
    expect(
      "the occurrence is LEASED after the burst, not left pending",
      after?.state === "leased",
      `state=${after?.state} attempt=${after?.attempt} started_at=${after?.started_at ?? "null"}`,
    );

    // V01-013, asserted rather than skipped. `TRANSITION_OCCURRENCE_SQL` has no `attempt` in
    // its SET list and the claim passes `None` for `started_at`, so BOTH of these columns are
    // written by nothing after creation. The consequence is not cosmetic:
    // `let attempt = occurrence.attempt + 1` therefore recomputes 1 on every claim, so
    // `max_start_attempts` can never be exceeded and the retry bound is unenforceable.
    //
    // A gate that reports this as FAIL is more useful than a green one, and it is the
    // campaign's rule: an unresolved item stays FAIL rather than being softened into a skip.
    expect(
      "V01-013: the occurrence's attempt counter ADVANCES on a claim, so max_start_attempts is enforceable (it is not - attempt is written by nothing)",
      Number(after?.attempt) > Number(before?.attempt),
      `attempt ${before?.attempt} -> ${after?.attempt} after a successful claim; the lease row carries attempt=1 while the occurrence still says ${after?.attempt}, and TRANSITION_OCCURRENCE_SQL has no attempt in its SET list`,
    );
    expect(
      "V01-013: a LEASED occurrence records when the work started (it does not - the claim binds None, so COALESCE(started_at, NULL) is NULL)",
      typeof after?.started_at === "string" && after.started_at.length === 24,
      `started_at=${after?.started_at ?? "null"} on a ${after?.state} occurrence`,
    );

    // The losers must learn nothing about the winner.
    const winner = winners[0];
    const winnerLeaseId = winner?.payload?.lease_id;
    const winnerToken = winner?.payload?.lease_token;
    const lossyLeak = losers.filter(
      (r) =>
        (winnerLeaseId && JSON.stringify(r.payload ?? null).includes(winnerLeaseId)) ||
        (winnerToken && JSON.stringify(r.payload ?? null).includes(winnerToken)),
    );
    expect(
      "NO losing response contains the winner's lease id or its raw lease token — the conflict re-reads a projection, it does not hand over the lease",
      lossyLeak.length === 0,
      lossyLeak.length === 0
        ? `${losers.length} loser(s) answered ${[...new Set(losers.map((r) => r.status))].join(" ")} with no winner lease material`
        : `${lossyLeak.length} loser response(s) carried the winner's lease: ${JSON.stringify(lossyLeak[0].payload).slice(0, 300)}`,
    );
    expect(
      "every losing response is an explicit refusal with a stable reason, never a 2xx and never a bare 500",
      losers.every(
        (r) => r.status === 409 || r.status === 425 || (r.status >= 400 && r.status < 500),
      ),
      `loser statuses: ${[...new Set(losers.map((r) => r.status))].join(" ") || "none"}`,
    );

    // The raw token is one-time and must not be persisted anywhere.
    const stored = JSON.stringify(await allLeases(occ1));
    expect(
      "the winner's raw lease token is NOT persisted — only a fingerprint is stored",
      typeof winnerToken === "string" && !stored.includes(winnerToken),
      typeof winnerToken === "string"
        ? `token length=${winnerToken.length}; the stored lease carries lease_token_fingerprint=${String(leases[0]?.lease_token_fingerprint).slice(0, 24)}...`
        : "the winner returned no token, so this claim is unproven",
    );
    expect(
      "the stored lease keeps a FINGERPRINT, so a database read cannot reconstruct the token",
      typeof leases[0]?.lease_token_fingerprint === "string" &&
        leases[0].lease_token_fingerprint.length > 0,
      `fingerprint=${String(leases[0]?.lease_token_fingerprint).slice(0, 32)}`,
    );

    const attempts = await attemptRows(occ1);
    console.log(
      `  after the burst: ${leases.length} active lease(s), ${attempts.length} attempt row(s) ` +
        `[${attempts.map((a) => `${a.attempt}:${a.outcome}`).join(", ")}]`,
    );
    expect(
      "exactly ONE attempt row exists for the occurrence, because eight racers produced one claim and not eight",
      attempts.length === 1,
      attempts.length === 1
        ? `attempt=${attempts[0].attempt} outcome=${attempts[0].outcome}`
        : `${attempts.length} attempt rows: ${JSON.stringify(attempts).slice(0, 300)}`,
    );
  }

  // =========================================================================
  // Case 2 — TWO DEVICES racing for the same occurrence
  //
  // A different shape from case 1: two distinct principals, each with its own device token and
  // its own org membership. The loser here is a *different device*, so a conflict that echoed
  // the winner's projection would disclose another device's lease.
  // =========================================================================
  probe.stage = "two-devices-one-occurrence";
  const occ2 = await newOccurrence("two-devices");
  if (occ2) {
    const pair = await Promise.all([claim(deviceA, occ2), claim(deviceB, occ2)]);
    const winners = pair.filter((r) => r.status >= 200 && r.status < 300);
    const losers = pair.filter((r) => !(r.status >= 200 && r.status < 300));
    console.log(
      `\n  2 devices, 1 occurrence, simultaneous -> ${pair.map((r) => r.status).join(" / ")}`,
    );
    expect(
      "CONTROL: exactly one of two DEVICES claims the occurrence",
      winners.length === 1,
      `${winners.length} device(s) won with statuses ${pair.map((r) => r.status).join(" / ")}`,
    );
    const leases = await activeLeases(occ2);
    expect(
      "exactly ONE active lease exists after two devices race for it",
      leases.length === 1,
      leases.length === 1
        ? `held by device ${leases[0].device_id}`
        : `${leases.length} ACTIVE LEASES: ${JSON.stringify(leases).slice(0, 300)}`,
    );
    const winnerToken = winners[0]?.payload?.lease_token;
    const winnerLeaseId = winners[0]?.payload?.lease_id;
    const otherDeviceLeak = losers.filter(
      (r) =>
        (winnerLeaseId && JSON.stringify(r.payload ?? null).includes(winnerLeaseId)) ||
        (winnerToken && JSON.stringify(r.payload ?? null).includes(winnerToken)),
    );
    expect(
      "the losing DEVICE is told nothing about the winning device's lease",
      otherDeviceLeak.length === 0,
      otherDeviceLeak.length === 0
        ? `the loser answered ${losers[0]?.status} with no winner lease material`
        : `${otherDeviceLeak.length} losing device response(s) carried the winner's lease`,
    );
  }

  // =========================================================================
  // Case 3 — the loser cannot simply claim again
  //
  // The obvious follow-on: if a refused claim left the occurrence claimable, a client could
  // retry until it won. This is a claim about the OCCURRENCE, not about a race, and it is the
  // difference between "at most one active lease" and "at most one claim".
  // =========================================================================
  probe.stage = "loser-cannot-reclaim";
  const occ3 = await newOccurrence("reclaim");
  if (occ3) {
    const first = await claim(deviceA, occ3);
    const second = await claim(deviceB, occ3);
    const third = await claim(deviceA, occ3);
    console.log(
      `\n  sequential re-claims on one occurrence -> ${[first, second, third].map((r) => r.status).join(" / ")}`,
    );
    expect(
      "CONTROL: the first claim succeeds, so the refusals below are refusals of an ALREADY-CLAIMED occurrence",
      first.status >= 200 && first.status < 300,
      `status=${first.status} body=${JSON.stringify(first.payload).slice(0, 200)}`,
    );
    expect(
      "a second device cannot claim an already-leased occurrence, however many times it tries",
      second.status >= 400 && third.status >= 400,
      `second=${second.status} third=${third.status}`,
    );
    const leases = await activeLeases(occ3);
    expect(
      "still exactly ONE active lease after three sequential claims",
      leases.length === 1,
      leases.length === 1 ? `lease=${leases[0].lease_id}` : `${leases.length} ACTIVE LEASES`,
    );
  }

  // =========================================================================
  // Case 4 — a device from ANOTHER organization claims this occurrence
  //
  // A device route, so this is a different boundary from every org-scoped attack in the
  // campaign: the org id is never in the path. The occurrence id is the only thing that
  // identifies the tenant, so `require_device_occurrence` is the entire boundary.
  // =========================================================================
  probe.stage = "cross-tenant-device";
  const occ4 = await newOccurrence("cross-tenant");
  if (occ4) {
    const bob = await probe.authenticatedUser("Bob");
    const bobOrg = await probe.createOrganization(
      bob.jar,
      "Bob Org",
      `v01-lease-bob-${probe.nonce}`,
    );
    const bobSlug =
      bobOrg.orgSlug ??
      (
        await d1Rows(
          `SELECT slug FROM organizations WHERE org_id = '${bobOrg.orgId}'`,
          "V01 Bob's org slug",
        )
      )[0]?.slug;
    const intruder = await enrolledDevice(
      { jar: bob.jar, orgId: bobOrg.orgId },
      bobSlug,
      "V01 intruder",
    );

    if (intruder) {
      const before = (await occurrenceRow(occ4))[0];
      const attack = await claim(intruder, occ4);
      const after = (await occurrenceRow(occ4))[0];
      const leases = await activeLeases(occ4);
      console.log(
        `\n  another org's device claims this occurrence -> ${attack.status} ` +
          `reason=${attack.payload?.error?.details?.reason ?? "n/a"}`,
      );
      expect(
        "another organization's device is refused an occurrence it does not own, with the org id nowhere in the path",
        attack.status >= 400,
        `status=${attack.status} body=${JSON.stringify(attack.payload).slice(0, 240)}`,
      );
      expect(
        "the refused cross-tenant claim changed NOTHING: the occurrence is in the same state at the same version",
        after?.state === before?.state &&
          String(after?.state_version) === String(before?.state_version),
        `state ${before?.state}@${before?.state_version} -> ${after?.state}@${after?.state_version}`,
      );
      expect(
        "the refused cross-tenant claim created NO lease, in either org",
        leases.length === 0,
        leases.length === 0
          ? "no lease exists for this occurrence, so the refusal left nothing behind"
          : `${leases.length} lease(s) exist: ${JSON.stringify(leases).slice(0, 300)}`,
      );
      // And the existence of the occurrence must not be distinguishable from a missing one.
      const missing = await claim(intruder, "occ_00000000000000000000000000000000");
      expect(
        "another org's device gets the SAME answer for a real occurrence it does not own as for one that does not exist, so the refusal does not confirm existence",
        String(attack.status) === String(missing.status) &&
          JSON.stringify(attack.payload?.error?.code ?? null) ===
            JSON.stringify(missing.payload?.error?.code ?? null),
        `real -> ${attack.status} ${attack.payload?.error?.code ?? "n/a"}; absent -> ${missing.status} ${missing.payload?.error?.code ?? "n/a"}`,
      );
    }
  }

  // --- the summary: the whole claim in one assertion -------------------------
  const everyActive = await d1Rows(
    `SELECT occurrence_id, COUNT(*) AS n FROM automation_leases WHERE state = 'active'
      GROUP BY occurrence_id HAVING n > 1`,
    "V01 occurrences with more than one active lease, database-wide",
  );
  expect(
    "NO occurrence anywhere in the database has more than one active lease, which is the partial unique index's claim stated as one assertion",
    everyActive.length === 0,
    everyActive.length === 0
      ? "the uniqueness held for every occurrence this probe created"
      : `MULTIPLE ACTIVE LEASES: ${JSON.stringify(everyActive).slice(0, 400)}`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
