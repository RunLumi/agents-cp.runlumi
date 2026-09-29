-- Name `staff` in `security_events.actor_type`, so a staff audit event is writable.
--
-- WHY
--
-- ADR 0007 establishes THREE actor kinds -- `Principal` (human), `MachineActor`,
-- and `StaffActor` -- and carries a MUST:
--
--     A staff audit event is written on grant creation and on every use, so a
--     support session is reconstructable from the customer's own audit view
--     without trusting platform-side logs.
--
-- Migration 0002 declared the audit table, and its CHECK enumerated the
-- pre-P07 world:
--
--     actor_type TEXT NOT NULL CHECK (
--         actor_type IN ('user', 'service_account', 'support', 'system', 'anonymous')
--     )
--
-- The `staff_principals` table, `StaffActor`, and the whole `/api/v1/internal/**`
-- surface arrive in migration 0018 -- sixteen migrations later -- and nothing
-- extended the CHECK to name the third actor kind. So the value the product
-- writes is the one value the schema refuses, and the MUST is unsatisfiable.
--
-- This is the same class as 0021. There, a CHECK no insert could satisfy meant
-- the team surface had never worked. Here, a CHECK no staff insert can satisfy
-- means EVERY `/api/v1/internal/**` write route has never worked: the four
-- writers in `routes/internal.rs` (`create_flag`, `patch_flag`,
-- `create_kill_switch`, `lift_kill_switch`) all call `staff_audit`, which
-- inserts `actor_type = 'staff'`, which the CHECK refuses, which aborts the D1
-- batch, which the caller reports as `503 service_unavailable`. Platform
-- feature flags cannot be rolled out and kill switches cannot be armed or lifted
-- through the API, and the platform's own actions are unaudited. Reads are
-- unaffected, which is why nothing noticed: `list_flags` answers 200 to the very
-- same token.
--
-- WHY `'support'` IS NOT THE ANSWER
--
-- `'support'` is in the 0002 list and reads like the staff value. It is not: it
-- is a `StaffRole`, not an actor kind. `permissions_for` defines four roles --
-- support, finance, security, engineering -- and writing `'support'` would
-- record a `security` or `engineering` staff member's platform action as a
-- support action. That satisfies the CHECK by making the audit trail misstate
-- the actor kind, which is the exact property ADR 0007 exists to protect. The
-- value is named, not coerced.
--
-- WHY A REBUILD AND NOT AN EDIT
--
-- Editing 0002 would fix a fresh database and nothing else: the ledger records
-- 0002 as applied, so it is skipped. Corrective migration is the only form that
-- reaches an already-applied database, and the `_new` / copy / drop / rename
-- shape is the one this repository already uses (0004, 0005, 0006, 0021).
--
-- The copy runs BEFORE the drop, and the two immutability triggers do not fire
-- on it: they are `BEFORE UPDATE` and `BEFORE DELETE`, and this is an INSERT
-- followed by a DROP. Recreating the table drops them along with it, so all four
-- indexes and both triggers are recreated verbatim below -- a rebuild that
-- silently loses the append-only guarantee on the audit table would be a far
-- worse defect than the one being fixed.
--
-- `security_events` has an outgoing foreign key on `org_id` and is referenced by
-- no table, no index of its own beyond these four, and no trigger other than its
-- own two, so the rebuild touches nothing else. Every other constraint is copied
-- byte for byte, including the `organizations` reference and its ON DELETE
-- RESTRICT.

CREATE TABLE security_events_new (
    event_id TEXT PRIMARY KEY CHECK (
        length(event_id) = 36 AND substr(event_id, 1, 4) = 'sec_'
    ),
    org_id TEXT REFERENCES organizations(org_id) ON DELETE RESTRICT,
    -- 'staff' ADDED: the third actor kind from ADR 0007. The other five are
    -- unchanged and in their original order, so a diff of this CHECK against 0002
    -- is one insertion and nothing else.
    actor_type TEXT NOT NULL CHECK (
        actor_type IN ('user', 'service_account', 'staff', 'support', 'system', 'anonymous')
    ),
    actor_id TEXT,
    effective_user_id TEXT,
    session_id TEXT,
    device_id TEXT,
    action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 64),
    resource_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 96),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 255),
    correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 255),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24)
);

INSERT INTO security_events_new (
    event_id, org_id, actor_type, actor_id, effective_user_id, session_id, device_id,
    action, resource_type, resource_id, outcome, reason, metadata_json,
    request_id, correlation_id, created_at
)
SELECT
    event_id, org_id, actor_type, actor_id, effective_user_id, session_id, device_id,
    action, resource_type, resource_id, outcome, reason, metadata_json,
    request_id, correlation_id, created_at
FROM security_events;

DROP TABLE security_events;
ALTER TABLE security_events_new RENAME TO security_events;

-- 0002's three indexes, verbatim.
CREATE INDEX idx_security_events_org_time ON security_events (org_id, created_at DESC);
CREATE INDEX idx_security_events_actor_time ON security_events (actor_id, created_at DESC);
CREATE INDEX idx_security_events_action_time ON security_events (action, created_at DESC);

-- 0010's fourth, which the rebuild would otherwise drop silently.
CREATE INDEX idx_security_events_run ON security_events(org_id, run_id, created_at DESC);

-- 0002's immutability triggers, verbatim. The audit table is append-only, and a
-- rebuild that lost this would be a worse finding than the one it repairs.
CREATE TRIGGER security_events_no_update
BEFORE UPDATE ON security_events
BEGIN
    SELECT RAISE(ABORT, 'security events are immutable');
END;

CREATE TRIGGER security_events_no_delete
BEFORE DELETE ON security_events
BEGIN
    SELECT RAISE(ABORT, 'security events are immutable');
END;
