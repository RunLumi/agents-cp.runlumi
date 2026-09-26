//! Client protocol and policy-schema compatibility (P08-CG).
//!
//! A local client that has never signed in still has to know whether the
//! control plane it just reached can talk to it. That is why this is the one
//! P08 question answered without an organization, without a session, and
//! without a device: F26 stage 0 is a supported product state, not a degraded
//! accident.
//!
//! The axes are deliberately separate. `protocol_major` is whether the two
//! binaries can exchange messages at all. `policy_schema_version` is whether
//! the control plane can still honour the shape of the policy a device already
//! holds — a client can be perfectly able to talk to the API and still be
//! carrying a policy snapshot this version refuses to enforce, and F26's
//! acceptance criterion "managed project policy cannot be bypassed by stale
//! local config" is exactly that case.

use serde::{Deserialize, Serialize};

/// Frozen contract version for this phase. Reported by `/api/v1/compatibility`
/// so a client can refuse to interpret a shape it was not written for.
pub const CONTRACT_VERSION: &str = "p08-cg-v1";

/// Client protocol majors this control plane speaks, ascending.
pub const SUPPORTED_CLIENT_PROTOCOLS: [i64; 1] = [1];

/// Policy schema versions this control plane can honour, ascending.
pub const SUPPORTED_POLICY_SCHEMA_VERSIONS: [i64; 1] = [1];

/// Frozen minimum client build for a managed session.
///
/// Distinct from the protocol major: a client can speak the current protocol and
/// still be missing a fix this control plane depends on. P03's per-organization
/// `min_client_version` override can be stricter, never looser.
pub const MIN_CLIENT_APP_VERSION: &str = "0.4.0";

/// The compatibility answer for one client, as a closed vocabulary.
///
/// `Blocked` does not exist. A client is never refused outright: the worst
/// answer this module can produce still leaves local-only operation available.
/// That is F26's entire promise — an old client keeps working locally — and
/// encoding it as a closed enum means a new failure mode has to be added
/// deliberately instead of appearing as an unhandled case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientCompatibility {
    /// Managed operations are permitted.
    Supported,
    /// The client is too old, or carries a policy the control plane no longer
    /// honours, for managed operations. Local-only is unaffected.
    UpgradeRequired,
    /// The client is newer than this control plane. Its local operation is
    /// unaffected; a managed session is not, because the control plane cannot
    /// know which of the client's messages it would be misreading.
    UnsupportedProtocol,
    /// The policy snapshot the client holds is outside the honoured range, but
    /// the client itself is current. A fresh snapshot fixes it.
    UnsupportedPolicySchema,
}

impl ClientCompatibility {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::UpgradeRequired => "upgrade_required",
            Self::UnsupportedProtocol => "protocol_unsupported",
            Self::UnsupportedPolicySchema => "policy_schema_unsupported",
        }
    }

    /// The stable `error.details.reason` a client sees for this answer. The web
    /// client maps the same strings to remediation copy, so the vocabulary is
    /// frozen on both sides of the wire.
    pub const fn reason(self) -> Option<&'static str> {
        match self {
            Self::Supported => None,
            Self::UpgradeRequired => Some("client_upgrade_required"),
            Self::UnsupportedProtocol => Some("client_protocol_unsupported"),
            Self::UnsupportedPolicySchema => Some("policy_schema_unsupported"),
        }
    }

    /// The client build that would resolve this answer, when one is declared.
    pub const fn min_app_version(self) -> Option<&'static str> {
        match self {
            Self::Supported | Self::UnsupportedPolicySchema => None,
            Self::UpgradeRequired | Self::UnsupportedProtocol => Some(MIN_CLIENT_APP_VERSION),
        }
    }

    pub const fn is_managed(self) -> bool {
        matches!(self, Self::Supported)
    }
}

/// How a client is allowed to operate right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DegradedMode {
    /// Full managed operation: org policy, org credentials, org budgets.
    Managed,
    /// Local-only. Local credentials, local tools, local automations, and local
    /// history, with no cloud state and no org policy applied.
    LocalOnly,
}

impl DegradedMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::LocalOnly => "local_only",
        }
    }
}

/// What a client told us about itself, already bounded by the transport.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientFingerprint {
    pub protocol_major: i64,
    pub policy_schema_version: i64,
    pub app_version: String,
}

impl ClientFingerprint {
    /// Build a fingerprint, rejecting out-of-range values rather than clamping
    /// them. A clamped `protocol_major` of 999 would compare as "newer than this
    /// control plane" and be refused — the same answer, but for the wrong
    /// reason, and the reason is what a support engineer reads.
    pub fn new(
        protocol_major: i64,
        policy_schema_version: i64,
        app_version: &str,
    ) -> Result<Self, InvalidFingerprint> {
        if !(1..=32).contains(&protocol_major)
            || !(1..=64).contains(&policy_schema_version)
            || app_version.is_empty()
            || app_version.len() > 32
            || !app_version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
        {
            return Err(InvalidFingerprint);
        }
        Ok(Self {
            protocol_major,
            policy_schema_version,
            app_version: app_version.to_owned(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidFingerprint;

/// One row of `client_compatibility_policies`.
///
/// The row is data rather than a constant so widening the supported range is a
/// reviewable migration instead of a deploy, but every range is defensively
/// collapsed here: a row whose minimum exceeds its maximum can only narrow
/// managed access, never grant it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibilityPolicy {
    pub sequence: i64,
    pub protocol_major: i64,
    pub min_protocol_major: i64,
    pub max_protocol_major: i64,
    pub min_policy_schema_version: i64,
    pub max_policy_schema_version: i64,
    pub local_only_eligible: bool,
    pub history_sync_eligible: bool,
}

impl CompatibilityPolicy {
    /// The frozen baseline. It must agree with the row seeded in
    /// `0016_p08_migration_adoption.sql`; [`baseline_matches_seed`] proves the
    /// two do not drift, because a compiled-in answer that disagreed with the
    /// stored one would make behaviour depend on whether storage was reachable.
    pub const fn baseline() -> Self {
        Self {
            sequence: 1,
            protocol_major: 1,
            min_protocol_major: 1,
            max_protocol_major: 1,
            min_policy_schema_version: 1,
            max_policy_schema_version: 1,
            local_only_eligible: true,
            history_sync_eligible: false,
        }
    }

    const fn effective_min_protocol(&self) -> i64 {
        if self.min_protocol_major < 1 {
            1
        } else {
            self.min_protocol_major
        }
    }

    const fn effective_max_protocol(&self) -> i64 {
        let low = self.effective_min_protocol();
        if self.max_protocol_major < low {
            low
        } else {
            self.max_protocol_major
        }
    }

    const fn effective_min_schema(&self) -> i64 {
        if self.min_policy_schema_version < 1 {
            1
        } else {
            self.min_policy_schema_version
        }
    }

    const fn effective_max_schema(&self) -> i64 {
        let low = self.effective_min_schema();
        if self.max_policy_schema_version < low {
            low
        } else {
            self.max_policy_schema_version
        }
    }

    /// Classify one client against this policy.
    ///
    /// Order matters, and it is the order of "can this be fixed at all". A
    /// client that is both too new and carrying an unhonoured policy is reported
    /// as `UnsupportedProtocol`, because no amount of re-issuing its policy
    /// fixes a client this control plane cannot talk to — and a remediation that
    /// cannot work is worse than none.
    pub fn evaluate(&self, client: &ClientFingerprint) -> CompatibilityVerdict {
        let state = if client.protocol_major > self.effective_max_protocol() {
            ClientCompatibility::UnsupportedProtocol
        } else if client.protocol_major < self.effective_min_protocol() {
            ClientCompatibility::UpgradeRequired
        } else if client.protocol_major != self.protocol_major {
            ClientCompatibility::UnsupportedProtocol
        } else if client.policy_schema_version > self.effective_max_schema() {
            ClientCompatibility::UnsupportedPolicySchema
        } else if client.policy_schema_version < self.effective_min_schema() {
            ClientCompatibility::UpgradeRequired
        } else {
            ClientCompatibility::Supported
        };
        CompatibilityVerdict { state }
    }

    /// Whether the optional history-sync stage may be requested (F26 stage 5).
    /// A separate switch from everything else: shipping stage 5 is a deliberate,
    /// reviewable change, not the absence of a check.
    pub const fn history_sync_allowed(&self) -> bool {
        self.history_sync_eligible
    }

    /// Whether the platform still treats an unevaluated client as a supported
    /// product state.
    ///
    /// This is a disclosure, not an authorization check, and the distinction is
    /// deliberate. A local-only client has no cloud authority at all: it holds no
    /// device token, so the only server-side enforcement that exists is "no
    /// managed authority", which is [`CompatibilityVerdict::managed_allowed`] and
    /// is unconditional. What the platform flag changes is what the product tells
    /// the user — a deployment that no longer supports unevaluated clients should
    /// say so, rather than silently letting someone run a client it cannot
    /// evaluate.
    pub const fn local_only_eligible(&self) -> bool {
        self.local_only_eligible
    }
}

/// The full answer a client receives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompatibilityVerdict {
    pub state: ClientCompatibility,
}

impl CompatibilityVerdict {
    /// Managed operations are permitted only for a fully supported client.
    /// Enrollment, device tokens, policy fetch, workspace binding, and
    /// automation import are all managed operations, so a degraded client cannot
    /// obtain any of them and therefore cannot be adopted by accident.
    pub const fn managed_allowed(&self) -> bool {
        self.state.is_managed()
    }

    /// Local-only operation is available to every client, and this does not
    /// depend on the verdict.
    ///
    /// F26 stage 0 is a first-class product state: an existing local user's
    /// agent keeps running whether or not this control plane can evaluate it.
    /// The only thing a degraded client loses is org policy, org credentials, and
    /// org budgets — local state stays authoritative for local concerns
    /// (FR-F26-007). Nothing here can turn this off, which is what makes stage 0
    /// a guarantee rather than a setting.
    pub const fn local_only_available(&self) -> bool {
        true
    }

    /// The mode a client is allowed to use right now.
    pub const fn mode(&self) -> DegradedMode {
        if self.managed_allowed() {
            DegradedMode::Managed
        } else {
            DegradedMode::LocalOnly
        }
    }

    /// The stable `error.details.reason` for this verdict, or `None` when the
    /// client is supported and there is nothing to explain.
    pub const fn reason(self) -> Option<&'static str> {
        self.state.reason()
    }

    /// The client build that would resolve this verdict, when one is declared.
    pub const fn min_app_version(self) -> Option<&'static str> {
        self.state.min_app_version()
    }
}

/// The frozen ranges, reported by the public compatibility route.
///
/// Exposed separately from a verdict so a client can compare ranges itself
/// instead of trusting a single boolean, and so a mismatch is diagnosable from
/// one log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CompatibilityRanges {
    pub contract_version: &'static str,
    pub supported_protocols: &'static [i64],
    pub supported_policy_schema_versions: &'static [i64],
    pub min_client_app_version: &'static str,
    pub local_only_eligible: bool,
    pub history_sync_eligible: bool,
}

impl CompatibilityRanges {
    pub const fn from_policy(policy: &CompatibilityPolicy) -> Self {
        Self {
            contract_version: CONTRACT_VERSION,
            supported_protocols: &SUPPORTED_CLIENT_PROTOCOLS,
            supported_policy_schema_versions: &SUPPORTED_POLICY_SCHEMA_VERSIONS,
            min_client_app_version: MIN_CLIENT_APP_VERSION,
            local_only_eligible: policy.local_only_eligible(),
            history_sync_eligible: policy.history_sync_eligible,
        }
    }
}

/// The compiled-in baseline must agree with the seeded row, or a client that
/// reached the control plane while storage was unavailable would be told a
/// different compatibility answer than the same client gets normally.
pub const fn baseline_matches_seed() -> bool {
    let policy = CompatibilityPolicy::baseline();
    policy.protocol_major == 1
        && policy.min_protocol_major == 1
        && policy.max_protocol_major == 1
        && policy.min_policy_schema_version == 1
        && policy.max_policy_schema_version == 1
        && policy.local_only_eligible()
        && !policy.history_sync_allowed()
}
