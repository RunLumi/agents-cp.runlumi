# ADR 0012 — Retain removed workspace bindings for run attribution

Status: accepted for desktop integration implementation; delivery pending.

P05 runs and P06 automation targets retain workspace binding references.
Physical deletion prevents local-mode rollback after any run because their FKs
restrict deletion. Unbind must revoke authority and preserve history.

Use an additive nullable removed_at timestamp. Ordinary binding lookups, lists,
identity uniqueness counts and automation eligibility require it to be NULL.
DELETE marks removal; run/audit records retain the original ID. Rebinding
creates a fresh ID through a partial live-identity unique index. Data retention
deletion remains a separate governance operation.

Older binaries can read the schema but do not enforce removal. The minimum
backend after migration 0026 is the removal-aware version. Preserve that version
for code rollback; never advertise older backend compatibility with tombstones.
Client delivery follows backend-first merge and a tested gitlink pair.

Runtime proof includes active controls, retained historical IDs, refused use of
a removed binding, absence from policy/lists, and fresh rebind. See P03-CR-003
and DE2E-INT-04.
