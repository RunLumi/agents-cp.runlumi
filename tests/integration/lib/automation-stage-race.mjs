// Stage `race`: two REAL desktop clients (two isolated profiles, two enrolled devices) contend for the
// same server occurrence. Both processes are frozen (SIGSTOP) while the Worker generates the
// occurrence, then released together, so both scheduler ticks poll within milliseconds of each other.
// Eligibility is NOT assumed and a marker is never authority. The backend (P06-CR-008) resolves the
// workspace binding on the SERVER from the authenticated device's own live binding for the project, and a
// binding-less occurrence is offered only to a device with exactly one. Client B therefore gets its
// binding the only supported way: the actual UI onboarding/adoption flow binds B's own workspace to the
// same project. The stage reads D1 to prove each device holds its own distinct live binding, proves (with a
// positive control) which devices the due predicate admits before and after the owner retargets the
// definition through the public PATCH route, and finally that the winning run was written with the
// winner's OWN binding. Backend target policy and Main's guards are never relaxed. Client B's local
// original is attached to the shared managed automation only through the product's own UI (card menu ->
// attach dialog -> pick the existing definition -> acknowledge local instructions -> Confirm). There is no
// seeded marker and no direct attach command, and the marker confers no execution authority.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDesktopApp } from "./lumi-desktop-app.mjs";
import { onboardToManagedPolicy } from "./lumi-desktop-onboarding.mjs";
import {
  localJournal,
  localMarkers,
  managedEvidence,
  serverFingerprint,
  until,
} from "./automation-evidence.mjs";
import { readTable, seedLocalAutomations } from "./automation-journey-state.mjs";
import { rowOf } from "./automation-stage-adopt.mjs";
import { automationUi } from "./automation-ui.mjs";
import {
  assistantText,
  managedTasks,
  outputShape,
  probe as readOrUnproven,
  taskOutput,
} from "./automation-task-output.mjs";
import { TERMINAL } from "./automation-stage-schedule.mjs";
import {
  assertRefusalDisclosesNothing,
  disclosesLeaseId,
  refusalReason,
} from "./claim-recording-proxy.mjs";
import { awaitClaims } from "./automation-claim-console.mjs";
import {
  admittedByResolver,
  assertEachDeviceResolves,
  readDeviceBindings,
} from "./automation-race-binding.mjs";

// Only `dispatching` is claimable. A `pending` occurrence has not been dispatched yet: releasing the clients on it
// let the next slot's occurrence arrive first, and the overlap policy then skipped it (native-race-lane3-run5.log,
// retained D1: occ_7d08fffe...ad skipped with automation_overlap_policy before any claim was possible).
const CLAIMABLE = ["dispatching"];
const MOCK_REPLY = "Hello from Lumi.";
let patchSequence = 0;

/** Devices the backend's due predicate (DEVICE_DUE_OCCURRENCES_SQL, P06-CR-008) would admit. Read-only mirror over D1 rows. */
async function admittedDevices(ctx, managedId, deviceIds) {
  const { server, orgId, projectId } = ctx;
  const [definition] = await server.rows(
    `SELECT target_kind, target_device_id, target_workspace_binding_id
       FROM automation_definitions WHERE org_id='${orgId}' AND automation_id='${managedId}'`,
    "definition target for the admission mirror",
  );
  assert.ok(definition, "the managed definition exists for the admission mirror");
  const { devices, bindings } = await readDeviceBindings(server, orgId, deviceIds);
  return admittedByResolver({ ...definition, project_id: projectId }, devices, bindings);
}

/**
 * Prove client B is NOT eligible while the definition is bound to A's workspace binding (positive
 * control for the predicate), retarget it through the public route, then prove both devices are eligible.
 */
async function makeBothEligible(ctx, deviceIdB, { whilePinned } = {}) {
  const { ledger, probe, server, orgId, fixtureOrg, state } = ctx;
  const managedId = state.managedAutomationId;
  const both = [state.deviceIdA, deviceIdB].sort();
  // Execution authority is the server rows the actual UI flows created, never a local marker.
  const { bindings } = await readDeviceBindings(server, orgId, both);
  const ownBindings = assertEachDeviceResolves(bindings, both, ctx.projectId);
  state.bindingIds = ownBindings;
  ledger.pass(
    `actual UI onboarding gave each device its own live server binding for ${ctx.projectId}: A ${ownBindings[state.deviceIdA]}, B ${ownBindings[deviceIdB]} (distinct workspace identities)`,
  );
  const read = async () =>
    (
      await server.rows(
        `SELECT version, status, target_kind, target_device_id, target_workspace_binding_id
           FROM automation_definitions WHERE org_id='${orgId}' AND automation_id='${managedId}'`,
        "definition target",
      )
    )[0];
  const before = await read();
  const admittedBefore = await admittedDevices(ctx, managedId, both);
  if (before.target_workspace_binding_id) {
    assert.deepEqual(
      admittedBefore,
      [state.deviceIdA],
      `while bound to A's workspace binding only A is eligible, predicate admitted ${admittedBefore}`,
    );
    ledger.pass(
      `eligibility control: the due predicate admits only A while the definition is bound to ${before.target_workspace_binding_id}, so a marker on B alone would never contend`,
    );
    await whilePinned?.();
  }
  const result = await probe.request(
    fixtureOrg.fixture,
    "PATCH",
    `/api/v1/orgs/${orgId}/automations/${managedId}`,
    {
      version: Number(before.version),
      target: { kind: "eligible_device", required_capabilities: [] },
    },
    probe.browserMutation(
      fixtureOrg.fixture,
      `automation-race-retarget-${Date.now()}-${(patchSequence += 1)}`,
    ),
  );
  assert.equal(
    result.status,
    200,
    `retarget answered ${result.status}: ${result.text.slice(0, 300)}`,
  );
  const after = await read();
  assert.equal(after.target_kind, "eligible_device");
  assert.equal(
    after.target_workspace_binding_id,
    null,
    "the definition no longer names a single device's binding",
  );
  assert.equal(after.status, "active", "the retarget kept the automation active");
  assert.ok(
    Number(after.version) > Number(before.version),
    "the retarget is a versioned definition update",
  );
  const admittedAfter = await admittedDevices(ctx, managedId, both);
  assert.deepEqual(
    admittedAfter,
    both,
    `both enrolled devices must be eligible, predicate admitted ${admittedAfter}`,
  );
  ledger.pass(
    "owner retargeted the definition through the public PATCH route (eligible_device, no workspace binding, version bumped); the due predicate now admits both active devices",
  );
}

const B_TITLE = "Nightly review (client B)";
const promptB = (PROMPT) => `${PROMPT}-client-b`;

const confirmBox = (view) =>
  view.centerOfTestId("lumi-automation-confirm", '[data-testid="lumi-automation-dialog"]');

const shoot = ({ appB, evidenceDir }, name) =>
  evidenceDir ? appB.page.screenshot(join(evidenceDir, `${name}.png`)).catch(() => {}) : undefined;

const definitionCount = async ({ server, orgId }) =>
  Number(
    (
      await server.rows(
        `SELECT COUNT(*) AS n FROM automation_definitions WHERE org_id='${orgId}'`,
        "definition count",
      )
    )[0].n,
  );

/** Positive control through the rendered dialog: the product itself refuses a definition pinned to A's binding. */
async function attachRefusalControl(ctx, original) {
  const { ledger, profileB, appB } = ctx;
  const view = automationUi(appB);
  const originalBefore = rowOf(profileB, original.automationId);
  assert.ok(originalBefore, "client B's local original exists");
  assert.equal(localMarkers(profileB).length, 0, "client B holds no marker before the attach");
  await view.openAutomations();
  await view.waitForCard(B_TITLE);
  await view.startAttach(B_TITLE);
  await view.waitPhase(["choosing"], "attach candidates (none selectable yet)");
  const refused = await view.attachOptions();
  assert.equal(
    refused.length,
    1,
    `exactly the one existing definition is listed, got ${refused.length}`,
  );
  assert.equal(
    refused[0].attachable,
    false,
    "while pinned to A's binding the product refuses B's attach",
  );
  assert.equal(await confirmBox(view), null, "Confirm is unavailable for a refused candidate");
  await shoot(ctx, "race-attach-refused");
  await view.cancelDialog();
  assert.equal(localMarkers(profileB).length, 0, "a refused attach preview wrote no marker");
  assert.deepEqual(
    rowOf(profileB, original.automationId),
    originalBefore,
    "a refused preview left the original untouched",
  );
  ledger.pass(
    "actual UI control: B's attach dialog lists the managed definition as NOT attachable while it is pinned to A's binding; Confirm unavailable, nothing written",
  );
}

/**
 * Attach B's unmarked original to the shared managed automation through the real dialog (spec 07). Once
 * the owner retargeted the definition it must be the single attachable candidate. The single Confirm
 * writes one `attached` marker naming exactly the managed id, leaves the original untouched and neither
 * creates nor changes any server definition. Returns B's original row as it was before the attach.
 */
async function attachClientBThroughUi(ctx, original) {
  const { ledger, server, orgId, profileB, state, appB } = ctx;
  const view = automationUi(appB);
  const managedId = state.managedAutomationId;
  const originalBefore = rowOf(profileB, original.automationId);
  assert.ok(originalBefore, "client B's local original exists");
  assert.equal(localMarkers(profileB).length, 0, "client B holds no marker before the attach");
  await view.openAutomations();
  await view.waitForCard(B_TITLE);
  const definitionsBefore = await definitionCount(ctx);
  const fingerprintBefore = (await serverFingerprint(server, orgId)).definitions;
  await view.startAttach(B_TITLE);
  await view.waitPhase(["choosing"], "attach candidates");
  const options = await view.attachOptions();
  assert.equal(
    options.length,
    1,
    `exactly the one existing definition is listed, got ${options.length}`,
  );
  assert.equal(
    options[0].attachable,
    true,
    `the retargeted definition is attachable: ${options[0].text}`,
  );
  assert.equal(
    await confirmBox(view),
    null,
    "Confirm is unavailable before a definition is chosen",
  );
  await view.chooseAttachOption(0);
  await view.waitPhase(["ready"], "definition chosen");
  assert.equal(
    await confirmBox(view),
    null,
    "Confirm stays unavailable until local instructions are acknowledged",
  );
  assert.equal(
    await view.toggleAttachAck(),
    true,
    "the acknowledgement is checked by a real click",
  );
  assert.notEqual(
    await confirmBox(view),
    null,
    "Confirm is available after choosing and acknowledging",
  );
  await shoot(ctx, "race-attach-ready");
  await view.pressDialog("lumi-automation-confirm");
  const outcome = await view.waitPhase(["done", "confirm_failed"], "attach outcome");
  await shoot(ctx, "race-attach-outcome");
  assert.equal(
    outcome,
    "done",
    `attach outcome ${outcome}: ${(await view.dialogText()).slice(0, 400)}`,
  );
  await view.pressDialog("lumi-automation-cancel"); // Close reuses this id once done
  await view.waitDialogGone();

  const markers = localMarkers(profileB);
  assert.equal(markers.length, 1, `exactly one marker on B, got ${markers.length}`);
  const [marker] = markers;
  assert.equal(marker.local_automation_id, original.automationId);
  assert.equal(marker.state, "managed");
  assert.equal(
    marker.origin,
    "attached",
    "the marker records a shared attach, not a created definition",
  );
  assert.equal(marker.org_id, orgId);
  assert.equal(
    marker.managed_automation_id,
    managedId,
    "the marker names exactly the shared managed automation",
  );
  assert.deepEqual(
    rowOf(profileB, original.automationId),
    originalBefore,
    "attach left B's local original row byte-identical",
  );
  assert.equal(
    await definitionCount(ctx),
    definitionsBefore,
    "attach created no extra server definition",
  );
  assert.deepEqual(
    (await serverFingerprint(server, orgId)).definitions,
    fingerprintBefore,
    "attach left every server definition (status, version, updated_at) unchanged",
  );
  ledger.pass(
    `actual UI attach: B chose the existing definition, acknowledged local instructions and confirmed; one marker (managed, origin attached) names ${managedId}, the local original is unchanged and no server definition was created or changed`,
  );
  return originalBefore;
}

/** Start client B on its own profile with an UNMARKED local original, then onboard it through the real UI. */
async function startClientB(ctx) {
  const { root, probe, web, projectId, fixtureOrg, PROMPT } = ctx;
  const profileB = await mkdtemp(join(tmpdir(), "lumi-automation-b-"));
  const workspaceB = join(profileB, "workspace");
  mkdirSync(workspaceB, { recursive: true });
  mkdirSync(join(profileB, "home", ".zcode", "v2"), { recursive: true });
  const [original] = await seedLocalAutomations({
    root,
    profile: profileB,
    specs: [
      {
        title: B_TITLE,
        cronExpr: "* * * * *",
        prompt: promptB(PROMPT),
        workspacePath: workspaceB,
        nextRunAt: Date.now() + 3_600_000,
      },
    ],
  });
  // Fixture control before B ever launches: its original is a plain, UNMARKED local automation. A marker may
  // appear only through the attach dialog later in the stage, and it never confers execution authority.
  assert.equal(
    localMarkers(profileB).length,
    0,
    "client B's seeded original carries no managed marker before launch (the attach UI is the only way to mark it)",
  );
  assert.ok(
    rowOf(profileB, original.automationId),
    "client B's seeded original row exists before launch",
  );
  const appB = createDesktopApp({
    binary: ctx.binary,
    desktop: ctx.desktop,
    probe,
    profile: profileB,
    workspacePath: workspaceB,
    name: "client B",
    origin: ctx.claimProxy?.origin,
  });
  ctx.appB = appB;
  await appB.start();
  const onboarding = await onboardToManagedPolicy({
    app: appB,
    probe,
    web,
    projectId,
    email: fixtureOrg.email,
    password: fixtureOrg.password,
  });
  assert.equal(
    localMarkers(profileB).length,
    0,
    "real sign-in/onboarding of B left its original unmarked",
  );
  return { profileB, original, deviceIdB: onboarding.deviceId, appB };
}

export async function raceStage(ctx) {
  const { ledger, probe, server, orgId, profileA, appA, state } = ctx;
  const rounds = Number(process.env.DE2E_AUTOMATION_RACE_ROUNDS ?? 2);
  const managedId = state.managedAutomationId;
  const { profileB, original, deviceIdB, appB } = await startClientB(ctx);
  state.deviceIdB = deviceIdB;
  state.profileB = profileB;
  ctx.profileB = profileB; // the attach helpers below read it from ctx
  state.localIdB = original.automationId;
  assert.notEqual(deviceIdB, state.deviceIdA, "the second client enrolled its own device");
  const devices = await server.rows(
    `SELECT device_id, status FROM devices WHERE device_id IN ('${state.deviceIdA}','${deviceIdB}')`,
    "both devices",
  );
  assert.deepEqual(devices.map((row) => row.status).sort(), ["active", "active"]);
  ledger.pass("client B runs in its own isolated profile with its own enrolled, active device");
  // The real attach dialog is the control: the product refuses a definition pinned to A's binding.
  await makeBothEligible(ctx, deviceIdB, {
    whilePinned: () => attachRefusalControl(ctx, original),
  });
  const originalBBefore = await attachClientBThroughUi(ctx, original);

  const seen = new Set(
    (await managedEvidence(server, orgId, managedId)).occurrences.map((o) => o.occurrence_id),
  );
  const results = [];
  // Tasks come from each profile's OWN tasks-index, so "no task" is an isolated measurement.
  const localIds = { A: ctx.seeds.adopted.automationId, B: original.automationId };
  const tasksOf = (key) =>
    managedTasks(key === "A" ? profileA : profileB, { localAutomationId: localIds[key] });
  // Hold the first claim of each contested occurrence until the other client's claim arrives so both reach the
  // Worker's guarded write together (the concurrent-loser path); restored to pass-through after the rounds.
  ctx.claimProxy?.setClaimBarrier(8_000);
  for (let round = 1; round <= rounds; round += 1) {
    const tasksBefore = { A: tasksOf("A").length, B: tasksOf("B").length };
    appA.signal("SIGSTOP");
    appB.signal("SIGSTOP");
    let target;
    let heldBeforeRelease;
    try {
      const fresh = await until(
        `round ${round}: a new claimable occurrence while both clients are frozen`,
        async () => (await managedEvidence(server, orgId, managedId)).occurrences,
        (rows) => rows.some((row) => !seen.has(row.occurrence_id) && CLAIMABLE.includes(row.state)),
        { timeout: 4 * 60_000, every: 5_000, tick: () => probe.triggerSweep() },
      );
      target = fresh.find((row) => !seen.has(row.occurrence_id) && CLAIMABLE.includes(row.state));
      // Read while BOTH processes are still stopped: after SIGCONT a client may claim within milliseconds.
      heldBeforeRelease = (await managedEvidence(server, orgId, managedId)).leases.filter(
        (l) => l.occurrence_id === target.occurrence_id,
      ).length;
    } finally {
      appA.signal("SIGCONT");
      appB.signal("SIGCONT");
    }
    seen.add(target.occurrence_id);
    assert.equal(
      heldBeforeRelease,
      0,
      "positive control: nobody held the occurrence while both clients were frozen",
    );

    const evidence = await until(
      `round ${round}: the contested occurrence settles`,
      () => managedEvidence(server, orgId, managedId),
      (value) =>
        value.occurrences.some(
          (row) => row.occurrence_id === target.occurrence_id && TERMINAL.includes(row.state),
        ),
      { timeout: 5 * 60_000, every: 6_000, tick: () => probe.triggerSweep() },
    );
    const occurrence = evidence.occurrences.find(
      (row) => row.occurrence_id === target.occurrence_id,
    );
    const leases = evidence.leases.filter((row) => row.occurrence_id === target.occurrence_id);
    const attempts = evidence.attempts.filter((row) => row.occurrence_id === target.occurrence_id);
    const links = evidence.links.filter((row) => row.occurrence_id === target.occurrence_id);
    assert.equal(occurrence.state, "succeeded", `contested occurrence ended ${occurrence.state}`);
    assert.equal(
      leases.length,
      1,
      `exactly one lease for the contested occurrence, got ${leases.length}`,
    );
    assert.equal(
      attempts.filter((row) => row.outcome === "claimed").length,
      1,
      "exactly one claim attempt row",
    );
    assert.equal(links.length, 1, "exactly one run link");
    const runs = await server.rows(
      `SELECT run_id FROM runs WHERE org_id='${orgId}' AND automation_occurrence_id='${target.occurrence_id}'`,
      "runs for contested occurrence",
    );
    assert.equal(runs.length, 1, `exactly one P05 run for the occurrence, got ${runs.length}`);
    const winnerDevice = leases[0].device_id;
    assert.ok(
      [state.deviceIdA, deviceIdB].includes(winnerDevice),
      "the winner is one of the two enrolled devices",
    );
    const [contestedRun] = await server.rows(
      `SELECT state, workspace_binding_id FROM runs WHERE org_id='${orgId}' AND automation_occurrence_id='${target.occurrence_id}'`,
      "contested run binding",
    );
    assert.equal(
      contestedRun.workspace_binding_id,
      state.bindingIds[winnerDevice],
      "the server wrote the winner's OWN live binding into the run (never NULL, never the loser's)",
    );
    assert.notEqual(
      contestedRun.state,
      "queued",
      "no orphaned queued run remains for the contested occurrence",
    );
    const [winnerProfile, loserProfile] =
      winnerDevice === state.deviceIdA ? [profileA, profileB] : [profileB, profileA];
    const loserDevice = winnerDevice === state.deviceIdA ? deviceIdB : state.deviceIdA;

    const winnerJournal = localJournal(winnerProfile).filter(
      (row) => row.occurrence_id === target.occurrence_id,
    );
    const loserJournal = localJournal(loserProfile).filter(
      (row) => row.occurrence_id === target.occurrence_id,
    );
    assert.equal(winnerJournal.length, 1, "the winner journaled the occurrence");
    assert.equal(winnerJournal[0].state, "settled");
    assert.equal(
      loserJournal.filter((row) => ["started", "settled"].includes(row.state)).length,
      0,
      "the loser journal has no started/settled row for the occurrence",
    );
    // Actual Agent effects, read only from each client's OWN profile: the winner's retained original ran as
    // ONE new completed task; the loser's tasks-index gained none (it never executed its original).
    const [winnerKey, loserKey] = winnerDevice === state.deviceIdA ? ["A", "B"] : ["B", "A"];
    const winnerTasks = await until(
      `round ${round}: the winner's tasks-index shows one new completed task`,
      async () => tasksOf(winnerKey),
      (tasks) => tasks.length === tasksBefore[winnerKey] + 1 && tasks.at(-1).status === "completed",
      { timeout: 60_000, every: 3_000 },
    );
    const loserTasks = tasksOf(loserKey);
    assert.equal(
      loserTasks.length,
      tasksBefore[loserKey],
      `the loser created a task: ${JSON.stringify(loserTasks.map((t) => [t.taskId, t.status]))}`,
    );
    ledger.pass(
      `round ${round}: client ${winnerKey} created exactly one new completed Agent task (${winnerTasks.at(-1).model}); client ${loserKey}'s task index gained none`,
    );
    const reply = readOrUnproven(() => taskOutput(winnerProfile, winnerTasks.at(-1).taskId));
    if (reply.status === "ok" && assistantText(reply.value).includes(MOCK_REPLY))
      ledger.pass(
        `round ${round}: the winner's in-profile Agent session holds the model reply "${MOCK_REPLY}"`,
      );
    else
      ledger.gap(
        "race",
        `round ${round}: the winner's assistant text was read back from its in-profile Agent session`,
        "UNPROVEN",
        reply.status === "ok"
          ? `session readable but the reply was absent: ${JSON.stringify(outputShape(reply.value))}`
          : `in-profile Agent store not readable (${reply.code})`,
      );
    // The Worker's own console capture is the contention record: a refused claim is an HTTP 409 on the same
    // occurrence while D1 shows a single lease. It cannot name the refused device, only that a second claim lost.
    const claims = await awaitClaims(
      () => probe.workerConsole(Number.MAX_SAFE_INTEGER),
      target.occurrence_id,
    );
    results.push({
      round,
      occurrence: target.occurrence_id,
      winnerDevice,
      loserDevice,
      acceptedClaims: claims.accepted,
      refusedClaims: claims.refused,
      otherClaimStatuses: claims.other,
      claimCorrelationIds: claims.correlationIds,
    });
    assert.ok(
      claims.accepted <= 1,
      `the Worker accepted ${claims.accepted} claims for one occurrence`,
    );
    ledger.pass(
      `round ${round}: exactly one lease, one claim, one run link and one P05 run for ${target.occurrence_id}; winner ${winnerDevice === state.deviceIdA ? "A" : "B"} settled it and the loser journal has no started or settled row`,
    );
    // The refused claim's actual HTTP body, read at the transport boundary (proxy in front of the Worker).
    const refusals = (ctx.claimProxy?.claimsFor(target.occurrence_id) ?? []).filter(
      (row) => row.status === 409,
    );
    if (refusals.length) {
      const problems = refusals.flatMap((row) =>
        assertRefusalDisclosesNothing(row, {
          forbidden: [
            winnerDevice,
            leases[0].lease_token_fingerprint,
            contestedRun.workspace_binding_id,
            runs[0].run_id,
          ],
        }),
      );
      assert.deepEqual(
        problems,
        [],
        `the losing claim's response disclosed more than the refusal: ${problems}`,
      );
      const reasons = [...new Set(refusals.map(refusalReason))];
      results.at(-1).refusalBodies = refusals.map((row) => ({
        status: row.status,
        requestId: row.requestId,
        reason: refusalReason(row),
        disclosesLeaseId: disclosesLeaseId(row),
        body: row.body,
      }));
      ledger.pass(
        `round ${round}: the loser's claim response (captured at the proxy) is a stable 409 error envelope with reason ${reasons.join("/")} and carries no winner device, run, workspace binding, lease token or fence${refusals.some(disclosesLeaseId) ? " (it names the winner's lease ID by design, never the token)" : ""}`,
      );
      if (reasons.some((reason) => reason !== "occurrence_already_claimed"))
        ledger.gap(
          "race",
          `round ${round}: the loser's refusal carries the frozen loser_reason occurrence_already_claimed`,
          "UNPROVEN",
          `the captured refusal reason was ${reasons.join("/")}; the frozen p06-contracts fixture names occurrence_already_claimed for a concurrent-claim loser, so this late-loser path needs a contract decision (retained body in result.json race[].refusalBodies)`,
        );
    }
    if (claims.accepted === 0)
      ledger.gap(
        "race",
        `round ${round}: the Worker's console capture holds the accepted claim for the occurrence`,
        "UNPROVEN",
        "no HTTP 201 claim line for this occurrence was captured, so contention cannot be read from the console",
      );
    else if (claims.refused === 0)
      ledger.gap(
        "race",
        `round ${round}: the losing client demonstrably contended (a refused claim in the Worker's console capture)`,
        "UNPROVEN",
        "the capture holds no HTTP 409 for this occurrence, so a tick that never claimed cannot be told from a refused claim",
      );
    else
      ledger.pass(
        `round ${round}: the Worker refused ${claims.refused} further claim request(s) for the occurrence with HTTP 409 (correlation ${claims.correlationIds.join(", ") || "unpaired"}) while D1 holds one lease`,
      );
    await delay(1_000);
  }
  ctx.claimProxy?.setClaimBarrier(0);
  assert.deepEqual(
    rowOf(profileB, original.automationId),
    originalBBefore,
    "client B's attached original row is byte-identical",
  );
  assert.equal(
    readTable(
      profileB,
      "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?",
      original.automationId,
    )[0].n,
    0,
    "client B wrote no local run history for its attached original",
  );
  ledger.pass("client B's attached local original has no local run history after the races");
  state.raceResults = results;
  if (!results.some((row) => row.refusalBodies?.length))
    ledger.gap(
      "race",
      "loser response disclosure limited to occurrence_already_claimed at the transport boundary",
      "UNPROVEN",
      "no refused claim response was captured by the proxy in any round",
    );
}
