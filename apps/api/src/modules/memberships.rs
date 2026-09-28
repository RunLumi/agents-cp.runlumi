use crate::modules::authorization::{MembershipRole, MembershipStatus};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvitationStatus {
    Pending,
    Accepted,
    Expired,
    Revoked,
}

impl InvitationStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "accepted" => Some(Self::Accepted),
            "expired" => Some(Self::Expired),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }
}

pub fn role_can_be_invited(role: MembershipRole) -> bool {
    matches!(
        role,
        MembershipRole::Admin | MembershipRole::Member | MembershipRole::Viewer
    )
}

/// Whether `actor_role` may set `target_current_role`'s membership to
/// `requested_role`.
///
/// The requested role is an **argument**, and that is the whole point of this
/// signature. An earlier version took only the target's *current* role, and the
/// only owner protection it could express was "an admin may not re-role somebody
/// who is already an owner" — nothing at all about *creating* an owner, because
/// the value being written never reached the decision. An admin could therefore
/// set `role: "owner"` on anyone, including itself, and mint unlimited
/// co-owners, walking past both the separate `org.ownership_transfer` permission
/// and the step-up security check that guards the transfer route.
///
/// Naming the parameter `target_current_role` rather than `target_role` is
/// deliberate: it makes the previous mistake a type error at the call site
/// instead of a silently wrong answer, which is the only durable defence against
/// wiring the wrong value into a four-argument predicate.
///
/// An owner may set any role on any active member, which keeps the last-owner
/// and ownership-transfer paths working. A non-owner admin may do neither: it may
/// not re-role an existing owner, and it may not create one.
pub fn can_change_role(
    actor_role: MembershipRole,
    target_current_role: MembershipRole,
    target_status: MembershipStatus,
    requested_role: MembershipRole,
) -> bool {
    target_status == MembershipStatus::Active
        && matches!(actor_role, MembershipRole::Owner | MembershipRole::Admin)
        && (actor_role == MembershipRole::Owner
            || (target_current_role != MembershipRole::Owner
                && requested_role != MembershipRole::Owner))
}

pub fn can_remove_member(actor_role: MembershipRole, target_role: MembershipRole) -> bool {
    matches!(actor_role, MembershipRole::Owner | MembershipRole::Admin)
        && (actor_role == MembershipRole::Owner || target_role != MembershipRole::Owner)
}

pub fn can_leave(actor_role: MembershipRole, active_owner_count: u32) -> bool {
    actor_role != MembershipRole::Owner || active_owner_count > 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_non_owner_roles_can_be_invited() {
        assert!(role_can_be_invited(MembershipRole::Admin));
        assert!(role_can_be_invited(MembershipRole::Member));
        assert!(role_can_be_invited(MembershipRole::Viewer));
        assert!(!role_can_be_invited(MembershipRole::Owner));
    }

    #[test]
    fn last_owner_cannot_be_demoted_removed_or_leave() {
        assert!(can_change_role(
            MembershipRole::Owner,
            MembershipRole::Owner,
            MembershipStatus::Active,
            MembershipRole::Member
        ));
        assert!(!can_remove_member(
            MembershipRole::Admin,
            MembershipRole::Owner
        ));
        assert!(!can_leave(MembershipRole::Owner, 1));
        assert!(can_leave(MembershipRole::Owner, 2));
    }

    // --- V01-003 -------------------------------------------------------------
    // The requested role is an argument to the decision, so the "may an admin create an
    // owner" case is expressible at all. Before the fourth parameter existed it was not
    // expressible, and the route wired the target's *current* role into the slot, so an
    // admin could set `role: "owner"` on anyone and on itself.

    #[test]
    fn an_admin_cannot_create_an_owner() {
        // The regression itself: target is currently a plain member, request is `owner`.
        assert!(!can_change_role(
            MembershipRole::Admin,
            MembershipRole::Member,
            MembershipStatus::Active,
            MembershipRole::Owner
        ));
        // Nor from another admin's seat.
        assert!(!can_change_role(
            MembershipRole::Admin,
            MembershipRole::Admin,
            MembershipStatus::Active,
            MembershipRole::Owner
        ));
        // Nor by demoting themselves and re-promoting in one conceptual step.
        assert!(!can_change_role(
            MembershipRole::Admin,
            MembershipRole::Admin,
            MembershipStatus::Active,
            MembershipRole::Owner
        ));
    }

    #[test]
    fn an_admin_still_cannot_re_role_an_existing_owner() {
        assert!(!can_change_role(
            MembershipRole::Admin,
            MembershipRole::Owner,
            MembershipStatus::Active,
            MembershipRole::Member
        ));
    }

    #[test]
    fn an_admin_may_still_manage_roles_up_to_admin() {
        for requested in [
            MembershipRole::Admin,
            MembershipRole::Member,
            MembershipRole::Viewer,
        ] {
            assert!(
                can_change_role(
                    MembershipRole::Admin,
                    MembershipRole::Member,
                    MembershipStatus::Active,
                    requested
                ),
                "an admin must still be able to set {requested:?}"
            );
        }
    }

    #[test]
    fn an_owner_may_still_change_any_active_members_role_including_to_owner() {
        assert!(can_change_role(
            MembershipRole::Owner,
            MembershipRole::Member,
            MembershipStatus::Active,
            MembershipRole::Owner
        ));
    }

    #[test]
    fn a_non_admin_actor_is_refused_for_every_requested_role() {
        for actor in [MembershipRole::Member, MembershipRole::Viewer] {
            for requested in [
                MembershipRole::Owner,
                MembershipRole::Admin,
                MembershipRole::Member,
                MembershipRole::Viewer,
            ] {
                assert!(
                    !can_change_role(
                        actor,
                        MembershipRole::Member,
                        MembershipStatus::Active,
                        requested
                    ),
                    "{actor:?} must not be able to request {requested:?}"
                );
            }
        }
    }

    #[test]
    fn an_inactive_target_cannot_be_re_roleed_by_anyone() {
        for actor in [
            MembershipRole::Owner,
            MembershipRole::Admin,
            MembershipRole::Member,
            MembershipRole::Viewer,
        ] {
            assert!(!can_change_role(
                actor,
                MembershipRole::Member,
                MembershipStatus::Removed,
                MembershipRole::Viewer
            ));
        }
    }
}
