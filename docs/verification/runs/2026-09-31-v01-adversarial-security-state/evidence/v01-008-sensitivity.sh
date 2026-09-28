#!/usr/bin/env bash
# V01-008 sensitivity proof — the project PATCH optimistic update.
#
# The defect was a `SET`/`WHERE` placeholder disagreement that left `WHERE project_id = ?1`
# comparing the primary key against the project's *name*. The route then answered 409
# `version_conflict` forever, and the error told clients the project "changed since you
# loaded it" when nothing had.
#
#   P1  the statement's placeholders are put back out of correspondence
#         -> the control's PATCH must be refused, proving the probe notices a write that
#            does not happen. This is the whole claim: a mutation probe that cannot tell a
#            successful write from a refused one reports a project surface that has never
#            worked.
#   P2  `default_model_route` is put back into the SET list
#         -> the preservation assertion must fail, proving that check is load-bearing. It
#            exists because the broken statement would have written a timestamp into that
#            column, and it is worth nothing if a mutation does not move it.
#   P3  the ownership-transfer attack is removed
#         -> the mutating-tenancy probe must notice it is no longer attacking anything
#
# `set -e` and an explicit mutation-applied check, from the start -- V01-006's harness
# reported three MISSED verdicts for three mutations that had never run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
REPO="$ROOT/apps/api/src/repositories/projects.rs"
PROBE="$ROOT/apps/api/scripts/v01-mutating-tenancy-probe.mjs"
WORK="$ROOT/target/v01-project-sensitivity"
SNAP="$WORK/snapshot"

mkdir -p "$SNAP"
cp "$REPO" "$SNAP/projects.rs" || exit 2
[[ -s "$SNAP/projects.rs" ]] || { echo "the snapshot is empty -- refusing to run"; exit 2; }

restore() {
  cp "$SNAP/projects.rs" "$REPO"
  if diff -q "$SNAP/projects.rs" "$REPO" >/dev/null; then
    echo "restored the product (verified against the snapshot)"
    return 0
  fi
  echo "RESTORE FAILED -- DO NOT TRUST ANY RESULT"
  return 1
}
trap 'restore' EXIT INT TERM

mutation_applied() {
  if diff -q "$SNAP/projects.rs" "$REPO" >/dev/null; then
    echo "MUTATION DID NOT APPLY -- the file is unchanged, so this case would grade a run that"
    echo "never happened. Aborting."
    exit 2
  fi
}

# Did the assertion this case targets fail in the broken build?
#
# The needle is matched as a SUBSTRING of the whole assertion, not anchored after the `FAIL`
# marker. Three cases in this campaign were graded MISSED for detections that had happened,
# every one of them because the needle began mid-sentence and the pattern was anchored:
# "a PATCH carrying a stale version is refused" against a line that reads "a PATCH carrying a
# stale version is refused with a conflict, ...". An anchoring that never fires is a verifier
# that reports the absence of a defect it just watched occur.
fired() {
  grep -E "^  FAIL  " "$1" | grep -qF "$2" && echo "detected" || echo "MISSED"
}

run_probe() {
  local label="$1"
  pkill -9 -f workerd 2>/dev/null || true
  sleep 1
  rm -rf "$WORK/db-$label"
  V01_TEN_PERSIST_TO="$WORK/db-$label" node "$PROBE" > "$WORK/$label.txt" 2>&1 || true
}

[[ "${1:-}" == "--apply" ]] || { echo "pass --apply to drive the broken product"; exit 2; }

run_probe baseline
echo "baseline: $(grep -oE '[0-9]+/[0-9]+ V01 [A-Za-z-]+ cases hold' "$WORK/baseline.txt" | tail -1)"

# --- P1: the placeholders disagree again ---------------------------------------
python3 - "$REPO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "SET name = ?1, visibility = ?2, archived_at = ?3, version = version + 1, updated_at = ?4\nWHERE project_id = ?5 AND org_id = ?6 AND version = ?7"
assert old in s, "the repaired statement is not where the mutation expects it"
# The original defect, verbatim: SET from ?2 and WHERE's project_id from ?1.
new = "SET name = ?2, visibility = ?3, archived_at = ?4, default_model_route = ?5, version = version + 1, updated_at = ?6\nWHERE project_id = ?1 AND org_id = ?7 AND version = ?8"
s = s.replace(old, new, 1)
# And the bind list to match, so the count is still right and only the CORRESPONDENCE is
# wrong -- the exact shape of the original defect, and the reason `schema:bind-count` passed.
binds_old = """                BindValue::Text(update.name),
                BindValue::Text(update.visibility),
                archive_value,
                BindValue::Text(update.now.as_str()),
                BindValue::Text(update.project_id),
                BindValue::Text(update.org_id),
                BindValue::Integer(i32::try_from(update.expected_version).unwrap_or_default()),"""
binds_new = """                BindValue::Text(update.name),
                BindValue::Text(update.visibility),
                archive_value,
                BindValue::Null,
                BindValue::Text(update.now.as_str()),
                BindValue::Text(update.project_id),
                BindValue::Text(update.org_id),
                BindValue::Integer(i32::try_from(update.expected_version).unwrap_or_default()),"""
assert binds_old in s, "the bind list is not where the mutation expects it"
s = s.replace(binds_old, binds_new, 1)
p.write_text(s)
print("P1 applied: SET and WHERE placeholders disagree again, with the count still correct")
PY
mutation_applied
run_probe p1
P1=$(fired "$WORK/p1.txt" "CONTROL: Org A's own owner can rename")
restore

# --- P2: default_model_route back in the SET list -----------------------------
python3 - "$REPO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "SET name = ?1, visibility = ?2, archived_at = ?3, version = version + 1, updated_at = ?4"
assert old in s, "the repaired statement is not where the mutation expects it"
# The column the repaired statement deliberately does not mention.
new = "SET name = ?1, visibility = ?2, archived_at = ?3, default_model_route = NULL, version = version + 1, updated_at = ?4"
s = s.replace(old, new, 1)
p.write_text(s)
print("P2 applied: a rename now clears default_model_route")
PY
mutation_applied
run_probe p2
P2=$(fired "$WORK/p2.txt" "a rename leaves default_model_route alone")
restore

# --- P3: the optimistic guard is removed --------------------------------------
python3 - "$REPO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "WHERE project_id = ?5 AND org_id = ?6 AND version = ?7"
assert old in s, "the repaired WHERE is not where the mutation expects it"
# The placeholder is KEPT, so the count is unchanged and the mutation cannot be caught by the
# bind-count gate. The first version of P3 dropped `?7` outright, which left seven binds for
# six placeholders: D1 refused the statement, the control answered 503, and the case was
# detected by the "no 5xx" assertion rather than by the claim it is named for.
s = s.replace(old, "WHERE project_id = ?5 AND org_id = ?6 AND ?7 IS NOT NULL", 1)
p.write_text(s)
print("P3 applied: the version comparison is gone but the placeholder count is unchanged")
PY
mutation_applied
run_probe p3
P3=$(fired "$WORK/p3.txt" "carrying a stale version is refused")
restore

echo
echo "=== summary ==="
echo "  P1 placeholders disagree (the V01-008 defect):  $P1"
echo "  P2 a rename clears default_model_route:         $P2"
echo "  P3 the optimistic guard is removed:              $P3"
for f in p1 p2 p3; do grep -E "^  FAIL  " "$WORK/$f.txt" | head -2 | cut -c1-165; done
ok=1
[[ "$P1" == detected ]] || ok=0
[[ "$P2" == detected ]] || ok=0
[[ "$P3" == detected ]] || ok=0
[[ $ok -eq 1 ]]
