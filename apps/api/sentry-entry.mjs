import * as Sentry from "@sentry/cloudflare";

import RustWorker from "./build/index.js";
import { installReportBridge } from "./scripts/sentry-report-filter.mjs";

// `Sentry.withSentry` cannot wrap the Rust-generated WorkerEntrypoint class
// directly: workers-rs builds each entrypoint instance as a `Proxy` whose
// `defineProperty` trap forwards to an inner object, so the SDK's
// non-configurable `__SENTRY_CONTEXT__` definition throws a proxy-invariant
// `TypeError` on every invocation. This entry therefore exposes the plain
// `ExportedHandler` surface (which the SDK supports) and delegates each
// handler to the Rust class. The Rust handlers ignore the execution context,
// so constructing the facade per invocation is stateless. (See ADR 0009.)
//
// The DSN is read from the `SENTRY_DSN` secret at runtime and is never
// hardcoded: an unset DSN disables the SDK and the Worker runs exactly as
// before. PII collection stays off and request/response bodies are never
// captured (F21 FR-F21-002).
function sentryOptions(env) {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT ?? "production",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
  };
}

// A swallowed error never throws, so `withSentry` cannot see it -- and the failures
// worth a page for are disproportionately exactly those. `installReportBridge`
// forwards the console lines the Rust side has marked, and only those.
//
// NOT `captureConsoleIntegration`: the Rust codebase uses `console_error!` for
// routine operational telemetry as well as for faults, so capturing console output
// wholesale would bury the faults under queue-routing and job-outcome lines. The
// decision is made at the call site instead, by the reserved prefix. See
// `scripts/sentry-report-filter.mjs`.
//
// Installed at module scope rather than inside the handlers, so it is in place
// before the first request and covers the scheduled and queue paths too.
installReportBridge(Sentry);

export default Sentry.withSentry(sentryOptions, {
  async fetch(request, env, ctx) {
    return new RustWorker(ctx, env).fetch(request);
  },
  async queue(batch, env) {
    return new RustWorker(undefined, env).queue(batch);
  },
  async scheduled(event, env, ctx) {
    return new RustWorker(ctx, env).scheduled(event);
  },
});
