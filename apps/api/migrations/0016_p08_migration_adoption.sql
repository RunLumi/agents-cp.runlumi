-- 0016_p08_migration_adoption.sql — client protocol compatibility registry,
-- per-workspace adoption state, stage/result telemetry, and remediation state.
--
-- Forward-only; apply after 0015_p06_baseline_seed.sql.
--
-- F26: the upgrade path is `local user -> optional account -> optional device
-- enrollment -> explicit org/project selection -> explicit workspace binding ->
-- managed model/tool policy -> optional history sync`. Nothing in this schema
-- converts a local workspace into an organization resource implicitly. Every row
-- that records managed state is created by an explicit request, and every table
-- is shaped so that local content has nowhere to go.
--
-- WHY these are new tables and not columns on `workspace_bindings`: P03 froze
-- `workspace_bindings` as the *placement* record (which project a device
-- workspace is bound to). Adoption is a different question with a different
-- lifecycle — it survives unbinding the placement, it moves forward and back
-- through stages, and it exists for a workspace that is deliberately never
-- bound. Attaching it to the P03 row would make "enrolled but unbound" and
-- "rolled back" unrepresentable, and it would put migration state on a table a
-- P03 dependent already reads.
--
-- No prompt, response, file content, path, workspace file listing, automation
-- body, MCP configuration, credential, or secret is stored in this schema. There
-- is no column in which any of those could be written: see the CHECK
-- constraints on `adoption_stage_events` and `workspace_adoption_states`.

--------------------------------------------------------------------------------
-- Client protocol compatibility (P08-CG)
--------------------------------------------------------------------------------
-- Platform data, not tenant data. It changes only through a contract-governed
-- migration, and every client resolves against exactly the same answer — the
-- same reasoning that put the entitlement registry in 0015 rather than on a
-- request path.
--
-- One row per supported client protocol major line. The ranges are CLOSED
-- intervals: a client outside `min_protocol_major .. max_protocol_major` is
-- refused managed operations, and that refusal is the documented degraded mode
-- rather than an error the client has to interpret.
CREATE TABLE client_compatibility_policies (
    compatibility_policy_id TEXT PRIMARY KEY CHECK (
        length(compatibility_policy_id) = 36
        AND substr(compatibility_policy_id, 1, 4) = 'cmp_'
    ),
    -- Monotonic key, so an ordered read answers "the newest policy wins" without
    -- needing a deployment to keep the table single-row.
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    protocol_major INTEGER NOT NULL CHECK (protocol_major BETWEEN 1 AND 32),
    min_protocol_major INTEGER NOT NULL CHECK (min_protocol_major BETWEEN 1 AND 32),
    max_protocol_major INTEGER NOT NULL CHECK (max_protocol_major BETWEEN 1 AND 32),
    CHECK (min_protocol_major <= max_protocol_major),
    -- Policy schema compatibility is a separate axis from the client protocol:
    -- a client can speak protocol 1 and still carry a policy snapshot the
    -- control plane can no longer honour.
    min_policy_schema_version INTEGER NOT NULL CHECK (
        min_policy_schema_version BETWEEN 1 AND 64
    ),
    max_policy_schema_version INTEGER NOT NULL CHECK (
        max_policy_schema_version BETWEEN 1 AND 64
    ),
    CHECK (min_policy_schema_version <= max_policy_schema_version),
    -- F26 stage 0 is the state a client is in before it has an account. A
    -- control plane that cannot run a local-only client has turned a staged
    -- migration into a forced one, so local-only availability is a recorded
    -- product decision rather than an emergent one.
    local_only_eligible INTEGER NOT NULL CHECK (local_only_eligible IN (0, 1)),
    -- History sync is F26 stage 5 and is NOT available until data-retention
    -- controls are mature. It is a per-policy switch so shipping it is a
    -- deliberate, reviewable change rather than the absence of a code path.
    history_sync_eligible INTEGER NOT NULL CHECK (history_sync_eligible IN (0, 1)),
    notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 512),
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    UNIQUE (protocol_major, sequence)
);

CREATE INDEX idx_client_compatibility_sequence
    ON client_compatibility_policies (sequence DESC);

-- The frozen baseline. `local_only_eligible = 1` because F26's stage 0 must keep
-- working for a client that has never signed in; `history_sync_eligible = 0`
-- because FR-F26-006 makes bulk upload of historical prompts and files opt-in
-- and later, and no reviewable evidence of mature retention controls exists yet.
-- The Rust baseline in `modules/migration/compatibility.rs` must agree with this
-- row; `baseline_matches_seed` in the domain tests is what keeps them from
-- drifting.
INSERT INTO client_compatibility_policies (
    compatibility_policy_id, sequence, protocol_major, min_protocol_major,
    max_protocol_major, min_policy_schema_version, max_policy_schema_version,
    local_only_eligible, history_sync_eligible, notes, version, created_at
) VALUES (
    'cmp_00000000000000000000000000000001',
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    'Frozen P08-CG baseline. Protocol major 1 and policy schema 1 are the only supported lines.',
    1,
    '2026-09-26T00:00:00.000Z'
);

--------------------------------------------------------------------------------
-- Workspace adoption state (P08-CG, F26 stages)
--------------------------------------------------------------------------------
-- One row per local workspace identity an organization has ever adopted, keyed
-- by the client's own opaque installation/workspace pair. This is the external
-- ID mapping F26-001 requires: it survives a rollback, so a user who unbinds and
-- later re-enrolls is recognised instead of appearing as a new workspace, and
-- support can name the local state without it ever having been uploaded.
--
-- `external_workspace_key` is a client-generated opaque key, never a filesystem
-- path. P03 already refuses absolute path semantics in a workspace identity; the
-- same bound is repeated here because this table is reachable from a different
-- write path.
CREATE TABLE workspace_adoption_states (
    adoption_state_id TEXT PRIMARY KEY CHECK (
        length(adoption_state_id) = 36 AND substr(adoption_state_id, 1, 4) = 'wst_'
    ),
    org_id TEXT NOT NULL REFERENCES organizations (org_id) ON DELETE CASCADE,
    -- The client-generated installation identifier: an opaque random value, so it
    -- identifies an install without describing it.
    external_installation_id TEXT NOT NULL CHECK (
        length(external_installation_id) BETWEEN 16 AND 128
        AND external_installation_id NOT GLOB '*[/\\]*'
    ),
    external_workspace_key TEXT NOT NULL CHECK (
        length(external_workspace_key) BETWEEN 1 AND 256
        AND external_workspace_key NOT GLOB '*[/\\]*'
    ),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    -- NULL while the workspace is deliberately unbound; set when the user
    -- explicitly maps it to a project. There is no state in which either is
    -- populated by inference from sign-in.
    bound_project_id TEXT REFERENCES projects (project_id) ON DELETE SET NULL,
    bound_device_id TEXT REFERENCES devices (device_id) ON DELETE SET NULL,
    stage TEXT NOT NULL CHECK (stage IN (
        'local_unmanaged', 'account_optional', 'device_enrolled',
        'workspace_bound', 'managed_policy', 'history_sync'
    )),
    ownership TEXT NOT NULL CHECK (ownership IN ('local_unmanaged', 'org_managed')),
    -- FR-F26-003. `local_credential` means the local key never left the machine;
    -- `metadata_only` means the control plane holds a provider and fingerprint
    -- and nothing retrievable; `org_managed_credential` means the user
    -- explicitly asked for the secret to be copied into the P04 credential
    -- store, and the secret itself lives in `credentials`, never here.
    credential_mode TEXT NOT NULL CHECK (credential_mode IN (
        'local_credential', 'metadata_only', 'org_managed_credential'
    )),
    -- The stage the user last left by a rollback, kept so a rollback is visible
    -- as a decision and not only as a missing managed state.
    rolled_back_from_stage TEXT CHECK (rolled_back_from_stage IN (
        'local_unmanaged', 'account_optional', 'device_enrolled',
        'workspace_bound', 'managed_policy', 'history_sync'
    )),
    client_protocol_major INTEGER NOT NULL CHECK (
        client_protocol_major BETWEEN 1 AND 32
    ),
    policy_schema_version INTEGER NOT NULL CHECK (
        policy_schema_version BETWEEN 1 AND 64
    ),
    client_app_version TEXT NOT NULL CHECK (length(client_app_version) BETWEEN 1 AND 32),
    -- A rollback is reversible, so the number of times it happened is retained
    -- rather than discarded.
    reversion_count INTEGER NOT NULL DEFAULT 0 CHECK (reversion_count >= 0),
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
);

-- One adoption record per local workspace per organization. This is the index
-- that makes FR-F26-002 structural: a second row for the same workspace cannot
-- be created, so a workspace cannot be silently adopted twice into two projects.
CREATE UNIQUE INDEX ux_workspace_adoption_org_workspace
    ON workspace_adoption_states (org_id, external_installation_id, external_workspace_key);
CREATE INDEX idx_workspace_adoption_org_stage
    ON workspace_adoption_states (org_id, stage, created_at);
CREATE INDEX idx_workspace_adoption_project
    ON workspace_adoption_states (bound_project_id, created_at);

-- A workspace is org-managed only if a project and a device are named. Without
-- this, stage `managed_policy` and ownership `org_managed` could be written for
-- a workspace the organization cannot address.
CREATE TRIGGER trg_workspace_adoption_managed_requires_project
BEFORE INSERT ON workspace_adoption_states
FOR EACH ROW WHEN NEW.ownership = 'org_managed'
    AND (NEW.bound_project_id IS NULL OR NEW.bound_device_id IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'an org-managed workspace requires a bound project and device');
END;

-- The same rule on update, so the invariant cannot be walked around by patching
-- the columns one at a time.
CREATE TRIGGER trg_workspace_adoption_managed_requires_project_update
BEFORE UPDATE ON workspace_adoption_states
FOR EACH ROW WHEN NEW.ownership = 'org_managed'
    AND (NEW.bound_project_id IS NULL OR NEW.bound_device_id IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'an org-managed workspace requires a bound project and device');
END;

-- History sync is stage 5 and is opt-in. A row cannot claim that stage while the
-- credential mode is still the local one, which is what stops "we synced
-- everything" from being recorded for a workspace that never consented.
CREATE TRIGGER trg_workspace_adoption_history_sync_requires_managed
BEFORE INSERT ON workspace_adoption_states
FOR EACH ROW WHEN NEW.stage = 'history_sync'
    AND (NEW.ownership <> 'org_managed' OR NEW.credential_mode = 'local_credential')
BEGIN
    SELECT RAISE(ABORT, 'history sync requires an org-managed workspace and a non-local credential mode');
END;

--------------------------------------------------------------------------------
-- Adoption stage telemetry (FR-F26-008)
--------------------------------------------------------------------------------
-- Stage and result only. There is deliberately no free-text column, no payload
-- column, and no path column: F26-008 measures the migration, not the user, and
-- a schema that cannot hold a prompt cannot leak one.
CREATE TABLE adoption_stage_events (
    adoption_event_id TEXT PRIMARY KEY CHECK (
        length(adoption_event_id) = 36 AND substr(adoption_event_id, 1, 4) = 'ase_'
    ),
    org_id TEXT NOT NULL REFERENCES organizations (org_id) ON DELETE CASCADE,
    adoption_state_id TEXT REFERENCES workspace_adoption_states (adoption_state_id)
        ON DELETE CASCADE,
    -- A stage-0 or stage-1 event legitimately has no adoption row yet, which is
    -- why this is nullable while `org_id` is not.
    device_id TEXT REFERENCES devices (device_id) ON DELETE SET NULL,
    actor_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
    stage TEXT NOT NULL CHECK (stage IN (
        'local_unmanaged', 'account_optional', 'device_enrolled',
        'workspace_bound', 'managed_policy', 'history_sync'
    )),
    result TEXT NOT NULL CHECK (result IN (
        'started', 'completed', 'skipped', 'failed', 'declined', 'rolled_back'
    )),
    -- A failure reason is a closed vocabulary, not a message. There is no column
    -- in which a client could put an error string containing local content.
    reason_code TEXT CHECK (
        reason_code IS NULL OR reason_code IN (
            'client_protocol_unsupported', 'client_upgrade_required',
            'policy_schema_unsupported', 'consent_required',
            'device_not_approved', 'device_revoked', 'policy_sync_failed',
            'credential_missing', 'credential_declined', 'capability_unsupported',
            'workspace_unbound', 'automation_import_conflict',
            'history_sync_unavailable', 'interrupted', 'conflict'
        )
    ),
    client_protocol_major INTEGER CHECK (
        client_protocol_major IS NULL OR client_protocol_major BETWEEN 1 AND 32
    ),
    policy_schema_version INTEGER CHECK (
        policy_schema_version IS NULL OR policy_schema_version BETWEEN 1 AND 64
    ),
    client_app_version TEXT CHECK (
        client_app_version IS NULL OR length(client_app_version) BETWEEN 1 AND 32
    ),
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24)
);

-- Roll-up reads group by stage/result per organization.
CREATE INDEX idx_adoption_events_org_stage
    ON adoption_stage_events (org_id, stage, occurred_at);
CREATE INDEX idx_adoption_events_state
    ON adoption_stage_events (adoption_state_id, occurred_at);
CREATE INDEX idx_adoption_events_device
    ON adoption_stage_events (device_id, occurred_at);

--------------------------------------------------------------------------------
-- Adoption remediation state (P08-FE-02)
--------------------------------------------------------------------------------
-- One open row per (adoption state, code). A client that is too old, whose policy
-- sync failed, or that is missing a credential needs an operator to be able to
-- SEE that and nothing more: the remediation is a pointer to a reason code and a
-- remedy, never a copy of the local state that caused it.
CREATE TABLE adoption_remediations (
    remediation_id TEXT PRIMARY KEY CHECK (
        length(remediation_id) = 36 AND substr(remediation_id, 1, 4) = 'rem_'
    ),
    org_id TEXT NOT NULL REFERENCES organizations (org_id) ON DELETE CASCADE,
    adoption_state_id TEXT REFERENCES workspace_adoption_states (adoption_state_id)
        ON DELETE CASCADE,
    device_id TEXT REFERENCES devices (device_id) ON DELETE SET NULL,
    code TEXT NOT NULL CHECK (code IN (
        'client_outdated', 'policy_sync_failed', 'credential_missing',
        'capability_unsupported', 'workspace_unbound', 'protocol_unsupported'
    )),
    stage TEXT NOT NULL CHECK (stage IN (
        'local_unmanaged', 'account_optional', 'device_enrolled',
        'workspace_bound', 'managed_policy', 'history_sync'
    )),
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')) DEFAULT 'open',
    -- The single action a user can take. Bounded, closed vocabulary: there is no
    -- "custom message", because a remediation points at a decision the user
    -- already has to make.
    remedy TEXT NOT NULL CHECK (remedy IN (
        'upgrade_client', 'reconnect_device', 'rebind_workspace',
        'choose_credential_mode', 'review_tool_policy', 'dismiss'
    )),
    -- A resolved row records who resolved it and when, so "we fixed it" is
    -- auditable. There is no resolution note: a free-text field here is exactly
    -- how local content would enter the cloud.
    resolved_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
    resolved_at TEXT CHECK (resolved_at IS NULL OR length(resolved_at) = 24),
    CHECK (
        (state = 'open' AND resolved_at IS NULL AND resolved_by_user_id IS NULL)
        OR (state = 'resolved' AND resolved_at IS NOT NULL)
    ),
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
);

-- At most one OPEN remediation per (state, code). A resolved row keeps its
-- history, so the partial index prevents a duplicate re-opening on every
-- heartbeat while still allowing a genuine re-remediation later.
CREATE UNIQUE INDEX ux_adoption_remediations_open
    ON adoption_remediations (adoption_state_id, code) WHERE state = 'open';
CREATE UNIQUE INDEX ux_adoption_remediations_device_open
    ON adoption_remediations (device_id, code) WHERE state = 'open' AND device_id IS NOT NULL;
CREATE INDEX idx_adoption_remediations_org_state
    ON adoption_remediations (org_id, state, created_at);
