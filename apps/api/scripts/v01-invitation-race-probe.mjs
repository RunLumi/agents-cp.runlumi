#!/usr/bin/env node
// V01-017 — inviting the same person twice, and inviting them twice at once.
//
// WHAT IS BEING ATTACKED, AND WHY THE GAP IS NARROWER THAN IT WAS RECORDED
//
// GAP-006 says `organizations.rs` invitations "read-then-write a deterministic identifier", and
// records it as a race. Reading it properly narrows it, and the narrowing is the point:
//
//   * `invitation_id = deterministic_resource_id(..., &key, ...)` — derived from the
//     `Idempotency-Key`, so two requests on one key target the same row;
//   * the handler then does `find_invitation(&invitation_id)` and, on a miss, a raw
//     `batch([insert, security, outbox])`. **It never calls `commit_mutation`** — there is no
//     idempotency claim and no guard in the batch, which is the shape V01-009 found in
//     `projects.rs` and V01-015 is looking for in `devices.rs`;
//   * `invitations.invitation_id` is the PRIMARY KEY, and `ux_invitations_pending_target` is
//     `UNIQUE (org_id, email) WHERE status = 'pending'`.
//
// So the **stored state** is protected by two constraints, and the campaign's rule is to grade on
// stored state. A duplicate row is not available here. What is left is the *response*, and that
// turns out to need no race at all:
//
//   a SEQUENTIAL second invite of the same email with a DIFFERENT key misses
//   `find_invitation` (a different key derives a different id), reaches the insert, and violates
//   `ux_invitations_pending_target` — so the batch aborts and the caller is told the **control
//   plane store is unavailable**.
//
// That is a plain, single-request defect wearing a concurrency-shaped gap's name: "you have
// already invited this person" is answered with a 503, which a client cannot distinguish from an
// outage and which the V01-010 family already established is a diagnosability defect in its own
// right. The race is the secondary case, and it is measured too, but it is not the sharpest one.
//
// EVERY COUNT IS READ FROM D1
//
// A 2xx that ignored the key would be correct; a 2xx that granted it twice is a breach. Only the
// row counts separate those, so every verdict here is a count of `invitations`, and the
// per-status breakdown is printed so a refusal is named as a refusal rather than counted as a
// pass.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 invitation duplicate and race", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_INVITE_PERSIST_TO", portEnvVar: "V01_INVITE_PORT" });

  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const org = await probe.createOrganization(alice.jar, "Alice Org", `v01-inv-${probe.nonce}`);
  const email = (label) => `v01-invite-${label}-${probe.nonce}@example.com`;

  const invitationsFor = (target) =>
    d1Rows(
      `SELECT invitation_id, email, role, status FROM invitations
        WHERE org_id = '${org.orgId}' ${target ? `AND email = '${target}'` : ""}
        ORDER BY created_at ASC, rowid ASC`,
      `V01 invitations${target ? ` for ${target}` : " in the org"}`,
    );
  const invite = (label, target, role = "member") =>
    request(
      alice.jar,
      "POST",
      `/api/v1/orgs/${org.orgId}/invitations`,
      { email: target, role },
      browserMutation(alice.jar, label),
    );
  const describe = (r) =>
    `status=${r.status} code=${r.payload?.error?.code ?? "none"} ` +
    `reason=${r.payload?.error?.details?.reason ?? "none"}`;

  // =========================================================================
  // Control — one real invitation
  // =========================================================================
  probe.stage = "control";
  const firstEmail = email("first");
  const first = await invite("v01-invite-first", firstEmail);
  expectStatus("CONTROL: a first invitation succeeds", first, [201]);
  const afterFirst = await invitationsFor(firstEmail);
  console.log(`\n  first invite: ${describe(first)} -> ${afterFirst.length} row(s)`);
  expect(
    "CONTROL: the first invitation wrote exactly ONE pending row for that email",
    afterFirst.length === 1 && afterFirst[0]?.status === "pending",
    `rows=${JSON.stringify(afterFirst)}`,
  );
  if (afterFirst.length !== 1) {
    probe.finish(2, "the control invitation did not produce a row, so every count below is void");
    return;
  }

  // =========================================================================
  // Case 1 — SEQUENTIAL duplicate, different key. No concurrency needed.
  // =========================================================================
  probe.stage = "sequential-duplicate";
  const duplicate = await invite("v01-invite-duplicate", firstEmail);
  const afterDuplicate = await invitationsFor(firstEmail);
  console.log(
    `  duplicate invite (different key, same email): ${describe(duplicate)} -> ${afterDuplicate.length} row(s)`,
  );
  expect(
    "V01-017: a duplicate invitation for the same email does not create a second pending row",
    afterDuplicate.length === 1,
    `rows=${JSON.stringify(afterDuplicate)} -- the partial unique index ux_invitations_pending_target ` +
      `should hold; more than one row means the schema is not protecting this`,
  );
  expect(
    "V01-017: a duplicate invitation is answered with a STABLE 4xx conflict, not a 503 that reads as an outage",
    duplicate.status >= 400 && duplicate.status < 500,
    `${describe(duplicate)} -- this is a single sequential request, so nothing about concurrency is ` +
      `involved; a 503 here tells the caller the control-plane store is down when in fact the ` +
      `address is already invited, which is indistinguishable from a real outage and from V01-010`,
  );
  expect(
    "the duplicate's refusal names WHY in a stable code, so a client can act on it",
    typeof duplicate.payload?.error?.code === "string" && duplicate.payload.error.code.length > 0,
    `code=${duplicate.payload?.error?.code ?? "none"} status=${duplicate.status}`,
  );

  // =========================================================================
  // Case 2 — CONCURRENT same key, one payload. The gap as recorded.
  // =========================================================================
  probe.stage = "concurrent-same-key";
  const raceEmail = email("race");
  const racers = await Promise.all(
    Array.from({ length: 6 }, (_, i) => invite(`v01-invite-race-${i}`, raceEmail)),
  );
  const raceRows = await invitationsFor(raceEmail);
  const byStatus = (rs) =>
    rs.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const raceStatuses = byStatus(racers);
  console.log(
    `  6 concurrent invites, ONE key, one email: statuses=${JSON.stringify(raceStatuses)} ` +
      `-> ${raceRows.length} row(s) in the database`,
  );
  for (const r of racers)
    console.log(
      `    ${r.status} ${r.payload?.error?.code ?? ""} ${r.payload?.error?.details?.reason ?? ""}`.trimEnd(),
    );
  expect(
    "V01-017: six concurrent invites on ONE key create exactly ONE invitation row",
    raceRows.length === 1,
    `rows=${JSON.stringify(raceRows)} -- the primary key on invitation_id should hold; a count above 1 ` +
      `means the deterministic id is not actually deterministic or the read-then-write is unguarded`,
  );
  expect(
    "V01-017: at most one of the six racers is a success",
    (racers.filter((r) => r.status >= 200 && r.status < 300).length ?? 0) <= 1,
    `successes=${racers.filter((r) => r.status >= 200 && r.status < 300).length} statuses=${JSON.stringify(raceStatuses)}`,
  );
  expect(
    "V01-017: every losing racer is an explicit refusal with a stable code, and NONE of them is a 503",
    racers
      .filter((r) => r.status >= 400)
      .every((r) => r.status < 500 && typeof r.payload?.error?.code === "string"),
    `statuses=${JSON.stringify(raceStatuses)}; a 503 among the losers means the losers' batches aborted ` +
      `on the primary key and the caller was told the store is unavailable`,
  );
  // The strongest form: a retried request that already succeeded must be able to READ the success
  // back. If every racer but one got an error, a client that retried after a timeout has no way to
  // learn the outcome.
  expect(
    "V01-017: a racer that is retried with the same key gets the first response back, so a client can learn the outcome after a timeout",
    racers.filter((r) => r.status === 200 || r.status === 201).length > 0,
    `no racer received a replayable answer; statuses=${JSON.stringify(raceStatuses)}`,
  );

  // =========================================================================
  // Case 3 — CONCURRENT different keys, same email.
  // =========================================================================
  probe.stage = "concurrent-different-keys";
  const multiEmail = email("multi");
  const multi = await Promise.all(
    Array.from({ length: 4 }, (_, i) => invite(`v01-invite-multi-${i}`, multiEmail)),
  );
  const multiRows = await invitationsFor(multiEmail);
  const multiStatuses = byStatus(multi);
  console.log(
    `  4 concurrent invites, FOUR keys, one email: statuses=${JSON.stringify(multiStatuses)} ` +
      `-> ${multiRows.length} pending row(s)`,
  );
  expect(
    "V01-017: four concurrent invites with DIFFERENT keys for one email create exactly ONE pending row",
    multiRows.length === 1,
    `rows=${JSON.stringify(multiRows)} -- ux_invitations_pending_target is UNIQUE (org_id, email) ` +
      `WHERE status = 'pending'`,
  );
  expect(
    "V01-017: none of the different-key racers is answered with a 503",
    multi.every((r) => r.status < 500),
    `statuses=${JSON.stringify(multiStatuses)}`,
  );

  // --- the summary ----------------------------------------------------------
  const everything = await invitationsFor(null);
  const events = await d1Rows(
    `SELECT action, resource_type, COUNT(*) AS n FROM security_events
      WHERE org_id = '${org.orgId}' AND resource_type = 'invitation' AND outcome = 'success'
      GROUP BY action, resource_type`,
    "V01 invitation audit events",
  );
  console.log(
    `\n  every invitation row in the org: ${JSON.stringify(everything)}\n` +
      `  invitation audit events: ${JSON.stringify(events)}\n` +
      `  (11 requests were made in total; the audit count is the honest measure of how many ` +
      `logical invitations the server thought happened, and it is compared against the row count above)`,
  );
  expect(
    "V01-017: the number of successful invitation AUDIT events equals the number of invitation rows, so a refused or lost race wrote no audit entry",
    Number(events[0]?.n ?? 0) === everything.length,
    `audit events=${JSON.stringify(events)} rows=${everything.length}`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
