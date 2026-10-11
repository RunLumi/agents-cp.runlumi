"""Exercise actual capability guard SQL on memory copies of retained synthetic D1.

Usage: python3 apps/api/scripts/p05-capability-claim-guard.py /path/to/local-d1.sqlite
Storage/race component proof only; actual Worker route proof is separate.
"""
from pathlib import Path
import json
import re
import sqlite3
import sys

root = Path(__file__).resolve().parents[3]
text = (root / "apps/api/src/repositories/tools.rs").read_text()


def sql(name):
    return re.search(r"const " + name + r': &str = r#"(.*?)"#;', text, re.S)[1]


guard = sql("ASSERT_TOOL_EXECUTION_CAPABILITIES_SQL")
claim = sql("CLAIM_TOOL_EXECUTION_SQL")
source = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True)
source.row_factory = sqlite3.Row
call = source.execute("""SELECT c.*, r.device_id FROM tool_call_refs c JOIN runs r ON r.run_id=c.run_id
JOIN approval_requests a ON a.tool_call_id=c.tool_call_id
WHERE c.status='allowed' AND c.execution_started_at IS NULL AND a.status='approved' LIMIT 1""").fetchone()
if not call:
    raise RuntimeError("unclaimed approved positive fixture missing; no verdict")
org = call["org_id"]
foreign = source.execute("SELECT org_id FROM organizations WHERE org_id<>? LIMIT 1", (org,)).fetchone()[0]


def fresh():
    database = sqlite3.connect(":memory:")
    source.backup(database)
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA foreign_keys=ON")
    return database


def binding(database):
    rows = database.execute("""SELECT capability_id,capability_key,risk_class,version FROM capability_definitions
    WHERE org_id IS NULL OR org_id=? ORDER BY capability_key ASC,capability_id ASC LIMIT 500""", (org,)).fetchall()
    return json.dumps([list(row) for row in rows], ensure_ascii=False, separators=(",", ":"))


def add(database, org_id):
    database.execute("""INSERT INTO capability_definitions
    (capability_id,org_id,capability_key,display_name,risk_class,metadata_json,version,created_at,updated_at)
    VALUES (?,?,?,'Fixture capability','network','{}',1,?,?)""",
    ("cap_"+"f"*32, org_id, "race_fixture", "2026-10-07T12:00:00.000Z", "2026-10-07T12:00:00.000Z"))


checks = []
for name, operation, expected in [
    ("unchanged positive", "none", True),
    ("visible addition", "addition", False),
    ("visible version", "version", False),
    ("visible risk reclassification", "risk", False),
    ("visible key remapping", "key", False),
    ("visible removal", "remove", False),
    ("foreign tenant addition does not invalidate own scope", "foreign", True),
]:
    database = fresh()
    try:
        captured = binding(database)
        row = database.execute("SELECT capability_id FROM capability_definitions WHERE org_id IS NULL OR org_id=? LIMIT 1", (org,)).fetchone()
        if operation in ("version", "risk", "key", "remove") and row is None:
            raise RuntimeError("visible capability positive fixture missing; no mutation verdict")
        if operation == "addition":
            add(database, org)
        elif operation == "foreign":
            add(database, foreign)
        elif operation == "version":
            database.execute("UPDATE capability_definitions SET version=version+1 WHERE capability_id=?", (row[0],))
        elif operation == "risk":
            database.execute("UPDATE capability_definitions SET risk_class='destructive' WHERE capability_id=?", (row[0],))
        elif operation == "key":
            database.execute("UPDATE capability_definitions SET capability_key='changed_key' WHERE capability_id=?", (row[0],))
        elif operation == "remove":
            database.execute("DELETE FROM capability_definitions WHERE capability_id=?", (row[0],))
        database.commit()
        admitted = True
        try:
            database.execute("BEGIN")
            database.execute(guard, (org, captured))
            database.execute(claim, (org, call["run_id"], call["tool_call_id"], "2026-10-07T12:00:00.000Z", call["device_id"], 3))
            database.execute("UPDATE approval_requests SET consumed_at=? WHERE tool_call_id=?", ("2026-10-07T12:00:00.000Z", call["tool_call_id"]))
            database.commit()
        except sqlite3.IntegrityError as error:
            if "a pending idempotency record carries no result and must hold a claim token" not in str(error):
                raise RuntimeError("wrong guard failure: "+str(error)) from error
            admitted = False
            database.rollback()
        assert admitted == expected, name
        stored = database.execute("SELECT execution_started_at FROM tool_call_refs WHERE tool_call_id=?", (call["tool_call_id"],)).fetchone()[0]
        consumed = database.execute("SELECT consumed_at FROM approval_requests WHERE tool_call_id=?", (call["tool_call_id"],)).fetchone()[0]
        assert (stored is not None) == expected and (consumed is not None) == expected, "claim and consume must commit/rollback together"
        checks.append({"claim": name, "verdict": "PASS"})
    finally:
        database.close()
source.close()
print(json.dumps({"scope": "actual capability guard SQL on memory copies; claim/consume atomicity component", "verdict": "PASS", "checks": checks}, indent=2))
