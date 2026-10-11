// Seeds LOCAL automations into an isolated profile's tasks-index with the product's own AutomationRepo
// (real schema, migrations and the 0005 claim guard). This is fixture seeding: the journey under test
// (preview, cancel, confirm, scheduling) is then driven through the actual app UI and scheduler.
//
// usage: tsx seed-local-automations.mts <tasks-index.sqlite> <json>
//   json: [{ title, cronExpr, prompt, workspacePath, nextRunAt }]
// prints the created automation ids/revisions as JSON on stdout.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const client = resolve(import.meta.dirname, "../../../integrations/lumi-agents");
const { AutomationRepo } = (await import(
  pathToFileURL(resolve(client, "packages/services/src/node.ts")).href
)) as typeof import("../../../integrations/lumi-agents/packages/services/src/node.js");

const [dbPath, raw] = process.argv.slice(2);
if (!dbPath || !raw) throw new Error("usage: seed-local-automations <db> <json>");
const specs = JSON.parse(raw) as {
  title: string;
  cronExpr: string;
  prompt: string;
  workspacePath: string;
  nextRunAt: number;
  /** A bounded schedule is a shape the hand-over must refuse (unsupported_bounded_runs). */
  maxRuns?: number;
  /** Fixture only: put the original in the adopted state through the product's own marker API. */
  markManaged?: { orgId: string; managedAutomationId: string };
}[];
const repo = new AutomationRepo(dbPath);
try {
  await repo.ensureReady();
  const created = [];
  for (const spec of specs) {
    const row = await repo.create(
      {
        title: spec.title,
        cronExpr: spec.cronExpr,
        prompt: spec.prompt,
        workspacePath: spec.workspacePath,
        recurring: true,
        ...(spec.maxRuns ? { maxRuns: spec.maxRuns } : {}),
      },
      { nextRunAt: spec.nextRunAt },
    );
    if (spec.markManaged) {
      await repo.beginManagedAdoption({
        localAutomationId: row.automationId,
        orgId: spec.markManaged.orgId,
        idempotencyKey: `seed-${row.automationId}`,
      });
      await repo.recordManagedAutomationCreated({
        localAutomationId: row.automationId,
        managedAutomationId: spec.markManaged.managedAutomationId,
      });
    }
    created.push({ automationId: row.automationId, title: row.title, updatedAt: row.updatedAt });
  }
  process.stdout.write(JSON.stringify(created));
} finally {
  repo.close();
}
