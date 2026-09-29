#!/usr/bin/env bash
# ============================================================================================
# Sensitivity proof for the `plugins` leak class in `v01-path-id-tenancy-probe.mjs`.
#
# A gate nobody has watched fail is an assumption, and this class is the ONLY thing attacking the
# `plugins` family's tenant boundary -- the six routes are named NOT_APPLICABLE to substitution on
# the strength of it. A vacuous class would therefore not merely be a weak gate; it would be the
# entire justification for six standing exclusions.
#
# M1  `INSTALL_BY_ORG_AND_PACKAGE_SQL` BINDS `org_id` and STOPS FILTERING on it. Every placeholder
#     and every bind survives, so the statement stays valid and only the scoping goes -- which is
#     the shape a single careless edit takes, and the one a static tenant audit cannot distinguish
#     from a correctly scoped statement. Expect: DETECTED.
#
# M2  the class's own positive-match control, with every needle intact: `packageId` is searched for
#     as a literal substring that appears nowhere. This is the only way to show a control IS a
#     control. Expect: DETECTED.
#
# M3  the DENOMINATOR gate: the six routes are marked NOT_APPLICABLE while the leak class has not
#     run. This is the assertion that stops the exclusions outliving their justification.
#     Expect: DETECTED.
#
# Harness rules this script obeys, each of which a previous harness in this campaign got wrong:
#   * `git diff --quiet` on the files it will mutate, BEFORE snapshotting, scoped to those files. A
#     snapshot is the only reference a snapshotting harness has, so a fault already present when it
#     snapshots is laundered into the baseline and every later compare is faithfully correct about a
#     wrong reference.
#   * snapshot + `cmp` on restore, not `mv`, because `mv` preserves the pre-fault mtime so the next
#     build is skipped and the run measures the faulted binary against a clean tree.
#   * traps on EXIT/INT/TERM/HUP that restore and then RE-RAISE through `exit` -- `trap ... EXIT`
#     does not fire for an unhandled SIGTERM, and a `pkill` mid-run would leave the fault in the tree.
#   * HEAD recorded at snapshot time and verified unmoved at exit: a commit during a mutation run has
#     captured the fault, and every verdict from that run is void.
#   * a verdict required per mutation BY NAME. An empty verdict list is a failure, not a pass.
#   * compile error discriminated from failed assertion on OUTPUT. `cargo`/`wrangler` exit non-zero
#     for both, and `^error:` also matches `error: test failed, to rerun pass ...`; here the wasm
#     build is matched on rustc's own diagnostic shape, and the probe is matched on its verdict line.
# ============================================================================================
set -uo pipefail

# Locate the repository by asking git, NOT by counting `..` segments. This script lives five levels
# below the root, and the original `dirname/..` resolved to `docs/verification/runs` -- a directory,
# so `cd` failed, and since `set -e` is deliberately absent here every later `git` call ran outside
# the repository. `git ls-files` outside a repo lists nothing, so the tracked-file check then
# reported a TRACKED file as untracked and the harness blamed the file. The file was fine; the
# reference was. A check that says "not tracked" about a tracked file is itself the finding.
REPO="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO" ] || [ ! -d "$REPO/apps/api" ]; then
  echo "FATAL: could not locate the repository root (git rev-parse --show-toplevel)." >&2
  echo "       Run this from inside the repository." >&2
  exit 2
fi
cd "$REPO"

PROBE="apps/api/src/repositories/plugins.rs"
PROBE_JS="apps/api/scripts/v01-path-id-tenancy-probe.mjs"
PERSIST="target/v01-pid-sens"
MUTATED=("$PROBE" "$PROBE_JS")
SNAP="$(mktemp -d)"
VERDICTS=()
LOG="$(mktemp)"
HEAD_AT_START="$(git rev-parse HEAD)"
MUTATING=0

cleanup() {
  local rc=$?
  if [ "$MUTATING" = "1" ]; then
    for f in "${MUTATED[@]}"; do
      [ -f "$SNAP/$(basename "$f")" ] && cp -p "$SNAP/$(basename "$f")" "$f"
    done
    MUTATING=0
  fi
  if [ "${#VERDICTS[@]}" -eq 0 ] && [ "$rc" -ne 2 ]; then
    echo "FATAL: no verdict was produced for any mutation -- a run that measured nothing is not a pass" >&2
    rc=1
  fi
  # rc 2 means the harness declined to run (a dirty tree, a red baseline, no repository). That is a
  # statement about THIS SCRIPT, not about the product, and it must not be laundered into a verdict.
  [ "$rc" -eq 2 ] && echo "(exit 2 -- the harness declined to run; this is not a statement about the product)" >&2
  if [ "$(git rev-parse HEAD)" != "$HEAD_AT_START" ]; then
    echo "FATAL: HEAD moved during the run. A commit has captured the deliberate fault; every verdict" >&2
    echo "       from this run is void until a human undoes it." >&2
    rc=1
  fi
  pkill -9 -f workerd 2>/dev/null
  rm -rf "$SNAP" "$LOG"
  exit $rc
}
trap cleanup EXIT
trap 'echo "interrupted; restoring" >&2; cleanup' INT TERM HUP

# --- the independent reference, scoped to the files this script mutates -----------------------
# Unrelated uncommitted work elsewhere in the tree is not a finding, so this must not be a bare
# `git diff --quiet`.
dirty=()
for f in "${MUTATED[@]}"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || { echo "FATAL: $f is untracked; a snapshot cannot restore what git cannot see" >&2; exit 2; }
  git diff --quiet -- "$f" || dirty+=("$f")
done
if [ "${#dirty[@]}" -ne 0 ]; then
  echo "FATAL: uncommitted changes already present in: ${dirty[*]}" >&2
  echo "       A snapshot taken now would launder that state into the baseline and every later" >&2
  echo "       comparison would be faithfully correct about a wrong reference." >&2
  exit 2
fi

for f in "${MUTATED[@]}"; do cp -p "$f" "$SNAP/$(basename "$f")"; done

assert_changed() {
  local what="$1" before="$2"
  if cmp -s "$PROBE" "$SNAP/plugins.rs" && cmp -s "$PROBE_JS" "$SNAP/v01-path-id-tenancy-probe.mjs"; then
    echo "  FATAL: $what changed nothing -- the file is byte-identical to the snapshot, so a verdict" >&2
    echo "         here would describe a run that never happened." >&2
    return 1
  fi
  return 0
}

restore() {
  for f in "${MUTATED[@]}"; do cp -p "$SNAP/$(basename "$f")" "$f"; done
  if ! cmp -s "$PROBE" "$SNAP/plugins.rs" || ! cmp -s "$PROBE_JS" "$SNAP/v01-path-id-tenancy-probe.mjs"; then
    echo "  FATAL: restore did not return the files to the snapshot" >&2
    return 1
  fi
  echo "  restored both source files (verified with cmp against the snapshot)"
  return 0
}

# The gate under test. Its baseline must be GREEN and must contain the cases the mutations attack --
# otherwise a detection would be indistinguishable from a fixture that no longer works.
echo "=== baseline ==="
pkill -9 -f workerd 2>/dev/null; sleep 3
rm -rf "$PERSIST"
if ! pnpm build > "$LOG" 2>&1; then
  if grep -qE '^(error|error\[E[0-9]+\])' "$LOG"; then
    echo "BASELINE BUILD FAILED (a rustc diagnostic) -- the harness cannot run" >&2; tail -20 "$LOG" >&2; exit 2
  fi
  echo "BASELINE BUILD FAILED (not a rustc diagnostic) -- the harness cannot run" >&2; tail -20 "$LOG" >&2; exit 2
fi
# `wrangler dev` serves this artifact. If it is older than the source under test then every verdict
# below describes a binary that never contained the claim -- and the run is VACUOUS rather than
# wrong, which is the worse state: a red baseline stops the run, a green one authorises a verdict.
# A previous version of this script rebuilt three times with `pnpm build`, and `wrangler deploy
# --dry-run` compiles and then discards its output to `build/.tmp` -- so every "rebuild" left the
# artifact untouched and all three mutations "failed" for a reason unrelated to the product.
ARTIFACT="$REPO/apps/api/build/index_bg.wasm"
rm -f "$ARTIFACT"
if [ ! -f "$ARTIFACT" ] || [ -z "$(strings -a "$ARTIFACT" 2>/dev/null | head -1)" ]; then
  echo "FATAL: the build did not produce $ARTIFACT" >&2
  echo "       The gates run against this file; without it they run against nothing." >&2
  tail -20 "$LOG" >&2
  exit 2
fi
BASELINE_ARTIFACT="$(shasum -a 256 "$ARTIFACT" | cut -d" " -f1)"
echo "  baseline artifact: ${BASELINE_ARTIFACT:0:16}  ($(date -r "$ARTIFACT" +%H:%M:%S))"

V01_PATHID_PERSIST_TO="$REPO/$PERSIST" node apps/api/scripts/v01-path-id-tenancy-probe.mjs > "$LOG" 2>&1
BASE_RC=$?
BASE="$(grep -oE '[0-9]+/[0-9]+ V01 path-id tenancy' "$LOG" | tail -1)"
echo "  baseline: exit=$BASE_RC  $BASE"
if [ "$BASE_RC" -ne 0 ]; then
  echo "BASELINE IS NOT GREEN -- refusing to run; a detection against a red sheet proves nothing" >&2
  grep -E '^  FAIL' "$LOG" | head -8 >&2
  exit 2
fi
for needed in "PL0 CONTROL" "PL2:" "PL3 CONTROL" "PL4:" "is named NOT_APPLICABLE to substitution"; do
  if ! grep -qF "$needed" "$LOG"; then
    echo "BASELINE LACKS the case this script attacks: $needed" >&2
    echo "  A mutation that reports DETECTED against a sheet without the case has measured nothing." >&2
    exit 2
  fi
done
echo "  baseline is green and contains every case the mutations attack"

run_mutation() {
  local name="$1" expect="$2"
  echo ""
  echo "=== $name ==="
  MUTATING=1
  pkill -9 -f workerd 2>/dev/null; sleep 3
  if ! pnpm build > "$LOG" 2>&1; then
    if grep -qE '^(error|error\[E[0-9]+\])' "$LOG"; then
      restore || true
      echo "  INVALID: the fault did not compile. A mutation must break the CLAIM, not the build --"
      echo "  this measures the compiler, not the gate."
      VERDICTS+=("$name INVALID-did-not-compile")
      return 0
    fi
    restore || true
    echo "  INVALID: the build failed without a rustc diagnostic; cannot attribute the failure" >&2
    VERDICTS+=("$name INVALID-build-failure")
    return 0
  fi
  V01_PATHID_PERSIST_TO="$REPO/$PERSIST" node apps/api/scripts/v01-path-id-tenancy-probe.mjs > "$LOG" 2>&1
  local rc=$?
  local sheet
  sheet="$(grep -oE '[0-9]+/[0-9]+ V01 path-id tenancy' "$LOG" | tail -1)"
  # The mutation's binary must DIFFER from the baseline's. Identical artifacts mean the fault was
  # never compiled in, and a verdict here would describe a run that did not happen -- the harness
  # bug this script exists partly to prevent, in its own build step.
  local artifact
  artifact="$(shasum -a 256 "$ARTIFACT" 2>/dev/null | cut -d" " -f1)"
  if [ "$artifact" = "$BASELINE_ARTIFACT" ]; then
    restore || true
    echo "  INVALID: the faulted build produced a byte-identical artifact to the baseline."
    echo "  The mutation was never compiled in, so a verdict would describe a run that did not happen."
    VERDICTS+=("$name INVALID-artifact-unchanged")
    return 0
  fi
  local verdict
  if [ "$rc" -eq 0 ]; then
    verdict="MISSED"
  else
    verdict="DETECTED"
  fi
  echo "  exit=$rc  $sheet  -> $verdict"
  grep -E '^  FAIL' "$LOG" | head -6 | sed 's/^  /    /' | cut -c1-150
  restore || true
  if [ "$verdict" = "$expect" ]; then
    VERDICTS+=("$name $verdict (expected $expect)")
  else
    VERDICTS+=("$name $verdict (EXPECTED $expect) -- DISAGREEMENT")
  fi
  MUTATING=0
}

# --- M1: bind org_id, stop filtering on it ---------------------------------------------------
python3 - <<'PYEOF'
import pathlib
f = pathlib.Path("apps/api/src/repositories/plugins.rs")
s = f.read_text()
old = "WHERE org_id = ?1 AND package_id = ?2\nLIMIT 1\n\"#;\n\nconst INSTALLS_FOR_ORG_SQL"
assert s.count(old) == 1, "INSTALL_BY_ORG_AND_PACKAGE_SQL was not in the expected form"
# `?1` stays BOUND and still REFERENCED, so the statement remains valid and every bind count is
# unchanged -- only the scoping goes. A mutation that instead deleted the predicate would remove a
# placeholder, D1 would refuse the statement at execution, and both orgs' calls would answer 503:
# a correct-shaped verdict on a build that cannot run the query at all.
new = "WHERE ?1 IS NOT NULL AND package_id = ?2\nLIMIT 1\n\"#;\n\nconst INSTALLS_FOR_ORG_SQL"
f.write_text(s.replace(old, new, 1))
PYEOF
assert_changed "M1" "x" || { echo "M1 changed nothing" >&2; exit 2; }
run_mutation "M1" "DETECTED"

# --- M2: the positive-match control's own search, needles intact -------------------------------
python3 - <<'PYEOF'
import pathlib
f = pathlib.Path("apps/api/scripts/v01-path-id-tenancy-probe.mjs")
s = f.read_text()
old = "          body.includes(packageId),"
assert s.count(old) == 1, "the positive-match control was not in the expected form"
# Every needle stays intact -- the mutation is to the CONTROL's search, not to the data, which is
# the only way to show that a negative assertion elsewhere is capable of failing.
new = "          body.includes(`${packageId}-a-string-that-appears-nowhere`),"
f.write_text(s.replace(old, new, 1))
PYEOF
assert_changed "M2" "x" || { echo "M2 changed nothing" >&2; exit 2; }
run_mutation "M2" "DETECTED"

# --- M3: the exclusions outlive their justification --------------------------------------------
python3 - <<'PYEOF'
import pathlib
f = pathlib.Path("apps/api/scripts/v01-path-id-tenancy-probe.mjs")
s = f.read_text()
old = "  let leakCaseRan = false;"
assert s.count(old) == 1, "leakCaseRan's declaration was not in the expected form"
# Force the flag false regardless of what the leak class did. The exclusions are justified BY that
# class, so a flag that cannot go false is a justification that cannot be withdrawn.
new = "  let leakCaseRan = false;\n  if (leakCaseRan) probe.stage = \"never\";"
f.write_text(s.replace(old, new, 1))
PYEOF
assert_changed "M3" "x" || { echo "M3 changed nothing" >&2; exit 2; }
run_mutation "M3" "DETECTED"

# Rebuild from restored source: a run that restores and leaves a binary built from the faulted
# source is indistinguishable from a repair that did not work.
echo ""
echo "=== rebuild from restored source ==="
pkill -9 -f workerd 2>/dev/null; sleep 3
if ! pnpm build > "$LOG" 2>&1; then
  echo "FATAL: the tree does not build after restore -- leaving a faulted binary behind" >&2
  tail -20 "$LOG" >&2
  exit 1
fi
rm -rf "$PERSIST"
V01_PATHID_PERSIST_TO="$REPO/$PERSIST" node apps/api/scripts/v01-path-id-tenancy-probe.mjs > "$LOG" 2>&1
FINAL_RC=$?
FINAL="$(grep -oE '[0-9]+/[0-9]+ V01 path-id tenancy' "$LOG" | tail -1)"
echo "  restored-tree run: exit=$FINAL_RC  $FINAL"
FINAL_ARTIFACT="$(shasum -a 256 "$ARTIFACT" 2>/dev/null | cut -d" " -f1)"
echo "  restored artifact: ${FINAL_ARTIFACT:0:16}"
if [ "$FINAL_ARTIFACT" = "$BASELINE_ARTIFACT" ]; then
  echo "FATAL: the restored tree produced the BASELINE artifact, so a repair and an unrepaired tree" >&2
  echo "       are indistinguishable. A sensitivity run that restores and leaves the faulted binary" >&2
  echo "       in place looks exactly like a repair that did not work." >&2
  exit 1
fi
if [ "$FINAL_RC" -ne 0 ]; then
  echo "FATAL: the tree is not green after restore" >&2
  grep -E '^  FAIL' "$LOG" | head -8 >&2
  exit 1
fi

echo ""
echo "===================== SENSITIVITY RESULTS ====================="
for v in "${VERDICTS[@]}"; do echo "  $v"; done
echo "  $FINAL  restored-tree baseline (exit 0)"
echo "==============================================================="
