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
#   M2  the partial unique index's predicate becomes `WHERE state = 'never'`, so the uniqueness no
#       longer covers an active lease at all. This removes the schema-level guarantee outright.
#       **RESULT: a KNOWN MISSED, and the reason is a finding rather than a weak mutation.** With
#       the compare-and-set intact, exclusivity held perfectly — one winner, one active lease, one
#       state transition — with the index removed entirely. So the `state_version` compare-and-set
#       in `TRANSITION_OCCURRENCE_SQL` is the load-bearing mechanism for "at most one active lease
#       per occurrence", and `ux_automation_leases_active` is a redundant second line *for this
#       claim*. That is worth knowing rather than papering over: a reviewer who assumed the index
#       was the guarantee would be wrong about which statement to protect, and a future path that
#       inserts a lease without going through the CAS would have no protection from this proof at
#       all. M1 is the mirror image: break the CAS instead, and the system **fails closed** — zero
#       leases, all eight racers refused — rather than admitting two.
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
  HEAD_BEFORE="$(git rev-parse HEAD)"
  echo "  HEAD at snapshot: $HEAD_BEFORE"
  assert_git_clean "before snapshot"
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

# THE INDEPENDENT REFERENCE. A snapshotting harness has no way to know what "clean" means --
# the snapshot is the only reference it has. So a fault ALREADY PRESENT when the snapshot is
# taken is laundered into the baseline, and every later compare and every restore is faithfully
# correct about a wrong reference. That happened here: three runs reported "restored both source
# files", every compare passed, and the M1 mutation was still in the tree at the end, because
# the snapshot it was restoring to had been taken with the mutation already in it. Only `git`
# could have known, and it did -- via a `git diff` after a run whose verdicts all read DETECTED.
#
# So the tree this harness mutates is checked against the repository, at snapshot time AND after
# every restore. Scoped to the files it touches, because unrelated uncommitted work elsewhere is
# not a finding.
assert_git_clean() {
  local when="$1" f dirty=()
  for f in "${TRACKED[@]}" "${MIG_FILES[@]}"; do
    git diff --quiet -- "$f" 2>/dev/null || dirty+=("$f")
  done
  if [ "${#dirty[@]}" -ne 0 ]; then
    echo "TREE NOT CLEAN ($when) in a file this harness touches:" >&2
    printf '  %s\n' "${dirty[@]}" >&2
    if [ "$when" = "after restore" ]; then
      echo "This is not a mutation of the claim: it means a deliberate fault survived, or the" >&2
      echo "snapshot was taken from an already-faulted tree. Every verdict from this run is void" >&2
      echo "until the tree is verified against git by hand." >&2
    else
      echo "Snapshotting now would launder whatever is in there into the baseline for every" >&2
      echo "comparison and every restore below." >&2
    fi
    exit 1
  fi
  echo "  git agrees the tree is clean ($when)"

  # A COMMIT DURING THE RUN CAPTURES THE FAULT. This is the dangerous variant of the snapshot
  # hazard, and it is worse, because it is permanent and it defeats the obvious repair: a
  # `git add -A` while this harness is mutating staged a deliberate fault, `git checkout --
  # <file>` then restored THE FAULT and reported the tree clean, and `git diff --quiet` above
  # cannot see it because the fault is in the index's HEAD rather than in the working tree. It
  # surfaced here as a baseline that failed for a reason the campaign record did not contain,
  # which is the only reason it was found at all.
  #
  # So HEAD moving while a mutation is applied is itself a fault, checked independently of the
  # file contents. The mutation is reverted by the trap either way, but a commit that captured
  # it has to be undone by a human and the run's verdicts are void until they are.
  if [ -n "${HEAD_BEFORE:-}" ] && [ "$(git rev-parse HEAD)" != "$HEAD_BEFORE" ]; then
    echo "HEAD MOVED DURING THIS RUN ($HEAD_BEFORE -> $(git rev-parse HEAD))." >&2
    echo "A commit made while a deliberate fault was applied has captured it, so the working" >&2
    echo "tree can be clean and still faulted. Every verdict from this run is void." >&2
    exit 1
  fi
}

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
  assert_git_clean "after restore"
}

assert_changed() {
  local f
  for f in "${TRACKED[@]}"; do
    if [ "$(sha "$f")" != "$(sha_of "$f")" ]; then
      echo "mutation applied to $f"
      return 0
    fi
  done
  # Recompute the CURRENT fingerprint before comparing, and write it to the path this function
  # then READS. Two versions of this guard were wrong in the same way: the first compared
  # against the file `restore_all` wrote on the previous case, and the second recomputed the
  # fingerprint but wrote it into the migrations directory and still read the stale copy from
  # the snapshot. Both report a real edit as "nothing changed", which is the false MISSED this
  # guard exists to prevent -- manufactured by the guard itself. A recomputed fingerprint is
  # only evidence if it lands in the file that is compared.
  migration_fingerprint "$SNAPSHOT/migrations.now"
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
  # REACHABILITY. Exit 1 is the code for "the product is broken", and a probe that ran to
  # completion prints its own summary. A probe that DIED also printed things, and used to exit 1
  # as well when it died after recording a failure -- so a run that stopped inside its first case
  # was indistinguishable from a run that graded every case and found two defects. Requiring the
  # summary line means a partial run can never be a verdict, whatever the exit code claims.
  if ! grep -q "cases hold" "$LOGDIR/v01-lease-sensitivity-$label.log"; then
    echo "PROBE FOR $label NEVER REACHED ITS SUMMARY -- it stopped partway, so the numbers in" >&2
    echo "that log do not describe a completed run. Treating it as no measurement at all." >&2
    tail -25 "$LOGDIR/v01-lease-sensitivity-$label.log" >&2
    exit 1
  fi
  if grep -q "DID NOT COMPLETE" "$LOGDIR/v01-lease-sensitivity-$label.log"; then
    echo "PROBE FOR $label REPORTED THAT IT DID NOT COMPLETE -- refusing to grade a partial run." >&2
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

# A SIGNAL SKIPS THE EXIT TRAP. This bit here, and it is the reason the M3 mutation was found
# sitting in `routes/automations.rs` with its lease insert commented out, which made every
# automation claim answer 503 with no lease and had me reading the product for a regression that
# was not one. `pkill` sends SIGTERM, bash has no handler for it, and `trap ... EXIT` does not
# fire for an unhandled signal -- so the restore that every earlier run had printed never ran.
#
# The safety net caught it anyway on the next run (`assert_git_clean "before snapshot"` refuses to
# snapshot a tree that git already disagrees with), which is the right order of preference: the
# trap is best-effort and the independent check is what makes a missed trap harmless rather than
# dangerous. But a harness that deliberately faults source files and leaves them faulted when
# stopped is a hazard in its own right, so the signals are handled and re-raise through `exit`,
# which does run the EXIT trap.
trap 'echo "--- signal caught; restoring before exit" >&2; exit 130' INT TERM HUP

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
# Both records DETECTED, and the mechanism is the finding: a CAS that no longer advances leaves
# every racer's UPDATE matching, so all eight batches run, and the batches FAIL -- zero leases,
# eight 503s. The system denies all work rather than admitting two, which is the right way round
# to break. The index would still admit one lease in principle, so a lease COUNT alone would not
# have shown this; the counter assertion is what sees it.
record m1 "$ONE_LEASE" DETECTED
record m1 "$ONE_ATTEMPT" DETECTED
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
# Both of M2's records are expected MISSEDs, and for the same reason: with the CAS intact the
# claim holds on its own, so removing the index's predicate changes nothing observable. That is a
# statement about which mechanism carries the claim, and it is the reason M1 exists.
record m2 "$ONE_LEASE" DETECTED \
  "EXPECTED MISSED, and it is a result rather than a weak mutation: exclusivity held with the index \
   removed, so the state_version compare-and-set is the load-bearing mechanism and this index is a \
   redundant second line for the claim. M1 is the mirror: break the CAS and the run fails CLOSED, \
   with zero active leases and all eight racers refused"
record m2 "$NO_LEAK" DETECTED \
  "expected MISSED, and necessarily so: the same-key losers were refused by the CAS, so the responses \
   carried no winner material to leak and the disclosure assertions had nothing extra to find"
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
