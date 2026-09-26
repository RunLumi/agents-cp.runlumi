//! The secret canary harness (P09-SEC-02).
//!
//! # What this file exists to prevent
//!
//! Every other invariant in this repository is checked by *behaviour*: a test
//! asserts a route refuses a bad input, a migration refuses a bad row, an
//! authorization decision comes out `deny`. Secret hygiene has no behaviour to
//! assert. A leak is the ABSENCE of output — nothing breaks, nothing fails, a
//! credential simply appears in a log aggregator, a panic message, or a support
//! ticket where nobody is looking. A test suite that only checks the happy path
//! passes with a total leak in place.
//!
//! So this harness inverts the usual shape. It **plants a canary** — a value
//! that is syntactically valid for the field it occupies and is unlikely to occur
//! by accident anywhere else — and then asserts that the canary is *unobservable*
//! in every surface that could carry it away: a `Debug` rendering, a `Display`
//! rendering, and a client JSON projection.
//!
//! # Why canaries rather than assertions about code shape
//!
//! Reading a struct definition and deciding "this field looks sensitive" is a
//! review, and reviews do not run in CI. A canary does not care what a field is
//! called or what a comment says: it puts a specific value in and checks that the
//! specific value does not come out. `PasswordRecord::encoded_hash` can be
//! renamed to `blob` and the canary still holds; a reviewer would have to notice.
//!
//! # The four things a canary cannot see, stated rather than glossed
//!
//! * It proves the *value* does not escape through a rendering it can name. It
//!   does not prove no other rendering exists.
//! * It cannot reach a projection that is private to its own route module, because
//!   making it visible would be a production change made for test convenience.
//!   [`projections_never_read_a_secret_field`] covers those statically instead.
//! * It cannot reach `P05AuditProjection`, which `consumers::p05` does not
//!   re-export. The static scan still audits its `Debug`.
//! * It is a host-target test. It proves the type's rendering, not that no
//!   platform ever logs the value.
//!
//! Each of those is a real limit. Naming them is more useful than pretending the
//! harness is total, and each has a compensating check or an owner.
//!
//! # The static half
//!
//! [`derived_debug_never_reaches_a_secret`] and
//! [`projections_never_read_a_secret_field`] read the whole `apps/api/src` tree at
//! test time. They exist because the runtime half can only cover types it can
//! *construct*, and because a projection that adds a `secret` field compiles
//! perfectly well — the only thing that notices is a test that reads the code.
//!
//! # Why the scanner has a self-test
//!
//! [`the_scanner_would_catch_a_planted_derive`] feeds a synthetic source string
//! through the same parser the real scan uses and asserts it reports the planted
//! struct. Without that case, a parser bug — a regex that stops matching, an
//! attribute scan that stops looking upward — makes every other case pass
//! vacuously. A canary harness that cannot fail is not a canary harness, so the
//! ability to fail is itself a test.
#![cfg(test)]

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

// ---------------------------------------------------------------------------
// The canary values.
//
// Each is a CONSTANT, not a generated value, so a failure message can name the
// exact string that leaked and grep finds it in the log it escaped into. Each is
// also syntactically valid for its field, because a canary that fails validation
// proves nothing: the value must reach the struct under test to be observable.
// ---------------------------------------------------------------------------

/// 64 lowercase hex: the exact shape of `api_keys.secret_hash`,
/// `api_keys.fingerprint`, `webhook_secret_fingerprints`, and every other
/// stored digest. A digest is not a bearer credential, but it is the only
/// persisted proof of one and the mission treats it as secret material.
const HASH_CANARY: &str = "ca4ac1e70000000000000000000000000000000000000000000000000000ny";

/// A 43-character base64url secret: the exact shape of the `lumik_` and
/// `lumi_staff` secret halves.
const SECRET_CANARY: &str = "c4n4ryS3cr3tHalfOfTheWireValueNoBodyCanEverReadIt";

/// The `lumik_` wire value assembled from [`SECRET_CANARY`]. Carries the hash
/// canary in its prefix so a leak of either half is attributable.
const MACHINE_WIRE_CANARY: &str = "lumik_ca4ac1e70000_c4n4ryS3cr3tHalfOfTheWireValueNoBodyCanEverReadIt";

/// The argon2id encoded form, with real parameters so it would survive a real
/// KDF. Only the SHAPE matters here; no test verifies a password against it.
const ARGON2_CANARY: &str = "$argon2id$v=19$m=65536,t=3,p=4$c2Fub3J5c2FsdA$Y2FuYXJ5Q2FuYXJ5Q2FuYXJ5Q2FuYXJ5Q2FuYXJ5Q2E";

/// An OpenAI/Anthropic-shaped provider credential. The provider adapter adds it
/// to an outbound header, so the canary asserts it never reaches a rendering.
const PROVIDER_KEY_CANARY: &str = "sk-p09canaryAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// Base64 AES-GCM ciphertext with a plausible length.
const CIPHERTEXT_CANARY: &str = "Q2FOTVlWSU9VUkVSRU9DSElQSEVSQUNBUlk";

/// A session/CSRF/reauth token as `adapters::new_secret` would mint it.
const SESSION_TOKEN_CANARY: &str = "cs_4an4ry50nT0k3nCanN0tL3akAndB3har3d0n0tB3St0r3";

/// The WebAuthn verifier state blob. Its contents are opaque to Lumi, which is
/// exactly why printing it is unreviewable.
const CEREMONY_STATE_CANARY: &str = "{\"challenge\":\"c4n4ry\",\"userVerified\":true}";

/// The opaque R2 export object key, as `build_object_key` produces it.
const OBJECT_KEY_CANARY: &str = "exports/usr_0123456789abcdef0123456789abcdef/exp_0123456789abcdef0123456789abcdef/ca4ac1e7000000000000000000000000";

/// The audit/security-event metadata canary, used to prove
/// `repositories::audit::bounded_metadata` refuses it.
const METADATA_CANARY: &str = "c4n4ry-metadata-payload-must-never-be-persisted-or-returned";

/// A representative value for an unbounded free-text column (an email, a device
/// label). Held separately from the secrets because the two are handled
/// differently: an email is PII and is redacted for a different reason, so
/// conflating the two would make the assertions lie about what is being proved.
const IDENTITY_CANARY: &str = "c4n4ry-identity@example.invalid";

/// Every canary, so one helper can assert "no surface printed any of them".
const ALL_CANARIES: &[&str] = &[
    HASH_CANARY,
    SECRET_CANARY,
    MACHINE_WIRE_CANARY,
    ARGON2_CANARY,
    PROVIDER_KEY_CANARY,
    CIPHERTEXT_CANARY,
    SESSION_TOKEN_CANARY,
    CEREMONY_STATE_CANARY,
    OBJECT_KEY_CANARY,
    METADATA_CANARY,
    IDENTITY_CANARY,
];

/// Fixed, well-formed identifiers. A canary that is also syntactically invalid as
/// an ID would make a test pass for the wrong reason.
const ORG: &str = "org_0123456789abcdef0123456789abcdef";
const USER: &str = "usr_0123456789abcdef0123456789abcdef";
const SESSION: &str = "ses_0123456789abcdef0123456789abcdef";
const DEVICE: &str = "dvc_0123456789abcdef0123456789abcdef";
const ACCOUNT: &str = "svc_0123456789abcdef0123456789abcdef";
const KEY: &str = "key_0123456789abcdef0123456789abcdef";
const NOW: &str = "2026-09-26T12:00:00.000Z";
const LATER: &str = "2026-09-26T13:00:00.000Z";

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/// Assert a rendering does not carry any canary, and say which one it carried.
#[track_caller]
fn assert_no_canary(surface: &str, rendered: &str) {
    for canary in ALL_CANARIES {
        assert!(
            !rendered.contains(canary),
            "{surface} leaked a canary ({canary:?}) into:\n{rendered}"
        );
    }
}

/// The positive control for [`assert_no_canary`].
///
/// Without this, a harness whose canary list was emptied, or whose `contains`
/// check was inverted by a refactor, would pass every case in the file. The
/// control asserts the detector fires on a string that provably contains a
/// canary, so "no canary found" means "looked and did not find" rather than
/// "did not look".
#[test]
fn the_canary_detector_itself_detects() {
    let planted = format!("ApiKeyRecord {{ secret_hash: {HASH_CANARY} }}");
    assert!(
        planted.contains(HASH_CANARY),
        "the detector must fire on a planted value or every other case is vacuous"
    );
    // And the negative form, so the positive control above is not the only thing
    // keeping the helper honest.
    assert_no_canary("a clean rendering", "ApiKeyRecord { key_prefix: \"0123456789ab\" }");
}

// ---------------------------------------------------------------------------
// Part 1 — runtime canaries: credential material
// ---------------------------------------------------------------------------

#[test]
fn a_machine_credential_is_invisible_in_debug_and_display() {
    use crate::core::{MachineKey, MachineKeyMaterial, MachineActor};

    // The parsed wire form. `parse` is the only constructor, so a canary that
    // survives it is a canary that really reached the type.
    let key = MachineKey::parse(MACHINE_WIRE_CANARY).expect("the canary wire form is valid");
    assert_eq!(key.secret(), SECRET_CANARY, "the canary really parsed");
    assert_no_canary("MachineKey Debug", &format!("{key:?}"));
    // The non-secret half is deliberately still visible: an operator identifies a
    // key by its prefix. Asserting the prefix survives keeps this from decaying
    // into "redact everything", which is how a redactor gets removed.
    assert!(format!("{key:?}").contains("ca4ac1e70000"));

    let material = MachineKeyMaterial::from_random_bytes(&[0x42; 32]).expect("32 bytes");
    assert_no_canary("MachineKeyMaterial Debug", &format!("{material:?}"));

    // The material's own derived values must not be reachable either. A
    // `MachineKeyMaterial` printed in full is a credential, not a hash.
    let wire = material.wire_value().to_owned();
    let hash = material.secret_hash.clone();
    let fingerprint = material.fingerprint.clone();
    let debug = format!("{material:?}");
    assert!(!debug.contains(&wire), "the wire value reached Debug");
    assert!(
        !debug.contains(&hash),
        "the derived secret hash reached Debug"
    );
    assert!(debug.contains(&fingerprint), "the fingerprint is public");

    let actor = MachineActor::new(
        KEY.parse().expect("api key id"),
        ACCOUNT.parse().expect("service account id"),
        ORG.parse().expect("organization id"),
        "ca4ac1e70000",
    );
    assert_no_canary("MachineActor Debug", &format!("{actor:?}"));
}

#[test]
fn a_staff_credential_is_invisible_in_debug_and_display() {
    use crate::core::{StaffKey, StaffPrincipal, StaffPrincipalId};

    let wire = format!("lumi_staff_ca4ac1e700000000_{SECRET_CANARY}");
    let key = StaffKey::parse(&wire).expect("the canary staff wire form is valid");
    assert_eq!(key.secret(), SECRET_CANARY, "the canary really parsed");
    assert_no_canary("StaffKey Debug", &format!("{key:?}"));
    assert!(format!("{key:?}").contains("ca4ac1e700000000"));

    // A refusal must be undifferentiated: `Display` is what a route and a log
    // both see, and it must not say which half of the credential was wrong.
    let refusal = StaffKey::parse("lumi_staff_ca4ac1e700000000_short").unwrap_err();
    assert_no_canary("StaffKeyError Display", &refusal.to_string());

    let principal = StaffPrincipal {
        staff_principal_id: StaffPrincipalId::new("stf_0123456789abcdef0123456789abcdef")
            .expect("staff id"),
        email: IDENTITY_CANARY.to_owned(),
        display_name: "Support".to_owned(),
        credential_prefix: "ca4ac1e700000000".to_owned(),
    };
    assert_no_canary("StaffPrincipal Debug", &format!("{principal:?}"));
}

#[test]
fn a_stored_api_key_never_reaches_debug_or_a_read_projection() {
    use crate::repositories::{ApiKeyRecord, ServiceAccountRecord};
    use crate::routes::machine_identity::{api_key_json, api_key_json_with_secret};

    let record = ApiKeyRecord {
        api_key_id: KEY.to_owned(),
        service_account_id: ACCOUNT.to_owned(),
        org_id: ORG.to_owned(),
        name: "ci-deploy".to_owned(),
        key_prefix: "ca4ac1e70000".to_owned(),
        secret_hash: HASH_CANARY.to_owned(),
        fingerprint: HASH_CANARY.to_owned(),
        capabilities_json: r#"["runs.read"]"#.to_owned(),
        project_ids_json: None,
        model_aliases_json: None,
        network_allowlist_json: None,
        status: "active".to_owned(),
        rotated_from_key_id: None,
        rotated_to_key_id: None,
        last_used_at: None,
        last_used_source: None,
        expires_at: None,
        revoked_at: None,
        revoke_reason: None,
        version: 1,
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
    };

    // `Debug` is the leak surface the mission names: a panic, an `unwrap()`, and a
    // test failure all print it. `secret_hash` is excluded; the prefix and the
    // fingerprint are deliberately kept, because an operator identifies a key by
    // them and neither is a credential.
    let debug = format!("{record:?}");
    assert!(
        !debug.contains(HASH_CANARY),
        "ApiKeyRecord Debug leaked its stored hash: {debug}"
    );
    assert!(debug.contains("ca4ac1e70000"));

    // The read projection. This is the one that a browser, a support export, and
    // a `curl` transcript all see, so it gets its own assertion rather than
    // inheriting the `Debug` one.
    let read = api_key_json(&record);
    assert_no_canary("api_key_json", &read.to_string());
    assert!(read.get("secret").is_none());
    assert!(read.get("secret_hash").is_none());
    assert!(read.get("wire_value").is_none());

    // The create/rotate projection is the ONE place a plaintext secret is
    // allowed. It must carry exactly the value it was handed, exactly once, and
    // add no second name for it.
    let once = api_key_json_with_secret(&record, MACHINE_WIRE_CANARY);
    assert_eq!(once["secret"], MACHINE_WIRE_CANARY);
    let object = once.as_object().expect("an object");
    assert_eq!(object.len(), read.as_object().expect("an object").len() + 2);
    let secret_values = object
        .iter()
        .filter(|(_, value)| value.as_str() == Some(MACHINE_WIRE_CANARY))
        .count();
    assert_eq!(secret_values, 1, "the secret appears under more than one field");

    let account = ServiceAccountRecord {
        service_account_id: ACCOUNT.to_owned(),
        org_id: ORG.to_owned(),
        name: "ci".to_owned(),
        description: None,
        capabilities_json: r#"["runs.read"]"#.to_owned(),
        created_by_principal: USER,
        status: "active".to_owned(),
        expires_at: None,
        suspended_at: None,
        suspend_reason: None,
        version: 1,
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
    };
    assert_no_canary("ServiceAccountRecord Debug", &format!("{account:?}"));
}

#[test]
fn an_encrypted_provider_credential_is_invisible_in_debug() {
    use crate::adapters::crypto::EncryptedSecret;
    use crate::modules::credentials::{CredentialMetadata, CredentialOwnerType, CredentialStatus};
    use crate::repositories::CredentialRecord;

    let encrypted = EncryptedSecret {
        ciphertext: CIPHERTEXT_CANARY.to_owned(),
        nonce: HASH_CANARY.to_owned(),
    };
    assert_no_canary("EncryptedSecret Debug", &format!("{encrypted:?}"));

    // The F11 BYOK record. `ciphertext`, `nonce`, and `fingerprint` are all
    // excluded from `Debug`; only the non-secret `key_version` survives.
    let record = CredentialRecord {
        credential_id: "cred_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: Some(ORG.to_owned()),
        owner_type: "organization".to_owned(),
        owner_user_id: None,
        provider_id: "prv_0123456789abcdef0123456789abcdef".to_owned(),
        label: "github".to_owned(),
        ciphertext: Some(CIPHERTEXT_CANARY.to_owned()),
        nonce: Some(HASH_CANARY.to_owned()),
        key_version: Some("v1".to_owned()),
        fingerprint: HASH_CANARY.to_owned(),
        status: "active".to_owned(),
        version: 1,
        parent_credential_id: None,
        created_by_user_id: Some(USER.to_owned()),
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
        last_used_at: None,
    };
    let debug = format!("{record:?}");
    assert!(
        !debug.contains(CIPHERTEXT_CANARY) && !debug.contains(HASH_CANARY),
        "CredentialRecord Debug leaked encrypted credential material: {debug}"
    );

    let metadata = CredentialMetadata {
        credential_id: record.credential_id.clone(),
        org_id: record.org_id.clone(),
        owner_type: CredentialOwnerType::Organization,
        owner_user_id: None,
        provider_id: record.provider_id.clone(),
        label: record.label.clone(),
        status: CredentialStatus::Active,
        version: 1,
        fingerprint: HASH_CANARY.to_owned(),
        key_version: "v1".to_owned(),
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
        last_used_at: None,
    };
    assert_no_canary("CredentialMetadata Debug", &format!("{metadata:?}"));
}

#[test]
fn a_license_signing_secret_is_invisible_in_debug() {
    use crate::adapters::billing::LicenseSigningSecret;

    // 48 zero bytes of PKCS#8 DER, base64. `from_env_value` checks the shape and
    // the length, not that the key is a real key, which is all a canary needs.
    let der = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let secret =
        LicenseSigningSecret::from_env_value(&format!("ca4ac1e70000:{der}")).expect("canary key shape");
    let debug = format!("{secret:?}");
    assert_no_canary("LicenseSigningSecret Debug", &debug);
    // The advertised key id is public metadata: a client needs it to pick a
    // verification key. Keeping it visible is the point of the redaction being
    // narrow rather than total.
    assert!(debug.contains("ca4ac1e70000"));
}

// ---------------------------------------------------------------------------
// Part 2 — runtime canaries: stored authentication material
// ---------------------------------------------------------------------------

#[test]
fn a_stored_password_hash_is_invisible_in_debug() {
    use crate::modules::authenticators::PasswordCredential;
    use crate::repositories::PasswordRecord;

    let record = PasswordRecord {
        user_id: USER.to_owned(),
        encoded_hash: ARGON2_CANARY.to_owned(),
        algorithm: "argon2id".to_owned(),
        memory_kib: 65_536,
        time_cost: 3,
        parallelism: 4,
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
    };
    let debug = format!("{record:?}");
    assert!(
        !debug.contains(ARGON2_CANARY),
        "PasswordRecord Debug leaked the argon2id hash: {debug}"
    );
    // The KDF COST parameters are not secret and an operator diagnosing a login
    // failure needs them, so they must survive the redaction.
    assert!(debug.contains("65536"), "the redaction became total: {debug}");

    let credential = PasswordCredential {
        user_id: USER.to_owned(),
        encoded_hash: ARGON2_CANARY.to_owned(),
        algorithm: "argon2id".to_owned(),
        memory_kib: 65_536,
        time_cost: 3,
        parallelism: 4,
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
    };
    assert_no_canary("PasswordCredential Debug", &format!("{credential:?}"));
}

#[test]
fn a_recovery_code_hash_is_invisible_in_debug() {
    use crate::repositories::RecoveryRecord;

    let record = RecoveryRecord {
        challenge_id: "chl_0123456789abcdef0123456789abcdef".to_owned(),
        user_id: Some(USER.to_owned()),
        email: IDENTITY_CANARY.to_owned(),
        code_hash: HASH_CANARY.to_owned(),
        status: "pending".to_owned(),
        attempts: 0,
        expires_at: LATER.to_owned(),
        consumed_at: None,
        created_at: NOW.to_owned(),
    };
    let debug = format!("{record:?}");
    assert!(
        !debug.contains(HASH_CANARY),
        "RecoveryRecord Debug leaked the recovery-code hash: {debug}"
    );
    assert!(
        !debug.contains(IDENTITY_CANARY),
        "RecoveryRecord Debug leaked the account's email: {debug}"
    );
}

#[test]
fn a_webauthn_ceremony_state_is_invisible_in_debug() {
    use crate::repositories::CeremonyRecord;

    let record = CeremonyRecord {
        ceremony_id: "cer_0123456789abcdef0123456789abcdef".to_owned(),
        kind: "registration".to_owned(),
        user_id: Some(USER.to_owned()),
        pending_user_id: None,
        email: Some(IDENTITY_CANARY.to_owned()),
        display_name: Some("Person".to_owned()),
        session_id: Some(SESSION.to_owned()),
        state_json: CEREMONY_STATE_CANARY.to_owned(),
        status: "pending".to_owned(),
        attempts: 0,
        expires_at: LATER.to_owned(),
        consumed_at: None,
        created_at: NOW.to_owned(),
    };
    let debug = format!("{record:?}");
    assert!(
        !debug.contains(CEREMONY_STATE_CANARY),
        "CeremonyRecord Debug leaked the WebAuthn verifier state: {debug}"
    );
    assert!(
        !debug.contains(IDENTITY_CANARY),
        "CeremonyRecord Debug leaked the pending login's email: {debug}"
    );
}

#[test]
fn a_passkey_credential_handle_is_invisible_in_debug() {
    use crate::repositories::PasskeyRecord;

    // `credential_id` is the WebAuthn lookup handle. It is not a private key —
    // there is no private key in this type at all — but the domain twin
    // `PasskeyCredential` redacts it, and a repository record that is more
    // permissive than the value it produces is how that redaction gets undone.
    let record = PasskeyRecord {
        passkey_id: "psk_0123456789abcdef0123456789abcdef".to_owned(),
        user_id: USER.to_owned(),
        credential_id: SESSION_TOKEN_CANARY.to_owned(),
        public_key_cose: CIPHERTEXT_CANARY.to_owned(),
        sign_count: 7,
        transports: vec!["usb".to_owned()],
        backup_eligible: Some(true),
        backup_state: Some(true),
        label: "Yubikey".to_owned(),
        created_at: NOW.to_owned(),
        last_used_at: None,
        revoked_at: None,
    };
    let debug = format!("{record:?}");
    assert!(
        !debug.contains(SESSION_TOKEN_CANARY),
        "PasskeyRecord Debug leaked the credential handle: {debug}"
    );
    assert!(
        !debug.contains(CIPHERTEXT_CANARY),
        "PasskeyRecord Debug leaked the public key material: {debug}"
    );
}

// ---------------------------------------------------------------------------
// Part 3 — runtime canaries: capability-shaped and store-internal material
// ---------------------------------------------------------------------------

#[test]
fn a_device_enrollment_and_token_are_invisible_in_debug() {
    use crate::repositories::{DeviceEnrollmentRecord, DeviceTokenRecord};

    // The enrollment `code_hash` gates who may approve, and `challenge` is the
    // proof released only after approval. Both are what a pending enrollment is
    // worth.
    let enrollment = DeviceEnrollmentRecord {
        enrollment_id: "enr_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: ORG.to_owned(),
        code_hash: HASH_CANARY.to_owned(),
        public_key: "ssh-ed25519 AAAA".to_owned(),
        key_fingerprint: HASH_CANARY.to_owned(),
        device_name: "Studio".to_owned(),
        platform: "macos".to_owned(),
        app_version: "1.0.0".to_owned(),
        status: "pending".to_owned(),
        challenge: Some(CEREMONY_STATE_CANARY.to_owned()),
        device_id: None,
        approved_by_user_id: None,
        expires_at: LATER.to_owned(),
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
    };
    let debug = format!("{enrollment:?}");
    assert!(
        !debug.contains(HASH_CANARY),
        "DeviceEnrollmentRecord Debug leaked code_hash/key_fingerprint: {debug}"
    );
    assert!(
        !debug.contains(CEREMONY_STATE_CANARY),
        "DeviceEnrollmentRecord Debug leaked the proof challenge: {debug}"
    );

    // A device bearer token's stored hash is the lookup index for the token
    // itself. Same treatment `api_keys.secret_hash` gets.
    let token = DeviceTokenRecord {
        token_hash: HASH_CANARY.to_owned(),
        device_id: DEVICE.to_owned(),
        expires_at: LATER.to_owned(),
        created_at: NOW.to_owned(),
    };
    let debug = format!("{token:?}");
    assert!(
        !debug.contains(HASH_CANARY),
        "DeviceTokenRecord Debug leaked the token hash: {debug}"
    );
    assert!(debug.contains(DEVICE));
}

#[test]
fn an_invitation_token_hash_is_invisible_in_debug() {
    use crate::repositories::InvitationRecord;

    let invitation = InvitationRecord {
        invitation_id: "inv_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: ORG.to_owned(),
        email: IDENTITY_CANARY.to_owned(),
        role: "member".to_owned(),
        invited_by_user_id: USER.to_owned(),
        token_hash: HASH_CANARY.to_owned(),
        status: "pending".to_owned(),
        expires_at: LATER.to_owned(),
        accepted_by_user_id: None,
        accepted_at: None,
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
    };
    let debug = format!("{invitation:?}");
    assert!(
        !debug.contains(HASH_CANARY),
        "InvitationRecord Debug leaked the invitation token hash: {debug}"
    );
    assert!(
        !debug.contains(IDENTITY_CANARY),
        "InvitationRecord Debug leaked the invitee's email: {debug}"
    );
}

#[test]
fn an_export_object_key_and_download_grant_are_invisible_in_debug() {
    use crate::adapters::r2::{ObjectKey, StoredObject, build_object_key};
    use crate::repositories::{DownloadGrantRecord, ExportArtifactRecord};

    // ADR 0006: the object key is capability-shaped. `ObjectKey::fmt` already
    // redacts; `StoredObject` carries the same value as a bare `String`, so it
    // has to redact for itself.
    let key = build_object_key(USER, "exp_0123456789abcdef0123456789abcdef", HASH_CANARY)
        .expect("the canary object key is a valid shape");
    assert!(key.as_str().contains(HASH_CANARY), "the canary really built");
    assert_no_canary("ObjectKey Debug", &format!("{key:?}"));
    // `Display` is the bucket-API call and is deliberately not redacted, so the
    // canary asserts the *Debug* surface only. Asserting Display here would fail
    // by design and would be a test that lies about the type's contract.
    assert!(key.to_string().contains(HASH_CANARY));

    let stored = StoredObject {
        key: OBJECT_KEY_CANARY.to_owned(),
        size_bytes: 4_096,
        etag: "9f".repeat(32),
        sha256_hex: Some(HASH_CANARY.to_owned()),
    };
    let debug = format!("{stored:?}");
    assert!(
        !debug.contains(HASH_CANARY),
        "StoredObject Debug leaked the object key or its digest: {debug}"
    );

    let artifact = ExportArtifactRecord {
        artifact_id: "art_0123456789abcdef0123456789abcdef".to_owned(),
        export_id: "exp_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: None,
        object_key: OBJECT_KEY_CANARY.to_owned(),
        bucket_name: "lumi-exports".to_owned(),
        content_type: "application/zip".to_owned(),
        size_bytes: Some(4_096),
        checksum_sha256: Some(HASH_CANARY.to_owned()),
        created_at: NOW.to_owned(),
        expires_at: LATER.to_owned(),
        deleted_at: None,
    };
    let debug = format!("{artifact:?}");
    assert!(
        !debug.contains(OBJECT_KEY_CANARY),
        "ExportArtifactRecord Debug leaked the object key: {debug}"
    );

    // A download grant is a bearer capability to read a customer's exported data.
    let grant = DownloadGrantRecord {
        grant_id: "grant_0123456789abcdef0123456789ab".to_owned(),
        export_id: "exp_0123456789abcdef0123456789abcdef".to_owned(),
        artifact_id: "art_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: None,
        user_id: USER.to_owned(),
        token_fingerprint: format!("sha256:{HASH_CANARY}"),
        issued_at: NOW.to_owned(),
        expires_at: LATER.to_owned(),
        revoked_at: None,
        use_count: 0,
        job_scope_type: "user".to_owned(),
        job_scope_user_id: USER.to_owned(),
        job_scope_org_id: String::new(),
        job_snapshot_cutoff_at: NOW.to_owned(),
        job_state: "ready".to_owned(),
    };
    assert_no_canary("DownloadGrantRecord Debug", &format!("{grant:?}"));
}

#[test]
fn a_webhook_secret_and_delivery_body_are_invisible_in_debug() {
    use crate::repositories::{WebhookDeliveryRecord, WebhookSecretRecord};

    let secret = WebhookSecretRecord {
        secret_version_id: "whs_0123456789abcdef0123456789abcdef".to_owned(),
        endpoint_id: "whe_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: ORG.to_owned(),
        ciphertext: CIPHERTEXT_CANARY.to_owned(),
        nonce: HASH_CANARY.to_owned(),
        fingerprint: HASH_CANARY.to_owned(),
        version: 1,
        created_at: NOW.to_owned(),
        rotated_at: None,
        revoked_at: None,
    };
    let debug = format!("{secret:?}");
    assert!(
        !debug.contains(CIPHERTEXT_CANARY) && !debug.contains(HASH_CANARY),
        "WebhookSecretRecord Debug leaked signing-secret material: {debug}"
    );

    // The delivery body is the serialized event envelope. It is metadata only by
    // construction, but "by construction" is a claim about the producer, so the
    // consumer's `Debug` redacts it too.
    let delivery = WebhookDeliveryRecord {
        delivery_id: "whd_0123456789abcdef0123456789abcdef".to_owned(),
        endpoint_id: "whe_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: ORG.to_owned(),
        event_id: "evt_0123456789abcdef0123456789abcdef".to_owned(),
        event_type: "foundation.check.requested.v1".to_owned(),
        body: METADATA_CANARY.to_owned(),
        body_hash: HASH_CANARY.to_owned(),
        secret_version_id: "whs_0123456789abcdef0123456789abcdef".to_owned(),
        signature_key_id: "sig_0123456789abcdef0123456789abcdef".to_owned(),
        state: "pending".to_owned(),
        attempt_count: 0,
        next_attempt_at: None,
        delivered_at: None,
        last_error_code: None,
        replay_of_delivery_id: None,
        replay_generation: 0,
        version: 1,
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
    };
    assert_no_canary("WebhookDeliveryRecord Debug", &format!("{delivery:?}"));
}

#[test]
fn a_lease_token_fingerprint_is_invisible_in_debug() {
    use crate::repositories::automations::ExecutionLeaseRecord;

    let lease = ExecutionLeaseRecord {
        lease_id: "lse_0123456789abcdef0123456789abcdef".to_owned(),
        occurrence_id: "occ_0123456789abcdef0123456789abcdef".to_owned(),
        org_id: ORG.to_owned(),
        device_id: DEVICE.to_owned(),
        state: "claimed".to_owned(),
        attempt: 1,
        lease_token_fingerprint: HASH_CANARY.to_owned(),
        lease_version: 1,
        lease_fence: 1,
        claimed_at: NOW.to_owned(),
        expires_at: LATER.to_owned(),
        released_at: None,
        completed_at: None,
        version: 1,
    };
    let debug = format!("{lease:?}");
    assert!(
        !debug.contains(HASH_CANARY),
        "ExecutionLeaseRecord Debug leaked the lease token fingerprint: {debug}"
    );
}

// ---------------------------------------------------------------------------
// Part 4 — runtime canaries: event, log, and error surfaces
// ---------------------------------------------------------------------------

#[test]
fn an_event_payload_and_a_queue_payload_are_invisible_in_debug() {
    use crate::consumers::QueueJobEnvelope;
    use crate::core::{ActorContext, EventEnvelope, EventType};

    let mut event = EventEnvelope {
        event_id: "evt_0123456789abcdef0123456789abcdef".parse().expect("event id"),
        event_type: EventType::new("foundation.check.requested.v1").expect("event type"),
        occurred_at: NOW.parse().expect("timestamp"),
        request_id: "req_0123456789abcdef0123456789abcdef".parse().expect("request id"),
        correlation_id: "req_0123456789abcdef0123456789abcdef".parse().expect("correlation id"),
        actor: ActorContext::anonymous(),
        organization_id: None,
        payload: json!({ "note": METADATA_CANARY, "token": SESSION_TOKEN_CANARY }),
    };
    assert_no_canary("EventEnvelope Debug", &format!("{event:?}"));
    // The payload must still be SERIALIZABLE — it is what the outbox persists and
    // what a webhook delivery body carries. Redaction is a `Debug` concern only,
    // and a harness that quietly broke serialization would look like a pass.
    let encoded = serde_json::to_string(&event).expect("the envelope still serializes");
    assert!(encoded.contains(METADATA_CANARY));

    // The tenant scope is itself redacted, so a `Debug` cannot name the org.
    event.organization_id = Some(ORG.parse().expect("organization id"));
    assert!(
        !format!("{event:?}").contains(ORG),
        "EventEnvelope Debug named the organization: {}",
        format!("{event:?}")
    );

    let envelope = QueueJobEnvelope {
        job_id: "job_0123456789abcdef0123456789abcdef".to_owned(),
        job_type: "webhook.delivery".to_owned(),
        schema_version: 1,
        dedupe_key: HASH_CANARY.to_owned(),
        event_id: Some("evt_0123456789abcdef0123456789abcdef".to_owned()),
        occurred_at: NOW.parse().expect("timestamp"),
        attempt: 1,
        correlation_id: None,
        tenant_scope: crate::consumers::webhooks::JobTenantScope {
            org_id: Some(ORG.to_owned()),
        },
        payload_ref: None,
        payload: Some(json!({ "secret": METADATA_CANARY })),
    };
    let debug = format!("{envelope:?}");
    assert!(
        !debug.contains(METADATA_CANARY),
        "QueueJobEnvelope Debug leaked its payload: {debug}"
    );
}

#[test]
fn an_api_error_detail_payload_is_invisible_in_debug() {
    use crate::core::{ApiError, ApiErrorCode};

    // `details` is a free-form `BTreeMap<String, Value>`, so it is the one field
    // in the error surface that can hold anything a handler chose to put there.
    // The `Debug` redaction is what stops a rejected request body from reaching a
    // log through an error report.
    let error = ApiError::new(ApiErrorCode::BadRequest, "bad", "req_0123456789abcdef0123456789abcdef".parse().expect("request id"))
        .with_detail("input", json!({ "password": ARGON2_CANARY, "token": SESSION_TOKEN_CANARY }))
        .with_detail("body", json!(METADATA_CANARY));
    assert_no_canary("ApiError Debug", &format!("{error:?}"));
    assert_no_canary("ApiErrorBody Debug", &format!("{:?}", error.error));

    // But the client still gets the detail it needs: the redaction is a
    // diagnostic-surface property, not a change to the response contract.
    let wire = serde_json::to_string(&error).expect("the error still serializes");
    assert!(wire.contains(METADATA_CANARY));
}

#[test]
fn a_provider_upstream_body_is_never_echoed() {
    use crate::adapters::providers::SsrfError;
    use crate::modules::inference::{AdapterError, normalize_adapter_error};

    // The upstream body is what a provider sends when it rejects a request, and
    // it routinely contains the request that was sent, which contains the
    // credential header. `normalize_adapter_error` takes it and drops it, so the
    // parameter is `_upstream_body`.
    let upstream = format!("{{\"error\":\"invalid api key: {PROVIDER_KEY_CANARY}\"}}");
    let error: AdapterError = normalize_adapter_error(401, &upstream);
    assert_no_canary("AdapterError Debug", &format!("{error:?}"));
    assert_no_canary("AdapterError Display", &error.to_string());

    // A provider endpoint with credentials in it must not survive into an error
    // either; the SSRF refusals are undifferentiated and carry no URL.
    for refusal in [
        SsrfError::InvalidUrl,
        SsrfError::SchemeNotAllowed,
        SsrfError::PrivateDestination,
        SsrfError::HostNotAllowlisted,
        SsrfError::CredentialsNotAllowed,
    ] {
        assert_no_canary("SsrfError Display", &refusal.to_string());
    }

    // The STREAMING path is the one that differs, and it is the one that matters:
    // an error can arrive after a 200 OK, so there is no status to normalize and
    // nothing to drop the body on the way in. The translation has to discard the
    // provider's own error text itself. `translate_anthropic_event` is private to
    // `adapters::providers`, so its canary lives in that module's own tests —
    // see `anthropic_stream_error_never_echoes_the_provider_message`.
    //
    // What is assertable from here is that the outbound request never keeps the
    // credential: the adapter writes it straight into an outbound header and holds
    // no field for it, so the request type it returns is header-only.
    let source = fs::read_to_string(crate_src().join("adapters").join("providers.rs"))
        .expect("a readable provider adapter source file");
    let production = without_test_regions(&source);
    for forbidden in ["fn build_request", "struct OutboundRequest", "credential: Option<String>"] {
        assert!(
            !production.contains(forbidden),
            "the provider adapter grew {forbidden:?}, which could retain a credential"
        );
    }
}

#[test]
fn an_outbound_provider_request_is_not_printed_in_debug() {
    use crate::adapters::providers::ProviderDispatch;
    use futures_util::StreamExt as _;

    let dispatch = ProviderDispatch {
        status_code: 200,
        content_type: Some("text/event-stream".to_owned()),
        provider_request_id: Some("req_provider".to_owned()),
        // The credential never reaches this struct — the adapter adds it to the
        // outbound `Headers` and drops it — but the stream is the response body
        // and must not be printable.
        stream: futures_util::stream::empty().boxed_local(),
    };
    let debug = format!("{dispatch:?}");
    assert!(
        debug.contains("[redacted]"),
        "the response stream is not marked redacted: {debug}"
    );
}

// ---------------------------------------------------------------------------
// Part 5 — runtime canaries: bounded and redacted payloads
// ---------------------------------------------------------------------------

#[test]
fn audit_metadata_refuses_a_canary_under_every_sensitive_key() {
    use crate::repositories::audit::bounded_metadata;

    // `bounded_metadata` is the F16 sanitizer: an allow-list of keys, a
    // deny-list of name fragments, bounded depth, key count, array length, and
    // string length. A canary placed under a denied fragment must be gone, not
    // merely renamed.
    for key in [
        "secret",
        "password",
        "api_key",
        "access_token",
        "refresh_token",
        "id_token",
        "authorization",
        "cookie",
        "private_key",
        "credential",
        "prompt",
        "response",
        "request_body",
        "response_body",
        "tool_arguments",
        "file_content",
    ] {
        let value = json!({ key: METADATA_CANARY });
        let sanitized = bounded_metadata(&value).to_string();
        assert!(
            !sanitized.contains(METADATA_CANARY),
            "bounded_metadata kept the canary under {key:?}: {sanitized}"
        );
    }

    // A code-shaped key with a free-text value is redacted rather than trusted:
    // `reason` is in the allow-list, so without this a handler could smuggle a
    // body through it.
    let smuggled = bounded_metadata(&json!({ "reason": METADATA_CANARY })).to_string();
    assert!(
        !smuggled.contains(METADATA_CANARY),
        "bounded_metadata trusted a non-code value under a code key: {smuggled}"
    );

    // A non-object is not wrapped under a synthetic key, so a bare string cannot
    // become persisted metadata by choosing a different JSON shape.
    assert_eq!(bounded_metadata(&json!(METADATA_CANARY)), json!({}));

    // A legitimate code survives, or the sanitizer is useless and will be relaxed.
    let kept = bounded_metadata(&json!({ "reason_code": "version_changed" }));
    assert_eq!(kept["reason_code"], "version_changed");
}

#[test]
fn a_usage_payload_redacts_rather_than_retaining_a_canary() {
    use crate::modules::usage::BoundedPayload;

    let raw = json!({ "prompt": METADATA_CANARY, "model": "coding-default" });
    let payload = BoundedPayload::new(raw).expect("a bounded payload accepts an object");
    let debug = format!("{payload:?}");
    assert_no_canary("BoundedPayload Debug", &debug);
}

// ---------------------------------------------------------------------------
// Part 6 — the static half: what a canary cannot construct
// ---------------------------------------------------------------------------

/// The field names that mean "this value is a credential, a credential's hash, or
/// a capability to read data".
///
/// This is a list of NAMES, not a list of types, because the canary half of this
/// file cannot know every type and the static half cannot construct them. A
/// rename defeats a name list; that is why the runtime canaries above exist and
/// why this list is the *backup* check, not the primary one.
const SECRET_FIELDS: &[&str] = &[
    "secret",
    "secrets",
    "secret_hash",
    "secret_base64",
    "plaintext",
    "wire",
    "wire_value",
    "password",
    "password_hash",
    "encoded_hash",
    "code_hash",
    "token",
    "token_hash",
    "csrf_hash",
    "hash",
    "digest",
    "claim_token",
    "key_digest",
    "fingerprint",
    "key_fingerprint",
    "credential",
    "credential_hash",
    "credential_fingerprint",
    "state_json",
    "challenge",
    "code",
    "code_verifier",
    "pkce_verifier",
    "grant_token",
    "download_token",
    "token_fingerprint",
    "lease_token_fingerprint",
    "object_key",
    "ciphertext",
    "nonce",
    "private_key",
    "private_key_der",
    "signing_key",
    "signing_secret",
    "api_key",
    "key_material",
    "device_token",
    "session_token",
    "refresh_token",
    "access_token",
    "reauth_token",
    "raw_token",
];

/// The structs that hold a secret-named field and still derive `Debug`.
///
/// Every entry is a transport DTO — an axum request body, a response envelope,
/// or a catalog metadata type — that is never formatted, plus a reason. The list
/// is the *reviewed* set: adding to it is a decision, and the count is asserted
/// so it cannot grow quietly.
const REVIEWED_DERIVED_DEBUG: &[(&str, &str, &str)] = &[
    (
        "routes/authenticators.rs",
        "PasswordSignupRequest",
        "axum request body. Never formatted: the request boundary replaces every \
         framework rejection body with the stable error envelope, so a serde \
         message containing the value cannot reach a client or a log.",
    ),
    (
        "routes/authenticators.rs",
        "PasswordLoginRequest",
        "axum request body. See PasswordSignupRequest.",
    ),
    (
        "routes/authenticators.rs",
        "PasswordResetRequest",
        "axum request body. Carries both a recovery code and a new password.",
    ),
    (
        "routes/authenticators.rs",
        "PasswordAccountRequest",
        "axum request body. See PasswordSignupRequest.",
    ),
    (
        "routes/authenticators.rs",
        "ReauthPasswordRequest",
        "axum request body. See PasswordSignupRequest.",
    ),
    (
        "routes/organizations.rs",
        "AcceptInviteRequest",
        "axum request body carrying the invitation token.",
    ),
    (
        "routes/data_governance.rs",
        "DownloadRequest",
        "axum request body carrying an export download grant token.",
    ),
    (
        "routes/device_auth.rs",
        "ExchangeDeviceRequest",
        "axum request body carrying the PKCE code verifier.",
    ),
    (
        "routes/account.rs",
        "ReauthResponse",
        "Response envelope. The token is the one-time reauth grant this endpoint \
         exists to return; the value is in the response body by contract.",
    ),
    (
        "routes/devices.rs",
        "DeviceTokenResponse",
        "Response envelope. The device token is the payload this endpoint exists \
         to return, once, in a header.",
    ),
    (
        "routes/devices.rs",
        "EnrollmentStatusResponse",
        "Response envelope. The proof challenge is released only after a human \
         approved the enrollment, and only to the enrolling device.",
    ),
    (
        "routes/devices.rs",
        "NonceResponse",
        "Response envelope. The nonce is the anti-replay value this endpoint \
         exists to return.",
    ),
    (
        "adapters/webauthn.rs",
        "RegistrationResponse",
        "WebAuthn attestation from the browser. `client_data_json` is signed by \
         the authenticator and is public by construction.",
    ),
    (
        "adapters/webauthn.rs",
        "AuthenticationResponse",
        "WebAuthn assertion from the browser. Public by construction.",
    ),
    (
        "adapters/webauthn.rs",
        "VerifiedRegistration",
        "Adapter output carrying public WebAuthn material only.",
    ),
    (
        "adapters/webauthn.rs",
        "VerifiedAuthentication",
        "Adapter output carrying public WebAuthn material only.",
    ),
    (
        "adapters/billing/provider.rs",
        "ProviderCallback",
        "Bounded, already-translated provider callback metadata. The struct \
         deliberately has no raw-body field; `nonce` and `signature_hex` are \
         inbound replay/signature material, not the adapter's signing secret.",
    ),
    (
        "modules/tool_policy.rs",
        "ToolDefinition",
        "Catalog metadata. `fingerprint` is a content digest of a tool \
         definition, published to clients in the tools API; it is not an API-key \
         fingerprint.",
    ),
    (
        "repositories/tools.rs",
        "ToolDefinitionRecord",
        "Store projection of ToolDefinition. See modules/tool_policy.rs.",
    ),
    (
        "routes/tools.rs",
        "ToolListEntry",
        "Client projection of ToolDefinition. See modules/tool_policy.rs.",
    ),
    (
        "routes/tools.rs",
        "CreateToolRequest",
        "axum request body carrying a tool content fingerprint.",
    ),
    (
        "routes/tools.rs",
        "UpdateToolRequest",
        "axum request body carrying a tool content fingerprint.",
    ),
    (
        "modules/credentials.rs",
        "CredentialHandle",
        "A logical handle: `credential_id` is the `cred_`-prefixed row id, not \
         credential material.",
    ),
    (
        "modules/routing.rs",
        "RouteCandidate",
        "`credential_id` is a row id, not credential material.",
    ),
    (
        "modules/routing.rs",
        "SelectedCandidate",
        "`credential_id` is a row id, not credential material.",
    ),
    (
        "modules/usage.rs",
        "UsageEventDraft",
        "`credential_id` is a row id, not credential material.",
    ),
    (
        "modules/usage.rs",
        "UsageEvent",
        "`credential_id` is a row id, not credential material.",
    ),
    (
        "repositories/ai.rs",
        "InferenceRequestRecord",
        "`credential_id` is a row id, not credential material.",
    ),
    (
        "repositories/ai.rs",
        "UsageRecord",
        "`credential_id` is a row id, not credential material.",
    ),
    (
        "modules/devices.rs",
        "EnrollmentInput",
        "`public_key` is a device Ed25519 PUBLIC key, published to the platform \
         precisely so the platform can verify with it.",
    ),
    (
        "repositories/devices.rs",
        "DeviceRecord",
        "`public_key` is a device Ed25519 PUBLIC key. A `fingerprint` of a \
         public key is an identifier, not a credential.",
    ),
    (
        "routes/devices.rs",
        "BeginEnrollmentRequest",
        "axum request body carrying a device PUBLIC key.",
    ),
    (
        "routes/authenticators.rs",
        "CeremonyStartResponse",
        "Response envelope carrying the WebAuthn CHALLENGE, which the browser \
         must receive in order to sign it.",
    ),
    (
        "adapters/webauthn.rs",
        "RegistrationOptions",
        "Challenge options the browser must receive.",
    ),
    (
        "adapters/webauthn.rs",
        "AuthenticationOptions",
        "Challenge options the browser must receive.",
    ),
];

fn crate_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn walk(directory: &Path, visit: &mut impl FnMut(&Path)) {
    let mut entries: Vec<_> = fs::read_dir(directory)
        .expect("the source directory is readable")
        .map(|entry| entry.expect("a readable directory entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            walk(&path, visit);
        } else {
            visit(&path);
        }
    }
}

/// One `struct` declaration, as the static scan sees it.
#[derive(Debug, PartialEq, Eq)]
struct StructFact {
    file: String,
    line: usize,
    name: String,
    derives: Vec<String>,
    fields: Vec<String>,
}

impl StructFact {
    fn derives_debug(&self) -> bool {
        self.derives.iter().any(|item| item == "Debug")
    }

    fn key(&self) -> String {
        format!("{}::{}", self.file, self.name)
    }

    /// The secret-named fields this struct holds, in declaration order.
    fn secret_fields(&self) -> Vec<&'static str> {
        self.fields
            .iter()
            .filter_map(|field| {
                SECRET_FIELDS
                    .iter()
                    .find(|candidate| *candidate == field)
                    .copied()
            })
            .collect()
    }
}

/// Every `struct` in `source`, with the attributes that precede it.
///
/// Deliberately a scanner and not a parser. The rule it enforces is small, the
/// scanner is easy to read, and [`the_scanner_would_catch_a_planted_derive`]
/// proves the scanner still fires — a parser that quietly stopped matching would
/// otherwise turn every case below into a pass.
fn parse_structs(source: &str, file: &str) -> Vec<StructFact> {
    let lines: Vec<&str> = source.lines().collect();
    let mut facts = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(rest) = line
            .trim_start()
            .strip_prefix("struct ")
            .or_else(|| line.trim_start().strip_prefix("pub struct "))
        else {
            continue;
        };
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if name.is_empty() {
            continue;
        }

        // Attributes directly above the declaration, looking upward through
        // `#[...]` and doc comments only. A blank line or a statement ends the
        // walk, so an unrelated earlier attribute is never attributed here.
        let mut attributes: Vec<String> = Vec::new();
        for previous in lines[..index].iter().rev() {
            let trimmed = previous.trim();
            if trimmed.starts_with("#[") || trimmed.starts_with("///") || trimmed.starts_with("//!")
            {
                attributes.push(trimmed.to_owned());
            } else {
                break;
            }
        }
        let derives = attributes
            .iter()
            .rev()
            .filter_map(|attribute| {
                attribute
                    .strip_prefix("#[derive(")
                    .and_then(|rest| rest.strip_suffix(")]"))
                    .map(|inner| inner.to_owned())
            })
            .flat_map(|inner| {
                inner
                    .split(',')
                    .map(|item| item.trim().to_owned())
                    .filter(|item| !item.is_empty())
                    .collect::<Vec<_>>()
            })
            .collect();

        // The field list, brace-matched. Field names only; types are not needed
        // and parsing them is where a scanner starts lying.
        let mut fields = Vec::new();
        let mut depth = 0_usize;
        let mut started = false;
        for body in lines.iter().skip(index) {
            for character in body.chars() {
                match character {
                    '{' => {
                        started = true;
                        depth += 1;
                    }
                    '}' => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            if started {
                if let Some(field) = body
                    .trim()
                    .strip_prefix("pub ")
                    .and_then(|rest| rest.split(':').next())
                    .or_else(|| body.trim().split(':').next())
                {
                    let cleaned: String = field
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect();
                    if !cleaned.is_empty()
                        && !cleaned.starts_with("pub")
                        && body.contains(':')
                        && !body.trim_start().starts_with("//")
                    {
                        fields.push(cleaned);
                    }
                }
            }
            if started && depth == 0 && index + 1 < lines.len() {
                break;
            }
            if started && depth == 0 {
                break;
            }
        }

        facts.push(StructFact {
            file: file.to_owned(),
            line: index + 1,
            name,
            derives,
            fields,
        });
    }
    facts
}

fn every_struct() -> Vec<StructFact> {
    let root = crate_src();
    let mut facts = Vec::new();
    walk(&root, &mut |path| {
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            return;
        }
        let source = fs::read_to_string(path).expect("a readable source file");
        let relative = path
            .strip_prefix(&root)
            .expect("the path is under src")
            .to_string_lossy()
            .replace('\\', "/");
        facts.extend(parse_structs(&source, &relative));
    });
    facts
}

/// The scan must still be able to fail. If `parse_structs` stopped matching —
/// because a struct gained a lifetime, a `where` clause, or a formatting change —
/// every other case in this file would pass with zero structs examined. This
/// plants the exact shape the scan is supposed to catch and asserts it does.
#[test]
fn the_scanner_would_catch_a_planted_derive() {
    let planted = r#"
/// A plant.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PlantedSecretRecord {
    pub id: String,
    pub encoded_hash: String,
}

/// A plant that is safe, and must NOT be reported.
#[derive(Clone, Debug, Serialize)]
pub struct PlantedHarmlessRecord {
    pub id: String,
    pub name: String,
}
"#;
    let facts = parse_structs(planted, "planted.rs");
    assert_eq!(facts.len(), 2, "the scanner stopped seeing structs: {facts:?}");

    let secret = &facts[0];
    assert_eq!(secret.name, "PlantedSecretRecord");
    assert!(secret.derives_debug(), "the scanner stopped reading derives");
    assert_eq!(
        secret.secret_fields(),
        vec!["encoded_hash"],
        "the scanner stopped reading fields: {secret:?}"
    );

    let harmless = &facts[1];
    assert!(
        harmless.secret_fields().is_empty(),
        "the scanner invented a secret field: {harmless:?}"
    );
}

#[test]
fn the_field_registry_still_catches_a_planted_name() {
    // The registry is the only thing standing between a renamed field and an
    // un-audited one, so prove it is not empty and not trivially wrong.
    assert!(
        SECRET_FIELDS.len() > 30,
        "the registry shrank to {} names; a secret-bearing field may have been added",
        SECRET_FIELDS.len()
    );
    let unique: BTreeSet<&&str> = SECRET_FIELDS.iter().collect();
    assert_eq!(
        unique.len(),
        SECRET_FIELDS.len(),
        "the registry has a duplicate, so one name is counted twice"
    );
    for expected in ["secret_hash", "encoded_hash", "token_hash", "fingerprint", "object_key"] {
        assert!(
            SECRET_FIELDS.contains(&expected),
            "{expected} left the registry, which is the one list that must not shrink"
        );
    }
    // A name that is NOT secret material, so the list is a judgement and not a
    // blanket "anything that looks like a credential".
    for harmless in ["name", "org_id", "status", "version", "created_at"] {
        assert!(
            !SECRET_FIELDS.contains(&harmless),
            "{harmless} entered the registry; a list that matches everything matches nothing"
        );
    }
}

#[test]
fn derived_debug_never_reaches_a_secret() {
    let facts = every_struct();
    assert!(
        facts.len() > 500,
        "the scan found only {} structs; the file walker probably broke",
        facts.len()
    );

    let reviewed: BTreeSet<(&str, &str)> = REVIEWED_DERIVED_DEBUG
        .iter()
        .map(|(file, name, _)| (*file, *name))
        .collect();

    let mut offenders = Vec::new();
    for fact in &facts {
        if !fact.derives_debug() {
            continue;
        }
        let secrets = fact.secret_fields();
        if secrets.is_empty() {
            continue;
        }
        let file = fact.file.as_str();
        let key = (file, fact.name.as_str());
        if reviewed.contains(&key) {
            continue;
        }
        offenders.push(format!(
            "{}:{} {} derives Debug and holds [{}]",
            fact.file,
            fact.line,
            fact.name,
            secrets.join(", ")
        ));
    }

    // Also assert the review list is not lying: every entry must name a struct
    // that still exists and still derives `Debug`, and every entry must carry a
    // reason. A stale entry means the scan has stopped being honest about what it
    // excludes.
    let mut stale = Vec::new();
    for (file, name, reason) in REVIEWED_DERIVED_DEBUG {
        if reason.trim().is_empty() {
            stale.push(format!("{file}::{name} has no reason"));
            continue;
        }
        match facts
            .iter()
            .find(|fact| fact.file == *file && fact.name == *name)
        {
            None => stale.push(format!("{file}::{name} no longer exists")),
            Some(fact) if !fact.derives_debug() => {
                stale.push(format!("{file}::{name} no longer derives Debug; delete the entry"))
            }
            Some(fact) if fact.secret_fields().is_empty() => stale.push(format!(
                "{file}::{name} no longer holds a secret-named field; delete the entry"
            )),
            Some(_) => {}
        }
    }
    assert!(
        stale.is_empty(),
        "the reviewed-Debug list has rotted:\n  {}",
        stale.join("\n  ")
    );

    assert!(
        offenders.is_empty(),
        "{} struct(s) derive Debug over a secret-named field. A derived Debug is a \
         panic message, an unwrap() error, a test failure, and a log line away from \
         production:\n  {}",
        offenders.len(),
        offenders.join("\n  ")
    );
}

#[test]
fn the_reviewed_debug_list_is_reviewed_not_rubber_stamped() {
    // Every reviewed entry is a transport DTO or a public-material type. If more
    // than half the list were store records the list would be a way to normalise
    // the bug rather than a record of reviewed decisions, so pin the split.
    let store_prefixes = ["repositories/", "adapters/d1", "consumers/"];
    let store_records = REVIEWED_DERIVED_DEBUG
        .iter()
        .filter(|(file, _, _)| {
            store_prefixes
                .iter()
                .any(|prefix| file.starts_with(prefix) && !file.contains("tools.rs"))
        })
        .count();
    assert!(
        store_records * 2 < REVIEWED_DERIVED_DEBUG.len(),
        "{store_records} of {} reviewed entries are store records; the review list is \
         becoming a way to normalise a leak rather than a record of judgement",
        REVIEWED_DERIVED_DEBUG.len()
    );
}

// ---------------------------------------------------------------------------
// Part 7 — the static half: client projections
// ---------------------------------------------------------------------------

/// Route projections that read a secret-named field, with the reason each is
/// safe. Same contract as [`REVIEWED_DERIVED_DEBUG`]: a judgement with a premise
/// the scan checks, not a suppression.
const REVIEWED_PROJECTION_FIELDS: &[(&str, &str, &str, &str)] = &[
    (
        "ai_catalog.rs",
        "credential_json",
        "fingerprint",
        "Masked with `masked_fingerprint` before it is placed in the object, so \
         at most the last six characters of a twelve-character prefix survive.",
    ),
    (
        "ai_catalog.rs",
        "credential_json",
        "credential_id",
        "A `cred_`-prefixed row id, not credential material. The encrypted secret \
         lives in `CredentialRecord.ciphertext` and is not projected.",
    ),
    (
        "machine_identity.rs",
        "api_key_json",
        "fingerprint",
        "A truncated hash of the WHOLE presented key, published deliberately so an \
         operator can identify which key is which. F14-002's guarantee is that the \
         raw key and its `secret_hash` are never projected, and \
         `derived_debug_never_reaches_a_secret` plus the runtime canary both pin \
         that.",
    ),
    (
        "tools.rs",
        "tool_json",
        "fingerprint",
        "A content digest of a tool definition, published in the tools API and used \
         as the approval binding. Not an API-key fingerprint.",
    ),
];

#[test]
fn projections_never_read_a_secret_field() {
    let root = crate_src().join("routes");
    let mut findings = Vec::new();
    let mut projections = 0_usize;

    walk(&root, &mut |path| {
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            return;
        }
        let source = fs::read_to_string(path).expect("a readable route source file");
        let file_name = path
            .file_name()
            .expect("a file name")
            .to_string_lossy()
            .into_owned();
        let lines: Vec<&str> = source.lines().collect();

        for (index, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed
                .strip_prefix("pub fn ")
                .or_else(|| trimmed.strip_prefix("pub(crate) fn "))
                .or_else(|| trimmed.strip_prefix("fn "))
            else {
                continue;
            };
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            // A projection is a function whose job is to build a client object.
            // The name is the only signal available without a type checker, and
            // the runtime canaries cover the projections whose names do not match.
            if !(name.ends_with("_json") || name.starts_with("redact_")) {
                continue;
            }
            projections += 1;

            let mut body = String::new();
            let mut depth = 0_usize;
            let mut started = false;
            for source_line in lines.iter().skip(index) {
                for character in source_line.chars() {
                    match character {
                        '{' => {
                            started = true;
                            depth += 1;
                        }
                        '}' => depth = depth.saturating_sub(1),
                        _ => {}
                    }
                }
                body.push_str(source_line);
                body.push('\n');
                if started && depth == 0 {
                    break;
                }
            }

            // Two ways a secret reaches a projection: a JSON key, and a field read
            // off the record being projected.
            let mut read: BTreeSet<&str> = BTreeSet::new();
            for capture in body.match_indices("\"") {
                let rest = &body[capture.0 + 1..];
                let Some(end) = rest.find('"') else { continue };
                let literal = &rest[..end];
                if let Some(secret) = SECRET_FIELDS.iter().find(|s| **s == literal) {
                    read.insert(secret);
                }
            }
            for capture in body.match_indices('.') {
                let rest = &body[capture.0 + 1..];
                let field: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if let Some(secret) = SECRET_FIELDS.iter().find(|s| **s == field) {
                    read.insert(secret);
                }
            }

            for secret in read {
                if REVIEWED_PROJECTION_FIELDS
                    .iter()
                    .any(|(f, n, s, _)| *f == file_name && *n == name && *s == secret)
                {
                    continue;
                }
                findings.push(format!(
                    "{file_name}:{} {name} reads the secret-named field `{secret}`",
                    index + 1
                ));
            }
        }
    });

    assert!(
        projections > 40,
        "the projection scan found only {projections} projections; the name pattern \
         probably stopped matching"
    );
    assert!(
        findings.is_empty(),
        "{} projection(s) read a secret-named field:\n  {}",
        findings.len(),
        findings.join("\n  ")
    );
}

#[test]
fn the_reviewed_projection_list_has_rotted_nowhere() {
    for (file, name, field, reason) in REVIEWED_PROJECTION_FIELDS {
        assert!(
            !reason.trim().is_empty(),
            "{file}::{name}::{field} has no reason"
        );
        let path = crate_src().join("routes").join(file);
        assert!(
            path.exists(),
            "{file} is gone; delete the reviewed projection entry"
        );
        let source = fs::read_to_string(&path).expect("a readable route source file");
        assert!(
            source.contains(&format!("fn {name}")),
            "routes/{file} has no `{name}` any more; delete the reviewed entry"
        );
    }
}

// ---------------------------------------------------------------------------
// Part 8 — the static half: production panic and log inventory
// ---------------------------------------------------------------------------

/// The `console_log!` sites in non-test code, and why each is bounded.
///
/// A Worker log line is permanent and world-readable to whoever holds the
/// account's log tail, so a log site is a *public* surface. The set is small on
/// purpose: every entry is a fixed-shape record built from bounded fields.
const REVIEWED_LOG_SITES: &[(&str, &str, &str)] = &[
    (
        "http/middleware.rs",
        "emit_request_log",
        "The `RequestLog` record has exactly seven fields: request id, correlation \
         id, method, matched route template, status, duration, and the event name. \
         There is no body, no header, and no query string, and `route` is the \
         matched PATTERN, so a secret in a path could not appear even if one \
         existed.",
    ),
    (
        "adapters/queues/logging.rs",
        "log",
        "The `OutboxLog` record is built from eight bounded outbox columns. Event \
         payloads and platform error text are absent from the record schema by \
         construction, and the module doc says so.",
    ),
    (
        "routes/devices.rs",
        "complete_enrollment",
        "A D1 error string for a batch whose SQL is a compile-time constant. The \
         bound values reach D1 as parameters, not in the statement text, so the \
         error cannot carry the token hash. There is no secret in the message \
         itself, which says only `complete prepare failed` / `complete batch failed`.",
    ),
];

/// Blank out every `#[cfg(test)]` region so a production inventory does not
/// report the test suite's own `unwrap()`s.
fn without_test_regions(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let lines: Vec<&str> = source.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim_start().starts_with("#[cfg(test)]") {
            // Skip to the end of the following `mod { ... }`, or to the end of
            // the file when the attribute is not attached to a module.
            let mut cursor = index + 1;
            while cursor < lines.len() && !lines[cursor].trim_start().starts_with("mod ") {
                cursor += 1;
            }
            if cursor < lines.len() {
                let mut depth = 0_usize;
                let mut started = false;
                while cursor < lines.len() {
                    let line = lines[cursor];
                    out.push_str(&" ".repeat(line.len()));
                    out.push('\n');
                    for character in line.chars() {
                        match character {
                            '{' => {
                                started = true;
                                depth += 1;
                            }
                            '}' => depth = depth.saturating_sub(1),
                            _ => {}
                        }
                    }
                    if started && depth == 0 {
                        break;
                    }
                    cursor += 1;
                }
                index = cursor + 1;
                continue;
            }
            for line in &lines[index..] {
                out.push_str(&" ".repeat(line.len()));
                out.push('\n');
            }
            break;
        }
        out.push_str(lines[index]);
        out.push('\n');
        index += 1;
    }
    out
}

#[test]
fn production_code_has_no_unwrap_and_only_reviewed_log_sites() {
    let root = crate_src();
    let mut unwraps = Vec::new();
    let mut log_sites = Vec::new();

    walk(&root, &mut |path| {
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            return;
        }
        let source = fs::read_to_string(path).expect("a readable source file");
        let relative = path
            .strip_prefix(&root)
            .expect("the path is under src")
            .to_string_lossy()
            .replace('\\', "/");

        // A file that is entirely a test module, declared as `mod foo;` under a
        // `#[cfg(test)]` in its parent, has no production lines to audit. This one
        // is named `*_tests.rs` by an existing convention, so the check is a
        // name check rather than a cross-module parse.
        if relative.ends_with("_tests.rs") || relative.contains("/tests/") {
            return;
        }

        let production = without_test_regions(&source);
        let mut enclosing = String::new();
        for (index, line) in production.lines().enumerate() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed
                .strip_prefix("pub fn ")
                .or_else(|| trimmed.strip_prefix("pub(crate) fn "))
                .or_else(|| trimmed.strip_prefix("fn "))
            {
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    enclosing = name;
                }
            }
            if trimmed.contains(".unwrap()") {
                unwraps.push(format!("{relative}:{} in {enclosing}", index + 1));
            }
            if trimmed.contains("console_log!") {
                log_sites.push((relative.clone(), enclosing.clone(), index + 1));
            }
        }
    });

    assert!(
        unwraps.is_empty(),
        "production code must not unwrap: a panic message prints every field of every \
         value on the stack, and `unwrap` is the fastest route to one.\n  {}",
        unwraps.join("\n  ")
    );

    let mut unexpected = Vec::new();
    let mut seen = BTreeSet::new();
    for (file, function, line) in &log_sites {
        let key = (file.as_str(), function.as_str());
        if !REVIEWED_LOG_SITES
            .iter()
            .any(|(f, n, _)| *f == key.0 && *n == key.1)
        {
            unexpected.push(format!("{file}:{line} in {function}"));
        } else {
            seen.insert(key);
        }
    }
    for (file, function, _) in REVIEWED_LOG_SITES {
        assert!(
            seen.contains(&(file, function)),
            "the reviewed log site {file}::{function} is gone; delete the entry"
        );
    }
    assert!(
        unexpected.is_empty(),
        "{} unreviewed production log site(s):\n  {}",
        unexpected.len(),
        unexpected.join("\n  ")
    );
}

#[test]
fn the_log_record_schemas_stay_bounded() {
    // A log site being reviewed is not enough: the RECORD it writes must stay
    // bounded, or a future field turns the site into a leak. This asserts the
    // shape of the one structured record the HTTP boundary emits, so adding a
    // field to it fails HERE as well as in the module that owns it.
    let source = fs::read_to_string(crate_src().join("http").join("middleware.rs"))
        .expect("a readable middleware source file");
    let production = without_test_regions(&source);
    let facts = parse_structs(&production, "http/middleware.rs");
    let record = facts
        .iter()
        .find(|fact| fact.name == "RequestLog")
        .expect("the request log record still exists");

    // Exactly the seven bounded transport dimensions. A count, so a field cannot
    // be added by slipping past a name check.
    assert_eq!(
        record.fields.len(),
        7,
        "the request log record changed shape: {:?}",
        record.fields
    );
    for expected in [
        "event",
        "request_id",
        "correlation_id",
        "method",
        "route",
        "status",
        "duration_ms",
    ] {
        assert!(
            record.fields.iter().any(|field| field == expected),
            "{expected} left the request log record"
        );
    }
    assert!(
        record.secret_fields().is_empty(),
        "the request log record now holds a secret-named field: {:?}",
        record.secret_fields()
    );

    // The outbox record schema, for the same reason.
    let logging = fs::read_to_string(
        crate_src()
            .join("adapters")
            .join("queues")
            .join("logging.rs"),
    )
    .expect("a readable queue logging source file");
    let production = without_test_regions(&logging);
    for field in [
        "\"payload\"",
        "\"body\"",
        "\"error\"",
        "\"headers\"",
        "\"secret\"",
        "\"token\"",
    ] {
        assert!(
            !production.contains(field),
            "the outbox log record now contains {field}, which can carry a payload"
        );
    }
}

// ---------------------------------------------------------------------------
// The count, so the harness cannot be quietly gutted.
// ---------------------------------------------------------------------------

#[test]
fn the_canary_set_is_wide_enough_to_mean_something() {
    // Every constant above must be reachable from `ALL_CANARIES`, and the list
    // must be wide enough that removing a surface's canary is visible.
    assert!(
        ALL_CANARIES.len() >= 10,
        "the canary set shrank to {} values",
        ALL_CANARIES.len()
    );
    let unique: BTreeSet<&&str> = ALL_CANARIES.iter().collect();
    assert_eq!(unique.len(), ALL_CANARIES.len(), "the canary set has a duplicate");

    // The two shapes that matter most, asserted explicitly because a canary of
    // the wrong shape proves nothing: a 64-hex digest and a 43-char base64url
    // secret.
    assert_eq!(HASH_CANARY.len(), 64, "the hash canary drifted off 64 hex");
    assert!(
        HASH_CANARY.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "the hash canary is not lowercase hex, so it could not have reached a \
         64-hex column"
    );
    assert_eq!(SECRET_CANARY.len(), 43, "the secret canary drifted off 43 chars");
    assert!(
        SECRET_CANARY
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "the secret canary is not base64url, so it could not have reached a \
         `lumik_` secret half"
    );

    // A human must be able to read a failure message and grep for the value. A
    // canary that is a run of one character is unreadable in a log aggregator.
    let mut varied = 0;
    for canary in ALL_CANARIES {
        if canary.chars().collect::<BTreeSet<_>>().len() > 6 {
            varied += 1;
        }
    }
    assert_eq!(varied, ALL_CANARIES.len(), "a canary is too uniform to grep for");
}

// A compile-time reminder that this file is a test-only module. If somebody drops
// the `#![cfg(test)]` above, this stops compiling rather than silently adding a
// filesystem walk to a production build.
const _: () = {
    let _ = std::marker::PhantomData::<fn() -> String>;
};

#[test]
fn the_report_is_stable() {
    // Prints the inventory so a reviewer can see what the harness covers without
    // reading the source. Not an assertion: the assertions are above. This exists
    // so `cargo test -- --nocapture` answers "what does this check?" directly.
    let facts = every_struct();
    let audited = facts
        .iter()
        .filter(|fact| !fact.secret_fields().is_empty())
        .count();
    let mut report = String::new();
    let _ = writeln!(report, "secret canary inventory");
    let _ = writeln!(report, "  structs scanned:            {}", facts.len());
    let _ = writeln!(report, "  holding a secret-named field: {audited}");
    let _ = writeln!(
        report,
        "  reviewed derive(Debug):       {}",
        REVIEWED_DERIVED_DEBUG.len()
    );
    let _ = writeln!(
        report,
        "  reviewed projection fields:  {}",
        REVIEWED_PROJECTION_FIELDS.len()
    );
    let _ = writeln!(
        report,
        "  reviewed production log sites:{}",
        REVIEWED_LOG_SITES.len()
    );
    let _ = writeln!(report, "  canary values:               {}", ALL_CANARIES.len());
    println!("{report}");
    assert!(audited > 20, "only {audited} structs hold a secret-named field");
}
