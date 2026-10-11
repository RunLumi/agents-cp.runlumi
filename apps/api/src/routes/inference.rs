use std::{cell::Cell, rc::Rc, sync::Arc, time::Duration};

use axum::{
    Json,
    body::Body,
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, Response},
    response::IntoResponse,
};
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use worker::AbortSignal;

use crate::{
    adapters::{
        add_seconds,
        crypto::decrypt_secret,
        d1::BindValue,
        execution::{
            BackgroundWork, LatchClaim, PullScope, StreamClock, Watchdog,
            schedule_cancel_settlement, trace_inline, trace_lifecycle, watchdog_delay_ms,
        },
        new_resource_id,
        providers::{AdapterKind, dispatch},
    },
    app::AppState,
    core::{ApiError, ApiErrorCode, Principal, RequestContext, Timestamp},
    http::auth::require_csrf,
    modules::{
        authorization::Permission,
        budget_p05::{
            BudgetDecision as P05BudgetDecision, BudgetEvaluationRequest, BudgetKind, BudgetPolicy,
            BudgetScope, MAX_RESERVATION_MINOR, ScopeContext, evaluate_budget_request,
        },
        catalog::{CatalogLifecycle, CatalogPolicy, ModelCapabilities, ModelCapability},
        credentials::{
            CredentialMetadata, CredentialMode, CredentialOwnerType, CredentialStatus,
            can_resolve_credential,
        },
        inference::{
            AdapterError, AdapterErrorKind, AdapterStreamState, ContentPart, InferenceMessage,
            InferenceRequest, MAX_TOOL_ARGUMENTS_BYTES, MAX_TOOL_CALLS, MessageRole,
            ProviderStreamEvent, ProviderUsage, RetryController, SseDecoder, ToolCall,
            ToolCallTracker, decode_message_tool_calls, valid_tool_call_id, valid_tool_name,
        },
        policy_p04::PolicySnapshotEnvelope,
        policy_p05 as p05_policy,
        rate_limits::{
            RateLimitDecision, RateLimitDimension, RateLimitPolicy, RateLimitPolicyState,
            RateLimitRequest, RateLimitUsage, evaluate_rate_limit_states,
        },
        routing::{RouteConfig, SelectedCandidate, select_candidates, validate_route_config},
        runs::RunState,
    },
    repositories::{
        AgentSessionRecord, AiRepository, BudgetRepository, BudgetScopeSnapshot, CredentialRecord,
        DeviceRecord, DeviceRepository, ModelRecord, NewReservationInput, PolicyRecord,
        PolicyRepository, ProjectRepository, ProviderRecord, ReservationReconcileInput, RunRecord,
        RunRepository,
    },
    routes::{
        agents::{can_manage_projects, ensure_project_access},
        authorization::authorize_org,
        errors,
        support::{
            SecurityEventId, database, database_error, domain_error, outbox_statement,
            security_event_statement_with_context,
        },
    },
};

const P05_BUDGET_SNAPSHOT_LIMIT: i32 = 128;
const P05_RATE_POLICY_LIMIT: i32 = 100;
const P05_RESERVATION_TTL_SECONDS: u32 = 3_600;
const P05_MAX_RESERVATION_TOKENS: u64 = 1_000_000;
const MAX_INFERENCE_TOOLS: usize = 128;

/// P05 adds server-owned correlation columns to the P04 request projection. The
/// P04 repository still owns the base insert; this additive statement binds the
/// run-derived identity immediately afterwards in the same D1 batch. Keeping
/// this here avoids making a client-supplied project/device/session authoritative.
const ATTACH_MANAGED_INFERENCE_IDENTITY_SQL: &str = r#"
UPDATE inference_requests
SET agent_session_id = ?1,
    agent_definition_id = ?2,
    agent_definition_version = ?3
WHERE request_id = ?4 AND org_id = ?5 AND run_id = ?6
"#;

const ATTACH_MANAGED_RUN_POLICY_SQL: &str = r#"
UPDATE runs
SET policy_snapshot_id = ?1,
    policy_version = ?2
WHERE run_id = ?3 AND org_id = ?4
  AND (
    policy_snapshot_id IS NULL
    OR (policy_snapshot_id = ?1 AND policy_version = ?2)
  )
"#;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InferenceQuery {
    pub limit: Option<u16>,
    pub cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRequest {
    pub model: String,
    pub messages: Vec<NativeMessage>,
    pub required_capabilities: Option<Vec<String>>,
    pub stream: Option<bool>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub tools: Option<Vec<Value>>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub agent_session_id: Option<String>,
    pub run_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeMessage {
    pub role: String,
    pub content: Vec<NativeContentPart>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeContentPart {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: Option<bool>,
    /// Standard OpenAI-compatible streaming usage negotiation. The gateway
    /// accounts usage server-side; accepting this lets SDK clients request a
    /// usage chunk while using the same streamed response path.
    pub stream_options: Option<ChatStreamOptions>,
    /// OpenAI SDKs send `auto` whenever tool definitions are present. Other
    /// tool-choice modes are rejected until the control-plane request model
    /// carries and enforces them end to end.
    pub tool_choice: Option<Value>,
    pub max_tokens: Option<u32>,
    pub max_completion_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub tools: Option<Vec<Value>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatStreamOptions {
    pub include_usage: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: String,
    /// Null (or absent) is valid only for an assistant message with calls.
    #[serde(default)]
    pub content: Value,
    pub tool_calls: Option<Vec<ChatToolCall>>,
    pub tool_call_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ChatToolCallFunction,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResponseFormat {
    Native,
    Chat,
    ChatWithUsage,
}

#[derive(Clone, Default)]
struct InferenceCorrelationTarget {
    project_id: Option<String>,
    run_id: Option<String>,
    agent_session_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct P05InferenceCorrelation {
    project_id: String,
    device_id: String,
    agent_session_id: String,
    run_id: String,
    agent_definition_id: String,
    agent_definition_version: i64,
}

fn valid_p05_opaque_id(value: &str, prefix: &str) -> bool {
    value.len() == 36
        && value.starts_with(&format!("{prefix}_"))
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// P05 IDs are lookup hints only. Require a complete tuple and let the caller
/// cross-check every field against D1 before route selection or provider I/O.
fn merge_p05_inference_headers(
    headers: &HeaderMap,
    target: &mut InferenceCorrelationTarget,
) -> Result<Option<P05InferenceCorrelation>, ()> {
    const NAMES: [&str; 7] = [
        "x-project-id",
        "x-device-id",
        "x-agent-session-id",
        "x-run-id",
        "x-agent-definition-id",
        "x-agent-definition-version",
        "x-lumi-execution-mode",
    ];
    if !NAMES.iter().any(|name| headers.contains_key(*name)) {
        return Ok(None);
    }
    let header = |name: &str| -> Result<&str, ()> {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .ok_or(())
    };
    let project_id = header("x-project-id")?;
    let device_id = header("x-device-id")?;
    let agent_session_id = header("x-agent-session-id")?;
    let run_id = header("x-run-id")?;
    let agent_definition_id = header("x-agent-definition-id")?;
    let version_raw = header("x-agent-definition-version")?;
    if header("x-lumi-execution-mode")? != "managed"
        || !valid_p05_opaque_id(project_id, "prj")
        || !valid_p05_opaque_id(device_id, "dvc")
        || !valid_p05_opaque_id(agent_session_id, "rse")
        || !valid_p05_opaque_id(run_id, "run")
        || !valid_p05_opaque_id(agent_definition_id, "agd")
    {
        return Err(());
    }
    let agent_definition_version = version_raw.parse::<i64>().map_err(|_| ())?;
    if agent_definition_version <= 0 || agent_definition_version.to_string() != version_raw {
        return Err(());
    }
    if target
        .project_id
        .as_deref()
        .is_some_and(|value| value != project_id)
        || target
            .run_id
            .as_deref()
            .is_some_and(|value| value != run_id)
        || target
            .agent_session_id
            .as_deref()
            .is_some_and(|value| value != agent_session_id)
    {
        return Err(());
    }
    target.project_id = Some(project_id.to_owned());
    target.run_id = Some(run_id.to_owned());
    target.agent_session_id = Some(agent_session_id.to_owned());
    Ok(Some(P05InferenceCorrelation {
        project_id: project_id.to_owned(),
        device_id: device_id.to_owned(),
        agent_session_id: agent_session_id.to_owned(),
        run_id: run_id.to_owned(),
        agent_definition_id: agent_definition_id.to_owned(),
        agent_definition_version,
    }))
}

struct ManagedRunScope {
    run: RunRecord,
    session: AgentSessionRecord,
    device: DeviceRecord,
    policy_snapshot: PolicySnapshotEnvelope,
}

#[derive(Clone)]
struct RequestScope {
    request_id: String,
    org_id: String,
    project_id: Option<String>,
    session_id: String,
    device_id: Option<String>,
    run_id: Option<String>,
    agent_session_id: Option<String>,
    agent_definition_id: Option<String>,
    agent_definition_version: Option<i64>,
    workspace_binding_id: Option<String>,
    policy_snapshot_id: Option<String>,
    policy_version: Option<i64>,
    managed_run: bool,
    model_alias: String,
    route_id: String,
    route_version_id: String,
    route_version_number: i64,
    reservation_id: String,
    reserved_minor: i64,
    budget_id: Option<String>,
    currency: String,
    principal_user_id: String,
    credential_mode: CredentialMode,
}

#[derive(Clone)]
struct StreamMetadata {
    request_id: String,
    format: ResponseFormat,
    model_alias: String,
    route_version_id: String,
    route_version_number: i64,
    reservation_id: String,
    reserved_minor: i64,
    budget_id: Option<String>,
    currency: String,
    provider_id: String,
    model_id: String,
    provider_request_id: Option<String>,
    fallback_count: i64,
    project_id: Option<String>,
    run_id: Option<String>,
    session_id: String,
    device_id: Option<String>,
    agent_session_id: Option<String>,
    agent_definition_id: Option<String>,
    agent_definition_version: Option<i64>,
    workspace_binding_id: Option<String>,
    policy_snapshot_id: Option<String>,
    policy_version: Option<i64>,
    managed_run: bool,
    principal_user_id: String,
    org_id: String,
    credential_id: Option<String>,
    budget_decision: String,
    started_at_ms: f64,
    deadline_at_ms: f64,
    ttft_ms: Option<i64>,
    total_latency_ms: Option<i64>,
    health_observed: bool,
}

struct StreamState {
    provider_stream: futures_util::stream::LocalBoxStream<'static, Result<Vec<u8>, worker::Error>>,
    decoder: SseDecoder,
    adapter_state: AdapterStreamState,
    usage: Option<ProviderUsage>,
    metadata: StreamMetadata,
    database: Arc<crate::adapters::d1::D1Adapter>,
    context: RequestContext,
    caller_signal: Option<AbortSignal>,
    first_chunk: Option<Vec<u8>>,
    started: bool,
    ended: bool,
    failed: bool,
    finalized: Rc<Cell<bool>>,
    clock: StreamClock,
    pulls: u8,
    _cancellation_guard: StreamCancellationGuard,
    first_output_at: Option<String>,
    tool_calls: ToolCallTracker,
    /// Bounded timer task that settles the request if no other path does.
    _watchdog: Watchdog,
}

struct StreamCancellationGuard {
    database: Arc<crate::adapters::d1::D1Adapter>,
    context: RequestContext,
    metadata: StreamMetadata,
    finalized: Rc<Cell<bool>>,
    background: BackgroundWork,
    clock: StreamClock,
}

impl Drop for StreamCancellationGuard {
    fn drop(&mut self) {
        trace_lifecycle(
            self.clock,
            if self.finalized.get() {
                "state_drop:settled"
            } else {
                "state_drop:unsettled"
            },
        );
        schedule_cancel_settlement(
            &self.background,
            self.finalized.clone(),
            cancel_settlement(
                self.database.clone(),
                self.context.clone(),
                self.metadata.clone(),
            ),
        );
    }
}

type SettlementFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>>>>;

/// The D1 settlement for a request whose caller went away. It yields only the
/// stable error code so a failure is visible without carrying request data.
fn cancel_settlement(
    database: Arc<crate::adapters::d1::D1Adapter>,
    context: RequestContext,
    metadata: StreamMetadata,
) -> impl FnOnce() -> SettlementFuture {
    move || {
        Box::pin(async move {
            finalize_request(
                database.as_ref(),
                &context,
                &metadata,
                None,
                None,
                context.received_at.as_str(),
                false,
                Some("request_cancelled"),
            )
            .await
            .map_err(|error| error.error.code.as_str().to_owned())
        })
    }
}

#[worker::send]
pub async fn models(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Query(query): Query<InferenceQuery>,
) -> Result<Response<Body>, ApiError> {
    let offset = cursor_offset(&context, query.cursor.as_deref())?;
    let limit = page_limit(query.limit);
    let org_id = required_org_id(&headers, &context)?;
    authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::ModelsRead,
        Some("model_alias"),
        None,
    )
    .await?;
    let database = database(&state, &context)?;
    let repository = AiRepository::new(database);
    let policy_record = repository
        .find_policy(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    let (policy, _) = policy_from_record(policy_record.as_ref(), state.environment.as_str());
    let aliases = repository
        .list_aliases()
        .await
        .map_err(|error| database_error(&context, error))?;
    let routes = repository
        .list_routes(&org_id, 1000, 0)
        .await
        .map_err(|error| database_error(&context, error))?;
    let route_by_alias = routes
        .into_iter()
        .map(|route| (route.alias.clone(), route))
        .collect::<std::collections::BTreeMap<_, _>>();
    let all_items = aliases
        .into_iter()
        .filter(|alias| alias.lifecycle != "disabled" && policy.allows_alias(&alias.alias_key))
        .map(|alias| {
            let route = route_by_alias.get(&alias.alias_key);
            json!({
                "alias": alias.alias_key,
                "display_name": alias.display_name,
                "lifecycle": alias.lifecycle,
                "description": alias.description,
                "route_id": route.map(|value| value.route_id.as_str()),
                "route_version_id": route.and_then(|value| value.active_version_id.as_deref()),
                "available": route.is_some_and(|value| value.lifecycle == "published"),
            })
        })
        .collect::<Vec<_>>();
    let start = usize::try_from(offset).unwrap_or(usize::MAX);
    let remaining = all_items.into_iter().skip(start).collect::<Vec<_>>();
    let (items, next_cursor, has_more) = page_window(remaining, limit, offset);
    Ok(
        Json(json!({"items": items, "next_cursor": next_cursor, "has_more": has_more}))
            .into_response(),
    )
}

#[worker::send]
pub async fn route(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(alias): Path<String>,
) -> Result<Response<Body>, ApiError> {
    let org_id = required_org_id(&headers, &context)?;
    authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::RoutesRead,
        Some("route"),
        Some(&alias),
    )
    .await?;
    let database = database(&state, &context)?;
    let repository = AiRepository::new(database);
    let policy_record = repository
        .find_policy(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    let (policy, _) = policy_from_record(policy_record.as_ref(), state.environment.as_str());
    if !policy.allows_alias(&alias) {
        return Err(gateway_error(&context, "model_not_allowed"));
    }
    let route = repository
        .find_route_by_alias(&org_id, &alias)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| gateway_error(&context, "route_unavailable"))?;
    let version = repository
        .find_route_version(
            &org_id,
            route
                .active_version_id
                .as_deref()
                .ok_or_else(|| gateway_error(&context, "route_unavailable"))?,
        )
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| gateway_error(&context, "route_unavailable"))?;
    let config = serde_json::from_str::<Value>(&version.config_json)
        .map_err(|_| gateway_error(&context, "route_unavailable"))?;
    Ok(Json(json!({
        "route": {"route_id": route.route_id, "alias": route.alias, "display_name": route.display_name, "strategy": route.strategy, "lifecycle": route.lifecycle, "version": route.version},
        "version": {"route_version_id": version.route_version_id, "version": version.version_number, "config": config, "published_at": version.published_at}
    }))
    .into_response())
}

#[worker::send]
pub async fn responses(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    Extension(caller_signal): Extension<AbortSignal>,
    policy_snapshot: Option<Extension<PolicySnapshotEnvelope>>,
    headers: HeaderMap,
    Json(body): Json<NativeRequest>,
) -> Result<Response<Body>, ApiError> {
    let requested_agent_session_id = body.agent_session_id.clone();
    let request = native_request(body, &context)?;
    run_inference(
        state,
        context,
        headers,
        request,
        ResponseFormat::Native,
        Some(&caller_signal),
        requested_agent_session_id.as_deref(),
        policy_snapshot.as_ref().map(|extension| &extension.0),
    )
    .await
}

#[worker::send]
pub async fn chat_completions(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<RequestContext>,
    Extension(caller_signal): Extension<AbortSignal>,
    policy_snapshot: Option<Extension<PolicySnapshotEnvelope>>,
    headers: HeaderMap,
    Json(body): Json<ChatRequest>,
) -> Result<Response<Body>, ApiError> {
    let chat_stream_usage = body.stream.unwrap_or(false)
        && body
            .stream_options
            .as_ref()
            .is_some_and(|options| options.include_usage == Some(true));
    let request = chat_request(body, &context)?;
    run_inference(
        state,
        context,
        headers,
        request,
        if chat_stream_usage {
            ResponseFormat::ChatWithUsage
        } else {
            ResponseFormat::Chat
        },
        Some(&caller_signal),
        None,
        policy_snapshot.as_ref().map(|extension| &extension.0),
    )
    .await
}

async fn load_trusted_policy_snapshot(
    database: &crate::adapters::d1::D1Adapter,
    org_id: &str,
    context: &RequestContext,
) -> Result<Option<PolicySnapshotEnvelope>, ApiError> {
    let Some(snapshot) = PolicyRepository::new(database)
        .latest_snapshot(org_id)
        .await
        .map_err(|error| database_error(context, error))?
    else {
        return Ok(None);
    };
    if snapshot.org_id != org_id || snapshot.policy_version <= 0 {
        return Err(gateway_error(context, "model_not_allowed"));
    }
    if snapshot.expires_at.as_str() <= context.received_at.as_str() {
        return Err(gateway_error(context, "model_not_allowed"));
    }
    let payload = serde_json::from_str::<Value>(&snapshot.payload)
        .map_err(|_| gateway_error(context, "model_not_allowed"))?;
    Ok(Some(PolicySnapshotEnvelope {
        policy_id: snapshot.policy_id,
        org_id: snapshot.org_id,
        policy_version: snapshot.policy_version,
        payload,
    }))
}

#[derive(Clone)]
struct P05BudgetAdmission {
    decision: P05BudgetDecision,
    budget_id: Option<String>,
    currency: String,
}

#[derive(Clone)]
struct P05RateAdmission {
    decision: RateLimitDecision,
}

fn p05_error(
    context: &RequestContext,
    code: ApiErrorCode,
    reason: &'static str,
    message: &'static str,
) -> ApiError {
    domain_error(context, code, reason, message)
}

fn p05_not_found(context: &RequestContext, reason: &'static str) -> ApiError {
    p05_error(
        context,
        ApiErrorCode::NotFound,
        reason,
        "The requested run context was not found.",
    )
}

fn p05_scope_error(context: &RequestContext) -> ApiError {
    p05_error(
        context,
        ApiErrorCode::PermissionDenied,
        "resource_scope_mismatch",
        "The run is outside the current execution scope.",
    )
}

fn p05_policy_unavailable(context: &RequestContext) -> ApiError {
    p05_error(
        context,
        ApiErrorCode::ServiceUnavailable,
        "policy_state_unavailable",
        "The current execution policy is unavailable.",
    )
}

fn p05_budget_unavailable(context: &RequestContext) -> ApiError {
    p05_error(
        context,
        ApiErrorCode::ServiceUnavailable,
        "budget_state_unavailable",
        "The authoritative budget state is unavailable.",
    )
}

fn p05_rate_unavailable(context: &RequestContext) -> ApiError {
    p05_error(
        context,
        ApiErrorCode::ServiceUnavailable,
        "rate_limit_state_unavailable",
        "The authoritative rate-limit state is unavailable.",
    )
}

/// Normalize the timestamp forms accepted by the P04/P05 schema before using
/// them in Rust-side period arithmetic or fixed-width D1 comparisons.
fn canonical_instant_text(value: &str) -> Option<String> {
    let normalized = if value.len() == 24 && value.ends_with('Z') {
        value.to_owned()
    } else {
        let head = value.get(..19)?;
        let suffix = value.get(19..)?;
        if suffix == "Z" {
            format!("{head}.000Z")
        } else {
            let fraction = suffix.strip_prefix('.')?.strip_suffix('Z')?;
            if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let mut milliseconds = fraction.chars().take(3).collect::<String>();
            while milliseconds.len() < 3 {
                milliseconds.push('0');
            }
            format!("{head}.{milliseconds}Z")
        }
    };
    Timestamp::new(normalized.clone()).ok()?;
    Some(normalized)
}

/// Convert a validated UTC instant to Unix seconds without relying on a local
/// timezone or a JavaScript clock. P05 budget/rate evaluators only need a
/// monotonic numeric projection of the server timestamp.
fn epoch_seconds(value: &str) -> Option<u64> {
    Timestamp::new(value).ok()?;
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number =
        |start: usize, end: usize| -> Option<i64> { value.get(start..end)?.parse::<i64>().ok() };
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    if !(1..=12).contains(&month)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(hour * 3_600)?
        .checked_add(minute * 60)?
        .checked_add(second)?;
    u64::try_from(seconds).ok()
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn p05_policy_scope_matches(payload: &Value, project_id: &str, device_id: &str) -> bool {
    let member_active = payload
        .get("org_access")
        .and_then(|value| value.get("member"))
        .and_then(Value::as_bool)
        == Some(true);
    if !member_active {
        return false;
    }
    let project_matches = if let Some(value) = payload.get("project_id") {
        value.as_str() == Some(project_id)
    } else {
        payload
            .get("projects")
            .and_then(|value| value.get("bindings"))
            .and_then(Value::as_array)
            .is_some_and(|bindings| {
                !bindings.is_empty()
                    && bindings.iter().all(Value::is_string)
                    && bindings
                        .iter()
                        .any(|value| value.as_str() == Some(project_id))
            })
    };
    let device_matches = match payload.get("device_id") {
        Some(value) => value.as_str() == Some(device_id),
        None => match payload.get("device") {
            Some(device) => device.get("id").and_then(Value::as_str) == Some(device_id),
            None => true,
        },
    };
    project_matches && device_matches
}

fn validate_p05_policy_sections(payload: &Value, context: &RequestContext) -> Result<(), ApiError> {
    let budgets = payload
        .get("budgets")
        .ok_or_else(|| p05_budget_unavailable(context))?;
    if p05_policy::is_opaque_placeholder(Some(budgets))
        || p05_policy::budget_policy(payload).is_none()
    {
        return Err(p05_budget_unavailable(context));
    }
    let rate_limits = payload
        .get("rate_limits")
        .ok_or_else(|| p05_rate_unavailable(context))?;
    if p05_policy::is_opaque_placeholder(Some(rate_limits))
        || p05_policy::rate_limit_policy(payload).is_none()
    {
        return Err(p05_rate_unavailable(context));
    }
    Ok(())
}

async fn load_managed_policy_snapshot(
    database: &crate::adapters::d1::D1Adapter,
    org_id: &str,
    project_id: &str,
    device_id: &str,
    context: &RequestContext,
) -> Result<PolicySnapshotEnvelope, ApiError> {
    let snapshot = PolicyRepository::new(database)
        .latest_snapshot(org_id)
        .await
        .map_err(|_| p05_policy_unavailable(context))?
        .ok_or_else(|| p05_policy_unavailable(context))?;
    let now = canonical_instant_text(context.received_at.as_str())
        .ok_or_else(|| p05_policy_unavailable(context))?;
    let expires_at = canonical_instant_text(snapshot.expires_at.as_str())
        .ok_or_else(|| p05_policy_unavailable(context))?;
    if snapshot.org_id != org_id || snapshot.policy_version <= 0 || expires_at <= now {
        return Err(p05_policy_unavailable(context));
    }
    let payload = serde_json::from_str::<Value>(&snapshot.payload)
        .map_err(|_| p05_policy_unavailable(context))?;
    if !p05_policy_scope_matches(&payload, project_id, device_id) {
        return Err(p05_scope_error(context));
    }
    validate_p05_policy_sections(&payload, context)?;
    Ok(PolicySnapshotEnvelope {
        policy_id: snapshot.policy_id,
        org_id: snapshot.org_id,
        policy_version: snapshot.policy_version,
        payload,
    })
}

#[allow(clippy::too_many_arguments)]
async fn resolve_managed_run_scope(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    context: &RequestContext,
    principal: &Principal,
    org_id: &str,
    run_id: &str,
    model_alias: &str,
    requested_agent_session_id: Option<&str>,
) -> Result<ManagedRunScope, ApiError> {
    let database = database(state, context)?;
    let runs = RunRepository::new(database);
    let run = runs
        .find_run(org_id, run_id)
        .await
        .map_err(|_| {
            p05_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "run_state_unavailable",
                "The run state is unavailable.",
            )
        })?
        .ok_or_else(|| p05_not_found(context, "run_not_found"))?;
    if run.org_id != org_id
        || run.principal_user_id != principal.user_id.as_str()
        || run.model_alias.as_deref() != Some(model_alias)
        || requested_agent_session_id.is_some_and(|session_id| session_id != run.agent_session_id)
    {
        return Err(p05_scope_error(context));
    }
    let run_state = RunState::parse(&run.state).ok_or_else(|| {
        p05_error(
            context,
            ApiErrorCode::ServiceUnavailable,
            "run_state_unavailable",
            "The run state is unavailable.",
        )
    })?;
    if run_state.is_terminal() {
        return Err(p05_error(
            context,
            ApiErrorCode::Conflict,
            "run_terminal",
            "The run is already terminal.",
        ));
    }

    let session = runs
        .find_session(org_id, &run.agent_session_id)
        .await
        .map_err(|_| {
            p05_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "session_state_unavailable",
                "The agent session state is unavailable.",
            )
        })?
        .ok_or_else(|| p05_not_found(context, "session_not_found"))?;
    if session.project_id != run.project_id
        || session.device_id != run.device_id
        || session.agent_definition_id != run.agent_definition_id
        || session.agent_definition_version != run.agent_definition_version
        || session.workspace_binding_id != run.workspace_binding_id
        || session.lifecycle != "active"
    {
        return Err(if session.lifecycle != "active" {
            p05_error(
                context,
                ApiErrorCode::Conflict,
                "session_closed",
                "The agent session is closed.",
            )
        } else {
            p05_scope_error(context)
        });
    }

    let project = ProjectRepository::new(database)
        .find_project(&run.project_id)
        .await
        .map_err(|_| {
            p05_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "project_state_unavailable",
                "The project state is unavailable.",
            )
        })?
        .filter(|project| project.org_id == org_id)
        .ok_or_else(|| p05_not_found(context, "project_not_found"))?;
    if project.archived_at.is_some() {
        return Err(p05_error(
            context,
            ApiErrorCode::Conflict,
            "project_archived",
            "The project is archived.",
        ));
    }
    let manager = can_manage_projects(state, headers, context, org_id).await;
    ensure_project_access(
        database,
        context,
        org_id,
        &run.project_id,
        principal.user_id.as_str(),
        manager,
    )
    .await?;

    let device = DeviceRepository::new(database)
        .find_device(&run.device_id)
        .await
        .map_err(|_| {
            p05_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "device_state_unavailable",
                "The execution device state is unavailable.",
            )
        })?
        .filter(|device| device.org_id == org_id)
        .ok_or_else(|| p05_not_found(context, "device_not_found"))?;
    if device.status != "active" {
        return Err(p05_error(
            context,
            ApiErrorCode::PermissionDenied,
            "device_revoked",
            "The execution device is not active.",
        ));
    }

    if let Some(binding_id) = session.workspace_binding_id.as_deref() {
        let binding = ProjectRepository::new(database)
            .find_binding(binding_id)
            .await
            .map_err(|_| {
                p05_error(
                    context,
                    ApiErrorCode::ServiceUnavailable,
                    "workspace_binding_unavailable",
                    "The workspace binding state is unavailable.",
                )
            })?
            .ok_or_else(|| {
                p05_error(
                    context,
                    ApiErrorCode::NotFound,
                    "workspace_binding_mismatch",
                    "The workspace binding is not available.",
                )
            })?;
        if binding.org_id != org_id
            || binding.project_id != run.project_id
            || binding.device_id != run.device_id
        {
            return Err(p05_error(
                context,
                ApiErrorCode::PermissionDenied,
                "workspace_binding_mismatch",
                "The workspace binding is outside the run scope.",
            ));
        }
    }

    let agent = runs
        .find_agent(org_id, &run.agent_definition_id)
        .await
        .map_err(|_| {
            p05_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "agent_state_unavailable",
                "The agent state is unavailable.",
            )
        })?
        .ok_or_else(|| p05_not_found(context, "agent_not_found"))?;
    if agent.lifecycle != "active"
        || agent
            .project_id
            .as_deref()
            .is_some_and(|project_id| project_id != run.project_id)
    {
        return Err(p05_not_found(context, "agent_not_found"));
    }

    let policy_snapshot =
        load_managed_policy_snapshot(database, org_id, &run.project_id, &run.device_id, context)
            .await?;
    if run
        .policy_snapshot_id
        .as_deref()
        .is_some_and(|policy_id| policy_id != policy_snapshot.policy_id)
        || run
            .policy_version
            .is_some_and(|version| version <= 0 || version != policy_snapshot.policy_version)
    {
        return Err(p05_policy_unavailable(context));
    }

    Ok(ManagedRunScope {
        run,
        session,
        device,
        policy_snapshot,
    })
}

fn nonnegative_u64(value: i64) -> Option<u64> {
    u64::try_from(value).ok()
}

fn budget_policy_from_snapshot(snapshot: &BudgetScopeSnapshot) -> Result<BudgetPolicy, ()> {
    if snapshot.org_id.is_empty() {
        return Err(());
    }
    let scope = BudgetScope::from_parts(
        &snapshot.scope_type,
        &snapshot.org_id,
        snapshot.scope_id.as_deref(),
    )
    .map_err(|_| ())?;
    let limit_minor = nonnegative_u64(snapshot.limit_minor).ok_or(())?;
    let spent_minor = nonnegative_u64(snapshot.spent_minor).ok_or(())?;
    let live_reserved_minor = nonnegative_u64(snapshot.live_reserved_minor).ok_or(())?;
    let period_start = canonical_instant_text(&snapshot.period_start)
        .and_then(|value| epoch_seconds(&value))
        .ok_or(())?;
    let period_end = canonical_instant_text(&snapshot.period_end)
        .and_then(|value| epoch_seconds(&value))
        .ok_or(())?;
    let kind = if snapshot.hard {
        BudgetKind::Hard
    } else {
        BudgetKind::Soft
    };
    BudgetPolicy::new(scope, kind, limit_minor)
        .with_usage(spent_minor, live_reserved_minor)
        .try_with_period(period_start, period_end)
        .map_err(|_| ())
}

fn most_restrictive_budget_id(snapshots: &[BudgetScopeSnapshot]) -> Option<String> {
    snapshots
        .iter()
        .filter(|snapshot| snapshot.hard)
        .min_by(|left, right| {
            let left_remaining = left.remaining_minor().unwrap_or(i64::MIN);
            let right_remaining = right.remaining_minor().unwrap_or(i64::MIN);
            left_remaining
                .cmp(&right_remaining)
                .then_with(|| left.budget_id.cmp(&right.budget_id))
        })
        .map(|snapshot| snapshot.budget_id.clone())
}

async fn p05_budget_admission(
    database: &crate::adapters::d1::D1Adapter,
    context: &RequestContext,
    org_id: &str,
    project_id: &str,
    principal_user_id: &str,
    model_alias: &str,
    requested_minor: u64,
) -> Result<P05BudgetAdmission, ApiError> {
    if requested_minor == 0 || requested_minor > MAX_RESERVATION_MINOR {
        return Err(p05_budget_unavailable(context));
    }
    let now = epoch_seconds(context.received_at.as_str())
        .ok_or_else(|| p05_budget_unavailable(context))?;
    let snapshots = BudgetRepository::new(database)
        .budget_scope_snapshots(
            org_id,
            context.received_at.as_str(),
            Some(project_id),
            Some(principal_user_id),
            Some(model_alias),
            P05_BUDGET_SNAPSHOT_LIMIT,
        )
        .await
        .map_err(|_| p05_budget_unavailable(context))?;
    if snapshots.len() >= P05_BUDGET_SNAPSHOT_LIMIT as usize {
        return Err(p05_budget_unavailable(context));
    }
    let policies = snapshots
        .iter()
        .map(budget_policy_from_snapshot)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| p05_budget_unavailable(context))?;
    let scope_context = ScopeContext::user(
        org_id,
        Some(project_id.to_owned()),
        principal_user_id,
        model_alias,
    );
    let evaluation = evaluate_budget_request(
        &BudgetEvaluationRequest::new(scope_context, requested_minor, true, now),
        &policies,
    );
    let budget_id = most_restrictive_budget_id(&snapshots);
    let currency = budget_id
        .as_ref()
        .and_then(|selected| {
            snapshots
                .iter()
                .find(|snapshot| &snapshot.budget_id == selected)
        })
        .map_or("USD", |snapshot| snapshot.currency.as_str())
        .to_owned();
    Ok(P05BudgetAdmission {
        decision: evaluation.decision,
        budget_id,
        currency,
    })
}

fn rate_policy_from_record(
    record: &crate::repositories::RateLimitPolicyRecord,
) -> Result<RateLimitPolicy, ()> {
    let requests_per_minute = match record.requests_per_minute {
        Some(value) => Some(nonnegative_u64(value).ok_or(())?),
        None => None,
    };
    let tokens_per_minute = match record.tokens_per_minute {
        Some(value) => Some(nonnegative_u64(value).ok_or(())?),
        None => None,
    };
    let max_concurrency = record
        .max_concurrent_requests
        .map(|value| u32::try_from(value).map_err(|_| ()))
        .transpose()?;
    RateLimitPolicy::from_parts(
        &record.scope_type,
        &record.org_id,
        record.scope_id.as_deref(),
        requests_per_minute,
        tokens_per_minute,
        max_concurrency,
        true,
    )
    .map_err(|_| ())
}

async fn p05_rate_admission(
    database: &crate::adapters::d1::D1Adapter,
    context: &RequestContext,
    org_id: &str,
    project_id: &str,
    principal_user_id: &str,
    model_alias: &str,
    requested_tokens: u64,
) -> Result<P05RateAdmission, ApiError> {
    let repository = BudgetRepository::new(database);
    let records = repository
        .list_rate_limit_policies(org_id, None, None, None, P05_RATE_POLICY_LIMIT)
        .await
        .map_err(|_| p05_rate_unavailable(context))?;
    if records.len() >= P05_RATE_POLICY_LIMIT as usize {
        return Err(p05_rate_unavailable(context));
    }
    let policies = records
        .iter()
        .map(rate_policy_from_record)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| p05_rate_unavailable(context))?;
    let scope_context = ScopeContext::user(
        org_id,
        Some(project_id.to_owned()),
        principal_user_id,
        model_alias,
    );
    let applicable = policies
        .into_iter()
        .filter(|policy| policy.matches(&scope_context))
        .collect::<Vec<_>>();
    if applicable.is_empty() {
        return Ok(P05RateAdmission {
            decision: RateLimitDecision::Allow,
        });
    }
    let now =
        epoch_seconds(context.received_at.as_str()).ok_or_else(|| p05_rate_unavailable(context))?;
    let canonical = canonical_instant_text(context.received_at.as_str())
        .ok_or_else(|| p05_rate_unavailable(context))?;
    let minute = canonical
        .get(..16)
        .ok_or_else(|| p05_rate_unavailable(context))?;
    let window_start = format!("{minute}:00.000Z");
    let window_start_timestamp =
        Timestamp::new(window_start.clone()).map_err(|_| p05_rate_unavailable(context))?;
    let window_end = add_seconds(&window_start_timestamp, 60)
        .map_err(|_| p05_rate_unavailable(context))?
        .as_str()
        .to_owned();
    let mut states = Vec::with_capacity(applicable.len());
    for policy in applicable {
        if !policy.has_limits() {
            continue;
        }
        let (project_filter, principal_filter, model_filter) = match policy.scope.scope_type {
            crate::modules::budget_p05::ScopeType::Project => {
                (policy.scope.scope_id.as_deref(), None, None)
            }
            crate::modules::budget_p05::ScopeType::User => {
                (None, policy.scope.scope_id.as_deref(), None)
            }
            crate::modules::budget_p05::ScopeType::ServiceAccount => (None, None, None),
            crate::modules::budget_p05::ScopeType::ModelAlias => {
                (None, None, policy.scope.scope_id.as_deref())
            }
            crate::modules::budget_p05::ScopeType::Organization => (None, None, None),
        };
        let usage = repository
            .rate_limit_usage(
                org_id,
                &window_start,
                &window_end,
                project_filter,
                principal_filter,
                model_filter,
                i64::try_from(now).map_err(|_| p05_rate_unavailable(context))?,
            )
            .await
            .map_err(|_| p05_rate_unavailable(context))?;
        if usage.requests < 0
            || usage.tokens < 0
            || usage.active_inferences < 0
            || usage.minute_started_at < 0
        {
            return Err(p05_rate_unavailable(context));
        }
        let active =
            u32::try_from(usage.active_inferences).map_err(|_| p05_rate_unavailable(context))?;
        states.push(RateLimitPolicyState::new(
            policy,
            RateLimitUsage::new(
                u64::try_from(usage.minute_started_at)
                    .map_err(|_| p05_rate_unavailable(context))?,
                u64::try_from(usage.requests).map_err(|_| p05_rate_unavailable(context))?,
                u64::try_from(usage.tokens).map_err(|_| p05_rate_unavailable(context))?,
                active,
            ),
        ));
    }
    let decision = evaluate_rate_limit_states(
        &scope_context,
        &states,
        RateLimitRequest::one(requested_tokens),
        now,
    )
    .decision;
    Ok(P05RateAdmission { decision })
}

#[allow(clippy::too_many_arguments)]
async fn record_inference_denial(
    database: &crate::adapters::d1::D1Adapter,
    context: &RequestContext,
    principal: Option<&Principal>,
    org_id: &str,
    device_id: Option<&str>,
    run_id: Option<&str>,
    agent_session_id: Option<&str>,
    action: &str,
    reason: &'static str,
    metadata: Value,
) {
    let event_id = generated_id("sec");
    let audit = security_event_statement_with_context(
        database,
        context,
        principal,
        None,
        Some(org_id),
        SecurityEventId::new(event_id),
        action,
        "inference",
        run_id.or(Some(request_id_resource(context))),
        "denied",
        &json!({
            "reason": reason,
            "device_id": device_id,
            "run_id": run_id,
            "agent_session_id": agent_session_id,
            "details": metadata
        }),
        device_id,
        run_id,
        agent_session_id,
        None,
    );
    let outbox = outbox_statement(
        database,
        context,
        principal,
        Some(org_id),
        action,
        &json!({
            "reason": reason,
            "device_id": device_id,
            "run_id": run_id,
            "agent_session_id": agent_session_id,
            "details": metadata
        }),
    );
    if let (Ok(audit), Ok(outbox)) = (audit, outbox) {
        let _ = database.batch(vec![audit, outbox]).await;
    }
}

fn request_id_resource(context: &RequestContext) -> &str {
    context.request_id.as_str()
}

fn attach_managed_identity_statement(
    database: &crate::adapters::d1::D1Adapter,
    scope: &RequestScope,
) -> worker::Result<worker::d1::D1PreparedStatement> {
    database.prepare(
        ATTACH_MANAGED_INFERENCE_IDENTITY_SQL,
        &[
            BindValue::Text(scope.agent_session_id.as_deref().unwrap_or("")),
            BindValue::Text(scope.agent_definition_id.as_deref().unwrap_or("")),
            scope
                .agent_definition_version
                .map_or(BindValue::Null, BindValue::Int64),
            BindValue::Text(scope.request_id.as_str()),
            BindValue::Text(scope.org_id.as_str()),
            BindValue::Text(scope.run_id.as_deref().unwrap_or("")),
        ],
    )
}

fn attach_managed_run_policy_statement(
    database: &crate::adapters::d1::D1Adapter,
    scope: &RequestScope,
) -> worker::Result<worker::d1::D1PreparedStatement> {
    database.prepare(
        ATTACH_MANAGED_RUN_POLICY_SQL,
        &[
            BindValue::Text(scope.policy_snapshot_id.as_deref().unwrap_or("")),
            scope
                .policy_version
                .map_or(BindValue::Null, BindValue::Int64),
            BindValue::Text(scope.run_id.as_deref().unwrap_or("")),
            BindValue::Text(scope.org_id.as_str()),
        ],
    )
}

fn p05_reservation_statement(
    database: &crate::adapters::d1::D1Adapter,
    scope: &RequestScope,
    reserved_minor: i64,
    expires_at: &str,
    now: &str,
    currency: &str,
) -> worker::Result<worker::d1::D1PreparedStatement> {
    BudgetRepository::new(database).insert_reservation_if_available_statement(
        &NewReservationInput {
            reservation_id: &scope.reservation_id,
            request_id: &scope.request_id,
            org_id: &scope.org_id,
            reserved_minor,
            expires_at,
            now,
            run_id: scope.run_id.as_deref(),
            budget_id: scope.budget_id.as_deref(),
            currency,
        },
    )
}

fn release_reservation_statement(
    database: &crate::adapters::d1::D1Adapter,
    scope: &RequestScope,
    context: &RequestContext,
    reason: &str,
) -> worker::Result<worker::d1::D1PreparedStatement> {
    if scope.managed_run {
        BudgetRepository::new(database).reconcile_reservation_statement(
            &ReservationReconcileInput {
                reservation_id: &scope.reservation_id,
                org_id: &scope.org_id,
                request_id: &scope.request_id,
                reconciled_at: context.received_at.as_str(),
                committed_minor: None,
                status: "released",
                reason: Some(reason),
                budget_id: scope.budget_id.as_deref(),
            },
        )
    } else {
        AiRepository::new(database).update_budget_reservation_statement(
            &scope.reservation_id,
            &scope.org_id,
            &scope.request_id,
            None,
            "released",
            &context.received_at,
        )
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_inference(
    state: Arc<AppState>,
    context: RequestContext,
    headers: HeaderMap,
    mut request: InferenceRequest,
    format: ResponseFormat,
    caller_signal: Option<&AbortSignal>,
    requested_agent_session_id: Option<&str>,
    policy_snapshot: Option<&PolicySnapshotEnvelope>,
) -> Result<Response<Body>, ApiError> {
    let mut correlation_target = InferenceCorrelationTarget {
        project_id: request.project_id.take(),
        run_id: request.run_id.take(),
        agent_session_id: requested_agent_session_id.map(str::to_owned),
    };
    let p05_correlation = merge_p05_inference_headers(&headers, &mut correlation_target)
        .map_err(|_| p05_scope_error(&context))?;
    request.project_id = correlation_target.project_id;
    request.run_id = correlation_target.run_id;
    let requested_agent_session_id = correlation_target.agent_session_id;
    let org_id = required_org_id(&headers, &context)?;
    let access = authorize_org(
        &state,
        &headers,
        &context,
        &org_id,
        Permission::InferenceUse,
        Some("model_alias"),
        Some(&request.model),
    )
    .await?;
    require_inference_write_proof(&headers, &access.session, &context).await?;
    validate_request_scope(&request, access.principal.session_id.as_str(), &context)?;
    if requested_agent_session_id
        .as_deref()
        .is_some_and(|value| crate::core::AgentSessionId::new(value).is_err())
    {
        return Err(validation_error(
            &context,
            "agent_session_scope_invalid",
            "The agent session scope is invalid.",
        ));
    }
    if request.run_id.is_none() && requested_agent_session_id.is_some() {
        return Err(validation_error(
            &context,
            "agent_session_scope_invalid",
            "An agent session requires a correlated run.",
        ));
    }
    let database = database(&state, &context)?;
    let managed_scope = if let Some(run_id) = request.run_id.as_deref() {
        let managed = resolve_managed_run_scope(
            &state,
            &headers,
            &context,
            &access.principal,
            &org_id,
            run_id,
            &request.model,
            requested_agent_session_id.as_deref(),
        )
        .await?;
        if p05_correlation.as_ref().is_some_and(|correlation| {
            correlation.project_id != managed.run.project_id
                || correlation.device_id != managed.device.device_id
                || correlation.agent_session_id != managed.run.agent_session_id
                || correlation.run_id != managed.run.run_id
                || correlation.agent_definition_id != managed.run.agent_definition_id
                || correlation.agent_definition_version != managed.run.agent_definition_version
        }) {
            return Err(p05_scope_error(&context));
        }
        if request
            .project_id
            .as_deref()
            .is_some_and(|project_id| project_id != managed.run.project_id)
        {
            return Err(p05_scope_error(&context));
        }
        request.project_id = Some(managed.run.project_id.clone());
        Some(managed)
    } else {
        None
    };
    let repository = AiRepository::new(database);
    let policy_record = repository
        .find_policy(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    if managed_scope.is_some() && policy_record.is_none() {
        return Err(gateway_error(&context, "model_not_allowed"));
    }
    let (mut policy, mut credential_mode) =
        policy_from_record(policy_record.as_ref(), state.environment.as_str());
    // P03 owns the persisted, signed/versioned policy transport. A managed run
    // never uses the optional test seam as authority: it has already loaded the
    // current server snapshot while resolving the run. Unmanaged requests keep
    // the P04 fallback behavior.
    let trusted_snapshot = if let Some(managed) = managed_scope.as_ref() {
        if policy_snapshot.is_some_and(|snapshot| snapshot.org_id != org_id) {
            return Err(gateway_error(&context, "model_not_allowed"));
        }
        Some(managed.policy_snapshot.clone())
    } else {
        match policy_snapshot {
            Some(snapshot) if snapshot.org_id == org_id => Some(snapshot.clone()),
            Some(_) => return Err(gateway_error(&context, "model_not_allowed")),
            None => load_trusted_policy_snapshot(database, &org_id, &context).await?,
        }
    };
    if let Some(snapshot) = trusted_snapshot.as_ref() {
        let (snapshot_policy, snapshot_mode) = snapshot.apply_to(policy, credential_mode);
        policy = snapshot_policy;
        credential_mode = snapshot_mode;
    }
    let effective_project_id = managed_scope
        .as_ref()
        .map(|managed| Some(managed.run.project_id.clone()))
        .unwrap_or_else(|| {
            trusted_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.trusted_project_id().map(str::to_owned))
        });
    let effective_device_id = managed_scope
        .as_ref()
        .map(|managed| Some(managed.device.device_id.clone()))
        .unwrap_or_else(|| {
            trusted_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.trusted_device_id().map(str::to_owned))
        });
    if let Some(snapshot) = trusted_snapshot.as_ref()
        && managed_scope.is_none()
        && let Some(trusted_project_id) = snapshot.trusted_project_id()
        && request
            .project_id
            .as_deref()
            .is_some_and(|project_id| project_id != trusted_project_id)
    {
        return Err(gateway_error(&context, "model_not_allowed"));
    }
    if !policy.allows_alias(&request.model) {
        return Err(gateway_error(&context, "model_not_allowed"));
    }
    let alias = repository
        .find_alias(&request.model)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| gateway_error(&context, "model_not_allowed"))?;
    if alias.lifecycle == "disabled" {
        return Err(gateway_error(&context, "model_not_allowed"));
    }
    // `model_not_allowed`, NOT `route_unavailable`.
    //
    // The route lookup is scoped by org, so a miss means *this organization has no route for this
    // alias* -- which is the same fact `policy.allows_alias` reports one line above, and that
    // condition already maps to `PermissionDenied`. Raising `route_unavailable` here instead sent
    // the client a `503 service_unavailable` for something it caused and can fix: it named a model
    // it is not entitled to, and it would retry, back off and page someone (V01-021).
    //
    // The other `route_unavailable` sites are deliberately left alone, because for them the
    // question is genuinely different -- a route that exists but is not published, a version
    // missing, a config that does not parse. Reclassifying those on the strength of this one
    // measurement would be guessing.
    let route = repository
        .find_route_by_alias(&org_id, &request.model)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| gateway_error(&context, "model_not_allowed"))?;
    if route.lifecycle != "published" {
        return Err(gateway_error(&context, "route_unavailable"));
    }
    let version = repository
        .find_route_version(
            &org_id,
            route
                .active_version_id
                .as_deref()
                .ok_or_else(|| gateway_error(&context, "route_unavailable"))?,
        )
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| gateway_error(&context, "route_unavailable"))?;
    let config = serde_json::from_str::<RouteConfig>(&version.config_json)
        .map_err(|_| gateway_error(&context, "route_unavailable"))?;
    validate_route_config(&config).map_err(|_| gateway_error(&context, "route_unavailable"))?;
    let estimated_input_tokens = crate::modules::budget::estimate_request_tokens(&request);
    let model_output_tokens = request.max_output_tokens.unwrap_or(0);
    let estimated_output_tokens = request.max_output_tokens.unwrap_or(4_096);
    let mut models = repository
        .list_models(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    models.retain(|model| {
        model
            .max_input_tokens
            .is_none_or(|limit| i64::from(estimated_input_tokens) <= limit)
            && model
                .max_output_tokens
                .is_none_or(|limit| i64::from(model_output_tokens) <= limit)
    });
    let mut providers = repository
        .list_providers(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    if state.environment != "development" {
        providers.retain(|provider| provider.adapter != "mock");
        models.retain(|model| {
            providers
                .iter()
                .any(|provider| provider.provider_id == model.provider_id)
        });
    }
    let health = repository
        .list_health(&org_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    if models.is_empty() {
        return Err(gateway_error(&context, "unsupported_capability"));
    }
    let required = request
        .required_capabilities
        .iter()
        .map(|value| value.as_str().to_owned())
        .collect::<Vec<_>>();
    let selected = select_candidates(
        &config,
        &models
            .iter()
            .filter_map(model_descriptor)
            .collect::<Vec<_>>(),
        &providers
            .iter()
            .filter_map(provider_descriptor)
            .collect::<Vec<_>>(),
        &policy,
        &health
            .iter()
            .map(|value| health_state(value, context.received_at.as_str()))
            .collect::<Vec<_>>(),
        &required,
        seed_from_id(context.request_id.as_str()),
    )
    .map_err(|error| gateway_error(&context, route_error_reason(error)))?;

    // A missing output cap is still bounded for reservation purposes. The
    // provider may return fewer tokens, but the pre-dispatch gate must never
    // reserve an unbounded amount.
    let reservation_minor = i64::try_from(
        u64::from(estimated_input_tokens)
            .saturating_add(u64::from(estimated_output_tokens))
            .min(P05_MAX_RESERVATION_TOKENS),
    )
    .map_err(|_| p05_budget_unavailable(&context))?;
    let managed_project_id = managed_scope
        .as_ref()
        .map(|managed| managed.run.project_id.as_str());
    let managed_device_id = managed_scope
        .as_ref()
        .map(|managed| managed.device.device_id.as_str());
    let managed_agent_session_id = managed_scope
        .as_ref()
        .map(|managed| managed.session.agent_session_id.as_str());
    let managed_run_id = managed_scope
        .as_ref()
        .map(|managed| managed.run.run_id.as_str());
    let (budget_decision_value, budget_id, budget_currency) =
        if let Some(project_id) = managed_project_id {
            let requested_tokens =
                u64::try_from(reservation_minor).map_err(|_| p05_budget_unavailable(&context))?;
            let rate_admission = p05_rate_admission(
                database,
                &context,
                &org_id,
                project_id,
                access.principal.user_id.as_str(),
                &request.model,
                requested_tokens,
            )
            .await?;
            let rate_reason = match &rate_admission.decision {
                RateLimitDecision::Allow => None,
                RateLimitDecision::Deny(violation)
                    if violation.dimension == RateLimitDimension::Concurrency =>
                {
                    Some("concurrency_limit_exceeded")
                }
                RateLimitDecision::Deny(_) => Some("rate_limit_exceeded"),
                RateLimitDecision::Unavailable => Some("rate_limit_state_unavailable"),
            };
            if let Some(reason) = rate_reason {
                record_inference_denial(
                    database,
                    &context,
                    Some(&access.principal),
                    &org_id,
                    managed_device_id,
                    managed_run_id,
                    managed_agent_session_id,
                    "rate_limit.denied.v1",
                    reason,
                    json!({ "model_alias": request.model, "requested_tokens": requested_tokens }),
                )
                .await;
                return Err(if reason == "rate_limit_state_unavailable" {
                    p05_rate_unavailable(&context)
                } else {
                    p05_error(
                        &context,
                        ApiErrorCode::RateLimited,
                        reason,
                        "The request rate limit does not allow this inference.",
                    )
                });
            }
            let budget_admission = p05_budget_admission(
                database,
                &context,
                &org_id,
                project_id,
                access.principal.user_id.as_str(),
                &request.model,
                requested_tokens,
            )
            .await?;
            match budget_admission.decision {
                P05BudgetDecision::Allow | P05BudgetDecision::SoftLimit => (
                    budget_admission.decision.as_str().to_owned(),
                    budget_admission.budget_id,
                    budget_admission.currency,
                ),
                P05BudgetDecision::Deny => {
                    record_inference_denial(
                    database,
                    &context,
                    Some(&access.principal),
                    &org_id,
                    managed_device_id,
                    managed_run_id,
                    managed_agent_session_id,
                    "budget.denied.v1",
                    "budget_exceeded",
                    json!({ "model_alias": request.model, "reserved_minor": reservation_minor }),
                )
                .await;
                    return Err(p05_error(
                        &context,
                        ApiErrorCode::PermissionDenied,
                        "budget_exceeded",
                        "The organization budget does not allow this request.",
                    ));
                }
                P05BudgetDecision::Unavailable => {
                    record_inference_denial(
                        database,
                        &context,
                        Some(&access.principal),
                        &org_id,
                        managed_device_id,
                        managed_run_id,
                        managed_agent_session_id,
                        "budget.denied.v1",
                        "budget_state_unavailable",
                        json!({ "model_alias": request.model }),
                    )
                    .await;
                    return Err(p05_budget_unavailable(&context));
                }
            }
        } else {
            // No managed run means the caller is explicitly on the P04/local
            // compatibility path. Keep its organization-level precheck and
            // conditional reservation semantics, but do not pretend P05 scope
            // enforcement happened.
            match repository
                .hard_budget_remaining(&org_id, context.received_at.as_str())
                .await
            {
                Ok(Some(remaining)) if remaining < reservation_minor => {
                    return Err(gateway_error(&context, "budget_exceeded"));
                }
                Ok(_) => {}
                Err(_) => return Err(gateway_error(&context, "budget_state_unavailable")),
            }
            ("allow".to_owned(), None, "USD".to_owned())
        };

    let reservation_id = new_resource_id("bud").as_str().to_owned();
    // Keep the reservation alive beyond the maximum bounded route attempt
    // window; P05 owns authoritative expiry/reconciliation policy.
    let reservation_expires_at = add_seconds(&context.received_at, P05_RESERVATION_TTL_SECONDS)
        .map_err(|_| {
            if managed_scope.is_some() {
                p05_budget_unavailable(&context)
            } else {
                gateway_error(&context, "budget_state_unavailable")
            }
        })?;
    let scope = RequestScope {
        request_id: context.request_id.as_str().to_owned(),
        org_id: org_id.clone(),
        project_id: effective_project_id.clone(),
        session_id: request
            .session_id
            .clone()
            .unwrap_or_else(|| access.principal.session_id.as_str().to_owned()),
        device_id: effective_device_id,
        run_id: request.run_id.clone(),
        agent_session_id: managed_scope
            .as_ref()
            .map(|managed| managed.session.agent_session_id.clone()),
        agent_definition_id: managed_scope
            .as_ref()
            .map(|managed| managed.run.agent_definition_id.clone()),
        agent_definition_version: managed_scope
            .as_ref()
            .map(|managed| managed.run.agent_definition_version),
        workspace_binding_id: managed_scope
            .as_ref()
            .and_then(|managed| managed.run.workspace_binding_id.clone()),
        policy_snapshot_id: managed_scope
            .as_ref()
            .map(|managed| managed.policy_snapshot.policy_id.clone()),
        policy_version: managed_scope
            .as_ref()
            .map(|managed| managed.policy_snapshot.policy_version),
        managed_run: managed_scope.is_some(),
        model_alias: request.model.clone(),
        route_id: route.route_id.clone(),
        route_version_id: version.route_version_id.clone(),
        route_version_number: version.version_number,
        reservation_id: reservation_id.clone(),
        reserved_minor: reservation_minor,
        budget_id,
        currency: budget_currency.clone(),
        principal_user_id: access.principal.user_id.as_str().to_owned(),
        credential_mode,
    };
    let reservation_statement = if scope.managed_run {
        p05_reservation_statement(
            database,
            &scope,
            reservation_minor,
            reservation_expires_at.as_str(),
            context.received_at.as_str(),
            &budget_currency,
        )
        .map_err(|error| database_error(&context, error))?
    } else {
        repository
            .insert_budget_reservation_if_available_statement(
                &scope.reservation_id,
                &scope.request_id,
                &scope.org_id,
                reservation_minor,
                reservation_expires_at.as_str(),
                &context.received_at,
            )
            .map_err(|error| database_error(&context, error))?
    };
    let request_statement = repository
        .insert_inference_request_statement(
            &scope.request_id,
            &scope.org_id,
            scope.project_id.as_deref(),
            scope.run_id.as_deref(),
            &scope.principal_user_id,
            Some(&scope.session_id),
            scope.device_id.as_deref(),
            &scope.model_alias,
            &scope.route_id,
            &scope.route_version_id,
            &context.received_at,
        )
        .map_err(|error| database_error(&context, error))?;
    let identity_statement = if scope.managed_run {
        Some(
            attach_managed_identity_statement(database, &scope)
                .map_err(|error| database_error(&context, error))?,
        )
    } else {
        None
    };
    let run_policy_statement = if scope.managed_run {
        Some(
            attach_managed_run_policy_statement(database, &scope)
                .map_err(|error| database_error(&context, error))?,
        )
    } else {
        None
    };
    let request_event = security_event_statement_with_context(
        database,
        &context,
        Some(&access.principal),
        None,
        Some(&scope.org_id),
        SecurityEventId::generate(),
        "inference.requested.v1",
        "model_alias",
        Some(&scope.model_alias),
        "success",
        &json!({
            "route_version_id": scope.route_version_id,
            "stream": request.stream,
            "project_id": scope.project_id,
            "device_id": scope.device_id,
            "run_id": scope.run_id,
            "agent_session_id": scope.agent_session_id,
            "workspace_binding_id": scope.workspace_binding_id,
        }),
        scope.device_id.as_deref(),
        scope.run_id.as_deref(),
        scope.agent_session_id.as_deref(),
        None,
    )?;
    let request_outbox = outbox_statement(
        database,
        &context,
        Some(&access.principal),
        Some(&scope.org_id),
        "inference.requested.v1",
        &json!({
            "route_version_id": scope.route_version_id,
            "stream": request.stream,
            "project_id": scope.project_id,
            "device_id": scope.device_id,
            "run_id": scope.run_id,
            "agent_session_id": scope.agent_session_id,
            "workspace_binding_id": scope.workspace_binding_id,
        }),
    )?;
    let mut initial_statements = vec![request_statement, reservation_statement];
    if let Some(identity_statement) = identity_statement {
        initial_statements.push(identity_statement);
    }
    if let Some(run_policy_statement) = run_policy_statement {
        initial_statements.push(run_policy_statement);
    }
    let initial_results = database.batch(initial_statements).await.map_err(|_error| {
        if scope.managed_run {
            p05_budget_unavailable(&context)
        } else {
            gateway_error(&context, "budget_state_unavailable")
        }
    })?;
    if crate::adapters::d1::D1Adapter::changes(&initial_results[1]).unwrap_or_default() != 1 {
        if let Ok(statement) = repository.update_inference_request_statement(
            &scope.request_id,
            &scope.org_id,
            None,
            None,
            None,
            "failed",
            0,
            None,
            Some(context.received_at.as_str()),
            Some("budget_exceeded"),
        ) {
            let _ = database.batch(vec![statement]).await;
        }
        if scope.managed_run {
            record_inference_denial(
                database,
                &context,
                Some(&access.principal),
                &org_id,
                scope.device_id.as_deref(),
                scope.run_id.as_deref(),
                scope.agent_session_id.as_deref(),
                "budget.denied.v1",
                "budget_exceeded",
                json!({ "model_alias": scope.model_alias, "reserved_minor": reservation_minor }),
            )
            .await;
        }
        return Err(if scope.managed_run {
            p05_error(
                &context,
                ApiErrorCode::PermissionDenied,
                "budget_exceeded",
                "The organization budget does not allow this request.",
            )
        } else {
            gateway_error(&context, "budget_exceeded")
        });
    }
    if scope.managed_run
        && (crate::adapters::d1::D1Adapter::changes(&initial_results[2]).unwrap_or_default() != 1
            || crate::adapters::d1::D1Adapter::changes(&initial_results[3]).unwrap_or_default()
                != 1)
    {
        let cleanup_request = repository.update_inference_request_statement(
            &scope.request_id,
            &scope.org_id,
            None,
            None,
            None,
            "failed",
            0,
            None,
            Some(context.received_at.as_str()),
            Some("resource_scope_mismatch"),
        );
        let cleanup_reservation =
            release_reservation_statement(database, &scope, &context, "identity_mismatch");
        if let (Ok(cleanup_request), Ok(cleanup_reservation)) =
            (cleanup_request, cleanup_reservation)
        {
            let _ = database
                .batch(vec![cleanup_request, cleanup_reservation])
                .await;
        }
        return Err(p05_scope_error(&context));
    }
    if let Err(error) = database.batch(vec![request_event, request_outbox]).await {
        let cleanup_request = repository.update_inference_request_statement(
            &scope.request_id,
            &scope.org_id,
            None,
            None,
            None,
            "failed",
            0,
            None,
            Some(context.received_at.as_str()),
            Some("provider_unavailable"),
        );
        let cleanup_reservation =
            release_reservation_statement(database, &scope, &context, "event_write_failed");
        if let (Ok(cleanup_request), Ok(cleanup_reservation)) =
            (cleanup_request, cleanup_reservation)
        {
            let _ = database
                .batch(vec![cleanup_request, cleanup_reservation])
                .await;
        }
        return Err(if scope.managed_run {
            p05_error(
                &context,
                ApiErrorCode::ServiceUnavailable,
                "run_state_unavailable",
                "The inference state could not be recorded.",
            )
        } else {
            database_error(&context, error)
        });
    }

    let mut last_error = AdapterErrorKind::ProviderUnavailable;
    let mut credential_unavailable = false;
    let mut last_attempt_metadata: Option<StreamMetadata> = None;
    let retry_budget = if request.retry_safe {
        selected
            .iter()
            .map(|candidate| candidate.max_retries)
            .max()
            .unwrap_or(0)
            .min(3)
    } else {
        0
    };
    let max_fallbacks = if request.retry_safe {
        selected.len().saturating_sub(1).min(7) as u8
    } else {
        0
    };
    let mut retry_controller = RetryController::new(retry_budget, max_fallbacks);
    for candidate in selected.iter() {
        if last_attempt_metadata.is_some() && retry_controller.fallback_count() > 0 {
            let delay = retry_backoff_ms(
                retry_controller.fallback_count(),
                context.request_id.as_str(),
            );
            worker::Delay::from(Duration::from_millis(u64::from(delay))).await;
        }
        let credential = match resolve_credential(&repository, &scope, candidate).await {
            Ok(Some(value)) => value,
            Ok(None) => {
                credential_unavailable = true;
                if !retry_allowed(&request, &retry_controller) {
                    retry_controller.fail();
                    break;
                }
                continue;
            }
            Err(error) => {
                last_error = error.kind;
                record_health(&repository, &scope.org_id, candidate, &error, &context).await;
                if retry_allowed(&request, &retry_controller)
                    && (error.retryable || error.kind == AdapterErrorKind::CredentialRejected)
                {
                    retry_controller.mark_retryable_failure(error.kind);
                } else {
                    retry_controller.fail();
                }
                if retry_controller.state() == crate::modules::inference::ResponseLifecycle::Failed
                {
                    break;
                }
                continue;
            }
        };
        let provider = match providers
            .iter()
            .find(|value| value.provider_id == candidate.provider_id)
        {
            Some(value) => value,
            None => {
                last_error = AdapterErrorKind::ProviderUnavailable;
                retry_controller.fail();
                break;
            }
        };
        let model = match models
            .iter()
            .find(|value| value.model_id == candidate.model_id)
        {
            Some(value) => value,
            None => {
                last_error = AdapterErrorKind::UnsupportedCapability;
                retry_controller.fail();
                break;
            }
        };
        let adapter = match AdapterKind::parse(&provider.adapter) {
            Some(value) => value,
            None => {
                last_error = AdapterErrorKind::InvalidResponse;
                retry_controller.fail();
                break;
            }
        };
        if adapter == AdapterKind::Mock && state.environment != "development" {
            last_error = AdapterErrorKind::ProviderUnavailable;
            retry_controller.fail();
            break;
        }
        let plaintext = match credential_plaintext(&state, Some(&credential)).await {
            Ok(Some(value)) => value,
            Ok(None) => {
                credential_unavailable = true;
                if !retry_allowed(&request, &retry_controller) {
                    retry_controller.fail();
                    break;
                }
                continue;
            }
            Err(error) => {
                last_error = error.kind;
                record_health(&repository, &scope.org_id, candidate, &error, &context).await;
                if retry_allowed(&request, &retry_controller)
                    && (error.retryable || error.kind == AdapterErrorKind::CredentialRejected)
                {
                    retry_controller.mark_retryable_failure(error.kind);
                } else {
                    retry_controller.fail();
                }
                if retry_controller.state() == crate::modules::inference::ResponseLifecycle::Failed
                {
                    break;
                }
                continue;
            }
        };
        let attempt_started_at_ms = worker::js_sys::Date::now();
        let mut metadata = StreamMetadata {
            request_id: context.request_id.as_str().to_owned(),
            format,
            model_alias: scope.model_alias.clone(),
            route_version_id: scope.route_version_id.clone(),
            route_version_number: scope.route_version_number,
            reservation_id: scope.reservation_id.clone(),
            reserved_minor: scope.reserved_minor,
            budget_id: scope.budget_id.clone(),
            currency: scope.currency.clone(),
            provider_id: candidate.provider_id.clone(),
            model_id: candidate.model_id.clone(),
            provider_request_id: None,
            fallback_count: i64::from(retry_controller.fallback_count()),
            project_id: scope.project_id.clone(),
            run_id: scope.run_id.clone(),
            session_id: scope.session_id.clone(),
            device_id: scope.device_id.clone(),
            agent_session_id: scope.agent_session_id.clone(),
            agent_definition_id: scope.agent_definition_id.clone(),
            agent_definition_version: scope.agent_definition_version,
            workspace_binding_id: scope.workspace_binding_id.clone(),
            policy_snapshot_id: scope.policy_snapshot_id.clone(),
            policy_version: scope.policy_version,
            managed_run: scope.managed_run,
            principal_user_id: scope.principal_user_id.clone(),
            org_id: scope.org_id.clone(),
            credential_id: Some(credential.credential_id.clone()),
            budget_decision: budget_decision_value.to_owned(),
            started_at_ms: attempt_started_at_ms,
            deadline_at_ms: attempt_started_at_ms + f64::from(candidate.timeout_ms),
            ttft_ms: None,
            total_latency_ms: None,
            health_observed: false,
        };
        last_attempt_metadata = Some(metadata.clone());
        let dispatch_result = dispatch(
            adapter,
            provider.endpoint_url.as_deref().unwrap_or(""),
            &model.provider_model_id,
            &request,
            Some(&plaintext),
            &state.provider_allowlist,
            state.allow_local_provider_endpoints,
            Some(context.request_id.as_str()),
            caller_signal,
            candidate.timeout_ms,
        )
        .await;
        let mut dispatch = match dispatch_result {
            Ok(value) => value,
            Err(error) => {
                if caller_signal.is_some_and(AbortSignal::aborted) {
                    let _ = finalize_request(
                        database,
                        &context,
                        &metadata,
                        None,
                        None,
                        context.received_at.as_str(),
                        false,
                        Some("request_cancelled"),
                    )
                    .await;
                    return Err(gateway_error(&context, "request_cancelled"));
                }
                last_error = error.kind;
                record_health(&repository, &scope.org_id, candidate, &error, &context).await;
                metadata.health_observed = true;
                last_attempt_metadata = Some(metadata.clone());
                if retry_allowed(&request, &retry_controller) && error.retryable {
                    retry_controller.mark_retryable_failure(error.kind);
                } else {
                    retry_controller.fail();
                }
                if retry_controller.state() == crate::modules::inference::ResponseLifecycle::Failed
                {
                    break;
                }
                continue;
            }
        };
        retry_controller.mark_dispatched();
        let dispatched_update = repository
            .update_inference_request_statement(
                context.request_id.as_str(),
                scope.org_id.as_str(),
                Some(candidate.provider_id.as_str()),
                Some(candidate.model_id.as_str()),
                metadata.credential_id.as_deref(),
                "dispatched_no_output",
                metadata.fallback_count,
                None,
                None,
                None,
            )
            .map_err(|error| database_error(&context, error))?;
        database
            .batch(vec![dispatched_update])
            .await
            .map_err(|error| database_error(&context, error))?;
        let first_chunk = if request.stream {
            match preflight_stream(&mut dispatch.stream, metadata.deadline_at_ms, caller_signal)
                .await
            {
                PreflightOutcome::Output(chunk) => Some(chunk),
                PreflightOutcome::Failure(kind) => {
                    last_error = kind;
                    let error = AdapterError {
                        kind,
                        retryable: matches!(
                            kind,
                            AdapterErrorKind::ConnectionFailed
                                | AdapterErrorKind::Timeout
                                | AdapterErrorKind::RateLimited
                                | AdapterErrorKind::ProviderUnavailable
                        ),
                        status_code: None,
                    };
                    record_health(&repository, &scope.org_id, candidate, &error, &context).await;
                    metadata.health_observed = true;
                    last_attempt_metadata = Some(metadata.clone());
                    if retry_allowed(&request, &retry_controller) && error.retryable {
                        retry_controller.mark_retryable_failure(kind);
                    } else {
                        retry_controller.fail();
                    }
                    if retry_controller.state()
                        == crate::modules::inference::ResponseLifecycle::Failed
                    {
                        break;
                    }
                    continue;
                }
                PreflightOutcome::Cancelled => {
                    let _ = finalize_request(
                        database,
                        &context,
                        &metadata,
                        None,
                        None,
                        context.received_at.as_str(),
                        false,
                        Some("request_cancelled"),
                    )
                    .await;
                    return Err(gateway_error(&context, "request_cancelled"));
                }
            }
        } else {
            match next_stream_chunk(&mut dispatch.stream, metadata.deadline_at_ms, caller_signal)
                .await
            {
                NextChunk::TimedOut => {
                    last_error = AdapterErrorKind::Timeout;
                    if retry_allowed(&request, &retry_controller) {
                        retry_controller.mark_retryable_failure(AdapterErrorKind::Timeout);
                    } else {
                        retry_controller.fail();
                    }
                    if retry_controller.state()
                        == crate::modules::inference::ResponseLifecycle::Failed
                    {
                        break;
                    }
                    continue;
                }
                NextChunk::Cancelled => {
                    let _ = finalize_request(
                        database,
                        &context,
                        &metadata,
                        None,
                        None,
                        context.received_at.as_str(),
                        false,
                        Some("request_cancelled"),
                    )
                    .await;
                    return Err(gateway_error(&context, "request_cancelled"));
                }
                NextChunk::Chunk(Some(Ok(chunk))) if !chunk.is_empty() => Some(chunk),
                NextChunk::Chunk(Some(Ok(_))) | NextChunk::Chunk(None) => {
                    last_error = AdapterErrorKind::InvalidResponse;
                    retry_controller.fail();
                    if retry_controller.state()
                        == crate::modules::inference::ResponseLifecycle::Failed
                    {
                        break;
                    }
                    continue;
                }
                NextChunk::Chunk(Some(Err(_))) => {
                    last_error = AdapterErrorKind::ConnectionFailed;
                    if retry_allowed(&request, &retry_controller) {
                        retry_controller.mark_retryable_failure(AdapterErrorKind::ConnectionFailed);
                    } else {
                        retry_controller.fail();
                    }
                    if retry_controller.state()
                        == crate::modules::inference::ResponseLifecycle::Failed
                    {
                        break;
                    }
                    continue;
                }
            }
        };
        retry_controller.mark_stream_committed();
        let committed_update = repository
            .update_inference_request_statement(
                context.request_id.as_str(),
                scope.org_id.as_str(),
                Some(candidate.provider_id.as_str()),
                Some(candidate.model_id.as_str()),
                metadata.credential_id.as_deref(),
                "stream_committed",
                metadata.fallback_count,
                None,
                None,
                None,
            )
            .map_err(|error| database_error(&context, error))?;
        database
            .batch(vec![committed_update])
            .await
            .map_err(|error| database_error(&context, error))?;
        metadata.provider_request_id = dispatch.provider_request_id.clone();
        if caller_signal.is_some_and(AbortSignal::aborted) {
            let _ = finalize_request(
                database,
                &context,
                &metadata,
                None,
                None,
                context.received_at.as_str(),
                false,
                Some("request_cancelled"),
            )
            .await;
            return Err(gateway_error(&context, "request_cancelled"));
        }
        if !request.stream {
            return collect_non_streaming(
                context,
                database,
                dispatch.content_type.clone(),
                dispatch.stream,
                first_chunk,
                metadata,
                caller_signal,
            )
            .await;
        }
        metadata.provider_request_id = dispatch.provider_request_id;
        let database = state
            .database
            .clone()
            .ok_or_else(|| service_unavailable(&context))?;
        let finalized = Rc::new(Cell::new(false));
        let clock = StreamClock::start();
        trace_lifecycle(
            clock,
            match caller_signal {
                None => "armed:no_signal",
                Some(signal) if signal.aborted() => "armed:signal_already_aborted",
                Some(_) => "armed:signal",
            },
        );
        register_cancellation_finalizer(
            caller_signal,
            database.clone(),
            context.clone(),
            metadata.clone(),
            finalized.clone(),
            state.background.clone(),
            clock,
        )?;
        let body_stream = make_stream(
            database,
            context.clone(),
            dispatch.stream,
            first_chunk,
            metadata,
            caller_signal.cloned(),
            finalized,
            state.background.clone(),
            clock,
        );
        let worker_body =
            worker::Body::from_stream(body_stream).map_err(|_| service_unavailable(&context))?;
        let mut response = Response::new(Body::new(worker_body));
        response.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("text/event-stream; charset=utf-8"),
        );
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-cache"),
        );
        response.headers_mut().insert(
            "x-accel-buffering",
            axum::http::HeaderValue::from_static("no"),
        );
        return Ok(response);
    }
    let failure_reason = if credential_unavailable {
        "credential_unavailable"
    } else {
        gateway_reason(last_error)
    };
    let failure_metadata = last_attempt_metadata.unwrap_or(StreamMetadata {
        request_id: context.request_id.as_str().to_owned(),
        format,
        model_alias: scope.model_alias.clone(),
        route_version_id: scope.route_version_id.clone(),
        route_version_number: scope.route_version_number,
        reservation_id: scope.reservation_id.clone(),
        reserved_minor: scope.reserved_minor,
        budget_id: scope.budget_id.clone(),
        currency: scope.currency.clone(),
        provider_id: String::new(),
        model_id: String::new(),
        provider_request_id: None,
        fallback_count: 0,
        project_id: scope.project_id.clone(),
        run_id: scope.run_id.clone(),
        session_id: scope.session_id.clone(),
        device_id: scope.device_id.clone(),
        agent_session_id: scope.agent_session_id.clone(),
        agent_definition_id: scope.agent_definition_id.clone(),
        agent_definition_version: scope.agent_definition_version,
        workspace_binding_id: scope.workspace_binding_id.clone(),
        policy_snapshot_id: scope.policy_snapshot_id.clone(),
        policy_version: scope.policy_version,
        managed_run: scope.managed_run,
        principal_user_id: scope.principal_user_id.clone(),
        org_id: scope.org_id.clone(),
        credential_id: None,
        budget_decision: budget_decision_value.to_owned(),
        started_at_ms: worker::js_sys::Date::now(),
        deadline_at_ms: worker::js_sys::Date::now(),
        ttft_ms: None,
        total_latency_ms: None,
        health_observed: false,
    });
    let _ = finalize_request(
        database,
        &context,
        &failure_metadata,
        None,
        None,
        context.received_at.as_str(),
        false,
        Some(failure_reason),
    )
    .await;
    Err(gateway_error(&context, failure_reason))
}

async fn resolve_credential(
    repository: &AiRepository<'_>,
    scope: &RequestScope,
    candidate: &SelectedCandidate,
) -> Result<Option<CredentialRecord>, AdapterError> {
    let records = if let Some(credential_id) = &candidate.credential_id {
        repository
            .find_credential_for_owner(credential_id, &scope.org_id, &scope.principal_user_id)
            .await
            .map_err(|_| AdapterError {
                kind: AdapterErrorKind::CredentialRejected,
                retryable: false,
                status_code: None,
            })?
            .into_iter()
            .collect::<Vec<_>>()
    } else {
        repository
            .list_active_credentials(
                &scope.org_id,
                &candidate.provider_id,
                &scope.principal_user_id,
            )
            .await
            .map_err(|_| AdapterError {
                kind: AdapterErrorKind::CredentialRejected,
                retryable: false,
                status_code: None,
            })?
    };
    for record in records {
        if record.provider_id != candidate.provider_id {
            continue;
        }
        let owner = CredentialOwnerType::parse(&record.owner_type).ok_or(AdapterError {
            kind: AdapterErrorKind::CredentialRejected,
            retryable: false,
            status_code: None,
        })?;
        let status = CredentialStatus::parse(&record.status).ok_or(AdapterError {
            kind: AdapterErrorKind::CredentialRejected,
            retryable: false,
            status_code: None,
        })?;
        let metadata = CredentialMetadata {
            credential_id: record.credential_id.clone(),
            org_id: record.org_id.clone(),
            owner_type: owner,
            owner_user_id: record.owner_user_id.clone(),
            provider_id: record.provider_id.clone(),
            label: record.label.clone(),
            status,
            version: record.version,
            fingerprint: record.fingerprint.clone(),
            key_version: record.key_version.clone().unwrap_or_default(),
            created_at: record.created_at.clone(),
            updated_at: record.updated_at.clone(),
            last_used_at: record.last_used_at.clone(),
        };
        if can_resolve_credential(
            &metadata,
            &scope.org_id,
            &scope.principal_user_id,
            scope.credential_mode,
        ) {
            return Ok(Some(record));
        }
    }
    Ok(None)
}

async fn record_health(
    repository: &AiRepository<'_>,
    org_id: &str,
    candidate: &SelectedCandidate,
    error: &AdapterError,
    context: &RequestContext,
) {
    let request_specific = matches!(
        error.kind,
        AdapterErrorKind::InvalidRequest
            | AdapterErrorKind::UnsupportedCapability
            | AdapterErrorKind::ContentFiltered
    );
    let state = if error.kind == AdapterErrorKind::CredentialRejected || request_specific {
        "degraded"
    } else {
        "cooldown"
    };
    let cooldown_until = if error.kind == AdapterErrorKind::CredentialRejected || request_specific {
        None
    } else {
        add_seconds(&context.received_at, 30)
            .ok()
            .map(|value| value.as_str().to_owned())
    };
    if let Ok(statement) = repository.upsert_health_statement(
        &candidate.provider_id,
        org_id,
        state,
        1,
        cooldown_until.as_deref(),
        None,
        Some(context.received_at.as_str()),
        Some(error.kind.as_str()),
        &context.received_at,
    ) {
        let _ = statement.run().await;
        if let Ok(sample) = repository.increment_health_failure_statement(
            &candidate.provider_id,
            org_id,
            error.kind.as_str(),
            &context.received_at,
        ) {
            let _ = sample.run().await;
        }
    }
}

async fn record_health_success(
    repository: &AiRepository<'_>,
    org_id: &str,
    provider_id: &str,
    context: &RequestContext,
) {
    if let Ok(statement) = repository.upsert_health_statement(
        provider_id,
        org_id,
        "ready",
        0,
        None,
        Some(context.received_at.as_str()),
        None,
        None,
        &context.received_at,
    ) {
        let _ = statement.run().await;
        if let Ok(sample) =
            repository.increment_health_success_statement(provider_id, org_id, &context.received_at)
        {
            let _ = sample.run().await;
        }
    }
}

async fn record_health_latency(
    repository: &AiRepository<'_>,
    org_id: &str,
    provider_id: &str,
    metadata: &StreamMetadata,
    context: &RequestContext,
) {
    if (metadata.ttft_ms.is_some() || metadata.total_latency_ms.is_some())
        && let Ok(statement) = repository.record_health_latency_statement(
            provider_id,
            org_id,
            metadata.ttft_ms,
            metadata.total_latency_ms,
            &context.received_at,
        )
    {
        let _ = statement.run().await;
    }
}

async fn record_health_error_code(
    repository: &AiRepository<'_>,
    org_id: &str,
    provider_id: &str,
    error_code: &str,
    context: &RequestContext,
) {
    let cooldown_until = add_seconds(&context.received_at, 30)
        .ok()
        .map(|value| value.as_str().to_owned());
    if let Ok(statement) = repository.upsert_health_statement(
        provider_id,
        org_id,
        "cooldown",
        1,
        cooldown_until.as_deref(),
        None,
        Some(context.received_at.as_str()),
        Some(error_code),
        &context.received_at,
    ) {
        let _ = statement.run().await;
        if let Ok(sample) = repository.increment_health_failure_statement(
            provider_id,
            org_id,
            error_code,
            &context.received_at,
        ) {
            let _ = sample.run().await;
        }
    }
}

async fn credential_plaintext(
    state: &AppState,
    record: Option<&CredentialRecord>,
) -> Result<Option<String>, AdapterError> {
    let Some(record) = record else {
        return Ok(None);
    };
    let (Some(ciphertext), Some(nonce), Some(_)) =
        (&record.ciphertext, &record.nonce, &record.key_version)
    else {
        return Ok(None);
    };
    let key = state.credential_key.as_deref().ok_or(AdapterError {
        kind: AdapterErrorKind::CredentialRejected,
        retryable: false,
        status_code: None,
    })?;
    decrypt_secret(key, ciphertext, nonce)
        .await
        .map(Some)
        .map_err(|_| AdapterError {
            kind: AdapterErrorKind::CredentialRejected,
            retryable: false,
            status_code: None,
        })
}

enum NextChunk {
    Chunk(Option<Result<Vec<u8>, worker::Error>>),
    TimedOut,
    Cancelled,
}

impl NextChunk {
    /// Fixed words only, so a trace line can never carry provider data.
    fn label(&self) -> &'static str {
        match self {
            Self::Chunk(Some(Ok(_))) => "chunk",
            Self::Chunk(Some(Err(_))) => "error",
            Self::Chunk(None) => "eof",
            Self::TimedOut => "timeout",
            Self::Cancelled => "cancelled",
        }
    }
}

async fn next_stream_chunk(
    stream: &mut futures_util::stream::LocalBoxStream<'static, Result<Vec<u8>, worker::Error>>,
    deadline_at_ms: f64,
    caller_signal: Option<&AbortSignal>,
) -> NextChunk {
    if caller_signal.is_some_and(AbortSignal::aborted) {
        return NextChunk::Cancelled;
    }
    if caller_signal.is_none() {
        let remaining = (deadline_at_ms - worker::js_sys::Date::now()).max(0.0);
        if remaining <= 0.0 {
            return NextChunk::TimedOut;
        }
        let next = stream.next();
        let delay =
            worker::Delay::from(Duration::from_millis(remaining.min(u64::MAX as f64) as u64));
        futures_util::pin_mut!(next, delay);
        return match futures_util::future::select(next, delay).await {
            futures_util::future::Either::Left((chunk, _)) => NextChunk::Chunk(chunk),
            futures_util::future::Either::Right((_, _)) => NextChunk::TimedOut,
        };
    }

    // Fetch streams normally resolve their abort signal, but a provider can
    // leave a response pending forever. Poll the signal while waiting so a
    // downstream disconnect still releases the reservation and account for
    // the request instead of leaving an orphaned upstream operation.
    loop {
        if caller_signal.is_some_and(AbortSignal::aborted) {
            return NextChunk::Cancelled;
        }
        let remaining = deadline_at_ms - worker::js_sys::Date::now();
        if remaining <= 0.0 {
            return NextChunk::TimedOut;
        }
        let poll_ms = remaining.clamp(1.0, 50.0) as u64;
        let next = stream.next();
        let delay = worker::Delay::from(Duration::from_millis(poll_ms));
        futures_util::pin_mut!(next, delay);
        match futures_util::future::select(next, delay).await {
            futures_util::future::Either::Left((chunk, _)) => return NextChunk::Chunk(chunk),
            futures_util::future::Either::Right((_, _)) => {
                if caller_signal.is_some_and(AbortSignal::aborted) {
                    return NextChunk::Cancelled;
                }
            }
        }
    }
}

enum PreflightOutcome {
    Output(Vec<u8>),
    Failure(AdapterErrorKind),
    Cancelled,
}

async fn preflight_stream(
    stream: &mut futures_util::stream::LocalBoxStream<'static, Result<Vec<u8>, worker::Error>>,
    deadline_at_ms: f64,
    caller_signal: Option<&AbortSignal>,
) -> PreflightOutcome {
    let mut decoder = SseDecoder::new();
    let mut adapter_state = AdapterStreamState::default();
    let mut raw = Vec::new();
    loop {
        match next_stream_chunk(stream, deadline_at_ms, caller_signal).await {
            NextChunk::Cancelled => return PreflightOutcome::Cancelled,
            NextChunk::TimedOut => return PreflightOutcome::Failure(AdapterErrorKind::Timeout),
            NextChunk::Chunk(None) => {
                let events = decoder.finish(&mut adapter_state);
                if events.iter().any(is_meaningful_stream_event) {
                    return PreflightOutcome::Output(raw);
                }
                return PreflightOutcome::Failure(AdapterErrorKind::InvalidResponse);
            }
            NextChunk::Chunk(Some(Err(_))) => {
                if caller_signal.is_some_and(AbortSignal::aborted) {
                    return PreflightOutcome::Cancelled;
                }
                return PreflightOutcome::Failure(AdapterErrorKind::ConnectionFailed);
            }
            NextChunk::Chunk(Some(Ok(chunk))) => {
                if raw.len().saturating_add(chunk.len()) > 512 * 1024 {
                    return PreflightOutcome::Failure(AdapterErrorKind::InvalidResponse);
                }
                raw.extend_from_slice(&chunk);
                let events = decoder.push(&chunk, &mut adapter_state);
                // Metadata, usage-only chunks, and an empty finish event do
                // not commit the downstream response. Keep reading until a
                // real text/tool delta arrives or the provider fails.
                if events.iter().any(is_meaningful_stream_event) {
                    return PreflightOutcome::Output(raw);
                }
                if adapter_state.invalid_response || adapter_state.done {
                    return PreflightOutcome::Failure(AdapterErrorKind::InvalidResponse);
                }
            }
        }
    }
}

fn is_meaningful_stream_event(event: &ProviderStreamEvent) -> bool {
    matches!(
        event,
        ProviderStreamEvent::TextDelta { .. } | ProviderStreamEvent::ToolCallDelta { .. }
    )
}

async fn collect_non_streaming(
    context: RequestContext,
    database: &crate::adapters::d1::D1Adapter,
    provider_content_type: Option<String>,
    mut provider_stream: futures_util::stream::LocalBoxStream<
        'static,
        Result<Vec<u8>, worker::Error>,
    >,
    first_chunk: Option<Vec<u8>>,
    mut metadata: StreamMetadata,
    caller_signal: Option<&AbortSignal>,
) -> Result<Response<Body>, ApiError> {
    let mut decoder = SseDecoder::new();
    let mut adapter_state = AdapterStreamState::default();
    let mut text = String::new();
    let mut json_buffer = String::new();
    let mut usage = None;
    let mut tool_calls = ToolCallTracker::default();
    let mut json_tool_calls = Vec::new();
    let mut first_output_at = None;
    let json_response = provider_content_type
        .as_deref()
        .is_some_and(|value| value.contains("application/json"))
        || first_chunk.as_ref().is_some_and(|chunk| {
            chunk.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{')
        });
    if let Some(chunk) = first_chunk {
        metadata.ttft_ms = Some(elapsed_ms(metadata.started_at_ms));
        first_output_at = Some(now_rfc3339());
        if json_response {
            json_buffer.push_str(&String::from_utf8_lossy(&chunk));
        } else {
            collect_events(
                &mut decoder,
                &mut adapter_state,
                &chunk,
                &mut text,
                &mut usage,
                &mut tool_calls,
            );
        }
    }
    loop {
        let chunk =
            match next_stream_chunk(&mut provider_stream, metadata.deadline_at_ms, caller_signal)
                .await
            {
                NextChunk::TimedOut => {
                    metadata.total_latency_ms = Some(elapsed_ms(metadata.started_at_ms));
                    let _ = finalize_request(
                        database,
                        &context,
                        &metadata,
                        usage.as_ref(),
                        first_output_at.as_deref(),
                        context.received_at.as_str(),
                        false,
                        Some("request_timeout"),
                    )
                    .await;
                    return Err(gateway_error(&context, "request_timeout"));
                }
                NextChunk::Cancelled => {
                    metadata.total_latency_ms = Some(elapsed_ms(metadata.started_at_ms));
                    let _ = finalize_request(
                        database,
                        &context,
                        &metadata,
                        usage.as_ref(),
                        first_output_at.as_deref(),
                        context.received_at.as_str(),
                        false,
                        Some("request_cancelled"),
                    )
                    .await;
                    return Err(gateway_error(&context, "request_cancelled"));
                }
                NextChunk::Chunk(None) => break,
                NextChunk::Chunk(Some(Err(_))) => {
                    let reason = if caller_signal.is_some_and(AbortSignal::aborted) {
                        "request_cancelled"
                    } else {
                        "upstream_invalid_response"
                    };
                    let _ = finalize_request(
                        database,
                        &context,
                        &metadata,
                        usage.as_ref(),
                        first_output_at.as_deref(),
                        context.received_at.as_str(),
                        false,
                        Some(reason),
                    )
                    .await;
                    return Err(gateway_error(&context, reason));
                }
                NextChunk::Chunk(Some(Ok(chunk))) => {
                    if first_output_at.is_none() {
                        metadata.ttft_ms = Some(elapsed_ms(metadata.started_at_ms));
                        first_output_at = Some(now_rfc3339());
                    }
                    chunk
                }
            };
        if json_response {
            json_buffer.push_str(&String::from_utf8_lossy(&chunk));
        } else {
            collect_events(
                &mut decoder,
                &mut adapter_state,
                &chunk,
                &mut text,
                &mut usage,
                &mut tool_calls,
            );
        }
    }
    if json_response
        && !collect_json_response(
            json_buffer.as_bytes(),
            &mut text,
            &mut usage,
            &mut json_tool_calls,
        )
    {
        adapter_state.invalid_response = true;
    }
    let calls = if json_response {
        json_tool_calls
    } else {
        match tool_calls.finish() {
            Ok(calls) => calls,
            Err(_) => {
                adapter_state.invalid_response = true;
                Vec::new()
            }
        }
    };
    if adapter_state.invalid_response {
        let _ = finalize_request(
            database,
            &context,
            &metadata,
            usage.as_ref(),
            None,
            context.received_at.as_str(),
            false,
            Some("upstream_invalid_response"),
        )
        .await;
        return Err(gateway_error(&context, "upstream_invalid_response"));
    }
    metadata.total_latency_ms = Some(elapsed_ms(metadata.started_at_ms));
    let completed_at = now_rfc3339();
    finalize_request(
        database,
        &context,
        &metadata,
        usage.as_ref(),
        first_output_at.as_deref(),
        &completed_at,
        true,
        None,
    )
    .await?;
    let body = if matches!(
        metadata.format,
        ResponseFormat::Chat | ResponseFormat::ChatWithUsage
    ) {
        let (message, finish_reason) = chat_response_message(&text, &calls);
        json!({"id": metadata.request_id, "object": "chat.completion", "model": metadata.model_alias, "alias": metadata.model_alias, "route_version_id": metadata.route_version_id, "provider_id": metadata.provider_id, "model_id": metadata.model_id, "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}], "usage": usage_json(usage.as_ref()), "fallback_count": metadata.fallback_count})
    } else {
        let mut output = vec![json!({"type": "text", "text": text})];
        output.extend(calls.iter().map(|call| {
            json!({"type": "tool_call", "call_id": call.id, "name": call.name, "arguments": call.arguments})
        }));
        json!({"request_id": metadata.request_id, "alias": metadata.model_alias, "model": metadata.model_alias, "route_version_id": metadata.route_version_id, "provider_id": metadata.provider_id, "model_id": metadata.model_id, "output": output, "usage": usage_json(usage.as_ref()), "fallback_count": metadata.fallback_count})
    };
    Ok(Json(body).into_response())
}

/// Buffered OpenAI-compatible assistant message: null content when the model
/// answered only with calls, and `tool_calls` finish reason.
fn chat_response_message(text: &str, calls: &[ToolCall]) -> (Value, &'static str) {
    if calls.is_empty() {
        return (json!({"role": "assistant", "content": text}), "stop");
    }
    let tool_calls = calls
        .iter()
        .map(|call| {
            json!({"id": call.id, "type": "function", "function": {"name": call.name, "arguments": call.arguments}})
        })
        .collect::<Vec<_>>();
    let content = if text.is_empty() {
        Value::Null
    } else {
        json!(text)
    };
    (
        json!({"role": "assistant", "content": content, "tool_calls": tool_calls}),
        "tool_calls",
    )
}

fn collect_json_response(
    chunk: &[u8],
    text: &mut String,
    usage: &mut Option<ProviderUsage>,
    calls: &mut Vec<ToolCall>,
) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(chunk) else {
        return false;
    };
    if value.get("error").is_some() {
        return false;
    }
    let has_anthropic_content = value.get("content").and_then(Value::as_array).is_some();
    let has_openai_choices = value.get("choices").and_then(Value::as_array).is_some();
    if !has_anthropic_content && !has_openai_choices {
        return false;
    }
    if let Some(content) = value.get("content").and_then(Value::as_array) {
        for part in content {
            if let Some(part_text) = part.get("text").and_then(Value::as_str) {
                text.push_str(part_text);
            }
        }
        if let Some(provider_usage) = value.get("usage") {
            *usage = Some(ProviderUsage {
                input_tokens: provider_usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
                output_tokens: provider_usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
                cached_tokens: None,
                provider_name: value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                pricing_version: None,
            });
        }
        return true;
    }
    if let Some(content) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    {
        text.push_str(content);
    }
    match value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
    {
        None | Some(Value::Null) => {}
        Some(Value::Array(provider_calls)) => match decode_message_tool_calls(provider_calls) {
            Ok(decoded) => *calls = decoded,
            Err(_) => return false,
        },
        Some(_) => return false,
    }
    if let Some(provider_usage) = value.get("usage").filter(|value| !value.is_null()) {
        *usage = Some(ProviderUsage {
            input_tokens: provider_usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            output_tokens: provider_usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            cached_tokens: provider_usage
                .get("prompt_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            provider_name: value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            pricing_version: None,
        });
    }
    true
}

fn collect_events(
    decoder: &mut SseDecoder,
    state: &mut AdapterStreamState,
    chunk: &[u8],
    text: &mut String,
    usage: &mut Option<ProviderUsage>,
    tool_calls: &mut ToolCallTracker,
) {
    for event in decoder.push(chunk, state) {
        match event {
            ProviderStreamEvent::TextDelta { text: delta } => text.push_str(&delta),
            ProviderStreamEvent::Usage { usage: value } => *usage = Some(value),
            ProviderStreamEvent::InvalidResponse => state.invalid_response = true,
            ProviderStreamEvent::ToolCallDelta {
                index,
                call_id,
                name,
                arguments_delta,
            } => {
                if tool_calls
                    .accept(index, call_id.as_deref(), name.as_deref(), &arguments_delta)
                    .is_err()
                {
                    state.invalid_response = true;
                }
            }
            ProviderStreamEvent::Done | ProviderStreamEvent::ProviderRequestId { .. } => {}
        }
    }
}

fn register_cancellation_finalizer(
    caller_signal: Option<&AbortSignal>,
    database: Arc<crate::adapters::d1::D1Adapter>,
    context: RequestContext,
    metadata: StreamMetadata,
    finalized: Rc<Cell<bool>>,
    background: BackgroundWork,
    clock: StreamClock,
) -> Result<(), ApiError> {
    let Some(caller_signal) = caller_signal else {
        return Ok(());
    };
    let error_context = context.clone();
    let callback = Closure::once_into_js(move || {
        trace_lifecycle(clock, "abort_event");
        schedule_cancel_settlement(
            &background,
            finalized,
            cancel_settlement(database, context, metadata),
        );
    });
    caller_signal
        .add_event_listener_with_callback("abort", callback.as_ref().unchecked_ref())
        .map_err(|_| service_unavailable(&error_context))
}

#[allow(clippy::too_many_arguments)]
async fn finalize_request_once(
    database: &crate::adapters::d1::D1Adapter,
    context: &RequestContext,
    metadata: &StreamMetadata,
    usage: Option<&ProviderUsage>,
    first_output_at: Option<&str>,
    completed_at: &str,
    success: bool,
    error_code: Option<&str>,
    finalized: &Rc<Cell<bool>>,
) -> Result<(), ApiError> {
    let Some(claim) = LatchClaim::take(finalized) else {
        return Ok(());
    };
    // Runs inside the response body, so the runtime can drop it mid-await once the
    // caller is gone. The claim releases the latch then, instead of stranding it.
    let reason = error_code.unwrap_or("completed");
    trace_inline(&format!("start:{reason}"));
    let result = finalize_request(
        database,
        context,
        metadata,
        usage,
        first_output_at,
        completed_at,
        success,
        error_code,
    )
    .await;
    match &result {
        Ok(_) => {
            claim.keep();
            trace_inline(&format!("ok:{reason}"));
        }
        Err(error) => {
            claim.release();
            trace_inline(&format!("err:{}", error.error.code.as_str()));
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn make_stream(
    database: Arc<crate::adapters::d1::D1Adapter>,
    context: RequestContext,
    provider_stream: futures_util::stream::LocalBoxStream<'static, Result<Vec<u8>, worker::Error>>,
    first_chunk: Option<Vec<u8>>,
    metadata: StreamMetadata,
    caller_signal: Option<AbortSignal>,
    finalized: Rc<Cell<bool>>,
    background: BackgroundWork,
    clock: StreamClock,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, worker::Error>> {
    // Registered now, not when a disconnect is noticed: the abort event and the
    // stream drop did not run in the probe. A timer bounds it to deadline + grace.
    let watchdog = background.watch(
        watchdog_delay_ms(metadata.deadline_at_ms, worker::js_sys::Date::now()),
        finalized.clone(),
        cancel_settlement(database.clone(), context.clone(), metadata.clone()),
    );
    let cancellation_guard = StreamCancellationGuard {
        database: database.clone(),
        context: context.clone(),
        metadata: metadata.clone(),
        finalized: finalized.clone(),
        background,
        clock,
    };
    stream::unfold(
        StreamState {
            provider_stream,
            decoder: SseDecoder::new(),
            adapter_state: AdapterStreamState::default(),
            usage: None,
            metadata,
            database,
            context,
            caller_signal,
            first_chunk,
            started: false,
            ended: false,
            failed: false,
            finalized,
            clock,
            pulls: 0,
            _cancellation_guard: cancellation_guard,
            first_output_at: None,
            tool_calls: ToolCallTracker::default(),
            _watchdog: watchdog,
        },
        |mut state| async move {
            if state.ended {
                return None;
            }
            let chunk = if !state.started {
                state.first_chunk.take()
            } else {
                let pull = PullScope::begin(state.clock, &mut state.pulls);
                let next = next_stream_chunk(
                    &mut state.provider_stream,
                    state.metadata.deadline_at_ms,
                    state.caller_signal.as_ref(),
                )
                .await;
                pull.end(next.label());
                match next {
                    NextChunk::Chunk(Some(Ok(chunk))) => Some(chunk),
                    NextChunk::TimedOut => {
                        state.failed = true;
                        state.ended = true;
                        state.metadata.total_latency_ms =
                            Some(elapsed_ms(state.metadata.started_at_ms));
                        let _ = finalize_request_once(
                            state.database.as_ref(),
                            &state.context,
                            &state.metadata,
                            state.usage.as_ref(),
                            state.first_output_at.as_deref(),
                            state.context.received_at.as_str(),
                            false,
                            Some("request_timeout"),
                            &state.finalized,
                        )
                        .await;
                        return Some((Ok(render_error(&state.metadata, "request_timeout")), state));
                    }
                    NextChunk::Cancelled => {
                        state.ended = true;
                        state.metadata.total_latency_ms =
                            Some(elapsed_ms(state.metadata.started_at_ms));
                        let _ = finalize_request_once(
                            state.database.as_ref(),
                            &state.context,
                            &state.metadata,
                            state.usage.as_ref(),
                            state.first_output_at.as_deref(),
                            state.context.received_at.as_str(),
                            false,
                            Some("request_cancelled"),
                            &state.finalized,
                        )
                        .await;
                        return None;
                    }
                    NextChunk::Chunk(Some(Err(_))) => {
                        if state
                            .caller_signal
                            .as_ref()
                            .is_some_and(AbortSignal::aborted)
                        {
                            state.ended = true;
                            state.metadata.total_latency_ms =
                                Some(elapsed_ms(state.metadata.started_at_ms));
                            let _ = finalize_request_once(
                                state.database.as_ref(),
                                &state.context,
                                &state.metadata,
                                state.usage.as_ref(),
                                state.first_output_at.as_deref(),
                                state.context.received_at.as_str(),
                                false,
                                Some("request_cancelled"),
                                &state.finalized,
                            )
                            .await;
                            return None;
                        }
                        state.failed = true;
                        state.ended = true;
                        state.metadata.total_latency_ms =
                            Some(elapsed_ms(state.metadata.started_at_ms));
                        let _ = finalize_request_once(
                            state.database.as_ref(),
                            &state.context,
                            &state.metadata,
                            state.usage.as_ref(),
                            state.first_output_at.as_deref(),
                            state.context.received_at.as_str(),
                            false,
                            Some("upstream_invalid_response"),
                            &state.finalized,
                        )
                        .await;
                        return Some((
                            Ok(render_error(&state.metadata, "upstream_invalid_response")),
                            state,
                        ));
                    }
                    NextChunk::Chunk(None) => None,
                }
            };
            let Some(chunk) = chunk else {
                state.ended = true;
                state.metadata.total_latency_ms = Some(elapsed_ms(state.metadata.started_at_ms));
                let remaining = state.decoder.finish(&mut state.adapter_state);
                // One terminal decision for the whole response. `may_complete`
                // is false for a malformed body and for a body that ended
                // without the protocol's terminal marker, so a stream that was
                // cut short is never recorded as a completion and never emits
                // one either. The flushed tail is still rendered so the caller
                // keeps what arrived, and the reservation is released rather
                // than committed, which is the same treatment a timeout or a
                // cancellation already gets.
                let completed = state.adapter_state.may_complete();
                let mut output = render_events(&mut state, remaining, completed);
                // Rendering can still reject the response: an incomplete or
                // out-of-bounds tool call is corrupt output, not a completion.
                let completed = completed && !state.failed;
                if !completed {
                    let _ = finalize_request_once(
                        state.database.as_ref(),
                        &state.context,
                        &state.metadata,
                        state.usage.as_ref(),
                        state.first_output_at.as_deref(),
                        state.context.received_at.as_str(),
                        false,
                        Some("upstream_invalid_response"),
                        &state.finalized,
                    )
                    .await;
                    // A decoded invalid response already emitted its own error
                    // event; a truncated tail did not, so it is emitted here.
                    if !state.failed {
                        output.extend(render_error(&state.metadata, "upstream_invalid_response"));
                    }
                    return Some((Ok(output), state));
                }
                let _ = finalize_request_once(
                    state.database.as_ref(),
                    &state.context,
                    &state.metadata,
                    state.usage.as_ref(),
                    state.first_output_at.as_deref(),
                    state.context.received_at.as_str(),
                    true,
                    None,
                    &state.finalized,
                )
                .await;
                if output.is_empty() {
                    output.extend(render_completion(
                        &state.metadata,
                        state.usage.as_ref(),
                        !state.tool_calls.is_empty(),
                    ));
                }
                return Some((Ok(output), state));
            };
            let events = state.decoder.push(&chunk, &mut state.adapter_state);
            let output = render_events(&mut state, events, false);
            if state.failed {
                state.ended = true;
                state.metadata.total_latency_ms = Some(elapsed_ms(state.metadata.started_at_ms));
                let _ = finalize_request_once(
                    state.database.as_ref(),
                    &state.context,
                    &state.metadata,
                    state.usage.as_ref(),
                    state.first_output_at.as_deref(),
                    state.context.received_at.as_str(),
                    false,
                    Some("upstream_invalid_response"),
                    &state.finalized,
                )
                .await;
                return Some((Ok(output), state));
            }
            if output.is_empty() && !state.ended {
                return Some((Ok(output), state));
            }
            Some((Ok(output), state))
        },
    )
}

fn render_events(
    state: &mut StreamState,
    events: Vec<ProviderStreamEvent>,
    terminal: bool,
) -> Vec<u8> {
    let mut output = Vec::new();
    if !state.started {
        state.started = true;
        state.metadata.ttft_ms = Some(elapsed_ms(state.metadata.started_at_ms));
        state.first_output_at = Some(now_rfc3339());
        output.extend(render_started(&state.metadata));
    }
    for event in events {
        match event {
            ProviderStreamEvent::TextDelta { text } => {
                output.extend(render_text(&state.metadata, &text));
            }
            ProviderStreamEvent::ToolCallDelta {
                index,
                call_id,
                name,
                arguments_delta,
            } => {
                if state
                    .tool_calls
                    .accept(index, call_id.as_deref(), name.as_deref(), &arguments_delta)
                    .is_err()
                {
                    state.failed = true;
                    output.extend(render_error(&state.metadata, "upstream_invalid_response"));
                    break;
                }
                output.extend(render_tool(
                    &state.metadata,
                    index,
                    call_id.as_deref(),
                    name.as_deref(),
                    &arguments_delta,
                ));
            }
            ProviderStreamEvent::Usage { usage } => state.usage = Some(usage),
            ProviderStreamEvent::ProviderRequestId {
                provider_request_id,
            } => {
                state.metadata.provider_request_id = Some(provider_request_id);
            }
            ProviderStreamEvent::Done => {}
            ProviderStreamEvent::InvalidResponse => {
                state.failed = true;
                output.extend(render_error(&state.metadata, "upstream_invalid_response"));
                break;
            }
        }
    }
    if terminal && !state.failed && state.tool_calls.finish().is_err() {
        state.failed = true;
        output.extend(render_error(&state.metadata, "upstream_invalid_response"));
    }
    if terminal && !state.failed {
        output.extend(render_completion(
            &state.metadata,
            state.usage.as_ref(),
            !state.tool_calls.is_empty(),
        ));
    }
    output
}

fn render_started(metadata: &StreamMetadata) -> Vec<u8> {
    let value = json!({"type": "response.started", "request_id": metadata.request_id, "alias": metadata.model_alias, "model": metadata.model_alias, "route_version_id": metadata.route_version_id, "route_version": metadata.route_version_number, "provider_id": metadata.provider_id, "model_id": metadata.model_id, "provider_request_id": metadata.provider_request_id});
    render_event(metadata, "response.started", &value)
}

fn render_text(metadata: &StreamMetadata, text: &str) -> Vec<u8> {
    let value = json!({
        "type": "response.output_text.delta",
        "request_id": metadata.request_id,
        "alias": metadata.model_alias,
        "model": metadata.model_alias,
        "route_version_id": metadata.route_version_id,
        "provider_id": metadata.provider_id,
        "model_id": metadata.model_id,
        "text": text
    });
    render_event(metadata, "response.output_text.delta", &value)
}

fn render_tool(
    metadata: &StreamMetadata,
    index: u32,
    call_id: Option<&str>,
    name: Option<&str>,
    arguments_delta: &str,
) -> Vec<u8> {
    // `call_id` and `name` are null on fragments where the provider omitted
    // them; the gateway never substitutes an id.
    let value = json!({
        "type": "response.tool_call.delta",
        "request_id": metadata.request_id,
        "alias": metadata.model_alias,
        "model": metadata.model_alias,
        "route_version_id": metadata.route_version_id,
        "provider_id": metadata.provider_id,
        "model_id": metadata.model_id,
        "index": index,
        "call_id": call_id,
        "name": name,
        "arguments_delta": arguments_delta
    });
    render_event(metadata, "response.tool_call.delta", &value)
}

fn render_error(metadata: &StreamMetadata, reason: &str) -> Vec<u8> {
    let value = json!({
        "type": "error",
        "request_id": metadata.request_id,
        "alias": metadata.model_alias,
        "model": metadata.model_alias,
        "route_version_id": metadata.route_version_id,
        "provider_id": metadata.provider_id,
        "model_id": metadata.model_id,
        "error": {"code": reason, "message": "The provider stream failed."}
    });
    render_event(metadata, "error", &value)
}

fn render_completion(
    metadata: &StreamMetadata,
    usage: Option<&ProviderUsage>,
    has_tool_calls: bool,
) -> Vec<u8> {
    let finish_reason = if has_tool_calls { "tool_calls" } else { "stop" };
    let value = json!({"type": "response.completed", "request_id": metadata.request_id, "alias": metadata.model_alias, "model": metadata.model_alias, "route_version_id": metadata.route_version_id, "provider_id": metadata.provider_id, "model_id": metadata.model_id, "fallback_count": metadata.fallback_count, "finish_reason": finish_reason, "usage": usage_json(usage)});
    render_event(metadata, "response.completed", &value)
}

fn render_event(metadata: &StreamMetadata, event_type: &str, value: &Value) -> Vec<u8> {
    if metadata.format == ResponseFormat::Native {
        format!("event: {event_type}\ndata: {value}\n\n").into_bytes()
    } else {
        let choice = if event_type == "response.completed" {
            let finish_reason = value
                .get("finish_reason")
                .and_then(Value::as_str)
                .unwrap_or("stop");
            json!({"index": 0, "delta": {}, "finish_reason": finish_reason})
        } else if event_type == "response.tool_call.delta" {
            json!({"index": 0, "delta": {"tool_calls": [chat_tool_call_delta(value)]}, "finish_reason": null})
        } else if event_type == "response.started" {
            json!({"index": 0, "delta": {"role": "assistant"}, "finish_reason": null})
        } else if event_type == "error" {
            json!({"index": 0, "delta": {}, "finish_reason": "error"})
        } else {
            json!({"index": 0, "delta": {"content": value.get("text").and_then(Value::as_str).unwrap_or("")}, "finish_reason": null})
        };
        let chunk = chat_completion_chunk(
            &metadata.request_id,
            &metadata.model_alias,
            &metadata.route_version_id,
            &metadata.provider_id,
            &metadata.model_id,
            json!([choice]),
            (event_type == "error")
                .then(|| value.get("error"))
                .flatten(),
        );
        let mut output = format!("data: {chunk}\n\n");
        if metadata.format == ResponseFormat::ChatWithUsage && event_type == "response.completed" {
            let usage = value.get("usage").map(chat_usage_json).unwrap_or_else(
                || json!({"prompt_tokens": null, "completion_tokens": null, "total_tokens": null}),
            );
            let usage_chunk = json!({
                "id": metadata.request_id,
                "object": "chat.completion.chunk",
                "model": metadata.model_alias,
                "alias": metadata.model_alias,
                "route_version_id": metadata.route_version_id,
                "provider_id": metadata.provider_id,
                "model_id": metadata.model_id,
                "choices": [],
                "usage": usage,
            });
            output.push_str(&format!("data: {usage_chunk}\n\n"));
        }
        if matches!(event_type, "response.completed" | "error") {
            output.push_str("data: [DONE]\n\n");
        }
        output.into_bytes()
    }
}

/// OpenAI `delta.tool_calls[]` element: `id`/`type`/`name` appear only on the
/// fragments where the provider sent an id/name.
fn chat_tool_call_delta(value: &Value) -> Value {
    let mut function = serde_json::Map::new();
    if let Some(name) = value.get("name").filter(|name| !name.is_null()) {
        function.insert("name".to_owned(), name.clone());
    }
    function.insert(
        "arguments".to_owned(),
        value
            .get("arguments_delta")
            .cloned()
            .unwrap_or_else(|| json!("")),
    );
    let mut call = json!({"index": value.get("index").cloned().unwrap_or(Value::Null)});
    if let Some(id) = value.get("call_id").filter(|id| !id.is_null()) {
        call["id"] = id.clone();
        call["type"] = json!("function");
    }
    call["function"] = Value::Object(function);
    call
}

fn chat_completion_chunk(
    request_id: &str,
    model_alias: &str,
    route_version_id: &str,
    provider_id: &str,
    model_id: &str,
    choices: Value,
    error: Option<&Value>,
) -> Value {
    let mut chunk = json!({
        "id": request_id,
        "object": "chat.completion.chunk",
        "model": model_alias,
        "alias": model_alias,
        "route_version_id": route_version_id,
        "provider_id": provider_id,
        "model_id": model_id,
        "choices": choices,
    });
    if let Some(error) = error {
        chunk["error"] = error.clone();
    }
    chunk
}

fn chat_usage_json(usage: &Value) -> Value {
    let input = usage.get("input_tokens").and_then(Value::as_u64);
    let output = usage.get("output_tokens").and_then(Value::as_u64);
    json!({
        "prompt_tokens": input,
        "completion_tokens": output,
        "total_tokens": input.zip(output).map(|(input, output)| input.saturating_add(output)),
    })
}

#[allow(clippy::too_many_arguments)]
async fn finalize_request(
    database: &crate::adapters::d1::D1Adapter,
    context: &RequestContext,
    metadata: &StreamMetadata,
    usage: Option<&ProviderUsage>,
    first_output_at: Option<&str>,
    completed_at: &str,
    success: bool,
    error_code: Option<&str>,
) -> Result<(), ApiError> {
    let state_value = if success { "completed" } else { "failed" };
    let update = AiRepository::new(database)
        .update_inference_request_statement(
            &metadata.request_id,
            &metadata.org_id,
            Some(&metadata.provider_id),
            Some(&metadata.model_id),
            metadata.credential_id.as_deref(),
            state_value,
            metadata.fallback_count,
            first_output_at,
            Some(completed_at),
            error_code,
        )
        .map_err(|error| database_error(context, error))?;
    let credential_update = metadata
        .credential_id
        .as_deref()
        .map(|credential_id| {
            AiRepository::new(database)
                .mark_credential_used_statement(credential_id, &context.received_at)
        })
        .transpose()
        .map_err(|error| database_error(context, error))?;
    let reservation_update = if metadata.managed_run {
        BudgetRepository::new(database)
            .reconcile_reservation_statement(&ReservationReconcileInput {
                reservation_id: &metadata.reservation_id,
                org_id: &metadata.org_id,
                request_id: &metadata.request_id,
                reconciled_at: completed_at,
                committed_minor: success.then_some(metadata.reserved_minor),
                status: if success { "committed" } else { "released" },
                reason: Some(if success {
                    "inference_completed"
                } else {
                    "inference_failed"
                }),
                budget_id: metadata.budget_id.as_deref(),
            })
            .map_err(|error| database_error(context, error))?
    } else {
        AiRepository::new(database)
            .update_budget_reservation_statement(
                &metadata.reservation_id,
                &metadata.org_id,
                &metadata.request_id,
                success.then_some(0),
                if success { "committed" } else { "released" },
                &context.received_at,
            )
            .map_err(|error| database_error(context, error))?
    };
    let mut statements = vec![update, reservation_update];
    if let Some(credential_update) = credential_update {
        statements.push(credential_update);
    }
    if success {
        let usage_id = new_resource_id("use");
        let usage_statement = AiRepository::new(database)
            .insert_usage_statement(
                usage_id.as_str(),
                &metadata.request_id,
                &metadata.org_id,
                metadata.project_id.as_deref(),
                metadata.run_id.as_deref(),
                &metadata.principal_user_id,
                Some(&metadata.session_id),
                metadata.device_id.as_deref(),
                &metadata.model_alias,
                &metadata.route_version_id,
                &metadata.provider_id,
                &metadata.model_id,
                metadata.credential_id.as_deref(),
                usage.and_then(|value| value.input_tokens).map(i64::from),
                usage.and_then(|value| value.output_tokens).map(i64::from),
                usage.and_then(|value| value.cached_tokens).map(i64::from),
                &usage_json(usage).to_string(),
                metadata.managed_run.then_some(metadata.reserved_minor),
                (!metadata.managed_run)
                    .then(|| usage.and_then(|value| value.output_tokens).map(|_| 0))
                    .flatten(),
                Some(&metadata.currency),
                usage.and_then(|value| value.pricing_version.as_deref()),
                &metadata.budget_decision,
                metadata.ttft_ms,
                metadata.total_latency_ms,
                &context.received_at,
            )
            .map_err(|error| database_error(context, error))?;
        statements.push(usage_statement);
        let usage_metadata = json!({
            "usage_event_id": usage_id.as_str(),
            "request_id": metadata.request_id,
            "project_id": metadata.project_id,
            "device_id": metadata.device_id,
            "run_id": metadata.run_id,
            "agent_session_id": metadata.agent_session_id,
            "workspace_binding_id": metadata.workspace_binding_id,
            "input_tokens": usage.and_then(|value| value.input_tokens),
            "output_tokens": usage.and_then(|value| value.output_tokens),
            "budget_decision": metadata.budget_decision
        });
        let usage_event_id = new_resource_id("sec").as_str().to_owned();
        statements.push(security_event_statement_with_context(
            database,
            context,
            None,
            None,
            Some(&metadata.org_id),
            SecurityEventId::new(usage_event_id),
            "usage.recorded.v1",
            "usage_event",
            Some(usage_id.as_str()),
            "success",
            &usage_metadata,
            metadata.device_id.as_deref(),
            metadata.run_id.as_deref(),
            metadata.agent_session_id.as_deref(),
            None,
        )?);
        statements.push(outbox_statement(
            database,
            context,
            None,
            Some(&metadata.org_id),
            "usage.recorded.v1",
            &usage_metadata,
        )?);
    }
    let event_metadata = json!({
        "provider_id": metadata.provider_id,
        "model_id": metadata.model_id,
        "fallback_count": metadata.fallback_count,
        "project_id": metadata.project_id,
        "device_id": metadata.device_id,
        "run_id": metadata.run_id,
        "agent_session_id": metadata.agent_session_id,
        "agent_definition_id": metadata.agent_definition_id,
        "agent_definition_version": metadata.agent_definition_version,
        "workspace_binding_id": metadata.workspace_binding_id,
        "policy_snapshot_id": metadata.policy_snapshot_id,
        "policy_version": metadata.policy_version,
        "usage": usage_json(usage),
        "budget_decision": metadata.budget_decision,
    });
    let action = if success {
        "inference.completed.v1"
    } else {
        "inference.failed.v1"
    };
    let event_id = new_resource_id("sec").as_str().to_owned();
    statements.push(security_event_statement_with_context(
        database,
        context,
        None,
        None,
        Some(&metadata.org_id),
        SecurityEventId::new(event_id),
        action,
        "inference",
        Some(&metadata.request_id),
        if success { "success" } else { "failure" },
        &event_metadata,
        metadata.device_id.as_deref(),
        metadata.run_id.as_deref(),
        metadata.agent_session_id.as_deref(),
        None,
    )?);
    statements.push(outbox_statement(
        database,
        context,
        None,
        Some(&metadata.org_id),
        action,
        &event_metadata,
    )?);
    database
        .batch(statements)
        .await
        .map_err(|error| database_error(context, error))?;
    if success && !metadata.provider_id.is_empty() {
        record_health_success(
            &AiRepository::new(database),
            &metadata.org_id,
            &metadata.provider_id,
            context,
        )
        .await;
        record_health_latency(
            &AiRepository::new(database),
            &metadata.org_id,
            &metadata.provider_id,
            metadata,
            context,
        )
        .await;
    } else if !success
        && matches!(
            error_code,
            Some("upstream_invalid_response")
                | Some("provider_unavailable")
                | Some("provider_rate_limited")
                | Some("request_timeout")
        )
        && !metadata.provider_id.is_empty()
        && !metadata.health_observed
    {
        record_health_error_code(
            &AiRepository::new(database),
            &metadata.org_id,
            &metadata.provider_id,
            error_code.unwrap_or("provider_unavailable"),
            context,
        )
        .await;
        record_health_latency(
            &AiRepository::new(database),
            &metadata.org_id,
            &metadata.provider_id,
            metadata,
            context,
        )
        .await;
    }
    Ok(())
}

fn retry_allowed(request: &InferenceRequest, controller: &RetryController) -> bool {
    request.retry_safe && controller.can_retry()
}

fn retry_backoff_ms(attempt: u8, seed: &str) -> u32 {
    let exponent = u32::from(attempt.saturating_sub(1).min(4));
    let base = 25_u32.saturating_mul(1_u32 << exponent).min(400);
    let jitter = seed
        .bytes()
        .fold(0_u32, |value, byte| value.wrapping_add(u32::from(byte)))
        % base.max(1);
    base.saturating_add(jitter)
}

fn now_rfc3339() -> String {
    String::from(
        worker::js_sys::Date::new(&JsValue::from_f64(worker::js_sys::Date::now())).to_iso_string(),
    )
}

fn elapsed_ms(started_at_ms: f64) -> i64 {
    (worker::js_sys::Date::now() - started_at_ms)
        .max(0.0)
        .round() as i64
}

fn usage_json(usage: Option<&ProviderUsage>) -> Value {
    usage.map_or_else(|| json!({"input_tokens": null, "output_tokens": null, "cached_tokens": null}), |value| json!({"input_tokens": value.input_tokens, "output_tokens": value.output_tokens, "cached_tokens": value.cached_tokens, "provider_name": value.provider_name, "pricing_version": value.pricing_version}))
}

fn validate_generation_limits(
    max_output_tokens: Option<u32>,
    temperature: Option<f32>,
    context: &RequestContext,
) -> Result<(), ApiError> {
    if max_output_tokens.is_some_and(|value| value > 1_000_000) {
        return Err(validation_error(
            context,
            "max_output_tokens_invalid",
            "The output token limit is too large.",
        ));
    }
    if temperature.is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value)) {
        return Err(validation_error(
            context,
            "temperature_invalid",
            "Temperature must be between 0 and 2.",
        ));
    }
    Ok(())
}

fn validate_tools(tools: &[Value], context: &RequestContext) -> Result<(), ApiError> {
    if tools.len() > MAX_INFERENCE_TOOLS {
        return Err(validation_error(
            context,
            "tools_invalid",
            "Provide no more than 128 tools.",
        ));
    }
    let encoded = serde_json::to_vec(tools).map_err(|_| {
        validation_error(
            context,
            "tools_invalid",
            "The tool definitions are invalid.",
        )
    })?;
    if encoded.len() > 128 * 1024 {
        return Err(validation_error(
            context,
            "tools_invalid",
            "The tool definitions are too large.",
        ));
    }
    for tool in tools {
        let Some(function) = tool
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| *value == "function")
            .and_then(|_| tool.get("function"))
        else {
            return Err(validation_error(
                context,
                "tools_invalid",
                "Only function tools are supported.",
            ));
        };
        let Some(name) = function.get("name").and_then(Value::as_str) else {
            return Err(validation_error(
                context,
                "tools_invalid",
                "Each tool function requires a name.",
            ));
        };
        if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            return Err(validation_error(
                context,
                "tools_invalid",
                "Tool function names are invalid.",
            ));
        }
        if function
            .get("parameters")
            .is_some_and(|value| !value.is_object() && !value.is_null())
        {
            return Err(validation_error(
                context,
                "tools_invalid",
                "Tool function parameters must be an object when provided.",
            ));
        }
    }
    Ok(())
}

fn native_request(
    body: NativeRequest,
    context: &RequestContext,
) -> Result<InferenceRequest, ApiError> {
    let mut messages = Vec::new();
    for message in body.messages {
        let role = match message.role.as_str() {
            "system" => MessageRole::System,
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            "tool" => MessageRole::Tool,
            _ => {
                return Err(validation_error(
                    context,
                    "message_invalid",
                    "Choose a valid message role.",
                ));
            }
        };
        let mut content = Vec::new();
        for part in message.content {
            if part.content_type != "text" {
                return Err(validation_error(
                    context,
                    "content_unsupported",
                    "Only text content is supported in this endpoint.",
                ));
            }
            let text = part.text.filter(|value| !value.is_empty()).ok_or_else(|| {
                validation_error(context, "content_invalid", "Message text is required.")
            })?;
            if text.len() > 256 * 1024 {
                return Err(validation_error(
                    context,
                    "content_too_large",
                    "Message content is too large.",
                ));
            }
            content.push(ContentPart::Text { text });
        }
        if content.is_empty() {
            return Err(validation_error(
                context,
                "content_invalid",
                "Message content is required.",
            ));
        }
        messages.push(InferenceMessage {
            role,
            content,
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
    }
    if messages.is_empty() || messages.len() > 128 {
        return Err(validation_error(
            context,
            "messages_invalid",
            "Provide between one and 128 messages.",
        ));
    }
    let total_text_bytes = messages
        .iter()
        .flat_map(|message| message.content.iter())
        .fold(0_usize, |total, part| {
            let ContentPart::Text { text } = part;
            total.saturating_add(text.len())
        });
    if total_text_bytes > 512 * 1024 {
        return Err(validation_error(
            context,
            "content_too_large",
            "The request content is too large.",
        ));
    }
    validate_generation_limits(body.max_output_tokens, body.temperature, context)?;
    let tools = body.tools.unwrap_or_default();
    validate_tools(&tools, context)?;
    let mut required = body
        .required_capabilities
        .unwrap_or_else(|| vec!["text".to_owned()])
        .into_iter()
        .map(|value| {
            ModelCapability::parse(&value).ok_or_else(|| {
                validation_error(
                    context,
                    "capability_invalid",
                    "Choose valid model capabilities.",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !tools.is_empty() && !required.contains(&ModelCapability::Tools) {
        required.push(ModelCapability::Tools);
    }
    let retry_safe = tools.is_empty();
    Ok(InferenceRequest {
        model: body.model,
        messages,
        required_capabilities: required,
        stream: body.stream.unwrap_or(true),
        max_output_tokens: body.max_output_tokens,
        temperature: body.temperature,
        tools,
        retry_safe,
        project_id: body.project_id,
        session_id: body.session_id,
        run_id: body.run_id,
    })
}

type ChatMessageError = (&'static str, &'static str);

/// Call ids issued by assistant messages and answered by tool messages so far.
#[derive(Default)]
struct ChatToolTurns {
    issued: std::collections::HashSet<String>,
    answered: std::collections::HashSet<String>,
}

impl ChatToolTurns {
    fn used(&self) -> bool {
        !self.issued.is_empty() || !self.answered.is_empty()
    }

    /// Every issued call must have its tool message by the end of the request.
    fn all_answered(&self) -> bool {
        self.issued.is_subset(&self.answered)
    }
}

fn chat_message_text(content: &Value) -> Result<Option<String>, ChatMessageError> {
    if content.is_null() {
        return Ok(None);
    }
    if let Some(value) = content.as_str() {
        return Ok(Some(value.to_owned()));
    }
    let values = content
        .as_array()
        .ok_or(("content_invalid", "Message content is invalid."))?;
    let mut text = String::new();
    for value in values {
        if value.get("type").and_then(Value::as_str) != Some("text") {
            return Err(("content_unsupported", "Only text content is supported."));
        }
        text.push_str(
            value
                .get("text")
                .and_then(Value::as_str)
                .ok_or(("content_invalid", "Message text is required."))?,
        );
    }
    Ok(Some(text))
}

fn chat_tool_calls(
    calls: Vec<ChatToolCall>,
    turns: &mut ChatToolTurns,
) -> Result<Vec<ToolCall>, ChatMessageError> {
    const INVALID: ChatMessageError = (
        "tool_calls_invalid",
        "The assistant tool calls are invalid.",
    );
    if calls.is_empty() || calls.len() > MAX_TOOL_CALLS {
        return Err(INVALID);
    }
    let mut accepted = Vec::with_capacity(calls.len());
    for call in calls {
        let arguments_are_object = call.function.arguments.len() <= MAX_TOOL_ARGUMENTS_BYTES
            && serde_json::from_str::<Value>(&call.function.arguments)
                .is_ok_and(|arguments| arguments.is_object());
        if call.call_type != "function"
            || !valid_tool_call_id(&call.id)
            || !valid_tool_name(&call.function.name)
            || !arguments_are_object
            || turns.issued.len() >= MAX_TOOL_CALLS
            || !turns.issued.insert(call.id.clone())
        {
            return Err(INVALID);
        }
        accepted.push(ToolCall {
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
        });
    }
    Ok(accepted)
}

/// Convert one OpenAI-compatible message. Tool fields are strictly bound to
/// their roles: calls only on assistant messages, a referenced issued and
/// still-unanswered call id on tool messages, neither anywhere else.
fn chat_message(
    message: ChatMessage,
    turns: &mut ChatToolTurns,
) -> Result<InferenceMessage, ChatMessageError> {
    let role = match message.role.as_str() {
        "system" => MessageRole::System,
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "tool" => MessageRole::Tool,
        _ => return Err(("message_invalid", "Choose a valid message role.")),
    };
    let text = chat_message_text(&message.content)?;
    if text.as_ref().is_some_and(|text| text.len() > 256 * 1024) {
        return Err(("content_too_large", "Message content is too large."));
    }
    let tool_field_error = (
        "message_invalid",
        "Tool fields do not belong on this message.",
    );
    let (text, tool_calls, tool_call_id) = match role {
        MessageRole::Assistant => match message.tool_calls.filter(|calls| !calls.is_empty()) {
            // An empty array is how some SDKs serialise plain assistant history.
            Some(calls) if message.tool_call_id.is_none() => {
                let calls = chat_tool_calls(calls, turns)?;
                (text.filter(|text| !text.is_empty()), calls, None)
            }
            Some(_) => return Err(tool_field_error),
            None if message.tool_call_id.is_some() => return Err(tool_field_error),
            None => (
                Some(text.ok_or(("content_invalid", "Message content is invalid."))?),
                Vec::new(),
                None,
            ),
        },
        MessageRole::Tool => {
            let id = message.tool_call_id.filter(|id| valid_tool_call_id(id));
            let id = id.ok_or((
                "tool_call_id_invalid",
                "A tool message must reference a call id.",
            ))?;
            if message.tool_calls.is_some() {
                return Err(tool_field_error);
            }
            if !turns.issued.contains(&id) || !turns.answered.insert(id.clone()) {
                return Err((
                    "tool_call_id_invalid",
                    "A tool message must answer one earlier unanswered call.",
                ));
            }
            (
                Some(text.ok_or(("content_invalid", "Message content is invalid."))?),
                Vec::new(),
                Some(id),
            )
        }
        MessageRole::System | MessageRole::User => {
            if message.tool_calls.is_some() || message.tool_call_id.is_some() {
                return Err(tool_field_error);
            }
            (
                Some(text.ok_or(("content_invalid", "Message content is invalid."))?),
                Vec::new(),
                None,
            )
        }
    };
    Ok(InferenceMessage {
        role,
        content: text
            .map(|text| vec![ContentPart::Text { text }])
            .unwrap_or_default(),
        tool_calls,
        tool_call_id,
    })
}

fn chat_request(body: ChatRequest, context: &RequestContext) -> Result<InferenceRequest, ApiError> {
    if body
        .tool_choice
        .as_ref()
        .is_some_and(|choice| choice.as_str() != Some("auto"))
    {
        return Err(validation_error(
            context,
            "tool_choice_unsupported",
            "Only automatic tool selection is supported.",
        ));
    }
    let mut messages = Vec::new();
    let mut turns = ChatToolTurns::default();
    for message in body.messages {
        messages.push(
            chat_message(message, &mut turns)
                .map_err(|(code, detail)| validation_error(context, code, detail))?,
        );
    }
    if messages.is_empty() || messages.len() > 128 {
        return Err(validation_error(
            context,
            "messages_invalid",
            "Provide between one and 128 messages.",
        ));
    }
    if !turns.all_answered() {
        return Err(validation_error(
            context,
            "tool_call_id_invalid",
            "Every assistant tool call needs a tool message.",
        ));
    }
    let total_content_bytes = messages.iter().fold(0_usize, |total, message| {
        total.saturating_add(message.content_bytes())
    });
    if total_content_bytes > 512 * 1024 {
        return Err(validation_error(
            context,
            "content_too_large",
            "The request content is too large.",
        ));
    }
    if body.max_tokens.is_some() && body.max_completion_tokens.is_some() {
        return Err(validation_error(
            context,
            "max_tokens_invalid",
            "Choose only one output token limit.",
        ));
    }
    validate_generation_limits(
        body.max_completion_tokens.or(body.max_tokens),
        body.temperature,
        context,
    )?;
    let tools = body.tools.unwrap_or_default();
    validate_tools(&tools, context)?;
    let mut required = vec![ModelCapability::Text];
    if !tools.is_empty() || turns.used() {
        required.push(ModelCapability::Tools);
    }
    let retry_safe = tools.is_empty() && !turns.used();
    Ok(InferenceRequest {
        model: body.model,
        messages,
        required_capabilities: required,
        stream: body.stream.unwrap_or(false),
        max_output_tokens: body.max_completion_tokens.or(body.max_tokens),
        temperature: body.temperature,
        tools,
        retry_safe,
        project_id: None,
        session_id: None,
        run_id: None,
    })
}

fn validate_request_scope(
    request: &InferenceRequest,
    current_session: &str,
    context: &RequestContext,
) -> Result<(), ApiError> {
    if request
        .session_id
        .as_deref()
        .is_some_and(|value| value != current_session)
    {
        return Err(domain_error(
            context,
            ApiErrorCode::PermissionDenied,
            "session_scope_mismatch",
            "The request session is outside the current access scope.",
        ));
    }
    if request.project_id.as_ref().is_some_and(|value| {
        value.is_empty() || value.len() > 255 || value.chars().any(char::is_control)
    }) {
        return Err(validation_error(
            context,
            "project_scope_invalid",
            "The project scope is invalid.",
        ));
    }
    if request
        .run_id
        .as_deref()
        .is_some_and(|value| crate::core::RunId::new(value).is_err())
    {
        return Err(validation_error(
            context,
            "run_scope_invalid",
            "The run scope is invalid.",
        ));
    }
    Ok(())
}

fn required_org_id(headers: &HeaderMap, context: &RequestContext) -> Result<String, ApiError> {
    let value = headers
        .get("x-org-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            domain_error(
                context,
                ApiErrorCode::PermissionDenied,
                "org_context_required",
                "Choose an active organization before calling inference.",
            )
        })?;
    crate::core::OrganizationId::new(value).map_err(|_| {
        domain_error(
            context,
            ApiErrorCode::ValidationFailed,
            "org_context_invalid",
            "The organization context is invalid.",
        )
    })?;
    Ok(value.to_owned())
}

async fn require_inference_write_proof(
    headers: &HeaderMap,
    session: &crate::repositories::SessionRecord,
    context: &RequestContext,
) -> Result<(), ApiError> {
    if headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("Bearer "))
    {
        Ok(())
    } else {
        require_csrf(headers, session, context).await
    }
}

fn policy_from_record(
    record: Option<&PolicyRecord>,
    environment: &str,
) -> (CatalogPolicy, CredentialMode) {
    let Some(record) = record else {
        if environment == "development" {
            return (
                CatalogPolicy::default(),
                CredentialMode::PlatformOrOrganization,
            );
        }
        return (
            CatalogPolicy {
                allowed_aliases: Some(Default::default()),
                allowed_models: Some(Default::default()),
                allowed_providers: Some(Default::default()),
                enabled: false,
            },
            CredentialMode::OrganizationOnly,
        );
    };
    let parse = |value: &str| {
        serde_json::from_str::<Vec<String>>(value)
            .ok()
            .map(|items| items.into_iter().collect())
    };
    let allowed_aliases = parse(&record.allowed_aliases_json);
    let allowed_models = parse(&record.allowed_models_json);
    let allowed_providers = parse(&record.allowed_providers_json);
    let malformed =
        allowed_aliases.is_none() || allowed_models.is_none() || allowed_providers.is_none();
    let policy = CatalogPolicy {
        allowed_aliases,
        allowed_models,
        allowed_providers,
        enabled: record.managed_route_enabled && !malformed,
    };
    (
        policy,
        CredentialMode::parse(&record.credential_mode).unwrap_or(CredentialMode::OrganizationOnly),
    )
}

fn model_descriptor(model: &ModelRecord) -> Option<crate::modules::catalog::ModelDescriptor> {
    let capabilities =
        serde_json::from_str::<Vec<ModelCapability>>(&model.capabilities_json).ok()?;
    Some(crate::modules::catalog::ModelDescriptor {
        model_id: model.model_id.clone(),
        provider_id: model.provider_id.clone(),
        provider_model_id: model.provider_model_id.clone(),
        display_name: model.display_name.clone(),
        capabilities: ModelCapabilities::new(capabilities),
        max_input_tokens: model
            .max_input_tokens
            .and_then(|value| u32::try_from(value).ok()),
        max_output_tokens: model
            .max_output_tokens
            .and_then(|value| u32::try_from(value).ok()),
        lifecycle: CatalogLifecycle::parse(&model.lifecycle)?,
        pricing_version: model.pricing_version.clone(),
    })
}

fn provider_descriptor(
    provider: &ProviderRecord,
) -> Option<crate::modules::catalog::ProviderDescriptor> {
    Some(crate::modules::catalog::ProviderDescriptor {
        provider_id: provider.provider_id.clone(),
        display_name: provider.display_name.clone(),
        adapter: provider.adapter.clone(),
        lifecycle: CatalogLifecycle::parse(&provider.lifecycle)?,
        endpoint_url: provider.endpoint_url.clone(),
    })
}

fn health_state(
    record: &crate::repositories::HealthRecord,
    now: &str,
) -> crate::modules::routing::HealthState {
    match record.state.as_str() {
        "cooldown"
            if record
                .cooldown_until
                .as_deref()
                .is_none_or(|cooldown_until| cooldown_until > now) =>
        {
            crate::modules::routing::HealthState::cooling_down(
                &record.provider_id,
                record
                    .cooldown_until
                    .as_deref()
                    .unwrap_or("9999-12-31T23:59:59.999Z"),
            )
        }
        "degraded" => crate::modules::routing::HealthState::Degraded {
            provider_id: record.provider_id.clone(),
            last_error: record
                .last_error_code
                .clone()
                .unwrap_or_else(|| "provider_error".to_owned()),
        },
        _ => crate::modules::routing::HealthState::ready(&record.provider_id),
    }
}

fn seed_from_id(value: &str) -> u64 {
    u64::from_str_radix(value.get(..16).unwrap_or("0"), 16).unwrap_or(1)
}
fn route_error_reason(error: crate::modules::routing::RouteSelectionError) -> &'static str {
    match error {
        crate::modules::routing::RouteSelectionError::UnsupportedCapability => {
            "unsupported_capability"
        }
        _ => "route_unavailable",
    }
}
fn gateway_reason(kind: AdapterErrorKind) -> &'static str {
    match kind {
        AdapterErrorKind::Timeout => "request_timeout",
        AdapterErrorKind::RateLimited => "provider_rate_limited",
        AdapterErrorKind::CredentialRejected => "credential_unavailable",
        AdapterErrorKind::UnsupportedCapability => "unsupported_capability",
        AdapterErrorKind::InvalidResponse => "upstream_invalid_response",
        AdapterErrorKind::InvalidRequest => "model_not_allowed",
        _ => "provider_unavailable",
    }
}
fn gateway_error(context: &RequestContext, reason: &str) -> ApiError {
    let code = match reason {
        "model_not_allowed"
        | "unsupported_capability"
        | "credential_unavailable"
        | "budget_exceeded"
        | "resource_scope_mismatch"
        | "device_revoked"
        | "device_not_approved"
        | "run_not_managed" => ApiErrorCode::PermissionDenied,
        "run_not_found" | "session_not_found" | "agent_not_found" | "project_not_found"
        | "device_not_found" | "resource_not_found" => ApiErrorCode::NotFound,
        "run_terminal" | "invalid_run_transition" | "session_closed" | "project_archived" => {
            ApiErrorCode::Conflict
        }
        "provider_rate_limited" | "rate_limit_exceeded" | "concurrency_limit_exceeded" => {
            ApiErrorCode::RateLimited
        }
        _ => ApiErrorCode::ServiceUnavailable,
    };
    domain_error(
        context,
        code,
        reason,
        "The inference request could not be completed.",
    )
}
fn validation_error(context: &RequestContext, reason: &str, message: &str) -> ApiError {
    domain_error(context, ApiErrorCode::ValidationFailed, reason, message)
}
fn service_unavailable(context: &RequestContext) -> ApiError {
    errors::api_error(
        context,
        ApiErrorCode::ServiceUnavailable,
        "The inference service is unavailable.",
    )
}
fn generated_id(prefix: &str) -> String {
    new_resource_id(prefix).as_str().to_owned()
}
fn page_limit(value: Option<u16>) -> u16 {
    value.unwrap_or(50).clamp(1, 100)
}
fn cursor_offset(context: &RequestContext, cursor: Option<&str>) -> Result<u32, ApiError> {
    let Some(cursor) = cursor.filter(|value| !value.is_empty()) else {
        return Ok(0);
    };
    let offset = cursor.parse::<u32>().map_err(|_| {
        ApiError::new(
            ApiErrorCode::BadRequest,
            "The pagination cursor is invalid.",
            context.request_id.clone(),
        )
        .with_detail("reason", json!("invalid_cursor"))
    })?;
    if offset > 1_000_000 {
        return Err(ApiError::new(
            ApiErrorCode::BadRequest,
            "The pagination cursor is invalid.",
            context.request_id.clone(),
        )
        .with_detail("reason", json!("invalid_cursor")));
    }
    Ok(offset)
}

fn page_window<T>(mut records: Vec<T>, limit: u16, offset: u32) -> (Vec<T>, Option<String>, bool) {
    let has_more = records.len() > usize::from(limit);
    records.truncate(usize::from(limit));
    let next_cursor = has_more.then(|| offset.saturating_add(u32::from(limit)).to_string());
    (records, next_cursor, has_more)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p05_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("x-project-id", "prj_11111111111111111111111111111111"),
            ("x-device-id", "dvc_22222222222222222222222222222222"),
            ("x-agent-session-id", "rse_33333333333333333333333333333333"),
            ("x-run-id", "run_44444444444444444444444444444444"),
            (
                "x-agent-definition-id",
                "agd_55555555555555555555555555555555",
            ),
            ("x-agent-definition-version", "7"),
            ("x-lumi-execution-mode", "managed"),
        ] {
            headers.insert(name, value.parse().unwrap());
        }
        headers
    }

    #[test]
    fn chat_request_accepts_standard_stream_usage_option_but_keeps_it_strict() {
        let request = serde_json::from_value::<ChatRequest>(json!({
            "model": "coding-default",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true,
            "stream_options": {"include_usage": true},
            "tool_choice": "auto",
            "max_tokens": 512
        }))
        .expect("OpenAI-compatible SDK stream_options are valid");
        assert_eq!(request.stream_options.unwrap().include_usage, Some(true));
        assert_eq!(request.tool_choice.unwrap(), "auto");
        assert!(
            serde_json::from_value::<ChatRequest>(json!({
                "model": "coding-default",
                "messages": [{"role": "user", "content": "hello"}],
                "stream_options": {"unknown": true}
            }))
            .is_err()
        );
    }

    #[test]
    fn successful_chat_stream_chunks_omit_the_error_field() {
        let success = chat_completion_chunk(
            "req_0123456789abcdef0123456789abcdef",
            "coding-default",
            "rte_0123456789abcdef0123456789abcdef",
            "prv_0123456789abcdef0123456789abcdef",
            "mdl_0123456789abcdef0123456789abcdef",
            json!([{"index": 0, "delta": {"content": "ok"}, "finish_reason": null}]),
            None,
        );
        assert!(success.get("error").is_none());

        let error = json!({"code": "provider_failed", "message": "failed"});
        let failure = chat_completion_chunk(
            "req_0123456789abcdef0123456789abcdef",
            "coding-default",
            "rte_0123456789abcdef0123456789abcdef",
            "prv_0123456789abcdef0123456789abcdef",
            "mdl_0123456789abcdef0123456789abcdef",
            json!([{"index": 0, "delta": {}, "finish_reason": "error"}]),
            Some(&error),
        );
        assert_eq!(failure["error"]["code"], "provider_failed");
    }

    #[test]
    fn chat_usage_keeps_missing_provider_measurements_unknown() {
        assert_eq!(
            chat_usage_json(&json!({"input_tokens": 4, "output_tokens": 3})),
            json!({"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7})
        );
        assert_eq!(
            chat_usage_json(&json!({"input_tokens": null, "output_tokens": null})),
            json!({"prompt_tokens": null, "completion_tokens": null, "total_tokens": null})
        );
    }

    #[test]
    fn p05_correlation_headers_are_complete_hints_and_merge_only_consistently() {
        let mut target = InferenceCorrelationTarget::default();
        let correlation = merge_p05_inference_headers(&HeaderMap::new(), &mut target).unwrap();
        assert_eq!(correlation, None);
        assert_eq!(target.project_id, None);

        let headers = p05_headers();
        let correlation = merge_p05_inference_headers(&headers, &mut target).unwrap();
        assert_eq!(
            correlation,
            Some(P05InferenceCorrelation {
                project_id: "prj_11111111111111111111111111111111".to_owned(),
                device_id: "dvc_22222222222222222222222222222222".to_owned(),
                agent_session_id: "rse_33333333333333333333333333333333".to_owned(),
                run_id: "run_44444444444444444444444444444444".to_owned(),
                agent_definition_id: "agd_55555555555555555555555555555555".to_owned(),
                agent_definition_version: 7,
            })
        );
        assert_eq!(
            target.run_id.as_deref(),
            Some("run_44444444444444444444444444444444")
        );
        assert_eq!(
            target.agent_session_id.as_deref(),
            Some("rse_33333333333333333333333333333333")
        );

        target.run_id = Some("run_66666666666666666666666666666666".to_owned());
        assert!(merge_p05_inference_headers(&headers, &mut target).is_err());
    }

    #[test]
    fn p05_correlation_headers_fail_closed_when_partial_or_not_managed() {
        let mut partial = HeaderMap::new();
        partial.insert(
            "x-run-id",
            "run_44444444444444444444444444444444".parse().unwrap(),
        );
        assert!(
            merge_p05_inference_headers(&partial, &mut InferenceCorrelationTarget::default())
                .is_err()
        );

        let mut local = p05_headers();
        local.insert("x-lumi-execution-mode", "local_only".parse().unwrap());
        assert!(
            merge_p05_inference_headers(&local, &mut InferenceCorrelationTarget::default())
                .is_err()
        );

        let mut invalid_version = p05_headers();
        invalid_version.insert("x-agent-definition-version", "07".parse().unwrap());
        assert!(
            merge_p05_inference_headers(
                &invalid_version,
                &mut InferenceCorrelationTarget::default()
            )
            .is_err()
        );
    }

    #[test]
    fn non_stream_provider_error_is_not_a_successful_empty_response() {
        let mut text = String::new();
        let mut usage = None;
        let mut calls = Vec::new();
        assert!(!collect_json_response(
            br#"{"error":{"code":"upstream_failed"}}"#,
            &mut text,
            &mut usage,
            &mut calls
        ));
        assert!(!collect_json_response(
            br#"{"id":"provider-only"}"#,
            &mut text,
            &mut usage,
            &mut calls
        ));
        assert!(collect_json_response(
            br#"{"choices":[{"message":{"content":"ok"}}]}"#,
            &mut text,
            &mut usage,
            &mut calls
        ));
        assert_eq!(text, "ok");
        text.clear();
        assert!(collect_json_response(
            br#"{"model":"claude","content":[{"type":"text","text":"anthropic"}],"usage":{"input_tokens":2,"output_tokens":3}}"#,
            &mut text,
            &mut usage,
            &mut calls
        ));
        assert_eq!(text, "anthropic");
    }

    #[test]
    fn buffered_tool_calls_with_null_content_render_as_openai_tool_message() {
        let mut text = String::new();
        let mut usage = None;
        let mut calls = Vec::new();
        assert!(collect_json_response(
            br#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"fs_write","arguments":"{\"path\":\"a\"}"}}]},"finish_reason":"tool_calls"}]}"#,
            &mut text,
            &mut usage,
            &mut calls
        ));
        let (message, finish) = chat_response_message(&text, &calls);
        assert_eq!(finish, "tool_calls");
        assert_eq!(message["content"], Value::Null);
        assert_eq!(message["tool_calls"][0]["id"], "call_1");
        assert_eq!(message["tool_calls"][0]["function"]["name"], "fs_write");
        // Corrupt buffered calls fail closed rather than being dropped.
        assert!(!collect_json_response(
            br#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"bad id","type":"function","function":{"name":"x","arguments":"{}"}}]}}]}"#,
            &mut text,
            &mut usage,
            &mut Vec::new()
        ));
        assert!(!collect_json_response(
            br#"{"choices":[{"message":{"tool_calls":"nope"}}]}"#,
            &mut text,
            &mut usage,
            &mut Vec::new()
        ));
        assert_eq!(chat_response_message("hi", &[]).1, "stop");
    }

    fn chat_json(messages: Value) -> ChatRequest {
        serde_json::from_value(json!({"model": "coding-default", "messages": messages}))
            .expect("structurally valid chat request")
    }

    fn convert(messages: Value) -> Result<Vec<InferenceMessage>, ChatMessageError> {
        let mut turns = ChatToolTurns::default();
        chat_json(messages)
            .messages
            .into_iter()
            .map(|message| chat_message(message, &mut turns))
            .collect()
    }

    const CALL: &str = r#"{"id":"call_1","type":"function","function":{"name":"fs_write","arguments":"{\"path\":\"a.txt\"}"}}"#;

    #[test]
    fn chat_tool_round_trip_preserves_assistant_calls_and_tool_result() {
        let call: Value = serde_json::from_str(CALL).unwrap();
        let converted = convert(json!([
            {"role": "user", "content": "write it"},
            {"role": "assistant", "content": null, "tool_calls": [call]},
            {"role": "tool", "tool_call_id": "call_1", "content": "done"},
        ]))
        .unwrap();
        assert!(converted[1].content.is_empty());
        assert_eq!(converted[1].tool_calls[0].name, "fs_write");
        assert_eq!(converted[2].tool_call_id.as_deref(), Some("call_1"));
        // Serialization to an OpenAI-compatible provider keeps both halves.
        let request = InferenceRequest {
            model: "m".to_owned(),
            messages: converted,
            required_capabilities: Vec::new(),
            stream: false,
            max_output_tokens: None,
            temperature: None,
            tools: Vec::new(),
            retry_safe: false,
            project_id: None,
            session_id: None,
            run_id: None,
        };
        let body: Value = serde_json::from_str(
            &crate::adapters::providers::translate_openai_request(&request, "p").unwrap(),
        )
        .unwrap();
        assert_eq!(body["messages"][1]["content"], Value::Null);
        assert_eq!(body["messages"][1]["tool_calls"][0]["type"], "function");
        assert_eq!(body["messages"][2]["tool_call_id"], "call_1");
        assert_eq!(body["messages"][2]["content"], "done");
    }

    #[test]
    fn ordinary_text_messages_are_unchanged() {
        let converted = convert(json!([
            {"role": "system", "content": "s"},
            {"role": "user", "content": [{"type": "text", "text": "u"}]},
            {"role": "assistant", "content": "a"},
        ]))
        .unwrap();
        assert!(
            converted
                .iter()
                .all(|message| message.tool_calls.is_empty())
        );
        assert!(
            converted
                .iter()
                .all(|message| message.tool_call_id.is_none())
        );
        assert_eq!(
            converted[2],
            InferenceMessage {
                role: MessageRole::Assistant,
                content: vec![ContentPart::Text {
                    text: "a".to_owned()
                }],
                tool_calls: Vec::new(),
                tool_call_id: None,
            }
        );
        // Null content is still invalid without calls.
        assert!(convert(json!([{"role": "assistant", "content": null}])).is_err());
        assert!(convert(json!([{"role": "user", "content": null}])).is_err());
    }

    #[test]
    fn chat_tool_fields_are_strict_unknown_fields_and_roles() {
        let call: Value = serde_json::from_str(CALL).unwrap();
        for bad in [
            json!([{"role": "assistant", "content": null, "tool_calls": [call.clone()], "extra": 1}]),
            json!([{"role": "assistant", "tool_calls": [{"id": "c", "type": "function", "function": {"name": "n", "arguments": "{}"}, "extra": 1}]}]),
            json!([{"role": "assistant", "tool_calls": [{"id": "c", "type": "function", "function": {"name": "n", "arguments": "{}", "extra": 1}}]}]),
            json!([{"role": "assistant", "tool_calls": [{"id": "c", "function": {"name": "n", "arguments": "{}"}}]}]),
            json!([{"role": "assistant", "tool_calls": [{"id": "c", "type": "function", "function": {"name": "n", "arguments": {}}}]}]),
        ] {
            assert!(
                serde_json::from_value::<ChatRequest>(json!({"model": "m", "messages": bad}))
                    .is_err()
            );
        }
        // Wrong role for tool fields.
        for role in ["user", "system", "tool"] {
            assert!(
                convert(json!([{"role": role, "content": "x", "tool_calls": [call.clone()]}]))
                    .is_err(),
                "{role} borrowed tool_calls"
            );
        }
        for role in ["user", "system", "assistant"] {
            assert!(
                convert(json!([{"role": role, "content": "x", "tool_call_id": "call_1"}])).is_err(),
                "{role} borrowed tool_call_id"
            );
        }
        assert!(convert(json!([{"role": "function", "content": "x"}])).is_err());
        // Assistant cannot hold both a result id and calls.
        assert!(convert(json!([{"role": "assistant", "tool_calls": [call.clone()], "tool_call_id": "call_1"}])).is_err());
    }

    #[test]
    fn chat_tool_ids_must_be_unique_issued_and_answered_once() {
        let call: Value = serde_json::from_str(CALL).unwrap();
        let assistant = json!({"role": "assistant", "tool_calls": [call.clone()]});
        let result = |id: &str| json!({"role": "tool", "tool_call_id": id, "content": "ok"});
        assert!(convert(json!([assistant.clone(), result("call_1")])).is_ok());
        // Unmatched, missing and malformed ids.
        assert!(convert(json!([assistant.clone(), result("call_9")])).is_err());
        assert!(convert(json!([result("call_1")])).is_err());
        assert!(convert(json!([assistant.clone(), {"role": "tool", "content": "ok"}])).is_err());
        assert!(convert(json!([assistant.clone(), result("bad id")])).is_err());
        // Duplicate call ids (same message and across messages) and duplicate results.
        assert!(
            convert(json!([{"role": "assistant", "tool_calls": [call.clone(), call.clone()]}]))
                .is_err()
        );
        assert!(convert(json!([assistant.clone(), assistant.clone()])).is_err());
        assert!(
            convert(json!([
                assistant.clone(),
                result("call_1"),
                result("call_1")
            ]))
            .is_err()
        );
        // A tool message cannot also carry calls, and needs content.
        assert!(convert(json!([assistant.clone(), {"role": "tool", "tool_call_id": "call_1", "content": null}])).is_err());
    }

    #[test]
    fn unanswered_calls_and_empty_call_arrays_follow_the_contract() {
        let call: Value = serde_json::from_str(CALL).unwrap();
        let mut turns = ChatToolTurns::default();
        for message in chat_json(json!([
            {"role": "assistant", "tool_calls": [call.clone()]},
            {"role": "user", "content": "next"},
        ]))
        .messages
        {
            chat_message(message, &mut turns).unwrap();
        }
        assert!(
            !turns.all_answered(),
            "call_1 never received a tool message"
        );
        let mut answered = ChatToolTurns::default();
        for message in chat_json(json!([
            {"role": "assistant", "tool_calls": [call]},
            {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
        ]))
        .messages
        {
            chat_message(message, &mut answered).unwrap();
        }
        assert!(answered.all_answered());
        // Plain assistant history with an empty array stays valid text.
        assert!(convert(json!([{"role": "assistant", "content": "hi", "tool_calls": []}])).is_ok());
        assert!(convert(json!([{"role": "assistant", "tool_calls": []}])).is_err());
    }

    #[test]
    fn chat_tool_call_bounds_are_enforced() {
        let call = |id: &str, name: &str, arguments: &str| json!({"id": id, "type": "function", "function": {"name": name, "arguments": arguments}});
        let assistant = |calls: Vec<Value>| json!([{"role": "assistant", "tool_calls": calls}]);
        assert!(convert(assistant(vec![call("a", "n", "{}")])).is_ok());
        assert!(convert(assistant(Vec::new())).is_err(), "empty array");
        assert!(convert(assistant(vec![call("", "n", "{}")])).is_err());
        assert!(convert(assistant(vec![call(&"a".repeat(129), "n", "{}")])).is_err());
        assert!(convert(assistant(vec![call("a", "", "{}")])).is_err());
        assert!(convert(assistant(vec![call("a", &"n".repeat(129), "{}")])).is_err());
        assert!(convert(assistant(vec![call("a", "bad\nname", "{}")])).is_err());
        // Arguments: invalid JSON, non-object JSON, empty, oversized.
        for arguments in ["{", "[]", "\"s\"", "", "null"] {
            assert!(
                convert(assistant(vec![call("a", "n", arguments)])).is_err(),
                "{arguments:?}"
            );
        }
        let oversized = format!("{{\"k\":\"{}\"}}", "x".repeat(MAX_TOOL_ARGUMENTS_BYTES));
        assert!(convert(assistant(vec![call("a", "n", &oversized)])).is_err());
        let many = (0..=MAX_TOOL_CALLS)
            .map(|index| call(&format!("c{index}"), "n", "{}"))
            .collect::<Vec<_>>();
        assert!(convert(assistant(many)).is_err(), "more than 128 calls");
        let exactly = (0..MAX_TOOL_CALLS)
            .map(|index| call(&format!("c{index}"), "n", "{}"))
            .collect::<Vec<_>>();
        assert!(convert(assistant(exactly)).is_ok());
    }

    #[test]
    fn tool_call_material_counts_toward_request_content_and_budget() {
        let call: Value = serde_json::from_str(CALL).unwrap();
        let converted = convert(json!([{"role": "assistant", "tool_calls": [call]}])).unwrap();
        assert!(converted[0].content_bytes() > "call_1fs_write".len());
        let request = InferenceRequest {
            model: "m".to_owned(),
            messages: converted,
            required_capabilities: Vec::new(),
            stream: false,
            max_output_tokens: None,
            temperature: None,
            tools: Vec::new(),
            retry_safe: false,
            project_id: None,
            session_id: None,
            run_id: None,
        };
        assert!(crate::modules::budget::estimate_request_tokens(&request) > 0);
    }

    fn metadata_fixture(format: ResponseFormat) -> StreamMetadata {
        StreamMetadata {
            request_id: "req_0123456789abcdef0123456789abcdef".to_owned(),
            format,
            model_alias: "coding-default".to_owned(),
            route_version_id: "rte_0123456789abcdef0123456789abcdef".to_owned(),
            route_version_number: 1,
            reservation_id: "rsv".to_owned(),
            reserved_minor: 0,
            budget_id: None,
            currency: "USD".to_owned(),
            provider_id: "prv_0123456789abcdef0123456789abcdef".to_owned(),
            model_id: "mdl_0123456789abcdef0123456789abcdef".to_owned(),
            provider_request_id: None,
            fallback_count: 0,
            project_id: None,
            run_id: None,
            session_id: "ses".to_owned(),
            device_id: None,
            agent_session_id: None,
            agent_definition_id: None,
            agent_definition_version: None,
            workspace_binding_id: None,
            policy_snapshot_id: None,
            policy_version: None,
            managed_run: false,
            principal_user_id: "usr".to_owned(),
            org_id: "org".to_owned(),
            credential_id: None,
            budget_decision: "allow".to_owned(),
            started_at_ms: 0.0,
            deadline_at_ms: 0.0,
            ttft_ms: None,
            total_latency_ms: None,
            health_observed: false,
        }
    }

    fn frames(rendered: &[u8]) -> Vec<Value> {
        String::from_utf8(rendered.to_vec())
            .unwrap()
            .split("\n\n")
            .filter_map(|frame| frame.strip_prefix("data: "))
            .filter(|data| *data != "[DONE]")
            .map(|data| serde_json::from_str(data).unwrap())
            .collect()
    }

    /// Provider bytes -> decoder -> chat renderer, then re-read the way an
    /// OpenAI SDK accumulates `delta.tool_calls` by index.
    #[test]
    fn fragmented_interleaved_provider_calls_round_trip_through_the_chat_renderer() {
        let provider: Vec<&[u8]> = vec![
            br#"data: {"id":"p","choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"fs_wri","arguments":""}}]}}]}

"#,
            br#"data: {"id":"p","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"ls","arguments":"{\"d"}}]}}]}

data: {"id":"p","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"te","arguments":"{\"path\":"}}]}}]}

"#,
            br#"data: {"id":"p","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a\"}"}},{"index":1,"function":{"arguments":"\":1}"}}]}}]}

data: {"id":"p","choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: {"id":"p","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":6}}

data: [DONE]

"#,
        ];
        let mut metadata = metadata_fixture(ResponseFormat::ChatWithUsage);
        let mut decoder = SseDecoder::new();
        let mut adapter_state = AdapterStreamState::default();
        let mut tracker = ToolCallTracker::default();
        let mut usage = None;
        let mut rendered = render_started(&metadata);
        for chunk in provider {
            for event in decoder.push(chunk, &mut adapter_state) {
                match event {
                    ProviderStreamEvent::ToolCallDelta {
                        index,
                        call_id,
                        name,
                        arguments_delta,
                    } => {
                        tracker
                            .accept(index, call_id.as_deref(), name.as_deref(), &arguments_delta)
                            .unwrap();
                        rendered.extend(render_tool(
                            &metadata,
                            index,
                            call_id.as_deref(),
                            name.as_deref(),
                            &arguments_delta,
                        ));
                    }
                    ProviderStreamEvent::Usage { usage: value } => usage = Some(value),
                    ProviderStreamEvent::ProviderRequestId {
                        provider_request_id,
                    } => {
                        metadata.provider_request_id = Some(provider_request_id);
                    }
                    ProviderStreamEvent::InvalidResponse => panic!("valid stream rejected"),
                    _ => {}
                }
            }
        }
        assert!(adapter_state.may_complete());
        tracker.finish().unwrap();
        rendered.extend(render_completion(
            &metadata,
            usage.as_ref(),
            !tracker.is_empty(),
        ));

        let text = String::from_utf8(rendered.clone()).unwrap();
        assert!(text.ends_with("data: [DONE]\n\n"));
        let chunks = frames(&rendered);
        // Fragments with an omitted id carry no substituted id.
        let later = chunks
            .iter()
            .filter_map(|chunk| chunk["choices"][0]["delta"]["tool_calls"][0].as_object())
            .filter(|call| call["index"] == 0 && !call.contains_key("id"))
            .count();
        assert_eq!(later, 2);
        // SDK-style accumulation.
        let mut accumulated: std::collections::BTreeMap<u64, (String, String, String)> =
            Default::default();
        for chunk in &chunks {
            for call in chunk["choices"][0]["delta"]["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let entry = accumulated
                    .entry(call["index"].as_u64().unwrap())
                    .or_default();
                if let Some(id) = call["id"].as_str() {
                    entry.0.push_str(id);
                }
                entry
                    .1
                    .push_str(call["function"]["name"].as_str().unwrap_or(""));
                entry
                    .2
                    .push_str(call["function"]["arguments"].as_str().unwrap_or(""));
            }
        }
        assert_eq!(
            accumulated.values().cloned().collect::<Vec<_>>(),
            vec![
                (
                    "call_a".to_owned(),
                    "fs_write".to_owned(),
                    "{\"path\":\"a\"}".to_owned()
                ),
                ("call_b".to_owned(), "ls".to_owned(), "{\"d\":1}".to_owned()),
            ]
        );
        let finish: Vec<_> = chunks
            .iter()
            .filter_map(|chunk| chunk["choices"][0]["finish_reason"].as_str())
            .collect();
        assert_eq!(finish, vec!["tool_calls"]);
        // The usage chunk is independent: empty choices, measured tokens.
        let usage_chunk = chunks.last().unwrap();
        assert_eq!(usage_chunk["choices"], json!([]));
        assert_eq!(usage_chunk["usage"]["prompt_tokens"], 11);
        assert_eq!(usage_chunk["usage"]["total_tokens"], 17);
    }

    #[test]
    fn plain_text_streams_keep_stop_and_native_tool_events_are_additive() {
        let metadata = metadata_fixture(ResponseFormat::Chat);
        let mut rendered = render_text(&metadata, "hi");
        rendered.extend(render_completion(&metadata, None, false));
        let chunks = frames(&rendered);
        assert_eq!(chunks[0]["choices"][0]["delta"]["content"], "hi");
        assert_eq!(chunks[1]["choices"][0]["finish_reason"], "stop");
        assert!(
            frames(&rendered)
                .iter()
                .all(|chunk| chunk["usage"].is_null())
        );

        let native = metadata_fixture(ResponseFormat::Native);
        let event = String::from_utf8(render_tool(&native, 2, None, Some("n"), "{}")).unwrap();
        assert!(event.starts_with("event: response.tool_call.delta\n"));
        let data: Value =
            serde_json::from_str(event.split("data: ").nth(1).unwrap().trim()).unwrap();
        assert_eq!(data["index"], 2);
        assert_eq!(data["call_id"], Value::Null, "no substituted id");
        assert_eq!(data["name"], "n");
        let done = String::from_utf8(render_completion(&native, None, true)).unwrap();
        assert!(done.contains("\"finish_reason\":\"tool_calls\""));
    }

    #[test]
    fn tool_output_is_committed_output_so_no_fallback_follows_it() {
        // A tool delta commits the stream (preflight returns Output), and a
        // committed stream can never be retried or fallen back.
        let delta = ProviderStreamEvent::ToolCallDelta {
            index: 0,
            call_id: Some("call_1".to_owned()),
            name: Some("fs_write".to_owned()),
            arguments_delta: String::new(),
        };
        assert!(is_meaningful_stream_event(&delta));
        let mut controller = RetryController::new(2, 2);
        controller.mark_dispatched();
        controller.mark_stream_committed();
        assert!(!controller.can_retry());
        controller.mark_retryable_failure(AdapterErrorKind::ConnectionFailed);
        assert_eq!(controller.fallback_count(), 0);
        assert_eq!(
            controller.state(),
            crate::modules::inference::ResponseLifecycle::Failed
        );
        // Requests carrying tool turns are never pre-dispatch retry safe.
        let call: Value = serde_json::from_str(CALL).unwrap();
        let messages = convert(json!([{"role": "assistant", "tool_calls": [call]}])).unwrap();
        assert!(messages[0].tool_call_id.is_none() && !messages[0].tool_calls.is_empty());
    }

    #[test]
    fn p05_managed_policy_scope_is_server_owned_and_exact() {
        let payload = json!({
            "org_access": { "member": true },
            "projects": { "bindings": ["prj_1", "prj_2"] },
            "device_id": "dvc_1",
        });
        assert!(p05_policy_scope_matches(&payload, "prj_2", "dvc_1"));
        assert!(!p05_policy_scope_matches(&payload, "prj_other", "dvc_1"));
        assert!(!p05_policy_scope_matches(&payload, "prj_1", "dvc_other"));
        let mut stale_member = payload.clone();
        stale_member["org_access"]["member"] = json!(false);
        assert!(!p05_policy_scope_matches(&stale_member, "prj_1", "dvc_1"));
    }

    #[test]
    fn p05_budget_snapshot_projection_keeps_scope_and_usage_authoritative() {
        let snapshot = BudgetScopeSnapshot {
            budget_id: "bud_1".to_owned(),
            org_id: "org_1".to_owned(),
            scope_type: "project".to_owned(),
            scope_id: Some("prj_1".to_owned()),
            period_start: "2026-09-01T00:00:00.000Z".to_owned(),
            period_end: "2026-10-01T00:00:00.000Z".to_owned(),
            limit_minor: 10,
            hard: true,
            version: 1,
            currency: "USD".to_owned(),
            created_at: "2026-09-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-09-01T00:00:00.000Z".to_owned(),
            spent_minor: 6,
            live_reserved_minor: 2,
        };
        let policy = budget_policy_from_snapshot(&snapshot).expect("valid P05 budget row");
        assert_eq!(policy.scope.scope_type.as_str(), "project");
        assert_eq!(policy.committed_minor, 6);
        assert_eq!(policy.reserved_minor, 2);
        let context = ScopeContext::user("org_1", Some("prj_1".to_owned()), "usr_1", "alias");
        let evaluation = evaluate_budget_request(
            &BudgetEvaluationRequest::new(
                context,
                3,
                true,
                epoch_seconds("2026-09-25T00:00:00.000Z").unwrap(),
            ),
            &[policy],
        );
        assert_eq!(evaluation.decision, P05BudgetDecision::Deny);
    }

    #[test]
    fn p05_timestamp_projection_is_fixed_width_and_ordered() {
        assert_eq!(
            canonical_instant_text("2026-09-25T12:00:00Z").as_deref(),
            Some("2026-09-25T12:00:00.000Z")
        );
        let first = epoch_seconds("2026-09-25T12:00:00.000Z").unwrap();
        let second = epoch_seconds("2026-09-25T12:00:01.000Z").unwrap();
        assert_eq!(second, first + 1);
    }

    #[test]
    fn stream_commitment_requires_meaningful_provider_output() {
        assert!(is_meaningful_stream_event(
            &ProviderStreamEvent::TextDelta {
                text: "hello".to_owned(),
            }
        ));
        assert!(is_meaningful_stream_event(
            &ProviderStreamEvent::ToolCallDelta {
                index: 0,
                call_id: Some("call-1".to_owned()),
                name: None,
                arguments_delta: "{}".to_owned(),
            }
        ));
        assert!(!is_meaningful_stream_event(
            &ProviderStreamEvent::ProviderRequestId {
                provider_request_id: "provider-1".to_owned(),
            }
        ));
        assert!(!is_meaningful_stream_event(&ProviderStreamEvent::Usage {
            usage: ProviderUsage {
                input_tokens: Some(1),
                output_tokens: Some(0),
                cached_tokens: None,
                provider_name: None,
                pricing_version: None,
            },
        }));
        assert!(!is_meaningful_stream_event(&ProviderStreamEvent::Done));
    }
}

#[cfg(test)]
mod v01_021_gateway_error_reasons {
    //! Every reason the gateway can raise must be CLASSIFIED, because the default is wrong.
    //!
    //! `gateway_error` maps a hand-written list of reasons to specific codes and sends **everything
    //! else** to `ServiceUnavailable`. So its safety depends on a list nobody can check at compile
    //! time, and a reason added without adding it to the list is reported to the client as an
    //! outage. V01-021 measured one: a caller naming a model alias its organization had no route for
    //! got `503 service_unavailable` / `details.reason = "route_unavailable"` for a condition it
    //! caused and could fix.
    //!
    //! The hazard is one level deeper. `route_error_reason` has its own `_ => "route_unavailable"`
    //! arm, so **any** `RouteSelectionError` the product does not enumerate also arrives as
    //! `route_unavailable` and becomes a 503. Two catch-alls, one wrong answer.
    //!
    //! So the test below does NOT demand that every reason be a 4xx — several are correctly 5xx, and
    //! insisting on that would be its own kind of wrong. It demands that every reason be
    //! **classified**, into one of two lists, and that a reason in neither list fails. A new reason
    //! therefore cannot be added without somebody deciding whether it is the client's fault, which
    //! is the decision that was skipped when `route_unavailable` was passed to a lookup the CALLER
    //! controls.
    //!
    //! The two lists are the decision. They live next to the test so that changing one means
    //! changing the argument.

    /// Reasons the CLIENT caused or can fix. These must be a 4xx: a client told "the service is
    /// unavailable" for something it did will retry, back off, and page someone.
    const CLIENT_CORRECTABLE: &[&str] = &[
        "model_not_allowed",
        "unsupported_capability",
        "credential_unavailable",
        "budget_exceeded",
        "resource_scope_mismatch",
        "device_revoked",
        "device_not_approved",
        "run_not_managed",
        "run_not_found",
        "session_not_found",
        "agent_not_found",
        "project_not_found",
        "device_not_found",
        "resource_not_found",
        "run_terminal",
        "invalid_run_transition",
        "session_closed",
        "project_archived",
    ];

    /// Reasons that genuinely denote a transient server-side condition, where 503 is the honest
    /// answer and a 4xx would be a lie:
    ///
    /// * `request_timeout` — the upstream did not answer in time.
    /// * `upstream_invalid_response` — the upstream answered with something unparseable.
    /// * `budget_state_unavailable` — the AUTHORITATIVE budget state could not be read, and the
    ///   objective requires unavailable authoritative budget state to be refused rather than
    ///   guessed at. Refusing with 503 is refusing.
    /// * `provider_rate_limited`, `rate_limit_exceeded`, `concurrency_limit_exceeded` — mapped to
    ///   `RateLimited`, which is a 4xx, and listed here only so the classification is exhaustive.
    /// * `request_cancelled` — the caller went away; nobody reads the status, and it is recorded so
    ///   the class is complete rather than because 503 is meaningful.
    /// * `route_unavailable` — the route exists but cannot serve: not published, no active version,
    ///   or a config that does not parse. That is a server-side state, so 503 is defensible. The one
    ///   site where it was NOT defensible — the org-scoped lookup a caller reaches by naming an
    ///   alias — now raises `model_not_allowed` instead, which is the whole of V01-021's repair.
    const LEGITIMATELY_TRANSIENT: &[&str] = &[
        "request_timeout",
        "upstream_invalid_response",
        "budget_state_unavailable",
        "provider_rate_limited",
        "rate_limit_exceeded",
        "concurrency_limit_exceeded",
        "request_cancelled",
        "route_unavailable",
    ];

    const SOURCE: &str = include_str!("inference.rs");

    #[test]
    fn every_reason_this_file_raises_is_classified() {
        let mut unclassified: Vec<String> = Vec::new();
        let text = SOURCE;
        let mut i = 0usize;
        while let Some(at) = text[i..].find("gateway_error(") {
            let start = i + at;
            let window = &text[start..(start + 120).min(text.len())];
            if let Some(q1) = window.find('"')
                && let Some(end) = window[q1 + 1..].find('"')
            {
                let reason = &window[q1 + 1..q1 + 1 + end];
                let known = !reason.is_empty()
                    && (CLIENT_CORRECTABLE.contains(&reason)
                        || LEGITIMATELY_TRANSIENT.contains(&reason));
                if !known {
                    unclassified.push(reason.to_owned());
                }
            }
            i = start + 1;
        }
        assert!(
            unclassified.is_empty(),
            "these reasons reach `gateway_error` and are in NEITHER class, so each is answered \
             `503 service_unavailable` by default: {unclassified:?}. Classify each as the client's \
             fault (a 4xx) or as a genuinely transient server state (503), and put it in the \
             corresponding list."
        );
    }

    #[test]
    fn the_two_classes_do_not_overlap() {
        for reason in CLIENT_CORRECTABLE {
            assert!(
                !LEGITIMATELY_TRANSIENT.contains(reason),
                "`{reason}` is in both classes, so the classification says nothing about it"
            );
        }
    }

    #[test]
    fn the_org_scoped_route_lookup_no_longer_reports_an_outage() {
        // The specific instance, pinned: a caller naming an alias their organization has no route
        // for is an AUTHORITY condition, and the reason it must not report is that this lookup is
        // the one a client reaches by naming something. If this ever goes back to
        // `route_unavailable`, the client is told the service is down for its own typo again.
        let window_start = SOURCE
            .find("find_route_by_alias(&org_id, &request.model)")
            .expect("the org-scoped route lookup is still present");
        let window = &SOURCE[window_start..(window_start + 260).min(SOURCE.len())];
        assert!(
            window.contains("model_not_allowed"),
            "the org-scoped `find_route_by_alias` miss must raise `model_not_allowed`, not \
             `route_unavailable`: a miss means THIS ORGANIZATION has no route for this alias, which \
             is the same fact the line above reports as `model_not_allowed`."
        );
    }
}
