#!/usr/bin/env bash
# VI-AUTH-001 sensitivity, run directly.
#
# WHY THIS EXISTS RATHER THAN A RE-RUN OF THE CAMPAIGN. The campaign reached this case and wedged:
# a stray `workerd` left on port 8787 by an earlier probe of this campaign's own made `wrangler dev`
# unable to bind, and `p02-passkey-smoke.mjs` sat for 1h35m having consumed 1.17s of CPU with no worker
# child and the port free. It could not complete, so its verdict is **UNMEASURED** -- not a kill, and
# emphatically not a survivor. An instrument that did not run is not a measured zero.
#
# The campaign has no per-case filter (its only flags are --apply, --self-test, --preflight), so
# re-running it to reach one case would re-spend ~1.5h on the nine cases already killed. The fault is
# taken VERBATIM from the campaign's own case definition rather than retyped, so this proves the case
# the campaign would have run, not a convenient substitute.
#
# ORDER: the control runs FIRST and must pass. A mutant is only meaningful over a probe that works, and
# a red mutant over a red control would say nothing about the product.
#
# The verdict and the bail live in separate statements, and a build error is never a detection:
# `cargo test`/`smoke` exit non-zero for both a failing assertion and a compile error, and `^error:`
# cannot separate them because it matches cargo's own `error: test failed, to rerun pass`.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
WT="/Volumes/SSD/v04-auth-verify"
LOGDIR="/Volumes/SSD/v04-logs"
LOG="$LOGDIR/v04-auth-001-sensitivity.log"
mkdir -p "$LOGDIR"; : > "$LOG"

SNAPSHOT_HEAD="$(git -C "$REPO" rev-parse HEAD)"
VERDICTS=()
log() { printf '%s\n' "$*" | tee -a "$LOG"; }

SITE1="apps/api/src/routes/authenticators.rs"
SITE2="apps/api/src/repositories/authenticators.rs"
SNAP="$LOGDIR/auth-snapshot"; mkdir -p "$SNAP"

cleanup() { git -C "$REPO" worktree remove --force "$WT" 2>/dev/null; git -C "$REPO" worktree prune 2>/dev/null; return 0; }
restore() {
  cp "$SNAP/routes.rs" "$WT/$SITE1" 2>/dev/null && touch "$WT/$SITE1"
  cp "$SNAP/repos.rs" "$WT/$SITE2" 2>/dev/null && touch "$WT/$SITE2"
  if git -C "$WT" diff --quiet -- "$SITE1" "$SITE2" 2>/dev/null; then
    log "  restored: both sites match the worktree HEAD"
  else
    log "  RESTORE FAILED -- a deliberate fault may still be in the worktree"
    git -C "$WT" diff --stat -- "$SITE1" "$SITE2" 2>/dev/null | tee -a "$LOG"
  fi
  return 0
}
on_signal() { log "interrupted -- cleaning up"; restore; cleanup; trap - EXIT; exit 130; }

# --- preconditions, stated before anything is measured ---------------------------------------
if ! git -C "$REPO" diff --quiet -- "$SITE1" "$SITE2"; then
  log "FATAL: $SITE1 or $SITE2 has uncommitted work in main. Refusing to start."
  exit 2
fi
if [ -d "$WT" ]; then
  log "FATAL: $WT already exists. A snapshot taken over a previous fault is a snapshot of the wrong tree."
  exit 2
fi
HOLDER="$(lsof -nP -iTCP:8787 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1}')"
if [ -n "$HOLDER" ]; then
  log "FATAL: port 8787 is held by '$HOLDER'. A held port is what wedged the last attempt, and it"
  log "       produces a hang rather than an error, so nothing downstream would ever be reached."
  exit 2
fi
log "VI-AUTH-001 sensitivity -- a consumed WebAuthn ceremony accepted a second time"
log "  HEAD at launch : $SNAPSHOT_HEAD"
log "  port 8787      : free (checked before starting, not assumed)"
log "  fault taken    : verbatim from the campaign's own case definition"

trap cleanup EXIT
trap on_signal INT TERM HUP

git -C "$REPO" worktree add "$WT" HEAD >> "$LOG" 2>&1 || { log "FATAL: worktree"; exit 2; }

# A fresh worktree has no `node_modules`, and without it `wrangler` cannot bundle
# `apps/api/sentry-entry.mjs` (it imports `@sentry/cloudflare`), the Worker never becomes healthy, and
# the probe reports that -- which a campaign grades as a kill for the wrong reason. The campaign's own
# source calls this "worse than a red gate, because it looks like evidence about the product".
#
# The CONTROL run is what caught it here, exactly as intended: the first attempt failed with
# `spawn .../apps/api/node_modules/...` and the script refused to run the mutant at all, rather than
# reporting a mutant verdict over a probe that cannot execute. Symlink rather than copy, as the
# campaign does -- the point is to resolve the real packages.
for d in node_modules apps/api/node_modules apps/web/node_modules; do
  [ -e "$REPO/$d" ] && ln -sfn "$REPO/$d" "$WT/$d"
done
log "  node_modules   : symlinked from the main checkout (a fresh worktree has none)"

cp "$WT/$SITE1" "$SNAP/routes.rs"
cp "$WT/$SITE2" "$SNAP/repos.rs"
log "  worktree       : $WT @ $(git -C "$WT" rev-parse --short HEAD)"

# --- run the probe, classifying the result --------------------------------------------------
# echoes one of: PASS | DETECTED | INVALID
run_passkey() {
  local tag="$1" out="$LOGDIR/auth-passkey-$1.log"
  ( cd "$WT" && pnpm smoke:passkey ) > "$out" 2>&1
  local code=$?
  local plain; plain="$(sed 's/\x1b\[[0-9;]*m//g' "$out")"
  if grep -qE "^error\[E[0-9]+\]|^error: could not compile|^error: aborting" <<< "$plain"; then
    echo INVALID; return 0
  fi
  # The kill is only real if the probe marks that check FAILED. The first classifier merely looked for
  # the string "consumed login ceremony cannot be replayed" anywhere in the output -- and the probe
  # PRINTS that text on a PASSING run too, as the name of the check. So an unmutated, fully green tree
  # (76/76) was classified DETECTED. A substring is not a verdict; the line's own PASS/FAIL marker is.
  if grep -qE "^FAIL.*consumed login ceremony cannot be replayed" <<< "$plain"; then
    echo DETECTED; return 0
  fi
  if grep -qE "^[0-9]+/[0-9]+ checks passed" <<< "$plain"; then
    # Every check reported and the mutant's invariant did not fail: the replay was accepted.
    echo "SURVIVED:$(grep -m1 -oE '^[0-9]+/[0-9]+ checks passed' <<< "$plain")"; return 0
  fi
  echo "UNKNOWN:$(grep -m1 -E 'FAIL|checks passed|Error' <<< "$plain" | cut -c1-90)"
  return 0
}

# --- CONTROL FIRST ---------------------------------------------------------------------------
log ""
log "CONTROL  the unmutated tree must PASS, or the mutant below means nothing"
C="$(run_passkey control)"
log "  control: $C"
case "$C" in
  SURVIVED:*)
    # All checks passed on an UNMUTATED tree. Note that a control returning DETECTED would be a real
    # product finding -- the replay invariant failing with no fault applied -- and is reported as such
    # rather than being read as harness noise.
    log "  control is green -- smoke:passkey runs here, and the port is genuinely free" ;;
  DETECTED)
    log "  NOTE: the replay invariant FAILED on an unmutated tree. That is a product finding, not a"
    log "        harness fault, and the mutant leg below would be meaningless."
    VERDICTS+=("PRODUCT: VI-AUTH-001 fails with NO fault applied -- the invariant is not held") ;;
  INVALID)
    log "  FATAL: the control did not build; no verdict is possible"; VERDICTS+=("INVALID control: build failed") ;;
  *)
    log "  FATAL: the control did not complete ($C). A mutant over a control that did not run says"
    log "         nothing, and reporting one would be reporting a run this script did not perform."
    VERDICTS+=("INVALID control: $C") ;;
esac

if [[ "$C" == SURVIVED:* ]]; then
  # --- the mutant ---------------------------------------------------------------------------
  log ""
  log "MUTANT   both defences removed, so the replay is accepted"
  python3 - "$WT/$SITE1" "$WT/$SITE2" << 'PY'
import pathlib, sys
one, two = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = one.read_text()
old1 = "        || ceremony.status != CeremonyStatus::Pending.as_str()"
assert s.count(old1) == 1, f"site 1 anchor found {s.count(old1)} times -- refusing to guess"
one.write_text(s.replace(old1, "        || false"))
s = two.read_text()
old2 = "        Ok(D1Adapter::changes(&result)? == 1)"
n2 = s.count(old2)
# NOT unique. `consume_ceremony` (the target), `revoke_passkey` and `consume_recovery` all end with
# this exact line. The campaign uses JS `String.replace` with a STRING pattern, which replaces the
# FIRST occurrence only -- so the campaign's case is correctly targeted purely because
# `consume_ceremony` is defined first.
#
# This script's first run asserted the anchor was UNIQUE and refused the mutation, which silently
# degraded a two-site fault to a one-site fault. 76/76 then came back -- which is the EXPECTED
# single-site result, since the storage CAS catches the replay on its own -- and I was one step from
# recording a Tier-0 mutant survivor that did not exist. The lesson is the one the campaign already
# states: a harness must not be able to report a verdict for a run it did not perform.
#
# So: match the campaign's replace-FIRST semantics, and assert the ENCLOSING FUNCTION rather than
# trusting source order. If those three functions are ever reordered, the campaign would silently
# disable `revoke_passkey` or `consume_recovery` and report a kill for a fault it did not intend.
assert n2 >= 1, "site 2 anchor absent"
first = s.index(old2)
enclosing = [
    ln for ln in s[:first].splitlines()
    if ln.lstrip().startswith(("pub async fn ", "pub fn ", "async fn ", "fn "))
]
assert enclosing and enclosing[-1].strip().startswith("pub async fn consume_ceremony"), (
    "site 2's first occurrence is inside "
    + (enclosing[-1].strip() if enclosing else "nothing")
    + ", not consume_ceremony -- this case targets source ORDER and the order has changed"
)
two.write_text(s.replace(old2, "        let _ = &result; Ok(true)", 1))
print(f"  both sites mutated (site 2 anchor occurs {n2}x; first is inside consume_ceremony)")
PY
  if git -C "$WT" diff --quiet -- "$SITE1" "$SITE2"; then
    log "  FATAL: the mutation changed nothing; the case would report a verdict for a run it did not do"
    VERDICTS+=("INVALID mutant: no change")
  else
    log "  mutation changed both files (asserted against git, not the snapshot):"
    git -C "$WT" diff --stat -- "$SITE1" "$SITE2" | sed "s/^/    /" | tee -a "$LOG"
    M="$(run_passkey mutant)"
    log "  mutant:  $M"
    case "$M" in
      DETECTED)
        VERDICTS+=("DETECTED VI-AUTH-001 -- smoke:passkey marked the replay check FAIL, so the 2-site fault is caught by runtime evidence over real HTTP and real ES256") ;;
      SURVIVED:*)
        VERDICTS+=("SURVIVED VI-AUTH-001 -- every check still passed ($M) with both defences removed. A meaningful Tier-0 mutant survived, which is a release blocker on its own") ;;
      INVALID)
        VERDICTS+=("INVALID VI-AUTH-001 -- the mutant did not build, so nothing was measured") ;;
      *)
        VERDICTS+=("INVALID VI-AUTH-001 -- $M") ;;
    esac
  fi
  restore
fi

# --- verdict ---------------------------------------------------------------------------------
log ""
log "VERDICTS"
for v in ${VERDICTS+"${VERDICTS[@]}"}; do log "  $v"; done
DETECTED="$(printf '%s\n' ${VERDICTS+"${VERDICTS[@]}"} | grep -c '^DETECTED' || true)"
INVALID="$(printf '%s\n' ${VERDICTS+"${VERDICTS[@]}"} | grep -c '^INVALID' || true)"
log "  detected: $DETECTED   invalid: $INVALID"

if [ -z "${VERDICTS[*]:-}" ] || [ "${#VERDICTS[@]}" -eq 0 ]; then
  log "  FATAL: no verdicts recorded"; exit 2
fi
if [ "$INVALID" -gt 0 ]; then
  log "  FAIL: a leg did not run, so the sheet is not a measurement"; exit 1
fi
if printf '%s\n' ${VERDICTS+"${VERDICTS[@]}"} | grep -q '^SURVIVED'; then
  log "  FAIL: a meaningful Tier-0 mutant SURVIVED -- a release blocker in its own right"; exit 1
fi
if [ "$DETECTED" -lt 1 ]; then
  log "  FAIL: the mutant was not detected"; exit 1
fi

if [ "$(git -C "$REPO" rev-parse HEAD)" != "$SNAPSHOT_HEAD" ]; then
  log "  WARNING: HEAD moved during the run"
else
  log "  HEAD unmoved: yes"
fi
if git -C "$REPO" diff --quiet -- "$SITE1" "$SITE2"; then
  log "  main tree: clean, no fault in the product"
else
  log "  main tree: DIRTY"; exit 1
fi
log ""
log "RESULT: VI-AUTH-001 DETECTED (killed), exit 0"