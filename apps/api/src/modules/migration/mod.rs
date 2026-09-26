//! P08 migration and adoption domain.
//!
//! Everything an existing local ZCode/Lumi Agents user has to decide about the
//! control plane is decided here, with no database, no HTTP, and no clock, so the
//! rules can be read and tested in one place:
//!
//! ```text
//! local_unmanaged → account_optional → device_enrolled
//!                → workspace_bound   → managed_policy → history_sync
//! ```
//!
//! Two properties are the reason this is a domain module rather than route
//! logic, and every function below exists to make one of them unbreakable:
//!
//! 1. **No silent ownership conversion (FR-F26-002).** Signing in, enrolling a
//!    device, or refreshing a token never changes a workspace's owner.
//!    [`Ownership`] is derivable from a stage a user explicitly asked for, and
//!    [`apply_stage`] is the only function that can change a stage at all.
//! 2. **Reversibility (FR-F26-006).** Every stage can be rolled back to
//!    `local_unmanaged`, the rollback is recorded rather than deleted, and no
//!    function in this module takes a path, a file, a prompt, or a secret.
//!
//! [`compatibility`] answers the question a local client must be able to ask
//! before it has an account at all: may I run, and if not, may I at least keep
//! running locally? The answer is a closed vocabulary, never an exception the
//! client has to interpret.

pub mod adoption;
pub mod compatibility;

#[cfg(test)]
mod tests;

pub use adoption::{
    AdoptionChange, AdoptionError, AdoptionStage, AdoptionState, AutomationImportCandidate,
    CredentialMode, ExternalWorkspaceRef, ImportConflict, ImportPolicyContext, ImportPreview,
    ImportPreviewItem, MAX_IMPORT_CANDIDATES, MAX_TELEMETRY_JSON_LEN, MigrationObservation,
    Ownership, Remediation, RemediationCode, Remedy, StageTransition, TelemetryReport,
    TelemetryResult, apply_stage, automation_import_preview, credential_mode_permitted,
    default_remedy, derive_remediations, external_workspace_ref, rollback, validate_candidate,
};
pub use compatibility::{
    CONTRACT_VERSION, ClientCompatibility, ClientFingerprint, CompatibilityPolicy,
    CompatibilityRanges, CompatibilityVerdict, DegradedMode, InvalidFingerprint,
    MIN_CLIENT_APP_VERSION, SUPPORTED_CLIENT_PROTOCOLS, SUPPORTED_POLICY_SCHEMA_VERSIONS,
    baseline_matches_seed,
};
