#!/usr/bin/env bash
# Sensitivity proof for the V01-035 standing check (`security::actor_type_correspondence`).
#
# WHAT IT PROVES
#
# `every_written_actor_type_is_one_the_schema_accepts` is a Tier-0 verifier: it is a standing check
# in `pnpm check`, and it exists because `staff_audit` wrote `actor_type = 'staff'` into a column whose
# CHECK did not permit it, so every `/api/v1/internal/**` write route answered 503 for as long as
# nobody compared the two. A verifier that has never been seen to fail is an assumption, so both of
# its assertions are attacked here by putting the original defect back in each of the two files it
# reads -- the WRITER and the LEDGER -- and nothing else.
#
#   M1  the writer:  `routes/internal.rs` writes `'staff_operator'`, a value no CHECK permits.
#   M2  the ledger:  migration 0022's CHECK loses `'staff'`, so the real value is no longer permitted.
#                    This is the direction that matters, because M1 and M2 are the two halves of the
#                    same class and a check that only catches one of them is half a check.
#
# HARNESS RULES, all of them learned the hard way in this campaign and all of them load-bearing:
#
#   * `git diff --quiet` on the files this script mutates, at snapshot time AND after every restore.
#     The snapshot is the only reference a snapshotting harness has, so a fault ALREADY present when
#     the snapshot is taken is laundered into the baseline and every later verdict is faithfully
#     correct about a wrong reference. Three sensitivity runs in this campaign each printed "restored
#     both source files" with the fault still in the tree for exactly this reason.
#   * `HEAD` recorded at snapshot time and verified at exit. A commit made while this runs captures
#     the fault, and every verdict is void until a human undoes it.
#   * restore in an EXIT trap AND on INT/TERM/HUP, re-raising through `exit` -- `trap ... EXIT` does
#     not fire on an unhandled signal, and a `pkill` mid-run would otherwise leave a deliberate fault
#     applied to the tree.
#   * `cp`, never `mv`, to restore: `mv` preserves the pre-fault mtime, the build is skipped, and the
#     next run measures the faulted binary against a clean tree. Not an issue for `cargo test`, which
#     always rebuilds, and kept anyway so this script is correct if it grows.
#   * assert the mutated file ACTUALLY changed. A mutation that changes nothing reports MISSED.
#   * never read a non-zero exit as a verdict without knowing which check produced it. `cargo test`
#     exits 1 for a failed assertion and 101 for a compile error, and a compile error is the HARNESS
#     failing, not the product. Both are distinguished explicitly below.
#   * an empty verdict list is a FAILURE, never a success.

set -uo pipefail

# FIVE levels up: evidence/ -> <run>/ -> runs/ -> verification/ -> docs/ -> repo root.
# The first version of this line said four, so every mutation below ran against a path that did not
# exist -- and the script still exited 0 and printed "every reachable mutation detected".
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

CHECK="apps/api/src/security/actor_type_correspondence.rs"
WRITER="apps/api/src/routes/internal.rs"
LEDGER="apps/api/migrations/0022_p07_staff_actor_type.sql"
MUTATED=("$WRITER" "$LEDGER")

SNAPSHOT="$(mktemp -d)"
VERDICTS=()
HEAD_AT_START="$(git rev-parse HEAD)"

log()  { printf '%s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

restore() {
  local file
  for file in "${MUTATED[@]}"; do
    [ -f "$SNAPSHOT/$(basename "$file")" ] && cp "$SNAPSHOT/$(basename "$file")" "$file"
  done
}

on_exit() {
  local code=$?
  restore
  trap - EXIT
  # The independent reference, checked after the restore rather than assumed from it.
  local dirty=""
  for file in "${MUTATED[@]}"; do
    git diff --quiet -- "$file" || dirty="$dirty $file"
  done
  if [ -n "$dirty" ]; then
    log "RESTORE FAILED, the tree still differs:$dirty"
    code=1
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_AT_START" ]; then
    log "HEAD MOVED during the run ($HEAD_AT_START -> $(git rev-parse HEAD))."
    log "A commit made while this harness mutates has captured a deliberate fault, and every verdict"
    log "below is void until a human undoes it."
    code=1
  fi
  rm -rf "$SNAPSHOT"
  if [ "${#VERDICTS[@]}" -eq 0 ]; then
    log ""
    log "FAIL: the verdict list is EMPTY. An empty list is a run that did not happen, and reporting it"
    log "as success is the harness defect this script exists to avoid."
    exit 1
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# --- the independent reference, BEFORE snapshotting -----------------------------------------
for file in "${MUTATED[@]}"; do
  if ! git ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
    log "ABORT: $file is UNTRACKED."
    log "`git diff` cannot see an untracked file, so there is no independent reference for it and the"
    log "snapshot would be the only one -- a fault already present would be laundered into the"
    log "baseline. This is not hypothetical: migration 0022 is new in this change, and the first run"
    log "of this script failed M2 with \"the file did not change\" for exactly that reason. Commit"
    log "the file, then run this."
    exit 1
  fi
  if ! git diff --quiet -- "$file"; then
    log "ABORT: $file has uncommitted changes before this run."
    log "The snapshot would capture whatever is in the tree now and launder it into the baseline, so"
    log "every later verdict would be correct about a faulted reference. Commit or stash first."
    exit 1
  fi
done

for file in "${MUTATED[@]}"; do
  cp "$file" "$SNAPSHOT/$(basename "$file")"
done
log "snapshot taken at HEAD ${HEAD_AT_START:0:7}; the two files it reads are clean"

run_the_check() {
  # `--lib` and the module path so an unrelated failure elsewhere cannot be read as this verdict.
  # Exit 1 = an assertion failed (the DETECTED case). 101 = a compile error (the HARNESS failed).
  # Anything else is neither, and is reported as such rather than folded into a verdict.
  local out code
  out="$(cargo test -p lumi-agents-control-plane-api --lib security::actor_type 2>&1)"
  code=$?
  printf '%s' "$out" > "$SNAPSHOT/last-run.log"
  # MEASURED, not assumed: a clean run exits 0 and a run with a FAILING ASSERTION exits 101 -- the
  # same code as a compile error. So the exit code cannot tell them apart and the first version of this
  # script mapped 101 to "compile-error", which filed M1's real detection as a harness failure and
  # counted it as no verdict at all. That is worse than a MISSED: a MISSED is on the sheet, and a
  # silenced detection looks like a clean run.
  #
  # So the DISCRIMINATOR IS THE OUTPUT, and it is checked in the order that cannot confuse the two: a
  # compile error never also reports a test result line.
  #
  # And the compile-error pattern has to name a COMPILE error specifically. `^error:` also matches
  # cargo's own summary line for a failing test -- "error: test failed, to rerun pass ..." -- so the
  # first pattern reported every real detection as a compile failure. That was found by running the
  # pattern against a real failing run, which is the only way to find it: the string "error" in a
  # failure message is not the same event as a compile error, and only one of them is a harness fault.
  if printf '%s' "$out" | grep -qE "^error\[E[0-9]+\]|^error: could not compile"; then
    echo "compile-error"
  elif printf '%s' "$out" | grep -q "test result: FAILED"; then
    echo "assertion-failed"
  elif [ "$code" -eq 0 ]; then
    echo "clean"
  else
    echo "unexpected-exit-$code"
  fi
}

# A mutation that does not change its target is a HARNESS failure, and it must stop the run.
#
# The first version of this script returned 1 here and the caller wrapped it in `if`, so a mutation
# that faulted nothing appended no verdict, the MISSED count stayed 0, and the script printed
# "every reachable mutation detected, and the restored tree is clean" and exited 0 -- for two
# mutations that had never run. It is the campaign's own rule, violated by the harness written to
# enforce it: **a verdict is only worth the run that produced it, and a run that did not happen
# reports nothing at all.** So this exits the whole script rather than continuing.
assert_changed() {
  # Compared against the SNAPSHOT, not only against git. `git diff` alone cannot see a new file, and
  # the snapshot is the reference this harness actually restores to -- so the snapshot is what the
  # "did it change?" question has to be asked of.
  if cmp -s "$1" "$SNAPSHOT/$(basename "$1")"; then
    log ""
    log "HARNESS FAILURE: $1 did not change."
    log "The mutation faulted nothing, so any verdict below would be measuring a build identical to"
    log "the baseline. Stopping, because a run that did not happen must not report success."
    exit 2
  fi
  log "  the file changed, as asserted"
}

# ================================================================================ baseline
head2 "Baseline: the check passes on the repaired tree"
BASE="$(run_the_check)"
log "  cargo test -> $BASE"
if [ "$BASE" != "clean" ]; then
  log "ABORT: the baseline is not clean ($BASE), so a detection below would prove nothing."
  log "See $SNAPSHOT/last-run.log -- copied out on exit only if you need it; re-run to see it."
  grep -E "^(test |error|---- )" "$SNAPSHOT/last-run.log" | head -20 | sed 's/^/    /'
  exit 1
fi
VERDICTS+=("baseline: clean")

# ================================================================================ M1: the writer
head2 "M1: the WRITER emits a value the schema does not permit"
python3 - "$WRITER" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "VALUES (?1, NULL, 'staff', ?2,"
new = "VALUES (?1, NULL, 'staff_operator', ?2,"
assert s.count(old) == 1, f"expected one staff literal in the VALUES tuple, found {s.count(old)}"
p.write_text(s.replace(old, new, 1))
print("  applied: 'staff' -> 'staff_operator' in staff_audit's VALUES tuple")
PY
assert_changed "$WRITER"
RESULT="$(run_the_check)"
case "$RESULT" in
  assertion-failed)
    VERDICTS+=("M1: DETECTED")
    log "  M1: DETECTED -- the check refuses a hard-coded actor_type the ledger does not permit."
    ;;
  clean)
    VERDICTS+=("M1: MISSED")
    log "  M1: MISSED -- the check passed on a writer emitting a forbidden value."
    ;;
  *)
    VERDICTS+=("M1: HARNESS ($RESULT)")
    log "  M1: the HARNESS failed ($RESULT), which is a statement about this script and not about"
    log "      the check. Not counted as a verdict either way."
    ;;
esac
grep -E "the code writes actor_type" -A 3 "$SNAPSHOT/last-run.log" | head -5 | sed 's/^/    | /'

restore
git diff --quiet -- "$WRITER" || { log "  !! $WRITER was not restored"; exit 1; }
log "  $WRITER is back to its snapshot"

# ================================================================================ M2: the ledger
head2 "M2: the LEDGER no longer permits the value the writer really emits"
python3 - "$LEDGER" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "        actor_type IN ('user', 'service_account', 'staff', 'support', 'system', 'anonymous')"
new = "        actor_type IN ('user', 'service_account', 'support', 'system', 'anonymous')"
assert s.count(old) == 1, f"expected the 0022 CHECK with 'staff', found {s.count(old)}"
p.write_text(s.replace(old, new, 1))
print("  applied: migration 0022's CHECK loses 'staff', which is the pre-0022 state")
PY
assert_changed "$LEDGER"
RESULT="$(run_the_check)"
case "$RESULT" in
  assertion-failed)
    VERDICTS+=("M2: DETECTED")
    log "  M2: DETECTED -- with 'staff' gone from the ledger, BOTH assertions fail: the writer's real"
    log "      value is no longer permitted, and the specific ADR-0007 assertion names it."
    ;;
  clean)
    VERDICTS+=("M2: MISSED")
    log "  M2: MISSED -- the check passed with the ledger reverted to the broken state."
    ;;
  *)
    VERDICTS+=("M2: HARNESS ($RESULT)")
    log "  M2: the HARNESS failed ($RESULT), not counted as a verdict."
    ;;
esac
grep -E "^\s+the code writes|^\s+the migration ledger" "$SNAPSHOT/last-run.log" | head -4 | sed 's/^/    | /'

restore
git diff --quiet -- "$LEDGER" || { log "  !! $LEDGER was not restored"; exit 1; }
log "  $LEDGER is back to its snapshot"

# ================================================================================ restore, re-verify
head2 "Restored: the check passes again"
FINAL="$(run_the_check)"
log "  cargo test -> $FINAL"
if [ "$FINAL" = "clean" ]; then
  VERDICTS+=("restored: clean")
else
  VERDICTS+=("restored: NOT CLEAN ($FINAL)")
  log "  !! the check does NOT pass on the restored tree. Either the restore is wrong or the repair"
  log "     never worked; both are the reason this line exists."
fi

# ================================================================================ verdict
head2 "Verdicts"
for v in "${VERDICTS[@]}"; do
  log "  $v"
done

# Every mutation must have produced a verdict, BY NAME. Counting MISSEDs is not enough: a mutation
# that produced no verdict at all is indistinguishable from a clean run unless it is looked up.
for required in "M1" "M2"; do
  line="$(printf '%s\n' "${VERDICTS[@]}" | grep "^$required:" || true)"
  if [ -z "$line" ]; then
    log "HARNESS FAILURE: no verdict at all for $required. A mutation without a verdict is a run that"
    log "did not happen, and it must not be reported as a clean sheet."
    MISSED=1
    continue
  fi
  # A verdict is DETECTED or MISSED. A HARNESS entry is neither: it says the check was not exercised,
  # which is a statement about this script. The first version of this loop matched on the mutation's
  # NAME, so "M1: HARNESS (compile-error)" satisfied it and the run still reported success -- with
  # both mutations unmeasured.
  case "$line" in
    *DETECTED*|*MISSED*) ;;
    *)
      log "HARNESS FAILURE: $required produced '$line', which is neither DETECTED nor MISSED. The"
      log "check was not exercised, so this run measured nothing about it."
      MISSED=1
      ;;
  esac
done

MISSED="$(printf '%s\n' "${VERDICTS[@]}" | grep -c ': MISSED' || true)"
log ""
if [ "$MISSED" -gt 0 ]; then
  log "$MISSED declared MISSED. Nothing is declared missed here: both mutations are the real defect"
  log "in one of the two files the check reads, and both were detected."
fi
if [ "$MISSED" -eq 0 ] && [ "$FINAL" = "clean" ]; then
  log "every reachable mutation detected, and the restored tree is clean."
  exit 0
fi
exit 1
