//! D1 persistence for P03 managed devices, enrollments, and device tokens.
//!
//! SQL is constant and fully bound (P01/P02 convention); invariant-bearing
//! writes run as D1 batches so state transitions stay atomic.

use serde::{Deserialize, Serialize};
use worker::d1::D1PreparedStatement;

use crate::{
    adapters::d1::{BindValue, D1Adapter},
    core::Timestamp,
};

/// One organization's device-policy row (F19-008). `min_client_version` is
/// `None` while no floor is armed; `version` carries the optimistic-concurrency
/// counter the admin write surface guards on (migration 0024).
#[derive(Debug, Deserialize)]
pub struct DevicePolicyRecord {
    pub org_id: String,
    pub min_client_version: Option<String>,
    pub version: i64,
    pub updated_at: String,
}

const FIND_DEVICE_POLICY_SQL: &str = r#"
SELECT org_id, min_client_version, version, updated_at
FROM org_device_policy_settings
WHERE org_id = ?1
LIMIT 1
"#;

const UPSERT_DEVICE_POLICY_SQL: &str = r#"
INSERT INTO org_device_policy_settings (org_id, min_client_version, version, updated_at)
VALUES (?1, ?2, ?3 + 1, ?4)
ON CONFLICT(org_id) DO UPDATE SET
    min_client_version = excluded.min_client_version,
    version = ?3 + 1,
    updated_at = excluded.updated_at
WHERE org_device_policy_settings.version = ?3
"#;

const ASSERT_DEVICE_POLICY_VERSION_SQL: &str = r#"
INSERT INTO idempotency_records (
    principal_id, organization_id, method, path, key_digest, request_fingerprint,
    state, response_status, response_body, expires_at, claim_token
)
SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL
WHERE NOT EXISTS (
    SELECT 1 FROM org_device_policy_settings WHERE org_id = ?1 AND version = ?2
)
"#;

const ASSERT_DEVICE_POLICY_ABSENT_SQL: &str = r#"
INSERT INTO idempotency_records (
    principal_id, organization_id, method, path, key_digest, request_fingerprint,
    state, response_status, response_body, expires_at, claim_token
)
SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL
WHERE EXISTS (
    SELECT 1 FROM org_device_policy_settings WHERE org_id = ?1
)
"#;

const INSERT_ENROLLMENT_SQL: &str = r#"INSERT INTO device_enrollments (
    enrollment_id, org_id, code_hash, public_key, key_fingerprint,
    device_name, platform, app_version, status, challenge, expires_at, created_at, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11, ?11)
"#;

const ENROLLMENT_BY_ID_SQL: &str = r#"
SELECT enrollment_id, org_id, code_hash, public_key, key_fingerprint, device_name,
       platform, app_version, status, challenge, device_id, approved_by_user_id,
       expires_at, created_at, updated_at
FROM device_enrollments
WHERE enrollment_id = ?1
LIMIT 1
"#;

const EXPIRE_ENROLLMENT_SQL: &str = r#"
UPDATE device_enrollments
SET status = 'expired', updated_at = ?2
WHERE enrollment_id = ?1 AND status = 'pending'
"#;

const DENY_ENROLLMENT_SQL: &str = r#"
UPDATE device_enrollments
SET status = 'denied', updated_at = ?3
WHERE enrollment_id = ?1 AND org_id = ?2 AND status = 'pending'
"#;

const INSERT_DEVICE_SQL: &str = r#"
INSERT INTO devices (
    device_id, org_id, enrolled_by_user_id, name, platform, app_version,
    public_key, key_fingerprint, status, created_at, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?9)
"#;

const APPROVE_ENROLLMENT_SQL: &str = r#"
UPDATE device_enrollments
SET approved_by_user_id = ?3, device_id = ?4, updated_at = ?5
WHERE enrollment_id = ?1 AND org_id = ?2 AND status = 'pending' AND expires_at > ?5
"#;

const COMPLETE_ENROLLMENT_SQL: &str = r#"
UPDATE device_enrollments
SET status = 'completed', device_id = ?2, updated_at = ?3
WHERE enrollment_id = ?1 AND status = 'pending'
  AND approved_by_user_id IS NOT NULL AND expires_at > ?3
"#;

const INSERT_DEVICE_TOKEN_SQL: &str = r#"
INSERT INTO device_tokens (token_hash, device_id, expires_at, created_at)
VALUES (?1, ?2, ?3, ?4)
"#;

const DEVICE_BY_ID_SQL: &str = r#"
SELECT device_id, org_id, enrolled_by_user_id, name, platform, app_version,
       public_key, key_fingerprint, status, capabilities, capability_reported_at,
       last_seen_at, revoked_at, revoked_by_user_id, created_at, updated_at
FROM devices
WHERE device_id = ?1
LIMIT 1
"#;

const DEVICES_BY_ORG_SQL: &str = r#"
SELECT device_id, org_id, enrolled_by_user_id, name, platform, app_version,
       public_key, key_fingerprint, status, capabilities, capability_reported_at,
       last_seen_at, revoked_at, revoked_by_user_id, created_at, updated_at
FROM devices
WHERE org_id = ?1 AND (created_at, device_id) < (?2, ?3)
ORDER BY created_at DESC, device_id DESC
LIMIT ?4
"#;

const FIRST_DEVICES_PAGE_SQL: &str = r#"
SELECT device_id, org_id, enrolled_by_user_id, name, platform, app_version,
       public_key, key_fingerprint, status, capabilities, capability_reported_at,
       last_seen_at, revoked_at, revoked_by_user_id, created_at, updated_at
FROM devices
WHERE org_id = ?1
ORDER BY created_at DESC, device_id DESC
LIMIT ?2
"#;

const REVOKE_DEVICE_SQL: &str = r#"
UPDATE devices
SET status = 'revoked', revoked_at = ?2, revoked_by_user_id = ?3, updated_at = ?2
WHERE device_id = ?1 AND status = 'active'
"#;

const DELETE_DEVICE_TOKENS_SQL: &str = r#"
DELETE FROM device_tokens WHERE device_id = ?1
"#;

const DEVICE_TOKEN_BY_HASH_SQL: &str = r#"
SELECT token_hash, device_id, expires_at, created_at
FROM device_tokens
WHERE token_hash = ?1 AND device_id = ?2 AND expires_at > ?3
LIMIT 1
"#;

const UPDATE_DEVICE_HEARTBEAT_SQL: &str = r#"
UPDATE devices
SET last_seen_at = ?2, capabilities = ?3, capability_reported_at = ?4,
    app_version = ?5, updated_at = ?2
WHERE device_id = ?1 AND status = 'active'
"#;

const DEVICE_COUNT_BY_FINGERPRINT_SQL: &str = r#"
SELECT COUNT(*) AS n FROM devices WHERE org_id = ?1 AND key_fingerprint = ?2
"#;

/// Statement input for a new pending enrollment.
pub struct DeviceEnrollmentInput<'a> {
    pub enrollment_id: &'a str,
    pub org_id: &'a str,
    pub code_hash: &'a str,
    pub public_key: &'a str,
    pub key_fingerprint: &'a str,
    pub device_name: &'a str,
    pub platform: &'a str,
    pub app_version: &'a str,
    pub challenge: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub device_id: String,
    pub org_id: String,
    pub enrolled_by_user_id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
    pub public_key: String,
    pub key_fingerprint: String,
    pub status: String,
    pub capabilities: Option<String>,
    pub capability_reported_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
    pub revoked_by_user_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// P09-SEC-02: `DeviceRecord` keeps its derived `Debug` because everything in it
// is public by construction — a device's Ed25519 public key and the fingerprint
// of that public key are identifiers a human needs, and `device_json` already
// returns the non-secret half. The two records below it hold the values that are
// not: the enrollment `code_hash` and the released proof `challenge` are what a
// pending enrollment is gated on, and `token_hash` is the lookup index for a
// bearer device token. Each therefore gets a hand-written `Debug`.

/// An enrollment in flight. `code_hash` gates who may approve the enrollment and
/// `challenge` is the proof released only after approval, so both are excluded.
/// `finish_non_exhaustive` means a new column cannot start printing silently.
#[derive(Clone, Serialize, Deserialize)]
pub struct DeviceEnrollmentRecord {
    pub enrollment_id: String,
    pub org_id: String,
    pub code_hash: String,
    pub public_key: String,
    pub key_fingerprint: String,
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    pub status: String,
    pub challenge: Option<String>,
    pub device_id: Option<String>,
    pub approved_by_user_id: Option<String>,
    pub expires_at: String,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for DeviceEnrollmentRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceEnrollmentRecord")
            .field("enrollment_id", &self.enrollment_id)
            .field("org_id", &self.org_id)
            .field("code_hash", &"[redacted]")
            .field("public_key", &self.public_key)
            .field("key_fingerprint", &self.key_fingerprint)
            .field("device_name", &self.device_name)
            .field("platform", &self.platform)
            .field("app_version", &self.app_version)
            .field("status", &self.status)
            .field("challenge", &self.challenge.as_ref().map(|_| "[redacted]"))
            .field("device_id", &self.device_id)
            .field("approved_by_user_id", &self.approved_by_user_id)
            .field("expires_at", &self.expires_at)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish_non_exhaustive()
    }
}

/// The stored form of a device bearer token. Only the hash is persisted, and the
/// hash is the lookup index: printing it tells a reader which token was in play
/// and gives an offline attacker the whole row to work from, exactly as
/// `api_keys.secret_hash` does. Redacted for the same reason.
#[derive(Clone, Serialize, Deserialize)]
pub struct DeviceTokenRecord {
    pub token_hash: String,
    pub device_id: String,
    pub expires_at: String,
    pub created_at: String,
}

impl std::fmt::Debug for DeviceTokenRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceTokenRecord")
            .field("token_hash", &"[redacted]")
            .field("device_id", &self.device_id)
            .field("expires_at", &self.expires_at)
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

pub struct DeviceRepository<'a> {
    database: &'a D1Adapter,
}

impl<'a> DeviceRepository<'a> {
    pub fn new(database: &'a D1Adapter) -> Self {
        Self { database }
    }

    pub fn insert_enrollment_statement(
        &self,
        enrollment: &DeviceEnrollmentInput<'_>,
        expires_at: &str,
        now: &Timestamp,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            INSERT_ENROLLMENT_SQL,
            &[
                BindValue::Text(enrollment.enrollment_id),
                BindValue::Text(enrollment.org_id),
                BindValue::Text(enrollment.code_hash),
                BindValue::Text(enrollment.public_key),
                BindValue::Text(enrollment.key_fingerprint),
                BindValue::Text(enrollment.device_name),
                BindValue::Text(enrollment.platform),
                BindValue::Text(enrollment.app_version),
                BindValue::Text(enrollment.challenge),
                BindValue::Text(expires_at),
                BindValue::Text(now.as_str()),
            ],
        )
    }

    pub async fn find_enrollment(
        &self,
        enrollment_id: &str,
    ) -> worker::Result<Option<DeviceEnrollmentRecord>> {
        let statement = self
            .database
            .prepare(ENROLLMENT_BY_ID_SQL, &[BindValue::Text(enrollment_id)])?;
        statement.first::<DeviceEnrollmentRecord>(None).await
    }

    pub async fn expire_enrollment(
        &self,
        enrollment_id: &str,
        now: &Timestamp,
    ) -> worker::Result<()> {
        let statement = self.database.prepare(
            EXPIRE_ENROLLMENT_SQL,
            &[
                BindValue::Text(enrollment_id),
                BindValue::Text(now.as_str()),
            ],
        )?;
        statement.run().await?;
        Ok(())
    }

    /// The denial as a PREPARED statement, so it can commit in the same batch as the audit event.
    ///
    /// V01-041. `deny_enrollment` below used to be the only form, and it executed immediately — which is
    /// why the route could not exist as written: a denial and the `security_events` row recording it
    /// have to commit together, or a crash between them leaves a reviewer having refused access with no
    /// record that they did. Every other mutation on this repository has a `*_statement` form for
    /// exactly that reason.
    ///
    /// The SQL and the bind list live here and nowhere else. `deny_enrollment` is now implemented in
    /// terms of this, so the two cannot drift — two ways to write the same row is the hazard, not the
    /// convenience.
    pub fn deny_enrollment_statement(
        &self,
        enrollment_id: &str,
        org_id: &str,
        now: &Timestamp,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            DENY_ENROLLMENT_SQL,
            &[
                BindValue::Text(enrollment_id),
                BindValue::Text(org_id),
                BindValue::Text(now.as_str()),
            ],
        )
    }

    /// Deny a pending enrollment and report whether a row changed.
    ///
    /// Prefer [`Self::deny_enrollment_statement`] wherever the denial should be batched with an audit
    /// event; this exists for a caller that genuinely wants the write on its own.
    pub async fn deny_enrollment(
        &self,
        enrollment_id: &str,
        org_id: &str,
        now: &Timestamp,
    ) -> worker::Result<bool> {
        let result = self
            .deny_enrollment_statement(enrollment_id, org_id, now)?
            .run()
            .await?;
        Ok(D1Adapter::changes(&result)? > 0)
    }

    /// Approve a pending enrollment: record the approver (releasing the
    /// proof challenge) and insert the managed device row in one batch. The
    /// device proves possession separately at the complete endpoint.
    pub fn approve_enrollment_statements(
        &self,
        enrollment: &DeviceEnrollmentRecord,
        device_id: &str,
        approved_by_user_id: &str,
        now: &Timestamp,
    ) -> worker::Result<Vec<D1PreparedStatement>> {
        let approve = self.database.prepare(
            APPROVE_ENROLLMENT_SQL,
            &[
                BindValue::Text(&enrollment.enrollment_id),
                BindValue::Text(&enrollment.org_id),
                BindValue::Text(approved_by_user_id),
                BindValue::Text(device_id),
                BindValue::Text(now.as_str()),
            ],
        )?;
        let insert_device = self.database.prepare(
            INSERT_DEVICE_SQL,
            &[
                BindValue::Text(device_id),
                BindValue::Text(&enrollment.org_id),
                BindValue::Text(approved_by_user_id),
                BindValue::Text(&enrollment.device_name),
                BindValue::Text(&enrollment.platform),
                BindValue::Text(&enrollment.app_version),
                BindValue::Text(&enrollment.public_key),
                BindValue::Text(&enrollment.key_fingerprint),
                BindValue::Text(now.as_str()),
            ],
        )?;
        // Insert the device first: SQLite foreign keys are immediate, so the
        // enrollment's device_id reference needs its row to exist up front.
        Ok(vec![insert_device, approve])
    }

    /// Complete an approved enrollment after proof verification: close the
    /// enrollment and store the first device token in one batch.
    pub fn complete_enrollment_statements(
        &self,
        enrollment_id: &str,
        device_id: &str,
        token_hash: &str,
        token_expires_at: &str,
        now: &Timestamp,
    ) -> worker::Result<Vec<D1PreparedStatement>> {
        let close = self.database.prepare(
            COMPLETE_ENROLLMENT_SQL,
            &[
                BindValue::Text(enrollment_id),
                BindValue::Text(device_id),
                BindValue::Text(now.as_str()),
            ],
        )?;
        let insert_token = self.database.prepare(
            INSERT_DEVICE_TOKEN_SQL,
            &[
                BindValue::Text(token_hash),
                BindValue::Text(device_id),
                BindValue::Text(token_expires_at),
                BindValue::Text(now.as_str()),
            ],
        )?;
        Ok(vec![close, insert_token])
    }

    /// Atomically complete an approved enrollment: insert the managed device,
    /// close the enrollment, and store the first device token in one batch.
    pub async fn complete_enrollment(
        &self,
        enrollment: &DeviceEnrollmentRecord,
        device_id: &str,
        approved_by_user_id: &str,
        token_hash: &str,
        token_expires_at: &str,
        now: &Timestamp,
    ) -> worker::Result<Option<DeviceRecord>> {
        let now_text = now.as_str();
        let insert_device = self.database.prepare(
            INSERT_DEVICE_SQL,
            &[
                BindValue::Text(device_id),
                BindValue::Text(&enrollment.org_id),
                BindValue::Text(approved_by_user_id),
                BindValue::Text(&enrollment.device_name),
                BindValue::Text(&enrollment.platform),
                BindValue::Text(&enrollment.app_version),
                BindValue::Text(&enrollment.public_key),
                BindValue::Text(&enrollment.key_fingerprint),
                BindValue::Text(now_text),
            ],
        )?;
        let close_enrollment = self.database.prepare(
            COMPLETE_ENROLLMENT_SQL,
            &[
                BindValue::Text(&enrollment.enrollment_id),
                BindValue::Text(device_id),
                BindValue::Text(now_text),
            ],
        )?;
        let insert_token = self.database.prepare(
            INSERT_DEVICE_TOKEN_SQL,
            &[
                BindValue::Text(token_hash),
                BindValue::Text(device_id),
                BindValue::Text(token_expires_at),
                BindValue::Text(now_text),
            ],
        )?;
        let results = self
            .database
            .batch(vec![insert_device, close_enrollment, insert_token])
            .await?;
        if !results.iter().all(|result| result.success()) {
            return Ok(None);
        }
        self.find_device(device_id).await
    }

    pub async fn find_device(&self, device_id: &str) -> worker::Result<Option<DeviceRecord>> {
        let statement = self
            .database
            .prepare(DEVICE_BY_ID_SQL, &[BindValue::Text(device_id)])?;
        statement.first::<DeviceRecord>(None).await
    }

    pub async fn device_fingerprint_count(
        &self,
        org_id: &str,
        key_fingerprint: &str,
    ) -> worker::Result<u32> {
        let statement = self.database.prepare(
            DEVICE_COUNT_BY_FINGERPRINT_SQL,
            &[BindValue::Text(org_id), BindValue::Text(key_fingerprint)],
        )?;
        let row = statement
            .first::<serde_json::Value>(None)
            .await?
            .ok_or_else(|| worker::Error::RustError("fingerprint count missing".into()))?;
        Ok(row
            .get("n")
            .and_then(|value| value.as_u64())
            .unwrap_or_default() as u32)
    }

    /// Keyset page ordered by `(created_at, device_id)` descending. `cursor`
    /// carries the encoded last-seen key of the previous page; `None` returns
    /// the first page.
    pub async fn list_devices_by_org(
        &self,
        org_id: &str,
        cursor: Option<(&str, &str)>,
        limit: i32,
    ) -> worker::Result<Vec<DeviceRecord>> {
        let statement = match cursor {
            Some((created_at, device_id)) => self.database.prepare(
                DEVICES_BY_ORG_SQL,
                &[
                    BindValue::Text(org_id),
                    BindValue::Text(created_at),
                    BindValue::Text(device_id),
                    BindValue::Integer(limit),
                ],
            )?,
            None => self.database.prepare(
                FIRST_DEVICES_PAGE_SQL,
                &[BindValue::Text(org_id), BindValue::Integer(limit)],
            )?,
        };
        statement.all().await?.results::<DeviceRecord>()
    }

    /// Revoke a device and invalidate every outstanding token atomically.
    /// Returns `false` when the device was already revoked or is missing.
    /// The two statements a revocation is, as PREPARED statements.
    ///
    /// Split out from `revoke_device` so the route can compose them into a larger transaction
    /// instead of running its own. `revoke_device` below is now a thin wrapper over these, so
    /// there is exactly one place that decides what a revocation writes and in which order —
    /// which matters because the second statement is what makes revocation *effective*: the
    /// device-token lookup does not join `devices`, so deleting the rows is the only thing that
    /// stops a revoked device authenticating (V01-016, V01-019).
    pub fn revoke_device_statements(
        &self,
        device_id: &str,
        revoked_by_user_id: &str,
        now: &Timestamp,
    ) -> worker::Result<Vec<D1PreparedStatement>> {
        let revoke = self.database.prepare(
            REVOKE_DEVICE_SQL,
            &[
                BindValue::Text(device_id),
                BindValue::Text(now.as_str()),
                BindValue::Text(revoked_by_user_id),
            ],
        )?;
        let drop_tokens = self
            .database
            .prepare(DELETE_DEVICE_TOKENS_SQL, &[BindValue::Text(device_id)])?;
        Ok(vec![revoke, drop_tokens])
    }

    pub async fn revoke_device(
        &self,
        device_id: &str,
        revoked_by_user_id: &str,
        now: &Timestamp,
    ) -> worker::Result<bool> {
        // `results[0]` is the revoke itself and `results[1]` the token deletion, in that order,
        // so `changes(&results[0])` answers "did this revoke a device that was still active".
        let statements = self.revoke_device_statements(device_id, revoked_by_user_id, now)?;
        let results = self.database.batch(statements).await?;
        if !results.iter().all(|result| result.success()) {
            return Ok(false);
        }
        Ok(D1Adapter::changes(&results[0])? > 0)
    }

    pub async fn insert_device_token(
        &self,
        token_hash: &str,
        device_id: &str,
        expires_at: &str,
        now: &Timestamp,
    ) -> worker::Result<()> {
        let statement = self.database.prepare(
            INSERT_DEVICE_TOKEN_SQL,
            &[
                BindValue::Text(token_hash),
                BindValue::Text(device_id),
                BindValue::Text(expires_at),
                BindValue::Text(now.as_str()),
            ],
        )?;
        statement.run().await?;
        Ok(())
    }

    pub async fn find_live_device_token(
        &self,
        token_hash: &str,
        device_id: &str,
        now: &Timestamp,
    ) -> worker::Result<Option<DeviceTokenRecord>> {
        let statement = self.database.prepare(
            DEVICE_TOKEN_BY_HASH_SQL,
            &[
                BindValue::Text(token_hash),
                BindValue::Text(device_id),
                BindValue::Text(now.as_str()),
            ],
        )?;
        statement.first::<DeviceTokenRecord>(None).await
    }

    pub async fn update_heartbeat(
        &self,
        device_id: &str,
        now: &Timestamp,
        capabilities: Option<&str>,
        app_version: &str,
    ) -> worker::Result<bool> {
        let capability_value = capabilities.map(BindValue::Text).unwrap_or(BindValue::Null);
        let statement = self.database.prepare(
            UPDATE_DEVICE_HEARTBEAT_SQL,
            &[
                BindValue::Text(device_id),
                BindValue::Text(now.as_str()),
                capability_value,
                BindValue::Text(now.as_str()),
                BindValue::Text(app_version),
            ],
        )?;
        let result = statement.run().await?;
        Ok(D1Adapter::changes(&result)? > 0)
    }

    /// The organization's device-policy row, `None` when no floor has ever
    /// been armed. The columns beyond `org_id` exist only after migration
    /// 0024, which also introduced `version`.
    pub async fn find_device_policy(
        &self,
        org_id: &str,
    ) -> worker::Result<Option<DevicePolicyRecord>> {
        let statement = self
            .database
            .prepare(FIND_DEVICE_POLICY_SQL, &[BindValue::Text(org_id)])?;
        statement.first::<DevicePolicyRecord>(None).await
    }

    /// Arm (or clear, with `None`) the organization's minimum client version,
    /// guarded by the row's optimistic `version`. The upsert computes the new
    /// version as `?3 + 1` on both paths — the caller passes the row's current
    /// version, or 0 when creating — and the `WHERE` on the conflict arm makes
    /// a stale concurrent write match zero rows. A zero-row conflict update
    /// does not abort a D1 batch by itself (the V01-042 shape), so the caller
    /// pairs this statement with `assert_device_policy_version_statement` and
    /// grades the stored `changes()`.
    pub fn upsert_device_policy_statement(
        &self,
        org_id: &str,
        min_client_version: Option<&str>,
        expected_version: i64,
        now: &Timestamp,
    ) -> worker::Result<D1PreparedStatement> {
        let version_bind = match min_client_version {
            Some(value) => BindValue::Text(value),
            // Clearing the floor stores NULL, which the read maps to "no floor".
            None => BindValue::Null,
        };
        self.database.prepare(
            UPSERT_DEVICE_POLICY_SQL,
            &[
                BindValue::Text(org_id),
                version_bind,
                BindValue::Integer(expected_version as i32),
                BindValue::Text(now.as_str()),
            ],
        )
    }

    /// Guard sentinel: aborts the batch when the stored row's version is not
    /// the one the caller based its write on. Same shape as the org policy
    /// guard in `repositories/ai.rs` — a no-op INSERT whose NULLs violate the
    /// idempotency ledger's own constraints exactly when the guard fails.
    pub fn assert_device_policy_version_statement(
        &self,
        org_id: &str,
        expected_version: i64,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            ASSERT_DEVICE_POLICY_VERSION_SQL,
            &[
                BindValue::Text(org_id),
                BindValue::Integer(expected_version as i32),
            ],
        )
    }

    /// Guard sentinel for the create path: aborts the batch when a row
    /// already exists, so two concurrent "first" writes cannot both claim
    /// version 1.
    pub fn assert_device_policy_absent_statement(
        &self,
        org_id: &str,
    ) -> worker::Result<D1PreparedStatement> {
        self.database
            .prepare(ASSERT_DEVICE_POLICY_ABSENT_SQL, &[BindValue::Text(org_id)])
    }
}
