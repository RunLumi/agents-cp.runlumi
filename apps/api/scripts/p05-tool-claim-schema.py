"""Check claim invariants against a read-only synthetic P05 runtime DB snapshot.

Usage: python3 apps/api/scripts/p05-tool-claim-schema.py /path/to/retained/local-d1.sqlite
Never mutate the runtime database: every case uses an in-memory SQLite backup.
This is storage evidence only; HTTP/device admission and handler effects are separate.
"""
import json
import sqlite3
import sys
from pathlib import Path

source_path = Path(sys.argv[1]).resolve()
source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)
source.row_factory = sqlite3.Row
row = source.execute("""SELECT c.tool_call_id,r.device_id FROM tool_call_refs c
JOIN runs r ON r.run_id=c.run_id WHERE c.status='allowed' AND c.execution_started_at IS NULL LIMIT 1""").fetchone()
if not row:
    raise RuntimeError("missing unclaimed allowed positive control; no schema verdict")
timestamp = "2026-10-07T12:00:00.000Z"


def fresh():
    database = sqlite3.connect(":memory:")
    source.backup(database)
    database.execute("PRAGMA foreign_keys=ON")
    return database


def claim(database):
    database.execute("""UPDATE tool_call_refs SET execution_started_at=?,execution_device_id=?,execution_policy_version=3
    WHERE tool_call_id=?""", (timestamp, row["device_id"], row["tool_call_id"]))
    database.commit()


checks = []
for name, statement, params, admitted in [
    ("partial timestamp only", "UPDATE tool_call_refs SET execution_started_at=? WHERE tool_call_id=?", (timestamp, row["tool_call_id"]), False),
    ("zero policy version", "UPDATE tool_call_refs SET execution_started_at=?,execution_device_id=?,execution_policy_version=0 WHERE tool_call_id=?", (timestamp, row["device_id"], row["tool_call_id"]), False),
    ("claim reset", "UPDATE tool_call_refs SET execution_started_at=NULL,execution_device_id=NULL,execution_policy_version=NULL WHERE tool_call_id=?", (row["tool_call_id"],), True),
    ("claim time changed", "UPDATE tool_call_refs SET execution_started_at=? WHERE tool_call_id=?", ("2026-10-07T12:01:00.000Z", row["tool_call_id"]), True),
    ("claim policy changed", "UPDATE tool_call_refs SET execution_policy_version=4 WHERE tool_call_id=?", (row["tool_call_id"],), True),
    ("argument binding changed", "UPDATE tool_call_refs SET arguments_summary='operation=changed' WHERE tool_call_id=?", (row["tool_call_id"],), True),
    ("tool fingerprint changed", "UPDATE tool_call_refs SET tool_fingerprint='changed-fingerprint' WHERE tool_call_id=?", (row["tool_call_id"],), True),
]:
    database = fresh()
    try:
        if admitted:
            claim(database)
        before = database.execute("SELECT * FROM tool_call_refs WHERE tool_call_id=?", (row["tool_call_id"],)).fetchone()
        try:
            database.execute(statement, params)
            database.commit()
        except sqlite3.IntegrityError as error:
            if "tool_execution_claim_" not in str(error):
                raise RuntimeError("wrong invariant failure: " + str(error)) from error
            database.rollback()
        else:
            raise AssertionError("mutation accepted: " + name)
        after = database.execute("SELECT * FROM tool_call_refs WHERE tool_call_id=?", (row["tool_call_id"],)).fetchone()
        assert after == before, "failure must preserve entire tool reference"
        checks.append({"claim": name, "verdict": "PASS"})
    finally:
        database.close()

database = fresh()
try:
    claim(database)
    database.execute("UPDATE tool_call_refs SET status='completed' WHERE tool_call_id=?", (row["tool_call_id"],))
    database.commit()
    stored = database.execute("SELECT status,execution_started_at,execution_device_id,execution_policy_version FROM tool_call_refs WHERE tool_call_id=?", (row["tool_call_id"],)).fetchone()
    assert stored == ("completed", timestamp, row["device_id"], 3)
    checks.append({"claim": "terminal result preserves admission metadata", "verdict": "PASS"})
finally:
    database.close()
source.close()
print(json.dumps({"scope": "immutable ToolCallRef claim in real retained schema; memory copies only", "verdict": "PASS", "checks": checks}, indent=2))
