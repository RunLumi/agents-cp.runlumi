-- Unbind revokes execution authority while keeping P05/P06 historical FKs intact.
ALTER TABLE workspace_bindings ADD COLUMN removed_at TEXT
    CHECK (removed_at IS NULL OR length(removed_at) = 24);

DROP INDEX ux_workspace_bindings_device_identity;
CREATE UNIQUE INDEX ux_workspace_bindings_device_identity
    ON workspace_bindings (device_id, workspace_identity) WHERE removed_at IS NULL;
