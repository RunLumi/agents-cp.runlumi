use std::sync::Arc;

use axum::http::HeaderMap;
use serde_json::json;

use crate::{
    app::AppState,
    core::{ApiError, ApiErrorCode, Principal, RequestContext},
    http::auth::require_session,
    modules::authorization::{
        AuthorizationDecision, DenyReason, MembershipRole, MembershipSnapshot, MembershipStatus,
        OrganizationContext, OrganizationState, Permission, ResourceContext, authorize,
    },
    repositories::{MembershipRecord, OrganizationRecord, OrganizationRepository, SessionRecord},
    routes::{errors, support::database},
};

pub struct DeviceAccess {
    pub device: crate::repositories::DeviceRecord,
    #[allow(dead_code)]
    pub organization: OrganizationRecord,
    #[allow(dead_code)]
    pub membership: MembershipRecord,
}

/// Resolve a device-token request to one active organization and the current
/// membership of the user who enrolled the device. Device identity is never
/// accepted from a body or path; the token lookup supplies its scope.
pub(crate) async fn authorize_device(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    context: &RequestContext,
) -> Result<DeviceAccess, ApiError> {
    let device = crate::routes::devices::require_device(state, headers, context).await?;
    let database = database(state, context)?;
    let repository = OrganizationRepository::new(database);
    let organization = repository
        .find_organization(&device.org_id)
        .await
        .map_err(|_| service_unavailable(context))?
        .ok_or_else(|| inaccessible(context))?;
    let membership = repository
        .find_membership(&device.org_id, &device.enrolled_by_user_id)
        .await
        .map_err(|_| service_unavailable(context))?
        .ok_or_else(|| {
            errors::api_error(
                context,
                ApiErrorCode::PermissionDenied,
                "The device is no longer approved for this organization.",
            )
            .with_detail("reason", json!("device_not_approved"))
        })?;
    if membership.status != "active" {
        return Err(errors::api_error(
            context,
            ApiErrorCode::PermissionDenied,
            "The device is no longer approved for this organization.",
        )
        .with_detail("reason", json!("device_not_approved")));
    }
    if organization.state != "active" {
        return Err(errors::api_error(
            context,
            ApiErrorCode::PermissionDenied,
            "The organization is not active.",
        )
        .with_detail("reason", json!("organization_not_active")));
    }
    // The device's OWN lifecycle, checked here rather than per route.
    //
    // `DEVICE_TOKEN_BY_HASH_SQL` selects from `device_tokens` and does not join `devices`, so
    // nothing downstream of it can see a device's status: the token lookup answers "is this secret
    // live", not "is this device allowed to act". Revocation works today only because
    // `revoke_device` deletes the token rows in the same batch that sets `status = 'revoked'` --
    // one mechanism, with no second check, which is the fragility V01-016 recorded.
    //
    // That single coupling is what made V01-019 possible: `token_nonce` took no `HeaderMap` at
    // all, so it issued fresh server-generated secret material to anyone, and to a revoked device
    // too. Requiring a device here is necessary but not sufficient, so the status is checked as
    // well: a route that skips this helper must be the only remaining way in, and a device that
    // has been revoked must be refused by EVERY device route rather than by the one whose token
    // somebody remembered to delete.
    if device.status != "active" {
        // The SAME reason and message `load_active_device` already returns, so one fact has one
        // answer across the module. Two vocabularies for "this device was revoked" would let a
        // client treat a revoked device as differently broken depending on which route it reached
        // for, which is the V01-010 shape wearing a different hat.
        return Err(errors::api_error(
            context,
            ApiErrorCode::PermissionDenied,
            "The device has been revoked.",
        )
        .with_detail("reason", json!("device_revoked")));
    }
    Ok(DeviceAccess {
        device,
        organization,
        membership,
    })
}

pub struct OrgAccess {
    pub principal: Principal,
    pub organization: OrganizationRecord,
    pub membership: MembershipRecord,
    pub session: SessionRecord,
}

/// The only route-level bridge to the central policy service. It resolves the
/// current session and current membership, then makes one decision.
pub async fn authorize_org(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    context: &RequestContext,
    org_id: &str,
    permission: Permission,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
) -> Result<OrgAccess, ApiError> {
    if let Some(header_org) = headers
        .get("x-org-id")
        .and_then(|value| value.to_str().ok())
        && header_org != org_id
    {
        return Err(errors::api_error(
            context,
            ApiErrorCode::PermissionDenied,
            "The organization context does not match the requested resource.",
        )
        .with_detail("reason", json!("org_context_mismatch")));
    }
    let authenticated = require_session(state, headers, context).await?;
    let database = database(state, context)?;
    let repository = OrganizationRepository::new(database);
    let organization = repository
        .find_organization(org_id)
        .await
        .map_err(|_| service_unavailable(context))?
        .ok_or_else(|| inaccessible(context))?;
    let membership = repository
        .find_membership(org_id, authenticated.principal.user_id.as_str())
        .await
        .map_err(|_| service_unavailable(context))?
        .ok_or_else(|| inaccessible(context))?;
    let state_value = OrganizationState::parse(&organization.state)
        .ok_or_else(|| service_unavailable(context))?;
    let role =
        MembershipRole::parse(&membership.role).ok_or_else(|| service_unavailable(context))?;
    let status =
        MembershipStatus::parse(&membership.status).ok_or_else(|| service_unavailable(context))?;
    let organization_context = OrganizationContext {
        organization_id: crate::core::OrganizationId::new(org_id)
            .map_err(|_| inaccessible(context))?,
        state: state_value,
        version: organization.version,
    };
    let membership_snapshot = MembershipSnapshot {
        membership_id: crate::core::MembershipId::new(&membership.membership_id)
            .map_err(|_| service_unavailable(context))?,
        organization_id: organization_context.organization_id.clone(),
        user_id: authenticated.principal.user_id.clone(),
        role,
        status,
        version: membership.version,
    };
    let resource = resource_type.map(|resource_type| ResourceContext {
        resource_type: resource_type.to_owned(),
        resource_id: resource_id.unwrap_or_default().to_owned(),
        organization_id: organization_context.organization_id.clone(),
    });
    let decision = authorize(
        Some(&authenticated.principal),
        &organization_context,
        Some(&membership_snapshot),
        &permission,
        resource.as_ref(),
    );
    if let AuthorizationDecision::Deny(reason) = decision {
        return Err(denial(context, reason));
    }
    Ok(OrgAccess {
        principal: authenticated.principal,
        organization,
        membership,
        session: authenticated.session,
    })
}

pub fn denial(context: &RequestContext, reason: DenyReason) -> ApiError {
    let code = match reason {
        DenyReason::AuthenticationRequired => ApiErrorCode::AuthenticationRequired,
        DenyReason::EmailVerificationRequired
        | DenyReason::MembershipRequired
        | DenyReason::PermissionDenied
        | DenyReason::OrganizationSuspended
        | DenyReason::OrganizationPendingDeletion
        | DenyReason::ResourceScopeMismatch
        | DenyReason::StaleMembership
        | DenyReason::UnknownPermission
        | DenyReason::VersionConflict => ApiErrorCode::PermissionDenied,
        DenyReason::OrganizationDeleted => ApiErrorCode::NotFound,
    };
    let message = match reason {
        DenyReason::AuthenticationRequired => "Authentication is required.",
        DenyReason::EmailVerificationRequired => "Verify your email before continuing.",
        DenyReason::MembershipRequired => "An active organization membership is required.",
        DenyReason::PermissionDenied => "You do not have permission to perform this action.",
        DenyReason::OrganizationSuspended => "This organization is suspended.",
        DenyReason::OrganizationPendingDeletion => "This organization is pending deletion.",
        DenyReason::OrganizationDeleted => "The requested organization was not found.",
        DenyReason::ResourceScopeMismatch => {
            "The requested resource is outside the organization scope."
        }
        DenyReason::StaleMembership => {
            "The organization membership changed. Refresh and try again."
        }
        DenyReason::UnknownPermission | DenyReason::VersionConflict => {
            "The request is not permitted."
        }
    };
    errors::api_error(context, code, message).with_detail("reason", json!(reason.as_str()))
}

fn inaccessible(context: &RequestContext) -> ApiError {
    errors::api_error(
        context,
        ApiErrorCode::NotFound,
        "The requested resource was not found.",
    )
    .with_detail("reason", json!("resource_not_found"))
}

fn service_unavailable(context: &RequestContext) -> ApiError {
    errors::api_error(
        context,
        ApiErrorCode::ServiceUnavailable,
        "The identity store is unavailable.",
    )
}

#[cfg(test)]
mod v01_019_device_routes_must_authenticate {
    //! Every device route must take credentials, and a non-active device must be refused.
    //!
    //! `GET /api/v1/devices/token/nonce` shipped with **no `HeaderMap` parameter and no
    //! authentication call at all**, so it minted server-generated secret material for anonymous
    //! callers and for revoked devices. Its siblings in `app.rs` -- `/devices/token`,
    //! `/devices/heartbeat`, `/devices/policy`, `/devices/policy/ack` -- all require
    //! `Authorization: DeviceToken`, so the omission was invisible to every other gate.
    //!
    //! A test that pins *this route* would be worth little: the same omission in the next device
    //! route would pass. So this walks the ROUTER instead -- it reads `app.rs`, finds every route
    //! under `/api/v1/devices/` whose handler lives in `routes::devices`, and requires that handler
    //! to take a `HeaderMap`. A new device route added without credentials fails here, at compile
    //! time, with the path and the function name in the message.

    const APP: &str = include_str!("../app.rs");
    const DEVICES: &str = include_str!("devices.rs");

    /// The signature of a handler, as a run of text from `pub async fn NAME(` to its closing `)`.
    fn signature_of(src: &str, name: &str) -> Option<String> {
        let needle = format!("pub async fn {name}(");
        let start = src.find(&needle)?;
        let rest = &src[start + needle.len()..];
        let mut depth = 1usize;
        for (i, c) in rest.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(rest[..i].to_owned());
                    }
                }
                _ => {}
            }
        }
        None
    }

    #[test]
    fn every_device_route_handler_takes_credentials() {
        // Each entry is a (path, handler) pair the router binds under `/api/v1/devices/`.
        // `app.rs` writes some routes on one line and some across four, so a line-oriented
        // filter finds some of them and misses the rest -- and a check that finds some of what it
        // is looking for is worse than none, because the misses are silent. So: find each path
        // string, then read forward to the next `.route(` for the handlers bound to it.
        let mut device_routes: Vec<(String, String)> = Vec::new();
        let mut cursor = 0usize;
        while let Some(at) = APP[cursor..].find("\"/api/v1/devices/") {
            let path_start = cursor + at;
            let path_end = APP[path_start + 1..]
                .find('"')
                .map(|i| path_start + 1 + i)
                .expect("a device route path is always closed");
            let path = APP[path_start + 1..path_end].to_owned();
            let window_end = APP[path_end..]
                .find(".route(")
                .map(|i| path_end + i)
                .unwrap_or(APP.len());
            let window = &APP[path_end..window_end];
            for handler in window.match_indices("devices::").map(|(i, _)| {
                window[i + "devices::".len()..]
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect::<String>()
            }) {
                device_routes.push((path.clone(), handler));
            }
            cursor = path_end;
        }

        assert!(
            !device_routes.is_empty(),
            "no device routes were found in app.rs, so this test would pass having checked nothing"
        );

        let mut unauthenticated = Vec::new();
        for (path, handler) in &device_routes {
            // The enrollment ceremony is deliberately anonymous: a device that has no credential
            // yet is proving possession of its key, and that is the whole point of those routes.
            if path.contains("/enrollments") {
                continue;
            }
            // `refresh_token` is the one device route that authenticates by PROOF rather than by
            // bearer token: it takes a `device_id` in its body and a signature over a fresh nonce,
            // and refuses a revoked device with `device_revoked` from `load_active_device`. That is
            // a legitimate design -- it is how a device whose token has just expired gets a new one
            // -- so it is allow-listed here with its reason rather than forced to carry a header it
            // has no use for. Everything else must present credentials.
            if *handler == "refresh_token" {
                continue;
            }
            let Some(signature) = signature_of(DEVICES, handler) else {
                unauthenticated.push(format!("{path} -> devices::{handler} (handler not found)"));
                continue;
            };
            if !signature.contains("HeaderMap") {
                unauthenticated.push(format!("{path} -> devices::{handler}"));
            }
        }
        // Guard against the allow-list quietly swallowing the route it exists for: if
        // `refresh_token` ever stops being proof-authenticated, or is renamed, the exemption stops
        // applying and the route is checked like every other.
        assert!(
            signature_of(DEVICES, "refresh_token")
                .map(|s| !s.contains("HeaderMap"))
                .unwrap_or(false),
            "`refresh_token` now takes a HeaderMap, so the proof-of-possession exemption in this \
             test is stale. Remove the exemption rather than leaving it to hide a future omission."
        );
        assert!(
            unauthenticated.is_empty(),
            "every /api/v1/devices/ route must take credentials. These do not take a HeaderMap, so \
             they cannot read an Authorization header and therefore cannot authenticate: \
             {unauthenticated:?}. `GET /devices/token/nonce` shipped exactly this way (V01-019) and \
             issued server-generated secret material to anyone, including a revoked device."
        );
    }
}
