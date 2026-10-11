// A transparent loopback reverse proxy between the desktop apps and the development Worker. It exists to read
// what the Worker answers a LOSING claim at the real transport boundary (the desktop does not expose the body).
// It forwards every request unchanged (Host included, streamed both ways, so SSE inference still works) and
// records ONLY the occurrence-claim route: method, status, and a size-bounded response body. Request bodies,
// authorization headers and every other route are never recorded. It is test-owned: no product code is touched.
import { createServer, request as httpRequest } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const CLAIM = /^\/api\/v1\/devices\/automation-occurrences\/(occ_[0-9a-f]+)\/claim(?:\?|$)/;
const BODY_LIMIT = 4_096;
const DECODE_LIMIT = 64 * 1_024; // a decompression bomb is refused, never expanded

/** Response bytes -> text, undoing the content-encoding the Worker applied (never throws; marks what it could not decode). */
export function decodeBody(chunks, encoding) {
  const raw = Buffer.concat(chunks);
  const bound = { maxOutputLength: DECODE_LIMIT };
  try {
    if (encoding === "gzip") return gunzipSync(raw, bound).toString("utf8");
    if (encoding === "br") return brotliDecompressSync(raw, bound).toString("utf8");
    if (encoding === "deflate") return inflateSync(raw, bound).toString("utf8");
  } catch {
    return `<undecodable ${encoding} body, ${raw.length} bytes>`;
  }
  return raw.toString("utf8");
}

/** A body over the bound is kept truncated AND flagged: it can never validate as a clean refusal. */
const bounded = (text) => ({
  body: text.slice(0, BODY_LIMIT),
  truncated: text.length > BODY_LIMIT,
});

// Route shape only: identifiers and the query string are dropped (".../runs/run_ab12.../start?x=1" -> ".../runs/run_<star>/start").
export const routeShape = (url) =>
  String(url)
    .split("?")[0]
    .replace(/\b([a-z]{2,4})_[0-9a-f]{8,}\b/g, "$1_*");

/**
 * `claimBarrierMs`: hold the FIRST claim of an occurrence until a second claim for it arrives (or the budget runs
 * out), then forward both together. Both devices then read the occurrence as claimable and race to the Worker's
 * guarded write, which is the concurrent-loser path; without it the second claim usually arrives after the winner
 * committed and takes the late invalid-state path. Only timing changes: bodies and headers are forwarded untouched.
 */
export async function startClaimRecordingProxy({
  target,
  redact = (text) => text,
  claimBarrierMs: initialBarrierMs = 0,
}) {
  let claimBarrierMs = initialBarrierMs;
  const upstream = new URL(target);
  const claims = [];
  const requests = []; // method, route shape, status, duration only: no headers, no bodies, no identifiers
  const drops = []; // one-shot fault injections: { pattern, dropped }
  const waiting = new Map(); // occurrence id -> release functions of held claims
  const server = createServer((req, res) => {
    const claim = req.method === "POST" ? CLAIM.exec(req.url ?? "") : null;
    const startedAt = Date.now();
    const held = claim && claimBarrierMs > 0;
    // One-shot fault: forward the request so the Worker COMMITS it, then discard the response and cut the socket.
    const drop =
      req.method === "POST"
        ? drops.find((item) => !item.dropped && item.pattern.test(req.url ?? ""))
        : undefined;
    if (drop) drop.dropped = true;
    const forward = httpRequest(
      // agent:false = a fresh upstream connection per request, so a pooled socket the Worker already closed can never
      // surface as a transport error on (say) a lease renewal and be mistaken for a product fault.
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
        agent: false,
      },
      (answer) => {
        if (drop) {
          answer.resume();
          answer.on("end", () => {
            drop.result = {
              status: answer.statusCode,
              route: routeShape(req.url),
              at: new Date().toISOString(),
            };
            requests.push({
              at: new Date(startedAt).toISOString(),
              method: req.method,
              route: routeShape(req.url),
              status: `dropped_after_${answer.statusCode}`,
              ms: Date.now() - startedAt,
            });
            req.socket.destroy();
          });
          return;
        }
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        const captured = [];
        let size = 0;
        answer.on("data", (chunk) => {
          res.write(chunk);
          if (claim && size < 64 * BODY_LIMIT) {
            captured.push(chunk);
            size += chunk.length;
          }
        });
        answer.on("end", () => {
          res.end();
          requests.push({
            at: new Date(startedAt).toISOString(),
            method: req.method,
            route: routeShape(req.url),
            status: answer.statusCode,
            ms: Date.now() - startedAt,
          });
          if (claim)
            claims.push({
              occurrenceId: claim[1],
              status: answer.statusCode,
              requestId: answer.headers["x-request-id"] ?? answer.headers["x-lumi-request-id"],
              ...bounded(redact(decodeBody(captured, answer.headers["content-encoding"]))),
            });
        });
      },
    );
    forward.on("error", (error) => {
      requests.push({
        at: new Date(startedAt).toISOString(),
        method: req.method,
        route: routeShape(req.url),
        status: "transport_error",
        code: error?.code,
        ms: Date.now() - startedAt,
      });
      res.destroy();
    });
    if (!held) {
      req.pipe(forward);
      return;
    }
    const body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      const release = () => forward.end(Buffer.concat(body));
      const group = waiting.get(claim[1]) ?? [];
      group.push(release);
      if (group.length >= 2) {
        waiting.delete(claim[1]);
        for (const send of group) send();
        return;
      }
      waiting.set(claim[1], group);
      setTimeout(() => {
        if (waiting.get(claim[1]) !== group) return;
        waiting.delete(claim[1]);
        for (const send of group) send();
      }, claimBarrierMs).unref();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    /** Arm a one-shot drop of the NEXT response whose POST path matches; `result` is set once the Worker answered. */
    dropNextResponse: (pattern) => {
      const item = { pattern, dropped: false, result: undefined };
      drops.push(item);
      return item;
    },
    setClaimBarrier: (ms) => {
      claimBarrierMs = ms;
    },
    requestLog: () => requests.slice(),
    claimsFor: (occurrenceId) => claims.filter((row) => row.occurrenceId === occurrenceId),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** The refusal's stable reason: `error.details.reason` when present, else `error.code`. Undefined for a non-envelope. */
export function refusalReason(row) {
  try {
    const error = JSON.parse(row.body)?.error;
    return error?.details?.reason ?? error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Non-disclosure of a refused claim. The body must be the stable error envelope and must not carry the winner's
 * device, run or workspace identifiers, the lease token or its fingerprint, or any fence/token field. The winner's
 * LEASE ID is returned deliberately by the route (`existing_lease_id`, an identifier, never the credential) and is
 * therefore reported by `disclosesLeaseId`, not treated as a leak.
 */
export function assertRefusalDisclosesNothing(row, { forbidden }) {
  const problems = [];
  const snippet = JSON.stringify(String(row.body).slice(0, 400));
  if (row.truncated)
    problems.push("refusal body exceeds the validated bound, so it cannot be certified");
  let parsed;
  try {
    parsed = JSON.parse(row.body);
  } catch {
    problems.push(`refusal body is not JSON: ${snippet}`);
  }
  if (parsed && typeof parsed.error?.code !== "string")
    problems.push(`refusal is not an error envelope: ${snippet}`);
  for (const needle of forbidden.filter(Boolean))
    if (row.body.includes(needle)) problems.push(`body contains ${String(needle).slice(0, 8)}…`);
  for (const pattern of [
    /\brun_[0-9a-f]{8}/i,
    /wsb_[0-9a-f]{8}/i,
    /dvc_[0-9a-f]{8}/i,
    /fence/i,
    /lease_token/i,
    /"token"/i,
  ])
    if (pattern.test(row.body)) problems.push(`body matches ${pattern}`);
  return problems;
}

export const disclosesLeaseId = (row) => /existing_lease_id/.test(row.body);
