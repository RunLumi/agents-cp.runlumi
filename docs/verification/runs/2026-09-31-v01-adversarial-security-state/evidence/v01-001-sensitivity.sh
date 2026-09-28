#!/usr/bin/env bash
# V01-001 sensitivity proof.
#
# A gate nobody has watched fail is an assumption. This drives the two load-bearing
# assertions of `v01-adoption-privacy-probe.mjs` against a deliberately broken product
# and shows the probe reports each one.
#
#   M1  A1  `external_workspace_ref` stops refusing a filesystem path
#              -> the probe must report a path stored in `external_workspace_key`
#   M2  A2  the `adoption.recorded` audit row carries the client's workspace key
#              -> the probe must report content in the audit trail
#
# Both are reverted by the trap, so a run that is interrupted leaves the tree as it
# found it. Usage:  bash evidence/v01-001-sensitivity.sh [--apply]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
ADOPTION="$ROOT/apps/api/src/modules/migration/adoption.rs"
ROUTES="$ROOT/apps/api/src/routes/migration.rs"
PROBE="apps/api/scripts/v01-adoption-privacy-probe.mjs"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

# Restore with `cp`, never `mv`.
#
# This is the defect V01-001 found in its own verifier, and it is worth stating plainly.
# The first version of this script saved the pristine file with `cp` and put it back
# with `mv`. `mv` preserves the saved copy's mtime -- the mtime from *before* the fault
# was applied -- so after the restore the source looked older than the artifact built
# from it, the build tool declined to rebuild, and the NEXT probe run measured the
# faulted binary while reading source that said otherwise. The adoption privacy probe
# duly reported five payload classes leaked into the audit trail against a tree where
# `git status` was clean, and against a gate whose only failing assertion was one the
# operator had themselves introduced two commands earlier.
#
# `cp` gives the restored file the current time, so the next build happens. The
# harness's `buildFreshness()` now also reports a served Worker that predates its
# source, so a stale artifact cannot be believed again.
restore() {
  [[ -f "$ROOT/target/v01-adoption.rs.orig" ]] &&
    cp "$ROOT/target/v01-adoption.rs.orig" "$ADOPTION"
  [[ -f "$ROOT/target/v01-routes.rs.orig" ]] &&
    cp "$ROOT/target/v01-routes.rs.orig" "$ROUTES"
  rm -f "$ROOT/target/v01-adoption.rs.orig" "$ROOT/target/v01-routes.rs.orig"
  echo "restored the product"
}
trap restore EXIT INT TERM

run_probe() {
  local label="$1"
  pkill -9 -f workerd 2>/dev/null
  sleep 1
  rm -rf "$ROOT/target/v01-sensitivity"
  V01_PERSIST_TO="$ROOT/target/v01-sensitivity" \
    node "$ROOT/$PROBE" > "$ROOT/target/v01-sensitivity-$label.log" 2>&1
  echo "$?" > "$ROOT/target/v01-sensitivity-$label.exit"
}

# --- M1 -----------------------------------------------------------------------
M1_BEFORE=$(cat "$ADOPTION" | wc -l | tr -d ' ')
cp "$ADOPTION" "$ROOT/target/v01-adoption.rs.orig"
python3 - "$ADOPTION" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().split("\n")
# The two separator lines are the only occurrences of these two predicates in the
# module, so removing them is unambiguous. Matching on indentation was the first
# attempt and it asserted on a four-space prefix the file does not use.
targets = [i for i, l in enumerate(lines) if "workspace.contains(" in l]
assert len(targets) == 2, f"expected 2 separator checks, found {len(targets)}"
for i in reversed(targets):
    del lines[i]
p.write_text("\n".join(lines))
print("M1 applied: external_workspace_ref no longer refuses a path")
PY

if [[ $APPLY -eq 0 ]]; then
  echo "dry run; pass --apply to build and drive the broken product"
  exit 0
fi

run_probe m1
M1_EXIT=$(cat "$ROOT/target/v01-sensitivity-m1.exit")
echo
echo "=== M1: the path refusal removed ==="
grep -E "^  (PASS|FAIL)  a filesystem path sent as workspace_key" \
  "$ROOT/target/v01-sensitivity-m1.log" | cut -c1-200
if grep -qE "^  FAIL  a filesystem path sent as workspace_key" "$ROOT/target/v01-sensitivity-m1.log"; then
  echo "M1: DETECTED  (probe exit $M1_EXIT)"
  M1_RESULT=detected
else
  echo "M1: NOT DETECTED  (probe exit $M1_EXIT) -- the assertion is not load-bearing"
  M1_RESULT=missed
fi
restore

# Prove the restore actually took, in the two ways that matter: the source is back, and
# the next run will rebuild it. Without this the script reports "restored" and leaves a
# faulted binary in place for whatever runs next.
if git -C "$ROOT" diff --quiet -- "$ADOPTION" "$ROUTES"; then
  echo "M1: the source is back to HEAD"
  M1_RESTORE=clean
else
  echo "M1: THE SOURCE STILL DIFFERS FROM HEAD"
  M1_RESTORE=dirty
fi
pkill -9 -f workerd 2>/dev/null
sleep 1

# --- M2 -----------------------------------------------------------------------
cp "$ROUTES" "$ROOT/target/v01-routes.rs.orig"
python3 - "$ROUTES" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = """            "client_protocol_major": fingerprint.protocol_major,
            "project_id": body.project_id,"""
assert old in s, "the audit metadata block is not where the mutation expects it"
s = s.replace(old, """            "client_protocol_major": fingerprint.protocol_major,
            "project_id": body.project_id,
            "workspace_key": body.workspace_key,""", 1)
p.write_text(s)
print("M2 applied: the audit row now carries the client's workspace key")
PY

run_probe m2
M2_EXIT=$(cat "$ROOT/target/v01-sensitivity-m2.exit")
echo
echo "=== M2: the audit row carries the workspace key ==="
grep -E "^  (PASS|FAIL)  no payload class reaches the security_events" \
  "$ROOT/target/v01-sensitivity-m2.log" | cut -c1-240
if grep -qE "^  FAIL  no payload class reaches the security_events" "$ROOT/target/v01-sensitivity-m2.log"; then
  echo "M2: DETECTED  (probe exit $M2_EXIT)"
  M2_RESULT=detected
else
  echo "M2: NOT DETECTED  (probe exit $M2_EXIT) -- the assertion is not load-bearing"
  M2_RESULT=missed
fi

echo
echo "=== summary ==="
echo "  M1 path refusal removed:        $M1_RESULT (source after restore: $M1_RESTORE)"
echo "  M2 audit carries workspace key: $M2_RESULT"
[[ "$M1_RESULT" == detected && "$M2_RESULT" == detected && "$M1_RESTORE" == clean ]] && exit 0
exit 1
