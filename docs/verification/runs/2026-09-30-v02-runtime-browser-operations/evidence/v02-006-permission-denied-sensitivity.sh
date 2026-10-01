#!/usr/bin/env bash
# ============================================================================================
# V02-006 / V02-008 sensitivity -- prove the permission-denied and empty classes can FAIL.
#
# A gate nobody has watched to fail is an assumption, and this campaign has now been wrong about that
# seven times. The newest browser classes (permission denied, empty, non-disclosure, destructive
# confirmation, one-time secret) have each been watched to report FAIL -- but only on HARNESS faults,
# which is a weaker statement: it proves the instrument goes red, not that it would go red on this
# class of product defect.
#
# THE MUTATION
#
#   apps/web/src/features/organizations/org-dashboard.tsx -- drop the `!` from the `unauthorizedPath`
#   predicate:
#
#     pathSlug && !me.organizations.some((item) => item.organization.slug === pathSlug)
#     pathSlug &&  me.organizations.some((item) => item.organization.slug === pathSlug)
#
#   A forgotten negation. It is the single most likely edit to make in this line, and it fails OPEN:
#   an organization the session CANNOT see stops being treated as unavailable.
#
# WHAT MUST HAPPEN
#
#   The permission-denied cases must FAIL, and so must the recovery leg: with the predicate inverted,
#   navigating to the session's OWN organization is what raises the denial, so the session genuinely
#   cannot get back to a page it is allowed to see.
#
#   And here is the more interesting half: NON-DISCLOSURE will still PASS. Both of its legs change
#   together -- a real foreign slug and a phantom slug are in the same position relative to the
#   inverted predicate -- so the answers stay identical. That is not a defect in the mutation; it is a
#   statement about the CHECK's scope, and it is exactly the kind of thing a sensitivity run exists
#   to surface. A class that "cannot fail" because both its legs move together is a class whose green
#   sheet says very little, and it should be written down rather than discovered later.
#
# HARNESS DISCIPLINE (each rule earned in this campaign at cost)
#
#   * `cp` for snapshot and restore, never `cp -p`: an mtime-preserving restore makes an mtime-based
#     build skip the rebuild and ship the fault while the sheet reads green (V01-044).
#   * `git diff --quiet` on the mutated file BEFORE snapshotting -- a snapshot taken with uncommitted
#     work in it launders that work into the baseline.
#   * HEAD recorded at snapshot time and re-checked at exit: a commit during a mutation run captures
#     the fault permanently, and `git checkout --` then restores the FAULT.
#   * Traps on EXIT, INT, TERM and HUP, each re-raising through `exit`.
#   * The dev stack is RESTARTED after the mutation and the served module's hash must CHANGE.
#     Measured in V02-001: Vite logged `hmr update` on every mutation while a fresh request kept
#     returning the previous transform for 12 seconds.
#   * An empty verdict list is a failure. A build failure is INVALID, never a detection. Probe exit 2
#     is INVALID, never a detection.
#   * Restoring the SOURCE is not restoring the WORLD: Vite keeps serving the previous transform, so
#     the exit path restarts the stack too.
# ============================================================================================

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
TARGET="apps/web/src/features/organizations/org-dashboard.tsx"
WEB_PORT=5173
DEV_LOG="/tmp/v02-006-sensitivity-dev.log"
SNAP="$(mktemp -d)/org-dashboard.tsx"

ORIGINAL='    pathSlug && !me.organizations.some((item) => item.organization.slug === pathSlug),'
FAULTED='    pathSlug && me.organizations.some((item) => item.organization.slug === pathSlug),'

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

# The hash of the module Vite is actually SERVING. A token-based check cannot work here:
# `unauthorizedPath` and this whole expression are not unique substrings, so "absent after the
# mutation" can never hold. A hash carries no uniqueness assumption -- it answers only the question
# that matters, which is whether the browser's module graph is built from the source just written.
served_hash() {
  curl -s "http://localhost:${WEB_PORT}/src/features/organizations/org-dashboard.tsx" 2>/dev/null \
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
BASE_OUT="/tmp/v02-006-sensitivity-baseline.log"
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
log "  CASE M1 the unauthorizedPath predicate loses its negation"

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
  log "    INVALID: the anchor did not match exactly once -- likely `pnpm format` reflowed it"
  restore || true
  exit 2
fi

cmp -s "$SNAP" "$REPO/$TARGET" && {
  VERDICTS+=("INVALID M1  the file did not change, so the mutation faulted nothing")
  log "    INVALID: byte-identical to the snapshot; the fault did nothing"
  restore || true
  exit 2
}
log "    fault applied (the ! is gone)"

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
MUT_OUT="/tmp/v02-006-sensitivity-mutated.log"
( cd "$REPO" && pnpm smoke:browser ) > "$MUT_OUT" 2>&1
MUT_STATUS=$?
MUT_SUMMARY="$(grep -oE "[0-9]+/[0-9]+ browser checks passed" "$MUT_OUT" | tail -1)"

restore || true

if [ "$MUT_STATUS" -eq 2 ]; then
  VERDICTS+=("INVALID M1  the probe exited 2, so the harness could not run")
  log "    INVALID: probe exit 2 -- the harness could not run. That is not a detection."
  grep -A 3 "browser probe failed" "$MUT_OUT" | head -5 | sed 's/^/             /'
else
  DENIED_FAILS="$(grep -cE "^FAIL.*(denied|DENIED|refusal|denial)" "$MUT_OUT")"
  NON_DISCLOSURE="$(grep -cE "^FAIL.*NON-DISCLOSURE" "$MUT_OUT")"
  RECOVERY="$(grep -cE "^FAIL.*RECOVERY: after a denied" "$MUT_OUT")"
  if [ "$MUT_STATUS" -eq 1 ]; then
    VERDICTS+=("DETECTED M1  ${MUT_SUMMARY:-no summary}  denied-legs-failing=${DENIED_FAILS} recovery-failing=${RECOVERY}")
    log "    DETECTED: probe exit 1 -- ${MUT_SUMMARY:-no summary}"
    log "    permission-denied legs failing: ${DENIED_FAILS}   recovery failing: ${RECOVERY}"
    log "    NON-DISCLOSURE legs failing: ${NON_DISCLOSURE}  <-- see the note in the report"
    grep -E "^FAIL" "$MUT_OUT" | head -6 | cut -c1-140 | sed 's/^/             /'
  else
    VERDICTS+=("MISSED M1  ${MUT_SUMMARY:-no summary}")
    log "    MISSED: probe exit 0 -- ${MUT_SUMMARY:-no summary}"
    log "    This gate cannot detect a dropped negation on unauthorizedPath, which fails OPEN."
  fi
fi

restore || true

log ""
log "  ------------------------------------------------------------------"
log "  V02-006 / V02-008 SENSITIVITY"
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