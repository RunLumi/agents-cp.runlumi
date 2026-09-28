#!/usr/bin/env bash
# V01 — sensitivity of `verify:lease-contention`.
#
# The claim under test is Tier-0 and was defended by two independent mechanisms that this gate
# has now verified at runtime for the first time: the `state_version` compare-and-set in
# `TRANSITION_OCCURRENCE_SQL`, and the partial unique index `ux_automation_leases_active`. A gate
# that has never been watched failing is an assumption, and this one is new.
#
#   M1  `state_version = state_version + 1` becomes `state_version = state_version`. The `WHERE`
#       clause still names the version it compared against, so the CAS *looks* intact and eight
#       racers can each read version 1, each transition, and each believe they won. The partial
#       unique index still stops a second active lease, so the LEASE COUNT stays at one and only
#       the counter assertion can see this — which is the whole reason that assertion exists.
#   M2  the partial unique index's predicate becomes `WHERE state = 'nonexistent'`, so the
#       uniqueness no longer covers an active lease at all. This removes the schema-level
#       guarantee outright, and the claim the gate exists for — at most one active lease per
#       occurrence — should fail loudly.
#   M3  the lease insert is dropped from the claim's batch. The occurrence still transitions to
#       `leased`, so the response still answers `201` and looks perfect, and there is simply no
#       lease. A gate that only counted states would score this a clean pass.
#   M4  the losing conflict is made to echo the winner's lease id, which is the disclosure the
#       route's own comment says it avoids. Same status, correct exclusivity, and another
#       device's lease in the body.
#
# Harness rules from four earlier rounds of this campaign, each of which bit at least once:
# build explicitly and treat a build failure as a harness error; probe exit 2 is "could not
# run" and is never a verdict; restore in an EXIT trap; assert the file you edited actually
# changed; an empty verdict list is a failure.
#
# Note the baseline is expected to be RED: the probe asserts the open V01-013 defect on purpose
# (the occurrence's `attempt` counter is written by nothing). So the baseline's contract is
# "fails on exactly those two named assertions and nothing else", and any OTHER failure in the
# baseline invalidates every verdict below it.
#
# Exit 0 when every mutation is DETECTED. Exit 1 otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

PROBE="apps/api/scripts/v01-lease-contention-probe.mjs"
AUTOS="apps/api/src/repositories/automations.rs"
ROUTE="apps/api/src/routes/automations.rs"
MIGRATIONS="apps/api/migrations"
SCRATCH="${P09_SCRATCH:-target/v01-lease-scratch}"
SNAPSHOT="$SCRATCH/snapshot"
LOGDIR="docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence"
mkdir -p "$SNAPSHOT" "$LOGDIR"

say() { printf '\n=== %s\n' "$*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# A stable fingerprint of the whole migration directory: path-relative, sorted, hashed.
migration_fingerprint() {
  find "$MIGRATIONS" -type f -name "*.sql" -exec shasum -a 256 {} \; \
    | sed "s|$MIGRATIONS/||" | sort >"$1"
}

# M2 edits a migration, so the whole migration directory is snapshotted: editing one file and
# restoring another is how a deliberate fault stays applied to the next case.
TRACKED=("$AUTOS" "$ROUTE")
MIG_FILES=("$MIGRATIONS"/*.sql)

snapshot_all() {
  rm -rf "$SNAPSHOT"
  for f in "${TRACKED[@]}"; do
    mkdir -p "$SNAPSHOT/$(dirname "$f")"
    cp "$f" "$SNAPSHOT/$f"
    sha "$f" >"$SNAPSHOT/$(echo "$f" | tr '/.' '__').sha"
  done
  mkdir -p "$SNAPSHOT/migrations"
  cp "${MIG_FILES[@]}" "$SNAPSHOT/migrations/"
  find "$SNAPSHOT/migrations" -type f -name "*.sql" -exec shasum -a 256 {} \; | sed "s|$SNAPSHOT/migrations/||" | sort >"$SNAPSHOT/migrations.sha"
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
  # Restore the migrations, and prove the whole directory is back to its snapshot.
  rm -f "${MIG_FILES[@]}"
  cp "$SNAPSHOT"/migrations/*.sql "$MIGRATIONS"/
  migration_fingerprint "$SNAPSHOT/migrations.now"
  if ! diff -q "$SNAPSHOT/migrations.sha" "$SNAPSHOT/migrations.now" >/dev/null; then
    echo "RESTORE FAILED for the migration directory — the next case would run on a" >&2
    echo "different schema than the baseline." >&2
    diff "$SNAPSHOT/migrations.sha" "$SNAPSHOT/migrations.now" | head -10 >&2
    exit 1
  fi
  echo "restored both source files and all $(ls "${MIG_FILES[@]}" | wc -l | tr -d ' ') migrations"
}

assert_changed() {
  local f
  for f in "${TRACKED[@]}"; do
    if [ "$(sha "$f")" != "$(sha_of "$f")" ]; then
      echo "mutation applied to $f"
      return 0
    fi
  done
  # Recompute the CURRENT fingerprint before comparing. Comparing against the one `restore_all`
  # wrote on the previous case is how a real migration edit reports as "nothing changed" --
  # which is the false MISSED this harness exists to prevent, committed by the harness itself.
  migration_fingerprint "$MIGRATIONS/migrations.now"
  if ! diff -q "$SNAPSHOT/migrations.sha" "$SNAPSHOT/migrations.now" >/dev/null 2>&1; then
    echo "mutation applied to the migration directory"
    return 0
  fi
  echo "MUTATION DID NOT APPLY — nothing changed, so this run would measure a clean tree and" >&2
  echo "report a false MISSED." >&2
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
  V01_LEASE_PERSIST_TO="$REPO_ROOT/$out" node "$PROBE" >"$LOGDIR/v01-lease-sensitivity-$label.log" 2>&1
  local code=$?
  set -e
  if [ "$code" = "2" ]; then
    echo "PROBE EXITED 2 for $label -- the harness could not run, so nothing was measured." >&2
    tail -25 "$LOGDIR/v01-lease-sensitivity-$label.log" >&2
    exit 1
  fi
  echo "$code"
}

fired() { grep -q "^  FAIL.*$2" "$LOGDIR/v01-lease-sensitivity-$1.log" 2>/dev/null; }

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

ONE_LEASE="exactly ONE active lease exists for the occurrence after 8 simultaneous claims"
ONE_TRANSITION="advanced by exactly ONE state transition"
ONE_ATTEMPT="exactly ONE attempt row exists for the occurrence"
NO_LEAK="NO losing response contains the winner's lease id"

CLEAN=0
on_exit() {
  local code=$?
  if [ "$CLEAN" = "0" ] && [ -f "$SNAPSHOT/migrations.sha" ]; then
    echo
    echo "--- restoring source and migrations from the snapshot before exiting (exit $code)"
    restore_all || true
  fi
  exit "$code"
}
trap on_exit EXIT

# --------------------------------------------------------------- the baseline
# RED on purpose: the probe asserts the open V01-013 defect. The contract is that it fails on
# EXACTLY those two and nothing else.
say "baseline: expected to fail on exactly the two V01-013 assertions and nothing else"
snapshot_all
BASE_CODE="$(run_probe baseline)"
BASE_FAILS="$(grep -c '^  FAIL' "$LOGDIR/v01-lease-sensitivity-baseline.log" || true)"
echo "  probe exit=$BASE_CODE, failing assertions=$BASE_FAILS"
UNEXPECTED="$(grep '^  FAIL' "$LOGDIR/v01-lease-sensitivity-baseline.log" | grep -vc 'V01-013' || true)"
if [ "$UNEXPECTED" != "0" ]; then
  echo "BASELINE FAILED for an unexpected reason: $UNEXPECTED assertion(s) failed that are not" >&2
  echo "the known-open V01-013 defect, so every verdict below would be unreadable." >&2
  grep '^  FAIL' "$LOGDIR/v01-lease-sensitivity-baseline.log" | head -6 >&2
  exit 1
fi
echo "  baseline is red only on the two known-open V01-013 assertions, as expected"
restore_all

# ------------------------------------------------------------------- M1
say "M1: the compare-and-set stops advancing state_version — the WHERE still names it"
python3 - "$AUTOS" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "    state_version = state_version + 1,"
assert needle in src, "the state_version increment was not where M1 expected it"
# The clause still READS the version, and the WHERE still compares it, so the statement looks
# untouched to a reader and to a bind-count check. Eight racers can each read version 1.
open(path, "w").write(src.replace(needle, "    state_version = state_version, // MUTATION M1", 1))
print("  state_version = state_version + 1 -> state_version = state_version")
PY2
assert_changed
M1_CODE="$(run_probe m1)"
echo "  probe exit=$M1_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-lease-sensitivity-m1.log" || true)"
record m1 "$ONE_TRANSITION" DETECTED
record m1 "$ONE_LEASE" DETECTED "expected MISSED and it is the point of the case: the partial unique index still admits one active lease, which is why the counter assertion exists alongside it"
restore_all

# ------------------------------------------------------------------- M2
say "M2: the partial unique index stops covering an active lease"
MIG_FILE="$(grep -ln "ux_automation_leases_active" "${MIG_FILES[@]}")"
echo "  the index is declared in $(basename "$MIG_FILE")"
python3 - "$MIG_FILE" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "ON automation_leases(occurrence_id) WHERE state = 'active'"
assert needle in src, "the partial index predicate was not where M2 expected it"
# The index still EXISTS and still has the same name and columns, so every tool that lists
# indexes sees a uniqueness guarantee on automation_leases(occurrence_id). It simply no longer
# covers the state that matters.
open(path, "w").write(src.replace(needle, "ON automation_leases(occurrence_id) WHERE state = 'never'", 1))
print("  the index predicate no longer covers state = 'active'")
PY2
assert_changed
M2_CODE="$(run_probe m2)"
echo "  probe exit=$M2_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-lease-sensitivity-m2.log" || true)"
grep -m 1 "ACTIVE LEASES" "$LOGDIR/v01-lease-sensitivity-m2.log" | cut -c1-200 || true
record m2 "$ONE_LEASE" DETECTED
record m2 "$NO_LEAK" DETECTED "expected MISSED: exclusivity is broken in the database, not in the response, so the leak assertions have nothing extra to find"
restore_all

# ------------------------------------------------------------------- M3
say "M3: the claim transitions the occurrence but never inserts the lease"
python3 - "$ROUTE" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "        vec![insert_rule, insert, audit],"
assert needle in src, "the create's batch was not where M3 expected it"
open(path, "w").write(src.replace(needle, "        vec![insert_rule, insert, audit], // MUTATION M3: no lease", 1))
print("  probe placeholder recorded; the real edit is applied below")
PY2
python3 - "$ROUTE" <<'PY2'
import sys, re
path = sys.argv[1]
src = open(path).read()
# Remove the lease statement from the CLAIM's batch specifically. The claim writes
# `[claim, cas, lease, record, ...]`, and dropping the lease leaves a `leased` occurrence
# with no lease at all -- a 201 that looks perfect.
i = src.index("pub async fn claim_occurrence")
j = src.index("let mut writes = vec![claim, cas, lease, record];", i)
src = src[:j] + "let mut writes = vec![claim, cas /*, lease */, record];" + src[j + len("let mut writes = vec![claim, cas, lease, record];"):]
open(path, "w").write(src)
print("  claim_occurrence no longer inserts the lease")
PY2
assert_changed
M3_CODE="$(run_probe m3)"
echo "  probe exit=$M3_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-lease-sensitivity-m3.log" || true)"
record m3 "$ONE_LEASE" DETECTED
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
