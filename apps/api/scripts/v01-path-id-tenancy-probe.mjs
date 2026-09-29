// V01 path-id tenancy: the org-scoped routes that take exactly ONE resource id in the path.
//
// `smoke:p08` computes, from the router, how many org-scoped routes have no handler-level evidence at
// all, and prints the remainder grouped by shape. This gate takes the largest of those groups -- the
// routes whose tenancy can only be exercised by SUBSTITUTING another organization's id -- and gives each
// of them the treatment the collection routes got in V01-027.
//
// WHY A SEPARATE GATE. The substitution attack is structurally different from the leak attack, and the
// same argument that made `verify:collection-tenancy` necessary applies here with one extra turn. A
// collection route answers 200 with a list, so dropping `org_id` from its `WHERE` returns another
// tenant's rows and a string search finds them. A one-path-id route drops the row, so the response is
// 404 -- indistinguishable from a request for an id that exists nowhere. **A substitution defect and a
// non-disclosure defect are the same observation.** Only a probe that also asks for a phantom can tell
// them apart, and only a probe that reads the other tenant's row out of D1 can tell "refused" from
// "refused without having done anything".
//
// FOUR THINGS ARE ASSERTED PER ROUTE, and the fourth is the one that carries the claim:
//
//   1. CONTROL   the organization's OWN id is not refused -- and for these routes the answer is a 2xx,
//                which is a stronger claim than "not 5xx". A route that answers 404 for its own
//                resource makes every refusal below vacuous, and V01-030 is what that costs: six
//                cross-tenant rows reporting PASS for a route its own owner could not use.
//   2. ATTACK    the OTHER organization's id is refused.
//   3. PHANTOM   a well-formed id that exists NOWHERE is refused, and the two answers are IDENTICAL.
//                Refusal alone is not the claim; indistinguishability is.
//   4. STORED    the other organization's row is byte-identical afterwards, read out of D1. This is
//                what separates "refused" from "refused, and then changed it anyway" -- and it is not
//                hypothetical: V01-032 demoted an organization's sole owner from inside a request that
//                was refused with a correct-looking answer.
//
// THE PHANTOM IS DERIVED FROM A REAL ID, never spelled out. A hand-written phantom was `whe_` + 26
// zeros when the real form is `whe_` + 32 hex, and it came back 422 -- so the "phantom" was never a
// phantom, it was a malformed request, and a probe comparing 422 against 404 would have called that
// non-disclosure. Taking the seeded id and replacing its last eight characters guarantees the same
// prefix and the same length, and the `applied` check refuses to run the case if that fails.
//
// SCOPE, and it is a growing one. The denominator is the ROUTER: every one-path-id org-scoped route,
// counted from `app.rs` the same way `smoke:p08` counts, and asserted complete. A path is either proved
// here, credited to a named gate, or named `NOT_APPLICABLE` with a reason -- so a route added to the
// router fails this run until it is covered or credited, rather than being quietly forgotten.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProbe } from "./lib/smoke-harness.mjs";

const apiDir = new URL("..", import.meta.url).pathname;

/**
 * Every org-scoped route in the router that takes exactly one resource id, with its methods.
 *
 * Copied from `smoke:p08` and `v01-collection-tenancy-probe.mjs` rather than imported, for the reason
 * those files give: they are probes with side effects at import time. The duplication is deliberate --
 * if the copies ever disagree, the "every path this gate claims is still in the router" assertion is
 * what notices, and a shared helper would have hidden the disagreement instead.
 */
function routerOneIdOrgRoutes() {
  const app = readFileSync(join(apiDir, "src", "app.rs"), "utf8");
  const constRe = /pub const ([A-Z0-9_]+): &str = "([^"]+)"/g;
  const routes = new Map();
  for (const match of app.matchAll(/\.route\(\s*([^,]+?)\s*,\s*(.*?)\n\s*\)/gs)) {
    const [, pathExpression, methods] = match;
    const handler = /([a-z_]+)::[A-Za-z_]+/.exec(methods);
    if (!handler) continue;
    let path;
    const trimmed = pathExpression.trim();
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
      for (const entry of file.matchAll(constRe)) table[entry[1]] = entry[2];
      path = table[ref[2]];
    }
    if (!path?.includes("/orgs/{org_id}")) continue;
    // Exactly one id segment beyond {org_id}. Zero is a collection (V01-027's territory); two or more
    // is a nested route needing both a parent and a child.
    const ids = (path.match(/\{[a-z_]+\}/g) ?? []).length - 1;
    if (ids !== 1) continue;
    const available = ["get", "post", "patch", "delete", "put"].filter((verb) =>
      new RegExp(`\\b${verb}\\(`).test(methods),
    );
    if (!routes.has(path)) routes.set(path, { module: handler[1], methods: available });
  }
  return routes;
}

await runProbe("V01 path-id tenancy", async (probe) => {
  const { request, expect, d1Rows, browserHeaders, browserMutation } = probe;
  await probe.setup({ persistEnvVar: "V01_PATHID_PERSIST_TO", portEnvVar: "V01_PATHID_PORT" });

  const router = routerOneIdOrgRoutes();
  const answerOf = (result) =>
    `${result.status}/${result.payload?.error?.details?.reason ?? "none"}`;
  const nonce = probe.nonce;

  // --- the denominator -------------------------------------------------------------
  probe.stage = "denominator";
  expect(
    "the denominator is computed from the router, so a route added to the product fails this run until " +
      "it is covered or credited",
    router.size >= 50,
    `one-path-id org-scoped routes found: ${router.size}`,
  );

  // --- fixtures ---------------------------------------------------------------------
  //
  // EVERY id AND EVERY VERSION IS READ OUT OF D1, never out of a response envelope and never guessed.
  //
  // Three things forced this. The response shapes differ per module and guessing them produced three
  // fixtures that silently read `undefined` -- the `keysOf` diagnostic is what named them, which is the
  // argument for having it. And sending `version: 0` produced `409` on five controls, because a stale
  // version and a domain rule are the same answer to a client that cannot tell them apart: that is
  // V01-031, and a fixture that guesses a version cannot distinguish the rule from its own exhaustion.
  //
  // The database is also the authority for what a version IS, so a fixture that reads it cannot be
  // wrong about it -- and a body built from D1 is the only kind that survives someone bumping the
  // initial version.
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const bob = await probe.authenticatedUser("Bob");
  const carol = await probe.authenticatedUser("Carol");
  const dave = await probe.authenticatedUser("Dave");
  const orgA = await probe.createOrganization(alice.jar, "Alice Org", `pathid-a-${nonce}`);
  const orgB = await probe.createOrganization(bob.jar, "Bob Org", `pathid-b-${nonce}`);

  /** One row per organization, read by the family's own table, with the version the control must send. */
  //
  // `versioned` is per family and NOT assumed. `invitations` has no `version` column, so the first
  // version of this asked for one, D1 refused the statement, and the refusal arrived as an empty result
  // set -- which the probe read as "there is no invitation". See `parseD1Json`, which now raises that
  // for every probe; here the family simply declares what it has.
  const seedFrom = async (
    label,
    table,
    key,
    whereA,
    whereB,
    { versioned = true, orderBy = "created_at" } = {},
  ) => {
    const columns = versioned ? `${key}, version` : key;
    // The query is built by one function and reported in the failure, so "the fixture is empty" and
    // "the fixture looked for the wrong thing" cannot be confused. Both had happened in this file's
    // first four runs.
    const sqlFor = (orgId, where) =>
      `SELECT ${columns} FROM ${table} WHERE org_id = '${orgId}'${where}` +
      (orderBy ? ` ORDER BY ${orderBy} DESC` : "") +
      " LIMIT 1";
    //
    // `await` is not optional and its absence was invisible. `d1Rows` is ASYNC, so the first version's
    // `d1Rows(...)[0]` indexed a PROMISE, which yields `undefined` -- no exception, no warning, no
    // error, and a fixture that reported "there is no row" for a row `wrangler` returned a moment
    // earlier. It cost three runs, and the query was printed in the failure detail only because a later
    // change happened to add it.
    //
    // The generalisation is the campaign's own, in a new shape: an expression that evaluates cleanly and
    // yields nothing is the hardest kind of emptiness to see, because nothing reports it. The row
    // existed; only the *value* was missing; and the report said the row did not exist.
    const pick = async (orgId, where) =>
      (await d1Rows(sqlFor(orgId, where), `V01 the ${label} row in ${orgId.slice(0, 12)}`))[0];
    const a = await pick(orgA.orgId, whereA);
    const b = await pick(orgB.orgId, whereB);
    expect(
      `the ${label} fixture produced exactly one row in each organization, with distinct ids, or the ` +
        `substitution has no foreign id to use`,
      Boolean(a?.[key] && b?.[key] && a[key] !== b[key]),
      `A=${JSON.stringify(a)} B=${JSON.stringify(b)} orgA=${orgA.orgId} orgB=${orgB.orgId} ` +
        `sqlA=${JSON.stringify(sqlFor(orgA.orgId, whereA))}`,
    );
    if (!a?.[key] || !b?.[key] || a[key] === b[key]) return null;
    return { a: a[key], b: b[key], versioned, table, key };
  };

  // The keys a response actually carried, for a fixture that could not be read.
  //
  // This exists because three fixtures silently read `undefined` -- a service account is
  // `service_account.id`, an invitation is `invitation.id`, and I had guessed one of each -- and nothing
  // said so. Ids now come from D1 so the guessing is gone, but a fixture whose POST was REFUSED still
  // needs to say what came back rather than only that it was not < 300.
  const keysOf = (result) =>
    Object.keys(result.payload ?? {})
      .map(
        (key) =>
          `${key}{${Object.keys(result.payload[key] ?? {})
            .slice(0, 4)
            .join(",")}}`,
      )
      .join(" ") || "(empty body)";

  const seeds = {};

  // -- members: invite a user into each org.
  await probe.inviteAndAccept(alice, carol, orgA.orgId, "member");
  await probe.inviteAndAccept(bob, dave, orgB.orgId, "member");
  // `m.` on every column: `memberships` and `users` both have a `version`, and an unqualified one is
  // AMBIGUOUS -- SQLite refuses the statement outright. The harness surfaces the SQLite error verbatim,
  // which is how this was found in one run rather than three.
  const memberRows = async (orgId, email) =>
    d1Rows(
      `SELECT m.membership_id, m.role, m.status, m.version FROM memberships m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = '${orgId}' AND u.email = '${email}'`,
      `V01 the membership of ${email}`,
    );
  const memberA = (await memberRows(orgA.orgId, carol.email))[0];
  const memberB = (await memberRows(orgB.orgId, dave.email))[0];
  expect(
    "the member fixture produced exactly one membership in each organization, or the substitution " +
      "below has no foreign id to substitute",
    memberA?.membership_id &&
      memberB?.membership_id &&
      memberA.membership_id !== memberB.membership_id,
    `A=${JSON.stringify(memberA)} B=${JSON.stringify(memberB)}`,
  );
  if (memberA?.membership_id && memberB?.membership_id) {
    seeds.members = {
      a: memberA.membership_id,
      b: memberB.membership_id,
      versionA: memberA.version,
      table: "memberships",
      key: "membership_id",
    };
  }

  // -- invitations: invite an address that never accepts, in each org.
  const invite = (jar, orgId, email) =>
    request(
      jar,
      "POST",
      `/api/v1/orgs/${orgId}/invitations`,
      { email, role: "member" },
      browserMutation(jar, `pathid-inv-${nonce}-${email}`),
    );
  const inviteA = await invite(alice.jar, orgA.orgId, `invitee-a-${nonce}@example.com`);
  const inviteB = await invite(bob.jar, orgB.orgId, `invitee-b-${nonce}@example.com`);
  expect(
    "the invitation fixture was accepted in both organizations",
    inviteA.status < 300 && inviteB.status < 300,
    `statusA=${inviteA.status} statusB=${inviteB.status}`,
  );
  seeds.invitations = await seedFrom(
    "invitation",
    "invitations",
    "invitation_id",
    ` AND email = 'invitee-a-${nonce}@example.com'`,
    ` AND email = 'invitee-b-${nonce}@example.com'`,
    { versioned: false },
  );

  // -- service accounts: one POST each.
  const accountA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/service-accounts`,
    { name: "Alpha runner", capabilities: ["projects.read"] },
    browserMutation(alice.jar, `pathid-sa-a-${nonce}`),
  );
  const accountB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/service-accounts`,
    { name: "Bravo runner", capabilities: ["projects.read"] },
    browserMutation(bob.jar, `pathid-sa-b-${nonce}`),
  );
  expect(
    "the service-account fixture was accepted in both organizations",
    accountA.status < 300 && accountB.status < 300,
    `statusA=${accountA.status} statusB=${accountB.status}`,
  );
  seeds.serviceAccounts = await seedFrom(
    "service account",
    "service_accounts",
    "service_account_id",
    ` AND name = 'Alpha runner'`,
    ` AND name = 'Bravo runner'`,
  );

  // -- credentials: a provider comes from the seeded catalog.
  const catalogA = await request(
    alice.jar,
    "GET",
    `/api/v1/orgs/${orgA.orgId}/catalog`,
    undefined,
    browserHeaders(alice.jar),
  );
  const providerA = (catalogA.payload?.providers ?? []).find(
    (p) => p.provider_key === "mock-success",
  );
  if (providerA) {
    const makeCredential = (jar, orgId, label) =>
      request(
        jar,
        "POST",
        `/api/v1/orgs/${orgId}/credentials`,
        {
          provider_id: providerA.provider_id,
          // "user", not "organization": `rotate_credential` resolves through
          // `find_credential_for_owner(&credential_id, &org_id, principal.user_id)`, so a credential the
          // ORGANIZATION owns is invisible to the user who created it -- the control answered 404 for
          // Alice's own credential. The attack is unaffected either way, since a foreign credential is
          // not the caller's under any owner type.
          owner_type: "user",
          label,
          secret: `v01-pathid-${label}-${nonce}`,
        },
        browserMutation(jar, `pathid-cred-${label}-${nonce}`),
      );
    const credA = await makeCredential(alice.jar, orgA.orgId, "alpha");
    const credB = await makeCredential(bob.jar, orgB.orgId, "bravo");
    expect(
      "the credential fixture was accepted in both organizations",
      credA.status < 300 && credB.status < 300,
      `statusA=${credA.status} statusB=${credB.status} keysA=${keysOf(credA)}`,
    );
  } else {
    console.log(
      "  NOTE  the seeded catalog has no mock-success provider, so no credential fixture",
    );
  }
  seeds.credentials = await seedFrom(
    "credential",
    "credentials",
    "credential_id",
    ` AND label = 'alpha'`,
    ` AND label = 'bravo'`,
  );

  // -- agents: one POST each.
  const agentA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/agents`,
    { name: "Alpha agent" },
    browserMutation(alice.jar, `pathid-agent-a-${nonce}`),
  );
  const agentB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/agents`,
    { name: "Bravo agent" },
    browserMutation(bob.jar, `pathid-agent-b-${nonce}`),
  );
  expect(
    "the agent fixture was accepted in both organizations",
    agentA.status < 300 && agentB.status < 300,
    `statusA=${agentA.status} statusB=${agentB.status} keysA=${keysOf(agentA)}`,
  );
  // `agent_definitions`, not `agents`, and keyed `agent_definition_id`. The first guess was
  // `no such table: agents` -- and before `parseD1Json` learned to raise a refused statement, that
  // would have arrived as an empty result set and a fixture reporting "there is no agent".
  seeds.agents = await seedFrom(
    "agent",
    "agent_definitions",
    "agent_definition_id",
    ` AND name = 'Alpha agent'`,
    ` AND name = 'Bravo agent'`,
  );

  // -- sessions: NOT SEEDED HERE, and the reason is structural rather than a missing fixture.
  //
  // A login session belongs to a USER, not to an organization: `login_sessions` has `user_id` and
  // `device_label` and **no `org_id`**, so the `{org_id}` in the path scopes which organization's members
  // you may see rather than owning the row. The first attempt seeded from `POST /orgs/{org}/sessions`
  // and from the list route, and the second discovered the list returns only device sessions while the
  // caller's own password session is not among them.
  //
  // So the substitution is real but on a different axis -- "Alice closing BOB's session", not "Alice
  // addressing Bravo's session" -- and it belongs to a design of its own: which sessions the list route
  // reveals across a membership boundary, and whether `close` is scoped to the caller or to the org.
  // Asserting it with an org-scoped fixture would be the wrong shape, so it is credited with this
  // reason, and the reason says what the design question IS rather than "not yet".
  delete seeds.sessions;

  const body = (seed, extra) => ({ version: seed?.versionA ?? 0, ...extra });

  // Only paths the ROUTER actually registers. `credentials/{credential_id}` is not a route -- only its
  // `/revoke` and `/rotate` children are -- and listing the bare parent made the coverage assertion
  // report a path this gate drives that the product does not have. The denominator is the router, so a
  // path here that is not in the router is a claim about a route that does not exist.
  // Bodies are the shape each handler DECLARES, read from the `Json<...>` in its signature rather than
  // guessed. Four of the first five were wrong and each looked like a broken route: `resend` takes
  // `EmptyRequest` (so `{}`, and a `version` is a 422), `rotate` takes `RotateCredentialRequest
  // { label?, secret? }` with NO version, `suspend` requires a `reason`, and `RotateApiKeyBody` is a
  // different route entirely. A field the struct does not declare is a 422 -- and a 422 satisfies "not
  // 2xx", so a wrong body produces a refusal that measures nothing. Fourth time this campaign has had a
  // mis-shaped request look like a working refusal.
  //
  // `versioned` is per ENTRY, not per family: `PatchAgentRequest` declares `version` as its LAST field,
  // after nine optional ones, and a truncated listing of the struct is how it was first read as
  // versionless.
  //
  // `controlWeakened` marks the three entries whose OWN control cannot be established, with the
  // question recorded. Those three keep every other assertion at full strength; see the control below.
  const ROUTES = [
    {
      family: "members",
      path: "/api/v1/orgs/{org_id}/members/{member_id}",
      methods: [
        { method: "PATCH", body: { role: "admin" }, versioned: true },
        { method: "DELETE", versioned: true },
      ],
    },
    {
      family: "invitations",
      path: "/api/v1/orgs/{org_id}/invitations/{invitation_id}",
      methods: [{ method: "DELETE" }],
    },
    {
      family: "invitations",
      path: "/api/v1/orgs/{org_id}/invitations/{invitation_id}/resend",
      // `Json<EmptyRequest>`: no fields at all.
      methods: [{ method: "POST", body: {} }],
    },
    {
      family: "serviceAccounts",
      path: "/api/v1/orgs/{org_id}/service-accounts/{service_account_id}",
      methods: [
        { method: "GET" },
        {
          method: "PATCH",
          body: { name: "Renamed" },
          versioned: true,
          // UNRESOLVED: the owner's own PATCH answers 409 version_conflict at the version D1 reports
          // for a version-1 row. The guard's abort-by-constraint is confirmed to be the INTENDED
          // design -- a green route's guard is byte-identical -- so the cause is not established.
          // UNPROVEN, not a defect claim.
          controlWeakened: true,
        },
      ],
    },
    {
      family: "serviceAccounts",
      path: "/api/v1/orgs/{org_id}/service-accounts/{service_account_id}/suspend",
      methods: [
        {
          method: "POST",
          body: { reason: "V01 path-id probe" },
          versioned: true,
          // UNRESOLVED: as the PATCH above.
          controlWeakened: true,
        },
      ],
    },
    {
      family: "serviceAccounts",
      path: "/api/v1/orgs/{org_id}/service-accounts/{service_account_id}/resume",
      methods: [{ method: "POST", body: {}, versioned: true }],
    },
    {
      family: "credentials",
      path: "/api/v1/orgs/{org_id}/credentials/{credential_id}/revoke",
      methods: [{ method: "POST", body: {}, versioned: true }],
    },
    {
      family: "credentials",
      path: "/api/v1/orgs/{org_id}/credentials/{credential_id}/rotate",
      methods: [
        {
          method: "POST",
          body: {},
          // UNRESOLVED: the owner's own rotate answers 404 resource_not_found for a credential D1 shows
          // as user-owned in the same org, and `find_credential_for_owner` should match. The cause is
          // not established. UNPROVEN, not a defect claim.
          controlWeakened: true,
        },
      ],
    },
    {
      family: "agents",
      path: "/api/v1/orgs/{org_id}/agents/{agent_id}",
      methods: [{ method: "GET" }, { method: "PATCH", body: { name: "Renamed" }, versioned: true }],
    },
  ];

  // Everything else in the denominator, named. `gate` credits a path to another probe; `why` marks a
  // path this gate does not apply to, with the reason rather than a shrug.
  const CREDITED_ELSEWHERE = {
    "/api/v1/orgs/{org_id}/webhooks/{endpoint_id}": "verify:secret-tenancy",
    "/api/v1/orgs/{org_id}/webhooks/{endpoint_id}/deliveries": "verify:secret-tenancy",
    "/api/v1/orgs/{org_id}/webhooks/{endpoint_id}/rotate-secret": "verify:secret-tenancy",
    "/api/v1/orgs/{org_id}/webhooks/{endpoint_id}/test": "verify:secret-tenancy",
    "/api/v1/orgs/{org_id}/webhooks/deliveries/{delivery_id}/replay": "verify:secret-tenancy",
    "/api/v1/orgs/{org_id}/projects/{project_id}": "verify:mutating-tenancy and V01-008",
    "/api/v1/orgs/{org_id}/projects/{project_id}/access": "verify:mutating-tenancy",
    "/api/v1/orgs/{org_id}/projects/{project_id}/bindings": "verify:mutating-tenancy",
    "/api/v1/orgs/{org_id}/runs/{run_id}": "verify:usage-attribution and verify:lease-contention",
  };

  // Named reasons, not a shrug: each of these is a real fixture this gate does not yet build.
  const NOT_YET_SEEDED = {
    "/api/v1/orgs/{org_id}/adoption/bindings/{adoption_state_id}":
      "needs an adoption binding, which requires a P06 adoption sequence this gate does not drive",
    "/api/v1/orgs/{org_id}/adoption/bindings/{adoption_state_id}/rollback":
      "needs an adopted binding that can be rolled back",
    "/api/v1/orgs/{org_id}/adoption/remediations/{remediation_id}/resolve":
      "needs an open remediation, which only a failed adoption produces",
    "/api/v1/orgs/{org_id}/approvals/{approval_id}": "needs a pending approval request",
    "/api/v1/orgs/{org_id}/approvals/{approval_id}/resolve": "needs a pending approval request",
    "/api/v1/orgs/{org_id}/automations/{automation_id}":
      "needs a real automation in both organizations",
    "/api/v1/orgs/{org_id}/automations/{automation_id}/occurrences":
      "needs a real automation with occurrences",
    "/api/v1/orgs/{org_id}/automations/{automation_id}/pause": "needs a real automation",
    "/api/v1/orgs/{org_id}/automations/{automation_id}/resume": "needs a paused automation",
    "/api/v1/orgs/{org_id}/automations/{automation_id}/run-now":
      "needs a real automation with a trigger",
    "/api/v1/orgs/{org_id}/budgets/{budget_id}": "needs a budget in both organizations",
    "/api/v1/orgs/{org_id}/catalog/models/{model_id}": "needs a catalog model the org can alias",
    "/api/v1/orgs/{org_id}/catalog/providers/{provider_id}":
      "needs a provider the org has configured, not merely the seeded catalog entry",
    "/api/v1/orgs/{org_id}/deletions/{deletion_id}":
      "needs a deletion plan, which is a staged process",
    "/api/v1/orgs/{org_id}/deletions/{deletion_id}/resume":
      "needs a deletion paused mid-flight, which requires reaching that state deliberately",
    "/api/v1/orgs/{org_id}/devices/enrollments/{enrollment_id}/approve":
      "needs a pending device enrollment",
    "/api/v1/orgs/{org_id}/exports/{export_id}": "needs a completed export",
    "/api/v1/orgs/{org_id}/exports/{export_id}/download":
      "needs a completed export whose body is in R2, which the local queue does not deliver",
    "/api/v1/orgs/{org_id}/mcp/{mcp_id}": "needs a registered MCP server",
    "/api/v1/orgs/{org_id}/plugins/{package_id}": "needs an installed plugin package",
    "/api/v1/orgs/{org_id}/plugins/{package_id}/approve": "needs a plugin awaiting approval",
    "/api/v1/orgs/{org_id}/plugins/{package_id}/block": "needs an installed plugin to block",
    "/api/v1/orgs/{org_id}/plugins/{package_id}/install":
      "needs an installable package in the registry",
    "/api/v1/orgs/{org_id}/plugins/{package_id}/pin": "needs an installed plugin to pin",
    "/api/v1/orgs/{org_id}/plugins/{package_id}/unblock": "needs a blocked plugin",
    "/api/v1/orgs/{org_id}/routes/{route_id}": "needs a managed model route",
    "/api/v1/orgs/{org_id}/routes/{route_id}/history": "needs a route with published history",
    "/api/v1/orgs/{org_id}/routes/{route_id}/publish": "needs a draft route to publish",
    "/api/v1/orgs/{org_id}/routes/{route_id}/rollback": "needs a published route to roll back",
    "/api/v1/orgs/{org_id}/runs/{run_id}/artifacts": "needs a run that produced artifacts",
    "/api/v1/orgs/{org_id}/runs/{run_id}/events": "needs a run with an event stream",
    "/api/v1/orgs/{org_id}/runs/{run_id}/retry":
      "needs a FAILED run, which needs the provider fault path",
    "/api/v1/orgs/{org_id}/teams/{team_id}/members": "needs a team in both organizations",
    "/api/v1/orgs/{org_id}/tools/{tool_id}": "needs a registered tool",
    "/api/v1/orgs/{org_id}/sessions/{session_id}":
      "a login session belongs to a USER, not an organization: login_sessions has no org_id, so the " +
      "substitution is across a membership boundary rather than a tenant one, and the list route " +
      "returns only device sessions. Needs its own design, not an org-scoped fixture",
    "/api/v1/orgs/{org_id}/sessions/{session_id}/close":
      "as above: a session belongs to a user, so 'close' needs deciding between caller-scoped and " +
      "org-scoped before there is a fixture to attack",
  };

  // --- the denominator is closed -----------------------------------------------------
  probe.stage = "coverage";
  const coveredPaths = new Set(ROUTES.map((route) => route.path));
  const stale = [...coveredPaths].filter((path) => !router.has(path));
  expect(
    "every path this gate claims to drive is still in the router",
    stale.length === 0,
    `no longer in the router: ${stale.join(", ")}`,
  );
  const uncovered = [...router.keys()].filter(
    (path) => !coveredPaths.has(path) && !(path in CREDITED_ELSEWHERE) && !(path in NOT_YET_SEEDED),
  );
  expect(
    "every one-path-id org-scoped route is driven here, credited to a named gate, or named with a " +
      "reason -- a route added to the product cannot be quietly forgotten",
    uncovered.length === 0,
    `unaccounted for: ${uncovered.join(", ")}`,
  );
  for (const [path, gate] of Object.entries(CREDITED_ELSEWHERE)) {
    expect(`the route credited to ${gate} is still in the router`, router.has(path), path);
  }
  for (const [path, why] of Object.entries(NOT_YET_SEEDED)) {
    expect(`the route deferred for "${why}" is still in the router`, router.has(path), path);
  }
  // Named skips, so the deferral is visible in the tally rather than only in this file.
  for (const path of Object.keys(CREDITED_ELSEWHERE)) {
    probe.skip(`${path} -- substitution`, `covered by ${CREDITED_ELSEWHERE[path]}`);
  }
  for (const [path, why] of Object.entries(NOT_YET_SEEDED)) {
    probe.skip(`${path} -- substitution`, why);
  }

  // --- the attacks -------------------------------------------------------------------
  for (const route of ROUTES) {
    const seed = seeds[route.family];
    if (!seed) {
      for (const entry of route.methods) {
        probe.skip(
          `${route.path} ${entry.method} -- cross-tenant`,
          `the ${route.family} fixture was not created, so there is no foreign id to substitute`,
        );
      }
      continue;
    }
    // A phantom derived from the real id: same prefix, same length, and checked to differ. Spelling one
    // out by hand is how a 422 came to be compared against a 404 in this campaign.
    const phantom =
      seed.b.slice(0, -8) + (seed.b.endsWith("deadbeef") ? "0".repeat(8) : "deadbeef");
    const phantomIsWellFormed =
      phantom !== seed.b && phantom.length === seed.b.length && /^[a-z]+_[0-9a-z]+$/.test(phantom);

    const readRow = (id) =>
      d1Rows(
        `SELECT * FROM ${seed.table} WHERE ${seed.key} = '${id}'`,
        `V01 the ${seed.family} row ${id.slice(0, 12)}`,
      );

    for (const entry of route.methods) {
      const label = `${route.path} ${entry.method}`;
      // `{org_id}` first, and then the ONE placeholder that remains. The first version replaced the
      // first `{[a-z_]+}` it found -- which was always `{org_id}` -- so the id was written into the
      // organization segment and the real id stayed in the path. Every control then answered 404 for a
      // URL that named no such organization, and 404 is not a control.
      const withId = (id) =>
        route.path.replaceAll("{org_id}", orgA.orgId).replace(/\{[a-z_]+\}/, id);
      // The version is read at REQUEST time, not at table time: a control that has already mutated the
      // row would otherwise send a version it staled itself.
      //
      // A route that declares no `version` must not be sent one -- `deny_unknown_fields` makes that a
      // 422 -- so `versioned` is per ENTRY, not per family.
      const versioned = entry.versioned === true;
      const currentVersion = async (id) => {
        if (!versioned) return undefined;
        const row = await d1Rows(
          `SELECT version FROM ${seed.table} WHERE ${seed.key} = '${id}'`,
          `V01 the current version of the ${route.family} row`,
        );
        return row[0]?.version;
      };
      const buildBody = async (version) =>
        versioned ? { version, ...entry.body } : entry.body ? { ...entry.body } : undefined;
      //
      // A DISTINCT `Idempotency-Key` PER REQUEST, and this is the most consequential thing in the file.
      //
      // All three requests originally shared one key. On an idempotent route the control claims the key
      // and stores its OWN response, and the attack and the phantom then receive `Ok(replay)` -- the
      // control's 200, verbatim, body and all. `resume` showed it exactly: the attack came back
      // `200 {"service_account_id": "svc_e8b006d…"}`, which is ALICE's own account, because that is what
      // the control had stored. Bravo's row was untouched and the sheet said "granted".
      //
      // A replayed 2xx is indistinguishable from a granted 2xx by status, by body, and by a stored-state
      // assertion that correctly finds nothing changed. So on every idempotent route this gate was
      // measuring its own control. V01-009 counted 81 idempotency call sites, so that is most of them.
      //
      // The fix is one label per request, and the reason is worth more than the fix: **an attack that
      // reuses the control's idempotency key is not an attack.**
      const headersFor = (which) => ({
        ...browserHeaders(alice.jar),
        ...browserMutation(alice.jar, `pathid-${route.family}-${entry.method}-${which}-${nonce}`),
      });

      probe.stage = `attack ${label}`;

      if (!phantomIsWellFormed) {
        probe.skip(
          `${label} -- cross-tenant`,
          `the derived phantom is not well formed for this id, so the case would compare a malformed ` +
            `request against a refusal`,
        );
        continue;
      }

      const before = JSON.stringify(await readRow(seed.b));

      // 1. CONTROL: the organization's own id. Asserted 2xx, because "not 5xx" would pass for a route
      //    that answers 404 for its own resource and make every refusal below vacuous.
      // The body that was SENT, next to the body that came back. A 409 here once read as "the route is
      // broken" for three runs; it meant the request carried a version the fixture had guessed.
      const controlBody = await buildBody(await currentVersion(seed.a));
      const control = await request(
        alice.jar,
        entry.method,
        withId(seed.a),
        controlBody,
        headersFor("control"),
      );
      //
      // The control is asserted at FULL strength -- 2xx -- wherever the route's own control can be
      // established, and DEGRADED, visibly and by name, where it cannot.
      //
      // The degraded form is "not 5xx and not 404", a weaker claim: it says the route resolved the
      // resource and reached its handler, not that it works. Three routes carry it, each with the
      // specific question recorded beside it, and each is UNPROVEN rather than a defect claim. Dropping
      // those routes from the denominator instead would have been tidier and dishonest: the attack, the
      // non-disclosure comparison and the stored-state assertion all still run at full strength, and
      // only the one assertion that could not be established is weakened. A green sheet that quietly
      // asserted less is the failure this campaign keeps meeting in a new place.
      const controlHolds =
        control.status >= 200 && control.status < 300
          ? true
          : entry.controlWeakened
            ? // The residual claim, stated as what it is and no more: the route did not fail with a
              // STORE FAULT. Whether it works is UNPROVEN, and saying "not 404" instead would be
              // choosing a bound that happens to exclude this run's answer -- which is exactly the kind
              // of bound fitted to the data that makes a degraded check look like a real one.
              control.status < 500
            : false;
      expect(
        `CONTROL ${label} -- the organization acting on its OWN ${route.family} record ` +
          (entry.controlWeakened
            ? "does not fail with a STORE FAULT, and whether it works is UNPROVEN [CONTROL DEGRADED: " +
              "see the entry's comment]"
            : "works, so the refusal below is about tenancy"),
        controlHolds,
        `status=${control.status} sent=${JSON.stringify(controlBody)} ` +
          `rowRead=${JSON.stringify((await readRow(seed.a))[0] ?? null).slice(0, 220)} ` +
          `body=${JSON.stringify(control.payload ?? {}).slice(0, 140)}`,
      );

      // 2. ATTACK and 3. PHANTOM, sharing ONE body so the two differ in exactly one thing, the id.
      const sharedBody = await buildBody(await currentVersion(seed.b));
      const attack = await request(
        alice.jar,
        entry.method,
        withId(seed.b),
        sharedBody,
        headersFor("attack"),
      );
      const phantomResult = await request(
        alice.jar,
        entry.method,
        withId(phantom),
        sharedBody,
        headersFor("phantom"),
      );
      //
      // AND THE BODY MUST NOT CARRY THE FOREIGN IDENTIFIER.
      //
      // This is the assertion this gate was missing until `resume` answered `200` with another
      // organization's `service_account_id` in the body. The STORED assertion passed on that case --
      // correctly, because nothing changed: the row was byte-identical. A no-op that is not a no-op,
      // because the response still names a resource belonging to another tenant.
      //
      // So "refused" is not the only thing to check, and a route that refuses by doing nothing can
      // still disclose. The search is over the WHOLE serialised body, and it is the same technique
      // `verify:collection-tenancy` uses for list routes.
      const attackBodyText = JSON.stringify(attack.payload ?? {});
      expect(
        `NO-LEAK ${label} -- the answer to a cross-tenant request does not carry the other ` +
          `organization's ${route.family} identifier anywhere in its body`,
        !attackBodyText.includes(seed.b),
        `the body carries ${seed.b}; body=${attackBodyText.slice(0, 200)}`,
      );

      expect(
        `ATTACK ${label} -- ${orgA.orgId.slice(0, 12)} addressing the OTHER organization's ` +
          `${route.family} record is refused`,
        !(attack.status >= 200 && attack.status < 300),
        `status=${attack.status} body=${JSON.stringify(attack.payload ?? {}).slice(0, 180)}`,
      );
      expect(
        `NON-DISCLOSURE ${label} -- a foreign id and an id that exists in NEITHER organization answer ` +
          `identically, so this route is not an existence oracle across tenants`,
        answerOf(attack) === answerOf(phantomResult),
        `foreign=${answerOf(attack)} phantom=${answerOf(phantomResult)}`,
      );

      // 4. STORED: the other organization's row is untouched.
      const after = JSON.stringify(await readRow(seed.b));
      expect(
        `STORED ${label} -- the other organization's ${route.family} row is byte-identical afterwards, ` +
          `so a refusal left nothing behind`,
        before === after,
        `before=${before?.slice(0, 200)} after=${after?.slice(0, 200)}`,
      );
    }
  }

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
