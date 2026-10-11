"""Storage proof: actual P06 insert SQL against the immutable migration's schedule table.

This does not prove HTTP, authorization, or desktop execution. No runtime DB is modified.
"""
import json
import re
import sqlite3
from pathlib import Path

api = Path(__file__).resolve().parents[1]
source = (api / "src/repositories/automations.rs").read_text()
sql = re.search(r'const INSERT_SCHEDULE_RULE_SQL: &str = r#"(.*?)"#;', source, re.S)[1]
migration = (api / "migrations/0011_p06_automations.sql").read_text()
schema = re.search(r"CREATE TABLE automation_schedule_rules \(.*?\n\);", migration, re.S)[0]
stamp = "2026-10-08T00:00:00.000Z"
org = "org_" + "a" * 32
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.executescript(schema)

fixtures = [
    ({"kind": "manual"}, {}),
    ({"kind": "one_time", "scheduled_at": stamp}, {"scheduled_at": stamp}),
    ({"kind": "cron", "expression": "* * * * *", "timezone": "UTC",
      "dom_dow_mode": "or", "dst_policy": "skip_duplicate"},
     {"expression": "* * * * *", "timezone": "UTC", "dom_dow_mode": "or", "dst_policy": "skip_duplicate"}),
    ({"kind": "interval", "every": 2, "unit": "weeks", "anchor_at": stamp,
      "timezone": "UTC", "by_weekday": [1, 3], "overlap_policy": "queue_one",
      "missed_policy": "catch_up", "catch_up_limit": 2},
     {"interval_every": 2, "interval_unit": "weeks", "anchor_at": stamp, "timezone": "UTC",
      "by_weekday_json": "[1,3]", "overlap_policy": "queue_one", "missed_policy": "catch_up", "catch_up_limit": 2}),
]
for index, (rule, expected) in enumerate(fixtures):
    rule_id = "sch_" + f"{index:032x}"
    canonical = json.dumps({"rule": rule, "zone": {}}, separators=(",", ":"))
    db.execute(sql, (rule_id, org, canonical, stamp))
    stored = db.execute("SELECT * FROM automation_schedule_rules WHERE schedule_rule_id=?", (rule_id,)).fetchone()
    assert stored["canonical_json"] == canonical
    assert stored["kind"] == rule["kind"]
    for field, value in expected.items():
        assert stored[field] == value, (field, stored[field], value)
    assert stored["overlap_policy"] == rule.get("overlap_policy", "skip")
    assert stored["missed_policy"] == rule.get("missed_policy", "run_once")
    print(f"PASS {rule['kind']}: actual SQL persists required fields and canonical revision")

# The storage CHECK remains load-bearing: a missing cron expression is rejected,
# rather than papering over the original route bug by relaxing the schema.
try:
    db.execute(sql, ("sch_" + "f" * 32, org,
                    json.dumps({"rule": {"kind": "cron", "timezone": "UTC"}, "zone": {}}), stamp))
except sqlite3.IntegrityError as error:
    assert "CHECK constraint failed" in str(error)
else:
    raise AssertionError("invalid cron was accepted")
assert db.execute("SELECT COUNT(*) FROM automation_schedule_rules").fetchone()[0] == 4
print("PASS malformed cron refused by unchanged CHECK; prior rows preserved")
db.close()
