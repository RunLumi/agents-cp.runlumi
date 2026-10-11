#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${REPO_ROOT:-$(cd -- "$script_dir/../../../../../" && pwd)}"
results_root="${LUMI_E2E_TEST_RESULTS:-$repo_root/test-results}"
repo_under_test="${LUMI_E2E_REPO:-$results_root/credential-sensitivity-repo}"
node24="${NODE24_BIN:-node}"
cd "$repo_under_test"
export PATH="$(dirname -- "$node24"):$(dirname -- "$(command -v cargo)"):$PATH"
export CARGO_HOME="${CARGO_HOME:-$results_root/credential-sensitivity-cargo}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$results_root/credential-sensitivity-cargo-target}"
export TMPDIR="${TMPDIR:-$results_root/t}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$results_root/claim-xdg}"
export WRANGLER_SEND_METRICS=false
sensitivity_head=$(git rev-parse HEAD)
test "$sensitivity_head" = 82d6775b7343099d1025c120b49c0476096e3ea4
git diff --quiet
git diff --cached --quiet
restore_credential_route() {
 git restore --source="$sensitivity_head" --worktree -- apps/api/src/routes/migration.rs
 test "$(git rev-parse HEAD)" = "$sensitivity_head"
 git diff --quiet -- apps/api/src/routes/migration.rs
 git diff --cached --quiet -- apps/api/src/routes/migration.rs
}
trap restore_credential_route EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
python3 - <<'MUTATE'
from pathlib import Path
import hashlib,json,os
p=Path('apps/api/src/routes/migration.rs')
manifest=Path(os.environ['LUMI_E2E_TEST_RESULTS'])/'credential-sensitivity-source-manifest.json'
expected=json.loads(manifest.read_text())[str(p)]
assert hashlib.sha256(p.read_bytes()).hexdigest()==expected
s=p.read_text(); needle='            statements.push(
                repository
                    .advance_statement('
assert s.count(needle)==1
start=s.index(needle); end=s.index('\n            );',start)+len('\n            );')
block=s[start:end]
# Valid mode-only fault: keep every applied-stage positive control working.
s=s[:start]+'            if current_stage != requested {\n'+block+'\n            }'+s[end:]
p.write_text(s)
MUTATE
cd apps/api
worker-build --release > "$results_root/credential-sensitivity-fault-build.log" 2>&1
cd "$repo_root"
set +e
"$node24" apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs > "$results_root/credential-sensitivity-fault-runtime.log" 2>&1
sensitivity_status=$?
set -e
printf '%s\n' "$sensitivity_status" > "$results_root/credential-sensitivity-fault-status.txt"
restore_credential_route
trap - EXIT INT TERM HUP
cd apps/api
worker-build --release > "$results_root/credential-sensitivity-restored-build.log" 2>&1
cd "$repo_root"
"$node24" apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs > "$results_root/credential-sensitivity-restored-runtime.log" 2>&1
test "$(git rev-parse HEAD)" = "$sensitivity_head"
git diff --quiet -- apps/api/src/routes/migration.rs
git diff --cached --quiet -- apps/api/src/routes/migration.rs
