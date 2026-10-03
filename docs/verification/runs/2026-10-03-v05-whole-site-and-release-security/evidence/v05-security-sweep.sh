#!/usr/bin/env bash
# V05 §2 — the security gate sweep. Every Tier-0-carrying gate from AGENTS.md's
# runtime-proof table, re-run in THIS campaign against the repaired candidate
# tree, with the documented command forms (a documented command that cannot
# start is a gate that provides no evidence).
#
# Each gate logs to v05-gate-<name>.log beside this script; the summary at the
# end lists gate -> exit. Exit codes are load-bearing: 1 = a check did not hold,
# 2 = the harness could not run. Two gates are EXPECTED to exit 2 in this
# environment and are annotated: smoke:p06 (local jobs queue never delivers, the
# V01-026/V04 T0-16 blocker) and verify:provider-faults (Worker cannot open an
# outbound socket, V01-026). Anything else exiting non-zero fails the sweep.
set -uo pipefail

EVIDENCE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$EVIDENCE" && git rev-parse --show-toplevel)"
SUMMARY="$EVIDENCE/v05-security-sweep-summary.txt"
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$HOME/.lumi-tools/bin:$HOME/.cargo/bin:$PATH"
export npm_config_store_dir=/Volumes/SSD/.pnpm-store-v12
PNPM="$HOME/.lumi-tools/bin/pnpm"
cd "$REPO"

: > "$SUMMARY"
run_gate() { # $1 name, $2 command, $3 expected exit (default 0)
  local name="$1" cmd="$2" expected="${3:-0}" log="$EVIDENCE/v05-gate-$1.log"
  echo "=== $name — $cmd" >> "$log"
  local start end
  start=$(date +%s)
  ( cd "$REPO" && eval "$cmd" ) > "$log" 2>&1
  local code=$?
  end=$(date +%s)
  local verdict="PASS"
  [ "$code" != "$expected" ] && verdict="FAIL"
  {
    printf '%-28s exit=%-3s expected=%-3s %-4s %ss\n' "$name" "$code" "$expected" "$verdict" "$((end-start))"
  } | tee -a "$SUMMARY"
}

echo "V05 §2 security sweep — started $(date -u +%FT%TZ)" | tee -a "$SUMMARY"
echo "candidate tree: $(git rev-parse --short HEAD) (+ working tree repairs)" | tee -a "$SUMMARY"
echo | tee -a "$SUMMARY"

# --- fast deterministic integrity gates ---------------------------------------
run_gate bind-count        "node apps/api/scripts/p09-bind-count-scan.mjs"
run_gate migrate-fresh     "rm -rf apps/api/.wrangler/state && $PNPM db:migrate:local"
run_gate p08-invariants    "$PNPM --filter @runlumi/agents-cp-api p08:invariants"
run_gate guard-probe       "$PNPM guard:probe"

# --- per-phase surface smokes --------------------------------------------------
run_gate smoke-local       "$PNPM smoke:local"
run_gate smoke-p02         "$PNPM smoke:p02"
run_gate smoke-p03         "$PNPM smoke:p03"
run_gate smoke-p04         "$PNPM smoke:p04"
run_gate smoke-p05         "$PNPM smoke:p05"

# --- tenant isolation (T0-01, T0-02, T0-15) ------------------------------------
run_gate collection-tenancy "$PNPM verify:collection-tenancy"
run_gate path-id-tenancy    "$PNPM verify:path-id-tenancy"
run_gate filter-tenancy     "node apps/api/scripts/v01-filter-tenancy-probe.mjs"
run_gate mutating-tenancy   "node apps/api/scripts/v01-mutating-tenancy-probe.mjs"
run_gate privilege-esc      "$PNPM verify:privilege-escalation"
run_gate smoke-p08          "node apps/api/scripts/p08-tenancy-smoke.mjs"

# --- secrets and observability (T0-05) -----------------------------------------
run_gate secret-tenancy     "$PNPM verify:secret-tenancy"
run_gate observability      "$PNPM verify:observability"
run_gate adoption-privacy   "$PNPM verify:adoption-privacy"

# --- budgets and inference (T0-06, T0-07, T0-08) --------------------------------
run_gate budget-hardceiling "$PNPM verify:budget-hardceiling"
run_gate budget-concurrency "$PNPM verify:budget-concurrency"
run_gate inference-failure  "node apps/api/scripts/v01-inference-failure-probe.mjs"
run_gate usage-attribution  "node apps/api/scripts/v01-usage-attribution-probe.mjs"

# --- destructive operations and revocation (T0-04, T0-09) -----------------------
run_gate idempotency        "node apps/api/scripts/v01-idempotency-probe.mjs"
run_gate device-idempotency "node apps/api/scripts/v01-device-idempotency-probe.mjs"
run_gate revoked-device     "node apps/api/scripts/v01-revoked-device-probe.mjs"
run_gate invitation-race    "node apps/api/scripts/v01-invitation-race-probe.mjs"

# --- staff/machine boundary and tool policy (T0-13, T0-14, T0-20) ----------------
run_gate staff-credential   "$PNPM verify:staff-credential"
run_gate tool-policy-deny   "$PNPM verify:tool-policy-deny"

# --- async bounds (T0-17) --------------------------------------------------------
run_gate attempt-exhaustion "node apps/api/scripts/v01-attempt-exhaustion-probe.mjs"
run_gate lease-contention   "node apps/api/scripts/v01-lease-contention-probe.mjs"
run_gate webhook-fanout     "$PNPM verify:webhook-fanout"

# --- migrations and restore (T0-11, T0-12) ---------------------------------------
run_gate restore-rehearsal  "node apps/api/scripts/p09-restore-rehearsal.mjs"
run_gate migration-prior    "bash docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence/v01-007-migration-prior-state.sh"

# --- known environmental BLOCKEDs: expected exit 2, the blocker is measured ------
run_gate smoke-p06          "node apps/api/scripts/p06-data-smoke.mjs" 2
run_gate provider-faults    "node apps/api/scripts/v01-provider-fault-probe.mjs" 2

# --- the mutation campaign's preflight (cases must still apply; the campaign
#     itself is carried from V04 with the product tree unchanged) ------------------
run_gate campaign-preflight "node apps/api/scripts/p09-mutation-campaign.mjs --preflight"

echo | tee -a "$SUMMARY"
echo "sweep finished $(date -u +%FT%TZ)" | tee -a "$SUMMARY"
if grep -q "FAIL" "$SUMMARY"; then
  echo "SWEEP: FAIL (at least one gate did not meet its expected exit)"
  exit 1
fi
echo "SWEEP: all gates met their expected exits"
exit 0
