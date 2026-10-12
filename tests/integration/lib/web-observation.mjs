// Journey D web observation: the org owner sees a desktop-produced managed run in the actual web
// control plane (runs, usage and audit views) with the same identifiers D1 recorded, and another
// organization's owner sees none of them on the same URLs. Graded on rendered text plus D1 ids;
// a positive control (the owner sees the ids) precedes the tenant attack.
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launch, newPage } from "../../../apps/web/scripts/cdp.mjs";

async function signedInPage(chrome, origin, jar) {
  const page = await newPage(chrome);
  await page.send("Network.enable", {});
  await page.send("Network.clearBrowserCookies", {});
  for (const [name, value] of jar.cookies.entries())
    await page.send("Network.setCookie", { name, value, url: `${origin}/`, path: "/" });
  await page.setViewport(1440, 1100);
  return page;
}

async function textOf(page, url, ready, label, timeout = 30_000) {
  await page.goto(url);
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (ready(text)) return text;
    if (Date.now() > deadline) return text;
    await delay(500);
  }
}

/**
 * @param ids { runId, requestId, deviceId, projectId } read from D1 for one desktop run.
 * Returns named claims; throws on the first failed assertion.
 */
export async function observeRunInWeb({ probe, web, ownerJar, org, ids, evidenceDir }) {
  const origin = `http://127.0.0.1:${web.port}`;
  const base = `${origin}/org/${org.slug}`;
  const chrome = await launch({ port: await probe.availablePort(), headless: true });
  const claims = [];
  try {
    const owner = await signedInPage(chrome, origin, ownerJar);
    const runs = await textOf(
      owner,
      `${base}/runs`,
      (t) => t.includes(ids.runId.slice(0, 12)),
      "runs",
    );
    await owner.screenshot(join(evidenceDir, "web-runs.png"));
    assert.ok(runs.includes(ids.runId.slice(0, 12)), "runs view lists the desktop run");
    const usage = await textOf(
      owner,
      `${base}/usage`,
      (t) => t.includes(ids.runId.slice(0, 12)),
      "usage",
    );
    await owner.screenshot(join(evidenceDir, "web-usage.png"));
    assert.ok(usage.includes(ids.runId.slice(0, 12)), "usage view attributes usage to the run");
    const audit = await textOf(
      owner,
      `${base}/audit?run_id=${ids.runId}`,
      (t) => t.includes(ids.runId),
      "audit",
    );
    await owner.screenshot(join(evidenceDir, "web-audit.png"));
    assert.ok(audit.includes(ids.runId), "audit view filters to the desktop run");
    assert.ok(audit.includes(ids.deviceId), "audit rows name the executing device");
    claims.push(
      `owner sees the desktop run ${ids.runId} in runs, usage and audit (device ${ids.deviceId}) in the actual web control plane`,
    );

    // Tenant attack: another organization's owner on the same URLs.
    const { jar: foreign } = await probe.authenticatedUser("Foreign web owner");
    await probe.createOrganization(foreign, "Foreign web org", `foreign-web-${probe.nonce}`);
    const attacker = await signedInPage(chrome, origin, foreign);
    for (const path of ["runs", "usage", `audit?run_id=${ids.runId}`]) {
      const text = await textOf(attacker, `${base}/${path}`, () => false, path, 6_000);
      for (const [name, value] of Object.entries(ids))
        assert.equal(text.includes(value), false, `foreign owner ${path} discloses ${name}`);
    }
    await attacker.screenshot(join(evidenceDir, "web-foreign-audit.png"));
    claims.push("another organization's owner sees none of the run's identifiers on the same URLs");
  } finally {
    await chrome.close();
  }
  return claims;
}
