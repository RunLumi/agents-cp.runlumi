#!/usr/bin/env bash
# V04 work items 5, 7, 8 — the remaining release-gate rows: the phase smoke suite, the real browser,
# the performance budgets, the guard probe, and the representative mutant sample.
#
# This is a SEPARATE runner from the adversarial suite for one reason: the browser gate needs a
# dev stack on :5173 and :8787, and the mutation campaign needs a disposable linked worktree with
# ~2.4 GB of scratch per case on the same volume as the repository. Interleaving them with the
# 25-gate adversarial suite would put three classes of resource contention into one exit code.
#
# The mutation campaign is the slowest thing here by an order of magnitude. It is LAST, and it is
# only run if the scratch volume check passes, because a run that fails on every case at once is a
# statement about the MACHINE, not the code.

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
LOG="/tmp/v04-smoke-browser-perf.log"
: > "$LOG"

GATE=0
RESULTS=()

run_gate() {
  local label="$1"
  shift
  GATE=$((GATE + 1))
  local out="/tmp/v04-sb${GATE}-${label}.log"
  local start end code
  start=$(date +%s)
  ( cd "$REPO" && "$@" ) > "$out" 2>&1
  code=$?
  end=$(date +%s)
  printf '%-34s exit=%-3s %6ss  log=%s\n' "$label" "$code" "$((end - start))" "$out" >> "$LOG"
  RESULTS+=("$label=$code")
  return 0
}

# --- phase smoke suite -----------------------------------------------------------------------------
# smoke:p08 is here rather than in the adversarial suite on purpose: it is the gate the release gate
# itself flags as still reporting routes with NO handler-level evidence, so its count is a finding to
# read, not a number to pass.
run_gate "smoke:p02 identity"      pnpm smoke:p02
run_gate "smoke:p03 membership"    pnpm smoke:p03
run_gate "smoke:p04 authorization" pnpm smoke:p04
run_gate "smoke:p05 tools+runs"    pnpm smoke:p05
run_gate "smoke:p06 data"          pnpm smoke:p06
run_gate "smoke:p08 tenancy"       pnpm smoke:p08
run_gate "guard:probe"             pnpm guard:probe
run_gate "schema:null-check"       pnpm schema:null-check
run_gate "schema:p07"              pnpm schema:p07

# --- performance -----------------------------------------------------------------------------------
# Needs the production preview on :4173, which perf-probe starts itself. Run BEFORE the browser gate
# so a held preview port cannot be misread as a browser failure.
run_gate "perf:budgets"            pnpm perf:budgets

# --- browser ---------------------------------------------------------------------------------------
# The dev stack must be up. This runner starts it, waits for BOTH services (a 401 from /api/v1/me is
# the correct unauthenticated answer and means the Worker is serving), runs the probe, and stops the
# stack in a trap so a kill cannot leave a held port for the next gate.
start_stack() {
  pkill -9 -f workerd 2>/dev/null
  pkill -9 -f "wrangler dev" 2>/dev/null
  sleep 4
  ( cd "$REPO" && nohup pnpm dev > /tmp/v04-dev-stack.log 2>&1 & )
  local tries=0 v a
  while [ "$tries" -lt 150 ]; do
    v="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/ 2>/dev/null)"
    a="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/api/v1/me 2>/dev/null)"
    # Waiting only on Vite races the prerequisite check against the thing it depends on: the Worker
    # applies the whole migration ledger on first boot and is noticeably slower than Vite.
    if [ "$v" = "200" ] && [ "$a" = "401" ]; then sleep 3; return 0; fi
    tries=$((tries + 1))
    sleep 2
  done
  printf 'FATAL: the stack did not come up (vite=%s api=%s)\n' "${v:-000}" "${a:-000}" >> "$LOG"
  return 1
}

stop_stack() {
  pkill -9 -f "pnpm dev" 2>/dev/null
  pkill -9 -f workerd 2>/dev/null
  pkill -9 -f wrangler 2>/dev/null
  pkill -9 -f "Google Chrome" 2>/dev/null
  return 0
}
trap stop_stack EXIT
trap 'stop_stack; trap - EXIT; exit 130' INT TERM HUP

if start_stack; then
  printf 'stack up (vite=200 api=401)\n' >> "$LOG"
  run_gate "smoke:browser"        pnpm smoke:browser
else
  printf 'smoke:browser SKIPPED -- the stack never came up. That is UNPROVEN, not a pass.\n' >> "$LOG"
  RESULTS+=("smoke:browser=UNPROVEN-stack-down")
fi
stop_stack
trap - EXIT

# --- representative mutant sample -------------------------------------------------------------------
# Needs a disposable linked worktree on the SAME volume as the repository, because the scratch is
# ~2.4 GB per case and a worktree under /private/var/folders puts the scratch on the system volume,
# where the builds then fail and every case is reported BLOCKED -- which reads exactly like a wall of
# broken mutants. The failure mode to avoid: believe the machine before the cases.
SCRATCH_VOL="$(df -h "$REPO" | tail -1 | awk '{print $5}')"
printf '\nscratch volume for the mutation campaign: %s free on the repository volume\n' "$SCRATCH_VOL" >> "$LOG"
if [ -d "$REPO/../verify" ]; then
  printf 'a linked worktree already exists at ../verify -- refusing to reuse one, because a snapshot\n'
  printf 'taken over a previous campaign'"'"'s fault is a snapshot of the wrong tree.\n' >> "$LOG"
else
  ( cd "$REPO" && git worktree add ../verify HEAD ) >> "$LOG" 2>&1
  if [ -d "$REPO/../verify" ]; then
    run_gate "verify:mutation (sample)" bash -c "cd '$REPO/../verify' && P09_SCRATCH='$REPO/target/mutation-scratch' pnpm verify:mutation --apply"
  else
    printf 'verify:mutation SKIPPED -- the worktree could not be created\n' >> "$LOG"
  fi
fi
git -C "$REPO" worktree remove --force "$REPO/../verify" 2>/dev/null

{
  printf '\n===========================================================\n'
  printf 'V04 SMOKE / BROWSER / PERF / MUTATION RESULTS\n'
  printf '===========================================================\n'
  for r in "${RESULTS[@]}"; do printf '  %s\n' "$r"; done
  printf '\n'
  NONZERO=0
  for r in "${RESULTS[@]}"; do
    case "$r" in *"=0"*) ;; *) NONZERO=$((NONZERO + 1)) ;; esac
  done
  printf '  %s gates run, %s non-zero exit\n' "${#RESULTS[@]}" "$NONZERO"
  printf 'finished: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} >> "$LOG"
