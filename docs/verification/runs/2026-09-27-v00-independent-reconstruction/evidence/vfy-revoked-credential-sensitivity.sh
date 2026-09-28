#!/bin/sh
# Prove the passkey probe's REVOKED-CREDENTIAL case can fail.
#
# WHY
#
# Two cases were added to `p02-passkey-smoke.mjs` against the objective's required
# list -- "unknown/revoked credential" and "`user_id` substitution" -- and the
# "unknown" half already existed. A check that has never been watched fail is an
# assumption, so the revoked half is reverted here: if the credential lookup stops
# filtering on `revoked_at`, a revoked passkey must start authenticating again and
# the probe must say so.
#
# The identity-substitution case is NOT covered here, and the reason is stated in
# the record rather than papered over: the server does not read any identity header,
# so there is no line to revert. Reverting it would mean ADDING the vulnerability.
# That case is a live assertion of a property rather than a mutation-detectable one,
# and it is described that way wherever it is claimed.
set -eu
REPO=/Volumes/SSD/agents-cp.runlumi
WT=/private/var/folders/zz/jzz3w1rj5lq21d_7c0nkc31m0000gn/T/opencode/revcheck
TARGET=apps/api/src/routes/authenticators.rs
ANCHOR='        .filter(|record| record.revoked_at.is_none())'

cd "$REPO"
git worktree remove --force "$WT" 2>/dev/null || true
rm -rf "$WT"
git worktree add "$WT" HEAD >/dev/null 2>&1
# The worktree is at HEAD, which does NOT contain the probe this script is here to
# exercise. Without the sync below the script measured the OLD 41-check probe, which
# has no revoked-credential case at all -- so it reported 41/41 after the revert and
# the sensitivity claim was vacuous. A sensitivity proof that runs the wrong verifier
# is worse than none, because it looks like evidence.
rsync -a --delete --exclude '.git' --exclude 'target' --exclude 'node_modules' \
      --exclude '.wrangler' --exclude 'dist' --exclude '.vite' "$REPO/" "$WT/"
ln -s "$REPO/node_modules" "$WT/node_modules"
ln -s "$REPO/apps/api/node_modules" "$WT/apps/api/node_modules"

cleanup() {
  git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
  pkill -9 -f workerd 2>/dev/null || true
}

echo "=== baseline: the revoked-credential case as committed ==="
( cd "$WT/apps/api" && node scripts/p02-passkey-smoke.mjs 2>&1 | grep -E "REVOKED|checks passed" ) || true

echo
echo "=== revert: the login ceremony stops filtering on revoked_at ==="
python3 - "$WT/$TARGET" "$ANCHOR" <<'PY'
import sys, pathlib
p, anchor = pathlib.Path(sys.argv[1]), sys.argv[2]
s = p.read_text()
assert anchor in s, "revocation filter anchor missing"
p.write_text(s.replace(anchor, "        .filter(|_| true)", 1))
print("a revoked credential is no longer filtered out of the login path")
PY

echo
echo "=== rebuilding the Worker and re-running the probe ==="
( cd "$WT/apps/api" && cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -1 )
( cd "$WT/apps/api" && worker-build --release 2>&1 | tail -1 )
( cd "$WT/apps/api" && node scripts/p02-passkey-smoke.mjs 2>&1 | grep -E "REVOKED|checks passed|case\(s\) failed" ) || true

cleanup
echo
echo "done"
