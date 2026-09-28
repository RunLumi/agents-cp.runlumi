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
