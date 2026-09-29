#!/usr/bin/env bash
# verify:path-id-tenancy sensitivity proof -- the substitution gate for the 48 one-path-id routes.
#
# A gate nobody has watched fail is an assumption, and this one is new. It is also the only gate for the
# largest block of unproven routes `smoke:p08` reports, so a silently-passing sheet here would be worse
# than an absent one.
#
#   M1  `REMOVE_MEMBERSHIP_SQL` stops filtering on `org_id`, with `?3` still BOUND
#          -> Org A removing Org B's member succeeds, and the stored-state assertion on B's row sees
#             the row become `removed`.
#   M2  `CHANGE_ROLE_SQL` stops filtering on `org_id`, with `?2` still BOUND
#          -> Org A demoting Org B's member succeeds.
#
# Both keep every placeholder and every bind, so `pnpm schema:bind-count` stays GREEN throughout and the
# mutation takes away only the SCOPING. That is deliberate and it is the point: a mutation the count
# check could see would not be testing a tenancy claim.
#
# Both target routes whose control is asserted at FULL strength. Three service-account/credential
# entries carry a deliberately degraded control and are named as UNPROVEN in the probe; picking those
# would have made the proof pass for a reason that has nothing to do with tenancy.
#
# Harness discipline (the failures this campaign recorded in its own scripts): `set -e` with every build
# checked explicitly; restore in a trap on EXIT **and** INT/TERM/HUP re-raising through `exit`, because a
# trap does not fire on SIGTERM; restore with `cp`, never `mv`, because `mv` preserves the saved mtime and
# the next build is then skipped; `git diff --quiet` on the file being mutated at snapshot time and after
# every restore; assert the mutated file actually CHANGED; record HEAD and verify it has not moved;
# **rebuild after the final restore** so no faulted artifact survives; never `git add -A`; an empty
# verdict list is a failure; probe exit 2 is a HARNESS verdict and never a product one.
#
# Usage:  bash evidence/v01-path-id-sensitivity.sh [--apply]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
ORGS="$ROOT/apps/api/src/repositories/organizations.rs"
PROBE="apps/api/scripts/v01-path-id-tenancy-probe.mjs"
PROBE_ENV="V01_PATHID_PERSIST_TO"
WORK="$ROOT/target/v01-path-id-sensitivity"
ARTIFACT="$ROOT/target/wasm32-unknown-unknown/release/lumi_agents_control_plane_api.wasm"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

SNAP_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
VERDICTS=()

restore() {
  local status=$?
  if [[ -f "$ROOT/target/v01-pathid-orgs.rs.orig" ]]; then
    cp "$ROOT/target/v01-pathid-orgs.rs.orig" "$ORGS"
    rm -f "$ROOT/target/v01-pathid-orgs.rs.orig"
    echo "restored the product"
  fi
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
    echo "HEAD MOVED during this run (was $SNAP_HEAD). A commit made while the harness was mutating has"
    echo "captured a deliberate fault, and every verdict above is VOID until a human undoes it."
    status=1
  fi
  exit "$status"
}
trap restore EXIT INT TERM HUP

assert_clean() {
  if ! git -C "$ROOT" diff --quiet -- "$ORGS"; then
    echo "REFUSING TO START: $ORGS already differs from HEAD."
    echo "An independent reference is the only thing that stops a fault already present when the snapshot"
    echo "is taken from being laundered into the baseline."
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
  env "$PROBE_ENV=$WORK/run-$label" node "$ROOT/$PROBE" >"$WORK/$label.log" 2>&1 || status=$?
  echo "$status" >"$WORK/$label.exit"
  echo "probe exit $status"
}

if [[ $APPLY -eq 0 ]]; then
  echo "dry run; pass --apply to build and drive the broken product"
  exit 0
fi
mkdir -p "$WORK"
echo "baseline HEAD $SNAP_HEAD"

# --- M1 ------------------------------------------------------------------------
cp "$ORGS" "$ROOT/target/v01-pathid-orgs.rs.orig"
BEFORE="$(shasum "$ORGS" | cut -d' ' -f1)"
python3 - "$ORGS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "WHERE membership_id = ?1 AND org_id = ?3 AND status = 'active' AND version = ?4"
new = "WHERE membership_id = ?1 AND status = 'active' AND version = ?4"
assert s.count(old) == 1, "REMOVE_MEMBERSHIP_SQL is not where the mutation expects it"
# ?3 stays BOUND, so the statement is still valid and only the scoping goes.
p.write_text(s.replace(old, new, 1))
print("M1 applied: REMOVE_MEMBERSHIP_SQL no longer filters on org_id")
PY
AFTER="$(shasum "$ORGS" | cut -d' ' -f1)"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "M1: THE FILE DID NOT CHANGE -- the mutation faulted nothing, so there is no verdict"; exit 1
fi
build_fresh
run_probe m1
echo
echo "=== M1: removing another organization's member ==="
grep -E "cases hold" "$WORK/m1.log" | cut -c1-80 || true
grep -E "^  FAIL  (ATTACK|STORED).*members/\{member_id\} DELETE" "$WORK/m1.log" | cut -c1-190 || true
M1_EXIT="$(cat "$WORK/m1.exit")"
if [[ "$M1_EXIT" == "2" ]]; then
  M1_RESULT=invalid
elif grep -qE "^  FAIL  (ATTACK|STORED).*members/\{member_id\} DELETE" "$WORK/m1.log"; then
  echo "M1: DETECTED  (probe exit $M1_EXIT)"; M1_RESULT=detected
else
  echo "M1: NOT DETECTED  (probe exit $M1_EXIT) -- the substitution is not load-bearing"
  M1_RESULT=missed
fi
VERDICTS+=("M1:$M1_RESULT")
cp "$ROOT/target/v01-pathid-orgs.rs.orig" "$ORGS"
rm -f "$ROOT/target/v01-pathid-orgs.rs.orig"
if ! git -C "$ROOT" diff --quiet -- "$ORGS"; then echo "M1: SOURCE STILL DIFFERS FROM HEAD"; exit 1; fi
echo "M1: the source is back to HEAD"
pkill -9 -f workerd 2>/dev/null || true
sleep 2

# --- M2 ------------------------------------------------------------------------
cp "$ORGS" "$ROOT/target/v01-pathid-orgs.rs.orig"
BEFORE="$(shasum "$ORGS" | cut -d' ' -f1)"
python3 - "$ORGS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "WHERE membership_id = ?1 AND org_id = ?2 AND status = 'active' AND version = ?5"
new = "WHERE membership_id = ?1 AND status = 'active' AND version = ?5"
assert s.count(old) == 1, "CHANGE_ROLE_SQL is not where the mutation expects it"
# ?2 stays BOUND: removing the placeholder too would make D1 refuse the statement, and the probe would
# report a 503 rather than a cross-tenant write. A mutation must break the claim, not the statement.
p.write_text(s.replace(old, new, 1))
print("M2 applied: CHANGE_ROLE_SQL no longer filters on org_id")
PY
AFTER="$(shasum "$ORGS" | cut -d' ' -f1)"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "M2: THE FILE DID NOT CHANGE -- the mutation faulted nothing, so there is no verdict"; exit 1
fi
build_fresh
run_probe m2
echo
echo "=== M2: demoting another organization's member ==="
grep -E "cases hold" "$WORK/m2.log" | cut -c1-80 || true
grep -E "^  FAIL  (ATTACK|STORED).*members/\{member_id\} PATCH" "$WORK/m2.log" | cut -c1-190 || true
M2_EXIT="$(cat "$WORK/m2.exit")"
if [[ "$M2_EXIT" == "2" ]]; then
  M2_RESULT=invalid
elif grep -qE "^  FAIL  (ATTACK|STORED).*members/\{member_id\} PATCH" "$WORK/m2.log"; then
  echo "M2: DETECTED  (probe exit $M2_EXIT)"; M2_RESULT=detected
else
  echo "M2: NOT DETECTED  (probe exit $M2_EXIT) -- the substitution is not load-bearing"
  M2_RESULT=missed
fi
VERDICTS+=("M2:$M2_RESULT")
cp "$ROOT/target/v01-pathid-orgs.rs.orig" "$ORGS"
rm -f "$ROOT/target/v01-pathid-orgs.rs.orig"
if ! git -C "$ROOT" diff --quiet -- "$ORGS"; then echo "M2: SOURCE STILL DIFFERS FROM HEAD"; exit 1; fi
echo "M2: the source is back to HEAD"

echo
echo "=== summary ==="
printf '  %s\n' "${VERDICTS[@]}"
if [[ ${#VERDICTS[@]} -eq 0 ]]; then
  echo "NO VERDICTS -- an empty verdict list is a failure, not success"; exit 1
fi
for verdict in "${VERDICTS[@]}"; do
  [[ "$verdict" == *":detected" ]] || { echo "$verdict did not detect its fault"; exit 1; }
done
echo "both mutations detected"
