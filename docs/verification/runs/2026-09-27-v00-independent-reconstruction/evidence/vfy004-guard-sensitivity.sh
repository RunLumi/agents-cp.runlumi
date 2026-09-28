#!/bin/sh
# Prove apps/api/scripts/p02-guard-probe.mjs can fail. A probe that only ever
# passes is not evidence, and VFY-004 is a case where the verifier and the defect
# shared a wrong assumption: both keyed off the same substring.
set -e
cd /Volumes/SSD/agents-cp.runlumi
SRC=apps/api/src/core/idempotency.rs
cp "$SRC" /private/var/folders/zz/jzz3w1rj5lq21d_7c0nkc31m0000gn/T/opencode/idempotency-good.rs
restore() { cp /private/var/folders/zz/jzz3w1rj5lq21d_7c0nkc31m0000gn/T/opencode/idempotency-good.rs "$SRC"; }

echo "=== baseline ==="
node apps/api/scripts/p02-guard-probe.mjs 2>&1 | tail -2

echo
echo "=== MUTATION 1: the pre-0020 text, with the 0020 trigger text removed ==="
echo "    (exactly the VFY-004 defect: recogniser unaware of the trigger)"
python3 -c "
import pathlib
p = pathlib.Path('apps/api/src/core/idempotency.rs')
s = p.read_text()
s = s.replace('    \"a pending idempotency record carries no result and must hold a claim token\",\n', '')
p.write_text(s)
"
node apps/api/scripts/p02-guard-probe.mjs 2>&1 | grep -E "FAIL|guard cases hold" | head -6 || true
restore

echo
echo "=== MUTATION 2: the pre-0020 text removed, trigger text kept ==="
python3 -c "
import pathlib
p = pathlib.Path('apps/api/src/core/idempotency.rs')
s = p.read_text()
s = s.replace('    \"NOT NULL constraint failed: idempotency_records.principal_id\",\n', '')
p.write_text(s)
"
node apps/api/scripts/p02-guard-probe.mjs 2>&1 | grep -E "FAIL|guard cases hold" | head -6 || true
restore

echo
echo "=== MUTATION 3: the old over-broad matcher, verbatim ==="
python3 -c "
import pathlib, re
p = pathlib.Path('apps/api/src/core/idempotency.rs')
s = p.read_text()
s = re.sub(r'const GUARD_ABORT_TEXTS: &\[&str\] = &\[[\s\S]*?\n\];', 'const GUARD_ABORT_TEXTS: &[&str] = &[\"constraint\"];', s, count=1)
p.write_text(s)
"
node apps/api/scripts/p02-guard-probe.mjs 2>&1 | grep -E "FAIL|guard cases hold" | head -8 || true
restore

echo
echo "=== MUTATION 4: the list emptied, so no guard is ever recognised ==="
python3 -c "
import pathlib, re
p = pathlib.Path('apps/api/src/core/idempotency.rs')
s = p.read_text()
s = re.sub(r'const GUARD_ABORT_TEXTS: &\[&str\] = &\[[\s\S]*?\n\];', 'const GUARD_ABORT_TEXTS: &[&str] = &[];', s, count=1)
p.write_text(s)
"
node apps/api/scripts/p02-guard-probe.mjs 2>&1 | grep -E "FAIL|guard cases hold" | head -8 || true
restore

echo
echo "=== MUTATION 5: the pre-0020 entry widened back to the whole table ==="
python3 -c "
import pathlib
p = pathlib.Path('apps/api/src/core/idempotency.rs')
s = p.read_text()
s = s.replace('\"NOT NULL constraint failed: idempotency_records.principal_id\"', '\"NOT NULL constraint failed: idempotency_records.\"')
p.write_text(s)
"
node apps/api/scripts/p02-guard-probe.mjs 2>&1 | grep -E "FAIL|guard cases hold" | head -6 || true
restore

echo
echo "=== restored ==="
node apps/api/scripts/p02-guard-probe.mjs 2>&1 | tail -2
cargo test -p lumi-agents-control-plane-api --lib core::idempotency 2>&1 | tail -2
