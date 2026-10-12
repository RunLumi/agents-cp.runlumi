// After the control plane revokes a device, the Worker deletes its tokens, so the desktop first sees
// an expired token and offers human-authorized recovery; recovery is then refused `device_revoked`
// and the desktop persists a terminal revoked state (LumiAgents DE2E-CLI-03/04). This drives that
// through the actual Settings UI and asserts the final state a user sees.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const RECOVER = '[data-testid="lumi-device-recover"]';
const REVOKED = '[data-testid="lumi-device-revoked"]';

/** Returns "recovery-refused" or "revoked-already" (when the app already knew). */
export async function confirmRevokedInUi(page, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  const state = async () =>
    page.evaluate(
      ({ recover, revoked }) => ({
        recover: !!document.querySelector(recover),
        revoked: !!document.querySelector(revoked),
      }),
      { recover: RECOVER, revoked: REVOKED },
    );
  let seen;
  // A user action (Sync) makes the app learn the refusal if it has not polled yet.
  await page.evaluate(() => {
    const sync = [...document.querySelectorAll("button")].find(
      (b) => b.innerText.trim() === "Sync policy" && !b.disabled,
    );
    sync?.click();
  });
  while (Date.now() < deadline) {
    seen = await state();
    if (seen.recover || seen.revoked) break;
    await delay(500);
  }
  assert.ok(seen?.recover || seen?.revoked, "revocation surfaces as recovery or revoked state");
  const path = seen.revoked ? "revoked-already" : "recovery-refused";
  if (!seen.revoked) {
    await page.evaluate((recover) => document.querySelector(recover).click(), RECOVER);
    while (Date.now() < deadline && !(await state()).revoked) await delay(500);
  }
  const final = await page.evaluate(
    ({ recover, revoked }) => ({
      revoked: !!document.querySelector(revoked),
      recover: !!document.querySelector(recover),
      syncEnabled: [...document.querySelectorAll("button")].some(
        (b) => b.innerText.trim() === "Sync policy" && !b.disabled,
      ),
      enroll: [...document.querySelectorAll("button")].some(
        (b) => b.innerText.trim() === "Confirm and enroll this device",
      ),
    }),
    { recover: RECOVER, revoked: REVOKED },
  );
  assert.equal(final.revoked, true, "the revoked state is shown");
  assert.equal(final.recover, false, "a revoked device is not offered recovery");
  assert.equal(final.syncEnabled, false, "policy sync is unavailable for a revoked device");
  assert.equal(final.enroll, false, "no silent re-enrollment is offered");
  return path;
}
