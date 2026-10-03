-- 0023_p05_capability_catalogue_seed.sql — seed the platform capability
-- catalogue with the two standard capability classes the tool-policy evaluator
-- requires for browser and computer use.
--
-- Forward-only; apply after 0022_p07_staff_actor_type.sql.
--
-- F13-002 derives effective tool access from "runtime/device capability", and
-- `evaluate_tool_policy` refuses every browser- or computer-shaped call in
-- managed mode unless the required capability is catalogued in
-- `capability_definitions` (`capability_not_defined`). That table had NO
-- writer anywhere -- no INSERT or UPDATE in application code, no seed, no
-- route -- so the eleven FR-F13-005/006 controls were implemented, correct,
-- and unreachable (V04-010). This seed is the missing platform writer: two
-- platform-wide rows (org_id IS NULL), which `CAPABILITIES_FOR_ORG_SQL`
-- selects alongside each org's own rows.
--
-- The capability_key spellings are the evaluator's own required identifiers
-- (`BROWSER_CAPABILITY_ID` / `COMPUTER_CAPABILITY_ID`), and the risk_class
-- values are the schema's own browser/computer classes, so a tool that
-- references either row is browser- or computer-capable by construction.
-- org_id IS NULL keeps them platform-wide and out of every org's editable
-- catalogue; the org-scoped unique index does not apply to these rows.
--
-- The capability_id suffixes are the ASCII-hex spellings of the keys
-- ("browser" = 62726f77736572, "computer" = 636f6d7075746572), zero-padded to
-- 32 hex characters: a CapabilityId is `<prefix>_<32 lowercase hex>`
-- (core/identifiers.rs), and a tool references the row through
-- `capability_ids_value` -> `CapabilityId::new`, so the seeded ids must be
-- valid CapabilityIds or the platform rows would be unreferenceable — the
-- exact V04-010 shape this migration exists to close.
--
-- Rows are deterministic and INSERT OR IGNORE, so re-applying the ledger over
-- a populated database (verify:migration-prior-state) is stable.

INSERT OR IGNORE INTO capability_definitions
    (capability_id, org_id, capability_key, display_name, risk_class,
     metadata_json, version, created_at, updated_at)
VALUES
    ('cap_62726f77736572000000000000000000', NULL, 'browser',
     'Browser use', 'browser', '{}', 1,
     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    ('cap_636f6d70757465720000000000000000', NULL, 'computer',
     'Computer use', 'computer', '{}', 1,
     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
