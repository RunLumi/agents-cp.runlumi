#!/usr/bin/env bash
# V04 work item 1 — the deterministic baseline, from the pinned commit, sequentially.
#
# WHY SEQUENTIAL AND NOT PARALLEL: a held port produces a false exit 2, and the V01/V02 campaigns
# both learned that the difference between "a check did not hold" (exit 1) and "the harness could not
# run" (exit 2) is the difference between a statement about the product and a statement about the
# machine. Parallel gates would blur exactly that distinction. This script runs them in order and
# records each exit code separately so no step can be read as another's result.
#
# WHY IT RECORDS STEP-BY-STEP RATHER THAN A SINGLE ROLL-UP: a roll-up that says "baseline failed"
# is a verdict without a cause, and this campaign's standing finding is that a verdict with no cause
# is the same failure as a verdict with no evidence.

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
LOGDIR="${V04_LOGDIR:-$(dirname "$REPO")/v04-logs}"
#
# V04 HARNESS FIX #3 -- AND NOT UNDER target/ EITHER. The second re-run lost its logs because
# something reclaimed the 28 GB that `target/` held after the system volume hit 98%: `target/` was
# deleted, and with it `$REPO/target/v04-logs`. That is a plausible, benign action by another process
# and it still destroyed the evidence of a gate that was running at the time -- so the log home is a
# sibling of the repository on the SAME volume, outside the build directory, where neither a rebuild
# nor a disk-space recovery can reach it.

mkdir -p "$LOGDIR"
LOG="$LOGDIR/v04-baseline.log"

: > "$LOG"

STEP=0
RESULTS=()

run_step() {
  local label="$1"
  shift
  STEP=$((STEP + 1))
  local out="$LOGDIR/v04-baseline-step${STEP}.log"
  printf '\n===== [%d] %s =====\n' "$STEP" "$label" >> "$LOG"
  local start end code
  start=$(date +%s)
  ( cd "$REPO" && "$@" ) > "$out" 2>&1
  code=$?
  end=$(date +%s)
  local tail_summary
  tail_summary="$(grep -oE '[0-9]+/[0-9]+ [a-z-]+( passed| hold| cases hold)?' "$out" | tail -1)"
  printf '  exit=%s  %ss  %s\n' "$code" "$((end - start))" "${tail_summary:-(no summary line)}" >> "$LOG"
  printf '  log: %s\n' "$out" >> "$LOG"
  RESULTS+=("$(printf '%-46s exit=%s  %ss' "$label" "$code" "$((end - start))")")
  return 0
}

log() { printf '%s\n' "$*" >> "$LOG"; }

log "V04 deterministic baseline"
log "commit: $(git -C "$REPO" rev-parse HEAD)"
log "started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
log "node $(node -v) / pnpm $(pnpm -v) / cargo $(cargo -V 2>/dev/null | cut -d' ' -f2)"

# --- repository integrity -------------------------------------------------------------------------
run_step "pnpm check (format, lint, typecheck, test, rust)" pnpm check
run_step "pnpm build"                                    pnpm build
run_step "rust WASM check"                               cargo check --workspace --target wasm32-unknown-unknown
run_step "schema bind count"                             pnpm schema:bind-count

# --- database ------------------------------------------------------------------------------------
# Fresh D1, from zero. Every campaign migration gate starts from zero rows, and that is how `teams`
# stayed unwritable while all of them were green -- which is why `verify:migration-prior-state` exists
# and why the populated case is the one that matters.
run_step "fresh D1 migration ledger"                     pnpm --filter @runlumi/agents-cp-api db:migrations:apply:local
run_step "P08 schema invariants (17 expected)"            pnpm --filter @runlumi/agents-cp-api p08:invariants
run_step "upgrade path over POPULATED tables"             pnpm verify:migration-prior-state
run_step "restore rejects invalid writes"                pnpm verify:restore

# --- repository self-checks ----------------------------------------------------------------------
run_step "mutation campaign self-test"                    pnpm verify:campaign-selftest
run_step "mutation campaign preflight"                    pnpm verify:campaign-preflight

log ""
log "=============================================================================="
log "V04 BASELINE RESULTS"
log "=============================================================================="
for r in "${RESULTS[@]}"; do log "  $r"; done
log ""
FAILS=0
for r in "${RESULTS[@]}"; do
  case "$r" in *"exit=0"*) ;; *) FAILS=$((FAILS + 1)) ;; esac
done
log "  ${#RESULTS[@]} steps run, $FAILS non-zero exit"
log ""
log "NOTE: a non-zero exit here is a STARTING POINT, not a verdict. Exit 1 is 'a check did not"
log "hold'; exit 2 is 'the harness could not run'. They are different findings and are recorded"
log "separately above. Nothing here is a release verdict."
log "finished: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
