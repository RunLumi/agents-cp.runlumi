#!/usr/bin/env bash
# V01-009 sensitivity — does `verify:idempotency` actually detect a route that is not idempotent?
#
# A gate nobody has watched fail is an assumption. This one is new, and it was written after
# the defect it detects had already been found and repaired, so its ability to detect is
# exactly the thing that had not been demonstrated.
#
# Four faults, each removing or reversing part of the repair:
#
#   M1  `create_project` claims no key at all — the pre-V01-009 state. This is the defect
#       itself and must kill the incompatible-payload and both race cases.
#   M2  the claim is resolved AFTER the slug pre-condition. This is a fault I *introduced*
#       during the repair and then removed: it makes a genuine retry answer
#       `409 project_slug_conflict` instead of the stored response. A gate that only counted
#       rows would not notice, because the row count is still correct.
#   M3  the fence leaves the commit batch. Nothing in `create_project` changes, the claim,
#       the scope and the fingerprint all stay — only the guard statement is replaced, so
#       the guard is now a duplicate upsert instead of the assertion that aborts the loser.
#       This is the difference between "a duplicate is unlikely" and "a duplicate is
#       impossible", and it is invisible to any check that does not issue concurrent
#       requests.
#   M4  the replay returns the live body instead of the stored one. Same side effects, same
#       status, wrong response — a defect only a body comparison can see.
#
# Two harness rules from earlier in this campaign are load-bearing here:
#
#   * `set -e` alone is not enough. A sensitivity script that reverts its fault with `mv`
#     preserves the pre-fault mtime, so the build is skipped and the next run measures the
#     faulted binary against a clean tree. Every mutation below therefore asserts that the
#     file it edited ACTUALLY CHANGED before it builds.
#   * restore is `cp` from a snapshot, never `mv` and never `git diff HEAD`. The repair is an
#     uncommitted change, so "differs from HEAD" cannot distinguish a failed restore from the
#     repair itself.
#
# Exit 0 when every mutation is DETECTED (the gate works). Exit 1 when any is MISSED, because
# a gate that cannot fail is not evidence.

set -euo pipefail

# This file sits five levels down: evidence/ -> <run>/ -> runs/ -> verification/ -> docs/.
# Getting this wrong is silent until the first `cp` reports a path that is not there.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$REPO_ROOT"

PROBE="apps/api/scripts/v01-idempotency-probe.mjs"
ROUTE="apps/api/src/routes/projects.rs"
IDEM="apps/api/src/repositories/idempotency.rs"
SCRATCH="${P09_SCRATCH:-target/v01-009-scratch}"
SNAPSHOT="$SCRATCH/snapshot"
LOGDIR="docs/verification/runs/2026-09-31-v01-adversarial-security-state/evidence"
mkdir -p "$SNAPSHOT" "$LOGDIR"

say() { printf '\n=== %s\n' "$*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# Snapshot every file a mutation might touch. A harness that snapshots only the file it
# expects to edit is how a deliberate fault stays compiled in for the next case — which is
# exactly what happened in V01-002.
snapshot_all() {
  rm -rf "$SNAPSHOT"
  for f in "$ROUTE" "$IDEM"; do
    mkdir -p "$SNAPSHOT/$(dirname "$f")"
    cp "$f" "$SNAPSHOT/$f"
  done
  sha "$ROUTE" >"$SNAPSHOT/route.sha"
  sha "$IDEM" >"$SNAPSHOT/idem.sha"
}

restore_all() {
  local f after want
  for f in "$ROUTE" "$IDEM"; do
    cp "$SNAPSHOT/$f" "$f"
  done
  want="$(cat "$SNAPSHOT/route.sha")"
  after="$(sha "$ROUTE")"
  if [ "$after" != "$want" ]; then
    echo "RESTORE FAILED for $ROUTE — the next measurement would be against a faulted tree" >&2
    exit 1
  fi
  want="$(cat "$SNAPSHOT/idem.sha")"
  after="$(sha "$IDEM")"
  if [ "$after" != "$want" ]; then
    echo "RESTORE FAILED for $IDEM — the next measurement would be against a faulted tree" >&2
    exit 1
  fi
  echo "restored both files (sha256 route=$after)"
}

# A mutation that edits nothing must never be measured. This is the check whose absence
# produced three false MISSED verdicts in an earlier harness in this campaign.
assert_changed() {
  if [ "$(sha "$ROUTE")" = "$(cat "$SNAPSHOT/route.sha")" ] &&
    [ "$(sha "$IDEM")" = "$(cat "$SNAPSHOT/idem.sha")" ]; then
    echo "MUTATION DID NOT APPLY - no tracked file changed, so this run would measure a" >&2
    echo "clean tree and report a false MISSED." >&2
    exit 1
  fi
  echo "mutation applied"
}

# Build the mutated tree. A mutation that does not compile is a HARNESS failure, not a
# verdict: the probe would exit 2 ("could not run") and recording that as MISSED is how an
# earlier campaign reported three mutations as undetected when nothing had been measured at
# all. So the build is explicit, and a failure aborts the run instead of producing a verdict.
build_worker() {
  local label="$1" log="$SCRATCH/build-$1.log"
  mkdir -p "$SCRATCH"
  set +e
  cargo build --release --target wasm32-unknown-unknown \
    -p lumi-agents-control-plane-api >"$log" 2>&1
  local code=$?
  set -e
  if [ "$code" != "0" ]; then
    echo "BUILD FAILED for mutation $label -- this is a harness error, not a verdict." >&2
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
  V01_IDEM_PERSIST_TO="$REPO_ROOT/$out" node "$PROBE" >"$LOGDIR/v01-009-sensitivity-$1.log" 2>&1
  local code=$?
  set -e
  # Exit 2 means the harness could not run. That is not a defect and not a pass; treat it
  # as a harness error so it can never be recorded as a verdict.
  if [ "$code" = "2" ]; then
    echo "PROBE EXITED 2 for $label -- the harness could not run, so nothing was measured." >&2
    tail -25 "$LOGDIR/v01-009-sensitivity-$label.log" >&2
    exit 1
  fi
  echo "$code"
}

# `fired()` matches its needle as a SUBSTRING of the FAIL line. Anchoring it after the word
# FAIL is what made three cases report MISSED while the detection sat in the log.
fired() {
  grep -q "^  FAIL.*$2" "$LOGDIR/v01-009-sensitivity-$1.log" 2>/dev/null
}

# An abort in the middle of a mutation leaves the fault compiled in, and the NEXT run's
# `snapshot_all` then faithfully snapshots the faulted file -- so the baseline fails, the
# verdict is unreadable, and the repository is left broken. That happened here once, and
# recovering from it meant reconstructing the repair by hand.
#
# So restoration is not a line at the end of each case. It is a trap, which runs on exit,
# on error, and on interruption. `restore_all` is idempotent and verifies the sha, so
# calling it twice is harmless.
CLEAN=0
on_exit() {
  local code=$?
  if [ "$CLEAN" = "0" ] && [ -f "$SNAPSHOT/route.sha" ]; then
    echo
    echo "--- restoring source from the snapshot before exiting (exit $code)"
    restore_all || true
  fi
  exit "$code"
}
trap on_exit EXIT

verdicts=()
# record <label> <needle> <expected> [why-missed-is-acceptable]
#
# A MISSED is only acceptable when there is a named reason, and the reason is printed
# rather than assumed. An unexplained MISSED means the gate has a hole; an explained one
# means the gate is not the right instrument for that particular claim, which is itself
# worth recording.
record() {
  # The default matters: under `set -u` an unbound $4 aborts the function mid-verdict,
  # and the EXIT trap then reported exit 0 with an empty verdict list -- a harness
  # reporting success for a run that never finished.
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

RACE="concurrent requests with ONE key and DIFFERENT payloads creates exactly ONE project"
SAME8="a burst of 8 concurrent requests with the SAME key and the SAME payload creates exactly ONE project"
INCOMPAT="the same key with a DIFFERENT payload is refused"
REPLAY="the replay returns the FIRST request's response"

# --------------------------------------------------------------- the baseline
say "baseline: the repaired route must pass the gate"
snapshot_all
BASE_CODE="$(run_probe baseline)"
if [ "$BASE_CODE" != "0" ]; then
  echo "BASELINE FAILED (exit $BASE_CODE). The gate must be green before a mutation means" >&2
  echo "anything; a red baseline makes every verdict below unreadable." >&2
  tail -20 "$LOGDIR/v01-009-sensitivity-baseline.log" >&2
  exit 1
fi
echo "  baseline PASS (exit 0)"
restore_all

# ------------------------------------------------------------------- M1
say "M1: create_project claims no key - the pre-repair defect, verbatim"
python3 - "$ROUTE" <<'PY2'
import sys
path = sys.argv[1]
src = open(path).read()
# Replace the whole claimed-write tail with the pre-V01-009 shape: the key is still
# CHECKED, the slug pre-condition still runs, and the insert and the outbox row are two
# separate unguarded batches with no claim, no fence and no stored response.
# Anchor at the claim, NOT at the key check. The name, visibility and slug validation
# between them must survive: an earlier version of this mutation anchored too high and
# removed them, so the tree did not compile and the run produced no verdict at all.
start = src.index("    let mutation = prepare_scoped_mutation(")
end = src.index("/// The 201 body of `create_project`")
pre_repair = """    if ProjectRepository::new(database)
        .project_slug_count(org_id.as_str(), &slug)
        .await
        .map_err(|error| database_error(&context, error))?
        > 0
    {
        return Err(deny(
            &context,
            ApiErrorCode::Conflict,
            "project_slug_conflict",
            "A project with this slug already exists.",
        ));
    }
    let project_id = generated_id("prj");
    let insert = ProjectRepository::new(database)
        .insert_project_statement(
            &crate::repositories::NewProjectInput {
                project_id: &project_id,
                org_id: org_id.as_str(),
                name: &name,
                slug: &slug,
                visibility: visibility.as_str(),
                created_by_user_id: access.principal.user_id.as_str(),
            },
            &context.received_at,
        )
        .map_err(|error| database_error(&context, error))?;
    database
        .batch(vec![insert])
        .await
        .map_err(|error| database_error(&context, error))?;
    let project = ProjectRepository::new(database)
        .find_project(&project_id)
        .await
        .map_err(|_| service_unavailable(&context))?
        .ok_or_else(|| service_unavailable(&context))?;
    let event = outbox_statement(
        database,
        &context,
        Some(&access.principal),
        Some(org_id.as_str()),
        "project.created.v1",
        &json!({ "project_id": project_id, "visibility": visibility.as_str() }),
    )?;
    database
        .batch(vec![event])
        .await
        .map_err(|error| database_error(&context, error))?;
    Ok((StatusCode::CREATED, Json(project_json(&project))).into_response())
}

"""
open(path, "w").write(src[:start] + pre_repair + src[end:])
print("  restored the pre-V01-009 two-batch, unclaimed write")
PY2
assert_changed
M1_CODE="$(run_probe m1)"
echo "  probe exit=$M1_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-009-sensitivity-m1.log" || true)"
record m1 "$RACE" DETECTED
record m1 "$INCOMPAT" DETECTED
# This one is an honest MISSED, and it is the same accidental defence the finding is about:
# with no idempotency at all, eight identical payloads still produce one project, because
# UNIQUE (org_id, slug) refuses the seventh. The gate cannot see through that, and no gate
# over this route could -- which is why the case that DID find the defect varied the
# payload. Recorded rather than quietly dropped.
record m1 "$SAME8" DETECTED \
  "expected MISSED: UNIQUE (org_id, slug) produces the single row with or without a claim, \
so this assertion is satisfied by an unrelated constraint. The payload-varying cases above \
are what make the difference visible."
restore_all

# ------------------------------------------------------------------- M2
say "M2: the claim is resolved after the slug pre-condition (the fault I introduced)"
python3 - "$ROUTE" <<'PY2'
import re, sys
path = sys.argv[1]
src = open(path).read()
claim_at = src.index("    let mutation = prepare_scoped_mutation(")
slug_at = src.index("    if ProjectRepository::new(database)", claim_at)
project_at = src.index('    let project_id = generated_id("prj");', slug_at)
claim = src[claim_at:slug_at]
slug = src[slug_at:project_at]
# The slug block ran AFTER the claim, so it could release the claim it had just taken.
# Moving it earlier means there is no claim to release, which is precisely why the
# pre-release version of this code did not compile and why the fault as originally
# written had no `claim.release` in it.
slug = slug.replace(
    "        // The claim goes back, so the client's next attempt with this key is answered\n"
    "        // `project_slug_conflict` again rather than `idempotency_in_progress` for the\n"
    "        // length of the TTL.\n"
    "        claim.release(database, &context).await;\n",
    "",
)
assert "claim.release" not in slug, "the release was not removed, so the reorder will not compile"
open(path, "w").write(src[:claim_at] + slug + claim + src[project_at:])
print("  moved the slug pre-condition ahead of the claim")
PY2
assert_changed
M2_CODE="$(run_probe m2)"
echo "  probe exit=$M2_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-009-sensitivity-m2.log" || true)"
record m2 "$REPLAY" DETECTED
restore_all

# ------------------------------------------------------------------- M3
say "M3: the fence leaves the commit batch — the claim stays, only the guard goes"
python3 - "$IDEM" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "        let guard = self.claim_guard_statement(record, claim_token)?;"
assert needle in src, "the guard statement was not where M3 expected it"
# Replace the assertion with a harmless duplicate claim. Every scoping, fingerprint and
# uniqueness property stays; only the statement that ABORTS the losing worker is gone.
replacement = (
    "        // MUTATION M3: the assertion is gone. Scoping, fingerprinting and the\n"
    "        // UNIQUE constraint all still hold, and a duplicate is now merely unlikely.\n"
    "        let guard = self.claim_statement(record, claim_token, &record.expires_at)?;"
)
open(path, "w").write(src.replace(needle, replacement, 1))
print("  commit_success no longer prepares ASSERT_CLAIM_SQL")
PY
assert_changed
M3_CODE="$(run_probe m3)"
echo "  probe exit=$M3_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-009-sensitivity-m3.log" || true)"
record m3 "$SAME8" DETECTED
record m3 "$RACE" DETECTED
restore_all

# ------------------------------------------------------------------- M4
say "M4: the stored success carries a different body than the live response"
python3 - "$ROUTE" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "    let success =\n        StoredSuccess::new(201, response.clone()).map_err(|_| service_unavailable(&context))?;"
assert needle in src, "the StoredSuccess line was not where M4 expected it"
replacement = (
    "    // MUTATION M4: the stored body differs from the live one. Same status, same side\n"
    "    // effect, and a client that retries cannot recognise its own project. The id is\n"
    "    // gone as well as the rest, because keeping it is what made an earlier version of\n"
    "    // this mutation invisible to an id-only comparison.\n"
    "    let stored = json!({ \"project\": name });\n"
    "    let _ = &response;\n"
    "    let success = StoredSuccess::new(201, stored).map_err(|_| service_unavailable(&context))?;"
)
open(path, "w").write(src.replace(needle, replacement, 1))
print("  the replay now answers a body the live path never sent")
PY
assert_changed
M4_CODE="$(run_probe m4)"
echo "  probe exit=$M4_CODE, FAIL lines=$(grep -c '^  FAIL' "$LOGDIR/v01-009-sensitivity-m4.log" || true)"
record m4 "$REPLAY" DETECTED
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
