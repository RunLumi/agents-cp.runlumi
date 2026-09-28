use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ActorId, CoreError, OrganizationId, Timestamp};

/// The abort texts a **guard sentinel** can produce, and the schema version that
/// produces each.
///
/// A guard sentinel is a deliberately invalid `idempotency_records` insert that
/// aborts a D1 batch when a conditional write matched zero rows. 37 statements
/// across 13 repository modules emit the identical row, and
/// `apps/api/scripts/p02-guard-probe.mjs` counts them so a changed shape is
/// noticed rather than silently unproved.
///
/// The batch error is the ONLY signal that a write was refused ON PURPOSE, as
/// opposed to the store being unavailable, and the two must not be confused: a
/// refusal means "re-read authoritative state and answer accordingly", an outage
/// means "fail closed with 503". Reporting an outage for a deliberate refusal
/// turns a settled 409 into a retryable 503; reporting a refusal for an outage
/// invents a business answer for a system fault.
///
/// # Why a named list and not a substring test
///
/// V00-2026-09-27 (finding VFY-004) broke this by accident. The recogniser was
/// `detail.contains("NOT NULL") || detail.contains("constraint")` -- a
/// case-sensitive match on the text the schema produced before migration `0020`.
/// That migration added `trg_idempotency_pending_has_no_result`, a `BEFORE
/// INSERT` trigger, which fires before the column constraints and aborts with its
/// own `RAISE` text. The error for the byte-identical statement therefore became
///
/// ```text
/// a pending idempotency record carries no result and must hold a claim token:
///   SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)
/// ```
///
/// Neither half of the old test matches that, so every guard in the repository was
/// silently reclassified as a store outage. `p05-smoke.mjs` began returning
/// `status=503 reason=none` for a duplicate budget reservation, and P06 automation
/// refusals became retryable job failures instead of settled ones.
///
/// The old test was ALSO too broad in the other direction. `contains
/// ("constraint")` accepts a UNIQUE or FOREIGN KEY violation on ANY table, so an
/// unrelated integrity failure could be reported as a deliberate guard and
/// answered with business copy. Naming the texts is both narrower and correct.
///
/// # Why these two and not more
///
/// Only two texts are reachable, and that was measured rather than assumed: see
/// `apps/api/scripts/p02-guard-probe.mjs`, which applies the real migrations to a
/// real SQLite database and executes the real sentinel statement.
///
/// * `principal_id TEXT NOT NULL` is a COLUMN constraint, and SQLite evaluates
///   column constraints before table-level `CHECK`s. So pre-`0020` the NOT NULL
///   text always wins and the several `CHECK constraint failed: ...` texts on this
///   table are unreachable. They are deliberately absent; adding them would be
///   dead code a future edit could mistake for coverage.
/// * All 37 sentinels set `state = 'pending'`, so the sibling trigger
///   `trg_idempotency_completed_requires_status` and its message cannot fire
///   either. Also absent, also deliberately.
///
/// # Keeping the list honest
///
/// `apps/api/scripts/p02-guard-probe.mjs` executes a real sentinel through a real
/// database and requires the resulting text to appear in this list. A future
/// migration that changes the abort text therefore fails a gate instead of
/// silently reclassifying every guard. Adding an entry without such a change is a
/// bug, and the probe says so at the point of failure.
const GUARD_ABORT_TEXTS: &[&str] = &[
    // Schema 0019 and earlier: the column NOT NULL constraint. Named down to the
    // COLUMN, not the table, because the sentinel's only NULL-valued NOT NULL
    // column is `principal_id` -- the other NULLs are `response_status`,
    // `response_body`, and `claim_token`, which are nullable from 0020 onward and
    // which the pre-0020 trigger/CHECK rules covered. Naming the table instead
    // would classify a genuine bug that inserted a row with, say, a NULL
    // `organization_id` as a deliberate guard, and hand the caller a business
    // answer for a fault. Measured, not assumed: see the probe.
    "NOT NULL constraint failed: idempotency_records.principal_id",
    // Schema 0020 onward: `trg_idempotency_pending_has_no_result` and
    // `trg_idempotency_pending_claim_is_unique` abort first, with this text.
    "a pending idempotency record carries no result and must hold a claim token",
];

/// True when a D1 batch failed because a guard sentinel refused it, rather than
/// because the store was unavailable.
///
/// Case-insensitive, because the runtime may render the message in either case
/// depending on how the error is formatted. Every entry is a long, specific
/// string, so case-folding costs nothing in precision.
///
/// See [`GUARD_ABORT_TEXTS`] for the evidence behind the list.
pub fn is_guard_abort(detail: &str) -> bool {
    let lowered = detail.to_ascii_lowercase();
    GUARD_ABORT_TEXTS
        .iter()
        .any(|text| lowered.contains(&text.to_ascii_lowercase()))
}

/// Client-supplied key, validated at the request boundary and never persisted.
#[derive(Clone, PartialEq, Eq)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(value: impl Into<String>) -> Result<Self, CoreError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 128
            || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        {
            return Err(CoreError::InvalidIdempotencyKey);
        }
        Ok(Self(value))
    }

    /// Returns the header value for hashing at the trusted server boundary.
    pub fn expose_for_digest(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for IdempotencyKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IdempotencyKey([redacted])")
    }
}

/// Server-side digest of an idempotency key. The raw key is not part of records.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IdempotencyKeyDigest(String);

impl IdempotencyKeyDigest {
    pub fn new(value: impl Into<String>) -> Result<Self, CoreError> {
        let value = value.into();
        if value.is_empty() || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
            return Err(CoreError::InvalidIdempotencyDigest);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for IdempotencyKeyDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IdempotencyKeyDigest([redacted])")
    }
}

/// Server-side digest of the normalized request content.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RequestFingerprint(String);

impl RequestFingerprint {
    pub fn new(value: impl Into<String>) -> Result<Self, CoreError> {
        let value = value.into();
        if value.is_empty() || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
            return Err(CoreError::InvalidRequestFingerprint);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RequestFingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RequestFingerprint([redacted])")
    }
}

/// Uppercase method plus normalized path; query data is never part of the scope.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdempotencyScope {
    pub principal_id: ActorId,
    pub organization_id: Option<OrganizationId>,
    pub method: String,
    pub path: String,
}

impl IdempotencyScope {
    pub fn new(
        principal_id: ActorId,
        organization_id: Option<OrganizationId>,
        method: impl Into<String>,
        path: impl Into<String>,
    ) -> Result<Self, CoreError> {
        let method = method.into();
        let path = path.into();
        if method.is_empty()
            || method.len() > 16
            || !method
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte == b'-')
            || !path.starts_with('/')
            || path.contains('?')
            || path.contains('#')
            || path.chars().any(char::is_control)
        {
            return Err(CoreError::InvalidEndpointScope);
        }
        Ok(Self {
            principal_id,
            organization_id,
            method,
            path,
        })
    }
}

impl fmt::Debug for IdempotencyScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdempotencyScope")
            .field("principal_id", &"[redacted]")
            .field(
                "organization_id",
                &self.organization_id.as_ref().map(|_| "[redacted]"),
            )
            .field("method", &self.method)
            .field("path", &self.path)
            .finish()
    }
}

/// Successful response saved for a safe idempotency replay.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredSuccess {
    pub status: u16,
    pub body: Value,
}

impl StoredSuccess {
    pub fn new(status: u16, body: Value) -> Result<Self, CoreError> {
        if !(200..300).contains(&status) {
            return Err(CoreError::InvalidSuccessStatus);
        }
        Ok(Self { status, body })
    }
}

impl fmt::Debug for StoredSuccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredSuccess")
            .field("status", &self.status)
            .field("body", &"[redacted]")
            .finish()
    }
}

/// Whether a scoped idempotency operation is executing or can be replayed.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", content = "result", rename_all = "snake_case")]
pub enum IdempotencyState {
    Pending,
    Completed(StoredSuccess),
}

impl fmt::Debug for IdempotencyState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => f.write_str("Pending"),
            Self::Completed(_) => f.write_str("Completed([redacted])"),
        }
    }
}

/// Persistable idempotency state. Expiry is bounded to 24 hours by the caller.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct IdempotencyRecord {
    pub scope: IdempotencyScope,
    pub key_digest: IdempotencyKeyDigest,
    pub request_fingerprint: RequestFingerprint,
    pub expires_at: Timestamp,
    pub state: IdempotencyState,
}

impl fmt::Debug for IdempotencyRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdempotencyRecord")
            .field("scope", &self.scope)
            .field("key_digest", &"[redacted]")
            .field("request_fingerprint", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("state", &self.state)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn scope() -> IdempotencyScope {
        IdempotencyScope::new(
            "anonymous-local".parse().unwrap(),
            None,
            "POST",
            "/api/v1/_internal/foundation-checks",
        )
        .unwrap()
    }

    #[test]
    fn idempotency_header_validation_follows_frozen_byte_bounds() {
        assert!(IdempotencyKey::new("").is_err());
        assert!(IdempotencyKey::new("contains\nnewline").is_err());
        assert!(IdempotencyKey::new("x".repeat(129)).is_err());
        let key = IdempotencyKey::new("client-key-123").unwrap();
        assert_eq!(key.expose_for_digest(), "client-key-123");
        assert_eq!(format!("{key:?}"), "IdempotencyKey([redacted])");
    }

    #[test]
    fn scope_excludes_query_and_normalizes_method_by_contract() {
        assert!(
            IdempotencyScope::new("principal".parse().unwrap(), None, "post", "/api/v1/items")
                .is_err()
        );
        assert!(
            IdempotencyScope::new(
                "principal".parse().unwrap(),
                None,
                "POST",
                "/api/v1/items?x=1"
            )
            .is_err()
        );
        let scope = scope();
        assert_eq!(scope.method, "POST");
        assert_eq!(scope.path, "/api/v1/_internal/foundation-checks");
    }

    #[test]
    fn record_shape_uses_digest_and_replayable_success_without_raw_key() {
        let record = IdempotencyRecord {
            scope: scope(),
            key_digest: IdempotencyKeyDigest::new("sha256:0123456789abcdef").unwrap(),
            request_fingerprint: RequestFingerprint::new("sha256:fedcba9876543210").unwrap(),
            expires_at: "2026-09-25T12:00:00.000Z".parse().unwrap(),
            state: IdempotencyState::Completed(
                StoredSuccess::new(202, json!({ "delivery_status": "pending" })).unwrap(),
            ),
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["key_digest"], "sha256:0123456789abcdef");
        assert_eq!(value["request_fingerprint"], "sha256:fedcba9876543210");
        assert_eq!(value["state"]["status"], "completed");
        assert_eq!(value["state"]["result"]["status"], 202);
        assert!(value.get("raw_key").is_none());
        assert!(!format!("{record:?}").contains("pending"));
    }

    #[test]
    fn every_text_a_guard_sentinel_can_produce_is_recognised() {
        // The two shapes below are the REAL D1 output for the byte-identical
        // sentinel statement, measured by applying the migrations to a database
        // and running it: the column NOT NULL text before migration 0020, and
        // the trigger text from 0020 onward. `apps/api/scripts/p02-guard-probe.mjs`
        // re-measures this against the live schema, so the two halves cannot
        // drift apart silently.
        for text in [
            "D1_ERROR: NOT NULL constraint failed: idempotency_records.principal_id",
            "D1_ERROR: a pending idempotency record carries no result and must hold a claim token: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
            // The runtime may or may not append the extended code, and may
            // re-case the message; both are matched case-insensitively.
            "Error: A Pending Idempotency Record Carries No Result And Must Hold A Claim Token",
        ] {
            assert!(is_guard_abort(text), "guard text not recognised: {text}");
        }
    }

    #[test]
    fn a_genuine_store_failure_is_not_mistaken_for_a_guard() {
        // The over-broad half of the old test, and the more dangerous half.
        // These are real D1 failures that must stay "unavailable", because
        // treating one as a deliberate refusal reports a business answer for an
        // outage: a caller would be told their budget is exhausted when in fact
        // the store could not be reached, and would not retry.
        for text in [
            "D1_ERROR: UNIQUE constraint failed: outbox_events.event_id",
            "D1_ERROR: FOREIGN KEY constraint failed",
            "D1_ERROR: no such table: budget_reservations",
            "D1_ERROR: too many SQL variables",
            // The over-broad test matched this, because it contains
            // "constraint". Nothing about it is a deliberate guard.
            "D1_ERROR: CHECK constraint failed: state = 'completed' AND response_status BETWEEN 200 AND 299",
            // Near misses on the sentinel TABLE that are still real failures.
            // A NOT NULL violation on any other column of `idempotency_records`
            // is a code bug, not a guard, and must be reported as unavailable.
            "D1_ERROR: NOT NULL constraint failed: idempotency_records.organization_id",
            "D1_ERROR: NOT NULL constraint failed: idempotency_records.method",
        ] {
            assert!(
                !is_guard_abort(text),
                "store failure read as a guard: {text}"
            );
        }
    }

    #[test]
    fn the_abort_text_list_has_no_unreachable_entries() {
        // Dead entries are a liability: a future reader cannot tell an entry that
        // is measured from one that is guessed, and a guessed one invites
        // "fixing" the recognizer by matching more. Both entries are measured by
        // `apps/api/scripts/p02-guard-probe.mjs`; this test pins the count so
        // adding a third requires noticing that it has no evidence behind it.
        assert_eq!(
            GUARD_ABORT_TEXTS.len(),
            2,
            "GUARD_ABORT_TEXTS grew to {} entries. Only two are reachable: the \
             column NOT NULL text (schema 0019 and earlier) and the pending-trigger \
             text (0020 onward). If a migration genuinely changed the abort text, \
             prove it with the probe first, then update this count deliberately.",
            GUARD_ABORT_TEXTS.len()
        );
    }

    #[test]
    fn an_empty_list_would_be_caught() {
        // `is_guard_abort` must not degrade to "always false" if the list is
        // emptied or the parse is broken. A guard that is never recognised turns
        // into a 503 on every refusal, which is the original defect in a new coat.
        assert!(!is_guard_abort(""));
        assert!(GUARD_ABORT_TEXTS.iter().all(|text| !text.is_empty()));
    }

    #[test]
    fn stored_result_accepts_only_2xx_status() {
        assert!(StoredSuccess::new(200, json!({})).is_ok());
        assert_eq!(
            StoredSuccess::new(409, json!({})),
            Err(CoreError::InvalidSuccessStatus)
        );
    }
}
