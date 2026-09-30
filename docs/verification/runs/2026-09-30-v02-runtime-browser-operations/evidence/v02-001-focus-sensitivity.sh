#!/usr/bin/env bash
# ============================================================================================
# Sensitivity proof for V02-001 -- the repaired visible-focus assertion in `smoke:browser`.
#
# THE CLAIM: "focusing the switcher visibly changes its rendering" is a real assertion, not a
# tautology. The check it replaced was satisfied by any control with a box-shadow, and would have
# passed with the focus ring deleted from the source. A repaired check that cannot itself fail
# would be the same defect wearing new code, so it has to be watched to fail.
#
# M1  delete the focus ring from the switcher. The source carries
#       `outline-none focus-visible:ring-2 focus-visible:ring-[var(--...)] focus-visible:ring-offset-…`
#       and removing the ring utilities must make BOTH delta cases fail:
#         - "focusing the switcher VISIBLY changes its rendering"
#         - "the ring is not merely PRESENT but CHANGED"
#       Expect: DETECTED. If M1 does not go red, the repair is a tautology and the finding stands
#       with a different subject.
#
# M2  the control direction. Restore the ring, then remove `outline-none` ONLY, so the control
#       keeps its ring. Expect: still PASS -- and this is a declared KNOWN MISSED rather than a
#       shortfall, because the delta cannot see a change that does not change anything. It is
#       declared because it establishes the boundary of what the repair can detect: the assertion
#       proves focus is *visibly different*, not that it is *correct*.
#
# M3  the V02-001 defect verbatim. Reinstate the OLD assertion --
#       `(boxShadow && boxShadow !== "none") || (outline && !outline.startsWith("none"))`
#       -- and expect it to be SATISFIED BY A CONTROL WITH NO FOCUS RING, which is the whole
#       finding. The probe must report this case green while the ring is deleted. Expect: the old
#       assertion passes where the new one fails, which is the finding reproduced in one run.
#
# HAZARDS THIS SCRIPT RESPECTS, each learned in this campaign:
#   * the file is snapshotted with `cp -p` and restored with `cp` + `touch`. An mtime-preserving
#     restore makes an mtime-based build skip the rebuild and ship the fault -- V01-044, which
#     reported a green sheet over a 30-minute self-inflicted run. Vite HMR is mtime-sensitive too.
#   * the dev server is already running, so the "stale build" hazard is real rather than
#     theoretical: after mutating, this script WAITS for the rebuild by confirming the served
#     module content changed, instead of sleeping a fixed interval. A mutation that never reached
#     the browser would be reported as MISSED, which is the worst direction for a false verdict.
#   * the tree must be clean for the files it mutates, or the snapshot launders uncommitted work
#     into the baseline.
#   * traps cover EXIT/INT/TERM/HUP and re-raise through `exit`.
#   * a verdict is required per case BY NAME, and an empty verdict list is a failure.
#   * gates are never run concurrently or back-to-back; a held CDP port produces a false exit 2.
# ============================================================================================
set -uo pipefail

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../../../../.." rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO" ] || [ ! -d "$REPO/apps/web" ]; then
  echo "FATAL: could not locate the repository root; run this from inside it" >&2
  exit 2
fi
cd "$REPO"

TARGET="apps/web/src/features/organizations/org-dashboard.tsx"
PROBE="apps/web/scripts/browser-probe.mjs"
WEB_PORT=5173
SNAP="$(mktemp -d)"
LOG="$(mktemp)"
VERDICTS=()
HEAD_AT_START="$(git rev-parse HEAD)"
MUTATING=0

cleanup() {
  local rc=$?
  if [ "$MUTATING" = "1" ]; then
    cp "$SNAP/org-dashboard.tsx" "$TARGET"; touch "$TARGET"
    cp "$SNAP/browser-probe.mjs" "$PROBE"; touch "$PROBE"
  fi
  if [ "${#VERDICTS[@]}" -eq 0 ] && [ "$rc" -ne 2 ]; then
    echo "FATAL: no verdict was produced for any mutation -- a run that measured nothing is not a pass" >&2
    rc=1
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_AT_START" ]; then
    echo "FATAL: HEAD moved during the run; a commit has captured the deliberate fault" >&2
    rc=1
  fi
  pkill -9 -f "Google Chrome for Testing" 2>/dev/null
  rm -rf "$SNAP" "$LOG"
  exit $rc
}
trap cleanup EXIT
trap 'echo "interrupted; restoring" >&2; cleanup' INT TERM HUP

for f in "$TARGET" "$PROBE"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || {
    echo "FATAL: $f is untracked; a snapshot cannot restore what git cannot see" >&2; exit 2; }
  if ! git diff --quiet -- "$f"; then
    echo "FATAL: uncommitted changes in $f. A snapshot taken now would launder that state into" >&2
    echo "       the baseline, and every later comparison would be correct about a wrong reference." >&2
    exit 2
  fi
done

[ -f "$SNAP" ] || mkdir -p "$SNAP"
cp -p "$TARGET" "$SNAP/org-dashboard.tsx"
cp -p "$PROBE" "$SNAP/browser-probe.mjs"

restore() {
  cp "$SNAP/org-dashboard.tsx" "$TARGET"; touch "$TARGET"
  cp "$SNAP/browser-probe.mjs" "$PROBE"; touch "$PROBE"
  # Two independent references, because one is not enough. `cmp` against the snapshot proves the copy
  # happened; `git diff --quiet` proves the result is the COMMITTED source, which is the only
  # reference that cannot itself have been laundered. The first version of this script checked
  # neither and left the tree with a deliberate fault applied, while still printing verdicts.
  cmp -s "$TARGET" "$SNAP/org-dashboard.tsx" \
    || { echo "  FATAL: restore did not match the snapshot (tsx)" >&2; return 1; }
  cmp -s "$PROBE" "$SNAP/browser-probe.mjs" \
    || { echo "  FATAL: restore did not match the snapshot (probe)" >&2; return 1; }
  git diff --quiet -- "$TARGET" "$PROBE" \
    || { echo "  FATAL: the tree is not clean after restore -- a deliberate fault is still applied" >&2; return 1; }
  echo "  restored (cp + touch; cmp against the snapshot AND git diff both clean)"
}

# Confirm the dev server is SERVING the mutated module before running the browser against it.
#
# This is the hazard V01-044 taught, one layer up: a mutation that never reaches the browser is
# indistinguishable from a mutation the browser ignored, and both read MISSED. Rather than sleep a
# fixed interval and hope, this polls the served source and requires it to change.
# Wait for the dev server to STOP serving the token, which is the property the mutation changes.
#
# TWO versions of this marker were wrong, and both failed for the same reason -- it could not
# distinguish the mutated element from the eleven other controls that legitimately keep a focus ring.
#
#   1. `org-switcher` is present in the module in BOTH states, so it could only ever prove the
#      module was served, never that the fault had reached the browser.
#   2. `focus-visible:ring-2` is served TWELVE times -- the other controls keep their rings, so an
#      ABSENCE check on it can never succeed, and the helper ran to exhaustion again.
#
# The marker must be unique to the MUTATED ELEMENT. The switcher is the only control that pairs
# `outline-none` with `focus-visible:ring-2` adjacently, so that adjacency is present before the
# mutation and absent after it, and no other control can satisfy or defeat the check.
await_served_change_absent() {
  local marker="$1" tries=0
  while [ "$tries" -lt 40 ]; do
    # NOT `| grep -q`. Under `set -o pipefail`, `grep -q` exits on its first match, curl then takes
    # SIGPIPE and exits 141, and pipefail reports that as the PIPELINE's status -- so the test failed
    # on a module that contained the marker on every one of 40 attempts. `grep -c` reads the whole
    # stream, curl finishes normally, and the comparison happens in the shell.
    local served_count
    served_count="$(curl -s "http://localhost:${WEB_PORT}/src/features/organizations/org-dashboard.tsx" 2>/dev/null \
      | grep -c "$marker" || true)"
    if [ "${served_count:-0}" -eq 0 ]; then
      echo "    the dev server has stopped serving '$marker' -- the fault reached the browser"
      return 0
    fi
    tries=$((tries + 1))
    sleep 1
  done
  echo "    FATAL: the dev server never dropped '$marker'; the run would read MISSED for a fault" >&2
  echo "           that never reached the browser" >&2
  return 1
}

run_case() {
  local name="$1" expect="$2"
  echo ""
  echo "=== $name ==="
  MUTATING=1
  pkill -9 -f "Google Chrome for Testing" 2>/dev/null
  sleep 4
  pnpm smoke:browser > "$LOG" 2>&1
  local rc=$?
  local verdict="MISSED"
  [ "$rc" -ne 0 ] && verdict="DETECTED"
  echo "  exit=$rc  $(grep -cE '^PASS' "$LOG" | tr -d ' ') PASS"
  grep -E "^FAIL" "$LOG" | head -5 | sed 's/^/    /' | cut -c1-150
  if [ "$verdict" = "$expect" ]; then
    VERDICTS+=("$name $verdict (expected $expect)")
  else
    VERDICTS+=("$name $verdict (EXPECTED $expect) -- DISAGREEMENT")
  fi
  # Restore BEFORE clearing the flag, or the next case inherits this one's fault. Without this, M2
  # ran against M1's ringless source and measured "no ring and no outline" while claiming to measure
  # "ring intact" -- a harness that reports a verdict for a run it did not perform, which is the
  # defect this campaign has now hit in three different harnesses.
  restore || true
  MUTATING=0
}

echo "=== baseline ==="
pkill -9 -f "Google Chrome for Testing" 2>/dev/null
sleep 4
pnpm smoke:browser > "$LOG" 2>&1
BASE_RC=$?
echo "  baseline: exit=$BASE_RC  $(grep -cE '^PASS' "$LOG" | tr -d ' ') PASS"
if [ "$BASE_RC" -ne 0 ]; then
  echo "BASELINE IS NOT GREEN -- refusing to run; a detection against a red sheet proves nothing" >&2
  grep -E "^FAIL" "$LOG" | head -6 >&2
  exit 2
fi
for needed in "reachable by pressing Tab" "VISIBLY changes its rendering" "ring is not merely PRESENT"; do
  grep -qF "$needed" "$LOG" || {
    echo "BASELINE LACKS the case this script attacks: $needed" >&2; exit 2; }
done
echo "  green, and every case the mutations attack is present"

# --- M1: delete the focus ring from the switcher -------------------------------------------------
python3 - <<'MUTATE_M1'
import pathlib, re
p = pathlib.Path("apps/web/src/features/organizations/org-dashboard.tsx")
s = p.read_text()
# The switcher's own className carries the ring utilities. Remove them from THAT element only --
# every other control keeps its ring, so a red sheet cannot be explained by the app losing focus
# styling everywhere.
start = s.index('id="org-switcher"')
tail = s[start:start + 1200]
mutated = re.sub(r"focus-visible:ring[^\s\"]*", "", tail)
mutated = re.sub(r"focus-visible:ring-offset[^\s\"]*", "", mutated)
assert mutated != tail, "no focus-visible:ring utility was found on the switcher"
p.write_text(s[:start] + mutated + s[start + 1200:])
print("    the switcher's focus ring is removed")
MUTATE_M1
cmp -s "$TARGET" "$SNAP/org-dashboard.tsx" && { echo "M1 changed nothing" >&2; exit 1; }
await_served_change_absent "outline-none focus-visible:ring-2" || exit 1
run_case "M1 (the focus ring deleted from the switcher)" "DETECTED"

# --- M2: the control direction -- ring present, outline-neutered only ----------------------------
python3 - <<'MUTATE_M2'
import pathlib
p = pathlib.Path("apps/web/src/features/organizations/org-dashboard.tsx")
s = p.read_text()
start = s.index('id="org-switcher"')
tail = s[start:start + 1200]
assert "outline-none" in tail, "the switcher no longer declares outline-none"
p.write_text(s[:start] + tail.replace("outline-none", "", 1) + s[start + 1200:])
print("    outline-none is removed; the ring stays")
MUTATE_M2
cmp -s "$TARGET" "$SNAP/org-dashboard.tsx" && { echo "M2 changed nothing" >&2; exit 1; }
run_case "M2 (outline-neutered, ring intact -- KNOWN MISSED by construction)" "MISSED"

# --- M3: the V02-001 defect verbatim, on a control with no ring ---------------------------------
echo ""
echo "=== M3 (the ORIGINAL assertion, reinstated while the ring is still deleted) ==="
MUTATING=1
python3 - <<'MUTATE_M3A'
import pathlib, re
p = pathlib.Path("apps/web/src/features/organizations/org-dashboard.tsx")
s = p.read_text()
start = s.index('id="org-switcher"')
tail = s[start:start + 1200]
# The SAME mutation as M1, by construction rather than by a hand-listed token set. The first
# version of this block named `focus-visible:ring-[var(--focus)]` and `ring-offset-white`, neither of
# which the switcher carries -- its real className is
# `outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]` -- so it removed the ring
# WIDTH and left the ring colour, meaning M3 would have measured a still-visible ring and reported
# the finding as unreproduced. A hand-listed token set is a guess about the source; a regex over
# the element's own className is not.
mutated = re.sub(r"focus-visible:ring[^\s\"]*", "", tail)
assert mutated != tail, "no focus-visible:ring utility was found on the switcher"
p.write_text(s[:start] + mutated + s[start + 1200:])
print("    the ring is removed again, by the same mutation as M1")
MUTATE_M3A
python3 - <<'MUTATE_M3B'
import pathlib
p = pathlib.Path("apps/web/scripts/browser-probe.mjs")
s = p.read_text()
anchor = '  check(\n    "the ring is not merely PRESENT but CHANGED'
assert s.count(anchor) == 1, "the V02-001 regression case was not found"
# Reinsert the pre-V02-001 assertion verbatim, next to the repaired one, so the same run reports
# both verdicts on the same control. This is the finding reproduced rather than described.
old_assertion = '''  const legacyFocusAssertion =
    (focusProbe.boxShadow && focusProbe.boxShadow !== "none") ||
    (focusAfter?.outline && !focusAfter.outline.startsWith("none"));
  check(
    "M3 CONTROL: the PRE-V02-001 assertion, reinstated verbatim, still PASSES with the focus " +
      "ring deleted from the source -- which is the whole finding in one assertion",
    legacyFocusAssertion === true,
    `legacy=${legacyFocusAssertion} boxShadow=${JSON.stringify(focusAfter?.boxShadow)}`,
  );
'''
s = s[:s.index(anchor)] + old_assertion + s[s.index(anchor):]
p.write_text(s)
print("    the pre-V02-001 assertion is reinstated beside the repaired one")
MUTATE_M3B
await_served_change_absent "outline-none focus-visible:ring-2" || exit 1
pkill -9 -f "Google Chrome for Testing" 2>/dev/null
sleep 4
pnpm smoke:browser > "$LOG" 2>&1
M3_RC=$?
echo "  exit=$M3_RC  $(grep -cE '^PASS' "$LOG" | tr -d ' ') PASS"
echo "  --- the finding, reproduced: both verdicts on a control with NO focus ring ---"
grep -E "M3 CONTROL|VISIBLY changes|ring is not merely" "$LOG" | cut -c1-160 | sed 's/^/    /'
MUTATING=0
if grep -q "M3 CONTROL" "$LOG" && grep "M3 CONTROL" "$LOG" | grep -q "^PASS"; then
  VERDICTS+=("M3 (the old assertion passes where the new one fails -- the finding reproduced) DETECTED")
else
  VERDICTS+=("M3 DISAGREEMENT -- the legacy assertion did not pass with the ring deleted")
fi

restore
pkill -9 -f "Google Chrome for Testing" 2>/dev/null
sleep 4
pnpm smoke:browser > "$LOG" 2>&1
FINAL_RC=$?
echo ""
echo "  restored-tree: exit=$FINAL_RC  $(grep -cE '^PASS' "$LOG" | tr -d ' ') PASS"
[ "$FINAL_RC" -ne 0 ] && { echo "FATAL: the tree is not green after restore" >&2; exit 1; }

echo ""
echo "======================== SENSITIVITY RESULTS ========================"
for v in "${VERDICTS[@]}"; do echo "  $v"; done
echo "  $(grep -cE '^PASS' "$LOG" | tr -d ' ') PASS  restored-tree baseline (exit 0)"
echo "==================================================================="
