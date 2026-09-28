#!/usr/bin/env bash
# V01-007 sensitivity proof — migrations applied to a populated prior state.
#
# The claim is that a migration which drops, rebuilds or rewrites a table carries the rows
# that were already there. "The migration looks like it copies" is a claim about the code;
# the claim is about what a database ends up holding, and only a fault can tell them apart.
#
#   M1  a migration inside prior state A's window DELETEs the seeded plans
#         -> "the seeded plans survive" must fail
#   M2  0020 DELETEs the stored idempotency claims before its rewrite
#         -> "the stored idempotency claim survives the 0020 rewrite" must fail
#
# Both are the smallest possible expression of the defect: a migration that reaches its
# conclusion without preserving the data. Neither needs the probe to be clever -- the point
# is that the probe is *watching* the rows rather than counting tables.
#
# `set -e` plus an explicit mutation-applied guard, from the start. The V01-006 harness
# reported three MISSED verdicts for three mutations that had never run, because
# `set -uo pipefail` does not abort and a failed python heredoc was silent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
API="$ROOT/apps/api"
MIGRATIONS="$API/migrations"
PROBE="$ROOT/docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence/v01-007-migration-prior-state.sh"
WORK="$ROOT/target/v01-migration-sensitivity"
SNAP="$WORK/snapshot"

mkdir -p "$SNAP"
cp "$MIGRATIONS"/*.sql "$SNAP/" || exit 2
# A short snapshot is how the V01-003 harness lost its restore.
if [[ "$(ls -1 "$SNAP"/*.sql | wc -l | tr -d ' ')" -lt 21 ]]; then
  echo "the snapshot is incomplete -- refusing to run a harness that may not restore"
  exit 2
fi

restore() {
  cp "$SNAP"/*.sql "$MIGRATIONS/"
  local ok=1
  for f in "$SNAP"/*.sql; do diff -q "$f" "$MIGRATIONS/$(basename "$f")" >/dev/null || ok=0; done
  if [[ $ok -eq 1 ]]; then
    echo "restored the ledger (verified against the snapshot)"
    return 0
  fi
  echo "RESTORE FAILED -- DO NOT TRUST ANY RESULT"
  return 1
}
trap 'restore' EXIT INT TERM

mutation_applied() {
  if diff -rq "$SNAP" "$MIGRATIONS" >/dev/null 2>&1; then
    echo "MUTATION DID NOT APPLY -- the ledger is unchanged, so this case would grade a run"
    echo "that never happened. Aborting."
    exit 2
  fi
}

fired() { grep -E "^  FAIL  ${2}" "$1" >/dev/null && echo "detected" || echo "MISSED"; }

[[ "${1:-}" == "--apply" ]] || { echo "pass --apply to drive the broken ledger"; exit 2; }

bash "$PROBE" >"$WORK/baseline.txt" 2>&1 || true
echo "baseline: $(grep -oE 'passed: [0-9]+  failed: [0-9]+' "$WORK/baseline.txt" | tail -1)"

# --- M1: a migration in prior state A's window drops the seeded plans -----------
# 0018 sits inside the 0015 -> 0021 window, so a delete there is exactly the class of defect:
# a migration that reaches its conclusion and loses rows a real deployment had.
printf '\n-- V01 SENSITIVITY M1: a migration that drops the seeded rows\nDELETE FROM plans;\n' \
  >>"$MIGRATIONS/0018_p07_platform_operations.sql"
mutation_applied
echo "M1 applied: 0018 now deletes the seeded plans"
bash "$PROBE" >"$WORK/m1.txt" 2>&1 || true
M1=$(fired "$WORK/m1.txt" "the seeded plans survive")
restore

# --- M2: 0020 drops the stored claims before its rewrite -----------------------
printf '\n-- V01 SENSITIVITY M2: the null-safety rewrite loses the stored claims\nDELETE FROM idempotency_records;\n' \
  >>"$MIGRATIONS/0020_p09_idempotency_null_safety.sql"
mutation_applied
echo "M2 applied: 0020 now deletes the stored idempotency claims"
bash "$PROBE" >"$WORK/m2.txt" 2>&1 || true
M2=$(fired "$WORK/m2.txt" "the stored idempotency claim survives")
restore

echo
echo "=== summary ==="
echo "  M1 a migration drops the seeded plans:   $M1"
echo "  M2 0020 drops the stored claims:         $M2"
for f in m1 m2; do
  grep -E "^  FAIL  " "$WORK/$f.txt" | head -3 | cut -c1-170
done
ok=1
[[ "$M1" == detected ]] || ok=0
[[ "$M2" == detected ]] || ok=0
[[ $ok -eq 1 ]]
