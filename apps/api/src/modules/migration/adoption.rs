//! Adoption stages, ownership, credential mode, telemetry, remediation, and
//! automation-import conflicts (P08-CG, F26).
//!
//! This module is the reason P08 is boring. It contains no I/O, so the rules
//! that decide whether a local workspace becomes an organization resource can
//! be read in one sitting and tested exhaustively:
//!
//! - [`apply_stage`] is the **only** function that can move a workspace forward.
//!   Signing in, enrolling a device, and refreshing a token have no path into
//!   it, which is FR-F26-002 ("a local workspace does not become org-owned
//!   merely because the user signs in") expressed structurally rather than as a
//!   review note.
//! - [`rollback`] is available from every stage and is recorded, not deleted, so
//!   unbinding is a decision with a history instead of a missing row.
//! - [`TelemetryReport::parse`] accepts a closed set of keys. There is no field
//!   through which a prompt, a file path, or a credential could arrive, so
//!   FR-F26-008's "do not count content itself" is a property of the type and
//!   not a promise about future callers.
//! - [`automation_import_preview`] has no mutating counterpart in P08 and no
//!   delete path at all, so "existing local automations remain untouched until
//!   imported" (FR-F26-004) is enforced by the absence of the operation rather
//!   than by remembering not to call one.

use std::collections::BTreeSet;

use serde_json::Value;

use super::compatibility::CompatibilityPolicy;

/// F26 stages 0–5. The names are the wire vocabulary; the ranks are the ordering,
/// and a stage may only ever advance by exactly one rank.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AdoptionStage {
    /// Stage 0 — unmanaged compatibility. No cloud state at all.
    LocalUnmanaged,
    /// Stage 1 — the account exists. Workspaces and sessions are still local.
    AccountOptional,
    /// Stage 2 — this device is enrolled and holds a policy snapshot. The
    /// workspace is still not attached to any project.
    DeviceEnrolled,
    /// Stage 3 — the user explicitly mapped this workspace to a project.
    WorkspaceBound,
    /// Stage 4 — the project runs on org routes, org credentials, org budgets,
    /// and org tool policy.
    ManagedPolicy,
    /// Stage 5 — optional history sync, and only with an explicit choice.
    HistorySync,
}

impl AdoptionStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalUnmanaged => "local_unmanaged",
            Self::AccountOptional => "account_optional",
            Self::DeviceEnrolled => "device_enrolled",
            Self::WorkspaceBound => "workspace_bound",
            Self::ManagedPolicy => "managed_policy",
            Self::HistorySync => "history_sync",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local_unmanaged" => Some(Self::LocalUnmanaged),
            "account_optional" => Some(Self::AccountOptional),
            "device_enrolled" => Some(Self::DeviceEnrolled),
            "workspace_bound" => Some(Self::WorkspaceBound),
            "managed_policy" => Some(Self::ManagedPolicy),
            "history_sync" => Some(Self::HistorySync),
            _ => None,
        }
    }

    /// Zero-based stage number, matching F26's own numbering.
    pub const fn rank(self) -> u8 {
        match self {
            Self::LocalUnmanaged => 0,
            Self::AccountOptional => 1,
            Self::DeviceEnrolled => 2,
            Self::WorkspaceBound => 3,
            Self::ManagedPolicy => 4,
            Self::HistorySync => 5,
        }
    }

    /// Every stage, in order. Used to render a stage ladder and to prove that
    /// `parse` and `as_str` agree across the whole vocabulary.
    pub const ALL: [Self; 6] = [
        Self::LocalUnmanaged,
        Self::AccountOptional,
        Self::DeviceEnrolled,
        Self::WorkspaceBound,
        Self::ManagedPolicy,
        Self::HistorySync,
    ];

    /// The stage exactly one rank above this one, if any.
    pub const fn next(self) -> Option<Self> {
        match self {
            Self::LocalUnmanaged => Some(Self::AccountOptional),
            Self::AccountOptional => Some(Self::DeviceEnrolled),
            Self::DeviceEnrolled => Some(Self::WorkspaceBound),
            Self::WorkspaceBound => Some(Self::ManagedPolicy),
            Self::ManagedPolicy => Some(Self::HistorySync),
            Self::HistorySync => None,
        }
    }

    /// Whether reaching this stage means an organization owns the workspace.
    ///
    /// This is the F26 line between "the cloud knows about it" and "the cloud
    /// governs it". Stages 0–2 leave local state authoritative; stage 3 is the
    /// explicit binding, and from there org policy applies (FR-F26-007).
    pub const fn implies_org_ownership(self) -> bool {
        self.rank() >= Self::WorkspaceBound.rank()
    }
}

/// Who governs a workspace's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ownership {
    /// Local state is authoritative. No org policy, credential, or budget
    /// applies. This is the correct state for a signed-out user and for every
    /// workspace that has not been explicitly bound.
    LocalUnmanaged,
    /// The organization governs this workspace. Org policy is authoritative for
    /// managed operations and a stale local config cannot bypass it.
    OrgManaged,
}

impl Ownership {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalUnmanaged => "local_unmanaged",
            Self::OrgManaged => "org_managed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local_unmanaged" => Some(Self::LocalUnmanaged),
            "org_managed" => Some(Self::OrgManaged),
            _ => None,
        }
    }

    /// The ownership a stage implies.
    ///
    /// Used only by [`apply_stage`] and [`credential_mode_permitted`], and only
    /// for a stage the user explicitly asked for. Nothing else derives ownership,
    /// which is what keeps signing in from converting a local workspace.
    pub const fn for_stage(stage: AdoptionStage) -> Self {
        if stage.implies_org_ownership() {
            Self::OrgManaged
        } else {
            Self::LocalUnmanaged
        }
    }
}

/// What happens to an existing local provider secret (FR-F26-003).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialMode {
    /// The local key never leaves the machine. This is the default and the only
    /// mode available without an explicit choice.
    LocalCredential,
    /// The control plane holds a provider identifier and a fingerprint. Nothing
    /// retrievable. Useful for showing "this workspace uses a key you already
    /// have" without copying it.
    MetadataOnly,
    /// The user explicitly asked for the secret to be copied into the P04
    /// credential store. The secret itself is a `credentials` row; this is only
    /// the mode label.
    OrgManagedCredential,
}

impl CredentialMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalCredential => "local_credential",
            Self::MetadataOnly => "metadata_only",
            Self::OrgManagedCredential => "org_managed_credential",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local_credential" => Some(Self::LocalCredential),
            "metadata_only" => Some(Self::MetadataOnly),
            "org_managed_credential" => Some(Self::OrgManagedCredential),
            _ => None,
        }
    }

    /// Every mode, in the order the wizard offers them. The order is the
    /// escalation order on purpose: the safest option is first and the only one
    /// that copies a secret is last.
    pub const ALL: [Self; 3] = [
        Self::LocalCredential,
        Self::MetadataOnly,
        Self::OrgManagedCredential,
    ];

    /// Whether choosing this mode results in a secret being stored in the cloud.
    /// True only for a mode the user picked on purpose.
    pub const fn copies_a_secret(self) -> bool {
        matches!(self, Self::OrgManagedCredential)
    }
}

/// Domain failure codes. Every one of these is a stable `error.details.reason`;
/// none of them is a message a client has to parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdoptionError {
    /// The requested stage is not the immediate successor of the current one.
    StageNotAdvanceable,
    /// Stage 5 was requested while the platform has not enabled it.
    HistorySyncUnavailable,
    /// Stage 5 was requested while the credential mode is still the local one.
    HistorySyncRequiresManagedCredential,
    /// A managed stage was requested with no bound project or device.
    BindingIncomplete,
    /// `org_managed_credential` was chosen for a workspace no organization
    /// governs, so there would be no organization to own the secret.
    CredentialModeRequiresManaged,
    /// The workspace is already unmanaged.
    AlreadyLocal,
    /// A local workspace reference was malformed or carried path semantics.
    InvalidExternalReference,
    /// A telemetry payload carried a key this contract does not define.
    TelemetryFieldUnknown,
    /// A telemetry payload was oversized.
    TelemetryTooLarge,
    /// An automation-import preview was requested with too many candidates.
    ImportTooLarge,
}

impl AdoptionError {
    /// The stable reason string shared with the web client's remediation copy.
    pub const fn code(self) -> &'static str {
        match self {
            Self::StageNotAdvanceable => "migration_stage_invalid",
            Self::HistorySyncUnavailable => "history_sync_not_available",
            Self::HistorySyncRequiresManagedCredential => {
                "history_sync_requires_managed_credential"
            }
            Self::BindingIncomplete => "binding_incomplete",
            Self::CredentialModeRequiresManaged => "credential_mode_requires_managed",
            Self::AlreadyLocal => "already_local_unmanaged",
            Self::InvalidExternalReference => "external_reference_invalid",
            Self::TelemetryFieldUnknown => "telemetry_field_unknown",
            Self::TelemetryTooLarge => "telemetry_payload_too_large",
            Self::ImportTooLarge => "automation_import_too_large",
        }
    }
}

const MAX_INSTALLATION_ID_LEN: usize = 128;
const MIN_INSTALLATION_ID_LEN: usize = 16;
const MAX_WORKSPACE_KEY_LEN: usize = 256;

/// A validated reference to one local workspace.
///
/// F26-001 asks the cloud to preserve a mapping to existing local identifiers so
/// a user can resume and so support can name the local state. This type is that
/// mapping, and it is deliberately the *whole* of what the cloud is allowed to
/// know about a local workspace: an opaque installation identifier and an opaque
/// workspace key. A filesystem path, a directory listing, or a session body has
/// no representation here, so there is nothing to sanitize later.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWorkspaceRef {
    pub installation_id: String,
    pub workspace_key: String,
}

/// Validate a client-supplied installation/workspace reference.
///
/// Path semantics are refused outright. P03 refuses them for a workspace
/// identity; the same bound is repeated here because this reference is
/// reachable from a different write path, and a local workspace key that leaked
/// an absolute path would put a user's directory layout in the cloud for no
/// benefit.
pub fn external_workspace_ref(
    installation_id: &str,
    workspace_key: &str,
) -> Result<ExternalWorkspaceRef, AdoptionError> {
    let installation = installation_id.trim();
    let workspace = workspace_key.trim();
    let installation_ok = installation.len() >= MIN_INSTALLATION_ID_LEN
        && installation.len() <= MAX_INSTALLATION_ID_LEN
        && !installation.contains('/')
        && !installation.contains('\\')
        && !installation.chars().any(char::is_control);
    let workspace_ok = !workspace.is_empty()
        && workspace.len() <= MAX_WORKSPACE_KEY_LEN
        && !workspace.contains('/')
        && !workspace.contains('\\')
        && !workspace.chars().any(char::is_control);
    if !installation_ok || !workspace_ok {
        return Err(AdoptionError::InvalidExternalReference);
    }
    Ok(ExternalWorkspaceRef {
        installation_id: installation.to_owned(),
        workspace_key: workspace.to_owned(),
    })
}

/// The current adoption state of one local workspace, as far as the domain is
/// concerned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptionState {
    pub stage: AdoptionStage,
    pub ownership: Ownership,
    pub credential_mode: CredentialMode,
    pub bound_project_id: Option<String>,
    pub bound_device_id: Option<String>,
}

impl AdoptionState {
    /// A workspace that has adopted nothing: stage 0, local, no binding, local
    /// credentials. This is also the state a rollback produces, which is why it
    /// is a constructor rather than a struct literal at every call site.
    pub const fn local() -> Self {
        Self {
            stage: AdoptionStage::LocalUnmanaged,
            ownership: Ownership::LocalUnmanaged,
            credential_mode: CredentialMode::LocalCredential,
            bound_project_id: None,
            bound_device_id: None,
        }
    }

    /// A workspace at the enrolled-but-unbound stage, as a device sees it after
    /// enrollment and before the user chooses a project.
    pub const fn enrolled(credential_mode: CredentialMode) -> Self {
        Self {
            stage: AdoptionStage::DeviceEnrolled,
            ownership: Ownership::LocalUnmanaged,
            credential_mode,
            bound_project_id: None,
            bound_device_id: None,
        }
    }

    /// A workspace bound to a project and device, as the migration matrix's
    /// "managed" case looks.
    pub fn bound(project_id: &str, device_id: &str, credential_mode: CredentialMode) -> Self {
        Self {
            stage: AdoptionStage::WorkspaceBound,
            ownership: Ownership::OrgManaged,
            credential_mode,
            bound_project_id: Some(project_id.to_owned()),
            bound_device_id: Some(device_id.to_owned()),
        }
    }
}

/// The result of one explicit, user-initiated stage change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptionChange {
    pub from: AdoptionStage,
    pub to: AdoptionStage,
    pub ownership: Ownership,
    pub credential_mode: CredentialMode,
    /// True when this request moved the workspace backwards. Recorded so an
    /// audit row can distinguish a rollback from an edit.
    pub rolled_back: bool,
}

/// The outcome of a stage request. `Unchanged` is separate from `Applied` so a
/// resumable wizard can re-assert the current step idempotently instead of being
/// told it made a mistake.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StageTransition {
    Applied(AdoptionChange),
    Unchanged(AdoptionStage),
}

/// Advance one workspace to the stage the user explicitly asked for.
///
/// Five rules, in the order they are checked:
///
/// 1. **Backwards is a rollback, not a step.** [`rollback`] is the only way back,
///    and it always lands on `local_unmanaged` rather than on an arbitrary
///    stage.
/// 2. **One step at a time.** A request may only reach the immediate successor.
///    Skipping a stage would let a client claim `managed_policy` for a workspace
///    that was never bound, which is the silent-ownership failure F26-002
///    forbids in a subtler form.
/// 3. **Stage 5 must be enabled.** History sync is a platform switch, not a
///    default.
/// 4. **Managed stages need a complete binding.** A project and a device, or the
///    organization would be governing something it cannot address.
/// 5. **The credential mode must fit the stage.** Stage 5 runs on managed
///    inference, so a workspace that insists on its own key cannot be there; and
///    a managed credential needs a managed workspace to be owned by.
///
/// A request that keeps the stage is a credential-mode change, which the wizard
/// offers as its own step. That case is validated too, so "choose credential
/// mode" cannot pick `org_managed_credential` for an unbound workspace just by
/// leaving the stage where it is. Re-requesting the current stage with the same
/// mode is `Unchanged`, not an error, so a resumed wizard is safe to replay.
pub fn apply_stage(
    current: &AdoptionState,
    requested: AdoptionStage,
    credential_mode: CredentialMode,
    policy: &CompatibilityPolicy,
) -> Result<StageTransition, AdoptionError> {
    if requested.rank() < current.stage.rank() {
        return Err(AdoptionError::StageNotAdvanceable);
    }
    if requested == current.stage {
        credential_mode_permitted(Ownership::for_stage(current.stage), credential_mode)?;
        return Ok(StageTransition::Unchanged(current.stage));
    }
    if current.stage.next() != Some(requested) {
        return Err(AdoptionError::StageNotAdvanceable);
    }
    if requested == AdoptionStage::HistorySync {
        if !policy.history_sync_allowed() {
            return Err(AdoptionError::HistorySyncUnavailable);
        }
        if credential_mode == CredentialMode::LocalCredential {
            return Err(AdoptionError::HistorySyncRequiresManagedCredential);
        }
    }
    if requested.implies_org_ownership()
        && (current.bound_project_id.is_none() || current.bound_device_id.is_none())
    {
        return Err(AdoptionError::BindingIncomplete);
    }
    credential_mode_permitted(Ownership::for_stage(requested), credential_mode)?;

    Ok(StageTransition::Applied(AdoptionChange {
        from: current.stage,
        to: requested,
        ownership: Ownership::for_stage(requested),
        credential_mode,
        rolled_back: false,
    }))
}

/// Return a workspace to unmanaged local operation.
///
/// Always available from every stage, because FR-F26-006 requires a user to be
/// able to leave managed operation when enrollment or policy goes wrong. The
/// result records where the workspace came from, so the cloud keeps the history
/// of the decision while the local state — which the server never owned and
/// never modified — stays exactly as it was.
pub fn rollback(current: &AdoptionState) -> Result<AdoptionChange, AdoptionError> {
    if current.stage == AdoptionStage::LocalUnmanaged {
        return Err(AdoptionError::AlreadyLocal);
    }
    Ok(AdoptionChange {
        from: current.stage,
        to: AdoptionStage::LocalUnmanaged,
        // A rollback also returns the workspace to the local credential mode.
        // Keeping `org_managed_credential` after an unbind would claim the
        // organization still holds a secret for a workspace it no longer governs,
        // which is wrong and unfalsifiable from the local side.
        ownership: Ownership::LocalUnmanaged,
        credential_mode: CredentialMode::LocalCredential,
        rolled_back: true,
    })
}

/// Whether a credential mode may be chosen for a workspace in a given ownership
/// state.
///
/// Choosing a mode is a separate explicit act from advancing a stage, which is
/// why this is its own function: the wizard's "choose credential mode" step must
/// not be able to smuggle in an ownership change, and a mode change must not be
/// able to skip a stage.
pub fn credential_mode_permitted(
    ownership: Ownership,
    mode: CredentialMode,
) -> Result<(), AdoptionError> {
    if mode == CredentialMode::OrgManagedCredential && ownership != Ownership::OrgManaged {
        return Err(AdoptionError::CredentialModeRequiresManaged);
    }
    Ok(())
}

// ===========================================================================
// Telemetry (FR-F26-008)
// ===========================================================================

/// Keys a stage/result report may carry. This list is the whole contract: a key
/// that is not here is rejected, not ignored, so a future client that starts
/// sending prompts fails loudly in its own test suite instead of quietly
/// uploading them.
const TELEMETRY_FIELDS: [&str; 6] = [
    "stage",
    "result",
    "reason_code",
    "protocol_major",
    "policy_schema_version",
    "app_version",
];

/// Bounded size of one telemetry report. Small enough that a report cannot
/// become a content channel, large enough that a reason code and three numbers
/// always fit.
pub const MAX_TELEMETRY_JSON_LEN: usize = 1024;

/// Migration result vocabulary. `declined` is separate from `skipped` on
/// purpose: a user who said no is a different signal from a user who was never
/// asked, and collapsing them would quietly turn a consent decline into a
/// neutral event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TelemetryResult {
    Started,
    Completed,
    Skipped,
    Failed,
    Declined,
    RolledBack,
}

impl TelemetryResult {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Declined => "declined",
            Self::RolledBack => "rolled_back",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "started" => Some(Self::Started),
            "completed" => Some(Self::Completed),
            "skipped" => Some(Self::Skipped),
            "failed" => Some(Self::Failed),
            "declined" => Some(Self::Declined),
            "rolled_back" => Some(Self::RolledBack),
            _ => None,
        }
    }
}

/// A validated stage/result report: stage, result, and an optional
/// closed-vocabulary reason. No content, ever.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelemetryReport {
    pub stage: AdoptionStage,
    pub result: TelemetryResult,
    pub reason_code: Option<String>,
    pub protocol_major: Option<i64>,
    pub policy_schema_version: Option<i64>,
    pub app_version: Option<String>,
}

impl TelemetryReport {
    /// Parse and bound one report.
    ///
    /// Unknown keys are rejected rather than dropped. Silently dropping them
    /// would make this function look safe while a client sent a prompt; rejecting
    /// them means a client that tries is visibly broken, which is the outcome we
    /// want during rollout.
    pub fn parse(raw: &str) -> Result<Self, AdoptionError> {
        if raw.len() > MAX_TELEMETRY_JSON_LEN {
            return Err(AdoptionError::TelemetryTooLarge);
        }
        let value: Value =
            serde_json::from_str(raw).map_err(|_| AdoptionError::TelemetryFieldUnknown)?;
        let object = value
            .as_object()
            .ok_or(AdoptionError::TelemetryFieldUnknown)?;
        for key in object.keys() {
            if !TELEMETRY_FIELDS.contains(&key.as_str()) {
                return Err(AdoptionError::TelemetryFieldUnknown);
            }
        }

        let stage = AdoptionStage::parse(text_field(object.get("stage"))?)
            .ok_or(AdoptionError::TelemetryFieldUnknown)?;
        let result = TelemetryResult::parse(text_field(object.get("result"))?)
            .ok_or(AdoptionError::TelemetryFieldUnknown)?;

        let reason_code = match object.get("reason_code") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                if text.is_empty() || text.len() > 64 || !text.bytes().all(is_reason_byte) {
                    return Err(AdoptionError::TelemetryFieldUnknown);
                }
                Some(text.clone())
            }
            Some(_) => return Err(AdoptionError::TelemetryFieldUnknown),
        };
        let protocol_major = optional_bounded_int(object.get("protocol_major"), 1, 32)?;
        let policy_schema_version =
            optional_bounded_int(object.get("policy_schema_version"), 1, 64)?;
        let app_version = match object.get("app_version") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                if text.is_empty()
                    || text.len() > 32
                    || !text
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
                {
                    return Err(AdoptionError::TelemetryFieldUnknown);
                }
                Some(text.clone())
            }
            Some(_) => return Err(AdoptionError::TelemetryFieldUnknown),
        };

        Ok(Self {
            stage,
            result,
            reason_code,
            protocol_major,
            policy_schema_version,
            app_version,
        })
    }

    /// The stage/result pair, as it is written to telemetry.
    pub const fn pair(&self) -> (AdoptionStage, TelemetryResult) {
        (self.stage, self.result)
    }
}

fn text_field(value: Option<&Value>) -> Result<&str, AdoptionError> {
    value
        .and_then(Value::as_str)
        .ok_or(AdoptionError::TelemetryFieldUnknown)
}

fn optional_bounded_int(
    value: Option<&Value>,
    low: i64,
    high: i64,
) -> Result<Option<i64>, AdoptionError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let parsed = number
                .as_i64()
                .ok_or(AdoptionError::TelemetryFieldUnknown)?;
            if parsed < low || parsed > high {
                return Err(AdoptionError::TelemetryFieldUnknown);
            }
            Ok(Some(parsed))
        }
        Some(_) => Err(AdoptionError::TelemetryFieldUnknown),
    }
}

fn is_reason_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
}

// ===========================================================================
// Automation import (FR-F26-004, P08-INT-05)
// ===========================================================================

/// A bounded preview request. Fifty candidates is generous for a real crontab
/// and small enough that a device cannot use one request as a conflict-report
/// amplifier.
pub const MAX_IMPORT_CANDIDATES: usize = 50;
const MAX_IMPORT_LIST_LEN: usize = 32;
const MAX_IMPORT_ITEM_LEN: usize = 64;

/// One local automation the user is considering importing.
///
/// It is a *description*, not a body: a key, a schedule kind, the capabilities it
/// needs, and the credential mode it would run under. There is no prompt, no
/// command, and no file path, because the control plane's job is to decide
/// whether org policy permits the import — not to receive the automation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationImportCandidate {
    pub local_key: String,
    pub schedule_kind: String,
    pub required_tools: Vec<String>,
    pub required_model_capabilities: Vec<String>,
    pub uses_off_peak: bool,
    pub credential_mode: CredentialMode,
}

/// The org facts an import is judged against. All of them are things the control
/// plane already knows; none of them can be asserted by the importing client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportPolicyContext {
    /// Whether automations may be created in this organization at all.
    pub automations_available: bool,
    pub max_active_automations: i64,
    pub active_automations: i64,
    pub off_peak_available: bool,
    /// The org tool policy. A required tool outside this set is a conflict.
    pub allowed_tools: BTreeSet<String>,
    /// The capabilities org model routes actually provide.
    pub available_model_capabilities: BTreeSet<String>,
    /// FR-F26-004: a workspace that runs on its own local key may only import
    /// automations when org policy still permits the org to carry someone else's
    /// credential. Off by default, and not the client's decision.
    pub local_credential_permitted: bool,
    /// Whether the importing workspace is bound to a project. An automation with
    /// no target project is not importable, because the org cannot schedule work
    /// it cannot address.
    pub workspace_bound: bool,
}

/// Compute what importing these local automations would do, without doing it.
///
/// This function is pure and has no mutating counterpart anywhere in P08, which
/// is the enforcement mechanism for "existing local automations remain untouched
/// until imported": there is no code path in the control plane that can touch a
/// local automation, so the client keeps its own copy until it chooses to create
/// a managed one through P06's ordinary automation route.
pub fn automation_import_preview(
    candidates: &[AutomationImportCandidate],
    context: &ImportPolicyContext,
) -> Result<ImportPreview, AdoptionError> {
    if candidates.len() > MAX_IMPORT_CANDIDATES {
        return Err(AdoptionError::ImportTooLarge);
    }
    // Counted down, not up: the limit is on *managed* automations after import,
    // so a batch that would cross it is blocked at the candidate that would cross
    // it rather than being silently trimmed.
    let mut remaining = context
        .max_active_automations
        .saturating_sub(context.active_automations)
        .max(0);
    let mut items = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let mut conflicts = Vec::new();
        if !context.automations_available {
            conflicts.push(ImportConflict::AutomationNotAvailable);
        }
        if !context.workspace_bound {
            conflicts.push(ImportConflict::WorkspaceUnbound);
        }
        if !context.off_peak_available && candidate.uses_off_peak {
            conflicts.push(ImportConflict::OffPeakNotEntitled);
        }
        if !context.local_credential_permitted
            && candidate.credential_mode == CredentialMode::LocalCredential
        {
            conflicts.push(ImportConflict::LocalCredentialNotPermitted);
        }
        for tool in &candidate.required_tools {
            if !context.allowed_tools.contains(tool) {
                conflicts.push(ImportConflict::ToolNotPermitted(tool.clone()));
            }
        }
        for capability in &candidate.required_model_capabilities {
            if !context.available_model_capabilities.contains(capability) {
                conflicts.push(ImportConflict::ModelCapabilityUnavailable(
                    capability.clone(),
                ));
            }
        }
        if conflicts.is_empty() {
            if remaining > 0 {
                remaining -= 1;
            } else {
                conflicts.push(ImportConflict::AutomationLimitReached);
            }
        }
        conflicts.sort_by(|left, right| conflict_sort_key(left).cmp(&conflict_sort_key(right)));
        items.push(ImportPreviewItem {
            local_key: candidate.local_key.clone(),
            conflicts,
        });
    }
    Ok(ImportPreview { items })
}

fn conflict_sort_key(conflict: &ImportConflict) -> (&'static str, &str) {
    (conflict.code(), conflict.subject().unwrap_or(""))
}

/// Why one candidate cannot be imported as described.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportConflict {
    /// The organization has no automations capability.
    AutomationNotAvailable,
    /// The organization is already at `max_active_automations`. An import must
    /// never drop an existing managed automation to make room.
    AutomationLimitReached,
    /// A required tool is not permitted by the org tool policy. F26-004 requires
    /// the conflict to be shown before import, not enforced afterwards.
    ToolNotPermitted(String),
    /// No org model route provides a required capability.
    ModelCapabilityUnavailable(String),
    /// The automation uses off-peak execution and the org is not entitled to it.
    OffPeakNotEntitled,
    /// The workspace is not bound to a project.
    WorkspaceUnbound,
    /// The local automation depends on a local credential the org may not use.
    LocalCredentialNotPermitted,
}

impl ImportConflict {
    /// The stable reason string. `ImportConflict` deliberately has no `Display`:
    /// a conflict is machine-readable, and the copy belongs to the client so it
    /// can be localized.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::AutomationNotAvailable => "automation_not_available",
            Self::AutomationLimitReached => "automation_limit_reached",
            Self::ToolNotPermitted(_) => "tool_not_permitted",
            Self::ModelCapabilityUnavailable(_) => "model_capability_unavailable",
            Self::OffPeakNotEntitled => "off_peak_not_entitled",
            Self::WorkspaceUnbound => "workspace_unbound",
            Self::LocalCredentialNotPermitted => "local_credential_not_permitted",
        }
    }

    /// The subject of a parameterized conflict: the tool or capability name, or
    /// `None` for a whole-automation conflict. Returned separately so the subject
    /// is the only free-form part.
    pub fn subject(&self) -> Option<&str> {
        match self {
            Self::ToolNotPermitted(name) | Self::ModelCapabilityUnavailable(name) => Some(name),
            _ => None,
        }
    }
}

/// One candidate's verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportPreviewItem {
    pub local_key: String,
    pub conflicts: Vec<ImportConflict>,
}

impl ImportPreviewItem {
    /// A candidate with no conflicts is importable. Every other candidate is
    /// reported as blocked rather than partially imported, because half an
    /// automation with a silently changed tool requirement is worse than an
    /// automation the user chose not to import.
    pub const fn is_importable(&self) -> bool {
        self.conflicts.is_empty()
    }
}

/// The full preview.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportPreview {
    pub items: Vec<ImportPreviewItem>,
}

impl ImportPreview {
    pub fn importable_count(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.is_importable())
            .count()
    }

    pub fn blocked_count(&self) -> usize {
        self.items.len() - self.importable_count()
    }

    /// Whether the whole batch may be committed. One blocked candidate blocks the
    /// batch: a user who confirms an import expects the set they previewed.
    pub fn is_commit_ready(&self) -> bool {
        self.blocked_count() == 0
    }
}

/// Bound one candidate's fields, so an oversized import is refused with the same
/// vocabulary from every layer.
pub fn validate_candidate(candidate: &AutomationImportCandidate) -> Result<(), AdoptionError> {
    let key_ok = is_opaque_name(&candidate.local_key);
    let schedule_ok = matches!(
        candidate.schedule_kind.as_str(),
        "one_time" | "cron" | "interval" | "manual"
    );
    let lists_bounded = candidate.required_tools.len() <= MAX_IMPORT_LIST_LEN
        && candidate.required_model_capabilities.len() <= MAX_IMPORT_LIST_LEN;
    let items_ok = candidate
        .required_tools
        .iter()
        .chain(candidate.required_model_capabilities.iter())
        .all(|value| is_opaque_name(value));
    if key_ok && schedule_ok && lists_bounded && items_ok {
        Ok(())
    } else {
        Err(AdoptionError::InvalidExternalReference)
    }
}

fn is_opaque_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IMPORT_ITEM_LEN
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.'
        })
}

// ===========================================================================
// Remediation (P08-FE-02)
// ===========================================================================

/// What an operator can be told is wrong, plus the protocol case that is a
/// precondition for all of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RemediationCode {
    /// The client build is below what managed operation requires.
    ClientOutdated,
    /// The client is on a protocol this control plane cannot speak.
    ProtocolUnsupported,
    /// The device has not acknowledged the current policy snapshot.
    PolicySyncFailed,
    /// A managed workspace still has only its local credential.
    CredentialMissing,
    /// The org tool policy forbids something this client needs.
    CapabilityUnsupported,
    /// The workspace is enrolled but not mapped to a project.
    WorkspaceUnbound,
}

impl RemediationCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClientOutdated => "client_outdated",
            Self::ProtocolUnsupported => "protocol_unsupported",
            Self::PolicySyncFailed => "policy_sync_failed",
            Self::CredentialMissing => "credential_missing",
            Self::CapabilityUnsupported => "capability_unsupported",
            Self::WorkspaceUnbound => "workspace_unbound",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "client_outdated" => Some(Self::ClientOutdated),
            "protocol_unsupported" => Some(Self::ProtocolUnsupported),
            "policy_sync_failed" => Some(Self::PolicySyncFailed),
            "credential_missing" => Some(Self::CredentialMissing),
            "capability_unsupported" => Some(Self::CapabilityUnsupported),
            "workspace_unbound" => Some(Self::WorkspaceUnbound),
            _ => None,
        }
    }

    /// Every code, in the order an operator should see them. A device that is
    /// too old is listed above a device whose policy failed to sync, because
    /// fixing the build usually fixes the policy too.
    pub const ALL: [Self; 6] = [
        Self::ClientOutdated,
        Self::ProtocolUnsupported,
        Self::PolicySyncFailed,
        Self::CredentialMissing,
        Self::CapabilityUnsupported,
        Self::WorkspaceUnbound,
    ];
}

/// The single action an operator can suggest. Deliberately a closed set: there is
/// no "custom message", because a remediation is a pointer to a decision the
/// user already has to make, not a place for the platform to explain itself in
/// free text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Remedy {
    UpgradeClient,
    ReconnectDevice,
    RebindWorkspace,
    ChooseCredentialMode,
    ReviewToolPolicy,
    Dismiss,
}

impl Remedy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UpgradeClient => "upgrade_client",
            Self::ReconnectDevice => "reconnect_device",
            Self::RebindWorkspace => "rebind_workspace",
            Self::ChooseCredentialMode => "choose_credential_mode",
            Self::ReviewToolPolicy => "review_tool_policy",
            Self::Dismiss => "dismiss",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "upgrade_client" => Some(Self::UpgradeClient),
            "reconnect_device" => Some(Self::ReconnectDevice),
            "rebind_workspace" => Some(Self::RebindWorkspace),
            "choose_credential_mode" => Some(Self::ChooseCredentialMode),
            "review_tool_policy" => Some(Self::ReviewToolPolicy),
            "dismiss" => Some(Self::Dismiss),
            _ => None,
        }
    }
}

/// The single action that resolves a code.
pub const fn default_remedy(code: RemediationCode) -> Remedy {
    match code {
        RemediationCode::ClientOutdated | RemediationCode::ProtocolUnsupported => {
            Remedy::UpgradeClient
        }
        RemediationCode::PolicySyncFailed => Remedy::ReconnectDevice,
        RemediationCode::CredentialMissing => Remedy::ChooseCredentialMode,
        RemediationCode::CapabilityUnsupported => Remedy::ReviewToolPolicy,
        RemediationCode::WorkspaceUnbound => Remedy::RebindWorkspace,
    }
}

/// The facts remediation is derived from. Every field is something the control
/// plane already knows; none of them is something the client asserts about its
/// own health.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrationObservation {
    /// Whether this workspace has any cloud state at all. A local-only
    /// workspace is never remediated.
    pub adopted: bool,
    /// Whether this workspace is org-managed. An enrolled-but-unmanaged
    /// workspace is told only about its client and policy facts.
    pub client_managed: bool,
    pub client_build_current: bool,
    pub policy_acknowledged: bool,
    pub credential_mode: CredentialMode,
    pub required_capabilities_permitted: bool,
    pub project_bound: bool,
}

/// One open remediation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remediation {
    pub code: RemediationCode,
    pub remedy: Remedy,
}

/// Derive the open remediations for one observed workspace.
///
/// A local-only workspace produces nothing, and an enrolled-but-unmanaged
/// workspace produces only its client and policy facts. Both are deliberate:
/// doing nothing is a supported state, so inventing a problem for it would make
/// P08 feel like nagging rather than migration, and telling someone they have a
/// credential problem before they asked for a credential would be inventing one
/// too. The result is deduplicated and in the frozen operator order, so the web
/// client can pin the rendering.
pub fn derive_remediations(observation: &MigrationObservation) -> Vec<Remediation> {
    if !observation.adopted {
        return Vec::new();
    }
    let mut codes = Vec::new();
    if !observation.client_build_current {
        codes.push(RemediationCode::ClientOutdated);
    }
    if !observation.policy_acknowledged {
        codes.push(RemediationCode::PolicySyncFailed);
    }
    if observation.client_managed {
        if observation.credential_mode == CredentialMode::LocalCredential {
            codes.push(RemediationCode::CredentialMissing);
        }
        if !observation.required_capabilities_permitted {
            codes.push(RemediationCode::CapabilityUnsupported);
        }
        if !observation.project_bound {
            codes.push(RemediationCode::WorkspaceUnbound);
        }
    }
    codes.sort_unstable();
    codes.dedup();
    codes
        .into_iter()
        .map(|code| Remediation {
            code,
            remedy: default_remedy(code),
        })
        .collect()
}
