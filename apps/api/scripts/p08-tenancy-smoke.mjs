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
  //
  // V01 path-id-tenancy. `verify:path-id-tenancy` measures the org-scoped routes that take exactly ONE
  // resource id in the path, which is the largest block this probe reports as unproven and the one a
  // substitution attack is the only way to reach. For each it asserts FOUR things: the organization's own
  // id is not refused, the other organization's id is, a well-formed id that exists NOWHERE answers
  // IDENTICALLY (so the route is not an existence oracle), and the other organization's row is
  // byte-identical afterwards, read out of D1.
  //
  // Every entry is at FULL STRENGTH and none carries a degraded control. Three did once, and all three
  // are resolved: two were a real defect (V01-033 -- a `version` guard placed AFTER the statement it
  // guards, so the route could never succeed and reported `version_conflict`) and one was that gate's own
  // ordering (the revoke control revoked the credential the rotate control then used, so the rotate
  // control was refused 404 for an already-revoked row). Every control now creates its own row, so the
  // controls are independent by construction. The credits below therefore all read PLAIN: a credit that
  // names a degradation which no longer exists under-claims on purpose, and a stale one is simply wrong.
  {
    path: "/api/v1/orgs/{org_id}/agents/{agent_id}",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  // The automations family needs three things the others do not, and each was a fixture fault the control
  // caught rather than assumed: an `automations.max_active` entitlement, because `entitlement_grants` is
  // EMPTY in every seeded database and without it every create is refused for a reason that has nothing
  // to do with tenancy; a project and an agent, which an automation references; and for `resume` a prior
  // STATE rather than merely a prior row, since the handler transitions `"paused" -> "active"` and
  // refuses an automation that is not already paused.
  {
    path: "/api/v1/orgs/{org_id}/automations/{automation_id}",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/automations/{automation_id}/occurrences",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/automations/{automation_id}/pause",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/automations/{automation_id}/resume",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/automations/{automation_id}/run-now",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/members/{member_id}",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/invitations/{invitation_id}",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/invitations/{invitation_id}/resend",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/credentials/{credential_id}/revoke",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/credentials/{credential_id}/rotate",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/service-accounts/{service_account_id}",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/service-accounts/{service_account_id}/suspend",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  {
    path: "/api/v1/orgs/{org_id}/service-accounts/{service_account_id}/resume",
    by: "v01-path-id-tenancy-probe.mjs",
  },
  { path: "/api/v1/orgs/{org_id}/runs/{run_id}", by: "p05-smoke.mjs (2 cross-tenant negatives)" },
  //
  // V01-027. `verify:collection-tenancy` measures 25 org-scoped COLLECTION routes for leakage: as
  // Org A, fetch each one and search the whole serialised body for every identifier belonging to
  // Org B. That is a different proof from this probe's -- a collection route has no request that
  // should be refused, so a substitution cannot reach it -- and it is the proof that catches a
  // `WHERE` clause which forgot `org_id` and answered a perfectly authorised 200 with another
  // tenant's rows.
  //
  // Crediting them here is what keeps this probe's headline honest. Without it the number below
  // would stay at 80 while 25 of those routes are measured elsewhere, and a coverage figure that
  // overstates the gap is as misleading as one that understates it.
  //
  // The credit is for the routes that gate MEASURED. Nine of the ones it lists are deliberately
  // NOT credited, because it named them NOT_APPLICABLE -- seven answer 405 and two have no fixture
  // -- and "the other probe tried and could not" is not evidence.
  ...[
    "/api/v1/orgs/{org_id}",
    "/api/v1/orgs/{org_id}/agents",
    "/api/v1/orgs/{org_id}/api-keys",
    "/api/v1/orgs/{org_id}/approvals",
    "/api/v1/orgs/{org_id}/automations",
    "/api/v1/orgs/{org_id}/catalog",
    "/api/v1/orgs/{org_id}/catalog/models",
    "/api/v1/orgs/{org_id}/credentials",
    "/api/v1/orgs/{org_id}/data-policy",
    "/api/v1/orgs/{org_id}/deletions",
    "/api/v1/orgs/{org_id}/devices",
    "/api/v1/orgs/{org_id}/exports",
    "/api/v1/orgs/{org_id}/invitations",
    "/api/v1/orgs/{org_id}/mcp",
    "/api/v1/orgs/{org_id}/plugin-reports",
    "/api/v1/orgs/{org_id}/policy/tools",
    "/api/v1/orgs/{org_id}/rate-limits",
    "/api/v1/orgs/{org_id}/routes",
    "/api/v1/orgs/{org_id}/runs",
    "/api/v1/orgs/{org_id}/service-accounts",
    "/api/v1/orgs/{org_id}/sessions",
    "/api/v1/orgs/{org_id}/teams",
    "/api/v1/orgs/{org_id}/tools",
    "/api/v1/orgs/{org_id}/usage/denials",
    "/api/v1/orgs/{org_id}/usage/rollups",
    "/api/v1/orgs/{org_id}/webhooks",
  ].map((route) => ({
    path: route,
    by: "v01-collection-tenancy-probe.mjs (body searched for Org B ids)",
  })),
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

/**
 * Was a seeded resource created?
 *
 * Reports a SKIP rather than a failure, and records the response for the report. The
 * reasoning is in the report block below: a create this probe cannot drive is a limit
 * on the probe, and the routes it would have covered are already listed as unproven.
 */
function seedOk(label, result, id, prefix, failures) {
  if (typeof id === "string" && id.startsWith(prefix)) return true;
  const detail = `status=${result.status} body=${String(result.text).slice(0, 200)}`;
  failures.push(`${label}: ${detail}`);
  console.log(`  SKIP  seeded a ${label} in org A  — ${detail}`);
  return false;
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

  // --- substituted resource ids -------------------------------------------
  // A route that takes a resource id can only be tested by putting a REAL id from
  // org B into org A's path. Seeding one per surface is the honest way, and the
  // surfaces below are the ones whose create bodies are small enough to state
  // exactly. A surface whose creation is not cheap is left in the computed
  // unproven list rather than faked with a fabricated id, because a fabricated id
  // makes the route 404 for the wrong reason and proves nothing.
  probe.stage = "seeding";
  const seeded = [];
  const seedFailures = [];

  const seedProject = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/projects`,
    {
      name: "Alice Project",
      slug: `alice-project-${probe.nonce}`,
      visibility: "org",
    },
    probe.browserMutation(alice.jar, "project-a"),
  );
  const projectId =
    seedProject.payload?.id ?? seedProject.payload?.project_id ?? seedProject.payload?.project?.id;
  if (seedOk("project", seedProject, projectId, "prj_", seedFailures)) {
    seeded.push({
      label: "project",
      id: projectId,
      routes: [
        ["GET", "/api/v1/orgs/{org_id}/projects/{project_id}"],
        ["GET", "/api/v1/orgs/{org_id}/projects/{project_id}/access"],
        ["GET", "/api/v1/orgs/{org_id}/projects/{project_id}/bindings"],
      ],
    });
  }

  const seedAccount = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/service-accounts`,
    { name: "Alice Service Account", capabilities: [] },
    probe.browserMutation(alice.jar, "sa-a"),
  );
  // `create_service_account` answers `{ "service_account": { "id": … } }` — the
  // record's own identifier field is `id`, and the record is nested. Reading the
  // wrong shape is how the first run of this probe seeded nothing and reported a
  // missing resource instead of a shape mismatch.
  const accountId =
    seedAccount.payload?.service_account?.id ??
    seedAccount.payload?.service_account?.service_account_id ??
    seedAccount.payload?.service_account_id ??
    seedAccount.payload?.id;
  if (seedOk("service account", seedAccount, accountId, "svc_", seedFailures)) {
    seeded.push({
      label: "service account",
      id: accountId,
      routes: [["GET", "/api/v1/orgs/{org_id}/service-accounts/{service_account_id}"]],
    });
  }

  const seedTeam = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/teams`,
    {
      display_name: "Alice Team",
      slug: `alice-team-${probe.nonce}`,
    },
    probe.browserMutation(alice.jar, "team-a"),
  );
  // `create_team` answers with the record itself, so `team_id` is at the top level.
  const teamId =
    seedTeam.payload?.team_id ?? seedTeam.payload?.team?.team_id ?? seedTeam.payload?.id;
  if (seedOk("team", seedTeam, teamId, "team_", seedFailures)) {
    seeded.push({
      label: "team",
      id: teamId,
      routes: [["GET", "/api/v1/orgs/{org_id}/teams/{team_id}/members"]],
    });
  }

  // --- the substituted-id test ---------------------------------------------
  // Alice owns every seeded resource, so each of these must be readable by her and
  // invisible to org B's owner. Mallory is a member of org A and NOT of org B, so
  // the same substitution is run from both sides of the boundary.
  probe.stage = "substituted-ids";
  let idEvidenced = 0;
  for (const resource of seeded) {
    for (const [method, template] of resource.routes) {
      if (method !== "GET") {
        // A 405 is the router declining a method, which is a fact about the route
        // table and not about authorization. Driving it would put a line in the
        // report that reads like an authorization result and is not one.
        unproven.push(`${template} — ${method} needs a body this probe does not construct`);
        continue;
      }
      const asOwner = await request(
        alice.jar,
        method,
        template.replace("{org_id}", orgA.orgId).replace(/\{[a-z_]+\}/, resource.id),
      );
      const asOutsider = await request(
        mallory.jar,
        method,
        template.replace("{org_id}", orgB.orgId).replace(/\{[a-z_]+\}/, resource.id),
      );
      const asOtherOwner = await request(
        carol.jar,
        method,
        template.replace("{org_id}", orgB.orgId).replace(/\{[a-z_]+\}/, resource.id),
      );
      const label = `${resource.label} ${template.replace("/api/v1/orgs/{org_id}", "").replace(/\{[a-z_]+\}/, "{id}")}`;

      if (asOwner.status >= 200 && asOwner.status < 300) {
        if (
          (asOutsider.status >= 200 && asOutsider.status < 300) ||
          (asOtherOwner.status >= 200 && asOtherOwner.status < 300)
        ) {
          leaks.push(`${template} — a real org A id was readable under org B`);
          probe.fail(
            `${label} — the resource is invisible across the boundary`,
            `LEAK: outsider=${asOutsider.status} other-owner=${asOtherOwner.status}`,
          );
        } else if (
          statusIs(asOutsider, [404], ["resource_not_found"]) &&
          asOtherOwner.status === 404
        ) {
          idEvidenced += 1;
          const otherReason = reasonOf(asOtherOwner);
          probe.pass(
            `${label} — a real org A id is invisible under org B`,
            `owner=${asOwner.status} non-member=${asOutsider.status}/${reasonOf(asOutsider)} other-owner=${asOtherOwner.status}/${otherReason}`,
          );
        } else {
          unproven.push(
            `${template} — the plain non-member was ${asOutsider.status}/${reasonOf(asOutsider)} and the other owner ${asOtherOwner.status}/${reasonOf(asOtherOwner)}; the load-bearing check is a plain non-member refused as 404 resource_not_found`,
          );
          probe.skip(
            `${label} — refused, but not with the inaccessible-organization shape`,
            `outsider=${asOutsider.status}/${reasonOf(asOutsider)} other-owner=${asOtherOwner.status}/${reasonOf(asOtherOwner)}`,
          );
        }
      } else {
        unproven.push(
          `${template} — the owner's own call was ${asOwner.status}/${reasonOf(asOwner)}`,
        );
        probe.skip(
          `${label} — unproven, the owner's own call did not succeed`,
          `owner=${asOwner.status}/${reasonOf(asOwner)}`,
        );
      }
    }
  }

  // --- the report ----------------------------------------------------------
  // A route that has just been proven by substitution is no longer unproven, so it
  // leaves the computed list. Recomputing here rather than reusing the earlier number
  // is what keeps the headline honest as the seeding grows.
  const nowProven = new Set(
    seeded.flatMap((resource) => resource.routes.map(([, template]) => template)),
  );
  const stillUnproven = unprovenRoutes.filter((p) => !nowProven.has(p));
  const withId = stillUnproven.filter((p) => /\{[a-z_]+\}/.test(p.replace("{org_id}", ""))).length;
  const mutating = stillUnproven.length - withId;
  console.log(
    `\ncross-tenant: ${proven + idEvidenced}/${TESTED_HERE.length + nowProven.size} routes proven, ${leaks.length} leak(s), ${unproven.length} unproven among those`,
  );
  if (unproven.length > 0) {
    console.log("\nnot proven among the tested routes:");
    for (const line of unproven) console.log(`  - ${line}`);
  }
  console.log(
    `\norg-scoped routes with NO handler-level cross-tenant evidence: ${stillUnproven.length} of ${router.size}`,
  );
  //
  // The set itself, grouped by SHAPE and written out, because a count is not a work list.
  //
  // "80 of 104" says how much is unmeasured and nothing about what measuring it would take, and the
  // difference between those two is the whole plan: a `GET` by id needs a substituted identifier and
  // no body, while a `PUT` needs a valid body to reach its authorization check at all, and a nested
  // route needs its parents to exist. Grouping by shape is what turns the gap into a sequence of
  // attacks that can be ordered by cost, instead of 80 separate decisions.
  //
  // It is also the honest denominator for any claim of "the boundary is proven": a route in
  // `byIdNoBody` has no evidence merely because nobody has built a table row for it yet.
  const shapeOf = (path) => {
    const rest = path.replace("/api/v1/orgs/{org_id}", "");
    const ids = (rest.match(/\{[a-z_]+\}/g) ?? []).length;
    if (ids === 0) return "collection (no path id)";
    if (ids === 1) return "one path id";
    if (ids === 2) return "two path ids (nested)";
    return `${ids} path ids`;
  };
  const byShape = new Map();
  for (const path of stillUnproven) {
    const shape = shapeOf(path);
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape).push(path);
  }
  console.log("\nunproven org-scoped routes, by shape:");
  for (const [shape, paths] of [...byShape].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(paths.length).padStart(3)}  ${shape}`);
    for (const path of paths) console.log(`         ${path}`);
  }
  console.log(`  ${withId} take a resource id, so they need a real resource to substitute`);
  console.log(`  ${mutating} are mutating or id-less actions this probe does not drive`);
  console.log("  they are:" + stillUnproven.map((p) => `\n    ${p}`).join(""));

  // A seed that cannot be created is a limitation of THIS probe, not a demonstrated
  // product failure: the routes it would have covered stay in the list above, and
  // naming the response here is what keeps that visible. Recording it as a failure
  // instead would leave the gate permanently red for a cause nobody has diagnosed,
  // and a gate that is always red is a gate nobody reads.
  if (seedFailures.length > 0) {
    console.log(
      "\nOPEN LEADS — resources this probe could not create, so their routes are unproven:",
    );
    for (const lead of seedFailures) console.log(`  - ${lead}`);
    // The Worker's own log, and specifically because a lead you cannot diagnose
    // is a lead you cannot act on. The response body read "the usage store is
    // unavailable" for a request that never touched the usage store, and the
    // reason was being discarded before it reached a log line -- so the probe
    // reported a symptom and nothing could be done with it. The product now logs
    // it; without printing it here, that line is written and never read.
    //
    // Only when there are leads, and only the tail: a diagnostic, not a transcript.
    const log = probe.workerLog();
    if (log.trim()) {
      console.log("\n--- Worker log (tail) — the leads above, with their causes ---");
      console.log(log);
    }
  }

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
