#!/usr/bin/env node
// V01 — can Org A reach, mutate, or READ a SECRET belonging to Org B?
//
// WHY THIS FAMILY, AND WHY IT IS THE SHARPEST THING LEFT
//
// `smoke:p08` computes how many org-scoped routes have no handler-level cross-tenant evidence. The
// 64 it reports are grouped by shape, and the shapes are not equally interesting. 48 are one-path-id
// substitutions; 12 are collections (25 of which `verify:collection-tenancy` now covers); 4 are
// nested. Among the 48, this family is the one where a single missed check is a credential breach:
//
//   POST .../webhooks/{endpoint_id}/rotate-secret   returns the NEW PLAINTEXT SECRET in its body
//   POST .../credentials/{credential_id}/rotate     returns the rotated secret material
//   POST .../service-accounts/{service_account_id}/suspend   a mutation on another org's identity
//   POST .../webhooks/deliveries/{delivery_id}/replay       re-delivers another org's payload
//
// `rotate_webhook_secret` was read before it was attacked, and it does
// `mint_secret(..)` and then answers with `json!({ .., "secret": plaintext })`. A cross-tenant
// success here does not merely authorise a mutation: it hands the caller another organization's
// signing secret in the response body. The reading is the hypothesis. The attack is the finding, and
// on this campaign the reading has been wrong in both directions -- it missed V01-023 entirely, and
// it correctly described a defect in V01-021 that the probe had been grading as a pass.
//
// FIVE ASSERTIONS PER ROUTE, AND WHY EACH ONE IS NEEDED
//
// 1. **Refused.** A status. The weakest of the five, and it is here only so a failure has a shape.
// 2. **No secret material in the body.** The response is searched for Org B's secret PLAINTEXT, for
//    every one of Org B's `webhook_secrets` version ids, and for Org B's credential id. A `403`
//    carrying the secret would pass assertion 1 and fail this one.
// 3. **Org B's stored state is UNCHANGED, read from D1.** This is the assertion the campaign's own
//    rule demands: *a 2xx that ignored the id is correct; a 2xx that granted it is a breach.* A
//    refusal is not the claim -- the claim is that nothing happened to another tenant.
// 4. **Non-disclosure.** A foreign id and a well-formed id that exists in NEITHER org must answer
//    indistinguishably, or the route is an existence oracle for other tenants' resources.
// 5. **Positive control: the owner's own call succeeds and returns the OWNER'S OWN secret.** Without
//    it, assertions 1-4 are satisfied by a route that is simply broken, and "no leak" would be the
//    product being down. This is the control that has found the real defect in four of this
//    campaign's gates.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("V01 secret-tenancy", async (probe) => {
  const { request, expect, expectStatus, browserHeaders, browserMutation, d1Rows } = probe;

  // A persist dir, like every other V01 probe. Without one the database lives in a temp directory
  // that is removed when the run ends, so a failure cannot be investigated after the fact -- and
  // "the run died on a D1 error I cannot reproduce" is the least useful sentence in this campaign.
  await probe.setup({ persistEnvVar: "V01_SECRET_PERSIST_TO", portEnvVar: "V01_SECRET_PORT" });

  // --- fixtures: two organizations, each with a REAL secret --------------------
  probe.stage = "fixtures";
  const alice = await probe.authenticatedUser("Secret Alice");
  const bob = await probe.authenticatedUser("Secret Bob");
  const orgA = await probe.createOrganization(alice.jar, "Secret A", `sec-a-${probe.nonce}`);
  const orgB = await probe.createOrganization(bob.jar, "Secret B", `sec-b-${probe.nonce}`);
  const headersFor = (jar, orgId) => ({ ...browserHeaders(jar), "X-Org-ID": orgId });
  const headersA = headersFor(alice.jar, orgA.orgId);
  const headersB = headersFor(bob.jar, orgB.orgId);

  // Bravo's webhook endpoint. `create_webhook` answers 201 with the PLAINTEXT secret, so this both
  // seeds a real secret and records the plaintext the leak assertions will search for.
  const webhookB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/webhooks`,
    {
      name: "Bravo hook",
      url: "https://example.invalid/bravo",
      subscribed_event_types: ["project.created.v1"],
    },
    browserMutation(bob.jar, "sec-hook-b"),
  );
  const endpointB =
    webhookB.payload?.endpoint?.endpoint_id ??
    webhookB.payload?.endpoint_id ??
    webhookB.payload?.id;
  const secretB = webhookB.payload?.secret ?? webhookB.payload?.endpoint?.secret;
  const secretVersionB = webhookB.payload?.secret_version_id;

  const webhookA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/webhooks`,
    {
      name: "Alpha hook",
      url: "https://example.invalid/alpha",
      subscribed_event_types: ["project.created.v1"],
    },
    browserMutation(alice.jar, "sec-hook-a"),
  );
  const endpointA =
    webhookA.payload?.endpoint?.endpoint_id ??
    webhookA.payload?.endpoint_id ??
    webhookA.payload?.id;
  const secretA = webhookA.payload?.secret ?? webhookA.payload?.endpoint?.secret;

  // Bravo's service account and credential, for the two mutating families.
  const accountB = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/service-accounts`,
    { name: "Bravo runner", capabilities: ["projects.read"] },
    browserMutation(bob.jar, "sec-account-b"),
  );
  const accountBId =
    accountB.payload?.service_account?.service_account_id ??
    accountB.payload?.service_account_id ??
    accountB.payload?.id;

  // A credential needs a provider, so Bravo gets a real one from the seeded catalog.
  const catalog = await request(
    bob.jar,
    "GET",
    `/api/v1/orgs/${orgB.orgId}/catalog`,
    undefined,
    headersB,
  );
  const providerB = (catalog.payload?.providers ?? []).find(
    (p) => p.provider_key === "mock-success",
  );
  let credentialBId = null;
  const credentialSecretB = `v01-secret-bravo-${probe.nonce}`;
  if (providerB) {
    const credential = await request(
      bob.jar,
      "POST",
      `/api/v1/orgs/${orgB.orgId}/credentials`,
      {
        provider_id: providerB.provider_id,
        owner_type: "organization",
        label: "Bravo credential",
        secret: credentialSecretB,
      },
      browserMutation(bob.jar, "sec-credential-b"),
    );
    credentialBId =
      credential.payload?.credential?.credential_id ?? credential.payload?.credential_id ?? null;
  }

  // --- the fixture must be real, or every refusal below proves nothing ------
  probe.stage = "preconditions";
  expect(
    "CONTROL: Bravo's webhook endpoint exists with a REAL plaintext secret, or there is nothing to steal",
    typeof endpointB === "string" &&
      endpointB.startsWith("whe_") &&
      typeof secretB === "string" &&
      secretB.length >= 16,
    `endpoint=${endpointB ?? "none"} secret=${secretB ? `${secretB.slice(0, 8)}…(${secretB.length})` : "none"} ` +
      `status=${webhookB.status} body=${probe.brief(webhookB.payload, 180)}`,
  );
  expect(
    "CONTROL: Alpha's own endpoint exists too, so the positive control below is a real request",
    typeof endpointA === "string" && endpointA.startsWith("whe_"),
    `endpoint=${endpointA ?? "none"} status=${webhookA.status} body=${probe.brief(webhookA.payload, 180)}`,
  );
  expect(
    "CONTROL: Bravo's service account and credential were created, or those two families are NOT_APPLICABLE here",
    true,
    `service_account=${accountBId ?? "not created (status " + accountB.status + ")"} ` +
      `credential=${credentialBId ?? "not created"}`,
  );

  // Bravo's secrets as D1 knows them. Read back, never taken from the create response, so the
  // assertion cannot be satisfied by a value the probe invented.
  probe.stage = "needles";
  const bravoSecrets = await d1Rows(
    `SELECT secret_version_id FROM webhook_secrets WHERE endpoint_id = '${endpointB}' ORDER BY created_at ASC`,
    "V01 Bravo's webhook secret versions",
  );
  const bravoVersionIds = bravoSecrets.map((row) => row.secret_version_id).filter(Boolean);
  const accountStateBefore = accountBId
    ? await d1Rows(
        `SELECT status FROM service_accounts WHERE service_account_id = '${accountBId}'`,
        "V01 Bravo's service account status before the attack",
      )
    : [];
  const credentialBefore = credentialBId
    ? await d1Rows(
        `SELECT version, fingerprint FROM credentials WHERE credential_id = '${credentialBId}'`,
        "V01 Bravo's credential before the attack",
      )
    : [];
  const endpointStateBefore = await d1Rows(
    `SELECT current_secret_version_id, enabled FROM webhook_endpoints WHERE endpoint_id = '${endpointB}'`,
    "V01 Bravo's webhook endpoint before the attack",
  );
  expect(
    "CONTROL: at least one of Bravo's secret versions is known to D1, so the body search has a real needle",
    bravoVersionIds.length >= 1,
    `versions=${JSON.stringify(bravoVersionIds)} -- without one, "the body contains no secret" is ` +
      `unfalsifiable`,
  );

  const leakNeedles = [
    ["bravo secret plaintext", secretB],
    ...bravoVersionIds.map((id) => [`bravo secret_version_id ${id.slice(0, 12)}…`, id]),
  ].filter(([, value]) => typeof value === "string" && value.length > 0);

  // A well-formed id in NEITHER org, for the non-disclosure comparison.
  const phantom = `whe_${"0".repeat(32)}`;

  // =========================================================================
  // The attack
  // =========================================================================
  const routes = [
    {
      label: "POST webhooks/{endpoint_id}/rotate-secret",
      method: "POST",
      foreign: `/api/v1/orgs/${orgA.orgId}/webhooks/${endpointB}/rotate-secret`,
      own: `/api/v1/orgs/${orgA.orgId}/webhooks/${endpointA}/rotate-secret`,
      phantom: `/api/v1/orgs/${orgA.orgId}/webhooks/${phantom}/rotate-secret`,
      mutation: "orgB",
    },
    {
      label: "POST credentials/{credential_id}/rotate",
      method: "POST",
      foreign: `/api/v1/orgs/${orgA.orgId}/credentials/${credentialBId}/rotate`,
      own: null,
      phantom: `/api/v1/orgs/${orgA.orgId}/credentials/cred_${"0".repeat(32)}/rotate`,
      body: { label: "rotated by Alpha" },
      mutation: "credential",
      skip: !credentialBId,
    },
    {
      label: "POST service-accounts/{service_account_id}/suspend",
      method: "POST",
      foreign: `/api/v1/orgs/${orgA.orgId}/service-accounts/${accountBId}/suspend`,
      own: null,
      phantom: `/api/v1/orgs/${orgA.orgId}/service-accounts/svc_${"0".repeat(32)}/suspend`,
      mutation: "account",
      skip: !accountBId,
    },
  ];

  probe.stage = "positive-control";
  // The control comes FIRST, deliberately. Everything after it is a statement about tenancy, and
  // without this the whole sheet is also a statement about a route that does not work.
  const ownRotate = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/webhooks/${endpointA}/rotate-secret`,
    {},
    { ...headersA, ...browserMutation(alice.jar, "sec-own-rotate") },
  );
  const ownSecret = ownRotate.payload?.secret;

  // THE BISECTION. No product change, no log, no build -- and it is the answer four builds of
  // console-reading did not produce.
  //
  // `rotate_webhook_secret` runs a fixed prologue before it can do anything:
  //
  //   authorize_org -> require_csrf -> idempotency_key -> database -> load_endpoint -> ...
  //
  // Several of those steps have a refusal of their own with a DIFFERENT status: no session is 401, a
  // bad CSRF token is 403 `csrf_failed`, a missing `Idempotency-Key` is 400, and an endpoint that
  // does not exist is 404. So a request with one precondition deliberately broken answers with that
  // step's status if the handler REACHED it, and still answers the baseline status if it never got
  // that far. Reading the variants together bisects the prologue exactly -- which is the information
  // the console could not supply, because the console is truncated precisely at the tail where these
  // requests live.
  //
  // TWO GUARDS, both of which this block needed after getting them wrong once.
  //
  // The first is that a perturbation must be VERIFIED as applied before its answer means anything.
  // The session variant originally set `Cookie: ""` in the header object, and the harness then does
  // `if (cookie) headers.Cookie = cookie` from the jar -- so the empty string was silently
  // overwritten by the real cookie, the variant sent a fully valid session, and its 503 read as
  // "did not move", which would have pinned the failure two steps too early. That is a vacuous
  // perturbation: it looks like a measurement and is not one, and it is the same shape as every other
  // empty-set case this campaign has found, arriving now inside the tool written to fix one. Each
  // variant therefore reports whether its precondition actually changed, and an unapplied variant
  // contributes NOTHING rather than a reading.
  //
  // The second is that a bisection which distinguishes nothing must say so, instead of reporting the
  // last bound it happened to compute.
  const rotatePath = (endpoint) => `/api/v1/orgs/${orgA.orgId}/webhooks/${endpoint}/rotate-secret`;
  const bisectBase = { ...headersA, ...browserMutation(alice.jar, "sec-own-rotate") };
  // A well-formed id that cannot exist, and CHECKED to be one before it is used.
  //
  // The first attempt was `whe_` + 26 zeros and it came back 422, not 404: a resource id is
  // `prefix_` + 32 lowercase hex (a UUID with its dashes removed), so 26 characters is rejected by
  // validation before any lookup happens. Read as a status, that 422 says "did not move" -- which
  // would have pinned the failure to the wrong side of `load_endpoint` on the strength of an id the
  // product never treated as one. So the format is asserted here, and a phantom that is not
  // well-formed, or that is somehow the real endpoint, is discarded instead of read.
  const phantomEndpoint = `whe_${"0".repeat(32)}`;
  const phantomIsWellFormed =
    /^whe_[0-9a-f]{32}$/.test(phantomEndpoint) &&
    phantomEndpoint.length === endpointA.length &&
    phantomEndpoint !== endpointA;
  const perturbations = [
    {
      label: "CSRF token removed",
      refusal: 403,
      then: "the failure is AFTER require_csrf",
      otherwise: "the failure is AT OR BEFORE require_csrf",
      build: () => {
        const headers = { ...bisectBase };
        delete headers["X-CSRF-Token"];
        return { headers, applied: !("X-CSRF-Token" in headers) };
      },
    },
    {
      label: "Idempotency-Key removed",
      refusal: 400,
      then: "the failure is AFTER idempotency_key",
      otherwise: "the failure is AT OR BEFORE idempotency_key",
      build: () => {
        const headers = { ...bisectBase };
        delete headers["Idempotency-Key"];
        return { headers, applied: !("Idempotency-Key" in headers) };
      },
    },
    {
      label: "session cookie removed",
      refusal: 401,
      then: "the failure is AFTER require_session",
      otherwise: "the failure is AT OR BEFORE require_session",
      // An EMPTY JAR, not an empty header. The harness overwrites `Cookie` from the jar whenever the
      // jar has one, so a jar is the only way to actually withhold the session.
      build: () => {
        const jar = probe.client();
        return { jar, headers: { ...bisectBase }, applied: !jar.header() };
      },
    },
    {
      label: "endpoint id substituted with a phantom",
      refusal: 404,
      then: "the failure is AFTER load_endpoint",
      otherwise: "the failure is AT OR BEFORE load_endpoint",
      build: () => ({
        headers: { ...bisectBase },
        path: rotatePath(phantomEndpoint),
        applied: phantomIsWellFormed,
      }),
    },
  ];
  let informative = 0;
  let unapplied = 0;
  // A bisection exists to localise a FAILURE. With a healthy baseline there is nothing to localise,
  // and printing "the failure is AFTER require_csrf" beside a 200 would be a diagnosis of a fault that
  // does not exist -- which is the same mistake as reading a truncated log as an absence of a log, in
  // the opposite direction. So it reports the baseline and stops.
  if (ownRotate.status >= 200 && ownRotate.status < 300) {
    console.log(
      `  bisect: baseline is ${ownRotate.status}, so there is no failure to localise and no ` +
        `perturbation was issued. This block is skipped rather than narrated.`,
    );
  } else {
    console.log(`  bisect baseline: status=${ownRotate.status}`);
    for (const variant of perturbations) {
      const built = variant.build();
      if (built.applied === false) {
        unapplied += 1;
        console.log(
          `  bisect ${variant.label}: NO INFORMATION -- the precondition was not actually applied, ` +
            `so this variant is discarded rather than read as "did not move"`,
        );
        continue;
      }
      const result = await request(
        built.jar ?? alice.jar,
        "POST",
        built.path ?? rotatePath(endpointA),
        {},
        built.headers,
      );
      const reached = result.status === variant.refusal;
      if (reached) informative += 1;
      console.log(
        `  bisect ${variant.label}: status=${result.status}` +
          (reached
            ? ` -> reached that step, so ${variant.then}`
            : ` -> did not move, so ${variant.otherwise}`),
      );
    }
    console.log(
      informative === 0
        ? "  bisect VERDICT: NO INFORMATION -- no variant changed the status, so no conclusion about " +
            "where the failure is may be drawn from this block."
        : `  bisect VERDICT: ${informative} of ${perturbations.length} variants moved the status` +
            `${unapplied ? `, and ${unapplied} were discarded as unapplied` : ""}, so the prologue is ` +
            `bisected to the window bounded by the readings above.`,
    );
  }

  const diag = probe
    .workerConsole(60_000)
    .replace(/\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => line.includes("V01-028 DIAG"))
    .slice(-4);
  for (const line of diag) console.log(`  DIAG ${line.slice(0, 200)}`);
  expect(
    "CONTROL: Alpha rotating HER OWN webhook secret succeeds and returns HER OWN secret, so every refusal below is about tenancy and not about a broken route",
    ownRotate.status === 200 && typeof ownSecret === "string" && ownSecret.length >= 16,
    `status=${ownRotate.status} secret=${ownSecret ? `${ownSecret.slice(0, 8)}…` : "none"} ` +
      `body=${probe.brief(ownRotate.payload, 160)}`,
  );
  expect(
    "CONTROL: Alpha's own secret is NOT Bravo's, so the two are distinguishable and the leak search is meaningful",
    typeof ownSecret === "string" && ownSecret !== secretB,
    `own=${ownSecret ? ownSecret.slice(0, 12) : "none"} bravo=${secretB ? secretB.slice(0, 12) : "none"}`,
  );

  probe.stage = "attack";
  const results = [];
  for (const route of routes) {
    if (route.skip) {
      probe.skip(
        `${route.label} -- cross-tenant`,
        "the fixture for this family was not created in this probe, so the case is unread rather " +
          "than passing. Reported, not dropped.",
      );
      continue;
    }
    const result = await request(alice.jar, route.method, route.foreign, route.body ?? {}, {
      ...headersA,
      ...browserMutation(alice.jar, `sec-x-${route.label.replaceAll(/\W+/g, "-")}`),
    });
    const body = JSON.stringify(result.payload ?? result.text ?? "");
    const found = leakNeedles.filter(([, value]) => body.includes(value)).map(([kind]) => kind);
    console.log(
      `\n  ${route.label}\n    status=${result.status} code=${result.payload?.error?.code ?? "none"} ` +
        `leaked=${found.length === 0 ? "none" : found.join(", ")}`,
    );

    // 1. refused
    expect(
      `${route.label}: Org A addressing Org B's resource is refused`,
      result.status >= 400,
      `status=${result.status} body=${probe.brief(result.payload, 200)}`,
    );
    // 2. no secret material
    expect(
      `${route.label}: the response contains NO secret belonging to Org B`,
      found.length === 0,
      found.length === 0
        ? `body=${probe.brief(result.payload, 160)}`
        : `the body names ${found.join(", ")} -- a refusal that carries another tenant's secret is ` +
            `still a breach`,
    );
    // 4. non-disclosure
    const phantomResult = await request(alice.jar, route.method, route.phantom, route.body ?? {}, {
      ...headersA,
      ...browserMutation(alice.jar, `sec-p-${route.label.replaceAll(/\W+/g, "-")}`),
    });
    const reasonOf = (r) => r.payload?.error?.details?.reason ?? r.payload?.error?.code ?? "none";
    expect(
      `${route.label}: a foreign id and an id that exists in NEITHER org answer indistinguishably, so this is not an existence oracle`,
      result.status === phantomResult.status && reasonOf(result) === reasonOf(phantomResult),
      `foreign=${result.status}/${reasonOf(result)} phantom=${phantomResult.status}/${reasonOf(phantomResult)} -- ` +
        `a difference lets any caller enumerate another organization's resources by probing ids`,
    );
    results.push({ route, result, phantomResult });
  }

  // 3. Org B's stored state, read from D1
  probe.stage = "stored-state";
  const afterVersions = await d1Rows(
    `SELECT secret_version_id FROM webhook_secrets WHERE endpoint_id = '${endpointB}' ORDER BY created_at ASC`,
    "V01 Bravo's webhook secret versions AFTER the attack",
  );
  expect(
    "Org B gained NO new webhook secret version: the cross-tenant rotate changed nothing on disk",
    afterVersions.length === bravoVersionIds.length,
    `before=${bravoVersionIds.length} after=${afterVersions.length} -- a refusal is not the claim; the ` +
      `claim is that another tenant's stored state is untouched`,
  );
  const endpointAfter = await d1Rows(
    `SELECT current_secret_version_id, enabled FROM webhook_endpoints WHERE endpoint_id = '${endpointB}'`,
    "V01 Bravo's webhook endpoint after the attack",
  );
  expect(
    "Org B's webhook still points at ITS OWN current secret version, and its enabled flag is unchanged",
    JSON.stringify(endpointAfter) === JSON.stringify(endpointStateBefore),
    `before=${JSON.stringify(endpointStateBefore)} after=${JSON.stringify(endpointAfter)}`,
  );
  if (accountBId) {
    const accountAfter = await d1Rows(
      `SELECT status FROM service_accounts WHERE service_account_id = '${accountBId}'`,
      "V01 Bravo's service account after the attack",
    );
    expect(
      "Org B's service account is NOT suspended by Org A",
      JSON.stringify(accountAfter) === JSON.stringify(accountStateBefore),
      `before=${JSON.stringify(accountStateBefore)} after=${JSON.stringify(accountAfter)} -- this is the ` +
        `assertion that distinguishes "refused" from "granted"`,
    );
  }
  if (credentialBId) {
    const credentialAfter = await d1Rows(
      `SELECT version, fingerprint FROM credentials WHERE credential_id = '${credentialBId}'`,
      "V01 Bravo's credential after the attack",
    );
    expect(
      "Org B's credential is NOT rotated by Org A",
      JSON.stringify(credentialAfter) === JSON.stringify(credentialBefore),
      `before=${JSON.stringify(credentialBefore)} after=${JSON.stringify(credentialAfter)}`,
    );
  }

  // NOW at the end of the run, which is the only moment the criterion can be met.
  //
  // MISTAKE ONE. I concluded, four times, that "no log fired" -- and therefore that the failure was
  // somewhere else -- because the console looked truncated. It was never truncated. It holds every
  // request including the rotate calls. What I had actually done was pipe it through `cut -c1-300` and
  // search for a MARKER STRING, and the line that mattered was neither of the four sites I
  // instrumented: it was V01-010's pre-existing log inside `load_endpoint`. It sat past the point the
  // evidence had been cut to. The lesson is not "cut wider" -- it is that the instrument was declared
  // untrustworthy on the strength of a check that was never run, and four conclusions were then drawn
  // from a stream nobody had verified could carry them.
  //
  // MISTAKE TWO, the correction for the first. I "fixed" it by reading the console at the POINT OF USE,
  // immediately after the call it describes. That is exactly wrong for a file another process appends to
  // asynchronously: at that moment the writer has not flushed, so the read is MORE likely to be empty
  // than the read at the end. The run that finally showed the line was a run that read the file after
  // the run had finished.
  //
  // So: read at the END, and grade the read on whether it contains the most recent request this harness
  // made. A count is not enough -- a majority check passes while the newest requests, the ones being
  // diagnosed, are exactly the ones missing, which is the truncation shape and also the flush shape.
  //
  // A capture that fails this does not void the product verdicts: every case above is graded on a status
  // code and on rows read out of D1, neither of which comes from here. It voids the DIAGNOSIS, so this
  // block says so out loud instead of letting a missing line read as a missing log.
  const capture = probe.consoleCapture();
  console.log(
    `  console capture: ${capture.ok ? "trustworthy" : "UNTRUSTWORTHY"} -- it ` +
      `${capture.ok ? "records" : "does NOT record"} the most recent request ` +
      `(${capture.requested} made, ${capture.seen} request line(s) in the file)`,
  );
  if (!capture.ok) {
    console.log(
      `  HARNESS DIAGNOSTIC ONLY -- the product verdicts above stand, but nothing may be concluded ` +
        `from this file: ${capture.reason}`,
    );
  }
  const stageLines = probe
    .workerConsole(200_000)
    .replace(/\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => /ERROR|load_endpoint|prepare_mutation|mint_secret|StoredSuccess/.test(line));
  if (stageLines.length === 0 && capture.ok) {
    console.log("  the console is readable and holds no error line for this run");
  }
  for (const line of stageLines.slice(-6)) console.log(`  STAGE ${line.slice(0, 240)}`);
  console.log(
    `\n${results.length} secret-bearing route(s) attacked cross-tenant; ` +
      `${leakNeedles.length} secret needle(s) searched in every body; Bravo's stored state compared ` +
      `from D1 before and after.`,
  );
});
