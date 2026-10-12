// Managed-turn UI helpers shared by the actual Electron journeys: reach Settings -> General's
// managed-run controls the way a user does and submit one turn through "Run with managed policy".
import assert from "node:assert/strict";
import { uiHelpers } from "./lumi-desktop-app.mjs";

// Codes are rendered next to other text (e.g. "...lumi_device_refusedReload"), so stop at known words.
const LUMI_CODE = /lumi_[a-z_]{3,80}?(?=[A-Z]|\b|$)/;

/**
 * Open the managed-run controls. Resolves "ready" once server-owned agent/model options are
 * listed, or "refused" with the stable code shown when the section or workspace is refused.
 */
export async function openManagedControls(page, { timeout = 30_000 } = {}) {
  const ui = uiHelpers(page);
  if (!(await page.evaluate(() => !!document.querySelector("#lumi-managed-agent")))) {
    await ui.clickText("Settings");
    await ui.wait(() => !!document.querySelector('[aria-label="General"]'), "settings nav");
    await ui.clickText("General");
  }
  await ui.wait(
    (pattern) =>
      (document.querySelectorAll("#lumi-managed-agent option").length > 1 &&
        document.querySelectorAll("#lumi-managed-model option").length > 1) ||
      new RegExp(pattern).test(
        [
          document.querySelector("#lumi-managed-prompt")?.parentElement?.innerText ?? "",
          ...[...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? ""),
        ].join(" "),
      ),
    "managed run controls or refusal",
    { timeout, arg: LUMI_CODE.source },
  );
  const code = await page.evaluate(
    (pattern) =>
      [
        document.querySelector("#lumi-managed-prompt")?.parentElement?.innerText ?? "",
        ...[...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? ""),
      ]
        .join(" ")
        .match(new RegExp(pattern))?.[0],
    LUMI_CODE.source,
  );
  return code ? { state: "refused", code } : { state: "ready" };
}

/** Select agent/model, type the prompt and press Run. Requires the controls to be ready. */
export async function submitManagedTurn(page, { agentId, alias, prompt }) {
  const ui = uiHelpers(page);
  const opened = await openManagedControls(page);
  assert.equal(opened.state, "ready", `managed controls refused: ${opened.code}`);
  assert.equal(await ui.selectValue("#lumi-managed-agent", agentId), true);
  assert.equal(await ui.selectValue("#lumi-managed-model", alias), true, `alias ${alias} listed`);
  await page.evaluate((value) => {
    const textarea = document.querySelector("#lumi-managed-prompt");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, prompt);
  await ui.wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText.trim() === "Run with managed policy" && !button.disabled,
      ),
    "managed run enabled",
  );
  await ui.clickText("Run with managed policy");
}

/** The stable `lumi_*` code currently shown by the managed-run section, if any. */
export const managedSectionCode = (page) =>
  page.evaluate(
    (pattern) =>
      document
        .querySelector("#lumi-managed-prompt")
        ?.parentElement?.innerText.match(new RegExp(pattern))?.[0],
    LUMI_CODE.source,
  );
