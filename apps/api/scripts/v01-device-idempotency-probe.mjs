#!/usr/bin/env node
// V01-015 — do `approve_enrollment` and `revoke_device` honour an `Idempotency-Key`?
//
// WHAT IS BEING ATTACKED
//
// Both routes require a key and then throw it away:
//
//     idempotency_key(&headers, &context)?;          // devices.rs: approve_enrollment
//     idempotency_key(&headers, &context)?;          // devices.rs: revoke_device
//
// That is V01-009's shape in `projects.rs`, where a discarded key meant six concurrent
// POSTs on one key created six projects. Whether it is as bad here is **not** knowable by
// reading, and this probe is written so that it does not need to be: it measures the stored
// state after a replay and reports whatever happens.
//
// WHAT MAKES THIS CASE NOT PASS FOR THE WRONG REASON
//
// The obvious failure mode of a replay test is that the second call is refused for a reason
// that has nothing to do with the key — the enrollment is no longer `pending`, the device is
// already revoked — and the probe then reports "the key was honoured" when in fact the route
// would have refused a second attempt whatever key arrived. That is exactly how V01-008 hid:
// every cross-tenant attack was correctly refused and the one call that had to *work* answered
// 409, so the probe's own positive control is what found the defect.
//
// So every case here ends with a **different-key** call on the same route with the same
// fixture state. A different key is a different request, so whatever it answers is the
// route's answer to a *genuinely new* request — and that is the reference the replay's
// outcome has to be read against. If the replay and the different-key call answer the same
// thing, the key was ignored. If the replay answers the *first response again* while the
// different-key call does not, the key was honoured.
//
// GRADED ON STORED STATE
//
// Every verdict below is read out of D1, never out of a status code. A 503 that wrote nothing
// and a 201 that wrote a second device are different findings, and only the rows tell them
// apart. The response bodies are compared too, because "replayed the stored response" and
// "re-ran and happened to agree" are different behaviours with the same bytes — so the state
// is checked as well, and both are reported.
//
// NOT PREDICTED, MEASURED
//
// Reading suggests `approve_enrollment` would abort on the second call, because it mints
// `generated_id("dvc")` per call and `INSERT_DEVICE_SQL` sits under a
// `UNIQUE (org_id, key_fingerprint)`, and it never checks `rows_affected`. That is a
// prediction from reading a schema, and this campaign has been wrong about exactly that kind
// of prediction often enough that it is recorded here as a hypothesis to be falsified rather
// than as an expected result. The probe prints what actually happened.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runProbe } from "./lib/smoke-harness.mjs";

/**
 * Device enrollment and the device routes are unauthenticated at the boundary and prove
 * possession with a signature. A jar that could contribute a session cookie would let a
 * browser session ride along, and the case would prove nothing about the device boundary.
 */
const anonJar = () => ({ header: () => "" });

await runProbe("V01 device-route idempotency", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_DEVICE_PERSIST_TO", portEnvVar: "V01_DEVICE_PORT" });

  // --- a real device identity: ed25519 keypair, real signature ---------------
  // The same reason as every other probe in this campaign that enrolls a device: the
  // enrollment challenge is signed with the key the device presents, and a stand-in signer
  // would make the case untestable rather than easy.
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

  // --- fixtures --------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const org = await probe.createOrganization(alice.jar, "Alice Org", `v01-dev-${probe.nonce}`);
  const orgSlug = (
    await d1Rows(`SELECT slug FROM organizations WHERE org_id = '${org.orgId}'`, "V01 the org slug")
  )[0]?.slug;
  expect(
    "CONTROL: the organization's slug is known, so devices can be enrolled against it",
    typeof orgSlug === "string" && orgSlug.length > 0,
    `slug=${orgSlug ?? "none"}`,
  );
  const admin = { jar: alice.jar, orgId: org.orgId, orgSlug };

  /** Begin an enrollment. It stays `pending` until an admin approves it. */
  const beginEnrollment = async (label) => {
    const device = makeDevice(label);
    const created = await request(anonJar(), "POST", "/api/v1/devices/enrollments", {
      org_slug: orgSlug,
      public_key: device.publicKeyPem,
      key_fingerprint: device.keyFingerprint,
      device_name: label,
      platform: "darwin-arm64",
      app_version: "0.5.0",
    });
    const enrollmentId = created.payload?.enrollment_id;
    if (typeof enrollmentId !== "string") {
      probe.skip(
        `the ${label} enrollment could not be begun`,
        `status=${created.status} body=${probe.brief(created.payload, 200)}`,
      );
      return null;
    }
    return { ...device, enrollmentId };
  };

  /** Approve an enrollment, and complete the proof so a real device token exists. */
  const approveAndFinish = async (label, keyLabel) => {
    const pending = await beginEnrollment(label);
    if (!pending) return null;
    const approval = await request(
      admin.jar,
      "POST",
      `/api/v1/orgs/${org.orgId}/devices/enrollments/${pending.enrollmentId}/approve`,
      {},
      browserMutation(admin.jar, keyLabel),
    );
    const status = await request(
      anonJar(),
      "GET",
      `/api/v1/devices/enrollments/${pending.enrollmentId}`,
    );
    if (typeof status.payload?.challenge !== "string") {
      probe.skip(
        `the ${label} enrollment released no challenge`,
        `status=${status.status} body=${probe.brief(status.payload, 200)}`,
      );
      return null;
    }
    const finished = await request(
      anonJar(),
      "POST",
      `/api/v1/devices/enrollments/${pending.enrollmentId}/complete`,
      { signature: pending.sign(status.payload.challenge) },
    );
    return { ...pending, approval, finished };
  };

  /** Everything the two cases need to read out of the database about one enrollment. */
  const storedFor = async (enrollmentId) => {
    const [enrollment] = await d1Rows(
      `SELECT status, device_id FROM device_enrollments WHERE enrollment_id = '${enrollmentId}'`,
      `V01 enrollment ${enrollmentId}`,
    );
    const deviceId = enrollment?.device_id ?? null;
    const devices = await d1Rows(
      `SELECT device_id, key_fingerprint, status FROM devices
        ${deviceId ? `WHERE device_id = '${deviceId}'` : `WHERE org_id = '${org.orgId}' AND key_fingerprint IN (SELECT key_fingerprint FROM device_enrollments WHERE enrollment_id = '${enrollmentId}')`}`,
      `V01 devices for enrollment ${enrollmentId}`,
    );
    const events = await d1Rows(
      `SELECT event_id, action, resource_id, created_at FROM security_events
        WHERE org_id = '${org.orgId}' AND resource_type = 'device' AND outcome = 'success'
        ORDER BY created_at ASC, rowid ASC`,
      `V01 security_events for the org`,
    );
    return { enrollment, deviceId, devices, events };
  };

  /** Compare two responses as bodies, not as statuses. */
  const sameBody = (a, b) =>
    JSON.stringify(a?.payload ?? null) === JSON.stringify(b?.payload ?? null);

  /**
   * Compare two bodies IGNORING `request_id`.
   *
   * This exists because `sameBody` is the wrong tool for the different-key control, and using it
   * there made the control **vacuous**. Every error body carries its own `request_id`, so two
   * refusals identical in every respect a caller can act on still compare as different -- and the
   * control, whose whole job is to notice that a replay and a genuinely new request are answered
   * the same way, could never fire. It reported PASS on a defect it is structurally unable to see,
   * which is the fifth wrong-reason pass of this round.
   *
   * So the control compares everything EXCEPT the per-request correlation id. If the replay and
   * the different-key call differ only in `request_id`, they are the same answer -- which is
   * exactly the question the control asks.
   */
  const withoutRequestId = (payload) => {
    if (!payload || typeof payload !== "object") return payload;
    const { request_id: _ignored, ...rest } = payload;
    if (rest.error && typeof rest.error === "object") {
      const { request_id: _alsoIgnored, ...errorRest } = rest.error;
      return { ...rest, error: errorRest };
    }
    return rest;
  };
  const sameAnswer = (a, b) =>
    JSON.stringify(withoutRequestId(a?.payload)) === JSON.stringify(withoutRequestId(b?.payload));
  const describe = (r) => `status=${r.status} body=${probe.brief(r.payload, 200)}`;

  // =========================================================================
  // Case 1 — approve_enrollment, replayed on one key
  // =========================================================================
  probe.stage = "approve-replay";
  const approveCase = await approveAndFinish("V01 approve device", "v01-dev-approve-1");
  if (!approveCase) {
    probe.finish(2, "the approve fixture could not be built, so the case is untestable");
    return;
  }
  const { enrollmentId } = approveCase;
  const firstApproval = approveCase.approval;
  expectStatus("CONTROL: the first approval succeeds", firstApproval, [201]);
  const afterFirst = await storedFor(enrollmentId);
  console.log(
    `\n  approve: first -> ${describe(firstApproval)}\n` +
      `    stored: enrollment status=${afterFirst.enrollment?.status} device_id=${afterFirst.deviceId} ` +
      `devices=${afterFirst.devices.length} audit_events=${afterFirst.events.length}`,
  );
  expect(
    "CONTROL: the first approval wrote exactly ONE device and ONE audit event, so a replay that changes either is measurable",
    afterFirst.devices.length === 1 && afterFirst.events.length === 1,
    `devices=${JSON.stringify(afterFirst.devices)} events=${JSON.stringify(afterFirst.events)}`,
  );

  // THE REPLAY: the same key again, byte for byte.
  const replayApproval = await request(
    admin.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/devices/enrollments/${enrollmentId}/approve`,
    {},
    browserMutation(admin.jar, "v01-dev-approve-1"),
  );
  const afterReplay = await storedFor(enrollmentId);
  console.log(`  approve: replay -> ${describe(replayApproval)}`);
  console.log(
    `    stored: devices=${afterReplay.devices.length} audit_events=${afterReplay.events.length} ` +
      `device_id=${afterReplay.deviceId ?? "none"}`,
  );
  expect(
    "V01-015: replaying the approval on the SAME key writes nothing new -- one device, one audit event (the route discards the key at devices.rs)",
    afterReplay.devices.length === 1 && afterReplay.events.length === 1,
    `after the replay: devices=${JSON.stringify(afterReplay.devices)} events=${JSON.stringify(afterReplay.events)}`,
  );
  expect(
    "V01-015: replaying the approval on the SAME key replays the FIRST response, status and body alike",
    replayApproval.status === firstApproval.status && sameBody(replayApproval, firstApproval),
    `first ${describe(firstApproval)} vs replay ${describe(replayApproval)}`,
  );

  // THE POSITIVE CONTROL. A different key is a different request, so this is the route's
  // answer to a genuinely new one. Without it, the two assertions above would be satisfied by
  // a route that simply refuses every second approval whatever key arrived.
  const differentKeyApproval = await request(
    admin.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/devices/enrollments/${enrollmentId}/approve`,
    {},
    browserMutation(admin.jar, "v01-dev-approve-2"),
  );
  const afterDifferentKey = await storedFor(enrollmentId);
  console.log(`  approve: DIFFERENT key -> ${describe(differentKeyApproval)}`);
  console.log(
    `    stored: devices=${afterDifferentKey.devices.length} audit_events=${afterDifferentKey.events.length}`,
  );
  expect(
    "CONTROL: a DIFFERENT key on the already-approved enrollment is not a second success",
    !(differentKeyApproval.status >= 200 && differentKeyApproval.status < 300) ||
      afterDifferentKey.devices.length === 1,
    `status=${differentKeyApproval.status} devices=${afterDifferentKey.devices.length} -- ` +
      `this is the reference the replay's outcome has to be read against`,
  );
  expect(
    "the two outcomes are distinguishable: the replay and the different-key call do not both answer the same thing, or the route is refusing repeats for a reason unrelated to the key",
    !(
      sameAnswer(replayApproval, differentKeyApproval) &&
      replayApproval.status === differentKeyApproval.status
    ) || afterReplay.events.length !== afterDifferentKey.events.length,
    `replay ${describe(replayApproval)} vs different-key ${describe(differentKeyApproval)}; ` +
      `audit_events after replay=${afterReplay.events.length} after different key=${afterDifferentKey.events.length}`,
  );

  // =========================================================================
  // Case 2 — revoke_device, replayed on one key
  // =========================================================================
  // A second, independent device, so case 1's state cannot make case 2's refusals look right.
  probe.stage = "revoke-replay";
  const revokeCase = await approveAndFinish("V01 revoke device", "v01-dev-revoke-setup");
  if (!revokeCase) {
    probe.finish(2, "the revoke fixture could not be built, so the case is untestable");
    return;
  }
  const revokeDeviceId =
    revokeCase.approval?.payload?.device?.device_id ?? revokeCase.approval?.payload?.device?.id;
  expect(
    "CONTROL: the second device was really approved, so there is something to revoke",
    typeof revokeDeviceId === "string",
    `status=${revokeCase.approval?.status} body=${probe.brief(revokeCase.approval?.payload, 200)}`,
  );
  if (typeof revokeDeviceId !== "string") {
    probe.finish(2, "no device id, so the revoke case is untestable");
    return;
  }

  const deviceState = async () =>
    d1Rows(
      `SELECT device_id, status, revoked_at FROM devices WHERE device_id = '${revokeDeviceId}'`,
      `V01 device ${revokeDeviceId}`,
    );
  const tokensFor = async () =>
    d1Rows(
      `SELECT COUNT(*) AS n FROM device_tokens WHERE device_id = '${revokeDeviceId}'`,
      `V01 tokens for ${revokeDeviceId}`,
    );

  const beforeRevoke = await deviceState();
  const beforeTokens = await tokensFor();
  const firstRevoke = await request(
    admin.jar,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${revokeDeviceId}`,
    {},
    browserMutation(admin.jar, "v01-dev-revoke-1"),
  );
  const afterFirstRevoke = await deviceState();
  const afterFirstTokens = await tokensFor();
  console.log(
    `\n  revoke: first -> ${describe(firstRevoke)}\n` +
      `    stored: status ${beforeRevoke[0]?.status} -> ${afterFirstRevoke[0]?.status} ` +
      `revoked_at=${afterFirstRevoke[0]?.revoked_at ?? "null"} ` +
      `tokens ${beforeTokens[0]?.n} -> ${afterFirstTokens[0]?.n}`,
  );
  expect(
    "CONTROL: the first revoke took effect and dropped the device's tokens",
    firstRevoke.status >= 200 &&
      firstRevoke.status < 300 &&
      afterFirstRevoke[0]?.status === "revoked" &&
      Number(afterFirstTokens[0]?.n) < Number(beforeTokens[0]?.n),
    `status=${firstRevoke.status} device=${JSON.stringify(afterFirstRevoke[0])} tokens ${beforeTokens[0]?.n} -> ${afterFirstTokens[0]?.n}`,
  );

  const replayRevoke = await request(
    admin.jar,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${revokeDeviceId}`,
    {},
    browserMutation(admin.jar, "v01-dev-revoke-1"),
  );
  const afterReplayRevoke = await deviceState();
  console.log(`  revoke: replay -> ${describe(replayRevoke)}`);
  console.log(
    `    stored: status=${afterReplayRevoke[0]?.status} revoked_at=${afterReplayRevoke[0]?.revoked_at ?? "null"}`,
  );
  expect(
    "V01-015: replaying the revoke on the SAME key replays the FIRST response rather than re-running it (the route discards the key at devices.rs)",
    replayRevoke.status === firstRevoke.status && sameBody(replayRevoke, firstRevoke),
    `first ${describe(firstRevoke)} vs replay ${describe(replayRevoke)}`,
  );
  expect(
    "V01-015: the replayed revoke left the revocation timestamp alone, so it did not re-run the write",
    afterReplayRevoke[0]?.revoked_at === afterFirstRevoke[0]?.revoked_at,
    `revoked_at ${afterFirstRevoke[0]?.revoked_at ?? "null"} -> ${afterReplayRevoke[0]?.revoked_at ?? "null"}`,
  );

  const differentKeyRevoke = await request(
    admin.jar,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${revokeDeviceId}`,
    {},
    browserMutation(admin.jar, "v01-dev-revoke-2"),
  );
  console.log(`  revoke: DIFFERENT key -> ${describe(differentKeyRevoke)}`);
  // No disjunct here on purpose. If the replay and a genuinely new request answer the SAME
  // thing, then nothing about the key is being honoured -- the route is answering both from an
  // incidental state guard (`REVOKE_DEVICE_SQL` is `WHERE status = 'active'`, so a second
  // revoke matches no rows and returns early). That is safe today and is not idempotency, and a
  // disjunct that let a differing first-response status excuse it would report exactly the
  // thing this probe exists to catch.
  expect(
    "CONTROL: a DIFFERENT key on the already-revoked device is answered DIFFERENTLY from the replay, so the key is what distinguishes them",
    !(
      sameAnswer(replayRevoke, differentKeyRevoke) &&
      replayRevoke.status === differentKeyRevoke.status
    ),
    `replay ${describe(replayRevoke)} vs different-key ${describe(differentKeyRevoke)}; identical answers ` +
      `mean the route is refusing repeats from a state guard rather than honouring the key`,
  );
  // The audit-integrity claim, which does not depend on the response at all.
  const revokeEvents = async () =>
    d1Rows(
      `SELECT event_id, action, created_at FROM security_events
        WHERE org_id = '${org.orgId}' AND resource_type = 'device' AND resource_id = '${revokeDeviceId}'
        ORDER BY created_at ASC, rowid ASC`,
      `V01 audit events for the revoked device`,
    );
  const eventsAfterFirstRevoke = await revokeEvents();
  await request(
    admin.jar,
    "DELETE",
    `/api/v1/orgs/${org.orgId}/devices/${revokeDeviceId}`,
    {},
    browserMutation(admin.jar, "v01-dev-revoke-1"),
  );
  const eventsAfterRevokeReplay = await revokeEvents();
  console.log(
    `    audit events for the revoked device: ${eventsAfterFirstRevoke.length} -> ${eventsAfterRevokeReplay.length}`,
  );
  expect(
    "V01-015: a replayed revoke records no additional audit event for the device",
    eventsAfterRevokeReplay.length === eventsAfterFirstRevoke.length,
    `audit events ${eventsAfterFirstRevoke.length} -> ${eventsAfterRevokeReplay.length}`,
  );

  // --- the summary ----------------------------------------------------------
  const orgEvents = await d1Rows(
    `SELECT action, resource_id, COUNT(*) AS n FROM security_events
      WHERE org_id = '${org.orgId}' AND resource_type = 'device' AND outcome = 'success'
      GROUP BY action, resource_id ORDER BY n DESC`,
    "V01 device audit events grouped by action and resource",
  );
  console.log(
    `\n  device audit events by action and resource: ${JSON.stringify(orgEvents)}\n` +
      `  (any n above 1 is one logical action recorded more than once, which is the audit-integrity ` +
      `half of a discarded key)`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
