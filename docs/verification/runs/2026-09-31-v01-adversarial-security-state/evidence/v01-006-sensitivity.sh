#!/usr/bin/env bash
# V01-006 sensitivity proof — concurrent reservations against a hard budget ceiling.
#
# The claim this proves is that a conditional INSERT in SQL really is serialised by D1
# rather than merely being one statement. "It is one statement" is a claim about the code;
# the claim is about the system, and only a fault can tell the two apart.
#
#   B1  the hard-ceiling NOT EXISTS is removed from INSERT_RESERVATION_IF_AVAILABLE_SQL
#         -> the burst must oversell: 8 requests for 240 against a limit of 100
#   B2  the outstanding-reservation subquery stops counting `status = 'reserved'`
#         -> capacity freed by a release is not reclaimed, so the reuse must be refused
#   B3  the `inference_requests` EXISTS is removed
#         -> EXPECTED MISSED: the route resolves the request first and refuses with 404
#            before the statement runs, so the SQL clause is a second line for the same rule
#
# B1 is the case that matters. B2 and B3 are the two sub-clauses that make the same
# statement do the right thing for a second reason, so they are here to show the probe
# reads each one rather than passing on B1 alone.
#
# Restore uses `cp` against a SNAPSHOT, and the product is checked by content afterwards --
# V01-002 and V01-003 both turned on a restore that reported success and changed nothing.
#
# Usage:  bash evidence/v01-006-sensitivity.sh [--apply]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
REPO="$ROOT/apps/api/src/repositories/budgets.rs"
PROBE="$ROOT/apps/api/scripts/v01-budget-concurrency-probe.mjs"
WORK="$ROOT/target/v01-budget-sensitivity"

mkdir -p "$WORK/snapshot"
cp "$REPO" "$WORK/snapshot/budgets.rs" || exit 2
[[ "$(ls -1 "$WORK/snapshot" | wc -l | tr -d ' ')" == "1" ]] || {
  echo "the snapshot is incomplete -- refusing to run a harness that may not restore"
  exit 2
}

restore() {
  cp "$WORK/snapshot/budgets.rs" "$REPO"
  if diff -q "$WORK/snapshot/budgets.rs" "$REPO" >/dev/null; then
    echo "restored the product (verified against the snapshot)"
    return 0
  fi
  echo "RESTORE FAILED -- DO NOT TRUST ANY RESULT"
  return 1
}

product_is_clean() {
  local bad=0
  grep -q "INSERT_RESERVATION_IF_AVAILABLE_SQL" "$REPO" || {
    echo "  the conditional-insert constant is gone"; bad=1; }
  grep -q "rv.status = 'reserved'" "$REPO" || {
    echo "  the outstanding-reservation filter is gone"; bad=1; }
  grep -q "FROM inference_requests r" "$REPO" || {
    echo "  the inference correlation is gone"; bad=1; }
  return $bad
}

trap 'restore; product_is_clean || echo "THE PRODUCT IS NOT IN ITS ORIGINAL STATE"' EXIT INT TERM

# Did the mutation actually change the file? `set -e` catches a failed python heredoc, but
# only if the heredoc is the last command of the script -- so this is checked explicitly as
# well, because a mutation that silently applied nothing produces a MISSED that looks like
# evidence.
mutation_applied() {
  if diff -q "$WORK/snapshot/budgets.rs" "$REPO" >/dev/null; then
    echo "MUTATION DID NOT APPLY -- the product is unchanged, so this case would grade a run"
    echo "that never happened. Aborting."
    exit 2
  fi
}

run_probe() {
  local label="$1"
  pkill -9 -f workerd 2>/dev/null
  sleep 1
  rm -rf "$WORK/$label"
  # A mutated build is expected to make the probe exit 1, so its status is recorded
  # rather than allowed to abort the harness under `set -e`.
  V01_BUDGET_PERSIST_TO="$WORK/$label" node "$PROBE" > "$WORK/$label.log" 2>&1 || true
  grep -cE "^  FAIL" "$WORK/$label.log" > "$WORK/$label.failures" || true
}

# Did the claim's own assertion fail in the broken build?
fired() {
  local log="$1" needle="$2"
  grep -E "^  FAIL  ${needle}" "$log" >/dev/null && echo "detected" || echo "MISSED"
}

report() {
  local label="$1" log="$2"
  echo
  echo "=== $label ==="
  grep -E "^  (PASS|FAIL)  (concurrent reservations|the burst granted|the burst is refused|a denied reservation|a granted reservation can be released|releasing a reservation|a request denied during|for a request the server has never seen|a reservation against a budget)" \
    "$log" | cut -c1-210
  grep -E "concurrent reservations of" "$log" | cut -c1-160
}

[[ "${1:-}" == "--apply" ]] || { echo "pass --apply to drive the broken product"; exit 2; }

run_probe baseline
echo "baseline: $(grep -oE '[0-9]+/[0-9]+ [A-Za-z0-9 -]+cases hold' "$WORK/baseline.log" | tail -1)"
[[ -s "$WORK/baseline.log" ]] || { echo "the baseline produced nothing; refusing to grade"; exit 2; }

# --- B1: the ceiling is neutralised, and the statement stays valid ----------------
python3 - "$REPO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().split("\n")
# Two `NOT EXISTS` blocks precede `< ?4`. The first is the duplicate-request guard; the
# ceiling is the second, identified by the table it selects from. Testing the *span* from a
# candidate to `< ?4` is what made the first version ambiguous -- the first candidate's span
# contains the second's text, so a substring test on the span matches for both.
end = next(i for i, l in enumerate(lines) if l.strip() == "< ?4")
candidates = [i for i, l in enumerate(lines[:end]) if l.strip() == "AND NOT EXISTS ("]
assert len(candidates) == 2, f"expected 2 NOT EXISTS blocks, found {len(candidates)}"
start = next(
    i for i in candidates
    if any("FROM budgets b" in line for line in lines[i:i + 4])
)
assert "b.limit_minor" in "\n".join(lines[start:end]), "the chosen block is not the ceiling"
assert not any("budget_reservations existing" in line for line in lines[start:end]), \
    "the chosen block is the duplicate guard, not the ceiling"

# Neutralise the arithmetic rather than deleting the block. The polarity matters: the clause
# is `NOT EXISTS (... < ?4)`, so a LIMIT THAT IS ALWAYS LITTLE makes the subquery always
# true, the NOT EXISTS always false, and every reservation refused -- which is a denial, not
# an overspend. The mutation has to make the condition always FALSE, so the limit becomes a
# number no burst can approach.
#
# Deleting it leaves a dangling `AND`, SQLite rejects the statement, every request answers
# 5xx, and the probe's ceiling assertion passes VACUOUSLY on zero reservations -- so the case
# is caught by the "no 5xx" assertion instead of by the claim it exists to test. A mutation
# that breaks the build reports a different defect than the one under test, which is the
# `KILLED_FOR_THE_WRONG_REASON` shape this repository has hit twice already.
target = next(i for i in range(start, end) if "b.limit_minor" in lines[i])
lines[target] = lines[target].replace("b.limit_minor", "999999999")
p.write_text("\n".join(lines))
print(f"B1 applied: the ceiling limit is unreachable, the statement stays valid (line {target + 1})")
PY
mutation_applied
run_probe b1
B1=$(fired "$WORK/b1.log" "concurrent reservations do not collectively exceed")
report "B1: the hard ceiling is removed" "$WORK/b1.log"
restore

# --- B2: released capacity is not reclaimed ------------------------------------
python3 - "$REPO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().split("\n")
# The clause is found by its TEXT, not by an indentation guess. The first version matched a
# literal `\n          AND rv.status` at eight spaces against a line indented eighteen, the
# assert failed, and -- before `mutation_applied` existed -- the case graded a probe run
# against the unmutated product and reported MISSED. Three cases did that at once.
# The predicate appears three times in the file, so matching on it alone is not enough: the
# one to remove is the one inside THIS statement's outstanding-reservation sum, which is the
# block introduced by `FROM budget_reservations rv` (as opposed to `FROM budget_reservations
# existing`, the duplicate guard, and to any other statement in the repository file).
insert_start = next(
    i for i, l in enumerate(lines) if l.startswith("const INSERT_RESERVATION_IF_AVAILABLE_SQL")
)
insert_end = next(i for i in range(insert_start + 1, len(lines)) if lines[i].rstrip() == '"#;')
targets = [
    i for i in range(insert_start, insert_end)
    if lines[i].strip() == "AND rv.status = 'reserved'"
]
assert len(targets) == 1, (
    f"expected one status filter inside INSERT_RESERVATION_IF_AVAILABLE_SQL, "
    f"found {len(targets)}"
)
del lines[targets[0]]
p.write_text("\n".join(lines))
print(f"B1/B2 applied: the outstanding-reservation sum ignores status (line {targets[0] + 1})")
PY
mutation_applied
run_probe b2
# Removing the status filter makes a RELEASED reservation keep holding its amount, so
# the capacity is not reclaimed and the retry of a denied request is refused. That is the
# assertion that fires -- not the one naming the release, which still succeeds.
B2=$(fired "$WORK/b2.log" "a request denied during the burst can reserve")
report "B2: released capacity is not reclaimed" "$WORK/b2.log"
restore

# --- B3: no inference correlation ----------------------------------------------
# EXPECTED to report MISSED, and that is the product being right rather than the probe
# being weak. `create_reservation` resolves the request itself, first:
#
#     let inference = repository
#         .find_inference_request_scope(&org_id, &request_id)
#         .await
#         .map_err(|_| budget_state_unavailable(&context))?
#         .ok_or_else(|| not_found(&context, "resource_not_found"))?;
#
# so an uncorrelated request is refused with 404 before the statement is ever reached, and
# removing the statement's own `EXISTS (inference_requests)` changes nothing observable. The
# SQL clause is a SECOND line for the same rule, which is the same shape as V01-003's M2 and
# V01-004's A1/A3. A joint mutation that removes both would break the probe's own fixture --
# every request it makes has a real inference row -- so it would measure the fixture rather
# than the claim. The attack exists in the probe regardless: it is what proves the ROUTE-level
# refusal, and it would catch a future change that dropped the route's lookup.
python3 - "$REPO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
# Two-space indentation, found by content rather than by an indentation guess -- the same
# mistake that made B2's first version fail its assert silently.
old = """  AND EXISTS (
      SELECT 1 FROM inference_requests r
      WHERE r.request_id = ?2 AND r.org_id = ?3
  )"""
assert old in s, "the inference-correlation clause is not where the mutation expects it"
s = s.replace(old, "  AND ?2 IS NOT NULL", 1)
p.write_text(s)
print("B3 applied: a reservation no longer needs a correlated inference request")
PY
mutation_applied
run_probe b3
B3=$(fired "$WORK/b3.log" "a reservation for a request the server has never seen is refused")
report "B3: no inference correlation" "$WORK/b3.log"
restore

echo
echo "=== summary ==="
echo "  B1 the hard ceiling is removed:        $B1"
echo "  B2 released capacity is not reclaimed: $B2"
echo "  B3 no inference correlation:           $B3"
if ! product_is_clean; then
  echo
  echo "RESULT: INVALID -- the product is not in the state this script found it in."
  exit 1
fi
# B3 is an expected MISSED and does not gate the exit code. B1 and B2 do: B1 is the claim
# under test, and B2 is the mechanism that makes a released hold stop counting.
ok=1
[[ "$B1" == detected ]] || ok=0
[[ "$B2" == detected ]] || ok=0
[[ $ok -eq 1 ]]
