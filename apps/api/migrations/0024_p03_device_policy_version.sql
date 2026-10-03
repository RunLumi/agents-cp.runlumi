-- 0024_p03_device_policy_version.sql — give org_device_policy_settings an
-- optimistic-concurrency version for the new admin write surface.
--
-- Forward-only; apply after 0023_p05_capability_catalogue_seed.sql.
--
-- F19-008: an organization can require a minimum client version for
-- cloud-managed operations when a security fix demands it. The comparator
-- (`modules/devices.rs::version_at_least`), the policy read, and the refusal
-- have existed since P03, but nothing could WRITE
-- `org_device_policy_settings.min_client_version` — the control existed on
-- paper and could not be armed (V04-008, fail-open inert). The routed write
-- surface lands in this branch (`PUT /api/v1/orgs/{org_id}/device-policy`);
-- concurrent admins need a version guard so a stale write cannot silently
-- clobber a fresh floor, which is the same optimistic-concurrency shape the
-- org policy table has used since P04.
--
-- ALTER TABLE ... ADD COLUMN with a constant DEFAULT is supported by SQLite
-- and applies to existing rows (the table is keyed by org_id and was
-- previously unwritten, so it is expected to be empty everywhere; DEFAULT 1
-- keeps any hypothetical row valid).

ALTER TABLE org_device_policy_settings
    ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
