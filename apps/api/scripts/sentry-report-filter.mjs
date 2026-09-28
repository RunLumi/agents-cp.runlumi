/**
 * Which console lines are worth a Sentry event.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `captureConsoleIntegration`
 *
 * The Worker entry is wrapped by `Sentry.withSentry`, which sees *thrown* errors and
 * unhandled rejections. A swallowed error never throws: it is caught, formatted and
 * dropped. Those are exactly the failures worth having a page for — a D1 batch that
 * died, an audit insert rejected by a constraint — and they are exactly the ones the
 * SDK cannot see.
 *
 * The obvious remedy is `integrations: [Sentry.captureConsoleIntegration()]`, and it
 * is wrong here. This codebase uses `console_error!` for routine operational
 * telemetry as well as for faults — queue routing, job outcomes, deliberately
 * rejected envelopes — so capturing console output wholesale would turn a
 * high-signal channel into a stream of `p06_queue_routed:{route}` events and spend
 * the quota on lines nobody acts on.
 *
 * So the decision is made at the call site instead: a line is a Sentry event if and
 * only if it carries the reserved prefix. The Rust side has a helper that adds it
 * (`routes::support::report_error`), and a test in `support.rs` asserts that this
 * constant and the Rust one are the same string, so the two halves cannot drift.
 *
 * Kept in its own module, pure, with no Sentry or Worker import, so `node --test` can
 * cover it without pulling in the built worker.
 */

/** Reserved. A console line starting with this is a fault worth reporting. */
export const REPORT_PREFIX = "lumi:report:";

/**
 * Split a console argument list into `[isReportable, message]`.
 *
 * Only the first argument is inspected, and only when it is a string. A report is
 * always written as one formatted string, so this cannot miss one; and a non-string
 * first argument means a developer passed something structured, which is never a
 * report.
 *
 * @param {unknown[]} args the arguments `console.error` was called with
 * @returns {[boolean, string]} whether to report, and the message without the prefix
 */
export function classifyReport(args) {
  const first = args[0];
  if (typeof first !== "string" || !first.startsWith(REPORT_PREFIX)) {
    return [false, ""];
  }
  return [true, first.slice(REPORT_PREFIX.length)];
}

/**
 * Wrap `console.error` so marked lines also become Sentry events.
 *
 * The line is always still written: `wrangler dev` and Cloudflare Workers Logs are
 * where an operator reads during development and incident response, and a diagnostic
 * that vanished from the log stream because a DSN happened to be unset would be
 * worse than one that never reached Sentry.
 *
 * Errors thrown by `captureMessage` are swallowed deliberately. This runs inside the
 * Worker, and a reporting failure must not become a request failure — a broken
 * telemetry path taking down a mutation route would be a worse bug than the one it
 * was added to observe.
 *
 * @param {typeof import("@sentry/cloudflare")} Sentry
 * @param {(level: "error" | "warning") => void} [report] the reporting sink
 * @returns {() => void} restores the original `console.error`
 */
export function installReportBridge(Sentry, report) {
  const original = console.error;
  console.error = (...args) => {
    original.apply(console, args);
    const [isReportable, message] = classifyReport(args);
    if (!isReportable) return;
    const sink =
      report ??
      ((level) => {
        Sentry.captureMessage(message, level);
      });
    try {
      sink("error");
    } catch {
      // A telemetry failure is not a request failure.
    }
  };
  return () => {
    console.error = original;
  };
}
