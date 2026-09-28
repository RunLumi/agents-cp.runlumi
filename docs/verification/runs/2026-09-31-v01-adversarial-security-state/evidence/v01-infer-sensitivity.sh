#!/usr/bin/env bash
# V01 — sensitivity of `verify:inference-failure`.
#
# This gate's claims are almost entirely NEGATIVE, and a gate made of negative claims is the
# shape most able to pass for the wrong reason:
#
#   * "the reservation is not left 'reserved'"  — vacuous if no reservation was ever taken;
#   * "the request reaches a terminal state"    — vacuous if no request row exists;
#   * "no usage row is recorded"                — vacuous if nothing was ever dispatched.
#
# The probe answers all three with an ordered positive control, so the claims are about real
# rows. What that leaves is the other question: can the gate be made to FAIL by a realistic
# single-edit regression?
#
#   M1  the failure path finalises the request but DROPS the reservation release from the
#       batch. Every other part of the failure handling is untouched. The request reaches
#       `failed` and the money stays held — the exact shape this gate exists to catch, and one
#       no status-based assertion can see.
#   M2  the same batch, dropping the REQUEST finalisation instead. The money is correctly
#       released and the request is left non-terminal forever, which is a run that never
#       closes. M1 and M2 are the two halves of one batch, and a gate that only checks the
#       first half would call the second half a pass.
#   M3  the compare-and-set in `UPDATE_BUDGET_RESERVATION_SQL` stops matching, so no release
#       can ever land. A one-token regression in a different file, exercising the SQL rather
#       than the route — and it is the guard that stops a late finaliser from overwriting a
#       COMMITTED reservation with RELEASED, so breaking it is a money defect in its own right.
#
# Harness rules from four earlier rounds of this campaign, each of which bit at least once:
# build explicitly and treat a build failure as a harness error; probe exit 2 is "could not
# run" and is never a verdict; restore in an EXIT trap; assert the file you edited actually
# changed; an empty verdict list is a failure.
#
# Exit 0 when every mutation is DETECTED. Exit 1 otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

PROBE="apps/api/scripts/v01-inference-failure-probe.mjs"
INFERENCE="apps/api/src/routes/inference.rs"
AI="apps/api/src/repositories/ai.rs"
SCRATCH="${P09_SCRATCH:-target/v01-infer-scratch}"
SNAPSHOT="$SCRATCH/snapshot"
LOGDIR="docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence"
mkdir -p "$SNAPSHOT" "$LOGDIR"

say() { printf '\n=== %s\n' "$*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

TRACKED=("$INFERENCE" "$AI")

snapshot_all() {
  rm -rf "$SNAPSHOT"
  for f in "${TRACKED[@]}"; do
    mkdir -p "$SNAPSHOT/$(dirname "$f")"
    cp "$f" "$SNAPSHOT/$f"
    sha "$f" >"$SNAPSHOT/$(echo "$f" | tr '/.' '__').sha"
  done
}

sha_of() { cat "$SNAPSHOT/$(echo "$1" | tr '/.' '__').sha"; }

restore_all() {
  local f after want
  for f in "${TRACKED[@]}"; do
    cp "$SNAPSHOT/$f" "$f"
    want="$(sha_of "$f")"
    after="$(sha "$f")"
    if [ "$after" != "$want" ]; then
      echo "RESTORE FAILED for $f — the next measurement would be against a faulted tree" >&2
      exit 1
    fi
  done
  echo "restored both files"
}

assert_changed() {
  local f
  for f in "${TRACKED[@]}"; do
    if [ "$(sha "$f")" != "$(sha_of "$f")" ]; then
      echo "mutation applied to $f"
      return 0
    fi
  done
  echo "MUTATION DID NOT APPLY — no tracked file changed, so this run would measure a clean" >&2
  echo "tree and report a false MISSED." >&2
  exit 1
}

build_worker() {
  local label="$1" log="$SCRATCH/build-$1.log"
  mkdir -p "$SCRATCH"
  set +e
  cargo build --release --target wasm32-unknown-unknown \
    -p lumi-agents-control-plane-api >"$log" 2>&1
  local code=$?
  set -e
  if [ "$code" != "0" ]; then
    echo "BUILD FAILED for mutation $label -- harness error, not a verdict." >&2
    grep -E "^error" -A 6 "$log" | head -30 >&2
    exit 1
  fi
}

run_probe() {
  local label="$1" out="$SCRATCH/db-$1"
  rm -rf "$out"
  build_worker "$label"
  pkill -9 -f workerd >/dev/null 2>&1 || true
  sleep 2
  set +e
  V01_INFER_PERSIST_TO="$REPO_ROOT/$out" node "$PROBE" >"$LOGDIR/v01-infer-sensitivity-$label.log" 2>&1
  local code=$?
  set -e
  if [ "$code" = "2" ]; then
    echo "PROBE EXITED 2 for $label -- the harness could not run, so nothing was measured." >&2
    tail -25 "$LOGDIR/v01-infer-sensitivity-$label.log" >&2
    exit 1
  fi
  echo "$code"
}

fired() { grep -q "^  FAIL.*$2" "$LOGDIR/v01-infer-sensitivity-$1.log" 2>/dev/null; }

verdicts=()
record() {
  local label="$1" needle="$2" want="$3" why="${4:-}" got="MISSED"
  if fired "$label" "$needle"; then got="DETECTED"; fi
  if [ "$got" = "$want" ]; then
    verdicts+=("OK    $label -> $got")
  elif [ "$got" = "MISSED" ] && [ -n "$why" ]; then
    verdicts+=("KNOWN $label -> MISSED, expected and explained")
    printf '  %-9s %s\n            %s\n' "$got" "$label" "$why"
    return
  else
    verdicts+=("WRONG $label -> $got, expected $want")
  fi
  printf '  %-9s %s\n' "$got" "$label"
}

STRANDED="is not left 'reserved' after the request finished"
NONTERMINAL="reaches a TERMINAL state"
MONEY="no reservation anywhere in the database is left 'reserved'"

CLEAN=0
on_exit() {
  local code=$?
  if [ "$CLEAN" = "0" ] && [ -f "$SNAPSHOT" ]; then
    echo
    echo "--- restoring source from the snapshot before exiting (exit $code)"
    restore_all || true
  fi
  exit "$code"
}
trap on_exit EXIT

# --------------------------------------------------------------- the baseline
say "baseline: the repaired product must pass the gate"
snapshot_all
BASE_CODE="$(run_probe baseline)"
if [ "$BASE_CODE" != "0" ]; then
  echo "BASELINE FAILED (exit $BASE_CODE). A red baseline makes every verdict below unreadable." >&2
  tail -20 "$LOGDIR/v01-infer-sensitivity-baseline.log" >&2
  exit 1
fi
echo "  baseline PASS (exit 0)"
restore_all

# ------------------------------------------------------------------- M1
say "M1: the failure path drops the reservation update — the request finalises, the money stays held"
python3 - "$INFERENCE" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "    let mut statements = vec![update, reservation_update];"
assert needle in src, "the finalisation batch was not where M1 expected it"
# The request state write stays, the reservation update goes. The response is exactly as it
# should be, the request reaches `failed`, and the reservation stays `reserved` forever.
# This is the shape the gate exists to catch, and no status-based assertion can see it.
open(path, "w").write(
    src.replace(needle, "    let mut statements = vec![update]; // MUTATION M1", 1)
)
print("  finalize_request no longer reconciles the reservation")
PY2
assert_changed
M1_CODE="$(run_probe m1)"
echo "  probe exit=$M1_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-infer-sensitivity-m1.log" || true)"
grep -m 1 "STRANDED" "$LOGDIR/v01-infer-sensitivity-m1.log" | cut -c1-200 || true
record m1 "$STRANDED" DETECTED
restore_all

# ------------------------------------------------------------------- M2
say "M2: the same batch drops the REQUEST state write — the money is released, the run never closes"
python3 - "$INFERENCE" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "    let mut statements = vec![update, reservation_update];"
assert needle in src, "the finalisation batch was not where M2 expected it"
# The opposite half, and the one a money-only gate would score as a clean pass: the reservation
# is released correctly and the inference request is left non-terminal forever.
open(path, "w").write(
    src.replace(needle, "    let mut statements = vec![reservation_update]; // MUTATION M2", 1)
)
print("  finalize_request no longer writes the request's terminal state")
PY2
assert_changed
M2_CODE="$(run_probe m2)"
echo "  probe exit=$M2_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-infer-sensitivity-m2.log" || true)"
record m2 "$NONTERMINAL" DETECTED
restore_all

# ------------------------------------------------------------------- M3
say "M3: the reservation compare-and-set stops matching — a one-token change in the SQL"
python3 - "$AI" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "WHERE reservation_id = ?1 AND org_id = ?2 AND request_id = ?6 AND status = 'reserved'"
assert needle in src, "the compare-and-set was not where M3 expected it"
# This guard is what stops a late finaliser from overwriting a COMMITTED reservation with
# RELEASED, so it is a money guard in its own right and not merely a release precondition.
open(path, "w").write(
    src.replace(needle, needle.replace("status = 'reserved'", "status = 'committed'"), 1)
)
print("  UPDATE_BUDGET_RESERVATION_SQL: the compare-and-set now requires 'committed'")
PY2
assert_changed
M3_CODE="$(run_probe m3)"
echo "  probe exit=$M3_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-infer-sensitivity-m3.log" || true)"
record m3 "$MONEY" DETECTED
restore_all

# ------------------------------------------------------------------ verdict
say "verdicts"
if [ "${#verdicts[@]}" -eq 0 ]; then
  echo "  NO VERDICTS RECORDED - the run produced no measurement, which is not a pass." >&2
  exit 1
fi
for line in "${verdicts[@]}"; do echo "  $line"; done
echo
if printf '%s\n' "${verdicts[@]}" | grep -q "^WRONG"; then
  echo "SENSITIVITY FAILED — at least one mutation was not detected." >&2
  exit 1
fi
CLEAN=1
echo "SENSITIVITY OK — every mutation was detected. The gate can fail."
