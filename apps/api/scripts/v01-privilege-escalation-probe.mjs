#!/usr/bin/env node
// V01 Client privilege escalation — attempt to make the server grant authority the
// client asked for.
//
// WHY THIS PROBE IS SHAPED THE WAY IT IS
//
// Every other probe in this repository asks "what status came back?". That question is
// not enough here, and asking it anyway is how an escalation gate passes while the
// escalation happens.
//
// A client-supplied `role: "owner"` that is accepted with 200 and silently ignored is
// CORRECT. A client-supplied `role: "owner"` that is accepted with 200 and stored is a
// breach. Both look identical to a status-code check. So every attack below is graded
// three ways, and the verdict is about the *state*, read from D1:
//
//   REFUSED              the server refused at the boundary. Correct, and the strongest
//                        outcome.
//   ACCEPTED_BUT_INERT   2xx, and the stored state shows the client did NOT get what it
//                        asked for. Correct: the field was clamped, defaulted or ignored.
//   ESCALATED            2xx, and the stored state shows the client DID get it. A breach.
//
// Only ESCALATED fails. A probe that failed on 2xx would have to be weakened to pass, and
// a weakened escalation gate is worse than none: it would report that the boundary holds
// while the boundary is the thing being tested.
//
// TWO THINGS THAT MAKE A CLEAN SHEET MEANINGLESS, BOTH GUARDED HERE
//
// 1. The attacker must be a real plain member, or "everything was refused" only proves the
//    harness was talking to a stranger. The probe proves the attacker's role from D1 and
//    proves they can still do something a member is allowed to do. This is the same lesson
//    as V01-001's content search: a negative result from a probe that never engaged is not
//    a negative result.
//
// 2. Every attack is made against a real resource that really exists, and the read-back
//    names the resource. An attack against an id that does not exist proves nothing about
//    authorisation, because "not found" and "not permitted" are the same status.
//
// WHAT THIS DOES NOT ATTACK
//
// Cross-tenant substitution is `smoke:p08`'s job and is not repeated here except where a
// cross-tenant id is the only way to reach a class (credential id). Scope is
// authority-within-your-own-tenant, which had no runtime attack at all before this.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 privilege-escalation", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation, browserHeaders } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_ESC_PERSIST_TO", portEnvVar: "V01_ESC_PORT" });

  /** One attempted escalation and how it turned out. */
  const attacks = [];
  /**
   * Run an attack and grade it.
   *
   * `effect` is called with the response and returns what the client actually obtained:
   *   "none"  nothing it asked for
   *   "asked" exactly what it asked for
   * An attack that throws is not graded — the harness reports it, because a probe that
   * cannot complete an attack has not shown the attack fails.
   */
  async function attack(class_, label, run, effect) {
    let result;
    try {
      result = await run();
    } catch (error) {
      probe.fail(`${class_}: ${label} could not be completed`, String(error).slice(0, 200));
      attacks.push({ class_, label, grade: "INCOMPLETE", status: null });
      return null;
    }
    const obtained = await effect(result);
    const status = result.status;
    let grade;
    if (status >= 500) {
      grade = "STORE_FAULT";
    } else if (status >= 200 && status < 300) {
      grade = obtained === "asked" ? "ESCALATED" : "ACCEPTED_BUT_INERT";
    } else if (status === 404 || status === 405 || status === 501) {
      // The route is not there, so no authorization decision was ever made. Grading
      // this "REFUSED" would let a renamed or deleted route quietly turn every attack
      // in its class into a pass -- the probe would keep reporting a boundary it is no
      // longer touching.
      grade = "ROUTE_ABSENT";
    } else {
      grade = "REFUSED";
    }
    // The machine reason, read from the error envelope. `result.reason` was read first
    // and is always undefined: the harness's result carries `payload`, not a flattened
    // reason, so the verbose table printed nothing and a 409 stayed unexplained.
    const reason =
      result.payload?.error?.details?.reason ??
      result.payload?.error?.code ??
      (result.status < 300 ? null : "(no reason in the envelope)");
    attacks.push({
      class_,
      label,
      grade,
      status,
      obtained,
      reason,
      message: result.payload?.error?.message ?? "",
    });
    return result;
  }

  // --- fixtures --------------------------------------------------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Alice");
  const mallory = await probe.authenticatedUser("Mallory");
  const bob = await probe.authenticatedUser("Bob");
  const orgA = await probe.createOrganization(alice.jar, "Alice Org", `alice-org-${probe.nonce}`);
  const orgB = await probe.createOrganization(bob.jar, "Bob Org", `bob-org-${probe.nonce}`);
  await probe.inviteAndAccept(alice, mallory, orgA.orgId, "member");
  // The admin attacker exists because the member attacks are refused one layer ABOVE the
  // domain rules. An admin passes `Permission::MembersManage` and is still forbidden by
  // `can_change_role` and `role_can_be_invited`, so the admin is what makes the second
  // layer reachable -- and therefore what makes those rules provable rather than
  // merely unexercised.
  const abel = await probe.authenticatedUser("Abel");
  await probe.inviteAndAccept(alice, abel, orgA.orgId, "admin");

  const roleOf = async (email) => {
    const rows = await d1Rows(
      `SELECT m.role FROM memberships m JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = '${orgA.orgId}' AND u.email = '${email}'`,
      `V01 the role of ${email}`,
    );
    return rows[0]?.role;
  };

  // --- control 1: the attacker really is a plain member ----------------------
  probe.stage = "attacker-identity";
  const memberRows = await d1Rows(
    `SELECT m.role, m.status, u.email FROM memberships m
     JOIN users u ON u.user_id = m.user_id
     WHERE m.org_id = '${orgA.orgId}' AND u.email = '${mallory.email}'`,
    "V01 the attacker's stored role",
  );
  expect(
    "the attacker is stored as a plain active member, not an outsider and not an admin",
    memberRows.length === 1 && memberRows[0].role === "member" && memberRows[0].status === "active",
    JSON.stringify(memberRows[0] ?? {}),
  );

  // --- control 2: a member is not refused everything -------------------------
  // Without this, a probe whose cookie jar was broken would report a perfect sheet.
  const memberCan = await request(
    mallory.jar,
    "GET",
    `/api/v1/orgs/${orgA.orgId}`,
    undefined,
    browserHeaders(mallory.jar),
  );
  expectStatus(
    "a plain member can read its own organization, so the attacker's session works",
    memberCan,
    [200],
  );

  expect(
    "the second attacker is stored as an admin, who passes the route's permission check and is still bound by the domain",
    (await roleOf(abel.email)) === "admin",
    `abel role=${await roleOf(abel.email)}`,
  );

  // --- real resources to attack, one per class -------------------------------
  probe.stage = "targets";
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
  const projectId =
    project.payload?.id ?? project.payload?.project?.id ?? project.payload?.project_id;
  probe.pass(
    "id extraction note: three routes name their resource id differently (project `id`, " +
      "service_account `id`, budget `budget_id`), which is why a missing id is reported with " +
      "the body that produced it rather than as `undefined`",
    "recorded",
  );
  probe.expect(
    "Org A has a real project to attack",
    typeof projectId === "string",
    typeof projectId === "string"
      ? `project_id=${projectId}`
      : `project_id=${projectId}; HTTP ${project.status} ${JSON.stringify(project.payload).slice(0, 220)}`,
  );

  const budget = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/budgets`,
    {
      scope_type: "organization",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2026-12-31T23:59:59.000Z",
      limit_minor: 100_00,
      hard: true,
      currency: "USD",
    },
    browserMutation(alice.jar, "v01-budget"),
  );
  const budgetId = budget.payload?.budget?.budget_id ?? budget.payload?.budget_id;
  probe.expect(
    "Org A has a real budget to attack",
    typeof budgetId === "string",
    `budget_id=${budgetId}`,
  );

  const serviceAccount = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/service-accounts`,
    { name: "V01 target service account", capabilities: ["runs.read"] },
    browserMutation(alice.jar, "v01-sa"),
  );
  const serviceAccountId =
    serviceAccount.payload?.service_account?.id ?? serviceAccount.payload?.service_account_id;
  probe.expect(
    "Org A has a real service account to attack",
    typeof serviceAccountId === "string",
    typeof serviceAccountId === "string"
      ? `service_account_id=${serviceAccountId}`
      : `HTTP ${serviceAccount.status} ${JSON.stringify(serviceAccount.payload).slice(0, 220)}`,
  );

  // Org B's own service account, so the credential-id class attacks something that
  // exists rather than an id that is merely absent.
  const foreignServiceAccount = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/service-accounts`,
    { name: "V01 foreign service account", capabilities: ["runs.read"] },
    browserMutation(bob.jar, "v01-sa-b"),
  );
  const foreignServiceAccountId =
    foreignServiceAccount.payload?.service_account?.id ??
    foreignServiceAccount.payload?.service_account_id;
  probe.expect(
    "Org B has a real service account for the credential-id class",
    typeof foreignServiceAccountId === "string",
    typeof foreignServiceAccountId === "string"
      ? `foreign=${foreignServiceAccountId}`
      : `HTTP ${foreignServiceAccount.status} ${JSON.stringify(foreignServiceAccount.payload).slice(0, 220)}`,
  );

  const membershipRows = await d1Rows(
    `SELECT membership_id, user_id FROM memberships WHERE org_id = '${orgA.orgId}'`,
    "V01 Org A memberships",
  );
  const malloryMembership = membershipRows.find((row) => row.user_id === mallory.user.id);
  const abelMembership = membershipRows.find((row) => row.user_id === abel.user.id);
  probe.expect(
    "the attacker's own membership_id is known, so self-promotion can be aimed precisely",
    Boolean(malloryMembership?.membership_id),
    `membership_id=${malloryMembership?.membership_id}`,
  );
  probe.expect(
    "the admin's own membership_id is known, so admin self-promotion can be aimed precisely",
    Boolean(abelMembership?.membership_id),
    `membership_id=${abelMembership?.membership_id}`,
  );

  // =========================================================================
  // Class 1 — organization and project
  // =========================================================================
  probe.stage = "org-and-project";

  await attack(
    "org",
    "a member renames the organization",
    () =>
      request(
        mallory.jar,
        "PATCH",
        `/api/v1/orgs/${orgA.orgId}`,
        { display_name: "Owned By Mallory", slug: `owned-${probe.nonce}`.slice(0, 60), version: 1 },
        browserMutation(mallory.jar, "v01-esc-org-rename"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT display_name FROM organizations WHERE org_id = '${orgA.orgId}'`,
        "V01 org name after the rename attempt",
      );
      return rows[0]?.display_name === "Owned By Mallory" ? "asked" : "none";
    },
  );

  await attack(
    "org",
    "a member rewrites the tool policy to allow everything",
    () =>
      request(
        mallory.jar,
        "PUT",
        `/api/v1/orgs/${orgA.orgId}/policy/tools`,
        {
          schema_version: 1,
          default_posture: "allow",
          default_approval_mode: "never",
          tool_ids: [],
          denied_tool_ids: [],
        },
        browserMutation(mallory.jar, "v01-esc-policy"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT document_json, policy_version FROM tool_policies WHERE org_id = '${orgA.orgId}'`,
        "V01 tool policy after the attempt",
      );
      const document = String(rows[0]?.document_json ?? "");
      return /"default_posture"\s*:\s*"allow"/.test(document) || /"allow"/.test(document)
        ? "asked"
        : "none";
    },
  );

  // The org id in the body. `deny_unknown_fields` should refuse it outright; if a body
  // field ever wins over the path, a client could write into an organization it is not in,
  // which is the whole escalation question in one field.
  await attack(
    "org",
    "a body-supplied org_id is accepted as authoritative over the path",
    () =>
      request(
        mallory.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/projects`,
        {
          name: "V01 cross-org project",
          slug: `v01-cross-${probe.nonce}`.slice(0, 60),
          visibility: "org",
          org_id: orgB.orgId,
        },
        browserMutation(mallory.jar, "v01-esc-cross-org"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT name FROM projects WHERE org_id = '${orgB.orgId}' AND name = 'V01 cross-org project'`,
        "V01 did the project land in the other org",
      );
      return rows.length > 0 ? "asked" : "none";
    },
  );

  // =========================================================================
  // Class 2 — role and permission. The most severe class, and the one with the
  // most routes into it.
  // =========================================================================
  probe.stage = "role";

  const roleTargets = ["owner", "admin"];
  for (const role of roleTargets) {
    await attack(
      "role",
      `a member invites a new member as ${role}`,
      () =>
        request(
          mallory.jar,
          "POST",
          `/api/v1/orgs/${orgA.orgId}/invitations`,
          { email: `new-${role}-${probe.nonce}@example.test`.slice(0, 60), role },
          browserMutation(mallory.jar, `v01-esc-invite-${role}`),
        ),
      async (result) => {
        const rows = await d1Rows(
          `SELECT role FROM invitations WHERE org_id = '${orgA.orgId}' AND email LIKE '%${role}-${probe.nonce}%'`,
          `V01 invitations created as ${role}`,
        );
        if (rows.some((row) => row.role === role)) return "asked";
        return result.status >= 200 && result.status < 300 ? "none" : "none";
      },
    );
  }

  for (const role of roleTargets) {
    await attack(
      "role",
      `a member promotes itself to ${role}`,
      () =>
        request(
          mallory.jar,
          "PATCH",
          `/api/v1/orgs/${orgA.orgId}/members/${malloryMembership?.membership_id}`,
          { role, version: 1 },
          browserMutation(mallory.jar, `v01-esc-selfpromote-${role}`),
        ),
      async () => {
        const rows = await d1Rows(
          `SELECT role FROM memberships WHERE membership_id = '${malloryMembership?.membership_id}'`,
          "V01 the attacker's role after self-promotion",
        );
        return rows[0]?.role === role ? "asked" : "none";
      },
    );
  }

  // An admin CAN pass `Permission::MembersManage`, so these are the attacks that reach
  // `role_can_be_invited` and `can_change_role` rather than being refused one layer up.
  for (const role of ["owner"]) {
    await attack(
      "role",
      `an admin invites a new member as ${role}`,
      () =>
        request(
          abel.jar,
          "POST",
          `/api/v1/orgs/${orgA.orgId}/invitations`,
          { email: `abel-invite-${role}-${probe.nonce}@example.test`.slice(0, 60), role },
          browserMutation(abel.jar, `v01-esc-admin-invite-${role}`),
        ),
      async () => {
        const rows = await d1Rows(
          `SELECT role FROM invitations
           WHERE org_id = '${orgA.orgId}' AND email LIKE 'abel-invite-${role}-${probe.nonce}%'`,
          `V01 invitations an admin created as ${role}`,
        );
        return rows.some((row) => row.role === role) ? "asked" : "none";
      },
    );
  }

  for (const role of ["owner"]) {
    await attack(
      "role",
      `an admin promotes a member to ${role}`,
      () =>
        request(
          abel.jar,
          "PATCH",
          `/api/v1/orgs/${orgA.orgId}/members/${malloryMembership?.membership_id}`,
          { role, version: 1 },
          browserMutation(abel.jar, `v01-esc-admin-promote-${role}`),
        ),
      async () => {
        const rows = await d1Rows(
          `SELECT role FROM memberships WHERE membership_id = '${malloryMembership?.membership_id}'`,
          "V01 the member's role after the admin's promotion attempt",
        );
        return rows[0]?.role === role ? "asked" : "none";
      },
    );

    await attack(
      "role",
      `an admin promotes itself to ${role}`,
      () =>
        request(
          abel.jar,
          "PATCH",
          `/api/v1/orgs/${orgA.orgId}/members/${abelMembership?.membership_id}`,
          { role, version: 1 },
          browserMutation(abel.jar, `v01-esc-admin-self-${role}`),
        ),
      async () => {
        const rows = await d1Rows(
          `SELECT role FROM memberships WHERE membership_id = '${abelMembership?.membership_id}'`,
          "V01 the admin's own role after the self-promotion attempt",
        );
        return rows[0]?.role === role ? "asked" : "none";
      },
    );
  }

  await attack(
    "role",
    "a member transfers ownership to itself",
    () =>
      request(
        mallory.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
        { target_membership_id: malloryMembership?.membership_id },
        browserMutation(mallory.jar, "v01-esc-transfer"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT COUNT(*) AS owners FROM memberships WHERE org_id = '${orgA.orgId}' AND role = 'owner' AND status = 'active'`,
        "V01 active owners after the transfer attempt",
      );
      return Number(rows[0]?.owners) > 1 ? "asked" : "none";
    },
  );

  // =========================================================================
  // Class 3 — entitlement and budget
  // =========================================================================
  probe.stage = "budget";

  const budgetBefore = await d1Rows(
    `SELECT limit_minor, hard, version FROM budgets WHERE budget_id = '${budgetId}'`,
    "V01 budget before the escalation attempts",
  );

  await attack(
    "budget",
    "a member raises the organization budget and clears the hard limit",
    () =>
      request(
        mallory.jar,
        "PATCH",
        `/api/v1/orgs/${orgA.orgId}/budgets/${budgetId}`,
        { limit_minor: 999_999_99, hard: false, version: budgetBefore[0]?.version ?? 1 },
        browserMutation(mallory.jar, "v01-esc-budget"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT limit_minor, hard FROM budgets WHERE budget_id = '${budgetId}'`,
        "V01 budget after the attempt",
      );
      const before = budgetBefore[0];
      if (!before) return "none";
      return Number(rows[0]?.limit_minor) !== Number(before.limit_minor) ||
        String(rows[0]?.hard) !== String(before.hard)
        ? "asked"
        : "none";
    },
  );

  await attack(
    "budget",
    "a member creates a second, larger budget",
    () =>
      request(
        mallory.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/budgets`,
        {
          scope_type: "organization",
          period_start: "2026-01-01T00:00:00.000Z",
          period_end: "2026-12-31T23:59:59.000Z",
          limit_minor: 999_999_99,
          hard: false,
          currency: "USD",
        },
        browserMutation(mallory.jar, "v01-esc-budget-new"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT COUNT(*) AS n FROM budgets WHERE org_id = '${orgA.orgId}' AND limit_minor >= 999_999_99`,
        "V01 budgets at the attacker's requested limit",
      );
      return Number(rows[0]?.n) > 0 ? "asked" : "none";
    },
  );

  // =========================================================================
  // Class 4 — tool capability
  // =========================================================================
  probe.stage = "capability";

  await attack(
    "capability",
    "a member mints a service account with every capability",
    () =>
      request(
        mallory.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/service-accounts`,
        {
          name: "V01 escalated service account",
          capabilities: ["members.manage", "budgets.manage", "credentials.manage"],
        },
        browserMutation(mallory.jar, "v01-esc-sa"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT capabilities_json FROM service_accounts
         WHERE org_id = '${orgA.orgId}' AND name = 'V01 escalated service account'`,
        "V01 the escalated service account's capabilities",
      );
      if (rows.length === 0) return "none";
      const capabilities = String(rows[0]?.capabilities_json ?? "");
      return /members\.manage|budgets\.manage|credentials\.manage/.test(capabilities)
        ? "asked"
        : "none";
    },
  );

  await attack(
    "capability",
    "a member rewrites its own service account's capabilities",
    () =>
      request(
        mallory.jar,
        "PATCH",
        `/api/v1/orgs/${orgA.orgId}/service-accounts/${serviceAccountId}`,
        { capabilities: ["members.manage", "credentials.manage"], version: 1 },
        browserMutation(mallory.jar, "v01-esc-sa-patch"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT capabilities_json FROM service_accounts WHERE service_account_id = '${serviceAccountId}'`,
        "V01 the target service account's capabilities",
      );
      const capabilities = String(rows[0]?.capabilities_json ?? "");
      return /members\.manage|credentials\.manage/.test(capabilities) ? "asked" : "none";
    },
  );

  // =========================================================================
  // Class 5 — model alias and route
  // =========================================================================
  probe.stage = "model-route";

  await attack(
    "model",
    "a member publishes a route whose candidates carry a foreign credential_id",
    () =>
      request(
        mallory.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/routes`,
        {
          alias: `escalated-${probe.nonce}`.slice(0, 60),
          display_name: "V01 escalated route",
          strategy: "fixed",
          config: {
            strategy: "fixed",
            candidates: [
              {
                provider_id: "openai",
                model_id: "gpt-4o",
                weight: 100,
                timeout_ms: 30_000,
                max_retries: 0,
                // A credential id the attacker does not own, named inside a body field.
                // If this is stored, the route would bill against another tenant's key.
                credential_id: foreignServiceAccountId,
              },
            ],
          },
        },
        browserMutation(mallory.jar, "v01-esc-route"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT r.route_id, v.config_json FROM routes r
         LEFT JOIN route_versions v ON v.route_version_id = r.active_version_id
         WHERE r.org_id = '${orgA.orgId}' AND r.alias LIKE 'escalated-%'`,
        "V01 the route the attacker published",
      );
      if (rows.length === 0) return "none";
      const config = String(rows[0]?.config_json ?? "");
      // A route that exists but dropped the foreign credential is inert; one that kept
      // it is the escalation, and naming the field matters more than the count.
      return config.includes(foreignServiceAccountId) ? "asked" : "none";
    },
  );

  await attack(
    "model",
    "a member adds a catalog model with wildcard capabilities",
    () =>
      request(
        mallory.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/catalog/models`,
        {
          provider_id: "openai",
          provider_model_id: "gpt-4o",
          display_name: "V01 escalated model",
          capabilities: ["*", "admin:*"],
        },
        browserMutation(mallory.jar, "v01-esc-model"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT capabilities_json FROM models WHERE display_name = 'V01 escalated model'`,
        "V01 the catalog model the attacker added",
      );
      if (rows.length === 0) return "none";
      return /"\*"/.test(String(rows[0]?.capabilities_json ?? "")) ? "asked" : "none";
    },
  );

  // =========================================================================
  // Class 6 — credential id, the one class that needs another tenant's id
  // =========================================================================
  probe.stage = "credential-id";

  await attack(
    "credential",
    "a member patches another organization's service account by id",
    () =>
      request(
        mallory.jar,
        "PATCH",
        `/api/v1/orgs/${orgA.orgId}/service-accounts/${foreignServiceAccountId}`,
        { capabilities: ["members.manage"], version: 1 },
        browserMutation(mallory.jar, "v01-esc-foreign-sa"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT capabilities_json, org_id FROM service_accounts WHERE service_account_id = '${foreignServiceAccountId}'`,
        "V01 the foreign service account after the attempt",
      );
      const capabilities = String(rows[0]?.capabilities_json ?? "");
      return /members\.manage|credentials\.manage/.test(capabilities) ? "asked" : "none";
    },
  );

  // =========================================================================
  // Class 7 — policy version. A stale or invented version must be refused rather
  // than applied, or a client can overwrite a policy it never read.
  // =========================================================================
  probe.stage = "policy-version";

  await attack(
    "policy-version",
    "a member rewrites the tool policy with an invented schema version",
    () =>
      request(
        mallory.jar,
        "PUT",
        `/api/v1/orgs/${orgA.orgId}/policy/tools`,
        {
          schema_version: 999_999,
          default_posture: "allow",
          default_approval_mode: "never",
          tool_ids: ["*"],
          denied_tool_ids: [],
        },
        browserMutation(mallory.jar, "v01-esc-policy-version"),
      ),
    async () => {
      const rows = await d1Rows(
        `SELECT policy_version, document_json FROM tool_policies WHERE org_id = '${orgA.orgId}'`,
        "V01 the tool policy after the version attack",
      );
      const document = String(rows[0]?.document_json ?? "");
      return Number(rows[0]?.policy_version) === 999_999 || /999999/.test(document)
        ? "asked"
        : "none";
    },
  );

  // =========================================================================
  // The verdicts
  // =========================================================================
  probe.stage = "verdicts";

  const routeAbsent = attacks.filter((a) => a.grade === "ROUTE_ABSENT");
  const escalated = attacks.filter((a) => a.grade === "ESCALATED");
  const storeFaults = attacks.filter((a) => a.grade === "STORE_FAULT");
  const incomplete = attacks.filter((a) => a.grade === "INCOMPLETE");
  const refused = attacks.filter((a) => a.grade === "REFUSED");
  const inert = attacks.filter((a) => a.grade === "ACCEPTED_BUT_INERT");

  expect(
    "no client-supplied field is honoured: every escalation attempt left the stored state with less authority than the client asked for",
    escalated.length === 0,
    escalated.length === 0
      ? `${attacks.length} attacks, ${refused.length} refused, ${inert.length} accepted but inert, 0 escalated`
      : escalated.map((a) => `${a.class_}: ${a.label} (HTTP ${a.status})`).join(" | "),
  );

  expect(
    "no escalation attempt is answered with a 5xx, which would be a store fault dressed as a refusal",
    storeFaults.length === 0,
    storeFaults.length === 0
      ? "none"
      : storeFaults.map((a) => `${a.label} -> ${a.status}`).join(" | "),
  );

  expect(
    "every attack was actually completed, so a clean sheet is a clean sheet",
    incomplete.length === 0,
    incomplete.length === 0
      ? `${attacks.length}/${attacks.length}`
      : incomplete.map((a) => a.label).join(" | "),
  );

  expect(
    "every refused attack was refused by an authorization or validation decision, not because the route is absent",
    routeAbsent.length === 0,
    routeAbsent.length === 0
      ? "no 404/405/501 among the refusals"
      : routeAbsent.map((a) => `${a.class_}: ${a.label} -> ${a.status}`).join(" | "),
  );

  // The attacker's own role, one last time, read from the database rather than inferred
  // from the responses above.
  const finalRole = await d1Rows(
    `SELECT role FROM memberships WHERE membership_id = '${malloryMembership?.membership_id}'`,
    "V01 the attacker's final role",
  );
  expect(
    "the attacker is still a plain member after the whole campaign",
    finalRole[0]?.role === "member",
    `role=${finalRole[0]?.role}`,
  );

  const byClass = {};
  for (const a of attacks) {
    byClass[a.class_] = (byClass[a.class_] ?? 0) + 1;
  }
  console.log(
    `\n${attacks.length} privilege-escalation attacks across ${Object.keys(byClass).length} classes: ${Object.entries(
      byClass,
    )
      .map(([k, n]) => `${k} x${n}`)
      .join(", ")}`,
  );
  console.log(
    `  refused ${refused.length}, accepted-but-inert ${inert.length}, escalated ${escalated.length}` +
      (routeAbsent.length > 0 ? `, route-absent ${routeAbsent.length}` : ""),
  );
  const byStatus = {};
  for (const a of attacks) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  console.log(
    `  status distribution: ${Object.entries(byStatus)
      .sort((x, y) => x[0] - y[0])
      .map(([code, n]) => `${code} x${n}`)
      .join("  ")}`,
  );

  // ===================================================================
  // GAP-002 -- the last-owner rules, at the HTTP layer.
  //
  // `f02` FR-F02-005: "An organization MUST have at least one active owner. Removing/demoting the last
  // owner MUST fail transactionally." `can_leave` and `can_remove_member` are unit-tested, and V01-003
  // proved that a correct-looking unit test had been sitting on top of a real defect. Nothing attacked
  // the ROUTES: could the last owner demote themselves, remove themselves, or leave?
  //
  // Graded on STORED STATE in D1, not on the status: a 2xx is the claim, and a membership row that still
  // says `owner` afterwards is the evidence. "Fail transactionally" is the part a status cannot express
  // at all -- it means the refusal left nothing behind -- so every attack is followed by a re-read of the
  // owner's own row and of the organization's active-owner count.
  //
  // THREE controls, because without them this block is the V01-030 shape exactly: a sheet of `PASS` rows
  // measuring a route that refuses everyone, over a fixture that never had an owner to lose.
  //
  //   C1 the SOLO organization really has exactly ONE active owner before the first attack. If the
  //      fixture were wrong, all three attacks would be refused for an unrelated reason and every one
  //      would pass while proving nothing -- "the last owner" has to BE the last owner.
  //   C2 the DUO organization really has TWO, so the control below removes a real second owner.
  //   C3 in the DUO organization the SAME demotion SUCCEEDS. Without it, "every attack was refused" is
  //      indistinguishable from "the route refuses everything" -- the failure mode that let V01-030
  //      report six passing cross-tenant rows for a route its own owner could not use.
  // ===================================================================
  probe.stage = "last-owner";
  const ownersIn = async (orgId) =>
    d1Rows(
      `SELECT u.email, m.role, m.status FROM memberships m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = '${orgId}' AND m.role = 'owner' AND m.status = 'active'`,
      `V01 the active owners of ${orgId.slice(0, 12)}`,
    );

  const solo = await probe.createOrganization(alice.jar, "Solo Org", `solo-org-${probe.nonce}`);
  const duo = await probe.createOrganization(alice.jar, "Duo Org", `duo-org-${probe.nonce}`);
  await probe.inviteAndAccept(alice, bob, duo.orgId, "member");
  // The REAL version, not a guess. Sending `version: 0` is what made this fixture look like a
  // last-owner refusal for four runs, and the answer it got was the misleading one V01-031 is about --
  // so a fixture that guesses a version is a fixture that cannot tell a domain rule from a lost race.
  const bobInDuo = await d1Rows(
    `SELECT m.membership_id, m.version FROM memberships m JOIN users u ON u.user_id = m.user_id
     WHERE m.org_id = '${duo.orgId}' AND u.email = '${bob.email}'`,
    "V01 Bob's membership id in the duo organization",
  );
  expect(
    "the duo fixture has exactly one Bob membership to promote",
    bobInDuo.length === 1,
    JSON.stringify(bobInDuo),
  );
  if (bobInDuo.length === 1) {
    const promote = await request(
      alice.jar,
      "PATCH",
      `/api/v1/orgs/${duo.orgId}/members/${bobInDuo[0].membership_id}`,
      { role: "owner", version: bobInDuo[0].version },
      { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-promote-${probe.nonce}`) },
    );
    expect(
      "the fixture can promote a member to owner at all, so C3's later success is a fact about the " +
        "last-owner rule and not about a route that refuses every role change",
      promote.status >= 200 && promote.status < 300,
      `status=${promote.status} body=${JSON.stringify(promote.payload ?? {}).slice(0, 200)}`,
    );
  }

  const soloOwners = await ownersIn(solo.orgId);
  expect(
    "C1 the solo organization has EXACTLY ONE active owner before any attack, so 'the last owner' is " +
      "the last owner -- otherwise all three attacks are refused for an unrelated reason and pass " +
      "while proving nothing",
    soloOwners.length === 1 && soloOwners[0].email === alice.email,
    `owners=${JSON.stringify(soloOwners)}`,
  );
  const duoOwners = await ownersIn(duo.orgId);
  expect(
    "C2 the duo organization has EXACTLY TWO active owners, so the control below removes a real second " +
      "owner",
    duoOwners.length === 2,
    `owners=${JSON.stringify(duoOwners)}`,
  );

  const aliceInSolo = await d1Rows(
    `SELECT m.membership_id, m.role, m.status FROM memberships m JOIN users u ON u.user_id = m.user_id
     WHERE m.org_id = '${solo.orgId}' AND u.email = '${alice.email}'`,
    "V01 Alice's membership id in the solo organization",
  );
  expect(
    "Alice's own membership row in the solo organization is readable and active, so there is a row " +
      "for the attacks to try to end",
    aliceInSolo.length === 1 && aliceInSolo[0].status === "active",
    JSON.stringify(aliceInSolo),
  );

  if (aliceInSolo.length === 1) {
    const membershipId = aliceInSolo[0].membership_id;
    const ownRole = aliceInSolo[0].role;
    const versionRow = await d1Rows(
      `SELECT version FROM memberships WHERE membership_id = '${membershipId}'`,
      "V01 Alice's membership version in the solo organization",
    );
    const version = versionRow[0]?.version ?? 0;

    /** One attack, and the stored-state assertions that give it meaning. */
    const lastOwnerAttack = async (label, method, path, body) => {
      const result = await request(alice.jar, method, path, body, {
        ...browserHeaders(alice.jar),
        ...browserMutation(alice.jar, `esc-${label}-${probe.nonce}`),
      });
      // `grade` is not optional here: the verbose attack table reads `a.grade.padEnd(17)`, and
      // omitting it crashed the probe AFTER every assertion had run -- 64 passed, 4 failed, and a
      // harness failure that hid the whole sheet behind a `Cannot read properties of undefined`.
      attacks.push({
        class_: "last-owner",
        label,
        status: result.status,
        grade: result.status >= 200 && result.status < 300 ? "granted" : "refused",
        reason: result.payload?.error?.details?.reason,
        message: result.payload?.error?.message,
      });
      expect(
        `the last owner cannot ${label} their own organization (FR-F02-005)`,
        !(result.status >= 200 && result.status < 300),
        `status=${result.status} body=${JSON.stringify(result.payload ?? {}).slice(0, 200)}`,
      );
      const after = await ownersIn(solo.orgId);
      expect(
        `the organization still has at least one active owner after the last owner tried to ${label}`,
        after.length >= 1,
        `owners after=${JSON.stringify(after)}`,
      );
      const row = await d1Rows(
        `SELECT role, status FROM memberships WHERE membership_id = '${membershipId}'`,
        `V01 Alice's membership after she tried to ${label}`,
      );
      expect(
        `Alice's own membership is UNCHANGED after she tried to ${label} -- the refusal was ` +
          `transactional, not a status with a half-applied write behind it`,
        row.length === 1 && row[0].role === ownRole && row[0].status === "active",
        `before role=${ownRole}/active  after=${JSON.stringify(row)}`,
      );
      return result;
    };

    await lastOwnerAttack("demote", "PATCH", `/api/v1/orgs/${solo.orgId}/members/${membershipId}`, {
      role: "member",
      version,
    });
    await lastOwnerAttack("remove", "DELETE", `/api/v1/orgs/${solo.orgId}/members/${membershipId}`);
    await lastOwnerAttack("leave", "POST", `/api/v1/orgs/${solo.orgId}/leave`, {});

    const aliceInDuo = await d1Rows(
      `SELECT m.membership_id, m.version FROM memberships m JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = '${duo.orgId}' AND u.email = '${alice.email}'`,
      "V01 Alice's membership id in the duo organization",
    );
    if (aliceInDuo.length === 1) {
      const control = await request(
        alice.jar,
        "PATCH",
        `/api/v1/orgs/${duo.orgId}/members/${aliceInDuo[0].membership_id}`,
        { role: "member", version: aliceInDuo[0].version },
        { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-c3-${probe.nonce}`) },
      );
      expect(
        "C3 with a second active owner present, the SAME demotion SUCCEEDS -- so the three refusals " +
          "above are about the last-owner rule and not about a route that refuses every role change",
        control.status >= 200 && control.status < 300,
        `status=${control.status} body=${JSON.stringify(control.payload ?? {}).slice(0, 200)}`,
      );
      const duoAfter = await ownersIn(duo.orgId);
      expect(
        "C3 the duo organization is left with exactly one active owner, so the demotion really did " +
          "remove an owner and the count moved",
        duoAfter.length === 1 && duoAfter[0].email === bob.email,
        `owners after=${JSON.stringify(duoAfter)}`,
      );
    }
  }

  // ===================================================================
  // FR-F02-006 -- ownership transfer, at the HTTP layer.
  //
  // `f02` requires four things, and they are four DIFFERENT checks in four different places:
  //
  //   1. current owner authorization   -> `authorize_org(.. Permission::OrgOwnershipTransfer ..)`
  //   2. target is an ACTIVE member    -> `find_membership_by_id` + a `status == 'active'` check
  //   3. recent re-authentication      -> `consume_reauth(.. "ownership_transfer" ..)`
  //   4. a security/audit event        -> `security_statement(.. "organization.ownership_transferred.v1" ..)`
  //
  // `can_transfer_ownership` may well be a pure function of (actor_role, target_status) and be
  // perfectly correct, and V01-003 already showed that tells us nothing about the wiring.
  //
  // TWO FIXTURE FACTS THAT DECIDE WHETHER THIS BLOCK MEASURES ANYTHING.
  //
  // First, the re-auth grant is CONSUMED before the target is even looked up: `transfer_ownership`
  // calls `consume_reauth` and only then reads the target membership. So a grant is single-use, and a
  // block that reuses one grant would have every later attack fail at `reauthentication_required` --
  // reporting a domain refusal for what is really a spent token. `freshReauth()` per attempt is not
  // tidiness, it is the difference between measuring the rule and measuring my own fixture. This is
  // V01-031's lesson again, from the other side: a fixture that reuses a consumed credential cannot
  // tell a domain rule from its own exhaustion.
  //
  // Second, the target lookup is `find_membership_by_id(&org_id, ..)`, so a membership that exists in
  // ANOTHER organization and one that exists NOWHERE are both absent from this org and must answer
  // identically. That is the non-disclosure requirement, and it is asserted by comparing the two
  // answers rather than by asserting that one of them looks like a refusal.
  // ===================================================================
  probe.stage = "ownership-transfer";
  const freshReauth = async (jar, label) => {
    const result = await request(
      jar,
      "POST",
      "/api/v1/account/reauth",
      {},
      { ...browserHeaders(jar), ...browserMutation(jar, `esc-reauth-${label}-${probe.nonce}`) },
    );
    if (!(result.status >= 200 && result.status < 300)) {
      console.log(
        `  NOTE  the re-auth endpoint answered ${result.status} for ${label}: ` +
          `${JSON.stringify(result.payload ?? {}).slice(0, 160)}`,
      );
      return null;
    }
    // RENAMED ON THE WAY OUT, and this bit immediately. `POST /account/reauth` returns
    // `{ grant_id, token }` while `TransferOwnershipRequest` declares `reauth_grant_id` and
    // `reauth_token`, so spreading the response produced a body missing two required fields and
    // **every** transfer in this block answered 422 -- including the control. The four refusals above
    // it were passing for the wrong reason, which is the failure this campaign has now hit twice: a
    // malformed request looks exactly like a domain rule refusing you.
    return {
      reauth_grant_id: result.payload?.grant_id,
      reauth_token: result.payload?.token,
    };
  };
  const membershipIdOf = async (orgId, email, label) => {
    const rows = await d1Rows(
      `SELECT m.membership_id, m.role, m.status FROM memberships m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = '${orgId}' AND u.email = '${email}'`,
      label,
    );
    return rows[0] ?? null;
  };
  const orgOwners = async (orgId) =>
    d1Rows(
      `SELECT u.email, m.role FROM memberships m JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = '${orgId}' AND m.status = 'active' AND m.role IN ('owner','admin')`,
      `V01 the owners and admins of ${orgId.slice(0, 12)}`,
    );

  const abelInA = await membershipIdOf(orgA.orgId, abel.email, "V01 Abel's membership in org A");
  const malloryInA = await membershipIdOf(
    orgA.orgId,
    mallory.email,
    "V01 Mallory's membership in org A",
  );
  const bobInB = await membershipIdOf(orgB.orgId, bob.email, "V01 Bob's membership in org B");
  expect(
    "the transfer fixtures exist: an admin and a plain member in org A, and an owner in org B whose " +
      "membership id is the cross-tenant target",
    abelInA !== null && malloryInA !== null && bobInB !== null,
    `abelA=${JSON.stringify(abelInA)} malloryA=${JSON.stringify(malloryInA)} bobB=${JSON.stringify(bobInB)}`,
  );

  const ownersBeforeA = await orgOwners(orgA.orgId);
  const ownersBeforeB = await orgOwners(orgB.orgId);
  const answerOf = (result) =>
    `${result.status}/${result.payload?.error?.details?.reason ?? "none"}`;

  if (abelInA && malloryInA && bobInB) {
    // --- T1: requirement 1, current owner authorization -------------------------
    const malloryGrant = await freshReauth(mallory.jar, "mallory");
    const t1 = await request(
      mallory.jar,
      "POST",
      `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
      { target_membership_id: abelInA.membership_id, ...(malloryGrant ?? {}) },
      { ...browserHeaders(mallory.jar), ...browserMutation(mallory.jar, `esc-t1-${probe.nonce}`) },
    );
    attacks.push({
      class_: "ownership-transfer",
      label: "T1 a plain member transfers ownership",
      status: t1.status,
      grade: t1.status >= 200 && t1.status < 300 ? "granted" : "refused",
      reason: t1.payload?.error?.details?.reason,
    });
    expect(
      "T1 a plain MEMBER cannot transfer ownership (FR-F02-006 requires current owner authorization)",
      !(t1.status >= 200 && t1.status < 300) && t1.status !== 422,
      `status=${t1.status} reason=${t1.payload?.error?.details?.reason} -- a 422 is a rejected body, ` +
        `which is not a refusal of the actor`,
    );
    expect(
      "T1 Mallory is still a plain member afterwards, so the refusal was not a 403 with a half-applied " +
        "role change behind it",
      (await membershipIdOf(orgA.orgId, mallory.email, "V01 Mallory after T1"))?.role === "member",
      `after=${JSON.stringify(await membershipIdOf(orgA.orgId, mallory.email, "V01 Mallory after T1"))}`,
    );

    // --- T2: requirement 2, and existence non-disclosure ------------------------
    // A membership that exists in org B, against one that exists in NEITHER org. Both must answer the
    // same way, or the route is an existence oracle across tenants.
    const aliceGrant1 = await freshReauth(alice.jar, "alice-t2");
    const t2Foreign = await request(
      alice.jar,
      "POST",
      `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
      { target_membership_id: bobInB.membership_id, ...(aliceGrant1 ?? {}) },
      { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-t2a-${probe.nonce}`) },
    );
    const phantomTarget = `mem_${"0".repeat(32)}`;
    const aliceGrant2 = await freshReauth(alice.jar, "alice-t2b");
    const t2Phantom = await request(
      alice.jar,
      "POST",
      `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
      { target_membership_id: phantomTarget, ...(aliceGrant2 ?? {}) },
      { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-t2b-${probe.nonce}`) },
    );
    for (const [label, result] of [
      ["T2a a membership belonging to org B", t2Foreign],
      ["T2b a membership that exists in neither org", t2Phantom],
    ]) {
      attacks.push({
        class_: "ownership-transfer",
        label,
        status: result.status,
        grade: result.status >= 200 && result.status < 300 ? "granted" : "refused",
        reason: result.payload?.error?.details?.reason,
      });
      expect(
        `${label} cannot receive ownership (FR-F02-006 requires an active member OF THIS ORG)`,
        !(result.status >= 200 && result.status < 300),
        `status=${result.status} reason=${result.payload?.error?.details?.reason}`,
      );
      // A 422 means the BODY was refused, not the target. Asserting the absence of a 2xx is not
      // enough on its own: a missing field produces a 422 that satisfies it while measuring nothing
      // about tenancy. This is the only thing that would have caught the bug above.
      expect(
        `${label} was refused by a RULE and not by a malformed body -- a 422 is a rejected request, ` +
          `and accepting one here would let this case pass without exercising anything`,
        result.status !== 422,
        `status=${result.status} -- if this is 422 the request body is wrong, not the target`,
      );
    }
    expect(
      "T2a and T2b answer IDENTICALLY, so the route is not an existence oracle: a membership that " +
        "exists in another organization is indistinguishable from one that exists nowhere",
      answerOf(t2Foreign) === answerOf(t2Phantom),
      `foreign(exists in org B)=${answerOf(t2Foreign)}  phantom(exists nowhere)=${answerOf(t2Phantom)}`,
    );
    const ownersAfterAttempts = await orgOwners(orgA.orgId);
    expect(
      "T2 org A's owners and admins are UNCHANGED, and org B's owner still owns org B",
      JSON.stringify(ownersAfterAttempts) === JSON.stringify(ownersBeforeA) &&
        JSON.stringify(await orgOwners(orgB.orgId)) === JSON.stringify(ownersBeforeB),
      `beforeA=${JSON.stringify(ownersBeforeA)} afterA=${JSON.stringify(ownersAfterAttempts)} ` +
        `beforeB=${JSON.stringify(ownersBeforeB)} afterB=${JSON.stringify(await orgOwners(orgB.orgId))}`,
    );

    // --- T3: requirement 3, recent re-authentication ----------------------------
    const t3 = await request(
      alice.jar,
      "POST",
      `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
      {
        target_membership_id: malloryInA.membership_id,
        reauth_grant_id: `rag_${"0".repeat(32)}`,
        reauth_token: "not-a-real-token",
      },
      { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-t3-${probe.nonce}`) },
    );
    attacks.push({
      class_: "ownership-transfer",
      label: "T3 a valid transfer with no re-auth grant",
      status: t3.status,
      grade: t3.status >= 200 && t3.status < 300 ? "granted" : "refused",
      reason: t3.payload?.error?.details?.reason,
    });
    expect(
      "T3 an owner cannot transfer ownership without recent re-authentication (FR-F02-006), and the " +
        "refusal says so rather than blaming the target",
      !(t3.status >= 200 && t3.status < 300) &&
        t3.payload?.error?.details?.reason === "reauthentication_required",
      `status=${t3.status} reason=${t3.payload?.error?.details?.reason}`,
    );

    // --- T4: requirement 2's OTHER half -- a target that EXISTS but is not active ------
    //
    // T2 proves the route refuses a target that does not exist in this org. That leaves the other half
    // of "an ACTIVE member" with no handler-level evidence: a membership that is present, belongs to
    // this org, and has been REMOVED. So Carol is invited, accepted, removed, and then targeted.
    const carol = await probe.authenticatedUser("Carol");
    await probe.inviteAndAccept(alice, carol, orgA.orgId, "member");
    const carolInA = await membershipIdOf(
      orgA.orgId,
      carol.email,
      "V01 Carol's membership in org A",
    );
    expect(
      "Carol is an active member of org A before she is removed",
      carolInA?.status === "active",
      JSON.stringify(carolInA),
    );
    if (carolInA) {
      const removal = await request(
        alice.jar,
        "DELETE",
        `/api/v1/orgs/${orgA.orgId}/members/${carolInA.membership_id}`,
        undefined,
        { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-carol-${probe.nonce}`) },
      );
      expect(
        "the fixture can remove a member, so T4's refusal is about the removal and not a route that " +
          "refuses every removal",
        removal.status >= 200 && removal.status < 300,
        `status=${removal.status} body=${JSON.stringify(removal.payload ?? {}).slice(0, 160)}`,
      );
      const carolAfter = await membershipIdOf(orgA.orgId, carol.email, "V01 Carol after removal");
      expect(
        "Carol's membership is stored as REMOVED, which is the precondition T4 depends on",
        carolAfter?.status === "removed",
        `after=${JSON.stringify(carolAfter)}`,
      );
      const aliceGrantT4 = await freshReauth(alice.jar, "alice-t4");
      const t4 = await request(
        alice.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
        { target_membership_id: carolInA.membership_id, ...(aliceGrantT4 ?? {}) },
        { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-t4-${probe.nonce}`) },
      );
      attacks.push({
        class_: "ownership-transfer",
        label: "T4 a REMOVED member of this org",
        status: t4.status,
        grade: t4.status >= 200 && t4.status < 300 ? "granted" : "refused",
        reason: t4.payload?.error?.details?.reason,
      });
      expect(
        "T4 ownership cannot be transferred to a member who has been REMOVED (FR-F02-006 requires an " +
          "ACTIVE target), and the refusal names that rather than blaming the target's existence",
        !(t4.status >= 200 && t4.status < 300) &&
          t4.status !== 422 &&
          t4.payload?.error?.details?.reason === "membership_required",
        `status=${t4.status} reason=${t4.payload?.error?.details?.reason}`,
      );
      // A SEPARATE assertion, and it is the one that carries the invariant. A refusal is a statement
      // about the request; this is a statement about the organization afterwards. Before V01-032 the
      // two were the same, because the SQL demoted the owner even when the target was ineligible --
      // and the refusal still looked correct.
      expect(
        "T4 org A still has an active owner after the attempt: the refusal left the ownership of the " +
          "organization untouched, which a status cannot show",
        (await orgOwners(orgA.orgId)).some((owner) => owner.role === "owner"),
        `owners after=${JSON.stringify(await orgOwners(orgA.orgId))}`,
      );
    }

    // --- T5: requirement 3's OTHER half -- a grant that is STALE, not absent ----------
    //
    // T3 uses a grant that never existed, which is a weaker condition than a stale one. The product
    // enforces `expires_at > now` in CONSUME_REAUTH_SQL, and that TTL is a real requirement, so it gets
    // its own case.
    //
    // The staleness is produced by SETTING UP A FIXTURE: the grant is issued by the real endpoint and
    // then its expiry is moved into the past in D1. That is arranging the situation, not weakening the
    // product -- the TTL check under test is untouched, and it is the check being exercised. The write
    // is asserted to have touched exactly one row and the row is read BACK, because a fixture that
    // silently did nothing would leave this case testing a fresh grant and passing for the wrong reason.
    //
    // The write is asserted by READING THE ROW BACK rather than by a change count, and that is not a
    // shortcut. `wrangler d1 execute --json` does not emit `meta.changes` for an UPDATE -- the whole
    // payload is `{"results": [], "success": true, "meta": {"duration": 0}}` -- so a helper reporting
    // `changes` would return 0 for a write that succeeded, and this case would have failed while the
    // fixture was in exactly the state it claims. Asserting the EFFECT is the stronger assertion
    // anyway: it is what the product will read.
    const staleGrant = await freshReauth(alice.jar, "alice-stale");
    if (staleGrant) {
      await d1Rows(
        `UPDATE reauthentication_grants SET expires_at = '2020-01-01T00:00:00.000Z' ` +
          `WHERE grant_id = '${staleGrant.reauth_grant_id}'`,
        "V01 age one re-auth grant into the past",
      );
      const grantRow = await d1Rows(
        `SELECT expires_at, consumed_at FROM reauthentication_grants ` +
          `WHERE grant_id = '${staleGrant.reauth_grant_id}'`,
        "V01 the aged grant read back",
      );
      expect(
        "the grant really is unconsumed and already expired, read back from D1 rather than assumed -- " +
          "this is the assertion that says T5 attacked what it claims to have attacked",
        grantRow.length === 1 &&
          grantRow[0].consumed_at === null &&
          String(grantRow[0].expires_at) < "2026-01-01",
        `row=${JSON.stringify(grantRow)}`,
      );
      const t5 = await request(
        alice.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
        { target_membership_id: malloryInA.membership_id, ...staleGrant },
        { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-t5-${probe.nonce}`) },
      );
      attacks.push({
        class_: "ownership-transfer",
        label: "T5 a valid transfer with an EXPIRED re-auth grant",
        status: t5.status,
        grade: t5.status >= 200 && t5.status < 300 ? "granted" : "refused",
        reason: t5.payload?.error?.details?.reason,
      });
      expect(
        "T5 a REAL grant that has EXPIRED is refused (FR-F02-006 requires RECENT re-authentication, and " +
          "recency is the part T3 could not test)",
        !(t5.status >= 200 && t5.status < 300) &&
          t5.status !== 422 &&
          t5.payload?.error?.details?.reason === "reauthentication_required",
        `status=${t5.status} reason=${t5.payload?.error?.details?.reason}`,
      );
    }

    // --- control: all four requirements met, so the route WORKS --------------------
    const aliceGrant = await freshReauth(alice.jar, "alice-control");
    const control = aliceGrant
      ? await request(
          alice.jar,
          "POST",
          `/api/v1/orgs/${orgA.orgId}/ownership-transfer`,
          { target_membership_id: malloryInA.membership_id, ...aliceGrant },
          { ...browserHeaders(alice.jar), ...browserMutation(alice.jar, `esc-ctl-${probe.nonce}`) },
        )
      : null;
    expect(
      "the re-auth endpoint issues a grant at all, without which the control below cannot distinguish " +
        "'the rule is enforced' from 'the route never works'",
      aliceGrant !== null,
      aliceGrant === null ? "the re-auth endpoint did not return a grant" : "",
    );
    if (control) {
      attacks.push({
        class_: "ownership-transfer",
        label: "C an owner transfers to an active member of their own org",
        status: control.status,
        grade: control.status >= 200 && control.status < 300 ? "granted" : "refused",
        reason: control.payload?.error?.details?.reason,
      });
      expect(
        "C an OWNER transferring to an ACTIVE member of their own org, with a fresh grant, SUCCEEDS -- " +
          "so the three refusals above are the rules and not a route that refuses everything",
        control.status >= 200 && control.status < 300,
        `status=${control.status} body=${JSON.stringify(control.payload ?? {}).slice(0, 200)}`,
      );
      const malloryAfter = await membershipIdOf(
        orgA.orgId,
        mallory.email,
        "V01 Mallory after the transfer",
      );
      const aliceAfter = await membershipIdOf(
        orgA.orgId,
        alice.email,
        "V01 Alice after the transfer",
      );
      expect(
        "C the STORED roles moved: the target is now the owner and the previous owner is now an admin",
        malloryAfter?.role === "owner" && aliceAfter?.role === "admin",
        `mallory=${JSON.stringify(malloryAfter)} alice=${JSON.stringify(aliceAfter)}`,
      );
      const audit = await d1Rows(
        `SELECT action, resource_type, outcome FROM security_events
         WHERE org_id = '${orgA.orgId}' AND action = 'organization.ownership_transferred.v1'`,
        "V01 the ownership-transfer audit row",
      );
      expect(
        "C a security event was written for the transfer (FR-F02-006's fourth requirement), so the " +
          "privileged operation left the audit trail the spec requires",
        audit.length >= 1,
        `rows=${JSON.stringify(audit)}`,
      );
    }
  }

  // Every attack, with its status and grade.
  //
  // The aggregate distribution is not enough to grade a sensitivity case, and finding
  // that out cost a run. Removing `role_can_be_invited`'s `Owner` exclusion does not
  // produce an escalation -- the `invitations` table has its own
  // `role IN ('admin','member','viewer')` CHECK and refuses the write -- so the
  // escalation assertion correctly stays green while the request travels a layer
  // further than it should. Without a per-attack table it is impossible to see that the
  // behaviour changed at all, and the sensitivity case reads MISSED when the honest
  // answer is "a third layer caught it".
  if (process.env.V01_ESC_VERBOSE) {
    console.log("\n  class          status  grade              attack");
    for (const a of attacks) {
      console.log(
        `  ${(a.class_ ?? "?").padEnd(14)} ${String(a.status).padEnd(7)} ${a.grade.padEnd(17)} ${a.label}`,
      );
      // The machine reason, when there is one. A status alone cannot tell a 409 caused by
      // an idempotency key collision from a 409 caused by a domain rule -- and the two
      // need opposite verdicts when grading a sensitivity case.
      if (a.reason) {
        console.log(`  ${" ".repeat(14)} ${"".padEnd(7)} reason: ${a.reason} — ${a.message ?? ""}`);
      }
    }
  }

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
