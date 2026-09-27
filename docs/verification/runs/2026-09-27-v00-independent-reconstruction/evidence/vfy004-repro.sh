#!/usr/bin/env bash
# VFY-004 reproducer: the deliberate guard sentinel's abort text changed when
# migration 0020 added a BEFORE INSERT trigger, and `is_guard_violation` matches
# the pre-0020 text only.
#
#   pre-0020  : NOT NULL constraint failed: idempotency_records.principal_id
#   post-0020 : a pending idempotency record carries no result and must hold a
#               claim token: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)
#
# The matcher, unchanged across both:
#   detail.contains("NOT NULL") || detail.contains("constraint")
#
# Run after `pnpm db:migrate:local` and with the dev Worker (or any D1) available.
set -uo pipefail
cd /Volumes/SSD/agents-cp.runlumi
SCRATCH="${TMPDIR:-/tmp}/vfy-004"
SENTINEL="INSERT INTO idempotency_records (principal_id, organization_id, method, path, key_digest, request_fingerprint, state, response_status, response_body, expires_at, claim_token) SELECT NULL, '', '', '', '', '', 'pending', NULL, NULL, '', NULL WHERE NOT EXISTS (SELECT 1 FROM budget_reservations WHERE reservation_id='nope');"

printf -- '--- A. the real local D1, migrations 0001..0020 -------------------------\n'
DB="$(find apps/api/.wrangler -name '*.sqlite' -path '*D1DatabaseObject*' ! -name 'metadata.sqlite' 2>/dev/null | head -1)"
if [ -z "$DB" ]; then
  echo 'no local D1 found; run pnpm db:migrate:local first' >&2
  exit 1
fi
echo "DB=$DB"
printf '$ wrangler d1 execute DB --local --env development --command "<sentinel>"\n'
(cd apps/api && ./node_modules/.bin/wrangler d1 execute DB --local --env development --command "$SENTINEL") 2>&1 \
  | grep -E 'ERROR|error' | sed 's/\x1b\[[0-9;]*m//g'

printf -- '\n--- B. the same statement against 0001..0019 only -----------------------\n'
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
OLD="$SCRATCH/pre0020.sqlite"
for f in apps/api/migrations/00*.sql; do
  case "$(basename "$f")" in 0020_*) continue ;; esac
  sqlite3 "$OLD" < "$f" 2>/dev/null
done
printf '$ sqlite3 pre0020.sqlite "<sentinel>"\n'
sqlite3 "$OLD" "$SENTINEL" 2>&1 | sed 's/^/  /'

printf -- '\n--- C. the matcher ---------------------------------------------------\n'
sed -n '980,992p' apps/api/src/repositories/automations.rs
printf '\n$ sed -n "252,256p" apps/api/src/routes/usage.rs\n'
sed -n '252,256p' apps/api/src/routes/usage.rs

printf -- '\n--- D. end to end through the real Worker -----------------------------\n'
printf '$ node apps/api/scripts/p05-smoke.mjs   (fresh local D1, own Worker)\n'
printf '  see evidence/browser-probe-run.log siblings: 175 checks passed, 1 failed\n'
printf '  FAIL  internal reservation endpoint replays the managed hold -- status=503 reason=none\n'

printf -- '\n--- E. guard sentinel statements that share the mechanism ---------------\n'
grep -rn 'INSERT INTO idempotency_records' apps/api/src/repositories/*.rs | sed 's/:.*//' | sort | uniq -c
rm -rf "$SCRATCH"
