#!/usr/bin/env bash
# V01 — sensitivity of `verify:collection-tenancy`.
#
# A gate nobody has watched fail is an assumption, and this one is the newest of the round: it claims
# that **30 org-scoped collection routes** leak nothing belonging to another organization, and it has
# never seen a leak. A leak test is the most dangerous shape of gate to be wrong about, because the
# failure mode is a *silent* pass -- a route that forgot `org_id` in its `WHERE` clause returns a
# perfectly authorised `200` carrying another tenant's rows, and nothing about the response looks wrong.
#
#   M1  `AGENTS_PAGE_SQL`'s `WHERE org_id = ?1` becomes `WHERE ?1 = ?1`. The bind is still there and
#       still bound, so the statement stays valid and only the SCOPING goes -- the realistic form of
#       the regression, and the one a reviewer would actually merge. `/orgs/{org_id}/agents` must then
#       answer with Bravo's agent in it, and the probe must say so by name.
#
#       The place a bind-count mistake would be made deliberately: the *first* version of this
#       mutation deleted `AND org_id = ?1` outright, which left the bind list longer than the
#       placeholders, D1 refused the statement, the route answered an error, and the probe reported
#       "no leak" for a route that had not run. A verdict from a build that cannot execute the query
#       is not a verdict. The mutation keeps the bind.
#
#   M2  the **positive-match control** is the second half of the proof, and it is checked by
#       breaking the thing it depends on rather than by inspection. The control asserts that the same
#       string search FINDS Org A's own project id in Org A's own `/projects` body. If the search could
#       not find an identifier when one is present, every "found nothing" above it would be vacuous.
#       M2 removes Alpha's project from the fixture, so the control has nothing to find and must FAIL
#       -- which is the only way to show it is a control and not a decoration.
#
# Harness rules from four earlier rounds of this campaign, each of which bit at least once: build
# explicitly and treat a build failure as a harness error; probe exit 2 is "could not run" and is never
# a verdict; restore in an EXIT trap; assert the file actually changed; an empty verdict list is a
# failure; the tree is checked against git independently of the snapshot; HEAD must not move.
#
# Exit 0 when every mutation is DETECTED. Exit 1 otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

PROBE="apps/api/scripts/v01-collection-tenancy-probe.mjs"
RUNS="apps/api/src/repositories/runs.rs"
SCRATCH="${P09_SCRATCH:-target/v01-collection-scratch}"
SNAPSHOT="$SCRATCH/snapshot"
LOGDIR="docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence"
mkdir -p "$SNAPSHOT" "$LOGDIR"

say() { printf '\n=== %s\n' "$*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

TRACKED=("$RUNS")
# M2 deliberately edits the PROBE, so it is snapshotted and restored alongside the product source.
PROBE_TRACKED=1

snapshot_all() {
  HEAD_BEFORE="$(git rev-parse HEAD)"
  echo "  HEAD at snapshot: $HEAD_BEFORE"
  assert_git_clean "before snapshot"
  rm -rf "$SNAPSHOT"
  for f in "${TRACKED[@]}" "$PROBE"; do
    mkdir -p "$SNAPSHOT/$(dirname "$f")"
    cp "$f" "$SNAPSHOT/$f"
    sha "$f" >"$SNAPSHOT/$(echo "$f" | tr '/.' '__').sha"
  done
}

sha_of() { cat "$SNAPSHOT/$(echo "$1" | tr '/.' '__').sha"; }

assert_git_clean() {
  local when="$1" f dirty=()
  # The probe is checked only at snapshot time and after a full restore: M2 deliberately edits it,
  # so demanding it be clean mid-run would refuse the fault this harness exists to apply.
  local scope=("${TRACKED[@]}")
  if [ "${when}" != "after restore" ]; then scope+=("$PROBE"); fi
  for f in "${scope[@]}"; do
    git diff --quiet -- "$f" 2>/dev/null || dirty+=("$f")
  done
  if [ "${#dirty[@]}" -ne 0 ]; then
    echo "TREE NOT CLEAN ($when) in a file this harness touches:" >&2
    printf '  %s\n' "${dirty[@]}" >&2
    echo "A deliberate fault survived, or the snapshot came from an already-faulted tree." >&2
    exit 1
  fi
  echo "  git agrees the tree is clean ($when)"
  if [ -n "${HEAD_BEFORE:-}" ] && [ "$(git rev-parse HEAD)" != "$HEAD_BEFORE" ]; then
    echo "HEAD MOVED DURING THIS RUN ($HEAD_BEFORE -> $(git rev-parse HEAD))." >&2
    echo "A commit made while a fault was applied has captured it. Verdicts are void." >&2
    exit 1
  fi
}

restore_all() {
  local f after want
  for f in "${TRACKED[@]}" "$PROBE"; do
    cp "$SNAPSHOT/$f" "$f"
    want="$(sha_of "$f")"
    after="$(sha "$f")"
    if [ "$after" != "$want" ]; then
      echo "RESTORE FAILED for $f — the next measurement would be against a faulted tree" >&2
      exit 1
    fi
  done
  echo "  restored ${TRACKED[*]}"
  assert_git_clean "after restore"
}

assert_changed() {
  local f
  for f in "${TRACKED[@]}"; do
    if [ "$(sha "$f")" != "$(sha_of "$f")" ]; then
      echo "  mutation applied to $f"
      return 0
    fi
  done
  echo "MUTATION DID NOT APPLY — nothing changed, so this run would measure a clean tree and" >&2
  echo "report a false MISSED." >&2
  exit 1
}

build_worker() {
  local label="$1" log="$SCRATCH/build-$1.log"
  mkdir -p "$SCRATCH"
  set +e
  cargo build --release --target wasm32-unknown-unknown \
    -p lumi-agents-control-plane-api >"$log" 2>&1
  local code=$?
  set -e
  if [ "$code" != "0" ]; then
    echo "BUILD FAILED for mutation $label -- harness error, not a verdict." >&2
    grep -E "^error" -A 6 "$log" | head -30 >&2
    exit 1
  fi
}

run_probe() {
  local label="$1" out="$SCRATCH/db-$1"
  rm -rf "$out"
  build_worker "$label"
  pkill -9 -f workerd >/dev/null 2>&1 || true
  sleep 2
  set +e
  V01_COLLECTION_PERSIST_TO="$REPO_ROOT/$out" node "$PROBE" \
    >"$LOGDIR/v01-collection-sensitivity-$label.log" 2>&1
  local code=$?
  set -e
  if [ "$code" = "2" ]; then
    echo "PROBE EXITED 2 for $label -- the harness could not run, so nothing was measured." >&2
    tail -25 "$LOGDIR/v01-collection-sensitivity-$label.log" >&2
    exit 1
  fi
  if ! grep -q "cases hold" "$LOGDIR/v01-collection-sensitivity-$label.log"; then
    echo "PROBE FOR $label NEVER REACHED ITS SUMMARY -- treating it as no measurement at all." >&2
    tail -25 "$LOGDIR/v01-collection-sensitivity-$label.log" >&2
    exit 1
  fi
  if grep -q "DID NOT COMPLETE" "$LOGDIR/v01-collection-sensitivity-$label.log"; then
    echo "PROBE FOR $label REPORTED THAT IT DID NOT COMPLETE -- refusing to grade a partial run." >&2
    tail -25 "$LOGDIR/v01-collection-sensitivity-$label.log" >&2
    exit 1
  fi
  echo "$code"
}

# FIXED-STRING matching, and the reason is a false MISSED this harness itself produced on its first
# run. M1 leaked three identifiers and the probe printed
#   LEAK  /api/v1/orgs/{org_id}/agents -> 200 leaked org=org_9cf8..., project=prj_e79a..., agent=agd_...
# and the probe's own assertion FAILED -- and `fired` reported MISSED, because the needle was fed
# through `grep -E` and `{org_id}` is an interval metacharacter. A harness that reports a detection
# as a miss is worse than one that cannot detect: it turns a caught defect into a recorded gap.
fired() { grep -qF -- "$2" "$LOGDIR/v01-collection-sensitivity-$1.log" 2>/dev/null; }

verdicts=()
record() {
  local label="$1" needle="$2" want="$3" why="${4:-}" got="MISSED"
  if fired "$label" "$needle"; then got="DETECTED"; fi
  if [ "$got" = "$want" ]; then
    verdicts+=("OK    $label -> $got")
  elif [ "$got" = "MISSED" ] && [ -n "$why" ]; then
    verdicts+=("KNOWN $label -> MISSED, expected and explained")
    printf '  %-9s %s\n            %s\n' "$got" "$label" "$why"
    return
  else
    verdicts+=("WRONG $label -> $got, expected $want")
  fi
  printf '  %-9s %s\n' "$got" "$label"
}

LEAK="body of GET /api/v1/orgs/{org_id}/agents"
POSITIVE="the same search FINDS Org A's own project id"

CLEAN=0
on_exit() {
  local code=$?
  if [ "$CLEAN" = "0" ] && [ -f "$SNAPSHOT/$(echo "$RUNS" | tr '/.' '__').sha" ]; then
    echo
    echo "--- restoring source from the snapshot before exiting (exit $code)"
    restore_all || true
  fi
  exit "$code"
}
trap on_exit EXIT
# A SIGNAL SKIPS THE EXIT TRAP: `trap ... EXIT` does not fire for an unhandled SIGTERM, and `pkill`
# sends SIGTERM. Handle the signals and re-raise through `exit`, which does run the trap.
trap 'echo "--- signal caught; restoring before exit" >&2; exit 130' INT TERM HUP

# --------------------------------------------------------------- the baseline
say "baseline: 30 collection routes, no leak, and the positive control finds Alpha's own project"
snapshot_all
BASE_CODE="$(run_probe baseline)"
BASE_FAILS="$(grep -c '^  FAIL' "$LOGDIR/v01-collection-sensitivity-baseline.log" || true)"
echo "  probe exit=$BASE_CODE, failing assertions=$BASE_FAILS"
if [ "$BASE_FAILS" != "0" ]; then
  echo "BASELINE IS NOT GREEN: $BASE_FAILS assertion(s) fail before any mutation, so a detection" >&2
  echo "below could not be attributed to the fault." >&2
  grep '^  FAIL' "$LOGDIR/v01-collection-sensitivity-baseline.log" | head -8 >&2
  exit 1
fi
grep -E "MEASURED against" "$LOGDIR/v01-collection-sensitivity-baseline.log" | sed 's/^/  /'
# The harness's own vacuity guard. A detection needle that already appears in the BASELINE log would
# make every mutation "detected" for free, which is the same class of defect as a control that cannot
# fail. So the baseline is required NOT to contain either needle.
for needle in "$LEAK" "$POSITIVE"; do
  if grep -qF -- "$needle" "$LOGDIR/v01-collection-sensitivity-baseline.log"; then
    echo "HAIRNESS DEFECT: the needle \"$needle\" already appears in the green baseline, so every" >&2
    echo "mutation below would be graded DETECTED without anything being detected." >&2
    exit 1
  fi
done
echo "  neither detection needle appears in the baseline, so a detection has to be earned"
restore_all

# -------------------------------------------------------------------- M1
say "M1: AGENTS_PAGE_SQL binds org_id but stops filtering on it"
python3 - "$RUNS" << 'PY'
import sys
path = sys.argv[1]
src = open(path).read()
# The placeholder STAYS and stays bound. Deleting it would leave the bind list longer than the
# placeholders, D1 would refuse the statement, and the route would answer an error -- which the probe
# would report as "no leak" for a route that never ran. That is a verdict from a broken reference.
old = """FROM agent_definitions
WHERE org_id = ?1"""
new = """FROM agent_definitions
WHERE ?1 = ?1"""
if old not in src:
    print("M1 ANCHOR NOT FOUND", file=sys.stderr)
    sys.exit(1)
open(path, "w").write(src.replace(old, new, 1))
print("  AGENTS_PAGE_SQL no longer filters on org_id")
PY
assert_changed
M1_CODE="$(run_probe m1)"
echo "  probe exit=$M1_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-collection-sensitivity-m1.log" || true)"
grep -E "^  LEAK" "$LOGDIR/v01-collection-sensitivity-m1.log" | head -3 | sed 's/^/  /'
record m1 "GET $LEAK" DETECTED
restore_all

# -------------------------------------------------------------------- M2
say "M2: the positive-match control is given nothing to find"
python3 - "$PROBE" << 'PY'
import sys
path = sys.argv[1]
src = open(path).read()
# Stop seeding Org A's own project, so the control that proves the search CAN find an identifier has
# none to find. This is the only way to show a control is a control.
old = '''  const projectA = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgA.orgId}/projects`,
    { name: "Alpha Project", slug: `alpha-project-${probe.nonce}`, visibility: "org" },
    browserMutation(alice.jar, "coll-project-a"),
  );'''
new = '''  const projectA = { status: 0, payload: null }; // M2: Alpha's own project is not seeded'''
if old not in src:
    print("M2 ANCHOR NOT FOUND", file=sys.stderr)
    sys.exit(1)
open(path, "w").write(src.replace(old, new, 1))
print("  Org A's own project is no longer seeded")
PY
assert_probe_changed() {
  if git diff --quiet -- "$PROBE" 2>/dev/null; then
    echo "M2 DID NOT APPLY to the probe -- nothing changed, so this run would grade a clean probe" >&2
    echo "and report a false MISSED." >&2
    exit 1
  fi
  echo "  mutation applied to $PROBE"
}
assert_probe_changed
M2_CODE="$(run_probe m2)"
echo "  probe exit=$M2_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-collection-sensitivity-m2.log" || true)"
record m2 "$POSITIVE" DETECTED
cp "$SNAPSHOT/$PROBE" "$PROBE"
if [ "$(sha "$PROBE")" != "$(sha_of "$PROBE")" ]; then
  echo "RESTORE FAILED for the probe -- the next measurement would grade a faulted probe" >&2
  exit 1
fi
echo "  the probe is restored from the snapshot and fingerprinted"

# ------------------------------------------------------------------ verdict
say "verdicts"
if [ "${#verdicts[@]}" -eq 0 ]; then
  echo "  NO VERDICTS RECORDED - the run produced no measurement, which is not a pass." >&2
  exit 1
fi
for line in "${verdicts[@]}"; do echo "  $line"; done
echo
if printf '%s\n' "${verdicts[@]}" | grep -q "^WRONG"; then
  echo "SENSITIVITY FAILED — at least one mutation was not detected." >&2
  exit 1
fi
CLEAN=1
echo "SENSITIVITY OK — every mutation was detected. The gate can fail."
