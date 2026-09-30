#!/usr/bin/env node
// ============================================================================================
// V01-048 -- an exhausted HARD budget refuses the inference, and the refusal is not a zero-row
//           insert that happened to be noticed
//
// THE CLAIM, and it is one of the objective's five named budget requirements
//
//   1. "hard denial before upstream dispatch"
//   5. "unavailable authoritative budget state follows spec"
//
// and the product states its own rule for the read that produces the second one
// (`apps/api/src/repositories/budgets.rs:945`):
//
//   "A read error must be surfaced as `budget_state_unavailable`, never as 'allowed'."
//
// WHY THIS PATH, and what it turned out to be
//
// The first aim was requirement 5: drive the request to `budget_state_unavailable` and prove it
// fails closed. That refusal is reachable through `P05_BUDGET_SNAPSHOT_LIMIT` (128) -- when the
// applicable-snapshot read returns 128 or more, `p05_budget_admission` answers
// `p05_budget_unavailable`. **That is the MANAGED path only.** A request with no `run_id` skips the
// entire P05 block: the budget admission, the rate admission, all of it sit inside
// `if let Some(project_id) = managed_project_id` (`routes/inference.rs:1555`).
//
// So the unmanaged path -- an ordinary inference, which is what most traffic is -- has a
// DIFFERENT and much thinner budget control:
//
//   insert_budget_reservation_if_available_statement
//     WHERE NOT EXISTS (SELECT 1 FROM budgets b
//                       WHERE b.org_id = ?3 AND b.hard = 1
//                         AND b.period_start <= ?6 AND b.period_end > ?6
//                         AND b.limit_minor - usage - reserved < ?4)
//
// **The entire enforcement is "this INSERT matched a row."** An INSERT matching ZERO rows neither
// aborts a D1 batch nor raises an error -- which is the V01-042 shape, and V01-043 had to add a
// `find_quarantine` for exactly this on the UPDATE side. So the question this class actually asks
// is the one that matters most on the path most traffic takes:
//
//   > An exhausted hard budget refuses the inference, no reservation is held, and nothing is
//   > dispatched -- or does the request sail through on a reservation that silently did not
//   > happen?
//
// The answer is the correct one, and it is now measured rather than assumed.
//
// WHAT MAKES THE MEASUREMENT NON-VACUOUS
//
// Four controls, because a `403` is a statement about a RESPONSE and every one of these could be
// satisfied by a request that never consulted a budget:
//
//   B1  a generous budget lets the SAME request take a reservation -- so the refusal below is the
//       ceiling doing its work, and the reservation machinery is proven live;
//   B2  the hard budget EXISTS and its limit is below the amount the request reserves, read from
//       D1 -- so the ceiling is unambiguously exceeded;
//   B4  the reservations are read from D1, not from the status, because a refused request that
//       still held a reservation would be the exact defect;
//   B5  an inference row is checked for a DISPATCHED state, which is the objective's
//       "before upstream dispatch" requirement stated as stored state rather than as a status.
//
// A6 is the scope control: a second organization with no hard budget must NOT be refused, or the
// refusal could be a platform-wide outage rather than a budget decision.
// ============================================================================================
import { createHash } from "node:crypto";
import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 budget hard-ceiling", async (probe) => {
  await probe.setup({
    persistEnvVar: "V01_BUDGETCEILING_PERSIST_TO",
    portEnvVar: "V01_BUDGETCEILING_PORT",
  });

  const { request, expect, d1Rows, browserMutation } = probe;
  const nonce = probe.nonce;

  // Every timestamp is RELATIVE. A literal here would make this gate a function of the calendar,
  // which is V01-022: a check that was red at one date and green at another, for reasons that had
  // nothing to do with the claim. The budget periods must also STRADDLE now, because the
  // applicable-snapshot query filters `b.period_start <= ?2 AND b.period_end > ?2` -- a distinct
  // historical day per budget would leave at most one of them applicable, and a control that
  // paraphrased that predicate instead of reusing it counted 129 rows while the product saw 1.
  const now = new Date(Date.now() - 60_000).toISOString();
  const periodStart = (index) => new Date(Date.now() - (index + 1) * 86_400_000).toISOString();
  const periodEnd = (index) => new Date(Date.now() + (index + 1) * 86_400_000).toISOString();
  const sha = (label, kind) =>
    createHash("sha256").update(`${nonce}-${kind}-${label}`).digest("hex").slice(0, 32);

  const owner = await probe.authenticatedUser("V01 Budget Ceiling");
  const org = await probe.createOrganization(owner.jar, "Ceiling Org", `v01-ceiling-${nonce}`);
  const orgId = org.orgId;
  const userId = owner.user.id;
  const alias = `v01-ceiling-model-${nonce}`;

  // --- the platform catalog, read rather than built ---------------------------------------------
  //
  // The ledger already seeds four mock providers with models and endpoints -- `mock-success` on
  // `mock://lumi-success` with capabilities `["text","tools"]`. I first built a fifth provider and
  // a fifth model through `POST /catalog/providers` and `POST /catalog/models`, got rows that each
  // looked right, and still got `route_unavailable` -- which `route_error_reason` masks under a
  // catch-all `_ =>`, so the reason said nothing. A fixture should use what the platform ships.
  const catalog = (
    await d1Rows(
      `SELECT m.model_id, m.provider_id, m.provider_model_id, p.provider_key
         FROM models m JOIN providers p ON p.provider_id = m.provider_id
        WHERE p.provider_key = 'mock-success' AND m.lifecycle = 'active' LIMIT 1`,
      "V01 reading the seeded mock-success catalog",
    )
  )[0];
  expect(
    "B0 CONTROL: a real PROVIDER and MODEL exist for the seeded `mock-success` fixture, both " +
      "active -- candidate selection loads both, and a missing one is masked as " +
      "`route_unavailable` BEFORE any budget check runs",
    Boolean(catalog) &&
      typeof catalog.model_id === "string" &&
      typeof catalog.provider_id === "string",
    `row=${JSON.stringify(catalog)?.slice(0, 180)}`,
  );

  // `model_aliases` is a platform-wide registry with NO create route, so the alias is seeded. The
  // same shape as the plugin registry V01-043 needed: a fixture, not a relaxation.
  const aliasId = `mal_${sha("alias", "alias")}`;
  await d1Rows(
    `INSERT INTO model_aliases (alias_id, alias_key, display_name, lifecycle, description,
       created_at, updated_at)
     VALUES ('${aliasId}', '${alias}', 'V01 ceiling alias', 'active',
             'seeded by the V01 budget hard-ceiling probe', '${now}', '${now}')`,
    "V01 seeding a platform model alias",
  );

  // --- the org model policy, through the product's own route ------------------------------------
  //
  // Written through `PUT /policy`, and it must name the MODEL. `allowed_models: []` is an EMPTY
  // LIST, not an absent field, and `CatalogPolicy::allows_model` (`modules/catalog.rs:183`) tests
  // `is_none_or(|values| values.contains(id))` -- so an empty array permits NOTHING while an
  // absent field permits everything. Every field of that request was individually valid and the
  // policy was still a policy that allowed nothing.
  const policy = await request(
    owner.jar,
    "PUT",
    `/api/v1/orgs/${orgId}/policy`,
    {
      allowed_aliases: [alias],
      allowed_models: [catalog?.model_id].filter(Boolean),
      allowed_providers: [catalog?.provider_id].filter(Boolean),
      // A CLOSED vocabulary (`modules/credentials.rs:100-104`); "platform" is not one of them and
      // the refusal named the rule.
      credential_mode: "platform_only",
      // `enabled` is `managed_route_enabled && !malformed`, and `allows_alias` checks `self.enabled`
      // BEFORE the alias list -- so false disables the policy while still persisting the alias.
      managed_route_enabled: true,
      // 0 is the CREATE case: a negative version is `version_invalid`, and 1 reads as "I read
      // version 0 and am writing the next one", which conflicts when no row existed.
      version: 0,
    },
    browserMutation(owner.jar, `v01-ceiling-policy-${nonce}`),
  );
  expect(
    "B0 CONTROL: the model policy ALLOWS the alias, model and provider -- otherwise the inference " +
      "is refused `model_not_allowed` before any budget is consulted",
    policy.status < 400,
    `status=${policy.status} body=${probe.brief(policy.payload, 170)}`,
  );

  // --- the route, with an active version and a selectable candidate -------------------------------
  const routeId = `rte_${sha("route", "route")}`;
  const routeVersionId = `rtv_${sha("version", "version")}`;
  // `validate_route_config` (`modules/routing.rs:136-144`) requires a NON-EMPTY candidate list,
  // each with a non-empty provider_id and model_id, `weight != 0`,
  // `250 <= timeout_ms <= 120_000`, `max_retries <= 3`, and a distinct (provider, model) pair.
  // `timeout_ms` DEFAULTS TO 0, which is below the floor, so a candidate without one is invalid.
  const routeConfig = JSON.stringify({
    strategy: "fixed",
    candidates: [
      {
        provider_id: catalog?.provider_id ?? "prv_missing",
        model_id: catalog?.model_id ?? "mdl_missing",
        weight: 1,
        timeout_ms: 30_000,
        max_retries: 1,
      },
    ],
  });
  await d1Rows(
    `INSERT INTO routes (route_id, org_id, alias, display_name, strategy, lifecycle,
       active_version_id, created_by_user_id, created_at, updated_at)
     VALUES ('${routeId}', '${orgId}', '${alias}', 'V01 ceiling route', 'fixed', 'published',
             '${routeVersionId}', '${userId}', '${now}', '${now}')`,
    "V01 seeding a model route",
  );
  await d1Rows(
    `INSERT INTO route_versions (route_version_id, route_id, org_id, version_number, config_json,
       config_hash, created_by_user_id, created_at, published_at)
     VALUES ('${routeVersionId}', '${routeId}', '${orgId}', 1, '${routeConfig}',
             '${"b".repeat(64)}', '${userId}', '${now}', '${now}')`,
    "V01 publishing a route version",
  );

  const body = {
    model: alias,
    // `NativeContentPart` CHECKs `type == "text"`. The OpenAI-shaped "input_text" is refused
    // `422 content_unsupported` before the budget check -- which is the first time this class
    // passed every case for the wrong reason.
    messages: [{ role: "user", content: [{ type: "text", text: "v01 budget ceiling" }] }],
  };
  const callInference = (label) =>
    request(
      owner.jar,
      "POST",
      "/api/v1/inference/responses",
      body,
      browserMutation(owner.jar, `v01-ceiling-${label}-${nonce}`, { "x-org-id": orgId }),
    );
  const reasonOf = (r) => r.payload?.error?.details?.reason ?? "-";
  const moneyRows = async () => {
    const reservations = (
      await d1Rows(
        `SELECT COUNT(*) AS n FROM budget_reservations WHERE org_id = '${orgId}'`,
        "V01 counting this org's reservations",
      )
    )[0];
    const usage = (
      await d1Rows(
        `SELECT COUNT(*) AS n FROM usage_events WHERE org_id = '${orgId}'`,
        "V01 counting this org's usage rows",
      )
    )[0];
    return {
      reservations: Number(reservations?.n ?? -1),
      usage: Number(usage?.n ?? -1),
    };
  };

  // ==========================================================================================
  // B1 -- the POSITIVE control. With no hard budget the same request must take a reservation.
  //
  // This is the "was it called?" instrument. Without it, a `403 budget_exceeded` from B3 could be
  // satisfied by a route that refuses every inference, and the money assertions would be measuring
  // a refusal that had nothing to do with a budget. It also proves the reservation machinery is
  // live on the UNMANAGED path, which is a fact this class would otherwise assume.
  // ==========================================================================================
  probe.stage = "positive-control";
  const beforeControl = await moneyRows();
  const control = await callInference("control");
  const afterControl = await moneyRows();
  console.log(
    `    CONTROL (no hard budget) -> ${control.status} reason=${reasonOf(control)} ` +
      `reservations ${beforeControl.reservations}->${afterControl.reservations}`,
  );
  expect(
    "B1 CONTROL: with NO hard budget the request is NOT refused for the budget -- so the refusal " +
      "below is a budget decision and not a route that refuses everyone",
    reasonOf(control) !== "budget_exceeded",
    `status=${control.status} reason=${reasonOf(control)}`,
  );
  expect(
    "B1 CONTROL: and a reservation IS taken, read from D1 -- the unmanaged path's only budget " +
      "control is this statement, so proving it is live is what makes the refusal below mean " +
      "something. The request then fails at the credential, which is expected and fine: it got " +
      "PAST the ceiling",
    afterControl.reservations > beforeControl.reservations,
    `reservations before=${beforeControl.reservations} after=${afterControl.reservations} ` +
      `status=${control.status} reason=${reasonOf(control)}`,
  );

  // ==========================================================================================
  // B2/B3 -- the ATTACK. An exhausted HARD budget.
  // ==========================================================================================
  probe.stage = "hard-ceiling";
  const HARD_LIMIT_MINOR = 1;
  await d1Rows(
    `INSERT INTO budgets (budget_id, org_id, scope_type, scope_id, period_start, period_end,
       limit_minor, hard, version, created_at, updated_at, currency)
     VALUES ('bud_${sha("hard", "budget")}', '${orgId}', 'organization', '',
             '${periodStart(0)}', '${periodEnd(0)}', ${HARD_LIMIT_MINOR}, 1, 1, '${now}', '${now}',
             'usd_minor')`,
    "V01 seeding an EXHAUSTED HARD budget",
  );
  const hardRow = (
    await d1Rows(
      `SELECT budget_id, limit_minor, hard, period_start, period_end FROM budgets
        WHERE org_id = '${orgId}' AND hard = 1`,
      "V01 reading the hard budget",
    )
  )[0];
  // The ceiling predicate, restated as the PRODUCT states it, so the fixture is checked against
  // the rule rather than against the probe's belief about it.
  const ceilingSaysDenied = (
    await d1Rows(
      `SELECT COUNT(*) AS n FROM budgets b
        WHERE b.org_id = '${orgId}' AND b.hard = 1
          AND b.period_start <= '${now}' AND b.period_end > '${now}'
          AND b.limit_minor
              - COALESCE((SELECT SUM(COALESCE(u.actual_cost_minor, u.estimated_cost_minor, 0))
                            FROM usage_events u
                           WHERE u.org_id = b.org_id AND u.created_at >= b.period_start
                             AND u.created_at < b.period_end), 0)
              - COALESCE((SELECT SUM(COALESCE(r.reserved_minor, 0) - COALESCE(r.committed_minor, 0))
                            FROM budget_reservations r
                           WHERE r.org_id = b.org_id AND r.status = 'reserved'
                             AND r.expires_at > '${now}'), 0)
              < 4102`,
      "V01 evaluating the product's own ceiling predicate",
    )
  )[0];
  expect(
    "B2 CONTROL: a HARD budget EXISTS, its limit is below the reservation, and the product's own " +
      "ceiling predicate says the request is DENIED -- read with the SQL the reservation statement " +
      "uses, so the fixture is checked against the rule and not against the probe's belief",
    Boolean(hardRow) &&
      Number(hardRow.hard) === 1 &&
      Number(hardRow.limit_minor) < 4_102 &&
      Number(ceilingSaysDenied?.n ?? 0) === 1,
    `budget=${JSON.stringify(hardRow)?.slice(0, 150)} ceiling_denies=${ceilingSaysDenied?.n ?? "?"}`,
  );

  const beforeAttack = await moneyRows();
  const attack = await callInference("attack");
  const afterAttack = await moneyRows();
  console.log(
    `    ATTACK (exhausted hard budget) -> ${attack.status} reason=${reasonOf(attack)} ` +
      `reservations ${beforeAttack.reservations}->${afterAttack.reservations} ` +
      `usage ${beforeAttack.usage}->${afterAttack.usage}`,
  );

  expect(
    "B3: an inference against an EXHAUSTED hard budget is REFUSED",
    attack.status === 403,
    `status=${attack.status} reason=${reasonOf(attack)} body=${probe.brief(attack.payload, 160)}`,
  );
  expect(
    "B3: and it names `budget_exceeded` SPECIFICALLY -- the unmanaged path's refusal vocabulary is " +
      "NOT `budget_state_unavailable` (that is the managed path's), and a reader who assumed one " +
      "reason covered both would miss that they are two different controls",
    reasonOf(attack) === "budget_exceeded",
    `reason=${reasonOf(attack)} code=${attack.payload?.error?.code ?? "-"}`,
  );

  // ---- the money half, graded on STORED state --------------------------------------------------
  //
  // The claim is not "the response says no". It is that no money is held and nothing is spent. An
  // INSERT that matches zero rows is exactly the shape that would leave a refusal in the response
  // and a silent absence in the ledger, so both tables are read directly.
  expect(
    "B4: and NO reservation is taken -- the ceiling lives in `WHERE NOT EXISTS`, so the INSERT " +
      "simply matches nothing, and an INSERT matching zero rows neither aborts a D1 batch nor " +
      "raises. This is the assertion that would catch the refusal being cosmetic",
    afterAttack.reservations === beforeAttack.reservations,
    `reservations before=${beforeAttack.reservations} after=${afterAttack.reservations}`,
  );
  expect(
    "B4: and NO usage row is written -- nothing was dispatched, so nothing is billable",
    afterAttack.usage === beforeAttack.usage,
    `usage before=${beforeAttack.usage} after=${afterAttack.usage}`,
  );

  // ---- "before upstream dispatch", as stored state rather than as a status --------------------
  //
  // The objective's requirement 1 is that a hard denial precedes dispatch. The standing check in
  // `modules/p09_failure_tests.rs` proves the ORDER structurally, by reading the source. This reads
  // the resulting state: `response_state` is a closed vocabulary that does NOT include "pending",
  // and `not_dispatched` is the one that means the request was refused before going out.
  const readStates = async (label) =>
    (await d1Rows(
      `SELECT request_id, response_state FROM inference_requests
        WHERE org_id = '${orgId}' AND model_alias = '${alias}'`,
      `V01 the inference rows this org accumulated (${label})`,
    )) ?? [];
  const DISPATCHED_STATES = ["dispatched_no_output", "stream_committed", "completed", "failed"];
  const statesAfterControl = await readStates("after the control");
  const statesAfterAttack = await readStates("after the attack");
  // The CONTROL dispatched and then failed at the credential, so its row is `failed` -- a terminal
  // state for a request that went out. The first version asserted over every row in the org and so
  // graded the CONTROL's dispatch as the ATTACK's; and asserting that no dispatched row existed at
  // all would have been satisfied by a control that never ran. The claim is about what the ATTACK
  // ADDED, so the comparison is before/after the attack, on the states the product defines.
  const seenBefore = new Set(statesAfterControl.map((r) => r.request_id));
  const added = statesAfterAttack.filter((r) => !seenBefore.has(r.request_id));
  const dispatchedByAttack = added.filter((r) =>
    DISPATCHED_STATES.includes(String(r.response_state)),
  );
  console.log(
    `    inference rows after control: ${JSON.stringify(statesAfterControl)?.slice(0, 160)}`,
  );
  console.log(
    `    rows ADDED by the attack: ${JSON.stringify(added)?.slice(0, 160)} ` +
      `dispatched=${dispatchedByAttack.length}`,
  );
  expect(
    "B5: the ATTACK added no inference row that reached a DISPATCHED state -- `response_state` is " +
      "a closed vocabulary (`not_dispatched`, `dispatched_no_output`, `stream_committed`, " +
      "`completed`, `failed`), and the objective's requirement 1 is that a hard denial precedes " +
      "dispatch. The source-order check in `modules/p09_failure_tests.rs` proves the ORDER " +
      "structurally; this proves the resulting STATE, and it excludes the control's own row, which " +
      "legitimately dispatched and then failed at the credential",
    dispatchedByAttack.length === 0,
    `added=${JSON.stringify(added)?.slice(0, 200)}`,
  );
  // The positive form of the same instrument: the CONTROL must have produced a dispatched row, or
  // `added` is empty for a reason that has nothing to do with the budget -- an inference route that
  // records nothing would satisfy the assertion above.
  expect(
    "B5 CONTROL: and the CONTROL did produce a dispatched row -- otherwise 'the attack added no " +
      "dispatched row' would be satisfied by a route that records no inference row at all, which " +
      "is the shape of an instrument that cannot register a signal",
    statesAfterControl.some((r) => DISPATCHED_STATES.includes(String(r.response_state))),
    `control rows=${JSON.stringify(statesAfterControl)?.slice(0, 200)}`,
  );

  // ---- the scope control ---------------------------------------------------------------------
  //
  // A refusal that every organization receives would satisfy B3 and B4 while proving nothing about
  // budgets, so a second organization with a generous budget is asked the identical request.
  const other = await probe.createOrganization(
    owner.jar,
    "Ceiling Control Org",
    `v01-ceiling2-${nonce}`,
  );
  const otherAlias = `v01-ceiling-model2-${nonce}`;
  const otherAliasId = `mal_${sha("alias2", "alias")}`;
  await d1Rows(
    `INSERT INTO model_aliases (alias_id, alias_key, display_name, lifecycle, description,
       created_at, updated_at)
     VALUES ('${otherAliasId}', '${otherAlias}', 'V01 control alias', 'active', 'scope control',
             '${now}', '${now}')`,
    "V01 seeding the control org's alias",
  );
  const otherRouteId = `rte_${sha("route2", "route")}`;
  const otherVersionId = `rtv_${sha("version2", "version")}`;
  await d1Rows(
    `INSERT INTO routes (route_id, org_id, alias, display_name, strategy, lifecycle,
       active_version_id, created_by_user_id, created_at, updated_at)
     VALUES ('${otherRouteId}', '${other.orgId}', '${otherAlias}', 'V01 control route', 'fixed',
             'published', '${otherVersionId}', '${userId}', '${now}', '${now}')`,
    "V01 seeding the control org's route",
  );
  await d1Rows(
    `INSERT INTO route_versions (route_version_id, route_id, org_id, version_number, config_json,
       config_hash, created_by_user_id, created_at, published_at)
     VALUES ('${otherVersionId}', '${otherRouteId}', '${other.orgId}', 1, '${routeConfig}',
             '${"c".repeat(64)}', '${userId}', '${now}', '${now}')`,
    "V01 publishing the control org's route version",
  );
  const otherPolicy = await request(
    owner.jar,
    "PUT",
    `/api/v1/orgs/${other.orgId}/policy`,
    {
      allowed_aliases: [otherAlias],
      allowed_models: [catalog?.model_id].filter(Boolean),
      allowed_providers: [catalog?.provider_id].filter(Boolean),
      credential_mode: "platform_only",
      managed_route_enabled: true,
      version: 0,
    },
    browserMutation(owner.jar, `v01-ceiling-policy2-${nonce}`),
  );
  expect(
    "B6 SCOPE CONTROL: the second organization's policy is accepted, so its inference is refused " +
      "for a budget reason or not at all -- never because its own fixture is missing",
    otherPolicy.status < 400,
    `status=${otherPolicy.status} body=${probe.brief(otherPolicy.payload, 150)}`,
  );
  const otherCall = await request(
    owner.jar,
    "POST",
    "/api/v1/inference/responses",
    { model: otherAlias, messages: body.messages },
    browserMutation(owner.jar, `v01-ceiling-other-${nonce}`, { "x-org-id": other.orgId }),
  );
  expect(
    "B6 SCOPE: a DIFFERENT organization with NO hard budget is NOT refused for budget_exceeded -- " +
      "so the refusal is one organization's ceiling and not a platform-wide outage, which would " +
      "satisfy B3 and B4 while proving nothing about the budget check",
    reasonOf(otherCall) !== "budget_exceeded",
    `status=${otherCall.status} reason=${reasonOf(otherCall)}`,
  );
});
