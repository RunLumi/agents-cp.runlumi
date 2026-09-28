#!/usr/bin/env node
// V01-014 — can an automation occurrence be started more times than `max_start_attempts` allows?
//
// THE DEFECT THIS ATTACKS, AND WHY IT NEEDS A CLAIM *AND* AN EXPIRY
//
// V01-013 found that `TRANSITION_OCCURRENCE_SQL` has no `attempt` in its SET list, and that
// nothing else writes `automation_occurrences.attempt` either. The occurrence is inserted with
// `attempt = 0` and never changed. The claim computes
//
//     let attempt = occurrence.attempt + 1;
//     if attempt > max_start_attempts { refuse }
//
// so with the column permanently `0` that expression is **always 1**, and `max_start_attempts`
// can never be exceeded. The guard is real code, reads the right column, and is dead.
//
// A single claim cannot show this. Every claim is attempt 1 whatever the bound is, so one
// claim looks correct under `max_start_attempts: 1` and under `max_start_attempts: 3`
// identically. The defect only becomes visible when an occurrence is **claimed a second time**,
// and a second claim needs the first lease to stop being active. That needs one of:
//
//   * a lease that expires, and the sweep that expires it; or
//   * an explicit release.
//
// So this probe drives the whole arc, in this order, and each step asserts the thing that must
// be true for the NEXT step to mean anything:
//
//   1. build an automation with `max_start_attempts: 1` — the tightest bound the schema allows
//      (the column is `CHECK (max_start_attempts BETWEEN 1 AND 3)`), so a second claim has
//      nowhere to hide;
//   2. `run_now` for a claimable occurrence, and assert it is claimable;
//   3. claim it. Assert the winner got a lease AND that the **occurrence's own `attempt`
//      advanced** — this is the V01-013 assertion, and it fails today;
//   4. claim it again immediately. Assert the refusal, and assert the attempt did not move;
//   5. let the lease expire, fire the sweep, and claim a THIRD time. With `max_start_attempts: 1`
//      this must be refused as an exhausted attempt, and the occurrence's `attempt` must be
//      sitting at 1 — the number the refused claim would have been.
//
// WHY THE ATTEMPT IS READ FROM THE OCCURRENCE AND NOT THE RESPONSE
//
// The claim response carries its own `attempt`, and under V01-013 that number is computed from
// the broken column, so it reads `1` on every claim. Reading it would report success. The
// occurrence row is the only place the counter is supposed to be *recorded*, so that is what is
// read, and the two are reported together so a divergence between them is visible.
//
// THE TIMING IS THE PRODUCT'S, NOT MINE
//
// `lease_ttl_seconds` is `CHECK (… BETWEEN 30 AND 3600)`, so 30 seconds is the fastest a lease
// can be made to expire and this case cannot be shortened. The wait is a real wait and it is
// bounded: if the sweep has not expired the lease by then, the case says so rather than
// assuming it did, because "the third claim was refused because the lease was still active" and
// "the third claim was refused because the attempt was exhausted" are different findings.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 attempt-exhaustion", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation, browserHeaders } = probe;
  const anonJar = () => ({ header: () => "" });

  console.log("");
  await probe.setup({ persistEnvVar: "V01_ATTEMPT_PERSIST_TO", portEnvVar: "V01_ATTEMPT_PORT" });

  // --- a real device identity ------------------------------------------------
  const { createHash, generateKeyPairSync, sign } = await import("node:crypto");
  const makeDevice = (label) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      label,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      keyFingerprint: createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      sign: (message) => sign(null, Buffer.from(message), privateKey).toString("hex"),
    };
  };

  const enroll = async (admin, orgSlug, label) => {
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
    if (typeof enrollmentId !== "string") return null;
    const approval = await request(
      admin.jar,
      "POST",
      `/api/v1/orgs/${admin.orgId}/devices/enrollments/${enrollmentId}/approve`,
      {},
      browserMutation(admin.jar, `v01-attempt-approve-${label}`),
    );
    expectStatus(`CONTROL: the ${label} enrollment is approved`, approval, [201]);
    const status = await request(anonJar(), "GET", `/api/v1/devices/enrollments/${enrollmentId}`);
    if (typeof status.payload?.challenge !== "string") return null;
    const finished = await request(
      anonJar(),
      "POST",
      `/api/v1/devices/enrollments/${enrollmentId}/complete`,
      { signature: device.sign(status.payload.challenge) },
    );
    const token = finished.payload?.device_token;
    if (typeof token !== "string") return null;
    probe.registerSecret(token);
    return { token };
  };

  // --- fixtures --------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const org = await probe.createOrganization(alice.jar, "Alice Org", `v01-attempt-${probe.nonce}`);
  const orgSlug = (
    await d1Rows(`SELECT slug FROM organizations WHERE org_id = '${org.orgId}'`, "V01 the org slug")
  )[0]?.slug;
  const admin = { jar: alice.jar, orgId: org.orgId, orgSlug };
  expect(
    "CONTROL: the organization's slug is known",
    typeof orgSlug === "string" && orgSlug.length > 0,
    `slug=${orgSlug ?? "none"}`,
  );

  const project = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    {
      name: "V01 attempt project",
      slug: `v01-attempt-${probe.nonce}`.slice(0, 60),
      visibility: "org",
    },
    browserMutation(alice.jar, "v01-attempt-project"),
  );
  const projectId = project.payload?.id;
  expectStatus("CONTROL: a real project", project, [201]);

  const agent = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/agents`,
    { name: "V01 attempt agent", project_id: projectId },
    browserMutation(alice.jar, "v01-attempt-agent"),
  );
  const agentId = agent.payload?.id ?? agent.payload?.agent?.id;
  expectStatus("CONTROL: a real agent on it", agent, [201]);

  const device = await enroll(admin, orgSlug, "V01 attempt device");
  if (!device) {
    probe.finish(2, "the device fixture could not be built, so no attempt claim is testable");
    return;
  }

  // `max_start_attempts: 1` is the tightest bound the column allows, and `lease_ttl_seconds: 30`
  // the shortest, so a second start has the fewest places to hide.
  probe.stage = "automation";
  const automation = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/automations`,
    {
      name: "V01 attempt automation",
      project_id: projectId,
      agent_definition_id: agentId,
      execution_principal: { kind: "user" },
      target: { kind: "eligible_device" },
      schedule: { kind: "manual" },
      execution_policy: {},
      execution_retry: {
        max_start_attempts: 1,
        lease_ttl_seconds: 30,
        heartbeat_interval_seconds: 10,
      },
    },
    browserMutation(alice.jar, "v01-attempt-automation"),
  );
  const automationId =
    automation.payload?.automation?.automation_id ?? automation.payload?.automation_id;
  expect(
    "CONTROL: an automation exists with max_start_attempts = 1",
    automation.status === 201 && typeof automationId === "string",
    `status=${automation.status} body=${JSON.stringify(automation.payload).slice(0, 200)}`,
  );
  if (automation.status !== 201 || typeof automationId !== "string") {
    probe.finish(2, "the automation fixture could not be created, so no attempt claim is testable");
    return;
  }
  const stored = await d1Rows(
    `SELECT max_start_attempts, lease_ttl_seconds FROM automations WHERE automation_id = '${automationId}'`,
    "V01 the stored retry policy",
  );
  expect(
    "CONTROL: the stored automation really carries max_start_attempts = 1, so a second start must be refused",
    Number(stored[0]?.max_start_attempts) === 1,
    `max_start_attempts=${stored[0]?.max_start_attempts} lease_ttl_seconds=${stored[0]?.lease_ttl_seconds}`,
  );

  // --- the occurrence ---------------------------------------------------------
  probe.stage = "occurrence";
  const version = Number(
    (
      await d1Rows(
        `SELECT version FROM automations WHERE automation_id = '${automationId}'`,
        "V01 the automation version",
      )
    )[0]?.version ?? 1,
  );
  const runNow = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/automations/${automationId}/run-now`,
    { version },
    browserMutation(alice.jar, "v01-attempt-runnow"),
  );
  const occurrenceId = runNow.payload?.occurrence?.occurrence_id ?? runNow.payload?.occurrence_id;
  expect(
    "CONTROL: run_now produced an occurrence",
    typeof occurrenceId === "string",
    `status=${runNow.status} body=${JSON.stringify(runNow.payload).slice(0, 200)}`,
  );
  if (typeof occurrenceId !== "string") {
    probe.finish(2, "no occurrence, so no claim is testable");
    return;
  }

  const occurrenceRow = () =>
    d1Rows(
      `SELECT occurrence_id, state, attempt, started_at, state_version
         FROM automation_occurrences WHERE occurrence_id = '${occurrenceId}'`,
      `V01 occurrence ${occurrenceId}`,
    );
  const activeLeases = () =>
    d1Rows(
      `SELECT lease_id, state, attempt FROM automation_leases WHERE occurrence_id = '${occurrenceId}'`,
      `V01 leases for ${occurrenceId}`,
    );
  const claim = (label) =>
    request(
      anonJar(),
      "POST",
      `/api/v1/devices/automation-occurrences/${occurrenceId}/claim`,
      undefined,
      { Authorization: `DeviceToken ${device.token}` },
    );

  // --- step 3: the first claim ----------------------------------------------
  probe.stage = "first-claim";
  const before = (await occurrenceRow())[0];
  expect(
    "CONTROL: the occurrence is claimable before any claim",
    before?.state === "pending" || before?.state === "dispatching",
    `state=${before?.state} attempt=${before?.attempt}`,
  );
  const first = await claim("first");
  expect(
    "CONTROL: the first claim succeeds, so the refusals after it are refusals of a claimed occurrence",
    first.status >= 200 && first.status < 300,
    `status=${first.status} body=${JSON.stringify(first.payload).slice(0, 200)}`,
  );
  const afterFirst = (await occurrenceRow())[0];
  console.log(
    `\n  first claim: http=${first.status} response_attempt=${first.payload?.attempt} ` +
      `occurrence_attempt ${before?.attempt} -> ${afterFirst?.attempt} started_at=${afterFirst?.started_at ?? "null"}`,
  );

  expect(
    "V01-013: the occurrence's attempt counter ADVANCES on a successful claim, so the second start is attempt 2 (it does not - TRANSITION_OCCURRENCE_SQL has no attempt in its SET list)",
    Number(afterFirst?.attempt) > Number(before?.attempt),
    `occurrence attempt ${before?.attempt} -> ${afterFirst?.attempt} while the response said ${first.payload?.attempt}; ` +
      `max_start_attempts is 1, so the bound is decided entirely by this column`,
  );
  expect(
    "V01-013: a LEASED occurrence records when the work started (it does not - the claim binds None, so COALESCE(started_at, NULL) is NULL)",
    typeof afterFirst?.started_at === "string" && afterFirst.started_at.length === 24,
    `started_at=${afterFirst?.started_at ?? "null"} on a ${afterFirst?.state} occurrence`,
  );

  // --- step 4: a second claim while the lease is live -------------------------
  probe.stage = "second-claim-while-leased";
  const second = await claim("second");
  const afterSecond = (await occurrenceRow())[0];
  const leasesAfterSecond = await activeLeases();
  console.log(
    `  second claim while leased: http=${second.status} reason=${second.payload?.error?.details?.reason ?? "n/a"} ` +
      `occurrence_attempt=${afterSecond?.attempt} active_leases=${leasesAfterSecond.filter((l) => l.state === "active").length}`,
  );
  expect(
    "a second claim while the first lease is still active is refused, and does not add a second active lease",
    second.status >= 400 && leasesAfterSecond.filter((l) => l.state === "active").length === 1,
    `status=${second.status} active_leases=${leasesAfterSecond.filter((l) => l.state === "active").length}`,
  );

  // --- step 5: wait for the lease to expire, sweep, then claim again ---------
  //
  // 30 seconds is the schema's own floor for `lease_ttl_seconds`, so this is the fastest the
  // product allows. Bounded, and the bound is checked rather than assumed.
  probe.stage = "expiry";
  console.log(
    "  waiting for the lease's 30s TTL to elapse (the schema's floor for lease_ttl_seconds)...",
  );
  await new Promise((resolve) => setTimeout(resolve, 35_000));
  const beforeSweep = await activeLeases();
  const activeBeforeSweep = beforeSweep.filter((l) => l.state === "active");
  expect(
    "the first lease is still recorded as active before the sweep, so a later refusal cannot be attributed to the sweep having already run",
    activeBeforeSweep.length === 1,
    `active leases before the sweep: ${activeBeforeSweep.length}`,
  );

  await probe.triggerSweep();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const afterSweep = await activeLeases();
  const activeAfterSweep = afterSweep.filter((l) => l.state === "active");
  console.log(
    `  after the sweep: active_leases=${activeAfterSweep.length} ` +
      `states=[${afterSweep.map((l) => `${l.lease_id.slice(0, 12)}:${l.state}:${l.attempt}`).join(" ")}]`,
  );

  const third = await claim("third");
  const afterThird = (await occurrenceRow())[0];
  console.log(
    `  third claim after expiry: http=${third.status} reason=${third.payload?.error?.details?.reason ?? "n/a"} ` +
      `response_attempt=${third.payload?.attempt ?? "n/a"} occurrence_attempt=${afterThird?.attempt}`,
  );

  // THE CLAIM. `max_start_attempts` is 1, so a second START of this occurrence must be
  // refused. If it is not, the bound is not enforced and V01-013 is a live money-and-abuse
  // defect rather than a bookkeeping one.
  expect(
    "V01-013: with max_start_attempts = 1, an occurrence whose lease EXPIRED cannot be started a second time (it can - the attempt column never advances, so the bound is never reached)",
    third.status >= 400,
    `third claim answered ${third.status} with reason=${third.payload?.error?.details?.reason ?? "n/a"}; ` +
      `a second start of an occurrence bound to one attempt means an automation can run its ` +
      `work twice for one scheduled slot, and the retry bound is unreachable by construction`,
  );
  expect(
    "the occurrence's attempt counter sits at 1, the number the refused second start would have used",
    Number(afterThird?.attempt) === 1,
    `occurrence attempt=${afterThird?.attempt} (0 means the counter is dead and every claim is attempt 1)`,
  );

  // --- the summary ----------------------------------------------------------
  const everyAttempt = await d1Rows(
    `SELECT occurrence_id, attempt, COUNT(*) AS n FROM automation_occurrences GROUP BY occurrence_id, attempt`,
    "V01 attempt values across every occurrence",
  );
  console.log(
    `  attempt values observed across all occurrences: ${JSON.stringify(everyAttempt.slice(0, 5))}`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
