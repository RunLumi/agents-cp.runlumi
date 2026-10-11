-- P03-CR-004: platform runtime requirements, never execution grants.
-- IDs match LumiAgents lumi-managed-id-v1:cap SHA-256 derivation.
-- Existing reports without these toggles remain unsupported.
INSERT OR IGNORE INTO capability_definitions
    (capability_id, org_id, capability_key, display_name, risk_class,
     metadata_json, version, created_at, updated_at)
VALUES
    ('cap_2fd038c370f05abe4025d375c70a2aa1', NULL, 'filesystem',
     'Filesystem write', 'filesystem_write', '{}', 1,
     '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z'),
    ('cap_b761bbbf664d9b310a219854c924f0e1', NULL, 'process',
     'Process execution', 'process_execution', '{}', 1,
     '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z'),
    ('cap_0933cdf3c4c66d83d47f8aba45255381', NULL, 'network',
     'Network access', 'network', '{}', 1,
     '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z'),
    ('cap_52400cf9b2bed9c8d552ddd56538c481', NULL, 'mcp',
     'MCP execution', 'mcp', '{}', 1,
     '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
