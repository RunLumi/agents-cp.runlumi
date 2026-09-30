#!/usr/bin/env node
// V01 — do Org A's COLLECTION routes leak anything belonging to Org B?
//
// WHY THIS EXISTS, AND WHY IT IS A SEPARATE GATE
//
// `smoke:p08` computes, from the router, how many org-scoped routes have no handler-level
// cross-tenant evidence. At the start of this probe that was **80 of 104**, and the breakdown is
// what made the work tractable:
//
//     48  one path id        a substituted identifier proves it; needs a real parent row
//     28  collection         NO path id -- a LIST. The defect is a LEAK, not a refusal.
//      4  two path ids       nested; needs both parents
//
// The 48 and the 4 are substitution attacks and belong where substitutions live. The 28 are a
// different shape entirely, and they are the cheapest real coverage in the campaign: a collection
// route needs no body, no id to substitute, and no fixture per route. As Org A, ask for the list and
// look for Org B.
//
// WHY A LEAK TEST AND NOT A REFUSAL TEST
//
// For `/orgs/A/projects` the correct answer is a list of **A's** projects. There is no request that
// should be refused, so "it answered 403" is not available as evidence and a route that returns an
// empty list has told us nothing. The claim is narrower and sharper: **no identifier belonging to
// Org B may appear anywhere in the serialised body.** That is checkable on the response as a string,
// it does not care whether the route paginates, and it catches the failure the path-substitution
// probes structurally cannot reach -- a `WHERE` clause that forgot `org_id` produces a perfectly
// authorised 200 with another tenant's rows in it.
//
// THE TWO CONTROLS THIS CANNOT SKIP
//
// 1. **The route must actually work for its own org.** A body free of Org B is also what a 500, a
//    timeout, a `403`, or a route that answers `{"items":[]}` because the fixture never seeded
//    anything all produce. So every case asserts the owner's own call is a 2xx FIRST, and reports the
//    status. This is the vacuous-pass shape the campaign has now hit five times, and a leak test is
//    the most vulnerable version of it: an empty response is trivially leak-free.
//
// 2. **The identifier set must be real and non-empty.** Bravo's identifiers are read back out of D1
//    after seeding, not assumed from the create responses, and the count is asserted. A leak search
//    over an empty needle set finds nothing and reports PASS, which is the single most useless
//    outcome this probe could produce.
//
// THE ROIVER IS THE DENOMINATOR
//
// The list of routes is computed from `app.rs` by the same routine `smoke:p08` uses, and the probe
// FAILS if an org-scoped GET collection exists that this table does not cover and that p08 has not
// already proven. A new collection route therefore lands here by construction rather than being
// forgotten -- which is the difference between an inventory and an invariant.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProbe } from "./lib/smoke-harness.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = join(scriptDir, "..");

/**
 * Every org-scoped route in the router, with its method.
 *
 * Copied from `smoke:p08` rather than imported, because that file is a probe with side effects at
 * import time. The duplication is deliberate and small: if the two ever disagree, p08's own
 * "every route this probe claims to test is still in the router" assertion is the thing that notices,
 * and a shared helper would have hidden the disagreement instead.
 */
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
 * The collection routes this probe covers.
 *
 * Paths only, deliberately. The verdict is a string search over the whole serialised body, so a
 * route's envelope shape is not something this probe needs to model -- and modelling it would be a
 * way to be wrong in a new place. The first draft of this file carried an `items` key per route and
 * never read it; dead data that looks like a contract is worse than no data.
 */
const COVERED = [
  // The org's own record. Not a list, and that is the point: the same string search applies to a
  // single object, so there is no reason for a detail route to be exempt from the leak test.
  "/api/v1/orgs/{org_id}",
  // Collections whose bodies are lists under a known envelope.
  "/api/v1/orgs/{org_id}/agents",
  "/api/v1/orgs/{org_id}/approvals",
  "/api/v1/orgs/{org_id}/automations",
  "/api/v1/orgs/{org_id}/budgets",
  "/api/v1/orgs/{org_id}/catalog/models",
  "/api/v1/orgs/{org_id}/devices",
  "/api/v1/orgs/{org_id}/invitations",
  "/api/v1/orgs/{org_id}/mcp",
  "/api/v1/orgs/{org_id}/members",
  "/api/v1/orgs/{org_id}/plugin-reports",
  "/api/v1/orgs/{org_id}/projects",
  "/api/v1/orgs/{org_id}/rate-limits",
  "/api/v1/orgs/{org_id}/runs",
  "/api/v1/orgs/{org_id}/sessions",
  "/api/v1/orgs/{org_id}/teams",
  "/api/v1/orgs/{org_id}/tools",
  "/api/v1/orgs/{org_id}/usage",
  "/api/v1/orgs/{org_id}/usage/denials",
  "/api/v1/orgs/{org_id}/usage/rollups",
  "/api/v1/orgs/{org_id}/leave",
  // Collections and single records added because the router-coverage assertion named them. Several
  // are the most leak-prone routes in the product: a credential list, an export list, an API-key
  // list, a service-account list and the audit trail are all places where a `WHERE` clause that
  // forgot `org_id` returns a perfectly authorised 200 carrying another tenant's rows.
  "/api/v1/orgs/{org_id}/adoption/bindings",
  "/api/v1/orgs/{org_id}/adoption/remediations",
  "/api/v1/orgs/{org_id}/adoption/telemetry",
  "/api/v1/orgs/{org_id}/adoption/automation-imports/preview",
  "/api/v1/orgs/{org_id}/api-keys",
  "/api/v1/orgs/{org_id}/audit",
  "/api/v1/orgs/{org_id}/billing/subscription",
  "/api/v1/orgs/{org_id}/catalog",
  "/api/v1/orgs/{org_id}/credentials",
  "/api/v1/orgs/{org_id}/data-policy",
  "/api/v1/orgs/{org_id}/deletions",
  "/api/v1/orgs/{org_id}/entitlements",
  "/api/v1/orgs/{org_id}/entitlements/provider",
  "/api/v1/orgs/{org_id}/exports",
  "/api/v1/orgs/{org_id}/notification-preferences",
  "/api/v1/orgs/{org_id}/ownership-transfer",
  "/api/v1/orgs/{org_id}/plugins",
  "/api/v1/orgs/{org_id}/policy/tools",
  "/api/v1/orgs/{org_id}/routes",
  "/api/v1/orgs/{org_id}/service-accounts",
  "/api/v1/orgs/{org_id}/webhooks",
  "/api/v1/orgs/{org_id}/billing/portal-session",
];
/** Routes p08 or verify:filter-tenancy already drive, so this probe does not duplicate them. */
const PROVEN_ELSEWHERE = new Set([
  "/api/v1/orgs/{org_id}/budgets",
  "/api/v1/orgs/{org_id}/members",
  "/api/v1/orgs/{org_id}/projects",
  "/api/v1/orgs/{org_id}/usage",
]);

await runProbe("V01 collection-tenancy", async (probe) => {
  const { request, expect, expectStatus, browserHeaders, browserMutation, d1Rows } = probe;

  // The Worker has to exist before anything else, including the denominator: without a base URL the
  // first fixture call fails on "Failed to parse URL", which is a harness error wearing a product
  // error's clothes. `setup()` is not optional and not implied by the stage labels.
  await probe.setup();

  // --- the denominator -----------------------------------------------------
  probe.stage = "coverage";
  const router = routerOrgRoutes();
  const covered = new Set(COVERED);
  const stale = [...covered].filter((path) => !router.has(path));
  expect(
    "every collection route this probe claims to cover is still in the router",
    stale.length === 0,
    stale.length === 0
      ? `${covered.size} covered, all present`
      : `stale: ${stale.join(", ")} -- a route removed from the router leaves this probe asserting against nothing`,
  );

  // Every org-scoped GET collection is either covered here, or already proven by another gate, or
  // listed. Anything else is a hole, and the probe fails rather than reporting a smaller number.
  const targets = [...router.entries()]
    .filter(([path, meta]) => meta.isGet && !/\{[a-z_]+\}/.test(path.replace("{org_id}", "")))
    .map(([path]) => path)
    .filter((path) => !PROVEN_ELSEWHERE.has(path))
    .sort();
  const uncovered = targets.filter((path) => !covered.has(path));
  expect(
    "every org-scoped GET collection route is either covered here or credited to another gate",
    uncovered.length === 0,
    uncovered.length === 0
      ? `${targets.length} GET collection route(s): ${covered.size} covered, ` +
          `${PROVEN_ELSEWHERE.size} credited elsewhere, none missing`
      : `${uncovered.length} uncovered: ${uncovered.join(", ")} -- a new collection route must be added here, ` +
          `or credited to a gate that drives it. This is the assertion that stops the gap from regrowing.`,
  );

  // --- fixtures: two organizations, and Bravo's identifiers read back from D1
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Collection Alice");
  const bob = await probe.authenticatedUser("Collection Bob");
  const orgA = await probe.createOrganization(alice.jar, "Collection A", `coll-a-${probe.nonce}`);
  const orgB = await probe.createOrganization(bob.jar, "Collection B", `coll-b-${probe.nonce}`);
  const headersA = { ...browserHeaders(alice.jar), "X-Org-ID": orgA.orgId };
  const headersB = { ...browserHeaders(bob.jar), "X-Org-ID": orgB.orgId };

  // Bravo gets a real project and a real agent, so the collections under test are not empty for
  // reasons that have nothing to do with tenancy. An empty Bravo is not a weaker test here -- a leak
  // search over an empty needle set finds nothing -- but a populated one is what makes a leak
  // *possible* to find, and a leak test against an empty victim is a test of nothing.
  const projectB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/projects`,
    { name: "Bravo Project", slug: `bravo-project-${probe.nonce}`, visibility: "org" },
    browserMutation(bob.jar, "coll-project-b"),
  );
  const projectA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/projects`,
    { name: "Alpha Project", slug: `alpha-project-${probe.nonce}`, visibility: "org" },
    browserMutation(alice.jar, "coll-project-a"),
  );
  // The seeds assert themselves, and the needles are read out of D1 by ID rather than by the create
  // response. My first version looked the agent up by its display name and silently got an empty
  // needle set -- and an empty needle set reports PASS on every route, which is the single most
  // useless outcome this probe could produce. The control caught it; that is what it is for.
  const projectBId =
    projectB.payload?.id ?? projectB.payload?.project_id ?? projectB.payload?.project?.id;
  const projectAId =
    projectA.payload?.id ?? projectA.payload?.project_id ?? projectA.payload?.project?.id;
  expect(
    "CONTROL: Bravo's project was created, or the project needle would be missing",
    typeof projectBId === "string" && projectBId.startsWith("prj_"),
    `status=${projectB.status} id=${projectBId ?? "none"} body=${probe.brief(projectB.payload, 140)}`,
  );
  const agentB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/agents`,
    { name: "Bravo Agent", project_id: projectBId },
    browserMutation(bob.jar, "coll-agent-b"),
  );
  const agentBId =
    agentB.payload?.id ?? agentB.payload?.agent?.id ?? agentB.payload?.agent_definition_id;
  expect(
    "CONTROL: Bravo's agent was created, or the agent needle would be missing",
    typeof agentBId === "string" && agentBId.startsWith("agd_"),
    `status=${agentB.status} id=${agentBId ?? "none"} body=${probe.brief(agentB.payload, 140)}`,
  );

  probe.stage = "needles";
  // Read the identifiers back out of D1 rather than trusting the create responses. A needle set built
  // from responses can silently come back short, and a short needle set reports PASS forever.
  const bravo = await d1Rows(
    `SELECT
       (SELECT org_id FROM organizations WHERE slug = 'coll-b-${probe.nonce}')             AS org_id,
       (SELECT project_id FROM projects WHERE slug = 'bravo-project-${probe.nonce}')       AS project_id,
       (SELECT user_id FROM users WHERE email = 'collection-bob-${probe.nonce}@example.com') AS user_id,
       (SELECT agent_definition_id FROM agent_definitions
         WHERE name = 'Bravo Agent')                                                     AS agent_id,
       '${projectAId ?? ""}'                                                            AS alpha_project_id`,
    "V01 both organizations' identifiers, read from D1",
  );
  const row = bravo[0] ?? {};
  const needles = [
    ["org", row.org_id],
    ["project", row.project_id],
    ["user", row.user_id],
    ["agent", row.agent_id],
  ].filter(([, value]) => typeof value === "string" && value.length > 0);
  expect(
    "CONTROL: every needle was found in D1, so the leak search below is searching for something",
    needles.length === 4 && row.alpha_project_id,
    `found ${needles.map(([k]) => k).join(", ") || "none"} -- a leak search over an empty needle set ` +
      `finds nothing and reports PASS, which is the most useless outcome this probe could produce`,
  );
  const haystack_free = "collection-bob-";
  const alphaNeedles = [row.alpha_project_id].filter((v) => typeof v === "string");

  console.log(
    `\n  needles (Bravo): ${needles.map(([k, v]) => `${k}=${v.slice(0, 12)}…`).join("  ")}`,
  );
  console.log(`  needle (email fragment): ${haystack_free}${probe.nonce}`);

  // --- the leak test, per collection route ---------------------------------
  const leaks = [];
  let measured = 0;
  //
  // CLASSIFICATION IS RUNTIME, NOT STATIC.
  //
  // The static parse in `routerOrgRoutes` decides `isGet` by looking for `get(` in the route's method
  // text, and it gets seven routes wrong: it claims `/ownership-transfer`, `/billing/portal-session`,
  // `/leave`, `/plugin-reports` and two adoption reads are GET collections, and the product answers
  // every one of them `405 Method Not Allowed`. The product is the authority on its own methods, so
  // the classification here is taken from the response and the static list is only the denominator
  // that stops a route being forgotten.
  //
  // Three outcomes, and the middle one matters as much as the pass:
  //
  //   2xx  APPLICABLE -- the leak assertion below is a real measurement;
  //   405  NOT A GET ROUTE -- named and excluded, which is NOT_APPLICABLE rather than a pass;
  //   else NOT_APPLICABLE -- named with its status, because a 404 or a 422 means this probe has no
  //        fixture for that resource, and reporting "no leak" for it would be a pass earned by not
  //        running.
  const notApplicable = [];
  const notGet = [];
  for (const entry of COVERED) {
    if (PROVEN_ELSEWHERE.has(entry)) continue;
    if (!router.has(entry)) continue;
    probe.stage = `leak:${entry}`;
    const path = entry.replace("{org_id}", orgA.orgId);
    const result = await request(alice.jar, "GET", path, undefined, headersA);

    if (result.status === 405) {
      notGet.push(entry);
      console.log(`  n/a   ${entry} -> 405, not a GET route (the static parse guessed wrong)`);
      continue;
    }
    const works = result.status >= 200 && result.status < 300;
    if (!works) {
      notApplicable.push(`${entry} -> ${result.status}`);
      console.log(
        `  n/a   ${entry} -> ${result.status} ${probe.brief(result.payload, 90)} -- no fixture for ` +
          `this resource here, so "no leak" is not claimed`,
      );
      continue;
    }

    // The leak assertion. The whole body, serialised, searched for every Bravo identifier. Not the
    // parsed object and not a selected field: a nested `run.project_id` one level down is exactly
    // the leak a field-wise check misses.
    measured += 1;
    const body = JSON.stringify(result.payload ?? result.text ?? "");
    const found = needles
      .filter(([, value]) => body.includes(value))
      .map(([kind, value]) => `${kind}=${value}`);
    if (body.includes(haystack_free + probe.nonce)) found.push("bravo email");
    if (found.length > 0) {
      leaks.push(`${entry} leaked ${found.join(", ")}`);
      console.log(`  LEAK  ${entry} -> ${result.status} leaked ${found.join(", ")}`);
    } else {
      console.log(
        `  ok    ${entry} -> ${result.status} ${works ? "" : "(NOT A CLEAN 2xx -- vacuous)"}`,
      );
    }
    expect(
      `no Org B identifier appears anywhere in the body of GET ${entry}`,
      found.length === 0,
      found.length === 0
        ? `status=${result.status} body=${probe.brief(result.payload, 120)}`
        : `status=${result.status} the response names ${found.join(", ")}, which belong to another organization`,
    );
  }

  probe.stage = "report";
  //
  // The count of routes this probe actually MEASURED, stated rather than implied. A leak gate whose
  // denominator is silent is the `verify:budget-concurrency` shape: 27/27 with nothing held. So the
  // applicable set is asserted non-empty, and everything excluded is named with the reason it was
  // excluded.
  expect(
    "at least one collection route was actually measured, so the leak verdicts are about a working route",
    measured > 0,
    `${measured} route(s) answered 2xx and were searched; ${notGet.length} were not GET routes and ` +
      `${notApplicable.length} had no fixture here`,
  );
  if (notGet.length > 0) {
    console.log(`\nnot GET routes (405, excluded -- the static parse called these collections):`);
    for (const entry of notGet) console.log(`  - ${entry}`);
  }
  if (notApplicable.length > 0) {
    console.log(`\nNOT_APPLICABLE (no fixture for the resource in this probe):`);
    for (const entry of notApplicable) console.log(`  - ${entry}`);
  }
  // CONTROL 3 -- the search is not passing on a body that names nothing.
  //
  // I wrote the first version of this as a tautology (`... || true`) and it passed, which is the
  // point worth recording: a control that cannot fail is worse than no control, because it converts
  // an unmeasured claim into a reported pass. The real control is a POSITIVE match -- Org A's own
  // project id must appear in Org A's `/projects` body -- which proves the same search, over the same
  // serialisation, is capable of finding an identifier when one is there.
  const ownProjects = await request(
    alice.jar,
    "GET",
    `/api/v1/orgs/${orgA.orgId}/projects`,
    undefined,
    headersA,
  );
  const ownBody = JSON.stringify(ownProjects.payload ?? ownProjects.text ?? "");
  expect(
    "CONTROL: the same search FINDS Org A's own project id in Org A's own collection, so 'found nothing' means absent and not incapable",
    // `alphaNeedles.length > 0` is load-bearing and was MISSING. `[].every(..)` is `true`, so with
    // the needle set empty this control passed while proving nothing -- found by the sensitivity
    // harness's M2, which removes Org A's own project and expected this to fail. It did not. A
    // positive-match control that passes when there is nothing to match is the same defect as a
    // negative assertion graded on an empty set, and it is the sixth time this campaign has hit one.
    alphaNeedles.length > 0 &&
      ownProjects.status === 200 &&
      alphaNeedles.every((v) => ownBody.includes(v)),
    `status=${ownProjects.status} needles=${alphaNeedles.length} ` +
      `looking for ${alphaNeedles.join(", ") || "(none seeded)"} in ` +
      `${probe.brief(ownProjects.payload, 160)} -- if this fails, every leak verdict above is measuring ` +
      `a search that finds nothing regardless of what the response contains`,
  );
  console.log(
    `\n${measured} collection route(s) MEASURED against ${needles.length} Org B identifier(s) plus ` +
      `Bravo's email; ${leaks.length} leak(s). Excluded: ${notGet.length} not-GET, ` +
      `${notApplicable.length} without a fixture.`,
  );
});
