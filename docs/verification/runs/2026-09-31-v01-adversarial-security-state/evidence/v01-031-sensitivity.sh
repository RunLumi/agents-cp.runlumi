#!/usr/bin/env bash
# V01-031 / GAP-002 sensitivity proof -- the last-owner guards, and the new HTTP-layer attacks.
#
# `f02` FR-F02-005: "An organization MUST have at least one active owner. Removing/demoting the last
# owner MUST fail transactionally." The pure functions were unit-tested and correct; nothing attacked the
# ROUTES until the GAP-002 class was added to `verify:privilege-escalation`. A gate nobody has watched
# fail is an assumption, and these are new cases on a Tier-0 gate.
#
#   M1  `CHANGE_ROLE_SQL`'s guard always passes
#          -> the last owner demotes themselves: 200, and the organization is left with ZERO
#             active owners, read from D1.
#   M2  `REMOVE_MEMBERSHIP_SQL`'s guard always passes
#          -> the last owner is removed: 204, and again zero active owners in D1.
#
# BOTH mutations replace one predicate with `1 = 1` and change no placeholder, so
# `pnpm schema:bind-count` stays GREEN throughout. That is deliberate and is the point: the count check
# is blind to this class, so a mutation here that it could see would not be testing the right thing.
#
# The interesting half of M1 is not the 200. It is `owners after=[]`: the stored-state assertion reports
# that the organization has no active owner at all, which is the invariant FR-F02-005 exists to hold. A
# probe grading on status alone would have seen a 200 and a 204 -- two successful-looking responses -- and
# would have had to reason about whether they were allowed.
#
# Harness discipline (the failures this campaign recorded in its own scripts):
#   * `set -e`, and every build checked explicitly -- a mutation that does not compile is a broken
#     harness, not a product verdict.
#   * restore in a trap on EXIT **and** INT/TERM/HUP, re-raising through `exit`; a trap does not fire on
#     SIGTERM, so a `pkill` would otherwise leave the fault applied.
#   * restore with `cp`, never `mv`: `mv` preserves the saved mtime, the build is skipped, and the next
#     run measures a stale binary against a clean-looking tree.
#   * `git diff --quiet` on the file this script mutates, at snapshot time and after every restore,
#     because the snapshot is the only reference a snapshotting harness has.
#   * assert the mutated file actually CHANGED, so a mutation that faulted nothing reports no verdict.
#   * record HEAD and verify at exit that it has not moved.
#   * **rebuild after the final restore**, so a faulted artifact is never left on disk for the next run.
#     This bit us for real: a sensitivity run finished, restored the source, and left a binary built from
#     the faulted source -- which looks exactly like a repair that did not work.
#   * never `git add -A`, never `git commit` from here; an empty verdict list is a failure; probe exit 2
#     is a HARNESS verdict and never a product one.
#
# Usage:  bash evidence/v01-031-sensitivity.sh [--apply]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
ORGS="$ROOT/apps/api/src/repositories/organizations.rs"
PROBE="apps/api/scripts/v01-privilege-escalation-probe.mjs"
PROBE_ENV="V01_ESC_PERSIST_TO"
WORK="$ROOT/target/v01-031-sensitivity"
ARTIFACT="$ROOT/target/wasm32-unknown-unknown/release/lumi_agents_control_plane_api.wasm"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

SNAP_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
VERDICTS=()

restore() {
  local status=$?
  if [[ -f "$ROOT/target/v01-031-orgs.rs.orig" ]]; then
    cp "$ROOT/target/v01-031-orgs.rs.orig" "$ORGS"
    rm -f "$ROOT/target/v01-031-orgs.rs.orig"
    echo "restored the product"
  fi
  # Rebuild from the RESTORED source, so no faulted artifact survives the run. Without this the next
  # gate measures a binary built from a deliberate fault while the tree reads clean.
  rm -f "$ARTIFACT"
  if cargo build --release --target wasm32-unknown-unknown \
    -p lumi-agents-control-plane-api >"$WORK/final-build.log" 2>&1 && [[ -f "$ARTIFACT" ]]; then
    echo "rebuilt from the restored source: $(ls -l "$ARTIFACT" | awk '{print $6, $7, $8}')"
  else
    echo "FINAL REBUILD FAILED -- see $WORK/final-build.log. A faulted binary may still be on disk."
    status=1
  fi
  if [[ "$(git -C "$ROOT" rev-parse HEAD)" != "$SNAP_HEAD" ]]; then
    echo
    echo "HEAD MOVED during this run (was $SNAP_HEAD). A commit made while the harness was mutating"
    echo "has captured a deliberate fault, and every verdict above is VOID until a human undoes it."
    status=1
  fi
  exit "$status"
}
trap restore EXIT INT TERM HUP

assert_clean() {
  if ! git -C "$ROOT" diff --quiet -- "$ORGS"; then
    echo "REFUSING TO START: $ORGS already differs from HEAD."
    echo "An independent reference is the only thing that stops a fault already present when the"
    echo "snapshot is taken from being laundered into the baseline."
    exit 2
  fi
}
assert_clean

build_fresh() {
  rm -f "$ARTIFACT"
  if ! cargo build --release --target wasm32-unknown-unknown \
    -p lumi-agents-control-plane-api >"$WORK/build.log" 2>&1; then
    echo "BUILD FAILED -- see $WORK/build.log"
    return 1
  fi
  [[ -f "$ARTIFACT" ]] || { echo "BUILD REPORTED SUCCESS BUT PRODUCED NO ARTIFACT"; return 1; }
  echo "built: $(ls -l "$ARTIFACT" | awk '{print $6, $7, $8}')"
}

run_probe() {
  local label="$1"
  pkill -9 -f workerd 2>/dev/null || true
  sleep 5
  rm -rf "$WORK/run-$label"
  local status=0
  env "$PROBE_ENV=$WORK/run-$label" V01_ESC_VERBOSE=1 node "$ROOT/$PROBE" \
    >"$WORK/$label.log" 2>&1 || status=$?
  echo "$status" >"$WORK/$label.exit"
  echo "probe exit $status"
}

if [[ $APPLY -eq 0 ]]; then
  echo "dry run; pass --apply to build and drive the broken product"
  exit 0
fi
mkdir -p "$WORK"
echo "baseline HEAD $SNAP_HEAD"

# --- M1 -----------------------------------------------------------------------
cp "$ORGS" "$ROOT/target/v01-031-orgs.rs.orig"
BEFORE="$(shasum "$ORGS" | cut -d' ' -f1)"
python3 - "$ORGS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "  AND (\n    role <> 'owner'\n    OR ?3 = 'owner'"
new = "  AND (\n    1 = 1\n    OR ?3 = 'owner'"
assert s.count(old) == 1, "CHANGE_ROLE_SQL's guard is not where the mutation expects it"
p.write_text(s.replace(old, new, 1))
print("M1 applied: CHANGE_ROLE_SQL's last-owner guard always passes")
PY
AFTER="$(shasum "$ORGS" | cut -d' ' -f1)"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "M1: THE FILE DID NOT CHANGE -- the mutation faulted nothing, so there is no verdict"
  exit 1
fi
build_fresh
run_probe m1
echo
echo "=== M1: the last owner can now demote themselves ==="
grep -E "cases hold" "$WORK/m1.log" | cut -c1-80 || true
grep -E "^  last-owner" "$WORK/m1.log" | cut -c1-70 || true
grep -E "^  FAIL  (the last owner|the organization still)" "$WORK/m1.log" | cut -c1-140 || true
M1_EXIT="$(cat "$WORK/m1.exit")"
if [[ "$M1_EXIT" == "2" ]]; then
  echo "M1: HARNESS COULD NOT RUN (exit 2) -- this is not a verdict"
  M1_RESULT=invalid
elif grep -qE "^  FAIL  the last owner cannot (demote|leave|remove)" "$WORK/m1.log"; then
  echo "M1: DETECTED  (probe exit $M1_EXIT)"
  M1_RESULT=detected
else
  echo "M1: NOT DETECTED  (probe exit $M1_EXIT) -- the last-owner attacks are not load-bearing"
  M1_RESULT=missed
fi
VERDICTS+=("M1:$M1_RESULT")
cp "$ROOT/target/v01-031-orgs.rs.orig" "$ORGS"
rm -f "$ROOT/target/v01-031-orgs.rs.orig"
if ! git -C "$ROOT" diff --quiet -- "$ORGS"; then
  echo "M1: THE SOURCE STILL DIFFERS FROM HEAD"
  exit 1
fi
echo "M1: the source is back to HEAD"
pkill -9 -f workerd 2>/dev/null || true
sleep 2

# --- M2 -----------------------------------------------------------------------
cp "$ORGS" "$ROOT/target/v01-031-orgs.rs.orig"
BEFORE="$(shasum "$ORGS" | cut -d' ' -f1)"
python3 - "$ORGS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "  AND (\n    role <> 'owner'\n    OR (SELECT COUNT(*) FROM memberships\n        WHERE org_id = ?3"
new = "  AND (\n    1 = 1\n    OR (SELECT COUNT(*) FROM memberships\n        WHERE org_id = ?3"
assert s.count(old) == 1, "REMOVE_MEMBERSHIP_SQL's guard is not where the mutation expects it"
p.write_text(s.replace(old, new, 1))
print("M2 applied: REMOVE_MEMBERSHIP_SQL's last-owner guard always passes")
PY
AFTER="$(shasum "$ORGS" | cut -d' ' -f1)"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "M2: THE FILE DID NOT CHANGE -- the mutation faulted nothing, so there is no verdict"
  exit 1
fi
build_fresh
run_probe m2
echo
echo "=== M2: the last owner can now be removed ==="
grep -E "cases hold" "$WORK/m2.log" | cut -c1-80 || true
grep -E "^  last-owner" "$WORK/m2.log" | cut -c1-70 || true
M2_EXIT="$(cat "$WORK/m2.exit")"
if [[ "$M2_EXIT" == "2" ]]; then
  echo "M2: HARNESS COULD NOT RUN (exit 2) -- this is not a verdict"
  M2_RESULT=invalid
elif grep -qE "^  FAIL  the last owner cannot (demote|leave|remove)" "$WORK/m2.log"; then
  echo "M2: DETECTED  (probe exit $M2_EXIT)"
  M2_RESULT=detected
else
  echo "M2: NOT DETECTED  (probe exit $M2_EXIT) -- the last-owner attacks are not load-bearing"
  M2_RESULT=missed
fi
VERDICTS+=("M2:$M2_RESULT")

echo
echo "=== summary ==="
printf '  %s\n' "${VERDICTS[@]}"
if [[ ${#VERDICTS[@]} -eq 0 ]]; then
  echo "NO VERDICTS -- an empty verdict list is a failure, not success"
  exit 1
fi
for verdict in "${VERDICTS[@]}"; do
  [[ "$verdict" == *":detected" ]] || { echo "$verdict did not detect its fault"; exit 1; }
done
echo "both mutations detected"
