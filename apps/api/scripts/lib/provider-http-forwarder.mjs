// Test-owned network topology for the Worker's outbound `fetch`.
//
// Used as Miniflare/wrangler `outboundService` (a `(Request) => Response` function). Exactly one
// destination is permitted: the public-looking provider endpoint the catalog stores
// (`https://<host>/v1/<scenario>/v1/chat/completions`). That request is re-dialled, unmodified, to
// the owned loopback fixture. Everything else is DENIED and recorded; there is no pass-through
// to the real network, so no unmatched destination can leave the machine.
//
// This is topology, not a product relaxation: the Worker still sees an `https://` public host, so
// the production allowlist, scheme, userinfo, range and redirect rules all still run unchanged.

const DENY_STATUS = 403;

/**
 * @param {{
 *   permittedHost: string,
 *   targetOrigin: string,
 *   pathPattern?: RegExp,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createOutboundForwarder({
  permittedHost,
  targetOrigin,
  pathPattern = /^\/v1\/[a-z0-9-]+\/v1\/chat\/completions$/,
  fetchImpl = fetch,
}) {
  const host = permittedHost.toLowerCase();
  const target = new URL(targetOrigin);
  const forwarded = [];
  const denials = [];

  const deny = (request, url, reason) => {
    // Origin + path only: a query string could carry a token, and the ledger is evidence.
    denials.push({
      reason,
      method: request.method,
      scheme: url?.protocol ?? "unparseable:",
      host: url?.host ?? "",
      path: url?.pathname ?? "",
    });
    return new Response(JSON.stringify({ error: "fixture_egress_denied", reason }), {
      status: DENY_STATUS,
      headers: { "content-type": "application/json", "x-lumi-fixture-egress": "denied" },
    });
  };

  const handler = async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return deny(request, undefined, "unparseable_url");
    }
    if (url.protocol !== "https:") return deny(request, url, "scheme_not_https");
    if (url.username !== "" || url.password !== "") return deny(request, url, "userinfo");
    if (url.hostname.toLowerCase() !== host) return deny(request, url, "host_not_permitted");
    if (url.port !== "") return deny(request, url, "port_not_default");
    if (request.method !== "POST") return deny(request, url, "method_not_permitted");
    if (url.search !== "" || !pathPattern.test(url.pathname)) {
      return deny(request, url, "path_not_permitted");
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("connection");
    const upstreamUrl = new URL(url.pathname, target);
    const entry = {
      method: request.method,
      path: url.pathname,
      requestAborted: false,
      responseCancelled: false,
    };
    forwarded.push(entry);
    // Two independent cancel paths, both recorded so the probe measures which one the platform
    // actually fires instead of assuming:
    //   * `request.signal`  — the Worker aborted while the call was in flight;
    //   * the response body's `cancel()` — the Worker (or its caller) stopped reading.
    // Either one aborts the upstream socket.
    const upstreamAbort = new AbortController();
    const abortUpstream = (reason) => {
      if (!upstreamAbort.signal.aborted) upstreamAbort.abort(reason);
    };
    request.signal?.addEventListener(
      "abort",
      () => {
        entry.requestAborted = true;
        abortUpstream(request.signal.reason);
      },
      { once: true },
    );
    let upstream;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
        redirect: "manual",
        signal: upstreamAbort.signal,
      });
    } catch (error) {
      // Miniflare answers a throwing handler with an HTTP 500 carrying the stack text, so a
      // socket fault before any response byte cannot be shown to the Worker as a rejected
      // `fetch`. It is made an explicit 502 with a marker instead of leaking a stack trace.
      entry.upstreamTransportError = String(error?.cause?.code ?? error?.name ?? "error");
      return new Response(JSON.stringify({ error: "fixture_upstream_transport_failure" }), {
        status: 502,
        headers: {
          "content-type": "application/json",
          "x-lumi-fixture-egress": "upstream-transport-failure",
        },
      });
    }
    if (upstream.body === null) {
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    }
    const reader = upstream.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        entry.responseCancelled = true;
        abortUpstream(reason);
        return reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  };

  return Object.assign(handler, {
    forwarded: () => forwarded.map((entry) => ({ ...entry })),
    denials: () => denials.map((entry) => ({ ...entry })),
    reset() {
      forwarded.length = 0;
      denials.length = 0;
    },
  });
}
