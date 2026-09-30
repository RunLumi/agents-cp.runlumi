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
TARGET2="apps/api/src/routes/inference.rs"
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
    cp "$SNAP/inference.rs" "$TARGET2"; touch "$TARGET2"
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

for f in "$TARGET" "$TARGET2" "$PROBE"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || {
    echo "FATAL: $f is untracked; a snapshot cannot restore what git cannot see" >&2; exit 2; }
  if ! git diff --quiet -- "$f"; then
    echo "FATAL: uncommitted changes in $f. A snapshot taken now would launder that state into the" >&2
    echo "       baseline, and every later comparison would be correct about a wrong reference." >&2
    exit 2
  fi
done
cp -p "$TARGET" "$SNAP/ai.rs"
cp -p "$TARGET2" "$SNAP/inference.rs"
cp -p "$PROBE" "$SNAP/probe.mjs"

restore() {
  cp "$SNAP/ai.rs" "$TARGET"; touch "$TARGET"
  cp "$SNAP/inference.rs" "$TARGET2"; touch "$TARGET2"
  cp "$SNAP/probe.mjs" "$PROBE"; touch "$PROBE"
  cmp -s "$TARGET" "$SNAP/ai.rs" \
    && cmp -s "$TARGET2" "$SNAP/inference.rs" \
    && cmp -s "$PROBE" "$SNAP/probe.mjs" \
    || { echo "  FATAL: restore did not match the snapshot" >&2; return 1; }
  echo "  restored (cp + touch, all three verified with cmp)"
}

# Stop any live worker and WAIT FOR IT TO BE GONE before touching its persist directory.
#
# `pkill` returns as soon as the signal is delivered, so removing the persist dir 3 seconds later can
# race miniflare recreating it from the previous run's state. Two of this script's four cases came
# back `exit=2, no sheet` from exactly that -- and the harness's rule is that exit 2 means "could
# not run", which this script correctly reported as DETECTED. That is the worst possible direction
# for a false verdict: a flaky start reads as a successful detection. The poll makes it a harness
# fact rather than a coincidence.
settle_worker() {
  pkill -9 -f workerd 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    pgrep -f workerd >/dev/null 2>&1 || return 0
    sleep 1
  done
  pkill -9 -f workerd 2>/dev/null
  sleep 2
}

run_case() {
  local name="$1" expect="$2"
  echo ""
  echo "=== $name ==="
  MUTATING=1
  settle_worker
  rm -rf target/v01-hc-sens
  V01_BUDGETCEILING_PERSIST_TO="$REPO/target/v01-hc-sens" \
    node apps/api/scripts/v01-budget-hardceiling-probe.mjs > "$LOG" 2>&1
  local rc=$?
  local sheet
  sheet="$(grep -oE '[0-9]+/[0-9]+ V01 budget hard-ceiling' "$LOG" | tail -1)"
  local verdict="MISSED"
  # A build failure is not a detection. The harness exits 2 when it cannot run, and reporting that
  # as DETECTED is the worst possible direction for a false verdict -- so a case whose Worker log
  # carries a rustc diagnostic is reported INVALID and excluded from the sheet. This is the V01-004
  # lesson: a mutation must break the CLAIM, not the statement.
  if [ "$rc" -eq 2 ] && grep -qE "^error\[E|error: could not compile|failed to execute .cargo build" "$LOG"; then
    verdict="INVALID"
    echo "    the mutation did not compile:"
    grep -E "^error" "$LOG" | head -3 | sed 's/^/      /' | cut -c1-130
  elif [ "$rc" -ne 0 ]; then
    verdict="DETECTED"
  fi
  echo "  exit=$rc  ${sheet:-no sheet}  -> $verdict"
  grep -E '^  FAIL' "$LOG" | head -6 | sed 's/^/    /' | cut -c1-140
  restore || true
  if [ "$verdict" = "INVALID" ]; then
    VERDICTS+=("$name INVALID-did-not-compile")
    MUTATING=0
    return 0
  fi
  if [ "$verdict" = "$expect" ]; then
    VERDICTS+=("$name $verdict (expected $expect)")
  else
    VERDICTS+=("$name $verdict (EXPECTED $expect) -- DISAGREEMENT")
  fi
  MUTATING=0
}

echo "=== baseline ==="
settle_worker
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

# --- M1: remove the APPLICATION-level precheck (layer 1) ---------------------------------------
#
# The first two attempts at this script aimed only at the SQL ceiling and both came back MISSED.
# That was correct, and it is the finding: the unmanaged path enforces the budget TWICE, so neither
# layer alone is the control.
#
#   layer 1  `hard_budget_remaining(&org_id, now)` compared against `reservation_minor`
#            (`routes/inference.rs:1662-1666`) -- an explicit application-level precheck;
#   layer 2  the `WHERE NOT EXISTS (...)` ceiling inside
#            `INSERT_BUDGET_RESERVATION_IF_AVAILABLE_SQL` -- defence in depth, and the only budget
#            work an unmanaged request actually does.
#
# M1 removes layer 1 and the class still passes, because layer 2 catches it. Expect: MISSED, declared
# rather than treated as a gap in the class.
#
# Two earlier mistakes are recorded because both produced a FALSE VERDICT rather than a weak one:
#
#   * `< ?4` -> `< ?4 + 1e18` did not DISABLE the control, it INVERTED it. With a threshold that
#     large, EXISTS finds a row for every budget, so the INSERT matched nothing and the request was
#     refused -- which is exactly what the class asserts. **Weakening a control is not the same as
#     removing one**, and only the second is a defect.
#   * renaming the pattern binding to `_remaining` broke the BUILD (`E0425`: it is used later in the
#     same match arm), and the harness exited 2 -- which this script reported as DETECTED, the worst
#     possible direction for a false verdict. `run_case` now discriminates a rustc diagnostic in the
#     Worker log and reports INVALID instead.
python3 - <<'MUTATE_M1'
import pathlib
f = pathlib.Path("apps/api/src/routes/inference.rs")
s = f.read_text()
old = "Ok(Some(remaining)) if remaining < reservation_minor => {"
assert s.count(old) == 1, f"expected exactly one precheck, found {s.count(old)}"
# `remaining` STAYS NAMED: it is used later in the same match arm, so renaming it breaks the build,
# and an unused binding is only a warning. Only the comparison is removed, so the read still happens
# -- a mutation that breaks the claim and not the statement.
s = s.replace(old, "Ok(Some(remaining)) if false && remaining < reservation_minor => {", 1)
f.write_text(s)
MUTATE_M1
cmp -s "$TARGET2" "$SNAP/inference.rs" && { echo "M1 changed nothing" >&2; exit 1; }
run_case "M1 (the application precheck removed)" "MISSED"

# --- M2: remove the SQL ceiling (layer 2) --------------------------------------------------------
python3 - <<'MUTATE_M2'
import pathlib
f = pathlib.Path("apps/api/src/repositories/ai.rs")
s = f.read_text()
old = "WHERE b.org_id = ?3 AND b.hard = 1"
assert s.count(old) == 1, f"expected exactly one hard predicate, found {s.count(old)}"
s = s.replace(old, "WHERE b.org_id = ?3 AND b.hard = 1 AND b.hard = 0", 1)
f.write_text(s)
MUTATE_M2
cmp -s "$TARGET" "$SNAP/ai.rs" && { echo "M2 changed nothing" >&2; exit 1; }
run_case "M2 (the SQL ceiling removed)" "MISSED"

# --- M3: remove ALL THREE guards ------------------------------------------------------------------
#
# The first version of this mutation removed only the two guards I had identified, and the class
# still reported 25/25. That MISSED was correct and it was the interesting result: the third guard
# exists and I had not found it. The follow-up is a deliberate READ of the unmanaged path rather than
# another guess, and it found the missing layer immediately:
#
#   guard 3  `routes/inference.rs:1834` --
#               if D1Adapter::changes(&initial_results[1]).unwrap_or_default() != 1 { ... }
#
# `initial_results[1]` is the RESERVATION statement (`initial_statements =
# vec![request_statement, reservation_statement]`), so this reads the reservation INSERT's
# rows-affected and refuses with `budget_exceeded` when it did not match exactly one row. And it is
# **not gated on `scope.managed_run`**, unlike the rows-affected check at line 1875 which is.
#
# That is the V01-042 shape handled correctly: an INSERT matching zero rows neither aborts a D1
# batch nor raises an error, so the only way to notice is to read `changes()`. The class's B4
# assertion -- the reservation count is unchanged -- is exactly what this guard produces, which is
# why B4 and not the status is the assertion that matters.
#
# With all three removed, nothing on the unmanaged path consults a budget before dispatch. Expect:
# DETECTED.
python3 - <<'MUTATE_M3A'
import pathlib
f = pathlib.Path("apps/api/src/routes/inference.rs")
s = f.read_text()
# Guard 1: the application precheck. `remaining` STAYS NAMED -- it is used later in the same match
# arm, so renaming it to `_remaining` breaks the build (E0425), and a mutation that breaks the build
# measures the compiler rather than the claim.
old1 = "Ok(Some(remaining)) if remaining < reservation_minor => {"
assert s.count(old1) == 1, f"expected one precheck, found {s.count(old1)}"
s = s.replace(old1, "Ok(Some(remaining)) if false && remaining < reservation_minor => {", 1)

# Guard 3: the rows-affected check. `!= 2` is never true for a single INSERT that matched one row,
# so the refusal is gone while `initial_results` stays referenced and the statement stays valid.
old3 = "if crate::adapters::d1::D1Adapter::changes(&initial_results[1]).unwrap_or_default() != 1 {"
assert s.count(old3) == 1, f"expected one rows-affected check, found {s.count(old3)}"
s = s.replace(
    old3,
    "if crate::adapters::d1::D1Adapter::changes(&initial_results[1]).unwrap_or_default() != 2 {",
    1,
)
f.write_text(s)
MUTATE_M3A

python3 - <<'MUTATE_M3B'
import pathlib
f = pathlib.Path("apps/api/src/repositories/ai.rs")
s = f.read_text()
# Guard 2: the SQL ceiling. An impossible predicate, so the subquery can never match a budget and the
# reservation INSERT always succeeds. Every placeholder stays bound and the bind count is unchanged,
# so `schema:bind-count` stays green throughout.
old2 = "WHERE b.org_id = ?3 AND b.hard = 1"
assert s.count(old2) == 1, f"expected one hard predicate, found {s.count(old2)}"
s = s.replace(old2, "WHERE b.org_id = ?3 AND b.hard = 1 AND b.hard = 0", 1)
f.write_text(s)
MUTATE_M3B

cmp -s "$TARGET" "$SNAP/ai.rs" && { echo "M3 changed no SQL" >&2; exit 1; }
cmp -s "$TARGET2" "$SNAP/inference.rs" && { echo "M3 changed no handler" >&2; exit 1; }
run_case "M3 (ALL THREE guards removed)" "DETECTED"

# --- M4: the probe's own fixture no longer creates a hard ceiling --------------------------------
python3 - <<'MUTATE_M4'
import pathlib
f = pathlib.Path("apps/api/scripts/v01-budget-hardceiling-probe.mjs")
s = f.read_text()
old = "const HARD_LIMIT_MINOR = 1;"
assert s.count(old) == 1, "the hard limit was not found in the expected form"
# A limit the request does NOT exceed, so there is no breach to detect and every refusal-shaped
# assertion should go quiet. Node reads the probe directly and cargo correctly does not rebuild.
s = s.replace(old, "const HARD_LIMIT_MINOR = 9_000_000_000;", 1)
f.write_text(s)
MUTATE_M4
cmp -s "$PROBE" "$SNAP/probe.mjs" && { echo "M4 changed nothing" >&2; exit 1; }
run_case "M4 (the ceiling is not actually exceeded)" "DETECTED"

# The final run is on the RESTORED tree, and it is the check that a repair and an unrepaired tree
# cannot be confused. It settles the worker first, because a stale miniflare still serving the
# faulted binary would produce a red sheet that looks like a broken restore -- the mirror of the
# false DETECTION a flaky start produces in the other direction.
restore
settle_worker
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
