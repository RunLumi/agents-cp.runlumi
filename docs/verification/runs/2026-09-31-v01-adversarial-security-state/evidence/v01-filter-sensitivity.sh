#!/usr/bin/env bash
# V01 — sensitivity of `verify:filter-tenancy`.
#
# This gate is a *negative* gate: every one of its claims is "nothing leaked", which is the
# shape most able to pass for the wrong reason. Its own controls already caught two of the ways
# — a wrapped body read as a bare array, and three nested paths that do not exist in the router
# at all. So the question here is the other one: can this gate be made to FAIL by a realistic
# single-edit regression?
#
#   M1  `AGENTS_PAGE_SQL`: `WHERE org_id = ?1` -> `WHERE 1 = 1`. The bind list is UNCHANGED and
#       every other predicate — including the `EXISTS` sub-queries that re-assert
#       `p.org_id = agent_definitions.org_id` — is untouched. The reader who assumes the inner
#       sub-queries are the boundary is exactly the reader this mutation fools, which is the
#       point of writing it.
#   M2  the projects page queries lose their outer `org_id = ?1`. A project id is globally
#       unique, so nothing inside the statement reveals the omission.
#   M3  `readable_project` loses its `.filter(|project| project.org_id == org_id)`. EVERY SQL
#       statement stays unchanged and correctly classified, and the tenant audit — which reads
#       the statements — sees nothing at all. The only thing that catches this is a handler-level
#       runtime probe, which is why this gate exists and why this case is the load-bearing one.
#
# Harness rules from four earlier rounds of this campaign, all of which bit at least once:
#   * build explicitly, and a build failure is a HARNESS error, not a verdict;
#   * probe exit 2 means "could not run", which is never a verdict either;
#   * restore in an EXIT trap, so an abort cannot leave a fault compiled in;
#   * assert the file you edited actually changed, or the run measures a clean tree;
#   * an empty verdict list is a failure, not a success.
#
# Exit 0 when every mutation is DETECTED. Exit 1 otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

PROBE="apps/api/scripts/v01-filter-tenancy-probe.mjs"
RUNS="apps/api/src/repositories/runs.rs"
PROJECTS="apps/api/src/repositories/projects.rs"
ROUTES="apps/api/src/routes/projects.rs"
AUDIT="apps/api/src/repositories/audit.rs"
SCRATCH="${P09_SCRATCH:-target/v01-filter-scratch}"
SNAPSHOT="$SCRATCH/snapshot"
LOGDIR="docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence"
mkdir -p "$SNAPSHOT" "$LOGDIR"

say() { printf '\n=== %s\n' "$*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

TRACKED=("$RUNS" "$PROJECTS" "$ROUTES" "$AUDIT")

snapshot_all() {
  rm -rf "$SNAPSHOT"
  for f in "${TRACKED[@]}"; do
    mkdir -p "$SNAPSHOT/$(dirname "$f")"
    cp "$f" "$SNAPSHOT/$f"
    sha "$f" >"$SNAPSHOT/$(echo "$f" | tr '/.' '__').sha"
  done
}

sha_of() { cat "$SNAPSHOT/$(echo "$1" | tr '/.' '__').sha"; }

restore_all() {
  local f after want
  for f in "${TRACKED[@]}"; do
    cp "$SNAPSHOT/$f" "$f"
    want="$(sha_of "$f")"
    after="$(sha "$f")"
    if [ "$after" != "$want" ]; then
      echo "RESTORE FAILED for $f — the next measurement would be against a faulted tree" >&2
      exit 1
    fi
  done
  echo "restored all four files"
}

assert_changed() {
  local f
  for f in "${TRACKED[@]}"; do
    if [ "$(sha "$f")" != "$(sha_of "$f")" ]; then
      echo "mutation applied to $f"
      return 0
    fi
  done
  echo "MUTATION DID NOT APPLY — no tracked file changed, so this run would measure a clean" >&2
  echo "tree and report a false MISSED." >&2
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
  V01_FILTER_PERSIST_TO="$REPO_ROOT/$out" node "$PROBE" >"$LOGDIR/v01-filter-sensitivity-$label.log" 2>&1
  local code=$?
  set -e
  if [ "$code" = "2" ]; then
    echo "PROBE EXITED 2 for $label -- the harness could not run, so nothing was measured." >&2
    tail -25 "$LOGDIR/v01-filter-sensitivity-$label.log" >&2
    exit 1
  fi
  echo "$code"
}

fired() { grep -q "^  FAIL.*$2" "$LOGDIR/v01-filter-sensitivity-$1.log" 2>/dev/null; }

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

AGENTS_LEAK="agents filtered by project: another org's"
NESTED_LEAK="nested project detail: another org's id in the path"
PAGINATION_LEAK="pagination: another org's cursor"

CLEAN=0
on_exit() {
  local code=$?
  if [ "$CLEAN" = "0" ] && [ -f "$SNAPSHOT" ]; then
    echo
    echo "--- restoring source from the snapshot before exiting (exit $code)"
    restore_all || true
  fi
  exit "$code"
}
trap on_exit EXIT

# --------------------------------------------------------------- the baseline
say "baseline: the repaired product must pass the gate"
snapshot_all
BASE_CODE="$(run_probe baseline)"
if [ "$BASE_CODE" != "0" ]; then
  echo "BASELINE FAILED (exit $BASE_CODE). A red baseline makes every verdict below unreadable." >&2
  tail -20 "$LOGDIR/v01-filter-sensitivity-baseline.log" >&2
  exit 1
fi
echo "  baseline PASS (exit 0)"
restore_all

# ------------------------------------------------------------------- M1
say "M1: AGENTS_PAGE_SQL loses its outer org predicate — the bind list is unchanged"
python3 - "$RUNS" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
i = src.index("const AGENTS_PAGE_SQL")
j = src.index("FROM agent_definitions", i)
k = src.index("WHERE org_id = ?1", j)
assert k < i + 900, "the org predicate was not in the outer query of AGENTS_PAGE_SQL"
src = src[:k] + "WHERE 1 = 1" + src[k + len("WHERE org_id = ?1"):]
open(path, "w").write(src)
print("  AGENTS_PAGE_SQL: WHERE org_id = ?1 -> WHERE 1 = 1 (every other predicate untouched)")
PY2
assert_changed
M1_CODE="$(run_probe m1)"
echo "  probe exit=$M1_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-filter-sensitivity-m1.log" || true)"
grep -m 2 "LEAKED" "$LOGDIR/v01-filter-sensitivity-m1.log" | cut -c1-200 || true
record m1 "$AGENTS_LEAK" DETECTED
restore_all

# ------------------------------------------------------------------- M2
say "M2: the projects page queries lose their outer org predicate"
python3 - "$PROJECTS" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
# THREE statements, not two. `list_projects_unrestricted` -- the path an OWNER takes -- builds
# its SQL inline inside the function, with no named constant, so a mutation that patches the
# constants alone changes code the owner never executes. That first version of M2 patched two
# constants, reported MISSED, and was wrong: the gate was fine and the mutation was weak.
#
# It is worth recording as a property of the code, not just of the test. A scan of named SQL
# constants finds the member path and misses the manager path, which is the one every owner in
# the system uses.
n = 0
for const in ("PROJECTS_PAGE_SQL", "FIRST_PROJECTS_PAGE_SQL"):
    i = src.index(f"const {const}")
    j = src.index("FROM projects", i)
    k = src.index("WHERE org_id = ?1", j)
    src = src[:k] + "WHERE 1 = 1" + src[k + len("WHERE org_id = ?1"):]
    n += 1
# The inline statement inside `list_projects_unrestricted`.
i = src.index("pub async fn list_projects_unrestricted")
end = src.index("pub async fn", i + 10)
body = src[i:end]
k = body.index("WHERE org_id = ?1")
src = src[:i] + body[:k] + "WHERE 1 = 1" + body[k + len("WHERE org_id = ?1"):] + src[end:]
n += 1
assert n == 3, f"expected to patch 3 statements, patched {n}"
open(path, "w").write(src)
print(f"  patched {n} statements, including the inline one the owner path executes")
PY2
assert_changed
M2_CODE="$(run_probe m2)"
echo "  probe exit=$M2_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-filter-sensitivity-m2.log" || true)"
grep -m 2 "LEAKED" "$LOGDIR/v01-filter-sensitivity-m2.log" | cut -c1-200 || true
record m2 "$PAGINATION_LEAK" DETECTED
restore_all

# ------------------------------------------------------------------- M3
say "M3: readable_project loses its handler-level org filter — every SQL statement untouched"
python3 - "$ROUTES" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
needle = ".filter(|project| project.org_id == org_id)"
assert needle in src, "the handler-level org filter was not where M3 expected it"
open(path, "w").write(src.replace(needle, "", 1))
print("  removed the handler's org filter; PROJECT_BY_ID_SQL is unchanged and still correct")
PY2
assert_changed
M3_CODE="$(run_probe m3)"
echo "  probe exit=$M3_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-filter-sensitivity-m3.log" || true)"
grep -m 2 "LEAKED" "$LOGDIR/v01-filter-sensitivity-m3.log" | cut -c1-200 || true
record m3 "$NESTED_LEAK" DETECTED
restore_all

# ------------------------------------------------------------------- M4
say "M4: LIST_AUDIT_SQL's org predicate becomes an OR — every filter predicate stays"
python3 - "$AUDIT" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
i = src.index("const LIST_AUDIT_SQL")
k = src.index("WHERE org_id = ?1", i)
assert k < i + 900, "the org predicate was not the leading one on LIST_AUDIT_SQL"
# `OR ?1 <> ''` rather than `WHERE 1 = 1`, and that is not a stylistic choice.
#
# On this statement `?1` is referenced NOWHERE else -- the EXISTS sub-queries compare
# `projects.org_id = agent_definitions.org_id`, column to column -- so deleting the predicate
# orphans the placeholder and D1 refuses the statement with a 503. That mutation cannot express
# the bug at all: it breaks the route instead of leaking it, and the probe caught the 503 on
# its controls, which is the right answer to a different question.
#
# The OR form is the realistic regression -- a conjunction typed as a disjunction -- and it keeps
# the bind count identical, which is exactly why it can ship.
src = src[:k] + "WHERE org_id = ?1 OR ?1 <> ''" + src[k + len("WHERE org_id = ?1"):]
open(path, "w").write(src)
print("  LIST_AUDIT_SQL: WHERE org_id = ?1 -> WHERE org_id = ?1 OR ?1 <> ''")
PY2
assert_changed
M4_CODE="$(run_probe m4)"
echo "  probe exit=$M4_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-filter-sensitivity-m4.log" || true)"
grep -m 1 "LEAKED" "$LOGDIR/v01-filter-sensitivity-m4.log" | cut -c1-200 || true
record m4 "audit filtered by resource_id" DETECTED
restore_all

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
