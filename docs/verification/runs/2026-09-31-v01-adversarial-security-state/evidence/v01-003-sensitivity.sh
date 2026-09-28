#!/usr/bin/env bash
# V01-003 sensitivity proof — client privilege escalation.
#
# A gate nobody has watched fail is an assumption, and this family is where a gate that
# cannot fail is most dangerous: an escalation probe reporting "refused" because it never
# engaged, or because it graded a 404 as a refusal, would keep reporting that the
# authorization boundary holds while the boundary is the thing under test.
#
# HOW A CASE IS GRADED, AND WHY IT IS NOT "did the escalation assertion fire"
#
# The first version graded each case on one hand-picked assertion, and two of four cases
# read MISSED. Neither miss was a broken probe:
#
#   M1  removing `Owner` from `role_can_be_invited` does NOT escalate, because
#       `invitations` carries its own `role IN ('admin','member','viewer')` CHECK. The
#       request travels one layer further than it should and the database stops it.
#   M2  letting a `Member` act in `can_change_role` does NOT escalate, because a plain
#       member is refused by `authorize_org(Permission::MembersManage)` before the domain
#       function is called. Defence in depth, working.
#
# Both are the product behaving correctly one layer below where the probe was looking. A
# case graded on a single assertion therefore reports MISSED for a change that really
# happened, and a case graded on "anything failed" would report DETECTED for a change that
# is invisible.
#
# So each case declares the attack it targets, and is graded on whether THAT attack's
# observed behaviour changed against the unmutated baseline. The baseline is measured, not
# assumed: `--baseline` prints the clean run's per-attack table and the script diffs
# against it. V01_ESC_VERBOSE=1 is what makes the table exist.
#
#   M1  `role_can_be_invited` allows `owner`      -> the admin's invite-as-owner moves
#                                                      off its clean status
#   M2  BOTH layers of the role check weakened     -> the member's self-promotion
#                                                      succeeds. Both halves are needed:
#                                                      weakening either alone is invisible
#                                                      through HTTP, which is the two-layer
#                                                      structure working. The domain rules
#                                                      are therefore proven by unit tests,
#                                                      where a single weakening IS visible.
#   M3  budget PATCH downgrades to BudgetsRead    -> the budget attack ESCALATES, read
#                                                      back from D1
#   M4  `change_role` authorizes on the target's CURRENT role again -- the V01-003
#       defect verbatim                             -> the admin self-promotion ESCALATES
#
# Restore uses `cp`, never `mv`: see V01-002, where `mv` preserved the pre-fault mtime, the
# build was skipped, and the next run measured the faulted binary against a clean tree.
# The restore is verified against a SNAPSHOT taken here, not against HEAD -- the repair for
# V01-003 is itself an uncommitted change, so "differs from HEAD" cannot distinguish
# "restore failed" from "the repair is present".
#
# Usage:  bash evidence/v01-003-sensitivity.sh --baseline
#         bash evidence/v01-003-sensitivity.sh --apply
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
MEMBERSHIPS="$ROOT/apps/api/src/modules/memberships.rs"
ORGANIZATIONS="$ROOT/apps/api/src/routes/organizations.rs"
BUDGETS="$ROOT/apps/api/src/routes/budgets.rs"
PROBE="$ROOT/apps/api/scripts/v01-privilege-escalation-probe.mjs"
WORK="$ROOT/target/v01-esc-sensitivity"

mkdir -p "$WORK"
SNAP="$WORK/snapshot"
mkdir -p "$SNAP"
# The files this script may change, snapshotted before anything is touched.
for f in "$MEMBERSHIPS" "$ORGANIZATIONS" "$BUDGETS"; do
  cp "$f" "$SNAP/$(basename "$f")" || { echo "could not snapshot $f -- refusing to run"; exit 2; }
done
# Three files, three snapshots. A short count is how the previous version lost them.
if [[ "$(ls -1 "$SNAP" | wc -l | tr -d ' ')" != "3" ]]; then
  echo "the snapshot is incomplete -- refusing to run a harness that may not restore"
  exit 2
fi

RESTORE_OK=1

restore() {
  local ok=1
  for f in "$MEMBERSHIPS" "$ORGANIZATIONS" "$BUDGETS"; do cp "$SNAP/$(basename "$f")" "$f"; done
  for f in "$MEMBERSHIPS" "$ORGANIZATIONS" "$BUDGETS"; do
    diff -q "$SNAP/$(basename "$f")" "$f" >/dev/null || ok=0
  done
  if [[ $ok -eq 1 ]]; then
    echo "restored the product (verified against the snapshot, not against HEAD)"
    RESTORE_OK=1
  else
    echo "RESTORE FAILED -- a file still differs from the snapshot; DO NOT TRUST ANY RESULT"
    RESTORE_OK=0
  fi
}

# The invariant this whole script exists to protect, checked by CONTENT rather than by
# file comparison. An earlier version of this harness snapshotted into a directory it
# never created, so every restore was a no-op, three deliberate faults stayed compiled
# into the tree, and a later run measured that tree and produced a baseline nobody
# questioned. `buildFreshness()` said the artifact matched the source, which it did --
# the source was simply wrong, and a build-freshness check cannot tell you that.
#
# So: fail the run if the product is not in the state it was found in, and say so in
# terms a person will act on.
product_is_clean() {
  local bad=0
  grep -q "MembershipRole::Owner" <(sed -n '/pub fn role_can_be_invited/,/^}/p' "$MEMBERSHIPS") \
    && { echo "  role_can_be_invited still allows owner"; bad=1; }
  grep -q "The role being REQUESTED" "$ORGANIZATIONS" \
    || { echo "  the V01-003 repair comment is missing from change_role"; bad=1; }
  grep -q "Permission::BudgetsManage" "$BUDGETS" \
    || { echo "  the budget PATCH no longer requires BudgetsManage"; bad=1; }
  return $bad
}

trap 'restore; product_is_clean || echo "THE PRODUCT IS NOT IN ITS ORIGINAL STATE"' EXIT INT TERM

run_probe() {
  local label="$1"
  pkill -9 -f workerd 2>/dev/null
  sleep 1
  rm -rf "$WORK/$label"
  V01_ESC_VERBOSE=1 V01_ESC_PERSIST_TO="$WORK/$label" \
    node "$PROBE" > "$WORK/$label.log" 2>&1
  echo "$?" > "$WORK/$label.exit"
}

# Pull "status grade attack" for one attack out of a verbose run.
attack_status() {
  local log="$1" needle="$2"
  grep -E "^  [a-z-]+ +[0-9]+ +[A-Z_]+ +.*${needle}" "$log" |
    head -1 | awk '{print $2 " " $3}'
}

# Grade a case: did the targeted attack behave differently from the baseline?
graded() {
  local log="$1" needle="$2" baseline="$3"
  local now was
  now="$(attack_status "$log" "$needle")"
  was="$(attack_status "$baseline" "$needle")"
  if [[ -z "$now" ]]; then
    echo "NO-TARGET"
    return
  fi
  if [[ "$now" == "$was" ]]; then
    echo "MISSED (still '$now')"
  else
    echo "detected ('$was' -> '$now')"
  fi
}

report() {
  local label="$1" log="$2"
  echo
  echo "=== $label ==="
  grep -E "^  (PASS|FAIL)  no client-supplied field is honoured" "$log" | cut -c1-240
  sed -n '/privilege-escalation attacks/,$p' "$log" | head -3
}

if [[ "${1:-}" == "--baseline" ]]; then
  run_probe baseline
  echo "baseline: $WORK/baseline.log"
  sed -n '/class          status/,$p' "$WORK/baseline.log" | head -25
  exit 0
fi

[[ "${1:-}" == "--apply" ]] || { echo "pass --baseline or --apply"; exit 2; }

# The baseline is measured in this same invocation, so a change to the probe cannot
# silently invalidate a previously recorded expectation.
run_probe baseline
BASELINE="$WORK/baseline.log"
echo "baseline recorded; grading every case against it"
[[ -s "$BASELINE" ]] || { echo "the baseline run produced nothing; refusing to grade"; exit 2; }

# --- M1: an owner becomes invitable -------------------------------------------
python3 - "$MEMBERSHIPS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "        MembershipRole::Admin | MembershipRole::Member | MembershipRole::Viewer"
assert old in s, "the invitable-role list is not where the mutation expects it"
s = s.replace(old, "        MembershipRole::Owner | MembershipRole::Admin | MembershipRole::Member | MembershipRole::Viewer", 1)
p.write_text(s)
print("M1 applied: role_can_be_invited now allows owner")
PY
run_probe m1
M1=$(graded "$WORK/m1.log" "an admin invites a new member as owner" "$BASELINE")
report "M1: role_can_be_invited allows owner" "$WORK/m1.log"
restore

# --- M2: the route's own permission is weakened --------------------------------
python3 - "$ORGANIZATIONS" "$MEMBERSHIPS" <<'PY'
import pathlib, sys
org, mem = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

lines = org.read_text().split("\n")
start = next(i for i, l in enumerate(lines) if "pub async fn change_role" in l)
for i in range(start, min(start + 40, len(lines))):
    if "Permission::MembersManage" in lines[i]:
        lines[i] = lines[i].replace("Permission::MembersManage", "Permission::MembersRead")
        print(f"M2 applied: change_role now requires MembersRead (organizations.rs:{i + 1})")
        break
else:
    raise SystemExit("no MembersManage in change_role")
org.write_text("\n".join(lines))

s = mem.read_text()
old = "        && matches!(actor_role, MembershipRole::Owner | MembershipRole::Admin)"
assert old in s, "the actor-role clause is not where the mutation expects it"
s = s.replace(
    old,
    "        && matches!(\n            actor_role,\n            MembershipRole::Owner\n                | MembershipRole::Admin\n                | MembershipRole::Member\n        )",
    1,
)
print("M2 applied: can_change_role now also accepts a Member actor")
mem.write_text(s)
PY
run_probe m2
# Graded on the self-promotion to `admin`, not to `owner`. Widening the actor clause and
# weakening the route still cannot produce an owner, because the V01-003 repair added a
# third layer -- `requested_role != Owner` -- that refuses it independently. That is the
# repair working, and it means `owner` is the wrong attack to grade this case on: it
# measures a layer the mutation does not touch.
M2=$(graded "$WORK/m2.log" "a member promotes itself to admin" "$BASELINE")
report "M2: both authorization layers weakened" "$WORK/m2.log"
restore

# --- M3: the budget PATCH downgrades ------------------------------------------
python3 - "$BUDGETS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().split("\n")
start = next(i for i, l in enumerate(lines) if "pub async fn patch_budget" in l)
for i in range(start, min(start + 40, len(lines))):
    if "Permission::BudgetsManage" in lines[i]:
        lines[i] = lines[i].replace("Permission::BudgetsManage", "Permission::BudgetsRead")
        print(f"M3 applied: the budget PATCH now requires BudgetsRead (line {i + 1})")
        break
else:
    raise SystemExit("no BudgetsManage in the patch route")
p.write_text("\n".join(lines))
PY
run_probe m3
M3=$(graded "$WORK/m3.log" "raises the organization budget" "$BASELINE")
report "M3: the budget PATCH only requires read" "$WORK/m3.log"
restore

# --- M4: the V01-003 defect, verbatim -----------------------------------------
python3 - "$ORGANIZATIONS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = """        // The role being REQUESTED, not the one the target already has. Passing the
        // current role here is what let an admin promote anyone -- including itself --
        // to owner: the decision never saw the value being written. See V01-003.
        role,"""
assert old in s, "the V01-003 repair comment is not where the mutation expects it"
s = s.replace(old, """        crate::modules::authorization::MembershipRole::parse(&target.role)
            .unwrap_or(crate::modules::authorization::MembershipRole::Viewer),""", 1)
p.write_text(s)
print("M4 applied: change_role authorizes against the target's CURRENT role again")
PY
run_probe m4
M4=$(graded "$WORK/m4.log" "an admin promotes itself to owner" "$BASELINE")
report "M4: change_role ignores the requested role (the V01-003 defect)" "$WORK/m4.log"
restore

echo
echo "=== summary ==="
echo "  M1 owner invitable:                 $M1"
echo "  M2 both role-check layers weakened:   $M2"
echo "  M3 budget PATCH needs only read:     $M3"
echo "  M4 requested role ignored (V01-003): $M4"
restore
if ! product_is_clean; then
  echo
  echo "RESULT: INVALID -- the product is not in the state this script found it in, so"
  echo "        none of the grades above describe the product under review."
  exit 1
fi
ok=1
for r in "$M1" "$M2" "$M3" "$M4"; do [[ "$r" == detected* ]] || ok=0; done
[[ $ok -eq 1 ]]
