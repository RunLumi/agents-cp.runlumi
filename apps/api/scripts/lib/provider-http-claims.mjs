// Per-claim verdict ledger for the provider HTTP adapter probe.
//
// Why this exists: the shared SmokeHarness only distinguishes pass / fail / "skipped", and
// `runProbe`-style exit logic returns 0 whenever nothing FAILED. A critical claim that was
// observed but never proven (for example "a client disconnect leaves no reservation held") was
// recorded with `skip()` and the command still exited 0. This ledger makes the claim the unit of
// reporting, uses the repository's verdict vocabulary, and derives the exit code from it.
//
// Rules (docs/verification/README.md, AGENTS.md "Runtime proofs"):
//   * a declared claim with no evidence is UNPROVEN, never PASS;
//   * PASS needs at least one PASS record and no FAIL/UNPROVEN/BLOCKED record for that claim;
//   * an observation that is not a verdict stays UNPROVEN; it is never promoted to PASS and is
//     never relabelled NOT_APPLICABLE;
//   * NOT_APPLICABLE is refused for critical claims;
//   * any FAIL is overall FAIL (exit 1); otherwise a critical BLOCKED/UNPROVEN claim makes the
//     overall verdict non-PASS (exit 2: the run did not establish the claim, which is a statement
//     about the evidence, not about the product).

export const VERDICTS = Object.freeze(["PASS", "FAIL", "UNPROVEN", "BLOCKED", "NOT_APPLICABLE"]);
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, NOT_PROVEN: 2 });

// Severity order when one claim has several records: the worst record decides.
const SEVERITY = { FAIL: 4, BLOCKED: 3, UNPROVEN: 2, NOT_APPLICABLE: 1, PASS: 0 };

export function createClaimLedger() {
  /** @type {Map<string, {id: string, title: string, critical: boolean, records: Array<{verdict: string, evidence: string}>}>} */
  const claims = new Map();

  const declare = (id, title, { critical = true } = {}) => {
    if (claims.has(id)) throw new Error(`claim ${id} declared twice`);
    claims.set(id, { id, title, critical, records: [] });
  };

  const record = (id, verdict, evidence = "") => {
    const claim = claims.get(id);
    if (!claim) throw new Error(`unknown claim ${id}`);
    if (!VERDICTS.includes(verdict)) throw new Error(`invalid verdict ${verdict} for ${id}`);
    if (verdict === "NOT_APPLICABLE") {
      if (claim.critical) throw new Error(`critical claim ${id} cannot be NOT_APPLICABLE`);
      if (!String(evidence).trim()) throw new Error(`NOT_APPLICABLE for ${id} needs a reason`);
    }
    claim.records.push({ verdict, evidence: String(evidence) });
  };

  const verdictOf = (id) => {
    const claim = claims.get(id);
    if (!claim) throw new Error(`unknown claim ${id}`);
    if (claim.records.length === 0) return "UNPROVEN"; // never ran: absent evidence is not a pass
    const worst = claim.records.reduce((a, b) =>
      SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a,
    );
    if (worst.verdict === "PASS") return "PASS";
    if (worst.verdict === "NOT_APPLICABLE") {
      return claim.records.some((r) => r.verdict === "PASS") ? "PASS" : "NOT_APPLICABLE";
    }
    return worst.verdict;
  };

  const rows = () =>
    [...claims.values()].map((claim) => ({
      id: claim.id,
      title: claim.title,
      critical: claim.critical,
      verdict: verdictOf(claim.id),
      evidence:
        claim.records.length === 0
          ? ["no evidence recorded; the case never ran"]
          : claim.records.map((r) => `${r.verdict}: ${r.evidence}`),
    }));

  /** Overall verdict + exit code. `failuresElsewhere` = assertions failed outside any claim. */
  const conclude = ({ failuresElsewhere = 0 } = {}) => {
    const all = rows();
    const failed = all.filter((r) => r.verdict === "FAIL");
    const blocked = all.filter((r) => r.critical && r.verdict === "BLOCKED");
    const unproven = all.filter((r) => r.critical && r.verdict === "UNPROVEN");
    let overall = "PASS";
    let exitCode = EXIT.PASS;
    if (failed.length > 0 || failuresElsewhere > 0) {
      overall = "FAIL";
      exitCode = EXIT.FAIL;
    } else if (blocked.length > 0) {
      overall = "BLOCKED";
      exitCode = EXIT.NOT_PROVEN;
    } else if (unproven.length > 0) {
      overall = "UNPROVEN";
      exitCode = EXIT.NOT_PROVEN;
    }
    return { overall, exitCode, rows: all, failed, blocked, unproven };
  };

  const format = (conclusion = conclude()) => {
    const lines = ["", "per-claim verdicts:"];
    for (const row of conclusion.rows) {
      lines.push(
        `  ${row.verdict.padEnd(14)} ${row.critical ? "[critical]" : "[advisory]"} ${row.id} — ${row.title}`,
      );
      if (row.verdict !== "PASS") for (const line of row.evidence) lines.push(`      ${line}`);
    }
    lines.push(`overall: ${conclusion.overall} (exit ${conclusion.exitCode})`);
    return lines.join("\n");
  };

  return { declare, record, verdictOf, rows, conclude, format };
}

/**
 * Decide whether a mid-stream disconnect really happened AFTER output began.
 *
 * A cancel claim is only evidence when the cut landed on a 2xx `text/event-stream` response whose
 * first read carried an SSE `data:` frame. A 503 JSON error that is then "cut" is a pre-output
 * failure that settles terminal on its own; it says nothing about post-output cancellation.
 * `established: false` callers must record BLOCKED/UNPROVEN for the cancel claim and keep the
 * pre-output observation separately.
 */
export function classifyStreamCut({ status, contentType, firstChunk }) {
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    return {
      established: false,
      reason: `response was HTTP ${status ?? "none"}, not a 2xx stream: this is a pre-output failure, not a post-output disconnect`,
    };
  }
  if (!/^text\/event-stream\b/i.test(contentType ?? "")) {
    return {
      established: false,
      reason: `content-type ${contentType ?? "none"} is not text/event-stream`,
    };
  }
  if (!/(^|\n)data:/.test(firstChunk ?? "")) {
    return { established: false, reason: "no SSE data frame was observed before the disconnect" };
  }
  return {
    established: true,
    reason: "2xx SSE response with an observed data frame before the cut",
  };
}

/**
 * Classify provider-socket closure from the two ledgers the `--outbound=node` topology provides:
 * the fixture record (what the provider socket saw) and the node-forwarder entry (why the
 * handler destroyed its upstream). PASS needs BOTH: the provider saw its client close before it
 * finished AND the handler attributes that to a downstream close. One without the other is an
 * observation, never a PASS (a provider that finished on its own, or a fixture-initiated destroy,
 * is not closure by the Worker). `completeFrames` is the frame count of a finished stream; a stream
 * that wrote all of them was not cut.
 */
export function classifyUpstreamClosure({ fixtureRecord, ledgerEntry, completeFrames }) {
  if (!fixtureRecord) return { verdict: "UNPROVEN", note: "no fixture record for this request" };
  if (!ledgerEntry)
    return { verdict: "UNPROVEN", note: "no forwarder ledger entry for this request" };
  const seen = `fixture outcome=${fixtureRecord.outcome} frames=${fixtureRecord.framesWritten}; forwarder upstreamDestroyedBy=${ledgerEntry.upstreamDestroyedBy ?? "none"} resClosedBeforeFinish=${ledgerEntry.resClosedBeforeFinish}`;
  if (fixtureRecord.outcome === "pending") {
    return {
      verdict: "UNPROVEN",
      note: `OBSERVED provider socket still open at the observation bound; ${seen}`,
    };
  }
  if (fixtureRecord.outcome !== "client-closed") {
    return {
      verdict: "UNPROVEN",
      note: `OBSERVED provider socket ended without a client close (${fixtureRecord.outcome}); ${seen}`,
    };
  }
  if (Number.isInteger(completeFrames) && fixtureRecord.framesWritten >= completeFrames) {
    return {
      verdict: "UNPROVEN",
      note: `OBSERVED the stream had already written every frame before the close; ${seen}`,
    };
  }
  if (ledgerEntry.upstreamDestroyedBy === null || ledgerEntry.resClosedBeforeFinish !== true) {
    return {
      verdict: "UNPROVEN",
      note: `the provider saw a close the handler does not attribute to a downstream close; ${seen}`,
    };
  }
  return { verdict: "PASS", note: seen };
}

/**
 * Was a settlement caused by the route timeout rather than by a cancel? A cancel claim is only
 * evidence when the settle was not the timeout path: `timeout` (error code names a timeout) and
 * `ambiguous` (settled within `slackMs` of the route timeout, error code not conclusive) both keep
 * the claim UNPROVEN and record the error code and timing instead.
 */
export function classifySettleCause({
  errorCode,
  settledWithinMs,
  routeTimeoutMs,
  slackMs = 1_500,
}) {
  if (/timeout/i.test(errorCode ?? "")) return "timeout";
  if (
    Number.isFinite(settledWithinMs) &&
    Number.isFinite(routeTimeoutMs) &&
    Math.abs(settledWithinMs - routeTimeoutMs) <= slackMs
  ) {
    return "ambiguous";
  }
  return "not-timeout";
}

/**
 * Classify a cancel-settlement observation without inventing a verdict the evidence cannot carry.
 *
 * `settledWithinMs` is when the request reached a terminal state with no reservation held, or null
 * if it never did inside the observation window. A late settlement (after `boundMs`) is NOT a pass
 * of the "settles promptly" claim: the original held-reservation observation is preserved.
 */
export function classifyCancelSettlement({ settledWithinMs, boundMs, windowMs }) {
  if (settledWithinMs !== null && settledWithinMs <= boundMs) {
    return { verdict: "PASS", note: `settled in ${settledWithinMs}ms (bound ${boundMs}ms)` };
  }
  if (settledWithinMs !== null) {
    return {
      verdict: "UNPROVEN",
      note: `OBSERVED held reservation beyond the ${boundMs}ms bound; reclaimed only at ${settledWithinMs}ms (product cause not diagnosed)`,
    };
  }
  return {
    verdict: "UNPROVEN",
    note: `OBSERVED request still unsettled with reservation held after ${windowMs}ms (product cause not diagnosed)`,
  };
}
