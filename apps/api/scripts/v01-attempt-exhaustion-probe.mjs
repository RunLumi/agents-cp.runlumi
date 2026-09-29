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
      `SELECT occurrence_id, state, attempt, started_at, state_version, reason_code
         FROM automation_occurrences WHERE occurrence_id = '${occurrenceId}'`,
      `V01 occurrence ${occurrenceId}`,
    );
  const leases = () =>
    d1Rows(
      `SELECT lease_id, attempt, state FROM automation_leases WHERE occurrence_id = '${occurrenceId}'`,
      `V01 leases for ${occurrenceId}`,
    );
  const activeLeases = async () => (await leases()).filter((l) => l.state === "active");
  // The id is a PARAMETER, not a closure over the first occurrence. It was, and the two-phase
  // case below therefore re-claimed the already-leased occurrence and read the resulting 409 as a
  // product failure. One case's target must never be implied by another case's.
  const claimOn = (id) =>
    request(anonJar(), "POST", `/api/v1/devices/automation-occurrences/${id}/claim`, undefined, {
      Authorization: `DeviceToken ${device.token}`,
    });
  const claim = () => claimOn(occurrenceId);

  // --- step 3: the first claim -----------------------------------------------
  probe.stage = "first-claim";
  const before = (await occurrenceRow())[0];
  expect(
    "CONTROL: the occurrence is claimable BEFORE any claim, so the refusals after it are refusals of a claimed occurrence",
    before?.state === "pending" || before?.state === "dispatching",
    `state=${before?.state} attempt=${before?.attempt}`,
  );

  const first = await claim();
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
  // NOT a defect, and worth pinning so nobody "fixes" it later: a LEASED occurrence has no
  // `started_at`, and that is correct. Starting work is a SEPARATE transition
  // (`POST /devices/automation-occurrences/{id}/start`, which mints the run, session and link), so
  // "has the lease" and "has begun work" are different facts. Collapsing them would destroy the
  // only signal that distinguishes a lease that was taken and never used from one that started and
  // stalled, which is what the expiry sweep and any stuck-work report depend on.
  //
  // My first version of this probe asserted the opposite -- that a leased occurrence SHOULD carry
  // a start time -- and would have "fixed" a deliberate two-phase design. Reading the route table
  // is what caught it.
  expect(
    "CONTROL: a LEASED-but-not-started occurrence has NO started_at, which is what distinguishes a lease taken and never used from one that started and stalled",
    afterFirst?.started_at === null || afterFirst?.started_at === undefined,
    `started_at=${afterFirst?.started_at ?? "null"} on a ${afterFirst?.state} occurrence -- a non-null ` +
      `value here would mean the claim and the start had been collapsed into one transition`,
  );

  // --- the two-phase start, on its OWN occurrence -----------------------------
  //
  // A separate occurrence, because calling `start_occurrence` moves this one to `started` and the
  // expiry arc below needs it to stay `leased` and then `pending` again. One case's action must not
  // be able to make the next case's precondition false.
  probe.stage = "two-phase-start";
  const newOccurrence = async (label) => {
    const v = Number(
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
      { version: v },
      browserMutation(alice.jar, `v01-attempt-runnow-${label}`),
    );
    const id = runNow.payload?.occurrence?.occurrence_id ?? runNow.payload?.occurrence_id;
    expect(
      `CONTROL: run_now created an occurrence for the ${label} case`,
      typeof id === "string",
      `status=${runNow.status} body=${probe.brief(runNow.payload, 200)}`,
    );
    return typeof id === "string" ? id : null;
  };
  const startOccurrence = (id, lease) =>
    request(
      anonJar(),
      "POST",
      `/api/v1/devices/automation-occurrences/${id}/start`,
      {
        lease_id: lease.lease_id,
        lease_version: lease.lease_version,
        lease_fence: lease.lease_fence,
        lease_token: lease.lease_token,
      },
      { Authorization: `DeviceToken ${device.token}` },
    );
  const rowFor = (id) =>
    d1Rows(
      `SELECT occurrence_id, state, attempt, started_at, run_id, state_version
         FROM automation_occurrences WHERE occurrence_id = '${id}'`,
      `V01 occurrence ${id}`,
    );

  const startId = await newOccurrence("two-phase-start");
  if (startId) {
    const claimed = await claimOn(startId);
    const lease = claimed.payload ?? {};
    const afterClaim = (await rowFor(startId))[0];
    console.log(
      `\n  two-phase: claim -> ${claimed.status} state=${afterClaim?.state} ` +
        `attempt=${afterClaim?.attempt} started_at=${afterClaim?.started_at ?? "null"} ` +
        `run_id=${afterClaim?.run_id ?? "null"}`,
    );
    expect(
      "the claim allocated the attempt: the occurrence's own attempt column now records it, and that is the counter `max_start_attempts` reads",
      Number(afterClaim?.attempt) === 1 && Number(lease.attempt) === 1,
      `occurrence attempt=${afterClaim?.attempt} while the response said ${lease.attempt} -- these ` +
        `used to agree only by accident, because the column was written by nothing`,
    );

    const started = await startOccurrence(startId, lease);
    const afterStart = (await rowFor(startId))[0];
    console.log(
      `  two-phase: start -> ${started.status} state=${afterStart?.state} ` +
        `attempt=${afterStart?.attempt} started_at=${afterStart?.started_at ?? "null"} ` +
        `run_id=${afterStart?.run_id ?? "null"}` +
        (started.status === 403
          ? ` reason=${started.payload?.error?.details?.reason ?? "n/a"}`
          : ""),
    );

    // THE START HALF OF THIS CASE MOVED, and the reason is worth recording.
    //
    // It used to be a named SKIP: `start_occurrence` re-reads the entitlement immediately before
    // creating the run and this organization held none, so the two-phase transition could not be
    // observed here at all. The comment recorded the consequence honestly -- "the recorded severity of
    // the `started_at` half of V01-013 rests on reading the route until that exists" -- and the
    // recorded GAP-008 said the same: the probe needed an entitled organization.
    //
    // **It was never an environmental gap.** V01-023 was behind it: `start_occurrence` could not
    // succeed for ANY organization, entitled or not, because one of its four batch guards asserted
    // the presence of a run link and `NOT EXISTS` inverted it -- so the guard aborted precisely when
    // there was no link, i.e. on every legitimate first start. A live defect sat behind a recorded
    // coverage limitation for the life of the probe, undiscoverable without an entitled org.
    //
    // The OBS-001 control below now grants the entitlement and asserts BOTH of these things against
    // a start that genuinely succeeds, so the assertion is stronger than the one it replaces rather
    // than merely relocated. The claim half above stays, because it is about attempt allocation and
    // the control's occurrence is a different row.
    void started;
    void afterStart;
  }

  // --- step 4: a second claim while the first lease is live -------------------
  probe.stage = "second-claim-while-leased";
  const second = await claim();
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
  // The requirement is NOT "the occurrence is still claimable". With `max_start_attempts: 1` and
  // the occurrence's attempt correctly recorded as 1, exhausting the bound IS the correct outcome,
  // and the sweep's job is to make the slot terminal rather than hand it back. My first version
  // demanded `pending`, which would have failed a CORRECT repair and passed the DEFECT -- because
  // with the dead column the sweep saw `attempt = 0`, computed `0 + 1 <= 1`, concluded there were
  // attempts left, and returned the slot to `pending`. Then the third claim hit the attempt-row
  // collision and answered a detail-less 503.
  //
  // So the control states the real requirement: the sweep must resolve the slot EITHER way, and
  // with a bound of 1 it must be the terminal way, with the reason naming exhaustion. Both of
  // those were false before the repair, in opposite directions, and only the second was visible.
  const terminal = ["failed", "succeeded", "cancelled", "skipped"].includes(beforeThird?.state);
  const exhaustedForBound =
    terminal &&
    Number(beforeThird?.attempt) >= 1 &&
    typeof beforeThird?.reason_code === "string" &&
    /exhaust|retry/i.test(beforeThird.reason_code);
  expect(
    "after the sweep expired the lease, the slot is resolved: with max_start_attempts = 1 and attempt = 1 the bound is EXHAUSTED, so the sweep must make the slot terminal with a reason naming exhaustion",
    exhaustedForBound,
    `state=${beforeThird?.state} attempt=${beforeThird?.attempt} ` +
      `reason_code=${beforeThird?.reason_code ?? "null"} -- before the repair this read ` +
      `state=pending attempt=0 reason=null, i.e. the sweep believed an attempt remained and handed ` +
      `the slot back, which is how a spent slot looked unspent`,
  );
  expect(
    "the exhaustion was reached by COUNTING the recorded attempt, so the counter the bound reads is the one the sweep used",
    Number(beforeThird?.attempt) === 1,
    `occurrence attempt=${beforeThird?.attempt}; the sweep's own reason is ` +
      `${beforeThird?.reason_code ?? "null"}`,
  );

  const third = await claim();
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

  // =========================================================================
  // OBS-001 -- a CLAIM that can never START, and the attempt it consumes.
  // =========================================================================
  //
  // `claim_occurrence` and `start_occurrence` do not agree on what makes an occurrence workable.
  // `start_occurrence` re-reads dispatch eligibility immediately before creating the run and refuses
  // when the organization cannot dispatch ("a value captured at schedule creation is never
  // authority"). `claim_occurrence` reads the occurrence and the retry policy, computes
  // `attempt = occurrence.attempt + 1`, checks it against `max_start_attempts`, and hands out a
  // lease. It never asks whether the automation is dispatchable.
  //
  // So the ATTEMPT is consumed at claim time for work that provably cannot start. With the tightest
  // legal bound (`max_start_attempts: 1`, which is what this probe's automation uses) one such claim
  // leaves the occurrence permanently unstartable: the budget is spent, the run does not exist, and
  // the sweep resolves the slot to `failed`. The claim is the only place the counter moves, so a
  // check at start time cannot undo it.
  //
  // WHO can do this: any active device in the organization. It is not cross-tenant, so the severity
  // is availability of the org's own automations rather than isolation -- but the state it leaves is
  // durable, and `verify:attempt-exhaustion` exists precisely because that counter is the thing
  // standing between a failing automation and an infinite retry loop.
  //
  // THE ORDER MATTERS, and it is the reason this is two cases and not one:
  //   1. ATTACK, on the unentitled organization this probe already has: claim succeeds, start is
  //      refused, and the occurrence is left with a spent attempt and no run.
  //   2. CONTROL, on the SAME organization once it is granted the entitlement: claim then start
  //      SUCCEEDS and a run exists.
  //
  // The control is what makes the attack's assertion mean anything. "No run was created" is
  // satisfied by an organization that can never start anything -- which is the state the attack
  // asserts about -- so without a positive case the attack grades its own premise. The control also
  // closes this probe's long-standing named SKIP, because the two-phase START transition can only be
  // observed where a start actually succeeds.
  probe.stage = "claim-without-dispatch";
  const grantAutomationEntitlement = async (orgId, label) => {
    // `entitlement_grants` is empty in every seeded database, which is why this probe's organization
    // is unentitled. Seeding a grant is a FIXTURE, not a relaxation: it makes the control stricter by
    // giving the product somewhere it is *allowed* to succeed, so the attack's refusal is
    // attributable to the missing entitlement rather than to the harness never having tried.
    //
    // `value_json` is a bare JSON integer (the repository deserialises it with `from_str::<i64>`),
    // and the F18 CHECK -- an override must expire, carry a reason and name a grantor -- applies only
    // to `source = 'internal_override'`, so a `plan` grant needs none of that.
    // `grant_id` is CHECKed to be EXACTLY 36 characters with an `egr_` prefix. My first attempt
    // built it from the nonce plus a label and came out 28 characters, so the INSERT was refused by
    // the schema and the probe DIED -- 41 assertions in, with the control never reached. Worth
    // recording because that failure mode is the expensive kind: the attack half had already printed
    // four PASSes, so the sheet looked healthy right up until the run refused to finish.
    //
    // So the shape is asserted before the statement runs. A fixture that silently writes nothing is
    // indistinguishable from one that worked, and this campaign has now hit that three ways.
    const grantId = `egr_${createHash("sha256")
      .update(`${probe.nonce}-${label}`)
      .digest("hex")
      .slice(0, 32)}`;
    if (!/^egr_[0-9a-f]{32}$/.test(grantId)) {
      probe.finish(
        2,
        `the entitlement grant id ${grantId} is not 36 characters, so the schema would refuse it`,
      );
      return null;
    }
    // 24 characters, `????-??-??T??:??:??.???Z`, because three columns CHECK `length(...) = 24`.
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
    await d1Rows(
      `INSERT INTO entitlement_grants
         (grant_id, org_id, entitlement_key, scope, value_json, source, effective_at, created_at, updated_at)
       VALUES ('${grantId}', '${orgId}', 'automations.max_active', 'organization', '5', 'plan',
               '${now}', '${now}', '${now}')`,
      `V01 granting automations.max_active to ${label}`,
    );
    const rows = await d1Rows(
      `SELECT entitlement_key, value_json FROM entitlement_grants
        WHERE org_id = '${orgId}' AND entitlement_key = 'automations.max_active' AND revoked_at IS NULL`,
      `V01 the grant is readable by the product's own query`,
    );
    return rows.length === 1 ? rows[0] : null;
  };

  const attackId = await newOccurrence("obs-001-attack");
  if (attackId) {
    // Assert the precondition rather than assuming it: an attack on an organization that IS entitled
    // would be measuring nothing, and the two cases below would be indistinguishable.
    const eligibleBefore = await d1Rows(
      `SELECT COUNT(*) AS n FROM entitlement_grants
        WHERE org_id = '${org.orgId}' AND entitlement_key = 'automations.max_active' AND revoked_at IS NULL`,
      "V01 the attack organization holds no automation entitlement",
    );
    expect(
      "CONTROL: the attack organization holds NO automation entitlement, so a start refusal is attributable to the entitlement and not to something else",
      Number(eligibleBefore[0]?.n ?? 0) === 0,
      `grants=${eligibleBefore[0]?.n ?? "unread"} -- without this the attack below and its control ` +
        `would be the same case twice, and "no run was created" would be vacuous`,
    );

    const attackClaim = await claimOn(attackId);
    const attackLease = attackClaim.payload ?? {};
    const afterAttackClaim = (await rowFor(attackId))[0];
    const activeLeases = await d1Rows(
      `SELECT COUNT(*) AS n FROM automation_leases
        WHERE occurrence_id = '${attackId}' AND state = 'active'`,
      "V01 the lease the claim created",
    );
    console.log(
      `\n  OBS-001 attack: claim -> ${attackClaim.status} state=${afterAttackClaim?.state} ` +
        `attempt=${afterAttackClaim?.attempt} active_leases=${activeLeases[0]?.n ?? "?"} ` +
        `run_id=${afterAttackClaim?.run_id ?? "null"}`,
    );
    expect(
      "CONTROL: the claim SUCCEEDED on an organization that cannot dispatch, so the asymmetry below is real and not a refusal I mistook for one",
      attackClaim.status >= 200 && attackClaim.status < 300,
      `claim status=${attackClaim.status} body=${probe.brief(attackClaim.payload, 200)}`,
    );
    expect(
      "OBS-001: the claim consumed an attempt and an active lease for an occurrence that can never start",
      Number(afterAttackClaim?.attempt) === 1 && Number(activeLeases[0]?.n ?? 0) === 1,
      `after the claim: attempt=${afterAttackClaim?.attempt} active_leases=${activeLeases[0]?.n} ` +
        `run_id=${afterAttackClaim?.run_id ?? "null"} -- the attempt counter is the automation's whole ` +
        `retry budget, and this occurrence's is now spent on work the product will refuse to start`,
    );

    const attackStart = await startOccurrence(attackId, attackLease);
    const afterAttackStart = (await rowFor(attackId))[0];
    console.log(
      `  OBS-001 attack: start -> ${attackStart.status} ` +
        `code=${attackStart.payload?.error?.code ?? "none"} ` +
        `reason=${attackStart.payload?.error?.details?.reason ?? "n/a"} ` +
        `state=${afterAttackStart?.state} attempt=${afterAttackStart?.attempt} ` +
        `run_id=${afterAttackStart?.run_id ?? "null"}`,
    );
    expect(
      "OBS-001: the start is REFUSED for want of dispatch eligibility, which is what makes the attempt spent for nothing",
      attackStart.status === 403,
      `start status=${attackStart.status} code=${attackStart.payload?.error?.code ?? "none"} ` +
        `reason=${attackStart.payload?.error?.details?.reason ?? "n/a"} body=${probe.brief(attackStart.payload, 200)}`,
    );
    expect(
      "OBS-001: no run exists after a claim and a refused start, so the attempt bought nothing",
      afterAttackStart?.run_id === null || afterAttackStart?.run_id === undefined,
      `run_id=${afterAttackStart?.run_id ?? "null"} state=${afterAttackStart?.state} ` +
        `attempt=${afterAttackStart?.attempt} -- this is the durable damage: the occurrence is at its ` +
        `attempt ceiling with no run, and this probe's automation has max_start_attempts = 1`,
    );
    expect(
      "OBS-001: the spent attempt is recorded on the OCCURRENCE, so nothing downstream can un-spend it",
      Number(afterAttackStart?.attempt) === 1,
      `attempt=${afterAttackStart?.attempt} -- a check at start time cannot undo a counter that the ` +
        `claim already moved, which is why the claim is the only place this can be prevented`,
    );
  }

  // --- the entitled control: the same two calls, on an organization that may dispatch ----------
  probe.stage = "entitled-control";
  const granted = await grantAutomationEntitlement(org.orgId, "control");
  expect(
    "CONTROL: the entitlement grant is present and readable, so a successful start below is attributable to the grant",
    granted !== null,
    `grants found=${granted === null ? 0 : 1} -- without this, "the start creates no run" in the ` +
      `attack above would be exactly what a successful start looks like`,
  );
  const controlId = await newOccurrence("obs-001-control");
  if (controlId && granted) {
    const controlClaim = await claimOn(controlId);
    const controlLease = controlClaim.payload ?? {};
    const storedLease = await d1Rows(
      `SELECT lease_id, state, attempt, lease_version, lease_fence, lease_token_fingerprint
         FROM automation_leases WHERE occurrence_id = '${controlId}'`,
      "V01 the stored lease the control's start must match",
    );
    const presentedFingerprint = `sha256:${createHash("sha256")
      .update(controlLease.lease_token ?? "")
      .digest("hex")}`;
    console.log(`  OBS-001 control: claim body = ${probe.brief(controlClaim.payload, 300)}`);
    console.log(
      `  OBS-001 control: presented lease_version=${controlLease.lease_version} ` +
        `lease_fence=${controlLease.lease_fence} fingerprint=${presentedFingerprint}`,
    );
    console.log(`  OBS-001 control: stored lease=${JSON.stringify(storedLease)}`);
    const controlStart = await startOccurrence(controlId, controlLease);
    const afterControl = (await rowFor(controlId))[0];
    // DIAGNOSTIC, and deliberately only on failure.
    //
    // `start_occurrence` maps a guard abort to `lease_fence_invalid`, and the abort's own text is the
    // only thing that distinguishes "a lost race" from "a guard that always fires" -- which is
    // exactly how V01-023 stayed invisible, and how it was finally found. The route now logs that
    // text (the V01-010 shape: a batch error that was reported as something else and discarded), so
    // when this case fails the cause is one line away instead of four wrong hypotheses deep.
    //
    // The polarity itself is NOT checked here. It is pinned by `pnpm guard:probe`, against real
    // SQLite, for all nine guards in both states -- which is the right layer, because a guard is a
    // property of its SQL and its tables and has nothing to do with a Worker. An earlier version of
    // this case rebuilt the four guards by hand and read them AFTER the start, so it graded
    // post-transition state; every one of those checks is now gone, and the matrix that replaced them
    // fails when a tenth guard appears.
    if (controlStart.status < 200 || controlStart.status >= 300) {
      const plain = probe.workerConsole(60_000).replace(/\[[0-9;]*m/g, "");
      const at = plain.lastIndexOf("the underlying error was");
      console.log(
        at >= 0
          ? `  OBS-001 control: the route logged -> ${plain.slice(at, at + 1200).replace(/\s+/g, " ")}`
          : "  OBS-001 control: the route logged nothing, so this is not a guard abort",
      );
    }
    const controlRuns = await d1Rows(
      `SELECT COUNT(*) AS n FROM automation_run_links WHERE occurrence_id = '${controlId}'`,
      "V01 the run link the control's start created",
    );
    console.log(
      `  OBS-001 control: claim -> ${controlClaim.status}, start -> ${controlStart.status} ` +
        `state=${afterControl?.state} attempt=${afterControl?.attempt} ` +
        `run_id=${afterControl?.run_id ?? "null"} run_links=${controlRuns[0]?.n ?? "?"}`,
    );
    expect(
      "CONTROL: on the SAME organization once entitled, claim then start SUCCEEDS and a run exists -- so the attack measured the entitlement, not the harness",
      controlStart.status >= 200 &&
        controlStart.status < 300 &&
        typeof afterControl?.run_id === "string" &&
        Number(controlRuns[0]?.n ?? 0) >= 1,
      `claim=${controlClaim.status} start=${controlStart.status} body=${probe.brief(controlStart.payload, 200)} ` +
        `run_id=${afterControl?.run_id ?? "null"} run_links=${controlRuns[0]?.n ?? "?"}`,
    );
    // This is the probe's former named SKIP, and it is only observable here: a start that succeeds
    // is the only way to see whether the START transition records `started_at`.
    expect(
      "V01-013: the START transition records started_at, now that a start actually succeeds",
      typeof afterControl?.started_at === "string" && afterControl.started_at.length === 24,
      `started_at=${afterControl?.started_at ?? "null"} state=${afterControl?.state} -- this case was a ` +
        `named SKIP for the whole life of the probe because no organization here was entitled`,
    );
    expect(
      "V01-013: the START transition does NOT advance the attempt counter",
      Number(afterControl?.attempt) === 1,
      `attempt=${afterControl?.attempt} -- the claim allocated it; a start that also incremented would ` +
        `consume the whole budget on a single attempt`,
    );
  }

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
