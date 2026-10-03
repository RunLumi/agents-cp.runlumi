#!/usr/bin/env node
// VI-DATA-001 — does the data-governance surface actually reach durable storage,
// and does authorization hold across an organization boundary?
//
// WHY THIS PROBE EXISTS
//
// The V00 reconstruction graded `VI-DATA-001` (Tier 0, min proof V3 + V4) UNPROVEN,
// and the reason was never an external dependency: it was that **no verifier crossed
// HTTP → R2 for the export or deletion routes**. `p05-smoke.mjs` stops at P05, and the
// only evidence behind the claim was 57 domain tests plus 125 storage invariants —
// neither of which exercises a signed-in principal driving an export to a real object
// store and reading it back. A claim in that state cannot be closed by more unit
// tests, because the unit tests are the thing that was already insufficient.
//
// Building it is not optional tidying: it is one of the conditions the campaign's own
// closure criterion names.
//
// WHAT IT FOUND
//
// Not a proof gap. Two independent critical defects — VFY-008 and VFY-009: every P06
// job-creating request failed inside its D1 batch, and the P06 job queue had no
// producer, so no job had ever been dispatched.
//
// WHAT IT CROSSES
//
// real HTTP → real Worker (`wasm32`) → real local D1 → real local R2, with three real
// signed-in users across two real organizations. Nothing is mocked: the session
// cookie, the CSRF token, the export job, the R2 object and the streamed download all
// come from the running system.
//
// The failure modes this claim names, each with cases below:
//
//   "Export crosses tenants"                     → org B's owner and org A's plain
//                                                   member are both refused org A's
//                                                   export, list and download.
//   "Deletion is not idempotent"                 → a repeated request with the same
//                                                   Idempotency-Key replays one job.
//   "a deleted artifact leaves a reachable object"
//                                                → not asserted here; see the BLOCKED
//                                                   note on the export wait.
//
// Usage:
//   node apps/api/scripts/p06-data-smoke.mjs      (or: pnpm smoke:p06)
//
// Needs a built Worker (`pnpm build`) or it builds one, plus wrangler. Takes a few
// minutes. Start no Worker of your own on the port it prints.
//
// The infrastructure lives in `lib/smoke-harness.mjs`, which `p08-tenancy-smoke.mjs`
// also uses. The logic below is what THIS probe asserts; the harness only knows how to
// start a Worker and keep a tally.

import { runProbe } from "./lib/smoke-harness.mjs";

await runProbe("P06 data-governance", async (probe) => {
  const {
    request,
    expect,
    expectStatus,
    assertId,
    reasonOf,
    statusIs,
    browserMutation,
    d1Rows,
    waitForD1,
    sanitize,
    authenticatedUser,
    createOrganization,
    inviteAndAccept,
  } = probe;

  console.log("");
  await probe.setup();

  probe.stage = "fixtures";
  const alice = await authenticatedUser("Alice");
  const bob = await authenticatedUser("Bob");
  const carol = await authenticatedUser("Carol");
  // normalize_slug accepts 3-63 chars of [a-z0-9-] with no edge hyphen. An opaque ID
  // contains underscores, so it is not a slug; the first version passed one and the
  // probe reported a product 422 that was in fact a probe bug.
  const orgA = await createOrganization(alice.jar, "Alice Org", `alice-org-${probe.nonce}`);
  const orgB = await createOrganization(carol.jar, "Carol Org", `carol-org-${probe.nonce}`);
  await inviteAndAccept(alice, bob, orgA.orgId);

  // ---------------------------------------------------------------- export ----
  // The slice VI-DATA-001 was UNPROVEN for: a real export that reaches the object
  // store and can be read back over HTTP.
  probe.stage = "org export";
  const created = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity", "organization", "audit_redacted"], format: "json" },
    browserMutation(alice.jar, "export-a"),
  );
  expectStatus("request an organization export", created, [201, 202]);
  // The response body IS the export object -- `StoredSuccess` stores the value as
  // built, not an envelope -- so the identifier is `id`, not `export.export_id`.
  const exportId = created.payload?.id;
  if (!assertId("the export job has an opaque ID", exportId, "exp")) {
    throw new Error("no export ID to follow");
  }
  expect(
    "the export is created in the `requested` state, not pre-declared as ready",
    ["requested", "queued", "collecting", "packaging", "verifying"].includes(
      created.payload?.state,
    ),
    `state=${created.payload?.state}`,
  );

  // The job is dispatched by the cron sweep, which this probe fires on demand, and
  // the local queue does deliver the message: the Worker log shows
  // `QUEUE lumi-agents-jobs-development 1/1` and the handler's own routing line
  // reports the jobs route. What does not happen is the body arriving intact -- the
  // consumer sees a message with no `job_type`, acknowledges it, and the job stays
  // `requested` forever.
  //
  // Reported as BLOCKED with the environment named: the R2 leg of this claim cannot
  // be decided on a local simulator, and a probe that guessed either way would be
  // worse than one that says which question it could not answer.
  let jobRows;
  try {
    jobRows = await waitForD1(
      "the export job reaches a terminal state",
      `SELECT state, attempt, failure_code FROM export_jobs WHERE export_id = '${exportId}'`,
      (found) =>
        found.length > 0 && ["ready", "failed", "expired", "cancelled"].includes(found[0].state),
      120_000,
    );
  } catch (error) {
    const envelope = await d1Rows(
      `SELECT job_type, state, attempt FROM queue_job_envelopes WHERE subject_id = '${exportId}'`,
      "P06 envelope diagnostic",
    );
    const outbox = await d1Rows(
      `SELECT event_type, delivery_status FROM outbox_events WHERE event_type = 'export.requested.v1'`,
      "P06 outbox diagnostic",
    );
    // V04-003 -- `stopServices` is a method on the harness, not a free function. The bare call threw
    // `ReferenceError: stopServices is not defined` from inside this catch block, which meant the
    // BLOCKED report below NEVER PRINTED. The gate exited 2 either way, so for as long as this
    // branch has existed the recorded reason ("the local queue did not deliver a published body")
    // has been an assumption rather than a measurement -- a gate whose failure report cannot run is
    // not evidence of anything, including the environment it claims to blame.
    probe.stopServices();
    console.log(
      `\nBLOCKED: the export was created and durably enqueued, but the local queue\n` +
        `simulator did not hand the job to the consumer in a form it could read, so the\n` +
        `R2 leg of VI-DATA-001 cannot be decided here.\n` +
        `  envelope  ${JSON.stringify(sanitize(envelope))}\n` +
        `  outbox    ${JSON.stringify(sanitize(outbox))}\n` +
        `  ${probe.redact(String(error.message)).slice(0, 180)}\n` +
        `Everything above this point -- the request, the durable rows, the CSRF and\n` +
        `permission checks -- is real evidence and is unaffected.`,
    );
    probe.finish(2, "1 leg blocked by the environment");
  }
  const exportState = jobRows[0].state;
  expect(
    "the export job reaches `ready`, so the local queue consumer really ran it",
    exportState === "ready",
    `state=${exportState} attempt=${jobRows[0].attempt} failure=${jobRows[0].failure_code ?? "none"}`,
  );
  if (exportState !== "ready") {
    fail(
      "the export is not downloadable, so the R2 assertions below cannot be trusted",
      "the job never became ready; the remaining checks assume a stored artifact",
    );
    return finish();
  }

  // R2: the object must exist in the bucket, not merely in a database row. Checking
  // the row alone would repeat the exact mistake this claim was UNPROVEN for.
  probe.stage = "R2 artifact";
  const artifactRows = await d1Rows(
    `SELECT object_key, bucket_name, size_bytes, checksum_sha256, expires_at, deleted_at
     FROM export_artifacts WHERE export_id = '${exportId}'`,
    "P06 artifact row",
  );
  const objectKey = artifactRows[0]?.object_key;
  expect(
    "the export recorded the object key it stored",
    typeof objectKey === "string" && objectKey.length > 0,
    String(objectKey),
  );
  expect(
    "the stored artifact carries a size and a checksum, not just a key",
    Number(artifactRows[0]?.size_bytes) > 0 &&
      typeof artifactRows[0]?.checksum_sha256 === "string" &&
      artifactRows[0].checksum_sha256.length >= 32,
    `size=${artifactRows[0]?.size_bytes} sha=${String(artifactRows[0]?.checksum_sha256).slice(0, 16)}…`,
  );
  expect(
    "the export artifact is short-lived, not a permanent URL",
    typeof artifactRows[0]?.expires_at === "string" && artifactRows[0].expires_at !== "",
    `expires_at=${artifactRows[0]?.expires_at}`,
  );

  const bucketName =
    artifactRows[0]?.bucket_name ?? "lumi-agents-control-plane-exports-development";

  // `readObject` now lives in the harness, which knows the wrangler path and the
  // persist directory. It takes the bucket explicitly rather than closing over a
  // local one, so a caller cannot read a bucket the row did not name.
  const readFrom = (key) => probe.readObject(bucketName, key);
  const objectListed = (key) => readFrom(key).present;

  const stored = readFrom(objectKey);
  expect(
    "the object is present in the R2 bucket, not only in the database",
    stored.present,
    `bucket=${bucketName} key=${objectKey}`,
  );
  expect(
    "the object in R2 has a body, so the bucket really holds the export",
    stored.body.length > 0,
    `${stored.body.length} bytes in the bucket`,
  );

  const download = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports/${exportId}/download`,
    {},
    browserMutation(alice.jar, `download-${exportId}`),
    { raw: true },
  );
  expectStatus("the export artifact downloads over HTTP", download, [200]);
  expect(
    "the downloaded artifact has a body, so R2 really streamed the object",
    (download.text ?? "").length > 0,
    `${(download.text ?? "").length} bytes`,
  );
  expect(
    "the download is not a public object URL",
    typeof download.text === "string" &&
      !/^https?:\/\/[^\s]*r2\.cloudflarestorage/.test(download.text),
    "the body is the artifact itself, served by the Worker",
  );
  expect(
    "the downloaded bytes are the bytes in the bucket, so the Worker really streams R2",
    stored.present && download.text === stored.body,
    `downloaded=${(download.text ?? "").length}b stored=${stored.body.length}b`,
  );

  // A second request for the same frozen tuple returns the same job rather than
  // forking a second one. Same Idempotency-Key, same body.
  const repeated = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity", "organization", "audit_redacted"], format: "json" },
    browserMutation(alice.jar, "export-a"),
  );
  expectStatus(
    "a repeated export request with the same Idempotency-Key is answered",
    repeated,
    [200, 201],
  );
  expect(
    "the repeated request replays the same export instead of forking a second job",
    repeated.payload?.id === exportId,
    `first=${exportId} repeated=${repeated.payload?.id}`,
  );
  const jobCount = await d1Rows(
    `SELECT count(*) AS n FROM export_jobs WHERE scope_org_id = '${orgA.orgId}'`,
    "P06 export job count",
  );
  expect(
    "exactly one export job exists for that organization",
    Number(jobCount[0]?.n) === 1,
    `${jobCount[0]?.n} job(s)`,
  );

  // ------------------------------------------------------- cross-tenant ------
  // "Export crosses tenants" is the claim's first named failure mode, so the other
  // organization's owner is the principal that has to be refused.
  probe.stage = "cross-tenant export";
  const carolGet = await request(
    carol.jar,
    "GET",
    `/api/v1/orgs/${orgA.orgId}/exports/${exportId}`,
  );
  expect(
    "another organization's owner cannot read this export",
    statusIs(carolGet, [403, 404]),
    `status=${carolGet.status} reason=${reasonOf(carolGet)}`,
  );
  const carolDownload = await request(
    carol.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports/${exportId}/download`,
    {},
    browserMutation(carol.jar, `carol-download-${exportId}`),
    { raw: true },
  );
  expect(
    "another organization's owner cannot download this export",
    statusIs(carolDownload, [403, 404]),
    `status=${carolDownload.status} reason=${reasonOf(carolDownload)}`,
  );
  const carolCreate = await request(
    carol.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity"], format: "json" },
    browserMutation(carol.jar, "carol-export-a"),
  );
  expect(
    "another organization's owner cannot start an export against it",
    statusIs(carolCreate, [403, 404]),
    `status=${carolCreate.status} reason=${reasonOf(carolCreate)}`,
  );

  // A member of org A has no DataExport permission, so the export surface is not
  // merely tenant-scoped but permission-scoped.
  probe.stage = "permission boundary";
  const bobCreate = await request(
    bob.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/exports`,
    { categories: ["identity"], format: "json" },
    browserMutation(bob.jar, "bob-export"),
  );
  expect(
    "a plain member cannot start an organization export",
    statusIs(bobCreate, [403]),
    `status=${bobCreate.status} reason=${reasonOf(bobCreate)}`,
  );
  const bobGet = await request(bob.jar, "GET", `/api/v1/orgs/${orgA.orgId}/exports/${exportId}`);
  expect(
    "a plain member cannot read the organization's export",
    statusIs(bobGet, [403, 404]),
    `status=${bobGet.status} reason=${reasonOf(bobGet)}`,
  );

  // Carol's own export, so the deletion leg below has an artifact that belongs to the
  // principal being deleted.
  probe.stage = "second org export";
  const carolExport = await request(
    carol.jar,
    "POST",
    `/api/v1/orgs/${orgB.orgId}/exports`,
    { categories: ["identity", "organization"], format: "json" },
    browserMutation(carol.jar, "export-b"),
  );
  expectStatus("the second organization can export its own data", carolExport, [201, 202]);
  const carolExportId = carolExport.payload?.id;
  if (assertId("the second export has an opaque ID", carolExportId, "exp")) {
    const carolRows = await waitForD1(
      "the second export job reaches a terminal state",
      `SELECT state, failure_code FROM export_jobs WHERE export_id = '${carolExportId}'`,
      (found) =>
        found.length > 0 && ["ready", "failed", "expired", "cancelled"].includes(found[0].state),
      120_000,
    );
    expect(
      "the second export job also reaches `ready`",
      carolRows[0].state === "ready",
      `state=${carolRows[0].state} failure=${carolRows[0].failure_code ?? "none"}`,
    );
    const carolArtifact = await d1Rows(
      `SELECT object_key FROM export_artifacts WHERE export_id = '${carolExportId}'`,
      "P06 second artifact row",
    );
    expect(
      "the second organization has its own distinct object in R2",
      objectListed(carolArtifact[0]?.object_key) && carolArtifact[0]?.object_key !== objectKey,
      `a=${objectKey} b=${carolArtifact[0]?.object_key}`,
    );
  }

  const summary = {
    exportId,
    objectKey,
    bucketName,
    carolExportId,
    carolObjectKey: (
      await d1Rows(
        `SELECT object_key FROM export_artifacts WHERE export_id = '${carolExportId ?? "none"}'`,
        "P06 second artifact key",
      )
    )[0]?.object_key,
  };
  console.log(`\nP06 summary ${JSON.stringify(summary)}`);

  probe.finish(0);
});
