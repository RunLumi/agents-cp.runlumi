#!/usr/bin/env bash
# ============================================================================================
# V02-004 sensitivity -- prove `pnpm verify:observability` can FAIL.
#
# A gate nobody has watched fail is an assumption, and this campaign has now found that
# assumption wrong five separate times. Worse, the failure mode of a correlation gate is the
# most dangerous kind: every assertion is an ABSENCE ("this id is not in that record", "this
# canary is not in that row"), and a gate made entirely of absences passes on a product that
# records nothing at all.
#
# THE MUTATION
#
#   apps/api/src/routes/support.rs -- the `security_events` INSERT binds the wrong value into
#   the `request_id` slot. It binds `received_at`, the line two below, instead of the request
#   id: a copy-paste between two adjacent binds.
#
#   Two properties make this the right fault to inject rather than an easy one:
#
#     * the BIND COUNT is unchanged, so `pnpm schema:bind-count` stays green. That check is
#       blind to this whole class, which is the point: a mutation it could see would not be
#       testing the right thing.
#
#     * binding `correlation_id` instead would have been a WEAK mutation, because for this
#       request `correlation_id == request_id`. The log line shows them equal, so a probe
#       that searched on `request_id OR correlation_id` -- which is exactly what the outbox leg
#       does -- would still have found the row and reported a MISSED. A mutation chosen
#       because it is easy to apply is often a mutation that changes nothing.
#
# WHAT MUST HAPPEN
#
#   The security-event leg must FAIL. The row still EXISTS -- this is not a missing-write
#   fault -- so a gate that counted rows rather than following the id would be unaffected.
#
# HARNESS DISCIPLINE, each rule earned in this campaign at cost
#
#   * `cp` for the snapshot and restore, never `cp -p`: an mtime-preserving restore makes an
#     mtime-based build SKIP the rebuild and ship the faulted binary while the sheet reads green
#     (V01-044). This is the single most expensive mistake available here.
#   * `git diff --quiet` on the mutated file BEFORE snapshotting. A snapshot taken with
#     uncommitted work already in it launders that work into the baseline, and every later
#     restore is then faithfully correct about a wrong reference. Three sensitivity runs each
#     printed "restored both source files" while the mutation survived.
#   * HEAD is recorded at snapshot time and re-checked at exit. A commit made while this script
#     is mutating captures the fault permanently, and `git checkout --` then restores the FAULT.
#   * Traps on EXIT, INT, TERM and HUP, each re-raising through `exit`. `trap ... EXIT` does not
#     fire for SIGTERM, and a `pkill` left every deliberate fault applied in a previous round.
#   * An empty verdict list is a FAILURE. A harness must not be able to report a verdict for a
#     run it did not perform.
#   * Build failure is INVALID, never a detection: `cargo` exits 101 for a failing assertion as
#     well as for a compile error, so the rustc diagnostic is what discriminates them. A broken
#     build that reads as DETECTED is the worst possible direction for a false verdict.
#   * exit 2 from the probe is INVALID, never a detection -- that is the harness saying it could
#     not run, not the product saying it failed.
# ============================================================================================

set -uo pipefail

# FIVE levels up, not four. The script lives at docs/verification/runs/<run>/evidence/, so
# `../../../..` resolves to `docs/` and every path below -- the snapshot, the mutated file, the
# build log -- would have been wrong while the script still reported a run. A path error that
# produces a plausible-looking failure is worse than one that produces an error.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
TARGET="apps/api/src/routes/support.rs"
SNAP="$(mktemp -d)/support.rs"
DEV_LOG="/tmp/v02-004-sensitivity-dev.log"
ORIGINAL='                BindValue::Text(context.request_id.as_str()),'
FAULTED='                BindValue::Text(context.received_at.as_str()),'

SNAPSHOT_HEAD=""
FAULT_MARK=""
RESTORED=0
VERDICTS=()

log() { printf '%s\n' "$*"; }

# ------------------------------------------------------------------------------------------
# Restore. `cp` + `touch`, verified against TWO independent references.
# ------------------------------------------------------------------------------------------
restore() {
  [ "$RESTORED" = "1" ] && return 0
  RESTORED=1
  if [ ! -f "$SNAP" ]; then
    log "  FATAL: the snapshot is missing, so the restore is a no-op and the fault would stay compiled in"
    return 1
  fi
  cp "$SNAP" "$REPO/$TARGET"
  touch "$REPO/$TARGET"
  if ! cmp -s "$SNAP" "$REPO/$TARGET"; then
    log "  FATAL: restore did not match the snapshot"
    return 1
  fi
  if ! git -C "$REPO" diff --quiet -- "$TARGET"; then
    log "  FATAL: the tree is NOT clean for $TARGET after restore -- a deliberate fault is still in it"
    git -C "$REPO" diff -- "$TARGET" | head -20
    return 1
  fi
  if [ -n "$SNAPSHOT_HEAD" ] && [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then
    log "  FATAL: HEAD MOVED during the run (${SNAPSHOT_HEAD} -> $(git -C "$REPO" rev-parse --short HEAD))."
    log "         A commit during a mutation run captures the fault permanently and every verdict"
    log "         below is void until a human undoes it."
    return 1
  fi
  log "  restored (cp + touch; cmp against the snapshot AND git diff both clean; HEAD unmoved)"
  return 0
}

# Restoring the SOURCE is not the same as restoring the WORLD.
#
# `wrangler dev` keeps serving the binary it built, so a script that restores the file and exits
# leaves `pnpm dev` answering from faulted code -- and every later gate in the session silently
# inherits a mutated product. That is the V01-046 shape: a restored file and a live fault quietly
# disagreeing, with nothing in the output to say so. So the exit path rebuilds from the restored
# source and waits for the Worker to answer again.
cleanup() {
  restore || true
  if [ "${RESTORED:-0}" = "1" ] && [ "${STACK_RESTARTED_AFTER_RESTORE:-0}" != "1" ]; then
    STACK_RESTARTED_AFTER_RESTORE=1
    log ""
    log "  restoring the running Worker to the un-mutated source (the file was already restored;"
    log "  without this, \`pnpm dev\` keeps serving a binary built from the fault)"
    settle_worker
    restart_stack && log "  the Worker is back on the restored source" \
      || log "  WARNING: could not restart the stack -- run \`pnpm dev\` by hand before trusting"
    log "               any later result from this checkout"
  fi
}

on_signal() {
  cleanup
  # Re-raise through `exit`, so the EXIT trap is not the only thing standing between a signal and
  # a compiled-in fault.
  trap - EXIT
  exit 130
}
STACK_RESTARTED_AFTER_RESTORE=0
trap cleanup EXIT
trap on_signal INT TERM HUP

# ------------------------------------------------------------------------------------------
# Prerequisite: the file must be tracked, committed and clean, or the snapshot is worthless.
# ------------------------------------------------------------------------------------------
if [ ! -f "$REPO/$TARGET" ]; then
  log "FATAL: $TARGET does not exist"
  exit 2
fi
if ! git -C "$REPO" ls-files --error-unmatch "$TARGET" >/dev/null 2>&1; then
  log "FATAL: $TARGET is untracked; a snapshot cannot restore what git cannot see"
  exit 2
fi
if ! git -C "$REPO" diff --quiet -- "$TARGET"; then
  log "FATAL: uncommitted changes in $TARGET. A snapshot taken now would launder that state"
  log "       into the baseline, and every later restore would be correct about a wrong reference."
  exit 2
fi
SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
mkdir -p "$(dirname "$SNAP")"
cp "$REPO/$TARGET" "$SNAP"
log "  snapshot taken at $(git -C "$REPO" rev-parse --short HEAD)"

# ------------------------------------------------------------------------------------------
# The stack must be up BEFORE anything is mutated. A prerequisite check that runs after the
# fault is a prerequisite check racing the thing it depends on.
# ------------------------------------------------------------------------------------------
api_code="$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/api/v1/me 2>/dev/null)"
if [ "$api_code" != "401" ] && [ "$api_code" != "200" ]; then
  log "FATAL: the Worker is not serving on :8787 (got ${api_code:-000}). Start \`pnpm dev\` first."
  exit 2
fi
log "  prerequisite: Worker serving (401 is correct for an unauthenticated caller)"

# ------------------------------------------------------------------------------------------
# Restart the whole dev stack. Defined after `cleanup` references it, which is safe because the trap
# body only runs at exit -- shell resolves the name when the body executes, not when it is defined.
# ------------------------------------------------------------------------------------------
# Restart the whole dev stack. Wrangler rebuilds the Worker, and a restart is required rather
# than trusted: the V02-001 harness measured a dev server that logged the source change and
# kept serving the previous transform for 12 seconds.
# ------------------------------------------------------------------------------------------
restart_stack() {
  pkill -f "pnpm dev" 2>/dev/null
  pkill -f "wrangler dev" 2>/dev/null
  pkill -f "vite" 2>/dev/null
  pkill -9 -f workerd 2>/dev/null
  sleep 4
  ( cd "$REPO" && nohup pnpm dev > "$DEV_LOG" 2>&1 & )
  local tries=0 code
  while [ "$tries" -lt 120 ]; do
    code="$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/api/v1/me 2>/dev/null)"
    if [ "$code" = "401" ] || [ "$code" = "200" ]; then
      sleep 3
      return 0
    fi
    tries=$((tries + 1))
    sleep 2
  done
  log "  FATAL: the stack did not come back up (api=${code:-000})"
  return 1
}

# Wait until workerd is GONE before touching anything. A live miniflare recreates the persist
# directory it was using, which produces exit-2 flakes that read as detections.
settle_worker() {
  local tries=0
  while pgrep -f workerd >/dev/null 2>&1 && [ "$tries" -lt 60 ]; do
    tries=$((tries + 1))
    sleep 1
  done
  sleep 2
}

# ------------------------------------------------------------------------------------------
# Did the fault REACH the Worker? A mutation that never reached the served artefact reads MISSED,
# and MISSED is indistinguishable from "this gate cannot detect the fault" -- which is the one
# conclusion a sensitivity run exists to be able to draw.
#
# The first version of this script ran `wrangler deploy --dry-run` as a separate build step and
# called that verification. It proved the source COMPILES, which is a different question from
# whether the binary `wrangler dev` is SERVING was rebuilt after the fault. Asserting on the
# served artefact's own mtime is the non-circular answer: it can only be newer than the mutation if
# the build that produced it read the faulted source.
#
# A rustc diagnostic in the dev log is the INVALID discriminator. It matters that this greps for the
# DIAGNOSTIC and not for the exit code: cargo exits 101 for a failing assertion as well as for a
# compile error, and `^error:` also matches cargo's own "error: test failed" line.
# ------------------------------------------------------------------------------------------
# The artefact is `apps/api/build/index_bg.wasm`, and the FIRST version looked under
# `apps/api/.wrangler/tmp` instead. That directory is a leftover cache, not the build output: it held
# several hundred `dev-*` directories whose newest entry was NINE HOURS older than the run, while
# `apps/api/build/index_bg.wasm` carried the current minute. The dev log says plainly
# `Running: worker-build --release`, and that is what writes `build/`.
#
# Worth recording HOW this failed: the check did not report MISSED, it reported INVALID, because it
# is written to refuse when it cannot prove the fault arrived. A guard that had been written as
# "assume the restart rebuilt it" would have reported MISSED for a fault that never reached the
# Worker, and a MISSED is indistinguishable from "this gate cannot detect the class". So the guard
# caught its own wrong assumption, which is the only reason the run cost minutes rather than being
# filed as evidence.
served_wasm_newer_than_fault() {
  local since="$1"
  local artefact="$REPO/apps/api/build/index_bg.wasm"
  if [ ! -f "$artefact" ]; then
    log "    INVALID: $artefact does not exist, so the served artefact cannot be checked at all."
    log "             The Worker may well have been rebuilt from the fault, but this run cannot"
    log "             prove it, and an unprovable arrival is not an arrival."
    return 1
  fi
  if [ ! "$artefact" -nt "$since" ]; then
    log "    INVALID: $artefact is NOT newer than the fault ($(ls -la "$artefact" | awk '{print $6, $7, $8}')"
    log "             vs the fault), so the Worker is serving a binary built from the PRE-mutation"
    log "             source. A probe run now would read MISSED for a fault that never arrived."
    return 1
  fi
  log "    the served wasm was rebuilt after the fault: apps/api/build/index_bg.wasm"
  return 0
}

build_diagnostic() {
  if grep -qE "error\[E[0-9]+\]|^error: could not compile" "$DEV_LOG" 2>/dev/null; then
    log "    INVALID: the faulted source did not compile -- rustc diagnostic in the dev log:"
    grep -E "error\[E[0-9]+\]|^error: could not compile" "$DEV_LOG" | head -3 | sed 's/^/             /'
    return 1
  fi
  return 0
}

# ------------------------------------------------------------------------------------------
# Run one case.
# ------------------------------------------------------------------------------------------
run_case() {
  local name="$1" expect="$2"
  local before_hash after_hash

  log ""
  log "  CASE ${name}"

  before_hash="$(shasum "$REPO/$TARGET" | cut -d' ' -f1)"

  # Mutate. `python3` with an exact-match assertion, so a reformat that moved the line is a
  # loud failure rather than a no-op that reports MISSED for a run that never happened.
  if ! python3 - "$REPO/$TARGET" "$ORIGINAL" "$FAULTED" << 'PY'
import sys, pathlib
path, original, faulted = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if s.count(original) != 1:
    print(f"  ANCHOR: expected exactly one occurrence, found {s.count(original)}")
    sys.exit(1)
p.write_text(s.replace(original, faulted, 1))
PY
  then
    VERDICTS+=("INVALID $name  the anchor did not match exactly once, so no fault was applied")
    log "    INVALID: the anchor did not match exactly once"
    restore || true
    return
  fi

  # assert_changed: bytes differ from the snapshot. `cmp` proves bytes changed; it does NOT
  # prove the fault had the intended EFFECT -- that is what the run is for.
  if cmp -s "$SNAP" "$REPO/$TARGET"; then
    VERDICTS+=("INVALID $name  the file did not change, so the mutation faulted nothing")
    log "    INVALID: the file is byte-identical to the snapshot; the fault did nothing"
    restore || true
    return
  fi
  after_hash="$(shasum "$REPO/$TARGET" | cut -d' ' -f1)"
  log "    fault applied: $TARGET changed ($before_hash -> $after_hash)"

  # A reference timestamp taken AFTER the fault is applied, so "newer than the fault" is a
  # statement about the build and not about the clock.
  FAULT_MARK="$(mktemp -u)"
  touch -d "@$(( $(date +%s) + 1 ))" "$FAULT_MARK" 2>/dev/null || FAULT_MARK="$(mktemp)"

  settle_worker
  restart_stack || { VERDICTS+=("INVALID $name  the stack did not restart"); restore || true; return; }

  if ! build_diagnostic; then
    VERDICTS+=("INVALID $name  the faulted source did not compile")
    restore || true
    return
  fi
  if ! served_wasm_newer_than_fault "$FAULT_MARK"; then
    VERDICTS+=("INVALID $name  the Worker kept serving a pre-mutation binary")
    restore || true
    return
  fi

  local probe_out="/tmp/v02-004-sensitivity-probe.log"
  ( cd "$REPO/apps/api" && node scripts/v02-observability-correlation-probe.mjs ) > "$probe_out" 2>&1
  local probe_status=$?
  local summary
  summary="$(grep -oE "[0-9]+ pass, [0-9]+ fail, [0-9]+ unmeasured" "$probe_out" | tail -1)"

  # Restore BEFORE reading the verdict, so a decision is never made about a faulted tree.
  restore || true

  if [ "$probe_status" -eq 2 ]; then
    VERDICTS+=("INVALID $name  the probe exited 2, so the harness could not run")
    log "    INVALID: probe exit 2 -- the harness could not run. That is not a detection."
    tail -4 "$probe_out" | sed 's/^/             /'
    return
  fi

  local security_line
  security_line="$(grep -E "security_events row carries THIS request" "$probe_out" | head -1 | cut -c1-140)"

  if [ "$probe_status" -eq 1 ]; then
    VERDICTS+=("DETECTED $name  ${summary:-no summary}")
    log "    DETECTED: probe exit 1 -- ${summary:-no summary}"
    log "    ${security_line:-the security-event leg line was not found}"
    grep -E "^  FAIL" "$probe_out" | head -4 | sed 's/^/             /'
  else
    VERDICTS+=("MISSED $name  ${summary:-no summary}")
    log "    MISSED: probe exit 0 -- ${summary:-no summary}"
    log "    ${security_line:-the security-event leg line was not found}"
  fi
}

# ------------------------------------------------------------------------------------------
# Baseline first. A mutation run with no clean baseline cannot tell a new detection from a
# fault that was already there.
# ------------------------------------------------------------------------------------------
log ""
log "  BASELINE (unmutated)"
BASE_OUT="/tmp/v02-004-sensitivity-baseline.log"
( cd "$REPO/apps/api" && node scripts/v02-observability-correlation-probe.mjs ) > "$BASE_OUT" 2>&1
BASE_STATUS=$?
BASE_SUMMARY="$(grep -oE "[0-9]+ pass, [0-9]+ fail, [0-9]+ unmeasured" "$BASE_OUT" | tail -1)"
log "    exit $BASE_STATUS -- ${BASE_SUMMARY:-no summary}"
if [ "$BASE_STATUS" -ne 0 ]; then
  log ""
  log "  FATAL: the baseline is not clean (exit $BASE_STATUS). A sensitivity run measured against a"
  log "         red baseline cannot distinguish its mutation from a fault that was already there."
  grep -E "^  FAIL" "$BASE_OUT" | head -5 | sed 's/^/             /'
  exit 2
fi

run_case "M1 the security event binds the wrong value into request_id" "DETECTED"

# ------------------------------------------------------------------------------------------
# Report. An EMPTY verdict list is a failure, not a success.
# ------------------------------------------------------------------------------------------
restore || true

log ""
log "  ------------------------------------------------------------------"
log "  V02-004 SENSITIVITY"
log "  ------------------------------------------------------------------"
if [ "${#VERDICTS[@]}" -eq 0 ]; then
  log "  FATAL: no verdict was produced. A harness must not report success for a run it did"
  log "         not perform -- an empty verdict list is a failure."
  exit 2
fi
for v in "${VERDICTS[@]}"; do
  log "  $v"
done
log ""
log "  tree after restore: $(git -C "$REPO" diff --quiet -- "$TARGET" && echo clean || echo DIRTY)"
log ""
log "  If M1 reads MISSED, this gate cannot detect a security event whose request id is not the"
log "  one that caused it -- and the correlation claim would be an assertion about the absence of"
log "  evidence rather than about correlation."

# The exit code is a VERDICT, and it must distinguish three outcomes rather than two.
#
# The first version ended in `grep MISSED -> exit 1; else exit 0`, so a sheet on which EVERY case was
# INVALID exited **0** -- a clean success for a run in which nothing was measured. That is the exact
# failure this campaign has now hit in six harnesses, and this one produced it while I was writing
# the guard meant to prevent it: the guard correctly reported INVALID, and the script around it
# reported success. **A guard is only as good as the exit status of the thing that reads it.**
#
#   0  every case DETECTED -- the gate detects this class of fault
#   1  a case MISSED      -- the gate does NOT detect it, which is a finding about the gate
#   2  a case INVALID     -- the harness could not measure it, which is a finding about the harness
#
# INVALID dominates MISSED: if any case is unmeasurable, no sheet including it is conclusive, and
# reporting the run as "the gate does not detect this" would be a claim about a run that never
# happened.
if grep -q "INVALID" <<<"${VERDICTS[*]}"; then
  log ""
  log "  exit 2: at least one case was INVALID, so this run is a statement about the HARNESS and"
  log "  not about the gate. A sensitivity proof that could not measure anything is not a pass."
  exit 2
fi
if grep -q "MISSED" <<<"${VERDICTS[*]}"; then
  exit 1
fi
exit 0