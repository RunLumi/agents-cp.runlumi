// Stages `restart` and `faults`: a managed occurrence that stays in flight long enough (the backend's
// development-only hanging route, `coding-slow`) to be killed, frozen or revoked while the REAL app
// holds the lease. Every outcome is graded on D1 rows and the client's own journal, never on a status
// code, and every fault is preceded by a positive control showing the same path works unfaulted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { automationUi, titleOf } from "./automation-ui.mjs";
import { entitlementLossControl, lostStartResponseControl } from "./automation-stage-controls.mjs";
import { revokeDevice, setAutomationStatus } from "./automation-admin.mjs";
import { localJournal, localMarkers, managedEvidence, until } from "./automation-evidence.mjs";
import { rowOf, TITLES } from "./automation-stage-adopt.mjs";
import {
  assistantText,
  assistantTerminal,
  managedTasks,
  outputShape,
  probe as readOrUnproven,
  taskOutput,
} from "./automation-task-output.mjs";

/** Tasks the managed scheduler created for the slow retained original, from the client's OWN profile. */
// Assistant text the hanging mock route can legitimately leave in a session: nothing yet, or its single pre-hang frame.
const HANG_FRAMES = ["", "waiting"];
const slowTasks = (ctx) => managedTasks(ctx.profileA, { localAutomationId: ctx.seeds[ctx.activeSlow ?? "slow"].automationId });
/** One task's Agent output from the in-profile store, or an explicit UNPROVEN result (never "empty"). */
const slowOutput = (ctx, task) => readOrUnproven(() => taskOutput(ctx.profileA, task.taskId));

/**
 * Hand a slow original (`slow`, `slowLease` or `slowRevoke`) over through the UI with the hanging model route and
 * make it the ACTIVE fault target: tasks, managed id, lease timing and the seen-occurrence set follow it.
 */
async function adoptSlow(ctx, key = "slow") {
  const { appA, ledger, profileA, seeds, state } = ctx;
  const view = automationUi(appA);
  ctx.activeSlow = key;
  await view.openAutomations();
  await view.startHandOver(TITLES[key]);
  if ((await view.waitPhase(["ready", "preview_failed"], "hand-over preview outcome")) === "preview_failed") {
    const text = await view.dialogText();
    assert.match(text, /lumi_workspace_binding_missing/, `unexpected preview failure: ${text.slice(0, 300)}`);
    assert.ok(state.restartManagedId, "device recovery is only exercised after the restart stage left its ambiguous original");
    await appA.page.screenshot(join(ctx.evidenceDir, `handover-preview-failed-${key}.png`)).catch(() => {});
    await view.cancelDialog();
    await recoverDeviceThroughUi(ctx, "lumi_workspace_binding_missing");
    await view.openAutomations();
    await view.startHandOver(TITLES[key]);
    assert.equal(await view.waitPhase(["ready", "preview_failed"], "hand-over preview after recovery"), "ready", "the preview works once the device is recovered");
  }
  await view.waitPhase(["ready"], "ready");
  await view.waitOptionsLoaded();
  await view.chooseByLabel("Agent", ctx.agentName);
  await view.chooseByLabel("Model", ctx.slowModelName);
  await view.pressDialog("lumi-automation-confirm");
  const outcome = await view.waitPhase(["done", "confirm_failed"], "confirm outcome");
  assert.equal(outcome, "done", `slow hand-over ${outcome}: ${(await view.dialogText()).slice(0, 300)}`);
  await view.pressDialog("lumi-automation-cancel");
  await view.waitDialogGone();
  // The dialog can close before the marker row is visible to a second reader (retained: native-full-lane3-run16,
  // where the same marker read `managed` moments later), so wait a bounded time; it must still become managed.
  const markerRows = await until(
    `the ${TITLES[key]} marker becomes managed`,
    async () => localMarkers(profileA).filter((row) => row.local_automation_id === seeds[key].automationId),
    (rows) => rows.some((row) => row.state === "managed"),
    { timeout: 30_000, every: 1_000 },
  );
  const marker = markerRows.find((row) => row.state === "managed");
  assert.ok(marker, "the slow original is managed");
  state.slowManagedId = marker.managed_automation_id;
  const definition = (
    await managedEvidence(ctx.server, ctx.orgId, state.slowManagedId)
  ).definition;
  assert.ok(definition, "slow managed definition exists");
  assert.ok(JSON.stringify(definition).includes("coding-slow"), "the slow definition carries the hanging model alias");
  state.leaseTtl = Number(definition.lease_ttl_seconds);
  state.heartbeat = Number(definition.heartbeat_interval_seconds);
  assert.ok(state.leaseTtl > 0 && state.heartbeat > 0, "lease timing is stored on the definition");
  ledger.pass(`${TITLES[key]} handed over in the UI with the hanging route (lease ttl ${state.leaseTtl}s, heartbeat ${state.heartbeat}s)`);
}

/** Resume the slow automation and wait until the desktop holds a STARTED, RENEWED occurrence. */
async function startInFlight(ctx, seen) {
  const { probe, server, orgId, state } = ctx;
  await setAutomationStatus(ctx, "resume", state.slowManagedId);
  const sweep = () => probe.triggerSweep();
  const started = await until(
    "the desktop claims and starts a fresh slow occurrence",
    () => managedEvidence(server, orgId, state.slowManagedId),
    (value) => value.occurrences.some((row) => !seen.has(row.occurrence_id) && row.state === "started"),
    { timeout: 5 * 60_000, every: 5_000, tick: sweep },
  );
  const occurrence = started.occurrences.find((row) => !seen.has(row.occurrence_id) && row.state === "started");
  seen.add(occurrence.occurrence_id);
  await setAutomationStatus(ctx, "pause", state.slowManagedId); // no further occurrences while we fault this one
  const renewed = await until(
    "the lease is renewed while the run is in flight (positive control for renewal)",
    () => managedEvidence(server, orgId, state.slowManagedId),
    (value) =>
      value.leases.some((lease) => lease.occurrence_id === occurrence.occurrence_id && lease.lease_version >= 2),
    { timeout: (state.heartbeat * 3 + 30) * 1_000, every: 4_000 },
  );
  const lease = renewed.leases.find((row) => row.occurrence_id === occurrence.occurrence_id);
  assert.equal(lease.device_id, state.deviceIdA, "the in-flight lease belongs to the desktop under test");
  return { occurrence, lease, link: renewed.links.find((row) => row.occurrence_id === occurrence.occurrence_id) };
}

const forOccurrence = (value, id) => ({
  occurrence: value.occurrences.find((row) => row.occurrence_id === id),
  leases: value.leases.filter((row) => row.occurrence_id === id),
  attempts: value.attempts.filter((row) => row.occurrence_id === id),
  links: value.links.filter((row) => row.occurrence_id === id),
});

async function waitAmbiguous(ctx, id, label) {
  const { probe, server, orgId, state } = ctx;
  return until(
    label,
    () => managedEvidence(server, orgId, state.slowManagedId),
    (value) => ["ambiguous", "failed", "succeeded"].includes(forOccurrence(value, id).occurrence?.state),
    { timeout: (state.leaseTtl + 180) * 1_000, every: 6_000, tick: () => probe.triggerSweep() },
  );
}

/** Nothing may move after the ambiguous verdict: same attempts, same links, still not succeeded. */
async function assertNoReplay(ctx, id, before, label) {
  const after = forOccurrence(await managedEvidence(ctx.server, ctx.orgId, ctx.state.slowManagedId), id);
  assert.equal(after.occurrence.state, "ambiguous", `${label}: occurrence stays ambiguous, got ${after.occurrence.state}`);
  assert.deepEqual(after.attempts.map((a) => a.outcome), before.attempts.map((a) => a.outcome), `${label}: attempt history is unchanged (no replay)`);
  assert.equal(after.links.length, before.links.length, `${label}: no second run link`);
  assert.equal(after.attempts.some((a) => a.outcome === "succeeded"), false, `${label}: nothing settled it as succeeded`);
}

/**
 * The device token lives 15 minutes (DEVICE_TOKEN_TTL_SECONDS) and Main refreshes it only through an explicit UI
 * command, so a long journey reaches `reauth_required`: the Settings card says so, Refresh/Sync are disabled, and a
 * workspace command such as a hand-over preview fails with the misleading `lumi_workspace_binding_missing` (it skips
 * the bindings read for a non-active device). The product's own remedy is Settings -> Lumi device -> "Approve
 * recovery and renew this device" (explicit confirm, signed by the device's own key). This drives exactly that
 * through the real UI, proves the device identity, workspace binding and ambiguous original are untouched, and
 * records the observed behavior as a finding. Nothing is seeded and no authority is written.
 */
async function recoverDeviceThroughUi(ctx, failure) {
  const { appA, ledger, server, orgId, state, evidenceDir, probe } = ctx;
  const view = automationUi(appA);
  const read = async () => ({
    device: (await server.rows(`SELECT device_id, status, revoked_at FROM devices WHERE device_id='${state.deviceIdA}'`, "device before recovery"))[0],
    bindings: await server.rows(`SELECT binding_id, device_id, removed_at FROM workspace_bindings WHERE org_id='${orgId}' AND device_id='${state.deviceIdA}' ORDER BY binding_id`, "bindings before recovery"),
    ambiguous: forOccurrence(await managedEvidence(server, orgId, state.restartManagedId), state.restartedOccurrence),
  });
  const before = await read();
  await view.ui().clickText("Settings");
  await view.ui().wait(() => !!document.querySelector('[aria-label="General"]'), "settings nav");
  await view.ui().clickText("General");
  await view.ui().wait(() => document.body.innerText.includes("This device token expired"), "the device section reports the expired token", { timeout: 30_000 });
  await appA.page.screenshot(join(evidenceDir, "device-token-expired.png")).catch(() => {});
  await view.ui().clickText("Approve recovery and renew this device");
  await view.ui().wait(() => !document.body.innerText.includes("This device token expired"), "recovery renewed the device token", { timeout: 60_000 });
  await appA.page.screenshot(join(evidenceDir, "device-token-recovered.png")).catch(() => {});
  const after = await read();
  assert.deepEqual(after.device, before.device, "recovery kept the same device id, status and no revocation");
  assert.deepEqual(after.bindings, before.bindings, "recovery left the workspace binding authority untouched");
  assert.deepEqual(after.ambiguous.occurrence.state, "ambiguous", "the ambiguous original is unchanged by recovery");
  assert.deepEqual(after.ambiguous.attempts.map((a) => a.outcome), before.ambiguous.attempts.map((a) => a.outcome));
  (ctx.state.findings ??= []).push({
    id: "device-token-expiry-without-refresh",
    observed: `hand-over preview failed with ${failure}; the Settings device card showed "This device token expired"; recovery through the UI restored it`,
    at: new Date().toISOString(),
    note: "token TTL 15 min, no automatic refresh in Main (refresh-device is a UI command); the error code names the binding, not the token. Needs a product decision, not a harness workaround.",
  });
  ledger.pass(
    `device token expiry: the hand-over preview failed with ${failure}; Settings -> device showed the expired-token notice; the real "Approve recovery and renew this device" click restored it with device ${state.deviceIdA}, its workspace binding and the ambiguous original unchanged`,
  );
  await probe.triggerSweep();
}

/**
 * Actually navigate to the automations list of the RESTARTED app and read the card of the automation whose
 * occurrence is ambiguous. The card must send the user to the run history (badge state `review`); anything else
 * is recorded with the card text that WAS read, never as a pass.
 */
async function readReconciliationCard(ctx) {
  const { appA, ledger, evidenceDir } = ctx;
  const view = automationUi(appA);
  await view.openAutomations();
  await view.waitForCard(TITLES.slow);
  const read = async () => (await view.cardTitles()).find((card) => titleOf(card) === TITLES.slow);
  let card = await read();
  for (let attempt = 0; attempt < 20 && !card?.text.includes("Check run history"); attempt += 1) {
    await delay(3_000);
    card = await read();
  }
  await appA.page.screenshot(join(evidenceDir, "restart-reconciliation-card.png")).catch(() => {});
  if (card?.text.includes("Check run history"))
    ledger.pass(`needs-reconciliation: after navigating to the list the restarted app's card reads ${JSON.stringify(card.text.split("\n").filter(Boolean).slice(0, 3))} (badge state ${card.badge})`);
  else
    ledger.gap(
      "restart",
      "the automation card surfaces the needs-reconciliation state after navigation",
      "UNPROVEN",
      `card read after navigating to the list: badge ${JSON.stringify(card?.badge)}, text ${JSON.stringify(card?.text.slice(0, 200))}`,
    );
}

/**
 * Contract: an ambiguous occurrence blocks every later slot of its automation until audited reconciliation. Prove it
 * with the actual scheduler by resuming the automation and reading the stored outcome of the slots that follow:
 * skipped with automation_overlap_policy, never dispatched, claimed or run, and the ambiguous original unchanged.
 */
async function assertAmbiguousBlocksSuccessors(ctx) {
  const { ledger, probe, server, orgId, state } = ctx;
  const id = state.restartedOccurrence;
  const managedId = state.restartManagedId;
  const seenBefore = new Set((await managedEvidence(server, orgId, managedId)).occurrences.map((row) => row.occurrence_id));
  await setAutomationStatus(ctx, "resume", managedId);
  let evidence;
  try {
    evidence = await until(
      "a slot after the ambiguous occurrence is decided by the overlap policy",
      () => managedEvidence(server, orgId, managedId),
      (value) => value.occurrences.some((row) => !seenBefore.has(row.occurrence_id) && row.state !== "pending"),
      { timeout: 4 * 60_000, every: 5_000, tick: () => probe.triggerSweep() },
    );
  } finally {
    await setAutomationStatus(ctx, "pause", managedId);
  }
  const successors = evidence.occurrences.filter((row) => !seenBefore.has(row.occurrence_id) && row.state !== "pending");
  assert.ok(successors.length >= 1, "a successor slot exists");
  for (const row of successors) {
    assert.equal(row.state, "skipped", `successor ${row.occurrence_id} must be skipped behind the ambiguous predecessor, got ${row.state}`);
    assert.equal(row.reason_code, "automation_overlap_policy", `skip reason ${row.reason_code}`);
    const related = forOccurrence(evidence, row.occurrence_id);
    assert.equal(related.leases.length + related.attempts.length + related.links.length, 0, "a skipped successor has no lease, attempt or run link");
  }
  await assertNoReplay(ctx, id, state.restartAmbiguous, "ambiguous predecessor");
  ledger.pass(
    `ambiguous predecessor blocks: ${successors.length} later slot(s) of the same automation ended skipped (automation_overlap_policy) with no lease/attempt/run, and ${id} stayed ambiguous with unchanged attempts and links; the fault scenarios below therefore use separate automations`,
  );
}

export async function restartStage(ctx) {
  const { ledger, appA, server, orgId, profileA, probe, state, evidenceDir } = ctx;
  await adoptSlow(ctx);
  const seen = new Set((await managedEvidence(server, orgId, state.slowManagedId)).occurrences.map((o) => o.occurrence_id));
  state.slowSeen = seen;

  const run = await startInFlight(ctx, seen);
  const id = run.occurrence.occurrence_id;
  ledger.pass(`in-flight control: occurrence ${id} started on the desktop device and its lease was renewed (version ${run.lease.lease_version})`);
  const before = forOccurrence(await managedEvidence(server, orgId, state.slowManagedId), id);
  assert.equal(before.occurrence.state, "started");
  const inFlight = await until(
    "the real Agent created the managed task and is waiting on the model (positive control for output readback)",
    async () => slowTasks(ctx),
    (tasks) => tasks.length >= 1,
    { timeout: 90_000, every: 3_000 },
  );
  const tasksInFlight = inFlight.length;
  assert.equal(inFlight.some((task) => task.status === "completed"), false, "the hanging model has not completed a task");
  const inFlightOutput = slowOutput(ctx, inFlight.at(-1));
  if (inFlightOutput.status === "ok")
    assert.ok(
      HANG_FRAMES.includes(assistantText(inFlightOutput.value)),
      `the hanging model has produced only its pre-hang frame, got ${JSON.stringify(assistantText(inFlightOutput.value))}`,
    );

  await appA.page.screenshot(join(evidenceDir, "restart-before-kill.png")).catch(() => {});
  await appA.stop({ hard: true });
  const ambiguous = await waitAmbiguous(ctx, id, "the killed client's started occurrence resolves on the server");
  const killed = forOccurrence(ambiguous, id);
  assert.equal(killed.occurrence.state, "ambiguous", `a started occurrence whose lease expires is ambiguous, got ${killed.occurrence.state}`);
  assert.equal(killed.attempts.filter((a) => a.outcome === "claimed").length, 1);
  assert.equal(killed.leases.length, 1);
  assert.notEqual(killed.leases[0].state, "active", "the dead client's lease is no longer active");
  ledger.pass("after SIGKILL the server turned the expired started lease into an ambiguous occurrence, not a retry");

  await appA.start();
  const marked = await until(
    "the restarted Main reconciles the interrupted occurrence",
    async () => localJournal(profileA).filter((row) => row.occurrence_id === id),
    (rows) => rows.length === 1 && rows[0].state === "ambiguous",
    { timeout: 120_000, every: 3_000 },
  );
  assert.equal(marked[0].reason, "process_restarted");
  ledger.pass("restart: the local journal marks the in-flight occurrence ambiguous (process_restarted) and does not resume it");

  await delay(70_000); // at least three scheduler ticks, each polling Main while sweeps keep running
  for (let i = 0; i < 3; i += 1) {
    await probe.triggerSweep();
    await delay(5_000);
  }
  await assertNoReplay(ctx, id, killed, "restart");
  assert.equal(localJournal(profileA).filter((row) => row.occurrence_id === id)[0].state, "ambiguous");
  assert.deepEqual(rowOf(profileA, ctx.seeds.adopted.automationId), state.adoptedBefore, "the retained original survived the restart untouched");
  ledger.pass("restart: several scheduler ticks later there is no new claim, link or run for the ambiguous occurrence and the original is untouched");
  const afterRestart = slowTasks(ctx);
  assert.equal(afterRestart.length, tasksInFlight, `restart replayed the prompt into a new task: ${JSON.stringify(afterRestart.map((t) => [t.taskId, t.status]))}`);
  assert.equal(afterRestart.some((task) => task.status === "completed"), false, "no task for the interrupted occurrence ever completed");
  ledger.pass("restart: the profile task index has the same task count as before the kill and none completed, so nothing re-executed the interrupted prompt");
  const afterOutput = slowOutput(ctx, afterRestart.at(-1));
  if (afterOutput.status === "ok" && afterOutput.value.messages.length) {
    // The backend's mock-timeout route streams ONE "waiting" frame (providers.rs) and then hangs, so that frame is
    // expected whether the kill landed before or after it; a completion or any new text would be re-execution.
    assert.ok(
      HANG_FRAMES.includes(assistantText(afterOutput.value)),
      `the killed turn holds only the pre-hang frame, got ${JSON.stringify(assistantText(afterOutput.value))}`,
    );
    ledger.pass("restart: the in-profile Agent session of the interrupted task holds at most the mock's pre-hang \"waiting\" frame, no completion");
  } else
    ledger.gap(
      "restart",
      "the interrupted task's in-profile Agent session holds at most the pre-hang frame",
      "UNPROVEN",
      afterOutput.status === "ok" ? "the session has no messages" : `in-profile Agent store not readable (${afterOutput.code})`,
    );
  await readReconciliationCard(ctx);
  state.restartManagedId = state.slowManagedId;
  state.restartAmbiguous = forOccurrence(await managedEvidence(server, orgId, state.slowManagedId), id);
  state.restartedOccurrence = id;
}

/** Adopt a separate slow original through the UI and return its (empty) seen-occurrence set. */
async function freshTarget(ctx, key) {
  await adoptSlow(ctx, key);
  const { server, orgId, state } = ctx;
  return new Set((await managedEvidence(server, orgId, state.slowManagedId)).occurrences.map((row) => row.occurrence_id));
}

export async function faultsStage(ctx) {
  const { ledger, appA, server, orgId, profileA, probe, state } = ctx;
  await assertAmbiguousBlocksSuccessors(ctx);
  await entitlementLossControl(ctx);
  await lostStartResponseControl(ctx);

  // --- expired lease: the client is frozen past the TTL, then thawed -------------------------------------
  {
    const seen = await freshTarget(ctx, "slowLease");
    const tasksBefore = slowTasks(ctx).length;
    const run = await startInFlight(ctx, seen);
    const id = run.occurrence.occurrence_id;
    ledger.pass(`positive control: the restarted client claimed and renewed a fresh occurrence ${id}`);
    await until(
      "the Agent created the managed task for the fresh occurrence (positive control: there is an in-flight handler to stop)",
      async () => slowTasks(ctx),
      (tasks) => tasks.length === tasksBefore + 1,
      { timeout: 90_000, every: 3_000 },
    );
    appA.signal("SIGSTOP");
    let expired;
    try {
      expired = await waitAmbiguous(ctx, id, "a frozen client's lease expires on the server");
    } finally {
      appA.signal("SIGCONT");
    }
    const frozen = forOccurrence(expired, id);
    assert.equal(frozen.occurrence.state, "ambiguous", `frozen client: occurrence ${frozen.occurrence.state}`);
    ledger.pass("a client frozen past its lease TTL cannot renew: the server expired the lease and the occurrence is ambiguous");
    await delay(100_000); // thawed: heartbeat, host completion and settle attempts are all refused now
    await probe.triggerSweep();
    await assertNoReplay(ctx, id, frozen, "expired lease");
    const journal = localJournal(profileA).filter((row) => row.occurrence_id === id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].state, "ambiguous", `thawed client's journal: ${JSON.stringify(journal[0])}`);
    ledger.pass(
      `expired/stale lease: after thawing, the late renew/settle changed nothing on the server and the client journal is ambiguous (${journal[0].reason})`,
    );
    // The in-flight handler itself: the Agent's session for this occurrence must be quiescent and empty of
    // model output, and must stay that way (a handler still running would write when the route answers).
    const stopped = slowTasks(ctx);
    assert.equal(stopped.length, tasksBefore + 1, "the lost lease did not spawn or replay another task");
    const task = stopped.at(-1);
    assert.notEqual(task.status, "completed", "the abandoned handler completed");
    await delay(15_000);
    const later = slowTasks(ctx).at(-1);
    assert.equal(later.status, task.status, "the abandoned task changed status after the lease was lost");
    const output = slowOutput(ctx, task);
    const quiet = slowOutput(ctx, later);
    if (output.status === "ok" && quiet.status === "ok") {
      assert.equal(assistantText(output.value).length, 0, `the abandoned handler produced output: ${JSON.stringify(outputShape(output.value))}`);
      assert.deepEqual(outputShape(quiet.value), outputShape(output.value), "the abandoned Agent turn kept changing after the lease was lost");
    }
    if (output.status === "ok" && assistantTerminal(output.value) && journal[0].reason === "lease_lost")
      ledger.pass(`lease loss stopped the in-flight handler: task status ${task.status}, terminal assistant turn with no output (${JSON.stringify(outputShape(output.value).at(-1))}), journal lease_lost`);
    else
      ledger.gap(
        "faults",
        "lease loss stops the in-flight Agent handler (observed, not inferred)",
        "UNPROVEN",
        `journal reason ${journal[0].reason}; task status ${task.status}; ${output.status === "ok" ? `assistant terminal=${assistantTerminal(output.value)}` : `in-profile Agent store not readable (${output.code})`}; a terminal turn tied to lease_lost with empty output was not observed`,
      );
  }

  // --- device revocation while a run is in flight -----------------------------------------------------------
  {
    const seen = await freshTarget(ctx, "slowRevoke");
    const run = await startInFlight(ctx, seen);
    const id = run.occurrence.occurrence_id;
    ledger.pass(`positive control: occurrence ${id} is in flight on the desktop device before revocation`);
    await revokeDevice(ctx, state.deviceIdA);
    const revoked = await waitAmbiguous(ctx, id, "a revoked device's in-flight occurrence resolves");
    const verdict = forOccurrence(revoked, id);
    assert.notEqual(verdict.occurrence.state, "succeeded", "a revoked device cannot complete the run");
    assert.equal(verdict.attempts.some((a) => a.outcome === "succeeded"), false, "no settle from the revoked device was accepted");
    assert.ok(verdict.links.every((link) => link.state !== "settled"), "the run link was not settled by a revoked device");
    ledger.pass(`device revocation: the in-flight occurrence ended ${verdict.occurrence.state} with no accepted settle`);

    // New work after revocation: the same path that claimed before must now be closed.
    await setAutomationStatus(ctx, "resume", state.slowManagedId);
    const fresh = await until(
      "a new occurrence exists that the revoked device could in principle claim",
      () => managedEvidence(server, orgId, state.slowManagedId),
      (value) => value.occurrences.some((row) => !seen.has(row.occurrence_id)),
      { timeout: 4 * 60_000, every: 5_000, tick: () => probe.triggerSweep() },
    );
    const next = fresh.occurrences.find((row) => !seen.has(row.occurrence_id));
    seen.add(next.occurrence_id);
    await delay(90_000); // three ticks, sweeps keep the occurrence dispatchable
    await probe.triggerSweep();
    const after = forOccurrence(await managedEvidence(server, orgId, state.slowManagedId), next.occurrence_id);
    assert.equal(after.leases.length, 0, "a revoked device holds no lease on a new occurrence");
    assert.equal(after.attempts.filter((a) => a.outcome === "claimed").length, 0, "a revoked device made no accepted claim");
    ledger.pass("after revocation the desktop's scheduler polls but no claim, lease or run is created for new occurrences");
    await setAutomationStatus(ctx, "pause", state.slowManagedId);
    state.deviceAvailable = false;
  }

  ledger.gap("faults", "off-peak occurrence is refused by the desktop", "UNPROVEN", "adoption never sets an off-peak policy; the owner PATCH route could add one to a handed-over definition, but the off-peak window/entitlement semantics are not driven here");
  ledger.gap("faults", "random lease/fence entropy and fence monotonicity across claims", "UNPROVEN", "only lease_fence >= 1 is read back; entropy and cross-claim monotonicity are covered by unit/Worker probes, not this journey");
  ledger.gap("faults", "stale fence presented by a live client with an unexpired lease", "UNPROVEN", "the raw lease token never leaves Main, so only the expired-lease path is reachable through the real app");
}
