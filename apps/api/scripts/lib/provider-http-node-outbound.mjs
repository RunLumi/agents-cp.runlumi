// Test-owned Miniflare `outboundService: { node: (req, res, miniflare) => void }` forwarder.
//
// Why it exists: the function form `(Request) => Response` never delivers a Worker-side abort
// (see provider-http-abort-diagnostic.mjs). The node form is served over a real HTTP exchange
// between workerd and Miniflare's loopback server, so `req`/`res` are a live socket pair and a
// Worker abort can surface as a `close` before the response finished.
//
// What the handler can NOT see (measured in provider-http-cancel-topology-probe.mjs): Miniflare sets
// no original-URL header for node services, so the scheme (https vs http) and an explicit port are not
// observable. Host (header) and path are. The deny rules below use only what is observable and the
// ledger records `schemeObservable: false` so no one assumes more.
//
// Permitted: POST, Host == permittedHost, path matches, no query. Everything else is answered 403 and
// never dialled. Allowed requests are re-dialled to the owned loopback fixture only.

import { request as httpRequest } from "node:http";

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);

/**
 * @param {{ permittedHost: string, targetOrigin: string, pathPattern?: RegExp }} options
 */
export function createNodeOutbound({
  permittedHost,
  targetOrigin,
  pathPattern = /^\/v1\/[a-z0-9-]+\/v1\/chat\/completions$/,
}) {
  const host = permittedHost.toLowerCase();
  const target = new URL(targetOrigin);
  const forwarded = [];
  const denials = [];
  const waiters = new Set();
  const notify = () => {
    for (const check of [...waiters]) check();
  };

  const deny = (req, res, reason, path) => {
    denials.push({ reason, method: req.method, host: String(req.headers.host ?? ""), path });
    // Drain the request body first: answering while the peer is still sending resets the connection.
    const respond = () => {
      res.writeHead(403, { "content-type": "application/json", "x-lumi-fixture-egress": "denied" });
      res.end(JSON.stringify({ error: "fixture_egress_denied", reason }));
    };
    if (req.complete) respond();
    else req.once("end", respond);
    req.resume();
  };

  const handler = (req, res) => {
    const [path, query = ""] = (req.url ?? "/").split("?");
    const reqHost = String(req.headers.host ?? "").toLowerCase();
    if (reqHost !== host) return deny(req, res, "host_not_permitted", path);
    if (req.method !== "POST") return deny(req, res, "method_not_permitted", path);
    if (query !== "" || !pathPattern.test(path)) return deny(req, res, "path_not_permitted", path);

    const entry = {
      method: req.method,
      path,
      schemeObservable: false,
      // Signals from the downstream (workerd-facing) side.
      reqAborted: false,
      reqSocketClosed: false,
      resClosedBeforeFinish: false,
      resFinished: false,
      // What this handler did about it.
      upstreamStatus: null,
      upstreamDestroyedBy: null,
      upstreamError: null,
    };
    forwarded.push(entry);

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name)) headers[name] = value;
    }
    const upstream = httpRequest(
      { host: target.hostname, port: target.port, method: req.method, path, headers },
      (upstreamRes) => {
        entry.upstreamStatus = upstreamRes.statusCode ?? null;
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        res.flushHeaders();
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );
    const abortUpstream = (cause) => {
      if (entry.upstreamDestroyedBy === null && !upstream.destroyed) {
        entry.upstreamDestroyedBy = cause;
        upstream.destroy();
      }
      notify();
    };
    upstream.on("error", (error) => {
      entry.upstreamError = String(error?.code ?? error?.name ?? "error");
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", "x-lumi-fixture-egress": "upstream-transport-failure" });
        res.end(JSON.stringify({ error: "fixture_upstream_transport_failure" }));
      } else {
        res.destroy();
      }
      notify();
    });

    req.on("aborted", () => {
      entry.reqAborted = true;
      abortUpstream("req-aborted");
    });
    req.socket.on("close", () => {
      entry.reqSocketClosed = true;
      if (!res.writableFinished) abortUpstream("socket-closed");
      notify();
    });
    res.on("close", () => {
      entry.resFinished = res.writableFinished;
      if (!res.writableFinished) {
        entry.resClosedBeforeFinish = true;
        abortUpstream("response-closed");
      }
      notify();
    });
    req.pipe(upstream);
  };

  return Object.assign(handler, {
    forwarded: () => forwarded.map((entry) => ({ ...entry })),
    denials: () => denials.map((entry) => ({ ...entry })),
    reset() {
      forwarded.length = 0;
      denials.length = 0;
    },
    /** Deterministic wait on this ledger (resolves on every state change, bounded). */
    waitFor(predicate, timeoutMs = 5_000) {
      return new Promise((resolve) => {
        const done = (value) => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(value);
        };
        const check = () => predicate(forwarded) && done(true);
        const timer = setTimeout(() => done(false), timeoutMs);
        waiters.add(check);
        check();
      });
    },
  });
}
