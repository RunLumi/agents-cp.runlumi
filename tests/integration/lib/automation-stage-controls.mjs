// Fault controls on the adopted, healthy managed automation: entitlement loss and a lost start response. Both
// reuse the real apps, the real Worker and the real scheduler; the only test-owned parts are the synthetic billing
// fixture (grant revoked / restored) and the recording proxy dropping ONE response after the Worker committed it.
import assert from "node:assert/strict";
import {
  compactOccurrences,
  localJournal,
  managedEvidence,
  until,
} from "./automation-evidence.mjs";
import {
  grantAutomationFixtureEntitlement,
  revokeAutomationFixtureEntitlement,
} from "./lumi-org-fixture.mjs";

const occurrenceIds = (value) => new Set(value.occurrences.map((row) => row.occurrence_id));
const related = (value, id) => ({
  leases: value.leases.filter((row) => row.occurrence_id === id),
  attempts: value.attempts.filter((row) => row.occurrence_id === id),
  links: value.links.filter((row) => row.occurrence_id === id),
});

/**
 * The plan lapses (grant revoked): the next slot must be decided against the CURRENT entitlement (spec f15, dispatch
 * re-reads it) and never reach a device. Restoring the grant is the positive control: the same automation executes again.
 */
export async function entitlementLossControl(ctx) {
  const { ledger, probe, server, orgId, state } = ctx;
  const managedId = state.managedAutomationId;
  const seen = occurrenceIds(await managedEvidence(server, orgId, managedId));
  const revoked = await revokeAutomationFixtureEntitlement(probe, orgId, "automations.max_active");
  let evidence;
  try {
    evidence = await until(
      "a slot after the entitlement lapsed is decided",
      () => managedEvidence(server, orgId, managedId),
      (value) =>
        value.occurrences.some((row) => !seen.has(row.occurrence_id) && row.state !== "pending"),
      {
        timeout: 4 * 60_000,
        every: 5_000,
        tick: () => probe.triggerSweep(),
        describe: compactOccurrences,
      },
    );
  } finally {
    await grantAutomationFixtureEntitlement(probe, orgId, "automations.max_active", 5);
  }
  const decided = evidence.occurrences.filter(
    (row) => !seen.has(row.occurrence_id) && row.state !== "pending",
  );
  for (const row of decided) {
    assert.ok(
      ["skipped", "cancelled", "failed"].includes(row.state),
      `entitlement-less slot ${row.occurrence_id} ended ${row.state} (${row.reason_code})`,
    );
    assert.match(String(row.reason_code), /entitlement/i, `blocked for ${row.reason_code}`);
    const rel = related(evidence, row.occurrence_id);
    assert.equal(
      rel.leases.length + rel.attempts.length + rel.links.length,
      0,
      "a blocked slot has no lease, attempt or run link",
    );
  }
  ledger.pass(
    `entitlement loss: after ${revoked} automations.max_active grant(s) lapsed, ${decided.length} slot(s) ended ${decided.map((row) => `${row.state}/${row.reason_code}`).join(", ")} with no lease, attempt or run (no client executed anything)`,
  );
  const restoredSeen = occurrenceIds(await managedEvidence(server, orgId, managedId));
  await until(
    "after the grant is restored a new slot executes (positive control for the block)",
    () => managedEvidence(server, orgId, managedId),
    (value) =>
      value.occurrences.some(
        (row) => !restoredSeen.has(row.occurrence_id) && row.state === "succeeded",
      ),
    {
      timeout: 6 * 60_000,
      every: 6_000,
      tick: () => probe.triggerSweep(),
      describe: compactOccurrences,
    },
  );
  ledger.pass(
    "entitlement restored: the same automation executed a fresh slot to succeeded, so the earlier block was the entitlement and nothing else",
  );
}

/**
 * A start that the Worker COMMITTED but whose response never reached the client. The occurrence must end ambiguous
 * (execution may have begun), never be released or re-claimed, and the client must not settle it.
 */
export async function lostStartResponseControl(ctx) {
  const { ledger, probe, server, orgId, state, profileA, claimProxy } = ctx;
  assert.ok(claimProxy, "the recording proxy is required to drop a response");
  const managedId = state.managedAutomationId;
  const seen = occurrenceIds(await managedEvidence(server, orgId, managedId));
  const profiles = { A: profileA, B: state.profileB };
  const fault = claimProxy.dropNextResponse(
    /\/automation-occurrences\/occ_[0-9a-f]+\/start(?:\?|$)/,
  );
  let committed;
  await until(
    "a start request is forwarded and its response dropped",
    async () => fault.result,
    (result) => !!result,
    { timeout: 4 * 60_000, every: 3_000, tick: () => probe.triggerSweep() },
  );
  assert.equal(
    fault.result.status,
    201,
    `the Worker committed the start (answered ${fault.result.status}) before its response was dropped`,
  );
  const after = await until(
    "the occurrence whose start response was lost resolves on the server",
    () => managedEvidence(server, orgId, managedId),
    (value) => {
      committed = value.occurrences.find(
        (row) =>
          !seen.has(row.occurrence_id) &&
          ["started", "ambiguous", "failed", "succeeded"].includes(row.state) &&
          row.started_at,
      );
      return committed && ["ambiguous", "failed", "succeeded"].includes(committed.state);
    },
    {
      timeout: (Number(state.leaseTtl ?? 300) + 240) * 1_000,
      every: 6_000,
      tick: () => probe.triggerSweep(),
    },
  );
  const id = committed.occurrence_id;
  assert.equal(
    committed.state,
    "ambiguous",
    `a started occurrence whose start response was lost must end ambiguous, got ${committed.state}`,
  );
  const rel = related(after, id);
  assert.equal(
    rel.attempts.filter((row) => row.outcome === "claimed").length,
    1,
    "claimed exactly once",
  );
  assert.equal(
    rel.attempts.some((row) => row.outcome === "succeeded"),
    false,
    "nothing settled it as succeeded",
  );
  const accepted = claimProxy.claimsFor(id).filter((row) => row.status === 201).length;
  assert.equal(accepted, 1, `no second accepted claim after the lost response, got ${accepted}`);
  for (const [key, profile] of Object.entries(profiles)) {
    const journal = localJournal(profile).filter((row) => row.occurrence_id === id);
    assert.equal(
      journal.some((row) => row.state === "settled"),
      false,
      `client ${key} settled an occurrence whose start it never saw confirmed`,
    );
  }
  ledger.pass(
    `lost start response: the Worker committed the start (${fault.result.status}) and its response was dropped; occurrence ${id} ended ${committed.state} (${committed.reason_code}) with one claim, no second accepted claim, no accepted settle and no client journal settled`,
  );
}
