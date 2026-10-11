#!/bin/zsh
set -e
cd /Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-repo
export PATH=/Users/james/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/james/.codex/worktrees/lumi-integration/agents-cp.runlumi/test-results/toolchain/cargo/bin:$PATH
export RUSTUP_HOME=/Users/james/.codex/worktrees/lumi-integration/agents-cp.runlumi/test-results/toolchain/rustup
export CARGO_HOME=/private/tmp/lumi-e2e-cargo
export CARGO_TARGET_DIR=/Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-cargo-target
export TMPDIR=/Volumes/SSD/agents-cp.runlumi/test-results/t
export XDG_CONFIG_HOME=/Volumes/SSD/agents-cp.runlumi/test-results/claim-xdg
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
import hashlib,json
p=Path('apps/api/src/routes/migration.rs')
expected=json.loads(Path('/Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-source-manifest.json').read_text())[str(p)]
assert hashlib.sha256(p.read_bytes()).hexdigest()==expected
s=p.read_text(); needle='            statements.push(\n                repository\n                    .advance_statement('
assert s.count(needle)==1
start=s.index(needle); end=s.index('\n            );',start)+len('\n            );')
block=s[start:end]
# Valid mode-only fault: keep every applied-stage positive control working.
s=s[:start]+'            if current_stage != requested {\n'+block+'\n            }'+s[end:]
p.write_text(s)
MUTATE
cd apps/api
worker-build --release > /Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-fault-build.log 2>&1
cd ../..
set +e
node apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs > /Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-fault-runtime.log 2>&1
sensitivity_status=$?
set -e
printf '%s\n' "$sensitivity_status" > /Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-fault-status.txt
restore_credential_route
trap - EXIT INT TERM HUP
cd apps/api
worker-build --release > /Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-restored-build.log 2>&1
cd ../..
node apps/api/scripts/p08-cr003-credential-mode-reproducer.mjs > /Volumes/SSD/agents-cp.runlumi/test-results/credential-sensitivity-restored-runtime.log 2>&1
test "$(git rev-parse HEAD)" = "$sensitivity_head"
git diff --quiet -- apps/api/src/routes/migration.rs
git diff --cached --quiet -- apps/api/src/routes/migration.rs
