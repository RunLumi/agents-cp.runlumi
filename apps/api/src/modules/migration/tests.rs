//! P08 domain tests.
//!
//! The emphasis is on the guarantees a migrating user depends on, not on line
//! coverage. The invariants below are the ones that make adoption reversible and
//! private:
//!
//! - a local workspace cannot become org-owned without an explicit step, and no
//!   step may skip a stage;
//! - a rollback is available from every stage and always lands on
//!   `local_unmanaged` with a local credential;
//! - an unsupported client keeps local-only operation, always;
//! - history sync is unavailable until the platform enables it AND the
//!   credential mode is not local;
//! - telemetry cannot carry user content, in any field, ever;
//! - an automation import preview is a preview: it blocks what org policy
//!   forbids and never silently trims a batch.

use std::collections::BTreeSet;

use super::adoption::*;
use super::compatibility::*;

const PROJECT: &str = "prj_0123456789abcdef0123456789abcdef";
const DEVICE: &str = "dvc_0123456789abcdef0123456789abcdef";

fn policy_with_history_sync() -> CompatibilityPolicy {
    CompatibilityPolicy {
        history_sync_eligible: true,
        ..CompatibilityPolicy::baseline()
    }
}

fn fingerprint(protocol: i64, schema: i64) -> ClientFingerprint {
    ClientFingerprint {
        protocol_major: protocol,
        policy_schema_version: schema,
        app_version: String::from("0.4.0"),
    }
}

// ===========================================================================
// Compatibility
// ===========================================================================

#[test]
fn the_compiled_baseline_matches_the_seeded_compatibility_row() {
    // If these drift, a client that reached the control plane while storage was
    // unavailable is told a different compatibility answer than the same client
    // gets normally.
    assert!(baseline_matches_seed());
    assert_eq!(CompatibilityPolicy::baseline().protocol_major, 1);
    assert!(!CompatibilityPolicy::baseline().history_sync_allowed());
}

#[test]
fn a_current_client_is_managed_and_a_degraded_client_is_local_only() {
    let policy = CompatibilityPolicy::baseline();
    let verdict = policy.evaluate(&ClientFingerprint::new(1, 1, "0.4.0").unwrap());
    assert_eq!(verdict.state, ClientCompatibility::Supported);
    assert!(verdict.managed_allowed());
    assert_eq!(verdict.mode(), DegradedMode::Managed);
    assert_eq!(verdict.reason(), None);

    for (protocol, schema, expected) in [
        (2, 1, ClientCompatibility::UnsupportedProtocol),
        (1, 2, ClientCompatibility::UnsupportedPolicySchema),
    ] {
        let client = ClientFingerprint::new(protocol, schema, "0.4.0").unwrap();
        let verdict = policy.evaluate(&client);
        assert_eq!(
            verdict.state, expected,
            "protocol {protocol} schema {schema}"
        );
        assert!(!verdict.managed_allowed());
        assert_eq!(verdict.mode(), DegradedMode::LocalOnly);
        assert!(verdict.reason().is_some());
    }
    // The two degradations are fixed in different ways, and the client needs to be
    // told which: an incompatible protocol needs a different build, while an
    // unhonoured policy only needs a fresh snapshot.
    assert_eq!(
        policy.evaluate(&fingerprint(2, 1)).min_app_version(),
        Some(MIN_CLIENT_APP_VERSION)
    );
    assert_eq!(policy.evaluate(&fingerprint(1, 2)).min_app_version(), None);
    assert_eq!(
        policy.evaluate(&fingerprint(1, 2)).reason(),
        Some("policy_schema_unsupported")
    );
}

#[test]
fn a_value_below_the_supported_range_is_upgrade_required_not_silently_accepted() {
    // Built by field rather than through the constructor, because a zero is
    // exactly what a hand-edited or migrated row can contain and the evaluator
    // has to fail closed on a value the transport would have refused.
    let policy = CompatibilityPolicy::baseline();
    for client in [fingerprint(0, 1), fingerprint(1, 0)] {
        let verdict = policy.evaluate(&client);
        assert_eq!(verdict.state, ClientCompatibility::UpgradeRequired);
        assert!(!verdict.managed_allowed());
        assert_eq!(verdict.mode(), DegradedMode::LocalOnly);
        assert_eq!(verdict.reason(), Some("client_upgrade_required"));
    }
}

#[test]
fn an_unsupported_client_always_keeps_local_only_operation() {
    // F26 stage 0 is a guarantee, not a setting. Every verdict, including a
    // protocol this control plane cannot speak, leaves local-only available — and
    // nothing in the policy can revoke it, which is why the method is not derived
    // from the verdict.
    let policy = CompatibilityPolicy::baseline();
    for protocol in 1..=8 {
        for schema in 1..=8 {
            let verdict = policy.evaluate(&fingerprint(protocol, schema));
            assert!(
                verdict.local_only_available(),
                "protocol {protocol} schema {schema} lost local-only"
            );
        }
    }
    // Even a policy that declares local-only unavailable cannot take it away, so
    // the guarantee does not depend on a stored flag.
    let withdrawn = CompatibilityPolicy {
        local_only_eligible: false,
        ..CompatibilityPolicy::baseline()
    };
    assert!(
        withdrawn
            .evaluate(&fingerprint(9, 1))
            .local_only_available()
    );
}

#[test]
fn a_degraded_client_never_obtains_managed_authority() {
    // Enrollment, device tokens, policy fetch, binding, and import are all
    // managed operations, so a client the control plane cannot evaluate cannot be
    // adopted by accident.
    let policy = CompatibilityPolicy::baseline();
    for client in [fingerprint(2, 1), fingerprint(0, 1), fingerprint(1, 5)] {
        assert!(!policy.evaluate(&client).managed_allowed());
    }
}

#[test]
fn a_malformed_client_fingerprint_is_refused_rather_than_clamped() {
    for (protocol, schema, version) in [
        (0, 1, "0.4.0"),
        (33, 1, "0.4.0"),
        (1, 0, "0.4.0"),
        (1, 65, "0.4.0"),
        (1, 1, ""),
        (1, 1, "0.4.0-beta"),
        (1, 1, "0.4.0 1"),
    ] {
        assert!(
            ClientFingerprint::new(protocol, schema, version).is_err(),
            "accepted protocol {protocol} schema {schema} version {version}"
        );
    }
    assert!(ClientFingerprint::new(1, 1, &"x".repeat(40)).is_err());
    assert!(ClientFingerprint::new(1, 1, "0.4.0").is_ok());
}

#[test]
fn an_inverted_stored_range_can_only_narrow_managed_access() {
    // A corrupted or hand-edited row must never be the reason a client gains
    // managed access.
    let policy = CompatibilityPolicy {
        min_protocol_major: 9,
        max_protocol_major: 2,
        min_policy_schema_version: 9,
        max_policy_schema_version: 2,
        ..CompatibilityPolicy::baseline()
    };
    for protocol in 1..=12 {
        assert!(
            !policy.evaluate(&fingerprint(protocol, 1)).managed_allowed(),
            "granted to protocol {protocol}"
        );
    }
}

#[test]
fn the_reported_ranges_match_the_frozen_constants() {
    let ranges = CompatibilityRanges::from_policy(&CompatibilityPolicy::baseline());
    assert_eq!(ranges.contract_version, CONTRACT_VERSION);
    assert_eq!(ranges.supported_protocols, &SUPPORTED_CLIENT_PROTOCOLS);
    assert_eq!(
        ranges.supported_policy_schema_versions,
        &SUPPORTED_POLICY_SCHEMA_VERSIONS
    );
    assert_eq!(ranges.min_client_app_version, MIN_CLIENT_APP_VERSION);
    assert!(ranges.local_only_eligible);
    assert!(!ranges.history_sync_eligible);
}

// ===========================================================================
// Stage vocabulary
// ===========================================================================

#[test]
fn the_stage_vocabulary_round_trips_and_is_totally_ordered() {
    assert_eq!(AdoptionStage::ALL.len(), 6);
    for (index, stage) in AdoptionStage::ALL.iter().enumerate() {
        assert_eq!(stage.rank() as usize, index, "{stage:?} is out of order");
        assert_eq!(AdoptionStage::parse(stage.as_str()), Some(*stage));
    }
    assert_eq!(AdoptionStage::parse("stage_3"), None);
    assert_eq!(AdoptionStage::parse(""), None);
    assert_eq!(
        AdoptionStage::LocalUnmanaged.next(),
        Some(AdoptionStage::AccountOptional)
    );
    assert_eq!(AdoptionStage::HistorySync.next(), None);
}

#[test]
fn org_ownership_starts_at_the_explicit_binding_stage() {
    // FR-F26-002: stages 0-2 are "the cloud knows about it"; stage 3 is "the
    // cloud governs it". Crossing that line any earlier is the silent conversion
    // the spec forbids.
    assert!(!AdoptionStage::LocalUnmanaged.implies_org_ownership());
    assert!(!AdoptionStage::AccountOptional.implies_org_ownership());
    assert!(!AdoptionStage::DeviceEnrolled.implies_org_ownership());
    assert!(AdoptionStage::WorkspaceBound.implies_org_ownership());
    assert!(AdoptionStage::ManagedPolicy.implies_org_ownership());
    assert!(AdoptionStage::HistorySync.implies_org_ownership());

    for stage in AdoptionStage::ALL {
        let derived = Ownership::for_stage(stage);
        assert_eq!(Ownership::parse(derived.as_str()), Some(derived));
        assert_eq!(
            derived,
            if stage.implies_org_ownership() {
                Ownership::OrgManaged
            } else {
                Ownership::LocalUnmanaged
            }
        );
    }
    assert_eq!(Ownership::parse("owned_by_someone"), None);
}

// ===========================================================================
// Stage transitions
// ===========================================================================

#[test]
fn a_workspace_advances_one_explicit_stage_at_a_time() {
    let policy = CompatibilityPolicy::baseline();
    let change = match apply_stage(
        &AdoptionState::local(),
        AdoptionStage::AccountOptional,
        CredentialMode::LocalCredential,
        &policy,
    )
    .unwrap()
    {
        StageTransition::Applied(change) => change,
        StageTransition::Unchanged(stage) => panic!("expected an applied step, got {stage:?}"),
    };
    assert_eq!(change.from, AdoptionStage::LocalUnmanaged);
    assert_eq!(change.to, AdoptionStage::AccountOptional);
    assert_eq!(change.ownership, Ownership::LocalUnmanaged);
    assert_eq!(change.credential_mode, CredentialMode::LocalCredential);
    assert!(!change.rolled_back);
}

#[test]
fn no_stage_can_be_skipped() {
    // Skipping would let a client claim `managed_policy` for a workspace that was
    // never bound, which is the silent-ownership failure in a subtler form.
    let policy = CompatibilityPolicy::baseline();
    for from in AdoptionStage::ALL {
        for requested in AdoptionStage::ALL {
            if requested.rank() <= from.rank() || requested.rank() == from.rank() + 1 {
                continue;
            }
            let mut state = AdoptionState::local();
            state.stage = from;
            assert_eq!(
                apply_stage(&state, requested, CredentialMode::MetadataOnly, &policy),
                Err(AdoptionError::StageNotAdvanceable),
                "{from:?} -> {requested:?} must not be allowed"
            );
        }
    }
}

#[test]
fn a_stage_can_never_be_reached_by_stepping_backwards() {
    // The only way back is `rollback`, which always lands on stage 0.
    let policy = policy_with_history_sync();
    for from in AdoptionStage::ALL {
        for requested in AdoptionStage::ALL {
            if requested.rank() >= from.rank() {
                continue;
            }
            let mut state = AdoptionState::local();
            state.stage = from;
            assert_eq!(
                apply_stage(&state, requested, CredentialMode::MetadataOnly, &policy),
                Err(AdoptionError::StageNotAdvanceable),
                "{from:?} -> {requested:?} must not be a step"
            );
        }
    }
}

#[test]
fn re_requesting_the_current_stage_is_unchanged_not_an_error() {
    // A resumable wizard re-asserts the step it is on. Telling the user they made
    // a mistake there would be a bug report waiting to happen.
    let policy = CompatibilityPolicy::baseline();
    for stage in AdoptionStage::ALL {
        for mode in CredentialMode::ALL {
            let mut state = AdoptionState::local();
            state.stage = stage;
            state.ownership = Ownership::for_stage(stage);
            let outcome = apply_stage(&state, stage, mode, &policy);
            if stage.implies_org_ownership() || mode != CredentialMode::OrgManagedCredential {
                assert_eq!(outcome, Ok(StageTransition::Unchanged(stage)));
            } else {
                assert_eq!(outcome, Err(AdoptionError::CredentialModeRequiresManaged));
            }
        }
    }
}

#[test]
fn a_managed_stage_requires_a_complete_binding() {
    // Without a project and a device the organization would be governing
    // something it cannot address.
    let policy = CompatibilityPolicy::baseline();
    for missing in ["project", "device"] {
        let mut state = AdoptionState::enrolled(CredentialMode::MetadataOnly);
        if missing == "project" {
            state.bound_project_id = Some(String::from(PROJECT));
        } else {
            state.bound_device_id = Some(String::from(DEVICE));
        }
        assert_eq!(
            apply_stage(
                &state,
                AdoptionStage::WorkspaceBound,
                CredentialMode::MetadataOnly,
                &policy
            ),
            Err(AdoptionError::BindingIncomplete),
            "missing {missing} was accepted"
        );
    }
    // A complete binding is accepted.
    let complete = AdoptionState {
        bound_project_id: Some(String::from(PROJECT)),
        bound_device_id: Some(String::from(DEVICE)),
        ..AdoptionState::enrolled(CredentialMode::MetadataOnly)
    };
    assert!(
        apply_stage(
            &complete,
            AdoptionStage::WorkspaceBound,
            CredentialMode::MetadataOnly,
            &policy
        )
        .is_ok()
    );
}

#[test]
fn history_sync_is_refused_until_the_platform_enables_it() {
    let mut state = AdoptionState::bound(PROJECT, DEVICE, CredentialMode::MetadataOnly);
    state.stage = AdoptionStage::ManagedPolicy;
    assert_eq!(
        apply_stage(
            &state,
            AdoptionStage::HistorySync,
            CredentialMode::MetadataOnly,
            &CompatibilityPolicy::baseline()
        ),
        Err(AdoptionError::HistorySyncUnavailable)
    );
    assert!(
        apply_stage(
            &state,
            AdoptionStage::HistorySync,
            CredentialMode::MetadataOnly,
            &policy_with_history_sync()
        )
        .is_ok()
    );
}

#[test]
fn history_sync_is_refused_while_the_credential_is_still_local() {
    // Stage 5 runs on managed inference. A workspace that insists on its own key
    // has not opted into it, whatever the platform flag says.
    let mut state = AdoptionState::bound(PROJECT, DEVICE, CredentialMode::LocalCredential);
    state.stage = AdoptionStage::ManagedPolicy;
    let policy = policy_with_history_sync();
    assert_eq!(
        apply_stage(
            &state,
            AdoptionStage::HistorySync,
            CredentialMode::LocalCredential,
            &policy
        ),
        Err(AdoptionError::HistorySyncRequiresManagedCredential)
    );
    for mode in [
        CredentialMode::MetadataOnly,
        CredentialMode::OrgManagedCredential,
    ] {
        assert!(apply_stage(&state, AdoptionStage::HistorySync, mode, &policy).is_ok());
    }
}

#[test]
fn an_org_managed_credential_cannot_be_chosen_before_a_workspace_is_bound() {
    // Including by leaving the stage alone: "choose credential mode" is its own
    // wizard step and must not be a way to attach an org secret to a workspace no
    // organization governs.
    let policy = CompatibilityPolicy::baseline();
    let state = AdoptionState::enrolled(CredentialMode::MetadataOnly);
    assert_eq!(
        apply_stage(
            &state,
            AdoptionStage::DeviceEnrolled,
            CredentialMode::OrgManagedCredential,
            &policy
        ),
        Err(AdoptionError::CredentialModeRequiresManaged)
    );
    assert_eq!(
        apply_stage(
            &state,
            AdoptionStage::AccountOptional,
            CredentialMode::OrgManagedCredential,
            &policy
        ),
        Err(AdoptionError::StageNotAdvanceable),
        "a backwards request is a rollback, not a step, even with a bad mode"
    );
    assert_eq!(
        credential_mode_permitted(
            Ownership::LocalUnmanaged,
            CredentialMode::OrgManagedCredential
        ),
        Err(AdoptionError::CredentialModeRequiresManaged)
    );
    assert!(
        credential_mode_permitted(Ownership::OrgManaged, CredentialMode::OrgManagedCredential)
            .is_ok()
    );
    assert!(
        credential_mode_permitted(Ownership::LocalUnmanaged, CredentialMode::LocalCredential)
            .is_ok()
    );
    assert!(
        credential_mode_permitted(Ownership::LocalUnmanaged, CredentialMode::MetadataOnly).is_ok()
    );
}

#[test]
fn only_the_explicit_choice_copies_a_secret() {
    assert!(!CredentialMode::LocalCredential.copies_a_secret());
    assert!(!CredentialMode::MetadataOnly.copies_a_secret());
    assert!(CredentialMode::OrgManagedCredential.copies_a_secret());
    for mode in CredentialMode::ALL {
        assert_eq!(CredentialMode::parse(mode.as_str()), Some(mode));
    }
    assert_eq!(CredentialMode::parse("send_us_your_key"), None);
}

#[test]
fn the_full_staged_adoption_path_is_walkable_end_to_end() {
    // The path F26 requires, in order, with the credential choice made at the
    // end and never before.
    let policy = policy_with_history_sync();
    let mut state = AdoptionState::local();

    for stage in [
        AdoptionStage::AccountOptional,
        AdoptionStage::DeviceEnrolled,
    ] {
        let change = match apply_stage(&state, stage, CredentialMode::LocalCredential, &policy)
            .unwrap_or_else(|error| panic!("{stage:?} must be reachable: {}", error.code()))
        {
            StageTransition::Applied(change) => change,
            StageTransition::Unchanged(reached) => {
                panic!("expected {stage:?}, still at {reached:?}")
            }
        };
        state.stage = change.to;
        state.ownership = change.ownership;
        assert_eq!(state.ownership, Ownership::LocalUnmanaged, "{stage:?}");
    }

    // Binding is the moment a project and a device become part of the record.
    state.bound_project_id = Some(String::from(PROJECT));
    state.bound_device_id = Some(String::from(DEVICE));
    for (stage, mode) in [
        (
            AdoptionStage::WorkspaceBound,
            CredentialMode::LocalCredential,
        ),
        (
            AdoptionStage::ManagedPolicy,
            CredentialMode::LocalCredential,
        ),
        (AdoptionStage::HistorySync, CredentialMode::MetadataOnly),
    ] {
        let change = match apply_stage(&state, stage, mode, &policy)
            .unwrap_or_else(|error| panic!("{stage:?} must be reachable: {}", error.code()))
        {
            StageTransition::Applied(change) => change,
            StageTransition::Unchanged(reached) => {
                panic!("expected {stage:?}, still at {reached:?}")
            }
        };
        state.stage = change.to;
        state.ownership = change.ownership;
        state.credential_mode = change.credential_mode;
    }
    assert_eq!(state.stage, AdoptionStage::HistorySync);
    assert_eq!(state.ownership, Ownership::OrgManaged);

    // And the whole thing is reversible in one step, back to stage 0.
    let change = rollback(&state).unwrap();
    assert_eq!(change.to, AdoptionStage::LocalUnmanaged);
    assert_eq!(change.ownership, Ownership::LocalUnmanaged);
    assert_eq!(change.credential_mode, CredentialMode::LocalCredential);
}

#[test]
fn a_rollback_is_reachable_from_every_stage_and_never_from_stage_zero() {
    for stage in [
        AdoptionStage::AccountOptional,
        AdoptionStage::DeviceEnrolled,
        AdoptionStage::WorkspaceBound,
        AdoptionStage::ManagedPolicy,
        AdoptionStage::HistorySync,
    ] {
        let mut state = AdoptionState::local();
        state.stage = stage;
        state.ownership = Ownership::for_stage(stage);
        let change = rollback(&state)
            .unwrap_or_else(|error| panic!("{stage:?} could not roll back: {}", error.code()));
        assert_eq!(change.to, AdoptionStage::LocalUnmanaged);
        assert_eq!(change.ownership, Ownership::LocalUnmanaged);
        assert_eq!(change.from, stage);
        assert!(change.rolled_back);
    }
    assert_eq!(
        rollback(&AdoptionState::local()),
        Err(AdoptionError::AlreadyLocal)
    );
}

#[test]
fn a_rollback_returns_the_local_credential_mode() {
    // Keeping `org_managed_credential` after an unbind would claim the
    // organization still holds a secret for a workspace it no longer governs.
    let state = AdoptionState::bound(PROJECT, DEVICE, CredentialMode::OrgManagedCredential);
    let change = rollback(&state).unwrap();
    assert_eq!(change.credential_mode, CredentialMode::LocalCredential);
}

// ===========================================================================
// External references (FR-F26-001, privacy)
// ===========================================================================

#[test]
fn a_local_workspace_reference_carries_no_path() {
    let reference = external_workspace_ref("  0123456789abcdef-installation  ", "ws-alpha")
        .expect("an opaque reference is accepted");
    assert_eq!(reference.installation_id, "0123456789abcdef-installation");
    assert_eq!(reference.workspace_key, "ws-alpha");

    for (installation, workspace) in [
        ("/Users/someone/code", "ws"),
        ("C:\\Users\\someone", "ws"),
        ("short", "ws"),
        (&"x".repeat(200), "ws"),
        ("0123456789abcdef-installation", "/Users/someone/code"),
        ("0123456789abcdef-installation", ""),
        ("0123456789abcdef-installation", "ws\nwith-newline"),
    ] {
        assert_eq!(
            external_workspace_ref(installation, workspace),
            Err(AdoptionError::InvalidExternalReference),
            "accepted {installation} / {workspace}"
        );
    }
}

#[test]
fn every_domain_failure_has_a_stable_reason_string() {
    for error in [
        AdoptionError::StageNotAdvanceable,
        AdoptionError::HistorySyncUnavailable,
        AdoptionError::HistorySyncRequiresManagedCredential,
        AdoptionError::BindingIncomplete,
        AdoptionError::CredentialModeRequiresManaged,
        AdoptionError::AlreadyLocal,
        AdoptionError::InvalidExternalReference,
        AdoptionError::TelemetryFieldUnknown,
        AdoptionError::TelemetryTooLarge,
        AdoptionError::ImportTooLarge,
    ] {
        let code = error.code();
        assert!(!code.is_empty());
        assert!(
            code.bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'),
            "{code} is not snake_case"
        );
    }
}

// ===========================================================================
// Telemetry (FR-F26-008)
// ===========================================================================

#[test]
fn telemetry_carries_stage_and_result_only() {
    let report = TelemetryReport::parse(
        r#"{"stage":"workspace_bound","result":"completed","reason_code":"consent_required","protocol_major":1,"policy_schema_version":1,"app_version":"0.4.0"}"#,
    )
    .unwrap();
    assert_eq!(
        report.pair(),
        (AdoptionStage::WorkspaceBound, TelemetryResult::Completed)
    );
    assert_eq!(report.reason_code.as_deref(), Some("consent_required"));
    assert_eq!(report.protocol_major, Some(1));
    assert_eq!(report.policy_schema_version, Some(1));
    assert_eq!(report.app_version.as_deref(), Some("0.4.0"));
}

#[test]
fn telemetry_refuses_anything_that_could_carry_user_content() {
    // The point of the closed field list: there is no key through which a prompt,
    // a file, a path, or a secret can reach the cloud, and a client that tries is
    // visibly broken rather than quietly successful.
    for payload in [
        r#"{"stage":"device_enrolled","result":"completed","prompt":"fix my auth bug"}"#,
        r#"{"stage":"device_enrolled","result":"completed","file_path":"/Users/someone/secret.ts"}"#,
        r#"{"stage":"device_enrolled","result":"completed","api_key":"sk-live-123"}"#,
        r#"{"stage":"device_enrolled","result":"completed","notes":"anything at all"}"#,
        r#"{"stage":"device_enrolled","result":"completed","messages":[{"role":"user"}]}"#,
        r#"{"stage":"device_enrolled","result":"completed","workspace_contents":["a","b"]}"#,
    ] {
        assert_eq!(
            TelemetryReport::parse(payload),
            Err(AdoptionError::TelemetryFieldUnknown),
            "accepted {payload}"
        );
    }
}

#[test]
fn telemetry_is_bounded_and_uses_closed_vocabularies() {
    assert_eq!(
        TelemetryReport::parse(&"x".repeat(MAX_TELEMETRY_JSON_LEN + 1)),
        Err(AdoptionError::TelemetryTooLarge)
    );
    for payload in [
        r#"{"stage":"stage_9","result":"completed"}"#,
        r#"{"stage":"device_enrolled","result":"succeeded"}"#,
        r#"{"stage":"device_enrolled"}"#,
        r#"{"result":"completed"}"#,
        r#"{"stage":"device_enrolled","result":"completed","reason_code":"a free-form message"}"#,
        r#"{"stage":"device_enrolled","result":"completed","reason_code":""}"#,
        r#"{"stage":"device_enrolled","result":"completed","protocol_major":0}"#,
        r#"{"stage":"device_enrolled","result":"completed","protocol_major":"1"}"#,
        r#"{"stage":"device_enrolled","result":"completed","app_version":"0.4.0-beta"}"#,
        r#"[]"#,
        r#"not json"#,
    ] {
        assert!(
            TelemetryReport::parse(payload).is_err(),
            "accepted {payload}"
        );
    }
    // A null reason is the common case, not an omission to be filled in.
    let report = TelemetryReport::parse(
        r#"{"stage":"local_unmanaged","result":"skipped","reason_code":null}"#,
    )
    .unwrap();
    assert_eq!(report.reason_code, None);
    assert_eq!(report.result, TelemetryResult::Skipped);
}

#[test]
fn a_declined_step_is_not_reported_as_a_skipped_one() {
    // Collapsing the two would turn a consent decline into a neutral event.
    let declined = TelemetryReport::parse(
        r#"{"stage":"history_sync","result":"declined","reason_code":"consent_required"}"#,
    )
    .unwrap();
    assert_eq!(declined.result, TelemetryResult::Declined);
    assert_ne!(declined.result, TelemetryResult::Skipped);
    for result in [
        TelemetryResult::Started,
        TelemetryResult::Completed,
        TelemetryResult::Skipped,
        TelemetryResult::Failed,
        TelemetryResult::Declined,
        TelemetryResult::RolledBack,
    ] {
        assert_eq!(TelemetryResult::parse(result.as_str()), Some(result));
    }
    assert_eq!(TelemetryResult::parse("done"), None);
}

// ===========================================================================
// Automation import (FR-F26-004)
// ===========================================================================

fn candidate(key: &str) -> AutomationImportCandidate {
    AutomationImportCandidate {
        local_key: key.to_owned(),
        schedule_kind: "cron".to_owned(),
        required_tools: Vec::new(),
        required_model_capabilities: Vec::new(),
        uses_off_peak: false,
        credential_mode: CredentialMode::MetadataOnly,
    }
}

fn context() -> ImportPolicyContext {
    ImportPolicyContext {
        automations_available: true,
        max_active_automations: 10,
        active_automations: 0,
        off_peak_available: true,
        allowed_tools: BTreeSet::new(),
        available_model_capabilities: BTreeSet::new(),
        local_credential_permitted: true,
        workspace_bound: true,
    }
}

#[test]
fn a_clean_preview_reports_every_candidate_as_importable() {
    let candidates = vec![candidate("nightly-backup"), candidate("weekly-report")];
    let preview = automation_import_preview(&candidates, &context()).unwrap();
    assert_eq!(preview.importable_count(), 2);
    assert_eq!(preview.blocked_count(), 0);
    assert!(preview.is_commit_ready());
    for item in &preview.items {
        assert!(item.is_importable(), "{} blocked", item.local_key);
    }
}

#[test]
fn a_required_tool_outside_org_policy_is_a_conflict_shown_before_import() {
    // FR-F26-004 requires the conflict to be visible before the import, not
    // enforced after it.
    let mut candidate = candidate("needs-shell");
    candidate.required_tools = vec!["shell".to_owned()];
    let mut context = context();
    context.allowed_tools = BTreeSet::from(["file_read".to_owned()]);
    let preview = automation_import_preview(&[candidate], &context).unwrap();
    assert!(!preview.is_commit_ready());
    assert_eq!(preview.blocked_count(), 1);
    assert_eq!(
        preview.items[0].conflicts,
        vec![ImportConflict::ToolNotPermitted("shell".to_owned())]
    );
    assert_eq!(preview.items[0].conflicts[0].code(), "tool_not_permitted");
    assert_eq!(preview.items[0].conflicts[0].subject(), Some("shell"));
}

#[test]
fn a_missing_model_capability_and_off_peak_are_both_reported() {
    let mut candidate = candidate("vision-nightly");
    candidate.required_model_capabilities = vec!["vision".to_owned()];
    candidate.uses_off_peak = true;
    let mut context = context();
    context.off_peak_available = false;
    let preview = automation_import_preview(&[candidate], &context).unwrap();
    let codes: Vec<&str> = preview.items[0]
        .conflicts
        .iter()
        .map(ImportConflict::code)
        .collect();
    assert_eq!(
        codes,
        vec!["model_capability_unavailable", "off_peak_not_entitled"]
    );
}

#[test]
fn a_local_credential_workspace_cannot_import_when_org_policy_forbids_byok() {
    let mut local = candidate("nightly-local");
    local.credential_mode = CredentialMode::LocalCredential;
    let mut context = context();
    context.local_credential_permitted = false;
    let preview = automation_import_preview(&[local], &context).unwrap();
    assert_eq!(
        preview.items[0].conflicts,
        vec![ImportConflict::LocalCredentialNotPermitted]
    );
    // A workspace that org policy does permit to keep its own key is unaffected.
    let mut permitted = context;
    permitted.local_credential_permitted = true;
    let preview = automation_import_preview(&[candidate("same")], &permitted).unwrap();
    assert!(preview.is_commit_ready());
}

#[test]
fn an_unbound_workspace_cannot_import() {
    let mut context = context();
    context.workspace_bound = false;
    let preview = automation_import_preview(&[candidate("orphan")], &context).unwrap();
    assert!(
        preview.items[0]
            .conflicts
            .contains(&ImportConflict::WorkspaceUnbound)
    );
}

#[test]
fn an_import_never_crosses_the_active_automation_limit_and_never_trims() {
    // The limit is on managed automations *after* import, so the candidate that
    // would cross it is blocked — not silently dropped, and never by evicting an
    // automation that is already running.
    let mut context = context();
    context.max_active_automations = 2;
    context.active_automations = 1;
    let candidates: Vec<AutomationImportCandidate> = ["a", "b", "c", "d"]
        .iter()
        .map(|key| candidate(key))
        .collect();
    let preview = automation_import_preview(&candidates, &context).unwrap();
    assert_eq!(preview.items.len(), 4, "no candidate may be dropped");
    assert_eq!(preview.importable_count(), 1);
    assert!(preview.items[0].is_importable());
    for item in &preview.items[1..] {
        assert_eq!(
            item.conflicts,
            vec![ImportConflict::AutomationLimitReached],
            "{} was silently trimmed",
            item.local_key
        );
    }
}

#[test]
fn an_organization_without_automations_blocks_every_candidate() {
    let mut context = context();
    context.automations_available = false;
    let preview = automation_import_preview(&[candidate("a"), candidate("b")], &context).unwrap();
    assert_eq!(preview.importable_count(), 0);
    for item in &preview.items {
        assert!(
            item.conflicts
                .contains(&ImportConflict::AutomationNotAvailable)
        );
    }
}

#[test]
fn conflicts_for_one_candidate_are_deterministic() {
    // Two identical previews must render identically, or the user thinks
    // something changed between two reads of the same state.
    let mut candidate = candidate("many-problems");
    candidate.required_tools = vec!["shell".to_owned(), "browser".to_owned()];
    candidate.required_model_capabilities = vec!["vision".to_owned()];
    candidate.uses_off_peak = true;
    let mut context = context();
    context.automations_available = false;
    context.off_peak_available = false;
    context.workspace_bound = false;
    let first = automation_import_preview(&[candidate.clone()], &context).unwrap();
    let second = automation_import_preview(&[candidate], &context).unwrap();
    assert_eq!(first, second);
    assert!(
        first.items[0].conflicts.len() >= 5,
        "{:?}",
        first.items[0].conflicts
    );
}

#[test]
fn an_oversized_or_malformed_import_is_refused() {
    let context = context();
    let many: Vec<AutomationImportCandidate> = (0..=MAX_IMPORT_CANDIDATES)
        .map(|index| candidate(&format!("job-{index}")))
        .collect();
    assert_eq!(
        automation_import_preview(&many, &context),
        Err(AdoptionError::ImportTooLarge)
    );
    assert!(automation_import_preview(&many[..MAX_IMPORT_CANDIDATES], &context).is_ok());

    let mut malformed = candidate("has space");
    assert!(validate_candidate(&malformed).is_err());
    malformed.local_key = "nightly".to_owned();
    assert!(validate_candidate(&malformed).is_ok());
    malformed.schedule_kind = "whenever".to_owned();
    assert!(validate_candidate(&malformed).is_err());
    malformed.schedule_kind = "interval".to_owned();
    malformed.required_tools = vec!["x".repeat(80)];
    assert!(validate_candidate(&malformed).is_err());
    malformed.required_tools = vec!["ok".to_owned()];
    malformed.required_model_capabilities = (0..=32).map(|index| format!("cap{index}")).collect();
    assert!(validate_candidate(&malformed).is_err());
}

#[test]
fn an_empty_preview_is_commit_ready_and_imports_nothing() {
    let preview = automation_import_preview(&[], &context()).unwrap();
    assert!(preview.items.is_empty());
    assert!(preview.is_commit_ready());
    assert_eq!(preview.importable_count(), 0);
}

// ===========================================================================
// Remediation (P08-FE-02)
// ===========================================================================

fn observation() -> MigrationObservation {
    MigrationObservation {
        adopted: true,
        client_managed: true,
        client_build_current: true,
        policy_acknowledged: true,
        credential_mode: CredentialMode::MetadataOnly,
        required_capabilities_permitted: true,
        project_bound: true,
    }
}

#[test]
fn a_healthy_managed_workspace_has_nothing_to_remediate() {
    assert!(derive_remediations(&observation()).is_empty());
}

#[test]
fn a_local_only_user_is_never_told_they_have_an_adoption_problem() {
    // The single most important remediation property. Doing nothing is a
    // supported state, so inventing a problem for it would make P08 feel like
    // nagging rather than migration.
    let unmanaged = MigrationObservation {
        adopted: false,
        client_managed: false,
        client_build_current: false,
        policy_acknowledged: false,
        credential_mode: CredentialMode::LocalCredential,
        required_capabilities_permitted: false,
        project_bound: false,
    };
    assert!(derive_remediations(&unmanaged).is_empty());
}

#[test]
fn an_enrolled_but_unmanaged_workspace_is_only_told_about_its_client_and_policy() {
    // It is told nothing about credentials, tool policy, or binding: it has not
    // asked for any of those yet.
    let mut current = observation();
    current.client_managed = false;
    current.client_build_current = true;
    current.policy_acknowledged = true;
    current.credential_mode = CredentialMode::LocalCredential;
    current.required_capabilities_permitted = false;
    current.project_bound = false;
    assert!(derive_remediations(&current).is_empty());

    // A stale client is still worth reporting before anything is managed.
    current.client_build_current = false;
    current.policy_acknowledged = false;
    let codes: Vec<RemediationCode> = derive_remediations(&current)
        .iter()
        .map(|entry| entry.code)
        .collect();
    assert_eq!(
        codes,
        vec![
            RemediationCode::ClientOutdated,
            RemediationCode::PolicySyncFailed
        ]
    );
}

#[test]
fn a_managed_workspace_reports_each_distinct_problem_once_in_operator_order() {
    let broken = MigrationObservation {
        adopted: true,
        client_managed: true,
        client_build_current: false,
        policy_acknowledged: false,
        credential_mode: CredentialMode::LocalCredential,
        required_capabilities_permitted: false,
        project_bound: false,
    };
    let remediations = derive_remediations(&broken);
    let codes: Vec<RemediationCode> = remediations.iter().map(|entry| entry.code).collect();
    assert_eq!(
        codes,
        vec![
            RemediationCode::ClientOutdated,
            RemediationCode::PolicySyncFailed,
            RemediationCode::CredentialMissing,
            RemediationCode::CapabilityUnsupported,
            RemediationCode::WorkspaceUnbound,
        ]
    );
    let mut unique = codes.clone();
    unique.dedup();
    assert_eq!(codes, unique, "a code was reported twice");
    for entry in &remediations {
        assert_eq!(entry.remedy, default_remedy(entry.code));
    }
    // Deterministic: the same facts always produce the same list, in the frozen
    // order, so the web client can pin the rendering.
    assert_eq!(remediations, derive_remediations(&broken));
}

#[test]
fn the_remediation_vocabularies_round_trip() {
    for code in RemediationCode::ALL {
        assert_eq!(RemediationCode::parse(code.as_str()), Some(code));
        assert_ne!(default_remedy(code), Remedy::Dismiss);
    }
    assert_eq!(RemediationCode::parse("try_again"), None);
    for remedy in [
        Remedy::UpgradeClient,
        Remedy::ReconnectDevice,
        Remedy::RebindWorkspace,
        Remedy::ChooseCredentialMode,
        Remedy::ReviewToolPolicy,
        Remedy::Dismiss,
    ] {
        assert_eq!(Remedy::parse(remedy.as_str()), Some(remedy));
    }
    assert_eq!(Remedy::parse("do_a_barrel_roll"), None);
}

// ===========================================================================
// Frozen coordinator fixture
// ===========================================================================

const FIXTURE: &str =
    include_str!("../../../../../docs/implementation/fixtures/p08-contracts-v1.json");

fn fixture() -> serde_json::Value {
    serde_json::from_str(FIXTURE).expect("frozen P08 fixture is valid JSON")
}

#[test]
fn the_frozen_p08_fixture_is_representable() {
    let value = fixture();
    assert_eq!(value["contract_version"], "p08-cg-v1");

    // The frozen protocol and policy-schema ranges.
    let protocols = value["client_compatibility"]["supported_protocols"]
        .as_array()
        .expect("supported_protocols array");
    assert_eq!(protocols.as_slice(), SUPPORTED_CLIENT_PROTOCOLS.as_slice());
    let schemas = value["client_compatibility"]["supported_policy_schema_versions"]
        .as_array()
        .expect("supported_policy_schema_versions array");
    assert_eq!(
        schemas.as_slice(),
        SUPPORTED_POLICY_SCHEMA_VERSIONS.as_slice()
    );
    assert_eq!(
        value["client_compatibility"]["min_client_app_version"],
        MIN_CLIENT_APP_VERSION
    );
    assert_eq!(
        value["client_compatibility"]["local_only_eligible"],
        CompatibilityPolicy::baseline().local_only_eligible()
    );
    assert_eq!(
        value["client_compatibility"]["history_sync_eligible"],
        CompatibilityPolicy::baseline().history_sync_eligible
    );

    // The stage ladder, in the order the fixture declares it.
    let stages = value["stages"].as_array().expect("stages array");
    assert_eq!(stages.len(), AdoptionStage::ALL.len());
    for (index, stage) in stages.iter().enumerate() {
        assert_eq!(
            stage.as_str(),
            Some(AdoptionStage::ALL[index].as_str()),
            "stage {index} drifted"
        );
    }
    assert_eq!(
        value["stage_rules"]["org_ownership_begins_at"],
        AdoptionStage::WorkspaceBound.as_str()
    );
    assert_eq!(
        value["stage_rules"]["rollback_target"],
        AdoptionStage::LocalUnmanaged.as_str()
    );

    // Ownership, credential, and telemetry-result vocabularies.
    for mode in value["credential_modes"]
        .as_array()
        .expect("credential_modes")
    {
        assert!(CredentialMode::parse(mode.as_str().expect("string mode")).is_some());
    }
    for ownership in value["ownership_states"]
        .as_array()
        .expect("ownership_states")
    {
        assert!(Ownership::parse(ownership.as_str().expect("string ownership")).is_some());
    }
    for result in value["telemetry_results"]
        .as_array()
        .expect("telemetry_results")
    {
        assert!(TelemetryResult::parse(result.as_str().expect("string result")).is_some());
    }
    assert_eq!(
        value["telemetry_fields"]
            .as_array()
            .expect("telemetry_fields")
            .len(),
        6,
        "a seventh telemetry field would be a new privacy decision"
    );

    // Every frozen error, conflict, remediation, and remedy code is a real value
    // the domain can produce or accept.
    for entry in value["adoption_error_codes"]
        .as_array()
        .expect("adoption_error_codes")
    {
        let code = entry.as_str().expect("string error code");
        let known = [
            AdoptionError::StageNotAdvanceable,
            AdoptionError::HistorySyncUnavailable,
            AdoptionError::HistorySyncRequiresManagedCredential,
            AdoptionError::BindingIncomplete,
            AdoptionError::CredentialModeRequiresManaged,
            AdoptionError::AlreadyLocal,
            AdoptionError::InvalidExternalReference,
            AdoptionError::TelemetryFieldUnknown,
            AdoptionError::TelemetryTooLarge,
            AdoptionError::ImportTooLarge,
        ];
        assert!(
            known.iter().any(|error| error.code() == code),
            "the fixture names an error the domain never produces: {code}"
        );
    }
    for entry in value["import_conflict_codes"]
        .as_array()
        .expect("import_conflict_codes")
    {
        let code = entry.as_str().expect("string conflict code");
        let known = [
            ImportConflict::AutomationNotAvailable,
            ImportConflict::AutomationLimitReached,
            ImportConflict::ToolNotPermitted(String::new()),
            ImportConflict::ModelCapabilityUnavailable(String::new()),
            ImportConflict::OffPeakNotEntitled,
            ImportConflict::WorkspaceUnbound,
            ImportConflict::LocalCredentialNotPermitted,
        ];
        assert!(
            known.iter().any(|conflict| conflict.code() == code),
            "the fixture names a conflict the domain never produces: {code}"
        );
    }
    for entry in value["compatibility_reasons"]
        .as_array()
        .expect("compatibility_reasons")
    {
        let code = entry.as_str().expect("string reason");
        let emitted = [
            ClientCompatibility::Supported,
            ClientCompatibility::UpgradeRequired,
            ClientCompatibility::UnsupportedProtocol,
            ClientCompatibility::UnsupportedPolicySchema,
        ];
        assert!(
            emitted.iter().any(|state| state.reason() == Some(code)),
            "the fixture names a reason the domain never emits: {code}"
        );
    }
    for code in value["remediation_codes"]
        .as_array()
        .expect("remediation_codes")
    {
        assert!(RemediationCode::parse(code.as_str().expect("string code")).is_some());
    }
    for remedy in value["remedies"].as_array().expect("remedies") {
        assert!(Remedy::parse(remedy.as_str().expect("string remedy")).is_some());
    }
}

#[test]
fn the_fixture_records_that_no_local_content_is_ever_uploaded() {
    // F26's privacy invariant, stated in the frozen artifact so a later phase
    // that wants to add a field has to edit this and defend the change.
    let value = fixture();
    let never = value["never_uploaded"]
        .as_array()
        .expect("never_uploaded array");
    for expected in [
        "local_api_keys",
        "historical_prompts",
        "files",
        "automations",
        "mcp_credentials",
        "workspace_contents",
    ] {
        assert!(
            never.iter().any(|entry| entry.as_str() == Some(expected)),
            "the fixture must still name {expected}"
        );
    }
    // And the new data classes the migration declares are all named, so F20 has
    // a declaration for every row P08 adds.
    let classes = value["new_data_classes"]
        .as_array()
        .expect("new_data_classes");
    assert_eq!(classes.len(), 4);
}
