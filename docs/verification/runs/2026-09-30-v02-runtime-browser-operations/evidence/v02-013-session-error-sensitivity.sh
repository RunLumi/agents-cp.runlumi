#!/usr/bin/env bash
# ============================================================================================
# V02-013 sensitivity -- prove the session-error class can FAIL on a product fault.
#
# THE MUTATION
#
#   apps/web/src/app.tsx -- the session error branch renders loading instead of the error:
#
#     setSession({ kind: "error", error });
#     setSession({ kind: "loading" });
#
#   A swallowed failure. It is the single most likely way for this branch to break in review —
#   an error path "simplified" into a state that already exists — and it fails SILENT: on any
#   failed `/me`, the app shows "Loading your workspace…" forever instead of the announced error
#   state with its retry. No crash, no blank page, no console error necessarily; just a spinner
#   that never clears.
#
# WHAT MUST HAPPEN
#
#   Every error-state leg must FAIL: V02-002's server-error cases, V02-010's malformed-response
#   cases, V02-012's disconnect cases, and all three recovery controls. The V02-002 LOADING case
#   itself should still PASS — the app genuinely renders its loading branch, which is precisely
#   why a loading check alone cannot carry this class. And V02-012's stuck-loader detector (added
#   for exactly this shape) should fire rather than time out.
#
#   Everything downstream that needs the authenticated shell goes red as cascade. Those lines are
#   downstream consequences, not independent witnesses — the V02-009 lesson stands: the fault is
#   caught strongly and the attribution is coarse.
#
# FIRST ATTEMPT SCORED INVALID — AND THE ANCHOR CHECK IS WHAT SAVED IT. The original anchor
# was the single line `setSession({ kind: "error", error });`, which occurs TWICE in app.tsx
# (line 30, load-session; line 44, sign-out). The `count != 1` guard refused to mutate rather
# than faulting both branches — which would have been a different, broader mutation than the
# header describes. The anchor now carries the preceding `} else {`, making it unique to the
# load-session branch. A harness that cannot aim its own fault cannot report on it.
#
# HARNESS DISCIPLINE: inherited verbatim from v02-006-permission-denied-sensitivity.sh, whose
# header lists each rule with the run that earned it. `cp` never `cp -p`; `git diff --quiet`
# before snapshotting; HEAD recorded and re-checked; traps on EXIT/INT/TERM/HUP; stack restarted
# after mutation AND after restore; served-hash must change; empty verdicts fail; exit 2 is
# INVALID, never a detection.
# ============================================================================================

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
TARGET="apps/web/src/app.tsx"
WEB_PORT=5173
DEV_LOG="/tmp/v02-013-sensitivity-dev.log"
SNAP="$(mktemp -d)/app.tsx"

ORIGINAL='      } else {
        setSession({ kind: "error", error });'
FAULTED='      } else {
        setSession({ kind: "loading" });'

SNAPSHOT_HEAD=""
RESTORED=0
STACK_RESTARTED_AFTER_RESTORE=0
VERDICTS=()

log() { printf '%s\n' "$*"; }

# ------------------------------------------------------------------------------------------
restore() {
  [ "$RESTORED" = "1" ] && return 0
  RESTORED=1
  if [ ! -f "$SNAP" ]; then
    log "  FATAL: the snapshot is missing, so the restore is a no-op and the fault would stay served"
    return 1
  fi
  cp "$SNAP" "$REPO/$TARGET"
  touch "$REPO/$TARGET"
  cmp -s "$SNAP" "$REPO/$TARGET" || { log "  FATAL: restore did not match the snapshot"; return 1; }
  git -C "$REPO" diff --quiet -- "$TARGET" || {
    log "  FATAL: the tree is NOT clean for $TARGET after restore -- a deliberate fault is still in it"
    git -C "$REPO" diff -- "$TARGET" | head -20
    return 1
  }
  if [ -n "$SNAPSHOT_HEAD" ] && [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then
    log "  FATAL: HEAD MOVED during the run (${SNAPSHOT_HEAD} -> $(git -C "$REPO" rev-parse --short HEAD))"
    log "         A commit during a mutation run captures the fault permanently."
    return 1
  fi
  log "  restored (cp + touch; cmp AND git diff clean; HEAD unmoved)"
  return 0
}

restart_stack() {
  pkill -f "pnpm dev" 2>/dev/null
  pkill -f "wrangler dev" 2>/dev/null
  pkill -f "vite" 2>/dev/null
  pkill -9 -f workerd 2>/dev/null
  sleep 4
  ( cd "$REPO" && nohup pnpm dev > "$DEV_LOG" 2>&1 & )
  local tries=0 vite_code api_code
  while [ "$tries" -lt 120 ]; do
    vite_code="$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${WEB_PORT}/" 2>/dev/null)"
    api_code="$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8787/api/v1/me" 2>/dev/null)"
    # A 401 is the correct answer for an unauthenticated caller and means the Worker is serving.
    # The Worker applies the whole migration ledger on first boot and takes noticeably longer than
    # Vite, so waiting only on Vite races the prerequisite check against the thing it depends on.
    if [ "$vite_code" = "200" ] && { [ "$api_code" = "401" ] || [ "$api_code" = "200" ]; }; then
      sleep 3
      return 0
    fi
    tries=$((tries + 1))
    sleep 2
  done
  log "  FATAL: the stack did not come back up (vite=${vite_code:-000} api=${api_code:-000})"
  return 1
}

# The hash of the module Vite is actually SERVING. A hash carries no uniqueness assumption --
# it answers only whether the browser's module graph is built from the source just written.
served_hash() {
  curl -s "http://localhost:${WEB_PORT}/src/app.tsx" 2>/dev/null \
    | shasum | cut -d" " -f1
}

cleanup() {
  restore || true
  if [ "${RESTORED:-0}" = "1" ] && [ "$STACK_RESTARTED_AFTER_RESTORE" != "1" ]; then
    STACK_RESTARTED_AFTER_RESTORE=1
    log ""
    log "  restoring the served module to the un-mutated source (the file was already restored; Vite"
    log "  keeps serving the previous transform otherwise, and every later run inherits a mutation)"
    restart_stack && log "  the stack is back on the restored source" \
      || log "  WARNING: could not restart the stack -- run \`pnpm dev\` by hand before trusting any"
  fi
}

on_signal() {
  cleanup
  trap - EXIT
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM HUP

# ------------------------------------------------------------------------------------------
# Prerequisite: tracked, committed, clean -- or the snapshot is worthless.
# ------------------------------------------------------------------------------------------
if [ ! -f "$REPO/$TARGET" ]; then log "FATAL: $TARGET does not exist"; exit 2; fi
git -C "$REPO" ls-files --error-unmatch "$TARGET" >/dev/null 2>&1 \
  || { log "FATAL: $TARGET is untracked; a snapshot cannot restore what git cannot see"; exit 2; }
git -C "$REPO" diff --quiet -- "$TARGET" \
  || { log "FATAL: uncommitted changes in $TARGET -- the snapshot would launder them into the baseline"; exit 2; }
SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
mkdir -p "$(dirname "$SNAP")"
cp "$REPO/$TARGET" "$SNAP"
log "  snapshot taken at $(git -C "$REPO" rev-parse --short HEAD)"

vite_code="$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${WEB_PORT}/" 2>/dev/null)"
api_code="$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/api/v1/me 2>/dev/null)"
if [ "$vite_code" != "200" ] || { [ "$api_code" != "401" ] && [ "$api_code" != "200" ]; }; then
  log "FATAL: the stack is not up (vite=${vite_code:-000} api=${api_code:-000}). Start \`pnpm dev\` first."
  exit 2
fi
log "  prerequisite: stack up (api=${api_code}, the correct unauthenticated answer)"

BASE_HASH="$(served_hash)"
if [ -z "$BASE_HASH" ] || [ "$BASE_HASH" = "$(echo '' | shasum | cut -d' ' -f1)" ]; then
  log "FATAL: could not read the served module, so a mutation could not be shown to reach the browser"
  exit 2
fi

# ------------------------------------------------------------------------------------------
# BASELINE. A mutation run measured against a red baseline cannot tell its own fault from one that
# was already there.
# ------------------------------------------------------------------------------------------
log ""
log "  BASELINE (unmutated)"
BASE_OUT="/tmp/v02-013-sensitivity-baseline.log"
pkill -9 -f "Google Chrome for Testing" 2>/dev/null
sleep 3
( cd "$REPO" && pnpm smoke:browser ) > "$BASE_OUT" 2>&1
BASE_STATUS=$?
BASE_SUMMARY="$(grep -oE "[0-9]+/[0-9]+ browser checks passed" "$BASE_OUT" | tail -1)"
log "    exit $BASE_STATUS -- ${BASE_SUMMARY:-no summary}"
if [ "$BASE_STATUS" -ne 0 ]; then
  log ""
  log "  FATAL: the baseline is not clean (exit $BASE_STATUS)."
  grep -E "^FAIL" "$BASE_OUT" | head -6 | sed 's/^/             /'
  exit 2
fi

# ------------------------------------------------------------------------------------------
# M1
# ------------------------------------------------------------------------------------------
log ""
log "  CASE M1 the session error branch renders loading instead of the error"

if ! python3 - "$REPO/$TARGET" "$ORIGINAL" "$FAULTED" << 'PY'
import sys, pathlib
path, original, faulted = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if s.count(original) != 1:
    print(f"  ANCHOR: expected exactly one occurrence, found {s.count(original)}")
    sys.exit(1)
p.write_text(s.replace(original, faulted, 1))
PY
then
  VERDICTS+=("INVALID M1  the anchor did not match exactly once, so no fault was applied")
  log "    INVALID: the anchor did not match exactly once"
  restore || true
  exit 2
fi

cmp -s "$SNAP" "$REPO/$TARGET" && {
  VERDICTS+=("INVALID M1  the file did not change, so the mutation faulted nothing")
  log "    INVALID: byte-identical to the snapshot; the fault did nothing"
  restore || true
  exit 2
}
log "    fault applied (the error branch now renders loading)"

restart_stack || { VERDICTS+=("INVALID M1  the stack did not restart"); restore || true; exit 2; }

NEW_HASH="$(served_hash)"
tries=0
while [ "$NEW_HASH" = "$BASE_HASH" ] && [ "$tries" -lt 20 ]; do
  tries=$((tries + 1))
  sleep 1
  NEW_HASH="$(served_hash)"
done
if [ "$NEW_HASH" = "$BASE_HASH" ]; then
  VERDICTS+=("INVALID M1  the served module never changed, so the fault did not reach the browser")
  log "    INVALID: the served module is unchanged after a restart, so the fault never reached the"
  log "             browser and a MISSED below would be meaningless"
  restore || true
  exit 2
fi
log "    the served module is serving different bytes than before the mutation"

pkill -9 -f "Google Chrome for Testing" 2>/dev/null
sleep 4
MUT_OUT="/tmp/v02-013-sensitivity-mutated.log"
( cd "$REPO" && pnpm smoke:browser ) > "$MUT_OUT" 2>&1
MUT_STATUS=$?
MUT_SUMMARY="$(grep -oE "[0-9]+/[0-9]+ browser checks passed" "$MUT_OUT" | tail -1)"

restore || true

if [ "$MUT_STATUS" -eq 2 ]; then
  VERDICTS+=("INVALID M1  the probe exited 2, so the harness could not run")
  log "    INVALID: probe exit 2 -- the harness could not run. That is not a detection."
  grep -A 3 "browser probe failed" "$MUT_OUT" | head -5 | sed 's/^/             /'
else
  ERROR_FAILS="$(grep -cE "^FAIL.*(SERVER ERROR|MALFORMED|DISCONNECT|ERROR state|error state)" "$MUT_OUT")"
  STUCK="$(grep -cE "stuckLoader=true" "$MUT_OUT")"
  RECOVERY_FAILS="$(grep -cE "^FAIL.*(RECOVERY|CONTROL)" "$MUT_OUT")"
  LOADING_PASS="$(grep -cE "^PASS.*LOADING" "$MUT_OUT")"
  if [ "$MUT_STATUS" -eq 1 ] && [ "$ERROR_FAILS" -ge 3 ]; then
    VERDICTS+=("DETECTED M1  ${MUT_SUMMARY:-no summary}  error-legs-failing=${ERROR_FAILS} recovery-failing=${RECOVERY_FAILS} stuck-loader-hits=${STUCK} loading-still-passing=${LOADING_PASS}")
    log "    DETECTED: probe exit 1 -- ${MUT_SUMMARY:-no summary}"
    log "    error-state legs failing: ${ERROR_FAILS}   recovery/control legs failing: ${RECOVERY_FAILS}"
    log "    stuck-loader detector hits: ${STUCK}   loading case still passing: ${LOADING_PASS}"
    grep -E "^FAIL" "$MUT_OUT" | head -8 | cut -c1-140 | sed 's/^/             /'
  elif [ "$MUT_STATUS" -eq 1 ]; then
    VERDICTS+=("MISSED M1  exit 1 but only ${ERROR_FAILS} error legs failing -- the class did not go red where it should")
    log "    MISSED-ish: exit 1 with only ${ERROR_FAILS} error-state failures; see the FAIL lines"
    grep -E "^FAIL" "$MUT_OUT" | head -8 | cut -c1-140 | sed 's/^/             /'
  else
    VERDICTS+=("MISSED M1  ${MUT_SUMMARY:-no summary}")
    log "    MISSED: probe exit 0 -- ${MUT_SUMMARY:-no summary}"
    log "    The error-state class cannot detect a swallowed session failure. That would be the"
    log "    largest hole in the browser gate: every error case green over an app that never shows one."
  fi
fi

restore || true

log ""
log "  ------------------------------------------------------------------"
log "  V02-013 SENSITIVITY (session-error class)"
log "  ------------------------------------------------------------------"
if [ "${#VERDICTS[@]}" -eq 0 ]; then
  log "  FATAL: no verdict was produced -- a harness must not report success for a run it did not"
  log "         perform. An empty verdict list is a failure."
  exit 2
fi
for v in "${VERDICTS[@]}"; do log "  $v"; done
log ""
log "  tree after restore: $(git -C "$REPO" diff --quiet -- "$TARGET" && echo clean || echo DIRTY)"

if grep -q "INVALID" <<<"${VERDICTS[*]}"; then exit 2; fi
if grep -q "MISSED" <<<"${VERDICTS[*]}"; then exit 1; fi
exit 0