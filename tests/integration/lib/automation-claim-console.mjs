// Per-occurrence claim outcomes read from the development Worker's own console capture. The Worker logs one
// structured `http_request` line per request (request/correlation ids, templated route, status) and the
// wrangler proxy logs one line carrying the concrete occurrence id. Neither names the device, so this proves
// that a SECOND claim request reached the Worker for the occurrence and was refused; it does not identify the
// refused device (D1 identifies the lease holder).
const PROXY = /POST \/api\/v1\/devices\/automation-occurrences\/(occ_[0-9a-f]+)\/claim (\d{3})\b/;
const ROUTE = "/api/v1/devices/automation-occurrences/{occurrence_id}/claim";

/** Ordered claim statuses for one occurrence, with correlation ids when the structured lines pair up 1:1. */
export function claimOutcomes(consoleText, occurrenceId) {
  const proxy = [];
  const structured = [];
  for (const line of String(consoleText).split("\n")) {
    const match = PROXY.exec(line);
    if (match) {
      proxy.push({ occurrenceId: match[1], status: Number(match[2]) });
      continue;
    }
    if (!line.startsWith('{"event":"http_request"') || !line.includes(ROUTE)) continue;
    try {
      const row = JSON.parse(line);
      structured.push({ status: row.status, correlationId: row.correlation_id });
    } catch {
      /* a truncated tail line is simply not evidence */
    }
  }
  // Pair only when every claim in the capture has both lines and the statuses agree position by position.
  const paired =
    proxy.length === structured.length &&
    proxy.every((row, i) => row.status === structured[i].status);
  return proxy
    .map((row, i) => ({ ...row, correlationId: paired ? structured[i].correlationId : undefined }))
    .filter((row) => row.occurrenceId === occurrenceId);
}

/** accepted: HTTP 201 claims; refused: HTTP 409 claims (occurrence_already_claimed class). */
export function summarizeClaims(outcomes) {
  return {
    accepted: outcomes.filter((row) => row.status === 201).length,
    refused: outcomes.filter((row) => row.status === 409).length,
    other: outcomes.filter((row) => ![201, 409].includes(row.status)).map((row) => row.status),
    correlationIds: outcomes.map((row) => row.correlationId).filter(Boolean),
  };
}

/**
 * The console capture is flushed lazily, so a read right after settlement can miss lines that exist (retained:
 * native-full-lane3-run8.log round 1 vs its full capture). Wait for the accepted claim, then briefly for a
 * refusal; whatever is present when the budgets run out is returned and judged by the caller.
 */
export async function awaitClaims(
  readConsole,
  occurrenceId,
  { acceptedMs = 20_000, refusedMs = 6_000, everyMs = 1_000 } = {},
) {
  const summary = () => summarizeClaims(claimOutcomes(readConsole(), occurrenceId));
  const waitFor = async (budgetMs, done) => {
    const deadline = Date.now() + budgetMs;
    let current = summary();
    while (!done(current) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      current = summary();
    }
    return current;
  };
  await waitFor(acceptedMs, (claims) => claims.accepted >= 1);
  return waitFor(refusedMs, (claims) => claims.accepted >= 1 && claims.refused >= 1);
}
