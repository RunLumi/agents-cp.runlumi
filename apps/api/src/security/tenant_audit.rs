//! The tenant-isolation audit (P09-SEC-01).
//!
//! # Why this file exists
//!
//! Four repositories already assert that their SQL binds the organization:
//! `plugins::tests::every_tenant_read_binds_the_organization`,
//! `budgets::tests::every_budget_and_rate_query_binds_the_tenant_first`,
//! `usage::tests::page_and_summary_filters_are_tenant_first`, and
//! `audit::tests::query_requires_a_valid_tenant_and_page_limit`. They are good,
//! and they are also **hand-enumerated**. A `const *_SQL` added tomorrow is not in
//! any of those lists, so it is not covered by construction — it is covered only
//! if somebody remembers. That is the finding this audit exists to fix.
//!
//! This file reads the migrations and the whole `apps/api/src` tree at test time
//! and puts every SQL statement that touches an org-owned table into exactly one
//! of six classes, then asserts the MECHANICAL property of that class. It fails
//! if:
//!
//! * a statement is unclassified — so the audit cannot rot;
//! * a class's mechanical property does not hold — so a classification cannot lie;
//! * an `IdChain` or `JobChain` statement names a resolver that is itself neither
//!   org-bound nor another chain — so a chain has to bottom out in something real.
//!
//! # The three tenant axes
//!
//! The existing tests only know about one. There are three, and a statement can
//! be bound by any of them:
//!
//! * **organization** — `org_id = ?1`. The usual case.
//! * **principal** — `user_id = ?1`. Deleting an account must collect that user's
//!   data across *every* org they belonged to, so these are deliberately not
//!   org-scoped. Treating them as a tenant bug would be wrong.
//! * **device** — `device_id = ?1`. A device authenticated as itself.
//!
//! And there is a fifth thing that is not a tenant axis at all: **the credential
//! itself**. `KEY_BY_PREFIX_SQL` and `KEY_BY_PREFIX_WITH_ACCOUNT_SQL` have no org
//! predicate and must not — a key is looked up by the 12-hex prefix derived from
//! 32 bytes of CSPRNG entropy, and the secret half is then verified in constant
//! time. A caller cannot select another tenant's prefix, because they cannot
//! choose one. That is the boundary for the two statements that hang off it, and it
//! is recorded as a chain terminal rather than left looking like a hole.
//!
//! # What this audit does and does not prove
//!
//! It proves that no SQL statement can *reach* another tenant's row by the shape
//! of the statement. It does NOT prove the routes call the right statement with
//! the right value; that is a call-graph property and needs an integration
//! environment. Both limits are stated in the Integration Gate rather than
//! glossed.
#![cfg(test)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// How a statement is prevented from reaching another tenant's row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Class {
    /// The organization is a predicate in the statement itself.
    OrgBound,
    /// Bound to a principal rather than an organization, by design: account
    /// deletion and export inventory are unions across every org a user was in.
    PrincipalBound,
    /// Bound to a device the caller has already authenticated as.
    DeviceBound,
    /// A read that carries no org predicate but SELECTs `org_id`, so the caller
    /// receives the tenant and can compare it. Without that column the "read then
    /// check" pattern is impossible and the statement is a cross-tenant read.
    ReturnsOrg,
    /// A write by primary key with no org predicate, guarded by a compare-and-set
    /// on version or a terminal-state predicate, so a replayed or misrouted write
    /// cannot clobber a newer state.
    CompareAndSet,
    /// No org predicate, reached from an id that an org-scoped read already
    /// resolved. `resolver` names that read, and the audit follows the chain.
    IdChain(&'static str),
    /// No org predicate, reached from a queue job whose envelope is itself
    /// tenant-scoped. `resolver` names the claim statement.
    JobChain(&'static str),
    /// Deliberately crosses tenants: a queue dispatcher, an expiry purge. The only
    /// statements allowed to do that, and each carries its reason.
    PlatformSweep,
    /// A platform table whose tenant column names a SUBJECT rather than the
    /// caller's scope.
    ///
    /// `support_grants.organization_id` is the *customer* a staff principal was
    /// granted access to, not an organization the caller belongs to, and
    /// `kill_switches` mixes a global row (NULL) with organization rows. A staff
    /// principal is not a member of any organization, so "bound the caller's
    /// tenant" is not a property these tables can have. Their isolation is the
    /// STAFF boundary instead, which
    /// [`platform_statements_live_behind_the_staff_boundary`] checks.
    PlatformScoped,
}

/// The credential lookups that are a chain terminal in their own right.
///
/// A key is found by a 12-hex prefix taken from 32 CSPRNG bytes, and the presented
/// secret is then compared in constant time. There is nothing for a caller to
/// tamper with, so "bound the caller's tenant" is the wrong property and demanding
/// it would be demanding a bug.
const CREDENTIAL_LOOKUPS: &[&str] = &[
    "repositories/machine_identity.rs::KEY_BY_PREFIX_SQL",
    "repositories/machine_identity.rs::KEY_BY_PREFIX_WITH_ACCOUNT_SQL",
];

fn is_credential_lookup(key: &str) -> bool {
    CREDENTIAL_LOOKUPS.contains(&key)
}

/// The tables whose tenant column names a subject rather than a caller scope.
const PLATFORM_TABLES: &[&str] = &["support_grants", "kill_switches"];

const JUDGEMENTS: &[(&str, Class, &str)] = &[
    // -- reads that resolve through an org-scoped read upstream ---------------
    (
        "repositories/automations.rs::AUTOMATION_SESSION_BY_EXTERNAL_ID_SQL",
        Class::IdChain("repositories/automations.rs::OCCURRENCE_BY_ID_SQL"),
        "Looks a session up by the occurrence's `external_id`, which is globally \
         unique but org-less. The only caller is a device route that resolved the \
         occurrence through `OCCURRENCE_BY_ID_SQL`, which is org-bound.",
    ),
    (
        "repositories/automations.rs::RUN_LINK_ATTEMPT_EXISTS_SQL",
        Class::IdChain("repositories/automations.rs::OCCURRENCE_BY_ID_SQL"),
        "Keyed by `occurrence_id`. Reached only from the same org-scoped \
         occurrence. Returns a boolean, so it is not a data oracle.",
    ),
    (
        "repositories/automations.rs::PREDECESSOR_SQL",
        Class::IdChain("repositories/automations.rs::OCCURRENCE_BY_ID_SQL"),
        "Walks `blocked_by_occurrence_id`, which points at another occurrence in \
         the same automation. Reached from an org-bound occurrence.",
    ),
    (
        "repositories/automations.rs::OPEN_QUEUED_SUCCESSOR_SQL",
        Class::IdChain("repositories/automations.rs::OCCURRENCE_BY_ID_SQL"),
        "Same chain; the successor is the row the predecessor blocked on.",
    ),
    (
        "repositories/automations.rs::ACTIVE_LEASE_FOR_OCCURRENCE_SQL",
        Class::IdChain("repositories/automations.rs::OCCURRENCE_BY_ID_SQL"),
        "Keyed by occurrence; the lease cannot belong to another org's occurrence.",
    ),
    (
        "repositories/automations.rs::EXPIRED_LEASES_SQL",
        Class::JobChain("repositories/data_governance.rs::CLAIM_QUEUE_ENVELOPE_SQL"),
        "The sweep runs from a queue job whose envelope names the org. NOT a global \
         sweep: it is bounded by the claimed envelope.",
    ),
    (
        "repositories/projects.rs::BINDING_COUNT_FOR_DEVICE_SQL",
        Class::DeviceBound,
        "Keyed by `device_id` AND `workspace_identity`, both of which the caller \
         proved by authenticating as that device. A device cannot ask about \
         another device's bindings.",
    ),
    (
        "repositories/projects.rs::BINDINGS_BY_DEVICE_SQL",
        Class::DeviceBound,
        "Same device boundary as the count above. Returns `org_id` as well, so the \
         caller could additionally check.",
    ),
    (
        "repositories/tools.rs::DEVICE_FOR_TOKEN_SQL",
        Class::DeviceBound,
        "The device-enrollment path: a one-time token IS the device's proof of \
         possession. Keyed by the token's own device id.",
    ),
    (
        "routes/devices.rs::TOKEN_LOOKUP_SQL",
        Class::DeviceBound,
        "Same enrollment path as above.",
    ),
    (
        "repositories/policy.rs::ACK_EXISTS_SQL",
        Class::DeviceBound,
        "Keyed by `device_id` plus the policy version. Returns a boolean for the \
         caller's own device.",
    ),
    // -- principal-bound: the union an account deletion must make ------------
    (
        "repositories/data_governance.rs::COLLECT_NOTIFICATIONS_USER_SQL",
        Class::PrincipalBound,
        "Account deletion collects a user's notifications across every org they \
         were in. Org-scoping it would silently leave rows behind in orgs they \
         have left, which is the data-retention bug F20 exists to prevent.",
    ),
    (
        "repositories/data_governance.rs::INVENTORY_USER_EXPORT_OBJECTS_SQL",
        Class::PrincipalBound,
        "Same deletion union, over export jobs rather than notifications.",
    ),
    (
        "repositories/data_governance.rs::INVENTORY_MEMBERSHIPS_USER_SQL",
        Class::PrincipalBound,
        "Same deletion union. Deliberately across orgs: a membership is the user's, \
         not one org's.",
    ),
    (
        "repositories/data_governance.rs::INVENTORY_INVITATIONS_USER_SQL",
        Class::PrincipalBound,
        "Same deletion union.",
    ),
    (
        "repositories/security.rs::LIST_SECURITY_EVENTS_FOR_USER_SQL",
        Class::PrincipalBound,
        "A user's own security events across their orgs. This is the user's data \
         to see, not an org's to see.",
    ),
    // -- job-chain: reached only from a tenant-scoped queue envelope ----------
    (
        "repositories/webhooks.rs::NEXT_SECRET_VERSION_SQL",
        Class::JobChain("repositories/webhooks.rs::CLAIM_JOB_SQL"),
        "`MAX(version) WHERE endpoint_id = ?1`. The endpoint id came from an \
         endpoint resolved under the caller's org. Returns a number, never a row.",
    ),
    (
        "repositories/data_governance.rs::CLAIM_QUEUE_ENVELOPE_SQL",
        Class::CompareAndSet,
        "The claim IS the tenant boundary: the envelope is fetched by dedupe key \
         and then compare-and-set on state plus lease version.",
    ),
    (
        "repositories/data_governance.rs::SETTLE_QUEUE_ENVELOPE_SQL",
        Class::CompareAndSet,
        "Settles an envelope this worker already holds a claim on.",
    ),
    (
        "repositories/webhooks.rs::CLAIM_JOB_SQL",
        Class::CompareAndSet,
        "The queue claim. Atomic CAS on job id plus attempt plus state plus lease \
         version; `ux_queue_job_envelopes_dedupe` is the D1-level backstop.",
    ),
    (
        "repositories/webhooks.rs::COMPLETE_JOB_SQL",
        Class::CompareAndSet,
        "Completes a job this worker holds the claim on.",
    ),
    (
        "repositories/webhooks.rs::RETRY_JOB_SQL",
        Class::CompareAndSet,
        "Same. A second worker cannot re-drive a job another worker holds.",
    ),
    // -- compare-and-set writes by primary key -------------------------------
    (
        "repositories/data_governance.rs::MARK_ARTIFACT_DELETED_SQL",
        Class::CompareAndSet,
        "Marks an export artifact deleted, guarded on the artifact's own state.",
    ),
    (
        "repositories/data_governance.rs::TOUCH_GRANT_SQL",
        Class::CompareAndSet,
        "A download grant's single-use redemption, guarded on its own state. \
         This is the statement that makes a grant one-shot.",
    ),
    (
        "repositories/data_governance.rs::REVOKE_GRANTS_FOR_EXPORT_SQL",
        Class::IdChain("repositories/data_governance.rs::DELETION_BY_ID_FOR_SCOPE_SQL"),
        "Revokes every grant for an export the caller already resolved under its \
         own scope. Writes many rows, so a compare-and-set on each is not the \
         property; the org-scoped resolution of the export is.",
    ),
    (
        "repositories/data_governance.rs::SET_DELETION_CUTOFF_SQL",
        Class::CompareAndSet,
        "A deletion job's cutoff, guarded on the job's own state and version.",
    ),
    (
        "repositories/data_governance.rs::UPDATE_DELETION_TASK_SQL",
        Class::CompareAndSet,
        "A deletion task's progress, guarded on its own state and version.",
    ),
    (
        "repositories/data_governance.rs::UPDATE_EXPORT_STATE_SQL",
        Class::CompareAndSet,
        "An export job's state, guarded on state plus version.",
    ),
    (
        "repositories/data_governance.rs::UPDATE_DELETION_STATE_SQL",
        Class::CompareAndSet,
        "A deletion job's state, guarded on state plus version.",
    ),
    (
        "repositories/devices.rs::EXPIRE_ENROLLMENT_SQL",
        Class::CompareAndSet,
        "Enrollment expiry, guarded on the enrollment's own state.",
    ),
    (
        "repositories/devices.rs::COMPLETE_ENROLLMENT_SQL",
        Class::CompareAndSet,
        "Same.",
    ),
    (
        "repositories/devices.rs::REVOKE_DEVICE_SQL",
        Class::CompareAndSet,
        "Revocation, guarded on the device's own state and version so a replayed \
         revoke cannot rewrite why it was revoked.",
    ),
    (
        "repositories/devices.rs::UPDATE_DEVICE_HEARTBEAT_SQL",
        Class::CompareAndSet,
        "A heartbeat, guarded on the device's version.",
    ),
    (
        "repositories/organizations.rs::ACCEPT_INVITATION_SQL",
        Class::CompareAndSet,
        "Invitation acceptance, guarded on the invitation's own state and version \
         so it can be accepted exactly once.",
    ),
    (
        "repositories/machine_identity.rs::TOUCH_KEY_USE_SQL",
        Class::IdChain("repositories/machine_identity.rs::KEY_BY_PREFIX_WITH_ACCOUNT_SQL"),
        "Last-used bookkeeping, best effort, on the key that JUST authenticated. \
         Deliberately unguarded: it is advisory telemetry, so a replay rewrites a \
         timestamp rather than moving money or authority, and a version guard here \
         would fight every concurrent key mutation for no benefit.",
    ),
    (
        "repositories/projects.rs::DELETE_GRANT_SQL",
        Class::IdChain("repositories/projects.rs::GRANT_BY_ID_SQL"),
        "Deletes by `(grant_id, project_id)`. The grant is resolved first and \
         carries its `org_id` for the caller to check.",
    ),
    (
        "repositories/projects.rs::DELETE_BINDING_SQL",
        Class::IdChain("repositories/projects.rs::BINDING_BY_ID_SQL"),
        "Same pattern for a workspace binding.",
    ),
    (
        "repositories/tools.rs::UPDATE_TOOL_CALL_STATUS_SQL",
        Class::IdChain("repositories/tools.rs::TOOL_CALL_REF_BY_ID_SQL"),
        "A tool-call's terminal status. The ref carries its `org_id` and its run's \
         scope, both resolved under the caller.",
    ),
    (
        "repositories/tools.rs::EXPIRE_APPROVAL_SQL",
        Class::CompareAndSet,
        "An approval's expiry, guarded on its own window and state.",
    ),
    (
        "repositories/webhooks.rs::RECORD_TERMINAL_FAILURE_SQL",
        Class::CompareAndSet,
        "An endpoint's terminal failure counter, guarded on its own state.",
    ),
    (
        "repositories/webhooks.rs::RESET_TERMINAL_FAILURES_SQL",
        Class::CompareAndSet,
        "Same counter being reset; a guard stops a replayed reset.",
    ),
    (
        "repositories/webhooks.rs::CANCEL_ENDPOINT_DELIVERIES_SQL",
        Class::IdChain("repositories/webhooks.rs::ENDPOINT_BY_ID_SQL"),
        "Cancels an endpoint's deliveries. The endpoint is org-scoped by the \
         caller's own policy read; the fan-out index makes the cascade exact.",
    ),
    (
        "repositories/webhooks.rs::MARK_DELIVERY_QUEUED_SQL",
        Class::JobChain("repositories/webhooks.rs::CLAIM_JOB_SQL"),
        "One of the delivery CAS transitions, reached from a claimed job.",
    ),
    (
        "repositories/webhooks.rs::MARK_DELIVERY_DELIVERING_SQL",
        Class::JobChain("repositories/webhooks.rs::CLAIM_JOB_SQL"),
        "Same.",
    ),
    (
        "repositories/webhooks.rs::MARK_DELIVERY_DELIVERED_SQL",
        Class::JobChain("repositories/webhooks.rs::CLAIM_JOB_SQL"),
        "Same. `WHERE delivery_id = ?1 AND state = 'delivering' AND version = ?3` \
         is a compare-and-set, so a duplicate delivery cannot double-credit it.",
    ),
    (
        "repositories/webhooks.rs::MARK_DELIVERY_RETRY_SQL",
        Class::JobChain("repositories/webhooks.rs::CLAIM_JOB_SQL"),
        "Same.",
    ),
    (
        "repositories/webhooks.rs::MARK_DELIVERY_DEAD_LETTER_SQL",
        Class::JobChain("repositories/webhooks.rs::CLAIM_JOB_SQL"),
        "Same. Bounded retries end here rather than looping.",
    ),
    (
        "repositories/webhooks.rs::MARK_NOTIFICATION_READ_SQL",
        Class::CompareAndSet,
        "A notification's read state, guarded on its own state so a replay is a \
         no-op rather than a second read receipt.",
    ),
    (
        "repositories/webhooks.rs::MARK_NOTIFICATION_DELIVERY_SQL",
        Class::CompareAndSet,
        "A delivery's state, guarded on its own state AND version, so a duplicate \
         notification cannot be delivered twice.",
    ),
    (
        "jobs/automations.rs::CANCEL_PREDECESSOR_SQL",
        Class::IdChain("repositories/automations.rs::OCCURRENCE_BY_ID_SQL"),
        "Cancels a blocked-on predecessor, reached from an org-bound occurrence.",
    ),
    // -- P01 idempotency: the tenant surface a single-spelling scan missed -----
    (
        "repositories/budgets.rs::ORGS_WITH_EXPIRED_RESERVATIONS_SQL",
        Class::PlatformSweep,
        "The platform expiry sweep. It MUST cross tenants: it asks which \
         organizations hold expired reservations so each can be swept. It returns \
         organization IDs and no other data, and it is bounded by `LIMIT ?2` so \
         one tenant's backlog cannot make the tick expensive.",
    ),
    (
        "repositories/idempotency.rs::LOOKUP_ACTIVE_SQL",
        Class::OrgBound,
        "Bound on BOTH the principal and the organization, plus the method, path \
         and key digest. The narrowest lookup in the system.",
    ),
    (
        "repositories/idempotency.rs::CLAIM_SQL",
        Class::OrgBound,
        "The upsert that claims a key. `ON CONFLICT` is scoped to the same five \
         columns the lookup used, so a claim cannot land on another tenant's row.",
    ),
    (
        "repositories/idempotency.rs::COMPLETION_SQL",
        Class::OrgBound,
        "Completion is bound to the principal, org, method, path, key digest AND \
         the request fingerprint, plus `state = 'pending'` and the claim token. \
         Only the worker holding the claim can complete it.",
    ),
    (
        "repositories/idempotency.rs::RELEASE_CLAIM_SQL",
        Class::OrgBound,
        "Releasing a failed claim. Same five columns plus the claim token, so a \
         second worker cannot release a claim it does not hold.",
    ),
    (
        "repositories/idempotency.rs::ASSERT_CLAIM_SQL",
        Class::OrgBound,
        "An assertion row inserted only when the guarded claim does NOT exist. \
         Writes nothing when the claim is live, which is the property it is for.",
    ),
    (
        "repositories/idempotency.rs::PURGE_EXPIRED_SQL",
        Class::PlatformSweep,
        "The one legitimate cross-tenant delete: an expiry purge over records \
         whose `expires_at` has passed, bounded by `LIMIT ?2` so it cannot lock \
         the table. An idempotency record past its TTL is dead weight by \
         definition, and leaving it would grow D1 without bound.",
    ),
    // -- P01 outbox: tenant-TAGGED, platform-dispatched -----------------------
    (
        "repositories/outbox.rs::INSERT_EVENT_SQL",
        Class::OrgBound,
        "The event's own `organization_id`, which may be NULL for a platform \
         event. Tagged, not scoped: the write is the producer's and cannot reach \
         another tenant's row.",
    ),
    (
        "repositories/outbox.rs::LIST_DUE_SQL",
        Class::PlatformSweep,
        "The dispatcher. It MUST cross tenants: one queue serves every \
         organization, and each row carries the org it belongs to for the handler. \
         Ordered by `next_attempt_at` and bounded by `LIMIT ?2`.",
    ),
    (
        "repositories/outbox.rs::MARK_QUEUED_SQL",
        Class::CompareAndSet,
        "Guarded on `delivery_status` AND `attempt_count`, so two dispatchers \
         racing the same event queue it once.",
    ),
    (
        "repositories/outbox.rs::RECORD_RETRY_SQL",
        Class::CompareAndSet,
        "Guarded on the status the worker observed plus the attempt count, so a \
         duplicate delivery cannot schedule a second retry.",
    ),
    (
        "repositories/outbox.rs::RECORD_DEAD_LETTER_SQL",
        Class::CompareAndSet,
        "Same guard, into the terminal state. Bounded retries end here rather \
         than looping, and the DLQ is visible rather than silent.",
    ),
    (
        "repositories/outbox.rs::MARK_DELIVERED_SQL",
        Class::CompareAndSet,
        "Guarded on the delivery status being one of the two non-terminal values, \
         so a duplicate cannot deliver, or re-deliver, a settled event.",
    ),
    (
        "repositories/outbox.rs::MARK_DEAD_LETTER_SQL",
        Class::CompareAndSet,
        "Same guard, into the terminal state.",
    ),
    (
        "repositories/outbox.rs::GET_RECORD_SQL",
        Class::ReturnsOrg,
        "Reads one event by id and returns its `organization_id`, so the caller \
         receives the tenant and can compare it before showing anything.",
    ),
    (
        "repositories/plugins.rs::POLICY_CONFLICTS_SQL",
        Class::OrgBound,
        "The F25-004 conflict read, scoped by `p.org_id = ?1`. It was an inline \
         literal inside the function until the P09 audit flagged it as invisible to \
         the tenant checks, so it is a named constant now and therefore audited.",
    ),
    // -- P08 migration adoption -------------------------------------------------
    //
    // P08 landed after this audit existed, and these 19 statements were flagged
    // unclassified on the first rebase. That is the audit working: a phase that
    // merges without it inherits an unaudited tenant surface, and "the audit was
    // not running" is indistinguishable from "the queries are fine".
    (
        "repositories/migration.rs::SELECT_ADOPTION_SQL",
        Class::OrgBound,
        "One adoption row by id AND `org_id`. The id is the caller's own; the org \
         is asserted anyway, so a substituted id returns nothing rather than \
         another tenant's row.",
    ),
    (
        "repositories/migration.rs::SELECT_ADOPTION_BY_EXTERNAL_SQL",
        Class::OrgBound,
        "The (external installation, workspace key) pair scoped to one org, so two \
         organizations adopting the same local installation cannot collide.",
    ),
    (
        "repositories/migration.rs::SELECT_ADOPTION_PAGE_SQL",
        Class::OrgBound,
        "The org's adoption list, bounded. Small by nature — one row per adopted \
         workspace — which is why it needs a ceiling and not a cursor.",
    ),
    (
        "repositories/migration.rs::SELECT_STAGE_COUNTS_SQL",
        Class::OrgBound,
        "Stage histogram for one org. Returns counts, never content.",
    ),
    (
        "repositories/migration.rs::INSERT_ADOPTION_SQL",
        Class::OrgBound,
        "The insert binds the org. `client_compatibility_policy` is the platform-\
         scoped exception and is not written here.",
    ),
    (
        "repositories/migration.rs::UPDATE_ADOPTION_STAGE_SQL",
        Class::OrgBound,
        "A stage advance, guarded on `org_id` AND `version`. The version guard is \
         what makes a wizard resumed from a cached screen lose rather than \
         overwrite a newer decision.",
    ),
    (
        "repositories/migration.rs::UPDATE_ADOPTION_ROLLBACK_SQL",
        Class::OrgBound,
        "A rollback, guarded the same way. Increments `reversion_count`, so \
         flip-flopping is visible rather than silent.",
    ),
    (
        "repositories/migration.rs::GUARD_SQL",
        Class::OrgBound,
        "The optimistic-concurrency assertion, expressed as an idempotency claim. \
         Writes nothing when a newer version exists, which is the property.",
    ),
    (
        "repositories/migration.rs::INSERT_EVENT_SQL",
        Class::OrgBound,
        "A stage event, bound to the org it happened in. The only adoption write \
         whose owner scope is a device, and it still carries the org.",
    ),
    (
        "repositories/migration.rs::SELECT_EVENTS_SQL",
        Class::OrgBound,
        "Stage events for one org, grouped. `result_code` and `stage` only — the \
         schema has no column that could hold local content.",
    ),
    (
        "repositories/migration.rs::SELECT_REMEDIATIONS_SQL",
        Class::OrgBound,
        "Remediations for one org, bounded, open ones first.",
    ),
    (
        "repositories/migration.rs::INSERT_REMEDIATION_SQL",
        Class::OrgBound,
        "A remediation, bound to the org. Carries a code and a remedy and no \
         resolution note by design.",
    ),
    (
        "repositories/migration.rs::RESOLVE_REMEDIATION_SQL",
        Class::OrgBound,
        "Resolution, guarded on `org_id`, `state = 'open'` AND `version`, so a \
         remediation is resolved exactly once.",
    ),
    (
        "repositories/migration.rs::GUARD_REMEDIATION_OPEN_SQL",
        Class::OrgBound,
        "The remediation claim, as an idempotency row. Same shape as `GUARD_SQL`.",
    ),
    (
        "repositories/migration.rs::SELECT_AUTOMATION_COUNT_SQL",
        Class::OrgBound,
        "Counts the org's active automations, for a pre-import check.",
    ),
    (
        "repositories/migration.rs::SELECT_LICENSE_STATE_SQL",
        Class::OrgBound,
        "The org's license state, for a pre-import check. Same read the \
         entitlement evaluator makes.",
    ),
    (
        "repositories/migration.rs::SELECT_BOOLEAN_GRANT_SQL",
        Class::OrgBound,
        "An entitlement grant scoped to the org AND to `revoked_at IS NULL` AND \
         unexpired, so a revoked grant cannot be read as held.",
    ),
    (
        "repositories/migration.rs::SELECT_COUNT_GRANT_SQL",
        Class::OrgBound,
        "The counting form of the same predicate. Seat counts are read for an \
         import plan, so it must agree with the boolean exactly.",
    ),
    (
        "repositories/migration.rs::SELECT_ORG_TOOL_POLICY_SQL",
        Class::OrgBound,
        "The org-wide tool policy (`project_id IS NULL`), for a pre-import \
         check. Project-scoped policies are read separately.",
    ),
    // -- P07 platform operations: the STAFF boundary ---------------------------
    (
        "repositories/platform_ops.rs::INSERT_GRANT_SQL",
        Class::PlatformScoped,
        "Writes a support grant. The `organization_id` is the customer being \
         granted access, not the caller's scope.",
    ),
    (
        "repositories/platform_ops.rs::GRANTS_FOR_STAFF_AND_ORG_SQL",
        Class::PlatformScoped,
        "Scoped to a staff principal AND the customer org, which together are \
         the boundary: a support principal's grants for one customer.",
    ),
    (
        "repositories/platform_ops.rs::GRANT_BY_ID_SQL",
        Class::PlatformScoped,
        "Reads a grant by id. Reached only from the staff route, and the caller \
         is a staff principal rather than an org member.",
    ),
    (
        "repositories/platform_ops.rs::GRANTS_PAGE_SQL",
        Class::PlatformScoped,
        "The staff list of every grant. Crossing tenants is the point: it is the \
         platform's own audit surface, behind the staff boundary.",
    ),
    (
        "repositories/platform_ops.rs::REVOKE_GRANT_SQL",
        Class::PlatformScoped,
        "Revocation, guarded on the issuing staff principal, the version, and \
         `revoked_at IS NULL` so a grant cannot be revoked twice or restored.",
    ),
    (
        "repositories/platform_ops.rs::ASSERT_FLAG_VERSION_SQL",
        Class::OrgBound,
        "The feature-flag optimistic-concurrency assertion, expressed as an \
         idempotency claim. It writes `idempotency_records`, which IS tenant \
         bound; the flag it asserts on is global, which is why the two differ.",
    ),
    (
        "repositories/platform_ops.rs::KILL_SWITCHES_FOR_TARGET_SQL",
        Class::PlatformScoped,
        "Matches every ENGAGED switch for a target, across scopes. Ordering puts \
         the organization-scoped row last, which is what makes the narrow decision \
         the reported one.",
    ),
    (
        "repositories/platform_ops.rs::KILL_SWITCHES_PAGE_SQL",
        Class::PlatformScoped,
        "The staff list of every switch. Global by design: a global switch has a \
         NULL organization and must still be visible.",
    ),
    (
        "repositories/platform_ops.rs::KILL_SWITCH_BY_ID_SQL",
        Class::PlatformScoped,
        "Reads one switch by id, for the staff route that lifts it.",
    ),
    (
        "repositories/platform_ops.rs::INSERT_KILL_SWITCH_SQL",
        Class::PlatformScoped,
        "Engaging a switch. A global switch stores NULL for the organization, \
         which 0018 validates against the scope.",
    ),
    (
        "repositories/platform_ops.rs::LIFT_KILL_SWITCH_SQL",
        Class::PlatformScoped,
        "Lifting is guarded on the version AND `state = 'engaged'`, so a lifted \
         switch cannot be re-engaged in place and a replay is a no-op.",
    ),
    (
        "repositories/platform_ops.rs::ASSERT_KILL_SWITCH_VERSION_SQL",
        Class::PlatformScoped,
        "The lift's optimistic-concurrency assertion, as an idempotency claim.",
    ),
    (
        "routes/billing.rs::ASSERT_IDEMPOTENCY_CLAIM_SQL",
        Class::OrgBound,
        "Billing's own copy of the claim assertion, bound to the caller's org.",
    ),
    (
        "routes/billing.rs::COMPLETE_IDEMPOTENCY_SQL",
        Class::OrgBound,
        "Billing's own completion, bound to the caller's org and the claim token.",
    ),
];

/// The other statements touching an org-owned table, each judged by its shape.
///
/// These need no per-entry reason: the audit re-derives `OrgBound` and
/// `ReturnsOrg` from the statement text and fails if the label disagrees, so a
/// mislabel here cannot survive.
const MECHANICAL: &[(&str, Class)] = &[
    ("repositories/ai.rs::INSERT_PROVIDER_SQL", Class::OrgBound),
    (
        "repositories/ai.rs::UPDATE_PROVIDER_LIFECYCLE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::UPDATE_MODEL_LIFECYCLE_SQL",
        Class::OrgBound,
    ),
    ("repositories/ai.rs::INSERT_POLICY_SQL", Class::OrgBound),
    ("repositories/ai.rs::UPDATE_POLICY_SQL", Class::OrgBound),
    ("repositories/ai.rs::INSERT_CREDENTIAL_SQL", Class::OrgBound),
    ("repositories/ai.rs::INSERT_ROUTE_SQL", Class::OrgBound),
    (
        "repositories/ai.rs::INSERT_ROUTE_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::ASSERT_ROUTE_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::ASSERT_CREDENTIAL_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::ASSERT_PROVIDER_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::ASSERT_MODEL_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::ASSERT_POLICY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::ASSERT_POLICY_ABSENT_SQL",
        Class::OrgBound,
    ),
    ("repositories/ai.rs::PUBLISH_ROUTE_SQL", Class::OrgBound),
    (
        "repositories/ai.rs::UPDATE_ROUTE_LIFECYCLE_SQL",
        Class::OrgBound,
    ),
    ("repositories/ai.rs::ROLLBACK_ROUTE_SQL", Class::OrgBound),
    ("repositories/ai.rs::HEALTH_UPSERT_SQL", Class::OrgBound),
    (
        "repositories/ai.rs::INSERT_INFERENCE_REQUEST_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::UPDATE_INFERENCE_REQUEST_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::INSERT_BUDGET_RESERVATION_IF_AVAILABLE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::INSERT_BUDGET_RESERVATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/ai.rs::UPDATE_BUDGET_RESERVATION_SQL",
        Class::OrgBound,
    ),
    ("repositories/ai.rs::INSERT_USAGE_SQL", Class::OrgBound),
    ("repositories/audit.rs::INSERT_AUDIT_SQL", Class::OrgBound),
    (
        "repositories/audit.rs::INSERT_AUDIT_IDEMPOTENT_SQL",
        Class::OrgBound,
    ),
    ("repositories/audit.rs::LIST_AUDIT_SQL", Class::OrgBound),
    ("repositories/audit.rs::GET_AUDIT_SQL", Class::OrgBound),
    (
        "repositories/automations.rs::AUTOMATION_BY_ID_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::AUTOMATIONS_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::ACTIVE_AUTOMATION_COUNT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::DUE_AUTOMATIONS_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/automations.rs::SCHEDULE_RULE_BY_ID_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::INSERT_SCHEDULE_RULE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::INSERT_AUTOMATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::UPDATE_AUTOMATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::SET_AUTOMATION_STATUS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::SOFT_DELETE_AUTOMATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::ADVANCE_CURSOR_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::INSERT_OCCURRENCE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::OCCURRENCE_BY_ID_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::OCCURRENCES_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::DEVICE_DUE_OCCURRENCES_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::TRANSITION_OCCURRENCE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::INSERT_LEASE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::LEASE_BY_ID_SQL",
        Class::OrgBound,
    ),
    ("repositories/automations.rs::ATTEMPTS_SQL", Class::OrgBound),
    (
        "repositories/automations.rs::RENEW_LEASE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::SETTLE_LEASE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::CLOSE_LEASE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::RUN_LINK_BY_ATTEMPT_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/automations.rs::INSERT_RUN_LINK_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::UPDATE_RUN_LINK_STATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::INSERT_AUTOMATION_SESSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::INSERT_AUTOMATION_RUN_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::LICENSE_STATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::PRINCIPAL_MEMBERSHIP_ACTIVE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::EFFECTIVE_INTEGER_ENTITLEMENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::CURRENT_POLICY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/automations.rs::RESTART_CURSOR_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::BILLING_ACCOUNT_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::SUBSCRIPTION_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::APPLY_SUBSCRIPTION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::ASSERT_SUBSCRIPTION_APPLIED_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::INSERT_SUBSCRIPTION_EVENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::PROVIDER_SYNC_STATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::RECORD_PROVIDER_SUCCESS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::RECORD_PROVIDER_FAILURE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::PROVIDER_PROJECTION_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::UPSERT_PROVIDER_PROJECTION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::ENTITLEMENT_GRANTS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::INSERT_OVERRIDE_GRANT_SQL",
        Class::OrgBound,
    ),
    ("repositories/billing.rs::REVOKE_GRANT_SQL", Class::OrgBound),
    (
        "repositories/billing.rs::LICENSE_STATE_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::UPSERT_LICENSE_STATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::MAX_ACCEPTED_POLICY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::INSERT_LICENSE_SNAPSHOT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::LATEST_SNAPSHOT_FOR_AUDIENCE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::AUTHORITATIVE_COUNTS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/billing.rs::MEMBERSHIP_SEAT_ROWS_SQL",
        Class::OrgBound,
    ),
    ("repositories/budgets.rs::BUDGETS_PAGE_SQL", Class::OrgBound),
    (
        "repositories/budgets.rs::INSERT_BUDGET_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::UPDATE_BUDGET_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::ASSERT_BUDGET_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::ASSERT_BUDGET_ABSENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::ASSERT_RESERVATION_CREATED_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::ASSERT_RESERVATION_RECONCILED_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::INFERENCE_REQUEST_SCOPE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::INSERT_RESERVATION_IF_AVAILABLE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::RECONCILE_RESERVATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::EXPIRE_RESERVATIONS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::RATE_LIMITS_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::UPSERT_RATE_LIMIT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::ASSERT_RATE_LIMIT_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::ASSERT_RATE_LIMIT_ABSENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::BUDGET_SCOPE_SNAPSHOT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/budgets.rs::RATE_LIMIT_USAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::POLICY_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INSERT_POLICY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::UPDATE_POLICY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::ASSERT_POLICY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::EXPORT_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::EXPORT_BY_ID_FOR_SCOPE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::EXPORT_BY_DEDUPE_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::EXPORTS_PAGE_FOR_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::EXPORTS_PAGE_FOR_USER_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::INSERT_EXPORT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INSERT_ARTIFACT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::ARTIFACT_BY_EXPORT_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::INSERT_GRANT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::GRANT_BY_FINGERPRINT_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::DELETION_BY_ID_FOR_SCOPE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::DELETION_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::DELETION_BY_TARGET_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::DELETIONS_PAGE_FOR_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::DELETIONS_PAGE_FOR_USER_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::INSERT_DELETION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::LINK_DELETION_JOB_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INSERT_DELETION_TASK_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::DELETION_TASKS_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::PENDING_DELETION_TASKS_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::INSERT_CERTIFICATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::CERTIFICATE_BY_DELETION_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/data_governance.rs::QUEUE_ENVELOPE_BY_DEDUPE_SQL",
        Class::ReturnsOrg,
    ),
    // The due-envelope read the P06 job producer dispatches from. It deliberately
    // crosses tenants -- the cron sweep serves every tenant at once -- so it is a
    // bounded platform sweep rather than an org-bound read. The LIMIT is what makes
    // that safe, and the class is what stops it from being unbounded. See VFY-009.
    (
        "repositories/data_governance.rs::QUEUE_ENVELOPES_DUE_SQL",
        Class::PlatformSweep,
    ),
    (
        "repositories/data_governance.rs::INSERT_QUEUE_ENVELOPE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_IDENTITY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_ORGANIZATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_ORGANIZATION_MEMBERSHIPS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_ORGANIZATION_TEAMS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_DEVICES_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_RUNS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_USAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_AUDIT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_NOTIFICATIONS_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::COLLECT_POLICY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_EXPORT_OBJECTS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_MEMBERSHIPS_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_DEVICES_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_DEVICES_USER_SQL",
        Class::PrincipalBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_ENROLLMENTS_USER_SQL",
        Class::PrincipalBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_ENROLLMENTS_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_WORKSPACE_BINDINGS_USER_SQL",
        Class::PrincipalBound,
    ),
    (
        "repositories/data_governance.rs::INVENTORY_INVITATIONS_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/devices.rs::INSERT_ENROLLMENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/devices.rs::ENROLLMENT_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/devices.rs::DENY_ENROLLMENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/devices.rs::INSERT_DEVICE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/devices.rs::APPROVE_ENROLLMENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/devices.rs::DEVICE_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/devices.rs::DEVICES_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/devices.rs::FIRST_DEVICES_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/devices.rs::DEVICE_COUNT_BY_FINGERPRINT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::ACCOUNT_BY_ID_FOR_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::KEY_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/machine_identity.rs::KEY_BY_PREFIX_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/machine_identity.rs::KEY_BY_PREFIX_WITH_ACCOUNT_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/machine_identity.rs::ACCOUNTS_PAGE_FOR_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::KEYS_PAGE_FOR_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::INSERT_ACCOUNT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::UPDATE_ACCOUNT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::SUSPEND_ACCOUNT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::RESUME_ACCOUNT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::INSERT_KEY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::MARK_KEY_ROTATED_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::REVOKE_KEY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::ASSERT_ACCOUNT_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/machine_identity.rs::ASSERT_KEY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INSERT_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::UPDATE_ORG_STATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INSERT_DEFAULT_LICENSE_STATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INSERT_MEMBERSHIP_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::ORG_BY_ID_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::ORGS_FOR_USER_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/organizations.rs::MEMBERSHIP_BY_USER_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::MEMBERS_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::UPDATE_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INSERT_INVITATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::PENDING_INVITATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INVITATION_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/organizations.rs::INVITATIONS_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::REVOKE_INVITATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::ROTATE_INVITATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INSERT_INVITED_MEMBERSHIP_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::CHANGE_ROLE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::REMOVE_MEMBERSHIP_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::TRANSFER_OWNERSHIP_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INSERT_TEAM_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::TEAMS_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::INSERT_TEAM_MEMBER_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::DELETE_TEAM_MEMBER_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/organizations.rs::ORG_BY_SLUG_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/plugins.rs::INSTALL_BY_ORG_AND_PACKAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::INSTALLS_FOR_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::POLICY_BY_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::INSERT_POLICY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::UPDATE_POLICY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::INSERT_INSTALL_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::UPDATE_INSTALL_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::SET_INSTALL_BLOCK_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::INSERT_REGISTRATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::UNREGISTERED_TOOLS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::REGISTERED_TOOLS_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/plugins.rs::RECORD_REPORT_SQL",
        Class::OrgBound,
    ),
    ("repositories/plugins.rs::TOUCH_REPORT_SQL", Class::OrgBound),
    (
        "repositories/plugins.rs::ASSERT_POLICY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/policy.rs::INSERT_SNAPSHOT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/policy.rs::SNAPSHOT_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/policy.rs::LATEST_SNAPSHOT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/policy.rs::SNAPSHOT_BY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/policy.rs::MAX_POLICY_VERSION_SQL",
        Class::OrgBound,
    ),
    ("repositories/policy.rs::INSERT_ACK_SQL", Class::OrgBound),
    (
        "repositories/projects.rs::INSERT_PROJECT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::PROJECT_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/projects.rs::UPDATE_PROJECT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::PROJECT_SLUG_COUNT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::PROJECTS_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::FIRST_PROJECTS_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::INSERT_GRANT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::GRANT_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/projects.rs::GRANTS_BY_PROJECT_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/projects.rs::GRANT_FOR_MEMBER_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::INSERT_BINDING_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/projects.rs::BINDING_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/projects.rs::BINDINGS_BY_PROJECT_SQL",
        Class::ReturnsOrg,
    ),
    ("repositories/runs.rs::AGENT_BY_ID_SQL", Class::OrgBound),
    ("repositories/runs.rs::AGENTS_PAGE_SQL", Class::OrgBound),
    ("repositories/runs.rs::INSERT_AGENT_SQL", Class::OrgBound),
    ("repositories/runs.rs::UPDATE_AGENT_SQL", Class::OrgBound),
    ("repositories/runs.rs::SESSION_BY_ID_SQL", Class::OrgBound),
    ("repositories/runs.rs::SESSIONS_PAGE_SQL", Class::OrgBound),
    ("repositories/runs.rs::INSERT_SESSION_SQL", Class::OrgBound),
    (
        "repositories/runs.rs::UPDATE_SESSION_LIFECYCLE_SQL",
        Class::OrgBound,
    ),
    ("repositories/runs.rs::RUN_BY_ID_SQL", Class::OrgBound),
    ("repositories/runs.rs::RUNS_PAGE_SQL", Class::OrgBound),
    ("repositories/runs.rs::INSERT_RUN_SQL", Class::OrgBound),
    (
        "repositories/runs.rs::UPDATE_RUN_STATE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/runs.rs::NEXT_EVENT_SEQUENCE_SQL",
        Class::OrgBound,
    ),
    ("repositories/runs.rs::MAX_ATTEMPT_SQL", Class::OrgBound),
    ("repositories/runs.rs::INSERT_EVENT_SQL", Class::OrgBound),
    ("repositories/runs.rs::EVENTS_PAGE_SQL", Class::OrgBound),
    ("repositories/runs.rs::INSERT_ARTIFACT_SQL", Class::OrgBound),
    ("repositories/runs.rs::ARTIFACTS_PAGE_SQL", Class::OrgBound),
    (
        "repositories/runs.rs::ASSERT_AGENT_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/runs.rs::ASSERT_SESSION_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/runs.rs::ASSERT_RUN_STATE_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/runs.rs::ASSERT_RETRY_ATTEMPT_ABSENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/security.rs::INSERT_SECURITY_EVENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/security.rs::LIST_SECURITY_EVENTS_SQL",
        Class::OrgBound,
    ),
    ("repositories/tools.rs::INSERT_TOOL_SQL", Class::OrgBound),
    ("repositories/tools.rs::TOOL_BY_ID_SQL", Class::OrgBound),
    (
        "repositories/tools.rs::TOOL_BY_FINGERPRINT_SQL",
        Class::OrgBound,
    ),
    ("repositories/tools.rs::TOOLS_PAGE_SQL", Class::OrgBound),
    (
        "repositories/tools.rs::FIRST_TOOLS_PAGE_SQL",
        Class::OrgBound,
    ),
    ("repositories/tools.rs::UPDATE_TOOL_SQL", Class::OrgBound),
    (
        "repositories/tools.rs::ASSERT_TOOL_VERSION_SQL",
        Class::OrgBound,
    ),
    ("repositories/tools.rs::INSERT_MCP_SQL", Class::OrgBound),
    ("repositories/tools.rs::MCP_BY_ID_SQL", Class::OrgBound),
    (
        "repositories/tools.rs::MCP_BY_FINGERPRINT_SQL",
        Class::OrgBound,
    ),
    ("repositories/tools.rs::MCP_PAGE_SQL", Class::OrgBound),
    ("repositories/tools.rs::FIRST_MCP_PAGE_SQL", Class::OrgBound),
    ("repositories/tools.rs::UPDATE_MCP_SQL", Class::OrgBound),
    (
        "repositories/tools.rs::ASSERT_MCP_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::TOOL_POLICY_BY_SCOPE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::INSERT_TOOL_POLICY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::UPDATE_TOOL_POLICY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::ASSERT_TOOL_POLICY_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::ASSERT_TOOL_POLICY_ABSENT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::RUN_TOOL_SCOPE_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/tools.rs::INSERT_TOOL_CALL_REF_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::TOOL_CALL_REF_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/tools.rs::CAPABILITIES_FOR_ORG_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::INSERT_APPROVAL_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::INSERT_RESOLVED_APPROVAL_SQL",
        Class::OrgBound,
    ),
    ("repositories/tools.rs::APPROVAL_BY_ID_SQL", Class::OrgBound),
    (
        "repositories/tools.rs::APPROVAL_BY_TOOL_CALL_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/tools.rs::REUSABLE_SESSION_APPROVAL_SQL",
        Class::ReturnsOrg,
    ),
    ("repositories/tools.rs::APPROVALS_PAGE_SQL", Class::OrgBound),
    (
        "repositories/tools.rs::FIRST_APPROVALS_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::RESOLVE_APPROVAL_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::ASSERT_APPROVAL_PENDING_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/tools.rs::ASSERT_APPROVAL_PENDING_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/usage.rs::USAGE_EVENT_SOURCE_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/usage.rs::RUN_USAGE_EVENT_SOURCE_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/usage.rs::USAGE_EVENT_BY_REQUEST_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/usage.rs::USAGE_EVENT_BY_RUN_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/usage.rs::INSERT_COST_RECORD_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/usage.rs::INSERT_RUN_COST_RECORD_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/usage.rs::ASSERT_COST_RECORD_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/usage.rs::ASSERT_RUN_COST_RECORD_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/usage.rs::INSERT_RUN_USAGE_SQL",
        Class::OrgBound,
    ),
    ("repositories/usage.rs::ROLLUPS_PAGE_SQL", Class::OrgBound),
    ("repositories/usage.rs::UPSERT_ROLLUP_SQL", Class::OrgBound),
    ("repositories/usage.rs::DENIALS_PAGE_SQL", Class::OrgBound),
    (
        "repositories/webhooks.rs::ENDPOINT_BY_ID_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::ENDPOINTS_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::INSERT_ENDPOINT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::UPDATE_ENDPOINT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::DISABLE_ENDPOINT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::INSERT_SECRET_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::SECRET_BY_ID_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::FAN_OUT_DELIVERIES_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::INSERT_TEST_DELIVERY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::INSERT_REPLAY_DELIVERY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::DELIVERY_BY_ID_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::DELIVERIES_PAGE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::INSERT_ATTEMPT_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::ATTEMPTS_FOR_DELIVERY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::INSERT_QUEUE_JOB_SQL",
        Class::OrgBound,
    ),
    ("repositories/webhooks.rs::JOB_BY_ID_SQL", Class::ReturnsOrg),
    (
        "repositories/webhooks.rs::INSERT_NOTIFICATION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::NOTIFICATION_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/webhooks.rs::NOTIFICATIONS_PAGE_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/webhooks.rs::INSERT_NOTIFICATION_DELIVERY_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::NOTIFICATION_DELIVERY_BY_ID_SQL",
        Class::ReturnsOrg,
    ),
    (
        "repositories/webhooks.rs::PREFERENCE_BY_SCOPE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::UPSERT_PREFERENCE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::PREFERENCES_BY_SCOPE_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::ASSERT_ENDPOINT_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "repositories/webhooks.rs::ASSERT_PREFERENCE_VERSION_SQL",
        Class::OrgBound,
    ),
    (
        "routes/inference.rs::ATTACH_MANAGED_INFERENCE_IDENTITY_SQL",
        Class::OrgBound,
    ),
    (
        "routes/inference.rs::ATTACH_MANAGED_RUN_POLICY_SQL",
        Class::OrgBound,
    ),
];
// ---------------------------------------------------------------------------
// Deriving the facts from the repository
// ---------------------------------------------------------------------------

fn crate_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// Every table that declares a TENANT column, from the migrations.
///
/// Derived rather than listed, so a new tenant-owned table is audited the day it
/// is created instead of the day somebody remembers.
///
/// The column is not uniformly named, and that is itself a finding. `0011` and
/// `0018` wrote `organization_id` while everything else wrote `org_id`, so a scan
/// that knew only one spelling left four tables outside the audit entirely:
/// `idempotency_records`, `outbox_events`, `support_grants`, and `kill_switches` —
/// the whole P01 idempotency/outbox tenant surface and the P07 grant/kill-switch
/// surface, whose queries nothing was checking. Both spellings count.
/// The column names a tenant-owned table uses to name its tenant.
///
/// Two spellings, because two migrations used two. See [`org_owned_tables`].
const TENANT_COLUMNS: &[&str] = &["org_id", "organization_id"];

fn org_owned_tables() -> BTreeSet<String> {
    let dir = crate_root().join("migrations");
    let mut tables = BTreeSet::new();
    for entry in fs::read_dir(&dir).expect("the migrations directory is readable") {
        let path = entry.expect("a readable directory entry").path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("sql") {
            continue;
        }
        let sql = fs::read_to_string(&path).expect("a readable migration");
        for capture in capture_all(&sql, "CREATE TABLE") {
            let Some((head, body)) = capture.split_once('(') else {
                continue;
            };
            let name = head
                .split_whitespace()
                .last()
                .unwrap_or_default()
                .to_owned();
            if name.is_empty() {
                continue;
            }
            let declares_tenant = body.lines().any(|line| {
                let line = line.trim_start();
                TENANT_COLUMNS
                    .iter()
                    .any(|column| line.starts_with(&format!("{column} ")))
            });
            if declares_tenant {
                tables.insert(name);
            }
        }
    }
    assert!(
        tables.len() > 50,
        "the migration scan found only {} tenant-owned tables; the DDL shape probably changed",
        tables.len()
    );
    tables
}

/// Everything from each marker to the next `;`.
fn capture_all(haystack: &str, marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = haystack;
    while let Some(start) = rest.find(marker) {
        let tail = &rest[start + marker.len()..];
        let Some(end) = tail.find(';') else { break };
        out.push(tail[..end].to_owned());
        rest = &tail[end..];
    }
    out
}

/// `("path/to/file.rs", "CONSTANT_NAME", sql)` for every SQL constant.
fn sql_constants() -> Vec<(String, String, String)> {
    let root = crate_root().join("src");
    let mut found = Vec::new();
    walk(&root, &mut |path| {
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            return;
        }
        let source = fs::read_to_string(path).expect("a readable source file");
        let relative = path
            .strip_prefix(&root)
            .expect("the path is under src")
            .to_string_lossy()
            .into_owned();
        for (name, body) in sql_constant_bodies(&source) {
            found.push((relative.clone(), name, body));
        }
    });
    found
}

fn walk(directory: &Path, visit: &mut impl FnMut(&Path)) {
    for entry in fs::read_dir(directory).expect("a readable directory") {
        let path = entry.expect("a readable entry").path();
        if path.is_dir() {
            walk(&path, visit);
        } else {
            visit(&path);
        }
    }
}

/// Extract every `const NAME_SQL: &str = "..."` / `r#"..."#`.
///
/// Deliberately simple rather than a real parser: the rule it enforces is "a SQL
/// string is a `const`", and `every_sql_statement_lives_in_a_named_constant`
/// proves that rule still holds, so a statement cannot escape the audit by moving
/// into a function.
fn sql_constant_bodies(source: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut search_from = 0usize;
    while let Some(found) = source[search_from..].find("const ") {
        let start = search_from + found;
        let tail = &source[start + "const ".len()..];
        search_from = start + "const ".len();
        let Some(name_end) = tail.find(':') else {
            continue;
        };
        let name = tail[..name_end].trim().to_owned();
        let after_name = &tail[name_end..];
        if !name.ends_with("SQL") || !after_name.trim_start().starts_with(": &str") {
            continue;
        }
        let Some(equals) = after_name.find('=') else {
            continue;
        };
        let literal = after_name[equals + 1..].trim_start();
        if let Some(body) = read_string_literal(literal, source) {
            out.push((name, body));
        }
    }
    out
}

/// The body of the string literal starting at `literal`, plus its total length.
fn read_string_literal(literal: &str, whole: &str) -> Option<String> {
    let base = literal.as_ptr() as usize - whole.as_ptr() as usize;
    if let Some(rest) = literal.strip_prefix('r') {
        let hashes = rest.chars().take_while(|c| *c == '#').count();
        let fence = format!("\"{}", "#".repeat(hashes));
        // `rest` begins one byte after the `r`, so the opening quote is at
        // `base + 1 + rest.find('"')` and the body starts one byte later.
        let body_start = base + 1 + rest.find('"')? + 1;
        let end = find_substring(whole.as_bytes(), body_start, &fence)?;
        return Some(whole[body_start..end].to_owned());
    }
    if !literal.starts_with('"') {
        return None;
    }
    let bytes = whole.as_bytes();
    let mut cursor = base + 1;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\\' => cursor += 2,
            b'"' => return Some(whole[base + 1..cursor].to_owned()),
            _ => cursor += 1,
        }
    }
    None
}

fn find_substring(haystack: &[u8], from: usize, needle: &str) -> Option<usize> {
    let needle = needle.as_bytes();
    if needle.is_empty() || from >= haystack.len() {
        return None;
    }
    (from..=haystack.len().saturating_sub(needle.len()))
        .find(|&at| &haystack[at..at + needle.len()] == needle)
}

// ---------------------------------------------------------------------------
// The classification, and the mechanical property of each class
// ---------------------------------------------------------------------------

fn classification() -> BTreeMap<String, (Class, String)> {
    let mut map: BTreeMap<String, (Class, String)> = MECHANICAL
        .iter()
        .map(|(key, class)| ((*key).to_owned(), (*class, String::new())))
        .collect();
    for (key, class, reason) in JUDGEMENTS {
        let previous = map.insert((*key).to_owned(), (*class, (*reason).to_owned()));
        assert!(
            previous.is_none(),
            "{key} is classified twice; a statement with two classes has none"
        );
    }
    map
}

fn has_org_predicate(sql: &str) -> bool {
    [
        "org_id = ?",
        "org_id=?",
        "org_id= ?",
        "organization_id = ?",
        "organization_id=?",
    ]
    .iter()
    .any(|needle| sql.contains(needle))
}

fn binds_principal(sql: &str) -> bool {
    [
        "user_id = ?",
        "principal_id = ?",
        "member_id = ?",
        "created_by_user_id = ?",
    ]
    .iter()
    .any(|needle| sql.contains(needle))
}

fn binds_device(sql: &str) -> bool {
    // `token_hash = ?` counts: the enrollment path identifies the device by the
    // one-time token that proves possession of it, which is the device's own
    // credential rather than a caller-chosen id.
    ["device_id = ?", "device_fingerprint = ?", "token_hash = ?"]
        .iter()
        .any(|needle| sql.contains(needle))
}

/// The byte offset of a standalone SQL keyword, or `None`.
///
/// Standalone means surrounded by whitespace, not merely contained: `WHERE` must
/// not match inside `somewhere`. Matching on `" WHERE "` with a leading space is
/// what broke this twice, because every statement here puts `WHERE` and `FROM` at
/// the start of a line.
fn find_keyword(sql: &str, keyword: &str) -> Option<usize> {
    let mut at = 0usize;
    while let Some(found) = sql[at..].find(keyword) {
        let absolute = at + found;
        let before = sql[..absolute].chars().next_back();
        let after = sql[absolute + keyword.len()..].chars().next();
        if before.is_none_or(char::is_whitespace) && after.is_none_or(char::is_whitespace) {
            return Some(absolute);
        }
        at = absolute + keyword.len();
    }
    None
}

fn is_write(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_uppercase();
    head.starts_with("UPDATE") || head.starts_with("DELETE")
}

fn is_insert(sql: &str) -> bool {
    sql.trim_start().to_ascii_uppercase().starts_with("INSERT")
}

fn is_select(sql: &str) -> bool {
    sql.trim_start().to_ascii_uppercase().starts_with("SELECT")
}

fn has_org_column(sql: &str) -> bool {
    let upper = sql.to_ascii_uppercase();
    upper.contains("ORG_ID") || upper.contains("ORGANIZATION_ID")
}

/// Does the SELECT list carry the tenant column? Without it the caller cannot
/// compare, so a "read then check" pattern is impossible and the statement is a
/// cross-tenant read.
///
/// The list is everything before the first standalone `FROM` token. Matching on
/// `" FROM "` with a leading space is wrong: the SQL in this repository puts
/// `FROM` on its own line, so there is no space before it, and the check silently
/// returned false for every multi-line statement.
fn select_list_carries_org(sql: &str) -> bool {
    match find_keyword(&sql.to_ascii_uppercase(), "FROM") {
        Some(at) => has_org_column(&sql[..at]),
        None => false,
    }
}

/// A compare-and-set: the write is guarded by an optimistic-concurrency version or
/// by a state predicate, so a replayed or misrouted write cannot clobber a newer
/// state even without a tenant predicate.
fn is_compare_and_set(sql: &str) -> bool {
    let upper = sql.to_ascii_uppercase();
    let Some(where_at) = find_keyword(&upper, "WHERE") else {
        return false;
    };
    let clause = &upper[where_at..];
    // A guard is any predicate beyond the bare primary key, in any of the forms
    // this schema actually uses: an optimistic-concurrency version, a state, an
    // attempt or claim token, or a one-shot precondition such as `IS NULL` or
    // `> 0`. Requiring a WHERE at all keeps a bare `UPDATE t SET x = 1` out.
    [
        "VERSION = ?",
        "STATE = ",
        "STATUS = ",
        "ATTEMPT_COUNT = ?",
        "CLAIM_TOKEN = ?",
        "IS NULL",
        "IS NOT NULL",
        "> 0",
        " IN (",
    ]
    .iter()
    .any(|guard| clause.contains(guard))
}

/// Is `table` named as a whole identifier in the SQL?
///
/// Whole-identifier, not substring: `runs` must not match inside a column called
/// `runs_total`, because a false match would put a statement in the audit that
/// does not touch the table it claims to touch.
fn mentions(sql: &str, table: &str) -> bool {
    sql.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|token| token == table)
}

fn indent(sql: &str) -> String {
    sql.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| format!("      {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn the_migration_scan_derives_the_tenant_owned_tables() {
    let tables = org_owned_tables();
    // One table from each phase, so a DDL change that stops declaring a tenant
    // column is caught here rather than silently un-auditing a whole surface.
    for expected in [
        "organizations",
        "memberships",
        "api_keys",
        "runs",
        "webhook_endpoints",
        "plugin_installs",
        "support_grants",
        // The four that a single-spelling scan misses. Named explicitly because
        // they are the reason `TENANT_COLUMNS` has two entries.
        "kill_switches",
        "idempotency_records",
        "outbox_events",
    ] {
        assert!(tables.contains(expected), "{expected} is tenant-owned");
    }
}

#[test]
fn every_sql_statement_lives_in_a_named_constant() {
    // The audit reads `const` items. If a statement moved into a function the
    // audit would stop seeing it, so this test is what makes the audit's coverage
    // claim true rather than hopeful.
    let root = crate_root().join("src");
    let mut escapes = Vec::new();
    walk(&root, &mut |path| {
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            return;
        }
        if path.to_string_lossy().contains("/security/") {
            return;
        }
        let source = fs::read_to_string(path).expect("a readable source file");
        let stripped = strip_const_bodies(&source);
        for needle in ["SELECT ", "INSERT INTO ", "UPDATE ", "DELETE FROM "] {
            if stripped.contains(&format!("\n{needle}")) {
                escapes.push(format!(
                    "{}: a SQL statement outside a `const *_SQL`",
                    path.file_name().expect("a file name").to_string_lossy()
                ));
            }
        }
    });
    assert!(
        escapes.is_empty(),
        "these SQL statements are invisible to the audit:\n  {}",
        escapes.join("\n  ")
    );
}

/// Blank out the string bodies of `const` items so the scan above sees only code
/// outside them.
fn strip_const_bodies(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    loop {
        let Some(found) = rest.find("const ") else {
            out.push_str(rest);
            return out;
        };
        let start = found;
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(equals) = tail.find('=') else {
            out.push_str(tail);
            return out;
        };
        let literal = tail[equals + 1..].trim_start();
        let Some(body) = read_string_literal(literal, source) else {
            out.push_str(&rest[..start + "const ".len()]);
            rest = &tail["const ".len()..];
            continue;
        };
        let offset = literal.as_ptr() as usize - source.as_ptr() as usize;
        rest = &source[(offset + body.len() + 2).min(source.len())..];
    }
}

#[test]
fn no_sql_statement_touching_a_tenant_owned_table_is_unclassified() {
    let owned = org_owned_tables();
    let classes = classification();
    let mut unclassified = Vec::new();
    let mut seen = 0usize;
    for (file, name, sql) in sql_constants() {
        if !owned.iter().any(|table| mentions(&sql, table)) {
            continue;
        }
        seen += 1;
        let key = format!("{file}::{name}");
        if !classes.contains_key(&key) {
            unclassified.push(key);
        }
    }
    assert!(
        unclassified.is_empty(),
        "{} statement(s) touching a tenant-owned table have no class. Add one to \
         JUDGEMENTS with a reason, or to MECHANICAL if its shape decides it:\n  {}",
        unclassified.len(),
        unclassified.join("\n  ")
    );
    assert!(
        seen > 300,
        "the audit only examined {seen} statements; the extractor probably broke"
    );
}

#[test]
fn every_classification_is_true_of_the_statement_it_labels() {
    let owned = org_owned_tables();
    let classes = classification();
    let mut wrong = Vec::new();
    for (file, name, sql) in sql_constants() {
        let key = format!("{file}::{name}");
        let Some((class, _)) = classes.get(&key) else {
            continue;
        };
        assert!(
            owned.iter().any(|table| mentions(&sql, table)),
            "{key} is classified but touches no tenant-owned table, so it needs no class"
        );
        let ok = match class {
            Class::OrgBound => has_org_predicate(&sql) || (is_insert(&sql) && has_org_column(&sql)),
            Class::PrincipalBound => binds_principal(&sql),
            Class::DeviceBound => binds_device(&sql),
            Class::ReturnsOrg => is_select(&sql) && select_list_carries_org(&sql),
            Class::CompareAndSet => is_write(&sql) && is_compare_and_set(&sql),
            // A sweep may cross tenants, but only if it is bounded: an unbounded
            // cross-tenant statement is a table lock waiting for load.
            Class::PlatformSweep => {
                !has_org_predicate(&sql) && find_keyword(&sql, "LIMIT").is_some()
            }
            Class::PlatformScoped => PLATFORM_TABLES.iter().any(|table| mentions(&sql, table)),
            Class::IdChain(resolver) => !has_org_predicate(&sql) && classes.contains_key(*resolver),
            Class::JobChain(resolver) => {
                !has_org_predicate(&sql) && classes.contains_key(*resolver)
            }
        };
        if !ok {
            wrong.push(format!(
                "{key} is labelled {class:?} but the statement says otherwise:\n{}",
                indent(&sql)
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} classification(s) contradict their statement:\n\n{}",
        wrong.len(),
        wrong.join("\n\n")
    );
}

#[test]
fn every_chain_bottoms_out_in_an_org_bound_statement() {
    // The property that makes `IdChain` more than a label: a chain is only as
    // trustworthy as what it terminates in, so a chain must terminate in a tenant
    // predicate, not in another chain that might itself dangle.
    let classes = classification();
    let constants: BTreeMap<String, String> = sql_constants()
        .into_iter()
        .map(|(file, name, sql)| (format!("{file}::{name}"), sql))
        .collect();
    let mut dangling = Vec::new();
    let mut weak_terminals = Vec::new();
    for (key, (class, _)) in &classes {
        let mut current = match class {
            Class::IdChain(resolver) | Class::JobChain(resolver) => *resolver,
            _ => continue,
        };
        let mut hops = 0usize;
        let terminal = loop {
            let Some(sql) = constants.get(current) else {
                break Err(format!("{current} names no SQL constant"));
            };
            // Two legitimate endings. `OrgBound` is the strong one: the tenant is
            // a predicate, so the statement cannot return another tenant's row at
            // all. `ReturnsOrg` is the weak one: the statement WILL return the
            // row, and safety depends on the caller comparing the tenant it
            // receives. Both satisfy "the caller knows the tenant", which is what
            // a chain needs; only the second needs a human to check the caller.
            if has_org_predicate(sql) {
                break Ok(true);
            }
            // Reached only with the credential that just authenticated.
            if is_credential_lookup(current) {
                break Ok(true);
            }
            let Some((next, _)) = classes.get(current) else {
                // A credential lookup is a real terminal, not a hole: see the
                // module note. It is reached only after the presented secret was
                // verified, so the caller cannot have chosen which row it names.
                if is_credential_lookup(current) {
                    break Ok(true);
                }
                break Err(format!(
                    "{current} is neither org-bound nor classified as a chain, so the \
                     chain from {key} ends in nothing"
                ));
            };
            match next {
                Class::ReturnsOrg => break Ok(false),
                // A `JobChain` may also end at the queue claim itself: the claim
                // is the tenant boundary for everything downstream of it, which is
                // why a CAS is a legitimate terminal there and not elsewhere.
                Class::CompareAndSet if matches!(class, Class::JobChain(_)) => break Ok(true),
                Class::IdChain(next) | Class::JobChain(next) => current = *next,
                // A platform statement has no caller tenant by construction, so a
                // chain ending there is ending at the staff boundary, which is a
                // real boundary rather than a gap.
                Class::PlatformScoped | Class::PlatformSweep => break Ok(true),
                _ => {
                    break Err(format!(
                        "{current} is a leaf class with no tenant, so the chain from \
                         {key} dangles"
                    ));
                }
            }
            hops += 1;
            if hops > 8 {
                break Err(format!("the chain from {key} cycles"));
            }
        };
        match terminal {
            Ok(true) => {}
            Ok(false) => weak_terminals.push(format!("{key} -> {current}")),
            Err(reason) => dangling.push(format!("{key} -> {reason}")),
        }
    }
    assert!(
        dangling.is_empty(),
        "{} chain(s) do not bottom out in an org-bound statement:\n  {}",
        dangling.len(),
        dangling.join("\n  ")
    );
    // Not a failure: these chains are sound, but their safety lives in the CALLER
    // comparing the tenant it receives rather than in the statement refusing the
    // row. Recorded so the count cannot quietly grow.
    if !weak_terminals.is_empty() {
        eprintln!(
            "note: {} chain(s) rest on a caller-side tenant check, not a predicate: {}",
            weak_terminals.len(),
            weak_terminals.join(", ")
        );
    }
}

/// `PlatformScoped` says "this statement has no caller tenant". The safety of
/// that claim is the STAFF boundary, so this is the test that makes the class mean
/// something: a platform table may only be named from the repository and route
/// modules that sit behind `require_staff`.
///
/// It is a module-level check, not a call-graph one, and it is honest about that:
/// it proves the platform tables are not reachable from a customer repository,
/// which is where a leak would actually start.
#[test]
fn platform_statements_live_behind_the_staff_boundary() {
    /// The only two modules permitted to name a platform table.
    const ALLOWED: &[&str] = &["repositories/platform_ops.rs", "routes/internal.rs"];
    let mut offenders = Vec::new();
    for (file, name, sql) in sql_constants() {
        if !PLATFORM_TABLES.iter().any(|table| mentions(&sql, table)) {
            continue;
        }
        if !ALLOWED.contains(&file.as_str()) {
            offenders.push(format!("{file}::{name}"));
        }
    }
    assert!(
        offenders.is_empty(),
        "a platform table is named outside the staff boundary, so its statements \
         have no tenant AND no staff check:\n  {}",
        offenders.join("\n  ")
    );

    // And the platform route prefix is still the staff one, asserted against the
    // mounted paths rather than a comment.
    let internal = fs::read_to_string(crate_root().join("src/routes/internal.rs"))
        .expect("the internal route module is readable");
    for (constant, prefix) in [
        ("FLAG_CREATE_PATH", "/api/v1/internal/"),
        ("KILL_SWITCH_CREATE_PATH", "/api/v1/internal/"),
        ("GRANT_CREATE_PATH", "/api/v1/internal/"),
    ] {
        let line = internal
            .lines()
            .find(|line| line.contains(constant) && line.contains("pub const"))
            .unwrap_or_else(|| panic!("{constant} is declared"));
        assert!(
            line.contains(prefix),
            "{constant} must stay under {prefix}, or the staff boundary is gone: {line}"
        );
    }
    // And the customer-facing route modules must never mention the staff verbs.
    for module in ["src/routes/organizations.rs", "src/routes/billing.rs"] {
        let source = fs::read_to_string(crate_root().join(module)).expect("readable");
        assert!(
            !source.contains("require_staff"),
            "{module} is a customer route and must not hold the staff boundary"
        );
    }
}

#[test]
fn the_audit_covers_every_sql_owning_module() {
    // A coverage floor, so a future rename that breaks extraction is loud rather
    // than quiet. Every module that owns SQL must be represented.
    let mut modules: BTreeSet<String> = sql_constants()
        .into_iter()
        .map(|(file, _, _)| file)
        // The audit names SQL only in its own needles and fixtures, so it is not
        // a SQL-owning module and cannot audit itself.
        .filter(|file| !file.starts_with("security/"))
        .collect();
    for expected in [
        "repositories/ai.rs",
        "repositories/audit.rs",
        "repositories/authenticators.rs",
        "repositories/automations.rs",
        "repositories/billing.rs",
        "repositories/budgets.rs",
        "repositories/data_governance.rs",
        "repositories/device.rs",
        "repositories/devices.rs",
        "repositories/identity.rs",
        "repositories/idempotency.rs",
        "repositories/machine_identity.rs",
        "repositories/migration.rs",
        "repositories/organizations.rs",
        "repositories/outbox.rs",
        "repositories/platform_ops.rs",
        "repositories/plugins.rs",
        "repositories/policy.rs",
        "repositories/projects.rs",
        "repositories/runs.rs",
        "repositories/security.rs",
        "repositories/tools.rs",
        "repositories/usage.rs",
        "repositories/webhooks.rs",
        "jobs/automations.rs",
        "routes/billing.rs",
        "routes/devices.rs",
        "routes/inference.rs",
    ] {
        assert!(modules.remove(expected), "{expected} has no audited SQL");
    }
    assert!(
        modules.is_empty(),
        "these SQL-owning modules are not in the coverage floor: {modules:?}"
    );
}

#[test]
fn the_audit_can_reject_a_mislabelled_statement() {
    // An audit that cannot fail is decoration. This proves the classification
    // check is load-bearing by refuting a mislabelling against the real SQL.
    //
    // `TOUCH_KEY_USE_SQL` records last-used on the key that just authenticated. It
    // is deliberately `IdChain`, not `CompareAndSet` and not `PrincipalBound`, and
    // the statements say so.
    let target = "repositories/machine_identity.rs::TOUCH_KEY_USE_SQL";
    let sql = sql_constants()
        .into_iter()
        .find(|(file, name, _)| format!("{file}::{name}") == target)
        .map(|(_, _, sql)| sql)
        .expect("the statement exists");
    // Refutations, each against the statement rather than against a label.
    assert!(
        !binds_principal(&sql),
        "it binds no principal, so not PrincipalBound"
    );
    assert!(
        !has_org_predicate(&sql) && !(is_insert(&sql) && has_org_column(&sql)),
        "it is not org-bound either, which is why it needed a class at all"
    );
    assert!(
        !is_compare_and_set(&sql),
        "it is deliberately unguarded, so not CompareAndSet"
    );
    assert!(
        is_write(&sql) && !is_select(&sql),
        "it is a write, by id alone"
    );
    // And what it really is, which is what the audit demanded.
    assert_eq!(
        classification().get(target).map(|(class, _)| *class),
        Some(Class::IdChain(
            "repositories/machine_identity.rs::KEY_BY_PREFIX_WITH_ACCOUNT_SQL"
        ))
    );
    // The resolver it names has NO org predicate, and must not: a key is looked up
    // by a CSPRNG-derived prefix and the secret half is verified in constant time,
    // so there is nothing for a caller to tamper with. Asserted so the exemption
    // stays a decision rather than a drift.
    let resolver = sql_constants()
        .into_iter()
        .find(|(file, name, _)| {
            format!("{file}::{name}")
                == "repositories/machine_identity.rs::KEY_BY_PREFIX_WITH_ACCOUNT_SQL"
        })
        .expect("the resolver exists")
        .2;
    assert!(
        !has_org_predicate(&resolver),
        "the credential lookup is a boundary by possession, not by predicate"
    );
    assert!(
        resolver.contains("k.key_prefix = ?1"),
        "it looks up by prefix"
    );
    assert!(
        resolver.contains("secret_hash"),
        "and returns the hash it verifies against"
    );
    assert!(
        is_credential_lookup("repositories/machine_identity.rs::KEY_BY_PREFIX_WITH_ACCOUNT_SQL"),
        "so the exemption is recorded rather than assumed"
    );
}

/// The P09 failure-injection pass found that the jobs dead-letter queue was
/// declared, attached to a consumer, and never read. A poison job that exhausted
/// its retries was acknowledged as an undecodable message and vanished, and
/// `consumers::automations::dead_letter_statement` had zero callers — so FR-F21-009
/// ("dead-letter state must be observable and replayable where safe") was not
/// satisfied and only the Cloudflare dashboard showed the failure.
///
/// These are structural, because the queue branch needs a live `Env` to run. They
/// assert the thing a future edit would break: the branch exists, it is ordered
/// before the outbox, and the statement it writes is terminal.
#[test]
fn the_jobs_dead_letter_queue_is_consumed_before_the_outbox() {
    let lib = fs::read_to_string(crate_root().join("src/lib.rs")).expect("lib.rs is readable");
    let queue_branch = lib
        .find("async fn queue(")
        .expect("the queue entry point exists");
    let body = &lib[queue_branch..];
    let body = &body[..body.find("\nasync fn").unwrap_or(body.len())];

    let dlq = body.find("p06_jobs_dlq_name(&env)").unwrap_or_else(|| {
        panic!("the jobs DLQ is not routed at all; it was declared and never read")
    });
    let outbox = body
        .find("consume_p01_outbox(&batch, &env)")
        .expect("the outbox branch exists");
    assert!(
        dlq < outbox,
        "the DLQ check must precede the outbox: a job envelope decoded as a \\
         business event is undecodable and would be acknowledged as invalid"
    );
    // And the primary jobs queue is still routed, and still first: it carries the
    // live traffic and must not be short-circuited by the dead-letter name.
    let jobs = body
        .find("p06_jobs_queue_name(&env)")
        .expect("the primary jobs queue is routed");
    assert!(jobs < dlq, "the live jobs queue is checked first");

    // The routing order is settled above; this is the CONSUMER's contract, and it
    // lives in a different function. The write is terminal and guarded on the
    // row's own lease version, so a duplicate dead-letter delivery cannot rewrite
    // why a job stopped.
    let consumer = lib
        .split("async fn consume_p06_dead_letters(")
        .nth(1)
        .unwrap_or_else(|| panic!("the dead-letter consumer does not exist"))
        .split("\nasync fn")
        .next()
        .expect("the consumer body");
    let write = consumer.find("dead_letter_statement(").unwrap_or_else(|| {
        panic!("the DLQ consumer must record the row durably before acknowledging")
    });
    // Acknowledged only after the durable write, never before: acking first would
    // make the message disappear with nothing recorded, which is the exact bug
    // this consumer exists to fix.
    assert!(
        consumer[write..].contains(".ack()"),
        "record first, then acknowledge"
    );
    assert!(
        consumer[write..].contains("batch("),
        "the terminal write must be a durable batch, not a best-effort call"
    );
    // A store failure must redeliver, never acknowledge, or the failure becomes
    // permanent precisely when the system is already unhealthy.
    assert!(
        consumer.contains("message.retry()"),
        "an unavailable store must be retried, not acknowledged"
    );
    let consumers = fs::read_to_string(crate_root().join("src/consumers/automations.rs"))
        .expect("the automations consumer is readable");
    assert!(
        consumers.contains("QueueJobState::DeadLetter"),
        "the recorded state must be terminal"
    );
}

/// The budget-expiry sweep had a written, bounded, index-backed statement and no
/// caller. A Worker killed between the reservation insert and `finalize_request`
/// left the row `reserved` forever. Not a spend leak — admission already filters
/// live holds by `expires_at > now` — but the row never reached a terminal state,
/// no `budget.reconciled` event fired, and an operator summing
/// `status = 'reserved'` saw a phantom hold that would never clear.
#[test]
fn an_expired_budget_hold_is_swept_to_a_terminal_state() {
    let budgets = fs::read_to_string(crate_root().join("src/repositories/budgets.rs"))
        .expect("the budget repository is readable");
    assert!(
        budgets.contains("ORGS_WITH_EXPIRED_RESERVATIONS_SQL"),
        "the sweep needs a bounded way to find the organizations to sweep"
    );
    // Bounded twice: organizations, then holds per organization. One tenant's
    // backlog must not make the tick expensive for everyone.
    assert!(budgets.contains("LIMIT ?2"), "the org lookup is bounded");
    assert!(
        budgets.contains("EXPIRE_RESERVATIONS_SQL") && budgets.contains("LIMIT ?3"),
        "the per-organization expiry is bounded"
    );
    // And the scheduled handler actually calls it.
    let lib = fs::read_to_string(crate_root().join("src/lib.rs")).expect("lib.rs is readable");
    assert!(
        lib.contains("run_budget_expiry_sweep(env)"),
        "the expiry sweep is never scheduled"
    );
    assert!(
        lib.contains("budget_expiry_sweep_failed"),
        "and its failure must be a stable signal, not a silent one"
    );
}
