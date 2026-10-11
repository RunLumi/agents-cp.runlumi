// Pure tests for the Phase 2 workspace hostile probe. No Worker, wrangler, D1 or network.
// Run: node --test apps/api/scripts/phase02-workspace-hostile-probe.test.mjs
//
// These prove the probe's own bookkeeping cannot turn a failure into a pass. They are NOT product
// evidence: nothing here talks to the candidate.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { leaks, redact } from "./phase02-redact-log.mjs";
import { fileURLToPath } from "node:url";
import {
  ClaimLedger,
  STATUS,
  assertSafeId,
  bindingIdsOf,
  changedKeys,
  claimIdsFromMarkdown,
  digestFromD1Row,
  digestSql,
  digestsUnchanged,
  isTombstoneTimestamp,
  makeDeviceIdentity,
  policyProjectIds,
  sourceLineContaining,
} from "./lib/phase02-workspace-probe-support.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const probeSource = readFileSync(join(here, "phase02-workspace-hostile-probe.mjs"), "utf8");
const guardsSource = readFileSync(join(here, "lib", "phase02-dispatch-guards.mjs"), "utf8");
const docSource = readFileSync(
  join(here, "..", "..", "..", "docs", "verification", "phase02-workspace-hostile-probe.md"),
  "utf8",
);

const hex = "0123456789abcdef0123456789abcdef";

test("a claim with no recorded outcome is UNPROVEN and the run cannot exit 0", () => {
  const ledger = new ClaimLedger([{ id: "A-1" }, { id: "A-2" }]);
  ledger.pass("A-1");
  assert.equal(ledger.statusOf("A-1"), STATUS.PASS);
  assert.equal(ledger.statusOf("A-2"), STATUS.UNPROVEN);
  assert.equal(ledger.exitCode(), 2);
});

test("the worst outcome wins: FAIL beats BLOCKED beats PASS, exit 1 on any FAIL", () => {
  const ledger = new ClaimLedger([{ id: "A-1" }, { id: "A-2" }, { id: "A-3" }]);
  ledger.pass("A-1");
  ledger.fail("A-1", "one assertion failed");
  ledger.pass("A-1");
  ledger.pass("A-2");
  ledger.block("A-2", "control failed");
  ledger.pass("A-3");
  assert.equal(ledger.statusOf("A-1"), STATUS.FAIL);
  assert.equal(ledger.statusOf("A-2"), STATUS.BLOCKED);
  assert.equal(ledger.statusOf("A-3"), STATUS.PASS);
  assert.equal(ledger.exitCode(), 1);
});

test("exit 0 only when every claim passed; BLOCKED alone is exit 2, never green", () => {
  const green = new ClaimLedger([{ id: "A-1" }]);
  green.pass("A-1");
  assert.equal(green.exitCode(), 0);
  const blocked = new ClaimLedger([{ id: "A-1" }]);
  blocked.block("A-1", "prerequisite absent");
  assert.equal(blocked.exitCode(), 2);
});

test("an empty claim table is refused: zero claims must never read as all-claims-passed", () => {
  // Vacuous truth: `[].every(...)` is true, so an empty ledger would exit 0 with nothing proven.
  assert.throws(() => new ClaimLedger([]), /non-empty claim table/);
  assert.throws(() => new ClaimLedger(undefined), /non-empty claim table/);
  assert.throws(() => new ClaimLedger(null), /non-empty claim table/);
  // Positive control: a declared claim that passes still yields exit 0.
  const positive = new ClaimLedger([{ id: "A-1" }, { id: "A-2" }]);
  positive.pass("A-1");
  positive.pass("A-2");
  assert.deepEqual(
    positive.summary().map((entry) => entry.status),
    [STATUS.PASS, STATUS.PASS],
  );
  assert.equal(positive.exitCode(), 0);
});

test("an undeclared claim id throws, so a typo cannot invent a claim", () => {
  const ledger = new ClaimLedger([{ id: "A-1" }]);
  assert.throws(() => ledger.pass("A-9"), /unknown claim id/);
  assert.throws(() => new ClaimLedger([{ id: "A-1" }, { id: "A-1" }]), /duplicate claim id/);
});

test("unchanged requires every digest field read and equal; an unread field is never unchanged", () => {
  const base = digestFromD1Row({
    row: '{"version":6}',
    adoption_events: 3,
    security_events: 4,
    outbox_events: 5,
    idempotency_records: 6,
    bindings: "wsb_a::t1",
  });
  assert.equal(digestsUnchanged(base, { ...base }).unchanged, true);
  const moved = { ...base, outbox_events: 6 };
  assert.deepEqual(digestsUnchanged(base, moved).changed, ["outbox_events"]);
  const unread = digestFromD1Row({ row: null, adoption_events: 3 });
  const verdict = digestsUnchanged(unread, unread);
  assert.equal(verdict.unchanged, false);
  assert.ok(verdict.changed.every((entry) => entry.endsWith("(unread)")));
  assert.equal(digestsUnchanged(undefined, base).unchanged, false);
});

test("ignore is explicit and per call: a denial may move security_events but nothing else", () => {
  const base = digestFromD1Row({
    row: "r",
    adoption_events: 1,
    security_events: 1,
    outbox_events: 1,
    idempotency_records: 1,
    bindings: "b",
  });
  assert.equal(digestsUnchanged(base, { ...base, security_events: 2 }).unchanged, false);
  assert.equal(
    digestsUnchanged(base, { ...base, security_events: 2 }, { ignore: ["security_events"] })
      .unchanged,
    true,
  );
  assert.equal(
    digestsUnchanged(
      base,
      { ...base, security_events: 2, outbox_events: 2 },
      { ignore: ["security_events"] },
    ).unchanged,
    false,
  );
});

test("changedKeys is order-insensitive and shallow", () => {
  assert.deepEqual(changedKeys({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.deepEqual(changedKeys({ a: 1 }, { a: 1, b: 2 }), ["b"]);
});

test("digestSql only accepts well-formed ids and never interpolates anything else", () => {
  const sql = digestSql({ adoptionStateId: `wst_${hex}`, orgId: `org_${hex}` });
  assert.match(
    sql,
    /FROM workspace_adoption_states WHERE adoption_state_id = 'wst_0123456789abcdef0123456789abcdef'/,
  );
  assert.match(sql, /FROM workspace_bindings/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
  for (const bad of [
    "wst_x' OR '1'='1",
    "",
    "wst_",
    "../etc",
    `wst_${hex};DROP TABLE x`,
    7,
    null,
  ]) {
    assert.throws(() => assertSafeId(bad, "id"), /malformed id/);
  }
});

test("the device identity signs for real: the signature verifies and a tampered message does not", () => {
  const device = makeDeviceIdentity("unit");
  const signature = device.sign("challenge-value");
  assert.equal(device.verifyOwn("challenge-value", signature), true);
  assert.equal(device.verifyOwn("other-value", signature), false);
  assert.match(device.keyFingerprint, /^[0-9a-f]{64}$/);
  assert.match(device.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.notEqual(makeDeviceIdentity("a").keyFingerprint, makeDeviceIdentity("b").keyFingerprint);
});

test("tombstone timestamps must be the exact 24-character wire form", () => {
  assert.equal(isTombstoneTimestamp("2026-10-09T01:02:03.456Z"), true);
  for (const bad of [
    null,
    undefined,
    "",
    "2026-10-09T01:02:03Z",
    "2026-10-09 01:02:03.456Z",
    "2026-10-09T01:02:03.4567Z",
  ]) {
    assert.equal(isTombstoneTimestamp(bad), false);
  }
});

test("list and policy readers fail closed on a wrong shape", () => {
  assert.deepEqual(
    bindingIdsOf({ items: [{ id: "wsb_1" }, { binding_id: "wsb_2" }, {}, { id: 3 }] }),
    ["wsb_1", "wsb_2"],
  );
  assert.deepEqual(bindingIdsOf(undefined), []);
  assert.deepEqual(policyProjectIds({ payload: { projects: { bindings: ["prj_a"] } } }), ["prj_a"]);
  assert.equal(policyProjectIds({ payload: { projects: { bindings: [1] } } }), null);
  assert.equal(policyProjectIds({ payload: {} }), null);
});

test("sourceLineContaining reports the first match with a 1-based line number", () => {
  assert.deepEqual(
    sourceLineContaining("a\n  ORDER BY o.scheduled_for_ ASC\nb", "ORDER BY o.scheduled_for_ "),
    {
      line: 2,
      text: "ORDER BY o.scheduled_for_ ASC",
    },
  );
  assert.equal(sourceLineContaining("nothing", "ORDER BY"), null);
});

test("the claims table in the doc and the CLAIMS table in the probe are identical", () => {
  const inProbe = [
    ...probeSource.matchAll(/\{\s*id: "(S[456]-[A-Z]+\d+)"/g),
    ...guardsSource.matchAll(/\{\s*id: "(S[456]-[A-Z]+\d+)"/g),
  ].map((m) => m[1]);
  const inDoc = claimIdsFromMarkdown(docSource);
  assert.ok(inProbe.length > 0 && inDoc.length > 0);
  assert.deepEqual([...inProbe].sort(), [...inDoc].sort());
  assert.equal(new Set(inProbe).size, inProbe.length, "duplicate id in the probe table");
});

test("every claim id the probe records is declared in its table", () => {
  const declared = new Set(
    [
      ...probeSource.matchAll(/\{\s*id: "(S[456]-[A-Z]+\d+)"/g),
      ...guardsSource.matchAll(/\{\s*id: "(S[456]-[A-Z]+\d+)"/g),
    ].map((m) => m[1]),
  );
  const used = new Set(
    [
      ...probeSource.matchAll(/(?:check|refusal)\(\s*"(S[456]-[A-Z]+\d+)"/g),
      ...guardsSource.matchAll(/(?:check|refusal)\(\s*"(S[456]-[A-Z]+\d+)"/g),
    ].map((m) => m[1]),
  );
  assert.ok(used.size > 0);
  for (const id of used) assert.ok(declared.has(id), `${id} is used but not declared`);
  for (const id of declared)
    assert.ok(used.has(id) || probeSource.includes(`"${id}"`), `${id} never used`);
});

test("the probe writes D1 only through the entitlement fixture (no seeded execution authority)", () => {
  const writes = [
    ...probeSource.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+(\w+)/g),
  ].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(writes, ["INSERT INTO entitlement_grants"]);
});

test("the only other D1 mutation is the one injected refresh fault: a trigger on policy_snapshots, always dropped", () => {
  const ddl = [
    ...probeSource.matchAll(
      /\b(CREATE TRIGGER|DROP TRIGGER IF EXISTS|CREATE TABLE|DROP TABLE|ALTER TABLE|CREATE INDEX)\s+(\$\{\w+\}|\w+)/g,
    ),
  ].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(ddl, [
    "CREATE TRIGGER ${REFRESH_FAULT_TRIGGER}",
    "DROP TRIGGER IF EXISTS ${REFRESH_FAULT_TRIGGER}",
  ]);
  assert.match(
    probeSource,
    /CREATE TRIGGER \$\{REFRESH_FAULT_TRIGGER\} BEFORE INSERT ON policy_snapshots BEGIN SELECT RAISE\(ABORT/,
  );
  // The drop sits in a `finally` so a thrown request cannot leave the fault armed for later claims.
  assert.match(probeSource, /finally \{\s*try \{\s*await d1Rows\(`DROP TRIGGER IF EXISTS/);
});

test("a failed fault control BLOCKS S5-T9 instead of failing it, and S5-T6 stall is diagnosed from measured envelopes", () => {
  // The control assertion is only recorded when the fault took effect; otherwise block() is called.
  assert.match(probeSource, /if \(faultTook\) \{\s*check\(\s*"S5-T9",\s*"control:/);
  assert.match(probeSource, /block\(\s*\["S5-T9"\],\s*`the injected refresh fault did not behave/);
  assert.match(probeSource, /FROM queue_job_envelopes WHERE subject_id IN/);
  assert.match(probeSource, /block\(\s*\["S5-T6"\],\s*`occurrences never reached dispatching/);
  // The probe must not seed or move an occurrence itself.
  assert.doesNotMatch(
    probeSource,
    /UPDATE\s+automation_occurrences|INSERT INTO automation_occurrences|queue_job_envelopes SET/,
  );
});

test("the S6 dispatch-guard module writes D1 only as a denial fixture and two hostile job rows, never to an occurrence", () => {
  const writes = [
    ...guardsSource.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+(\w+)/g),
  ].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(writes, ["UPDATE entitlement_grants", "INSERT INTO queue_job_envelopes"]);
  assert.doesNotMatch(guardsSource, /automation_occurrences\s+SET|automation_leases/);
});

test("the probe never retries a request or loops a mutating call", () => {
  assert.doesNotMatch(probeSource, /while\s*\(\s*true\s*\)/);
  // The only loop that polls is the bounded sweep wait; it reads D1 and the sweep, never a mutation.
  const loops = probeSource.match(/for \(let attempt = 0; attempt < \d+/g) ?? [];
  assert.equal(loops.length, 1);
});

test("no secret-bearing literal is written into the probe or the support module", () => {
  const support = readFileSync(join(here, "lib", "phase02-workspace-probe-support.mjs"), "utf8");
  for (const text of [probeSource, support]) {
    assert.doesNotMatch(
      text,
      /sk-[A-Za-z0-9]{16,}|-----BEGIN (RSA |EC |)PRIVATE KEY-----|whsec_|lumi_live_/,
    );
  }
});

test("the log redactor removes lease and device credentials and its gate catches a leak", () => {
  const token = "a".repeat(64);
  const raw = `body={"lease_id":"lse_1","lease_token":"${token}"} Authorization: Bearer ${"b".repeat(40)} DeviceToken ${"c".repeat(40)} {"device_token":"x.y.z"}`;
  assert.ok(leaks(raw).length > 0, "the gate must see the raw text as leaking");
  const clean = redact(raw);
  assert.deepEqual(leaks(clean), []);
  assert.ok(
    !clean.includes(token) && clean.includes("lse_1"),
    "identifiers survive, credentials do not",
  );
});
