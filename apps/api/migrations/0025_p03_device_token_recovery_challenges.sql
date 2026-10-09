-- P03-CR-002: recover an expired device token only after explicit human authority
-- and proof from the original device key. Challenge value itself is never persisted.
CREATE TABLE device_token_recovery_challenges (
    challenge_hash TEXT PRIMARY KEY CHECK (length(challenge_hash) = 64),
    org_id TEXT NOT NULL REFERENCES organizations (org_id),
    device_id TEXT NOT NULL REFERENCES devices (device_id),
    requested_by_user_id TEXT NOT NULL REFERENCES users (user_id),
    expires_at TEXT NOT NULL CHECK (length(expires_at) = 24),
    consumed_at TEXT CHECK (consumed_at IS NULL OR length(consumed_at) = 24),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24)
);
CREATE UNIQUE INDEX ux_device_recovery_one_pending
    ON device_token_recovery_challenges (device_id) WHERE consumed_at IS NULL;
CREATE INDEX idx_device_recovery_expiry
    ON device_token_recovery_challenges (expires_at, device_id);
