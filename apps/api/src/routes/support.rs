use std::sync::Arc;

use serde_json::json;

use crate::{
    adapters::{
        d1::{BindValue, D1Adapter},
        new_event_id,
    },
    app::AppState,
    core::{
        ActorContext, ActorId, ApiError, ApiErrorCode, EventEnvelope, EventType, OrganizationId,
        Principal, RequestContext,
    },
    repositories::{OutboxRepository, UserRecord},
    routes::errors,
};

pub fn idempotency_key(
    headers: &axum::http::HeaderMap,
    context: &RequestContext,
) -> Result<String, ApiError> {
    let value = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        })
        .ok_or_else(|| {
            domain_error(
                context,
                ApiErrorCode::BadRequest,
                "idempotency_key_required",
                "Idempotency-Key is required for this mutation.",
            )
        })?;
    Ok(value.to_owned())
}

pub async fn deterministic_resource_id(
    prefix: &str,
    key: &str,
    scope: &str,
    context: &RequestContext,
) -> Result<String, ApiError> {
    let digest = crate::adapters::sha256_hex(&format!("{scope}:{key}"))
        .await
        .map_err(|_| {
            errors::api_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "The idempotency store is unavailable.",
            )
        })?;
    let value = format!("{prefix}_{}", &digest[..32]);
    crate::core::ResourceId::new(value)
        .map(|id| id.as_str().to_owned())
        .map_err(|_| {
            errors::api_error(
                context,
                ApiErrorCode::InternalError,
                "The idempotency resource ID is invalid.",
            )
        })
}

pub fn database<'a>(
    state: &'a Arc<AppState>,
    context: &RequestContext,
) -> Result<&'a D1Adapter, ApiError> {
    state.database.as_deref().ok_or_else(|| {
        errors::api_error(
            context,
            ApiErrorCode::ServiceUnavailable,
            "The identity store is unavailable.",
        )
    })
}

pub fn outbox_statement(
    database: &D1Adapter,
    context: &RequestContext,
    principal: Option<&Principal>,
    organization_id: Option<&str>,
    event_type: &str,
    payload: &serde_json::Value,
) -> Result<worker::d1::D1PreparedStatement, ApiError> {
    let actor = if let Some(principal) = principal {
        let actor_id = ActorId::new(principal.user_id.as_str()).map_err(|_| {
            errors::api_error(
                context,
                ApiErrorCode::InternalError,
                "The event actor is invalid.",
            )
        })?;
        ActorContext {
            actor_type: crate::core::ActorType::User,
            actor_id: Some(actor_id.clone()),
            effective_user_id: Some(actor_id),
        }
    } else {
        ActorContext::anonymous()
    };
    let organization_id = organization_id
        .map(OrganizationId::new)
        .transpose()
        .map_err(|_| {
            errors::api_error(
                context,
                ApiErrorCode::InternalError,
                "The event scope is invalid.",
            )
        })?;
    let event = EventEnvelope {
        event_id: new_event_id(),
        event_type: EventType::new(event_type).map_err(|_| {
            errors::api_error(
                context,
                ApiErrorCode::InternalError,
                "The event type is invalid.",
            )
        })?,
        occurred_at: context.received_at.clone(),
        request_id: context.request_id.clone(),
        correlation_id: context.correlation_id.clone(),
        actor,
        organization_id,
        payload: payload.clone(),
    };
    OutboxRepository::new(database)
        .insert_statement(&event)
        .map_err(|_| {
            errors::api_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "The event store is unavailable.",
            )
        })
}

/// An identifier in the `security_events` namespace.
///
/// # Why this is a type and not a `&str`
///
/// There are two id namespaces of the same length, and the database is the only
/// thing that tells them apart:
///
/// | table | wants | length |
/// |---|---|---|
/// | `outbox_events` | `evt_` + 32 hex | 36 |
/// | `security_events` | `sec_` + 32 hex | 36 |
///
/// A `&str` parameter accepts both, and the failure surfaces as a D1 CHECK
/// violation *inside a batch*, hundreds of lines from the call that caused it.
/// Fifteen call sites passed `adapters::new_event_id()` -- the `evt_`
/// constructor -- to `security_event_statement`, and every one took its whole
/// transaction down. Six were in P07 machine identity, so
/// `POST /orgs/{id}/service-accounts` answered 503 for a reason nobody could
/// read: `commit_scoped_mutation` discarded the error, and the discard was fixed
/// in the same week.
///
/// Encoding the namespace in the type means the wrong id cannot be passed, and a
/// caller who bypasses the type trips an assertion here that names the problem,
/// rather than a constraint that does not.
///
/// The `assert!` matches how `core::identifiers` handles the same problem for
/// `ResourceId`: an id invariant that a validated generator cannot violate
/// should not cost a `Result` at fifty-odd call sites.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecurityEventId(String);

impl SecurityEventId {
    /// The `sec_` namespace: 4 characters plus 32 hex.
    const PREFIX: &'static str = "sec_";
    const LENGTH: usize = 36;

    /// The only way to build one, and it refuses anything outside the namespace.
    pub fn new(value: impl Into<String>) -> Self {
        let value = value.into();
        assert!(
            value.starts_with(Self::PREFIX) && value.len() == Self::LENGTH,
            "a security_events.event_id must be {} characters and start with {:?}, got {:?}",
            Self::LENGTH,
            Self::PREFIX,
            value
        );
        Self(value)
    }

    /// A fresh id. Preferred over `new` wherever the caller was building one for
    /// this call anyway.
    pub fn generate() -> Self {
        Self::new(crate::adapters::new_resource_id("sec").as_str())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Build an immutable security-event insert for a mutation. The helper
/// intentionally accepts only bounded metadata and never serializes a request
/// body, credential, prompt, or response. P05 callers may add device/run
/// correlation without changing the P01-P04 call sites.
#[allow(clippy::too_many_arguments)]
pub fn security_event_statement_with_context<'a>(
    database: &'a D1Adapter,
    context: &RequestContext,
    principal: Option<&Principal>,
    organization_id: Option<&'a str>,
    event_id: SecurityEventId,
    action: &'a str,
    resource_type: &'a str,
    resource_id: Option<&'a str>,
    outcome: &'a str,
    metadata: &serde_json::Value,
    device_id: Option<&'a str>,
    run_id: Option<&'a str>,
    agent_session_id: Option<&'a str>,
    tool_call_id: Option<&'a str>,
) -> Result<worker::d1::D1PreparedStatement, ApiError> {
    let metadata = serde_json::to_string(metadata).map_err(|_| {
        errors::api_error(
            context,
            ApiErrorCode::InternalError,
            "The security event metadata is invalid.",
        )
    })?;
    let organization_id = organization_id.map_or(BindValue::Null, BindValue::Text);
    let actor_id = principal
        .map(|value| BindValue::Text(value.user_id.as_str()))
        .unwrap_or(BindValue::Null);
    let effective_user_id = principal
        .map(|value| BindValue::Text(value.user_id.as_str()))
        .unwrap_or(BindValue::Null);
    let session_id = principal
        .map(|value| BindValue::Text(value.session_id.as_str()))
        .unwrap_or(BindValue::Null);
    let device_id = device_id.map_or(BindValue::Null, BindValue::Text);
    let resource_id = resource_id.map_or(BindValue::Null, BindValue::Text);
    let run_id = run_id.map_or(BindValue::Null, BindValue::Text);
    let agent_session_id = agent_session_id.map_or(BindValue::Null, BindValue::Text);
    let tool_call_id = tool_call_id.map_or(BindValue::Null, BindValue::Text);
    database
        .prepare(
            "INSERT INTO security_events (event_id, org_id, actor_type, actor_id, effective_user_id, session_id, device_id, run_id, agent_session_id, tool_call_id, action, resource_type, resource_id, outcome, reason, metadata_json, request_id, correlation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?16, ?17, ?18)",
            &[
                BindValue::Text(event_id.as_str()),
                organization_id,
                BindValue::Text(if principal.is_some() { "user" } else { "system" }),
                actor_id,
                effective_user_id,
                session_id,
                device_id,
                run_id,
                agent_session_id,
                tool_call_id,
                BindValue::Text(action),
                BindValue::Text(resource_type),
                resource_id,
                BindValue::Text(outcome),
                BindValue::Text(&metadata),
                BindValue::Text(context.request_id.as_str()),
                BindValue::Text(context.correlation_id.as_str()),
                BindValue::Text(context.received_at.as_str()),
            ],
        )
        .map_err(|_| {
            errors::api_error(
                context,
                ApiErrorCode::ServiceUnavailable,
                "The security event store is unavailable.",
            )
        })
}

/// Build an immutable security-event insert for a P01-P04 mutation.
#[allow(clippy::too_many_arguments)]
pub fn security_event_statement<'a>(
    database: &'a D1Adapter,
    context: &RequestContext,
    principal: Option<&Principal>,
    organization_id: Option<&'a str>,
    event_id: SecurityEventId,
    action: &'a str,
    resource_type: &'a str,
    resource_id: Option<&'a str>,
    outcome: &'a str,
    metadata: &serde_json::Value,
) -> Result<worker::d1::D1PreparedStatement, ApiError> {
    security_event_statement_with_context(
        database,
        context,
        principal,
        organization_id,
        event_id,
        action,
        resource_type,
        resource_id,
        outcome,
        metadata,
        None,
        None,
        None,
        None,
    )
}

pub fn domain_error(
    context: &RequestContext,
    code: ApiErrorCode,
    reason: &str,
    message: &str,
) -> ApiError {
    errors::api_error(context, code, message).with_detail("reason", json!(reason))
}

/// Reserved prefix marking a console line as a fault worth a Sentry event.
///
/// Must equal `REPORT_PREFIX` in `apps/api/scripts/sentry-report-filter.mjs`. The
/// test at the bottom of this file reads that file and compares, because the two
/// halves are in different languages and a typo would silently disable reporting
/// rather than fail anything.
pub const REPORT_PREFIX: &str = "lumi:report:";

/// Report a swallowed fault, and make it findable.
///
/// Every error this repository swallowed used to be invisible *and* undiagnosable:
/// it was dropped without a log line, and the only thing a caller saw was a status
/// code chosen by a matcher several layers away. Two of those swallows are fixed in
/// this branch. The remaining question is where the report goes, and `console.error`
/// alone is not enough: the Worker entry is wrapped by `Sentry.withSentry`, which
/// sees thrown errors, and this line is precisely one that was never thrown.
///
/// So the line carries a prefix the entry recognises and forwards. It is still
/// written to the log as well, because `wrangler dev` and Workers Logs are where an
/// operator looks during development, and a diagnostic that disappeared from the log
/// stream when a DSN was unset would be worse than one that never reached Sentry.
pub fn report_error(context: &RequestContext, message: &str) {
    worker::console_error!(
        "{REPORT_PREFIX}{message} request_id={}",
        context.request_id.as_str()
    );
}

pub fn database_error(context: &RequestContext, error: worker::Error) -> ApiError {
    let debug = format!("{error:?}");
    if debug.contains("UNIQUE") || debug.contains("constraint") || debug.contains("CONFLICT") {
        domain_error(
            context,
            ApiErrorCode::Conflict,
            "conflict",
            "The request conflicts with current state.",
        )
    } else {
        errors::api_error(
            context,
            ApiErrorCode::ServiceUnavailable,
            "The identity store is unavailable.",
        )
    }
}

pub fn user_json(user: &UserRecord) -> serde_json::Value {
    json!({
        "id": user.user_id,
        "email": user.email,
        "display_name": user.display_name,
        "email_verified": user.email_verified,
        "created_at": user.created_at,
    })
}

pub fn is_development(state: &AppState) -> bool {
    state.environment == "development"
}

pub fn secure_cookie(state: &AppState) -> bool {
    state.environment == "production"
}

#[cfg(test)]
mod report_prefix_tests {
    //! The Rust and JavaScript halves of the reporting bridge must agree.
    //!
    //! `REPORT_PREFIX` in `apps/api/src/routes/support.rs` and `REPORT_PREFIX` in
    //! `apps/api/scripts/sentry-report-filter.mjs` are the same string in two
    //! languages. Nothing would catch a typo: a mismatched prefix would simply stop
    //! forwarding, and the symptom would be "the logs look fine and Sentry is empty",
    //! which reads like nobody has had a fault yet. So it is read and compared here,
    //! where a mismatch is a failing test rather than a silent absence.
    use super::REPORT_PREFIX;

    const FILTER_SOURCE: &str = include_str!("../../scripts/sentry-report-filter.mjs");

    #[test]
    fn the_rust_and_javascript_prefixes_are_the_same_string() {
        assert!(
            FILTER_SOURCE.contains(&format!(
                r#"export const REPORT_PREFIX = "{REPORT_PREFIX}""#
            )),
            "apps/api/scripts/sentry-report-filter.mjs no longer declares REPORT_PREFIX as \
             {REPORT_PREFIX:?}; a mismatch stops faults reaching Sentry without failing \
             anything else"
        );
    }

    #[test]
    fn the_bridge_is_installed_by_the_worker_entry() {
        // The other half of the wiring: a matching constant is useless if nothing
        // reads it.
        let entry = include_str!("../../sentry-entry.mjs");
        assert!(
            entry.contains("installReportBridge"),
            "apps/api/sentry-entry.mjs does not install the report bridge, so a marked \
             line would be written to the log and never reported"
        );
    }
}
