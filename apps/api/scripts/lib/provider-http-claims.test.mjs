// Node-only tests for the claim ledger. No sockets, no workerd: runnable in a restricted sandbox.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  classifyCancelSettlement,
  classifySettleCause,
  classifyStreamCut,
  classifyUpstreamClosure,
  createClaimLedger,
} from "./provider-http-claims.mjs";

const ledgerWith = (...claims) => {
  const ledger = createClaimLedger();
  for (const [id, opts] of claims) ledger.declare(id, `title ${id}`, opts);
  return ledger;
};

describe("claim ledger verdicts", () => {
  test("a declared claim with no evidence is UNPROVEN, and a critical one makes the run non-PASS", () => {
    const ledger = ledgerWith(["a"]);
    assert.equal(ledger.verdictOf("a"), "UNPROVEN");
    const result = ledger.conclude();
    assert.equal(result.overall, "UNPROVEN");
    assert.equal(result.exitCode, EXIT.NOT_PROVEN);
    assert.match(ledger.format(result), /the case never ran/);
  });

  test("positive control: all-PASS claims exit 0", () => {
    const ledger = ledgerWith(["a"], ["b"]);
    ledger.record("a", "PASS", "x");
    ledger.record("b", "PASS", "y");
    assert.deepEqual([ledger.conclude().overall, ledger.conclude().exitCode], ["PASS", 0]);
  });

  test("the held-reservation observation stays UNPROVEN and cannot be turned into PASS by other passes", () => {
    const ledger = ledgerWith(["cancel-settles"], ["other"]);
    ledger.record("cancel-settles", "PASS", "partial assertion");
    ledger.record("cancel-settles", "UNPROVEN", "state=stream_committed held=1 after 20000ms");
    ledger.record("other", "PASS", "ok");
    assert.equal(ledger.verdictOf("cancel-settles"), "UNPROVEN");
    const result = ledger.conclude();
    assert.equal(result.exitCode, EXIT.NOT_PROVEN);
    assert.deepEqual(
      result.unproven.map((r) => r.id),
      ["cancel-settles"],
    );
  });

  test("FAIL outranks UNPROVEN and BLOCKED and exits 1", () => {
    const ledger = ledgerWith(["a"], ["b"], ["c"]);
    ledger.record("a", "FAIL", "bad");
    ledger.record("b", "UNPROVEN", "?");
    ledger.record("c", "BLOCKED", "?");
    assert.equal(ledger.conclude().exitCode, EXIT.FAIL);
  });

  test("BLOCKED is reported as BLOCKED, not folded into FAIL, and exits non-zero", () => {
    const ledger = ledgerWith(["a"]);
    ledger.record("a", "BLOCKED", "control never reached the fixture");
    const result = ledger.conclude();
    assert.equal(result.overall, "BLOCKED");
    assert.equal(result.exitCode, EXIT.NOT_PROVEN);
  });

  test("assertion failures outside any claim still fail the run", () => {
    const ledger = ledgerWith(["a"]);
    ledger.record("a", "PASS");
    assert.equal(ledger.conclude({ failuresElsewhere: 1 }).exitCode, EXIT.FAIL);
  });

  test("a non-critical UNPROVEN claim is reported but does not break the exit code", () => {
    const ledger = ledgerWith(["a"], ["adv", { critical: false }]);
    ledger.record("a", "PASS");
    assert.equal(ledger.verdictOf("adv"), "UNPROVEN");
    assert.equal(ledger.conclude().exitCode, EXIT.PASS);
  });

  test("NOT_APPLICABLE is refused for critical claims and needs a reason otherwise", () => {
    const ledger = ledgerWith(["crit"], ["adv", { critical: false }]);
    assert.throws(
      () => ledger.record("crit", "NOT_APPLICABLE", "because"),
      /cannot be NOT_APPLICABLE/,
    );
    assert.throws(() => ledger.record("adv", "NOT_APPLICABLE", "  "), /needs a reason/);
    ledger.record("adv", "NOT_APPLICABLE", "no such surface");
    assert.equal(ledger.verdictOf("adv"), "NOT_APPLICABLE");
  });

  test("unknown claims, bad verdicts and double declarations are programming errors", () => {
    const ledger = ledgerWith(["a"]);
    assert.throws(() => ledger.record("nope", "PASS"), /unknown claim/);
    assert.throws(() => ledger.record("a", "SKIPPED"), /invalid verdict/);
    assert.throws(() => ledger.declare("a", "again"), /declared twice/);
  });
});

describe("cancel settlement classification", () => {
  test("prompt settlement is PASS", () => {
    assert.equal(
      classifyCancelSettlement({ settledWithinMs: 1500, boundMs: 20_000, windowMs: 150_000 })
        .verdict,
      "PASS",
    );
  });
  test("late reclaim is not a PASS and keeps the held-reservation evidence", () => {
    const out = classifyCancelSettlement({
      settledWithinMs: 70_000,
      boundMs: 20_000,
      windowMs: 150_000,
    });
    assert.equal(out.verdict, "UNPROVEN");
    assert.match(out.note, /held reservation beyond the 20000ms bound/);
  });
  test("never settling inside the window is UNPROVEN, not a product diagnosis", () => {
    const out = classifyCancelSettlement({
      settledWithinMs: null,
      boundMs: 20_000,
      windowMs: 150_000,
    });
    assert.equal(out.verdict, "UNPROVEN");
    assert.match(out.note, /product cause not diagnosed/);
  });
});

describe("post-output cut precondition", () => {
  const frame = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
  test("a 2xx SSE response with a data frame establishes the cut", () => {
    assert.equal(
      classifyStreamCut({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        firstChunk: frame,
      }).established,
      true,
    );
  });
  test("a 503 JSON error cannot prove post-output cancel", () => {
    const out = classifyStreamCut({
      status: 503,
      contentType: "application/json",
      firstChunk: '{"error":{"code":"provider_unavailable"}}',
    });
    assert.equal(out.established, false);
    assert.match(out.reason, /pre-output failure/);
  });
  test("a 200 JSON body, or an SSE response with no data frame, is not established", () => {
    assert.equal(
      classifyStreamCut({ status: 200, contentType: "application/json", firstChunk: frame })
        .established,
      false,
    );
    assert.equal(
      classifyStreamCut({
        status: 200,
        contentType: "text/event-stream",
        firstChunk: ": keepalive\n\n",
      }).established,
      false,
    );
    assert.equal(
      classifyStreamCut({ status: undefined, contentType: null, firstChunk: "" }).established,
      false,
    );
  });
});

describe("provider-http-adapter-probe.mjs wiring (source guard)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../provider-http-adapter-probe.mjs", import.meta.url)),
    "utf8",
  );
  test("the mock control uses the mock adapter, and cancel claims gate on the cut precondition", () => {
    assert.match(source, /adapter: mockClaim \? "mock" : "openai_compatible"/);
    assert.equal((source.match(/precondition\.established/g) ?? []).length >= 2, true);
    assert.match(source, /cutNotEstablished\("cancel-settles"/);
    assert.match(source, /cutNotEstablished\("cancel-mock-control"/);
  });
  test("no skip() downgrade remains: every limitation goes through the claim ledger", () => {
    assert.equal(/\bprobe\.skip\(/.test(source), false);
  });
  test("exit code comes from the ledger conclusion, not from probe.failures alone", () => {
    assert.match(source, /ledger\.conclude\(/);
    assert.equal(/probe\.finish\(\s*probe\.failures\.length/.test(source), false);
  });
  test("every claim id the probe records against is declared (an undeclared id would abort the run mid-way)", () => {
    const declared = new Set([...source.matchAll(/^\s*\["([a-z0-9-]+)", "/gm)].map((m) => m[1]));
    declared.add("cancel-mock-control");
    const used = new Set([
      ...[...source.matchAll(/\b(?:check|note|terminal)\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
      ...[...source.matchAll(/(?:claims: \[|mockClaim: )([^\]\n}]*)/g)].flatMap((m) =>
        [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]),
      ),
      "status-429",
      "status-503",
      "timeout-stall-before-headers",
      "timeout-stall-after-headers",
    ]);
    assert.ok(used.size > 15, "the extraction must find the claims it is guarding");
    for (const id of used) assert.ok(declared.has(id), `claim ${id} is used but not declared`);
  });
  test("the redirect shim cannot yield an overall PASS for the unmodified adapter", () => {
    assert.match(source, /unmodified-adapter-request/);
  });
});

describe("classifyUpstreamClosure (node-outbound ledgers)", () => {
  const closed = { outcome: "client-closed", framesWritten: 12 };
  const attributed = { upstreamDestroyedBy: "response-closed", resClosedBeforeFinish: true };
  test("PASS needs the provider to see the close AND the handler to attribute it to a downstream close", () => {
    assert.equal(
      classifyUpstreamClosure({
        fixtureRecord: closed,
        ledgerEntry: attributed,
        completeFrames: 60,
      }).verdict,
      "PASS",
    );
  });
  test("a provider close the handler does not attribute is not PASS", () => {
    const r = classifyUpstreamClosure({
      fixtureRecord: closed,
      ledgerEntry: { upstreamDestroyedBy: null, resClosedBeforeFinish: false },
    });
    assert.equal(r.verdict, "UNPROVEN");
  });
  test("a socket still open, a finished stream, or a fixture-initiated destroy are observations, not PASS", () => {
    for (const fixtureRecord of [
      { outcome: "pending", framesWritten: 3 },
      { outcome: "completed", framesWritten: 60 },
      { outcome: "server-destroyed", framesWritten: 1 },
      { outcome: "client-closed", framesWritten: 60 },
    ]) {
      const r = classifyUpstreamClosure({
        fixtureRecord,
        ledgerEntry: attributed,
        completeFrames: 60,
      });
      assert.equal(r.verdict, "UNPROVEN", fixtureRecord.outcome);
      assert.match(r.note, /OBSERVED/);
    }
  });
  test("missing ledgers are UNPROVEN, never PASS", () => {
    assert.equal(
      classifyUpstreamClosure({ fixtureRecord: undefined, ledgerEntry: attributed }).verdict,
      "UNPROVEN",
    );
    assert.equal(
      classifyUpstreamClosure({ fixtureRecord: closed, ledgerEntry: undefined }).verdict,
      "UNPROVEN",
    );
  });
});

describe("classifySettleCause", () => {
  test("a timeout error code is the timeout path, not a cancel", () => {
    assert.equal(
      classifySettleCause({
        errorCode: "request_timeout",
        settledWithinMs: 3_000,
        routeTimeoutMs: 20_000,
      }),
      "timeout",
    );
  });
  test("settling at the route timeout without a conclusive code is ambiguous", () => {
    assert.equal(
      classifySettleCause({ errorCode: null, settledWithinMs: 20_400, routeTimeoutMs: 20_000 }),
      "ambiguous",
    );
  });
  test("a prompt settle with a non-timeout code is attributable to the cancel path", () => {
    assert.equal(
      classifySettleCause({
        errorCode: "client_disconnected",
        settledWithinMs: 1_200,
        routeTimeoutMs: 20_000,
      }),
      "not-timeout",
    );
  });
});
