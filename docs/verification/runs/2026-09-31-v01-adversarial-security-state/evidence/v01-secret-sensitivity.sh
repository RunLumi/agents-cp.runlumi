#!/usr/bin/env bash
# V01 secret-tenancy sensitivity proof.
#
# `verify:secret-tenancy` is a Tier-0 gate: it is the only thing standing between this
# repository and a claim that webhook secrets cannot cross a tenant boundary. It was
# red until V01-030 was repaired (its positive control answered 503), and it is now
# 32/32 -- which means, as of this commit, nobody has watched it fail.
#
#   M1  `WebhookEndpointRecord.enabled` goes back to a plain `bool`
#          -> the owner's own rotate answers 503, the positive control goes red,
#             and the probe exits 1. This is the defect the gate exists beside, and
#             the proof that the CONTROL is load-bearing rather than decorative.
#
#   M2  `ENDPOINT_BY_ID_SQL` stops filtering on `org_id`
#          -> a foreign endpoint resolves, the cross-tenant rows go red.
#
# M2 is the more interesting of the two, and it could not have been written before the
# repair. While the control was red, every attack row passed *vacuously*: a foreign
# endpoint produced no row, so nothing was decoded and nothing leaked, for the same
# reason the owner's own request 503'd. A gate in that state cannot tell "refused a
# foreign resource" from "refuses everybody", so it could not demonstrate that it
# detects a tenancy fault. M1 fixes the reason; M2 then proves the detection.
#
# Harness discipline, from the failures this campaign recorded in its own scripts:
#
#   * `set -e`, and every build checked explicitly. A mutation that does not compile
#     must abort, not be graded.
#   * restore in a trap on EXIT **and** INT/TERM/HUP, re-raising through `exit`, because
#     a trap does not fire on SIGTERM and a `pkill` would otherwise leave the fault
#     applied.
#   * restore with `cp`, never `mv`: `mv` preserves the saved copy's mtime, the build is
#     skipped, and the next run measures a stale binary against a clean-looking tree.
#   * `git diff --quiet` on the files this script will mutate, at snapshot time and after
#     every restore. The snapshot is the only reference a snapshotting harness has, so a
#     fault already present when the snapshot is taken is laundered into the baseline.
#   * assert the mutated file actually CHANGED, so a mutation that faulted nothing
#     cannot report a verdict.
#   * record HEAD and verify at exit that it has not moved: a commit made while the
#     harness is mutating captures the fault and voids every verdict in the run.
#   * never `git add -A` and never `git commit` from here.
#   * an empty verdict list is a failure, and probe exit 2 is a HARNESS verdict, never
#     a product one.
#
# Usage:  bash evidence/v01-secret-sensitivity.sh [--apply]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
WEBHOOKS="$ROOT/apps/api/src/repositories/webhooks.rs"
PROBE="apps/api/scripts/v01-secret-tenancy-probe.mjs"
PROBE_ENV="V01_SECRET_PERSIST_TO"
WORK="$ROOT/target/v01-secret-sensitivity"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

SNAP_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
VERDICTS=()

restore() {
  local status=$?
  if [[ -f "$ROOT/target/v01-secret-webhooks.rs.orig" ]]; then
    cp "$ROOT/target/v01-secret-webhooks.rs.orig" "$WEBHOOKS"
    rm -f "$ROOT/target/v01-secret-webhooks.rs.orig"
    echo "restored the product"
  fi
  # A commit during a mutation run has captured the fault. Verdicts are void until a
  # human undoes it, so say so rather than reporting success.
  if [[ "$(git -C "$ROOT" rev-parse HEAD)" != "$SNAP_HEAD" ]]; then
    echo
    echo "HEAD MOVED during this run (was $SNAP_HEAD). A commit made while the harness was"
    echo "mutating has captured a deliberate fault, and every verdict above is VOID."
    status=1
  fi
  exit "$status"
}
trap restore EXIT INT TERM HUP

# The reference is git, not the snapshot. Scoped to this script's own file, because
# unrelated uncommitted work is not a finding.
assert_clean() {
  if ! git -C "$ROOT" diff --quiet -- "$WEBHOOKS"; then
    echo "REFUSING TO START: $WEBHOOKS already differs from HEAD."
    echo "An independent reference is the only thing that stops a fault already present when"
    echo "the snapshot is taken from being laundered into the baseline."
    exit 2
  fi
}
assert_clean

build_fresh() {
  rm -f "$ROOT/target/wasm32-unknown-unknown/release/lumi_agents_control_plane_api.wasm"
  if ! cargo build --release --target wasm32-unknown-unknown \
    -p lumi-agents-control-plane-api >"$WORK/build.log" 2>&1; then
    echo "BUILD FAILED -- see $WORK/build.log"
    echo "A mutation that does not compile is a broken harness, not a product verdict."
    return 1
  fi
  local artifact="$ROOT/target/wasm32-unknown-unknown/release/lumi_agents_control_plane_api.wasm"
  if [[ ! -f "$artifact" ]]; then
    echo "BUILD REPORTED SUCCESS BUT PRODUCED NO ARTIFACT"
    return 1
  fi
  echo "built: $(ls -l "$artifact" | awk '{print $6, $7, $8}')"
}

run_probe() {
  local label="$1"
  pkill -9 -f workerd 2>/dev/null || true
  sleep 5
  rm -rf "$WORK/run-$label"
  local status=0
  env "$PROBE_ENV=$WORK/run-$label" node "$ROOT/$PROBE" \
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
cp "$WEBHOOKS" "$ROOT/target/v01-secret-webhooks.rs.orig"
M1_BEFORE="$(shasum "$WEBHOOKS" | cut -d' ' -f1)"
python3 - "$WEBHOOKS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().split("\n")
start = next(i for i, l in enumerate(lines) if l.startswith("pub struct WebhookEndpointRecord "))
end = next(i for i in range(start, len(lines)) if lines[i] == "}")
removed = [i for i in range(start, end) if "sql_bool::deserialize" in lines[i]]
assert removed, "V01-030's annotation is not where the mutation expects it"
for i in reversed(removed):
    del lines[i]
p.write_text("\n".join(lines))
print(f"M1 applied: removed {len(removed)} annotation(s) from WebhookEndpointRecord")
PY
M1_AFTER="$(shasum "$WEBHOOKS" | cut -d' ' -f1)"
if [[ "$M1_BEFORE" == "$M1_AFTER" ]]; then
  echo "M1: THE FILE DID NOT CHANGE -- the mutation faulted nothing, so there is no verdict"
  exit 1
fi
build_fresh
run_probe m1
echo
echo "=== M1: the INTEGER column decoded as a plain bool again ==="
grep -E "cases hold|^  console capture" "$WORK/m1.log" | cut -c1-160 || true
grep -E "^  FAIL  CONTROL" "$WORK/m1.log" | cut -c1-200 || true
M1_EXIT="$(cat "$WORK/m1.exit")"
if [[ "$M1_EXIT" == "2" ]]; then
  echo "M1: HARNESS COULD NOT RUN (exit 2) -- this is not a verdict"
  M1_RESULT=invalid
elif grep -qE "^  FAIL  CONTROL: Alpha rotating HER OWN" "$WORK/m1.log"; then
  echo "M1: DETECTED  (probe exit $M1_EXIT) -- the positive control caught it"
  M1_RESULT=detected
else
  echo "M1: NOT DETECTED  (probe exit $M1_EXIT) -- the control is not load-bearing"
  M1_RESULT=missed
fi
VERDICTS+=("M1:$M1_RESULT")
cp "$ROOT/target/v01-secret-webhooks.rs.orig" "$WEBHOOKS"
rm -f "$ROOT/target/v01-secret-webhooks.rs.orig"
if ! git -C "$ROOT" diff --quiet -- "$WEBHOOKS"; then
  echo "M1: THE SOURCE STILL DIFFERS FROM HEAD"
  exit 1
fi
echo "M1: the source is back to HEAD"
pkill -9 -f workerd 2>/dev/null || true
sleep 2

# --- M2 -----------------------------------------------------------------------
cp "$WEBHOOKS" "$ROOT/target/v01-secret-webhooks.rs.orig"
M2_BEFORE="$(shasum "$WEBHOOKS" | cut -d' ' -f1)"
python3 - "$WEBHOOKS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "WHERE org_id = ?1 AND endpoint_id = ?2\nLIMIT 1"
new = "WHERE endpoint_id = ?2\nLIMIT 1"
assert s.count(old) == 1, "ENDPOINT_BY_ID_SQL is not where the mutation expects it"
# ?1 stays BOUND and is simply no longer filtered on, so the statement is still valid and
# only the scoping goes. Dropping the placeholder instead would make D1 refuse the
# statement, and the probe would report a 503 rather than a leak -- a fault that
# breaks the statement instead of the claim.
p.write_text(s.replace(old, new, 1))
print("M2 applied: the endpoint lookup no longer filters on org_id")
PY
M2_AFTER="$(shasum "$WEBHOOKS" | cut -d' ' -f1)"
if [[ "$M2_BEFORE" == "$M2_AFTER" ]]; then
  echo "M2: THE FILE DID NOT CHANGE -- the mutation faulted nothing, so there is no verdict"
  exit 1
fi
build_fresh
run_probe m2
echo
echo "=== M2: the endpoint lookup stopped being org-scoped ==="
grep -E "cases hold" "$WORK/m2.log" | cut -c1-160 || true
grep -E "^  FAIL" "$WORK/m2.log" | head -4 | cut -c1-200 || true
M2_EXIT="$(cat "$WORK/m2.exit")"
if [[ "$M2_EXIT" == "2" ]]; then
  echo "M2: HARNESS COULD NOT RUN (exit 2) -- this is not a verdict"
  M2_RESULT=invalid
elif grep -qE "^  FAIL" "$WORK/m2.log"; then
  echo "M2: DETECTED  (probe exit $M2_EXIT)"
  M2_RESULT=detected
else
  echo "M2: NOT DETECTED  (probe exit $M2_EXIT) -- the cross-tenant rows are not load-bearing"
  M2_RESULT=missed
fi
VERDICTS+=("M2:$M2_RESULT")

echo
echo "=== summary ==="
printf '  %s\n' "${VERDICTS[@]}"
if [[ ${#VERDICTS[@]} -eq 0 ]]; then
  echo "NO VERDICTS -- treating an empty verdict list as failure, not success"
  exit 1
fi
for verdict in "${VERDICTS[@]}"; do
  [[ "$verdict" == *":detected" ]] || { echo "$verdict did not detect its fault"; exit 1; }
done
echo "both mutations detected"
