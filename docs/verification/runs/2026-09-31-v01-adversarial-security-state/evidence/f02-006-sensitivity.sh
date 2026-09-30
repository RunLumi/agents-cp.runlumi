#!/usr/bin/env bash
# FR-F02-006 sensitivity proof -- the four requirements of an ownership transfer.
#
# `f02` FR-F02-006: owner transfer requires current owner authorization, an active target member,
# recent re-authentication, and a security/audit event. The new class in
# `v01-privilege-escalation-probe.mjs` attacks each of the four over real HTTP. A gate nobody has
# watched fail is an assumption, and these are new cases on a Tier-0 gate.
#
#   M1  `find_membership_by_id` stops filtering on `org_id`
#          -> a membership belonging to ANOTHER org now resolves. Expected detection is by the
#             NON-DISCLOSURE assertion, not by the refusal: T2a answers 409 where the phantom
#             answers 404, so the two stop being indistinguishable and the route becomes an existence
#             oracle across tenants. This is what a non-disclosure assertion is FOR -- the refusal
#             itself is still a refusal.
#
#   M2  the re-auth requirement is disabled in the handler
#          -> T3, a transfer with no grant, SUCCEEDS. Detected by the status and by the specific
#             `reauthentication_required` reason.
#
#   M4  the handler stops requiring the target to be ACTIVE
#          -> T4, a transfer to a REMOVED member of the same org. Before V01-032 the transfer was still
#             refused, but by the SQL rather than by the handler, and the SQL had already DEMOTED the
#             current owner: the run's own database came back with `active owners: 0`. That is what
#             V01-032 fixed, and after the fix this mutation leaves the owner in place -- so the two
#             layers are now independent and this case detects the handler layer alone.
#
#   M5  `CONSUME_REAUTH_SQL` drops its `expires_at > ?6` predicate, with `?6` still bound
#          -> T5, a transfer carrying a REAL but EXPIRED grant, SUCCEEDS. `?6` is also the value
#             written by `SET consumed_at = ?6`, so the placeholder and the bind count both survive and
#             `schema:bind-count` stays green. That is the only way to test the TTL without changing
#             the statement's shape.
#
#   M3  `TRANSFER_OWNERSHIP_SQL` stops filtering on `org_id`
#          -> **a deliberate KNOWN MISSED, and the finding is the point.** The handler looks the target
#             up with `find_membership_by_id(&org_id, ..)` and returns 404 *before* the UPDATE runs, so
#             a foreign target can never reach the statement. M1 and M2 are both reachable; M3 is
#             defence in depth that no route currently exercises. Reporting it as DETECTED would be
#             false, and reporting it as a gap without naming the statement that carries the claim
#             would be useless to a reviewer.
#
# Every mutation changes no placeholder and removes no bind, so `pnpm schema:bind-count` stays GREEN
# throughout -- deliberately. A mutation the count check could see would not be testing this class.
#
# Harness discipline: `set -e` with every build checked explicitly; restore in a trap on EXIT **and**
# INT/TERM/HUP re-raising through `exit` (a trap does not fire on SIGTERM); restore with `cp`, never
# `mv`, because `mv` preserves the saved mtime and the next build is skipped; `git diff --quiet` on the
# files being mutated at snapshot time and after every restore, because the snapshot is the only
# reference a snapshotting harness has; assert the mutated file actually CHANGED; record HEAD and verify
# it has not moved; **rebuild after the final restore** so no faulted artifact survives; never
# `git add -A`; an empty verdict list is a failure; probe exit 2 is a HARNESS verdict, never a product
# one.
#
# Usage:  bash evidence/f02-006-sensitivity.sh [--apply]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
ORGS="$ROOT/apps/api/src/repositories/organizations.rs"
IDENTITY="$ROOT/apps/api/src/repositories/identity.rs"
ROUTES="$ROOT/apps/api/src/routes/organizations.rs"
PROBE="apps/api/scripts/v01-privilege-escalation-probe.mjs"
PROBE_ENV="V01_ESC_PERSIST_TO"
WORK="$ROOT/target/f02-006-sensitivity"
ARTIFACT="$ROOT/target/wasm32-unknown-unknown/release/lumi_agents_control_plane_api.wasm"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

SNAP_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
VERDICTS=()
KNOWN_MISSED=()

restore() {
  local status=$?
  for pair in "v01-f0206-orgs.rs:$ORGS" "v01-f0206-routes.rs:$ROUTES" "v01-f0206-identity.rs:$IDENTITY"; do
    local snap="$ROOT/target/${pair%%:*}" file="${pair##*:}"
    if [[ -f "$snap" ]]; then
      cp "$snap" "$file"
      rm -f "$snap"
      echo "restored $(basename "$file")"
    fi
  done
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
  if ! git -C "$ROOT" diff --quiet -- "$ORGS" "$ROUTES" "$IDENTITY"; then
    echo "REFUSING TO START: one of the files this script mutates already differs from HEAD."
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

apply() { # label, file, python-heredoc
  cp "$2" "$ROOT/target/v01-f0206-$1.orig"
  BEFORE="$(shasum "$2" | cut -d' ' -f1)"
  python3 - "$2" <<PY
$3
PY
  AFTER="$(shasum "$2" | cut -d' ' -f1)"
  if [[ "$BEFORE" == "$AFTER" ]]; then
    echo "$1: THE FILE DID NOT CHANGE -- the mutation faulted nothing, so there is no verdict"
    exit 1
  fi
}
undo() {
  cp "$ROOT/target/v01-f0206-$1.orig" "$2"
  rm -f "$ROOT/target/v01-f0206-$1.orig"
  if ! git -C "$ROOT" diff --quiet -- "$ORGS" "$ROUTES" "$IDENTITY"; then
    echo "$1: THE SOURCE STILL DIFFERS FROM HEAD"
    exit 1
  fi
  echo "$1: the source is back to HEAD"
  pkill -9 -f workerd 2>/dev/null || true
  sleep 2
}

if [[ $APPLY -eq 0 ]]; then
  echo "dry run; pass --apply to build and drive the broken product"
  exit 0
fi
mkdir -p "$WORK"
echo "baseline HEAD $SNAP_HEAD"

# --- M1 ------------------------------------------------------------------------
apply orgs "$ORGS" '
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "FROM memberships WHERE org_id = ?1 AND membership_id = ?2 LIMIT 1"
new = "FROM memberships WHERE membership_id = ?2 LIMIT 1"
assert s.count(old) == 1, "find_membership_by_id is not where the mutation expects it"
# ?1 stays BOUND and simply stops filtering, so the statement is still valid and only the scoping goes.
p.write_text(s.replace(old, new, 1))
print("M1 applied: find_membership_by_id no longer filters on org_id")
'
build_fresh
run_probe m1
echo
echo "=== M1: a membership from another org now resolves ==="
grep -E "cases hold" "$WORK/m1.log" | cut -c1-80 || true
grep -E "^  ownership-transfer" "$WORK/m1.log" | cut -c1-95 || true
grep -E "^  FAIL  T2a and T2b" "$WORK/m1.log" | cut -c1-190 || true
M1_EXIT="$(cat "$WORK/m1.exit")"
if [[ "$M1_EXIT" == "2" ]]; then
  M1_RESULT=invalid
elif grep -qE "^  FAIL  T2a and T2b" "$WORK/m1.log"; then
  echo "M1: DETECTED  (probe exit $M1_EXIT) -- by the NON-DISCLOSURE assertion, not by the refusal"
  M1_RESULT=detected
else
  echo "M1: NOT DETECTED  (probe exit $M1_EXIT)"
  M1_RESULT=missed
fi
VERDICTS+=("M1:$M1_RESULT")
undo orgs "$ORGS"

# --- M2 ------------------------------------------------------------------------
apply routes "$ROUTES" '
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = """    if !identity
        .consume_reauth("""
new = """    if false && !identity
        .consume_reauth("""
assert s.count(old) == 1, "the re-auth guard is not where the mutation expects it"
p.write_text(s.replace(old, new, 1))
print("M2 applied: the re-auth requirement no longer refuses")
'
build_fresh
run_probe m2
echo
echo "=== M2: a transfer with no re-auth grant ==="
grep -E "cases hold" "$WORK/m2.log" | cut -c1-80 || true
grep -E "^  ownership-transfer" "$WORK/m2.log" | cut -c1-95 || true
M2_EXIT="$(cat "$WORK/m2.exit")"
if [[ "$M2_EXIT" == "2" ]]; then
  M2_RESULT=invalid
elif grep -qE "^  FAIL  T3 an owner cannot transfer ownership" "$WORK/m2.log"; then
  echo "M2: DETECTED  (probe exit $M2_EXIT)"
  M2_RESULT=detected
else
  echo "M2: NOT DETECTED  (probe exit $M2_EXIT)"
  M2_RESULT=missed
fi
VERDICTS+=("M2:$M2_RESULT")
undo routes "$ROUTES"

# --- M3: the deliberate KNOWN MISSED -----------------------------------------
apply orgs "$ORGS" '
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "WHERE org_id = ?2\n  AND status = '\''active'\''\n  AND (membership_id = ?1 OR role = '\''owner'\'')"
new = "WHERE status = '\''active'\''\n  AND (membership_id = ?1 OR role = '\''owner'\'')"
assert s.count(old) == 1, "TRANSFER_OWNERSHIP_SQL is not where the mutation expects it"
p.write_text(s.replace(old, new, 1))
print("M3 applied: the transfer UPDATE no longer filters on org_id")
'
build_fresh
run_probe m3
echo
echo "=== M3: the transfer UPDATE is no longer org-scoped ==="
grep -E "cases hold" "$WORK/m3.log" | cut -c1-80 || true
grep -E "^  ownership-transfer" "$WORK/m3.log" | cut -c1-95 || true
M3_EXIT="$(cat "$WORK/m3.exit")"
if [[ "$M3_EXIT" == "2" ]]; then
  M3_RESULT=invalid
elif grep -qE "^  FAIL" "$WORK/m3.log"; then
  echo "M3: DETECTED  (probe exit $M3_EXIT)"
  M3_RESULT=detected
else
  echo "M3: KNOWN MISSED  (probe exit $M3_EXIT) -- expected, and the finding is which statement carries"
  echo "    the claim. transfer_ownership looks the target up with find_membership_by_id(&org_id, ..) and"
  echo "    returns 404 BEFORE the UPDATE runs, so a foreign target cannot reach TRANSFER_OWNERSHIP_SQL"
  echo "    at all. The statement's org_id predicate is defence in depth with no route exercising it, and"
  echo "    a reviewer should protect it as the only thing standing between a future refactor and a"
  echo "    cross-tenant ownership write."
  M3_RESULT=known-missed
fi
VERDICTS+=("M3:$M3_RESULT")
undo orgs "$ORGS"

# --- M4 ------------------------------------------------------------------------
apply routes "$ROUTES" '
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = """    if target.status != \"active\" {"""
new = """    if false && target.status != \"active\" {"""
assert s.count(old) == 1, "the active-target check is not where the mutation expects it"
p.write_text(s.replace(old, new, 1))
print("M4 applied: the target no longer has to be active")
'
build_fresh
run_probe m4
echo
echo "=== M4: a transfer to a REMOVED member ==="
grep -E "cases hold" "$WORK/m4.log" | cut -c1-80 || true
grep -E "^  ownership-transfer" "$WORK/m4.log" | cut -c1-95 || true
M4_EXIT="$(cat "$WORK/m4.exit")"
if [[ "$M4_EXIT" == "2" ]]; then
  M4_RESULT=invalid
elif grep -qE "^  FAIL  T4 ownership cannot be transferred" "$WORK/m4.log"; then
  echo "M4: DETECTED  (probe exit $M4_EXIT)"
  M4_RESULT=detected
else
  echo "M4: NOT DETECTED  (probe exit $M4_EXIT)"
  M4_RESULT=missed
fi
VERDICTS+=("M4:$M4_RESULT")
undo routes "$ROUTES"

# --- M5 ------------------------------------------------------------------------
apply identity "$ROOT/apps/api/src/repositories/identity.rs" '
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "  AND consumed_at IS NULL\n  AND expires_at > ?6\n"
new = "  AND consumed_at IS NULL\n"
assert s.count(old) == 1, "CONSUME_REAUTH_SQL is not where the mutation expects it"
# ?6 is still bound and still written by SET consumed_at = ?6, so only the TTL predicate goes.
p.write_text(s.replace(old, new, 1))
print("M5 applied: CONSUME_REAUTH_SQL no longer checks the grant expiry")
'
build_fresh
run_probe m5
echo
echo "=== M5: an EXPIRED re-auth grant ==="
grep -E "cases hold" "$WORK/m5.log" | cut -c1-80 || true
grep -E "^  ownership-transfer" "$WORK/m5.log" | cut -c1-95 || true
M5_EXIT="$(cat "$WORK/m5.exit")"
if [[ "$M5_EXIT" == "2" ]]; then
  M5_RESULT=invalid
elif grep -qE "^  FAIL  T5 a REAL grant that has EXPIRED" "$WORK/m5.log"; then
  echo "M5: DETECTED  (probe exit $M5_EXIT)"
  M5_RESULT=detected
else
  echo "M5: NOT DETECTED  (probe exit $M5_EXIT)"
  M5_RESULT=missed
fi
VERDICTS+=("M5:$M5_RESULT")
undo identity "$ROOT/apps/api/src/repositories/identity.rs"

echo
echo "=== summary ==="
printf '  %s\n' "${VERDICTS[@]}"
if [[ ${#VERDICTS[@]} -eq 0 ]]; then
  echo "NO VERDICTS -- an empty verdict list is a failure, not success"
  exit 1
fi
for verdict in "${VERDICTS[@]}"; do
  case "$verdict" in
    *:detected) ;;
    *:known-missed) KNOWN_MISSED+=("$verdict") ;;
    *) echo "$verdict is neither detected nor a declared known-missed"; exit 1 ;;
  esac
done
if [[ ${#KNOWN_MISSED[@]} -gt 0 ]]; then
  printf '  declared known-missed: %s\n' "${KNOWN_MISSED[*]}"
fi
echo "every reachable mutation detected"
