// Stage `adopt` of the desktop automation journey: preview, conflict, cancel, explicit confirm.
// Everything the user does is a real UI action in the real app; D1 and the local tasks-index are only
// read, and every "nothing changed" claim is a before/after comparison with a positive control first.
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { automationUi } from "./automation-ui.mjs";
import { localMarkers, serverFingerprint } from "./automation-evidence.mjs";
import { CONTENT_TABLES, readTable, snapshotLocal } from "./automation-journey-state.mjs";
import { grantAutomationFixtureEntitlement } from "./lumi-org-fixture.mjs";

export const TITLES = {
  adopted: "Nightly review",
  control: "Local control",
  bounded: "Bounded limit",
  slow: "Slow run",
  slowLease: "Slow run (lease)",
  slowRevoke: "Slow run (revocation)",
};

export const rowOf = (profile, id) =>
  readTable(profile, "SELECT * FROM automations WHERE automation_id = ?", id)[0];

export async function adoptStage(ctx) {
  const { appA, ledger, server, orgId, profileA, seeds, PROMPT, evidenceDir, state } = ctx;
  const view = automationUi(appA);
  const shot = (name) => appA.page.screenshot(join(evidenceDir, `${name}.png`)).catch(() => {});
  const shown = [TITLES.adopted, TITLES.control, TITLES.bounded];

  await view.openAutomations();
  for (const title of shown) await view.waitForCard(title);
  for (const title of shown)
    assert.equal(
      await view.badgeOf(title),
      null,
      `${title} has no hand-over badge before any action`,
    );
  ledger.pass("actual UI lists the seeded local originals, none with a hand-over badge");
  await shot("adopt-list");

  // Scoped to the four originals this stage acts on: the bad-model control is retried by the local scheduler
  // on its own clock and would otherwise change the hash during an unrelated preview.
  const underTest = [seeds.adopted, seeds.control, seeds.bounded, seeds.slow].map(
    (seed) => seed.automationId,
  );
  const observe = async () => ({
    local: snapshotLocal(profileA, { only: underTest }).hash,
    markers: localMarkers(profileA).length,
    server: await serverFingerprint(server, orgId),
  });
  const before = await observe();
  assert.equal(before.markers, 0, "no adoption marker exists before the first hand-over");
  const adoptedBefore = rowOf(profileA, seeds.adopted.automationId);
  const controlBefore = rowOf(profileA, seeds.control.automationId);
  assert.ok(
    adoptedBefore && controlBefore,
    "seeded originals are readable from the local database",
  );
  state.adoptedBefore = adoptedBefore;
  state.controlBefore = controlBefore;

  // --- preview + cancel -----------------------------------------------------------------------------
  await view.startHandOver(TITLES.adopted);
  await view.waitPhase(["blocked"], "server conflict without a BYOK entitlement");
  assert.match(await view.dialogText(), /local_credential_not_permitted/);
  assert.equal(await view.dialogHas("lumi-automation-confirm"), false);
  await shot("adopt-preview-server-conflict");
  await view.cancelDialog();
  assert.deepEqual(await observe(), before, "blocked preview and cancel have no stored effects");
  ledger.pass("real server conflict is shown with no Confirm or stored effects before entitlement");
  await grantAutomationFixtureEntitlement(ctx.probe, orgId, "inference.byok", true);
  await view.startHandOver(TITLES.adopted);
  await view.waitPhase(["ready"], "ready (positive control: a preview that can be confirmed)");
  await view.waitOptionsLoaded();
  const readyText = await view.dialogText();
  assert.ok(readyText.includes(TITLES.adopted), "the preview shows the automation title");
  assert.ok(
    readyText.includes("What is sent now"),
    "the preview states exactly what would be sent",
  );
  assert.equal(readyText.includes(PROMPT), false, "the preview never shows the prompt body");
  assert.equal(
    await view.dialogHas("lumi-automation-confirm"),
    true,
    "an adoptable preview offers Confirm",
  );
  await shot("adopt-preview-ready");
  await view.cancelDialog();
  await delay(2_000);
  assert.deepEqual(await observe(), before, "preview + cancel changed local or server state");
  assert.equal(await view.badgeOf(TITLES.adopted), null, "a cancelled preview leaves no badge");
  ledger.pass(
    "preview then Cancel: local tasks-index hash, marker table and D1 definition/occurrence/lease/run/link/audit counts are identical",
  );

  // --- conflict / not adoptable ----------------------------------------------------------------------
  await view.startHandOver(TITLES.bounded);
  await view.waitPhase(["not_adoptable", "blocked"], "a refusal");
  const refusalPhase = await view.dialogPhase();
  assert.equal(
    refusalPhase,
    "not_adoptable",
    `bounded schedule is refused as not adoptable, got ${refusalPhase}`,
  );
  assert.match(await view.dialogText(), /run limit or an end date/, "the refusal names its reason");
  assert.equal(
    await view.dialogHas("lumi-automation-confirm"),
    false,
    "a refused candidate has no Confirm action",
  );
  await shot("adopt-not-adoptable");
  await view.cancelDialog();
  assert.deepEqual(await observe(), before, "a refused preview changed local or server state");
  ledger.pass(
    "bounded-run automation previews as not adoptable with its reason, no Confirm action, and no local or server mutation",
  );

  // --- explicit confirm -------------------------------------------------------------------------------
  await view.startHandOver(TITLES.adopted);
  await view.waitPhase(["ready"], "ready");
  await view.waitOptionsLoaded();
  assert.equal(
    await view.centerOfTestId("lumi-automation-confirm", '[data-testid="lumi-automation-dialog"]'),
    null,
    "Confirm is disabled until an agent and a model are chosen",
  );
  await view.chooseByLabel("Agent", ctx.agentName);
  await view.chooseByLabel("Model", ctx.successModelName);
  await shot("adopt-confirm-ready");
  await view.pressDialog("lumi-automation-confirm");
  const outcome = await view.waitPhase(["done", "confirm_failed"], "confirm outcome");
  await shot("adopt-confirm-outcome");
  assert.equal(
    outcome,
    "done",
    `confirm outcome ${outcome}: ${(await view.dialogText()).slice(0, 400)}`,
  );
  await view.pressDialog("lumi-automation-cancel"); // the Close button reuses this id once done
  await view.waitDialogGone();
  ledger.pass("explicit Hand over with a chosen agent and model completes in the actual UI");

  const markers = localMarkers(profileA);
  assert.equal(markers.length, 1, `exactly one marker, got ${markers.length}`);
  const marker = markers[0];
  assert.equal(marker.local_automation_id, seeds.adopted.automationId);
  assert.equal(marker.state, "managed");
  assert.equal(marker.org_id, orgId);
  assert.match(String(marker.managed_automation_id), /^aut_[0-9a-f]{32}$/);
  assert.ok(marker.idempotency_key, "the create carried an idempotency key");
  state.managedAutomationId = marker.managed_automation_id;

  assert.deepEqual(
    rowOf(profileA, seeds.adopted.automationId),
    adoptedBefore,
    "the original row is byte-identical after confirm",
  );
  assert.deepEqual(
    rowOf(profileA, seeds.control.automationId),
    controlBefore,
    "the unmarked control is untouched",
  );
  assert.equal(
    readTable(
      profileA,
      "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?",
      seeds.adopted.automationId,
    )[0].n,
    0,
    "no local run history was written for the original",
  );
  ledger.pass(
    "confirm preserved the local original byte-for-byte and wrote exactly one reversible marker (state managed)",
  );

  const definitions = await server.rows(
    `SELECT * FROM automation_definitions WHERE org_id='${orgId}' AND automation_id='${marker.managed_automation_id}'`,
    "managed definition",
  );
  assert.equal(definitions.length, 1, "D1 holds exactly the managed definition the marker names");
  const definition = definitions[0];
  const text = JSON.stringify(definition);
  assert.equal(definition.status, "active");
  for (const needle of [
    TITLES.adopted,
    ctx.projectId,
    ctx.agentId,
    "coding-default",
    "lumi-local:",
  ])
    assert.ok(text.includes(needle), `definition carries ${needle}`);
  const after = await serverFingerprint(server, orgId);
  assert.equal(
    after.counts.definitions,
    before.server.counts.definitions + 1,
    "exactly one definition was created",
  );
  assert.equal(after.counts.runs, before.server.counts.runs, "adoption created no run");
  assert.equal(after.counts.leases, before.server.counts.leases, "adoption created no lease");
  assert.ok(after.counts.audit > before.server.counts.audit, "the create was audited");
  await server.assertAbsent(PROMPT, CONTENT_TABLES, "prompt body after hand-over");
  ledger.pass(
    "D1 shows one active managed definition for the chosen project/agent/alias and the prompt body appears in no server table",
  );

  await view.openAutomations();
  await view
    .ui()
    .wait(
      () =>
        !!document.querySelector('[data-testid="lumi-automation-badge"] [data-state="managed"]'),
      "managed badge",
    );
  assert.equal(await view.badgeOf(TITLES.adopted), "managed");
  assert.equal(await view.badgeOf(TITLES.control), null);
  assert.equal(await view.badgeOf(TITLES.bounded), null);
  await view.openCardMenu(TITLES.adopted);
  const menu = await view.menuTestIds();
  assert.ok(menu.includes("lumi-automation-return"), `adopted card offers Return, menu=${menu}`);
  assert.equal(
    menu.includes("lumi-automation-handover"),
    false,
    "a managed original cannot be handed over twice",
  );
  await view.dismissMenu();
  await shot("adopt-managed-badge");
  ledger.pass(
    "the card shows Managed by Lumi only on the adopted original and offers Return instead of a second hand-over",
  );
}
