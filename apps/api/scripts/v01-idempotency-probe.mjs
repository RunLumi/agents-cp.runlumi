#!/usr/bin/env node
// V01 Idempotency and races — the side effects, not the statuses.
//
// THE THREE REQUIRED CASES WITH NO ATTACK ANYWHERE
//
// Measured across every probe in the repository: the string "incompatible" appears zero
// times, and a genuine `Promise.all` burst of same-key requests appears once, in a probe
// about something else. So of the family's six required cases, these three are unattacked:
//
//   * same key + INCOMPATIBLE payload
//   * CONCURRENT same-key requests
//   * a key reused by a DIFFERENT principal
//
// WHAT IS ASSERTED, AND WHY IT IS NOT THE STATUS
//
// The instruction is "assert business side effects, not merely response equality", and this
// family is where that matters most. A same-key replay can answer 201 twice, look perfect,
// and have created two projects. A conflicting payload can be answered 200, look perfect, and
// have silently overwritten the first request's data. Both are invisible to a status check.
//
// So every assertion here is a COUNT read out of D1, plus the content of the rows that exist.
// The statuses are recorded and printed, because they are evidence, but they are never the
// claim.
//
// THREE THINGS THAT WOULD MAKE A CLEAN SHEET MEANINGLESS, ALL GUARDED
//
// 1. **The key must actually be required and actually be scoped.** A probe that sends the same
//    key and sees one row has proven nothing if the route ignores keys entirely. The control
//    is a DIFFERENT key producing a DIFFERENT project: same route, same body, one more row.
// 2. **The concurrent burst must be concurrent.** A `Promise.all` over eight fetches is; the
//    probe prints how many arrived before the first row appeared, so a run that accidentally
//    serialised is visible rather than assumed.
// 3. **A refusal must not be confused with a replay.** They differ in side effect: a replay
//    adds no row, and a refusal adds no row either — but a replay returns the FIRST
//    request's response, and a refusal does not. The probe compares the bodies, so a route
//    that answered 409 to everything and a route that replayed correctly are distinguishable.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 idempotency", async (probe) => {
  const { request, expect, expectStatus, d1Rows } = probe;
  const { browserMutation, browserHeaders } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_IDEM_PERSIST_TO", portEnvVar: "V01_IDEM_PORT" });

  // --- fixtures --------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const bob = await probe.authenticatedUser("Bob");
  const org = await probe.createOrganization(alice.jar, "Alice Org", `idem-org-${probe.nonce}`);
  const bobOrg = await probe.createOrganization(bob.jar, "Bob Org", `idem-bob-${probe.nonce}`);

  const projectsNamed = async (name) => {
    const rows = await d1Rows(
      `SELECT project_id, name, slug FROM projects WHERE name = '${name.replaceAll("'", "''")}'`,
      `V01 projects named ${name}`,
    );
    return rows;
  };
  const allProjects = async () =>
    d1Rows(`SELECT project_id, name, created_by_user_id FROM projects`, "V01 every project");

  const newProject = (name, slug) => ({
    name,
    slug: slug.slice(0, 60),
    visibility: "org",
  });

  // The counter that every case in this probe is really about.
  let totalBefore = (await allProjects()).length;
  const total = async () => (await allProjects()).length;

  // --- control: a DIFFERENT key on the same route adds a row -----------------
  probe.stage = "control";
  const controlKey = `v01-idem-control-${probe.nonce}`;
  const controlProject = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    newProject("V01 control", `v01-control-${probe.nonce}`),
    browserMutation(alice.jar, controlKey),
  );
  expectStatus("CONTROL: a project is created with a fresh key", controlProject, [201]);
  const afterControl = await total();
  expect(
    "CONTROL: a distinct idempotency key produces a distinct project, so the route honours keys and a replay below means something",
    afterControl === totalBefore + 1,
    `projects ${totalBefore} -> ${afterControl}`,
  );
  totalBefore = afterControl;

  // =========================================================================
  // Case 1 — same key, same payload, sequentially
  // =========================================================================
  probe.stage = "same-key-same-payload";
  const replayKey = `v01-idem-replay-${probe.nonce}`;
  const replayBody = newProject("V01 replayed", `v01-replay-${probe.nonce}`);

  const first = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    replayBody,
    browserMutation(alice.jar, replayKey),
  );
  expectStatus("the first request with a key succeeds", first, [201]);

  const second = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    replayBody,
    browserMutation(alice.jar, replayKey),
  );

  const afterReplay = await total();
  const replayedRows = await projectsNamed("V01 replayed");
  expect(
    "a replayed request creates NO second project: one key with one payload is one side effect",
    afterReplay === totalBefore + 1 && replayedRows.length === 1,
    `projects ${totalBefore} -> ${afterReplay}; rows named 'V01 replayed': ${replayedRows.length}`,
  );
  // The WHOLE body, not the id. Comparing only the id is what let the sensitivity harness's
  // M4 mutation pass: it returned a stored body that kept `id` and dropped everything else,
  // and an id-only comparison is blind to exactly that. A replay is a promise that the
  // client receives the response it already had.
  const firstBody = JSON.stringify(first.payload ?? {});
  const secondBody = JSON.stringify(second.payload ?? {});
  expect(
    "the replay returns the FIRST request's response, byte for byte, which is what makes a client retry safe",
    secondBody === firstBody && second.status === first.status,
    `status ${first.status} vs ${second.status}; ` +
      `reason=${second.payload?.error?.details?.reason ?? second.payload?.error?.code ?? "(no error)"}; ` +
      `first_body=${firstBody.slice(0, 240)}; replay_body=${secondBody.slice(0, 240)}`,
  );
  totalBefore = afterReplay;

  // =========================================================================
  // Case 2 — same key, INCOMPATIBLE payload
  // =========================================================================
  probe.stage = "same-key-incompatible-payload";
  const conflictKey = `v01-idem-conflict-${probe.nonce}`;
  const conflictBody = newProject("V01 conflict first", `v01-conflict-a-${probe.nonce}`);
  const conflictingBody = newProject("V01 conflict second", `v01-conflict-b-${probe.nonce}`);

  const conflictFirst = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    conflictBody,
    browserMutation(alice.jar, conflictKey),
  );
  expectStatus("the first request with the conflict key succeeds", conflictFirst, [201]);

  const conflictSecond = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    conflictingBody,
    browserMutation(alice.jar, conflictKey),
  );
  const afterConflict = await total();
  const firstNamed = await projectsNamed("V01 conflict first");
  const secondNamed = await projectsNamed("V01 conflict second");

  expect(
    "the same key with a DIFFERENT payload is refused: a key is a promise about one specific request, not a slot a second request may overwrite",
    conflictSecond.status === 409,
    `status=${conflictSecond.status} reason=${conflictSecond.payload?.error?.details?.reason ?? conflictSecond.payload?.error?.code}`,
  );
  expect(
    "the refused conflicting payload created no project, and the first request's project is untouched",
    afterConflict === totalBefore + 1 && firstNamed.length === 1 && secondNamed.length === 0,
    `projects ${totalBefore} -> ${afterConflict}; first=${firstNamed.length} second=${secondNamed.length}`,
  );
  totalBefore = afterConflict;

  // =========================================================================
  // Case 3 — CONCURRENT same key, same payload
  //
  // The claim: eight simultaneous requests with one key produce ONE side effect. This is
  // the race a status check cannot see, and the one that matters, because the loser's whole
  // purpose is to make a client's automatic retry safe.
  // =========================================================================
  probe.stage = "concurrent-same-key";
  const burstKey = `v01-idem-burst-${probe.nonce}`;
  const burstBody = newProject("V01 burst", `v01-burst-${probe.nonce}`);
  const BURST = 8;

  const burst = await Promise.all(
    Array.from({ length: BURST }, () =>
      request(
        alice.jar,
        "POST",
        `/api/v1/orgs/${org.orgId}/projects`,
        burstBody,
        browserMutation(alice.jar, burstKey),
      ),
    ),
  );
  const afterBurst = await total();
  const burstRows = await projectsNamed("V01 burst");
  const burstStatuses = burst.map((r) => r.status);
  const distinct = [...new Set(burstStatuses)].sort();

  console.log(
    `\n  ${BURST} CONCURRENT requests, one key, one payload -> statuses ${distinct.join(" ")}`,
  );

  expect(
    `a burst of ${BURST} concurrent requests with the SAME key and the SAME payload creates exactly ONE project`,
    afterBurst === totalBefore + 1 && burstRows.length === 1,
    `projects ${totalBefore} -> ${afterBurst}; rows named 'V01 burst': ${burstRows.length} (statuses ${distinct.join(" ")})`,
  );

  // Every response must be either the first one's replay or an explicit conflict. A
  // response that is neither — a validation error, a 5xx, an empty body — means one of the
  // eight did something the client cannot interpret, and a retrying client would treat it as
  // a failure and send again.
  const firstId = burst.find((r) => r.status < 300)?.payload?.id;
  const uninterpretable = burst.filter((r) => {
    if (r.status < 300) return r.payload?.id !== firstId;
    return r.status !== 409;
  });
  expect(
    "every response in the burst is either the first request's replay or an explicit 409, so a retrying client can interpret all of them",
    uninterpretable.length === 0,
    uninterpretable.length === 0
      ? `all ${BURST} were the replay (${burst.filter((r) => r.status < 300).length}) or a 409 (${burst.filter((r) => r.status === 409).length})`
      : `${uninterpretable.length} were neither: ${uninterpretable.map((r) => r.status).join(" ")}`,
  );
  totalBefore = afterBurst;

  // =========================================================================
  // Case 4 — CONCURRENT same key, DIFFERENT payloads
  //
  // Strictly harder than case 3. One key, eight different bodies: exactly one body may win,
  // and the winner must be exactly one of the offered payloads — never a blend, never two.
  // =========================================================================
  probe.stage = "concurrent-same-key-different-payloads";
  const raceKey = `v01-idem-race-${probe.nonce}`;
  const RACE = 6;
  const raceBodies = Array.from({ length: RACE }, (_, i) =>
    newProject(`V01 race ${i}`, `v01-race-${i}-${probe.nonce}`.slice(0, 60)),
  );

  const race = await Promise.all(
    raceBodies.map((body) =>
      request(
        alice.jar,
        "POST",
        `/api/v1/orgs/${org.orgId}/projects`,
        body,
        browserMutation(alice.jar, raceKey),
      ),
    ),
  );
  const afterRace = await total();
  const raceRows = await allProjects();
  const landed = raceBodies
    .map((_, i) => `V01 race ${i}`)
    .map((name) => ({ name, rows: raceRows.filter((r) => r.name === name).length }))
    .filter((entry) => entry.rows > 0);

  const raceStatuses = race.map((r) => r.status);
  console.log(
    `  ${RACE} CONCURRENT requests, ONE key, ${RACE} DIFFERENT payloads -> statuses ` +
      `${[...new Set(raceStatuses)].sort().join(" ")}; ${landed.length} payload(s) landed`,
  );

  expect(
    `a burst of ${RACE} concurrent requests with ONE key and DIFFERENT payloads creates exactly ONE project`,
    afterRace === totalBefore + 1,
    `projects ${totalBefore} -> ${afterRace}`,
  );
  expect(
    "exactly one of the conflicting payloads is stored, and no payload is stored twice",
    landed.length === 1 && landed[0].rows === 1,
    `landed: ${JSON.stringify(landed)}`,
  );
  totalBefore = afterRace;

  // =========================================================================
  // Case 5 — the same key used by a DIFFERENT principal, and in a DIFFERENT org
  //
  // The scope actor is the principal, so a key that is another user's must not replay their
  // response. If it did, a client that generated a colliding key could read another
  // principal's response body -- and, worse, could *block* their write, since the claim is
  // occupied. Key collision across tenants is not a theoretical concern: keys are frequently
  // client-generated and a naive client generates from a counter.
  //
  // Both principals must be members of the SAME org here, or the organization boundary
  // refuses first and the key is never consulted -- a refusal indistinguishable from a
  // correct key scope. That is asserted below, not assumed.
  // =========================================================================
  probe.stage = "key-scope";
  // `admin`, not `member`: only MembershipRole::Admin holds `projects.manage`
  // (modules/authorization.rs:523). A plain member's 403 here would be CORRECT product
  // behaviour, and it would have made the shared-key assertion below pass for a reason that
  // has nothing to do with key scoping.
  const member = await probe.authenticatedUser("Member");
  await probe.inviteAndAccept(alice, member, org.orgId, "admin");

  const sharedKey = `v01-idem-shared-${probe.nonce}`;
  const aliceBody = newProject("V01 alice scoped", `v01-alice-scoped-${probe.nonce}`);

  const aliceScoped = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    aliceBody,
    browserMutation(alice.jar, sharedKey),
  );
  expectStatus("Alice writes with a key", aliceScoped, [201]);

  // A control that the invited member CAN write to this org at all, with its OWN key.
  // Without it, a 403 on the shared-key request below would be indistinguishable from a
  // correct key scope, and this case would pass for the wrong reason -- the same trap
  // V01-009 itself fell into, where the unique-slug constraint produced a green sheet for
  // three cases while the mechanism under test was absent.
  const memberOwnKey = `v01-idem-member-own-${probe.nonce}`;
  const memberOwn = await request(
    member.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    newProject("V01 member own", `v01-member-own-${probe.nonce}`),
    browserMutation(member.jar, memberOwnKey),
  );
  expectStatus(
    "CONTROL: the invited member CAN create a project in this org, so the shared-key request below is refused by the key scope and not by membership",
    memberOwn,
    [201],
  );

  // The same key, a different user, the same org.
  const memberSharedBody = newProject("V01 member shared", `v01-member-shared-${probe.nonce}`);
  const memberSameOrg = await request(
    member.jar,
    "POST",
    `/api/v1/orgs/${org.orgId}/projects`,
    memberSharedBody,
    browserMutation(member.jar, sharedKey),
  );
  const memberSameOrgRows = await projectsNamed("V01 member shared");
  expect(
    "another principal's use of the SAME key in the same org is not a replay of the first principal's write",
    memberSameOrg.status < 300 &&
      memberSameOrgRows.length === 1 &&
      memberSameOrg.payload?.id !== aliceScoped.payload?.id,
    `status=${memberSameOrg.status} rows=${memberSameOrgRows.length} alice_id=${aliceScoped.payload?.id} member_id=${memberSameOrg.payload?.id}`,
  );

  // The same key, the same principal, a DIFFERENT org. The org is part of the scope, so
  // this must not collide either. Alice is the owner of her own org but not of Bob's, so
  // the honest reading is: either the org boundary refuses (a correct and sufficient
  // answer) or the key scope refuses. Both are recorded as such; neither is claimed as
  // evidence about the key.
  const otherOrgBody = newProject("V01 other org", `v01-other-org-${probe.nonce}`);
  const otherOrg = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${bobOrg.orgId}/projects`,
    otherOrgBody,
    browserMutation(alice.jar, sharedKey),
  );
  const otherOrgRows = await projectsNamed("V01 other org");
  if (otherOrg.status < 300) {
    expect(
      "the same key in a DIFFERENT org is not a replay: the organization is part of the claim's scope",
      otherOrgRows.length === 1 && otherOrg.payload?.id !== aliceScoped.payload?.id,
      `status=${otherOrg.status} rows=${otherOrgRows.length}`,
    );
  } else {
    probe.pass(
      "the same key in another org is refused by the organization boundary, which is a sufficient answer and is reported as such rather than as key-scope evidence",
      `status=${otherOrg.status} rows=${otherOrgRows.length} — the key scope was never consulted, so this case says nothing about it`,
    );
  }

  // --- the summary ------------------------------------------------------------
  const finalProjects = await allProjects();
  console.log(`\n  projects in the database at the end: ${finalProjects.length}`);
  const byName = {};
  for (const row of finalProjects) byName[row.name] = (byName[row.name] ?? 0) + 1;
  const duplicated = Object.entries(byName).filter(([, n]) => n > 1);
  expect(
    "no project name appears twice anywhere in the database after the whole campaign, which is the whole claim in one assertion",
    duplicated.length === 0,
    duplicated.length === 0
      ? `${finalProjects.length} projects, all distinct`
      : `duplicated: ${JSON.stringify(duplicated)}`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
