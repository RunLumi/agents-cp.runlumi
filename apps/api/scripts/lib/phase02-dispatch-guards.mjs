// S6 — runtime proof of the dispatch consumer's guards (P06-CR-009), driven through public routes and the
// real cron sweep. Called by phase02-workspace-hostile-probe.mjs with that probe's helpers, so it shares
// the fixtures (org A, device, project, agent, live binding) and the claim ledger.
//
// D1 writes made here, and why they are not execution authority:
//   * `entitlement_grants` value lowered then restored: a DENIAL fixture (the org becomes ineligible).
//   * two hostile `queue_job_envelopes` rows (cross-tenant subject, duplicate dispatch): hostile INPUTS to
//     the consumer, never a way to make an occurrence dispatchable. Both are asserted to change nothing.
// No occurrence is ever moved to `dispatching`, leased or settled by D1.

import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertSafeId } from "./phase02-workspace-probe-support.mjs";

export const DISPATCH_GUARD_CLAIMS = [
  {
    id: "S6-C1",
    text: "positive control: an eligible manual occurrence is dispatched by the real sweep and offered",
  },
  {
    id: "S6-H1",
    text: "an org that became ineligible before dispatch never dispatches; the occurrence is skipped",
  },
  {
    id: "S6-H2",
    text: "queue_one successor waits pending without consuming job attempts, then dispatches",
  },
  {
    id: "S6-H3",
    text: "cancel_previous cancels the predecessor, defers the successor, then dispatches it",
  },
  {
    id: "S6-H4",
    text: "two open occurrences of one automation: only the older dispatches under skip",
  },
  {
    id: "S6-H5",
    text: "a cross-tenant or duplicate dispatch job changes nothing and dispatches at most once",
  },
];

export async function runDispatchGuards(c) {
  const { first, d1Rows, A } = c;
  const orgId = assertSafeId(A.orgId, "org");
  const where = `org_id = '${orgId}' AND entitlement_key = 'automations.max_active'`;
  const original = (
    await first(`SELECT value_json FROM entitlement_grants WHERE ${where}`, "entitlement original")
  )?.value_json;
  const setEntitlement = (value, label) =>
    d1Rows(
      `UPDATE entitlement_grants SET value_json = '${String(value).replace(/[^0-9]/g, "")}' WHERE ${where}`,
      label,
    );
  try {
    await runGuardScenarios({ ...c, setEntitlement });
  } finally {
    // The denial/raise fixtures never outlive the section: the original grant value is put back.
    if (typeof original === "string")
      await setEntitlement(original, "entitlement restore original");
  }
}

const DENIAL_LIMIT = "1";
const DIFFERENTIAL_LIMIT = "50";

async function runGuardScenarios(c) {
  const {
    probe,
    check,
    block,
    request,
    mut,
    bearer,
    deviceMut,
    anonJar,
    first,
    d1Rows,
    brief,
    A,
    B,
    dev,
    project,
    agent,
    binding,
    renewDevice,
    setEntitlement,
  } = c;
  const ALL = DISPATCH_GUARD_CLAIMS.map((x) => x.id);
  const safe = (id, prefix) => assertSafeId(id, prefix);
  const orgSql = safe(A.orgId, "org");
  const nonce = probe.nonce;

  if (!(await renewDevice(dev))) return block(ALL, "device token refresh failed before S6");

  const sweepUntil = async (predicate, { rounds = 14, pause = 2_000 } = {}) => {
    for (let i = 0; i < rounds; i += 1) {
      if (await predicate()) return true;
      await probe.triggerSweep();
      await delay(pause);
    }
    return predicate();
  };
  const mkAutomation = async (name, overlap) => {
    const res = await request(
      A.jar,
      "POST",
      `/api/v1/orgs/${A.orgId}/automations`,
      {
        name: `${name}-${nonce}`,
        project_id: project,
        agent_definition_id: agent,
        execution_principal: { kind: "user" },
        target: { kind: "eligible_device", workspace_binding_id: binding },
        schedule: overlap ? { kind: "manual", overlap_policy: overlap } : { kind: "manual" },
        execution_policy: {},
      },
      mut(A.jar, name),
    );
    return res.payload?.automation?.automation_id ?? res.payload?.automation_id ?? null;
  };
  const runNow = async (automationId, label) => {
    const version = Number(
      (
        await first(
          `SELECT version FROM automation_definitions WHERE automation_id = '${safe(automationId, "automation")}'`,
          "automation version",
        )
      )?.version ?? 1,
    );
    const res = await request(
      A.jar,
      "POST",
      `/api/v1/orgs/${A.orgId}/automations/${automationId}/run-now`,
      { version },
      mut(A.jar, `runnow-${label}`),
    );
    return {
      res,
      id: res.payload?.occurrence?.occurrence_id ?? res.payload?.occurrence_id ?? null,
    };
  };
  const occ = (id) =>
    first(
      `SELECT state, state_version, reason_code, queued_at, blocked_by_occurrence_id FROM automation_occurrences WHERE occurrence_id = '${safe(id, "occ")}'`,
      `occurrence ${label(id)}`,
    );
  const label = (id) => String(id).slice(0, 12);
  const jobs = (id) =>
    d1Rows(
      `SELECT job_id, state, attempt, lease_version, last_error_code, next_attempt_at FROM queue_job_envelopes WHERE job_type = 'automation.dispatch' AND subject_id = '${safe(id, "occ")}' ORDER BY created_at`,
      `jobs ${label(id)}`,
    );
  const eventCount = async (id, type) =>
    Number(
      (
        await first(
          `SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = '${type}' AND instr(envelope_json, '${safe(id, "occ")}') > 0`,
          `events ${type}`,
        )
      )?.n ?? -1,
    );
  // A due read counts as evidence only when it answered 200 with an items array. A missing or
  // malformed body is NOT "absent": every negative below goes through `notOffered`, which fails closed.
  const dueIds = async () => {
    const res = await request(
      anonJar(),
      "GET",
      "/api/v1/devices/automations/due",
      undefined,
      bearer(dev),
    );
    const valid = res.status === 200 && Array.isArray(res.payload?.items);
    return {
      valid,
      ids: valid ? res.payload.items.map((i) => i.occurrence_id ?? i.id) : [],
      detail: `status=${res.status} items=${Array.isArray(res.payload?.items) ? res.payload.items.length : "missing"}`,
    };
  };
  const offered = (due, ...ids) => due.valid && ids.every((id) => due.ids.includes(id));
  const notOffered = (due, ...ids) => due.valid && ids.every((id) => !due.ids.includes(id));
  const DISPATCHED = "automation.occurrence.dispatched.v1";
  const SKIPPED = "automation.occurrence.skipped.v1";
  const stateIs =
    (id, ...states) =>
    async () =>
      states.includes((await occ(id))?.state);

  // ---- S6-C1 positive control -----------------------------------------------------------
  const eligible = await mkAutomation("p02ws-s6-eligible");
  const eligibleOcc = eligible ? (await runNow(eligible, "s6-eligible")).id : null;
  if (!eligibleOcc) return block(ALL, "S6 fixture automation/occurrence could not be created");
  const reached = await sweepUntil(stateIs(eligibleOcc, "dispatching"));
  const dueNow = reached ? await dueIds() : { valid: false, ids: [], detail: "not read" };
  check(
    "S6-C1",
    "control: an eligible occurrence reaches dispatching through the real sweep and is offered",
    reached && offered(dueNow, eligibleOcc),
    `state=${(await occ(eligibleOcc))?.state} due=${dueNow.detail}`,
  );
  if (!reached)
    return block(
      ALL.filter((id) => id !== "S6-C1"),
      "positive control failed, so no refusal below is interpretable",
    );

  // ---- S6-H4 older-only predecessor (skip policy, two open occurrences) -----------------
  const skipAuto = await mkAutomation("p02ws-s6-skip");
  const older = skipAuto ? (await runNow(skipAuto, "s6-skip-1")).id : null;
  const newer = skipAuto ? (await runNow(skipAuto, "s6-skip-2")).id : null;
  if (older && newer) {
    await sweepUntil(
      async () =>
        (await occ(older))?.state !== "pending" && (await occ(newer))?.state !== "pending",
    );
    const o = await occ(older);
    const n = await occ(newer);
    check(
      "S6-H4",
      "the OLDER open occurrence dispatches and the NEWER one is skipped for overlap (never both skipped)",
      o?.state === "dispatching" && n?.state === "skipped",
      `older=${o?.state}/${o?.reason_code} newer=${n?.state}/${n?.reason_code}`,
    );
    check(
      "S6-H4",
      "exactly one dispatched event for the older, none for the newer; one skipped event for the newer",
      (await eventCount(older, DISPATCHED)) === 1 &&
        (await eventCount(newer, DISPATCHED)) === 0 &&
        (await eventCount(newer, SKIPPED)) === 1,
      `older dispatched=${await eventCount(older, DISPATCHED)} newer dispatched=${await eventCount(newer, DISPATCHED)} newer skipped=${await eventCount(newer, SKIPPED)}`,
    );
  } else block(["S6-H4"], "two-occurrence fixture could not be created");

  // ---- S6-H5 hostile / duplicate dispatch jobs --------------------------------------------
  const forgedAuto = await mkAutomation("p02ws-s6-forged");
  const forgedOcc = forgedAuto ? (await runNow(forgedAuto, "s6-forged")).id : null;
  if (forgedOcc && B?.orgId) {
    const plant = async (orgId, subject, dedupe, generation) => {
      const jobId = `job_${randomBytes(16).toString("hex")}`;
      const stamp = new Date().toISOString();
      await d1Rows(
        "INSERT INTO queue_job_envelopes (job_id, job_type, schema_version, org_id, subject_type, subject_id, subject_version, dedupe_key, event_id, request_id, correlation_id, payload_ref, state, attempt, lease_version, lease_expires_at, next_attempt_at, last_error_code, replay_of_job_id, generation, version, created_at, updated_at) " +
          `VALUES ('${jobId}', 'automation.dispatch', 1, '${safe(orgId, "org")}', 'automation_occurrence', '${safe(subject, "occ")}', 1, '${dedupe}', NULL, NULL, NULL, 'd1:automation_occurrences/${subject}', 'queued', 1, 0, NULL, '${stamp}', NULL, NULL, ${generation}, 1, '${stamp}', '${stamp}')`,
        "hostile dispatch job",
      );
      return jobId;
    };
    const crossTenant = await plant(B.orgId, forgedOcc, `forged:${forgedOcc}:x`, 7);
    const jobState = (jobId) => async () =>
      (await first(`SELECT state FROM queue_job_envelopes WHERE job_id = '${jobId}'`, "job state"))
        ?.state;
    const settled = (jobId) => async () => {
      const state = await jobState(jobId)();
      return state === "succeeded" || state === "dead_letter";
    };
    await sweepUntil(stateIs(forgedOcc, "dispatching"));
    await sweepUntil(settled(crossTenant));
    const forgedRow = await first(
      `SELECT state, last_error_code FROM queue_job_envelopes WHERE job_id = '${crossTenant}'`,
      "cross-tenant job",
    );
    const after = await occ(forgedOcc);
    check(
      "S6-H5",
      "a dispatch job naming ANOTHER org for this occurrence is dead-lettered (occurrence not found in that tenant)",
      forgedRow?.state === "dead_letter" &&
        forgedRow?.last_error_code === "automation_occurrence_missing",
      probe.brief(forgedRow),
    );
    check(
      "S6-H5",
      "the occurrence was dispatched exactly once by its own job: one step, one event",
      after?.state === "dispatching" &&
        Number(after?.state_version) === 2 &&
        (await eventCount(forgedOcc, DISPATCHED)) === 1,
      probe.brief(after),
    );
    const duplicate = await plant(A.orgId, forgedOcc, `dup:${forgedOcc}:y`, 8);
    await sweepUntil(settled(duplicate));
    const dupRow = await first(
      `SELECT state, last_error_code FROM queue_job_envelopes WHERE job_id = '${duplicate}'`,
      "duplicate job",
    );
    const afterDup = await occ(forgedOcc);
    check(
      "S6-H5",
      "a duplicate dispatch job for an already-dispatched occurrence completes and writes nothing to it",
      dupRow?.state === "succeeded" &&
        Number(afterDup?.state_version) === 2 &&
        (await eventCount(forgedOcc, DISPATCHED)) === 1,
      `${probe.brief(dupRow)} ${probe.brief(afterDup)}`,
    );
  } else block(["S6-H5"], "forged-job fixture could not be created");

  // ---- S6-H1 ineligible org (denial fixture) ------------------------------------------------
  const ineligibleAuto = await mkAutomation("p02ws-s6-ineligible");
  const ineligibleOcc = ineligibleAuto ? (await runNow(ineligibleAuto, "s6-ineligible")).id : null;
  if (ineligibleOcc) {
    const before = await occ(ineligibleOcc);
    await setEntitlement(DENIAL_LIMIT, "entitlement denial fixture");
    const settled = await sweepUntil(async () => (await occ(ineligibleOcc))?.state !== "pending");
    const o = await occ(ineligibleOcc);
    const jr = (await jobs(ineligibleOcc))[0];
    const due = await dueIds();
    check(
      "S6-H1",
      "control: the occurrence was pending and eligible when created",
      before?.state === "pending",
      probe.brief(before),
    );
    check(
      "S6-H1",
      "after the org lost eligibility the sweep SKIPS the occurrence with reason entitlement_limit_exceeded (never dispatching)",
      settled && o?.state === "skipped" && o?.reason_code === "entitlement_limit_exceeded",
      probe.brief(o),
    );
    check(
      "S6-H1",
      "its job is terminal succeeded; exactly one skipped event, no dispatched event; not offered as due",
      jr?.state === "succeeded" &&
        (await eventCount(ineligibleOcc, SKIPPED)) === 1 &&
        (await eventCount(ineligibleOcc, DISPATCHED)) === 0 &&
        notOffered(due, ineligibleOcc),
      `job=${probe.brief(jr)} due=${due.detail}`,
    );
    await setEntitlement(DIFFERENTIAL_LIMIT, "entitlement raised for the differential");
    const again = await mkAutomation("p02ws-s6-restored");
    const againOcc = again ? (await runNow(again, "s6-restored")).id : null;
    const dispatched = againOcc ? await sweepUntil(stateIs(againOcc, "dispatching")) : false;
    check(
      "S6-H1",
      "differential: with eligibility restored a fresh occurrence of the same org dispatches",
      dispatched,
      `occ=${againOcc}`,
    );
  } else block(["S6-H1"], "ineligible fixture could not be created");

  // ---- S6-H2 queue_one (its own phase: defer, repeated re-evaluation, terminate predecessor, dispatch)
  const qAuto = await mkAutomation("p02ws-s6-queue-one", "queue_one");
  const q1 = qAuto ? (await runNow(qAuto, "s6-q1")).id : null;
  if (!q1 || !(await sweepUntil(stateIs(q1, "dispatching")))) {
    block(
      ["S6-H2"],
      "the queue_one predecessor did not dispatch, so deferral is not interpretable",
    );
  } else {
    const q2 = (await runNow(qAuto, "s6-q2")).id;
    const deferred = await sweepUntil(async () => Boolean((await occ(q2))?.queued_at));
    const q2Row = await occ(q2);
    check(
      "S6-H2",
      "queue_one: the successor stays pending, queued behind its predecessor, never dispatching",
      deferred && q2Row?.state === "pending" && q2Row?.blocked_by_occurrence_id === q1,
      `q1=${q1} q2=${probe.brief(q2Row)}`,
    );
    const dueDeferred = await dueIds();
    check(
      "S6-H2",
      "a deferred successor is not offered as due work (valid 200 read, predecessor offered as the positive control)",
      notOffered(dueDeferred, q2) && offered(dueDeferred, q1),
      `due=${dueDeferred.detail}`,
    );
    const firstRound = (await jobs(q2))[0];
    check(
      "S6-H2",
      "its job went back to queued with a future next_attempt_at, attempt still 1, deferral code recorded",
      firstRound?.state === "queued" &&
        Number(firstRound?.attempt) === 1 &&
        firstRound?.last_error_code === "automation_dispatch_deferred" &&
        Date.parse(firstRound?.next_attempt_at) > Date.now() - 2_000,
      probe.brief(firstRound),
    );
    // Let the deferred job come due and be re-evaluated while the predecessor is still open.
    await sweepUntil(async () => Number((await jobs(q2))[0]?.lease_version) >= 4, {
      rounds: 22,
      pause: 2_000,
    });
    const rounds = (await jobs(q2))[0];
    check(
      "S6-H2",
      "after repeated re-evaluations the successor is STILL pending and the job attempt count is unchanged (no attempt budget consumed, not dead-lettered)",
      Number(rounds?.lease_version) >= 4 &&
        Number(rounds?.attempt) === 1 &&
        rounds?.state === "queued" &&
        (await occ(q2))?.state === "pending",
      probe.brief(rounds),
    );

    // Terminate the predecessor through the public device lease API. The one-time lease token is
    // registered as a secret BEFORE anything about the claim is printed, and no body is printed.
    await renewDevice(dev);
    const claim = await request(
      anonJar(),
      "POST",
      `/api/v1/devices/automation-occurrences/${q1}/claim`,
      undefined,
      bearer(dev),
    );
    const lease = claim.payload ?? {};
    if (typeof lease.lease_token === "string") probe.registerSecret(lease.lease_token);
    const settle =
      claim.status === 201
        ? await request(
            anonJar(),
            "POST",
            `/api/v1/devices/automation-occurrences/${q1}/settle`,
            {
              lease_id: lease.lease_id,
              lease_version: lease.lease_version,
              lease_fence: lease.lease_fence,
              lease_token: lease.lease_token,
              outcome: "failed",
              reason_code: "p02ws_probe_predecessor_done",
            },
            deviceMut(dev, "s6-settle"),
          )
        : null;
    check(
      "S6-H2",
      "control: the predecessor is terminated through the public claim and settle routes",
      claim.status === 201 &&
        settle?.status >= 200 &&
        settle?.status < 300 &&
        (await occ(q1))?.state === "failed",
      `claim status=${claim.status} lease_id=${lease.lease_id ?? "none"} settle status=${settle ? settle.status : "not attempted"}`,
    );

    const dispatched = await sweepUntil(stateIs(q2, "dispatching"), { rounds: 24, pause: 2_000 });
    const q2Done = await occ(q2);
    const q2Job = (await jobs(q2))[0];
    const dueFinal = await dueIds();
    check(
      "S6-H2",
      "once the predecessor is terminal the queue_one successor dispatches: queue marker cleared, job succeeded, one event, offered",
      dispatched &&
        q2Done?.queued_at === null &&
        q2Job?.state === "succeeded" &&
        (await eventCount(q2, DISPATCHED)) === 1 &&
        offered(dueFinal, q2),
      `${probe.brief(q2Done)} job=${probe.brief(q2Job)} due=${dueFinal.detail}`,
    );
  }

  // ---- S6-H3 cancel_previous (its own phase, so the queue_one wait cannot let it dispatch early) ----
  const cAuto = await mkAutomation("p02ws-s6-cancel-prev", "cancel_previous");
  const c1 = cAuto ? (await runNow(cAuto, "s6-c1")).id : null;
  if (!c1 || !(await sweepUntil(stateIs(c1, "dispatching")))) {
    block(
      ["S6-H3"],
      "the cancel_previous predecessor did not dispatch, so deferral is not interpretable",
    );
  } else {
    const c2 = (await runNow(cAuto, "s6-c2")).id;
    const deferred = await sweepUntil(async () => Boolean((await occ(c2))?.queued_at));
    const c1Row = await occ(c1);
    const c2Row = await occ(c2);
    const dueDeferred = await dueIds();
    check(
      "S6-H3",
      "cancel_previous: the predecessor is cancelled and the successor waits pending behind it, not offered",
      deferred &&
        c1Row?.state === "cancelled" &&
        c2Row?.state === "pending" &&
        c2Row?.blocked_by_occurrence_id === c1 &&
        notOffered(dueDeferred, c2, c1),
      `pred=${probe.brief(c1Row)} succ=${probe.brief(c2Row)} due=${dueDeferred.detail}`,
    );
    const dispatched = await sweepUntil(stateIs(c2, "dispatching"), { rounds: 24, pause: 2_000 });
    const c2Done = await occ(c2);
    const c2Job = (await jobs(c2))[0];
    const dueFinal = await dueIds();
    check(
      "S6-H3",
      "once its predecessor is cancelled the cancel_previous successor dispatches exactly once",
      dispatched &&
        c2Done?.queued_at === null &&
        c2Job?.state === "succeeded" &&
        (await eventCount(c2, DISPATCHED)) === 1 &&
        offered(dueFinal, c2),
      `${probe.brief(c2Done)} job=${probe.brief(c2Job)} due=${dueFinal.detail}`,
    );
  }
}
