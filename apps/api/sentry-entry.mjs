import * as Sentry from "@sentry/cloudflare";

import RustWorker from "./build/index.js";

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
