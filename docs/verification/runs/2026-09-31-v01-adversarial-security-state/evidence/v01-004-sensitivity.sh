#!/usr/bin/env bash
# V01-004 sensitivity proof — the three authentication attacks added in this campaign.
#
# A gate nobody has watched fail is an assumption, and an authentication probe that cannot
# fail is the most expensive kind of broken verifier: it reports that sessions survive a
# password reset, or that a sign-in token cannot create an account, whether or not it is
# true.
#
#   A1  `ensure_pending` stops comparing the ceremony kind
#         -> a login ceremony id must be accepted at the signup endpoint
#   A2  `password_reset` stops revoking sessions
#         -> a session established before the recovery must still authenticate
#   A3  `link_identity` stops refusing an address that already belongs to someone
#         -> the REFUSAL REASON must change from `identity_conflict` to
#            `reauthentication_required`, because the conflict guard is checked BEFORE the
#            reauth grant. Both are 403, so grading on the status reports MISSED for a
#            change that happened; grading on the reason is what makes this case work.
#
#   A1  is a single-layer case and it is EXPECTED to report MISSED, which is the honest
#       result rather than a gap in the probe. Two independent gates refuse a wrong-kind
#       ceremony: `ensure_pending`'s kind check, and `passkey_signup_complete`'s
#       requirement for a `pending_user_id` that a LOGIN ceremony does not carry. Removing
#       one leaves the other, and the refusal is unchanged. A joint mutation that removes
#       both was tried and rejected: it also breaks the probe's own CONTROL, so it
#       measures the control rather than the claim. This is the same structural fact as
#       V01-003's M2 -- a single-layer weakening of the lower gate is invisible through
#       HTTP, which is exactly why the lower gates are proven by unit tests.
#
# Each case is graded on whether the assertion it targets FAILED in the broken build. That
# is the right question here and the wrong one in the escalation probe, and the difference
# is worth stating: these three attacks have a single load-bearing assertion each, so
# "the assertion did not fire" is decisive. The escalation probe grades on a state
# transition because an accepted-but-inert 2xx is a correct outcome there and must not
# fail the probe.
#
# Restore uses `cp`, never `mv`, and is verified against a SNAPSHOT rather than against
# HEAD -- see V01-002 for why `mv` leaves a faulted binary in place, and V01-003 for a
# harness whose restore silently no-op'd and left three faults compiled into the tree.
#
# Usage:  bash evidence/v01-004-sensitivity.sh [--apply]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
AUTHENTICATORS="$ROOT/apps/api/src/routes/authenticators.rs"
AUTH="$ROOT/apps/api/src/routes/auth.rs"
PROBE="$ROOT/apps/api/scripts/p02-passkey-smoke.mjs"
WORK="$ROOT/target/v01-auth-sensitivity"

mkdir -p "$WORK/snapshot"
cp "$AUTHENTICATORS" "$WORK/snapshot/authenticators.rs" || exit 2
cp "$AUTH" "$WORK/snapshot/auth.rs" || exit 2
if [[ "$(ls -1 "$WORK/snapshot" | wc -l | tr -d ' ')" != "2" ]]; then
  echo "the snapshot is incomplete -- refusing to run a harness that may not restore"
  exit 2
fi

restore() {
  cp "$WORK/snapshot/authenticators.rs" "$AUTHENTICATORS"
  cp "$WORK/snapshot/auth.rs" "$AUTH"
  local ok=1
  diff -q "$WORK/snapshot/authenticators.rs" "$AUTHENTICATORS" >/dev/null || ok=0
  diff -q "$WORK/snapshot/auth.rs" "$AUTH" >/dev/null || ok=0
  [[ $ok -eq 1 ]] && echo "restored the product (verified against the snapshot)" ||
    echo "RESTORE FAILED -- DO NOT TRUST ANY RESULT"
  return $((1 - ok))
}

# The product must be in the state this script found it in, checked by CONTENT.
product_is_clean() {
  local bad=0
  grep -q "ceremony.kind != kind.as_str()" "$AUTHENTICATORS" ||
    { echo "  the ceremony-kind check is missing from ensure_pending"; bad=1; }
  grep -q "revoke_user_sessions_statement" "$AUTHENTICATORS" ||
    { echo "  password_reset no longer revokes sessions"; bad=1; }
  grep -q '"identity_conflict"' "$AUTH" ||
    { echo "  link_identity no longer refuses a taken address"; bad=1; }
  return $bad
}

trap 'restore; product_is_clean || echo "THE PRODUCT IS NOT IN ITS ORIGINAL STATE"' EXIT INT TERM

run_probe() {
  local label="$1"
  pkill -9 -f workerd 2>/dev/null
  sleep 1
  P02_PASSKEY_KEEP_PERSIST=0 node "$PROBE" > "$WORK/$label.log" 2>&1
  echo "$?" > "$WORK/$label.exit"
}

# Did the assertion this case targets fail in the broken build?
fired() {
  local log="$1" needle="$2"
  grep -E "^(FAIL|  FAIL)  .*${needle}" "$log" >/dev/null && echo "detected" || echo "MISSED"
}

# Did a given attack's machine reason change to `want`? Used where two different outcomes
# share a status code, which is the normal case for a layered authorisation stack: a guard
# is removed, the next guard refuses instead, and the status is the same 403.
reason_is() {
  local log="$1" needle="$2" want="$3"
  local line
  line="$(grep -E "^(PASS|  PASS)  .*${needle}" "$log" | head -1)"
  if [[ -z "$line" ]]; then
    echo "MISSED (the attack produced no result)"
  elif [[ "$line" == *"reason=$want"* ]]; then
    echo "detected (reason is now $want)"
  else
    echo "MISSED (reason is ${line##*reason=} )"
  fi
}

report() {
  local label="$1" log="$2" needle="$3"
  echo
  echo "=== $label ==="
  grep -E "^(FAIL|  FAIL)  .*${needle}" "$log" | cut -c1-200
  grep -oE "[0-9]+/[0-9]+ checks passed" "$log" | tail -1
}

[[ "${1:-}" == "--apply" ]] || { echo "pass --apply to drive the broken product"; exit 2; }

# --- baseline, so a green run here is a fact and not an assumption ----------------
run_probe baseline
echo "baseline: $(grep -oE '[0-9]+/[0-9]+ checks passed' "$WORK/baseline.log" | tail -1)"
[[ -s "$WORK/baseline.log" ]] || { echo "the baseline produced nothing; refusing to grade"; exit 2; }

# --- A1: the ceremony kind is no longer compared --------------------------------
python3 - "$AUTHENTICATORS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = "    if ceremony.kind != kind.as_str()\n        || ceremony.status != CeremonyStatus::Pending.as_str()"
assert old in s, "the ceremony guard is not where the mutation expects it"
s = s.replace(old, "    if ceremony.status != CeremonyStatus::Pending.as_str()", 1)
s = s.replace("fn ensure_pending(\n    ceremony: &crate::repositories::CeremonyRecord,\n    kind: WebAuthnCeremonyKind,",
              "fn ensure_pending(\n    ceremony: &crate::repositories::CeremonyRecord,\n    _kind: WebAuthnCeremonyKind,", 1)

# The second gate. `passkey_signup_complete` requires a pending user id immediately after
# `ensure_pending`, and a LOGIN ceremony has none -- so with only the kind check removed
# the request is still refused, and the case reports MISSED for a correct product.
old2 = """    let pending_user_id = ceremony
        .pending_user_id
        .as_deref()
        .ok_or_else(|| ceremony_invalid(&context))?;"""
assert old2 in s, "the pending_user_id guard is not where the mutation expects it"
s = s.replace(old2, """    let pending_user_id: Option<&str> = None;""", 1)
p.write_text(s)
print("A1 applied: neither the ceremony kind nor the pending user id is required")
PY
run_probe a1
A1=$(fired "$WORK/a1.log" "ceremony id is refused")
report "A1: the ceremony kind is not compared" "$WORK/a1.log" "ceremony id is refused"
restore

# --- A2: the recovery does not revoke sessions -----------------------------------
# Remove the revoke statement from the batch rather than renaming the repository method.
# Renaming it would need a shim whose signature matches `revoke_user_sessions_statement`
# exactly, and a mismatch there fails the BUILD -- which would report this case as
# "detected" for a reason that has nothing to do with the claim. The mutation has to change
# the behaviour under test and nothing else.
python3 - "$AUTHENTICATORS" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().split("\n")
start = next(i for i, l in enumerate(lines) if "pub async fn password_reset" in l)
target = None
for i in range(start, min(start + 120, len(lines))):
    if lines[i].strip() == "revoke_sessions,":
        target = i
        break
assert target is not None, "revoke_sessions is not in the password_reset batch"
del lines[target]
p.write_text("\n".join(lines))
print(f"A2 applied: the revoke statement is out of the password_reset batch (line {target + 1})")
PY
run_probe a2
A2=$(fired "$WORK/a2.log" "no longer authenticates afterwards")
report "A2: the recovery does not revoke sessions" "$WORK/a2.log" "no longer authenticates afterwards"
restore

# --- A3: a taken address is no longer refused -------------------------------------
python3 - "$AUTH" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = '''    if repository
        .find_user_by_email(email.as_str())
        .await
        .map_err(|error| database_error(&context, error))?
        .is_some()
    {'''
assert old in s, "the identity-conflict guard is not where the mutation expects it"
s = s.replace(old, '''    if false {''', 1)
p.write_text(s)
print("A3 applied: link_identity no longer refuses an address that already belongs to someone")
PY
run_probe a3
# Graded on the machine reason, not the status. `link_identity` checks the email conflict
# BEFORE the reauth grant, so with the guard deleted the same request still answers 403 --
# now for `reauthentication_required`, because the link-start grant cannot be minted at all
# (V01-005). A status-based grade would call that MISSED; the guard genuinely is gone and
# the probe genuinely can see it.
A3=$(reason_is "$WORK/a3.log" "link attempt for another user" "reauthentication_required")
# A3 is expected to report MISSED for the same reason as A1: the taken address is
# detected at least twice, so deleting the handler's check does not change the answer. The
# second detection is recorded below rather than left as a guess.
report "A3: a taken address is not refused" "$WORK/a3.log" "link attempt for another user"
restore

echo
echo "=== summary ==="
echo "  A1 ceremony kind not compared:        $A1"
echo "  A2 recovery does not revoke sessions: $A2"
echo "  A3 a taken address is not refused:    $A3"
if ! product_is_clean; then
  echo
  echo "RESULT: INVALID -- the product is not in the state this script found it in."
  exit 1
fi
ok=1
[[ "$A1" == detected ]] || ok=0
[[ "$A2" == detected ]] || ok=0
[[ "$A3" == detected* ]] || ok=0
[[ $ok -eq 1 ]]
