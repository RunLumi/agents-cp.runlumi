#!/usr/bin/env bash
# Sensitivity proof for `security::guarded_column_writers` (V04-008).
#
# A green new check is an assumption. This proves the check can go red on the two faults it exists to
# catch, and it is written to the discipline this campaign established the hard way:
#
#   * `set -euo pipefail` plus an explicit assertion that each mutation CHANGED the file. A mutation
#     that faults nothing and still reports a verdict is worse than no run at all.
#   * `cp` + `touch`, never `cp -p`. An mtime-preserving restore makes an mtime-based build skip the
#     rebuild and ship the fault while the sheet reads green -- which happened in this campaign.
#   * Traps on EXIT/INT/TERM/HUP that re-raise through `exit`, because `trap ... EXIT` does not fire
#     for SIGTERM and a deliberate fault left compiled in is permanent.
#   * The tree is checked against an INDEPENDENT reference (`git`) before the snapshot and after every
#     restore, scoped to the two files this script touches. The snapshot is the only reference the
#     script itself has, so without git a fault already present at snapshot time is laundered into the
#     baseline and every later compare is faithfully correct about a wrong reference.
#   * HEAD is recorded and re-checked at exit, so a commit during the run cannot capture the fault.
#   * `cargo test` exits 101 for a failing assertion AND for a compile error, so exit code alone
#     reports every detection as a harness failure. The log is scanned for a rustc diagnostic to tell
#     them apart -- otherwise a mutation that does not compile reads as DETECTED.
#   * An empty verdict list is a failure, so this script cannot report success for a run it did not do.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
API="$REPO/apps/api"
CHECK="apps/api/src/security/guarded_column_writers.rs"
VICTIM="apps/api/src/repositories/security.rs"
GUARD="apps/api/src/routes/devices.rs"
SNAP="/Volumes/SSD/v04-logs/gcw-snapshot"
LOG="/Volumes/SSD/v04-logs/v04-008-sensitivity.log"
mkdir -p /Volumes/SSD/v04-logs
: > "$LOG"

SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
VERDICTS=()
log() { printf '%s\n' "$*" | tee -a "$LOG"; }

restore() {
  # `cp` then `touch`: the touch is what stops a mtime-based build from skipping the rebuild.
  cp "$SNAP/check.rs" "$REPO/$CHECK" && touch "$REPO/$CHECK"
  cp "$SNAP/victim.rs" "$REPO/$VICTIM" && touch "$REPO/$VICTIM"
  cp "$SNAP/guard.rs" "$REPO/$GUARD" && touch "$REPO/$GUARD"
  if git -C "$REPO" diff --quiet -- "$CHECK" "$VICTIM" "$GUARD"; then
    log "  restored: both files match HEAD"
  else
    log "  RESTORE FAILED -- a file still differs from HEAD; the verdicts below are void"
    git -C "$REPO" diff --stat -- "$CHECK" "$VICTIM" "$GUARD" | tee -a "$LOG"
  fi
  return 0
}
on_signal() { log "interrupted -- restoring"; restore; trap - EXIT; exit 130; }
trap restore EXIT
trap on_signal INT TERM HUP

# --- precondition: our own files must be clean against an independent reference ---------------
if ! git -C "$REPO" diff --quiet -- "$CHECK" "$VICTIM" "$GUARD"; then
  log "FATAL: $CHECK or $VICTIM has uncommitted changes. A snapshot taken now would launder whatever"
  log "       is already there into the baseline, and every compare below would be correct about a"
  log "       wrong reference. Commit or stash first."
  exit 2
fi
mkdir -p "$SNAP"
cp "$REPO/$CHECK" "$SNAP/check.rs"
cp "$REPO/$VICTIM" "$SNAP/victim.rs"
cp "$REPO/$GUARD" "$SNAP/guard.rs"
log "V04-008 sensitivity -- security::guarded_column_writers"
log "  HEAD at launch : $SNAPSHOT_HEAD"
log "  baseline       : $(cd "$API" && cargo test --lib guarded_column_writers 2>&1 | grep -oE '[0-9]+ passed' | head -1)"

assert_changed() {
  if cmp -s "$1" "$2"; then
    log "  FATAL: the mutation did not change $1 -- the case would report a verdict for a run it"
    log "         did not perform."
    return 1
  fi
  log "  mutation changed the file"
  return 0
}

run_case() {
  local name="$1" file="$2" before="$3"
  log ""
  log "[$name]"
  ( cd "$API" && cargo test --lib guarded_column_writers ) > "/Volumes/SSD/v04-logs/gcw-$name.log" 2>&1 || true
  local out; out="$(sed 's/\x1b\[[0-9;]*m//g' "/Volumes/SSD/v04-logs/gcw-$name.log")"

  # A compile error is not a detection. `cargo test` exits 101 for both, so exit code alone cannot
  # tell them apart -- and `^error:` cannot either, because it matches cargo's OWN summary line
  # `error: test failed, to rerun pass '--lib'`. That is the trap AGENTS.md records from the
  # V01-035 harness, and this script walked straight into it on its first run: both cases reported
  # INVALID having detected nothing but a failing assertion. Match only rustc's coded diagnostics and
  # cargo's compile failures.
  if grep -qE "^error\[E[0-9]+\]|^error: could not compile|^error: aborting" <<< "$out"; then
    VERDICTS+=("INVALID $name -- the build failed, so no verdict was measured")
    log "  INVALID -- rustc diagnostic, not an assertion"
    restore
    return 0
  fi
  if grep -q "test result: FAILED" <<< "$out"; then
    VERDICTS+=("DETECTED $name")
    log "  DETECTED -- $(grep -m1 -A 1 'panicked at' <<< "$out" | tail -1 | cut -c1-150)"
  else
    VERDICTS+=("MISSED $name")
    log "  MISSED -- the check stayed green on a fault it exists to catch"
  fi
  restore
  if cmp -s "$before" "$REPO/$file"; then
    log "  (post-restore: $file is byte-identical to its pre-case state)"
  else
    log "  POST-RESTORE MISMATCH on $file -- later verdicts are suspect"
  fi
}

# --- M1: the lever appears ---------------------------------------------------------------
log ""
log "M1  the guard's table gains a writer -- the V01-045 stale direction"
python3 - "$REPO/$VICTIM" << 'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(
    'pub const FAULT_INSERT: &str =\n    "INSERT INTO org_device_policy_settings (org_id) VALUES (?1)";\n\n'
    + p.read_text()
)
PY
assert_changed "$SNAP/victim.rs" "$REPO/$VICTIM"
run_case "M1-lever-appears" "$VICTIM" "$SNAP/victim.rs"

# --- M2: the guard's own subject is renamed ------------------------------------------------
log ""
log "M2  the guard is renamed in the product -- the record now describes code that is not there"
python3 - "$REPO/$GUARD" << 'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace("latest_min_client_version", "read_device_policy_setting"))
PY
assert_changed "$SNAP/guard.rs" "$REPO/$GUARD"
run_case "M2-guard-renamed" "$GUARD" "$SNAP/guard.rs"

# --- verdict ------------------------------------------------------------------------------
log ""
log "VERDICTS"
for v in "${VERDICTS[@]:-}"; do log "  $v"; done
DETECTED="$(printf '%s\n' "${VERDICTS[@]:-}" | grep -c '^DETECTED' || true)"
INVALID="$(printf '%s\n' "${VERDICTS[@]:-}" | grep -c '^INVALID' || true)"
log "  detected: $DETECTED   invalid: $INVALID   of ${#VERDICTS[@]}"

if [ -z "${VERDICTS[*]:-}" ]; then
  log "  FATAL: no verdicts were recorded -- a harness that reports success for a run it did not"
  log "         perform is the failure this campaign spent the most time on."
  exit 2
fi
if [ "$INVALID" -gt 0 ]; then
  log "  FATAL: a case did not build, so its verdict is not a measurement"
  exit 1
fi
if [ "$DETECTED" -lt 2 ]; then
  log "  FAIL: at least one mutation survived; the check does not detect what it claims to"
  exit 1
fi

if [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then
  log "  WARNING: HEAD MOVED during the run. Every verdict describes a tree that is no longer main."
else
  log "  HEAD unmoved: yes"
fi
if git -C "$REPO" diff --quiet -- "$CHECK" "$VICTIM" "$GUARD"; then
  log "  final tree: clean against HEAD"
else
  log "  final tree: DIRTY -- a deliberate fault may still be in the source"
  exit 1
fi
log ""
log "RESULT: 2/2 detected, exit 0"