#!/usr/bin/env node
// V01-021 — is usage attributed to the right org, project, principal and run?
//
// THE CLAIM, AND WHY IT IS THE ONE MOST LIKELY TO BE WRONG ON A GREEN BOARD
//
// The objective names it directly: "usage attributed to correct org/project/principal/run". The
// campaign record has it as **UNPROVEN with no evidence at all** — `verify:budget-concurrency` proves
// the *ceiling* and `verify:inference-failure` proves the *money is released*, but neither ever asks
// **whose** usage it is.
//
// Reading the code says it is correct, and the reading is specific:
//
//   * `RequestScope.project_id` is built from `effective_project_id`, which is the MANAGED RUN's
//     project or the TRUSTED POLICY SNAPSHOT's — never `request.project_id`. The caller's body
//     cannot reach attribution.
//   * a caller-supplied `run_id` forces `resolve_managed_run_scope(.., &principal, &org_id, ..)`,
//     so the run is resolved INSIDE the caller's org, and the project is then overwritten with the
//     run's own.
//   * the model alias goes through `policy.allows_alias` and `find_route_by_alias(&org_id, ..)`.
//
// That is a good design, and it is exactly the kind of design this campaign has repeatedly found to
// be wrong by reading: V01-008's placeholders, V01-011's 33 values against 34 columns and V01-013's
// missing SET entry all read as fine. **So the code reading is the hypothesis, not the finding, and
// the attack is what settles it.**
//
// THE STRONGEST ASSERTION IS A DATABASE INVARIANT, NOT A STATUS
//
// After driving one real inference in each of two organizations, every row in `usage_events` must be
// INTERNALLY CONSISTENT: the project it names belongs to the org it names, the principal is a member
// of that org, the credential belongs to that org, and the run belongs to that org.
//
// That single property catches a mis-attribution no status code would, and it catches one that
// reading a handler cannot see because the bug may live in a repository three layers down. It is
// the same discipline as `verify:idempotency`'s row counts: grade on what was STORED.
//
// THE ESCALATION LEG, AND WHY NAMING A FOREIGN RUN IS THE INTERESTING CASE
//
// The caller of `/api/v1/inference/responses` may name `project_id`, `run_id` and `model`. Each is
// attacked with the OTHER organization's identifier, because each is a different kind of authority
// question:
//
//   * a foreign `project_id` — is a caller's body able to steer attribution?
//   * a foreign `run_id` — the objective's "credential id" analogue for runs, and the one the
//     managed path resolves rather than trusts;
//   * a foreign model alias — the objective's "model alias/route" bullet, and the one a *policy*
//     could plausibly be expected to gate.
//
// And then the leak detector: **no identifier belonging to Org B may appear in any row written while
// Org A was attacking.** That is graded by searching the serialised rows for Org B's actual ids, not
// by trusting a status.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 usage attribution", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation, browserHeaders } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_USAGE_PERSIST_TO", portEnvVar: "V01_USAGE_PORT" });

  // ------------------------------------------------------------------------
  // A per-organization fixture: budget, project, credential, published route.
  // ------------------------------------------------------------------------
  const buildOrg = async (label) => {
    const owner = await probe.authenticatedUser(label);
    const org = await probe.createOrganization(
      owner.jar,
      `${label} Org`,
      `v01-usage-${label.toLowerCase()}-${probe.nonce}`,
    );
    const orgId = org.orgId;
    const mutation = (l) => browserMutation(owner.jar, `v01-usage-${label.toLowerCase()}-${l}`);

    // A hard budget, so a reservation is actually taken. Without one every money claim here is a
    // claim about nothing.
    const budget = await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/budgets`,
      {
        scope_type: "organization",
        period_start: "2026-01-01T00:00:00.000Z",
        period_end: "2027-01-01T00:00:00.000Z",
        limit_minor: 100_00,
        hard: true,
        currency: "USD",
      },
      mutation("budget"),
    );
    const budgetId = budget.payload?.budget?.budget_id ?? budget.payload?.budget_id;
    expect(
      `CONTROL: ${label} has a hard organization budget, so a reservation is actually taken`,
      typeof budgetId === "string" && budget.status < 300,
      `status=${budget.status} budget_id=${budgetId ?? "none"}`,
    );

    // A project, so attribution has something to be wrong ABOUT.
    const project = await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/projects`,
      {
        name: `${label} project`,
        slug: `v01-usage-${label.toLowerCase()}-${probe.nonce}`.slice(0, 60),
        visibility: "org",
      },
      mutation("project"),
    );
    const projectId = project.payload?.id;
    expectStatus(`CONTROL: ${label} has a real project`, project, [201]);

    // The seeded catalog, then a credential and a published single-candidate route.
    const catalog = await request(
      owner.jar,
      "GET",
      `/api/v1/orgs/${orgId}/catalog`,
      undefined,
      browserHeaders(owner.jar),
    );
    const provider = (catalog.payload?.providers ?? []).find(
      (p) => p.provider_key === "mock-success",
    );
    const model = (catalog.payload?.models ?? []).find(
      (m) => m.provider_model_id === "mock-success",
    );
    if (!provider || !model) {
      probe.finish(
        2,
        `the seeded catalog did not provide mock-success to ${label}, so no inference is testable`,
      );
      return null;
    }
    const credential = await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/credentials`,
      {
        provider_id: provider.provider_id,
        owner_type: "organization",
        label: `${label} credential`,
        secret: `v01-usage-secret-${label}-${probe.nonce}`,
      },
      mutation("credential"),
    );
    const credentialId = credential.payload?.credential?.credential_id;
    const alias = `v01-usage-${label.toLowerCase()}`;
    const config = {
      strategy: "fixed",
      candidates: [
        {
          provider_id: provider.provider_id,
          model_id: model.model_id,
          weight: 100,
          timeout_ms: 1_000,
          max_retries: 0,
          credential_id: credentialId,
        },
      ],
    };
    const route = await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/routes`,
      { alias, display_name: `${label} route`, strategy: "fixed", config },
      mutation("route"),
    );
    const routeId = route.payload?.route?.route_id;
    let aliasUsable = false;
    if (typeof routeId === "string") {
      const published = await request(
        owner.jar,
        "POST",
        `/api/v1/orgs/${orgId}/routes/${routeId}/publish`,
        { version: route.payload?.route?.version, config },
        mutation("publish"),
      );
      aliasUsable = published.status === 200;
      expect(
        `CONTROL: the ${label} route is published`,
        aliasUsable,
        `status=${published.status} alias=${alias}`,
      );
    }
    if (typeof budgetId !== "string" || typeof projectId !== "string" || !aliasUsable) {
      return null;
    }
    return { label, owner, orgId, budgetId, projectId, credentialId, alias };
  };

  probe.stage = "fixtures";
  const a = await buildOrg("Alpha");
  if (!a) {
    probe.finish(2, "the Alpha fixture could not be built, so no attribution claim is testable");
    return;
  }
  const b = await buildOrg("Bravo");
  if (!b) {
    probe.finish(2, "the Bravo fixture could not be built, so no CROSS-TENANT claim is testable");
    return;
  }
  console.log(`\n  Alpha: org=${a.orgId} project=${a.projectId} alias=${a.alias}`);
  console.log(`  Bravo: org=${b.orgId} project=${b.projectId} alias=${b.alias}`);

  // The inference routes are not org-scoped in the path, so the org arrives in a header.
  const headersFor = (who) => ({
    ...browserHeaders(who.owner.jar),
    "X-Org-ID": who.orgId,
  });

  /** A real inference. `body` is merged so a case can name a foreign identifier. */
  const infer = (who, label, body = {}, path = "/api/v1/inference/chat/completions") =>
    request(
      who.owner.jar,
      "POST",
      path,
      {
        model: who.alias,
        messages: [{ role: "user", content: "V01 usage attribution" }],
        stream: false,
        ...body,
      },
      { ...headersFor(who), ...browserMutation(who.owner.jar, `v01-usage-ask-${label}`) },
    );

  // ------------------------------------------------------------------------
  // The state readers.
  // ------------------------------------------------------------------------
  const usageRows = () =>
    d1Rows(
      `SELECT usage_event_id, request_id, org_id, project_id, run_id, principal_user_id,
              device_id, credential_id, model_alias, input_tokens, output_tokens
         FROM usage_events ORDER BY created_at ASC, rowid ASC`,
      "V01 every usage_events row",
    );
  const usageCount = async () => (await usageRows()).length;

  // ------------------------------------------------------------------------
  // The control: one real inference per organization.
  // ------------------------------------------------------------------------
  probe.stage = "control";
  const before = await usageCount();
  const okA = await infer(a, "alpha");
  const okB = await infer(b, "bravo");
  console.log(`\n  Alpha inference -> ${okA.status}, Bravo inference -> ${okB.status}`);
  expect(
    "CONTROL: Alpha's own inference succeeds, so every attribution failure below is a mis-attribution rather than a request that never worked",
    okA.status >= 200 && okA.status < 300,
    `status=${okA.status} body=${probe.brief(okA.payload, 240)}`,
  );
  expect(
    "CONTROL: Bravo's own inference succeeds too, so the cross-tenant case has two real organizations to compare",
    okB.status >= 200 && okB.status < 300,
    `status=${okB.status} body=${probe.brief(okB.payload, 240)}`,
  );
  const after = await usageCount();
  expect(
    "CONTROL: both inferences wrote usage rows, so the attribution invariants below have something to check",
    after > before,
    `usage_events went ${before} -> ${after}; an empty table would make every assertion vacuous`,
  );
  if (after === before) {
    probe.finish(2, "no usage row was written, so the attribution invariants would be vacuous");
    return;
  }

  // ------------------------------------------------------------------------
  // THE DATABASE INVARIANT — the strongest assertion in this probe.
  // ------------------------------------------------------------------------
  probe.stage = "invariant";
  const rows = await usageRows();
  console.log(`\n  usage_events now holds ${rows.length} row(s):`);
  for (const r of rows) {
    console.log(
      `    org=${String(r.org_id).slice(4, 12)} project=${String(r.project_id ?? "null").slice(4, 12)} ` +
        `principal=${String(r.principal_user_id ?? "null").slice(4, 12)} ` +
        `run=${String(r.run_id ?? "null").slice(4, 12)} cred=${String(r.credential_id ?? "null").slice(4, 12)} ` +
        `alias=${r.model_alias}`,
    );
  }

  // A project, principal, credential or run that belongs to the OTHER org would be a cross-tenant
  // money and data leak, and no status code anywhere would show it.
  const mismatches = [];
  for (const r of rows) {
    if (!r.project_id) continue;
    const owner = (
      await d1Rows(
        `SELECT org_id FROM projects WHERE project_id = '${r.project_id}'`,
        `V01 the org owning project ${r.project_id}`,
      )
    )[0];
    if (!owner) mismatches.push(`project ${r.project_id} does not exist`);
    else if (owner.org_id !== r.org_id)
      mismatches.push(
        `row org ${r.org_id} names project ${r.project_id}, which belongs to ${owner.org_id}`,
      );
  }
  for (const r of rows) {
    if (!r.principal_user_id) continue;
    const member = (
      await d1Rows(
        `SELECT status FROM memberships WHERE org_id = '${r.org_id}' AND user_id = '${r.principal_user_id}'`,
        `V01 the membership behind principal ${r.principal_user_id}`,
      )
    )[0];
    if (!member)
      mismatches.push(
        `row org ${r.org_id} names principal ${r.principal_user_id}, who is not a member of it`,
      );
  }
  for (const r of rows) {
    if (!r.credential_id) continue;
    const owner = (
      await d1Rows(
        `SELECT org_id FROM credentials WHERE credential_id = '${r.credential_id}'`,
        `V01 the org owning credential ${r.credential_id}`,
      )
    )[0];
    if (!owner) mismatches.push(`credential ${r.credential_id} does not exist`);
    else if (owner.org_id !== r.org_id)
      mismatches.push(
        `row org ${r.org_id} names credential ${r.credential_id}, which belongs to ${owner.org_id}`,
      );
  }
  for (const r of rows) {
    if (!r.run_id) continue;
    const owner = (
      await d1Rows(
        `SELECT org_id FROM runs WHERE run_id = '${r.run_id}'`,
        `V01 the org owning run ${r.run_id}`,
      )
    )[0];
    if (!owner) mismatches.push(`run ${r.run_id} does not exist`);
    else if (owner.org_id !== r.org_id)
      mismatches.push(
        `row org ${r.org_id} names run ${r.run_id}, which belongs to ${owner.org_id}`,
      );
  }
  expect(
    "every usage row is INTERNALLY CONSISTENT: the project, principal, credential and run it names all belong to the org it names",
    mismatches.length === 0,
    mismatches.length === 0
      ? `${rows.length} row(s), each self-consistent`
      : `${mismatches.length} mis-attribution(s): ${mismatches.slice(0, 6).join("; ")}`,
  );
  expect(
    "each organization's usage is charged to ITS OWN alias, so one tenant cannot spend another's route",
    rows.every((r) => r.model_alias === a.alias || r.model_alias === b.alias),
    `aliases seen: ${JSON.stringify([...new Set(rows.map((r) => r.model_alias))])}`,
  );

  // ------------------------------------------------------------------------
  // THE ESCALATION LEG — Alpha names Bravo's identifiers.
  // ------------------------------------------------------------------------
  probe.stage = "escalation";
  const bravoRun = (
    await d1Rows(
      `SELECT run_id FROM runs WHERE org_id = '${b.orgId}' ORDER BY created_at ASC LIMIT 1`,
      "V01 a Bravo run to name",
    )
  )[0]?.run_id;
  console.log(
    `\n  escalating: Alpha will name Bravo's project (${String(b.projectId).slice(4, 12)}), ` +
      `run (${String(bravoRun ?? "none").slice(4, 12)}) and alias (${b.alias})`,
  );

  const cases = [
    {
      label: "a foreign project_id",
      body: { project_id: b.projectId },
      path: "/api/v1/inference/responses",
    },
    {
      label: "a foreign run_id",
      body: bravoRun ? { run_id: bravoRun } : null,
      path: "/api/v1/inference/responses",
    },
    {
      label: "a foreign model alias",
      body: { model: b.alias },
      path: "/api/v1/inference/chat/completions",
    },
  ];

  const escalationResults = [];
  for (const c of cases) {
    if (!c.body) {
      probe.skip(
        `Alpha naming Bravo's run_id`,
        `Bravo produced no run, so there is no foreign run to name. An unread case, reported rather than dropped.`,
      );
      continue;
    }
    const beforeRows = await usageCount();
    const result = c.path.endsWith("responses")
      ? await request(
          a.owner.jar,
          "POST",
          c.path,
          {
            model: a.alias,
            input: [{ role: "user", content: "V01 usage attribution" }],
            ...c.body,
          },
          {
            ...headersFor(a),
            ...browserMutation(a.owner.jar, `v01-usage-esc-${c.label.replaceAll(/\W+/g, "-")}`),
          },
        )
      : await infer(a, `esc-${c.label.replaceAll(/\W+/g, "-")}`, c.body, c.path);
    const afterRows = await usageCount();
    escalationResults.push({ ...c, result, wrote: afterRows - beforeRows });
    console.log(
      `    ${c.label.padEnd(22)} -> ${result.status} ` +
        `code=${result.payload?.error?.code ?? "none"} ` +
        `reason=${result.payload?.error?.details?.reason ?? "none"} ` +
        `message=${JSON.stringify(result.payload?.error?.message ?? "")} ` +
        `(usage rows +${afterRows - beforeRows})`,
    );
    // Whatever the status, a SUCCESSFUL escalation must not have written a row naming Bravo.
    expect(
      `Alpha naming ${c.label} is refused, or is answered without spending Bravo's budget`,
      result.status < 200 || result.status >= 300 || afterRows - beforeRows === 0,
      `status=${result.status} usage rows written=${afterRows - beforeRows} -- a 2xx that wrote a row ` +
        `here is the claim failing, whatever the status says`,
    );
  }

  // THE SHAPE OF THE REFUSAL, which is a separate claim from whether it refused.
  //
  // No money moved and nothing leaked, so the SECURITY claim holds. The DIAGNOSABILITY claim does
  // not: a client naming a model alias its organization has no route for is answered
  // `503 service_unavailable` -- "the inference service is unavailable" -- for a condition it
  // caused and can fix. It will retry, back off, and page someone.
  //
  // The cause is a catch-all: `gateway_error` maps a list of reasons to specific codes and sends
  // everything else to `ServiceUnavailable`, and `route_unavailable` is not on the list. So the
  // function's safety depends on a list nobody can check at compile time, and the one condition the
  // product detects routinely is the one missing from it.
  for (const r of escalationResults) {
    if (r.result.status < 500) continue;
    expect(
      `a refusal for "${r.label}" is an explicit 4xx with a stable reason, not a 503 that reads as an outage`,
      false,
      `status=${r.result.status} code=${r.result.payload?.error?.code ?? "none"} ` +
        `reason=${r.result.payload?.error?.details?.reason ?? "none"} ` +
        `message=${JSON.stringify(r.result.payload?.error?.message ?? "")} -- no money moved and ` +
        `nothing leaked, so the refusal is correct; but a client that named a model it is not ` +
        `entitled to is told the inference service is DOWN, and will retry and alert`,
    );
  }

  // ------------------------------------------------------------------------
  // THE LEAK DETECTOR — no Bravo identifier may appear in anything Alpha wrote.
  // ------------------------------------------------------------------------
  probe.stage = "leak-detector";
  const bravoIdentifiers = {
    org: b.orgId,
    project: b.projectId,
    credential: b.credentialId,
    alias: b.alias,
    ...(bravoRun ? { run: bravoRun } : {}),
  };
  const bravoUsers = (
    await d1Rows(
      `SELECT user_id FROM memberships WHERE org_id = '${b.orgId}'`,
      "V01 Bravo's members",
    )
  ).map((r) => r.user_id);

  const afterEscalation = await usageRows();
  // Only rows written during the escalation are in scope for the leak claim; the control rows are
  // Bravo's OWN and are supposed to name Bravo.
  const alphaRows = afterEscalation.filter((r) => r.org_id === a.orgId);
  const leaks = [];
  for (const r of alphaRows) {
    for (const [kind, value] of Object.entries(bravoIdentifiers)) {
      if (typeof value === "string" && value.length > 0 && JSON.stringify(r).includes(value)) {
        leaks.push(`an Alpha row names Bravo's ${kind} (${value})`);
      }
    }
    for (const user of bravoUsers) {
      if (r.principal_user_id === user)
        leaks.push(`an Alpha row is charged to Bravo's user ${user}`);
    }
  }
  expect(
    "NO row written by Alpha names ANY of Bravo's identifiers — its org, project, credential, alias, run or user",
    leaks.length === 0,
    leaks.length === 0
      ? `${alphaRows.length} Alpha row(s), none naming Bravo`
      : `${leaks.length} leak(s): ${leaks.slice(0, 6).join("; ")}`,
  );

  // And the per-case summary, so a reader can see which escalation did what.
  console.log(
    `\n  escalation summary: ${escalationResults
      .map((r) => `${r.label}=${r.result.status}(+${r.wrote})`)
      .join(", ")}`,
  );
  console.log(
    `  ${alphaRows.length} Alpha usage row(s) and ${
      afterEscalation.length - alphaRows.length
    } Bravo row(s) in total`,
  );

  probe.finish(probe.failures.length > 0 ? 1 : 0);
});
