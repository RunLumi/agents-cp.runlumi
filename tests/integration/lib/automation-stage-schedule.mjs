// Stage `schedule`: the REAL desktop scheduler drives one server-generated occurrence of the adopted
// automation from due to settled. The test only (a) fires the Worker's own scheduled handler, which is
// the server clock in a local Worker, and (b) reads D1 and the local tasks-index.
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { localJournal, managedEvidence, until } from "./automation-evidence.mjs";
import { CONTENT_TABLES, readTable } from "./automation-journey-state.mjs";
import { rowOf } from "./automation-stage-adopt.mjs";
import { postAdoptionLocalProof } from "./local-personal-provider.mjs";
import {
  assistantTerminal,
  assistantText,
  managedTasks,
  outputShape,
  probe as readOrUnproven,
  taskOutput,
} from "./automation-task-output.mjs";

export const TERMINAL = ["succeeded", "failed", "cancelled", "missed", "skipped", "ambiguous"];
/** The backend development mock:// provider's fixed reply. */
const MOCK_REPLY = "Hello from Lumi.";
/** Same machine, same clock: only absorbs rounding between the Worker's ISO ms stamp and the client's. */
const CLOCK_SLACK_MS = 2_000;

/** Content-free rendering of what `assertAbsent` actually measured (tables / text columns / rows). */
export function describeScope(scope) {
  const sum = (key) => scope.reduce((total, item) => total + item[key], 0);
  return `${scope.length} tables, ${sum("columns")} text columns, ${sum("rows")} rows`;
}

/** A tasks-index timestamp (epoch ms, epoch s or ISO text) as epoch ms; NaN when it is none of those. */
export function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1_000 : value;
  if (typeof value === "string" && value !== "") return /^\d+$/.test(value) ? toEpochMs(Number(value)) : Date.parse(value);
  return Number.NaN;
}

/**
 * Split the retained original's tasks by whether the task row was created inside the occurrence's
 * [lease claim, succeeded] window. The tasks-index metadata carries only `cronAutomationId` (no occurrence
 * or run id), so the window is the narrowest correlation available; a row whose time cannot be read is
 * reported as `unreadable`, never assumed to be inside or outside.
 */
export function tasksInWindow(tasks, { claimedAt, settledAt }) {
  const inside = [];
  const outside = [];
  const unreadable = [];
  for (const task of tasks) {
    const at = toEpochMs(task.createdAt);
    if (Number.isNaN(at)) unreadable.push(task);
    else if (at >= claimedAt - CLOCK_SLACK_MS && at <= settledAt + CLOCK_SLACK_MS) inside.push(task);
    else outside.push(task);
  }
  return { inside, outside, unreadable };
}

/**
 * Read the managed occurrence's Agent output from the isolated client profile only. PASS needs the single
 * correlated task to be completed AND its in-profile assistant message to hold the mock reply with a
 * terminal marker; D1 settlement alone is never output. Anything else is an explicit, content-free gap.
 */
async function readManagedOutput(ctx, window) {
  const { ledger, profileA, seeds } = ctx;
  const claim = "managed Agent produced the assistant text / file result on the desktop";
  const gap = (reason) => ledger.gap("schedule", claim, "UNPROVEN", reason);
  if (!Number.isFinite(window.claimedAt) || !Number.isFinite(window.settledAt))
    return gap("D1 lease/attempt timestamps were unreadable, so no task could be correlated to the occurrence");

  const tasks = readOrUnproven(() => managedTasks(profileA, { localAutomationId: seeds.adopted.automationId }));
  if (tasks.status !== "ok") return gap(`in-profile tasks-index not readable (${tasks.code})`);
  const { inside, outside, unreadable } = tasksInWindow(tasks.value, window);
  if (unreadable.length > 0)
    return gap(`${unreadable.length} task row(s) had an unreadable created_at; window correlation impossible`);
  if (inside.length !== 1)
    return gap(
      `tasks-index metadata has only cronAutomationId (no occurrence/run id); ${inside.length} task(s) fall in the occurrence window and ${outside.length} outside, so one task cannot be attributed`,
    );
  const task = inside[0];
  // the client writes the task row and the settle report back to back; allow it a moment to land
  const reply = await until(
    "the correlated task's in-profile Agent session is terminal",
    async () => ({
      task: managedTasks(profileA, { localAutomationId: seeds.adopted.automationId }).find((t) => t.taskId === task.taskId),
      output: readOrUnproven(() => taskOutput(profileA, task.taskId)),
    }),
    ({ output }) => output.status !== "ok" || assistantTerminal(output.value),
    { timeout: 30_000, every: 2_000 },
  ).catch((error) => ({ error }));
  if (reply.error) return gap(`the correlated task never reached a terminal assistant message (${String(reply.error.message).slice(0, 200)})`);
  if (reply.output.status !== "ok") return gap(`in-profile Agent store not readable (${reply.output.code})`);
  assert.equal(reply.task?.status, "completed", `the correlated task ended ${reply.task?.status}`);
  const text = assistantText(reply.output.value);
  if (!text.includes(MOCK_REPLY))
    return gap(`session terminal but the mock reply was absent: ${JSON.stringify(outputShape(reply.output.value))}`);
  ledger.pass(
    `the managed occurrence's own Agent task (sole task created in its claim-to-settle window; ${outside.length} other task(s) for the original outside it) is completed and its in-profile assistant message holds the mock reply "${MOCK_REPLY}" with a terminal marker; correlation is by time window because task metadata has no occurrence id`,
  );
}

/** Every row of `table` for the org whose serialized form mentions `needle` (SELECT * keeps this schema-free). */
export async function rowsMentioning(server, orgId, table, needles) {
  const rows = await server.rows(`SELECT * FROM ${table} WHERE org_id='${orgId}'`, `${table} for correlation`);
  return rows.filter((row) => {
    const text = JSON.stringify(row);
    return needles.some((needle) => text.includes(needle));
  });
}

export async function scheduleStage(ctx) {
  const { ledger, probe, server, orgId, profileA, seeds, state, PROMPT, evidenceDir } = ctx;
  const managedId = state.managedAutomationId;
  assert.ok(managedId, "adopt stage must provide the managed automation id");
  const sweep = () => probe.triggerSweep();

  const evidence = await until(
    "a managed occurrence reaches a terminal state through the real desktop scheduler",
    () => managedEvidence(server, orgId, managedId),
    (value) => value.occurrences.some((occurrence) => TERMINAL.includes(occurrence.state)),
    { timeout: 6 * 60_000, every: 6_000, tick: sweep },
  );
  const occurrence = evidence.occurrences.find((item) => TERMINAL.includes(item.state));
  state.firstOccurrence = occurrence.occurrence_id;
  assert.equal(
    occurrence.state,
    "succeeded",
    `occurrence ended ${occurrence.state} (reason ${occurrence.reason_code}); attempts=${JSON.stringify(
      evidence.attempts.map((a) => [a.outcome, a.reason_code]),
    )}`,
  );
  ledger.pass(
    "server generated a due occurrence (its own sweep) and it reached succeeded through the real scheduler, not a test claim",
  );

  const leases = evidence.leases.filter((lease) => lease.occurrence_id === occurrence.occurrence_id);
  assert.equal(leases.length, 1, `exactly one lease row for the occurrence, got ${leases.length}`);
  assert.equal(leases[0].device_id, state.deviceIdA, "the lease belongs to the enrolled desktop device");
  assert.ok(leases[0].lease_fence >= 1 && leases[0].lease_version >= 1);
  const outcomes = evidence.attempts
    .filter((attempt) => attempt.occurrence_id === occurrence.occurrence_id)
    .map((attempt) => attempt.outcome);
  assert.deepEqual(outcomes.slice(0, 3), ["claimed", "started", "succeeded"], `attempt history ${outcomes}`);
  const link = evidence.links.find((item) => item.occurrence_id === occurrence.occurrence_id);
  assert.ok(link, "an automation_run_links row ties the occurrence to a P05 run");
  assert.equal(link.state, "settled");
  assert.equal(link.lease_id, leases[0].lease_id);
  const run = evidence.runs.find((item) => item.run_id === link.run_id);
  assert.ok(run, "the linked P05 run exists");
  assert.match(String(run.status ?? run.state), /complet|succe/i, `run state ${run.status ?? run.state}`);
  ledger.pass(
    `D1: one lease for the desktop device, attempts ${outcomes.join(">")}, run link settled, P05 run ${run.status ?? run.state} (same ids)`,
  );
  state.firstRunId = link.run_id;

  const journal = localJournal(profileA).filter((row) => row.occurrence_id === occurrence.occurrence_id);
  assert.equal(journal.length, 1, "one local journal row for the occurrence");
  assert.equal(journal[0].state, "settled");
  assert.equal(journal[0].run_id, link.run_id, "the local journal and D1 agree on the run id");
  assert.equal(journal[0].managed_automation_id, managedId);
  ledger.pass("the local managed-occurrence journal settled with the same occurrence and run ids as D1");

  const inference = await rowsMentioning(server, orgId, "inference_requests", [link.run_id]);
  const usage = await rowsMentioning(server, orgId, "usage_events", [link.run_id]);
  const audit = await rowsMentioning(server, orgId, "security_events", [occurrence.occurrence_id, link.run_id]);
  assert.ok(inference.length >= 1, "the run's model call reached the gateway (inference_requests row for the run)");
  assert.ok(usage.length >= 1, "usage was recorded for the run");
  assert.ok(audit.length >= 1, "claim/start/settle left audit rows naming the occurrence");
  ledger.pass(
    `real managed run readback: ${inference.length} inference request(s), ${usage.length} usage event(s), ${audit.length} audit row(s) for the same run/occurrence`,
  );
  const scope = await server.assertAbsent(PROMPT, CONTENT_TABLES, "prompt body after the managed run");
  ledger.pass(
    `the prompt body is in no server table after the managed run (measured ${describeScope(scope)})`,
  );
  const settledAt = Math.max(
    ...evidence.attempts
      .filter((attempt) => attempt.occurrence_id === occurrence.occurrence_id && attempt.outcome === "succeeded")
      .map((attempt) => Date.parse(attempt.recorded_at)),
  );
  await readManagedOutput(ctx, { claimedAt: Date.parse(leases[0].claimed_at), settledAt });
  ledger.gap(
    "schedule",
    "external provider round trip",
    "BLOCKED",
    "only the backend development mock:// provider is configured; no approved provider credential or spending cap",
  );
  ledger.gap(
    "schedule",
    "renewal during a long run",
    "UNPROVEN",
    "the mock provider answers inside one heartbeat; renewal is graded in the restart/fault stages on the slow route",
  );

  // --- the local scheduler did not also run the original --------------------------------------------
  const localDueAt = ctx.localDueAt;
  const wait = localDueAt + 75_000 - Date.now();
  if (wait > 0) {
    console.log(`waiting ${Math.ceil(wait / 1000)}s for the local due time + two scheduler ticks`);
    await delay(wait);
  }
  // Positive control = COMPLETED local work (run dispatched+succeeded, Agent task completed with the stub marker),
  // never an attempt or a last_error: the old predicate also passed when the control failed to resolve a model.
  await postAdoptionLocalProof(ctx);
  assert.deepEqual(rowOf(profileA, seeds.adopted.automationId), state.adoptedBefore, "the adopted original is byte-identical after it was due and managed");
  assert.equal(
    readTable(profileA, "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?", seeds.adopted.automationId)[0].n,
    0,
    "the local scheduler wrote no run history for the adopted original",
  );
  ledger.pass(
    "past the original's local due time, the unmarked control completed locally while the adopted original stayed untouched: only the managed scheduler ran it",
  );
  await ctx.appA.page.screenshot(join(evidenceDir, "schedule-after.png")).catch(() => {});
}
