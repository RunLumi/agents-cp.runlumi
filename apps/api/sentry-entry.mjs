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
  // V04-002 -- the queue path could not construct the Worker at all.
  //
  // `WorkerEntrypoint` is imported from `cloudflare:workers`, and workerd's constructor requires
  // parameter 1 to be an Object. This handler passed a literal `undefined`, so the very first real
  // queue message threw:
  //
  //     TypeError: Failed to construct 'WorkerEntrypoint': constructor parameter 1 is not of type
  //     'Object'.                                    (uncaught; kills the isolate)
  //
  // The `fetch` and `scheduled` handlers below both pass `ctx`, which is why only the queue path
  // failed. Cloudflare's ExportedHandler passes an ExecutionContext as the THIRD argument of `queue`,
  // so the fix is to accept it and forward it like the other two.
  //
  // WHY THIS SURVIVED SO LONG, and why the recorded explanation was wrong: `smoke:p06` is the only
  // probe that publishes a job and waits for the queue to deliver it, and its R2 leg had been
  // recorded as BLOCKED with the reason "the local queue does not deliver a published body". That is
  // a misattribution -- the queue never had a chance to mis-deliver, because the Worker could not
  // start to read the message. Every other async gate either replays over HTTP or asserts on the
  // outbox row, so no gate exercised a real delivery. A passing suite said nothing about this.
  async queue(batch, env, ctx) {
    return new RustWorker(ctx, env).queue(batch);
  },
  async scheduled(event, env, ctx) {
    return new RustWorker(ctx, env).scheduled(event);
  },
});
