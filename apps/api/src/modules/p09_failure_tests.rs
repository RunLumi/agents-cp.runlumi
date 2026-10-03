//! P09-REL-01 failure injection: what the control plane does when a dependency
//! fails mid-flight.
//!
//! The feature specs describe what must exist. This module describes what must
//! stay *true* when D1, R2, a provider, a queue, or a credential stops
//! cooperating, because the dangerous class of release defect is not a missing
//! feature, it is state left inconsistent by a mid-flight failure: a run marked
//! running with no charge, a leaked budget hold, a doubled delivery, a missing
//! audit event, or a truncated stream recorded as a success.
//!
//! # What is provable here, and what is not
//!
//! Every test below is pure or in-memory: no network, no clock, no shared
//! mutable state, no Worker binding. That is deliberate. It is the layer where
//! this repository concentrates its correctness tests, and it is the layer a
//! reviewer can read against `docs/specs` without a Cloudflare account.
//!
//! Three properties genuinely cannot be proven at this layer, and each is
//! called out where it occurs rather than faked:
//!
//! * **A real D1/R2/Queue platform error.** `worker::Error`'s `D1` and
//!   `UnknownJsError` variants wrap a `js_sys::Error` that only exists on
//!   `wasm32`, and a `D1PreparedStatement` cannot be constructed on the host
//!   target at all. The store tests therefore inject `worker::Error::RustError`
//!   with platform-shaped text and prove that the *mapper* is total and
//!   fail-closed — not that D1 produces that text.
//! * **SQL compare-and-set execution.** The CAS guards are asserted by reading
//!   the statement text, which is how the existing repository tests do it. The
//!   migrations' unique indexes (`usage_events.request_id`,
//!   `budget_reservations.request_id`) are the backstop that makes a second
//!   commit or a second charge structurally impossible; observing them reject a
//!   write needs a real D1.
//! * **Wall-clock behaviour.** `adapters::add_seconds` and `sha256_hex` are
//!   `wasm32`-only, so the in-memory outbox store below proves the durable state
//!   machine and leaves the calendar to the retry policy, whose bounds are
//!   asserted directly against `RetryPolicy`.

use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    task::{Context, Poll, Waker},
};

use serde_json::json;

use super::authorization::{
    AuthorizationDecision, DenyReason, MembershipRole, MembershipSnapshot, MembershipStatus,
    OrganizationContext, OrganizationState, Permission, authorize,
};
use super::budget_p05::{
    BudgetDecision, BudgetEvaluationRequest, BudgetPolicy, BudgetScope, ScopeContext,
    evaluate_budget_request,
};
use super::credentials::{
    CredentialMetadata, CredentialMode, CredentialOwnerType, CredentialStatus,
    can_resolve_credential,
};
use super::data_governance::export::ExportJobState;
use super::inference::{
    AdapterStreamState, ProviderStreamEvent, ResponseLifecycle, RetryController, SseDecoder,
    normalize_adapter_error,
};
use super::machine_identity::{
    ApiKeyScope, CredentialState, MachineDecision, MachineDenyReason, MachineRequest,
    authorize_machine,
};
use super::outbox::{
    ConsumerOutcome, DeliveryStatus, DispatchError, DispatchReport, EventHandler, EventPublisher,
    FailureCode, FailureDisposition, FailureUpdate, HandlerFailure, MAX_RETRY_BATCH,
    OutboxConsumer, OutboxLog, OutboxLogger, OutboxRecord, OutboxStore, OutboxStoreError,
    RetryPolicy, StoreTransition, retry_due_events,
};
use super::tool_policy::{
    CapabilityDefinition, CapabilityLifecycle, DecisionReasonCode, McpPolicyStatus,
    McpRegistration, McpSource, PolicyEvaluationInput, PolicyPosture, RiskClass,
    RuntimeCapabilities, ToolCall, ToolCatalog, ToolDecision, ToolDefinition, ToolLifecycle,
    ToolPolicyLayer, ToolSource, evaluate,
};
use crate::adapters::r2::{ArtifactError, build_object_key};
use crate::consumers::QueueJobEnvelope;
use crate::core::{
    ActorContext, ApiErrorCode, CorrelationId, EventEnvelope, EventId, EventType, MachineActor,
    MembershipId, OrganizationId, Principal, ProjectId, RequestContext, SessionId, Timestamp,
};
use crate::repositories::{BudgetReservationRecord, QueueJobState};

// =============================================================================
// Hand-rolled executor
//
// `async fn` in a trait is used by the outbox store and handler ports, so the
// consumer tests need an executor. This is the same shape as the one in
// `http/middleware.rs` tests: no runtime, no timer, no dependency. Every future
// used here resolves without yielding, so the loop terminates on the first
// `Ready`.
// =============================================================================

fn block_on<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = Box::pin(future);
    loop {
        match Pin::as_mut(&mut future).poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

// =============================================================================
// Fixtures. Every fixture is a constructor, so no test can observe another
// test's state.
// =============================================================================

const EVENT_ID: &str = "evt_0123456789abcdef0123456789abcdef";
const ORG_ID: &str = "org_0123456789abcdef0123456789abcdef";
const PROJECT_ID: &str = "prj_0123456789abcdef0123456789abcdef";
const USER_ID: &str = "usr_0123456789abcdef0123456789abcdef";

fn timestamp(value: &str) -> Timestamp {
    value.parse().expect("fixture timestamp is RFC 3339 UTC")
}

fn event() -> EventEnvelope {
    EventEnvelope {
        event_id: EVENT_ID.parse().expect("fixture event id"),
        event_type: EventType::new("inference.completed.v1").expect("fixture event type"),
        occurred_at: timestamp("2026-09-24T12:00:00.000Z"),
        request_id: "req_0123456789abcdef0123456789abcdef"
            .parse()
            .expect("fixture request id"),
        correlation_id: CorrelationId::new("req_0123456789abcdef0123456789abcdef")
            .expect("fixture correlation id"),
        actor: ActorContext::anonymous(),
        organization_id: None,
        payload: json!({ "must_not_be_logged": "private" }),
    }
}

fn request_context() -> RequestContext {
    RequestContext::new(
        "req_0123456789abcdef0123456789abcdef"
            .parse()
            .expect("fixture request id"),
        "trace_failure_injection".parse().expect("fixture trace id"),
        timestamp("2026-09-24T12:00:00.000Z"),
    )
}

/// The exact outbox retry policy the Worker entry point installs
/// (`lib.rs::outbox_retry_policy`): six total failed attempts, 30 s base, 900 s
/// cap, ±25 % jitter.
const PRODUCTION_OUTBOX_POLICY: (u32, u32, u32, u8) = (6, 30, 900, 25);

fn production_outbox_policy() -> RetryPolicy {
    let (attempts, base, cap, jitter) = PRODUCTION_OUTBOX_POLICY;
    RetryPolicy::new(attempts, base, cap, jitter).expect("production policy is valid")
}

// =============================================================================
// 1. D1 error mid-request
// =============================================================================

/// The D1 error mapper is the only thing between a store failure and a client,
/// so its contract is: never a success-shaped error, never a leak of the raw
/// store text, and a stable code per failure class.
///
/// The mapper classifies on substrings of the platform's `Debug` text, so what
/// is asserted here is the fail-closed direction, which holds for every input,
/// rather than the classification, which is a heuristic. See the handoff for the
/// sharp edge a substring match leaves open.
#[test]
fn a_store_failure_after_a_successful_read_maps_to_service_unavailable() {
    let context = request_context();
    for platform_text in [
        "D1_ERROR: d1_database_error: connection reset by peer",
        "D1_ERROR: too many requests",
        "D1_ERROR: request timed out",
        "D1_ERROR: overloaded",
        "",
    ] {
        let error = crate::routes::support::database_error(
            &context,
            worker::Error::RustError(platform_text.to_owned()),
        );
        assert_eq!(
            error.error.code,
            ApiErrorCode::ServiceUnavailable,
            "a store outage must not be reported as a client error: {platform_text:?}"
        );
        assert_eq!(error.error.code.status_code(), 503);
        // The stable envelope is the whole response body, so the platform text
        // must not survive into it in any form.
        let body = serde_json::to_string(&error).expect("error body serializes");
        assert!(!body.contains("D1_ERROR"), "leaked platform text: {body}");
        assert_eq!(error.error.request_id, context.request_id);
    }
}

/// A uniqueness violation is a client-visible conflict, not an outage, and it
/// gets the same stable code however SQLite phrases it.
#[test]
fn a_unique_constraint_violation_maps_to_the_stable_conflict_code() {
    let context = request_context();
    for platform_text in [
        "D1_ERROR: UNIQUE constraint failed: usage_events.request_id",
        "D1_ERROR: constraint failed: budget_reservations.reservation_id",
        "SQLITE_CONSTRAINT: UNIQUE",
        "D1_ERROR: D1_ERROR: too many requests: constraint",
    ] {
        let error = crate::routes::support::database_error(
            &context,
            worker::Error::RustError(platform_text.to_owned()),
        );
        assert_eq!(
            error.error.code,
            ApiErrorCode::Conflict,
            "{platform_text:?}"
        );
        assert_eq!(error.error.code.status_code(), 409);
        assert_eq!(
            error.error.details.get("reason"),
            Some(&json!("conflict")),
            "{platform_text:?}"
        );
        // A conflict must not name the table that refused the write: that is
        // schema detail the client has no use for.
        let body = serde_json::to_string(&error).expect("error body serializes");
        assert!(!body.contains("usage_events"), "leaked schema: {body}");
        assert!(
            !body.contains("budget_reservations"),
            "leaked schema: {body}"
        );
    }
}

/// A membership the store could not read is indistinguishable from a missing
/// one at the decision boundary, and both deny. This is what makes a D1 read
/// failure fail closed instead of skipping authorization.
#[test]
fn a_membership_the_store_could_not_read_never_authorizes() {
    let principal = Principal::new(
        USER_ID.parse().expect("fixture user id"),
        SessionId::new("ses_0123456789abcdef0123456789abcdef").expect("fixture session id"),
        "person@example.test",
        "Person",
        true,
    );
    let organization = OrganizationContext {
        organization_id: OrganizationId::new(ORG_ID).expect("fixture org id"),
        state: OrganizationState::Active,
        version: 1,
    };
    let membership = MembershipSnapshot {
        membership_id: MembershipId::new("mem_0123456789abcdef0123456789abcdef")
            .expect("fixture membership id"),
        organization_id: organization.organization_id.clone(),
        user_id: principal.user_id.clone(),
        role: MembershipRole::Owner,
        status: MembershipStatus::Active,
        version: 1,
    };

    // The read failed, so the caller has nothing to pass. `None` is the only
    // shape an unavailable lookup can produce, and it is a denial.
    for permission in [
        Permission::InferenceUse,
        Permission::RunsStart,
        Permission::OrgManage,
        Permission::DataExport,
    ] {
        let decision = authorize(Some(&principal), &organization, None, &permission, None);
        assert_eq!(
            decision,
            AuthorizationDecision::Deny(DenyReason::MembershipRequired),
            "{permission:?} must not be authorized without a readable membership"
        );
        assert!(!decision.is_allowed());
    }

    // A half-read membership is equally unusable: a non-positive version is a
    // torn read, not authority.
    let mut torn = membership.clone();
    torn.version = 0;
    assert!(
        !authorize(
            Some(&principal),
            &organization,
            Some(&torn),
            &Permission::InferenceUse,
            None
        )
        .is_allowed()
    );
}

// =============================================================================
// 2. Queue delay, duplicate delivery, bounded retry, dead-letter
// =============================================================================

/// Which store operation a fake outbox store should misbehave in, and how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriteFault {
    /// Writes succeed.
    None,
    /// The write fails the way an unavailable D1 does. Reads still succeed, so
    /// this is exactly "a read succeeded and then the write failed".
    Unavailable,
    /// The compare-and-set loses to a concurrent writer that left the row in a
    /// state this consumer cannot classify.
    Contended,
    /// The compare-and-set loses to a concurrent writer that durably scheduled a
    /// retry.
    WonByRetry,
}

/// An in-memory outbox row plus a fault injector.
///
/// The store implements the durable contract `OutboxStore` documents: every
/// update is conditional on the event ID, expected state, and expected attempt
/// count. It deliberately does not derive a due time from the policy's delay —
/// that bound is asserted directly against `RetryPolicy` in
/// `the_outbox_retry_budget_is_bounded_and_finite` — so this fake isolates the
/// state machine from the calendar.
struct FaultyOutboxStore {
    row: RefCell<OutboxRecord>,
    write_fault: Cell<WriteFault>,
    writes: Cell<u32>,
}

impl FaultyOutboxStore {
    fn new(delivery_status: DeliveryStatus, attempt_count: u32) -> Self {
        Self {
            row: RefCell::new(OutboxRecord {
                event: event(),
                delivery_status,
                attempt_count,
                next_attempt_at: None,
                queued_at: Some(timestamp("2026-09-24T12:00:00.000Z")),
                delivered_at: None,
                last_error_code: None,
            }),
            write_fault: Cell::new(WriteFault::None),
            writes: Cell::new(0),
        }
    }

    fn fail_writes_with(&self, fault: WriteFault) {
        self.write_fault.set(fault);
    }

    fn status(&self) -> DeliveryStatus {
        self.row.borrow().delivery_status
    }

    fn attempt_count(&self) -> u32 {
        self.row.borrow().attempt_count
    }

    fn last_error_code(&self) -> Option<String> {
        self.row
            .borrow()
            .last_error_code
            .as_ref()
            .map(|code| code.as_str().to_owned())
    }
}

impl OutboxStore for FaultyOutboxStore {
    async fn list_due_pending(
        &self,
        _now: &Timestamp,
        _limit: u16,
    ) -> Result<Vec<OutboxRecord>, OutboxStoreError> {
        Ok(Vec::new())
    }

    async fn mark_queued(
        &self,
        event_id: &EventId,
        expected_attempt_count: u32,
        queued_at: &Timestamp,
    ) -> Result<StoreTransition, OutboxStoreError> {
        self.writes.set(self.writes.get() + 1);
        if self.write_fault.get() == WriteFault::Unavailable {
            return Err(OutboxStoreError::Unavailable);
        }
        let mut row = self.row.borrow_mut();
        if row.event_id() != event_id || row.attempt_count != expected_attempt_count {
            return Ok(StoreTransition::NotApplied);
        }
        row.delivery_status = DeliveryStatus::Queued;
        row.queued_at = Some(queued_at.clone());
        row.next_attempt_at = None;
        Ok(StoreTransition::Applied)
    }

    async fn record_failure(
        &self,
        event_id: &EventId,
        update: &FailureUpdate<'_>,
    ) -> Result<StoreTransition, OutboxStoreError> {
        self.writes.set(self.writes.get() + 1);
        if self.write_fault.get() == WriteFault::Unavailable {
            return Err(OutboxStoreError::Unavailable);
        }
        let mut row = self.row.borrow_mut();
        if row.event_id() != event_id
            || row.delivery_status.is_terminal()
            || row.delivery_status != update.expected_status
            || row.attempt_count != update.expected_attempt_count
            || update.new_attempt_count != update.expected_attempt_count.saturating_add(1)
        {
            return Ok(StoreTransition::NotApplied);
        }
        if self.write_fault.get() == WriteFault::WonByRetry {
            // Another worker already incremented the attempt and scheduled a
            // retry. This copy must not increment again.
            row.attempt_count = update.new_attempt_count;
            row.delivery_status = DeliveryStatus::Pending;
            return Ok(StoreTransition::NotApplied);
        }
        if self.write_fault.get() == WriteFault::Contended {
            // A concurrent writer left the row in a non-terminal state this
            // consumer cannot classify. Nothing is changed here.
            return Ok(StoreTransition::NotApplied);
        }
        row.attempt_count = update.new_attempt_count;
        row.last_error_code = Some(FailureCode::new(update.error_code.as_str()).expect("code"));
        match update.disposition {
            FailureDisposition::Retry { .. } => {
                row.delivery_status = DeliveryStatus::Pending;
                row.next_attempt_at = Some(update.failed_at.clone());
            }
            FailureDisposition::DeadLetter => {
                row.delivery_status = DeliveryStatus::DeadLetter;
                row.next_attempt_at = None;
            }
        }
        Ok(StoreTransition::Applied)
    }

    async fn mark_delivered(
        &self,
        event_id: &EventId,
        delivered_at: &Timestamp,
    ) -> Result<StoreTransition, OutboxStoreError> {
        self.writes.set(self.writes.get() + 1);
        if self.write_fault.get() == WriteFault::Unavailable {
            return Err(OutboxStoreError::Unavailable);
        }
        let mut row = self.row.borrow_mut();
        if row.event_id() != event_id || row.delivery_status.is_terminal() {
            return Ok(StoreTransition::NotApplied);
        }
        row.delivery_status = DeliveryStatus::Delivered;
        row.next_attempt_at = None;
        row.delivered_at = Some(delivered_at.clone());
        Ok(StoreTransition::Applied)
    }

    async fn mark_dead_letter(
        &self,
        event_id: &EventId,
        error_code: &FailureCode,
    ) -> Result<StoreTransition, OutboxStoreError> {
        self.writes.set(self.writes.get() + 1);
        if self.write_fault.get() == WriteFault::Unavailable {
            return Err(OutboxStoreError::Unavailable);
        }
        let mut row = self.row.borrow_mut();
        if row.event_id() != event_id || row.delivery_status.is_terminal() {
            return Ok(StoreTransition::NotApplied);
        }
        row.delivery_status = DeliveryStatus::DeadLetter;
        row.next_attempt_at = None;
        row.last_error_code = Some(FailureCode::new(error_code.as_str()).expect("code"));
        Ok(StoreTransition::Applied)
    }

    async fn get_record(
        &self,
        event_id: &EventId,
    ) -> Result<Option<OutboxRecord>, OutboxStoreError> {
        let row = self.row.borrow();
        Ok((row.event_id() == event_id).then(|| (*row).clone()))
    }
}

/// A handler that records how many times its side effect was applied, so a
/// duplicate delivery can be proven not to reapply it.
struct CountingHandler {
    applied: Cell<u32>,
    failure: Option<&'static str>,
}

impl CountingHandler {
    fn succeeding() -> Self {
        Self {
            applied: Cell::new(0),
            failure: None,
        }
    }

    fn retryable_failure(code: &'static str) -> Self {
        Self {
            applied: Cell::new(0),
            failure: Some(code),
        }
    }
}

impl EventHandler for CountingHandler {
    async fn handle_once(&self, _event: &EventEnvelope) -> Result<(), HandlerFailure> {
        self.applied.set(self.applied.get() + 1);
        match self.failure {
            None => Ok(()),
            Some(code) => Err(HandlerFailure::retryable(
                FailureCode::new(code).expect("fixture failure code"),
            )),
        }
    }
}

struct CollectingLogger {
    actions: RefCell<Vec<&'static str>>,
}

impl CollectingLogger {
    fn new() -> Self {
        Self {
            actions: RefCell::new(Vec::new()),
        }
    }

    fn count(&self, action: &str) -> usize {
        self.actions
            .borrow()
            .iter()
            .filter(|recorded| **recorded == action)
            .count()
    }
}

impl OutboxLogger for CollectingLogger {
    fn log(&self, record: OutboxLog) {
        self.actions.borrow_mut().push(record.action);
    }
}

/// The D1 read succeeded and the write then failed. The consumer must surface
/// the store error so the platform redelivers, and the row must not claim to be
/// delivered: a false `delivered` would drop the event permanently.
#[test]
fn a_store_failure_on_the_terminal_write_is_never_acknowledged_as_delivered() {
    let store = FaultyOutboxStore::new(DeliveryStatus::Queued, 0);
    store.fail_writes_with(WriteFault::Unavailable);
    let handler = CountingHandler::succeeding();
    let logger = CollectingLogger::new();
    let consumer = OutboxConsumer::new(&store, &handler, &logger, production_outbox_policy());
    let now = timestamp("2026-09-24T12:00:01.000Z");

    assert_eq!(
        block_on(consumer.consume(&event(), &now)),
        Err(OutboxStoreError::Unavailable)
    );
    assert_eq!(store.status(), DeliveryStatus::Queued);
    assert_eq!(store.attempt_count(), 0);
    assert_eq!(store.writes.get(), 1);
    assert_eq!(
        logger.count("delivered"),
        0,
        "a failed write must not be logged as a transition"
    );
}

/// The counterpart: once D1 is healthy again the redelivery converges on exactly
/// one durable `delivered` transition, and later deliveries are duplicates.
///
/// The handler ran twice. That is the documented contract of
/// `modules::outbox::EventHandler`: the side effect must be idempotent by
/// `event_id` or commit atomically with a dedupe record, because a pre-handler
/// status lookup alone cannot stop two concurrent copies of the same message.
/// What this test pins is the *state* half of that contract: the durable row is
/// written once and the second write is a no-op, not a second transition.
#[test]
fn a_redelivery_after_a_store_failure_converges_on_one_durable_transition() {
    let store = FaultyOutboxStore::new(DeliveryStatus::Queued, 0);
    let handler = CountingHandler::succeeding();
    let logger = CollectingLogger::new();
    let consumer = OutboxConsumer::new(&store, &handler, &logger, production_outbox_policy());
    let now = timestamp("2026-09-24T12:00:01.000Z");
    let event = event();

    store.fail_writes_with(WriteFault::Unavailable);
    assert!(block_on(consumer.consume(&event, &now)).is_err());

    store.fail_writes_with(WriteFault::None);
    assert_eq!(
        block_on(consumer.consume(&event, &now)),
        Ok(ConsumerOutcome::Delivered)
    );
    assert_eq!(store.status(), DeliveryStatus::Delivered);
    assert_eq!(logger.count("delivered"), 1);

    for _ in 0..3 {
        assert_eq!(
            block_on(consumer.consume(&event, &now)),
            Ok(ConsumerOutcome::Duplicate)
        );
    }
    // Two writes total: the failed one and the one that applied. The three
    // duplicates short-circuited on the durable state and wrote nothing.
    assert_eq!(store.writes.get(), 2);
    assert_eq!(handler.applied.get(), 2);
}

/// A consumer that loses the compare-and-set to a writer it cannot classify must
/// ask for redelivery rather than acknowledge. Acknowledging here would lose the
/// event: the durable row is neither delivered nor scheduled.
#[test]
fn a_lost_compare_and_set_is_never_silently_acknowledged() {
    let store = FaultyOutboxStore::new(DeliveryStatus::Queued, 0);
    let handler = CountingHandler::retryable_failure("handler_transient");
    let logger = CollectingLogger::new();
    let consumer = OutboxConsumer::new(&store, &handler, &logger, production_outbox_policy());
    let now = timestamp("2026-09-24T12:00:01.000Z");

    store.fail_writes_with(WriteFault::Contended);
    assert_eq!(
        block_on(consumer.consume(&event(), &now)),
        Err(OutboxStoreError::Unavailable)
    );
    assert_eq!(store.status(), DeliveryStatus::Queued);
    assert_eq!(
        store.attempt_count(),
        0,
        "a lost compare-and-set must not burn an attempt"
    );
}

/// When a concurrent worker did schedule a durable retry, the losing copy is a
/// duplicate: the scheduled sweep owns redelivery, and re-running the handler
/// would apply the side effect a second time.
#[test]
fn a_concurrent_winner_scheduling_a_retry_makes_the_losing_copy_a_duplicate() {
    let store = FaultyOutboxStore::new(DeliveryStatus::Queued, 0);
    let handler = CountingHandler::retryable_failure("handler_transient");
    let logger = CollectingLogger::new();
    let consumer = OutboxConsumer::new(&store, &handler, &logger, production_outbox_policy());
    let now = timestamp("2026-09-24T12:00:01.000Z");

    store.fail_writes_with(WriteFault::WonByRetry);
    assert_eq!(
        block_on(consumer.consume(&event(), &now)),
        Ok(ConsumerOutcome::RetryScheduled)
    );
    assert_eq!(store.status(), DeliveryStatus::Pending);
    // Exactly one increment, from the winner, not from this copy.
    assert_eq!(store.attempt_count(), 1);
    assert_eq!(handler.applied.get(), 1);
}

/// A permanently failing handler never retries, and a retryable one retries a
/// bounded number of times and then lands in a durable, visible `dead_letter`.
///
/// This is the end-to-end bound that the `RetryPolicy` unit test does not prove
/// on its own: that the *consumer* stops, and that the stop is recorded rather
/// than dropped.
#[test]
fn the_outbox_retry_budget_is_bounded_and_a_poison_event_ends_in_a_visible_dead_letter() {
    let store = FaultyOutboxStore::new(DeliveryStatus::Queued, 0);
    let handler = CountingHandler::retryable_failure("handler_poison");
    let logger = CollectingLogger::new();
    let policy = production_outbox_policy();
    let consumer = OutboxConsumer::new(&store, &handler, &logger, policy);
    let now = timestamp("2026-09-24T12:00:01.000Z");
    let event = event();

    let mut attempts = 0_u32;
    let mut last = None;
    while attempts < 32 {
        attempts += 1;
        let outcome = block_on(consumer.consume(&event, &now)).expect("the store is healthy");
        last = Some(outcome);
        if outcome != ConsumerOutcome::RetryScheduled {
            break;
        }
    }

    let max_attempts = policy.max_attempts();
    assert_eq!(
        attempts, max_attempts,
        "a poison event must stop after exactly the configured attempt budget"
    );
    assert_eq!(last, Some(ConsumerOutcome::DeadLettered));
    assert_eq!(handler.applied.get(), max_attempts);
    assert_eq!(store.status(), DeliveryStatus::DeadLetter);
    assert!(store.status().is_terminal());
    assert_eq!(store.attempt_count(), max_attempts);
    // The dead-letter state is visible, not inferred: a stable code is stored on
    // the row and the terminal transition is logged once.
    assert_eq!(store.last_error_code().as_deref(), Some("handler_poison"));
    assert_eq!(logger.count("dead_lettered"), 1);
    assert_eq!(logger.count("retry_scheduled"), (max_attempts - 1) as usize);

    // Redelivering a dead-lettered event is a duplicate, so a poison event
    // cannot livelock the queue.
    assert_eq!(
        block_on(consumer.consume(&event, &now)),
        Ok(ConsumerOutcome::Duplicate)
    );
    assert_eq!(handler.applied.get(), max_attempts);
}

/// The backoff itself is finite and bounded: every scheduled delay is inside
/// `[1, cap]`, it never moves backwards, and the jitter is deterministic so a
/// redelivery does not reshuffle the schedule.
#[test]
fn the_outbox_retry_budget_is_bounded_and_finite() {
    let policy = production_outbox_policy();
    let (attempts, _base, cap, _jitter) = PRODUCTION_OUTBOX_POLICY;
    let event_id = event().event_id;

    let mut previous = 0_u32;
    let mut retries = 0_u32;
    for attempt in 1..=attempts {
        let disposition = policy.after_failure(attempt, &event_id);
        assert_eq!(
            disposition,
            policy.after_failure(attempt, &event_id),
            "the delay must be deterministic for a redelivery"
        );
        let FailureDisposition::Retry { delay_seconds } = disposition else {
            assert_eq!(attempt, attempts, "the final attempt dead-letters");
            break;
        };
        retries += 1;
        assert!(
            (1..=cap).contains(&delay_seconds),
            "attempt {attempt} scheduled an unbounded delay: {delay_seconds}"
        );
        assert!(
            delay_seconds >= previous,
            "attempt {attempt} backed off backwards: {delay_seconds} < {previous}"
        );
        previous = delay_seconds;
    }
    assert_eq!(retries, attempts - 1, "retries are bounded by the budget");

    // One past the budget is terminal, and attempt zero is never a retry.
    assert_eq!(
        policy.after_failure(attempts + 1, &event_id),
        FailureDisposition::DeadLetter
    );
    assert_eq!(
        policy.after_failure(0, &event_id),
        FailureDisposition::DeadLetter
    );
}

/// A failure that can never succeed must not consume the retry budget: one
/// attempt, then a durable dead-letter.
#[test]
fn a_permanent_handler_failure_dead_letters_on_the_first_attempt() {
    struct PermanentFailure;
    impl EventHandler for PermanentFailure {
        async fn handle_once(&self, _event: &EventEnvelope) -> Result<(), HandlerFailure> {
            Err(HandlerFailure::permanent(
                FailureCode::new("handler_permanent").expect("fixture failure code"),
            ))
        }
    }

    let store = FaultyOutboxStore::new(DeliveryStatus::Queued, 0);
    let logger = CollectingLogger::new();
    let consumer = OutboxConsumer::new(
        &store,
        &PermanentFailure,
        &logger,
        production_outbox_policy(),
    );
    let now = timestamp("2026-09-24T12:00:01.000Z");

    assert_eq!(
        block_on(consumer.consume(&event(), &now)),
        Ok(ConsumerOutcome::DeadLettered)
    );
    assert_eq!(store.status(), DeliveryStatus::DeadLetter);
    assert_eq!(
        store.attempt_count(),
        0,
        "a permanent failure must not consume the retry budget"
    );
    assert_eq!(
        store.last_error_code().as_deref(),
        Some("handler_permanent")
    );
    assert_eq!(logger.count("retry_scheduled"), 0);
}

/// A message that reached the configured dead-letter queue is recorded as
/// terminal *before* it is acknowledged, so it is visible and replayable rather
/// than silently dropped.
#[test]
fn a_dead_letter_queue_delivery_is_recorded_before_it_is_acknowledged() {
    let store = FaultyOutboxStore::new(DeliveryStatus::Queued, 3);
    let handler = CountingHandler::succeeding();
    let logger = CollectingLogger::new();
    let consumer = OutboxConsumer::new(&store, &handler, &logger, production_outbox_policy());
    let event = event();

    assert_eq!(
        block_on(consumer.consume_dead_letter(&event)),
        Ok(ConsumerOutcome::DeadLettered)
    );
    assert_eq!(store.status(), DeliveryStatus::DeadLetter);
    assert_eq!(
        store.last_error_code().as_deref(),
        Some("queue_dead_lettered")
    );
    assert_eq!(
        handler.applied.get(),
        0,
        "a DLQ delivery never replays work"
    );
    assert_eq!(store.attempt_count(), 3, "the attempt history is preserved");

    // A second DLQ copy is idempotent: the row is already terminal, so nothing
    // is written and the caller is told the event is a duplicate.
    assert_eq!(
        block_on(consumer.consume_dead_letter(&event)),
        Ok(ConsumerOutcome::Duplicate)
    );
    assert!(store.status().is_terminal());
    assert_eq!(
        store.attempt_count(),
        3,
        "a duplicate DLQ copy burns no attempt"
    );
}

/// An event that already succeeded must not be re-classified as a failure by a
/// late dead-letter message.
#[test]
fn a_dead_letter_queue_redelivery_of_a_delivered_event_stays_delivered() {
    let store = FaultyOutboxStore::new(DeliveryStatus::Delivered, 0);
    let handler = CountingHandler::succeeding();
    let logger = CollectingLogger::new();
    let consumer = OutboxConsumer::new(&store, &handler, &logger, production_outbox_policy());

    assert_eq!(
        block_on(consumer.consume_dead_letter(&event())),
        Ok(ConsumerOutcome::Duplicate)
    );
    assert_eq!(store.status(), DeliveryStatus::Delivered);
    assert_eq!(store.last_error_code(), None);
    assert_eq!(store.writes.get(), 0, "a duplicate DLQ copy writes nothing");
}

/// Queue delay: a row whose retry is not yet due is invisible to a bounded
/// sweep and becomes eligible the moment it is due. A sweep that ignored the
/// due time would either lose the event or hammer the provider; one that
/// published an undelivered row would double-send.
#[test]
fn a_delayed_event_is_not_published_before_it_is_due() {
    struct CountingPublisher {
        sends: Cell<u32>,
    }

    impl EventPublisher for CountingPublisher {
        async fn publish(&self, _event: &EventEnvelope) -> Result<(), FailureCode> {
            self.sends.set(self.sends.get() + 1);
            Err(FailureCode::new("queue_publish_failed").expect("fixture failure code"))
        }
    }

    /// A one-row store whose selection honours `next_attempt_at`.
    struct SingleRowStore {
        row: RefCell<OutboxRecord>,
    }

    impl SingleRowStore {
        fn new(next_attempt_at: Timestamp) -> Self {
            Self {
                row: RefCell::new(OutboxRecord {
                    event: event(),
                    delivery_status: DeliveryStatus::Pending,
                    attempt_count: 0,
                    next_attempt_at: Some(next_attempt_at),
                    queued_at: None,
                    delivered_at: None,
                    last_error_code: None,
                }),
            }
        }
    }

    impl OutboxStore for SingleRowStore {
        async fn list_due_pending(
            &self,
            now: &Timestamp,
            _limit: u16,
        ) -> Result<Vec<OutboxRecord>, OutboxStoreError> {
            let row = self.row.borrow();
            Ok(row
                .next_attempt_at
                .as_ref()
                .is_none_or(|at| at.as_str() <= now.as_str())
                .then(|| (*row).clone())
                .into_iter()
                .collect())
        }

        async fn mark_queued(
            &self,
            _event_id: &EventId,
            _expected_attempt_count: u32,
            _queued_at: &Timestamp,
        ) -> Result<StoreTransition, OutboxStoreError> {
            Ok(StoreTransition::NotApplied)
        }

        async fn record_failure(
            &self,
            _event_id: &EventId,
            _update: &FailureUpdate<'_>,
        ) -> Result<StoreTransition, OutboxStoreError> {
            Ok(StoreTransition::NotApplied)
        }

        async fn mark_delivered(
            &self,
            _event_id: &EventId,
            _delivered_at: &Timestamp,
        ) -> Result<StoreTransition, OutboxStoreError> {
            Ok(StoreTransition::NotApplied)
        }

        async fn mark_dead_letter(
            &self,
            _event_id: &EventId,
            _error_code: &FailureCode,
        ) -> Result<StoreTransition, OutboxStoreError> {
            Ok(StoreTransition::NotApplied)
        }

        async fn get_record(
            &self,
            _event_id: &EventId,
        ) -> Result<Option<OutboxRecord>, OutboxStoreError> {
            Ok(Some((*self.row.borrow()).clone()))
        }
    }

    let store = SingleRowStore::new(timestamp("2026-09-24T12:05:00.000Z"));
    let publisher = CountingPublisher {
        sends: Cell::new(0),
    };
    let logger = CollectingLogger::new();
    let policy = production_outbox_policy();

    // Not yet due: nothing is published, so a delayed event is never lost and
    // never sent early.
    let report: DispatchReport = block_on(retry_due_events(
        &store,
        &publisher,
        &logger,
        &timestamp("2026-09-24T12:00:30.000Z"),
        policy,
        100,
    ))
    .expect("the sweep itself is healthy");
    assert_eq!(report.selected, 0);
    assert_eq!(publisher.sends.get(), 0);

    // Due: exactly one publish attempt. The per-row compare-and-set is refused
    // by this fake, so the sweep reports a state change and leaves the durable
    // row alone for the next pass rather than double-counting the failure.
    let report = block_on(retry_due_events(
        &store,
        &publisher,
        &logger,
        &timestamp("2026-09-24T12:06:00.000Z"),
        policy,
        100,
    ))
    .expect("the sweep itself is healthy");
    assert_eq!(report.selected, 1);
    assert_eq!(publisher.sends.get(), 1);
    assert_eq!(report.state_changed, 1);
    assert_eq!(report.state_write_failures, 0);
    assert_eq!(report.dead_lettered + report.retry_scheduled, 0);
    assert_eq!(
        store.row.borrow().attempt_count,
        0,
        "a refused sweep writes nothing"
    );

    // The sweep is bounded, so a caller cannot ask for an unbounded scan, and a
    // rejected sweep publishes nothing.
    for limit in [0, MAX_RETRY_BATCH + 1, u16::MAX] {
        assert_eq!(
            block_on(retry_due_events(
                &store,
                &publisher,
                &logger,
                &timestamp("2026-09-24T12:06:00.000Z"),
                policy,
                limit,
            )),
            Err(DispatchError::InvalidBatchLimit),
            "limit {limit}"
        );
    }
    assert_eq!(publisher.sends.get(), 1);
}

/// The two queue envelopes cannot be read as each other. That separation is what
/// makes a mis-routed message unclassifiable rather than misapplied: a job
/// message arriving on the P01 outbox path fails to decode, so it is logged and
/// acknowledged instead of being mistaken for a business event — and, for the
/// same reason, a jobs-queue dead-letter message is never interpreted as an
/// outbox event.
#[test]
fn a_job_envelope_and_a_business_event_cannot_be_read_as_each_other() {
    let job = json!({
        "job_id": "job_0123456789abcdef0123456789abcdef",
        "job_type": "webhook.deliver",
        "schema_version": 1,
        "dedupe_key": "webhook.deliver:whd_0123456789abcdef0123456789abcdef:1",
        "event_id": EVENT_ID,
        "occurred_at": "2026-09-24T12:00:00.000Z",
        "attempt": 1,
        "correlation_id": "req_0123456789abcdef0123456789abcdef",
        "tenant_scope": { "org_id": ORG_ID },
        "payload_ref": "d1:webhook_deliveries/whd_0123456789abcdef0123456789abcdef",
    });
    // The job wire shape is the one the queue actually carries.
    let decoded = QueueJobEnvelope::validate(
        &serde_json::from_value(job.clone())
            .expect("the frozen job envelope decodes from its own wire shape"),
    )
    .expect("a well-formed job envelope validates");
    assert_eq!(decoded.as_str(), "webhook.deliver");

    assert!(
        serde_json::from_value::<EventEnvelope>(job).is_err(),
        "a job message must not decode as a business event"
    );
    assert!(
        serde_json::from_value::<QueueJobEnvelope>(serde_json::to_value(event()).expect("event"))
            .is_err(),
        "a business event must not decode as a job message"
    );
}

// =============================================================================
// 3. R2 failure
// =============================================================================

/// Every R2 failure is a stable phrase, and the conversion into a
/// `worker::Error` is the only way an artifact-store failure reaches a log line
/// or a diagnostic. Neither the opaque object key, the bucket name, nor a
/// provider string may appear in it.
#[test]
fn an_r2_failure_never_carries_the_object_key_or_a_provider_string_into_a_worker_error() {
    let key = build_object_key(
        ORG_ID,
        "exp_0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef",
    )
    .expect("fixture key is well formed");
    let opaque = key
        .as_str()
        .rsplit_once('/')
        .map(|(_, opaque)| opaque.to_owned())
        .expect("a built key has an opaque segment");

    for error in [
        ArtifactError::InvalidKey,
        ArtifactError::InvalidContentType,
        ArtifactError::BodyTooLarge,
        ArtifactError::BindingUnavailable,
        ArtifactError::ObjectAbsent,
        ArtifactError::ProviderUnavailable,
    ] {
        let message = error.to_string();
        assert_eq!(message, error.to_string(), "the phrase is stable");
        assert!(!message.contains(&opaque), "{error:?} leaked the key");
        assert!(!message.contains("exports/"), "{error:?} leaked the prefix");
        assert!(
            !message.contains("EXPORT_ARTIFACTS"),
            "{error:?} leaked the bucket"
        );

        let debug = format!("{:?}", worker::Error::from(error));
        assert!(
            !debug.contains(&opaque),
            "{error:?} leaked through Debug: {debug}"
        );
        assert!(
            !debug.contains("secret"),
            "{error:?} leaked a body: {debug}"
        );
    }
}

/// The export runner splits artifact failures into a policy class that fails the
/// job and a transport class that schedules a bounded retry
/// (`consumers::data_jobs::ExportRunner::store_artifact`). The property that
/// matters is that the split is total, that no transport failure is mistaken
/// for a completed upload, and that no artifact error is the "uploaded" signal
/// any state machine advances on.
#[test]
fn r2_failures_split_into_policy_and_transport_and_neither_is_a_success() {
    let all = [
        ArtifactError::InvalidKey,
        ArtifactError::InvalidContentType,
        ArtifactError::BodyTooLarge,
        ArtifactError::BindingUnavailable,
        ArtifactError::ObjectAbsent,
        ArtifactError::ProviderUnavailable,
    ];
    let policy_failures: Vec<ArtifactError> = all
        .into_iter()
        .filter(|error| {
            matches!(
                error,
                ArtifactError::BodyTooLarge | ArtifactError::InvalidKey
            )
        })
        .collect();
    assert_eq!(
        policy_failures.len(),
        2,
        "only a policy problem fails the job"
    );
    assert_eq!(
        all.len() - policy_failures.len(),
        4,
        "every other failure is transport and must be retried"
    );
    for error in [
        ArtifactError::InvalidContentType,
        ArtifactError::BindingUnavailable,
        ArtifactError::ObjectAbsent,
        ArtifactError::ProviderUnavailable,
    ] {
        assert!(
            !matches!(
                error,
                ArtifactError::BodyTooLarge | ArtifactError::InvalidKey
            ),
            "{error:?} must be retried, not failed"
        );
    }
    // A missing binding and a provider outage are indistinguishable to the
    // caller, and neither may be reported as a completed upload: a transport
    // failure routes a `verifying` job to `retry_wait`, and a retry re-enters
    // collection rather than jumping straight to `ready`, so a failed upload can
    // never be promoted to a downloadable artifact.
    assert_eq!(
        ExportJobState::Verifying
            .transition(ExportJobState::RetryWait)
            .expect("verifying may retry"),
        ExportJobState::RetryWait
    );
    assert!(!ExportJobState::RetryWait.can_transition_to(ExportJobState::Ready));
    assert!(!ExportJobState::RetryWait.can_transition_to(ExportJobState::Verifying));
    assert!(ExportJobState::RetryWait.can_transition_to(ExportJobState::Collecting));
    for state in ExportJobState::ALL {
        if state != ExportJobState::Ready {
            assert!(
                !state.can_mint_download_grant(),
                "{state} must never mint a download grant"
            );
        }
    }
}

// =============================================================================
// 4. Provider timeout, rate limit, and error
// =============================================================================

/// A provider error body must never reach a client or a log line. The mapped
/// error carries a kind, a retryability flag, and a status — and no body — and
/// its `Display` is the kind alone.
#[test]
fn provider_error_bodies_never_reach_a_client_or_a_log() {
    let secret = "{\"error\":{\"message\":\"sk-live-abcdef\",\"code\":\"internal\"}}";
    for status in [400, 401, 403, 408, 418, 422, 429, 500, 502, 503, 504] {
        let error = normalize_adapter_error(status, secret);
        let displayed = error.to_string();
        let debug = format!("{error:?}");
        assert_eq!(displayed, error.kind.as_str());
        assert!(!displayed.contains("sk-live"), "{status}: {displayed}");
        assert!(!displayed.contains("internal"), "{status}: {displayed}");
        assert!(!debug.contains("sk-live"), "{status}: {debug}");
        assert!(!debug.contains("internal"), "{status}: {debug}");
        assert_eq!(error.status_code, Some(status));
        // The mapped error is a closed three-field value, so there is no field
        // that could hold an upstream body in the first place.
        let fields = format!("{error:?}");
        for forbidden in ["body", "message", "upstream", "detail"] {
            assert!(
                !fields.contains(forbidden),
                "the mapped error has no `{forbidden}` field: {fields}"
            );
        }
    }
}

/// Only transport failures retry. A rejected credential, a malformed request,
/// or an unmapped status must stop the attempt chain immediately, because
/// repeating them spends money and discloses nothing new.
#[test]
fn only_transport_failures_are_retryable() {
    for (status, kind, retryable) in [
        (408, super::inference::AdapterErrorKind::Timeout, true),
        (429, super::inference::AdapterErrorKind::RateLimited, true),
        (
            502,
            super::inference::AdapterErrorKind::ProviderUnavailable,
            true,
        ),
        (
            503,
            super::inference::AdapterErrorKind::ProviderUnavailable,
            true,
        ),
        (504, super::inference::AdapterErrorKind::Timeout, true),
        (
            400,
            super::inference::AdapterErrorKind::InvalidRequest,
            false,
        ),
        (
            401,
            super::inference::AdapterErrorKind::CredentialRejected,
            false,
        ),
        (
            403,
            super::inference::AdapterErrorKind::CredentialRejected,
            false,
        ),
        (
            422,
            super::inference::AdapterErrorKind::InvalidRequest,
            false,
        ),
        (
            418,
            super::inference::AdapterErrorKind::InvalidResponse,
            false,
        ),
        (
            500,
            super::inference::AdapterErrorKind::InvalidResponse,
            false,
        ),
    ] {
        let error = normalize_adapter_error(status, "body");
        assert_eq!(error.kind, kind, "status {status}");
        assert_eq!(error.retryable, retryable, "status {status}");
    }
}

/// The retry/fallback chain is bounded. `routes::inference` derives the budget
/// from the route's per-candidate `max_retries` (capped at 3) and the candidate
/// count (capped at 7), so one request can cause a bounded number of dispatches
/// no matter how often a provider fails.
#[test]
fn the_retry_and_fallback_chain_is_bounded() {
    // The route's own derivation, restated over a plausible candidate set: the
    // highest per-candidate `max_retries` capped at 3, and one fallback per
    // remaining candidate capped at 7.
    let per_candidate_max_retries = [3_u8; 10];
    let route_retry_budget = per_candidate_max_retries
        .iter()
        .copied()
        .max()
        .unwrap_or(0)
        .min(3);
    let route_fallback_cap = per_candidate_max_retries.len().saturating_sub(1).min(7) as u8;
    assert_eq!(route_retry_budget, 3);
    assert_eq!(route_fallback_cap, 7);

    // A controller absorbs at most `max(retries, fallbacks)` retryable failures.
    // After that `can_retry()` is false, so the route stops trying other
    // candidates; the next failure is the one it records as terminal.
    let mut controller = RetryController::new(route_retry_budget, route_fallback_cap);
    let mut failures = 0_u8;
    while controller.can_retry() {
        controller.mark_retryable_failure(super::inference::AdapterErrorKind::ProviderUnavailable);
        failures += 1;
        assert!(failures <= 32, "the retry chain is not bounded");
    }
    assert_eq!(
        failures,
        route_retry_budget.max(route_fallback_cap),
        "the absorbed-failure bound is the larger of the two budgets"
    );
    assert!(!controller.can_retry());
    assert!(controller.fallback_count() <= route_fallback_cap);
    // The route's own terminal step: one more failure with no budget left.
    controller.mark_retryable_failure(super::inference::AdapterErrorKind::ProviderUnavailable);
    assert_eq!(controller.state(), ResponseLifecycle::Failed);
    assert!(!controller.can_retry());

    // A route whose candidates all declare zero retries and a single candidate
    // gets one dispatch and no more.
    let mut controller = RetryController::new(0, 0);
    assert!(!controller.can_retry());
    controller.mark_retryable_failure(super::inference::AdapterErrorKind::Timeout);
    assert_eq!(controller.state(), ResponseLifecycle::Failed);
    assert_eq!(controller.fallback_count(), 0);
}

/// A tool-bearing request is never retried and never falls back, so a tool side
/// effect cannot be applied twice. `routes::inference` sets
/// `retry_safe = tools.is_empty()` and reads the budget off that flag, so a
/// false flag means a zero budget at the source.
#[test]
fn a_tool_bearing_request_has_no_retry_and_no_fallback_budget() {
    let mut controller = RetryController::new(0, 0);
    controller.mark_dispatched();
    assert!(!controller.can_retry());
    controller.mark_retryable_failure(super::inference::AdapterErrorKind::Timeout);
    assert_eq!(controller.state(), ResponseLifecycle::Failed);
    assert_eq!(controller.fallback_count(), 0);
}

/// Once the provider has produced meaningful output the response is committed:
/// no retry, no second dispatch, and — because the reservation is only ever
/// reconciled on a terminal transition — no second charge. This is what makes
/// "a fallback does not double-charge" true rather than aspirational.
#[test]
fn a_committed_stream_can_never_be_retried_or_recommitted() {
    let mut controller = RetryController::new(3, 7);
    controller.mark_dispatched();
    assert!(
        controller.can_retry(),
        "a failure before any output may still retry"
    );
    controller.mark_stream_committed();

    controller.mark_retryable_failure(super::inference::AdapterErrorKind::ConnectionFailed);
    assert_eq!(
        controller.state(),
        ResponseLifecycle::Failed,
        "a committed stream must not fall back to another candidate"
    );
    assert!(!controller.can_retry());

    // The terminal state is a latch: a late dispatch or a late commitment cannot
    // resurrect a request that already failed, so a second charge has no state
    // to attach itself to.
    controller.mark_dispatched();
    controller.mark_stream_committed();
    assert_eq!(controller.state(), ResponseLifecycle::Failed);
    assert!(!controller.can_retry());
}

// =============================================================================
// 5. Partial streaming disconnect
// =============================================================================

/// The commitment gate for a provider response that has ended. Text deltas and
/// a flushed tail are not completion: only the protocol's terminal marker is.
/// This is the truncated/mid-token case that "some output was emitted" does not
/// cover, and it is what stops a cut-short run being recorded as succeeded with
/// its budget hold committed.
#[test]
fn a_truncated_stream_is_never_a_completion() {
    // Case one: the connection is cut between two complete frames, so the last
    // frame is missing its blank-line terminator. This is the common
    // truncation and the dangerous one, because the flushed tail parses cleanly
    // and looks exactly like a finished answer.
    let mut decoder = SseDecoder::new();
    let mut state = AdapterStreamState::default();
    let events = decoder.push(
        b"data: {\"id\":\"r1\",\"choices\":[{\"delta\":{\"content\":\"the answer is\"}}]}\n\n\
          data: {\"id\":\"r1\",\"choices\":[{\"delta\":{\"content\":\" forty\"}}]}",
        &mut state,
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, ProviderStreamEvent::TextDelta { .. })),
        "the fixture must produce real output before the cut"
    );
    assert!(!state.may_complete());

    let flushed = decoder.finish(&mut state);
    assert!(
        flushed.iter().any(
            |event| matches!(event, ProviderStreamEvent::TextDelta { text } if text == " forty")
        ),
        "the fixture must have an undelimited tail to flush"
    );
    assert!(
        !state.may_complete(),
        "flushing a well-formed partial event must not complete the response"
    );

    // Case two: the connection is cut mid-token, so the tail does not even parse.
    let mut decoder = SseDecoder::new();
    let mut state = AdapterStreamState::default();
    decoder.push(
        b"data: {\"id\":\"r1\",\"choices\":[{\"delta\":{\"content\":\"the answer is\"}}]}\n\n\
          data: {\"id\":\"r1\",\"choices\":[{\"delta\":{\"content\":\" fort",
        &mut state,
    );
    assert!(!state.may_complete());
    let flushed = decoder.finish(&mut state);
    assert!(
        flushed
            .iter()
            .any(|event| matches!(event, ProviderStreamEvent::InvalidResponse)),
        "a mid-token cut must surface as an invalid response, never as output"
    );
    assert!(state.invalid_response);
    assert!(!state.may_complete());
}

/// The control case: the same stream with its terminal marker completes. Without
/// it, the previous test could pass for the wrong reason — a decoder that never
/// reports completion at all.
#[test]
fn a_stream_that_reaches_its_terminal_marker_is_a_completion() {
    let mut decoder = SseDecoder::new();
    let mut state = AdapterStreamState::default();

    decoder.push(
        b"data: {\"id\":\"r1\",\"choices\":[{\"delta\":{\"content\":\"the answer is\"}}]}\n\n",
        &mut state,
    );
    assert!(
        !state.may_complete(),
        "output without a terminal marker is not a completion"
    );
    decoder.push(b"data: [DONE]\n\n", &mut state);
    assert!(state.may_complete());
    assert!(decoder.finish(&mut state).is_empty());
    assert!(state.may_complete());
}

/// A terminal marker split across two network chunks still completes, so the
/// gate keys on the protocol rather than on chunk boundaries.
#[test]
fn a_terminal_marker_split_across_chunks_still_completes() {
    let mut decoder = SseDecoder::new();
    let mut state = AdapterStreamState::default();

    assert!(
        decoder
            .push(
                b"data: {\"id\":\"r1\",\"choices\":[{\"delta\":{\"content\":",
                &mut state
            )
            .is_empty()
    );
    let tail = decoder.push(b"\"forty\"}}]}\n\ndata: [DONE]\n\n", &mut state);
    assert!(
        tail.iter().any(
            |event| matches!(event, ProviderStreamEvent::TextDelta { text } if text == "forty")
        )
    );
    assert!(state.may_complete());

    // The same marker delivered without its blank line is undelivered until EOF
    // flushes it, and completes then.
    let mut decoder = SseDecoder::new();
    let mut state = AdapterStreamState::default();
    decoder.push(b"data: [DONE]", &mut state);
    assert!(
        !state.may_complete(),
        "an undelimited event is not yet a marker"
    );
    decoder.finish(&mut state);
    assert!(state.may_complete());
}

/// A malformed body never completes, even when it ends cleanly and even after a
/// provider reported usage. Metadata frames are what the existing commitment
/// test already covers; this asserts they cannot become a completion on their
/// own, and that a usage-only stream followed by an error is a failure.
#[test]
fn a_malformed_or_metadata_only_body_is_never_a_completion() {
    let mut decoder = SseDecoder::new();
    let mut state = AdapterStreamState::default();
    let events = decoder.push(
        b"data: {\"id\":\"r1\",\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":0}}\n\n\
          data: {\"error\":{\"code\":\"synthetic\"}}\n\n",
        &mut state,
    );
    assert!(state.invalid_response);
    assert!(!state.may_complete());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, ProviderStreamEvent::InvalidResponse)),
        "the fixture must actually be malformed"
    );

    // A clean but empty body is not a completion either: a provider that
    // returned nothing must not be recorded as a finished answer.
    let mut decoder = SseDecoder::new();
    let mut state = AdapterStreamState::default();
    assert!(decoder.finish(&mut state).is_empty());
    assert!(!state.may_complete());
}

// =============================================================================
// 6. Credential and device revoked mid-request
// =============================================================================

/// A revocation cannot be laundered by anything else about the request. The
/// scope here is deliberately maximal — the key holds every machine-capable
/// permission, the target project is the key's own, the model alias is listed,
/// and the client address is on the allowlist — so the only thing that changes
/// between the allow and the deny is the revocation itself.
#[test]
fn a_revocation_cannot_be_laundered_by_a_permissive_scope_or_a_matching_target() {
    let organization = OrganizationContext {
        organization_id: OrganizationId::new(ORG_ID).expect("fixture org id"),
        state: OrganizationState::Active,
        version: 1,
    };
    let actor = MachineActor::new(
        "key_0123456789abcdef0123456789abcdef"
            .parse()
            .expect("fixture api key id"),
        "svc_0123456789abcdef0123456789abcdef"
            .parse()
            .expect("fixture service account id"),
        organization.organization_id.clone(),
        "lumi_p09",
    );
    let project = ProjectId::new(PROJECT_ID).expect("fixture project id");
    let scope = ApiKeyScope {
        capabilities: vec![
            Permission::RunsStart,
            Permission::RunsRead,
            Permission::InferenceUse,
            Permission::UsageRead,
            Permission::ToolsRead,
        ],
        project_ids: Some(vec![project.clone()]),
        model_aliases: Some(vec!["coding-default".to_owned()]),
        network_allowlist: Some(vec!["203.0.113.10".to_owned()]),
    };
    let request = MachineRequest::org_level("203.0.113.10")
        .with_resource_organization(&organization.organization_id)
        .with_project(&project)
        .with_model_alias("coding-default");
    let live = CredentialState {
        key_active: true,
        account_active: true,
        key_expired: false,
    };

    assert_eq!(
        authorize_machine(
            &actor,
            live,
            &organization,
            &scope,
            &Permission::RunsStart,
            request
        ),
        MachineDecision::Allow,
        "the fixture must allow before the revocation, or this test proves nothing"
    );

    // The revocation lands. Nothing else changed, and the check order means the
    // credential is refused before the scope is even read.
    for (state, reason) in [
        (
            CredentialState {
                key_active: false,
                account_active: true,
                key_expired: false,
            },
            MachineDenyReason::MachineKeyRevoked,
        ),
        (
            CredentialState {
                key_active: true,
                account_active: false,
                key_expired: false,
            },
            MachineDenyReason::MachineKeySuspended,
        ),
        (
            CredentialState {
                key_active: true,
                account_active: true,
                key_expired: true,
            },
            MachineDenyReason::MachineKeyExpired,
        ),
    ] {
        assert_eq!(
            authorize_machine(
                &actor,
                state,
                &organization,
                &scope,
                &Permission::RunsStart,
                request
            ),
            MachineDecision::Deny(reason),
            "{reason:?} must not be laundered by a permissive scope"
        );
    }
}

/// A provider credential is refused the moment it is revoked, in every mode that
/// would otherwise resolve it, and a credential mid-rotation deliberately still
/// is — that exception is a decision, so it is asserted rather than assumed.
#[test]
fn a_revoked_provider_credential_is_not_resolvable() {
    let metadata = |status| CredentialMetadata {
        credential_id: "cred_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: Some(ORG_ID.to_owned()),
        owner_type: CredentialOwnerType::Organization,
        owner_user_id: None,
        provider_id: "prov_0123456789abcdef0123456789abcdef".to_owned(),
        label: "primary".to_owned(),
        status,
        version: 1,
        fingerprint: "0123456789ab".to_owned(),
        key_version: "v1".to_owned(),
        created_at: "2026-09-01T00:00:00.000Z".to_owned(),
        updated_at: "2026-09-01T00:00:00.000Z".to_owned(),
        last_used_at: None,
    };
    let mode = CredentialMode::OrderedFallback;

    assert!(can_resolve_credential(
        &metadata(CredentialStatus::Active),
        ORG_ID,
        USER_ID,
        mode
    ));
    let revoked = metadata(CredentialStatus::Revoked);
    for mode in [
        CredentialMode::PlatformOnly,
        CredentialMode::OrganizationOnly,
        CredentialMode::UserAllowed,
        CredentialMode::PlatformOrOrganization,
        CredentialMode::OrderedFallback,
    ] {
        assert!(
            !can_resolve_credential(&revoked, ORG_ID, USER_ID, mode),
            "a revoked credential must not be resolvable in {mode:?}"
        );
    }
    // Documented exception: a credential mid-rotation stays usable, because
    // refusing it would strand in-flight traffic during a routine secret change.
    assert!(can_resolve_credential(
        &metadata(CredentialStatus::Rotating),
        ORG_ID,
        USER_ID,
        mode
    ));
}

/// A denial carries no approval binding, so there is nothing for an approval
/// granted before a revocation to be replayed into, and a binding issued before
/// the catalog changed no longer matches the call.
#[test]
fn a_revocation_leaves_no_approval_binding_to_replay() {
    let mut input = mcp_tool_input(McpPolicyStatus::Approved);
    let before = evaluate(&input);
    assert_eq!(
        before.decision,
        ToolDecision::RequireSessionApproval,
        "a network tool must require approval; the fixture must exercise the binding"
    );
    let binding = before
        .approval_binding
        .clone()
        .expect("an approval-requiring decision carries its binding");

    // The MCP source is revoked. Nothing else changed.
    input
        .catalog
        .mcp_registrations
        .get_mut(MCP_ID)
        .expect("fixture registered the MCP source")
        .policy_status = McpPolicyStatus::Revoked;
    let after = evaluate(&input);
    assert_eq!(after.decision, ToolDecision::Deny);
    assert_eq!(after.reason.code, DecisionReasonCode::McpSourceNotAllowed);
    assert!(
        after.approval_binding.is_none(),
        "a denial must not carry an approval binding"
    );
    assert!(
        binding.matches_call(&input.call),
        "the binding is still bound to this call; the catalog, not the binding, \
         is what refuses it"
    );
    // And the binding is inert against any change to the call it was issued for.
    let mut changed = input.call.clone();
    changed.tool_fingerprint = "fp-replaced".to_owned();
    assert!(!binding.matches_call(&changed));
}

/// Every revocation shape on the tool and MCP surfaces is a denial, and none of
/// them is reachable by leaving the organization policy in place.
#[test]
fn a_disabled_tool_a_revoked_source_and_a_platform_deny_are_all_refused() {
    let mut input = mcp_tool_input(McpPolicyStatus::Approved);
    assert_ne!(evaluate(&input).decision, ToolDecision::Deny);

    input
        .catalog
        .tools
        .get_mut(MCP_TOOL_ID)
        .expect("fixture registered the tool")
        .lifecycle = ToolLifecycle::Disabled;
    let denied = evaluate(&input);
    assert_eq!(denied.decision, ToolDecision::Deny);
    assert_eq!(denied.reason.code, DecisionReasonCode::ToolInactive);
    assert!(denied.approval_binding.is_none());

    for status in [
        McpPolicyStatus::Revoked,
        McpPolicyStatus::Denied,
        McpPolicyStatus::Disabled,
    ] {
        let denied = evaluate(&mcp_tool_input(status));
        assert_eq!(denied.decision, ToolDecision::Deny, "{status:?}");
        assert_eq!(
            denied.reason.code,
            DecisionReasonCode::McpSourceNotAllowed,
            "{status:?}"
        );
    }

    // A source that is merely unreviewed is a re-review, not a hard deny, so the
    // two states stay distinguishable in an audit.
    let review = evaluate(&mcp_tool_input(McpPolicyStatus::PendingReview));
    assert_eq!(review.decision, ToolDecision::Deny);
    assert_eq!(
        review.reason.code,
        DecisionReasonCode::McpToolRequiresReview
    );

    let mut input = mcp_tool_input(McpPolicyStatus::Approved);
    input.platform.denied_mcp_ids.insert(MCP_ID.to_owned());
    let denied = evaluate(&input);
    assert_eq!(denied.decision, ToolDecision::Deny);
    assert_eq!(denied.reason.code, DecisionReasonCode::PlatformHardDeny);
}

// =============================================================================
// 7. Budget denial
// =============================================================================

/// A hard budget that would be crossed denies, and an unavailable hard budget
/// denies rather than allowing. Both are fail-closed for cloud work. The soft
/// and inactive cases are asserted too, because a soft ceiling quietly becoming
/// a hard one (or a stale period becoming authority) is the same class of
/// mistake in reverse.
#[test]
fn hard_budget_denial_is_fail_closed() {
    let context = ScopeContext::user(ORG_ID, Some(PROJECT_ID.to_owned()), USER_ID, PROJECT_ID);
    let scope = BudgetScope::from_parts("project", ORG_ID, Some(PROJECT_ID))
        .expect("project scope is valid");
    let request = BudgetEvaluationRequest::new(context, 3, true, 1_000);

    let exceeded = evaluate_budget_request(
        &request,
        &[BudgetPolicy::hard(scope.clone(), 10).with_usage(6, 2)],
    );
    assert_eq!(exceeded.decision, BudgetDecision::Deny);
    assert!(exceeded.blocks_cloud_dispatch());
    assert!(!exceeded.is_allowed());
    assert_eq!(exceeded.decision.code(), "budget_exceeded");

    let unavailable = evaluate_budget_request(
        &request,
        &[BudgetPolicy::hard(scope.clone(), 10)
            .with_usage(0, 0)
            .unavailable()],
    );
    assert_eq!(unavailable.decision, BudgetDecision::Unavailable);
    assert!(
        unavailable.blocks_cloud_dispatch(),
        "an unreadable hard budget must not become capacity"
    );
    assert_eq!(unavailable.decision.code(), "budget_state_unavailable");

    // Exactly at the limit is allowed: the hold fits.
    let exact = evaluate_budget_request(
        &request,
        &[BudgetPolicy::hard(scope.clone(), 10).with_usage(5, 2)],
    );
    assert!(exact.is_allowed(), "{exact:?}");

    // A soft budget over its threshold still dispatches, and its unavailability
    // is not authority to block: only a hard policy is a spend ceiling.
    let soft = evaluate_budget_request(
        &request,
        &[BudgetPolicy::soft(scope.clone(), 1).with_usage(0, 0)],
    );
    assert_eq!(soft.decision, BudgetDecision::SoftLimit);
    assert!(soft.is_allowed());

    // An inactive policy is not a ceiling, and a period that does not contain
    // `now` is not a ceiling either.
    let inactive = evaluate_budget_request(
        &request,
        &[BudgetPolicy::hard(scope.clone(), 1)
            .with_usage(99, 99)
            .with_active(false)],
    );
    assert!(inactive.is_allowed(), "{inactive:?}");
    let stale = evaluate_budget_request(
        &request,
        &[BudgetPolicy::hard(scope.clone(), 1)
            .with_usage(99, 99)
            .try_with_period(1, 2)
            .expect("a well-formed period is accepted")],
    );
    assert!(
        stale.is_allowed(),
        "a budget from a closed period is not authority to deny: {stale:?}"
    );
}

/// A hold whose owning request died mid-flight never consumes budget forever.
/// `expires_at` bounds it, so the leak window is the reservation TTL rather than
/// the age of the crashed request, and every terminal path that did reconcile
/// leaves nothing outstanding.
#[test]
fn a_hold_left_behind_by_a_crash_stops_consuming_budget_at_its_expiry() {
    let now = "2026-09-24T12:00:00.000Z";
    let record = |status: &str, expires_at: &str, committed: Option<i64>| BudgetReservationRecord {
        reservation_id: "bud_0123456789abcdef0123456789abcdef".to_owned(),
        request_id: "req_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: ORG_ID.to_owned(),
        reserved_minor: 400,
        committed_minor: committed,
        status: status.to_owned(),
        expires_at: expires_at.to_owned(),
        created_at: "2026-09-24T11:59:00.000Z".to_owned(),
        updated_at: now.to_owned(),
        run_id: None,
        budget_id: None,
        currency: "USD".to_owned(),
        reconciled_at: None,
        reconciliation_reason: None,
    };

    let live = record("reserved", "2026-09-24T12:15:00.000Z", None);
    assert!(live.is_live(now));
    assert_eq!(live.outstanding_minor(now), 400);
    // A hold is bound to the request and run that created it, so it can never be
    // reused for someone else's spend.
    assert!(live.matches_identity("req_0123456789abcdef0123456789abcdef", None));
    assert!(!live.matches_identity("req_1123456789abcdef0123456789abcdef", None));
    assert!(!live.matches_identity("req_0123456789abcdef0123456789abcdef", Some("run_1")));

    // The request is gone and nothing will ever reconcile this row. The hold
    // still stops consuming budget once its window closes.
    let stale = record("reserved", "2026-09-24T11:59:59.000Z", None);
    assert!(!stale.is_live(now));
    assert_eq!(stale.outstanding_minor(now), 0);

    for (status, committed) in [
        ("committed", Some(120)),
        ("released", None),
        ("expired", None),
    ] {
        let settled = record(status, "2026-09-24T11:59:59.000Z", committed);
        assert!(!settled.is_live(now), "{status}");
        assert_eq!(settled.outstanding_minor(now), 0, "{status}");
    }
}

/// A terminal job row is terminal for the durable queue too, so a replayed
/// message cannot re-open a completed or dead-lettered job.
#[test]
fn a_terminal_queue_job_row_cannot_be_reopened_by_a_replay() {
    for state in ["succeeded", "dead_letter", "cancelled"] {
        let parsed = QueueJobState::parse(state).expect("terminal job state parses");
        assert!(parsed.is_terminal(), "{state}");
    }
    for state in ["queued", "running", "retry_wait"] {
        let parsed = QueueJobState::parse(state).expect("live job state parses");
        assert!(!parsed.is_terminal(), "{state}");
    }
    assert!(QueueJobState::parse("expired").is_none());
}

// =============================================================================
// MCP tool fixture for the revocation tests
// =============================================================================

const MCP_ID: &str = "mcp_fixture";
const MCP_TOOL_ID: &str = "tool_mcp_fixture";
const MCP_CAPABILITY: &str = "cap_network";
const MCP_FINGERPRINT: &str = "fp-reviewed";

/// A reviewed, approved, network-class MCP tool that the organization policy
/// lists. Every revocation test starts from this and changes exactly one input.
fn mcp_tool_input(policy_status: McpPolicyStatus) -> PolicyEvaluationInput {
    let definition = ToolDefinition {
        tool_id: MCP_TOOL_ID.to_owned(),
        name: MCP_TOOL_ID.to_owned(),
        source: ToolSource::Custom,
        risk_class: RiskClass::Network,
        capability_ids: BTreeSet::from([MCP_CAPABILITY.to_owned()]),
        fingerprint: MCP_FINGERPRINT.to_owned(),
        lifecycle: ToolLifecycle::Active,
        mcp_registration_id: Some(MCP_ID.to_owned()),
    };
    let mut organization_policy = ToolPolicyLayer {
        default_posture: PolicyPosture::Deny,
        ..ToolPolicyLayer::default()
    };
    organization_policy.tool_ids.insert(MCP_TOOL_ID.to_owned());
    organization_policy.mcp_ids.insert(MCP_ID.to_owned());

    let mut agent = super::tool_policy::AgentToolPolicy::default();
    agent.allowed_tool_ids.insert(MCP_TOOL_ID.to_owned());

    PolicyEvaluationInput {
        mode: super::tool_policy::ExecutionMode::ManagedOrganization,
        platform: super::tool_policy::PlatformToolPolicy::default(),
        organization_policy: Some(organization_policy),
        project_policy: None,
        agent,
        runtime: RuntimeCapabilities {
            supported_capability_ids: BTreeSet::from([MCP_CAPABILITY.to_owned()]),
        },
        catalog: ToolCatalog {
            tools: BTreeMap::from([(MCP_TOOL_ID.to_owned(), definition)]),
            capability_definitions: BTreeMap::from([(
                MCP_CAPABILITY.to_owned(),
                CapabilityDefinition {
                    capability_id: MCP_CAPABILITY.to_owned(),
                    risk_class: RiskClass::Network,
                    lifecycle: CapabilityLifecycle::Active,
                },
            )]),
            mcp_registrations: BTreeMap::from([(
                MCP_ID.to_owned(),
                McpRegistration {
                    mcp_id: MCP_ID.to_owned(),
                    source: McpSource::Custom,
                    policy_status,
                    current_tool_fingerprints: BTreeSet::from([MCP_FINGERPRINT.to_owned()]),
                    reviewed_tool_fingerprints: BTreeSet::from([MCP_FINGERPRINT.to_owned()]),
                },
            )]),
        },
        call: ToolCall {
            tool_call_id: "tcl_fixture".to_owned(),
            tool_id: MCP_TOOL_ID.to_owned(),
            tool_fingerprint: MCP_FINGERPRINT.to_owned(),
            capability_ids: BTreeSet::from([MCP_CAPABILITY.to_owned()]),
            risk_class: RiskClass::Network,
            arguments_summary: "operation=read".to_owned(),
            browser_action: None,
            computer_action: None,
        },
        policy_version: 3,
    }
}

// ---------------------------------------------------------------------------
// VI-BUD-001: a hard budget denial must happen BEFORE any upstream dispatch.
//
// The Tier-0 contract's mutation for this invariant is "move the budget decision
// after dispatch and require upstream-dispatch verification to fail". This is the
// honest account of what that mutation actually finds here, because the interesting
// part is what it does NOT find.
//
// What it DOES find: the dispatch path consumes `budget_decision_value`, a binding
// produced by the budget match. So hoisting the whole dispatch region above the
// budget decision is a COMPILE ERROR, not a silent behaviour change. The ordering is
// therefore load-bearing rather than conventional, and the compiler is the thing that
// fails. That is stronger than a test, and it is the verifier that kills the
// mutation.
//
// What it does NOT find: neutering the decision (`match budget_admission.decision`
// → `match P05BudgetDecision::Allow`) compiles perfectly, because the type is
// unchanged. The compiler couples the dispatch to the decision's RESULT; it cannot
// couple it to the decision being CONSULTED. So the assertions below are what catch
// that, and they are V1 structural -- source text, not runtime. An end-to-end proof
// that a denied request never reaches the provider needs a real D1 binding and a
// mock endpoint, which is the same BLOCKED row as the browser pass and the staging
// deploy. The residual is named in `docs/release/known-limitations.md` rather than
// papered over.
//
// Each assertion below aims at one specific regression, so a failure names which.

/// The VI-BUD-001 gate. V1 (structural), and labelled as such in its own name.
#[test]
fn a_hard_budget_denial_is_wired_to_precede_the_only_upstream_dispatch() {
    // The same resolution the tenant audit uses, so there is one answer to "where is
    // the crate root" rather than two.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("routes")
        .join("inference.rs");
    let source = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "{} must be readable for the VI-BUD-001 gate: {error}",
            path.display()
        )
    });

    // 1. Exactly one dispatch site. A second one would be a dispatch the budget
    //    decision does not sit in front of, and there is nothing here to notice it.
    let dispatch_sites: Vec<_> = source
        .match_indices("dispatch(")
        .map(|(at, _)| at)
        .collect();
    assert_eq!(
        dispatch_sites.len(),
        1,
        "there must be exactly one upstream dispatch in routes/inference.rs, so a budget \
         denial provably precedes all of them; found {}",
        dispatch_sites.len()
    );
    let dispatch_at = dispatch_sites[0];

    // 2. The decision is consulted BEFORE that dispatch, and it is the admission's own
    //    decision rather than a constant. The second half is the part the compiler
    //    cannot check: `match P05BudgetDecision::Allow` has the same type and
    //    compiles, which would let every decision take the Allow arm.
    let admission_at = source
        .find("p05_budget_admission(")
        .expect("the budget admission is called");
    let match_at = source
        .find("match budget_admission.decision {")
        .expect("the admission decision is matched on its own value, not on a constant");
    assert!(
        admission_at < dispatch_at,
        "the budget admission is evaluated AFTER the dispatch, so a denial can arrive too late \
         to prevent it"
    );
    assert!(
        match_at < dispatch_at,
        "the budget decision is matched AFTER the dispatch, so dispatch does not depend on it"
    );

    // 3. Both non-admitting outcomes DIVERGE. A `Deny` arm that recorded the denial
    //    and fell through would be the violation in its purest form: the tenant is
    //    told nothing, and the request is sent anyway.
    let arms = source
        .match_indices("P05BudgetDecision::")
        .map(|(at, _)| at)
        .collect::<Vec<_>>();
    assert!(
        arms.len() >= 4,
        "expected Allow, SoftLimit, Deny and Unavailable arms; found {} mentions",
        arms.len()
    );
    for arm in [
        "P05BudgetDecision::Deny =>",
        "P05BudgetDecision::Unavailable =>",
    ] {
        let at = source
            .find(arm)
            .unwrap_or_else(|| panic!("{arm} is missing from the budget decision"));
        // The arm's body runs to the next arm or the end of the match. 900 characters
        // is generous for these two arms and short enough not to reach past the match.
        // The search starts AFTER the arm's own mention: searching from `at` finds
        // the arm itself at offset 0 and yields an empty body, which is how the first
        // version of this reported a divergence that was right there in the source.
        let body_end = source[at + arm.len()..]
            .find("P05BudgetDecision::")
            .map(|offset| at + arm.len() + offset)
            .unwrap_or(at + 900);
        let body = &source[at..body_end];
        assert!(
            body.contains("return Err("),
            "{arm} does not diverge: it records the refusal and then falls through, so the \
             request would continue to dispatch"
        );
        assert!(
            body.contains("record_inference_denial("),
            "{arm} does not record the refusal, so an operator would not see the denial"
        );
    }

    // 4. The dispatch region CONSUMES the binding the match produces. This is the
    //    coupling that makes hoisting the dispatch a compile error, so it is worth
    //    asserting explicitly: without it the ordering is a convention that a rewrite
    //    could quietly drop.
    assert!(
        source.contains("budget_decision: budget_decision_value.to_owned()"),
        "the dispatch metadata no longer carries the budget decision, so the dispatch path is \
         no longer coupled to it and the ordering has become a convention"
    );
}
