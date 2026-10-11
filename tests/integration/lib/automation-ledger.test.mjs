// The stage ledger decides the journey verdict, so it must fail closed: only a stage that executed at
// least one claim and has nothing open may be PASS.
import assert from "node:assert/strict";
import test from "node:test";
import { createLedger } from "./automation-evidence.mjs";

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const run = (stages, steps) => {
  const ledger = createLedger(stages);
  quiet(() => steps(ledger));
  return ledger;
};

test("positive control: a stage with an executed claim is PASS", () => {
  const ledger = run(["a"], (l) => {
    l.enter("a");
    l.pass("claim");
    l.finish("a");
  });
  assert.equal(ledger.snapshot().a.status, "PASS");
  assert.equal(ledger.allPass(), true);
});

test("a stage entered and finished with zero claims is UNPROVEN, never PASS", () => {
  const ledger = run(["a"], (l) => {
    l.enter("a");
    l.finish("a");
  });
  assert.equal(ledger.snapshot().a.status, "UNPROVEN");
  assert.equal(ledger.allPass(), false);
});

test("the empty stage cannot ride on another stage's PASS claim", () => {
  const ledger = run(["a", "b"], (l) => {
    l.enter("a");
    l.pass("claim in a");
    l.finish("a");
    l.enter("b");
    l.finish("b");
  });
  assert.equal(ledger.snapshot().a.status, "PASS");
  assert.equal(ledger.snapshot().b.status, "UNPROVEN");
  assert.equal(ledger.allPass(), false);
});

test("an exception is FAIL with the message preserved, even after a PASS claim", () => {
  const ledger = run(["a"], (l) => {
    l.enter("a");
    l.pass("claim");
    l.finish("a", new Error("boom"));
  });
  const item = ledger.snapshot().a;
  assert.equal(item.status, "FAIL");
  assert.match(item.error, /boom/);
  assert.equal(ledger.allPass(), false);
});

test("a stage that never ran, or whose finish is called without enter, stays UNPROVEN", () => {
  const ledger = run(["a", "b"], (l) => {
    l.enter("a");
    l.pass("claim");
    l.finish("a");
    l.finish("b");
  });
  assert.equal(ledger.snapshot().b.status, "UNPROVEN");
  assert.equal(ledger.allPass(), false);
});

test("a finish for an unknown stage throws instead of being ignored", () => {
  const ledger = createLedger(["a"]);
  assert.throws(() => ledger.finish("typo"), /unknown stage/);
});

test("missing (UNPROVEN) and blocked claims keep the stage out of PASS", () => {
  const ledger = run(["missing", "blocked", "mixed", "failed", "weird"], (l) => {
    l.enter("missing");
    l.pass("ran");
    l.gap("missing", "not exercised", "UNPROVEN", "no public surface");
    l.finish("missing");
    l.enter("blocked");
    l.pass("ran");
    l.gap("blocked", "cannot exercise", "BLOCKED", "provider");
    l.finish("blocked");
    l.enter("mixed");
    l.gap("mixed", "a", "BLOCKED", "x");
    l.gap("mixed", "b", "UNPROVEN", "y");
    l.finish("mixed");
    l.enter("failed");
    l.pass("ran");
    l.gap("failed", "regressed", "FAIL", "z");
    l.finish("failed");
    l.enter("weird");
    l.pass("ran");
    l.gap("weird", "odd", "PASSED", "typo");
    l.finish("weird");
  });
  const status = Object.fromEntries(Object.entries(ledger.snapshot()).map(([name, item]) => [name, item.status]));
  assert.deepEqual(status, {
    missing: "UNPROVEN",
    blocked: "BLOCKED",
    mixed: "UNPROVEN",
    failed: "FAIL",
    weird: "UNPROVEN",
  });
  assert.equal(ledger.allPass(), false);
});

test("a gap-only stage (no PASS claim) is not PASS", () => {
  const ledger = run(["a"], (l) => {
    l.enter("a");
    l.gap("a", "only a gap", "BLOCKED", "x");
    l.finish("a");
  });
  assert.equal(ledger.snapshot().a.status, "BLOCKED");
});

test("all-stages: any single non-PASS stage, or no stages at all, is not allPass", () => {
  const stages = ["a", "b", "c"];
  const good = run(stages, (l) => {
    for (const name of stages) {
      l.enter(name);
      l.pass(`claim ${name}`);
      l.finish(name);
    }
  });
  assert.equal(good.allPass(), true);
  for (const bad of stages) {
    const ledger = run(stages, (l) => {
      for (const name of stages) {
        l.enter(name);
        if (name !== bad) l.pass(`claim ${name}`);
        l.finish(name);
      }
    });
    assert.equal(ledger.snapshot()[bad].status, "UNPROVEN", bad);
    assert.equal(ledger.allPass(), false, bad);
  }
  assert.equal(createLedger([]).allPass(), false);
});

test("a finished stage keeps its verdict on a repeated finish", () => {
  const ledger = run(["a"], (l) => {
    l.enter("a");
    l.finish("a", new Error("first"));
    l.finish("a");
  });
  assert.equal(ledger.snapshot().a.status, "FAIL");
});

// Regression for native-full-lane3-run18 restart FAIL: card lookup by substring handed over "Slow run (lease)"
// when "Slow run" was requested.
import { titleOf } from "./automation-ui.mjs";
test("a card is identified by its title line, so a prefix title never matches a longer one", () => {
  const lease = { text: "Slow run (lease)\nSLOW-LEASE-PROMPT" };
  const slow = { text: "Slow run\nManaged by Lumi\nCheck run history" };
  assert.equal(titleOf(slow), "Slow run");
  assert.deepEqual([lease, slow].filter((card) => titleOf(card) === "Slow run"), [slow]);
  assert.equal([lease, slow].filter((card) => card.text.includes("Slow run")).length, 2, "positive control: substring matching is ambiguous");
});
