// Pure support for `phase02-workspace-hostile-probe.mjs`. Nothing here does I/O, so it is
// unit-testable without a Worker, wrangler or D1 (see `phase02-workspace-hostile-probe.test.mjs`).
//
// What lives here is exactly the part of the probe that could silently turn a failure into a
// pass: the claim ledger (a table claim nobody resolved is UNPROVEN, never green), the state
// digest comparison (a refusal is graded on stored state, not on a status code) and the device
// identity (a real Ed25519 proof of possession, not a stand-in signer).

import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  BLOCKED: "BLOCKED",
  UNPROVEN: "UNPROVEN",
});

/**
 * One table of claims, resolved exactly once each.
 *
 * - `pass`/`fail`/`block` may be called many times for one claim (a claim usually has several
 *   assertions). The claim's status is the worst of what was recorded: FAIL > BLOCKED > PASS.
 * - A claim with no recorded outcome is UNPROVEN. An id that is not in the table throws, so a
 *   typo cannot create a claim that nothing declared.
 */
export class ClaimLedger {
  constructor(claims) {
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error("a non-empty claim table is required");
    }
    this.claims = new Map();
    for (const claim of claims) {
      if (this.claims.has(claim.id)) throw new Error(`duplicate claim id ${claim.id}`);
      this.claims.set(claim.id, { ...claim, outcomes: [] });
    }
  }

  #record(id, status, detail) {
    const claim = this.claims.get(id);
    if (!claim) throw new Error(`unknown claim id ${id}`);
    claim.outcomes.push({ status, detail });
  }

  pass(id, detail = "") {
    this.#record(id, STATUS.PASS, detail);
  }

  fail(id, detail = "") {
    this.#record(id, STATUS.FAIL, detail);
  }

  block(id, detail = "") {
    this.#record(id, STATUS.BLOCKED, detail);
  }

  statusOf(id) {
    const claim = this.claims.get(id);
    if (!claim) throw new Error(`unknown claim id ${id}`);
    const seen = new Set(claim.outcomes.map((outcome) => outcome.status));
    if (seen.has(STATUS.FAIL)) return STATUS.FAIL;
    if (seen.has(STATUS.BLOCKED)) return STATUS.BLOCKED;
    if (seen.has(STATUS.PASS)) return STATUS.PASS;
    return STATUS.UNPROVEN;
  }

  /** Every claim id with its resolved status, in table order. */
  summary() {
    return [...this.claims.keys()].map((id) => ({ id, status: this.statusOf(id) }));
  }

  /** The process exit code: 0 only if every claim PASSed; 1 if any FAIL; otherwise 2. */
  exitCode() {
    const statuses = this.summary().map((entry) => entry.status);
    if (statuses.includes(STATUS.FAIL)) return 1;
    return statuses.every((status) => status === STATUS.PASS) ? 0 : 2;
  }
}

/** Keys whose value differs between two plain objects (order-insensitive, shallow). */
export function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

/**
 * The stored-state digest a refusal is graded on. `row` is the adoption row projection; the rest
 * are scalar counts and a binding-table digest. Two digests are "unchanged" only if every field is
 * identical, and a digest with a missing field is never unchanged: an unread value must not
 * compare equal to another unread value.
 */
export const DIGEST_FIELDS = Object.freeze([
  "row",
  "adoption_events",
  "security_events",
  "outbox_events",
  "idempotency_records",
  "bindings",
]);

export function digestFromD1Row(d1Row) {
  const digest = {};
  for (const field of DIGEST_FIELDS) {
    const value = d1Row?.[field];
    digest[field] = value === undefined ? null : value;
  }
  return digest;
}

/**
 * `ignore` names fields a particular refusal is ALLOWED to move (a permission denial may append a
 * `denied` security event). Ignoring a field is explicit and per call; the default ignores none.
 */
export function digestsUnchanged(before, after, { ignore = [] } = {}) {
  if (!before || !after) return { unchanged: false, changed: ["(digest missing)"] };
  const fields = DIGEST_FIELDS.filter((field) => !ignore.includes(field));
  const unread = fields.filter((field) => before[field] === null || after[field] === null);
  if (unread.length > 0) return { unchanged: false, changed: unread.map((f) => `${f} (unread)`) };
  const changed = changedKeys(before, after).filter((key) => fields.includes(key));
  return { unchanged: changed.length === 0, changed };
}

/** The SQL that produces one digest row. Ids are validated before they reach SQL text. */
// Prefix plus a bare alphanumeric tail: no quote, whitespace or punctuation can reach SQL text.
const SAFE_ID = /^[a-z]{2,4}_[0-9a-zA-Z]{8,64}$/;
export function assertSafeId(id, label) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(`${label}: refusing to build SQL from a malformed id`);
  }
  return id;
}

export function digestSql({ adoptionStateId, orgId }) {
  const adoption = assertSafeId(adoptionStateId, "adoption id");
  const org = assertSafeId(orgId, "org id");
  return (
    `SELECT ` +
    `(SELECT json_object('stage', stage, 'ownership', ownership, 'credential_mode', credential_mode, ` +
    `'bound_project_id', bound_project_id, 'bound_device_id', bound_device_id, ` +
    `'rolled_back_from_stage', rolled_back_from_stage, 'reversion_count', reversion_count, ` +
    `'version', version, 'updated_at', updated_at, 'external_workspace_key', external_workspace_key, ` +
    `'external_installation_id', external_installation_id) ` +
    `FROM workspace_adoption_states WHERE adoption_state_id = '${adoption}') AS row, ` +
    `(SELECT COUNT(*) FROM adoption_stage_events WHERE adoption_state_id = '${adoption}') AS adoption_events, ` +
    `(SELECT COUNT(*) FROM security_events WHERE org_id = '${org}') AS security_events, ` +
    `(SELECT COUNT(*) FROM outbox_events WHERE organization_id = '${org}') AS outbox_events, ` +
    `(SELECT COUNT(*) FROM idempotency_records WHERE organization_id = '${org}') AS idempotency_records, ` +
    `(SELECT COALESCE(group_concat(digest, '|'), '') FROM (SELECT binding_id || ':' || ` +
    `COALESCE(removed_at, '') || ':' || updated_at AS digest FROM workspace_bindings ` +
    `ORDER BY binding_id)) AS bindings`
  );
}

/** A real Ed25519 device identity. `verifyOwn` exists so the unit test can prove the signature is real. */
export function makeDeviceIdentity(label) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyFingerprint = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  return {
    label,
    publicKeyPem,
    keyFingerprint,
    sign: (message) => sign(null, Buffer.from(message), privateKey).toString("hex"),
    verifyOwn: (message, signatureHex) =>
      verify(
        null,
        Buffer.from(message),
        createPublicKey(publicKeyPem),
        Buffer.from(signatureHex, "hex"),
      ),
  };
}

export const TIMESTAMP_24 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `removed_at` must be the 24-character wire timestamp the migration's CHECK requires. */
export function isTombstoneTimestamp(value) {
  return typeof value === "string" && value.length === 24 && TIMESTAMP_24.test(value);
}

/** Binding ids from either list shape the routes use (`id` or `binding_id`, under `items`). */
export function bindingIdsOf(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map((item) => item?.id ?? item?.binding_id).filter((id) => typeof id === "string");
}

/** Project ids the device policy snapshot currently authorizes, or `null` if the shape is wrong. */
export function policyProjectIds(payload) {
  const bindings = payload?.payload?.projects?.bindings;
  return Array.isArray(bindings) && bindings.every((value) => typeof value === "string")
    ? bindings
    : null;
}

/** First line of `text` containing `needle`, for labelled source-fact diagnostics. */
export function sourceLineContaining(text, needle) {
  const lines = String(text).split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? null : { line: index + 1, text: lines[index].trim() };
}

/** The shape of the claims table in `docs/verification/phase02-workspace-hostile-probe.md`. */
export function claimIdsFromMarkdown(markdown) {
  const ids = [];
  for (const line of String(markdown).split("\n")) {
    const match = /^\|\s*(S[456]-[A-Z]+\d+)\s*\|/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}
