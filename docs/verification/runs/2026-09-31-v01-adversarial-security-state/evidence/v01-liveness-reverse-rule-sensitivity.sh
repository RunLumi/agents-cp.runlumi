#!/usr/bin/env bash
# ============================================================================================
# Sensitivity proof for the reverse-direction rule in `security::repository_liveness`.
#
# The class check already had an enforced rule for one direction: an entry naming a function that no
# longer EXISTS. It had none for the direction that actually mattered here -- an entry whose function
# is CALLED while its reason still reads as a live justification. Four such entries accumulated the
# hour V01-041 and V01-043 wired the device-denial and plugin-quarantine routes, and nothing said so.
#
# M4  relabel a resolved entry back to `UNTRIAGED` while its function IS called. This is the exact
#     shape the rule exists to catch, and it is how the gap arose in the first place. Expect: DETECTED.
#
# M5  delete the new assertion entirely, restoring the original one-direction check. Expect: MISSED --
#     the mutations are measured against the repaired tree, so the absence of the rule must be
#     invisible to the remaining ones. This is a KNOWN MISSED and it is declared, not dropped: the
#     check cannot detect its own removal, which is the one property no self-contained assertion has.
#
# The mutation is ADDITIVE, not subtractive. In a statically linked language, removing a function's
# only caller almost always fails to compile, so such a mutation measures the compiler rather than the
# check -- and adding an unwired capability is also the historical shape of all four findings in this
# class.
#
# Harness rules: locate the repo with `git rev-parse --show-toplevel` (never `dirname/..`); refuse to
# run on a dirty tree scoped to the files it mutates; snapshot with `cp -p` (a fault must be newer than
# what it replaced) and RESTORE with `cp` + `touch` (an mtime-preserving restore makes cargo skip the
# rebuild and ship the fault -- V01-044); trap on EXIT/INT/TERM/HUP; require a verdict per mutation by
# name; discriminate a compile error from a failed assertion on OUTPUT, since cargo exits 101 for both.
# ============================================================================================
set -uo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO" ] || [ ! -d "$REPO/apps/api" ]; then
  echo "FATAL: could not locate the repository root; run this from inside it" >&2
  exit 2
fi
cd "$REPO"

TARGET="apps/api/src/security/repository_liveness.rs"
SNAP="$(mktemp -d)"
LOG="$(mktemp)"
VERDICTS=()
HEAD_AT_START="$(git rev-parse HEAD)"
MUTATING=0

cleanup() {
  local rc=$?
  if [ "$MUTATING" = "1" ] && [ -f "$SNAP/baseline.rs" ]; then
    cp "$SNAP/baseline.rs" "$TARGET"
    touch "$TARGET"
  fi
  if [ "${#VERDICTS[@]}" -eq 0 ] && [ "$rc" -ne 2 ]; then
    echo "FATAL: no verdict was produced for any mutation -- a run that measured nothing is not a pass" >&2
    rc=1
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_AT_START" ]; then
    echo "FATAL: HEAD moved during the run; a commit has captured the deliberate fault" >&2
    rc=1
  fi
  rm -rf "$SNAP" "$LOG"
  exit $rc
}
trap cleanup EXIT
trap 'echo "interrupted; restoring" >&2; cleanup' INT TERM HUP

git ls-files --error-unmatch "$TARGET" >/dev/null 2>&1 || {
  echo "FATAL: $TARGET is untracked" >&2; exit 2; }
if ! git diff --quiet -- "$TARGET"; then
  echo "FATAL: uncommitted changes in $TARGET. A snapshot taken now would launder that state" >&2
  echo "       into the baseline, and every later comparison would be correct about a wrong" >&2
  echo "       reference." >&2
  exit 2
fi
cp -p "$TARGET" "$SNAP/baseline.rs"

restore() {
  cp "$SNAP/baseline.rs" "$TARGET"
  touch "$TARGET"
  cmp -s "$TARGET" "$SNAP/baseline.rs" || { echo "  FATAL: restore did not match the snapshot" >&2; return 1; }
  echo "  restored (cp + touch, verified with cmp)"
}

run_case() {
  local name="$1" expect="$2" detail="$3"
  echo ""
  echo "=== $name ==="
  MUTATING=1
  cargo test --workspace repository_liveness > "$LOG" 2>&1
  local rc=$?
  # cargo exits 101 for a FAILED ASSERTION and for a COMPILE ERROR alike, and the compile-error
  # pattern `^error:` also matches `error: test failed, to rerun pass ...`. Discriminate on the
  # failed-assertion text, which only the assertion can produce.
  local verdict
  if grep -q "UNTRIAGED although they ARE called" "$LOG"; then
    verdict="DETECTED"
  elif [ "$rc" -eq 101 ] && grep -q "panicked at" "$LOG"; then
    verdict="DETECTED"
  else
    verdict="MISSED"
  fi
  echo "  $detail -> $verdict"
  grep -E "UNTRIAGED although|no longer exist" "$LOG" | head -1 | fold -w 150 | sed 's/^/    /'
  restore || true
  if [ "$verdict" = "$expect" ]; then
    VERDICTS+=("$name $verdict (expected $expect)")
  else
    VERDICTS+=("$name $verdict (EXPECTED $expect) -- DISAGREEMENT")
  fi
  MUTATING=0
}

echo "=== baseline ==="
cargo test --workspace repository_liveness > "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "BASELINE IS NOT GREEN -- refusing to run; a detection against a red sheet proves nothing" >&2
  grep -E "panicked at|UNTRIAGED|no longer exist" "$LOG" | head -4 >&2
  exit 2
fi
if ! grep -q "UNTRIAGED although they ARE called" apps/api/src/security/repository_liveness.rs; then
  echo "BASELINE LACKS the rule under test; refusing to measure" >&2
  exit 2
fi
echo "  green, and the rule under test is present"

# --- M4: a resolved entry relabelled UNTRIAGED while its function IS called ---------------------
python3 - << 'PYEOF'
import pathlib, re
f = pathlib.Path("apps/api/src/security/repository_liveness.rs")
s = f.read_text()
name = "deny_enrollment_statement"
# The whole tuple: opening paren through the reason string's closing quote and paren.
m = re.search(r'\(\s*"' + name + r'",\s*"[^"]*"\s*,?\s*\)', s)
assert m, "the whole deny_enrollment_statement entry was not found -- the mutation cannot run"
s = s[:m.start()] + f'(\\n            "{name}",\\n            "UNTRIAGED",\\n        )'.replace("\\n", "\n") + s[m.end():]
# Assert the name now carries the UNTRIAGED reason and appears exactly once. A regex that matched a
# PREFIX of a multi-line tuple would otherwise leave a second copy behind, the build would still
# compile, and the case would report MISSED for a run that never happened.
assert s.count('"' + name + '"') == 1, "the mutation left a duplicate entry behind"
assert re.search(r'"' + name + r'",\s*\n?\s*"UNTRIAGED"', s), "the relabelling did not apply"
f.write_text(s)
PYEOF
# `cmp` proves the bytes changed, which a mis-anchored edit also satisfies. The python block asserts
# the intended EFFECT; this re-checks it from the outside, so a mutation that rewrote the file without
# applying cannot reach a verdict.
grep -q '"deny_enrollment_statement"' "$TARGET" && \
  { python3 -c "
import re,sys
s=open('$TARGET').read()
sys.exit(0 if re.search(r'"deny_enrollment_statement",\s*
?\s*"UNTRIAGED"', s) else 1)
" || { echo "M4 did not take effect; refusing to report a verdict for a run that did not happen" >&2; exit 1; } }
run_case "M4 (an UNTRIAGED entry whose function IS called)" "DETECTED" "relabelled to UNTRIAGED"

# --- M5: the rule removed ---------------------------------------------------------------------
python3 - << 'PYEOF'
import pathlib
f = pathlib.Path("apps/api/src/security/repository_liveness.rs")
s = f.read_text()
i = s.index("        // The OTHER direction,")
j = s.index("        let reviewed: BTreeSet<&str>", i)
s = s[:i] + s[j:]
# The binding moved down with it; put it back where the original check had it.
if "let called = called_names(&root);" not in s:
    anchor = "        for (name, where_) in &declared {"
    s = s.replace(anchor, "        let called = called_names(&root);\n" + anchor, 1)
f.write_text(s)
PYEOF
cmp -s "$TARGET" "$SNAP/baseline.rs" && { echo "M5 changed nothing" >&2; exit 1; }
# A KNOWN MISSED, declared: no self-contained assertion can detect its own removal.
run_case "M5 (the rule deleted -- KNOWN MISSED by construction)" "MISSED" "assertion removed"

restore
cargo test --workspace repository_liveness > "$LOG" 2>&1
FINAL=$?
FINAL_LINE="$(grep -E 'test result' "$LOG" | head -1 | cut -d' ' -f3)"
echo ""
echo "  restored-tree: exit=$FINAL  $FINAL_LINE passed"
[ "$FINAL" -ne 0 ] && { echo "FATAL: tree is not green after restore" >&2; exit 1; }

echo ""
echo "===================== SENSITIVITY RESULTS ====================="
for v in "${VERDICTS[@]}"; do echo "  $v"; done
echo "  restored-tree baseline green"
echo "==============================================================="
