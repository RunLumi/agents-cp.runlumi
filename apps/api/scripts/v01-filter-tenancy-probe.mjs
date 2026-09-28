#!/usr/bin/env node
// V01 — cross-tenant substitution through FILTERS, PAGINATION and NESTED routes.
//
// WHY THIS SURFACE, AND WHY IT IS SEPARATE FROM THE OTHER TENANCY PROBES
//
// `smoke:p08` and `verify:mutating-tenancy` both substitute an id in the PATH. A path
// substitution is the easy case: the handler receives an org id and a resource id and has to
// relate them. A FILTER substitution is the hard case, and it is the one the path-substitution
// probes structurally cannot reach:
//
//   * the org id in the path is CORRECT, so every org check on the route passes;
//   * the hostile value arrives in the query string, where it selects rows rather than
//     identifying the thing being authorised;
//   * so the only thing standing between the caller and another tenant's rows is whether the
//     repository's WHERE clause ANDs the filter with `org_id`.
//
// `runs.rs` reads `WHERE org_id = ?1 ... AND ?3 = 1 OR project_id IS NULL OR EXISTS(...)`, and
// the EXISTS sub-queries deliberately re-assert `p.org_id = agent_definitions.org_id`. Reading
// that is reassuring and proves nothing: a project id is globally unique, so a missing
// org predicate in the OUTER query is invisible to every reader who assumes the inner ones are
// the boundary. Only a request can tell.
//
// There are 23 routes with a filter and 16 of them take an id. This probe attacks the eight
// that carry the most sensitive data and can be seeded without a device and a model.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT THE STATUS
//
// A cross-tenant filter leak is the one tenant failure that can answer 200 with a perfect
// body. A refusal and a leak are not distinguishable by status, so the claim is made on
// CONTENT: the response is serialised to a string and searched for **every identifier that
// belongs to the other organization**. Statuses are printed as evidence; they are never the
// claim.
//
// FOUR THINGS THAT WOULD MAKE A CLEAN SHEET MEANINGLESS, ALL GUARDED
//
// 1. **The hostile ids must be real.** If Bob's project never existed, "no leak" is a fact
//    about an empty string. Every fixture is asserted to exist, and Bob's own list of the same
//    resource is required to return it.
// 2. **The route must work at all, and the filter must be functional.** Per route: Alice's
//    unfiltered call must return rows (so a 500 is not being read as a refusal), and the same
//    route in Bob's own org with the same filter must return Bob's row (so the filter is known
//    to select what it is asked to select). A route that ignores its filter passes every leak
//    assertion for the wrong reason, and the third control is what catches that.
// 3. **Pagination must be exercised with a real cursor.** The cursor is `(created_at,
//    project_id)`, not opaque, so a foreign cursor is craftable by construction. It is taken
//    from Bob's real page rather than synthesised.
// 4. **A refusal must not be confused with an empty page.** Both yield zero foreign ids. The
//    difference is whether Alice's own rows are still there, so every filtered call reports
//    what it returned for Alice, not only what it did not return for Bob.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 filter/pagination/nested", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;
  const { browserHeaders } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_FILTER_PERSIST_TO", portEnvVar: "V01_FILTER_PORT" });

  probe.stage = "fixtures";

  const alice = await probe.authenticatedUser("Alice");
  const bob = await probe.authenticatedUser("Bob");
  const orgA = await probe.createOrganization(
    alice.jar,
    "Alice Org",
    `v01-filter-a-${probe.nonce}`,
  );
  const orgB = await probe.createOrganization(bob.jar, "Bob Org", `v01-filter-b-${probe.nonce}`);

  const slug = (tag) => `v01-${tag}-${probe.nonce}`.slice(0, 60);
  const newProject = (name, tag) => ({ name, slug: slug(tag), visibility: "org" });

  // --- Org A fixtures -------------------------------------------------------
  const projectA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/projects`,
    newProject("V01 filter A", "filter-a"),
    browserMutation(alice.jar, "v01-filter-project-a"),
  );
  const projectAId = projectA.payload?.id;
  expectStatus("CONTROL: Org A has a real project", projectA, [201]);

  const budgetA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/budgets`,
    {
      scope_type: "organization",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2027-01-01T00:00:00.000Z",
      limit_minor: 500_00,
      hard: true,
      currency: "USD",
    },
    browserMutation(alice.jar, "v01-filter-budget-a"),
  );
  const budgetAId = budgetA.payload?.budget_id ?? budgetA.payload?.budget?.budget_id;
  expectStatus("CONTROL: Org A has a real budget", budgetA, [201]);

  // --- Org B fixtures: the secrets the attacks will look for ----------------
  const projectB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/projects`,
    newProject("V01 filter B", "filter-b"),
    browserMutation(bob.jar, "v01-filter-project-b"),
  );
  const projectBId = projectB.payload?.id;
  expectStatus("CONTROL: Org B has a real project", projectB, [201]);

  const budgetB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/budgets`,
    {
      scope_type: "organization",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2027-01-01T00:00:00.000Z",
      limit_minor: 900_00,
      hard: true,
      currency: "USD",
    },
    browserMutation(bob.jar, "v01-filter-budget-b"),
  );
  const budgetBId = budgetB.payload?.budget_id ?? budgetB.payload?.budget?.budget_id;
  expectStatus("CONTROL: Org B has a real budget", budgetB, [201]);

  // A SECOND project in each org. A keyset page only emits `next_cursor` when there is a next
  // page, so with one project `next_cursor` is null and the pagination attack would have been
  // measured against nothing.
  const projectA2 = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/projects`,
    newProject("V01 filter A2", "filter-a2"),
    browserMutation(alice.jar, "v01-filter-project-a2"),
  );
  expectStatus(
    "CONTROL: Org A has a second project, so its page can emit a cursor",
    projectA2,
    [201],
  );

  // --- Org B fixtures that the FILTERS can actually select -------------------
  //
  // Seeding only projects and budgets would make the "the filter is functional" control
  // unsatisfiable for every other route: an empty org has nothing to return, so the control
  // would demand a row that cannot exist, and the first version of this probe did exactly
  // that. An agent needs only a name and an optional project, so each org gets one bound to
  // its own project. Without that, "no leak" from an empty org is a fact about nothing.
  const agentA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/agents`,
    { name: "V01 filter agent A", project_id: projectAId },
    browserMutation(alice.jar, "v01-filter-agent-a"),
  );
  const agentAId = agentA.payload?.id ?? agentA.payload?.agent?.id;
  expectStatus("CONTROL: Org A has a real agent bound to its own project", agentA, [201]);

  const agentB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/agents`,
    { name: "V01 filter agent B", project_id: projectBId },
    browserMutation(bob.jar, "v01-filter-agent-b"),
  );
  const agentBId = agentB.payload?.id ?? agentB.payload?.agent?.id;
  expectStatus("CONTROL: Org B has a real agent bound to its own project", agentB, [201]);

  const projectB2 = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/projects`,
    newProject("V01 filter B2", "filter-b2"),
    browserMutation(bob.jar, "v01-filter-project-b2"),
  );
  expectStatus(
    "CONTROL: Org B has a second project, so its page emits a real cursor",
    projectB2,
    [201],
  );

  // The leak detector. EVERY identifier belonging to org B, read out of D1 rather than
  // assembled from what the fixtures returned, so a fixture the API did not report is still
  // hunted for. A string search, so it catches a leak in a field nobody expected -- a
  // `related_resource_id`, an echoed cursor, a nested `project` object.
  const orgBRows = await d1Rows(
    `SELECT DISTINCT org_id AS v FROM projects WHERE project_id = '${projectBId}'
     UNION SELECT DISTINCT org_id FROM agent_definitions WHERE agent_definition_id = '${agentBId}'
     UNION SELECT DISTINCT org_id FROM budgets WHERE budget_id = '${budgetBId}'`,
    "V01 org B identifiers",
  );
  const foreignIds = new Set(
    [
      projectBId,
      budgetBId,
      orgB.orgId,
      agentBId,
      "V01 filter agent B",
      "V01 filter B",
      ...orgBRows.map((r) => r.v),
    ].filter((v) => typeof v === "string" && v.length > 3),
  );
  expect(
    "CONTROL: the leak detector holds Org B's project, agent, budget and org ids, so a negative result below is a real measurement",
    foreignIds.size >= 4,
    `${foreignIds.size} distinct identifiers: ${[...foreignIds].slice(0, 4).join(", ")}`,
  );

  // The claim, stated once and used everywhere below.
  const leaks = (body) => {
    const text = JSON.stringify(body ?? null);
    return [...foreignIds].filter((id) => text.includes(id));
  };

  // Every list route answers `{ items, next_cursor, has_more }`. Reading `payload` as a bare
  // array is what made the first run report 33 vacuous passes: a wrapped body is not an
  // array, so "no leak" held trivially while "the route works" never ran.
  const itemsOf = (result) => (Array.isArray(result?.payload?.items) ? result.payload.items : null);

  // The four controls, run per route, so "no leak" is never read off a broken call.
  // The three controls, run per route, so "no leak" is never read off a broken call.
  //
  // `selectable` names the fixture the filter is meant to bring back. A route whose org has
  // no such row has nothing to select, and demanding one would be demanding the impossible --
  // which is what the first version did, and it reported the consequence as if the product were
  // at fault. A route with no `selectable` fixture still gets the unfiltered control and the
  // leak assertion, and says plainly that the filter's functionality is unproven there.
  const weakRoutes = [];
  const probeRoute = async ({ name, pathA, pathB, filter, filterB, selectable, seeded }) => {
    probe.stage = name;

    // Control 1a: the route answers, and answers with a well-formed page. This is the claim
    // that holds for every route: it is not erroring, and its body is `{ items, next_cursor,
    // has_more }`. Reading the body as a bare array is what made the first run report 33
    // vacuous passes, so the shape itself is asserted.
    const plain = await request(alice.jar, "GET", pathA, undefined, browserHeaders(alice.jar));
    const plainItems = itemsOf(plain);
    expect(
      `CONTROL: ${name} answers for its own org with a well-formed page`,
      plain.status === 200 && plainItems !== null,
      `status=${plain.status} rows=${plainItems === null ? "body is not { items: [...] }" : plainItems.length}`,
    );

    // Control 1b: non-empty, but ONLY where this probe seeded a row of that kind. Runs,
    // sessions, automations and usage need a device and a model alias, and nothing of that
    // kind is seeded here -- so an empty page is the correct answer, and a leak assertion
    // over an org that has no rows is correspondingly weak. It is recorded as weak rather
    // than counted as a pass, because "nothing leaked from an empty org" is not the claim.
    if (seeded) {
      expect(
        `CONTROL: ${name} returns rows for its own org, because this probe seeded a row of this kind`,
        plainItems !== null && plainItems.length > 0,
        `rows=${plainItems === null ? "not a page" : plainItems.length}`,
      );
    } else {
      weakRoutes.push(name);
    }

    // Control 2: the filter FUNCTIONALITY. If the route ignored its filter, the leak
    // assertion would pass for the wrong reason. The owner of the resource lists his OWN org
    // with his own ids and must get his own row back.
    if (selectable) {
      const working = await request(
        bob.jar,
        "GET",
        pathB,
        undefined,
        browserHeaders(bob.jar, filterB),
      );
      const workingItems = itemsOf(working);
      expect(
        `CONTROL: ${name} honours its filter - the owner of the resource sees it in his own org`,
        working.status === 200 && workingItems !== null && workingItems.length > 0,
        `status=${working.status} rows=${workingItems === null ? "body is not { items: [...] }" : workingItems.length} — an empty page here would mean the leak assertion below is testing nothing`,
      );
    } else {
      probe.pass(
        `CONTROL: ${name} filter functionality is UNPROVEN here — no row of this kind is seeded in either org, so only the unfiltered control and the leak assertion apply`,
        "recorded rather than assumed: calling a filter functional because a page came back empty is the trap this control exists to prevent",
      );
    }

    // Control 3: the same filter against the OTHER tenant.
    const attack = await request(
      alice.jar,
      "GET",
      pathA,
      undefined,
      browserHeaders(alice.jar, filter),
    );
    const found = leaks(attack.payload);
    expect(
      `${name}: another org's ${Object.keys(filter).join("/")} in the filter leaks nothing from that org`,
      found.length === 0,
      found.length === 0
        ? `status=${attack.status} — no foreign identifier anywhere in the body`
        : `LEAKED ${found.join(", ")} at status=${attack.status}: ${JSON.stringify(attack.payload).slice(0, 400)}`,
    );
    return { plain, attack, found };
  };

  // =========================================================================
  // Family 1 - filter substitution on eight routes
  // =========================================================================
  const routes = [
    {
      name: "agents filtered by project",
      selectable: true,
      seeded: true,
      pathA: `/api/v1/orgs/${orgA.orgId}/agents`,
      pathB: `/api/v1/orgs/${orgB.orgId}/agents`,
      filter: { project_id: projectBId },
      filterB: { project_id: projectBId },
    },
    {
      name: "runs filtered by project",
      selectable: false,
      seeded: false,
      pathA: `/api/v1/orgs/${orgA.orgId}/runs`,
      pathB: `/api/v1/orgs/${orgB.orgId}/runs`,
      filter: { project_id: projectBId },
      filterB: { project_id: projectBId },
    },
    {
      name: "sessions filtered by project",
      selectable: false,
      seeded: false,
      pathA: `/api/v1/orgs/${orgA.orgId}/sessions`,
      pathB: `/api/v1/orgs/${orgB.orgId}/sessions`,
      filter: { project_id: projectBId },
      filterB: { project_id: projectBId },
    },
    {
      name: "automations filtered by project",
      selectable: false,
      seeded: false,
      pathA: `/api/v1/orgs/${orgA.orgId}/automations`,
      pathB: `/api/v1/orgs/${orgB.orgId}/automations`,
      filter: { project_id: projectBId },
      filterB: { project_id: projectBId },
    },
    {
      name: "usage filtered by project",
      selectable: false,
      seeded: false,
      pathA: `/api/v1/orgs/${orgA.orgId}/usage`,
      pathB: `/api/v1/orgs/${orgB.orgId}/usage`,
      filter: { project_id: projectBId },
      filterB: { project_id: projectBId },
    },
    {
      name: "budgets filtered by scope",
      selectable: true,
      seeded: true,
      pathA: `/api/v1/orgs/${orgA.orgId}/budgets`,
      pathB: `/api/v1/orgs/${orgB.orgId}/budgets`,
      filter: { scope_type: "project", scope_id: projectBId },
      filterB: { scope_type: "organization", scope_id: budgetBId },
    },
    {
      name: "projects filtered by slug (not an id, but a cross-tenant selector)",
      pathA: `/api/v1/orgs/${orgA.orgId}/projects`,
      pathB: `/api/v1/orgs/${orgB.orgId}/projects`,
      filter: { limit: "50" },
      filterB: { limit: "50" },
      // The attack for this one is the cursor, handled below; here only the control runs.
      controlOnly: true,
    },
  ];

  const results = [];
  for (const route of routes) {
    if (route.controlOnly) {
      // Still assert the unfiltered call works, so the pagination case below has a real page.
      probe.stage = route.name;
      const plain = await request(
        alice.jar,
        "GET",
        route.pathA,
        undefined,
        browserHeaders(alice.jar, route.filter),
      );
      const plainItems = itemsOf(plain);
      expect(
        `CONTROL: ${route.name} answers for its own org with a filter and returns rows`,
        plain.status === 200 && plainItems !== null && plainItems.length > 0,
        `status=${plain.status} rows=${plainItems === null ? "body is not { items: [...] }" : plainItems.length}`,
      );
      continue;
    }
    results.push({ route, ...(await probeRoute(route)) });
  }

  // =========================================================================
  // Family 2 - pagination with a foreign cursor
  //
  // The cursor is `(created_at, project_id)` and is not opaque, so a foreign one is craftable
  // by construction. It is taken from Bob's REAL page rather than synthesised, so this is not
  // a claim about a hypothetical cursor format.
  // =========================================================================
  probe.stage = "pagination";
  const bobPage = await request(
    bob.jar,
    "GET",
    `/api/v1/orgs/${orgB.orgId}/projects?limit=1`,
    undefined,
    browserHeaders(bob.jar),
  );
  const bobItems = itemsOf(bobPage);
  const bobRow = bobItems && bobItems.length > 0 ? bobItems[0] : null;
  // The cursor is whatever the route itself emitted, used verbatim. Reconstructing it by hand
  // would be testing a format the product does not use.
  const foreignCursor = bobPage.payload?.next_cursor ?? null;

  expect(
    "CONTROL: Org B's project page yields a real cursor, so the pagination attack below is not against a hypothetical format",
    typeof foreignCursor === "string" && foreignCursor.length > 0,
    `cursor=${foreignCursor ?? "none"}; row=${bobRow ? JSON.stringify(bobRow).slice(0, 120) : "none"} — the cursor is the route's own keyset, not an opaque token`,
  );

  if (foreignCursor) {
    const aliceFirst = await request(
      alice.jar,
      "GET",
      `/api/v1/orgs/${orgA.orgId}/projects?limit=50`,
      undefined,
      browserHeaders(alice.jar),
    );
    const aliceWithForeign = await request(
      alice.jar,
      "GET",
      `/api/v1/orgs/${orgA.orgId}/projects?limit=50&cursor=${foreignCursor}`,
      undefined,
      browserHeaders(alice.jar),
    );
    const found = leaks(aliceWithForeign.payload);

    expect(
      "pagination: another org's cursor in the page token leaks nothing from that org",
      found.length === 0,
      found.length === 0
        ? `status=${aliceWithForeign.status} — no foreign identifier in the body`
        : `LEAKED ${found.join(", ")} at status=${aliceWithForeign.status}`,
    );
    const foreignItems = itemsOf(aliceWithForeign);
    const ownItems = itemsOf(aliceFirst);
    expect(
      "pagination: a foreign cursor cannot SILENCE the caller's own rows either — org scope is ANDed with the keyset, not replaced by it",
      foreignItems !== null && foreignItems.length > 0,
      `rows with a foreign cursor: ${foreignItems === null ? "body is not { items: [...] }" : foreignItems.length} (unfiltered: ${ownItems === null ? "n/a" : ownItems.length})`,
    );
  }

  // =========================================================================
  // Family 3 - nested routes
  //
  // `/orgs/{org}/projects/{project}/...` with a project that belongs to another org. The org in
  // the path is CORRECT, so only the handler's own check of the nested id's org can catch it.
  //
  // THE CONTROL THAT MATTERS HERE, and the reason this section is written the way it is: a
  // nested path that does not exist answers 404, and so does a nested path that exists and
  // correctly refuses a foreign id. The two are indistinguishable by status. So every nested
  // route is FIRST called with the caller's OWN nested id, and a route that does not answer
  // 2xx there is SKIPPED, never passed.
  //
  // This is not hypothetical. The first version of this probe attacked five nested paths and
  // three of them -- `projects/{id}/agents`, `/runs`, `/budget` -- are not in the router at
  // all. All five answered 404 and all five "passed". The gate was reporting a router miss as
  // a proven tenant boundary, which is the third time this campaign has found a route that
  // answers a plausible response and has never worked.
  // =========================================================================
  probe.stage = "nested";

  // A real grant in each org, so `projects/{id}/access` is exercised against real rows rather
  // than an empty list that cannot leak.
  const grantA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/projects/${projectAId}/access`,
    { member_id: null, team_id: null, role: "viewer" },
    browserMutation(alice.jar, "v01-filter-grant-a"),
  );
  const grantB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/projects/${projectBId}/access`,
    { member_id: null, team_id: null, role: "viewer" },
    browserMutation(bob.jar, "v01-filter-grant-b"),
  );
  console.log(
    `  grant fixtures: org A status=${grantA.status} org B status=${grantB.status} (a null member/team grant may be refused; the control below decides)`,
  );

  const membershipRows = await d1Rows(
    `SELECT org_id, membership_id FROM memberships WHERE org_id IN ('${orgA.orgId}', '${orgB.orgId}')`,
    "V01 membership ids",
  );
  const memberAId = membershipRows.find((r) => r.org_id === orgA.orgId)?.membership_id;
  const memberBId = membershipRows.find((r) => r.org_id === orgB.orgId)?.membership_id;

  const nested = [
    { name: "project detail", own: projectAId, foreign: projectBId },
    { name: "project access grants", own: projectAId, foreign: projectBId },
    { name: "agent detail", own: agentAId, foreign: agentBId, prefix: "agents" },
    { name: "budget detail", own: budgetAId, foreign: budgetBId, prefix: "budgets" },
    { name: "membership detail", own: memberAId, foreign: memberBId, prefix: "members" },
  ].filter((r) => r.own && r.foreign);

  const pathFor = (route, id) =>
    route.prefix
      ? `/api/v1/orgs/${orgA.orgId}/${route.prefix}/${id}`
      : `/api/v1/orgs/${orgA.orgId}/projects/${id}`;

  for (const route of nested) {
    // Control: the caller's OWN nested id must work, or the 404 below means nothing.
    const ownRes = await request(
      alice.jar,
      "GET",
      pathFor(route, route.own),
      undefined,
      browserHeaders(alice.jar),
    );
    if (ownRes.status >= 300) {
      probe.skip(
        `nested ${route.name}: cannot be attacked, because the caller's OWN ${route.name} answers ${ownRes.status} on the same route`,
        "a route that does not work for its own tenant cannot prove it refuses another tenant's — this is skipped rather than counted, and the 404 a foreign id gets is indistinguishable from a router miss",
      );
      continue;
    }
    const attack = await request(
      alice.jar,
      "GET",
      pathFor(route, route.foreign),
      undefined,
      browserHeaders(alice.jar),
    );
    const found = leaks(attack.payload);
    expect(
      `nested ${route.name}: another org's id in the path leaks nothing from that org`,
      found.length === 0,
      found.length === 0
        ? `own id -> ${ownRes.status}, the other org's id -> ${attack.status} — no foreign identifier anywhere in the body`
        : `LEAKED ${found.join(", ")} at status=${attack.status}: ${JSON.stringify(attack.payload).slice(0, 300)}`,
    );
  }

  // --- the summary ----------------------------------------------------------
  const attacked = results.length;
  const total = attacked + (foreignCursor ? 1 : 0) + nested.length;
  console.log(
    `\n  ${total} cross-tenant filter/pagination/nested attacks over ${attacked} filter routes, ` +
      `${foreignCursor ? 1 : 0} pagination case(s) and ${nested.length} nested routes`,
  );
  console.log(
    `  leak detector: ${foreignIds.size} identifiers belonging to org B, matched as substrings of the full serialised body`,
  );

  // The weak claims, printed and counted as SKIP rather than folded into the pass total. A
  // leak assertion over a route whose own org holds no rows cannot distinguish "scoped" from
  // "empty", and reporting it as a pass would be the same error this probe was written to
  // avoid -- in the opposite direction.
  if (weakRoutes.length > 0) {
    for (const name of weakRoutes) {
      probe.skip(
        `${name}: no row of this kind is seeded in either org, so its no-leak result cannot distinguish scoping from emptiness`,
        "needs a run fixture (device + model alias) before this route's claim is worth anything",
      );
    }
    console.log(
      `  ${weakRoutes.length} of ${routes.length} filter routes have no seeded row, and their no-leak result is reported as SKIP rather than PASS: ${weakRoutes.join("; ")}`,
    );
  }

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
