#!/usr/bin/env bash
# V04 work item 4 — re-run the high-risk runtime and adversarial proofs.
#
# Each gate here is one of the twenty Tier-0 claims' evidence, so each is run and its own summary is
# recorded. The order is chosen, not alphabetical: the cheapest gates that would catch the most
# damage run first, because if the run has to stop early the earlier results are the ones worth
# having.
#
# SEQUENTIAL BY DESIGN. A held port produces a false exit 2, and exit 2 means "the harness could not
# run" -- a statement about the machine, not the product. A concurrency-induced exit 2 would be
# indistinguishable from a genuine finding, which is the one confusion this whole campaign exists to
# prevent.
#
# EXIT IS RECORDED PER GATE, not rolled up. A roll-up saying "adversarial suite failed" is a verdict
# without a cause.

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
# V04 HARNESS FIX #1 -- LOGS GO ON THE REPOSITORY VOLUME, NOT /tmp.
#
# The first adversarial run died with ENOSPC on the SYSTEM volume (98% full, 326 MiB free) while
# wrangler was writing its own state there -- and every per-gate log went to /tmp with it, so the
# evidence for the failure was destroyed by the failure. A harness that loses its own evidence when
# the machine is under pressure cannot show what the machine did.
#
# /tmp is on the system volume, which is also where wrangler writes. The repository volume is a
# different filesystem with the space, and it is the volume this campaign already designates for
# scratch -- the mutation campaign needs ~2.4 GB per case and is explicitly told to stay off the
# system volume for exactly this reason. So the logs go there: `target/` is gitignored, sits on the
# repository volume, and is wiped by a rebuild rather than by a machine restart.
LOGDIR="${V04_LOGDIR:-$REPO/target/v04-logs}"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/v04-adversarial.log"

: > "$LOG"

GATE=0
RESULTS=()

# V04 HARNESS FIX #2 -- SETTLE THE WORKER BETWEEN GATES.
#
# The first run's last two gates both exited 2: p06 died on a ReferenceError and left workerd holding
# ports, then the gate behind it could not reach a Worker at all. That is the standing hazard -- a
# held port produces a false exit 2, and a false exit 2 is a statement about the machine wearing the
# costume of a finding. `settle_worker` polls until workerd is actually gone, because a live miniflare
# RECREATES the persist directory it was using, so a fixed sleep either races it or tears down a
# directory still in use.
settle_worker() {
  local tries=0
  while [ "$tries" -lt 30 ]; do
    if ! pgrep -f workerd > /dev/null 2>&1; then return 0; fi
    pkill -9 -f workerd 2> /dev/null
    pkill -9 -f "wrangler dev" 2> /dev/null
    tries=$((tries + 1))
    sleep 1
  done
  printf 'WARN: workerd was still alive after %ss; the next gate may report a false exit 2\n' "$tries" >> "$LOG"
  return 0
}

run_gate() {
  local label="$1"
  shift
  GATE=$((GATE + 1))
  local out="$LOGDIR/v04-gate${GATE}-${label}.log"
  local start end code
  settle_worker
  start=$(date +%s)
  ( cd "$REPO" && "$@" ) > "$out" 2>&1
  code=$?
  end=$(date +%s)
  # The summary a reader actually needs: the gate's OWN verdict line, not a line we invented.
  local verdict
  verdict="$(sed 's/\x1b\[[0-9;]*m//g' "$out" \
    | grep -oE '[0-9]+/[0-9]+[a-z0-9 /_-]* (passed|hold|cases hold|checks passed)|passed: [0-9]+ +failed: [0-9]+|[0-9]+ case\(s\) failed' \
    | tail -1)"
  printf '%-40s exit=%-3s %5ss  %s\n' "$label" "$code" "$((end - start))" "${verdict:-(see log)}" >> "$LOG"
  RESULTS+=("$label=$code")
  return 0
}

# --- Tier-0 cross-tenant and authorization --------------------------------------------------------
# Cheapest first. These are the gates whose absence would leave the most Tier-0 claims unproven, and
# they are fast, so a truncated run still produces the most valuable evidence.
run_gate "bind-count"        pnpm schema:bind-count
run_gate "collection-tenancy"  pnpm verify:collection-tenancy
run_gate "filter-tenancy"      pnpm verify:filter-tenancy
run_gate "path-id-tenancy"     pnpm verify:path-id-tenancy
run_gate "mutating-tenancy"    pnpm verify:mutating-tenancy
run_gate "privilege-escalation" pnpm verify:privilege-escalation
run_gate "secret-tenancy"      pnpm verify:secret-tenancy
run_gate "adoption-privacy"    pnpm verify:adoption-privacy

# --- Tier-0 authentication, devices, sessions -------------------------------------------------------
run_gate "passkey"             pnpm smoke:passkey
run_gate "revoked-device"      pnpm verify:revoked-device
run_gate "device-idempotency"  pnpm verify:device-idempotency
run_gate "invitation-race"     pnpm verify:invitation-race

# --- Tier-0 budgets and inference -------------------------------------------------------------------
run_gate "budget-hardceiling"  pnpm verify:budget-hardceiling
run_gate "budget-concurrency"  pnpm verify:budget-concurrency
run_gate "inference-failure"   pnpm verify:inference-failure
run_gate "usage-attribution"   pnpm verify:usage-attribution

# --- Tier-0 tool-policy denial, staff authority, idempotency ------------------------------------------
run_gate "tool-policy-deny"    pnpm verify:tool-policy-deny
run_gate "staff-credential"    pnpm verify:staff-credential
run_gate "idempotency"         pnpm verify:idempotency

# --- Tier-0 automation lease/retry ---------------------------------------------------------------------
run_gate "lease-contention"    pnpm verify:lease-contention
run_gate "attempt-exhaustion"  pnpm verify:attempt-exhaustion

# --- Tier-0 webhook/outbox, data governance, observability ---------------------------------------------
run_gate "webhook-fanout"      pnpm verify:webhook-fanout
run_gate "data-governance p06" pnpm smoke:p06
run_gate "observability"       pnpm verify:observability

{
  printf '\n===========================================================\n'
  printf 'V04 ADVERSARIAL RESULTS\n'
  printf '===========================================================\n'
  for r in "${RESULTS[@]}"; do printf '  %s\n' "$r"; done
  printf '\n'
  NONZERO=0
  for r in "${RESULTS[@]}"; do
    case "$r" in *"=0"*) ;; *) NONZERO=$((NONZERO + 1)) ;; esac
  done
  printf '  %s gates run, %s non-zero exit\n' "${#RESULTS[@]}" "$NONZERO"
  printf '\n'
  printf 'Per-gate logs: $LOGDIR/v04-gate<N>-<name>.log\n'
  printf 'exit 0 = every check held. exit 1 = a check did not hold (a finding about the product).\n'
  printf 'exit 2 = the harness could not run (a finding about the environment, NOT a detection).\n'
  printf 'finished: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} >> "$LOG"
