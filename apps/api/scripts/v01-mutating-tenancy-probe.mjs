#!/usr/bin/env node
// V01 Tenant isolation — MUTATING cross-tenant calls.
//
// WHY A SEPARATE PROBE
//
// `smoke:p08` drives 20 of the 104 org-scoped routes, and every one of them is a GET. Its
// own source says why the rest are absent:
//
//     if (method !== "GET") {
//         unproven.push(`${template} — ${method} needs a body this probe does not construct`);
//         continue;
//     }
//
// So the cross-tenant boundary is proven on the *read* half and untested on the *write*
// half. That is the half where a mistake does damage: a GET that leaks is a disclosure, and
// a PATCH that succeeds in another tenant is a write to someone else's data. The V00 record
// quantified the gap at 82 of 104 org-scoped routes with no handler-level evidence, of which
// 28 are mutating actions.
//
// WHAT "REFUSED" HAS TO MEAN HERE
//
// A 403 and a 404 are both refusals, and for a cross-tenant caller they must be
// *indistinguishable* — otherwise the status code is an existence oracle for another
// tenant's resources. So the assertion is NOT on the status. It is on the STATE: after every
// attempt, the targeted row is read back out of D1 and must be exactly as it was.
//
// That is the only form that catches the failure this probe exists for: a handler that
// validates the path's `org_id`, finds the row by the substituted id, and updates it without
// re-checking that the row belongs to the caller's tenant. Such a handler answers 200 and
// every status-based gate passes.
//
// TWO CALLERS, AND WHY BOTH
//
//   * **Org B's owner** against Org A's resources. Owning a tenant must confer nothing over
//     another tenant. This is the classic cross-tenant case.
//   * **Org A's own plain member** against Org A's *other* members' and resources'. Inside
//     one tenant the boundary is the permission model, and `smoke:p08` does not cover writes
//     there either. This is the case that V01-003 turned out to live in.
//
// A POSITIVE CONTROL PER ROUTE, OR THE PROBE PROVES NOTHING
//
// Every route is called a third time by Org A's legitimate **owner**, with the same body, and
// must succeed. Without that, a probe in which every body is malformed reports a perfect
// sheet: all twenty-four mutations refused, every one of them for the same wrong reason. The
// control is the difference between "the boundary held" and "the request never worked".

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 mutating-tenancy", async (probe) => {
  const { request, expect, expectStatus, d1Rows } = probe;
  const { browserMutation, browserHeaders } = probe;

  console.log("");
  await probe.setup({
    persistEnvVar: "V01_TEN_PERSIST_TO",
    portEnvVar: "V01_TEN_PORT",
  });

  // --- fixtures: two tenants and three people ---------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice"); // owner of Org A
  const bob = await probe.authenticatedUser("Bob"); // owner of Org B
  const mallory = await probe.authenticatedUser("Mallory"); // plain member of Org A
  const orgA = await probe.createOrganization(alice.jar, "Alice Org", `alice-org-${probe.nonce}`);
  const orgB = await probe.createOrganization(bob.jar, "Bob Org", `bob-org-${probe.nonce}`);
  await probe.inviteAndAccept(alice, mallory, orgA.orgId, "member");

  // --- targets: real rows in Org A, so a substitution has something to find -----
  probe.stage = "seeding";
  const targets = {};

  const project = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/projects`,
    {
      name: "V01 target project",
      slug: `v01-target-${probe.nonce}`.slice(0, 60),
      visibility: "org",
    },
    browserMutation(alice.jar, "v01-project"),
  );
  targets.projectId = project.payload?.id ?? project.payload?.project_id;

  // Versions are read from the database, not taken from a create response. Every one of
  // these routes is an optimistic write, so a version of 1 is not a safe default: it makes
  // a legitimate owner's write fail with 409 and the positive control read as a product
  // defect rather than a probe bug.
  /** One D1 write, with its output shown rather than discarded. */
  const d1Write = async (statement) => {
    const output = await probe.runWrangler(
      [
        "d1",
        "execute",
        "DB",
        "--local",
        "--env",
        "development",
        "--persist-to",
        probe.persistDir,
        "--command",
        statement,
      ],
      "V01 write",
    );
    return output;
  };

  const versionOf = async (table, idColumn, id) => {
    const rows = await d1Rows(
      `SELECT version FROM ${table} WHERE ${idColumn} = '${id}'`,
      `V01 ${table} version`,
    );
    return Number(rows[0]?.version ?? 1);
  };

  expect(
    "Org A has a real project",
    typeof targets.projectId === "string",
    `status=${project.status} id=${targets.projectId ?? "none"}`,
  );
  // Give the project a real `default_model_route` before the patch, and read it back as the
  // baseline. With the column NULL on both sides, "the rename left it alone" is trivially
  // true and would pass against the very statement that wrote a timestamp into it. The claim
  // is only worth anything if there is a value to lose.
  await d1Write(
    `UPDATE projects SET default_model_route = 'v01-fixture-route' WHERE project_id = '${targets.projectId}'`,
  );
  const projectBefore = await d1Rows(
    `SELECT default_model_route FROM projects WHERE project_id = '${targets.projectId}'`,
    "V01 the project's default_model_route before any patch",
  );
  expect(
    "the project's default_model_route holds a real value before the patch, so the preservation claim below is not vacuous",
    projectBefore[0]?.default_model_route === "v01-fixture-route",
    `default_model_route=${projectBefore[0]?.default_model_route ?? "null"}`,
  );
  targets.defaultModelRouteBefore = projectBefore[0]?.default_model_route ?? null;
  targets.projectVersion = await versionOf("projects", "project_id", targets.projectId);

  const serviceAccount = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/service-accounts`,
    { name: "V01 target service account", capabilities: ["runs.read"] },
    browserMutation(alice.jar, "v01-sa"),
  );
  targets.serviceAccountId = serviceAccount.payload?.service_account?.id;
  expect(
    "Org A has a real service account",
    typeof targets.serviceAccountId === "string",
    `status=${serviceAccount.status} id=${targets.serviceAccountId ?? "none"}`,
  );
  targets.serviceAccountVersion = await versionOf(
    "service_accounts",
    "service_account_id",
    targets.serviceAccountId,
  );

  const budget = await request(
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
    browserMutation(alice.jar, "v01-budget"),
  );
  targets.budgetId = budget.payload?.budget_id ?? budget.payload?.budget?.budget_id;
  targets.budgetVersion = await versionOf("budgets", "budget_id", targets.budgetId);
  expect(
    "Org A has a real budget",
    typeof targets.budgetId === "string",
    `status=${budget.status} id=${targets.budgetId ?? "none"}`,
  );

  const memberships = await d1Rows(
    `SELECT membership_id, user_id, role FROM memberships WHERE org_id = '${orgA.orgId}'`,
    "V01 Org A memberships",
  );
  const malloryRow = memberships.find((row) => row.user_id === mallory.user.id);
  const aliceRow = memberships.find((row) => row.user_id === alice.user.id);
  expect(
    "Org A's membership ids are known",
    Boolean(malloryRow && aliceRow),
    `members=${memberships.length}`,
  );
  targets.malloryMembershipId = malloryRow?.membership_id;
  targets.aliceMembershipId = aliceRow?.membership_id;

  // =========================================================================
  // The attacks.
  //
  // Each entry is `{ class, name, method, path, body, read }` where `read` returns the
  // targeted row's state from D1 AFTER the call. `mutated` is decided by comparing before
  // and after, never by the response.
  // =========================================================================
  probe.stage = "attacks";

  const snapshot = async (read) => {
    const rows = await d1Rows(read, "V01 target state");
    return JSON.stringify(rows);
  };

  const attacks = [
    {
      class: "role",
      name: "another org's owner promotes Org A's member to owner",
      caller: () => bob.jar,
      callerLabel: "Org B owner",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/members/${targets.malloryMembershipId}`,
      body: () => ({ role: "owner", version: 1 }),
      // The exact call V01-003 proved could escalate. Cross-tenant, it must be refused
      // outright: owning a tenant confers nothing over another tenant's roles.
      read: `SELECT role FROM memberships WHERE membership_id = '${targets.malloryMembershipId}'`,
      want: (before) => before,
      wantLabel: "the member's role is unchanged",
    },
    {
      class: "role",
      name: "Org A's plain member promotes another member to admin",
      caller: () => mallory.jar,
      callerLabel: "Org A plain member",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/members/${targets.aliceMembershipId}`,
      body: () => ({ role: "admin", version: 1 }),
      read: `SELECT role FROM memberships WHERE membership_id = '${targets.aliceMembershipId}'`,
      want: (before) => before,
      wantLabel: "the owner's role is unchanged",
    },
    {
      class: "role",
      name: "Org A's plain member promotes itself to admin",
      caller: () => mallory.jar,
      callerLabel: "Org A plain member",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/members/${targets.malloryMembershipId}`,
      body: () => ({ role: "admin", version: 1 }),
      read: `SELECT role FROM memberships WHERE membership_id = '${targets.malloryMembershipId}'`,
      want: (before) => before,
      wantLabel: "the attacker's own role is unchanged",
    },
    {
      class: "role",
      name: "another org's owner removes Org A's owner",
      caller: () => bob.jar,
      callerLabel: "Org B owner",
      method: "DELETE",
      path: () => `/api/v1/orgs/${orgA.orgId}/members/${targets.aliceMembershipId}`,
      body: () => undefined,
      read: `SELECT status FROM memberships WHERE membership_id = '${targets.aliceMembershipId}'`,
      want: (before) => before,
      wantLabel: "the owner's membership still stands",
    },
    {
      class: "capability",
      name: "another org's owner rewrites Org A's service account capabilities",
      caller: () => bob.jar,
      callerLabel: "Org B owner",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/service-accounts/${targets.serviceAccountId}`,
      body: () => ({
        capabilities: ["members.manage", "credentials.manage"],
        version: targets.serviceAccountVersion,
      }),
      read: `SELECT capabilities_json FROM service_accounts WHERE service_account_id = '${targets.serviceAccountId}'`,
      want: (before) => before,
      wantLabel: "the service account's capabilities are unchanged",
    },
    {
      class: "capability",
      name: "Org A's plain member rewrites the org's service account",
      caller: () => mallory.jar,
      callerLabel: "Org A plain member",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/service-accounts/${targets.serviceAccountId}`,
      body: () => ({ capabilities: ["members.manage"], version: targets.serviceAccountVersion }),
      read: `SELECT capabilities_json FROM service_accounts WHERE service_account_id = '${targets.serviceAccountId}'`,
      want: (before) => before,
      wantLabel: "the service account's capabilities are unchanged",
    },
    {
      class: "project",
      name: "another org's owner renames Org A's project",
      caller: () => bob.jar,
      callerLabel: "Org B owner",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/projects/${targets.projectId}`,
      body: () => ({ name: "Renamed By Bob", visibility: "org", version: targets.projectVersion }),
      read: `SELECT name FROM projects WHERE project_id = '${targets.projectId}'`,
      want: (before) => before,
      wantLabel: "the project's name is unchanged",
    },
    {
      class: "project",
      name: "Org A's plain member grants itself access to the org's project",
      caller: () => mallory.jar,
      callerLabel: "Org A plain member",
      method: "POST",
      path: () => `/api/v1/orgs/${orgA.orgId}/projects/${targets.projectId}/access`,
      // GrantRequest is { member_id?, team_id? } -- a grant names a MEMBERSHIP or a TEAM, not
      // a user and a role. The first version invented a user_id and a role, and the request
      // would have been refused by deny_unknown_fields for a reason that has nothing to do
      // with tenancy.
      body: () => ({ member_id: targets.malloryMembershipId }),
      read: `SELECT COUNT(*) AS n FROM project_access_grants WHERE project_id = '${targets.projectId}'`,
      want: (before) => before,
      wantLabel: "no access grant was created",
    },
    {
      class: "budget",
      name: "another org's owner raises Org A's budget and clears the hard limit",
      caller: () => bob.jar,
      callerLabel: "Org B owner",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/budgets/${targets.budgetId}`,
      body: () => ({ limit_minor: 999_999_99, hard: false, version: targets.budgetVersion }),
      read: `SELECT limit_minor, hard FROM budgets WHERE budget_id = '${targets.budgetId}'`,
      want: (before) => before,
      wantLabel: "the budget's limit and hard flag are unchanged",
    },
    {
      class: "budget",
      name: "Org A's plain member raises the org's budget",
      caller: () => mallory.jar,
      callerLabel: "Org A plain member",
      method: "PATCH",
      path: () => `/api/v1/orgs/${orgA.orgId}/budgets/${targets.budgetId}`,
      body: () => ({ limit_minor: 999_999_99, hard: false, version: targets.budgetVersion }),
      read: `SELECT limit_minor, hard FROM budgets WHERE budget_id = '${targets.budgetId}'`,
      want: (before) => before,
      wantLabel: "the budget's limit and hard flag are unchanged",
    },
    {
      class: "org",
      name: "another org's owner takes over Org A's ownership",
      caller: () => bob.jar,
      callerLabel: "Org B owner",
      method: "POST",
      path: () => `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
      body: () => ({ target_membership_id: targets.malloryMembershipId }),
      read: `SELECT COUNT(*) AS owners FROM memberships WHERE org_id = '${orgA.orgId}' AND role = 'owner' AND status = 'active'`,
      want: (before) => before,
      wantLabel: "Org A still has exactly one owner",
    },
  ];

  const results = [];

  /**
   * A body with an `undefined` value serialises to a body MISSING that key.
   *
   * `targets.projectVersion` was used before it was ever assigned, and the result was a 422
   * with an empty error envelope and no reason -- a missing required field, presented as a
   * malformed request. Nothing in the response said "the probe is wrong", so the wrong thing
   * read as a product refusal. A guard here names it.
   */
  const bodyOf = (attack) => {
    const body = attack.body();
    const missing = Object.entries(body ?? {}).filter(([, value]) => value === undefined);
    if (missing.length > 0) {
      throw new Error(
        `${attack.name}: body field(s) ${missing.map(([k]) => k).join(", ")} are undefined, so ` +
          "JSON.stringify drops them and the request arrives malformed. That reads as a product " +
          "refusal, not as a probe bug.",
      );
    }
    return body;
  };

  for (const attack of attacks) {
    const before = await snapshot(attack.read);
    const result = await request(
      attack.caller(),
      attack.method,
      attack.path(),
      bodyOf(attack),
      browserMutation(attack.caller(), `v01-ten-${attack.class}-${attack.name.slice(0, 24)}`),
    );
    const after = await snapshot(attack.read);
    const unchanged = before === after;
    results.push({
      ...attack,
      status: result.status,
      reason: result.payload?.error?.details?.reason ?? result.payload?.error?.code ?? null,
      unchanged,
      before,
      after,
    });
  }

  // =========================================================================
  // The verdicts
  // =========================================================================
  probe.stage = "verdicts";

  const mutated = results.filter((entry) => !entry.unchanged);
  expect(
    "no cross-tenant or intra-tenant mutation changed the targeted row: every write was either refused or inert",
    mutated.length === 0,
    mutated.length === 0
      ? `${results.length} mutations, all left the state untouched`
      : mutated
          .map(
            (entry) => `${entry.callerLabel} ${entry.method} ${entry.name} (HTTP ${entry.status})`,
          )
          .join(" | "),
  );

  const storeFaults = results.filter((entry) => entry.status >= 500);
  expect(
    "no mutation was answered with a 5xx, which would be a store fault wearing the costume of a refusal",
    storeFaults.length === 0,
    storeFaults.length === 0
      ? "none"
      : storeFaults.map((entry) => `${entry.name} -> ${entry.status}`).join(" | "),
  );

  const accepted = results.filter((entry) => entry.status >= 200 && entry.status < 300);
  expect(
    "no cross-tenant or member mutation was accepted at all, so the refusals are refusals rather than clamps",
    accepted.length === 0,
    accepted.length === 0
      ? "none accepted"
      : accepted
          .map((entry) => `${entry.callerLabel}: ${entry.name} -> ${entry.status}`)
          .join(" | "),
  );

  // The existence-oracle question. A cross-tenant refusal must be indistinguishable from a
  // resource that is not there, or the status code tells Bob whether Org A has a project with
  // that id.
  probe.stage = "oracle";
  const realId = results.find((entry) => entry.class === "project");
  if (realId) {
    const absentId = `prj_00000000000000000000000000000000`;
    const absent = await request(
      bob.jar,
      "PATCH",
      `/api/v1/orgs/${orgA.orgId}/projects/${absentId}`,
      { name: "x", visibility: "org", version: 1 },
      browserMutation(bob.jar, "v01-ten-absent"),
    );
    const present = await request(
      bob.jar,
      "PATCH",
      `/api/v1/orgs/${orgA.orgId}/projects/${targets.projectId}`,
      { name: "x", visibility: "org", version: 1 },
      browserMutation(bob.jar, "v01-ten-present"),
    );
    // Only the STATUS is compared here, and only to show it does not vary. If it does, the
    // refusal is doing work the caller's authorization should do instead.
    expect(
      "a cross-tenant refusal does not vary between a resource that exists and one that does not, so the status is not an existence oracle",
      absent.status === present.status,
      `absent id -> ${absent.status} ${absent.payload?.error?.details?.reason ?? absent.payload?.error?.code ?? ""}; ` +
        `present id -> ${present.status} ${present.payload?.error?.details?.reason ?? present.payload?.error?.code ?? ""}`,
    );
  }

  // The per-route positive control, and the reason this probe is not vacuous.
  probe.stage = "positive-controls";
  // The version is re-read HERE, not reused from the seeding stage. The control runs last,
  // after eleven other calls against the same row, and optimistic concurrency means the
  // value it needs is whatever the row holds now. Reusing a version captured before the
  // campaign makes the control fail with 409 and read as a product defect.
  const controlVersion = await versionOf("projects", "project_id", targets.projectId);
  const control = await request(
    alice.jar,
    "PATCH",
    `/api/v1/orgs/${orgA.orgId}/projects/${targets.projectId}`,
    { name: "Renamed By Alice", visibility: "org", version: controlVersion },
    browserMutation(alice.jar, "v01-ten-control"),
  );
  expectStatus(
    "CONTROL: Org A's own owner can rename its own project, so the project route and the body are both sound",
    control,
    [200],
  );
  const controlAfter = await snapshot(
    `SELECT name FROM projects WHERE project_id = '${targets.projectId}'`,
  );
  expect(
    "the control's write is visible in the state, so a state comparison can tell the difference",
    controlAfter.includes("Renamed By Alice"),
    controlAfter.slice(0, 160),
  );

  // The two further defects the broken statement hid behind its broken WHERE clause, and
  // which a "did the rename work" check would never see (V01-008). The old statement would
  // have written a timestamp into `default_model_route` and the project's own id into
  // `updated_at`. Both are silent: nothing in the response mentions them.
  const columns = await d1Rows(
    `SELECT default_model_route, updated_at, version FROM projects WHERE project_id = '${targets.projectId}'`,
    "V01 the patched project's columns",
  );
  expect(
    "a rename leaves default_model_route alone: PatchProjectRequest has no model-route field, so patching a name must not clear the route",
    (columns[0]?.default_model_route ?? "") === (targets.defaultModelRouteBefore ?? ""),
    `before=${targets.defaultModelRouteBefore ?? "null"} after=${columns[0]?.default_model_route ?? "null"}`,
  );
  expect(
    "a rename writes a timestamp into updated_at, not the project's own id",
    typeof columns[0]?.updated_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(columns[0].updated_at) &&
      columns[0].updated_at !== targets.projectId,
    `updated_at=${columns[0]?.updated_at}`,
  );
  expect(
    "a successful patch bumps the optimistic version, which is the proof the WHERE clause matched",
    Number(columns[0]?.version ?? 0) > targets.projectVersion,
    `version ${targets.projectVersion} -> ${columns[0]?.version}`,
  );

  // --- optimistic concurrency -------------------------------------------------
  // The families list "optimistic concurrency conflict" as a required attack and no probe
  // here had one. The control above has just bumped the version, so `targets.projectVersion`
  // is now stale by construction -- which is exactly the state a client is in when two
  // people edit the same project, and the state the `WHERE version = ?7` guard exists for.
  //
  // It is added because the P3 sensitivity case was otherwise unobservable: the probe only
  // ever sent the CURRENT version, so removing the version comparison from the statement
  // changed nothing it could see.
  probe.stage = "optimistic-concurrency";
  const currentVersion = Number(columns[0]?.version ?? 0);
  const staleName = `Renamed Stale ${probe.nonce}`;
  const stale = await request(
    alice.jar,
    "PATCH",
    `/api/v1/orgs/${orgA.orgId}/projects/${targets.projectId}`,
    { name: staleName, visibility: "org", version: targets.projectVersion },
    browserMutation(alice.jar, "v01-ten-stale"),
  );
  expect(
    "a PATCH carrying a stale version is refused with a conflict, so a second editor cannot silently overwrite the first",
    stale.status === 409,
    `status=${stale.status} version sent=${targets.projectVersion} current=${currentVersion}`,
  );
  const afterStale = await d1Rows(
    `SELECT name, version FROM projects WHERE project_id = '${targets.projectId}'`,
    "V01 the project after the stale write",
  );
  expect(
    "the stale write changed nothing: the name is still the control's and the version did not advance",
    afterStale[0]?.name === "Renamed By Alice" && Number(afterStale[0]?.version) === currentVersion,
    `name=${afterStale[0]?.name} version=${afterStale[0]?.version}`,
  );

  // And the current version still works, so the refusal above is the conflict and not a
  // route that has stopped accepting writes.
  const retry = await request(
    alice.jar,
    "PATCH",
    `/api/v1/orgs/${orgA.orgId}/projects/${targets.projectId}`,
    { name: "Renamed Again", visibility: "org", version: currentVersion },
    browserMutation(alice.jar, "v01-ten-retry"),
  );
  expect(
    "the same write with the CURRENT version succeeds, so the conflict above was about the version and not about the route",
    retry.status === 200,
    `status=${retry.status}`,
  );

  // A refused mutation must also leave no NEW row, for the resource kinds where a write
  // creates rather than updates.
  const malloryGrants = await d1Rows(
    `SELECT COUNT(*) AS n FROM project_access_grants WHERE member_id = '${targets.malloryMembershipId}'`,
    "V01 access grants held by the attacker",
  );
  expect(
    "the attacker holds no access grant on the org's project",
    Number(malloryGrants[0]?.n ?? 0) === 0,
    `grants=${malloryGrants[0]?.n ?? "unknown"}`,
  );

  const finalRoles = await d1Rows(
    `SELECT u.email, m.role FROM memberships m JOIN users u ON u.user_id = m.user_id
     WHERE m.org_id = '${orgA.orgId}' ORDER BY u.email`,
    "V01 Org A memberships after the campaign",
  );
  expect(
    "Org A still has exactly one owner and one admin-free membership set",
    finalRoles.filter((row) => row.role === "owner").length === 1 &&
      finalRoles.filter((row) => row.role === "admin").length === 0,
    JSON.stringify(finalRoles).slice(0, 200),
  );

  console.log(
    `\n${results.length} mutating cross-tenant and intra-tenant attacks across ` +
      `${new Set(results.map((r) => r.class)).size} classes`,
  );
  const byStatus = {};
  for (const entry of results) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  console.log(
    `  status distribution: ${Object.entries(byStatus)
      .sort((x, y) => x[0] - y[0])
      .map(([code, n]) => `${code} x${n}`)
      .join("  ")}`,
  );
  console.log(`  state changed by: ${mutated.length} of ${results.length}`);
  if (process.env.V01_TEN_VERBOSE) {
    console.log("\n  status  caller                 attack");
    for (const entry of results) {
      console.log(
        `  ${String(entry.status).padEnd(7)} ${entry.callerLabel.padEnd(22)} ${entry.name}`,
      );
    }
  }

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
