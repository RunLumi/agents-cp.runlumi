#!/usr/bin/env bash
# V01 — sensitivity of `verify:usage-attribution`, and of the two checks the managed-run work added.
#
# A gate nobody has watched fail is an assumption. This one is new in the load-bearing sense: it now
# carries the objective's budget item 4 in full (usage attributed to the right org, project,
# principal AND run), which it did not before this round — the `run_id` leg was SKIPPED.
#
# Two mutations, each aimed at the *newest* coverage rather than at the oldest:
#
#   M1  `RUN_BY_ID_SQL`'s `AND org_id = ?2` becomes `AND ?2 = ?2`. The placeholder is still there
#       and still bound, so the statement remains valid and only the *scoping* goes: a foreign run
#       now resolves, and is then refused for a different reason — a 403 `resource_scope_mismatch`
#       against the phantom's 404 `run_not_found`. **The interesting part is which assertion sees
#       it.** The escalation case ("Alpha naming Bravo's run_id is refused, or answered without
#       spending Bravo's budget") still PASSES: it accepts any non-2xx with zero usage rows, and
#       403 is such an answer. Only the non-disclosure control — foreign run vs a run that never
#       existed — can tell the two apart, because that is the only assertion that requires the two
#       refusals to be *the same refusal*. If that is what the run reports, it is the finding: the
#       tenant-isolation requirement "denial does not leak unintended existence" is defended by one
#       assertion, and the other is blind to the difference by construction.
#
#       The FIRST version of M1 deleted `AND org_id = ?2` outright. That is the obvious edit and it
#       is the wrong one: it left two binds against one placeholder, D1 refused the statement, and
#       **both** probes answered `503 run_state_unavailable` — indistinguishable, so the
#       non-disclosure check PASSED and the run reported a MISSED. A gate that reports a
#       correct-looking pass on a build that cannot execute the query at all is the "a verdict is
#       only worth what its reference is worth" class, reached by a different route: the reference
#       was broken rather than wrong. This is also the same bind-count trap the tenant audit keeps
#       finding, now from the other direction — a dropped predicate with an untouched bind list.

#
#   M2  the usage row's `run_id` bind becomes `BindValue::Null`, unconditionally. Nothing crashes,
#       every inference still succeeds, and attribution still looks clean for org/project/principal
#       — because the row simply stops naming a run. The probe's "at least one usage row carries a
#       run_id" control must fail, because without it the run clause of the internal-consistency
#       invariant grades an empty set. This is the check that guards the check.
#
# Harness rules from four earlier rounds of this campaign, each of which bit at least once:
# build explicitly and treat a build failure as a harness error; probe exit 2 is "could not run"
# and is never a verdict; restore in an EXIT trap; assert the file you edited actually changed; an
# empty verdict list is a failure; the tree is checked against git independently of the snapshot;
# HEAD must not move during a run; signals re-raise through `exit` so the restore actually runs.
#
# Exit 0 when every mutation is DETECTED. Exit 1 otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

PROBE="apps/api/scripts/v01-usage-attribution-probe.mjs"
RUNS="apps/api/src/repositories/runs.rs"
AI="apps/api/src/repositories/ai.rs"
SCRATCH="${P09_SCRATCH:-target/v01-usage-scratch}"
SNAPSHOT="$SCRATCH/snapshot"
LOGDIR="docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence"
mkdir -p "$SNAPSHOT" "$LOGDIR"

say() { printf '\n=== %s\n' "$*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

TRACKED=("$RUNS" "$AI")

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
}

sha_of() { cat "$SNAPSHOT/$(echo "$1" | tr '/.' '__').sha"; }

# THE INDEPENDENT REFERENCE. A snapshot is the only reference this harness has, so a fault already
# present when the snapshot is taken is laundered into the baseline and every later compare and
# restore is faithfully correct about a wrong reference. `git` is the independent one, and it is
# checked at snapshot time AND after every restore, scoped to the two files this harness edits.
assert_git_clean() {
  local when="$1" f dirty=()
  for f in "${TRACKED[@]}"; do
    git diff --quiet -- "$f" 2>/dev/null || dirty+=("$f")
  done
  if [ "${#dirty[@]}" -ne 0 ]; then
    echo "TREE NOT CLEAN ($when) in a file this harness touches:" >&2
    printf '  %s\n' "${dirty[@]}" >&2
    echo "A deliberate fault survived, or the snapshot came from an already-faulted tree." >&2
    echo "Every verdict from this run is void until the tree is checked against git by hand." >&2
    exit 1
  fi
  echo "  git agrees the tree is clean ($when)"
  # A COMMIT DURING THE RUN CAPTURES THE FAULT, after which `git checkout -- <file>` restores the
  # fault and reports the tree clean, because the index now agrees with it. Permanent, and invisible
  # to every file-content check. So HEAD moving is itself a fault, independent of the contents.
  if [ -n "${HEAD_BEFORE:-}" ] && [ "$(git rev-parse HEAD)" != "$HEAD_BEFORE" ]; then
    echo "HEAD MOVED DURING THIS RUN ($HEAD_BEFORE -> $(git rev-parse HEAD))." >&2
    echo "A commit made while a deliberate fault was applied has captured it. Verdicts are void." >&2
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
  echo "restored $(printf '%s and ' "${TRACKED[@]}")"
  assert_git_clean "after restore"
}

# The mutation must have actually happened. Without this, a `sed` that matched nothing produces a
# run against a clean tree and a false MISSED — manufactured by the guard that exists to prevent it.
assert_changed() {
  local f
  for f in "${TRACKED[@]}"; do
    if [ "$(sha "$f")" != "$(sha_of "$f")" ]; then
      echo "  mutation applied to $f"
      return 0
    fi
  done
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
  V01_USAGE_PERSIST_TO="$REPO_ROOT/$out" node "$PROBE" \
    >"$LOGDIR/v01-usage-sensitivity-$label.log" 2>&1
  local code=$?
  set -e
  if [ "$code" = "2" ]; then
    echo "PROBE EXITED 2 for $label -- the harness could not run, so nothing was measured." >&2
    tail -25 "$LOGDIR/v01-usage-sensitivity-$label.log" >&2
    exit 1
  fi
  # REACHABILITY. A probe that died also printed things, and used to exit 1 like one that graded
  # every case. Requiring the summary line means a partial run can never be a verdict.
  if ! grep -q "cases hold" "$LOGDIR/v01-usage-sensitivity-$label.log"; then
    echo "PROBE FOR $label NEVER REACHED ITS SUMMARY -- it stopped partway, so the numbers in" >&2
    echo "that log do not describe a completed run. Treating it as no measurement at all." >&2
    tail -25 "$LOGDIR/v01-usage-sensitivity-$label.log" >&2
    exit 1
  fi
  if grep -q "DID NOT COMPLETE" "$LOGDIR/v01-usage-sensitivity-$label.log"; then
    echo "PROBE FOR $label REPORTED THAT IT DID NOT COMPLETE -- refusing to grade a partial run." >&2
    tail -25 "$LOGDIR/v01-usage-sensitivity-$label.log" >&2
    exit 1
  fi
  echo "$code"
}

fired() { grep -qE "^  FAIL.*$2" "$LOGDIR/v01-usage-sensitivity-$1.log" 2>/dev/null; }

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

NONDISCLOSURE="indistinguishable, so the 404 is not an existence oracle"
RUN_LEG="carries a run_id, so the run leg of the invariant above is exercised"
FOREIGN_RUN_ESCALATION="naming a foreign run_id is refused"

CLEAN=0
on_exit() {
  local code=$?
  if [ "$CLEAN" = "0" ] && [ -f "$SNAPSHOT/$(echo "${TRACKED[0]}" | tr '/.' '__').sha" ]; then
    echo
    echo "--- restoring source from the snapshot before exiting (exit $code)"
    restore_all || true
  fi
  exit "$code"
}
trap on_exit EXIT

# A SIGNAL SKIPS THE EXIT TRAP. `pkill` sends SIGTERM, bash has no handler for it, and
# `trap ... EXIT` does not fire for an unhandled signal — so the restore that every earlier run
# printed never ran, and the next run measured a faulted binary against a clean tree. The signals
# are handled and re-raise through `exit`, which does run the EXIT trap. The trap is best-effort;
# `assert_git_clean` is what makes a missed one harmless.
trap 'echo "--- signal caught; restoring before exit" >&2; exit 130' INT TERM HUP

# --------------------------------------------------------------- the baseline
say "baseline: the managed run exists, and both refusals are indistinguishable"
snapshot_all
BASE_CODE="$(run_probe baseline)"
BASE_FAILS="$(grep -c '^  FAIL' "$LOGDIR/v01-usage-sensitivity-baseline.log" || true)"
echo "  probe exit=$BASE_CODE, failing assertions=$BASE_FAILS"
if [ "$BASE_FAILS" != "0" ]; then
  echo "BASELINE IS NOT GREEN: $BASE_FAILS assertion(s) fail before any mutation, so a detection" >&2
  echo "below could not be attributed to the fault." >&2
  grep '^  FAIL' "$LOGDIR/v01-usage-sensitivity-baseline.log" | head -8 >&2
  exit 1
fi
grep -E "non-disclosure" "$LOGDIR/v01-usage-sensitivity-baseline.log" | head -2 | sed 's/^/  /'
restore_all

# -------------------------------------------------------------------- M1
say "M1: find_run stops scoping by org, so a foreign run is FOUND and refused differently"
python3 - "$RUNS" << 'PY'
import sys
path = sys.argv[1]
src = open(path).read()
# The placeholder STAYS and stays bound. Deleting it would leave two binds against one
# placeholder, D1 would refuse the statement, and both probes would answer the same 503 -- which
# is a broken reference, not a measurement of the claim.
old = "WHERE run_id = ?1 AND org_id = ?2"
new = "WHERE run_id = ?1 AND ?2 = ?2"
if old not in src:
    print("M1 ANCHOR NOT FOUND", file=sys.stderr)
    sys.exit(1)
open(path, "w").write(src.replace(old, new, 1))
print("  RUN_BY_ID_SQL binds org_id but no longer filters on it")
PY
assert_changed
M1_CODE="$(run_probe m1)"
echo "  probe exit=$M1_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-usage-sensitivity-m1.log" || true)"
grep -E "non-disclosure|a foreign run_id" "$LOGDIR/v01-usage-sensitivity-m1.log" | head -4 | sed 's/^/  /'
record m1 "$NONDISCLOSURE" DETECTED
# Recorded, not asserted: the escalation is expected to STILL pass, because it accepts any non-2xx.
if fired m1 "$FOREIGN_RUN_ESCALATION"; then
  echo "  UNEXPECTED: the escalation case also fired; the non-disclosure control is not the only"
  echo "  thing standing between a foreign run and a distinguishable answer."
fi
restore_all

# -------------------------------------------------------------------- M2
say "M2: the usage row stops naming its run, so the run leg of the invariant grades nothing"
python3 - "$AI" << 'PY'
import sys
path = sys.argv[1]
src = open(path).read()
old = "                run_id.map_or(BindValue::Null, BindValue::Text),"
new = "                BindValue::Null, // M2: the usage row no longer names its run"
if old not in src:
    print("M2 ANCHOR NOT FOUND", file=sys.stderr)
    sys.exit(1)
open(path, "w").write(src.replace(old, new, 1))
print("  the run_id bind is now unconditionally NULL")
PY
assert_changed
M2_CODE="$(run_probe m2)"
echo "  probe exit=$M2_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-usage-sensitivity-m2.log" || true)"
record m2 "$RUN_LEG" DETECTED
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
