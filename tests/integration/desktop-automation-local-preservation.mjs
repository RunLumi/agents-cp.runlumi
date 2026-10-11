// DE2E-INT-05 runtime check that needs NO Worker: the real Electron app, real scheduler utility process
// and real tasks-index SQLite, with the control plane UNREACHABLE.
//
// Proves (and only this): the rebuilt app boots; the scheduler still dispatches an unmarked local
// automation (existing local cron path preserved); an adopted original that is due is NOT claimed or
// rewritten by the scheduler; Main survives the scheduler's managed-poll request with no reachable
// control plane. It does NOT prove managed scheduling, lease/fence behaviour, two-client races or any
// Worker route; those need the Worker (see the checkpoint).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDesktopApp } from "./lib/lumi-desktop-app.mjs";
import { readTable, seedLocalAutomations, snapshotLocal } from "./lib/automation-journey-state.mjs";

const root = resolve(import.meta.dirname, "../..");
const client = join(root, "integrations/lumi-agents");
const binary = join(
  client,
  process.platform === "darwin"
    ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : "node_modules/electron/dist/electron",
);
const profile = await mkdtemp(join(tmpdir(), "lumi-automation-local-"));
const workspacePath = join(profile, "workspace");
mkdirSync(workspacePath, { recursive: true });
mkdirSync(join(profile, "home", ".zcode", "v2"), { recursive: true });
mkdirSync(join(profile, "evidence"), { recursive: true });
const org = `org_${"a".repeat(32)}`;
const due = Date.now() - 10_000;
const [adopted, control] = await seedLocalAutomations({
  root,
  profile,
  specs: [
    {
      title: "Adopted original",
      cronExpr: "* * * * *",
      prompt: "adopted prompt",
      workspacePath,
      nextRunAt: due,
      markManaged: { orgId: org, managedAutomationId: `aut_${"b".repeat(32)}` },
    },
    {
      title: "Unmarked control",
      cronExpr: "* * * * *",
      prompt: "control prompt",
      workspacePath,
      nextRunAt: due,
    },
  ],
});
const before = snapshotLocal(profile);
const adoptedBefore = before.automations.find((row) => row.automation_id === adopted.automationId);
const probe = {
  baseUrl: "http://127.0.0.1:9",
  availablePort: async () => 40_000 + Math.floor(Math.random() * 10_000),
};
const app = createDesktopApp({
  binary,
  desktop: join(client, "packages/desktop"),
  probe,
  profile,
  workspacePath,
  name: "local preservation",
});
const results = [];
const pass = (claim) => {
  results.push(claim);
  console.log(`PASS ${claim}`);
};
let failed = true;
try {
  await app.start();
  pass("rebuilt Electron app boots and renders with the control plane unreachable");
  // Several 20s scheduler ticks (the first tick happens right after the local database is ready).
  const deadline = Date.now() + 120_000;
  let controlRow;
  while (Date.now() < deadline) {
    controlRow = readTable(
      profile,
      "SELECT * FROM automations WHERE automation_id = ?",
      control.automationId,
    )[0];
    if (
      controlRow &&
      (controlRow.dispatch_attempts > 0 || controlRow.run_count > 0 || controlRow.last_error)
    )
      break;
    await delay(2_000);
  }
  assert.ok(
    controlRow &&
      (controlRow.dispatch_attempts > 0 || controlRow.run_count > 0 || controlRow.last_error),
    "the real local scheduler claimed and dispatched the unmarked automation",
  );
  pass("existing local cron path still claims and dispatches an unmarked due automation");
  await delay(45_000); // at least two more ticks, each of which also posts managed-poll-request
  const adoptedAfter = readTable(
    profile,
    "SELECT * FROM automations WHERE automation_id = ?",
    adopted.automationId,
  )[0];
  assert.deepEqual(
    adoptedAfter,
    adoptedBefore,
    "adopted original row is byte-identical after due ticks",
  );
  assert.equal(
    readTable(
      profile,
      "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?",
      adopted.automationId,
    )[0].n,
    0,
    "the scheduler wrote no run history for the adopted original",
  );
  pass("a due adopted original is not claimed, dispatched or rewritten by the real scheduler");
  assert.ok(app.pid, "Main process still alive after managed-poll requests");
  writeFileSync(join(profile, "evidence", "app.log"), app.log.slice(-20_000));
  pass("Main stays up while managed polling cannot reach a control plane");
  failed = false;
} finally {
  await app.stop();
  writeFileSync(
    join(profile, "evidence", "result.json"),
    JSON.stringify(
      { verdict: failed ? "FAIL" : "PASS", scope: "no Worker; local preservation only", results },
      null,
      2,
    ),
  );
  console.log(`Profile/evidence retained: ${profile}`);
}
process.exit(failed ? 1 : 0);
