-- P05-CR-004: decisions do not authorize repeatable handler execution.
ALTER TABLE tool_call_refs ADD COLUMN execution_started_at TEXT;
ALTER TABLE tool_call_refs ADD COLUMN execution_device_id TEXT REFERENCES devices(device_id) ON DELETE RESTRICT;
ALTER TABLE tool_call_refs ADD COLUMN execution_policy_version INTEGER;

CREATE TRIGGER tool_execution_claim_complete_insert
BEFORE INSERT ON tool_call_refs
WHEN NOT (
  (NEW.execution_started_at IS NULL AND NEW.execution_device_id IS NULL AND NEW.execution_policy_version IS NULL)
  OR (NEW.execution_started_at IS NOT NULL AND length(NEW.execution_started_at) = 24
      AND NEW.execution_device_id IS NOT NULL AND NEW.execution_policy_version IS NOT NULL
      AND NEW.execution_policy_version > 0 AND NEW.status = 'allowed')
)
BEGIN
  SELECT RAISE(ABORT, 'tool_execution_claim_invalid');
END;

CREATE TRIGGER tool_execution_claim_complete_update
BEFORE UPDATE ON tool_call_refs
WHEN NOT (
  (NEW.execution_started_at IS NULL AND NEW.execution_device_id IS NULL AND NEW.execution_policy_version IS NULL)
  OR (NEW.execution_started_at IS NOT NULL AND length(NEW.execution_started_at) = 24
      AND NEW.execution_device_id IS NOT NULL AND NEW.execution_policy_version IS NOT NULL
      AND NEW.execution_policy_version > 0)
)
OR (OLD.execution_started_at IS NULL AND NEW.execution_started_at IS NOT NULL
    AND (OLD.status <> 'allowed' OR NEW.status <> 'allowed'))
BEGIN
  SELECT RAISE(ABORT, 'tool_execution_claim_invalid');
END;

CREATE TRIGGER tool_execution_claim_immutable
BEFORE UPDATE ON tool_call_refs
WHEN OLD.execution_started_at IS NOT NULL AND (
  NEW.execution_started_at IS NOT OLD.execution_started_at
  OR NEW.execution_device_id IS NOT OLD.execution_device_id
  OR NEW.execution_policy_version IS NOT OLD.execution_policy_version
  OR NEW.run_id IS NOT OLD.run_id OR NEW.org_id IS NOT OLD.org_id
  OR NEW.project_id IS NOT OLD.project_id OR NEW.tool_id IS NOT OLD.tool_id
  OR NEW.tool_call_id IS NOT OLD.tool_call_id
  OR NEW.tool_fingerprint IS NOT OLD.tool_fingerprint
  OR NEW.arguments_summary IS NOT OLD.arguments_summary OR NEW.risk_class IS NOT OLD.risk_class
)
BEGIN
  SELECT RAISE(ABORT, 'tool_execution_claim_immutable');
END;
