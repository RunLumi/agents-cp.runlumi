"""Actual terminal-result CAS SQL on memory copies of synthetic retained D1.

Usage: python3 apps/api/scripts/p05-tool-result-cas.py /path/to/local-d1.sqlite
This is a storage/commit component proof, not HTTP interleaving fault injection.
"""
from pathlib import Path
import itertools
import json
import re
import sqlite3
import sys
import uuid

root = Path(__file__).resolve().parents[3]
text = (root / "apps/api/src/repositories/tools.rs").read_text()


def sql(name):
    return re.search(r"const " + name + r': &str = r#"(.*?)"#;', text, re.S)[1]


guard = sql("ASSERT_TOOL_RESULT_STATUS_SQL")
update = sql("UPDATE_TOOL_CALL_STATUS_SQL")
source = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True)
source.row_factory = sqlite3.Row
call = source.execute("""SELECT c.*,r.device_id FROM tool_call_refs c JOIN runs r ON r.run_id=c.run_id
JOIN approval_requests a ON a.tool_call_id=c.tool_call_id WHERE c.status='allowed'
AND c.execution_started_at IS NULL AND a.status='approved' LIMIT 1""").fetchone()
if not call:
    raise RuntimeError("positive control fixture missing; no CAS verdict")
audit = source.execute("SELECT * FROM security_events WHERE tool_call_id=? LIMIT 1", (call["tool_call_id"],)).fetchone()
if not audit:
    raise RuntimeError("real audit shape missing; no CAS verdict")
timestamp = "2026-10-07T12:00:00.000Z"
checks = []
for winner, loser in itertools.permutations(["completed", "failed", "cancelled"], 2):
    database = sqlite3.connect(":memory:")
    source.backup(database)
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA foreign_keys=ON")
    try:
        database.execute("""UPDATE tool_call_refs SET execution_started_at=?,execution_device_id=?,execution_policy_version=3
        WHERE tool_call_id=?""", (timestamp, call["device_id"], call["tool_call_id"]))
        database.commit()

        def report(status):
            try:
                database.execute("BEGIN")
                # Both callers observed allowed before either committed.
                database.execute(guard, (call["org_id"], call["run_id"], call["tool_call_id"], "allowed"))
                database.execute(update, (call["run_id"], call["tool_call_id"], status, timestamp))
                record = dict(audit)
                record.update(event_id=audit["event_id"].split("_")[0]+"_"+uuid.uuid4().hex,
                              action="tool.result.v1", metadata_json=json.dumps({"status": status}))
                columns = list(record)
                names = ",".join('"'+column+'"' for column in columns)
                database.execute("INSERT INTO security_events ("+names+") VALUES ("+",".join("?" for _ in columns)+")", tuple(record.values()))
                database.commit()
                return True
            except sqlite3.IntegrityError as error:
                if "a pending idempotency record carries no result and must hold a claim token" not in str(error):
                    raise RuntimeError("wrong CAS refusal: "+str(error)) from error
                database.rollback()
                return False

        assert report(winner), "positive terminal report must execute"
        assert not report(loser), "conflicting observed-status report must lose"
        stored = database.execute("SELECT status,execution_started_at FROM tool_call_refs WHERE tool_call_id=?", (call["tool_call_id"],)).fetchone()
        assert stored["status"] == winner and stored["execution_started_at"] == timestamp
        effects = database.execute("SELECT COUNT(*) FROM security_events WHERE tool_call_id=? AND action='tool.result.v1'", (call["tool_call_id"],)).fetchone()[0]
        assert effects == 1, "refused result must roll back audit together with status"
        assert not report(winner), "another stale pre-read must not write duplicate result/audit"
        checks.append({"claim": winner+" wins over "+loser+" with one stored result/audit", "verdict": "PASS"})
    finally:
        database.close()
source.close()
print(json.dumps({"scope": "actual result CAS SQL, real schema/audit; memory copies only", "verdict": "PASS", "checks": checks}, indent=2))
