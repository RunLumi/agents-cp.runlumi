#!/usr/bin/env bash
# V04 work item 5 (completion) -- the full mutation campaign, launched so the ONE class the release
# gate names and this campaign had not yet killed can be reached.
#
#   "Test-strength sample: ... auth replay mutant killed ..."
#
# Five of the six named classes were already killed in the previous run (VI-TEN-001 x2, VI-AUTHZ-001,
# VI-INF-001, VI-BUD-001 x2, VI-IDEM-001, VI-MIG-001, VI-SEC-001). The sixth is VI-AUTH-001, "a
# consumed WebAuthn ceremony is accepted a second time" -- a TWO-SITE fault across
# `routes/authenticators.rs` and `repositories/authenticators.rs`, caught ONLY by `smoke:passkey`
# driving a real ceremony twice over HTTP with real ES256. Two build sites make it the slowest case in
# the campaign, which is why the previous run was stopped before reaching it.
#
# The campaign has no per-case filter (its only flags are --apply, --self-test, --preflight), so the
# whole set runs again. That is the cost of the one missing named class, and it is worth recording
# rather than working around with a hand-edited case list: a campaign whose case set can be edited
# ad hoc is a campaign whose denominator is whatever the last editor wanted.
#
# DISCIPLINE, all of it earned earlier in this campaign:
#   * a disposable linked worktree at a path NOTHING else uses (`/Volumes/SSD/verify` -- note the
#     sibling `/Volumes/SSD/v04-verify` belongs to another instance and is NOT reused);
#   * scratch on the REPOSITORY volume (~2.4 GB per case), never the system volume, because a run that
#     fills the system volume fails its builds and then reports every case BLOCKED, which reads
#     exactly like a wall of broken mutants;
#   * logs in `/Volumes/SSD/v04-logs`, outside every directory the toolchain owns;
#   * HEAD recorded here and re-checked at exit, so a commit during a 2-hour run cannot capture a
#     fault permanently;
#   * an empty verdict list is a failure, and a build failure is INVALID rather than a detection.

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
WT="/Volumes/SSD/verify"
LOGDIR="/Volumes/SSD/v04-logs"
LOG="$LOGDIR/v04-mutation-campaign.log"
mkdir -p "$LOGDIR"
: > "$LOG"

SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
log() { printf '%s\n' "$*" | tee -a "$LOG"; }

cleanup() {
  git -C "$REPO" worktree remove --force "$WT" 2> /dev/null
  git -C "$REPO" worktree prune 2> /dev/null
  return 0
}
on_signal() { log "interrupted -- removing the worktree"; cleanup; trap - EXIT; exit 130; }
trap cleanup EXIT
trap on_signal INT TERM HUP

if [ -d "$WT" ]; then
  log "FATAL: $WT already exists. A snapshot taken over a previous campaign's fault is a snapshot of"
  log "       the wrong tree, so the campaign refuses to reuse one."
  exit 2
fi
git -C "$REPO" worktree add "$WT" HEAD >> "$LOG" 2>&1 || { log "FATAL: could not create $WT"; exit 2; }

log "V04 mutation campaign -- full set, to reach VI-AUTH-001"
log "  main HEAD at launch : $SNAPSHOT_HEAD"
log "  worktree            : $WT @ $(git -C "$WT" rev-parse --short HEAD)"
log "  scratch             : $REPO/target/mutation-scratch (repository volume)"
log "  free on repository  : $(df -h "$REPO" | tail -1 | awk '{print $4}')"
log "  started             : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

( cd "$WT" && P09_SCRATCH="$REPO/target/mutation-scratch" pnpm verify:mutation --apply ) \
  > "$LOGDIR/v04-mutation-full.log" 2>&1
CODE=$?

cleanup

log ""
log "  campaign exit       : $CODE"
log "  KILLED              : $(grep -c 'KILLED' "$LOGDIR/v04-mutation-full.log" 2>/dev/null || echo 0)"
log "  VI-AUTH-001 verdict : $(grep -oE '\[(KILLED|SURVIVED|INVALID)\] VI-AUTH-001' "$LOGDIR/v04-mutation-full.log" 2>/dev/null | head -1 || echo 'not reached')"
if [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then
  log "  WARNING: HEAD MOVED during the run ($SNAPSHOT_HEAD -> $(git -C "$REPO" rev-parse --short HEAD))."
  log "           Every verdict above describes a tree that is no longer the main tree."
else
  log "  HEAD unmoved        : yes"
fi
log "  finished            : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
exit "$CODE"
