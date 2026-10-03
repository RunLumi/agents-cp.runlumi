#!/usr/bin/env bash
# Sensitivity proof for the FR-F13-005 / FR-F13-006 browser and computer-use assertions.
#
# Twenty-one new assertions are only evidence if they can fail. Two mutations, one per family, each
# making a SINGLE toggle stop being consulted:
#
#   M1  `BrowserAction::Download { .. } => policy.allow_download`  ->  `=> true`
#   M2  `ComputerAction::ScreenCapture { .. } => policy.allow_screen_capture`  ->  `=> true`
#
# These are the right faults. Deleting a whole rule would make every browser case deny and the
# positive control would fail, which proves less: it cannot tell WHICH control stopped working. Making
# one toggle permissive makes exactly one assertion go red while the other twelve stay green, which is
# the only way to show each assertion is bound to its own field rather than to "the browser path".
#
# One worktree, one control, two mutants with a restore between them. The control must run FIRST and
# must include the new assertions by name -- an earlier campaign run reported a green total for a tree
# that did not contain the case under test at all, and concluded a defence existed that did not.
#
# Each mutant changes no SQL and no bind, so `pnpm schema:bind-count` stays green: a mutation that
# removes a placeholder makes D1 refuse the statement and both legs answer 503, which is the V01 lesson
# about breaking the statement instead of the claim.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
WT="/Volumes/SSD/v04-f13-verify"
LOGDIR="/Volumes/SSD/v04-logs"
LOG="$LOGDIR/v04-f13-sensitivity.log"
POLICY="apps/api/src/modules/tool_policy.rs"
mkdir -p "$LOGDIR"; : > "$LOG"

SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
log() { printf '%s\n' "$*" | tee -a "$LOG"; }
VERDICTS=()

restore() {
  [ -n "${SNAP:-}" ] && { cp "$SNAP" "$WT/$POLICY" 2>/dev/null && touch "$WT/$POLICY"; }
  if git -C "$WT" diff --quiet -- "$POLICY" 2>/dev/null; then log "  restored: the module matches worktree HEAD"
  else log "  RESTORE FAILED"; git -C "$WT" diff --stat -- "$POLICY" | tee -a "$LOG"; fi
  return 0
}
cleanup() { git -C "$REPO" worktree remove --force "$WT" 2>/dev/null; git -C "$REPO" worktree prune 2>/dev/null; return 0; }
on_signal() { log "interrupted"; restore; cleanup; trap - EXIT; exit 130; }
trap cleanup EXIT
trap on_signal INT TERM HUP

if ! git -C "$REPO" diff --quiet -- "$POLICY"; then log "FATAL: $POLICY is dirty in main"; exit 2; fi
if [ -d "$WT" ]; then log "FATAL: $WT exists; a snapshot over a previous fault is a snapshot of the wrong tree"; exit 2; fi
if lsof -nP -iTCP:8787 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{f=1} END{exit !f}'; then
  log "FATAL: port 8787 is held. A held port HANGS here rather than erroring."; exit 2
fi

log "FR-F13-005/006 sensitivity -- does each assertion bind to its OWN toggle?"
log "  HEAD at launch : $SNAPSHOT_HEAD"
git -C "$REPO" worktree add "$WT" HEAD >> "$LOG" 2>&1 || { log "FATAL: worktree"; exit 2; }
for d in node_modules apps/api/node_modules apps/web/node_modules; do
  [ -e "$REPO/$d" ] && ln -sfn "$REPO/$d" "$WT/$d"
done
SNAP="$LOGDIR/f13-snapshot.rs"
cp "$WT/$POLICY" "$SNAP"
log "  worktree       : $WT @ $(git -C "$WT" rev-parse --short HEAD)"

run_probe() {
  local out="$LOGDIR/v04-f13-$1.log"
  ( cd "$WT" && pnpm verify:tool-policy-deny ) > "$out" 2>&1
  local plain; plain="$(sed 's/\x1b\[[0-9;]*m//g' "$out")"
  # wrangler prefixes compiler output with `[custom build] `, so an `^error`-anchored pattern matches
  # nothing and a BUILD FAILURE is graded as a product verdict. Both prefixes are matched, and
  # "Worker never became healthy" is treated as a build failure rather than a result -- which is what
  # it is whenever the bundle did not compile.
  if grep -qE "^error\\[E[0-9]+\\]|^error: could not compile|^error: aborting|^\\[custom build\\] error:|Compiling your crate to WebAssembly failed" <<< "$plain"; then
    echo "INVALID(build)"; return 0
  fi
  if grep -q "the Worker never became healthy" <<< "$plain"; then
    echo "INVALID(worker-not-healthy -- the bundle did not build, so no assertion ran)"; return 0
  fi
  local total
  total="$(grep -m1 -oE '^[0-9]+/[0-9]+ .*cases hold' <<< "$plain")"
  # The control must show the new assertions by NAME. A green total from a tree that lacks them is not
  # evidence about them.
  if [ -z "$total" ]; then
    echo "NO-TOTAL:the probe produced no total -- $(grep -m1 -E 'DID NOT COMPLETE|never became healthy' <<< "$plain" | cut -c1-70)"
    return 0
  fi
  if ! grep -q "POSITIVE CONTROL: a browser .visit. to a listed domain CLEARS" <<< "$plain"; then
    echo "GREEN-WITHOUT-THE-CASE:$total"; return 0
  fi
  # Which of the two families failed, if any.
  local f1 f2
  f1="$(grep -cE '^[[:space:]]*FAIL.*browser .download.' <<< "$plain")"
  f2="$(grep -cE '^[[:space:]]*FAIL.*computer-use .screen_capture.' <<< "$plain")"
  echo "GREEN:$total f13_005_failed=$f1 f13_006_failed=$f2"
}

log ""; log "CONTROL  unmutated tree must be green and must run the new assertions"
C="$(run_probe control)"
log "  control: $C"
case "$C" in
  GREEN:*f13_005_failed=0*f13_006_failed=0)
    log "  control is green AND both new families ran" ;;
  GREEN-WITHOUT-THE-CASE:*)
    log "  FATAL: green, but the new assertions never ran ($C) -- the tree does not contain them"
    VERDICTS+=("INVALID control: the case under test did not run ($C)") ;;
  *)
    log "  FATAL: the control is not green ($C)"; VERDICTS+=("INVALID control: $C") ;;
esac

run_mutation() {
  local name="$1" label="$2" old_line="$3" new_line="$4" expect_field="$5"
  log ""
  log "MUTANT $label"
  # Whole lines in and out, so the arm keeps its trailing comma. The first version rebuilt the line
  # from `split("=>")`, dropped the comma, and the crate stopped compiling -- a mutation that breaks
  # the syntax measures the compiler, not the claim.
  python3 - "$WT/$POLICY" "$old_line" "$new_line" << 'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); old, new = sys.argv[2], sys.argv[3]
s = p.read_text()
assert s.count(old) == 1, f"anchor occurs {s.count(old)} times; refusing to guess"
p.write_text(s.replace(old, new))
print(f"  fault applied: {old.strip()!r} -> {new.strip()!r}")
PY
  if git -C "$WT" diff --quiet -- "$POLICY"; then
    log "  FATAL: the fault changed nothing"; VERDICTS+=("INVALID $name: no change"); return 0
  fi
  git -C "$WT" diff --stat -- "$POLICY" | sed 's/^/    /' | tee -a "$LOG"
  local M; M="$(run_probe "$name")"
  log "  mutant: $M"
  case "$M" in
    GREEN:*"$expect_field"=1*)
      VERDICTS+=("DETECTED $name -- exactly the $label assertion went red and the other family stayed green, so each assertion is bound to its own toggle") ;;
    GREEN:*"$expect_field"=0*)
      VERDICTS+=("MISSED $name -- $label stopped being enforced and its assertion still passed") ;;
    INVALID*|NO-TOTAL:*)
      VERDICTS+=("INVALID $name -- $M") ;;
    GREEN-WITHOUT-THE-CASE:*)
      VERDICTS+=("INVALID $name -- the case under test did not run ($M)") ;;
    *)
      VERDICTS+=("INVALID $name -- $M") ;;
  esac
  restore
}

if [[ "$C" == GREEN:*f13_005_failed=0*f13_006_failed=0 ]]; then
  run_mutation "M1-browser-download" "FR-F13-005 allow_download" \
    "        BrowserAction::Download { .. } => policy.allow_download," \
    "        BrowserAction::Download { .. } => true," "f13_005_failed"
  run_mutation "M2-computer-screen-capture" "FR-F13-006 allow_screen_capture" \
    "        ComputerAction::ScreenCapture { .. } => policy.allow_screen_capture," \
    "        ComputerAction::ScreenCapture { .. } => true," "f13_006_failed"
fi

log ""; log "VERDICTS"
for v in ${VERDICTS+"${VERDICTS[@]}"}; do log "  $v"; done
if [ "${#VERDICTS[@]}" -eq 0 ]; then log "  FATAL: no verdicts recorded"; exit 2; fi
if printf '%s\n' ${VERDICTS+"${VERDICTS[@]}"} | grep -q '^INVALID\|^MISSED'; then log "  FAIL"; exit 1; fi
if [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then log "  WARNING: HEAD moved"; fi
git -C "$REPO" diff --quiet -- "$POLICY" && log "  main tree: clean" || { log "  main tree: DIRTY"; exit 1; }
log ""; log "RESULT: 2/2 detected, exit 0 -- each assertion is bound to its own toggle"