//! P08 adoption persistence: SQL and row mapping only.
//!
//! The tables are `client_compatibility_policies`, `workspace_adoption_states`,
//! `adoption_stage_events`, and `adoption_remediations`, added by
//! `0019_p08_migration_adoption.sql`. Every decision this layer's callers need —
//! whether a client is compatible, whether a stage may advance, which
//! remediations are open, whether an automation may be imported — is made by
//! `modules::migration`, never here. What lives here is the query, the row, and
//! the guard that makes a concurrent second writer lose.
//!
//! Two properties are structural in this layer rather than in a review note:
//!
//! * Every write that changes adoption state is a single D1 batch whose first
//!   statement asserts the caller's `version` and current `stage`. A stale client
//!   that resumes a wizard from a cached screen therefore cannot overwrite a
//!   newer decision, and the batch aborts instead of silently winning.
//! * No `SELECT` here projects a column that could hold local content, because
//!   the schema has no such column. The adoption tables are safe to export
//!   `metadata_only` and to read in full by an operator.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use worker::d1::D1PreparedStatement;

use crate::{
    adapters::d1::{BindValue, D1Adapter},
    modules::migration::{
        AdoptionStage, CompatibilityPolicy, CredentialMode, Ownership, RemediationCode, Remedy,
    },
};

/// Bounded page sizes. The adoption list is small by nature — one row per
/// workspace an organization has adopted — so a hard ceiling is enough and no
/// cursor is needed for it.
pub const MAX_ADOPTION_PAGE_SIZE: usize = 100;
pub const MAX_REMEDIATION_PAGE_SIZE: usize = 100;

/// The newest compatibility policy, or `None` when none is stored.
///
/// Falling back to the compiled-in baseline is the caller's decision, not this
/// one's: a control plane that cannot read its own policy row must still answer
/// a local client, because refusing to answer would push an existing local user
/// off the managed path entirely.
pub const SELECT_COMPATIBILITY_SQL: &str = "SELECT sequence, protocol_major, min_protocol_major, \
     max_protocol_major, min_policy_schema_version, max_policy_schema_version, \
     local_only_eligible, history_sync_eligible \
     FROM client_compatibility_policies ORDER BY sequence DESC LIMIT 1";

const SELECT_ADOPTION_SQL: &str = "SELECT adoption_state_id, org_id, external_installation_id, \
     external_workspace_key, display_name, bound_project_id, bound_device_id, stage, ownership, \
     credential_mode, rolled_back_from_stage, client_protocol_major, policy_schema_version, \
     client_app_version, reversion_count, version, created_at, updated_at \
     FROM workspace_adoption_states \
     WHERE adoption_state_id = ?1 AND org_id = ?2";

const SELECT_ADOPTION_BY_EXTERNAL_SQL: &str = "SELECT adoption_state_id, org_id, \
     external_installation_id, external_workspace_key, display_name, bound_project_id, \
     bound_device_id, stage, ownership, credential_mode, rolled_back_from_stage, \
     client_protocol_major, policy_schema_version, client_app_version, reversion_count, version, \
     created_at, updated_at FROM workspace_adoption_states \
     WHERE org_id = ?1 AND external_installation_id = ?2 AND external_workspace_key = ?3";

const SELECT_ADOPTION_PAGE_SQL: &str = "SELECT adoption_state_id, org_id, \
     external_installation_id, external_workspace_key, display_name, bound_project_id, \
     bound_device_id, stage, ownership, credential_mode, rolled_back_from_stage, \
     client_protocol_major, policy_schema_version, client_app_version, reversion_count, version, \
     created_at, updated_at FROM workspace_adoption_states WHERE org_id = ?1 \
     ORDER BY created_at DESC, adoption_state_id DESC LIMIT ?2";

const SELECT_STAGE_COUNTS_SQL: &str = "SELECT stage, COUNT(*) AS total FROM \
     workspace_adoption_states WHERE org_id = ?1 GROUP BY stage";

const INSERT_ADOPTION_SQL: &str = "INSERT INTO workspace_adoption_states (adoption_state_id, \
     org_id, external_installation_id, external_workspace_key, display_name, bound_project_id, \
     bound_device_id, stage, ownership, credential_mode, rolled_back_from_stage, \
     client_protocol_major, policy_schema_version, client_app_version, reversion_count, version, \
     created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13, \
     0, 1, ?14, ?15)";

const UPDATE_ADOPTION_STAGE_SQL: &str = "UPDATE workspace_adoption_states SET stage = ?1, \
     ownership = ?2, credential_mode = ?3, bound_project_id = ?4, bound_device_id = ?5, \
     client_protocol_major = ?6, policy_schema_version = ?7, client_app_version = ?8, \
     version = version + 1, updated_at = ?9 \
     WHERE adoption_state_id = ?10 AND org_id = ?11 AND version = ?12";

const UPDATE_ADOPTION_ROLLBACK_SQL: &str = "UPDATE workspace_adoption_states SET \
     stage = 'local_unmanaged', ownership = 'local_unmanaged', \
     credential_mode = 'local_credential', rolled_back_from_stage = ?1, \
     bound_project_id = NULL, bound_device_id = NULL, \
     reversion_count = reversion_count + 1, version = version + 1, updated_at = ?2 \
     WHERE adoption_state_id = ?3 AND org_id = ?4 AND version = ?5";

/// A concurrent-writer guard that violates a `NOT NULL` constraint on purpose
/// when its `WHERE NOT EXISTS` predicate does not hold, aborting the surrounding
/// D1 batch. This is the same trick P05 and P06 use for a compare-and-set: a
/// stale `version` therefore rolls the whole batch back rather than letting a
/// later statement commit a decision made against a state the caller never saw.
const GUARD_SQL: &str = "INSERT INTO idempotency_records (principal_id, organization_id, method, \
     path, key_digest, request_fingerprint, state, response_status, response_body, expires_at, \
     claim_token) SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL \
     WHERE NOT EXISTS (SELECT 1 FROM workspace_adoption_states \
     WHERE adoption_state_id = ?1 AND org_id = ?2 AND version = ?3)";

pub fn assert_version_statement(
    database: &D1Adapter,
    adoption_state_id: &str,
    org_id: &str,
    expected_version: i64,
) -> worker::Result<D1PreparedStatement> {
    database.prepare(
        GUARD_SQL,
        &[
            BindValue::Text(adoption_state_id),
            BindValue::Text(org_id),
            BindValue::Int64(expected_version),
        ],
    )
}

const INSERT_EVENT_SQL: &str = "INSERT INTO adoption_stage_events (adoption_event_id, org_id, \
     adoption_state_id, device_id, actor_user_id, stage, result, reason_code, \
     client_protocol_major, policy_schema_version, client_app_version, occurred_at, created_at) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)";

const SELECT_EVENTS_SQL: &str = "SELECT stage, result, COUNT(*) AS total FROM \
     adoption_stage_events WHERE org_id = ?1 GROUP BY stage, result";

const SELECT_REMEDIATIONS_SQL: &str = "SELECT remediation_id, adoption_state_id, device_id, code, \
     stage, state, remedy, resolved_by_user_id, resolved_at, version, created_at, updated_at \
     FROM adoption_remediations WHERE org_id = ?1 \
     ORDER BY (state = 'open') DESC, created_at DESC, remediation_id DESC LIMIT ?2";

const INSERT_REMEDIATION_SQL: &str = "INSERT INTO adoption_remediations (remediation_id, org_id, \
     adoption_state_id, device_id, code, stage, state, remedy, resolved_by_user_id, resolved_at, \
     version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, NULL, NULL, 1, \
     ?8, ?8)";

const RESOLVE_REMEDIATION_SQL: &str = "UPDATE adoption_remediations SET state = 'resolved', \
     resolved_by_user_id = ?1, resolved_at = ?2, version = version + 1, updated_at = ?2 \
     WHERE remediation_id = ?3 AND org_id = ?4 AND state = 'open' AND version = ?5";

const GUARD_REMEDIATION_OPEN_SQL: &str = "INSERT INTO idempotency_records (principal_id, organization_id, method, path, key_digest, \
     request_fingerprint, state, response_status, response_body, expires_at, claim_token) \
     SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL \
     WHERE NOT EXISTS (SELECT 1 FROM adoption_remediations \
     WHERE remediation_id = ?1 AND org_id = ?2 AND state = 'open' AND version = ?3)";

/// The organization facts an automation-import preview is judged against.
///
/// Read here rather than in P06's repository because the query is a read-only
/// projection over P06 tables that exists only to answer P08's preview. P06 keeps
/// owning automation creation, dispatch, and its own entitlement evaluator; this
/// is a narrow slice of it, and it fails closed: a license state that is not
/// `active` or `grace` reports no automation capability at all.
const SELECT_AUTOMATION_COUNT_SQL: &str = "SELECT COUNT(*) AS total FROM automation_definitions \
     WHERE org_id = ?1 AND status = 'active'";

const SELECT_LICENSE_STATE_SQL: &str = "SELECT state FROM license_states WHERE org_id = ?1";

const SELECT_BOOLEAN_GRANT_SQL: &str = "SELECT value_json FROM entitlement_grants \
     WHERE org_id = ?1 AND entitlement_key = ?2 AND scope = 'organization' \
     AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?3) \
     ORDER BY effective_at DESC LIMIT 1";

const SELECT_COUNT_GRANT_SQL: &str = "SELECT value_json FROM entitlement_grants \
     WHERE org_id = ?1 AND entitlement_key = ?2 AND scope = 'organization' \
     AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?3) \
     ORDER BY effective_at DESC LIMIT 1";

/// The organization tool policy's allow-list, read for the import preview only.
///
/// P05 keeps ownership of `tool_policies` and of the default-deny evaluation at
/// dispatch. P08 reads the published organization-scope document so the preview
/// can name a conflict *before* the user imports, which is what FR-F26-004
/// requires. An organization with no published document has no organization-level
/// restriction to apply.
const SELECT_ORG_TOOL_POLICY_SQL: &str = "SELECT document_json FROM tool_policies \
     WHERE org_id = ?1 AND project_id IS NULL ORDER BY policy_version DESC LIMIT 1";

#[derive(Debug, Deserialize)]
struct ToolPolicyDocumentRow {
    document_json: String,
}

#[derive(Debug, Deserialize)]
struct CountRow {
    total: i64,
}

#[derive(Debug, Deserialize)]
struct StateRow {
    state: String,
}

#[derive(Debug, Deserialize)]
struct GrantRow {
    value_json: String,
}

/// Read-only facts about whether an organization may import automations, and with
/// which capabilities.
#[derive(Clone, Debug)]
pub struct AutomationImportLimits {
    pub automations_available: bool,
    pub max_active_automations: i64,
    pub active_automations: i64,
    pub off_peak_available: bool,
    /// The org's BYOK posture. F26-004: a workspace running on its own local key
    /// may only import automations when the org still permits the org to carry
    /// someone else's credential.
    pub local_credential_permitted: bool,
}

// ------------------------------------------------------------------ rows ----

#[derive(Debug, Deserialize)]
struct CompatibilityRow {
    sequence: i64,
    protocol_major: i64,
    min_protocol_major: i64,
    max_protocol_major: i64,
    min_policy_schema_version: i64,
    max_policy_schema_version: i64,
    local_only_eligible: i64,
    history_sync_eligible: i64,
}

/// One row of `client_compatibility_policies`, mapped into the domain type.
///
#[derive(Debug, Deserialize)]
struct AdoptionRow {
    adoption_state_id: String,
    org_id: String,
    external_installation_id: String,
    external_workspace_key: String,
    display_name: String,
    bound_project_id: Option<String>,
    bound_device_id: Option<String>,
    stage: String,
    ownership: String,
    credential_mode: String,
    rolled_back_from_stage: Option<String>,
    client_protocol_major: i64,
    policy_schema_version: i64,
    client_app_version: String,
    reversion_count: i64,
    version: i64,
    created_at: String,
    updated_at: String,
}

/// One adopted (or deliberately local) workspace, as the web console and the
/// adoption summary read it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdoptionStateRecord {
    pub adoption_state_id: String,
    pub org_id: String,
    pub external_installation_id: String,
    pub external_workspace_key: String,
    pub display_name: String,
    pub bound_project_id: Option<String>,
    pub bound_device_id: Option<String>,
    pub stage: String,
    pub ownership: String,
    pub credential_mode: String,
    pub rolled_back_from_stage: Option<String>,
    pub client_protocol_major: i64,
    pub policy_schema_version: i64,
    pub client_app_version: String,
    pub reversion_count: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl AdoptionStateRecord {
    /// Whether this workspace has any cloud state at all. Remediation and the
    /// adoption summary both key off this, so it lives in one place rather than
    /// being re-derived by each caller.
    pub fn is_adopted(&self) -> bool {
        self.stage != AdoptionStage::LocalUnmanaged.as_str()
            || self.ownership == Ownership::OrgManaged.as_str()
    }

    pub fn is_managed(&self) -> bool {
        self.ownership == Ownership::OrgManaged.as_str()
    }

    pub fn credential_mode(&self) -> Option<CredentialMode> {
        CredentialMode::parse(&self.credential_mode)
    }

    /// The last stage this workspace was rolled back from, if any. Surfaced so a
    /// console can say "unbound from managed policy" instead of implying the
    /// workspace was never adopted.
    pub fn rolled_back_from(&self) -> Option<AdoptionStage> {
        self.rolled_back_from_stage
            .as_deref()
            .and_then(AdoptionStage::parse)
    }
}

#[derive(Debug, Deserialize)]
struct StageCountRow {
    stage: String,
    total: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct EventCountRow {
    stage: String,
    result: String,
    total: i64,
}

#[derive(Debug, Deserialize)]
struct RemediationRow {
    remediation_id: String,
    adoption_state_id: Option<String>,
    device_id: Option<String>,
    code: String,
    stage: String,
    state: String,
    remedy: String,
    resolved_by_user_id: Option<String>,
    resolved_at: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
}

/// One remediation row. `code` and `remedy` are kept as the stored strings plus
/// their parsed forms so a row written by a future version with a code this build
/// does not know still renders as data instead of failing the whole list.
#[derive(Clone, Debug, Serialize)]
pub struct RemediationRecord {
    pub remediation_id: String,
    pub adoption_state_id: Option<String>,
    pub device_id: Option<String>,
    pub code: String,
    pub remedy: String,
    pub stage: String,
    pub state: String,
    pub resolved_by_user_id: Option<String>,
    pub resolved_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl RemediationRecord {
    pub fn is_open(&self) -> bool {
        self.state == "open"
    }

    pub fn parsed_code(&self) -> Option<RemediationCode> {
        RemediationCode::parse(&self.code)
    }

    pub fn parsed_remedy(&self) -> Option<Remedy> {
        Remedy::parse(&self.remedy)
    }
}

/// Statement inputs. `New*Input` keeps values borrowed and typed at the edge so
/// the SQL above has no string interpolation and no free-form text parameter.
pub struct NewAdoptionStateInput<'a> {
    pub adoption_state_id: &'a str,
    pub org_id: &'a str,
    pub external_installation_id: &'a str,
    pub external_workspace_key: &'a str,
    pub display_name: &'a str,
    pub bound_project_id: Option<&'a str>,
    pub bound_device_id: Option<&'a str>,
    pub stage: &'a str,
    pub ownership: &'a str,
    pub credential_mode: &'a str,
    pub client_protocol_major: i64,
    pub policy_schema_version: i64,
    pub client_app_version: &'a str,
    pub now: &'a str,
}

pub struct AdvanceStageInput<'a> {
    pub adoption_state_id: &'a str,
    pub org_id: &'a str,
    pub stage: &'a str,
    pub ownership: &'a str,
    pub credential_mode: &'a str,
    pub bound_project_id: Option<&'a str>,
    pub bound_device_id: Option<&'a str>,
    pub client_protocol_major: i64,
    pub policy_schema_version: i64,
    pub client_app_version: &'a str,
    pub now: &'a str,
    /// The version the caller read. The statement is a compare-and-set, and the
    /// batch's guard statement asserts the same value, so a stale writer loses.
    pub expected_version: i64,
}

pub struct RollbackInput<'a> {
    pub adoption_state_id: &'a str,
    pub org_id: &'a str,
    pub from_stage: &'a str,
    pub now: &'a str,
    pub expected_version: i64,
}

pub struct NewStageEventInput<'a> {
    pub adoption_event_id: &'a str,
    pub org_id: &'a str,
    pub adoption_state_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub actor_user_id: Option<&'a str>,
    pub stage: &'a str,
    pub result: &'a str,
    pub reason_code: Option<&'a str>,
    pub client_protocol_major: Option<i64>,
    pub policy_schema_version: Option<i64>,
    pub client_app_version: Option<&'a str>,
    pub now: &'a str,
}

pub struct NewRemediationInput<'a> {
    pub remediation_id: &'a str,
    pub org_id: &'a str,
    pub adoption_state_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub code: &'a str,
    pub stage: &'a str,
    pub remedy: &'a str,
    pub now: &'a str,
}

pub struct ResolveRemediationInput<'a> {
    pub remediation_id: &'a str,
    pub org_id: &'a str,
    pub resolved_by_user_id: &'a str,
    pub expected_version: i64,
    pub now: &'a str,
}

pub struct AdoptionRepository<'a> {
    database: &'a D1Adapter,
}

impl<'a> AdoptionRepository<'a> {
    pub const fn new(database: &'a D1Adapter) -> Self {
        Self { database }
    }

    /// The newest compatibility policy, or `None` when storage has no row.
    pub async fn find_compatibility_policy(&self) -> worker::Result<Option<CompatibilityPolicy>> {
        let row = self
            .database
            .prepare(SELECT_COMPATIBILITY_SQL, &[])?
            .first::<CompatibilityRow>(None)
            .await?;
        Ok(row.map(|row| CompatibilityPolicy {
            sequence: row.sequence,
            protocol_major: row.protocol_major,
            min_protocol_major: row.min_protocol_major,
            max_protocol_major: row.max_protocol_major,
            min_policy_schema_version: row.min_policy_schema_version,
            max_policy_schema_version: row.max_policy_schema_version,
            local_only_eligible: row.local_only_eligible != 0,
            history_sync_eligible: row.history_sync_eligible != 0,
        }))
    }

    pub async fn find_by_id(
        &self,
        adoption_state_id: &str,
        org_id: &str,
    ) -> worker::Result<Option<AdoptionStateRecord>> {
        let row = self
            .database
            .prepare(
                SELECT_ADOPTION_SQL,
                &[BindValue::Text(adoption_state_id), BindValue::Text(org_id)],
            )?
            .first::<AdoptionRow>(None)
            .await?;
        Ok(row.map(map_adoption))
    }

    /// Look a workspace up by the client's own opaque reference. This is how a
    /// resumed enrollment wizard recognises a workspace it already adopted
    /// instead of creating a second record for it (FR-F26-001).
    pub async fn find_by_external_reference(
        &self,
        org_id: &str,
        installation_id: &str,
        workspace_key: &str,
    ) -> worker::Result<Option<AdoptionStateRecord>> {
        let row = self
            .database
            .prepare(
                SELECT_ADOPTION_BY_EXTERNAL_SQL,
                &[
                    BindValue::Text(org_id),
                    BindValue::Text(installation_id),
                    BindValue::Text(workspace_key),
                ],
            )?
            .first::<AdoptionRow>(None)
            .await?;
        Ok(row.map(map_adoption))
    }

    /// The organization's adoption records, newest first.
    pub async fn list(&self, org_id: &str, limit: i64) -> worker::Result<Vec<AdoptionStateRecord>> {
        let rows = self
            .database
            .prepare(
                SELECT_ADOPTION_PAGE_SQL,
                &[BindValue::Text(org_id), BindValue::Int64(limit)],
            )?
            .all()
            .await?
            .results::<AdoptionRow>()?;
        Ok(rows.into_iter().map(map_adoption).collect())
    }

    /// Stage distribution for the adoption summary. Returned as raw stage strings
    /// so the route can render a stage this build does not know about as data
    /// rather than dropping it from the count.
    pub async fn stage_counts(&self, org_id: &str) -> worker::Result<Vec<(String, i64)>> {
        let rows = self
            .database
            .prepare(SELECT_STAGE_COUNTS_SQL, &[BindValue::Text(org_id)])?
            .all()
            .await?
            .results::<StageCountRow>()?;
        Ok(rows.into_iter().map(|row| (row.stage, row.total)).collect())
    }

    /// Stage/result distribution for the adoption summary.
    pub async fn event_counts(&self, org_id: &str) -> worker::Result<Vec<(String, String, i64)>> {
        let rows = self
            .database
            .prepare(SELECT_EVENTS_SQL, &[BindValue::Text(org_id)])?
            .all()
            .await?
            .results::<EventCountRow>()?;
        Ok(rows
            .into_iter()
            .map(|row| (row.stage, row.result, row.total))
            .collect())
    }

    /// The version guard every adoption mutation leads its batch with.
    pub fn assert_version_statement(
        &self,
        adoption_state_id: &str,
        org_id: &str,
        expected_version: i64,
    ) -> worker::Result<D1PreparedStatement> {
        assert_version_statement(self.database, adoption_state_id, org_id, expected_version)
    }

    pub fn insert_statement(
        &self,
        input: &NewAdoptionStateInput<'_>,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            INSERT_ADOPTION_SQL,
            &[
                BindValue::Text(input.adoption_state_id),
                BindValue::Text(input.org_id),
                BindValue::Text(input.external_installation_id),
                BindValue::Text(input.external_workspace_key),
                BindValue::Text(input.display_name),
                optional(input.bound_project_id),
                optional(input.bound_device_id),
                BindValue::Text(input.stage),
                BindValue::Text(input.ownership),
                BindValue::Text(input.credential_mode),
                BindValue::Int64(input.client_protocol_major),
                BindValue::Int64(input.policy_schema_version),
                BindValue::Text(input.client_app_version),
                BindValue::Text(input.now),
                BindValue::Text(input.now),
            ],
        )
    }

    pub fn advance_statement(
        &self,
        input: &AdvanceStageInput<'_>,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            UPDATE_ADOPTION_STAGE_SQL,
            &[
                BindValue::Text(input.stage),
                BindValue::Text(input.ownership),
                BindValue::Text(input.credential_mode),
                optional(input.bound_project_id),
                optional(input.bound_device_id),
                BindValue::Int64(input.client_protocol_major),
                BindValue::Int64(input.policy_schema_version),
                BindValue::Text(input.client_app_version),
                BindValue::Text(input.now),
                BindValue::Text(input.adoption_state_id),
                BindValue::Text(input.org_id),
                BindValue::Int64(input.expected_version),
            ],
        )
    }

    pub fn rollback_statement(
        &self,
        input: &RollbackInput<'_>,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            UPDATE_ADOPTION_ROLLBACK_SQL,
            &[
                BindValue::Text(input.from_stage),
                BindValue::Text(input.now),
                BindValue::Text(input.adoption_state_id),
                BindValue::Text(input.org_id),
                BindValue::Int64(input.expected_version),
            ],
        )
    }

    pub fn insert_event_statement(
        &self,
        input: &NewStageEventInput<'_>,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            INSERT_EVENT_SQL,
            &[
                BindValue::Text(input.adoption_event_id),
                BindValue::Text(input.org_id),
                optional(input.adoption_state_id),
                optional(input.device_id),
                optional(input.actor_user_id),
                BindValue::Text(input.stage),
                BindValue::Text(input.result),
                optional(input.reason_code),
                optional_int(input.client_protocol_major),
                optional_int(input.policy_schema_version),
                optional(input.client_app_version),
                BindValue::Text(input.now),
                BindValue::Text(input.now),
            ],
        )
    }

    /// Open and resolved remediations, open first.
    pub async fn list_remediations(
        &self,
        org_id: &str,
        limit: i64,
    ) -> worker::Result<Vec<RemediationRecord>> {
        let rows = self
            .database
            .prepare(
                SELECT_REMEDIATIONS_SQL,
                &[BindValue::Text(org_id), BindValue::Int64(limit)],
            )?
            .all()
            .await?
            .results::<RemediationRow>()?;
        Ok(rows
            .into_iter()
            .map(|row| RemediationRecord {
                remediation_id: row.remediation_id,
                adoption_state_id: row.adoption_state_id,
                device_id: row.device_id,
                code: row.code,
                remedy: row.remedy,
                stage: row.stage,
                state: row.state,
                resolved_by_user_id: row.resolved_by_user_id,
                resolved_at: row.resolved_at,
                version: row.version,
                created_at: row.created_at,
                updated_at: row.updated_at,
            })
            .collect())
    }

    /// Re-open prevention lives in a partial unique index, so this insert is safe
    /// to attempt repeatedly: a second open row for the same (state, code) aborts
    /// the batch rather than duplicating the row.
    pub fn insert_remediation_statement(
        &self,
        input: &NewRemediationInput<'_>,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            INSERT_REMEDIATION_SQL,
            &[
                BindValue::Text(input.remediation_id),
                BindValue::Text(input.org_id),
                optional(input.adoption_state_id),
                optional(input.device_id),
                BindValue::Text(input.code),
                BindValue::Text(input.stage),
                BindValue::Text(input.remedy),
                BindValue::Text(input.now),
            ],
        )
    }

    /// The guard for a resolve: the row must still be open at the version the
    /// caller read, so two operators clicking "resolve" cannot both win.
    pub fn assert_remediation_open_statement(
        &self,
        input: &ResolveRemediationInput<'_>,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            GUARD_REMEDIATION_OPEN_SQL,
            &[
                BindValue::Text(input.remediation_id),
                BindValue::Text(input.org_id),
                BindValue::Int64(input.expected_version),
            ],
        )
    }

    pub fn resolve_remediation_statement(
        &self,
        input: &ResolveRemediationInput<'_>,
    ) -> worker::Result<D1PreparedStatement> {
        self.database.prepare(
            RESOLVE_REMEDIATION_SQL,
            &[
                BindValue::Text(input.resolved_by_user_id),
                BindValue::Text(input.now),
                BindValue::Text(input.remediation_id),
                BindValue::Text(input.org_id),
                BindValue::Int64(input.expected_version),
            ],
        )
    }

    /// Read the org facts an automation-import preview is judged against.
    ///
    /// Fails closed on every ambiguity: an unreadable license row, a missing
    /// grant, or an unparsable value yields the restrictive answer, because a
    /// preview that waves an import through because a read failed is worse than
    /// one that blocks it and tells the user to fix the capability.
    pub async fn automation_import_limits(
        &self,
        org_id: &str,
        now: &str,
    ) -> worker::Result<AutomationImportLimits> {
        let active_automations = self
            .database
            .prepare(SELECT_AUTOMATION_COUNT_SQL, &[BindValue::Text(org_id)])?
            .first::<CountRow>(None)
            .await?
            .map_or(0, |row| row.total);
        let license_active = self
            .database
            .prepare(SELECT_LICENSE_STATE_SQL, &[BindValue::Text(org_id)])?
            .first::<StateRow>(None)
            .await?
            .is_some_and(|row| matches!(row.state.as_str(), "active" | "grace"));
        let max_active_automations = self
            .count_grant(org_id, "automations.max_active", now, 5)
            .await?;
        let off_peak = self
            .boolean_grant(org_id, "automations.off_peak_enabled", now, false)
            .await?;
        let byok = self
            .boolean_grant(org_id, "inference.byok", now, false)
            .await?;
        Ok(AutomationImportLimits {
            automations_available: license_active,
            max_active_automations,
            active_automations,
            off_peak_available: off_peak,
            local_credential_permitted: byok,
        })
    }

    /// A grant that is present and explicitly true, or missing. A grant that is
    /// present and false is false; a grant that is unparsable is false.
    async fn boolean_grant(
        &self,
        org_id: &str,
        key: &str,
        now: &str,
        default: bool,
    ) -> worker::Result<bool> {
        let row = self
            .database
            .prepare(
                SELECT_BOOLEAN_GRANT_SQL,
                &[
                    BindValue::Text(org_id),
                    BindValue::Text(key),
                    BindValue::Text(now),
                ],
            )?
            .first::<GrantRow>(None)
            .await?;
        Ok(match row {
            None => default,
            // A grant value that is neither `true` nor `false` is treated as
            // `false`. An entitlement a platform cannot read is not an
            // entitlement it may rely on.
            Some(row) => row.value_json.trim() == "true",
        })
    }

    /// A numeric grant, or `default` when it is absent or unparsable. An absent
    /// `max_active` falls back to the P06 platform default of five so a preview
    /// never assumes an unlimited plan.
    async fn count_grant(
        &self,
        org_id: &str,
        key: &str,
        now: &str,
        default: i64,
    ) -> worker::Result<i64> {
        let row = self
            .database
            .prepare(
                SELECT_COUNT_GRANT_SQL,
                &[
                    BindValue::Text(org_id),
                    BindValue::Text(key),
                    BindValue::Text(now),
                ],
            )?
            .first::<GrantRow>(None)
            .await?;
        Ok(row
            .and_then(|row| row.value_json.trim().parse::<i64>().ok())
            .unwrap_or(default)
            .clamp(0, 1_000_000))
    }

    /// The tools the organization's own tool policy names as allowed.
    ///
    /// An empty set means "this organization has published no organization-scope
    /// allow-list", which the preview reads as *unrestricted at import time* — not
    /// as "no tools allowed", because P05's engine still denies by default when the
    /// automation actually runs. A document that cannot be parsed is treated the
    /// same way, because failing to parse a policy must not invent a restriction
    /// the user cannot see or satisfy.
    pub async fn organization_allowed_tools(
        &self,
        org_id: &str,
    ) -> worker::Result<BTreeSet<String>> {
        let row = self
            .database
            .prepare(SELECT_ORG_TOOL_POLICY_SQL, &[BindValue::Text(org_id)])?
            .first::<ToolPolicyDocumentRow>(None)
            .await?;
        let Some(row) = row else {
            return Ok(BTreeSet::new());
        };
        let Ok(document) = serde_json::from_str::<serde_json::Value>(&row.document_json) else {
            return Ok(BTreeSet::new());
        };
        Ok(document
            .get("allowed_tool_ids")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }
}

fn map_adoption(row: AdoptionRow) -> AdoptionStateRecord {
    AdoptionStateRecord {
        adoption_state_id: row.adoption_state_id,
        org_id: row.org_id,
        external_installation_id: row.external_installation_id,
        external_workspace_key: row.external_workspace_key,
        display_name: row.display_name,
        bound_project_id: row.bound_project_id,
        bound_device_id: row.bound_device_id,
        stage: row.stage,
        ownership: row.ownership,
        credential_mode: row.credential_mode,
        rolled_back_from_stage: row.rolled_back_from_stage,
        client_protocol_major: row.client_protocol_major,
        policy_schema_version: row.policy_schema_version,
        client_app_version: row.client_app_version,
        reversion_count: row.reversion_count,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn optional(value: Option<&str>) -> BindValue<'_> {
    value.map_or(BindValue::Null, BindValue::Text)
}

fn optional_int(value: Option<i64>) -> BindValue<'static> {
    // `Int64` owns its value, so this needs no lifetime.
    match value {
        Some(number) => BindValue::Int64(number),
        None => BindValue::Null,
    }
}
