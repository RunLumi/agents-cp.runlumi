// V01-034 — is a STAFF credential's secret actually verified?
//
// The claim: `require_staff` resolves a presented `lumi_staff_` token by its LOOKUP PREFIX and never
// compares the presented secret against the stored `credential_hash`. If that is true then any
// well-formed `lumi_staff_<known-prefix>_<any-43-char-base64url>` authenticates as the principal that
// owns the prefix, and the "secret" is not one.
//
// WHY THIS PROBE IS BUILT THE WAY IT IS
//
// 1. **The forged token is well-formed, not malformed.** `StaffKey::parse` accepts
//    `lumi_staff_<16 lowercase hex>_<43 base64url>`, so a forged secret of exactly 43 base64url
//    characters passes the parser and reaches the verifier. A malformed token being refused proves
//    nothing about authentication; a well-formed one being accepted proves everything.
//
// 2. **The fixture is a LEGITIMATE staff principal, provisioned the way an operator would.** The row
//    carries `credential_hash = sha256_hex(the real secret)`. Nothing about the product's
//    authentication is relaxed to make this probe run — there is no test-only branch, no bypass
//    header, no stubbed verifier. The forged token is presented to the REAL verifier, and the real
//    verifier declines to check it. That is the only shape in which a green result would mean
//    anything.
//
// 3. **A green control and a red attack is the decisive pair, and they run FIRST.** A refusal alone
//    is satisfied by a route that refuses everyone and a fixture that never provisioned, so C1
//    asserts the correct secret is ACCEPTED before any attack is graded. If C1 goes red the probe
//    exits 1 immediately and the rest of the sheet is not evidence about anything.
//
// 4. **The write attack is graded on STORED STATE read from D1, never on status.** A 2xx that
//    ignored the token is a correct answer; a 2xx that APPLIED the write is a breach. And the
//    "version did not advance" assertion is only meaningful because a control created the row first —
//    asserting the absence of a change to a row that does not exist is the campaign's recurring
//    vacuity, in its purest form.
//
// 5. **A wrong secret and a nonexistent principal must be INDISTINGUISHABLE.** A4 asserts the two
//    answers are byte-identical, not merely that both are non-2xx. A fix that refuses wrong secrets
//    with a different error than it uses for unknown prefixes turns the endpoint into an existence
//    oracle for staff principals, and "not 2xx" passes straight through that.

import { createHash, randomBytes } from "node:crypto";
import { runProbe } from "./lib/smoke-harness.mjs";

/**
 * A jar with no cookies.
 *
 * `/api/v1/internal/**` authenticates with `Authorization: Bearer lumi_staff_...` and never reads a
 * cookie. Passing a browser jar here would be a real hazard rather than a cosmetic one: it would let
 * a customer session ride along on a request that is supposed to be staff-authenticated, and the
 * case would prove nothing about the staff boundary.
 */
const anonJar = () => ({ header: () => "" });

// A GET passes `undefined` and never `null`: the harness treats `undefined` as "no body" and
// serialises anything else, so `null` sends a literal `null` and a GET cannot carry one. The symptom
// was a transport error rather than a failed assertion, which is the harness correctly reporting
// exit 2 -- a statement about the probe, not about the product.

/** 32 random bytes as base64url without padding — exactly the 43 characters `StaffKey::parse` wants. */
const staffSecret = () => randomBytes(32).toString("base64url");

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

await runProbe("V01 staff-credential", async (probe) => {
  const { request, expect, expectStatus, d1Rows, browserMutation } = probe;

  console.log("");
  await probe.setup({ persistEnvVar: "V01_STAFF_PERSIST_TO", portEnvVar: "V01_STAFF_PORT" });

  // --- a real organization, for the support grant -------------------------------------------
  //
  // `CreateGrantBody.organization_id` must name a REAL organization: `support_grants.organization_id`
  // references it, so a fabricated id would earn a constraint violation that reads exactly like a
  // broken route. A support grant pointed at no customer is also not a meaningful test of the thing
  // ADR 0007 is about -- "a support session is reconstructable from the customer's own audit view" --
  // because there is no customer to reconstruct it from.
  //
  // Read out of the API's own response rather than parsed from a slug, since the id is opaque and a
  // guessed one is a guess.
  const grantUser = await probe.authenticatedUser("V01 Grant Target");
  const grantOrg = await probe.createOrganization(
    grantUser.jar,
    "V01 Grant Target Org",
    `v01-grant-${probe.nonce}`,
  );
  const orgA = {
    orgId: grantOrg?.orgId ?? grantOrg?.organization?.organization_id ?? grantOrg?.id,
  };
  expect(
    "the support-grant fixture names a real organization, so a constraint violation cannot be " +
      "mistaken for a broken route",
    typeof orgA.orgId === "string" && orgA.orgId.startsWith("org_"),
    `orgId=${orgA.orgId} payload=${probe.brief(grantOrg, 160)}`,
  );
  if (typeof orgA.orgId !== "string" || !orgA.orgId.startsWith("org_")) {
    probe.finish(
      1,
      "the organization fixture is missing, so the support-grant cases would be " +
        "measuring a constraint violation rather than the route",
    );
    return;
  }

  // --- the fixture: a real staff principal, with a real stored hash --------------------
  //
  // Provisioned through the database rather than through an API, because there IS no API that mints
  // a staff credential — it is issued by an operator out of band. That is exactly how the platform
  // would have one, so the row is the honest fixture and not a shortcut around the thing under test.
  const REAL_SECRET = staffSecret();
  const FORGED_SECRET = staffSecret();
  const OTHER_FORGED_SECRET = staffSecret();
  const PREFIX = sha256Hex(`v01-staff-${probe.nonce}`).slice(0, 16);
  const UNKNOWN_PREFIX = sha256Hex(`v01-staff-absent-${probe.nonce}`).slice(0, 16);
  const staffId = `stf_${sha256Hex(`v01-staff-id-${probe.nonce}`).slice(0, 32)}`;
  const stamp = "2026-09-29T00:00:00.000Z";

  //
  // The role is `engineering`, and the choice is load-bearing rather than incidental:
  // `permissions_for` (modules/staff.rs) gives `engineering` BOTH `FeatureFlagRead` and
  // `FeatureFlagManage`, while `support` holds only the latter. The first run of this probe used
  // `support` and the control came back **403 `staff_permission_denied`** rather than 401 -- which is
  // itself diagnostic, because a 403 means the token was ACCEPTED and refused later, at the
  // permission stage. That is recorded because it is the cheapest possible smell for this defect, and
  // because a probe that had asserted only "not 2xx" would have graded that 403 as a pass.
  probe.registerSecret(REAL_SECRET);
  probe.registerSecret(FORGED_SECRET);

  expect(
    "the fixture's own shapes are what StaffKey::parse demands, or the forged tokens are MALFORMED " +
      "and their refusal would prove nothing",
    /^[0-9a-f]{16}$/.test(PREFIX) &&
      /^[0-9a-f]{16}$/.test(UNKNOWN_PREFIX) &&
      /^[A-Za-z0-9_-]{43}$/.test(REAL_SECRET) &&
      /^[A-Za-z0-9_-]{43}$/.test(FORGED_SECRET) &&
      /^[A-Za-z0-9_-]{43}$/.test(OTHER_FORGED_SECRET) &&
      FORGED_SECRET !== REAL_SECRET &&
      OTHER_FORGED_SECRET !== REAL_SECRET &&
      OTHER_FORGED_SECRET !== FORGED_SECRET,
    `prefix=${PREFIX} unknownPrefix=${UNKNOWN_PREFIX} ` +
      `real=${REAL_SECRET.length} forged=${FORGED_SECRET.length} other=${OTHER_FORGED_SECRET.length} ` +
      "chars (43 each, and all three distinct)",
  );

  await d1Rows(
    `INSERT INTO staff_principals
       (staff_principal_id, email, display_name, staff_role, status,
        credential_prefix, credential_hash, credential_fingerprint, version, created_at, updated_at)
     VALUES ('${staffId}', 'v01-staff-${probe.nonce}@example.com', 'V01 Staff', 'engineering', 'active',
             '${PREFIX}', '${sha256Hex(REAL_SECRET)}', '${sha256Hex(`fp-${probe.nonce}`).slice(0, 32)}',
             1, '${stamp}', '${stamp}')`,
    "V01 provisioning a legitimate staff principal with a real stored hash",
  );
  const stored = (
    await d1Rows(
      `SELECT staff_principal_id, staff_role, status, credential_prefix, credential_hash
         FROM staff_principals WHERE staff_principal_id = '${staffId}'`,
      "V01 the staff principal exists and its stored hash is the hash of the REAL secret",
    )
  )[0];
  expect(
    "CONTROL: the staff principal was really written, with credential_hash == sha256(real secret)",
    Boolean(
      stored &&
      stored.credential_prefix === PREFIX &&
      stored.credential_hash === sha256Hex(REAL_SECRET) &&
      stored.staff_role === "engineering" &&
      stored.status === "active",
    ),
    `row=${JSON.stringify(stored)?.slice(0, 180)} ` +
      `expectedHash=${sha256Hex(REAL_SECRET).slice(0, 16)}...`,
  );
  if (!stored) {
    probe.finish(1, "the staff fixture was not written, so every case below would be vacuous");
    return;
  }

  //
  // A second principal, with the REAL secret hashed the same way, for the kill-switch cases.
  //
  // Role separation is real and ONE principal cannot hold both permission sets:
  // `permissions_for` gives `engineering` `FeatureFlagRead` + `FeatureFlagManage` but NOT
  // `KillSwitchOperate`, and gives `security` `KillSwitchOperate` but NOT `FeatureFlagRead`. Driving
  // both halves with a single role makes W3 answer 403, which reads as "the route is broken" -- the
  // exact shape of the defect this probe exists to find, pointed at the wrong thing.
  const SWITCH_SECRET = staffSecret();
  const SWITCH_PREFIX = sha256Hex(`v01-staff-switch-${probe.nonce}`).slice(0, 16);
  const switchStaffId = `stf_${sha256Hex(`v01-staff-switch-id-${probe.nonce}`).slice(0, 32)}`;
  probe.registerSecret(SWITCH_SECRET);
  await d1Rows(
    `INSERT INTO staff_principals
       (staff_principal_id, email, display_name, staff_role, status,
        credential_prefix, credential_hash, credential_fingerprint, version, created_at, updated_at)
     VALUES ('${switchStaffId}', 'v01-staff-switch-${probe.nonce}@example.com', 'V01 Staff (security)',
             'security', 'active', '${SWITCH_PREFIX}', '${sha256Hex(SWITCH_SECRET)}',
             '${sha256Hex(`sfp-${probe.nonce}`).slice(0, 32)}', 1, '${stamp}', '${stamp}')`,
    "V01 provisioning a second staff principal with the kill-switch permission",
  );
  const switchStored = (
    await d1Rows(
      `SELECT staff_principal_id, staff_role, credential_hash FROM staff_principals
        WHERE staff_principal_id = '${switchStaffId}'`,
      "V01 the second staff principal exists",
    )
  )[0];
  expect(
    "CONTROL: the second staff principal exists, with role 'security' and a real stored hash",
    Boolean(
      switchStored &&
      switchStored.staff_role === "security" &&
      switchStored.credential_hash === sha256Hex(SWITCH_SECRET),
    ),
    `row=${JSON.stringify(switchStored)?.slice(0, 160)}`,
  );

  const token = (prefix, secret) => `lumi_staff_${prefix}_${secret}`;
  const asStaff = (t) => ({ Authorization: `Bearer ${t}` });
  const FLAGS = "/api/v1/internal/feature-flags";

  // --- C1: the correct secret is accepted -------------------------------------------------
  // Runs FIRST, and a red C1 stops the probe. Without it every refusal below is equally consistent
  // with "this route refuses everyone", which is the vacuity V01-030 was built out of.
  probe.stage = "control";
  const c1 = await request(anonJar(), "GET", FLAGS, undefined, asStaff(token(PREFIX, REAL_SECRET)));
  expectStatus(
    "CONTROL C1: the REAL secret authenticates and /internal/feature-flags answers",
    c1,
    [200],
    [],
  );
  if (c1.status >= 400) {
    probe.finish(
      1,
      "the control is red, so the rest of this sheet would be a statement about a route that " +
        "refuses everyone",
    );
    return;
  }

  // A row to mutate, created with the REAL token. Without it, "the version did not advance" would
  // be satisfied by there being no row at all.
  const flagKey = `v01_flag_${probe.nonce}`;
  const created = await request(
    anonJar(),
    "POST",
    FLAGS,
    { flag_key: flagKey, enabled: true, expires_at: "2027-01-01T00:00:00.000Z" },
    {
      ...asStaff(token(PREFIX, REAL_SECRET)),
      // The create route is idempotency-KEYED and answered `400 idempotency_key_required` without one.
      "Idempotency-Key": probe.idempotencyKey("v01-staff-control-create"),
    },
  );
  expectStatus("CONTROL: the REAL token created a feature flag", created, [200, 201], []);
  const before = (
    await d1Rows(
      `SELECT flag_key, version, enabled FROM feature_flags WHERE flag_key = '${flagKey}'`,
      "V01 reading the flag the control created",
    )
  )[0];
  //
  // When this control is red, every case that needs a row to attack is BLOCKED rather than run
  // against nothing -- and it is blocked for a reason worth naming, because the two findings
  // interact: `create_flag`'s batch aborts on the staff audit insert (V01-035), so a forged write
  // (A3) would answer 503 for a reason that has nothing to do with the credential. Skipping with the
  // cause recorded is the honest reading. Silently running A3 against a missing row would let
  // "the version did not advance" pass on a row that does not exist, which is the campaign's
  // recurring vacuity in its purest form.
  const flagRowExists = Boolean(before && before.version === 1);
  if (flagRowExists) {
    expect(
      "CONTROL: the flag row EXISTS, so 'the version did not advance' can be non-vacuous",
      true,
      `row=${JSON.stringify(before)?.slice(0, 140)}`,
    );
  } else {
    probe.skip(
      "CONTROL: the flag row exists, so the write attack is not vacuous",
      `create_flag answered ${created.status}, so there is no row to attack -- ` +
        "this is V01-035 (the staff audit insert violates security_events.actor_type's CHECK) and " +
        "it MASKS the write half of V01-034 until it is fixed",
    );
  }

  // --- A1: a FORGED secret on the read route ---------------------------------------------
  probe.stage = "attack";
  const a1 = await request(
    anonJar(),
    "GET",
    FLAGS,
    undefined,
    asStaff(token(PREFIX, FORGED_SECRET)),
  );
  expectStatus(
    "ATTACK A1: a well-formed token whose SECRET is wrong is refused on the read route",
    a1,
    [401, 403],
    ["staff_authentication_required", "permission_denied"],
  );

  // --- A2: a second forged shape ---------------------------------------------------------
  const a2 = await request(
    anonJar(),
    "GET",
    FLAGS,
    undefined,
    asStaff(token(PREFIX, OTHER_FORGED_SECRET)),
  );
  expectStatus(
    "ATTACK A2: a second, different forged secret is refused too -- so A1 is not one unlucky string",
    a2,
    [401, 403],
    ["staff_authentication_required", "permission_denied"],
  );

  // --- A3: a forged secret on a WRITE route, graded on STORED STATE -----------------------
  // The consequential one. A 2xx that ignored the token would be correct; a 2xx that applied the
  // write is a platform-wide state change made with a credential nobody holds the secret for.
  let a3 = { status: 0, payload: { blocked: true } };
  if (flagRowExists) {
    a3 = await request(
      anonJar(),
      "PATCH",
      `${FLAGS}/${flagKey}`,
      { version: before.version, enabled: false },
      {
        ...asStaff(token(PREFIX, FORGED_SECRET)),
        // Its OWN key, never the control's. An attack that reuses the control's `Idempotency-Key` is
        // not an attack: on an idempotent route it receives the control's own response verbatim, the
        // target row is untouched, every assertion passes, and the sheet says *granted*.
        "Idempotency-Key": probe.idempotencyKey("v01-staff-attack-patch"),
      },
    );
  }
  if (flagRowExists) {
    const after = (
      await d1Rows(
        `SELECT flag_key, version, enabled FROM feature_flags WHERE flag_key = '${flagKey}'`,
        "V01 reading the flag after the forged write",
      )
    )[0];
    expect(
      "ATTACK A3: a FORGED secret did not change the stored flag -- graded on D1, not on the status",
      Boolean(after && after.version === before.version && after.enabled === before.enabled),
      `status=${a3.status} before=${JSON.stringify(before)} after=${JSON.stringify(after)} ` +
        `body=${probe.brief(a3.payload, 160)}`,
    );
    expectStatus(
      "ATTACK A3: and the forged write was refused, not merely ignored",
      a3,
      [401, 403],
      ["staff_authentication_required", "permission_denied"],
    );
  } else {
    probe.skip(
      "ATTACK A3: a FORGED secret did not change the stored flag",
      "no flag row exists to attack, because create_flag is broken (V01-035) -- a forged write " +
        "currently answers 503 for a reason unrelated to the credential, so this case is BLOCKED " +
        "rather than passing on an absent row",
    );
  }

  // --- A4: a wrong secret and a nonexistent principal must be INDISTINGUISHABLE -----------
  const a4 = await request(
    anonJar(),
    "GET",
    FLAGS,
    undefined,
    asStaff(token(UNKNOWN_PREFIX, REAL_SECRET)),
  );
  expectStatus(
    "NON-DISCLOSURE A4: a well-formed token for a principal that does not exist is refused",
    a4,
    [401, 403],
    ["staff_authentication_required", "permission_denied"],
  );
  //
  // `request_id` is REMOVED before comparing, and that is the whole trick. It is unique per request by
  // design, so requiring two answers to be byte-identical *including* it can never pass -- and this
  // assertion reported the product's correct behaviour (401, same code, same message) as a disclosure
  // oracle. `verify:device-idempotency` established the pattern in this campaign: compare the answers
  // while IGNORING `request_id`, because a correlation id differing is not the route answering
  // differently.
  const withoutRequestId = (payload) =>
    JSON.stringify(probe.redact(payload ?? null)).replace(
      /"request_id":"[^"]*"/g,
      '"request_id":"*"',
    );
  expect(
    "NON-DISCLOSURE A4: a wrong secret and a nonexistent principal answer IDENTICALLY once " +
      "`request_id` is set aside, so the endpoint is not an existence oracle for staff principals",
    a1.status === a4.status && withoutRequestId(a1.payload) === withoutRequestId(a4.payload),
    `wrongSecret:   ${a1.status} ${probe.brief(a1.payload, 110)}\n` +
      `            unknownPrefix: ${a4.status} ${probe.brief(a4.payload, 110)}`,
  );

  // =========================================================================================
  // V01-035 -- the platform's OWN control surface, driven with a LEGITIMATE token.
  //
  // Separate claim, same surface, so it lives in this probe rather than in a second one that would
  // pay for its own D1 and Worker. Every case here uses the REAL secret, so a failure is about the
  // route and never about the credential.
  //
  // `staff_audit` inserts `actor_type = 'staff'`, which `security_events.actor_type`'s CHECK refuses,
  // so the batch aborts and every internal WRITE route answers 503. There are exactly four writers,
  // and a call-site count is an assertion about the source rather than a measurement of the product --
  // so all four are driven here and the rows are read back out of D1.
  // =========================================================================================
  probe.stage = "internal-writes";
  const SWITCHES = "/api/v1/internal/kill-switches";

  // -- W1: create a feature flag -------------------------------------------------------------
  // `create_flag` is already exercised above as C1's row source; asserted here too so this section
  // stands on its own and the four writers read as four cases rather than three and a leftover.
  expect(
    "W1 create_flag: the REAL token created a feature flag",
    created.status === 200 || created.status === 201,
    `status=${created.status} body=${probe.brief(created.payload, 150)}`,
  );

  // -- W2: patch that flag -------------------------------------------------------------------
  const patched = flagRowExists
    ? await request(
        anonJar(),
        "PATCH",
        `${FLAGS}/${flagKey}`,
        { version: before.version, enabled: false, rollout_percentage: 50 },
        {
          ...asStaff(token(PREFIX, REAL_SECRET)),
          "Idempotency-Key": probe.idempotencyKey("v01-staff-control-patch"),
        },
      )
    : { status: 0, payload: { blocked: true } };
  const afterPatch = flagRowExists
    ? (
        await d1Rows(
          `SELECT flag_key, version, enabled, rollout_percentage FROM feature_flags WHERE flag_key = '${flagKey}'`,
          "V01 reading the flag after a legitimate patch",
        )
      )[0]
    : null;
  expect(
    "W2 patch_flag: a legitimate PATCH is accepted AND the stored row changed",
    (patched.status === 200 || patched.status === 201) &&
      Boolean(afterPatch) &&
      afterPatch.version === before.version + 1 &&
      // `enabled` is an INTEGER column, so D1 delivers it as a JavaScript NUMBER. `=== false` can
      // never hold for a row that was successfully set to false, so this assertion reported a correct
      // PATCH as a failure -- the same shape as V01-030, except there the annotation belongs in Rust and
      // here it belongs in the probe, because the probe is what is decoding.
      Number(afterPatch.enabled) === 0,
    `status=${patched.status} before=${JSON.stringify(before)} after=${JSON.stringify(afterPatch)} ` +
      `body=${probe.brief(patched.payload, 140)}`,
  );

  // -- W3: create a kill switch ---------------------------------------------------------------
  // `target_class` and `scope` are CHECKed, so the values are read out of the table rather than
  // guessed: a 422 here would be indistinguishable from a broken route.
  const switchCreated = await request(
    anonJar(),
    "POST",
    SWITCHES,
    {
      target_class: "mcp_server",
      target_ref: `v01_probe_${probe.nonce}`,
      scope: "global",
      reason: "V01 verifying the platform can still arm its own safety control",
    },
    {
      ...asStaff(token(SWITCH_PREFIX, SWITCH_SECRET)),
      "Idempotency-Key": probe.idempotencyKey("v01-staff-control-switch"),
    },
  );
  const switchRow = (
    await d1Rows(
      `SELECT kill_switch_id, state, version, target_class FROM kill_switches
        WHERE target_ref = 'v01_probe_${probe.nonce}'`,
      "V01 reading the kill switch the control created",
    )
  )[0];
  expect(
    "W3 create_kill_switch: a legitimate create is accepted AND the switch is stored engaged",
    (switchCreated.status === 200 || switchCreated.status === 201) &&
      Boolean(switchRow) &&
      switchRow.state === "engaged" &&
      switchRow.version === 1,
    `status=${switchCreated.status} row=${JSON.stringify(switchRow)?.slice(0, 140)} ` +
      `body=${probe.brief(switchCreated.payload, 140)}`,
  );

  // -- W4: lift that kill switch -------------------------------------------------------------
  let lifted = { status: 0, payload: null };
  if (switchRow) {
    lifted = await request(
      anonJar(),
      "POST",
      `${SWITCHES}/${switchRow.kill_switch_id}/lift`,
      { version: switchRow.version, reason: "V01 lifting the control it just armed" },
      {
        ...asStaff(token(SWITCH_PREFIX, SWITCH_SECRET)),
        "Idempotency-Key": probe.idempotencyKey("v01-staff-control-lift"),
      },
    );
  }
  const afterLift = switchRow
    ? (
        await d1Rows(
          `SELECT kill_switch_id, state, version, lift_reason FROM kill_switches
            WHERE kill_switch_id = '${switchRow.kill_switch_id}'`,
          "V01 reading the kill switch after a legitimate lift",
        )
      )[0]
    : null;
  expect(
    "W4 lift_kill_switch: a legitimate lift is accepted AND the stored state became 'lifted'",
    (lifted.status === 200 || lifted.status === 201) &&
      Boolean(afterLift) &&
      afterLift.state === "lifted" &&
      afterLift.version === switchRow?.version + 1,
    `status=${lifted.status} before=${JSON.stringify(switchRow)} after=${JSON.stringify(afterLift)} ` +
      `body=${probe.brief(lifted.payload, 140)}`,
  );

  // -- W5: and every one of them wrote its audit event -----------------------------------------
  // The MUST in ADR 0007: "A staff audit event is written on grant creation and on every use."
  // Asserted on the ROWS, because the batch aborts on this insert -- so a 503 and a missing audit
  // event are the same failure wearing two faces, and only the row distinguishes "no event" from
  // "an event that was not written because the route never ran".
  const staffEvents =
    (await d1Rows(
      `SELECT action, actor_type, actor_id, resource_type FROM security_events
        WHERE actor_id IN ('${staffId}', '${switchStaffId}') ORDER BY created_at`,
      "V01 reading the audit rows a legitimate staff write should have produced",
    )) ?? [];
  //
  // One row per write that SUCCEEDED -- derived from the outcomes above, not a hard-coded number. The
  // first version demanded `>= 4` while one of the four writes was still failing, so it reported the
  // audit trail as incomplete when it was exactly complete for the three that landed. That is the
  // campaign's own rule pointed the other way: asserting a count that includes a failed write asserts
  // on a failure, and a route that is broken makes its own audit assertion look broken with it.
  const expectedActions = [
    created.status === 200 || created.status === 201 ? "feature_flag.created" : null,
    patched.status === 200 || patched.status === 201 ? "feature_flag.updated" : null,
    switchCreated.status === 200 || switchCreated.status === 201 ? "kill_switch.engaged" : null,
    lifted.status === 200 || lifted.status === 201 ? "kill_switch.lifted" : null,
  ].filter(Boolean);
  const writtenActions = staffEvents.map((e) => e.action);
  const missingActions = expectedActions.filter((action) => !writtenActions.includes(action));
  expect(
    `W5: every internal write that SUCCEEDED (${expectedActions.length} of them) produced a ` +
      "security_events row for this staff principal",
    missingActions.length === 0,
    `expected=${JSON.stringify(expectedActions)} written=${JSON.stringify(writtenActions)} ` +
      `missing=${JSON.stringify(missingActions)}`,
  );
  expect(
    "W5: and the actor is recorded as a STAFF actor, which is the whole point of ADR 0007's three " +
      "actor kinds",
    staffEvents.length > 0 && staffEvents.every((e) => e.actor_type === "staff"),
    `actorTypes=${JSON.stringify([...new Set(staffEvents.map((e) => e.actor_type))])}`,
  );

  // --- A5: the secret must not be recoverable from anything the API returns ---------------
  // A second, quieter way to lose this boundary: if the listing echoes the prefix, the prefix is
  // published, and a published prefix plus an unchecked secret is a standing platform credential.
  const listing = await request(
    anonJar(),
    "GET",
    FLAGS,
    undefined,
    asStaff(token(PREFIX, REAL_SECRET)),
  );
  const listingText = probe.redact(JSON.stringify(listing.payload ?? null));
  expect(
    "A5: no staff credential material appears in an authenticated internal listing",
    !listingText.includes(REAL_SECRET) &&
      !listingText.includes(sha256Hex(REAL_SECRET)) &&
      !listingText.includes(FORGED_SECRET),
    `listing=${probe.brief(listing.payload, 200)}`,
  );

  // =========================================================================================
  // The REST of the surface. `/api/v1/internal/**` has SIX routes and this probe had measured two.
  //
  // Four were unmeasured: two reads and BOTH support-grant writes. Reading the grant handlers shows
  // they carry none of the four patterns this round found -- no `staff_audit`, no empty organization,
  // no guard after a writer, no `evt_` id -- and that is a reason to SUSPECT they are fine, which is
  // not a reason to believe it. A family that produced four defects in fifty lines earns full
  // measurement on the strength of that alone, and "I read it and it looks right" is exactly the
  // review that missed all four.
  //
  // ADR 0007's MUST is about grants specifically -- "a staff audit event is written on grant creation
  // and on every use" -- so the grant routes are the ones where an unaudited platform action would
  // contradict a written requirement rather than merely a convention.
  // =========================================================================================
  probe.stage = "internal-reads-and-grants";
  const GRANTS = "/api/v1/internal/support-grants";

  // -- R1: the by-key path is PATCH-ONLY, and that is worth asserting ---------------------------
  // `/internal/feature-flags/{flag_key}` is registered with `patch(patch_flag)` and nothing else.
  // The first version of this case asserted a 200 on an imagined GET -- and "not 2xx" would have
  // graded that as a pass for a route that does not exist, which is the campaign's most repeated
  // failure wearing a new name.
  //
  // Asserting the 405 is a real check rather than a workaround: it catches a route that quietly
  // starts accepting a verb nobody designed, and it pins the surface so a future reader does not
  // assume a read exists because the id is in the path.
  const flagByKeyGet = await request(
    anonJar(),
    "GET",
    `${FLAGS}/${flagKey}`,
    undefined,
    asStaff(token(PREFIX, REAL_SECRET)),
  );
  expectStatus(
    "R1: /internal/feature-flags/{flag_key} is PATCH-only, so a GET is refused rather than routed " +
      "to something that does not exist",
    flagByKeyGet,
    [404, 405],
  );
  // Asserted on the MESSAGE rather than on a reason code, because the harness redacts the code and a
  // code this probe cannot read is not evidence. The message is the observable, and it is the one
  // thing that distinguishes "this verb does not exist here" from "this resource does not exist".
  expect(
    "R1: and the refusal says the METHOD is not allowed, which is a different answer from a missing " +
      "resource -- so a client can tell the two apart",
    typeof flagByKeyGet.payload?.error?.message === "string" &&
      /method is not allowed/i.test(flagByKeyGet.payload.error.message),
    `status=${flagByKeyGet.status} message=${probe.brief(flagByKeyGet.payload?.error?.message, 90)}`,
  );

  // -- R2: read the kill switches ---------------------------------------------------------------
  const switchRead = await request(
    anonJar(),
    "GET",
    SWITCHES,
    undefined,
    asStaff(token(SWITCH_PREFIX, SWITCH_SECRET)),
  );
  expectStatus("R2 GET /internal/kill-switches: the collection answers", switchRead, [200], []);

  // -- R3: a grant is created against a REAL organization ----------------------------------------
  // `SupportGrantBody` is `deny_unknown_fields`, so a stray key is a 422 -- which would be
  // indistinguishable from a broken route. `ttl_seconds` is required and an expiry is a safety
  // control, so it gets a real future value rather than being omitted.
  const grantCreated = await request(
    anonJar(),
    "POST",
    GRANTS,
    {
      organization_id: orgA.orgId,
      reason: "V01 verifying a support grant can still be created and audited",
      ticket_reference: `V01-${probe.nonce}`,
      ttl_seconds: 900,
      capabilities: ["org.lookup"],
    },
    {
      ...asStaff(token(SWITCH_PREFIX, SWITCH_SECRET)),
      "Idempotency-Key": probe.idempotencyKey("v01-staff-control-grant"),
    },
  );
  const grantRow = (
    await d1Rows(
      `SELECT grant_id, organization_id, version, revoked_at FROM support_grants
        WHERE ticket_reference = 'V01-${probe.nonce}'`,
      "V01 reading the support grant the control created",
    )
  )[0];
  expect(
    "R3 POST /internal/support-grants: a legitimate grant is accepted AND the row names the real org",
    (grantCreated.status === 200 || grantCreated.status === 201) &&
      Boolean(grantRow) &&
      grantRow.organization_id === orgA.orgId,
    `status=${grantCreated.status} row=${JSON.stringify(grantRow)?.slice(0, 150)} ` +
      `body=${probe.brief(grantCreated.payload, 140)}`,
  );

  // -- R4: and it can be revoked -----------------------------------------------------------------
  let grantRevoked = { status: 0, payload: { blocked: true } };
  if (grantRow) {
    grantRevoked = await request(
      anonJar(),
      "POST",
      `${GRANTS}/${grantRow.grant_id}/revoke`,
      { version: grantRow.version, reason: "V01 revoking the grant it just created" },
      {
        ...asStaff(token(SWITCH_PREFIX, SWITCH_SECRET)),
        "Idempotency-Key": probe.idempotencyKey("v01-staff-control-grant-revoke"),
      },
    );
  }
  const afterRevoke = grantRow
    ? (
        await d1Rows(
          `SELECT grant_id, version, revoked_at, revoke_reason FROM support_grants
            WHERE grant_id = '${grantRow.grant_id}'`,
          "V01 reading the support grant after a legitimate revoke",
        )
      )[0]
    : null;
  expect(
    "R4 POST /internal/support-grants/{id}/revoke: a legitimate revoke is accepted AND the stored " +
      "grant is no longer usable",
    (grantRevoked.status === 200 || grantRevoked.status === 201) &&
      Boolean(afterRevoke) &&
      // `support_grants` has NO `status` column -- it carries `revoked_at` and `revoke_reason`. The
      // first version of this assertion compared a `status` that does not exist, so SQLite refused
      // the whole query and the probe died with a harness failure rather than a verdict. "No longer
      // usable" is read from `revoked_at` becoming non-null, which is the durable fact.
      afterRevoke.revoked_at !== null &&
      afterRevoke.version === (grantRow?.version ?? 0) + 1,
    `status=${grantRevoked.status} before=${JSON.stringify(grantRow)} after=${JSON.stringify(afterRevoke)} ` +
      `body=${probe.brief(grantRevoked.payload, 140)}`,
  );

  // -- R5: the ADR 0007 MUST, on grants specifically ---------------------------------------------
  // Read out of the ROWS, because a batch aborting on its audit insert and a batch that wrote no
  // audit row look identical from the outside -- and this round proved that the difference is the
  // whole defect.
  const grantEvents =
    (await d1Rows(
      `SELECT action, actor_type FROM security_events
        WHERE action LIKE 'support_grant.%' ORDER BY created_at`,
      "V01 reading the audit rows a support grant must produce",
    )) ?? [];
  const grantWriteSucceeded =
    (grantCreated.status === 200 || grantCreated.status === 201) &&
    (grantRevoked.status === 200 || grantRevoked.status === 201);
  const distinctActions = new Set(grantEvents.map((e) => e.action));
  expect(
    "R5: support-grant creation and revocation EACH wrote a security_events row, which is ADR 0007's " +
      "MUST stated for grants specifically",
    grantWriteSucceeded
      ? grantEvents.length === 2 && distinctActions.size === 2
      : grantEvents.length === distinctActions.size,
    `grantCreated=${grantCreated.status} grantRevoked=${grantRevoked.status} ` +
      `rows=${grantEvents.length} distinctActions=${JSON.stringify([...distinctActions])}`,
  );
  expect(
    "R5: and every one of those rows is attributed to a STAFF actor, not to a customer principal",
    grantEvents.every((e) => e.actor_type === "staff"),
    `actorTypes=${JSON.stringify([...new Set(grantEvents.map((e) => e.actor_type))])}`,
  );

  // =========================================================================================
  // ADR 0007's CENTRAL claim, never tested at the HTTP layer: the three actor kinds cannot reach
  // each other's routes.
  //
  //   "A machine or staff caller cannot reach a route that only calls `authorize`, because those
  //    routes take `Option<&Principal>`."                                   -- ADR 0007
  //   "The prefixes do not overlap, so the two parsers cannot produce a successful result for the
  //    other's input."                                                        -- core/staff.rs
  //
  // This is the load-bearing security property of the whole three-boundary design, and it has been
  // asserted only by unit tests over SQL strings. Three directions, because a boundary that holds in
  // one direction and not the other is half a boundary:
  //
  //   B1  a STAFF token on a CUSTOMER org-scoped route  -> must be refused
  //   B2  a MACHINE key on a STAFF route                -> must be refused
  //   B3  a CUSTOMER session on a STAFF route           -> must be refused
  //
  // Each is graded on the STATUS AND on what the body discloses, and B1 additionally asserts the
  // answer does not differ from a well-formed request naming an organization that does not exist --
  // a staff token that is refused differently depending on whether the org is real is an existence
  // oracle across tenants, which is the whole reason the check is here.
  // =========================================================================================
  probe.stage = "actor-boundaries";
  const PROJECTS = `/api/v1/orgs/${orgA.orgId}/projects`;

  // -- B1: staff on a customer route ----------------------------------------------------------
  const b1 = await request(
    anonJar(),
    "GET",
    PROJECTS,
    undefined,
    asStaff(token(PREFIX, REAL_SECRET)),
  );
  expectStatus(
    "B1: a STAFF token is refused on a CUSTOMER org-scoped route, so the two boundaries are separate",
    b1,
    [401, 403, 404],
    ["authentication_required", "permission_denied", "not_found"],
  );
  const b1Phantom = await request(
    anonJar(),
    "GET",
    `/api/v1/orgs/org_${"0".repeat(32)}/projects`,
    undefined,
    asStaff(token(PREFIX, REAL_SECRET)),
  );
  expect(
    "B1: and the refusal is the SAME for an organization that does not exist, so a staff token is not " +
      "a cross-tenant existence oracle",
    b1.status === b1Phantom.status &&
      withoutRequestId(b1.payload) === withoutRequestId(b1Phantom.payload),
    `realOrg: ${b1.status} ${probe.brief(b1.payload, 90)}\n` +
      `       phantom: ${b1Phantom.status} ${probe.brief(b1Phantom.payload, 90)}`,
  );

  // -- B2: a real machine key on a staff route -------------------------------------------------
  // A REAL key, minted through the API, because a malformed one being refused proves nothing -- the
  // same reason the forged STAFF token is well-formed by construction. A machine key is
  // `lumik_<12 hex>_<43 base64url>`, and `core::staff::StaffKey::parse` cannot accept it, which is the
  // property under test.
  let machineToken = null;
  {
    const account = await request(
      grantUser.jar,
      "POST",
      `/api/v1/orgs/${orgA.orgId}/service-accounts`,
      // `org.read` on the ACCOUNT as well as the key: the create route enforces "a key's capabilities
      // must be a subset of its service account's capabilities", and it says so -- a 422 naming the rule,
      // which is worth contrasting with the silent 401s this round spent several rounds diagnosing.
      { name: "V01 boundary probe", capabilities: ["projects.read", "org.read"] },
      browserMutation(grantUser.jar, `v01-staff-boundary-sa-${probe.nonce}`),
    );
    // The id field is `id` here, not `service_account_id` -- and this repository is deliberately
    // inconsistent about that: `agents` answers `id`, `automations` answers `automation_id`,
    // `service_accounts` answers `id`. Guessing the long form earned a "the fixture was not created"
    // failure for an account the API had created with a `200`, so the chain is kept AND the failure
    // message prints the KEYS -- which is what made the mismatch obvious in one read instead of one
    // guess at a time.
    const accountId =
      account.payload?.service_account?.id ??
      account.payload?.service_account?.service_account_id ??
      account.payload?.service_account_id ??
      account.payload?.id;
    if (accountId) {
      const key = await request(
        grantUser.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/api-keys`,
        {
          service_account_id: accountId,
          name: "V01 boundary key",
          // `org.read` is REQUIRED, and the reason is the finding rather than a fixture detail:
          // `machine_whoami` calls `authorize_machine(..., &Permission::OrgRead, ...)` AFTER
          // `require_machine`, and `machine_denial` codes a SCOPE denial as
          // `AuthenticationRequired` (401). So a key minted without `org.read` is refused with
          // "Authentication is required." for a key that authenticated perfectly -- which sent this
          // probe hunting an authentication bug for several rounds. That is V01-039.
          capabilities: ["org.read"],
        },
        browserMutation(grantUser.jar, `v01-staff-boundary-key-${probe.nonce}`),
      );
      // The field is `secret`, not `token` -- and the module says why it is `secret` and not something
      // more inviting: "The secret appears exactly once", in the create and rotate responses only, and
      // `api_key_json` (every other projection) has no field for one at all. So a list or get can never
      // leak it, which is the property worth preserving in a probe -- and the reason this fixture reads
      // the create response and nothing else.
      machineToken =
        key.payload?.api_key?.secret ?? key.payload?.secret ?? key.payload?.api_key?.token ?? null;
      expect(
        "B2: a REAL machine key was minted, in the `lumik_` scheme, or B2 would be testing a " +
          "malformed token -- which proves nothing",
        typeof machineToken === "string" && machineToken.startsWith("lumik_"),
        `account=${account.status}/${accountId} key=${key.status} ` +
          `token=${typeof machineToken === "string" ? `${machineToken.slice(0, 12)}…(${machineToken.length})` : JSON.stringify(machineToken)} ` +
          `body=${probe.brief(key.payload, 140)}`,
      );
    } else {
      expect(
        "B2: a service account was created for the machine-key fixture",
        false,
        `status=${account.status} topKeys=${JSON.stringify(Object.keys(account.payload ?? {}))} ` +
          `serviceAccountKeys=${JSON.stringify(Object.keys(account.payload?.service_account ?? {}))}`,
      );
    }
  }

  if (machineToken) {
    probe.registerSecret(machineToken);
    const b2 = await request(anonJar(), "GET", FLAGS, undefined, {
      Authorization: `Bearer ${machineToken}`,
    });
    expectStatus(
      "B2: a MACHINE key is refused on a STAFF route -- the `lumik_` and `lumi_staff_` schemes are " +
        "disjoint, so neither parser can accept the other's input",
      b2,
      [401, 403],
      ["authentication_required", "permission_denied", "staff_authentication_required"],
    );

    // And the control: the same key must WORK where a machine actor is accepted, or the refusal above
    // is satisfied by a key that is simply broken rather than by a boundary that holds.
    //
    // The first version of this control used `GET /orgs/{id}/projects` and asserted 2xx. It answers
    // 401 -- correctly, and for the reason ADR 0007 states: that route "only calls `authorize`" and
    // takes `Option<&Principal>`, and a machine key is deliberately not a `Principal`. So the control
    // was asking the wrong question, and a control that asserts the wrong thing is worse than none,
    // because it reports a working boundary as broken.
    //
    // `/api/v1/machine/whoami` is the ONE route in the tree that calls `require_machine`, and it exists
    // precisely to answer "is this credential live". That is the right control, and using it also
    // documents the surface: machine identity has exactly one accepting route, which is worth knowing.
    const b2Control = await request(anonJar(), "GET", "/api/v1/machine/whoami", undefined, {
      Authorization: `Bearer ${machineToken}`,
    });
    expect(
      "B2: and that same machine key WORKS on /machine/whoami -- the one route that accepts a machine " +
        "actor -- so the refusal above is a BOUNDARY and not a broken credential",
      b2Control.status >= 200 && b2Control.status < 300,
      `machineWhoami=${b2Control.status} body=${probe.brief(b2Control.payload, 150)}`,
    );

    // A minted credential MUST authenticate. Stated as its own case, with the arithmetic shown, because
    // "the key was refused on a staff route" and "the key does not work at all" are DIFFERENT defects and
    // the refusal alone cannot tell them apart.
    //
    // `MachineKeyMaterial::from_random_bytes` stores `sha256_hex_of(secret)` where `secret` is the
    // base64url half, and `require_machine` verifies `sha256_hex_of(key.secret())` -- the same half, and
    // `machine.rs`'s own test asserts those are equal and that neither equals the wire value's hash. So
    // the comparison below should find them equal, and when it does not the message says WHICH side
    // disagrees instead of leaving a 401 to be interpreted.
    const machineParts = machineToken.split("_");
    const machinePrefix = machineParts[1];
    const machineSecret = machineParts.slice(2).join("_");
    const machineComputed = createHash("sha256").update(machineSecret).digest("hex");
    const machineRow = (
      await d1Rows(
        `SELECT key_prefix, secret_hash, status FROM api_keys WHERE key_prefix = '${machinePrefix}'`,
        "V01 reading the machine key row the API just created",
      )
    )[0];
    // V01-039. A key that authenticates and is then DENIED must not be told it failed to authenticate.
    //
    // Minted without `org.read`, presented to the one route that requires it. The credential is valid --
    // proved by the sibling control above, an identically-shaped key WITH the capability answered 2xx --
    // so a 401 here is an authorization failure wearing an authentication code.
    //
    // Asserted on the CODE, not merely "not 2xx": a 2xx would be a breach, 403 or 404 would be correct,
    // and asserting only that it is refused would pass straight through the defect.
    const narrowAccount = await request(
      grantUser.jar,
      "POST",
      `/api/v1/orgs/${orgA.orgId}/service-accounts`,
      { name: "V01 narrow scope", capabilities: ["projects.read"] },
      browserMutation(grantUser.jar, `v01-staff-narrow-sa-${probe.nonce}`),
    );
    const narrowAccountId = narrowAccount.payload?.service_account?.id;
    let narrowToken = null;
    if (narrowAccountId) {
      const narrowKey = await request(
        grantUser.jar,
        "POST",
        `/api/v1/orgs/${orgA.orgId}/api-keys`,
        {
          service_account_id: narrowAccountId,
          name: "V01 narrow key",
          capabilities: ["projects.read"],
        },
        browserMutation(grantUser.jar, `v01-staff-narrow-key-${probe.nonce}`),
      );
      narrowToken = narrowKey.payload?.api_key?.secret ?? null;
    }
    if (narrowToken) {
      const narrow = await request(anonJar(), "GET", "/api/v1/machine/whoami", undefined, {
        Authorization: `Bearer ${narrowToken}`,
      });
      expect(
        "V01-039: a key that AUTHENTICATES and is then denied for its scope is refused with " +
          "permission_denied (403), not authentication_required (401) -- the credential was presented " +
          "and accepted, and reporting otherwise makes a scope problem look like a credential problem",
        narrow.status === 403,
        `status=${narrow.status} code=${narrow.payload?.error?.code ?? "-"} ` +
          `reason=${narrow.payload?.error?.details?.reason ?? "-"} ` +
          `body=${probe.brief(narrow.payload, 130)}`,
      );
    } else {
      expect(
        "V01-039: a narrow-scope key was minted for the denial-code case",
        false,
        `account=${narrowAccount.status}/${narrowAccountId}`,
      );
    }

    expect(
      "B2: the stored secret_hash IS sha256(the secret half of the wire value), so the minter and the " +
        "verifier agree on what is being hashed",
      Boolean(machineRow) &&
        machineRow.secret_hash === machineComputed &&
        machineRow.status === "active",
      `prefix=${machinePrefix} (len ${machinePrefix.length}) secretLen=${machineSecret.length} ` +
        `rowStatus=${machineRow?.status ?? "NO ROW"} ` +
        `storedHash=${machineRow?.secret_hash?.slice(0, 16) ?? "-"}... ` +
        `computedHash=${machineComputed.slice(0, 16)}... equal=${machineRow?.secret_hash === machineComputed}`,
    );
    expect(
      "B2: and whoami describes the SERVICE ACCOUNT the key was minted for, so a 2xx there would prove " +
        "the RIGHT credential answered rather than some other one",
      typeof b2Control.payload?.service_account_id === "string" ||
        typeof b2Control.payload?.machine?.service_account_id === "string" ||
        typeof b2Control.payload?.key?.service_account_id === "string",
      `payload=${probe.brief(b2Control.payload, 200)}`,
    );
  }

  // -- B3: a customer session on a staff route ---------------------------------------------------
  const b3 = await request(grantUser.jar, "GET", FLAGS, undefined, {});
  expectStatus(
    "B3: a CUSTOMER session is refused on a STAFF route -- a `MembershipRole` never satisfies a " +
      "`StaffPermission`, so no customer role can reach platform authority",
    b3,
    [401, 403],
    ["authentication_required", "permission_denied", "staff_authentication_required"],
  );

  probe.stage = "done";
});
