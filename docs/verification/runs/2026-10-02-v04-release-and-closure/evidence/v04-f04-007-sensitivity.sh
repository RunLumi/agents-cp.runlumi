#!/usr/bin/env bash
# Sensitivity proof for the FR-F04-007 assertion added to `v02-tool-policy-deny-probe.mjs`.
#
# The assertion requires the reason ON THE WIRE to match the leg: `policy_allowed` when the policy
# permits, `org_tool_denied` when it denies. That discrimination is the point -- D1 already accepts any
# non-empty stored status, and a presence-only check would be satisfied by a route returning one fixed
# reason for both outcomes.
#
# So the fault is the most dangerous shape for a reason field: a route that ALWAYS answers
# `policy_allowed`. It still returns a machine-readable reason, so a presence check passes; only the
# discrimination can catch it. If the deny leg stays green under this fault, the new assertion is
# decorative and must be rewritten.
#
# Control first, and the control asserts the case under test RAN -- the same fix this campaign needed
# for V04-009, where a control reported a green total for a tree that did not contain the case at all.
#
# The mutation changes no SQL and no bind, so `pnpm schema:bind-count` stays green throughout; a
# mutation that removes a placeholder would make D1 refuse the statement and both legs would answer
# 503, which is the V01 lesson about breaking the statement instead of the claim.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
WT="/Volumes/SSD/v04-f04-verify"
LOGDIR="/Volumes/SSD/v04-logs"
LOG="$LOGDIR/v04-f04-007-sensitivity.log"
SITE="apps/api/src/routes/tools.rs"
CASE_UNDER_TEST="FR-F04-007: the deny call RETURNS a machine-readable reason"
mkdir -p "$LOGDIR"; : > "$LOG"

SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
log() { printf '%s\n' "$*" | tee -a "$LOG"; }
VERDICTS=()

restore() {
  [ -n "${SNAP:-}" ] && { cp "$SNAP" "$WT/$SITE" 2>/dev/null && touch "$WT/$SITE"; }
  if git -C "$WT" diff --quiet -- "$SITE" 2>/dev/null; then log "  restored: the site matches worktree HEAD"
  else log "  RESTORE FAILED"; git -C "$WT" diff --stat -- "$SITE" | tee -a "$LOG"; fi
  return 0
}
cleanup() { git -C "$REPO" worktree remove --force "$WT" 2>/dev/null; git -C "$REPO" worktree prune 2>/dev/null; return 0; }
on_signal() { log "interrupted"; restore; cleanup; trap - EXIT; exit 130; }
trap cleanup EXIT
trap on_signal INT TERM HUP

if ! git -C "$REPO" diff --quiet -- "$SITE"; then log "FATAL: $SITE is dirty in main"; exit 2; fi
if [ -d "$WT" ]; then log "FATAL: $WT exists"; exit 2; fi
if lsof -nP -iTCP:8787 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{f=1} END{exit !f}'; then
  log "FATAL: port 8787 is held -- a held port hangs here rather than erroring"; exit 2
fi

log "FR-F04-007 sensitivity -- does the reason on the wire DISCRIMINATE?"
log "  HEAD at launch : $SNAPSHOT_HEAD"
git -C "$REPO" worktree add "$WT" HEAD >> "$LOG" 2>&1 || { log "FATAL: worktree"; exit 2; }
for d in node_modules apps/api/node_modules apps/web/node_modules; do
  [ -e "$REPO/$d" ] && ln -sfn "$REPO/$d" "$WT/$d"
done
SNAP="$LOGDIR/f04-snapshot.rs"
cp "$WT/$SITE" "$SNAP"
log "  worktree       : $WT @ $(git -C "$WT" rev-parse --short HEAD)"

run_probe() {
  local out="$LOGDIR/v04-f04-$1.log"
  ( cd "$WT" && pnpm verify:tool-policy-deny ) > "$out" 2>&1
  local plain; plain="$(sed 's/\x1b\[[0-9;]*m//g' "$out")"
  if grep -qE "^error\[E[0-9]+\]|^error: could not compile|^error: aborting" <<< "$plain"; then echo "INVALID"; return 0; fi
  if grep -qE "^[[:space:]]*FAIL.*$CASE_UNDER_TEST" <<< "$plain"; then echo "DETECTED"; return 0; fi
  if grep -qE "^[0-9]+/[0-9]+ .*cases hold" <<< "$plain"; then
    if grep -qE "^[[:space:]]*PASS.*$CASE_UNDER_TEST" <<< "$plain"; then
      echo "GREEN:$(grep -m1 -oE '^[0-9]+/[0-9]+ .*cases hold' <<< "$plain")"; return 0
    fi
    echo "GREEN-WITHOUT-THE-CASE:$(grep -m1 -oE '^[0-9]+/[0-9]+ .*cases hold' <<< "$plain")"; return 0
  fi
  echo "UNKNOWN:$(grep -m1 -E 'FAIL|cases hold|Error' <<< "$plain" | cut -c1-80)"
}

log ""; log "CONTROL  unmutated tree must be green AND must run the case under test"
C="$(run_probe control)"
log "  control: $C"
case "$C" in
  GREEN:*) log "  control is green and ran the assertion" ;;
  GREEN-WITHOUT-THE-CASE:*)
    log "  FATAL: green, but the case under test never ran ($C) -- the tree does not contain the"
    log "         assertion being measured, so no verdict is possible."
    VERDICTS+=("INVALID control: the case under test did not run ($C)") ;;
  *) log "  FATAL: the control is not green ($C)"; VERDICTS+=("INVALID control: $C") ;;
esac

if [[ "$C" == GREEN:* ]]; then
  log ""; log "MUTANT   the route always answers policy_allowed -- a reason that is present but blind"
  python3 - "$WT/$SITE" << 'PY3'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "        reason: decision.reason.code().as_str(),"
n = s.count(old)
assert n == 1, f"anchor occurs {n} times; refusing to guess which response it builds"
p.write_text(s.replace(old, '        reason: "policy_allowed",'))
print("  the response reason is now a constant: present, machine-readable, and carrying no information")
PY3
  if git -C "$WT" diff --quiet -- "$SITE"; then
    log "  FATAL: the fault changed nothing"; VERDICTS+=("INVALID mutant: no change")
  else
    git -C "$WT" diff --stat -- "$SITE" | sed 's/^/    /' | tee -a "$LOG"
    M="$(run_probe mutant)"
    log "  mutant: $M"
    case "$M" in
      DETECTED) VERDICTS+=("DETECTED -- a constant reason fails the deny leg, so the assertion discriminates");;
      GREEN:*)  VERDICTS+=("MISSED -- a CONSTANT reason passed. The assertion checks presence, not meaning, and is decorative") ;;
      INVALID)  VERDICTS+=("INVALID -- the mutant did not build");;
      *)        VERDICTS+=("INVALID -- $M");;
    esac
  fi
  restore
fi

log ""; log "VERDICTS"
for v in ${VERDICTS+"${VERDICTS[@]}"}; do log "  $v"; done
if [ "${#VERDICTS[@]}" -eq 0 ]; then log "  FATAL: no verdicts recorded"; exit 2; fi
if printf '%s\n' ${VERDICTS+"${VERDICTS[@]}"} | grep -q '^INVALID\|^MISSED'; then log "  FAIL"; exit 1; fi
if [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then log "  WARNING: HEAD moved"; fi
git -C "$REPO" diff --quiet -- "$SITE" && log "  main tree: clean" || { log "  main tree: DIRTY"; exit 1; }
log ""; log "RESULT: 1/1 detected, exit 0 -- the reason on the wire is proven to discriminate"