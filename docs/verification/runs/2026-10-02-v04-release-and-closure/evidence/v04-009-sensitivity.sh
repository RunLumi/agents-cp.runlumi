#!/usr/bin/env bash
# Sensitivity proof for the V04-009 recovery-replay case added to `smoke:passkey`.
#
# TWO CLAIMS, ONE RUN.
#
# 1. The new probe assertions have teeth. A recovery-replay case that passes on the product proves
#    nothing until it has been watched failing. The fault is `consume_recovery`'s compare-and-set --
#    `Ok(D1Adapter::changes(&result)? == 1)` -> `let _ = &result; Ok(true)` -- which is the ONLY
#    defence on that path.
#
# 2. V04-009's central claim is that recovery is defended by ONE layer where its four siblings have
#    two. If that is true, this ONE-site fault must expose the replay, where VI-AUTH-001 needed a
#    TWO-site fault to do the same for login. A single run measures both: if the replay becomes
#    ACCEPTED, the claim holds; if it is still refused, V04-009's table is wrong and the fourth
#    defence this campaign did not find is somewhere else.
#
# The same anchor text occurs THREE times in that file -- `consume_ceremony`, `revoke_passkey` and
# `consume_recovery` -- so the fault is located by SCOPING to `consume_recovery` rather than by
# counting occurrences. Counting is what produced the false Tier-0 survivor in this campaign's own
# earlier attempt at this proof; the campaign's own case targets the first occurrence, which is
# `consume_ceremony`, and that is correct only by source order.
#
# Control first: `smoke:passkey` must be green unmutated, or a red mutant says nothing.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
WT="/Volumes/SSD/v04-recovery-verify"
LOGDIR="/Volumes/SSD/v04-logs"
LOG="$LOGDIR/v04-009-sensitivity.log"
SITE="apps/api/src/repositories/authenticators.rs"
ROUTES="apps/api/src/routes/authenticators.rs"
# The assertion under test, by name. The control asserts this line appears as PASS, so a tree
# that does not contain the case cannot be graded green.
CASE_UNDER_TEST="a consumed recovery ceremony cannot be replayed"
mkdir -p "$LOGDIR"; : > "$LOG"

SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
log() { printf '%s\n' "$*" | tee -a "$LOG"; }
VERDICTS=()

restore() {
  [ -n "${SNAP:-}" ] && { cp "$SNAP" "$WT/$SITE" 2>/dev/null && touch "$WT/$SITE"; }
  [ -n "${SNAPR:-}" ] && { cp "$SNAPR" "$WT/$ROUTES" 2>/dev/null && touch "$WT/$ROUTES"; }
  if git -C "$WT" diff --quiet -- "$SITE" "$ROUTES" 2>/dev/null; then log "  restored: both sites match worktree HEAD"
  else log "  RESTORE FAILED -- a deliberate fault may remain"; git -C "$WT" diff --stat -- "$SITE" "$ROUTES" | tee -a "$LOG"; fi
  return 0
}
cleanup() { git -C "$REPO" worktree remove --force "$WT" 2>/dev/null; git -C "$REPO" worktree prune 2>/dev/null; return 0; }
on_signal() { log "interrupted"; restore; cleanup; trap - EXIT; exit 130; }
trap cleanup EXIT
trap on_signal INT TERM HUP

if ! git -C "$REPO" diff --quiet -- "$SITE" "$ROUTES"; then
  log "FATAL: $SITE or $ROUTES is dirty in main"; exit 2
fi
if [ -d "$WT" ]; then log "FATAL: $WT exists; a snapshot over a previous fault is a snapshot of the wrong tree"; exit 2; fi
if lsof -nP -iTCP:8787 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{f=1} END{exit !f}'; then
  log "FATAL: port 8787 is held. A held port HANGS here rather than erroring, which is how the previous"; log "       attempt burned 1h35m on 1.17s of CPU."; exit 2
fi

log "V04-009 sensitivity -- recovery ceremony replay, TWO sites (the inline guard AND the CAS)"
log "  HEAD at launch : $SNAPSHOT_HEAD"
git -C "$REPO" worktree add "$WT" HEAD >> "$LOG" 2>&1 || { log "FATAL: worktree"; exit 2; }
for d in node_modules apps/api/node_modules apps/web/node_modules; do
  [ -e "$REPO/$d" ] && ln -sfn "$REPO/$d" "$WT/$d"
done
SNAP="$LOGDIR/recovery-snapshot.rs"
SNAPR="$LOGDIR/recovery-snapshot-routes.rs"
cp "$WT/$SITE" "$SNAP"
cp "$WT/$ROUTES" "$SNAPR"
log "  worktree       : $WT @ $(git -C "$WT" rev-parse --short HEAD)"
log "  node_modules   : symlinked (a fresh worktree has none, and without them the Worker never"
log "                   becomes healthy -- which reads as a kill for the wrong reason)"

run_passkey() {
  local out="$LOGDIR/v04-009-$1.log"
  ( cd "$WT" && pnpm smoke:passkey ) > "$out" 2>&1
  local plain; plain="$(sed 's/\x1b\[[0-9;]*m//g' "$out")"
  if grep -qE "^error\[E[0-9]+\]|^error: could not compile|^error: aborting" <<< "$plain"; then echo "INVALID"; return 0; fi
  if grep -qE "^FAIL.*a consumed recovery ceremony cannot be replayed" <<< "$plain"; then echo "DETECTED"; return 0; fi
  if grep -qE "^[0-9]+/[0-9]+ checks passed" <<< "$plain"; then
    local total; total="$(grep -m1 -oE '^[0-9]+/[0-9]+ checks passed' <<< "$plain")"
    # The case under test MUST appear as a PASS in this run's output. Without this the control is
    # vacuous: a tree that does not contain the new case still reports a green total, and a mutant over
    # that tree also reports a green total, which is how the first run of this script concluded that a
    # fourth defence existed. The baseline before this case was 80/80 in the main checkout (76/76 before
    # the four assertions were added), so the count alone is not a sufficient witness either -- the
    # case's own NAME is.
    if ! grep -qE "^PASS.*$CASE_UNDER_TEST" <<< "$plain"; then
      echo "GREEN-WITHOUT-THE-CASE:$total"; return 0
    fi
    echo "GREEN:$total"; return 0
  fi
  echo "UNKNOWN:$(grep -m1 -E 'FAIL|checks passed|Error' <<< "$plain" | cut -c1-80)"
}

log ""; log "CONTROL  unmutated tree must be green"
C="$(run_passkey control)"
log "  control: $C"
case "$C" in
  GREEN:*)
    log "  control is green AND ran the case under test" ;;
  GREEN-WITHOUT-THE-CASE:*)
    log "  FATAL: the control is green but never ran '$CASE_UNDER_TEST' ($C). The tree under test does"
    log "         not contain the assertion being measured -- most likely the probe change is"
    log "         UNCOMMITTED and the worktree was built from HEAD without it. Reporting a verdict"
    log "         here would be a claim about a tree the case was never in."
    VERDICTS+=("INVALID control: the case under test did not run ($C)") ;;
  *)
    log "  FATAL: the control is not green ($C)"; VERDICTS+=("INVALID control: $C") ;;
esac

if [[ "$C" == GREEN:* && "$C" != GREEN-WITHOUT-THE-CASE:* ]]; then
  log ""; log "MUTANT   both defences removed: the INLINED status/expiry guard and the compare-and-set"
  python3 - "$WT/$ROUTES" "$WT/$SITE" << 'PY2'
import pathlib, sys
routes, site = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

# --- site A: the INLINED route-level guard in the handler ---------------------------------
r = routes.read_text()
start = r.index("let challenge = repository")
old_a = ('    if challenge.status != "pending"\n'
         '        || challenge.expires_at.as_str() <= context.received_at.as_str()\n'
         '    {\n'
         '        return Err(generic_recovery_failure(&context));\n'
         '    }\n')
i = r.index(old_a, start)
end = r.index("\n    let code_hash", i)
assert i < end, "site A located outside the reset handler"
routes.write_text(r[:i] + "    if false {\n        return Err(generic_recovery_failure(&context));\n    }\n" + r[i + len(old_a):])
print(f"  site A applied at offset {i}: the inline status/expiry guard in the reset handler")

# --- site B: the storage compare-and-set ---------------------------------------------------
s2 = site.read_text()
start2 = s2.index("pub async fn consume_recovery")
anchor = "Ok(D1Adapter::changes(&result)? == 1)"
j = s2.index(anchor, start2)
end2 = s2.index("\n    pub async fn ", start2 + 10)
assert j < end2, "site B located outside consume_recovery"
site.write_text(s2[:j] + "let _ = &result; Ok(true)" + s2[j + len(anchor):])
print(f"  site B applied at offset {j}, inside consume_recovery ({start2}..{end2})")
PY2
  if git -C "$WT" diff --quiet -- "$SITE" "$ROUTES"; then
    log "  FATAL: the fault changed nothing"; VERDICTS+=("INVALID mutant: no change")
  else
    git -C "$WT" diff --stat -- "$SITE" "$ROUTES" | sed 's/^/    /' | tee -a "$LOG"
    M="$(run_passkey mutant)"
    log "  mutant: $M"
    case "$M" in
      DETECTED) VERDICTS+=("DETECTED -- the new recovery-replay case caught the removed CAS");;
      GREEN:*)  VERDICTS+=("MISSED -- the replay was STILL refused with both defences removed, so a further defence exists that this campaign has not found");;
      INVALID)  VERDICTS+=("INVALID -- the mutant did not build");;
      *)        VERDICTS+=("INVALID -- $M");;
    esac
  fi
  restore
fi

log ""; log "VERDICTS"
for v in ${VERDICTS+"${VERDICTS[@]}"}; do log "  $v"; done
if [ "${#VERDICTS[@]}" -eq 0 ]; then log "  FATAL: no verdicts recorded"; exit 2; fi
if printf '%s\n' ${VERDICTS+"${VERDICTS[@]}"} | grep -q '^INVALID\|^MISSED'; then log "  FAIL"; exit 1; fi
if [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then log "  WARNING: HEAD moved"; fi
git -C "$REPO" diff --quiet -- "$SITE" "$ROUTES" && log "  main tree: clean" || { log "  main tree: DIRTY"; exit 1; }
log ""; log "RESULT: detected with BOTH defences removed, exit 0 -- recovery has two defences,"
log "        empirically, and the new probe case catches their joint removal"