//! Device-only once-only pre-execution admission for P05-CR-004.
use super::*;
use crate::repositories::ToolExecutionClaim;

fn refused(context: &RequestContext) -> ApiError {
    domain_error(
        context,
        ApiErrorCode::Conflict,
        "tool_execution_refused",
        "The tool execution could not be admitted.",
    )
}

pub(super) async fn claim(
    state: Arc<AppState>,
    context: RequestContext,
    headers: HeaderMap,
    run_id: String,
    tool_call_id: String,
    body: ToolResultRequest,
) -> Result<Response<Body>, ApiError> {
    let access = authorize_device(&state, &headers, &context).await?;
    if RunId::new(run_id.as_str()).is_err() || ToolCallId::new(tool_call_id.as_str()).is_err() {
        return Err(not_found(&context, "The tool call was not found."));
    }
    let preflight = body.preflight.as_ref().ok_or_else(|| refused(&context))?;
    if preflight.tool_call_id != tool_call_id
        || body.result_summary.is_some()
        || body.error_code.is_some()
    {
        return Err(refused(&context));
    }
    let expected_hash = body
        .arguments_hash
        .as_deref()
        .ok_or_else(|| refused(&context))?;
    let expected_version = body
        .policy_version
        .filter(|v| *v > 0)
        .ok_or_else(|| refused(&context))?;
    let key = idempotency_key(&headers, &context)?;
    let raw_token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("DeviceToken "))
        .map(str::trim)
        .ok_or_else(|| refused(&context))?;
    let token_hash = sha256_hex(raw_token)
        .await
        .map_err(|_| service_unavailable(&context))?;
    let database = database(&state, &context)?;
    let tools = ToolRepository::new(database);
    let runs = RunRepository::new(database);
    let run = runs
        .find_run(&access.device.org_id, &run_id)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| not_found(&context, "The run was not found."))?;
    if run.device_id != access.device.device_id {
        return Err(not_found(&context, "The run was not found."));
    }
    let before = tools
        .find_tool_call_ref(&run_id, &tool_call_id)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| refused(&context))?;
    if before.org_id != run.org_id
        || before.execution_started_at.is_some()
        || matches!(
            before.status.as_str(),
            "denied" | "completed" | "failed" | "cancelled"
        )
    {
        return Err(refused(&context));
    }
    // Capture individual versions before evaluation. A change during evaluation
    // or audit construction must fail the transaction, even if its max version is unchanged.
    let tool = tools
        .find_tool(&before.tool_id, &run.org_id)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| refused(&context))?;
    let agent = runs
        .find_agent(&run.org_id, &run.agent_definition_id)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| refused(&context))?;
    let organization_policy = tools
        .find_tool_policy(&run.org_id, None)
        .await
        .map_err(|error| database_error(&context, error))?;
    let project_policy = tools
        .find_tool_policy(&run.org_id, Some(&run.project_id))
        .await
        .map_err(|error| database_error(&context, error))?;
    let snapshot = PolicyRepository::new(database)
        .latest_snapshot(&run.org_id)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| refused(&context))?;
    let mcp = tools
        .find_mcp_registration_by_fingerprint(&run.org_id, &before.tool_fingerprint)
        .await
        .map_err(|error| database_error(&context, error))?;
    let capabilities = tools
        .list_capabilities(&run.org_id, CAPABILITY_CATALOG_MAX)
        .await
        .map_err(|error| database_error(&context, error))?;
    let capability_binding = serde_json::to_string(
        &capabilities
            .iter()
            .map(|capability| {
                json!([
                    capability.capability_id,
                    capability.capability_key,
                    capability.risk_class,
                    capability.version
                ])
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|_| internal_error(&context))?;
    let response = create_tool_decision(
        State(state.clone()),
        Extension(context.clone()),
        headers.clone(),
        Path(run_id.clone()),
        Json(preflight.clone()),
    )
    .await?;
    if response.status() != StatusCode::OK {
        return Err(refused(&context));
    }
    let bytes = axum::body::to_bytes(response.into_body(), 16_384)
        .await
        .map_err(|_| internal_error(&context))?;
    let decision: Value = serde_json::from_slice(&bytes).map_err(|_| internal_error(&context))?;
    if decision["decision"] != "allow"
        || decision["run_id"] != run_id
        || decision["tool_call_id"] != tool_call_id
        || decision["tool_id"] != before.tool_id
        || decision["tool_fingerprint"] != before.tool_fingerprint
        || decision["risk_class"] != before.risk_class
        || decision["policy_state"] != "ok"
        || decision["policy_version"].as_i64() != Some(expected_version)
        || decision["arguments_hash"].as_str() != Some(expected_hash)
    {
        return Err(refused(&context));
    }
    let call = tools
        .find_tool_call_ref(&run_id, &tool_call_id)
        .await
        .map_err(|error| database_error(&context, error))?
        .ok_or_else(|| refused(&context))?;
    let hash = sha256_hex(&call.arguments_summary)
        .await
        .map_err(|_| service_unavailable(&context))?;
    if call.status != "allowed" || call.execution_started_at.is_some() || hash != expected_hash {
        return Err(refused(&context));
    }
    let claim_input = ToolExecutionClaim {
        run: &run,
        call: &call,
        device: &access.device,
        agent_version: agent.version,
        tool_version: tool.version,
        policy_id: &snapshot.policy_id,
        organization_policy: organization_policy.as_ref(),
        project_policy: project_policy.as_ref(),
        mcp: mcp.as_ref(),
        effective_policy_version: expected_version,
        now: &context.received_at,
        token_hash: &token_hash,
        capability_binding: &capability_binding,
    };
    let mut writes = tools
        .execution_claim_statements(&claim_input)
        .map_err(|error| database_error(&context, error))?;
    let approvals = ApprovalRepository::new(database);
    let approval = approvals
        .find_approval_for_tool_call(&run_id, &tool_call_id)
        .await
        .map_err(|error| database_error(&context, error))?;
    if let Some(approval) = approval.as_ref() {
        if decision["approval_id"].as_str() != Some(approval.approval_id.as_str()) {
            return Err(refused(&context));
        }
        writes.push(
            approvals
                .assert_execution_statement(approval, &claim_input, &hash)
                .map_err(|error| database_error(&context, error))?,
        );
        if approval.approval_mode == "per_use" {
            writes.push(
                approvals
                    .consume_approval_statement(
                        &approval.approval_id,
                        &run.org_id,
                        &tool_call_id,
                        &access.device.device_id,
                        &context.received_at,
                    )
                    .map_err(|error| database_error(&context, error))?,
            );
        }
    } else if decision["approval_id"].is_string() || decision["approval_mode"].is_string() {
        return Err(refused(&context));
    }
    let payload = json!({"tool_call_id": tool_call_id, "policy_version": expected_version});
    writes.push(
        runs.insert_event_statement(&NewRunEventInput {
            run_event_id: new_resource_id("rev").as_str(),
            run_id: &run_id,
            sequence: runs
                .next_event_sequence(&run.org_id, &run_id)
                .await
                .map_err(|error| database_error(&context, error))?,
            event_type: "tool.execution_started.v1",
            occurred_at: &context.received_at,
            actor_type: "device",
            actor_id: Some(&access.device.device_id),
            correlation_id: context.correlation_id.as_str(),
            tool_call_id: Some(&tool_call_id),
            approval_id: approval.as_ref().map(|a| a.approval_id.as_str()),
            payload: &payload,
        })
        .map_err(|error| database_error(&context, error))?,
    );
    writes.push(security_event_statement_with_context(
        database,
        &context,
        None,
        None,
        Some(&run.org_id),
        SecurityEventId::generate(),
        "tool.execution_started.v1",
        "tool_call",
        Some(&tool_call_id),
        "success",
        &payload,
        Some(&access.device.device_id),
        Some(&run_id),
        Some(&run.agent_session_id),
        Some(&tool_call_id),
    )?);
    let outbox = outbox_statement(
        database,
        &context,
        None,
        Some(&run.org_id),
        "tool.execution_started.v1",
        &payload,
    )?;
    let body_value = serde_json::to_value(&body).map_err(|_| internal_error(&context))?;
    let claim = match prepare_scoped_mutation(
        database,
        &context,
        &access.device.device_id,
        &run.org_id,
        &key,
        "POST",
        &format!("/api/v1/devices/runs/{run_id}/tool-calls/{tool_call_id}/result"),
        &body_value,
    )
    .await?
    {
        crate::routes::usage::PreparedScopedMutation::Replay(_) => return Err(refused(&context)),
        crate::routes::usage::PreparedScopedMutation::Claim(claim) => claim,
    };
    let mut admitted = decision;
    admitted["status"] = json!("allowed");
    admitted["execution_started_at"] = json!(context.received_at);
    let success =
        StoredSuccess::new(200, admitted.clone()).map_err(|_| internal_error(&context))?;
    match commit_scoped_mutation(database, &context, claim, success, writes, outbox).await? {
        ScopedMutationCommit::Committed => Ok(Json(admitted).into_response()),
        ScopedMutationCommit::Replayed(_) | ScopedMutationCommit::Guarded => Err(refused(&context)),
    }
}
