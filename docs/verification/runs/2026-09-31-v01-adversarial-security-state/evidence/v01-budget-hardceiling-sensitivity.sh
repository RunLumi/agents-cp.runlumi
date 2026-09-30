#!/usr/bin/env bash
# ============================================================================================
# Sensitivity proof for the hard-ceiling class in `v01-budget-hardceiling-probe.mjs`.
#
# The claim: an exhausted HARD budget refuses the inference, holds no reservation, and adds no
# dispatched inference row. On the UNMANAGED path the entire enforcement is the
# `WHERE NOT EXISTS (...)` ceiling inside `INSERT_BUDGET_RESERVATION_IF_AVAILABLE_SQL`, so the
# statement is the whole control and these mutations are aimed at it.
#
# M1  weaken the ceiling from `< ?4` to `< 1e18`, so the EXISTS subquery can no longer find an
#     exceeded budget and the INSERT matches. `?4` stays bound and every placeholder count is
#     unchanged -- only the arithmetic moves. Expect: DETECTED (the attack would then reserve).
#
# M2  drop `AND b.hard = 1` so a SOFT budget also gates dispatch. This is the OPPOSITE direction
#     from a leak: it makes the control stricter, and the class must notice, because a gate that
#     only detects a weakened control cannot tell the difference between "the budget worked" and
#     "the budget was never consulted". Expect: DETECTED (B2's ceiling predicate and B3 both move).
#
# M3  declare the control's reservation machinery absent -- a probe-only mutation -- must be a
#     KNOWN MISSED, because node reads the probe directly and cargo correctly does not rebuild.
#     Recorded rather than dropped: the absence of a rebuild is not evidence about the product.
#
# Harness rules, each of which a previous harness in this campaign got wrong:
#   * `git rev-parse --show-toplevel`, never `dirname/..` (which resolved to a directory five
#     levels up, so every `git` call ran outside the repository and a tracked file was reported
#     untracked);
#   * refuse to run on a dirty tree scoped to the files it mutates -- a snapshot taken now would
#     launder that state into the baseline;
#   * snapshot with `cp -p`, RESTORE with `cp` + `touch`, because an mtime-preserving restore makes
#     an mtime-based build skip the rebuild and ship the fault (V01-044: measured, and it reported
#     a green sheet);
#   * traps on EXIT/INT/TERM/HUP that restore and then re-raise, since `trap ... EXIT` does not
#     fire for SIGTERM;
#   * a verdict required per mutation BY NAME, and an empty verdict list is a failure;
#   * `wrangler dev` rebuilds on every start (wrangler.jsonc sets `build.command`), so the probe
#     run itself is the fresh build.
# ============================================================================================
set -uo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO" ] || [ ! -d "$REPO/apps/api" ]; then
  echo "FATAL: could not locate the repository root; run this from inside it" >&2
  exit 2
fi
cd "$REPO"

TARGET="apps/api/src/repositories/ai.rs"
PROBE="apps/api/scripts/v01-budget-hardceiling-probe.mjs"
SNAP="$(mktemp -d)"
LOG="$(mktemp)"
VERDICTS=()
HEAD_AT_START="$(git rev-parse HEAD)"
MUTATING=0

cleanup() {
  local rc=$?
  if [ "$MUTATING" = "1" ]; then
    cp "$SNAP/ai.rs" "$TARGET"; touch "$TARGET"
    cp "$SNAP/probe.mjs" "$PROBE"; touch "$PROBE"
  fi
  if [ "${#VERDICTS[@]}" -eq 0 ] && [ "$rc" -ne 2 ]; then
    echo "FATAL: no verdict was produced for any mutation -- a run that measured nothing is not a pass" >&2
    rc=1
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_AT_START" ]; then
    echo "FATAL: HEAD moved during the run; a commit has captured the deliberate fault" >&2
    rc=1
  fi
  pkill -9 -f workerd 2>/dev/null
  rm -rf "$SNAP" "$LOG"
  exit $rc
}
trap cleanup EXIT
trap 'echo "interrupted; restoring" >&2; cleanup' INT TERM HUP

for f in "$TARGET" "$PROBE"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || {
    echo "FATAL: $f is untracked; a snapshot cannot restore what git cannot see" >&2; exit 2; }
  if ! git diff --quiet -- "$f"; then
    echo "FATAL: uncommitted changes in $f. A snapshot taken now would launder that state into the" >&2
    echo "       baseline, and every later comparison would be correct about a wrong reference." >&2
    exit 2
  fi
done
cp -p "$TARGET" "$SNAP/ai.rs"
cp -p "$PROBE" "$SNAP/probe.mjs"

restore() {
  cp "$SNAP/ai.rs" "$TARGET"; touch "$TARGET"
  cp "$SNAP/probe.mjs" "$PROBE"; touch "$PROBE"
  cmp -s "$TARGET" "$SNAP/ai.rs" || { echo "  FATAL: restore did not match the snapshot" >&2; return 1; }
  echo "  restored (cp + touch, verified with cmp)"
}

run_case() {
  local name="$1" expect="$2"
  echo ""
  echo "=== $name ==="
  MUTATING=1
  pkill -9 -f workerd 2>/dev/null; sleep 3
  rm -rf target/v01-hc-sens
  V01_BUDGETCEILING_PERSIST_TO="$REPO/target/v01-hc-sens" \
    node apps/api/scripts/v01-budget-hardceiling-probe.mjs > "$LOG" 2>&1
  local rc=$?
  local sheet
  sheet="$(grep -oE '[0-9]+/[0-9]+ V01 budget hard-ceiling' "$LOG" | tail -1)"
  local verdict="MISSED"
  [ "$rc" -ne 0 ] && verdict="DETECTED"
  echo "  exit=$rc  ${sheet:-no sheet}  -> $verdict"
  grep -E '^  FAIL' "$LOG" | head -6 | sed 's/^/    /' | cut -c1-140
  restore || true
  if [ "$verdict" = "$expect" ]; then
    VERDICTS+=("$name $verdict (expected $expect)")
  else
    VERDICTS+=("$name $verdict (EXPECTED $expect) -- DISAGREEMENT")
  fi
  MUTATING=0
}

echo "=== baseline ==="
pkill -9 -f workerd 2>/dev/null; sleep 3
rm -rf target/v01-hc-sens
V01_BUDGETCEILING_PERSIST_TO="$REPO/target/v01-hc-sens" \
  node apps/api/scripts/v01-budget-hardceiling-probe.mjs > "$LOG" 2>&1
BASE_RC=$?
BASE="$(grep -oE '[0-9]+/[0-9]+ V01 budget hard-ceiling' "$LOG" | tail -1)"
echo "  baseline: exit=$BASE_RC  $BASE"
if [ "$BASE_RC" -ne 0 ]; then
  echo "BASELINE IS NOT GREEN -- refusing to run; a detection against a red sheet proves nothing" >&2
  grep -E '^  FAIL' "$LOG" | head -6 >&2
  exit 2
fi
for needed in "B1 CONTROL" "B2 CONTROL" "B3:" "B4:" "B5:" "B5 CONTROL" "B6 SCOPE"; do
  grep -qF "$needed" "$LOG" || { echo "BASELINE LACKS the case this script attacks: $needed" >&2; exit 2; }
done
echo "  green, and every case the mutations attack is present"

# --- M1: the ceiling arithmetic ----------------------------------------------------------------
python3 - <<'PYEOF'
import pathlib, re
f = pathlib.Path("apps/api/src/repositories/ai.rs")
s = f.read_text()
# `- < ?4` is the whole ceiling. `?4` is the reserved amount; replacing the comparison with a
# constant that no budget can exceed leaves every placeholder bound and the statement valid, and
# only the arithmetic moves. This is the shape a single careless edit takes.
m = re.search(r"-\s*< \?4\s*\)\s*,", s)
assert m, "the ceiling comparison was not found in the expected form"
s = s[:m.start()] + "- < 1000000000000000000)," + s[m.end():]
f.write_text(s)
PYEOF
cmp -s "$TARGET" "$SNAP/ai.rs" && { echo "M1 changed nothing" >&2; exit 1; }
run_case "M1 (the ceiling arithmetic weakened)" "DETECTED"

# --- M2: a SOFT budget also gates dispatch --------------------------------------------------------
python3 - <<'PYEOF'
import pathlib
f = pathlib.Path("apps/api/src/repositories/ai.rs")
s = f.read_text()
old = "WHERE b.org_id = ?3 AND b.hard = 1"
assert s.count(old) == 1, "the hard=1 predicate was not found in the expected form"
# The OPPOSITE direction from a weakening: this makes the control STRICTER, and the class must
# notice. A gate that only detects a weakened control cannot tell "the budget worked" from "the
# budget was never consulted", which is the failure this mutation is aimed at.
s = s.replace(old, "WHERE b.org_id = ?3 AND b.hard IN (0, 1)", 1)
f.write_text(s)
PYEOF
cmp -s "$TARGET" "$SNAP/ai.rs" && { echo "M2 changed nothing" >&2; exit 1; }
run_case "M2 (a SOFT budget also gates dispatch)" "DETECTED"

# --- M3: a probe-only mutation --------------------------------------------------------------------
python3 - <<'PYEOF'
import pathlib
f = pathlib.Path("apps/api/scripts/v01-budget-hardceiling-probe.mjs")
s = f.read_text()
old = 'const HARD_LIMIT_MINOR = 1;'
assert s.count(old) == 1, "the hard limit was not found in the expected form"
# A limit the request does NOT exceed, so the ceiling is not reached and the attack should stop
# being an attack. Node reads the probe directly and cargo correctly does not rebuild -- which is
# exactly why this is a KNOWN MISSED for the artifact check and a real case for the class.
s = s.replace(old, "const HARD_LIMIT_MINOR = 9_000_000_000;", 1)
f.write_text(s)
PYEOF
cmp -s "$PROBE" "$SNAP/probe.mjs" && { echo "M3 changed nothing" >&2; exit 1; }
run_case "M3 (the ceiling is not actually exceeded)" "DETECTED"

restore
pkill -9 -f workerd 2>/dev/null; sleep 3
rm -rf target/v01-hc-sens
V01_BUDGETCEILING_PERSIST_TO="$REPO/target/v01-hc-sens" \
  node apps/api/scripts/v01-budget-hardceiling-probe.mjs > "$LOG" 2>&1
FINAL_RC=$?
FINAL="$(grep -oE '[0-9]+/[0-9]+ V01 budget hard-ceiling' "$LOG" | tail -1)"
echo ""
echo "  restored-tree: exit=$FINAL_RC  $FINAL"
[ "$FINAL_RC" -ne 0 ] && { echo "FATAL: the tree is not green after restore" >&2; exit 1; }

echo ""
echo "===================== SENSITIVITY RESULTS ====================="
for v in "${VERDICTS[@]}"; do echo "  $v"; done
echo "  $FINAL  restored-tree baseline (exit 0)"
echo "==============================================================="
