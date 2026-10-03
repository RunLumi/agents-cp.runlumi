#!/usr/bin/env node
// V02-011 — slice 5: is tool-policy ALLOW/DENY actually enforced at runtime?
//
// THE GAP THIS CLOSES, MEASURED RATHER THAN ASSUMED
//
// The objective names ten vertical slices; this is the fifth: **"tool-policy allow/deny"**. The
// previous campaign's own coverage map graded it **ALLOW ONLY**, and the grade rested on a count
// nobody had to run twice:
//
//     $ grep -c "denied_tool_ids: \[\]" apps/api/scripts/*.mjs
//     v01-privilege-escalation-probe.mjs: 2        # always EMPTY
//     p05-smoke.mjs:                              # one non-empty, as fixture setup for an
//                                                # outbox reason enum, never as an executed denial
//
// **Every fixture in the tree set the deny list to empty.** So `ToolDecision::Deny` has never been
// produced by a real HTTP request against a real Worker. The branch is implemented, it has a
// production caller, and it is unverified shipped code.
//
// This is NOT the V01-043 shape ("a capability built and wired to nothing") and the difference is
// the whole point of writing the probe at all:
//
//     routes/tools.rs:1687   let decision = evaluate(&evaluation);        <- production caller
//     routes/tools.rs:1758   if input.decision == ToolDecision::Deny {   <- the branch
//                               return persist_denial(input, reason, None).await;
//                           }
//
// The capability is wired, reviewed, and unit-tested 28 times. It has simply never been *driven*.
//
// WHY ONE POLICY YIELDS BOTH HALVES, AND WHY THAT MATTERS MORE THAN IT LOOKS
//
// `allows_tool` is:
//
//     !self.denied_tool_ids.contains(tool_id)
//         && (self.tool_ids.contains(tool_id) || matches!(self.default_posture, Allow))
//
// A deny beats an allow. So one policy — `default_posture: "allow"`, with ONE tool in
// `denied_tool_ids` — and TWO registered tools produce opposite outcomes from the same endpoint, on
// the same run, in the same request shape:
//
//     tool A (not denied)  ->  allowed
//     tool B (denied)      ->  org_tool_denied
//
// The allow leg is therefore not a separate check bolted on afterwards. **It is the positive control
// for the deny leg**: the same endpoint, the same body, the same read of the same stored table,
// producing the opposite verdict. A deny assertion whose allow leg is broken proves nothing, and
// this campaign has a documented history of exactly that shape — V01-042's "an INSERT matching zero
// rows neither aborts a batch nor raises an error", where six probes reported PASS while measuring
// the absence of a row rather than a refusal of a resource.
//
// WHAT IS GRADED, AND ON WHAT
//
// **Stored state in D1, never the HTTP status.** `persist_denial` writes a `tool.denied.v1` event and
// returns the persisted decision, so a handler that answered `200` while writing no denial would
// satisfy a status check and fail this one. The assertions are:
//
//   D1  the denied tool produces a STORED decision whose reason is `org_tool_denied`
//   D2  NO approval row exists for the denied call          <- the thing that would make it actionable
//   D3  the denial is ATTRIBUTABLE per ADR 0007              <- actor_type/actor_id are not NULL
//   D4  the same run, the same body, a non-denied tool is ALLOWED and DOES get its stored record
//   D5  the denial is visible in the org's usage-denial view  <- a customer can see it
//   D6  removing the tool from `denied_tool_ids` reverses it   <- the deny is the policy, not a latch
//
// D6 is the strongest of the six and the one most likely to be missing. A deny that cannot be
// lifted is indistinguishable from a tool that is broken forever, and a control that only ever
// pushes the policy in one direction cannot tell those apart.
//
// CROSS-TENANT AND AUTHORISATION LEGS
//
// The endpoint is device-authenticated, so two boundary questions ride along for free and both are
// graded on stored state: a **different device** requesting a decision for this run, and a device
// whose `org_id` differs from the run's. The second one must be indistinguishable from a run that
// does not exist, or the route is a cross-tenant existence oracle — the lesson from
// `verify:path-id-tenancy`'s four-assertion shape.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runProbe } from "./lib/smoke-harness.mjs";

const LABEL = "v02-tool-policy";
const ORG = "V02 Tool Policy";
const PROJECT = "v02-tool-policy-project";

await runProbe(LABEL, async (probe) => {
  const { request, expect, d1Rows, browserMutation, registerSecret } = probe;
  const anonJar = () => ({ header: () => "" });

  /**
   * Headers for a device-authenticated mutation.
   *
   * `POST /api/v1/devices/sessions` requires an `Idempotency-Key` and answers a correct `400`
   * without one. That is the right answer, and it is recorded here because the failure it causes is
   * instructive: the fixture reports "no managed run" and the decision assertions then read as
   * "the deny branch never refused anything". A control that reports *what is missing* is worth more
   * than one that reports only that something is.
   */
  const deviceMutation = (token, label) => ({
    Authorization: `DeviceToken ${token}`,
    "Idempotency-Key": `v02-tool-policy-${label}-${probe.nonce}`,
  });

  /**
   * A real enrolled device, because the run, session, binding and tool-decision routes all
   * authenticate with a DEVICE token. The enrollment challenge is signed with the same key the
   * device presents, which is the point of the device-proof check — a stand-in signer would make
   * the case untestable rather than easy.
   *
   * Copied rather than shared: three existing probes each define their own, and this repository's
   * probes are deliberately self-contained (each starts its own D1 and Worker). Lifting it into the
   * shared harness would mean editing three already-merged, sensitivity-proven gates, which is a
   * much larger risk than the duplication is worth.
   */
  const enrollDevice = async (owner, orgId, orgSlug, label, reportedCapabilities = null) => {
    if (typeof orgSlug !== "string") return null;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const device = {
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      keyFingerprint: createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      sign: (message) => sign(null, Buffer.from(message), privateKey).toString("hex"),
    };
    const tag = label.replaceAll(/\W+/g, "-").toLowerCase();
    const created = await request(anonJar(), "POST", "/api/v1/devices/enrollments", {
      org_slug: orgSlug,
      public_key: device.publicKeyPem,
      key_fingerprint: device.keyFingerprint,
      device_name: label,
      platform: "darwin-arm64",
      app_version: "0.5.0",
    });
    const enrollmentId = created.payload?.enrollment_id;
    if (typeof enrollmentId !== "string") return null;
    await request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/devices/enrollments/${enrollmentId}/approve`,
      {},
      browserMutation(owner.jar, `v02-approve-${tag}`),
    );
    const challenge = await request(
      anonJar(),
      "GET",
      `/api/v1/devices/enrollments/${enrollmentId}`,
    );
    if (typeof challenge.payload?.challenge !== "string") return null;
    const finished = await request(
      anonJar(),
      "POST",
      `/api/v1/devices/enrollments/${enrollmentId}/complete`,
      {
        signature: device.sign(challenge.payload.challenge),
      },
    );
    const token = finished.payload?.device_token;
    if (typeof token !== "string") return null;
    registerSecret(token);
    // Capabilities are declared by HEARTBEAT, not at enrollment -- `HeartbeatRequest` is the only
    // request carrying them, and `runtime_capabilities` reads the device's stored report. So a
    // browser/computer-use call needs a device that has REPORTED the capability, or the evaluator
    // refuses it `runtime_capability_unavailable` before any policy toggle is read.
    if (reportedCapabilities) {
      await request(
        anonJar(),
        "POST",
        "/api/v1/devices/heartbeat",
        { capabilities: reportedCapabilities, app_version: "0.5.0" },
        deviceMutation(token, `v02-heartbeat-${tag}`),
      );
    }
    return token;
  };

  console.log("");
  await probe.setup({
    persistEnvVar: "V02_TOOL_POLICY_PERSIST_TO",
    portEnvVar: "V02_TOOL_POLICY_PORT",
  });

  const d1 = (sql, label) => d1Rows(sql, label);
  const one = async (sql, label) => (await d1Rows(sql, label))[0] ?? null;

  // ---------------------------------------------------------------------------------------------
  // 0. CONTROL ON THE INSTRUMENT ITSELF.
  //
  // Everything below is graded by reading rows out of D1. If those tables cannot be read, or return
  // a shape this probe does not understand, every later assertion would report "no denial" and the
  // sheet would be a wall of vacuous PASSes. So the instrument is proved first, exactly as
  // `verify:secret-tenancy` and `verify:filter-tenancy` do -- and as the first run of this probe
  // proved the hard way.
  // ---------------------------------------------------------------------------------------------
  // PROVEN BY BEING WRITTEN FIRST. This control was added after the first run of this probe
  // reported `columns=none` for `tool_call_decisions` — a table I had guessed, and which does not
  // exist. Without the control the six assertions below would each have read "no denial stored" and
  // reported a clean, entirely false sheet. The real table is `tool_call_refs`, and the decision is
  // its `status` column: `requested | allowed | denied | completed | failed | cancelled`.
  //
  // The REASON is not stored on that row at all. `persist_denial` writes the status, a run timeline
  // event, a `security_events` row and a `tool.denied.v1` outbox envelope, and the reason lives in
  // the last two. So the reason assertion below reads the envelope rather than the decision row,
  // because a probe that looked for the reason on the decision row would be looking for a column
  // the product does not have.
  const instrument = await Promise.all([
    d1("PRAGMA table_info(tool_call_refs)", "V02 decision table shape"),
    d1("PRAGMA table_info(outbox_events)", "V02 outbox shape"),
    d1("PRAGMA table_info(security_events)", "V02 security_events shape"),
    d1("PRAGMA table_info(approval_requests)", "V02 approval_requests shape"),
  ]);
  const names = instrument.map((cols) => (cols ?? []).map((c) => c.name));
  probe.expect(
    "the instrument can read `tool_call_refs` — every denial assertion below is graded from this " +
      "table's `status` column, and a table this probe cannot read would make all of them vacuous. " +
      "This control exists because the first run of this probe guessed the table name, read nothing, " +
      "and would have reported six clean assertions about a branch that was never called",
    names[0].includes("status") && names[0].includes("tool_id"),
    `columns=${names[0].join(",") || "none"}`,
  );
  probe.expect(
    "and can read `outbox_events`, where the `tool.denied.v1` envelope carries the REASON — which is " +
      "not a column on the decision row, so reading it from the wrong table would be a false negative",
    names[1].includes("envelope_json") && names[1].includes("event_type"),
    `columns=${names[1].join(",") || "none"}`,
  );
  probe.expect(
    "and `security_events`, whose `actor_type`/`actor_id` are what ADR 0007's attribution requirement " +
      "is actually about",
    names[2].includes("actor_type") && names[2].includes("actor_id"),
    `columns=${names[2].join(",") || "none"}`,
  );
  probe.expect(
    "and `approval_requests`, whose emptiness for a denied call is the assertion that makes the " +
      "denial meaningful rather than cosmetic",
    names[3].includes("tool_call_id") && names[3].includes("status"),
    `columns=${names[3].join(",") || "none"}`,
  );

  // ---------------------------------------------------------------------------------------------
  // 1. THE FIXTURE: org -> project -> model policy -> device -> agent -> binding -> session -> run.
  //
  // A managed run is the only way to reach the tool-decision endpoint, because the handler
  // authenticates a DEVICE and checks `scope.device_id == device.device_id`. This chain is the same
  // one `verify:usage-attribution` builds, for the same reason.
  // ---------------------------------------------------------------------------------------------
  const owner = await probe.authenticatedUser(`${ORG} owner`);
  const org = await probe.createOrganization(owner.jar, ORG, `v02-tool-policy-${probe.nonce}`);
  const orgId = org.orgId;
  probe.expect(
    "created an organization to hold the tool policy",
    typeof orgId === "string" && orgId.length > 0,
    `orgId=${orgId}`,
  );

  const project = await probe.request(
    owner.jar,
    "POST",
    `/api/v1/orgs/${orgId}/projects`,
    // `visibility` is REQUIRED, and it must be `"org"`. The first version of this probe sent
    // `{name}` alone and got a correct `422`; the second sent `"restricted"` and got past creation
    // — only to be refused `project_access_denied` three calls later, because a restricted project
    // demands an explicit grant for the enrolling user (`ensure_project_binding` in
    // `device_runs.rs`), which this fixture never creates. The established pattern
    // (`v01-usage-attribution`) uses `"org"`, for exactly this reason.
    { name: PROJECT, visibility: "org" },
    browserMutation(owner.jar, "v02-tool-policy-project"),
  );
  const projectId = project.payload?.id ?? project.payload?.project?.id;
  probe.expect(
    "created a project, because a managed run's scope is resolved from the run's own project",
    typeof projectId === "string",
    `status=${project.status} body=${probe.brief(project.payload, 160)}`,
  );

  // The model policy. Without it every managed inference is refused `model_not_allowed` — by design,
  // so a managed run cannot fall back to the environment's test seam for authority.
  const alias = "v02-tool-policy-alias";
  const model = await one(
    "SELECT model_id, provider_model_id FROM models ORDER BY model_id LIMIT 1",
    "V02 a model",
  );
  const provider = await one(
    "SELECT provider_id, provider_key FROM providers ORDER BY provider_id LIMIT 1",
    "V02 a provider",
  );
  if (model && provider) {
    const policy = await probe.request(
      owner.jar,
      "PUT",
      `/api/v1/orgs/${orgId}/policy`,
      {
        allowed_aliases: [alias],
        // NOT empty arrays. `[]` is an ALLOW-NOTHING set here: `allows_model`/`allows_provider`
        // test `values.contains(x)`, and every inference then fails `route_unavailable`. Only
        // `None` means unrestricted, and this PUT always serialises an array.
        allowed_models: [model.model_id, model.provider_model_id].filter(Boolean),
        allowed_providers: [provider.provider_id, provider.provider_key].filter(Boolean),
        credential_mode: "platform_or_organization",
        managed_route_enabled: true,
        version: 0,
      },
      browserMutation(owner.jar, "v02-tool-policy-model"),
    );
    probe.expect(
      "published a model policy, without which every managed run is refused by design",
      policy.status === 200 || policy.status === 201,
      `status=${policy.status} reason=${probe.reasonOf(policy) ?? "none"}`,
    );
  } else {
    probe.skip("the managed-run leg", "no model or provider in the catalog to build a policy from");
    return;
  }

  // Two tools in one org. The ONLY difference between them is membership of `denied_tool_ids`.
  //
  // A fingerprint is an OPAQUE identifier, not a digest string: 4-128 chars, alphanumeric plus
  // `._-`, no colon. The first version sent `sha256:<hex>` and got a correct `fingerprint_invalid`
  // — the `:` is outside the charset, and the comment on `fingerprint_value` says so explicitly.
  // Computed ONCE per tool: the create body and the later decision body must carry the same value,
  // because the decision handler resolves the registration BY fingerprint.
  const fingerprint = (name) =>
    createHash("sha256").update(`${name}:${probe.nonce}`).digest("hex").slice(0, 64);
  const makeTool = async (name, capabilityIds = [], riskClass = "read_only") => {
    const fp = fingerprint(name);
    const created = await probe.request(
      owner.jar,
      "POST",
      `/api/v1/orgs/${orgId}/tools`,
      {
        name,
        source: "built_in",
        // Browser and computer tools are registered at their own risk class, because a decision
        // whose declared `risk_class` disagrees with the registered tool is refused
        // `tool_risk_class_mismatch` before any policy rule is read.
        risk_class: riskClass,
        // Not always empty: a browser- or computer-shaped decision is driven by the CATALOG
        // definition's capability ids (`has_browser_capability(&definition.capability_ids)`), not by
        // the call's, so a tool carrying `cap_browser_use` is what makes the browser policy reachable.
        capability_ids: capabilityIds,
        fingerprint: fp,
      },
      browserMutation(owner.jar, `v02-tool-${name}`),
    );
    const id = created.payload?.id ?? created.payload?.tool?.id;
    probe.expect(
      `registered tool "${name}" in the org's catalog`,
      typeof id === "string" && id.length > 0,
      `status=${created.status} body=${probe.brief(created.payload, 160)}`,
    );
    return {
      id,
      name,
      fingerprint: fp,
      capabilityId: capabilityIds?.[0] ?? null,
    };
  };
  const allowedTool = await makeTool("v02-allowed-tool");
  const deniedTool = await makeTool("v02-denied-tool");
  // The browser and computer tools are created HERE rather than in their own phase, because the
  // agent's `allowed_tool_ids` is fixed when the agent is created and every decision for a tool the
  // agent does not list is refused `agent_tool_not_allowed` -- which is what the first run of the
  // browser/computer phase measured, and why its positive control failed while its fourteen denials
  // passed on an empty allowlist. That is the vacuity the positive control exists to catch.
  //
  // The capability catalogue. It USED to be a precondition fixture, and the fact that it had to be
  // one was the finding (V04-010): `capability_definitions` had NO WRITER anywhere -- no INSERT or
  // UPDATE in apps/api/src, no seed in any migration, no route -- so every browser/computer call in
  // managed mode was refused `capability_not_defined` before any policy toggle was read, and the
  // positive control (the one leg that can register an allow) is what exposed it.
  //
  // Migration 0023_p05_capability_catalogue_seed is the writer now: two platform-wide rows
  // (org_id NULL) with the evaluator's own required keys (`browser`, `computer`). This phase asserts
  // they exist and drives the tools through their REAL capability ids, so the catalog-resolved
  // matcher (`has_browser_capability` via the row's risk class) is exercised end to end rather than
  // assumed.
  const seeded = await d1(
    "SELECT capability_id, capability_key, risk_class FROM capability_definitions WHERE org_id IS NULL ORDER BY capability_key",
    "V02 the platform capability catalogue",
  );
  probe.expect(
    "the platform catalogue carries the browser and computer rows migration 0023 seeds, so the " +
      "browser and computer RULES are reachable rather than refused `capability_not_defined` " +
      "(V04-010 closed)",
    (seeded ?? []).length === 2 &&
      (seeded ?? []).map((r) => r.capability_key).join(",") === "browser,computer" &&
      (seeded ?? []).every((r) => r.risk_class === r.capability_key),
    `rows=${(seeded ?? []).length} keys=${(seeded ?? []).map((r) => r.capability_key).join(",") || "none"}`,
  );
  const platformCapabilityId = (key) =>
    (seeded ?? []).find((row) => row.capability_key === key)?.capability_id ?? null;

  // They carry the PLATFORM capability rows seeded by migration 0023, by their real ids: a
  // `CapabilityId` must be `cap_` + 32 lowercase hex (core/identifiers.rs), which is exactly why no
  // spelling match on a tool's capability set could ever recognize a browser-capable tool (V04-010's
  // second half). With the catalogue-resolved matcher the tool's id resolves to the row's risk class,
  // and both ways of being browser-shaped -- the tool's capability AND the call's risk class -- are
  // exercised below.
  const browserTool = await makeTool(
    "v02-browser-tool",
    [platformCapabilityId("browser")].filter(Boolean),
    "browser",
  );
  const computerTool = await makeTool(
    "v02-computer-tool",
    [platformCapabilityId("computer")].filter(Boolean),
    "computer",
  );
  probe.expect(
    "the browser and computer tools registered WITH the platform capability ids, so the " +
      "catalogue-resolved matcher is what recognizes them",
    typeof browserTool.capabilityId === "string" && typeof computerTool.capabilityId === "string",
    `browser=${browserTool.capabilityId ?? "none"} computer=${computerTool.capabilityId ?? "none"}`,
  );

  if (typeof allowedTool.id !== "string" || typeof deniedTool.id !== "string") return;

  // The tool policy: allow by default, deny exactly one tool.
  //
  // `version: 0` is the create path. The handler compares the body against the CURRENT record's
  // version and refuses a mismatch with `version_conflict` — so D6's reversal must carry the
  // version this PUT returned, not `0` again. Getting that wrong is a real and quiet failure: the
  // reversal would be refused for a reason unrelated to the policy and D6 would look like a
  // product defect.
  // The PUT body must match `PutToolPolicyRequest` EXACTLY: it carries
  // `deny_unknown_fields`, so one invented field is a 422 with an empty `details`.
  // That is what the first version of this probe sent (`denied_capability_ids`,
  // `risk_class_overrides`, `denied_risk_classes`, and made-up browser/computer
  // sub-fields) — and the empty details made it look like a product refusal.
  const putToolPolicy = async (denied, version, overrides = {}) => {
    const result = await probe.request(
      owner.jar,
      "PUT",
      `/api/v1/orgs/${orgId}/policy/tools`,
      {
        schema_version: 1,
        default_posture: "allow",
        default_approval_mode: "none",
        tool_ids: [],
        denied_tool_ids: denied,
        mcp_ids: [],
        denied_mcp_ids: [],
        tool_approval_modes: {},
        // The browser and computer blocks are overridable because the browser/computer-use phase
        // needs a policy whose ALLOWLISTS are populated. With an empty allowlist every browser and
        // computer action is refused for a reason that has nothing to do with the toggles under test,
        // which would make every one of those denial assertions vacuous.
        browser: {
          allowed_domains: [],
          blocked_domains: [],
          allow_download: false,
          allow_upload: false,
          allow_authenticated: false,
          allow_clipboard: false,
          external_submit: "deny",
          ...(overrides.browser ?? {}),
        },
        computer: {
          allow_accessibility: false,
          allow_screen_capture: false,
          allow_keyboard_mouse: false,
          allow_shell_escalation: false,
          allowed_applications: [],
          ...(overrides.computer ?? {}),
        },
        version,
      },
      browserMutation(owner.jar, `v02-tool-policy-put-${version}`),
    );
    return result;
  };

  const policyPut = await putToolPolicy([deniedTool.id], 0);
  probe.expect(
    "wrote a tool policy that ALLOWS by default and denies exactly one tool",
    policyPut.status === 200 || policyPut.status === 201,
    `status=${policyPut.status} reason=${probe.reasonOf(policyPut) ?? "none"} body=${probe.brief(policyPut.payload, 200)}`,
  );
  const policyVersion = policyPut.payload?.version ?? policyPut.payload?.tool_policy?.version ?? 1;
  probe.expect(
    "the PUT returned a version, because the reversal in D6 is compared against it and sending 0 " +
      "again would be refused `version_conflict` for a reason unrelated to the policy",
    typeof policyVersion === "number" && policyVersion >= 1,
    `version=${policyVersion} body=${probe.brief(policyPut.payload, 200)}`,
  );

  // Newest row first: org creation may seed a default policy row, and an unordered SELECT can
  // return that one instead of the PUT's. The diagnostic parses the document so a mismatch names
  // what IS stored rather than only what is missing.
  const policyRows = await d1(
    `SELECT tool_policy_id, policy_version, version, document_json FROM tool_policies WHERE org_id = '${orgId}' AND project_id IS NULL ORDER BY version DESC`,
    "V02 the stored tool policy",
  );
  const storedPolicy = policyRows[0] ?? null;
  let storedDenied = null;
  try {
    storedDenied = JSON.parse(storedPolicy?.document_json ?? "null")?.denied_tool_ids ?? null;
  } catch {
    storedDenied = "UNPARSEABLE";
  }
  probe.expect(
    "and the policy is PERSISTED, not merely accepted — the evaluator reads the record, so a " +
      "response without a row would make every decision below vacuous",
    Array.isArray(storedDenied) && storedDenied.includes(deniedTool.id),
    `rows=${policyRows.length} first=${JSON.stringify(storedPolicy)?.slice(0, 400)} denied_tool_ids=${JSON.stringify(storedDenied)?.slice(0, 120)} want=${deniedTool.id}`,
  );

  // ---------------------------------------------------------------------------------------------
  // 2. THE RUN. Device -> agent -> binding -> session -> run.
  // ---------------------------------------------------------------------------------------------
  const orgSlug = org.slug;
  const device = await enrollDevice(owner, orgId, orgSlug, "V02 tool-policy device");
  if (!device) {
    probe.skip(
      "the decision legs",
      "no device could be enrolled, so no managed run exists to decide on",
    );
    return;
  }
  const asDevice = (label) => deviceMutation(device, label);

  // The agent allows BOTH tools. Without this the agent layer denies every
  // call with `agent_tool_not_allowed` and the allow leg — the positive control for the whole
  // probe — can never pass. Run 8 proved that: both legs answered deny, for two different reasons.
  // D6 needs it too: after the ORG deny is lifted the agent must still allow the tool, or the
  // reversal leg measures the agent rather than the policy. Pre-reversal the org deny beats the
  // agent allow; post-reversal both allow — which is the comparison D6 exists to make.
  const agent = await probe.request(
    owner.jar,
    "POST",
    `/api/v1/orgs/${orgId}/agents`,
    {
      name: "v02 tool policy agent",
      project_id: projectId,
      allowed_tool_ids: [allowedTool.id, deniedTool.id, browserTool.id, computerTool.id],
    },
    browserMutation(owner.jar, "v02-tool-policy-agent"),
  );
  const agentId = agent.payload?.id ?? agent.payload?.agent?.id;
  const binding = await probe.request(
    anonJar(),
    "POST",
    "/api/v1/devices/bindings",
    {
      project_id: projectId,
      workspace_identity: `v02-tool-policy-${probe.nonce}`,
      display_name: "v02 binding",
      environment_type: "local",
    },
    asDevice("v02-binding"),
  );
  const bindingId = binding.payload?.id;
  if (typeof agentId !== "string" || typeof bindingId !== "string") {
    probe.skip(
      "the decision legs",
      `the fixture could not be completed: agent=${agent.status} binding=${binding.status}`,
    );
    return;
  }

  const session = await probe.request(
    anonJar(),
    "POST",
    "/api/v1/devices/sessions",
    {
      project_id: projectId,
      agent_definition_id: agentId,
      workspace_binding_id: bindingId,
      external_id: `v02-tool-policy-${probe.nonce}`,
      title: "v02 tool policy session",
    },
    asDevice("v02-session"),
  );
  const sessionId = session.payload?.id ?? session.payload?.agent_session_id;
  if (typeof sessionId !== "string") {
    probe.skip(
      "the decision legs",
      `no session: status=${session.status} ${probe.brief(session.payload, 160)}`,
    );
    return;
  }

  const run = await probe.request(
    anonJar(),
    "POST",
    `/api/v1/devices/sessions/${sessionId}/runs`,
    {
      model_alias: alias,
      input_ref: `local://v02-tool-policy/${probe.nonce}`,
      execution_mode: "managed",
    },
    asDevice("v02-run"),
  );
  const runId = run.payload?.id ?? run.payload?.run_id;
  const runVersion = run.payload?.version ?? run.payload?.run?.version;
  probe.expect(
    "created a MANAGED run, which is the only way to reach the tool-decision endpoint — the handler " +
      "authenticates a device and requires the run to belong to it",
    run.status === 201 && typeof runId === "string",
    `status=${run.status} body=${probe.brief(run.payload, 200)}`,
  );
  if (typeof runId !== "string") return;
  // START it. A freshly created run is not in a decision-requesting state, and without this every
  // decision below is refused 409 `invalid_run_transition` — a refusal that has nothing to do with
  // the tool policy and would make the deny assertions vacuous in the other direction (everything
  // refused, nothing decided).
  const started = await probe.request(
    anonJar(),
    "POST",
    `/api/v1/devices/runs/${runId}/start`,
    { version: runVersion },
    asDevice("v02-run-start"),
  );
  probe.expect(
    "STARTED the run, because `run_can_request_tool_decision` only admits `dispatching | running | " +
      "waiting_user | waiting_approval` — p05 does the same before its tool-decision leg",
    started.status === 200,
    `status=${started.status} reason=${probe.reasonOf(started) ?? "none"} body=${probe.brief(started.payload, 200)}`,
  );
  if (started.status !== 200) return;

  // ---------------------------------------------------------------------------------------------
  // 3. THE TWO DECISIONS. Same endpoint, same body shape, one tool apart.
  // ---------------------------------------------------------------------------------------------
  // `ToolCallId` is `tcl_` + 32 hex (36 chars; see the `tool_call_refs` CHECK and
  // `approvals.rs:620`'s fixture). The first version of this probe sent `tcall_<tag>_<nonce>`,
  // which is wrong in BOTH prefix and length — and every decision was refused
  // `tool_call_id_invalid` before the policy was even read, so the whole class measured my
  // malformed id rather than the deny branch.
  const toolCallId = (tag) =>
    `tcl_${createHash("sha256").update(`${tag}:${probe.nonce}`).digest("hex").slice(0, 32)}`;
  const decide = async (tool, tag) =>
    probe.request(
      anonJar(),
      "POST",
      `/api/v1/runs/${runId}/tool-decisions`,
      {
        tool_call_id: toolCallId(tag),
        tool_id: tool.id,
        tool_fingerprint: tool.fingerprint,
        capability_ids: [],
        risk_class: "read_only",
        // `key=value` pairs: free text is Malformed here, and a Malformed summary refuses the
        // call before the policy is read — which made both legs fail identically in run 7.
        arguments_summary: `action=read;target=v02-${tag}`,
      },
      asDevice(`v02-decision-${tag}`),
    );

  const decisions = {};
  for (const [tag, tool] of [
    ["allow", allowedTool],
    ["deny", deniedTool],
  ]) {
    const result = await decide(tool, tag);
    decisions[tag] = result;
    decisions[`${tag}CallId`] = toolCallId(tag);
    // `tool_call_refs.status`, not a `decision` column. The CHECK is
    // `status IN ('requested','allowed','denied','completed','failed','cancelled')`.
    // AWAITED. `one` is async; without this `row` is a Promise and every `row?.status` below
    // is undefined — a shape node --check cannot see and only the sheet reveals.
    const row = await one(
      `SELECT status, tool_call_id FROM tool_call_refs WHERE run_id = '${runId}' AND tool_id = '${tool.id}'`,
      `V02 the stored ${tag} call`,
    );
    probe.expect(
      `${tag === "deny" ? "A DENIED tool" : "A tool the policy does not deny"} produces a STORED ` +
        `call in D1 — graded on the row, not the status, because a handler that answered 200 while ` +
        `writing nothing would satisfy a status check`,
      typeof row?.status === "string",
      `http=${result.status} stored=${row ? row.status : "NO ROW"} body=${probe.brief(result.payload, 160)}`,
    );
    decisions[`${tag}Row`] = row;

    // FR-F04-007, and the reason this is asserted HERE rather than left to a reading of the stored
    // row above. D1 grades the STORED decision, which is a different requirement: the spec asks that
    // the backend RETURN a machine-readable denial reason to the caller, and a product that stored the
    // reason while returning an opaque body would satisfy every other assertion in this probe.
    //
    // It is also the only assertion here that cannot be satisfied by a constant. D1 accepts any
    // non-empty status; this one requires the reason to MATCH THE TAG, so `policy_allowed` on the deny
    // leg fails. A route that returned one fixed reason for both outcomes would pass a presence check
    // and fail this one -- which is the difference between asserting a field exists and asserting it
    // means something.
    const expectReason = tag === "deny" ? "org_tool_denied" : "policy_allowed";
    probe.expect(
      `FR-F04-007: the ${tag} call RETURNS a machine-readable reason to the authorized caller, and it ` +
        `discriminates -- "${expectReason}" here. The stored row above is a separate requirement, and ` +
        `this one is on the wire: a product that persisted the reason while answering an opaque body ` +
        `would pass every other assertion in this probe`,
      result.payload?.reason === expectReason && result.payload?.decision === tag,
      `decision=${result.payload?.decision ?? "ABSENT"} reason=${result.payload?.reason ?? "ABSENT"}`,
    );
  }

  const denyRow = decisions.denyRow;
  const allowRow = decisions.allowRow;

  probe.expect(
    "and the stored status is `denied` for the tool the policy names",
    denyRow?.status === "denied",
    `status=${denyRow?.status} http=${decisions.deny?.status}`,
  );

  probe.expect(
    "while the tool the policy does NOT deny is `allowed`, on the same run and the same request " +
      "shape. THIS IS THE POSITIVE CONTROL for the assertion above: without it, a deny assertion " +
      "is satisfied by a route that refuses everyone, which is how six webhook probes once reported " +
      "PASS while measuring the absence of a row rather than a refusal of a resource",
    allowRow?.status === "allowed",
    `status=${allowRow?.status} http=${decisions.allow?.status}`,
  );

  // The REASON lives in the outbox envelope, not on the decision row. `persist_denial` writes the
  // status, a run timeline event, a security row and a `tool.denied.v1` envelope.
  // The outbox event is `tool.decision_recorded.v1` for every decision; the reason lives in the
  // envelope. (`tool.denied.v1` is the RUN TIMELINE event type — right string, wrong table.)
  const denialEnvelopes = await d1(
    `SELECT event_type, envelope_json FROM outbox_events WHERE event_type = 'tool.decision_recorded.v1' AND organization_id = '${orgId}'`,
    "V02 the denial envelope",
  );
  const envelopeText = (denialEnvelopes ?? []).map((e) => e.envelope_json ?? "").join(" ");
  probe.expect(
    "and a `tool.decision_recorded.v1` event reaches the OUTBOX for this org, whose envelope " +
      "carries the decision `deny` with reason `org_tool_denied` — the reason code is the only " +
      "thing distinguishing a policy refusal from a malformed request, and it lives in the " +
      "envelope because the decision row has no reason column at all",
    denialEnvelopes.length > 0 &&
      envelopeText.includes("org_tool_denied") &&
      envelopeText.includes('"deny"'),
    `events=${denialEnvelopes.length} carriesReason=${envelopeText.includes("org_tool_denied")} envelope=${probe.brief(envelopeText, 240)}`,
  );

  // D2: no approval row for the denied call. This is the assertion that makes the denial MEANINGFUL
  // — a denial that still left an approval behind would be a refusal the product could route around.
  const deniedApprovals = await d1(
    `SELECT COUNT(*) AS n FROM approval_requests WHERE run_id = '${runId}' AND tool_id = '${deniedTool.id}'`,
    "V02 approvals for the denied call",
  );
  const allowedApprovals = await d1(
    `SELECT COUNT(*) AS n FROM approval_requests WHERE run_id = '${runId}' AND tool_id = '${allowedTool.id}'`,
    "V02 approvals for the allowed call",
  );
  probe.expect(
    "NO approval request exists for the denied call — a denial that still left an approval behind " +
      "would be a refusal the product could route around, and the call is refused precisely so it " +
      "cannot",
    Number(deniedApprovals[0]?.n ?? -1) === 0,
    `approvals=${deniedApprovals[0]?.n} (expected 0)`,
  );
  probe.expect(
    "and the instrument can still SEE an approval row shape in the same table, so the count above is " +
      "a measured zero rather than a table this probe failed to read — an empty result from a wrong " +
      "column name and an empty result from a real absence are indistinguishable without this",
    Array.isArray(deniedApprovals) &&
      deniedApprovals.length > 0 &&
      deniedApprovals[0]?.n !== undefined,
    `denied=${deniedApprovals[0]?.n} allowed=${allowedApprovals[0]?.n} rowsReturned=${deniedApprovals.length}`,
  );

  // D3: the denial is attributable. ADR 0007's point is that a customer must be able to reconstruct
  // a support session from THEIR OWN audit view, without trusting platform-side logs — so an
  // unattributable row defeats the requirement even though the row exists and the route is 2xx.
  // This is the V01-038 shape, and it is the one assertion in the set that a row count could not make.
  const securityRows = await d1(
    `SELECT actor_type, actor_id, effective_user_id, action, outcome, reason FROM security_events WHERE org_id = '${orgId}' ORDER BY created_at DESC LIMIT 8`,
    "V02 security events for the denial",
  );
  const toolEvent = (securityRows ?? []).find((e) => String(e.action ?? "").startsWith("tool"));
  probe.expect(
    "the denial is ATTRIBUTABLE per ADR 0007 — `actor_type` is a real actor kind and `actor_id` is " +
      "present, because a customer must be able to reconstruct this from their own audit view " +
      "without trusting platform-side logs. This is the one assertion no row count could make: the " +
      "route is 2xx and the row exists either way. It is the V01-038 shape, where a `None` rendered " +
      "as `actor_type = 'system'` on the customer-visible row",
    typeof toolEvent?.actor_type === "string" &&
      toolEvent.actor_type.length > 0 &&
      typeof toolEvent.actor_id === "string" &&
      toolEvent.actor_id.length > 0,
    `actor_type=${toolEvent?.actor_type ?? "NULL"} actor_id=${toolEvent?.actor_id ?? "NULL"} action=${toolEvent?.action ?? `no tool action among ${(securityRows ?? []).length} rows`}`,
  );
  probe.expect(
    "and that actor is the DEVICE rather than `system` — a device decision recorded as `system` is " +
      "exactly the unattributable shape ADR 0007 exists to prevent",
    toolEvent?.actor_type !== "system",
    `actor_type=${toolEvent?.actor_type}`,
  );

  // X1/X2 — THE EXPLOIT LEG. A denial the product announces but does not record is advisory,
  // and `record_tool_result` is where that stops being academic: it refuses results for refs whose
  // status is terminal, and a first-time denial leaves the ref at `requested`. So the device ASKS
  // (is told NO with `org_tool_denied`) and then POSTS A RESULT ANYWAY. X2 is the control — the
  // same call shape against the ALLOWED call, which must be accepted, proving the result endpoint
  // works and the body is valid.
  const postResult = async (tool, tag) =>
    probe.request(
      anonJar(),
      "POST",
      `/api/v1/devices/runs/${runId}/tool-calls/${decisions[`${tag}CallId`]}/result`,
      { status: "completed", result_summary: `action=done;target=v02-${tag}` },
      asDevice(`v02-result-${tag}`),
    );
  const refStatus = async (tool) =>
    (
      await one(
        `SELECT status FROM tool_call_refs WHERE run_id = '${runId}' AND tool_id = '${tool.id}'`,
        `V02 ref status for ${tool.name}`,
      )
    )?.status ?? "NO ROW";
  const allowedResult = await postResult(allowedTool, "allow");
  probe.expect(
    "X2 CONTROL: a result for the ALLOWED call is ACCEPTED — proving the result endpoint works, " +
      "the body is valid, and the exploit leg below measures the product rather than my request shape",
    allowedResult.status === 200 && (await refStatus(allowedTool)) === "completed",
    `http=${allowedResult.status} stored=${await refStatus(allowedTool)}`,
  );
  const deniedResult = await postResult(deniedTool, "deny");
  const deniedRefAfter = await refStatus(deniedTool);
  probe.expect(
    "X1: a result for the DENIED call is REFUSED and the ref stays terminal — a device that was " +
      "told NO must not be able to complete the call by posting a result. Graded on the stored row: " +
      "an accepted result here means the denial was advisory",
    deniedResult.status !== 200 && deniedRefAfter === "denied",
    `http=${deniedResult.status} reason=${probe.reasonOf(deniedResult) ?? "none"} stored=${deniedRefAfter}`,
  );

  // D5: the customer can SEE the denial. A denial recorded in a table no product surface reads is
  // the V01-050 shape (`provider_entitlement_projections`, whose only INSERT is uncalled) — the
  // inverse: here the write is proven and the read is the question.
  // The run timeline (`tool.denied.v1`) is the customer-visible denial surface. `/usage/denials`
  // lists ONLY budget and rate-limit denials by design, so the previous version of this check was
  // expecting the product to do something it never promised — a probe bug, not a product gap.
  const timeline = await probe.request(
    owner.jar,
    "GET",
    `/api/v1/orgs/${orgId}/runs/${runId}/events`,
    undefined,
    browserMutation(owner.jar, "v02-tool-policy-timeline"),
  );
  const timelineItems = Array.isArray(timeline.payload?.items) ? timeline.payload.items : [];
  const denialEntry = timelineItems.find((e) => e.event_type === "tool.denied.v1");
  probe.expect(
    "and the customer can SEE it in the run's timeline as a `tool.denied.v1` event — a denial " +
      "written to a table no product surface reads is the V01-050 shape: the write proven, the " +
      "read unproven",
    timeline.status === 200 && typeof denialEntry === "object" && denialEntry !== null,
    `status=${timeline.status} items=${timelineItems.length} types=${timelineItems
      .map((e) => e.event_type)
      .join(",")
      .slice(0, 160)}`,
  );
  if (denialEntry) {
    probe.expect(
      "and that entry names the denial and its reason, so the customer learns WHY rather than only " +
        "that something failed",
      JSON.stringify(denialEntry).includes("org_tool_denied"),
      `entry=${probe.brief(denialEntry, 240)}`,
    );
  }

  // D6: the deny is LIFTABLE. A deny that cannot be removed is indistinguishable from a tool that is
  // broken forever, and a check that only ever pushes a policy in one direction cannot tell those
  // apart. The version guard is the hazard here: the body must carry the version the last PUT
  // returned.
  const reversal = await putToolPolicy([], policyVersion);
  probe.expect(
    "removing the tool from `denied_tool_ids` is ACCEPTED, carrying the version the last PUT returned " +
      "— sending 0 again would be refused `version_conflict` for a reason unrelated to the policy",
    reversal.status === 200 || reversal.status === 201,
    `status=${reversal.status} reason=${probe.reasonOf(reversal) ?? "none"} sentVersion=${policyVersion}`,
  );
  if (reversal.status === 200 || reversal.status === 201) {
    // decide() hashes the same tag to the same call id, so this request and `liftedCallId`
    // above name the same call by construction.
    const afterReversal = await decide(deniedTool, "deny-lifted");
    // EXACT id: the stored call id is `tcl_<hash of the tag>`, so a LIKE on the tag text can
    // never match. Same near-miss family as the phantom run id.
    const liftedCallId = toolCallId("deny-lifted");
    const liftedRow = await one(
      `SELECT status FROM tool_call_refs WHERE run_id = '${runId}' AND tool_call_id = '${liftedCallId}'`,
      "V02 the call after the deny was lifted",
    );
    probe.expect(
      "and the SAME tool, on the SAME run, with the SAME body, is now ALLOWED — so the refusal was " +
        "the POLICY rather than a latch that would deny this tool forever. A deny-only check cannot " +
        "tell those two products apart, and the difference is whether a customer can recover",
      afterReversal.status < 300 && liftedRow?.status === "allowed",
      `http=${afterReversal.status} stored=${liftedRow ? liftedRow.status : "NO ROW"}`,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 3b. FR-F13-005 / FR-F13-006 -- BROWSER AND COMPUTER-USE POLICY. Eleven sub-controls the specs
  // name, which until now no gate drove end to end. Every one is a boolean or an allowlist on
  // `BrowserPolicy` / `ComputerPolicy`, so the obvious objection is that a denial proves nothing:
  // what if the path refuses for an unrelated reason?
  //
  // It cannot, and that is the design. The policy below has its ALLOWLISTS POPULATED and every
  // capability toggle OFF. So for each action there are only two possible outcomes, and they point at
  // different fields:
  //
  //   * `visit` to a listed domain                                        ->  ALLOWED
  //     (the positive control: the instrument can register an allow on this very path)
  //   * every other action on a listed target                             ->  DENIED
  //
  // An UNCONSULTED toggle yields ALLOW, not deny. So each denial below is attributable to its own
  // field, and this phase fails if any of the eleven is parsed, stored and never consulted -- which
  // is the shape a fail-open control takes, and the reason reading the struct is not evidence.
  // ---------------------------------------------------------------------------------------------
  const ALLOWED_DOMAIN = "allowed.example.test";
  const ALLOWED_APP = "com.example.allowed-app";
  probe.expect(
    "the BROWSER and COMPUTER tools exist and are listed in the agent's `allowed_tool_ids`. They " +
      "carry the PLATFORM capability rows (migration 0023) by their real ids: before the repair " +
      "they could carry NO capability id a spelling matcher could recognize, because a " +
      "`CapabilityId` must be `cap_` + 32 lowercase hex and the old `has_browser_capability` " +
      "matched only bare or legacy spellings -- so `risk_class` was the ONLY working way to make a " +
      "call browser- or computer-shaped (V04-010). Both shapes are exercised now: the tools carry " +
      "the ids AND the calls claim the browser/computer risk class",
    typeof browserTool.id === "string" &&
      typeof computerTool.id === "string" &&
      typeof browserTool.capabilityId === "string",
    `browser=${browserTool.id ?? "none"}/${browserTool.capabilityId ?? "none"} computer=${computerTool.id ?? "none"}/${computerTool.capabilityId ?? "none"}`,
  );

  const bcPolicy = await putToolPolicy([], policyVersion + 1, {
    browser: {
      allowed_domains: [ALLOWED_DOMAIN],
      blocked_domains: ["blocked.example.test"],
      allow_download: false,
      allow_upload: false,
      allow_authenticated: false,
      allow_clipboard: false,
      external_submit: "deny",
    },
    computer: {
      allow_accessibility: false,
      allow_screen_capture: false,
      allow_keyboard_mouse: false,
      allow_shell_escalation: false,
      allowed_applications: [ALLOWED_APP],
    },
  });
  probe.expect(
    "wrote a policy whose browser and computer ALLOWLISTS are populated but every capability toggle " +
      "is off. This is what makes the denials attributable: an unconsulted toggle allows, a " +
      "consulted one denies, and an empty allowlist would have denied everything for an unrelated " +
      "reason",
    bcPolicy.status === 200 || bcPolicy.status === 201,
    `status=${bcPolicy.status} reason=${probe.reasonOf(bcPolicy) ?? "none"} body=${probe.brief(bcPolicy.payload, 160)}`,
  );

  // The run is bound to ONE device (`device_not_approved` for any other), so the capability report
  // goes on THAT device rather than a second one. Heartbeating it only ADDS capability, and the
  // evaluator consults `runtime.supports_all(...)` only for capabilities a call actually requires --
  // so every existing read-only decision above is unaffected, and adding capability can only make the
  // evaluator stricter about a call that needs it.
  const heartbeat = await request(
    anonJar(),
    "POST",
    "/api/v1/devices/heartbeat",
    { capabilities: { browser_use: true, computer_use: true }, app_version: "0.5.0" },
    deviceMutation(device, "v02-heartbeat-capabilities"),
  );
  probe.expect(
    "HEARTBEAT the run's own device with `browser_use` and `computer_use`. Capabilities are declared " +
      "by heartbeat, not at enrollment, and `runtime_capabilities` reads the device's stored report " +
      "-- so without this the evaluator refuses every browser/computer call " +
      "`runtime_capability_unavailable` before any policy toggle is read, which is exactly what an " +
      "earlier run of this phase measured",
    heartbeat.status === 200 || heartbeat.status === 204,
    `status=${heartbeat.status} reason=${probe.reasonOf(heartbeat) ?? "none"} body=${probe.brief(heartbeat.payload, 120)}`,
  );

  // A browser or computer decision differs from the plain one by carrying the action AND declaring the
  // matching `risk_class`. `risk_class` is what makes the call browser-shaped
  // (`browser_shaped = call.risk_class == Browser || browser_capability`), because the
  // capability-id half of that expression is unreachable (V04-010).
  const decideAction = (tool, tag, key, action, riskClass) =>
    probe.request(
      anonJar(),
      "POST",
      `/api/v1/runs/${runId}/tool-decisions`,
      {
        tool_call_id: toolCallId(`bc-${tag}`),
        tool_id: tool.id,
        tool_fingerprint: tool.fingerprint,
        // The call must claim exactly the tool's registered capability set
        // (`definition.capability_ids != call.capability_ids` is refused
        // `tool_capability_mismatch`), so a browser tool carrying the platform
        // capability row claims that id here.
        capability_ids: tool.capabilityId ? [tool.capabilityId] : [],
        risk_class: riskClass,
        arguments_summary: `action=${tag};target=v02`,
        [key]: action,
      },
      asDevice(`v02-bc-decision-${tag}`),
    );

  const decisionOf = (result) => result?.payload?.decision ?? null;

  // --- the POSITIVE CONTROL --------------------------------------------------------------
  const visitAllowed = await decideAction(
    browserTool,
    "visit-allowed",
    "browser_action",
    { action: "visit", domain: ALLOWED_DOMAIN },
    "browser",
  );
  probe.expect(
    "POSITIVE CONTROL: a browser `visit` to a listed domain CLEARS the browser rules. It does not come " +
      "back `allow` -- it comes back `require_session_approval`, because a browser-risk tool requires " +
      "an approval gate under a default policy, and that is STRONGER evidence than an allow: it " +
      "proves the call passed `domain_allowed`, reached the approval stage, and was never " +
      "`browser_action_denied`. Without this leg the thirteen denials below would all pass while the " +
      "browser rules were never consulted at all",
    decisionOf(visitAllowed) !== "deny" &&
      probe.reasonOf(visitAllowed) !== "browser_action_denied" &&
      probe.reasonOf(visitAllowed) !== "capability_not_defined" &&
      probe.reasonOf(visitAllowed) !== "runtime_capability_unavailable",
    `decision=${decisionOf(visitAllowed) ?? "ABSENT"} status=${visitAllowed.status} reason=${probe.reasonOf(visitAllowed) ?? "none"}`,
  );

  // --- FR-F13-005: the browser sub-controls ------------------------------------------------
  const browserCases = [
    ["download", { action: "download", domain: ALLOWED_DOMAIN }, "allow_download"],
    ["upload", { action: "upload", domain: ALLOWED_DOMAIN }, "allow_upload"],
    ["authenticated", { action: "authenticated", domain: ALLOWED_DOMAIN }, "allow_authenticated"],
    ["clipboard", { action: "clipboard", domain: ALLOWED_DOMAIN }, "allow_clipboard"],
    ["external_submit", { action: "external_submit", domain: ALLOWED_DOMAIN }, "external_submit"],
  ];
  for (const [tag, action, field] of browserCases) {
    const result = await decideAction(browserTool, tag, "browser_action", action, "browser");
    probe.expect(
      `FR-F13-005: browser \`${tag}\` is DENIED because \`${field}\` is off -- and because an unconsulted ` +
        'field would ALLOW, this assertion is what separates "the toggle is enforced" from "the ' +
        'toggle exists"',
      decisionOf(result) === "deny",
      `decision=${decisionOf(result) ?? "ABSENT"} status=${result.status} reason=${probe.reasonOf(result) ?? "none"}`,
    );
  }

  // The allowlist, in both directions -- neither is a per-action toggle, so neither is covered above.
  const visitUnlisted = await decideAction(
    browserTool,
    "visit-unlisted",
    "browser_action",
    { action: "visit", domain: "elsewhere.example.test" },
    "browser",
  );
  probe.expect(
    "FR-F13-005: a `visit` to a domain NOT in `allowed_domains` is DENIED, so the allowlist is " +
      "enforced and not merely present",
    decisionOf(visitUnlisted) === "deny",
    `decision=${decisionOf(visitUnlisted) ?? "ABSENT"} status=${visitUnlisted.status} reason=${probe.reasonOf(visitUnlisted) ?? "none"}`,
  );
  const visitBlocked = await decideAction(
    browserTool,
    "visit-blocked",
    "browser_action",
    { action: "visit", domain: "blocked.example.test" },
    "browser",
  );
  probe.expect(
    "FR-F13-005: a `visit` to a domain in `blocked_domains` is DENIED even though `Visit` requires " +
      "no capability toggle -- so `blocked_domains` is enforced independently of the per-action flags",
    decisionOf(visitBlocked) === "deny",
    `decision=${decisionOf(visitBlocked) ?? "ABSENT"} status=${visitBlocked.status} reason=${probe.reasonOf(visitBlocked) ?? "none"}`,
  );

  // --- FR-F13-006: the computer sub-controls -----------------------------------------------
  const computerCases = [
    ["accessibility", { action: "accessibility", application: ALLOWED_APP }, "allow_accessibility"],
    [
      "screen_capture",
      { action: "screen_capture", application: ALLOWED_APP },
      "allow_screen_capture",
    ],
    [
      "keyboard_mouse",
      { action: "keyboard_mouse", application: ALLOWED_APP },
      "allow_keyboard_mouse",
    ],
    [
      "shell_escalation",
      { action: "shell_escalation", application: ALLOWED_APP },
      "allow_shell_escalation",
    ],
  ];
  for (const [tag, action, field] of computerCases) {
    const result = await decideAction(computerTool, tag, "computer_action", action, "computer");
    probe.expect(
      `FR-F13-006: computer-use \`${tag}\` on a listed application is DENIED because \`${field}\` is off`,
      decisionOf(result) === "deny",
      `decision=${decisionOf(result) ?? "ABSENT"} status=${result.status} reason=${probe.reasonOf(result) ?? "none"}`,
    );
  }

  const computerUnlisted = await decideAction(
    computerTool,
    "unlisted-app",
    "computer_action",
    { action: "screen_capture", application: "com.example.denied-app" },
    "computer",
  );
  probe.expect(
    "FR-F13-006: a computer-use action against an application NOT in `allowed_applications` is " +
      "DENIED, so the application allowlist is enforced",
    decisionOf(computerUnlisted) === "deny",
    `decision=${decisionOf(computerUnlisted) ?? "ABSENT"} status=${computerUnlisted.status} reason=${probe.reasonOf(computerUnlisted) ?? "none"}`,
  );

  // Two fields the DOMAIN structs carry, no decision consults, and the API does not accept.
  // `deny_unknown_fields` makes this a 422, so the product's behaviour is CORRECT here and this is
  // recorded rather than asserted as a defect: the difference from the fail-open class is precisely
  // that an operator cannot believe a control took effect when it did not.
  const rejected = await probe.request(
    owner.jar,
    "PUT",
    `/api/v1/orgs/${orgId}/policy/tools`,
    {
      schema_version: 1,
      default_posture: "allow",
      tool_ids: [],
      denied_tool_ids: [],
      mcp_ids: [],
      denied_mcp_ids: [],
      tool_approval_modes: {},
      browser: {
        allowed_domains: [ALLOWED_DOMAIN],
        blocked_domains: [],
        allow_download: false,
        allow_upload: false,
        allow_authenticated: false,
        allow_clipboard: false,
        external_submit: "deny",
        blocked_categories: ["gambling"],
      },
      computer: {
        allow_accessibility: false,
        allow_screen_capture: false,
        allow_keyboard_mouse: false,
        allow_shell_escalation: false,
        allowed_applications: [ALLOWED_APP],
        blocked_applications: ["com.example.denied-app"],
      },
      version: (bcPolicy.payload?.version ?? policyVersion + 1) + 1,
    },
    browserMutation(owner.jar, `v02-tool-policy-unknown-fields`),
  );
  probe.expect(
    "`blocked_categories` and `blocked_applications` exist on the DOMAIN structs, are consulted by no " +
      "decision, and are REJECTED by the API rather than silently accepted. Two spec-named " +
      "sub-controls are therefore not settable at all, and the honest classification is fail-CLOSED",
    rejected.status === 422 || rejected.status === 400,
    `status=${rejected.status} reason=${probe.reasonOf(rejected) ?? "none"}`,
  );
  // ---------------------------------------------------------------------------------------------
  // 4. THE BOUNDARY LEGS. Both graded on stored state, and both required to be indistinguishable
  //    from a run that does not exist — or the route is a cross-tenant existence oracle.
  // ---------------------------------------------------------------------------------------------
  const otherOwner = await probe.authenticatedUser("V02 other owner");
  const otherOrg = await probe.createOrganization(
    otherOwner.jar,
    "V02 Tool Policy Other",
    `v02-tool-policy-other-${probe.nonce}`,
  );
  const otherDevice = await enrollDevice(
    otherOwner,
    otherOrg.orgId,
    otherOrg.slug,
    "V02 other device",
  );

  if (otherDevice) {
    const foreignCallId = toolCallId(`foreign-${probe.nonce}`);
    const foreign = await probe.request(
      anonJar(),
      "POST",
      `/api/v1/runs/${runId}/tool-decisions`,
      {
        tool_call_id: foreignCallId,
        tool_id: allowedTool.id,
        tool_fingerprint: allowedTool.fingerprint,
        capability_ids: [],
        risk_class: "read_only",
        arguments_summary: "action=read;target=v02-foreign",
      },
      deviceMutation(otherDevice, "v02-foreign-decision"),
    );
    // VALID format (`run_` + 32 hex, like `RunId::new` requires) existing NOWHERE. An
    // invalid-format id would 422 on the parse and the comparison would measure my id, not the
    // route's non-disclosure.
    const phantomId = `run_${createHash("sha256").update(`phantom:${probe.nonce}`).digest("hex").slice(0, 32)}`;
    const phantom = await probe.request(
      anonJar(),
      "POST",
      `/api/v1/runs/${phantomId}/tool-decisions`,
      {
        tool_call_id: toolCallId(`phantom-${probe.nonce}`),
        tool_id: allowedTool.id,
        tool_fingerprint: allowedTool.fingerprint,
        capability_ids: [],
        risk_class: "read_only",
        arguments_summary: "action=read;target=v02-phantom",
      },
      deviceMutation(otherDevice, "v02-phantom-decision"),
    );
    probe.expect(
      "a device from ANOTHER organization is refused, and its answer is IDENTICAL to a run id that " +
        "exists NOWHERE — a distinguishable refusal would make this endpoint a cross-tenant existence " +
        "oracle, and the claim lives in the COMPARISON, not in either status",
      foreign.status === phantom.status,
      `foreign=${foreign.status}/${probe.reasonOf(foreign) ?? "none"} phantom=${phantom.status}/${probe.reasonOf(phantom) ?? "none"}`,
    );
    const foreignRows = await d1(
      `SELECT COUNT(*) AS n FROM tool_call_refs WHERE tool_call_id = '${foreignCallId}'`,
      "V02 decisions written by the foreign device",
    );
    probe.expect(
      "and it wrote NO decision — graded on the row, because the foreign request is refused by a " +
        "device check that could, in principle, run AFTER the decision was persisted",
      Number(foreignRows[0]?.n ?? -1) === 0,
      `rows=${foreignRows[0]?.n} (expected 0)`,
    );
  } else {
    probe.skip(
      "the cross-tenant leg",
      "a second device could not be enrolled, so there is no foreign caller to refuse",
    );
  }
});
