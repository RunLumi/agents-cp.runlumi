//! P08 migration and adoption HTTP surface.
//!
//! Transport validation, current authorization, and bounded idempotency
//! orchestration. Every decision is already made by `modules::migration` and by
//! `AdoptionRepository`; a handler here computes no stage rule, no compatibility
//! verdict, and no remediation of its own.
//!
//! Rules this module is responsible for:
//!
//! * **`GET /api/v1/compatibility` is unauthenticated.** A local client that has
//!   never signed in has to be able to ask what this control plane supports. This
//!   is F26 stage 0 being a real product state rather than an error state, so the
//!   route answers without a session, without an organization, and without a
//!   device, and it discloses no tenant data.
//! * **Nothing in P08 accepts a local secret.** There is no request body in this
//!   module with a field for an API key, a prompt, a file, or an MCP
//!   configuration, and no route that writes one. The credential route records a
//!   *mode* and a reference; the secret itself is a P04 `credentials` row reached
//!   through P04's own routes.
//! * **Every adoption mutation is a compare-and-set.** A browser that resumes a
//!   stale wizard cannot overwrite a newer decision, and a second tab cannot
//!   double-apply a stage.
//! * **Unbinding never touches local data.** The rollback route writes one row in
//!   Lumi's database. It has no path to the user's machine, which is why the
//!   response can honestly say the local workspace was not modified.

#![allow(dead_code)]

use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, Response, StatusCode},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    app::AppState,
    core::{ApiError, ApiErrorCode, RequestContext, StoredSuccess},
    http::auth::require_csrf,
    modules::{
        authorization::Permission,
        migration::{
            AdoptionError, AdoptionStage, AdoptionState, CONTRACT_VERSION, ClientFingerprint,
            CompatibilityPolicy, CompatibilityRanges, CredentialMode, MigrationObservation,
            Ownership, SUPPORTED_CLIENT_PROTOCOLS, SUPPORTED_POLICY_SCHEMA_VERSIONS,
            StageTransition, TelemetryReport, apply_stage, automation_import_preview,
            derive_remediations, external_workspace_ref, rollback, validate_candidate,
        },
    },
    repositories::{
        AdoptionRepository, AdoptionStateRecord, AdvanceStageInput, MAX_ADOPTION_PAGE_SIZE,
        MAX_REMEDIATION_PAGE_SIZE, NewAdoptionStateInput, NewStageEventInput, RemediationRecord,
        ResolveRemediationInput, RollbackInput,
    },
    routes::{
        agents::{
            PreparedMutation, commit_mutation, generated_id, not_found, prepare_mutation,
            replay_response, service_unavailable, validation_error,
        },
        authorization::authorize_org,
        errors,
        support::{database, domain_error, idempotency_key, outbox_statement},
    },
};

/// Frozen event names. Adoption changes are organization-visible, so they go
/// through the outbox like every other P03–P07 event rather than into an audit
/// row alone.
const EVENT_ADOPTION_RECORDED: &str = "adoption.workspace_recorded.v1";
const EVENT_ADOPTION_STAGE_CHANGED: &str = "adoption.stage_changed.v1";
const EVENT_ADOPTION_ROLLED_BACK: &str = "adoption.rolled_back.v1";
const EVENT_ADOPTION_REMEDIATION_RESOLVED: &str = "adoption.remediation_resolved.v1";
const EVENT_ADOPTION_TELEMETRY_RECORDED: &str = "adoption.telemetry_recorded.v1";

const ADOPTION_PATH: &str = "/api/v1/orgs/{org_id}/adoption";
const BINDINGS_PATH: &str = "/api/v1/orgs/{org_id}/adoption/bindings";
const BINDING_PATH: &str = "/api/v1/orgs/{org_id}/adoption/bindings/{adoption_state_id}";
const ROLLBACK_PATH: &str = "/api/v1/orgs/{org_id}/adoption/bindings/{adoption_state_id}/rollback";
const REMEDIATION_PATH: &str =
    "/api/v1/orgs/{org_id}/adoption/remediations/{remediation_id}/resolve";
const TELEMETRY_PATH: &str = "/api/v1/orgs/{org_id}/adoption/telemetry";
const IMPORT_PREVIEW_PATH: &str = "/api/v1/orgs/{org_id}/adoption/automation-imports/preview";

const PERMISSION_ADOPTION_READ: &str = "adoption.read";
const PERMISSION_ADOPTION_MANAGE: &str = "adoption.manage";

/// Model capabilities the import preview treats as available, because P08 does not
/// evaluate them. The preview's job is to surface what org policy forbids before
/// an import; whether a route can actually service a capability is P04's catalog
/// decision at dispatch, and duplicating that list here would create a second
/// source of truth that drifts. The response says the check is deferred rather
/// than implying the capability was verified.
const ALL_MODEL_CAPABILITIES: [&str; 0] = [];

// ============================================================ requests ======

/// Register one local workspace as adopted, or re-attach one the caller already
/// knows.
///
/// `installation_id` and `workspace_key` are the client's own opaque identifiers.
/// They are not a path and cannot be one: the domain refuses either separator.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordAdoptionRequest {
    pub installation_id: String,
    pub workspace_key: String,
    pub display_name: String,
    /// Optional project. Present only when the user is on the binding step; a
    /// request without it records an adopted-but-unbound workspace, which is a
    /// legitimate and resumable position.
    pub project_id: Option<String>,
    pub device_id: Option<String>,
    pub stage: String,
    pub credential_mode: String,
    pub client_protocol_major: i64,
    pub policy_schema_version: i64,
    pub client_app_version: String,
}

/// Move one adopted workspace to the next stage, or change only its credential
/// mode.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdvanceStageRequest {
    pub stage: String,
    pub credential_mode: Option<String>,
    pub client_protocol_major: Option<i64>,
    pub policy_schema_version: Option<i64>,
    pub client_app_version: Option<String>,
    pub version: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VersionRequest {
    pub version: i64,
}

/// One local automation the user wants to import, described but not uploaded.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCandidateRequest {
    pub local_key: String,
    pub schedule_kind: String,
    #[serde(default)]
    pub required_tools: Vec<String>,
    #[serde(default)]
    pub required_model_capabilities: Vec<String>,
    #[serde(default)]
    pub uses_off_peak: bool,
    pub credential_mode: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportPreviewRequest {
    pub candidates: Vec<ImportCandidateRequest>,
    /// The adoption records whose workspaces would run these automations. The
    /// control plane verifies each one against its own record rather than taking
    /// the binding on trust, because "this workspace is bound" is exactly the
    /// claim a client would make to skip the `workspace_unbound` conflict.
    #[serde(default)]
    pub adoption_state_ids: Vec<String>,
    /// The stage/result the user is being asked to confirm. Accepted so the
    /// wizard can name the step it is on; it is validated, not trusted, and it
    /// carries no authority.
    pub stage: String,
}

#[derive(Debug, Deserialize)]
pub struct AdoptionQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CompatibilityResponse {
    pub contract_version: &'static str,
    pub supported_protocols: &'static [i64],
    pub supported_policy_schema_versions: &'static [i64],
    pub min_client_app_version: &'static str,
    pub local_only_eligible: bool,
    pub history_sync_eligible: bool,
    /// Echoed back when the client sent a fingerprint, so a client can log the
    /// server's verdict next to what it believed.
    pub client: Option<ClientVerdictResponse>,
    pub stages: [&'static str; 6],
}

#[derive(Debug, Serialize)]
pub struct ClientVerdictResponse {
    pub state: &'static str,
    pub mode: &'static str,
    pub local_only_available: bool,
    pub managed_allowed: bool,
    pub reason: Option<&'static str>,
    pub min_client_app_version: Option<&'static str>,
}

// ============================================================ public route ==

/// What this control plane supports, and what that means for this client.
///
/// Deliberately unauthenticated. An existing local user must be able to discover
/// the supported range before deciding whether to create an account, and a client
/// that decides not to must still have been told something definite. The response
/// contains only platform constants plus the caller's own echoed fingerprint, so
/// there is no tenant data to authorize.
#[worker::send]
pub async fn compatibility(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    Query(query): Query<CompatibilityQuery>,
) -> Result<Response<Body>, ApiError> {
    let policy = current_policy(&state, &context).await;
    let ranges = CompatibilityRanges::from_policy(&policy);
    let verdict = match (
        query.protocol_major,
        query.policy_schema_version,
        query.app_version.as_deref(),
    ) {
        (Some(protocol), Some(schema), Some(version)) => {
            // A malformed fingerprint is answered with the ranges alone: echoing
            // a verdict for a value the transport already refused would teach a
            // client that garbage is evaluated.
            ClientFingerprint::new(protocol, schema, version).ok()
        }
        _ => None,
    };
    let client = verdict.map(|fingerprint| {
        let verdict = policy.evaluate(&fingerprint);
        ClientVerdictResponse {
            state: verdict.state.as_str(),
            mode: verdict.mode().as_str(),
            local_only_available: verdict.local_only_available(),
            managed_allowed: verdict.managed_allowed(),
            reason: verdict.reason(),
            min_client_app_version: verdict.min_app_version(),
        }
    });
    let response = CompatibilityResponse {
        contract_version: ranges.contract_version,
        supported_protocols: SUPPORTED_CLIENT_PROTOCOLS.as_slice(),
        supported_policy_schema_versions: SUPPORTED_POLICY_SCHEMA_VERSIONS.as_slice(),
        min_client_app_version: ranges.min_client_app_version,
        local_only_eligible: ranges.local_only_eligible,
        history_sync_eligible: ranges.history_sync_eligible,
        client,
        stages: [
            AdoptionStage::LocalUnmanaged.as_str(),
            AdoptionStage::AccountOptional.as_str(),
            AdoptionStage::DeviceEnrolled.as_str(),
            AdoptionStage::WorkspaceBound.as_str(),
            AdoptionStage::ManagedPolicy.as_str(),
            AdoptionStage::HistorySync.as_str(),
        ],
    };
    let body = serde_json::to_value(response).map_err(|_| service_unavailable(&context))?;
    Ok((StatusCode::OK, Json(body)).into_response())
}

#[derive(Debug, Deserialize)]
pub struct CompatibilityQuery {
    pub protocol_major: Option<i64>,
    pub policy_schema_version: Option<i64>,
    pub app_version: Option<String>,
}

// =========================================================== summary route ==

/// Everything an operator needs to answer "where is this organization in the
/// migration, and what is stuck", in one call.
#[worker::send]
pub async fn adoption_summary(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    Query(query): Query<AdoptionQuery>,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionRead,
        Some("adoption"),
        None,
    )
    .await?;
    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    let limit = page_limit(query.limit, MAX_ADOPTION_PAGE_SIZE);
    let bindings = repository
        .list(&org_id, limit)
        .await
        .map_err(|error| database_error(&context, error))?;
    let stage_counts = repository
        .stage_counts(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    let event_counts = repository
        .event_counts(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    let remediations = repository
        .list_remediations(&org_id, MAX_REMEDIATION_PAGE_SIZE as i64)
        .await
        .map_err(|error| database_error(&context, error))?;
    let policy = current_policy(&state, &context).await;

    let managed = bindings.iter().filter(|row| row.is_managed()).count();
    let adopted = bindings.iter().filter(|row| row.is_adopted()).count();
    let open = remediations.iter().filter(|row| row.is_open()).count();

    // Remediations are derived here rather than stored-and-hoped-for, so an
    // operator sees the same answer whether the derived code or the recorded one
    // ran. The recorded rows are still returned, and a derived code that has no
    // open row is reported as `derived` so the console can show it without a
    // second write.
    let derived: Vec<Value> = bindings
        .iter()
        .flat_map(|row| {
            derive_for(row, &policy)
                .into_iter()
                .map(|entry| {
                    json!({
                        "adoption_state_id": row.adoption_state_id,
                        "code": entry.code.as_str(),
                        "remedy": entry.remedy.as_str(),
                        "stage": row.stage,
                        "source": "derived",
                    })
                })
                .collect::<Vec<Value>>()
        })
        .collect();

    let body = json!({
        "org_id": org_id,
        "contract_version": CONTRACT_VERSION,
        "compatibility": {
            "supported_protocols": SUPPORTED_CLIENT_PROTOCOLS,
            "supported_policy_schema_versions": SUPPORTED_POLICY_SCHEMA_VERSIONS,
            "local_only_eligible": policy.local_only_eligible(),
            "history_sync_eligible": policy.history_sync_allowed(),
        },
        "counts": {
            "adopted_workspaces": adopted,
            "managed_workspaces": managed,
            "open_remediations": open,
        },
        "stage_counts": stage_counts
            .iter()
            .map(|(stage, total)| json!({ "stage": stage, "count": total }))
            .collect::<Vec<Value>>(),
        "event_counts": event_counts
            .iter()
            .map(|(stage, result, total)| json!({
                "stage": stage, "result": result, "count": total,
            }))
            .collect::<Vec<Value>>(),
        "bindings": bindings.iter().map(binding_json).collect::<Vec<Value>>(),
        "remediations": remediations
            .iter()
            .map(remediation_json)
            .collect::<Vec<Value>>(),
        "derived_remediations": derived,
        "actor_role": access.membership.role,
    });
    Ok((StatusCode::OK, Json(body)).into_response())
}

#[worker::send]
pub async fn list_bindings(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    Query(query): Query<AdoptionQuery>,
) -> Result<Response<Body>, ApiError> {
    authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionRead,
        Some("adoption"),
        None,
    )
    .await?;
    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    let rows = repository
        .list(&org_id, page_limit(query.limit, MAX_ADOPTION_PAGE_SIZE))
        .await
        .map_err(|error| database_error(&context, error))?;
    let body = json!({
        "items": rows.iter().map(binding_json).collect::<Vec<Value>>(),
        "count": rows.len(),
    });
    Ok((StatusCode::OK, Json(body)).into_response())
}

#[worker::send]
pub async fn list_remediations(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    Query(query): Query<AdoptionQuery>,
) -> Result<Response<Body>, ApiError> {
    authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionRead,
        Some("adoption_remediation"),
        None,
    )
    .await?;
    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    let rows = repository
        .list_remediations(&org_id, page_limit(query.limit, MAX_REMEDIATION_PAGE_SIZE))
        .await
        .map_err(|error| database_error(&context, error))?;
    let body = json!({
        "items": rows.iter().map(remediation_json).collect::<Vec<Value>>(),
        "count": rows.len(),
        "open": rows.iter().filter(|row| row.is_open()).count(),
    });
    Ok((StatusCode::OK, Json(body)).into_response())
}

// ======================================================== adoption routes ===

/// Adopt one local workspace, or resume an adoption already in progress.
///
/// Idempotent on the client's own external reference: a resumed wizard that
/// replays this call finds the existing record and returns it, so a dropped
/// response never produces a second adoption of the same workspace.
#[worker::send]
pub async fn record_adoption(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    Json(body): Json<RecordAdoptionRequest>,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionManage,
        Some("adoption"),
        None,
    )
    .await?;
    require_csrf(&headers, &access.session, &context).await?;
    let key = idempotency_key(&headers, &context)?;
    let reference = external_workspace_ref(&body.installation_id, &body.workspace_key)
        .map_err(|error| adoption_failure(&context, error, ApiErrorCode::ValidationFailed))?;
    let stage = AdoptionStage::parse(&body.stage).ok_or_else(|| {
        validation_error(
            &context,
            AdoptionError::StageNotAdvanceable.code(),
            "The requested migration stage is not a stage Lumi Agents recognizes.",
        )
    })?;
    let credential_mode = CredentialMode::parse(&body.credential_mode).ok_or_else(|| {
        validation_error(
            &context,
            AdoptionError::InvalidExternalReference.code(),
            "The requested credential mode is not recognized.",
        )
    })?;
    // The first adoption decision a client can make is stage 0. Anything past it
    // has to walk forward from here, so a client that POSTs straight to
    // `managed_policy` is refused rather than silently fast-forwarded.
    if stage != AdoptionStage::LocalUnmanaged {
        return Err(adoption_failure(
            &context,
            AdoptionError::StageNotAdvanceable,
            ApiErrorCode::Conflict,
        ));
    }
    if stage.implies_org_ownership() && (body.project_id.is_none() || body.device_id.is_none()) {
        return Err(adoption_failure(
            &context,
            AdoptionError::BindingIncomplete,
            ApiErrorCode::ValidationFailed,
        ));
    }
    if credential_mode == CredentialMode::OrgManagedCredential {
        return Err(adoption_failure(
            &context,
            AdoptionError::CredentialModeRequiresManaged,
            ApiErrorCode::ValidationFailed,
        ));
    }
    let display_name = crate::modules::devices::validate_workspace_display_name(&body.display_name)
        .map_err(|_| {
            validation_error(
                &context,
                "display_name_invalid",
                "The workspace display name is invalid.",
            )
        })?;
    let fingerprint = ClientFingerprint::new(
        body.client_protocol_major,
        body.policy_schema_version,
        &body.client_app_version,
    )
    .map_err(|_| {
        validation_error(
            &context,
            "client_fingerprint_invalid",
            "The client protocol, policy schema, or app version is invalid.",
        )
    })?;

    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    if let Some(existing) = repository
        .find_by_external_reference(
            &org_id,
            &reference.installation_id,
            &reference.workspace_key,
        )
        .await
        .map_err(|error| database_error(&context, error))?
    {
        // Resume, not re-adopt. Returning the existing record is what makes the
        // wizard resumable across a dropped response.
        return Ok((StatusCode::OK, Json(binding_json(&existing))).into_response());
    }

    let body_value = serde_json::to_value(&body).map_err(|_| service_unavailable(&context))?;
    let claim = match prepare_mutation(
        database,
        &context,
        &access.principal,
        &org_id,
        &key,
        "POST",
        BINDINGS_PATH,
        &body_value,
    )
    .await?
    {
        PreparedMutation::Replay(success) => return Ok(replay_response(success)),
        PreparedMutation::Claim(claim) => claim,
    };

    let adoption_state_id = generated_id("wst");
    let insert = repository
        .insert_statement(&NewAdoptionStateInput {
            adoption_state_id: &adoption_state_id,
            org_id: &org_id,
            external_installation_id: &reference.installation_id,
            external_workspace_key: &reference.workspace_key,
            display_name: &display_name,
            bound_project_id: body.project_id.as_deref(),
            bound_device_id: body.device_id.as_deref(),
            stage: stage.as_str(),
            ownership: Ownership::for_stage(stage).as_str(),
            credential_mode: credential_mode.as_str(),
            client_protocol_major: fingerprint.protocol_major,
            policy_schema_version: fingerprint.policy_schema_version,
            client_app_version: &fingerprint.app_version,
            now: context.received_at.as_str(),
        })
        .map_err(|error| database_error(&context, error))?;
    let event = repository
        .insert_event_statement(&NewStageEventInput {
            adoption_event_id: &generated_id("ase"),
            org_id: &org_id,
            adoption_state_id: Some(&adoption_state_id),
            device_id: body.device_id.as_deref(),
            actor_user_id: Some(access.principal.user_id.as_str()),
            stage: stage.as_str(),
            result: crate::modules::migration::TelemetryResult::Completed.as_str(),
            reason_code: None,
            client_protocol_major: Some(fingerprint.protocol_major),
            policy_schema_version: Some(fingerprint.policy_schema_version),
            client_app_version: Some(&fingerprint.app_version),
            now: context.received_at.as_str(),
        })
        .map_err(|error| database_error(&context, error))?;
    let audit = support_security_statement(
        database,
        &context,
        &org_id,
        &access.principal,
        "adoption.recorded",
        "adoption",
        &adoption_state_id,
        &json!({
            "stage": stage.as_str(),
            "credential_mode": credential_mode.as_str(),
            "client_protocol_major": fingerprint.protocol_major,
            "project_id": body.project_id,
        }),
    )?;
    let outbox = outbox_statement(
        database,
        &context,
        Some(&access.principal),
        Some(&org_id),
        EVENT_ADOPTION_RECORDED,
        &json!({
            "adoption_state_id": adoption_state_id,
            "org_id": org_id,
            "stage": stage.as_str(),
            "project_id": body.project_id,
        }),
    )?;
    let success = StoredSuccess::new(
        201,
        json!({
            "adoption_state_id": adoption_state_id,
            "org_id": org_id,
            "stage": stage.as_str(),
            "ownership": Ownership::for_stage(stage).as_str(),
            "credential_mode": credential_mode.as_str(),
            "version": 1,
        }),
    )
    .map_err(|_| service_unavailable(&context))?;
    if let Some(replay) = commit_mutation(
        database,
        &context,
        claim,
        success,
        vec![insert, event, audit],
        outbox,
    )
    .await?
    {
        return Ok(replay_response(replay));
    }
    let record = repository
        .find_by_id(&adoption_state_id, &org_id)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| service_unavailable(&context))?;
    Ok((StatusCode::CREATED, Json(binding_json(&record))).into_response())
}

/// Move one adopted workspace to its next stage, or change only its credential
/// mode.
#[worker::send]
pub async fn advance_adoption_stage(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path((org_id, adoption_state_id)): Path<(String, String)>,
    Json(body): Json<AdvanceStageRequest>,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionManage,
        Some("adoption"),
        Some(&adoption_state_id),
    )
    .await?;
    require_csrf(&headers, &access.session, &context).await?;
    validate_version(&context, body.version)?;
    let key = idempotency_key(&headers, &context)?;
    let requested = AdoptionStage::parse(&body.stage).ok_or_else(|| {
        validation_error(
            &context,
            AdoptionError::StageNotAdvanceable.code(),
            "The requested migration stage is not a stage Lumi Agents recognizes.",
        )
    })?;
    let credential_mode = match body.credential_mode.as_deref() {
        None => None,
        Some(value) => Some(CredentialMode::parse(value).ok_or_else(|| {
            validation_error(
                &context,
                AdoptionError::InvalidExternalReference.code(),
                "The requested credential mode is not recognized.",
            )
        })?),
    };

    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    let record = require_record(&context, &repository, &org_id, &adoption_state_id).await?;
    let current_stage =
        AdoptionStage::parse(&record.stage).ok_or_else(|| service_unavailable(&context))?;
    let current_ownership =
        Ownership::parse(&record.ownership).ok_or_else(|| service_unavailable(&context))?;
    let current_mode = record
        .credential_mode()
        .ok_or_else(|| service_unavailable(&context))?;
    let policy = current_policy(&state, &context).await;

    let next_mode = credential_mode.unwrap_or(current_mode);
    let transition = apply_stage(
        &AdoptionState {
            stage: current_stage,
            ownership: current_ownership,
            credential_mode: current_mode,
            bound_project_id: record.bound_project_id.clone(),
            bound_device_id: record.bound_device_id.clone(),
        },
        requested,
        next_mode,
        &policy,
    )
    // Every stage refusal is a conflict rather than a validation failure: the
    // request was well formed, the current stage simply does not allow it, and the
    // stable reason in `details.reason` is what the client acts on.
    .map_err(|error| adoption_failure(&context, error, ApiErrorCode::Conflict))?;

    let body_value = serde_json::to_value(&body).map_err(|_| service_unavailable(&context))?;
    let claim = match prepare_mutation(
        database,
        &context,
        &access.principal,
        &org_id,
        &key,
        "PATCH",
        BINDING_PATH,
        &body_value,
    )
    .await?
    {
        PreparedMutation::Replay(success) => return Ok(replay_response(success)),
        PreparedMutation::Claim(claim) => claim,
    };

    let guard = repository
        .assert_version_statement(&adoption_state_id, &org_id, body.version)
        .map_err(|error| database_error(&context, error))?;
    // The guard leads the batch so a stale writer aborts before any row moves.
    let mut statements = vec![guard];
    let (status, change) = match transition {
        StageTransition::Unchanged(stage) => {
            // A credential-mode-only change still writes, because the wizard's
            // "choose credential mode" step is its own request. The stage is
            // unchanged and the version still moves, so a stale tab cannot
            // re-assert an old mode.
            (
                200,
                json!({
                    "adoption_state_id": adoption_state_id,
                    "org_id": org_id,
                    "stage": stage.as_str(),
                    "ownership": current_ownership.as_str(),
                    "credential_mode": next_mode.as_str(),
                    "unchanged_stage": true,
                    "version": body.version + 1,
                }),
            )
        }
        StageTransition::Applied(change) => {
            let update = repository
                .advance_statement(&AdvanceStageInput {
                    adoption_state_id: &adoption_state_id,
                    org_id: &org_id,
                    stage: change.to.as_str(),
                    ownership: change.ownership.as_str(),
                    credential_mode: change.credential_mode.as_str(),
                    bound_project_id: record.bound_project_id.as_deref(),
                    bound_device_id: record.bound_device_id.as_deref(),
                    client_protocol_major: body
                        .client_protocol_major
                        .unwrap_or(record.client_protocol_major),
                    policy_schema_version: body
                        .policy_schema_version
                        .unwrap_or(record.policy_schema_version),
                    client_app_version: body
                        .client_app_version
                        .as_deref()
                        .unwrap_or(&record.client_app_version),
                    now: context.received_at.as_str(),
                    expected_version: body.version,
                })
                .map_err(|error| database_error(&context, error))?;
            statements.push(update);
            (
                200,
                json!({
                    "adoption_state_id": adoption_state_id,
                    "org_id": org_id,
                    "from_stage": change.from.as_str(),
                    "stage": change.to.as_str(),
                    "ownership": change.ownership.as_str(),
                    "credential_mode": change.credential_mode.as_str(),
                    "rolled_back": false,
                    "version": body.version + 1,
                }),
            )
        }
    };
    statements.push(
        repository
            .insert_event_statement(&NewStageEventInput {
                adoption_event_id: &generated_id("ase"),
                org_id: &org_id,
                adoption_state_id: Some(&adoption_state_id),
                device_id: record.bound_device_id.as_deref(),
                actor_user_id: Some(access.principal.user_id.as_str()),
                stage: requested.as_str(),
                result: crate::modules::migration::TelemetryResult::Completed.as_str(),
                reason_code: None,
                client_protocol_major: body.client_protocol_major,
                policy_schema_version: body.policy_schema_version,
                client_app_version: body.client_app_version.as_deref(),
                now: context.received_at.as_str(),
            })
            .map_err(|error| database_error(&context, error))?,
    );
    statements.push(support_security_statement(
        database,
        &context,
        &org_id,
        &access.principal,
        "adoption.stage_changed",
        "adoption",
        &adoption_state_id,
        &json!({ "from": record.stage, "to": requested.as_str() }),
    )?);
    let outbox = outbox_statement(
        database,
        &context,
        Some(&access.principal),
        Some(&org_id),
        EVENT_ADOPTION_STAGE_CHANGED,
        &json!({
            "adoption_state_id": adoption_state_id,
            "org_id": org_id,
            "from_stage": record.stage,
            "to_stage": requested.as_str(),
        }),
    )?;
    let success = StoredSuccess::new(status, change).map_err(|_| service_unavailable(&context))?;
    if let Some(replay) =
        commit_mutation(database, &context, claim, success, statements, outbox).await?
    {
        return Ok(replay_response(replay));
    }
    let updated = repository
        .find_by_id(&adoption_state_id, &org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    Ok((
        status_code(status),
        Json(updated.as_ref().map_or_else(
            || json!({ "adoption_state_id": adoption_state_id }),
            binding_json,
        )),
    )
        .into_response())
}

/// Return one adopted workspace to unmanaged local operation.
///
/// Writes one row in Lumi's database and nothing else. There is no code path from
/// here to the user's machine, which is the whole point: FR-F26-006 asks for a
/// rollback that cannot corrupt local state, and the strongest way to guarantee
/// that is to have no way to touch it.
#[worker::send]
pub async fn rollback_adoption(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path((org_id, adoption_state_id)): Path<(String, String)>,
    Json(body): Json<VersionRequest>,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionManage,
        Some("adoption"),
        Some(&adoption_state_id),
    )
    .await?;
    require_csrf(&headers, &access.session, &context).await?;
    validate_version(&context, body.version)?;
    let key = idempotency_key(&headers, &context)?;
    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    let record = require_record(&context, &repository, &org_id, &adoption_state_id).await?;
    let current_stage =
        AdoptionStage::parse(&record.stage).ok_or_else(|| service_unavailable(&context))?;
    let current_ownership =
        Ownership::parse(&record.ownership).ok_or_else(|| service_unavailable(&context))?;
    let current_mode = record
        .credential_mode()
        .ok_or_else(|| service_unavailable(&context))?;
    let change = rollback(&AdoptionState {
        stage: current_stage,
        ownership: current_ownership,
        credential_mode: current_mode,
        bound_project_id: record.bound_project_id.clone(),
        bound_device_id: record.bound_device_id.clone(),
    })
    .map_err(|error| adoption_failure(&context, error, ApiErrorCode::Conflict))?;

    let body_value = serde_json::to_value(&body).map_err(|_| service_unavailable(&context))?;
    let claim = match prepare_mutation(
        database,
        &context,
        &access.principal,
        &org_id,
        &key,
        "POST",
        ROLLBACK_PATH,
        &body_value,
    )
    .await?
    {
        PreparedMutation::Replay(success) => return Ok(replay_response(success)),
        PreparedMutation::Claim(claim) => claim,
    };

    let guard = repository
        .assert_version_statement(&adoption_state_id, &org_id, body.version)
        .map_err(|error| database_error(&context, error))?;
    let update = repository
        .rollback_statement(&RollbackInput {
            adoption_state_id: &adoption_state_id,
            org_id: &org_id,
            from_stage: change.from.as_str(),
            now: context.received_at.as_str(),
            expected_version: body.version,
        })
        .map_err(|error| database_error(&context, error))?;
    let event = repository
        .insert_event_statement(&NewStageEventInput {
            adoption_event_id: &generated_id("ase"),
            org_id: &org_id,
            adoption_state_id: Some(&adoption_state_id),
            device_id: record.bound_device_id.as_deref(),
            actor_user_id: Some(access.principal.user_id.as_str()),
            stage: change.to.as_str(),
            result: crate::modules::migration::TelemetryResult::RolledBack.as_str(),
            reason_code: Some("consent_required"),
            client_protocol_major: None,
            policy_schema_version: None,
            client_app_version: None,
            now: context.received_at.as_str(),
        })
        .map_err(|error| database_error(&context, error))?;
    let audit = support_security_statement(
        database,
        &context,
        &org_id,
        &access.principal,
        "adoption.rolled_back",
        "adoption",
        &adoption_state_id,
        &json!({ "from_stage": change.from.as_str(), "to_stage": change.to.as_str() }),
    )?;
    let outbox = outbox_statement(
        database,
        &context,
        Some(&access.principal),
        Some(&org_id),
        EVENT_ADOPTION_ROLLED_BACK,
        &json!({
            "adoption_state_id": adoption_state_id,
            "org_id": org_id,
            "from_stage": change.from.as_str(),
            "to_stage": change.to.as_str(),
        }),
    )?;
    let success = StoredSuccess::new(
        200,
        json!({
            "adoption_state_id": adoption_state_id,
            "org_id": org_id,
            "from_stage": change.from.as_str(),
            "stage": change.to.as_str(),
            "ownership": change.ownership.as_str(),
            "credential_mode": change.credential_mode.as_str(),
            "rolled_back": true,
            "local_data_modified": false,
            "version": body.version + 1,
        }),
    )
    .map_err(|_| service_unavailable(&context))?;
    if let Some(replay) = commit_mutation(
        database,
        &context,
        claim,
        success,
        vec![guard, update, event, audit],
        outbox,
    )
    .await?
    {
        return Ok(replay_response(replay));
    }
    let updated = repository
        .find_by_id(&adoption_state_id, &org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    Ok((
        StatusCode::OK,
        Json(updated.as_ref().map_or_else(
            || json!({ "adoption_state_id": adoption_state_id }),
            binding_json,
        )),
    )
        .into_response())
}

#[worker::send]
pub async fn resolve_remediation(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path((org_id, remediation_id)): Path<(String, String)>,
    Json(body): Json<VersionRequest>,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionManage,
        Some("adoption_remediation"),
        Some(&remediation_id),
    )
    .await?;
    require_csrf(&headers, &access.session, &context).await?;
    validate_version(&context, body.version)?;
    let key = idempotency_key(&headers, &context)?;
    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    let existing = repository
        .list_remediations(&org_id, MAX_REMEDIATION_PAGE_SIZE as i64)
        .await
        .map_err(|error| database_error(&context, error))?
        .into_iter()
        .find(|row| row.remediation_id == remediation_id)
        .ok_or_else(|| not_found(&context, "remediation_not_found"))?;
    if !existing.is_open() {
        return Err(domain_error(
            &context,
            ApiErrorCode::Conflict,
            "remediation_already_resolved",
            "This remediation is already resolved.",
        ));
    }
    if existing.version != body.version {
        return Err(domain_error(
            &context,
            ApiErrorCode::Conflict,
            "version_conflict",
            "This remediation changed since it was loaded.",
        ));
    }

    let body_value = serde_json::to_value(&body).map_err(|_| service_unavailable(&context))?;
    let claim = match prepare_mutation(
        database,
        &context,
        &access.principal,
        &org_id,
        &key,
        "POST",
        REMEDIATION_PATH,
        &body_value,
    )
    .await?
    {
        PreparedMutation::Replay(success) => return Ok(replay_response(success)),
        PreparedMutation::Claim(claim) => claim,
    };

    let input = ResolveRemediationInput {
        remediation_id: &remediation_id,
        org_id: &org_id,
        resolved_by_user_id: access.principal.user_id.as_str(),
        expected_version: body.version,
        now: context.received_at.as_str(),
    };
    let guard = repository
        .assert_remediation_open_statement(&input)
        .map_err(|error| database_error(&context, error))?;
    let update = repository
        .resolve_remediation_statement(&input)
        .map_err(|error| database_error(&context, error))?;
    let audit = support_security_statement(
        database,
        &context,
        &org_id,
        &access.principal,
        "adoption.remediation_resolved",
        "adoption_remediation",
        &remediation_id,
        &json!({ "code": existing.code }),
    )?;
    let outbox = outbox_statement(
        database,
        &context,
        Some(&access.principal),
        Some(&org_id),
        EVENT_ADOPTION_REMEDIATION_RESOLVED,
        &json!({
            "remediation_id": remediation_id,
            "org_id": org_id,
            "code": existing.code,
        }),
    )?;
    let success = StoredSuccess::new(
        200,
        json!({
            "remediation_id": remediation_id,
            "org_id": org_id,
            "state": "resolved",
            "code": existing.code,
            "version": body.version + 1,
        }),
    )
    .map_err(|_| service_unavailable(&context))?;
    if let Some(replay) = commit_mutation(
        database,
        &context,
        claim,
        success,
        vec![guard, update, audit],
        outbox,
    )
    .await?
    {
        return Ok(replay_response(replay));
    }
    Ok((
        StatusCode::OK,
        Json(json!({
            "remediation_id": remediation_id,
            "org_id": org_id,
            "state": "resolved",
            "code": existing.code,
            "version": body.version + 1,
        })),
    )
        .into_response())
}

/// Record one migration stage/result pair.
///
/// A browser-authenticated route rather than a device route on purpose: stage 0
/// and stage 1 have no device, and a user who has signed in but not yet enrolled
/// still has to be able to say "I skipped this". The report is parsed by
/// `TelemetryReport::parse`, which refuses any field outside the frozen list, so
/// there is no request shape through which content can arrive.
#[worker::send]
pub async fn record_telemetry(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    body: axum::body::Bytes,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionRead,
        Some("adoption"),
        None,
    )
    .await?;
    require_csrf(&headers, &access.session, &context).await?;
    let raw = std::str::from_utf8(&body).map_err(|_| {
        validation_error(
            &context,
            AdoptionError::TelemetryFieldUnknown.code(),
            "The migration report is not valid UTF-8.",
        )
    })?;
    let report = TelemetryReport::parse(raw)
        .map_err(|error| adoption_failure(&context, error, ApiErrorCode::ValidationFailed))?;
    let database = database(&state, &context)?;
    let repository = AdoptionRepository::new(database);
    let insert = repository
        .insert_event_statement(&NewStageEventInput {
            adoption_event_id: &generated_id("ase"),
            org_id: &org_id,
            adoption_state_id: None,
            device_id: None,
            actor_user_id: Some(access.principal.user_id.as_str()),
            stage: report.stage.as_str(),
            result: report.result.as_str(),
            reason_code: report.reason_code.as_deref(),
            client_protocol_major: report.protocol_major,
            policy_schema_version: report.policy_schema_version,
            client_app_version: report.app_version.as_deref(),
            now: context.received_at.as_str(),
        })
        .map_err(|error| database_error(&context, error))?;
    database
        .batch(vec![insert])
        .await
        .map_err(|error| database_error(&context, error))?;
    let outbox = outbox_statement(
        database,
        &context,
        Some(&access.principal),
        Some(&org_id),
        EVENT_ADOPTION_TELEMETRY_RECORDED,
        &json!({
            "org_id": org_id,
            "stage": report.stage.as_str(),
            "result": report.result.as_str(),
        }),
    )?;
    outbox
        .run()
        .await
        .map_err(|error| database_error(&context, error))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "accepted": true,
            "stage": report.stage.as_str(),
            "result": report.result.as_str(),
        })),
    )
        .into_response())
}

/// Preview an automation import, without importing anything.
///
/// This is the only P08 route that reads a description of a local automation,
/// and it reads only the parts needed to judge org policy: a key, a schedule
/// kind, the tools and model capabilities it needs, and the credential mode it
/// would run under. The control plane has no route that creates an automation
/// from a local one — the client creates it through P06's ordinary route after
/// the user confirms this preview — so the local automations cannot be modified
/// or removed by anything here.
#[worker::send]
pub async fn preview_automation_import(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    Json(body): Json<ImportPreviewRequest>,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::AdoptionRead,
        Some("adoption"),
        None,
    )
    .await?;
    require_csrf(&headers, &access.session, &context).await?;
    // Whether the previewing workspace is bound is the one fact a client may
    // state, and the control plane checks it below against its own record.
    let project_bound = project_bound_for(&state, &context, &org_id, &body).await?;
    let mut candidates = Vec::with_capacity(body.candidates.len());
    for request in &body.candidates {
        let credential_mode = CredentialMode::parse(&request.credential_mode).ok_or_else(|| {
            validation_error(
                &context,
                AdoptionError::InvalidExternalReference.code(),
                "A candidate declared an unrecognized credential mode.",
            )
        })?;
        let candidate = crate::modules::migration::AutomationImportCandidate {
            local_key: request.local_key.clone(),
            schedule_kind: request.schedule_kind.clone(),
            required_tools: request.required_tools.clone(),
            required_model_capabilities: request.required_model_capabilities.clone(),
            uses_off_peak: request.uses_off_peak,
            credential_mode,
        };
        validate_candidate(&candidate)
            .map_err(|error| adoption_failure(&context, error, ApiErrorCode::ValidationFailed))?;
        candidates.push(candidate);
    }
    let context_facts = import_context(&state, &context, &org_id, project_bound).await?;
    let preview = automation_import_preview(&candidates, &context_facts)
        .map_err(|error| adoption_failure(&context, error, ApiErrorCode::ValidationFailed))?;
    let body = json!({
        "org_id": org_id,
        "tool_policy_scope": "organization",
        "model_capability_check": "deferred_to_dispatch",
        "items": preview
            .items
            .iter()
            .map(|item| json!({
                "local_key": item.local_key,
                "importable": item.is_importable(),
                "conflicts": item
                    .conflicts
                    .iter()
                    .map(|conflict| json!({
                        "code": conflict.code(),
                        "subject": conflict.subject(),
                    }))
                    .collect::<Vec<Value>>(),
            }))
            .collect::<Vec<Value>>(),
        "importable_count": preview.importable_count(),
        "blocked_count": preview.blocked_count(),
        "commit_ready": preview.is_commit_ready(),
        "local_automations_modified": false,
    });
    Ok((StatusCode::OK, Json(body)).into_response())
}

// =============================================================== helpers ====

/// The stored compatibility policy, or the compiled-in baseline when storage has
/// no row or cannot be read.
///
/// Falling back is deliberate: a local client that cannot read this row must
/// still get an answer, because an error here would push an existing local user
/// off the managed path rather than telling them what to upgrade to.
async fn current_policy(state: &Arc<AppState>, context: &RequestContext) -> CompatibilityPolicy {
    let Ok(database) = database(state, context) else {
        return CompatibilityPolicy::baseline();
    };
    AdoptionRepository::new(database)
        .find_compatibility_policy()
        .await
        .ok()
        .flatten()
        .unwrap_or_else(CompatibilityPolicy::baseline)
}

async fn require_record(
    context: &RequestContext,
    repository: &AdoptionRepository<'_>,
    org_id: &str,
    adoption_state_id: &str,
) -> Result<AdoptionStateRecord, ApiError> {
    repository
        .find_by_id(adoption_state_id, org_id)
        .await
        .map_err(|error| database_error(context, error))?
        .ok_or_else(|| not_found(context, "adoption_state_not_found"))
}

/// The org facts an import preview is judged against, read from the P06
/// automations and entitlements tables rather than asserted by the client.
async fn import_context(
    state: &Arc<AppState>,
    context: &RequestContext,
    org_id: &str,
    project_bound: bool,
) -> Result<crate::modules::migration::ImportPolicyContext, ApiError> {
    let database = database(state, context)?;
    let repository = AdoptionRepository::new(database);
    let limits = repository
        .automation_import_limits(org_id, context.received_at.as_str())
        .await
        .map_err(|error| database_error(context, error))?;
    let allowed_tools = repository
        .organization_allowed_tools(org_id)
        .await
        .map_err(|error| database_error(context, error))?;
    // The org tool policy is published per organization and per project. The
    // preview can only see the organization-scope document, so a candidate that
    // needs a tool the org document does not name is reported as a conflict, and
    // a project may narrow the set further at dispatch. That asymmetry is
    // deliberate and is stated in the response: the preview is an upper bound on
    // what will run, never a promise.
    Ok(crate::modules::migration::ImportPolicyContext {
        automations_available: limits.automations_available,
        max_active_automations: limits.max_active_automations,
        active_automations: limits.active_automations,
        off_peak_available: limits.off_peak_available,
        allowed_tools,
        // Model capability requirements are not judged here. P04 owns the route
        // catalog, and a capability set assembled from it here would be a second
        // source of truth for "which models can do what". The preview reports the
        // check as deferred so the user is not told a capability is available
        // when the catalog is what decides at dispatch.
        available_model_capabilities: ALL_MODEL_CAPABILITIES
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        local_credential_permitted: limits.local_credential_permitted,
        workspace_bound: project_bound,
    })
}

/// Resolve whether the previewing workspaces are bound to a project.
///
/// An empty list is treated as unbound, which is the restrictive reading: a
/// preview that claims to be for no particular workspace has not shown anything
/// about binding.
async fn project_bound_for(
    state: &Arc<AppState>,
    context: &RequestContext,
    org_id: &str,
    body: &ImportPreviewRequest,
) -> Result<bool, ApiError> {
    if body.adoption_state_ids.is_empty() {
        return Ok(false);
    }
    let database = database(state, context)?;
    let repository = AdoptionRepository::new(database);
    for id in &body.adoption_state_ids {
        let record = require_record(context, &repository, org_id, id).await?;
        if !record.is_managed() || record.bound_project_id.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn derive_for(
    row: &AdoptionStateRecord,
    policy: &CompatibilityPolicy,
) -> Vec<crate::modules::migration::Remediation> {
    let version_at_least = crate::modules::devices::version_at_least(
        &row.client_app_version,
        crate::modules::migration::MIN_CLIENT_APP_VERSION,
    );
    let verdict = ClientFingerprint {
        protocol_major: row.client_protocol_major,
        policy_schema_version: row.policy_schema_version,
        app_version: row.client_app_version.clone(),
    };
    derive_remediations(&MigrationObservation {
        adopted: row.is_adopted(),
        client_managed: row.is_managed(),
        client_build_current: version_at_least && policy.evaluate(&verdict).managed_allowed(),
        // The stored record has no policy-ack column of its own: P03 owns
        // `policy_acks`, and an enrolled workspace that never acked is reported
        // by the caller that has the ack. A managed workspace with a current
        // policy version is treated as acknowledged here, and the remediation
        // for a failed sync is owned by the device path.
        policy_acknowledged: true,
        credential_mode: row
            .credential_mode()
            .unwrap_or(CredentialMode::LocalCredential),
        required_capabilities_permitted: true,
        project_bound: row.bound_project_id.is_some(),
    })
}

fn binding_json(row: &AdoptionStateRecord) -> Value {
    json!({
        "adoption_state_id": row.adoption_state_id,
        "org_id": row.org_id,
        "external_installation_id": row.external_installation_id,
        "external_workspace_key": row.external_workspace_key,
        "display_name": row.display_name,
        "bound_project_id": row.bound_project_id,
        "bound_device_id": row.bound_device_id,
        "stage": row.stage,
        "ownership": row.ownership,
        "credential_mode": row.credential_mode,
        "rolled_back_from_stage": row.rolled_back_from_stage,
        "client_protocol_major": row.client_protocol_major,
        "policy_schema_version": row.policy_schema_version,
        "client_app_version": row.client_app_version,
        "reversion_count": row.reversion_count,
        "is_adopted": row.is_adopted(),
        "is_managed": row.is_managed(),
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    })
}

fn remediation_json(row: &RemediationRecord) -> Value {
    json!({
        "remediation_id": row.remediation_id,
        "adoption_state_id": row.adoption_state_id,
        "device_id": row.device_id,
        "code": row.code,
        "remedy": row.remedy,
        "stage": row.stage,
        "state": row.state,
        "resolved_by_user_id": row.resolved_by_user_id,
        "resolved_at": row.resolved_at,
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    })
}

fn validate_version(context: &RequestContext, value: i64) -> Result<(), ApiError> {
    if value <= 0 || value == i64::MAX {
        return Err(validation_error(
            context,
            "version_invalid",
            "The adoption version is invalid.",
        ));
    }
    Ok(())
}

fn page_limit(requested: Option<i64>, ceiling: usize) -> i64 {
    match requested {
        Some(value) if value > 0 => value.min(ceiling as i64),
        _ => ceiling as i64,
    }
}

fn status_code(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::OK)
}

fn database_error(context: &RequestContext, error: worker::Error) -> ApiError {
    crate::routes::support::database_error(context, error)
}

#[allow(clippy::too_many_arguments)]
fn support_security_statement(
    database: &crate::adapters::d1::D1Adapter,
    context: &RequestContext,
    org_id: &str,
    principal: &crate::core::Principal,
    action: &str,
    resource_type: &str,
    resource_id: &str,
    metadata: &Value,
) -> Result<worker::d1::D1PreparedStatement, ApiError> {
    let event_id = crate::adapters::new_event_id();
    crate::routes::support::security_event_statement(
        database,
        context,
        Some(principal),
        Some(org_id),
        event_id.as_str(),
        action,
        resource_type,
        Some(resource_id),
        "success",
        metadata,
    )
}

fn adoption_failure(
    context: &RequestContext,
    error: AdoptionError,
    code: ApiErrorCode,
) -> ApiError {
    let message = match error {
        AdoptionError::StageNotAdvanceable => {
            "A migration stage can only be entered one step at a time."
        }
        AdoptionError::HistorySyncUnavailable => {
            "History sync is not available for this organization yet."
        }
        AdoptionError::HistorySyncRequiresManagedCredential => {
            "History sync requires a credential mode other than the local key."
        }
        AdoptionError::BindingIncomplete => {
            "A managed workspace requires a bound project and device."
        }
        AdoptionError::CredentialModeRequiresManaged => {
            "An organization-managed credential requires a bound workspace."
        }
        AdoptionError::AlreadyLocal => "This workspace is already unmanaged.",
        AdoptionError::InvalidExternalReference => "The local workspace reference is invalid.",
        AdoptionError::TelemetryFieldUnknown => {
            "The migration report contained a field Lumi Agents does not accept."
        }
        AdoptionError::TelemetryTooLarge => "The migration report is too large.",
        AdoptionError::ImportTooLarge => "Too many automations were supplied.",
    };
    errors::api_error(context, code, message).with_detail("reason", json!(error.code()))
}
