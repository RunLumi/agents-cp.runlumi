#!/usr/bin/env node
// V01-014 — can an automation occurrence be STARTED more times than `max_start_attempts` allows?
//
// THE DEFECT, AND WHY IT NEEDS A CLAIM *AND* AN EXPIRY
//
// V01-013 found that `TRANSITION_OCCURRENCE_SQL` has no `attempt` in its SET list and that
// nothing else writes `automation_occurrences.attempt` either. The occurrence is inserted with
// `attempt = 0` and never changed. The claim computes
//
//     let attempt = occurrence.attempt + 1;
//     if attempt > max_start_attempts { refuse }
//
// so with the column permanently `0` that expression is **always 1**, and `max_start_attempts`
// can never be exceeded. The guard is real code, reading the right column, and is dead.
//
// A single claim cannot show this. Every claim is attempt 1 whatever the bound is, so one claim
// looks identical under `max_start_attempts: 1` and under `max_start_attempts: 3`. The defect
// only becomes visible when an occurrence is **started a second time**, and a second start needs
// the first lease to stop being active. Per the worker's own comment, the two automation sweeps
// are the authoritative clock and expire leases from D1 state, so the arc is: claim, wait out
// the TTL, let the sweep expire the lease, then claim again.
//
// The arc, in order, with each step asserting what the NEXT step depends on:
//
//   1. an automation with `max_start_attempts: 1` — the tightest bound the column allows
//      (`CHECK (max_start_attempts BETWEEN 1 AND 3)`), so a second start has nowhere to hide;
//   2. `run_now` for a claimable occurrence, asserted claimable;
//   3. a claim, asserting the winner got a lease AND that the **occurrence's own `attempt`
//      advanced** — the V01-013 assertion, which fails today;
//   4. a second claim while the first lease is still live: refused, no second active lease, and
//      the attempt counter unmoved;
//   5. the lease expired **by the sweep** — proved, not assumed — then a third claim. With
//      `max_start_attempts: 1` this must be refused as an exhausted attempt.
//
// WHY THE ATTEMPT IS READ FROM THE OCCURRENCE AND NOT THE RESPONSE
//
// The claim response carries its own `attempt`, computed from the broken column, so it reads
// `1` on every claim and would report success. The occurrence row is the only place the counter
// is supposed to be *recorded*, so that is what is read, and the two are printed together so a
// divergence between them is visible rather than inferred.
//
// WHY STEP 5 WAITS, AND WHY IT IS BOUNDED
//
// `lease_ttl_seconds` is `CHECK (… BETWEEN 30 AND 3600)`, so 30 seconds is the fastest a lease
// can be made to expire and this case cannot be shortened. The wait is a real wait for the
// product's own clock. It is polled with a deadline rather than assumed: the probe waits for the
// lease to stop being active and the sweep to be the thing that did it, so a third-claim refusal
// cannot be quietly attributed to a lease that was never released. "Refused because the lease
// was still active" and "refused because the attempt was exhausted" are different findings and
// the probe must be able to tell them apart.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runProbe } from "./lib/smoke-harness.mjs";

/**
 * Device routes authenticate with `Authorization: DeviceToken <token>` and never read a
 * session cookie. A jar that could contribute a cookie would let a browser session ride along
 * on a request that is supposed to be device-authenticated, and the case would then prove
 * nothing about the device boundary.
 */
const anonJar = () => ({ header: () => "" });

await runProbe("V01 attempt-exhaustion", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_ATTEMPT_PERSIST_TO", portEnvVar: "V01_ATTEMPT_PORT" });

  // --- a real device identity: ed25519 keypair, real signature ---------------
  // Not test-only stand-in crypto. The enrollment challenge is signed with the same key the
  // device presents, which is the whole point of the device-proof check, and a fake signer would
  // make the case untestable rather than easy.
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
        `the ${label} device could not be enrolled, so no attempt claim would be testable`,
        `status=${enrollment.status} body=${probe.brief(enrollment.payload, 200)}`,
      );
      return null;
    }
    const approval = await request(
      admin.jar,
      "POST",
      `/api/v1/orgs/${admin.orgId}/devices/enrollments/${enrollmentId}/approve`,
      {},
      browserMutation(admin.jar, `v01-attempt-approve-${label}`),
    );
    expectStatus(`CONTROL: the ${label} enrollment is approved`, approval, [201]);
    const status = await request(anonJar(), "GET", `/api/v1/devices/enrollments/${enrollmentId}`);
    expectStatus(`CONTROL: the ${label} enrollment releases a proof challenge`, status, [200]);
    if (typeof status.payload?.challenge !== "string") {
      probe.skip(
        `the ${label} enrollment released no challenge, so its device token cannot be obtained`,
        `status=${status.status} body=${probe.brief(status.payload, 200)}`,
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
    if (typeof token !== "string") {
      probe.skip(
        `the ${label} device returned no token, so the claims below could not be driven`,
        `status=${finished.status} body=${probe.brief(finished.payload, 200)}`,
      );
      return null;
    }
    probe.registerSecret(token);
    return { ...device, token, label };
  };

  // --- fixtures --------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const org = await probe.createOrganization(alice.jar, "Alice Org", `v01-attempt-${probe.nonce}`);
  const orgSlug = (
    await d1Rows(`SELECT slug FROM organizations WHERE org_id = '${org.orgId}'`, "V01 the org slug")
  )[0]?.slug;
  expect(
    "CONTROL: the organization's slug is known, so a device can be enrolled against it",
    typeof orgSlug === "string" && orgSlug.length > 0,
    `slug=${orgSlug ?? "none"}`,
  );
  const admin = { jar: alice.jar, orgId: org.orgId, orgSlug };

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

  const device = await enrolledDevice(admin, orgSlug, "V01 attempt device");
  if (!device) {
    probe.finish(
      2,
      "the device fixture could not be built, so no attempt claim is testable. This is a harness \n" +
        "outcome, not a product verdict.",
    );
    return;
  }

  // --- the automation, with the tightest bound and the shortest lease ---------
  // `max_start_attempts: 1` is the floor the column allows and `lease_ttl_seconds: 30` the
  // ceiling's opposite, so a second start has the fewest places to hide and the wait is the
  // shortest the product permits.
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
    "CONTROL: an automation exists",
    automation.status === 201 && typeof automationId === "string",
    `status=${automation.status} body=${probe.brief(automation.payload, 240)}`,
  );
  if (typeof automationId !== "string") {
    probe.finish(
      2,
      "the automation fixture could not be created, so no attempt claim is testable. This is a \n" +
        "harness outcome, not a product verdict.",
    );
    return;
  }

  // Read the policy back out of the database rather than trusting the request body. Every other
  // assertion in this probe is graded on stored state, and the one that decides whether the
  // final claim should have been refused deserves the same treatment.
  const stored = (
    await d1Rows(
      `SELECT max_start_attempts, lease_ttl_seconds, heartbeat_interval_seconds
         FROM automation_definitions WHERE automation_id = '${automationId}'`,
      "V01 the stored retry policy",
    )
  )[0];
  expect(
    "CONTROL: the STORED automation carries max_start_attempts = 1, so a second start must be refused",
    Number(stored?.max_start_attempts) === 1,
    `stored max_start_attempts=${stored?.max_start_attempts} lease_ttl_seconds=${stored?.lease_ttl_seconds} ` +
      `heartbeat_interval_seconds=${stored?.heartbeat_interval_seconds}`,
  );
  if (Number(stored?.max_start_attempts) !== 1) {
    probe.finish(
      2,
      "the stored retry policy is not the tight one this case needs, so its conclusion would be \n" +
        "about a different bound than it claims. Refusing to grade it.",
    );
    return;
  }

  // --- the occurrence ---------------------------------------------------------
  probe.stage = "occurrence";
  const version = Number(
    (
      await d1Rows(
        `SELECT version FROM automation_definitions WHERE automation_id = '${automationId}'`,
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
    `status=${runNow.status} body=${probe.brief(runNow.payload, 240)}`,
  );
  if (typeof occurrenceId !== "string") {
    probe.finish(2, "no occurrence, so no claim is testable. A harness outcome, not a verdict.");
    return;
  }

  const occurrenceRow = () =>
    d1Rows(
      `SELECT occurrence_id, state, attempt, started_at, state_version
         FROM automation_occurrences WHERE occurrence_id = '${occurrenceId}'`,
      `V01 occurrence ${occurrenceId}`,
    );
  const leases = () =>
    d1Rows(
      `SELECT lease_id, attempt, state FROM automation_leases WHERE occurrence_id = '${occurrenceId}'`,
      `V01 leases for ${occurrenceId}`,
    );
  const activeLeases = async () => (await leases()).filter((l) => l.state === "active");
  const claim = (label) =>
    request(
      anonJar(),
      "POST",
      `/api/v1/devices/automation-occurrences/${occurrenceId}/claim`,
      undefined,
      { Authorization: `DeviceToken ${device.token}` },
    );

  // --- step 3: the first claim -----------------------------------------------
  probe.stage = "first-claim";
  const before = (await occurrenceRow())[0];
  expect(
    "CONTROL: the occurrence is claimable BEFORE any claim, so the refusals after it are refusals of a claimed occurrence",
    before?.state === "pending" || before?.state === "dispatching",
    `state=${before?.state} attempt=${before?.attempt}`,
  );

  const first = await claim("first");
  const afterFirst = (await occurrenceRow())[0];
  const activeAfterFirst = await activeLeases();
  console.log(
    `\n  first claim: http=${first.status} response_attempt=${first.payload?.attempt} ` +
      `occurrence_attempt ${before?.attempt} -> ${afterFirst?.attempt} ` +
      `started_at=${afterFirst?.started_at ?? "null"} active_leases=${activeAfterFirst.length}`,
  );
  expect(
    "CONTROL: the first claim succeeds and takes exactly one active lease, so the refusals after it are real refusals",
    first.status >= 200 && first.status < 300 && activeAfterFirst.length === 1,
    `status=${first.status} active_leases=${activeAfterFirst.length}`,
  );

  expect(
    "V01-013: the occurrence's attempt counter ADVANCES on a successful claim, so a second start is attempt 2 (it does not - TRANSITION_OCCURRENCE_SQL has no attempt in its SET list)",
    Number(afterFirst?.attempt) > Number(before?.attempt),
    `occurrence attempt ${before?.attempt} -> ${afterFirst?.attempt} while the response said ` +
      `${first.payload?.attempt}; max_start_attempts is 1, so this column alone decides the bound`,
  );
  expect(
    "V01-013: a LEASED occurrence records when the work started (it does not - the claim binds None, so COALESCE(started_at, NULL) is NULL)",
    typeof afterFirst?.started_at === "string" && afterFirst.started_at.length === 24,
    `started_at=${afterFirst?.started_at ?? "null"} on a ${afterFirst?.state} occurrence`,
  );

  // --- step 4: a second claim while the first lease is live -------------------
  probe.stage = "second-claim-while-leased";
  const second = await claim("second");
  const afterSecond = (await occurrenceRow())[0];
  const activeAfterSecond = await activeLeases();
  console.log(
    `  second claim while leased: http=${second.status} ` +
      `reason=${second.payload?.error?.details?.reason ?? second.payload?.error?.code ?? "n/a"} ` +
      `occurrence_attempt=${afterSecond?.attempt} active_leases=${activeAfterSecond.length}`,
  );
  expect(
    "a second claim while the first lease is still active is refused, and adds no second active lease",
    second.status >= 400 && activeAfterSecond.length === 1,
    `status=${second.status} active_leases=${activeAfterSecond.length}`,
  );
  expect(
    "the refused second claim did not advance the attempt counter either",
    Number(afterSecond?.attempt) === Number(afterFirst?.attempt),
    `occurrence attempt ${afterFirst?.attempt} -> ${afterSecond?.attempt} on a refused claim`,
  );

  // --- step 5: the lease expires BY THE SWEEP, then a third claim -----------
  //
  // The sweep is the authoritative clock, so this waits for a positive transition — the lease
  // leaving `active` — with a deadline, and the sweep is what drives it. If the lease never
  // expires, the probe says so and stops, because a third claim refused by a still-live lease
  // would look exactly like a correct enforcement.
  probe.stage = "expiry";
  console.log(
    `\n  waiting out the ${stored.lease_ttl_seconds}s lease TTL and the sweep that expires it ` +
      `(the schema's floor for lease_ttl_seconds)...`,
  );
  //
  // Deliberately NOT `waitForD1`. That helper fires the sweep ONCE, about 1.5s in, and the
  // lease cannot be expired that early -- `lease_ttl_seconds` is 30 -- so it would poll for two
  // minutes against a clock that has not been turned and then report "the lease never expired".
  // That would be a false negative for the *attack*: the case would come back UNPROVEN for a
  // reason that is entirely the harness's, which is the same failure shape as
  // `verify:adoption-privacy` reporting "0 hits" over a table full of payloads.
  //
  // So the sweep is driven REPEATEDLY, and the positive transition is what ends the wait.
  const activeLeaseSql = `SELECT lease_id, attempt, state FROM automation_leases
      WHERE occurrence_id = '${occurrenceId}' AND state = 'active'`;
  const EXPIRY_DEADLINE_MS = 120_000;
  const expiryDeadline = Date.now() + EXPIRY_DEADLINE_MS;
  let leaseExpired = false;
  while (Date.now() < expiryDeadline) {
    if ((await d1Rows(activeLeaseSql, `V01 active leases for ${occurrenceId}`)).length === 0) {
      leaseExpired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await probe.triggerSweep();
  }
  if (!leaseExpired) {
    console.log(
      `  the lease was still active ${EXPIRY_DEADLINE_MS / 1000}s after the ${stored.lease_ttl_seconds}s TTL, ` +
        `with the sweep driven every 3s; a final claim here would be refused by a LIVE lease, ` +
        `which is indistinguishable from a correct attempt bound, so this case refuses to grade`,
    );
  }
  const allLeases = await leases();
  console.log(
    `  after the wait: active_leases=${allLeases.filter((l) => l.state === "active").length} ` +
      `states=[${allLeases.map((l) => `${l.lease_id.slice(0, 12)}:${l.state}:attempt=${l.attempt}`).join(" ")}]`,
  );
  expect(
    "the first lease is no longer active before the final claim, so a refusal there is attributable to the attempt bound and not to a live lease",
    leaseExpired,
    `leases: ${JSON.stringify(allLeases)}`,
  );

  // THE CAUSE CONTROL. A refused third claim is only evidence about the ATTEMPT BOUND if the
  // occurrence is still claimable when it is made. If the sweep responded to the expiry by
  // moving the occurrence to a terminal state, the claim would be refused for that reason and
  // the case would report a PASS about a bound it never tested -- the same false negative as
  // the one-shot sweep above, one level up. So the state is asserted to be claimable first,
  // and a terminal state is reported as UNPROVEN rather than as a pass.
  const beforeThird = (await occurrenceRow())[0];
  const claimable = beforeThird?.state === "pending" || beforeThird?.state === "dispatching";
  expect(
    "the occurrence is still CLAIMABLE after the sweep expired its lease, so a refusal below is attributable to the attempt bound and not to a terminal state",
    claimable,
    `state=${beforeThird?.state} attempt=${beforeThird?.attempt} -- if the sweep moved it to a ` +
      `terminal state, the final claim would be refused for that reason and this case would be ` +
      `UNPROVEN rather than passing`,
  );

  const third = await claim("third");
  const afterThird = (await occurrenceRow())[0];
  const activeAfterThird = await activeLeases();
  console.log(
    `  third claim after expiry: http=${third.status} ` +
      `reason=${third.payload?.error?.details?.reason ?? third.payload?.error?.code ?? "n/a"} ` +
      `response_attempt=${third.payload?.attempt ?? "n/a"} ` +
      `occurrence_attempt ${beforeThird?.attempt} -> ${afterThird?.attempt} ` +
      `active_leases=${activeAfterThird.length}\n` +
      `    body=${probe.brief(third.payload, 300)}`,
  );

  // THE CLAIM. `max_start_attempts` is 1 and the lease is gone, so a second START of this
  // occurrence must be refused. If it is not, the bound is not enforced and V01-013 is a live
  // abuse and spend defect rather than a bookkeeping one: one scheduled slot runs twice.
  // The refusal must be the RIGHT refusal, not merely a non-2xx. The first version of this
  // assertion asked only for `status >= 400` and it PASSED on a `503` -- which is the same
  // wrong-reason pass that let `verify:lease-contention` report a partial run as a complete one.
  // A `503` here says the control-plane store is unavailable, and a device that lost its lease
  // and retried would be told the whole store is down rather than that its attempt is spent. So
  // the shape is part of the claim: a 4xx, with a stable reason, and never a 5xx.
  expect(
    "V01-013: with max_start_attempts = 1, an occurrence whose lease EXPIRED cannot be started a second time, and the refusal is a 4xx naming a reason (it is neither: the attempt column never advances, so the bound is never reached, AND the refusal is not a stable 4xx)",
    third.status >= 400 && third.status < 500,
    `the third claim answered ${third.status} with body ${probe.brief(third.payload, 240)} ` +
      `and left ${activeAfterThird.length} active lease(s); a 503 tells a device that lost its lease that the ` +
      `control-plane store is down rather than that its attempt is spent, and a second start of an ` +
      `occurrence bound to one attempt would mean the same scheduled slot running its work twice`,
  );
  expect(
    "the occurrence's attempt counter sits at 1, the number the refused second start would have used",
    Number(afterThird?.attempt) === 1,
    `occurrence attempt=${afterThird?.attempt} (0 means the counter is dead and every claim is attempt 1)`,
  );
  expect(
    "a refused final claim takes no lease, so the attempt bound and lease exclusivity do not disagree",
    activeAfterThird.length === 0,
    `active_leases=${activeAfterThird.length} after a ${third.status} claim`,
  );

  // --- the summary ----------------------------------------------------------
  const everyAttempt = await d1Rows(
    `SELECT attempt, COUNT(*) AS n FROM automation_occurrences GROUP BY attempt`,
    "V01 the distinct attempt values across all occurrences",
  );
  console.log(
    `  distinct occurrence attempt values: ${JSON.stringify(everyAttempt)} ` +
      `(a single value is itself the finding: no occurrence can ever record a second start)`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
