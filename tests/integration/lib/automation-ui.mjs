// Real-UI driver for the Lumi automation hand-over (DE2E-INT-05). Everything here is what a person does
// in the renderer: open Automations, open a card's menu, read a dialog, pick from its selects, press
// Confirm or Cancel. There are no IPC calls, no handler imports and no renderer-side shortcuts. Pointer
// input is delivered as real CDP mouse events because Radix menus ignore a synthetic `.click()`.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { uiHelpers } from "./lumi-desktop-app.mjs";

/** Observations the product's UI made that a retry absorbed; the entry point copies them into the report. */
export const uiObservations = [];

/** A card is identified by its title line, never by a substring: "Slow run" is a prefix of "Slow run (lease)". */
export const titleOf = (card) => card.text.split("\n")[0].trim();

const DIALOG = '[data-testid="lumi-automation-dialog"]';
const MENU = '[role="menu"][data-state="open"]';

export function automationUi(app) {
  const page = () => app.page;
  const ui = () => uiHelpers(app.page);

  async function realClickAt(point, label) {
    assert.ok(point, `UI target not found: ${label}`);
    const { x, y } = point;
    await page().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page().send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await page().send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await delay(350);
  }

  const centerOfTestId = (testId, within) =>
    page().evaluate(
      (id, scope) => {
        const root = scope ? document.querySelector(scope) : document;
        const element = root?.querySelector(`[data-testid="${id}"]`);
        if (!element || element.disabled) return null;
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      },
      testId,
      within ?? null,
    );

  async function openAutomations() {
    // Settings preserves the underlying workspace DOM. A mounted list is not proof it is visible.
    const back = await page().evaluate(() => {
      for (const button of document.querySelectorAll("button")) {
        if (button.textContent?.trim() !== "Back to workspace") continue;
        const rect = button.getBoundingClientRect();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const hit = document.elementFromPoint(point.x, point.y);
        if (rect.width && rect.height && hit && button.contains(hit)) return point;
      }
      return null;
    });
    if (back) await realClickAt(back, "leave Settings");
    const hasList = () => page().evaluate(() => !!document.querySelector('[data-testid="automations-list"]'));
    if (await hasList()) return;
    if (!(await page().evaluate(() => !!document.querySelector('[data-testid="automations-open"]'))))
      await ui().clickText("Back to workspace");
    await ui().wait(() => !!document.querySelector('[data-testid="automations-open"]'), "sidebar");
    await ui().clickTestId("automations-open");
    await ui().wait(() => !!document.querySelector('[data-testid="automations-list"]'), "automations list");
  }

  const cardTitles = () =>
    page().evaluate(() =>
      [...document.querySelectorAll('[data-testid="automation-card"]')].map((card) => ({
        text: card.innerText,
        badge: card.querySelector('[data-testid="lumi-automation-badge"] [data-state]')?.getAttribute("data-state") ?? null,
      })),
    );

  async function waitForCard(title) {
    await ui().wait(
      (needle) =>
        [...document.querySelectorAll('[data-testid="automation-card"]')].some((card) =>
          card.innerText.split("\n")[0].trim() === needle,
        ),
      `automation card ${title}`,
      { arg: title, timeout: 45_000 },
    );
  }

  /** Adoption badge state (`managed`, `finishing`, `returning`) of the card, or null when none. */
  async function badgeOf(title) {
    const cards = await cardTitles();
    return cards.find((card) => titleOf(card) === title)?.badge ?? null;
  }

  async function openCardMenu(title) {
    await waitForCard(title);
    const point = await page().evaluate((needle) => {
      const card = [...document.querySelectorAll('[data-testid="automation-card"]')].find((item) =>
        item.innerText.split("\n")[0].trim() === needle,
      );
      const trigger = card?.querySelector('[data-testid="automation-card-menu"]');
      if (!trigger) return null;
      trigger.scrollIntoView({ block: "center" });
      const rect = trigger.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      if (!rect.width || !rect.height || !hit || !trigger.contains(hit)) return null;
      return point;
    }, title);
    await realClickAt(point, `card menu of ${title}`);
    await ui().wait((selector) => !!document.querySelector(selector), `menu of ${title}`, { arg: MENU });
  }

  /** Menu item test ids offered by the open card menu (so absence of an action is observable). */
  const menuTestIds = () =>
    page().evaluate((selector) =>
      [...document.querySelectorAll(`${selector} [data-testid]`)].map((item) =>
        item.getAttribute("data-testid"),
      ),
      MENU,
    );

  async function startHandOver(title, { attempts = 8, settleMs = 1_500 } = {}) {
    // The hand-over item is hidden (not disabled) while the account projection reloads, which a grant just before
    // opening the menu can trigger (native-full-lane3-run10/run15, retained profiles). Re-open the menu a bounded
    // number of times and record every absence; an item that never appears still fails with the menu's contents.
    for (let attempt = 1; ; attempt += 1) {
      await openCardMenu(title);
      if (await centerOfTestId("lumi-automation-handover", MENU)) break;
      const offered = await menuTestIds();
      uiObservations.push({ at: new Date().toISOString(), title, attempt, offered, note: "hand-over menu item absent" });
      assert.ok(attempt < attempts, `hand over menu item never appeared for ${title} after ${attempts} attempts; menu offered ${JSON.stringify(offered)}`);
      await dismissMenu();
      await delay(settleMs);
    }
    await realClickAt(await centerOfTestId("lumi-automation-handover", MENU), "hand over menu item");
    await ui().wait(() => !!document.querySelector('[data-testid="lumi-automation-dialog"]'), "dialog");
  }

  /** Card menu -> "Attach to existing" (spec 07). Opening the dialog only previews; nothing is sent. */
  async function startAttach(title) {
    await openCardMenu(title);
    await realClickAt(await centerOfTestId("lumi-automation-attach", MENU), "attach menu item");
    await ui().wait(() => !!document.querySelector('[data-testid="lumi-automation-dialog"]'), "attach dialog");
  }

  /** Rendered candidate radios: label text and whether the product marked them attachable. */
  const attachOptions = () =>
    page().evaluate(
      (selector) =>
        [...document.querySelectorAll(`${selector} [data-testid="lumi-automation-attach-option"]`)].map(
          (input) => ({
            text: input.closest("label")?.innerText ?? "",
            attachable: input.getAttribute("data-attachable") === "true",
            checked: input.checked,
          }),
        ),
      DIALOG,
    );

  /** Real click on the index-th candidate radio (never a disabled one: that is a refused candidate). */
  async function chooseAttachOption(index) {
    const point = await page().evaluate(
      (selector, position) => {
        const input = document.querySelectorAll(`${selector} [data-testid="lumi-automation-attach-option"]`)[position];
        if (!input || input.disabled) return null;
        input.scrollIntoView({ block: "center" });
        const rect = input.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      },
      DIALOG,
      index,
    );
    await realClickAt(point, `attach option ${index}`);
  }

  /** Real click on the local-instructions acknowledgement; returns its checked state afterwards. */
  async function toggleAttachAck() {
    await realClickAt(await centerOfTestId("lumi-automation-attach-ack", DIALOG), "attach acknowledgement");
    return page().evaluate(
      (selector) => document.querySelector(`${selector} [data-testid="lumi-automation-attach-ack"]`)?.checked ?? null,
      DIALOG,
    );
  }

  const dialogPhase = () =>
    page().evaluate(
      (selector) => document.querySelector(selector)?.getAttribute("data-phase") ?? null,
      DIALOG,
    );
  const dialogText = () =>
    page().evaluate((selector) => document.querySelector(selector)?.innerText ?? "", DIALOG);
  const dialogHas = (testId) =>
    page().evaluate(
      (selector, id) => !!document.querySelector(`${selector} [data-testid="${id}"]`),
      DIALOG,
      testId,
    );

  async function waitPhase(phases, label) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const phase = await dialogPhase();
      if (phase && phases.includes(phase)) return phase;
      await delay(250);
    }
    throw new Error(`dialog never reached ${label ?? phases.join("|")}; phase=${await dialogPhase()}; text=${(await dialogText()).slice(0, 300)}`);
  }

  /** Wait until the agent and model <select>s hold the real options the Worker returned. */
  async function waitOptionsLoaded() {
    await ui().wait(
      () => {
        const selects = [...document.querySelectorAll('[data-testid="lumi-automation-dialog"] select')];
        return selects.length >= 2 && selects.every((select) => select.options.length > 1);
      },
      "agent and model options",
    );
  }

  /** Select an actual rendered option by label or its public alias/id; never call a handler. */
  async function chooseByLabel(label, optionText) {
    const ok = await page().evaluate(
      (text, wanted) => {
        const wrapper = [...document.querySelectorAll('[data-testid="lumi-automation-dialog"] label')].find(
          (item) => item.innerText.trim().startsWith(text),
        );
        const select = wrapper?.querySelector("select");
        const option = select && [...select.options].find((item) =>
          item.text.trim() === wanted || item.value === wanted,
        );
        if (!select || !option) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return select.value === option.value;
      },
      label,
      optionText,
    );
    assert.equal(ok, true, `select ${label} -> ${optionText}`);
    await delay(250);
  }

  async function pressDialog(testId) {
    await ui().wait(
      (id) => {
        const button = document.querySelector(`[data-testid="${id}"]`);
        return !!button && !button.disabled;
      },
      `dialog button ${testId} enabled`,
      { arg: testId },
    );
    await realClickAt(await centerOfTestId(testId, DIALOG), `dialog ${testId}`);
  }

  async function waitDialogGone() {
    await ui().wait(() => !document.querySelector('[data-testid="lumi-automation-dialog"]'), "dialog closed");
  }

  async function cancelDialog() {
    await pressDialog("lumi-automation-cancel");
    await waitDialogGone();
  }

  /** Escape through a real key event; the menu must actually be gone afterwards. */
  async function dismissMenu() {
    await page().press("Escape");
    await ui().wait((selector) => !document.querySelector(selector), "menu closed", { arg: MENU });
  }

  return {
    ui,
    dismissMenu,
    openAutomations,
    cardTitles,
    waitForCard,
    badgeOf,
    openCardMenu,
    menuTestIds,
    startHandOver,
    startAttach,
    attachOptions,
    chooseAttachOption,
    toggleAttachAck,
    dialogPhase,
    dialogText,
    dialogHas,
    waitPhase,
    waitOptionsLoaded,
    chooseByLabel,
    pressDialog,
    cancelDialog,
    waitDialogGone,
    realClickAt,
    centerOfTestId,
  };
}
