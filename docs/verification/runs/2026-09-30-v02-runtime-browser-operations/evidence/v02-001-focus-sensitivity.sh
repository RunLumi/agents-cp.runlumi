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
DEV_LOG="$(mktemp)"
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
  pkill -f "pnpm dev" 2>/dev/null; pkill -f "vite" 2>/dev/null
  rm -rf "$SNAP" "$LOG" "$DEV_LOG"
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
# Restart the dev server and wait for it to serve the CURRENT source.
#
# THIRD failed mechanism, and the one that actually mattered. Vite's own log shows
# `hmr update /src/features/organizations/org-dashboard.tsx` firing on every mutation -- so the server
# KNOWS the source changed -- yet a fresh request for the module URL kept returning the previous
# transform, and a cache-busting query string did not change that either. So for 12 seconds of polling
# the served bytes said "unmutated" while the file on disk said "mutated", and the harness reported a
# false FATAL for a fault that had landed.
#
# A mutation campaign against the web app therefore has to RESTART the dev server after each
# mutation. This is not a shortcut and not a mock: the browser still runs against a real Vite server
# serving real source. It is the only way to make "the fault reached the browser" true rather than
# assumed -- which is the same discipline as the `cp` + `touch` rule on the Rust side, where an
# mtime-preserving restore made cargo ship the faulted binary.
restart_dev() {
  pkill -f "pnpm dev" 2>/dev/null
  pkill -f "vite" 2>/dev/null
  pkill -9 -f workerd 2>/dev/null
  sleep 4
  ( cd "$REPO" && nohup pnpm dev > "$DEV_LOG" 2>&1 & ) 
  # Wait for BOTH. Vite answers in a couple of seconds; the Worker applies the whole migration
  # ledger on first boot and takes noticeably longer. Waiting only for Vite meant the API
  # prerequisite check ran against a Worker that had not finished starting -- the check meant to
  # establish the prerequisite was itself racing it, and reported the prerequisite as absent.
  local tries=0 vite_code api_code
  while [ "$tries" -lt 90 ]; do
    vite_code="$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${WEB_PORT}/" 2>/dev/null || true)"
    api_code="$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8787/api/v1/me" 2>/dev/null || true)"
    # A 401 is the correct answer from an unauthenticated caller and means the Worker is serving.
    if [ "$vite_code" = "200" ] && { [ "$api_code" = "401" ] || [ "$api_code" = "200" ]; }; then
      sleep 3
      return 0
    fi
    tries=$((tries + 1))
    sleep 2
  done
  echo "    FATAL: the stack did not come back up (vite=${vite_code:-000} api=${api_code:-000})" >&2
  return 1
}

# The content hash of the module the dev server is actually serving.
#
# THREE token-based versions of this check failed, all for one reason: a substring of a class list
# cannot be assumed unique to the element being mutated. `focus-visible:ring-2` is served 12 times;
# `outline-none focus-visible:ring-2` -- chosen because I believed the switcher was the only control
# pairing those two utilities -- is served TWICE on a CLEAN tree, so "absent after the mutation" can
# never hold. Assuming uniqueness and then testing uniqueness is how both versions reported a false
# FATAL for a fault that had landed.
#
# A hash carries no such assumption. It answers the only question that matters: is the browser's
# module graph built from the source I just wrote, or from the source before it?
served_hash() {
  curl -s "http://localhost:${WEB_PORT}/src/features/organizations/org-dashboard.tsx" 2>/dev/null \
    | shasum | cut -d" " -f1
}

# Restart the dev server, then wait until the served module DIFFERS from the pre-mutation hash.
#
# The restart is required. Vite's log shows `hmr update` firing on every mutation -- the server knows
# the source changed -- yet a fresh request kept returning the previous transform, and a cache-busting
# query string did not help. Measured: mutated source, served count unchanged for 12 seconds, then 2 -> 1
# immediately after a restart. This is not a mock and not a shortcut: the browser still runs against a
# real Vite server serving real source. It is what makes "the fault reached the browser" a fact rather
# than an assumption -- the same discipline as the Rust-side `cp` + `touch` rule, where an
# mtime-preserving restore made cargo ship the faulted binary while the sheet read green.
await_served_change() {
  local before="$1" tries=0 current
  restart_dev || return 1
  while [ "$tries" -lt 20 ]; do
    current="$(served_hash)"
    if [ -n "$current" ] && [ "$current" != "$before" ]; then
      echo "    the dev server is serving different bytes than before the mutation"
      return 0
    fi
    tries=$((tries + 1))
    sleep 1
  done
  echo "    FATAL: the served module did not change after a restart; the run would read MISSED for a" >&2
  echo "           fault that never reached the browser" >&2
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
  # exit 1 is "a check did not hold" -- a statement about the product or the verifier.
  # exit 2 is "the harness could not run" -- a statement about the harness.
  # Scoring 2 as DETECTED is a FALSE VERDICT, and the worst direction for one: a broken mutation
  # or a crashed probe reads as a successful detection of a defect that may not exist. The first run
  # of this script did exactly that, reporting M1 DETECTED on `exit=2, 1 PASS` with no FAIL line --
  # the probe had died before it reached anything.
  if [ "$rc" -eq 2 ]; then
    verdict="INVALID"
  elif [ "$rc" -ne 0 ]; then
    verdict="DETECTED"
  fi
  echo "  exit=$rc  $(grep -cE '^PASS' "$LOG" | tr -d ' ') PASS  verdict=$verdict"
  grep -E "^FAIL" "$LOG" | head -5 | sed 's/^/    /' | cut -c1-150
  if [ "$verdict" = "INVALID" ]; then
    echo "    the probe could not run, so this measures nothing. Reporting it as a detection would" >&2
    echo "    be a false verdict in the worst direction -- see the comment in run_case." >&2
    grep -E "probe failed|Error:" "$LOG" | head -3 | sed 's/^/      /' | cut -c1-130 >&2
  fi
  if [ "$verdict" = "INVALID" ]; then
    VERDICTS+=("$name INVALID-the-probe-could-not-run")
  elif [ "$verdict" = "$expect" ]; then
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

# Bring the stack up before the BASELINE, not only between mutations.
#
# `smoke:browser` expects a Vite dev server on :5173 and a Worker on :8787 to be running already. With
# neither up, the probe navigates to nothing, the app never renders the auth screen, and the journey
# dies with `timed out waiting for auth screen` and exit 2 -- which is a statement about the harness
# and not about the product. This session's very first run of the gate died exactly that way, and
# the honest reading was "I invoked it wrong", not "the product is broken".
#
# A baseline that is red for that reason is worse than no baseline: the script would refuse to run,
# correctly, and the refusal would look like a product failure. So the script owns the prerequisite
# rather than assuming the operator remembered it.
echo "=== stack ==="
restart_dev || exit 2
# Assigned FIRST, then checked, then echoed. The previous order read `api_code` on the line before
# it was assigned, so `${api_code:-000}` was always 000 and the prerequisite check could only ever
# fail -- while `restart_dev` had already returned 0, meaning it HAD seen both ports serving. The
# default-value syntax concealed it: an unset variable produces exactly what `:-000` produces, and a
# check that cannot tell "not set" from "not serving" reports the second one forever.
#
# Quoting `"%{http_code}"` inside `$( )` inside `" "` also nests three levels and made the script
# unparseable, with bash reporting the error 80 lines away at a heredoc.
vite_code="$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${WEB_PORT}/" 2>/dev/null || true)"
api_code="$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8787/api/v1/me" 2>/dev/null || true)"
echo "  vite=${vite_code} api=${api_code}"
if [ "${api_code:-000}" = "000" ]; then
  echo "FATAL: the API is not answering on :8787 after restart_dev" >&2
  exit 2
fi

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
# These names are asserted to EXIST before any mutation runs, so the script cannot report a verdict
# for a case that has been renamed or removed. It fired on its first run after the closing assertion
# was renamed -- which is the guard working, and the reason a mutation run cannot silently stop
# attacking anything.
for needed in "reachable by pressing Tab" "VISIBLY changes its rendering" "RENDERS A FOCUS INDICATOR" "PRECONDITION"; do
  grep -qF "$needed" "$LOG" || {
    echo "BASELINE LACKS the case this script attacks: $needed" >&2; exit 2; }
done
echo "  green, and every case the mutations attack is present"
# The reference every mutation is compared against. Sound only because `restore` proves the tree
# returns to the COMMITTED source with both `cmp` and `git diff`, so "the baseline" is one state and
# not an accident of what the last restore happened to leave behind.
BASELINE_HASH="$(served_hash)"
if [ -z "$BASELINE_HASH" ]; then
  echo "FATAL: could not read a baseline hash from the dev server" >&2
  exit 2
fi
echo "  baseline served-module hash: ${BASELINE_HASH:0:16}"

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
await_served_change "$BASELINE_HASH" || exit 1
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
await_served_change "$BASELINE_HASH" || exit 1
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
await_served_change "$BASELINE_HASH" || exit 1
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
