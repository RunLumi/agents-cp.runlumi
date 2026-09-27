#!/bin/sh
# Prove that `pnpm smoke:browser` can FAIL.
#
# WHY THIS EXISTS
#
# The V00 browser probe lived in a run's `evidence/` directory, unexecuted by any
# gate, and a verifier nobody runs is an assumption. Promoting it to a gate is
# necessary but not sufficient: a gate that only ever passes is a script, not a
# check. So this runs the PROMOTED, 39-check probe against the PRE-REPAIR product
# and requires it to fail, naming the defects.
#
# The method is a linked worktree at the pre-repair commit, with the probe copied
# in and the pre-repair `apps/web/src` served by its own Vite instance. The Worker
# is the repaired one, deliberately: VFY-002, VFY-003, and VFY-007 are web-source
# defects and the repair changed no backend behaviour for them, so serving the
# repaired Worker isolates the variable under test to the web source. VFY-001 is
# covered separately and more directly, by reverting each of its two patches
# against `pnpm smoke:passkey` (see `repair-closure.md`).
#
# Usage:  sh vfy-browser-sensitivity.sh
#
# Requires: git, pnpm, Chrome. Takes roughly three minutes.
set -eu

# docs/verification/runs/<run>/evidence/  ->  five levels up is the repository root.
# Four was silently wrong: REPO resolved to `docs/`, the node_modules symlink became
# dangling, and the run failed with "the pre-repair web server never came up" --
# a harness fault reported as if it were about the product.
REPO=$(cd "$(dirname "$0")/../../../../.." && pwd)
[ -f "$REPO/package.json" ] || { printf 'REPO resolved to %s, which is not the repository root\n' "$REPO" >&2; exit 1; }
PRE_REPAIR_COMMIT=${PRE_REPAIR_COMMIT:-ecbdac1}
PRE_REPAIR_WEB_PORT=${PRE_REPAIR_WEB_PORT:-5174}
WORKER_PORT=${WORKER_PORT:-8787}
LOGDIR=$(mktemp -d)
WORKTREE="$LOGDIR/pre"

log() { printf '\n=== %s ===\n' "$1"; }
# Show the evidence a failure is about, BEFORE the cleanup trap deletes it. A
# diagnostic script that removes its own logs on failure makes every future run
# start from scratch again.
fail() {
  printf 'FAILED: %s\n' "$1" >&2
  for name in vite worker; do
    if [ -s "$LOGDIR/$name.log" ]; then
      printf '\n--- %s.log (tail) ---\n' "$name" >&2
      tail -20 "$LOGDIR/$name.log" >&2
    fi
  done
  printf '\nfull logs were in %s\n' "$LOGDIR" >&2
  # Keep them: a failure here is the interesting case, not the routine one.
  KEEP_LOGS=1
  exit 1
}

cleanup() {
  # `kill_tree`, not `kill`: vite and wrangler both spawn children, and a bare
  # `kill` on the subshell leaves the server holding its port, so the NEXT run
  # fails with "port already in use" and looks like a broken script.
  [ -n "${PRE_VITE_PID:-}" ] && kill_tree "$PRE_VITE_PID"
  [ -n "${WORKER_PID:-}" ] && kill_tree "$WORKER_PID"
  git -C "$REPO" worktree remove --force "$WORKTREE" 2>/dev/null || true
  git -C "$REPO" worktree prune 2>/dev/null || true
  # KEEP_LOGS is set by fail() so a failing run leaves its evidence behind.
  [ "${KEEP_LOGS:-0}" = "1" ] || rm -rf "$LOGDIR"
}
trap cleanup EXIT

kill_tree() {
  pkill -P "$1" 2>/dev/null || true
  kill "$1" 2>/dev/null || true
  sleep 1
  pkill -9 -P "$1" 2>/dev/null || true
  kill -9 "$1" 2>/dev/null || true
}

# A port left occupied by a previous run is the most likely reason this script
# fails for a reason that has nothing to do with the product, so it is reported
# as such rather than as a failed check.
require_free_port() {
  if command -v lsof >/dev/null 2>&1 && lsof -ti "tcp:$1" >/dev/null 2>&1; then
    printf 'port %s is already in use. Stop whatever owns it (lsof -ti tcp:%s | xargs kill -9)\n' "$1" "$1" >&2
    exit 1
  fi
}

log "pre-repair worktree at $PRE_REPAIR_COMMIT"
git -C "$REPO" worktree remove --force "$WORKTREE" 2>/dev/null || true
git -C "$REPO" worktree add "$WORKTREE" "$PRE_REPAIR_COMMIT" >/dev/null

# The three defects this run exists to detect must be visible in the pre-repair
# source, or the run below would be testing nothing. Asserted rather than assumed,
# because a "sensitive" result here could otherwise mean the worktree was not what
# it claimed to be.
#
# Two of the three are ABSENT pre-repair -- the defect is the missing code -- and
# one is PRESENT -- the defect is the too-wide table. Both directions are checked,
# because getting either wrong produces a confident and meaningless result.
assert_absent() {
  if grep -q -- "$2" "$WORKTREE/$1" 2>/dev/null; then
    fail "expected $2 to be ABSENT from $1; the worktree is not the pre-repair source"
  fi
  printf '  absent as expected: %s in %s\n' "$2" "$1"
}
assert_present() {
  if ! grep -q -- "$2" "$WORKTREE/$1" 2>/dev/null; then
    fail "expected $2 to be PRESENT in $1; the worktree is not the pre-repair source"
  fi
  printf '  present as expected: %s in %s\n' "$2" "$1"
}

# VFY-002: `verifyEmail` was exported and called from nowhere.
assert_absent apps/web/src/features/auth/auth-screen.tsx "verifyEmail"
# VFY-003: the latch was only ever set to false.
assert_absent apps/web/src/features/organizations/org-dashboard.tsx "setShowCreateOrg(true)"
# VFY-007: the table forced a width a phone cannot show.
assert_present apps/web/src/features/organizations/org-dashboard.tsx "min-w-\[620px\]"

log "node_modules (symlinked: the worktree shares the install with the checkout)"
ln -s "$REPO/node_modules" "$WORKTREE/node_modules"
ln -s "$REPO/apps/web/node_modules" "$WORKTREE/apps/web/node_modules"

log "serving the PRE-REPAIR web source on :$PRE_REPAIR_WEB_PORT"
require_free_port "$PRE_REPAIR_WEB_PORT"
# `exec` so $! is Vite's own pid and the cleanup trap can take its children with it.
( cd "$WORKTREE/apps/web" && exec ./node_modules/.bin/vite --port "$PRE_REPAIR_WEB_PORT" --strictPort ) \
  >"$LOGDIR/vite.log" 2>&1 &
PRE_VITE_PID=$!

log "starting the Worker on :$WORKER_PORT with both web origins allowed"
# The pre-repair copy runs on a different port, so the relying party must be told to
# accept it. Without this every ceremony would be refused for the RIGHT reason and read
# as a pass for the wrong one.
require_free_port "$WORKER_PORT"
( cd "$REPO/apps/api" && exec ./node_modules/.bin/wrangler dev --env development --local \
    --port "$WORKER_PORT" --show-interactive-dev-session=false \
    --var "WEBAUTHN_ORIGINS:http://localhost:5173,http://localhost:$PRE_REPAIR_WEB_PORT" ) \
  >"$LOGDIR/worker.log" 2>&1 &
WORKER_PID=$!

log "waiting for both services"
web=000
api=000
for _ in $(seq 1 120); do
  web=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PRE_REPAIR_WEB_PORT/" || true)
  api=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WORKER_PORT/api/health" || true)
  if [ "$web" = "200" ] && [ "$api" = "200" ]; then break; fi
  sleep 1
done
[ "$web" = "200" ] || fail "the pre-repair web server never came up (see $LOGDIR/vite.log)"
[ "$api" = "200" ] || fail "the Worker never came up (see $LOGDIR/worker.log)"

log "running the PROMOTED probe against the PRE-REPAIR product"
set +e
PROBE_WEB="http://localhost:$PRE_REPAIR_WEB_PORT/" \
PROBE_CDP_PORT=${PROBE_CDP_PORT:-9360} \
PROBE_TIMEOUT=${PROBE_TIMEOUT:-25000} \
  node "$REPO/apps/web/scripts/browser-probe.mjs" >"$LOGDIR/probe.log" 2>&1
status=$?
set -e

cat "$LOGDIR/probe.log"
printf '\nprobe exit status: %s\n' "$status"

# Exit 2 is a HARNESS fault and would mean this run says nothing about the
# product. The sensitivity claim requires a clean verdict, so it is not accepted.
[ "$status" -ne 2 ] || fail "the probe reported a harness fault (exit 2), so it proved nothing"
[ "$status" -ne 0 ] || fail "the probe PASSED against the pre-repair product, so it cannot detect these defects"

# The two web defects this run is here for must be named in the output, not merely
# counted. A count of failures says nothing about whether the RIGHT ones failed.
grep -q "the verification step renders a submittable form" "$LOGDIR/probe.log" \
  || fail "VFY-002 was not reported by name"
grep -q "a SECOND organization can be created through the UI" "$LOGDIR/probe.log" \
  || fail "VFY-003 was not reported by name"

# VFY-007 is NOT required to appear, and the reason is worth stating rather than
# hiding. The narrow-layout checks live after the cross-organization checks, and
# the pre-repair product cannot reach a second organization from the UI, so the
# journey stops before the Members table is ever measured. That is a true
# statement about the pre-repair product -- a layout defect is masked by a
# navigation defect -- but it means this run does not demonstrate VFY-007.
#
# VFY-007's sensitivity is covered separately, by the ten component cases in
# `apps/web/src/features/organizations/org-dashboard.test.ts`, each of which was
# verified to fail when its fix is reverted (see `repair-closure.md`). A single
# journey cannot prove everything, and pretending otherwise would overstate this
# evidence.
if grep -q "role control is fully inside the viewport" "$LOGDIR/probe.log"; then
  printf '\nVFY-007 was also reported by name.\n'
else
  printf '\nVFY-007 was NOT reached: the journey cannot reach a second organization from the\n'
  printf 'pre-repair UI, so the Members table is never measured. Its sensitivity is covered by\n'
  printf 'the component cases instead -- see the note in this script.\n'
fi

printf '\nSENSITIVE: the probe failed against %s, naming VFY-002 and VFY-003.\n' "$PRE_REPAIR_COMMIT"
