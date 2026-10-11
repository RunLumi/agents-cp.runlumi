// Focused controls for the schedule stage's output correlation. Pure functions only: no Worker, no Electron.
// Run: node --test tests/integration/lib/automation-stage-schedule.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { describeScope, tasksInWindow, toEpochMs } from "./automation-stage-schedule.mjs";

// Realistic 2026 instants: toEpochMs treats values < 1e11 as epoch seconds, so fixtures must be real epochs
// (a 1_000_000 "ms" fixture is a 1970 instant and is correctly read as seconds).
const BASE = Date.parse("2026-10-09T00:10:50.000Z");
const window = { claimedAt: BASE, settledAt: BASE + 60_000 };
const task = (taskId, createdAt) => ({ taskId, createdAt });
const ids = (list) => list.map((t) => t.taskId);

test("toEpochMs reads epoch ms, epoch seconds, digit strings and ISO text; anything else is NaN", () => {
  assert.equal(toEpochMs(1_791_507_050_640), 1_791_507_050_640);
  assert.equal(toEpochMs(1_791_507_050), 1_791_507_050_000);
  assert.equal(toEpochMs("1791507050640"), 1_791_507_050_640);
  assert.equal(toEpochMs("2026-10-09T00:10:50.640Z"), Date.parse("2026-10-09T00:10:50.640Z"));
  for (const bad of [null, undefined, "", "not a time", {}])
    assert.ok(Number.isNaN(toEpochMs(bad)), String(bad));
});

test("toEpochMs: a 2026 instant is >= 1e11 in ms and < 1e11 in seconds, so the threshold separates them", () => {
  assert.ok(BASE >= 1e11);
  assert.ok(BASE / 1_000 < 1e11);
  assert.equal(toEpochMs(BASE), BASE);
  assert.equal(toEpochMs(BASE / 1_000), BASE);
});

test("tasksInWindow attributes only tasks created between claim and settle", () => {
  const result = tasksInWindow(
    [task("before", BASE - 100_000), task("mine", BASE + 20_000), task("after", BASE + 200_000)],
    window,
  );
  assert.deepEqual(ids(result.inside), ["mine"]);
  assert.deepEqual(ids(result.outside).sort(), ["after", "before"]);
  assert.deepEqual(result.unreadable, []);
});

test("tasksInWindow gives the same verdict for epoch ms, epoch seconds, digit-string and ISO created_at", () => {
  const at = BASE + 20_000;
  for (const createdAt of [at, at / 1_000, String(at), new Date(at).toISOString()]) {
    const result = tasksInWindow(
      [
        task("mine", createdAt),
        task(
          "late",
          typeof createdAt === "number" && createdAt < 1e11
            ? createdAt + 300
            : toEpochMs(createdAt) + 300_000,
        ),
      ],
      window,
    );
    assert.deepEqual(ids(result.inside), ["mine"], `format ${typeof createdAt}:${createdAt}`);
    assert.deepEqual(ids(result.outside), ["late"], `format ${typeof createdAt}:${createdAt}`);
  }
});

test("tasksInWindow never guesses: two in-window tasks stay two, an unreadable time is reported", () => {
  const two = tasksInWindow([task("a", BASE + 10_000), task("b", BASE + 50_000)], window);
  assert.equal(two.inside.length, 2);
  const bad = tasksInWindow([task("a", "garbage"), task("b", BASE + 10_000)], window);
  assert.deepEqual(ids(bad.unreadable), ["a"]);
  assert.deepEqual(ids(bad.inside), ["b"]);
});

test("tasksInWindow tolerates only the clock slack at both edges", () => {
  assert.equal(tasksInWindow([task("edge", BASE - 1_500)], window).inside.length, 1);
  assert.equal(tasksInWindow([task("far", BASE - 2_500)], window).inside.length, 0);
  assert.equal(tasksInWindow([task("edge", window.settledAt + 1_500)], window).inside.length, 1);
  assert.equal(tasksInWindow([task("far", window.settledAt + 2_500)], window).inside.length, 0);
});

test("tasksInWindow: a whole-second created_at truncated below the claim stays inside the slack", () => {
  const claimedAt = BASE + 900; // task created at BASE+900ms, stored truncated as BASE (seconds)
  const result = tasksInWindow([task("trunc", BASE / 1_000)], {
    claimedAt,
    settledAt: claimedAt + 60_000,
  });
  assert.deepEqual(ids(result.inside), ["trunc"]);
});

test("describeScope renders the measured tables, text columns and rows without content", () => {
  const scope = [
    { table: "runs", columns: 4, rows: 3 },
    { table: "usage_events", columns: 2, rows: 7 },
  ];
  assert.equal(describeScope(scope), "2 tables, 6 text columns, 10 rows");
});
