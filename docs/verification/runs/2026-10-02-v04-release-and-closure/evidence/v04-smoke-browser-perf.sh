#!/usr/bin/env bash
# V04 work items 5, 7, 8 — the remaining release-gate rows: the phase smoke suite, the real browser,
# the performance budgets, the guard probe, and the representative mutant sample.
#
# SEPARATE FROM THE ADVERSARIAL SUITE for a resource reason, not a tidiness one: the browser gate needs
# a dev stack on two ports and the mutation campaign needs a disposable linked worktree with ~2.4 GB of
# scratch per case on the repository's own volume. Interleaving them with 25 adversarial gates would
# put three classes of contention into one exit code.
#
# THE MUTATION CAMPAIGN IS LAST AND ONLY AFTER A VOLUME CHECK. It is an order of magnitude slower than
# everything else here, and a run that fails on every case at once is a statement about the MACHINE,
# not the code.

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"

# V04 HARNESS FIX #1 -- LOGS GO ON THE REPOSITORY VOLUME, NOT /tmp.
# The first adversarial run died with ENOSPC on the SYSTEM volume (98% full, 326 MiB free) while
# wrangler was writing its own state there -- and every per-gate log went to /tmp with it, so the
# evidence for the failure was destroyed by the failure.
#
# V04 HARNESS FIX #3 -- AND NOT UNDER target/ EITHER. A later run lost its logs because something
# reclaimed the 28 GB `target/` held after the system volume hit 98%, and `target/` went with it. So
# the log home is a SIBLING of the repository, on the same volume, outside the build directory, where
# neither a rebuild nor a disk-space recovery can reach it.
LOGDIR="${V04_LOGDIR:-$(dirname "$REPO")/v04-logs}"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/v04-smoke-browser-perf.log"
DEV_LOG="$LOGDIR/v04-dev-stack.log"
: > "$LOG"

GATE=0
RESULTS=()

# V04 HARNESS FIX #5 -- SETTLE MUST KILL THE SUPERVISOR CHAIN, AND PROVE THE PORT IS FREE.
#
# Killing workerd directly can never succeed. The process tree is
#
#     pnpm dev  ->  wrangler (node)  ->  workerd (x2)
#
# so killing workerd makes WRANGLER respawn it, and every gate after that inherits a live Worker. That
# happened: p02/p03/p04 each burned 300s and died with UND_ERR_HEADERS_TIMEOUT while talking to a
# STALE Worker left on :8787. A gate talking to the wrong Worker is a machine fact wearing a product
# result's clothes, and it was self-inflicted -- a dev stack left up for an earlier observability run.
#
# So: kill the supervisors before the children, and do not proceed until the ports have no listeners.
# "No process matches" is not the observable; the port is.
settle_worker() {
  pkill -9 -f "pnpm dev" 2> /dev/null
  pkill -9 -f "wrangler" 2> /dev/null
  pkill -9 -f vite       2> /dev/null
  pkill -9 -f workerd    2> /dev/null
  local tries=0 listeners
  while [ "$tries" -lt 40 ]; do
    listeners="$(lsof -nP -iTCP:8787 -iTCP:5173 -sTCP:LISTEN 2> /dev/null | grep -c LISTEN || true)"
    if [ "$listeners" = "0" ] && ! pgrep -f workerd > /dev/null 2>&1; then return 0; fi
    pkill -9 -f "pnpm dev" 2> /dev/null
    pkill -9 -f wrangler   2> /dev/null
    pkill -9 -f workerd    2> /dev/null
    tries=$((tries + 1))
    sleep 1
  done
  printf 'SETTLE FAILED: %s listener(s) still on 8787/5173 after %ss -- everything after this is\\n' \
    "$listeners" "$tries" >> "$LOG"
  printf 'about the machine, not the product.\\n' >> "$LOG"
  return 0
}

# V04 HARNESS FIX #7 -- SETTLE IS A PROPERTY OF THE GROUP, NOT OF EVERY GATE.
#
# This was the cause of the whole third failure, and it was mine: `run_gate` called `settle_worker`
# before EVERY gate, and `settle_worker` kills `pnpm dev`. So the suite started the stack, logged
# "stack up (vite=200 api=401)", and then destroyed it before running the first gate that needed it --
# producing `ECONNREFUSED` at p02 while the log said the stack was up. Two contradictory statements
# in one file, and the honest one was in a variable nobody read.
#
# So `run_gate` takes an explicit first argument: `shared` means "the group already settled, do not
# touch the stack"; `solo` means this gate owns the machine and settles before itself. A runner that
# can log a precondition as satisfied and then invalidate it is worse than one that never logs it.
run_gate() {
  local scope="$1" label="$2"
  shift 2
  GATE=$((GATE + 1))
  local out="$LOGDIR/v04-sb${GATE}-$(printf '%s' "$label" | tr ' /:' '---').log"
  local start end code
  [ "$scope" = "solo" ] && settle_worker
  start=$(date +%s)
  ( cd "$REPO" && "$@" ) > "$out" 2>&1
  code=$?
  end=$(date +%s)
  printf '%-32s exit=%-3s %6ss\n' "$label" "$code" "$((end - start))" >> "$LOG"
  RESULTS+=("$label=$code")
  return 0
}

start_stack() {
  ( cd "$REPO" && nohup pnpm dev > "$DEV_LOG" 2>&1 & )
  local tries=0 v a
  while [ "$tries" -lt 150 ]; do
    v="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/ 2> /dev/null)"
    a="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/api/v1/me 2> /dev/null)"
    # Both services, always. A 401 from /api/v1/me is the CORRECT unauthenticated answer and means the
    # Worker is serving. Waiting on Vite alone races the check against the thing it depends on, since
    # the Worker applies the whole migration ledger on first boot.
    if [ "$v" = "200" ] && [ "$a" = "401" ]; then sleep 3; return 0; fi
    tries=$((tries + 1))
    sleep 2
  done
  printf 'the stack did not come up (vite=%s api=%s)\\n' "${v:-000}" "${a:-000}" >> "$LOG"
  return 1
}

stop_stack() {
  pkill -9 -f "pnpm dev"   2> /dev/null
  pkill -9 -f wrangler     2> /dev/null
  pkill -9 -f workerd      2> /dev/null
  pkill -9 -f "Google Chrome" 2> /dev/null
  return 0
}
trap stop_stack EXIT
trap 'stop_stack; trap - EXIT; exit 130' INT TERM HUP

# V04 HARNESS FIX #6 -- GATE PRECONDITIONS DECLARED, NOT DISCOVERED ONE AT A TIME.
#
# Three attempts at this runner failed the same way: a gate launched without a precondition it did not
# have, and the resulting exit code read like a result.
#   * p02/p03/p04 hit a STALE Worker and each burned 300s on UND_ERR_HEADERS_TIMEOUT.
#   * p02/p03/p04 then got ECONNREFUSED in 1s once the settle worked -- so these probes do not start
#     their own Worker either.
#   * perf:budgets printed "Worker bundle UNMEASURED, API latency UNMEASURED" and exited 2, because
#     both of those measurements need a live Worker.
#
# Declared, therefore:
#   NEEDS A WORKER : smoke:p02 p03 p04 p05 p06, perf:budgets, smoke:browser
#   SELF-CONTAINED: smoke:p08, guard:probe, schema:null-check, schema:p07, verify:mutation
#
# A precondition discovered by reading a failure is a precondition that will be discovered again.

# --- self-contained gates first, while the machine is quiet ----------------------------------------
# smoke:p08 is here rather than in the adversarial suite on purpose: it is the gate the release gate
# itself flags as still reporting routes with NO handler-level evidence, so its count is a finding to
# read, not a number to pass.
run_gate solo "smoke:p08 tenancy"   pnpm smoke:p08
run_gate solo "guard:probe"         pnpm guard:probe
run_gate solo "schema:null-check"   pnpm schema:null-check
run_gate solo "schema:p07"          pnpm schema:p07

# --- one stack, for the gates that declare they need it --------------------------------------------
printf '\nstarting the dev stack for the gates that declare they need it\n' >> "$LOG"
settle_worker
if start_stack; then
  printf 'stack up (vite=200 api=401)\n' >> "$LOG"
  run_gate shared "smoke:p02 identity"      pnpm smoke:p02
  run_gate shared "smoke:p03 membership"    pnpm smoke:p03
  run_gate shared "smoke:p04 authorization" pnpm smoke:p04
  run_gate shared "smoke:p05 tools+runs"    pnpm smoke:p05
  run_gate shared "smoke:p06 data"          pnpm smoke:p06

  # Its Worker-bundle and API-latency budgets are UNMEASURED without a live Worker and it exits 2 when
  # they are -- which is the correct behaviour, and the reason the precondition is declared.
  run_gate shared "perf:budgets"            pnpm perf:budgets
  run_gate shared "smoke:browser"           pnpm smoke:browser
else
  printf 'the stack never came up. Every gate that needs a Worker is UNPROVEN, not passed:\n' >> "$LOG"
  for g in "smoke:p02" "smoke:p03" "smoke:p04" "smoke:p05" "smoke:p06" "perf:budgets" "smoke:browser"; do
    RESULTS+=("$g=UNPROVEN-no-worker")
  done
fi
stop_stack
trap - EXIT

# --- representative mutant sample -------------------------------------------------------------------
# Needs a disposable linked worktree on the SAME volume as the repository, because the scratch is
# ~2.4 GB per case and a worktree under the system volume puts that scratch where the builds then fail
# and every case reads BLOCKED -- indistinguishable from a wall of broken mutants. It also refuses to
# reuse an existing ../verify, because a snapshot taken over a previous campaign's fault is a snapshot
# of the wrong tree.
SCRATCH_VOL="$(df -h "$REPO" | tail -1 | awk '{print $5}')"
printf '\nscratch volume for the mutation campaign: %s free on the repository volume\n' "$SCRATCH_VOL" >> "$LOG"
if [ -d "$REPO/../verify" ]; then
  printf 'a linked worktree already exists at ../verify -- refusing to reuse one\n' >> "$LOG"
  RESULTS+=("verify:mutation=SKIPPED-worktree-exists")
else
  ( cd "$REPO" && git worktree add ../verify HEAD ) >> "$LOG" 2>&1
  if [ -d "$REPO/../verify" ]; then
    run_gate solo "verify:mutation (sample)" \
      bash -c "cd '$REPO/../verify' && P09_SCRATCH='$REPO/target/mutation-scratch' pnpm verify:mutation --apply"
  else
    printf 'verify:mutation SKIPPED -- the worktree could not be created\n' >> "$LOG"
  fi
fi
git -C "$REPO" worktree remove --force "$REPO/../verify" 2> /dev/null

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
  printf 'exit 0 = every check held. exit 1 = a check did not hold (a finding about the product).\n'
  printf 'exit 2 = the harness could not run (a finding about the environment, NOT a detection).\n'
  printf 'finished: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} >> "$LOG"
