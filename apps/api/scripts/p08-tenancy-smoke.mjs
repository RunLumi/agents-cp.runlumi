#!/usr/bin/env node
// VI-TEN-001 (handler half) — can a principal in one organization reach another
// organization's data by putting that organization's id in the path?
//
// WHY THIS PROBE EXISTS
//
// `VI-TEN-001` is Tier 0. The reconstruction passed it, and correctly, on the
// evidence that existed: the tenant audit proves every SQL statement touching a
// tenant-owned table is classified, and `p05-smoke.mjs` substitutes across two
// routes over real HTTP. The record's own limit line says the rest:
//
//   "the audit itself states it does not prove routes call the right statement"
//
// So for almost every org-scoped route the guarantee was **statement-level only**.
// That is a Tier-0 gap, and `next-verification-actions.md` action 5.1 names it as
// the largest in-repo hole. This probe is the part of 5.1 that needs no external
// dependency.
//
// THE DESIGN, AND WHY IT IS NOT SIMPLER
//
// The obvious test — "org A asks for org B, expect a 403" — proves nothing. A
// handler that never consults the membership table and then fails to find the
// resource returns 404 for the same reason a correct handler does, and the probe
// cannot tell the two apart. That is the wrong-reason kill, and `GUARD-2` in the
// mutation campaign is the same mistake.
//
// So every route is asked **twice**, plus the mirror:
//
//   1. as a member of the organization   -> must be 2xx, even with nothing in it,
//                                          because an empty list is still a 200;
//   2. as a plain member of ANOTHER org  -> must be 404 `resource_not_found`;
//   3. as the OTHER org's owner          -> the same.
//
// A route counts as PROVEN only when (1) succeeded and both (2) and (3) were
// refused in the shape the product uses for an inaccessible organization. When (1)
// is not 2xx there is nothing to leak and nothing to distinguish, so the route is
// reported UNPROVEN with the reason rather than quietly counted as a pass.
//
// WHY THE UNPROVEN SET IS COMPUTED RATHER THAN LISTED
//
// The router has 104 org-scoped routes. A hand-written "not covered" list of the
// other 86 would be a list nobody maintains: someone adds a route, the list stays
// right, and the gap is invisible. Reading `app.rs` instead means a new route
// lands in the unproven bucket by construction and the reported count moves, so
// the number cannot stay flattering. The two lists below are therefore only the
// routes with a POSITIVE claim — the ones tested here, and the one p05-smoke
// already substitutes across.
//
// Usage:
//   node apps/api/scripts/p08-tenancy-smoke.mjs
//
// Needs a built Worker (`pnpm build`) or it builds one, plus wrangler. Takes a few
// minutes. Start no Worker of your own on the port it prints.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runProbe } from "./lib/smoke-harness.mjs";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Org-scoped GET routes with no resource id. Testable with no seeding. */
const TESTED_HERE = [
  { module: "ai_catalog", path: "/api/v1/orgs/{org_id}/catalog" },
  { module: "ai_catalog", path: "/api/v1/orgs/{org_id}/credentials" },
  { module: "ai_catalog", path: "/api/v1/orgs/{org_id}/routes" },
  { module: "audit", path: "/api/v1/orgs/{org_id}/audit" },
  { module: "automations", path: "/api/v1/orgs/{org_id}/automations" },
  { module: "billing", path: "/api/v1/orgs/{org_id}/billing/subscription" },
  { module: "billing", path: "/api/v1/orgs/{org_id}/entitlements" },
  { module: "billing", path: "/api/v1/orgs/{org_id}/entitlements/provider" },
  { module: "data_governance", path: "/api/v1/orgs/{org_id}/data-policy" },
  { module: "data_governance", path: "/api/v1/orgs/{org_id}/deletions" },
  { module: "data_governance", path: "/api/v1/orgs/{org_id}/exports" },
  { module: "machine_identity", path: "/api/v1/orgs/{org_id}/api-keys" },
  { module: "machine_identity", path: "/api/v1/orgs/{org_id}/service-accounts" },
  { module: "migration", path: "/api/v1/orgs/{org_id}/adoption/bindings" },
  { module: "migration", path: "/api/v1/orgs/{org_id}/adoption/remediations" },
  { module: "plugins", path: "/api/v1/orgs/{org_id}/plugins" },
  { module: "webhooks", path: "/api/v1/orgs/{org_id}/notification-preferences" },
  { module: "webhooks", path: "/api/v1/orgs/{org_id}/webhooks" },
];

/**
 * Routes with a positive handler-level claim from ANOTHER gate.
 *
 * `p05-smoke.mjs` asserts two cross-tenant negatives on this one: a second user
 * cannot read tenant A's run, and tenant B's path cannot read tenant A's run by
 * id. The V00 record described p05's coverage as "device, run, member, session,
 * budget"; reading the script, it is run and device, and the device case is on a
 * non-org-scoped path. This list is the accurate version, and the record is
 * corrected to match.
 */
const ALSO_PROVEN = [
  { path: "/api/v1/orgs/{org_id}/runs/{run_id}", by: "p05-smoke.mjs (2 cross-tenant negatives)" },
];

/** Every org-scoped path the router registers, read from `app.rs`. */
function routerOrgRoutes() {
  const app = readFileSync(join(apiDir, "src", "app.rs"), "utf8");
  const constRe = /pub const ([A-Z0-9_]+): &str = "([^"]+)"/g;
  const routes = new Map();
  for (const match of app.matchAll(/\.route\(\s*([^,]+?)\s*,\s*(.*?)\n\s*\)/gs)) {
    const [, pathExpr, methods] = match;
    const handler = /([a-z_]+)::[A-Za-z_]+/.exec(methods);
    if (!handler) continue;
    let path;
    const trimmed = pathExpr.trim();
    if (trimmed.startsWith('"')) {
      path = trimmed.replaceAll('"', "");
    } else {
      const ref = /^([a-z_]+)::([A-Z0-9_]+)$/.exec(trimmed);
      if (!ref) continue;
      let file;
      try {
        file = readFileSync(join(apiDir, "src", "routes", `${ref[1]}.rs`), "utf8");
      } catch {
        continue;
      }
      const table = {};
      for (const c of file.matchAll(constRe)) table[c[1]] = c[2];
      path = table[ref[2]];
    }
    if (path?.includes("/orgs/{org_id}")) {
      routes.set(path, { module: handler[1], isGet: /\bget\(/.test(methods) });
    }
  }
  return routes;
}

await runProbe("P08 cross-tenant", async (probe) => {
  const { request, reasonOf, statusIs } = probe;

  console.log("");
  await probe.setup();

  // --- the accounting, computed from the router ----------------------------
  probe.stage = "coverage";
  const router = routerOrgRoutes();
  const tested = new Set(TESTED_HERE.map((r) => r.path));
  const elsewhere = new Set(ALSO_PROVEN.map((r) => r.path));

  // A tested route the router no longer has is a bug in this file, not a gap in
  // the product: the probe would be asserting against something that is gone.
  const stale = [...tested].filter((path) => !router.has(path));
  probe.expect(
    "every route this probe claims to test is still in the router",
    stale.length === 0,
    stale.length === 0 ? `${tested.size} tested routes, all present` : `stale: ${stale.join(", ")}`,
  );
  const staleElsewhere = [...elsewhere].filter((path) => !router.has(path));
  probe.expect(
    "every route credited to another gate is still in the router",
    staleElsewhere.length === 0,
    staleElsewhere.length === 0
      ? `${elsewhere.size} credited routes, all present`
      : `stale: ${staleElsewhere.join(", ")}`,
  );

  // Everything the router has that this probe does not test, computed rather than
  // listed. A new route lands here by construction.
  const unprovenRoutes = [...router.keys()]
    .filter((path) => !tested.has(path) && !elsewhere.has(path))
    .sort();
  probe.pass(
    "the unproven set is computed from the router, so a new route cannot be forgotten",
    `${router.size} org-scoped routes: ${tested.size} tested here, ${elsewhere.size} proven elsewhere, ${unprovenRoutes.length} with no handler-level evidence`,
  );

  // --- fixtures ------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const carol = await probe.authenticatedUser("Carol");
  const mallory = await probe.authenticatedUser("Mallory");
  const orgA = await probe.createOrganization(alice.jar, "Alice Org", `alice-org-${probe.nonce}`);
  const orgB = await probe.createOrganization(carol.jar, "Carol Org", `carol-org-${probe.nonce}`);
  // A plain member of A, so "is a member at all" and "is an owner" are separate
  // facts and a route that authorizes only owners is not mistaken for a leak.
  await probe.inviteAndAccept(alice, mallory, orgA.orgId, "member");

  // --- the pair test -------------------------------------------------------
  probe.stage = "cross-tenant";
  let proven = 0;
  const unproven = [];
  const leaks = [];

  for (const route of TESTED_HERE) {
    const at = (orgId) => route.path.replace("{org_id}", orgId);
    const asMember = await request(alice.jar, "GET", at(orgA.orgId));
    const asPlainMemberOfOther = await request(mallory.jar, "GET", at(orgB.orgId));
    const asOtherOwner = await request(carol.jar, "GET", at(orgA.orgId));
    const label = `${route.module} ${route.path.replace("/api/v1/orgs/{org_id}", "") || "/"}`;

    if (asMember.status < 200 || asMember.status >= 300) {
      unproven.push(
        `${route.path} — the member's own call was ${asMember.status}/${reasonOf(asMember)}, so there is nothing to leak and nothing to distinguish`,
      );
      probe.skip(
        `${label} — unproven, the member's own call did not succeed`,
        `member=${asMember.status}/${reasonOf(asMember)}`,
      );
      continue;
    }

    const outsiderLeak = asPlainMemberOfOther.status >= 200 && asPlainMemberOfOther.status < 300;
    const ownerLeak = asOtherOwner.status >= 200 && asOtherOwner.status < 300;
    if (outsiderLeak || ownerLeak) {
      const which = outsiderLeak ? "a plain member of another org" : "another org's owner";
      const result = outsiderLeak ? asPlainMemberOfOther : asOtherOwner;
      leaks.push(`${route.path} — ${which} received ${result.status}`);
      probe.fail(
        `${label} — ${which} is refused`,
        `LEAK: status=${result.status} body=${String(result.text).slice(0, 200)}`,
      );
      continue;
    }

    const refused =
      statusIs(asPlainMemberOfOther, [404], ["resource_not_found"]) &&
      statusIs(asOtherOwner, [404], ["resource_not_found"]);
    if (refused) {
      proven += 1;
      probe.pass(
        `${label} — refused to both outsiders as 404 resource_not_found`,
        `member=${asMember.status} plain-member=${asPlainMemberOfOther.status} other-owner=${asOtherOwner.status}`,
      );
    } else {
      unproven.push(
        `${route.path} — refused, but not in the inaccessible-organization shape: plain member ${asPlainMemberOfOther.status}/${reasonOf(asPlainMemberOfOther)}, other owner ${asOtherOwner.status}/${reasonOf(asOtherOwner)}`,
      );
      probe.skip(
        `${label} — refused, but not with the inaccessible-organization shape`,
        `plain-member=${asPlainMemberOfOther.status}/${reasonOf(asPlainMemberOfOther)} other-owner=${asOtherOwner.status}/${reasonOf(asOtherOwner)}`,
      );
    }
  }

  // --- the report ----------------------------------------------------------
  const withId = unprovenRoutes.filter((p) => /\{[a-z_]+\}/.test(p.replace("{org_id}", ""))).length;
  const mutating = unprovenRoutes.length - withId;
  console.log(
    `\ncross-tenant: ${proven}/${TESTED_HERE.length} tested routes proven, ${leaks.length} leak(s), ${unproven.length} unproven among those`,
  );
  if (unproven.length > 0) {
    console.log("\nnot proven among the tested routes:");
    for (const line of unproven) console.log(`  - ${line}`);
  }
  console.log(
    `\norg-scoped routes with NO handler-level cross-tenant evidence: ${unprovenRoutes.length} of ${router.size}`,
  );
  console.log(`  ${withId} take a resource id, so they need a real resource to substitute`);
  console.log(`  ${mutating} are mutating or id-less actions this probe does not drive`);
  console.log("  they are:" + unprovenRoutes.map((p) => `\n    ${p}`).join(""));

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
