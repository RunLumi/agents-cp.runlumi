# ADR 0009: Sentry error reporting via the Cloudflare JS SDK

- Status: Accepted
- Date: 2026-09-28

## Context

The API is a Rust Worker compiled to `wasm32-unknown-unknown` (ADR 0002).
Sentry's setup snippet for Rust (`sentry = "0.49.3"` + `sentry::init` with a
hardcoded DSN) assumes a long-lived server: a background thread with a
`reqwest`/`native-tls` transport, Tokio, and a process exit to flush on.
None of those exist in the Workers runtime, and the default transport does
not compile for the WASM target. Calling `sentry::init` per request in
`fetch` would also leak a client per isolate invocation with no flush hook.

## Decision

Report Worker errors with `@sentry/cloudflare` (pinned exact in
`apps/api/package.json`), which is the Sentry-supported path for Workers:

- `apps/api/sentry-entry.mjs` exposes the plain `ExportedHandler` surface
  (`fetch`, `queue`, `scheduled`) wrapped with `Sentry.withSentry`, and
  delegates each handler to the Rust-generated `WorkerEntrypoint` class.
  Wrapping the class itself is not possible: workers-rs builds each
  entrypoint instance as a `Proxy` whose `defineProperty` trap forwards to
  an inner object, so the SDK's non-configurable `__SENTRY_CONTEXT__`
  definition throws a proxy-invariant `TypeError` on every invocation
  (reproduced locally under miniflare; it would fail identically in
  production workerd). No Rust changes; `worker-build` still produces
  `build/index.js`, which the entry imports.
- The DSN comes from the `SENTRY_DSN` Wrangler secret at runtime and is
  never hardcoded. An unset DSN disables the SDK; the Worker behaves as
  before.
- `sendDefaultPii` is off and `dataCollection` disables `userInfo` and
  HTTP bodies, per F21 FR-F21-002 (no raw auth material, secrets, or
  prompt/response bodies in telemetry).
- `tracesSampleRate` is 0.1, matching the existing `observability`
  `head_sampling_rate`.
- `wrangler.jsonc` sets `compatibility_flags: ["nodejs_compat"]` (required
  by the SDK) and a `CF_VERSION_METADATA` binding so the SDK detects the
  release automatically.

## Consequences

- The Worker bundle grows by the SDK: `wrangler deploy --dry-run --env
  production` reports 9957.57 KiB / gzip 2505.17 KiB versus a 9468.56 KiB /
  gzip 2401.55 KiB baseline (+489 KiB raw, +104 KiB gzip, well under the
  25 MiB Worker limit).
- What plain Wrangler wrapping cannot do is bundle-time instrumentation of
  dependencies (no Vite plugin on this target); spans are limited to what
  the SDK creates itself.
- Local dev and smoke tests run with no `SENTRY_DSN`, exercising the
  SDK-disabled path.
