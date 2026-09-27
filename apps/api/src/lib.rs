pub mod adapters;
mod app;
pub mod consumers;
pub mod core;
pub mod http;
pub mod jobs;
pub mod modules;
pub mod repositories;
mod routes;
pub mod security;

use crate::adapters::d1::D1Adapter;

use tower_service::Service;
use worker::*;

#[event(fetch)]
async fn fetch(
    req: HttpRequest,
    env: Env,
    _ctx: Context,
) -> Result<axum::http::Response<axum::body::Body>> {
    Ok(app::router(env).call(req).await?)
}

/// Queue events are decoded into the versioned business envelope before the
/// consumer sees them. Per-message acknowledgement and retry are handled by
/// the adapter only after durable D1 state transitions.
#[event(queue)]
async fn queue(batch: MessageBatch<serde_json::Value>, env: Env, _ctx: Context) -> Result<()> {
    // workers-rs generates a single queue entry point per crate, so the P01
    // outbox and the P06 job queue share one handler and are told apart by the
    // queue they were delivered on. The two carry DIFFERENT envelopes: the
    // outbox carries the business `EventEnvelope`, while P06 jobs carry a job
    // envelope with its own dedupe key, generation, and lease version. Decoding
    // one as the other would let the source event's delivery status be mistaken
    // for job or webhook delivery state, so the split happens before any decode.
    if batch.queue() == p06_jobs_queue_name(&env) {
        return consume_p06_jobs(&batch, &env).await;
    }
    // The jobs dead-letter queue is consumed too, and it is the ONLY path by
    // which a job that exhausted its retries becomes visible in Lumi. It is
    // checked before the outbox, because a job envelope decoded as a business
    // event is undecodable and would be acknowledged as an invalid message —
    // which is exactly what used to happen: `JOBS_DLQ_NAME` was declared in
    // `wrangler.jsonc` with a consumer attached, and nothing in Rust ever read
    // it. A poison `webhook.deliver` or `export.run` therefore vanished, and
    // `consumers::dead_letter_statement` had no callers at all.
    if batch.queue() == p06_jobs_dlq_name(&env) {
        return consume_p06_dead_letters(&batch, &env).await;
    }
    consume_p01_outbox(&batch, &env).await
}

fn p06_jobs_queue_name(env: &Env) -> String {
    env.var("JOBS_QUEUE_NAME")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "lumi-agents-jobs".to_owned())
}

fn p06_jobs_dlq_name(env: &Env) -> String {
    env.var("JOBS_DLQ_NAME")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "lumi-agents-jobs-dlq".to_owned())
}

/// Record every dead-lettered job durably, THEN acknowledge.
///
/// The order is the whole point. `ack()` first would make the message disappear
/// with nothing recorded, and a redelivery of an already-recorded job must be a
/// no-op rather than a second terminal transition, so the write is guarded on the
/// row's own lease version.
async fn consume_p06_dead_letters(
    batch: &MessageBatch<serde_json::Value>,
    env: &Env,
) -> Result<()> {
    use worker::MessageExt;

    let database = D1Adapter::new(env.d1("DB")?);
    let now = jobs::now_utc().map_err(|_| Error::RustError("worker clock unavailable".into()))?;
    let Ok(messages) = batch.messages() else {
        batch.retry_all();
        return Ok(());
    };
    for message in messages {
        let body: &serde_json::Value = message.body();
        let Ok(envelope) = serde_json::from_value::<consumers::QueueJobEnvelope>(body.clone())
        else {
            // A body that is not a job envelope has no job row to mark, so there
            // is nothing to record. Acknowledged rather than redelivered forever
            // against a queue that can never accept it.
            console_error!("p06_job_dead_lettered:queue_job_envelope_invalid");
            message.ack();
            continue;
        };
        let repository = repositories::WebhookRepository::new(&database);
        let record = match repository.find_job(&envelope.job_id).await {
            Ok(Some(record)) => record,
            Ok(None) => {
                // The row is gone (a completed deletion, say). Nothing to mark.
                message.ack();
                continue;
            }
            Err(_) => {
                // The store is unavailable. Retried rather than acknowledged, or
                // the failure would become permanent precisely when the system is
                // already unhealthy.
                message.retry();
                continue;
            }
        };
        // An unrecognised stored state is treated as NOT terminal, so an unknown
        // value is marked rather than silently treated as already settled.
        if repositories::QueueJobState::parse(&record.state)
            .is_some_and(|state| state.is_terminal())
        {
            // Already settled. A duplicate dead-letter delivery must not rewrite
            // why the job stopped.
            message.ack();
            continue;
        }
        let statement = match consumers::automations::dead_letter_statement(
            &database,
            &envelope.job_id,
            record.lease_version,
            "queue_dead_lettered",
            &now,
        ) {
            Ok(statement) => statement,
            Err(_) => {
                message.retry();
                continue;
            }
        };
        match database.batch(vec![statement]).await {
            Ok(_) => message.ack(),
            // Not acknowledged on failure: the whole point of this consumer is
            // that a failure here is visible rather than lost.
            Err(_) => message.retry(),
        }
    }
    Ok(())
}

async fn consume_p01_outbox(batch: &MessageBatch<serde_json::Value>, env: &Env) -> Result<()> {
    let database = D1Adapter::new(env.d1("DB")?);
    let store = repositories::OutboxRepository::new(&database);
    let now = jobs::now_utc().map_err(|_| Error::RustError("worker clock unavailable".into()))?;
    let retry_policy = outbox_retry_policy();
    let dead_letter_queue = env
        .var("OUTBOX_DLQ_NAME")
        .map(|value| value.to_string())
        .map_err(|_| Error::RustError("dead-letter queue configuration unavailable".into()))?;

    consumers::consume_outbox_batch(batch, &store, &now, retry_policy, &dead_letter_queue).await
}

/// P06 durable job queue.
///
/// This is a SEPARATE handler from the P01 outbox queue on purpose. The
/// outbox queue is typed as the business `EventEnvelope`; P06 job messages are
/// a different envelope with its own dedupe key, generation, and lease
/// version. Decoding one as the other would make a job message look like a
/// business event (or the reverse) and would let the source event's delivery
/// status be mistaken for job or webhook delivery state.
///
/// The body is read as an untyped value and routed on `job_type` rather than
/// decoded into one envelope up front: export and deletion jobs carry a
/// different payload shape than webhook and notification jobs, so a single
/// typed decode would reject half the queue.
async fn consume_p06_jobs(batch: &MessageBatch<serde_json::Value>, env: &Env) -> Result<()> {
    use worker::MessageExt;

    let database = D1Adapter::new(env.d1("DB")?);
    let now = jobs::now_utc().map_err(|_| Error::RustError("worker clock unavailable".into()))?;
    let artifacts = env
        .bucket(adapters::r2::ARTIFACT_BINDING)
        .ok()
        .map(adapters::r2::ExportArtifactStore::new);

    // The webhook secret encryption key comes from configuration, never from a
    // request. A missing key is not fatal: the handler then treats a secret as
    // undecryptable and fails that delivery closed, which is the right behavior
    // for a misconfigured environment rather than an undeliverable secret.
    let encryption_key = env.var("WEBHOOK_SECRET_KEY").ok().map(|v| v.to_string());
    let environment = env
        .var("ENVIRONMENT")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "production".to_owned());
    let email = adapters::webhooks::WorkerEmailTransport::new(
        env.send_email("EMAIL").ok(),
        env.var("EMAIL_FROM").ok().map(|v| v.to_string()),
        environment,
    );
    let resolver = adapters::webhooks::CloudflareDnsResolver;

    let automation = consumers::AutomationJobHandler::new(&database);
    let notifications = consumers::NotificationDeliveryJobHandler::new(&database, &email);
    let webhooks = consumers::WebhookDeliveryJobHandler::new(&database, encryption_key, &resolver);

    let Ok(messages) = batch.messages() else {
        batch.retry_all();
        return Ok(());
    };
    for message in messages {
        // Route on the declared job type. An unknown or absent type can never
        // become runnable, so it is acknowledged rather than redelivered
        // forever against a queue that will never accept it.
        let body: &serde_json::Value = message.body();
        let Some(job_type) = body.get("job_type").and_then(serde_json::Value::as_str) else {
            message.ack();
            continue;
        };
        let job_type = job_type.to_owned();

        let failure: Option<String> = if is_data_job_type(&job_type) {
            match serde_json::from_value::<consumers::DataJobEnvelope>(body.clone()) {
                Ok(envelope) => {
                    match consumers::handle_data_job(&database, artifacts.clone(), &now, &envelope)
                        .await
                    {
                        // A terminal durable outcome is already recorded, so the
                        // message is acknowledged. Only an explicit retry
                        // schedule or an unresolved failure is redelivered.
                        Ok(outcome) => {
                            let retry = matches!(
                                outcome,
                                consumers::DataJobOutcome::RetryScheduled
                                    | consumers::DataJobOutcome::NeedsAttention
                            );
                            if retry {
                                message.retry();
                            } else {
                                message.ack();
                            }
                            continue;
                        }
                        Err(error) => Some(error.code().to_owned()),
                    }
                }
                // A body that is not a valid envelope can never become one on a
                // retry, so it is acknowledged rather than redelivered forever.
                Err(_) => {
                    console_error!("p06_data_job_rejected:queue_job_envelope_invalid");
                    message.ack();
                    continue;
                }
            }
        } else {
            match serde_json::from_value::<consumers::QueueJobEnvelope>(body.clone()) {
                Ok(envelope) => {
                    // Each handler reports `NotOwned` for a job type it does not
                    // own, so routing is explicit on the declared type rather
                    // than positional on queue arrival order.
                    let outcome = if is_automation_job_type(&job_type) {
                        consumers::JobHandler::run(&automation, &envelope, &now).await
                    } else if is_webhook_job_type(&job_type) {
                        consumers::JobHandler::run(&webhooks, &envelope, &now).await
                    } else {
                        consumers::JobHandler::run(&notifications, &envelope, &now).await
                    };
                    match outcome {
                        Ok(consumers::JobOutcome::RetryScheduled) => {
                            message.retry();
                            None
                        }
                        Ok(_) => {
                            message.ack();
                            None
                        }
                        Err(failure) if failure.retryable => Some(failure.code.as_str().to_owned()),
                        // A permanent handler failure is durably recorded, so
                        // the message is acknowledged instead of retried forever.
                        Err(failure) => {
                            console_error!("p06_job_rejected:{}", failure.code.as_str());
                            message.ack();
                            None
                        }
                    }
                }
                // An envelope that fails validation can never become valid.
                Err(_) => {
                    console_error!("p06_job_rejected:queue_job_envelope_invalid");
                    message.ack();
                    continue;
                }
            }
        };

        if let Some(code) = failure {
            // Only the stable reason code reaches the log. A dedupe key, org
            // ID, webhook body, or customer data must never appear in a line.
            console_error!("p06_job_failed:{code}");
            message.retry();
        }
    }
    Ok(())
}

fn is_data_job_type(job_type: &str) -> bool {
    matches!(job_type, "export.run" | "deletion.run")
}

fn is_automation_job_type(job_type: &str) -> bool {
    matches!(
        job_type,
        "automation.generate_occurrence" | "automation.dispatch" | "automation.expire_lease"
    )
}

fn is_webhook_job_type(job_type: &str) -> bool {
    job_type == "webhook.deliver"
}

/// Sweep at most one bounded batch of due events each minute. D1 remains the
/// canonical source; Queue delivery is at-least-once and consumers deduplicate
/// by event ID.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if run_scheduled_sweep(env.clone()).await.is_err() {
        // ScheduledEvent's workers-rs bridge discards the Rust function's
        // return value, so emit a stable redacted failure signal explicitly.
        console_error!("outbox_retry_sweep_failed");
    }
    // P06: the two automation sweeps are the authoritative clock. The server
    // advances `schedule_cursor_at` and expires leases from D1 state, so a
    // missed tick loses no work and a late tick does not double-dispatch — the
    // occurrence uniqueness constraint and the single-active-lease constraint
    // are what make a repeated sweep safe.
    if run_automation_sweeps(env.clone()).await.is_err() {
        console_error!("automation_sweep_failed");
    }
    // Budget holds that outlived their request. Not a spend control — admission
    // already ignores an expired hold — but the only way a hold reaches a
    // terminal state after a Worker dies between the insert and the finalize.
    // Without it, `status = 'reserved'` accumulates rows that no operator query
    // can distinguish from live spend.
    if run_budget_expiry_sweep(env).await.is_err() {
        console_error!("budget_expiry_sweep_failed");
    }
}

/// Bounded per-tick budget-expiry sweep.
///
/// Bounded twice over: at most `BUDGET_EXPIRY_SWEEP_LIMIT` organizations, and at
/// most the same number of holds per organization. The second bound is what stops
/// one tenant with a large backlog from making the tick expensive, and the first
/// keeps the whole sweep inside the Worker's CPU budget. A missed tick loses
/// nothing: the rows are already past their expiry, so they stop counting against
/// the budget whether or not this runs.
async fn run_budget_expiry_sweep(env: Env) -> Result<()> {
    let database = D1Adapter::new(env.d1("DB")?);
    let now = jobs::now_utc().map_err(|_| Error::RustError("worker clock unavailable".into()))?;
    let repository = repositories::BudgetRepository::new(&database);
    let orgs = repository
        .orgs_with_expired_reservations(now.as_str(), BUDGET_EXPIRY_SWEEP_LIMIT)
        .await
        .map_err(|_| Error::RustError("budget_expiry_sweep_unavailable".into()))?;
    for org_id in orgs {
        let statement = repository
            .expire_reservations_statement(&org_id, now.as_str(), BUDGET_EXPIRY_SWEEP_LIMIT)
            .map_err(|_| Error::RustError("budget_expiry_statement_unavailable".into()))?;
        database
            .batch(vec![statement])
            .await
            .map_err(|_| Error::RustError("budget_expiry_sweep_write_failed".into()))?;
    }
    Ok(())
}

async fn run_automation_sweeps(env: Env) -> Result<()> {
    let database = D1Adapter::new(env.d1("DB")?);
    let now = jobs::now_utc().map_err(|_| Error::RustError("worker clock unavailable".into()))?;

    jobs::automations::run_due_occurrence_sweep(&database, &now, AUTOMATION_SWEEP_LIMIT)
        .await
        .map_err(|_| Error::RustError("automation_due_sweep_failed".into()))?;
    jobs::automations::run_lease_expiry_sweep(&database, &now, AUTOMATION_SWEEP_LIMIT)
        .await
        .map_err(|_| Error::RustError("automation_lease_sweep_failed".into()))?;
    Ok(())
}

/// Bounded per-tick batch. A larger batch would exceed the Worker's CPU budget
/// on a busy tenant; the sweep is re-entrant, so the remainder is picked up on
/// the next tick.
const AUTOMATION_SWEEP_LIMIT: i32 = 50;

/// Bounded per-tick batch for the budget-expiry sweep, in organizations and in
/// holds per organization. The same order of magnitude as the automation sweeps,
/// which are the existing precedent for "one tick must stay cheap".
const BUDGET_EXPIRY_SWEEP_LIMIT: i32 = 50;

async fn run_scheduled_sweep(env: Env) -> Result<()> {
    let database = D1Adapter::new(env.d1("DB")?);
    let store = repositories::OutboxRepository::new(&database);
    let queue = env.queue("OUTBOX_QUEUE")?;
    let publisher = adapters::queues::CloudflareQueuePublisher::new(queue);
    let logger = adapters::queues::WorkerOutboxLogger;
    let now = jobs::now_utc().map_err(|_| Error::RustError("worker clock unavailable".into()))?;

    jobs::run_retry_sweep(
        &store,
        &publisher,
        &logger,
        &now,
        outbox_retry_policy(),
        100,
    )
    .await
    .map(|_| ())
    .map_err(|_| Error::RustError("outbox retry sweep failed".into()))
}

fn outbox_retry_policy() -> modules::outbox::RetryPolicy {
    modules::outbox::RetryPolicy::new(6, 30, 900, 25).expect("static outbox retry policy is valid")
}
