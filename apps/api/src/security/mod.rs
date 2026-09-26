//! Release-hardening audits that read the whole workspace (P09).
//!
//! These are deliberately host-only and deliberately *outside* the request path.
//! An audit that runs in production is an audit nobody runs before a release.
pub(crate) mod tenant_audit;
