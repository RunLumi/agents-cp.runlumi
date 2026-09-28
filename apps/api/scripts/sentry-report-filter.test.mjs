// Node's built-in runner, so covering this needs no dependency.
//
// `node --test` rather than vitest: vitest is configured for `apps/web` and reaches
// nothing in `apps/api`, and pulling a runner across the workspace to test one pure
// module would be a larger change than the module.

import assert from "node:assert/strict";
import { test } from "node:test";

import { REPORT_PREFIX, classifyReport, installReportBridge } from "./sentry-report-filter.mjs";

test("an unmarked line is not a report", () => {
  assert.deepEqual(classifyReport(["p06_queue_routed:outbox"]), [false, ""]);
  assert.deepEqual(classifyReport([""]), [false, ""]);
  assert.deepEqual(classifyReport([]), [false, ""]);
});

test("a non-string first argument is not a report", () => {
  // Structured arguments are a developer's own logging, not the Rust helper.
  assert.deepEqual(classifyReport([{ event_id: "sec_1" }]), [false, ""]);
  assert.deepEqual(classifyReport([undefined, REPORT_PREFIX + "x"]), [false, ""]);
});

test("a marked line is a report, with the prefix stripped", () => {
  const [isReportable, message] = classifyReport([`${REPORT_PREFIX}the commit batch failed`]);
  assert.equal(isReportable, true);
  assert.equal(message, "the commit batch failed");
});

test("the prefix alone still reports an empty message rather than being dropped", () => {
  // Silently swallowing a marked-but-empty line would be a hole in the bridge.
  assert.deepEqual(classifyReport([REPORT_PREFIX]), [true, ""]);
});

test("only the first argument is classified", () => {
  assert.deepEqual(classifyReport(["plain", REPORT_PREFIX + "x"]), [false, ""]);
});

test("the bridge reports a marked line exactly once, and still writes it", () => {
  const written = [];
  const original = console.error;
  console.error = (...args) => written.push(args);
  const sent = [];
  try {
    const restore = installReportBridge(null, (level) => sent.push(level));
    console.error(`${REPORT_PREFIX}fault one`);
    console.error("routine telemetry");
    restore();
  } finally {
    console.error = original;
  }
  assert.equal(sent.length, 1, "one report for one marked line");
  assert.deepEqual(sent, ["error"]);
  assert.equal(written.length, 2, "both lines are still written to the log");
  assert.equal(written[0][0], `${REPORT_PREFIX}fault one`);
});

test("the bridge writes to the real console when no sink is injected", () => {
  // The production path: no `report` argument, so the closure captures Sentry.
  let captured = null;
  const Sentry = {
    captureMessage: (message, level) => {
      captured = [message, level];
    },
  };
  const original = console.error;
  console.error = () => {};
  try {
    const restore = installReportBridge(Sentry);
    console.error(`${REPORT_PREFIX}from the worker`);
    restore();
  } finally {
    console.error = original;
  }
  assert.deepEqual(captured, ["from the worker", "error"]);
});

test("a reporting failure does not become a request failure", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const restore = installReportBridge(null, () => {
      throw new Error("Sentry is down");
    });
    // The point of the test: this must not throw.
    restore();
  } finally {
    console.error = original;
  }
});

test("restoring puts the original console.error back", () => {
  const original = console.error;
  const restore = installReportBridge(null, () => {});
  assert.notEqual(console.error, original);
  restore();
  assert.equal(console.error, original);
});
