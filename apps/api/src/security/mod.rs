//! Release-hardening audits that read the whole workspace (P09).
//!
//! These are deliberately host-only and deliberately *outside* the request path.
//! An audit that runs in production is an audit nobody runs before a release.
//!
//! Each module here answers one question a reviewer would otherwise have to take
//! on faith:
//!
//! - `tenant_audit` — can any statement reach another tenant's row?
//! - `secret_canary` — can any secret reach a log, a `Debug`, or a projection?
//! - `release_docs` — do the checked-in release documents still match the code?
//! - `actor_type_correspondence` — can the code write an `actor_type` the schema would refuse?
pub(crate) mod actor_type_correspondence;
pub(crate) mod release_docs;
pub(crate) mod secret_canary;
pub(crate) mod tenant_audit;
