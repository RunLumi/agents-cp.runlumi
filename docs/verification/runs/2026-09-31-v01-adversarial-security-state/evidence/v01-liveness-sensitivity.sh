#!/usr/bin/env bash
# Sensitivity proof for `security::repository_liveness`.
#
# WHAT IT PROVES
#
# The check is Tier-0: it is in `pnpm check`, and it exists because three separate defects were each a
# repository capability that existed and could not be reached (V01-040's grant read, V01-041's
# enrollment denial, V01-042's idempotency purge). A verifier that has never been seen to fail is an
# assumption, so both halves of its contract are attacked here.
#
#   M1  a function that HAS a caller loses it. The check must then report it dead. This is the half that
#       catches a real regression: a capability quietly becoming unreachable.
#
#       M1 ADDS an uncalled capability rather than removing a caller, and that is deliberate. Two
#       earlier attempts removed a sole caller and both broke the build -- the harness reported
#       `compile-error` and correctly refused to count either as a verdict. In a statically linked
#       language, removing the only call to a function almost always fails to compile, so such a
#       mutation measures the compiler rather than the check. Adding an unwired capability is both
#       guaranteed to compile and the exact shape all three findings in this class actually had.
#   M2  a function that is genuinely dead is REMOVED from the reviewed list. The check must then report
#       it. This is the other half, and it is the one that matters most for the list's integrity: a
#       review list that can absorb entries silently is a permission slip, not a record of decisions.
#
# Attacking only M1 would prove the scan works and say nothing about whether the list is trustworthy.
#
# HARNESS RULES -- all of them learned the hard way in this campaign, all of them load-bearing:
#
#   * `git diff --quiet` on every file this script mutates, at snapshot time AND after every restore.
#     The snapshot is the only reference a snapshotting harness has, so a fault ALREADY present when the
#     snapshot is taken is laundered into the baseline and every later verdict is faithfully correct
#     about a wrong reference.
#   * `git ls-files --error-unmatch` on each mutated file: `git diff` cannot see an UNTRACKED file, so
#     an untracked one has no independent reference at all. Migration 0022 failed M2 on its first run
#     for exactly this reason.
#   * `HEAD` recorded at snapshot time and verified at exit. A commit made while this runs captures the
#     fault and every verdict is void until a human undoes it.
#   * restore in an EXIT trap AND on INT/TERM/HUP, re-raising through `exit` -- `trap ... EXIT` does not
#     fire on an unhandled signal.
#   * `cp`, never `mv`, to restore.
#   * assert the mutated file ACTUALLY changed, against the SNAPSHOT (`cmp`), not against git.
#   * discriminate compile-error from failed-assertion on the OUTPUT, not the exit code: `cargo test`
#     exits 101 for both, and `^error:` also matches cargo's own `error: test failed, to rerun pass ...`.
#   * a mutation that produces no verdict, or a verdict that is neither DETECTED nor MISSED, fails the
#     run. Four bugs in the sibling harness each silently converted a real detection into a no-verdict.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

CHECK="apps/api/src/security/repository_liveness.rs"
VICTIM="apps/api/src/repositories/automations.rs"
ADDED_FN="sensitivity_unwired_capability"
UNLISTED_FN="find_grants_for_staff_and_org"
MUTATED=("$CHECK" "$VICTIM")

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
  local dirty=""
  for file in "${MUTATED[@]}"; do
    cmp -s "$file" "$SNAPSHOT/$(basename "$file")" || dirty="$dirty $file"
  done
  if [ -n "$dirty" ]; then
    log ""
    log "RESTORE FAILED, these still differ from the snapshot:$dirty"
    code=1
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_AT_START" ]; then
    log ""
    log "HEAD MOVED during the run ($HEAD_AT_START -> $(git rev-parse HEAD)). A commit made while this"
    log "harness mutates has captured a deliberate fault, and every verdict below is void until a human"
    log "undoes it."
    code=1
  fi
  rm -rf "$SNAPSHOT"
  if [ "${#VERDICTS[@]}" -eq 0 ]; then
    log ""
    log "FAIL: the verdict list is EMPTY. An empty list is a run that did not happen, and reporting it as"
    log "success is the harness defect this script exists to avoid."
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
    log "ABORT: $file is UNTRACKED. \`git diff\` cannot see it, so there is no independent reference and"
    log "the snapshot would be the only one. Commit it, then run this."
    exit 1
  fi
  if ! git diff --quiet -- "$file"; then
    log "ABORT: $file has uncommitted changes. The snapshot would launder them into the baseline, so"
    log "every later verdict would be correct about a faulted reference. Commit or stash first."
    exit 1
  fi
done
for file in "${MUTATED[@]}"; do cp "$file" "$SNAPSHOT/$(basename "$file")"; done
log "snapshot taken at HEAD ${HEAD_AT_START:0:7}; both mutated files are clean and tracked"

run_the_check() {
  local out code
  out="$(cargo test -p lumi-agents-control-plane-api --lib security::repository_liveness 2>&1)"
  code=$?
  printf '%s' "$out" > "$SNAPSHOT/last-run.log"
  # `cargo test` exits 101 for a FAILED ASSERTION and for a COMPILE ERROR alike, and `^error:` also
  # matches cargo's own `error: test failed, to rerun pass ...`. So the discriminator is the output,
  # checked in an order that cannot confuse the two.
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

assert_changed() {
  if cmp -s "$1" "$SNAPSHOT/$(basename "$1")"; then
    log ""
    log "HARNESS FAILURE: $1 did not change. The mutation faulted nothing, so any verdict below would"
    log "be measuring a build identical to the baseline. Stopping, because a run that did not happen"
    log "must not report success."
    exit 2
  fi
  log "  the file changed, as asserted"
}

# ================================================================================ baseline
head2 "Baseline: the check passes on the current tree"
BASE="$(run_the_check)"
log "  cargo test -> $BASE"
if [ "$BASE" != "clean" ]; then
  log "ABORT: the baseline is not clean ($BASE), so a detection below would prove nothing."
  grep -E "^(test |error|---- )|repository function" "$SNAPSHOT/last-run.log" | head -20 | sed 's/^/    /'
  exit 1
fi
VERDICTS+=("baseline: clean")

# ================================================================================ M1
head2 "M1: a NEW capability is added and never wired"
# The mutation reproduces the HISTORICAL failure, which is the only kind worth reproducing.
#
# Two earlier attempts removed a function's sole caller, and both are instructive failures. The first
# (`active_passkey_count`) broke the build, because its result is bound. The second
# (`missed_target_state`) broke the build too, and the harness correctly reported `compile-error` and
# then correctly REFUSED to count it as a verdict.
#
# > In a statically linked language, removing the only call to a function almost always fails to
# > compile. So a "remove the caller" mutation measures the COMPILER, not the check.
#
# And the deeper point is that it is the wrong failure to reproduce. All three findings in this class
# -- V01-040, V01-041, V01-042 -- were capabilities that were ADDED and never wired, not ones whose
# callers disappeared. So M1 adds an uncalled `pub fn` to a repository file, which is exactly the shape
# of the defect, and which provably compiles: the 53 uncalled functions already in the tree compile
# clean under `-D warnings`, because a `pub` item is public API and `dead_code` does not fire.
python3 - "$VICTIM" "$ADDED_FN" <<'PY2'
import pathlib, sys
path, name = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
addition = (
    "\n/// SENSITIVITY M1: a capability that is declared and never wired -- the exact shape of\n"
    "/// V01-040, V01-041 and V01-042. Nothing calls this.\n"
    "pub fn " + name + "() -> &'static str {\n"
    "    \"never called\"\n"
    "}\n"
)
path.write_text(text + addition)
print(f"  applied: added an uncalled `pub fn {name}()` to {path}")
PY2
assert_changed "$VICTIM"
RESULT="$(run_the_check)"
case "$RESULT" in
  assertion-failed)
    if grep -q "$ADDED_FN" "$SNAPSHOT/last-run.log"; then
      VERDICTS+=("M1: DETECTED")
      log "  M1: DETECTED -- the check named $ADDED_FN, so a newly unwired capability cannot be added"
      log "      quietly. That is the shape all three findings in this class actually had."
    else
      VERDICTS+=("M1: DETECTED-WRONG-NAME")
      log "  M1: the check FAILED but did not name $ADDED_FN. A detection of some other function is not"
      log "      a detection of this one."
    fi
    ;;
  clean)     VERDICTS+=("M1: MISSED"); log "  M1: MISSED -- an uncalled capability passed." ;;
  *)         VERDICTS+=("M1: HARNESS ($RESULT)"); log "  M1: the HARNESS failed ($RESULT), not a verdict." ;;
esac
grep -E "repository function\(s\) have no non-test caller" -A 4 "$SNAPSHOT/last-run.log" | head -6 | sed 's/^/    | /'
restore
cmp -s "$VICTIM" "$SNAPSHOT/$(basename "$VICTIM")" || { log "  !! $VICTIM was not restored"; exit 1; }
log "  $VICTIM is back to its snapshot"

# ================================================================================ M2
head2 "M2: a genuinely dead function is REMOVED from the reviewed list"
python3 - "$CHECK" "$UNLISTED_FN" <<'PY'
import pathlib, re, sys
path, name = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
# Remove the tuple entry, keeping the array valid. Match the whole `("name", ...),` element.
pattern = re.compile(r'\n\s*\(\s*"' + re.escape(name) + r'"\s*,(?:[^()]|\([^()]*\))*\)', re.S)
new, n = pattern.subn("", text, count=1)
assert n == 1, f"expected one review-list entry for {name}, removed {n}"
path.write_text(new)
print(f"  applied: removed the review-list entry for {name}, which is genuinely uncalled")
PY
assert_changed "$CHECK"
RESULT="$(run_the_check)"
case "$RESULT" in
  assertion-failed)
    if grep -q "$UNLISTED_FN" "$SNAPSHOT/last-run.log"; then
      VERDICTS+=("M2: DETECTED")
      log "  M2: DETECTED -- with $UNLISTED_FN unlisted, the check reports it. So the reviewed list is"
      log "      what makes a function legal, not a formality the scan ignores."
    else
      VERDICTS+=("M2: DETECTED-WRONG-NAME")
      log "  M2: the check FAILED but did not name $UNLISTED_FN."
    fi
    ;;
  clean)     VERDICTS+=("M2: MISSED"); log "  M2: MISSED -- an unlisted dead function passed, so the list is a permission slip." ;;
  *)         VERDICTS+=("M2: HARNESS ($RESULT)"); log "  M2: the HARNESS failed ($RESULT), not a verdict." ;;
esac
grep -E "repository function\(s\) have no non-test caller" -A 4 "$SNAPSHOT/last-run.log" | head -6 | sed 's/^/    | /'
restore
cmp -s "$CHECK" "$SNAPSHOT/$(basename "$CHECK")" || { log "  !! $CHECK was not restored"; exit 1; }
log "  $CHECK is back to its snapshot"

# ================================================================================ restore, re-verify
head2 "Restored: the check passes again"
FINAL="$(run_the_check)"
log "  cargo test -> $FINAL"
if [ "$FINAL" = "clean" ]; then
  VERDICTS+=("restored: clean")
else
  VERDICTS+=("restored: NOT CLEAN ($FINAL)")
  log "  !! the check does NOT pass on the restored tree. Either the restore is wrong or the check"
  log "     never worked; both are why this line exists."
fi

# ================================================================================ verdict
head2 "Verdicts"
for v in "${VERDICTS[@]}"; do log "  $v"; done

MISSED=0
for required in "M1" "M2"; do
  line="$(printf '%s\n' "${VERDICTS[@]}" | grep "^$required:" || true)"
  if [ -z "$line" ]; then
    log ""
    log "HARNESS FAILURE: no verdict at all for $required. A mutation without a verdict is a run that"
    log "did not happen, and it must not be reported as a clean sheet."
    MISSED=1
    continue
  fi
  case "$line" in
    *DETECTED*) ;;
    *)
      log ""
      log "HARNESS FAILURE: $required produced '$line', which is neither DETECTED nor MISSED. The check"
      log "was not exercised, so this run measured nothing about it."
      MISSED=1
      ;;
  esac
done
MISSED=$(( MISSED + $(printf '%s\n' "${VERDICTS[@]}" | grep -c ': MISSED' || true) ))

log ""
if [ "$MISSED" -eq 0 ] && [ "$FINAL" = "clean" ]; then
  log "every mutation detected, and the restored tree is clean."
  exit 0
fi
exit 1
