// Source-level guards for the race stage (it cannot run without Electron + a Worker). They pin the two
// regressions seen at runtime: a re-seeded `markManaged` (authority seed) and a ReferenceError from a
// helper that used `orgId` without receiving it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./automation-stage-race.mjs", import.meta.url), "utf8");
const code = source.replace(/^\s*\/\/.*$/gm, "");

test("race stage never seeds a managed marker for client B", () => {
  assert.equal(/markManaged/.test(code), false, "B's marker may only come from the attach dialog");
  assert.match(
    code,
    /carries no managed marker before launch/,
    "unmarked-original fixture assertion present",
  );
  assert.match(code, /origin,\s*"attached"/, "the marker is asserted to come from a UI attach");
});

test("every function that reads orgId binds it first", () => {
  const chunks = code.split(/^(?=(?:export )?(?:async )?function |const \w+ = (?:async )?\()/m);
  for (const chunk of chunks) {
    // ignore property keys / SQL text: only bare reads such as `${orgId}`, `(orgId` or `, orgId`
    const reads = /(?:\$\{|[(,=]\s*)orgId\b(?!\s*:)/.test(chunk);
    if (!reads) continue;
    const binds = /\{[^}]*\borgId\b[^}]*\}\s*=\s*ctx|\(\{[^}]*\borgId\b[^}]*\}|\borgId\s*=/.test(
      chunk,
    );
    assert.ok(
      binds,
      `orgId is read without being bound in: ${chunk.slice(0, 80).replace(/\n/g, " ")}`,
    );
  }
});

// Regression for the retained race FAIL (native-race-lane3-run2.log): the attach helpers destructured
// `profileB` from ctx while raceStage only stored it on ctx.state, so the first read got `undefined`.
test("every ctx key the race stage destructures is defined by the entry point or assigned on ctx", () => {
  const entry = readFileSync(
    new URL("../desktop-automation-electron.mjs", import.meta.url),
    "utf8",
  );
  const defined = new Set();
  const literal = entry.match(/const ctx = \{([\s\S]*?)\n\};/)[1];
  for (const m of literal.matchAll(/^\s{2}(\w+)[,:]/gm)) defined.add(m[1]);
  for (const m of (entry + code).matchAll(/\bctx\.(\w+)\s*=[^=]/g)) defined.add(m[1]);
  for (const m of (entry + code).matchAll(/Object\.assign\(ctx, \{([^}]*)\}\)/g))
    for (const key of m[1].split(",")) defined.add(key.trim().split(":")[0]);
  const used = new Set();
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*ctx\b/g))
    for (const key of m[1].split(",")) if (key.trim()) used.add(key.trim().split(":")[0].trim());
  const missing = [...used].filter((key) => !defined.has(key));
  assert.deepEqual(missing, [], `destructured from ctx but never defined: ${missing}`);
});

test("clients are released only on a dispatching occurrence, never a pending one", () => {
  assert.match(code, /const CLAIMABLE = \["dispatching"\];/);
});

test("the no-holder positive control is measured before SIGCONT releases the clients", () => {
  const read = code.indexOf("heldBeforeRelease = (await managedEvidence");
  const release = code.indexOf('appA.signal("SIGCONT")');
  assert.ok(read > 0 && release > read, "lease read must precede the release");
});
