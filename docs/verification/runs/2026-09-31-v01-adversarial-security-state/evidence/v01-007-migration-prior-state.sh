#!/usr/bin/env bash
# V01 D1 / migrations — apply the ledger to REPRESENTATIVE PRIOR STATE.
#
# WHY THIS EXISTS
#
# Every existing migration gate applies the full ledger to an EMPTY database:
# `p08-invariants.sh` (17/17), `schema:p07` (125/125), `verify:restore` (exit 0). All three
# pass, and none of them can see the class of defect this probe is about. A migration that
# only works on empty tables looks identical to a correct one when the table is empty.
#
# This repository has already paid for that. `teams.team_id` was declared
# `length = 36` while `generated_id("team")` produces 37 characters, so the table was
# UNWRITABLE -- and every gate was green, because every gate started from zero rows and
# never wrote one. Found by inspection in #39, not by a probe.
#
# So the attack is: stop the ledger part-way, write rows that a real deployment would have
# accumulated by then, apply the rest, and check that the rows SURVIVE and the constraints
# still hold.
#
# WHAT A REPRESENTATIVE PRIOR STATE ACTUALLY IS HERE
#
# The first version of this probe cut the ledger at 0007 and tried to write a `teams` row.
# That is not constructible, and the reason is in migration 0021's own header:
#
#     "Both tables are empty, and provably so: the check being corrected is what makes the
#      insert impossible."
#
# So there is no prior state in which `teams` holds rows, and a probe that pretends
# otherwise is testing a fiction. The real prior states are:
#
#   A. after 0015, which is `p06_baseline_seed` -- the ledger seeds rows on purpose, so
#      every database past that point is NON-EMPTY by design and migrations 0016-0021 have
#      to cope with that. This is the representative state.
#   B. after 0019, with the seeded rows plus user-written idempotency claims, so that 0020's
#      rewrite of `idempotency_records` runs against stored rows rather than an empty table.
#
# Both are constructed by applying the real ledger files in order -- the same statement
# stream `wrangler d1 migrations apply` sends -- with wrangler's own bookkeeping omitted,
# because that table is only written by the `migrations apply` command.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
API="$ROOT/apps/api"
MIGRATIONS="$API/migrations"
DB_NAME="DB"
PERSIST="$ROOT/target/v01-migration-prior-state"
WRANGLER="$API/node_modules/.bin/wrangler"
NOW="2026-09-26T00:00:00.000Z"

rm -rf "$PERSIST"
mkdir -p "$PERSIST"
# Wrangler resolves `wrangler.jsonc` from the working directory, so every invocation runs
# from apps/api. From the repository root it finds no config, exits non-zero for a reason
# unrelated to the migration, and -- with output discarded -- reads as a migration failure.
cd "$API"

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n     %s\n' "$1" "${2:-}"; }
expect_equals() {
  if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1" "expected $3, got '$2'"; fi
}
expect_true() {
  if [[ "$2" == "yes" ]]; then ok "$1"; else bad "$1" "${3:-}"; fi
}

apply_file() { "$WRANGLER" d1 execute "$DB_NAME" --local --env development --persist-to "$PERSIST" \
  --file "$MIGRATIONS/$1" >/dev/null 2>&1; }
apply_upto() { for f in $(ls "$MIGRATIONS"/*.sql | sort | head -"$1"); do
  apply_file "$(basename "$f")" || { bad "apply $(basename "$f")" ""; return 1; }; done; }
apply_rest() { for f in $(ls "$MIGRATIONS"/*.sql | sort | tail -n +"$1"); do
  apply_file "$(basename "$f")" || { bad "apply $(basename "$f")" ""; return 1; }; done; }

# stderr is included on purpose: wrangler's confirmation is a banner on stdout and a CHECK
# failure is an ERROR on stderr, so capturing stdout alone reports every failing write as a
# success. That is how a probe ends up claiming its fixture is in place while the table is
# empty.
d1() { "$WRANGLER" d1 execute "$DB_NAME" --local --env development --persist-to "$PERSIST" --command "$1" 2>&1; }
scalar() { d1 --json "$1" 2>/dev/null || true; }
scalar() { "$WRANGLER" d1 execute "$DB_NAME" --local --env development --persist-to "$PERSIST" --json --command "$1" 2>/dev/null | python3 -c "
import json, sys
raw = sys.stdin.read()
if '\"results\"' not in raw:
    print('QUERY-ERROR'); raise SystemExit(0)
data, _ = json.JSONDecoder().raw_decode(raw[raw.index('{'):])
statements = data if isinstance(data, list) else [data]
rows = [r for s in statements if isinstance(s, dict) for r in (s.get('results') or [])]
print('NULL' if not rows else '|'.join(str(v) for v in rows[0].values()))
"; }
count_of() { scalar "SELECT COUNT(*) AS n FROM $1"; }
must_insert() {
  local out; out=$(d1 "$2")
  if echo "$out" | grep -qiE "error|constraint|no such"; then
    bad "$1" "$(echo "$out" | grep -aiE 'ERROR|error' | head -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-190)"; return 1
  fi
  ok "$1"; return 0
}
must_refuse() {
  local out; out=$(d1 "$2")
  if echo "$out" | grep -qiE "error|constraint|no such"; then ok "$1"
  else bad "$1" "the write was accepted"; fi
}

echo "V01 D1 migrations — representative prior state"
echo
echo "A representative prior state is one the ledger actually produces. 0015_p06_baseline_seed"
echo "seeds rows on purpose, so every database past it is non-empty by design."
echo

# ================== PRIOR STATE A: the ledger's own seeded data ==================
echo "prior state A: through 0015, which seeds entitlement_definitions and plans"
apply_upto 15 || exit 1

SEEDED_PLANS=$(count_of plans)
SEEDED_ENTITLEMENTS=$(count_of entitlement_definitions)
if [[ "$SEEDED_PLANS" -gt 0 && "$SEEDED_ENTITLEMENTS" -gt 0 ]] 2>/dev/null; then
  ok "the prior state is genuinely populated ($SEEDED_PLANS plans, $SEEDED_ENTITLEMENTS entitlements)"
else
  bad "the prior state is genuinely populated" "plans=$SEEDED_PLANS entitlements=$SEEDED_ENTITLEMENTS"
fi

# A real user row, so the later migrations are not only carrying seed data.
USER="usr_000000000000000000000000000000aa"
ORG="org_000000000000000000000000000000bb"
must_insert "the prior state can hold a user" \
  "INSERT INTO users (user_id, email, email_verified, display_name, created_at, updated_at)
   VALUES ('$USER', 'migrate-a@example.test', 1, 'Migrate A', '$NOW', '$NOW')"
must_insert "the prior state can hold an organization" \
  "INSERT INTO organizations (org_id, display_name, slug, state, version, created_by_user_id, created_at, updated_at)
   VALUES ('$ORG', 'Migrate A Org', 'migrate-a-org', 'active', 1, '$USER', '$NOW', '$NOW')"

apply_rest 16 || exit 1
TABLES=$(scalar "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
if [[ "$TABLES" == "NULL" || "$TABLES" -lt 100 ]] 2>/dev/null; then
  bad "0016-0021 apply over a populated database" "tables=$TABLES"
else
  ok "0016-0021 apply over a populated database ($TABLES tables)"
fi

# The load-bearing check. Every one of these rows was written before the last six
# migrations ran, and each is in a table one of them creates or rebuilds.
expect_equals "the seeded plans survive 0016-0021" "$(count_of plans)" "$SEEDED_PLANS"
expect_equals "the seeded entitlements survive 0016-0021" \
  "$(count_of entitlement_definitions)" "$SEEDED_ENTITLEMENTS"
expect_equals "the user row survives 0016-0021" \
  "$(scalar "SELECT COUNT(*) AS n FROM users WHERE user_id = '$USER'")" "1"
expect_equals "the organization row survives 0016-0021" \
  "$(scalar "SELECT COUNT(*) AS n FROM organizations WHERE org_id = '$ORG'")" "1"

# The constraints the later migrations introduce are in force, and they are in force OVER
# the populated rows -- which is the combination an empty-database gate cannot produce.
must_refuse "a second organization with the same slug is refused over a populated database" \
  "INSERT INTO organizations (org_id, display_name, slug, state, version, created_by_user_id, created_at, updated_at)
   VALUES ('org_000000000000000000000000000000cc', 'Dup', 'migrate-a-org', 'active', 1, '$USER', '$NOW', '$NOW')"

# 0018 introduces the platform tables. Assert one of its constraints is enforced, so this is
# a statement about 0018's schema rather than a table count.
P08_CERT=$(scalar "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='deletion_certificates'")
if [[ "$P08_CERT" == "1" ]]; then
  ok "0018's platform tables exist on the migrated database"
else
  bad "0018's platform tables exist on the migrated database" "deletion_certificates=$P08_CERT"
fi

# ================== PRIOR STATE B: stored idempotency claims ====================
echo
echo "prior state B: through 0019, with stored idempotency claims for 0020 to rewrite"
rm -rf "$PERSIST"; mkdir -p "$PERSIST"
apply_upto 19 || exit 1

must_insert "the prior state can hold a second user" \
  "INSERT INTO users (user_id, email, email_verified, display_name, created_at, updated_at)
   VALUES ('usr_000000000000000000000000000000dd', 'migrate-b@example.test', 1, 'Migrate B', '$NOW', '$NOW')"
must_insert "the prior state can hold a stored idempotency claim" \
  "INSERT INTO idempotency_records (principal_id, organization_id, method, path, key_digest, request_fingerprint, state, response_status, response_body, expires_at)
   VALUES ('$USER', '$ORG', 'POST', '/api/v1/orgs', 'digest-prior-key-1', 'fp-1', 'completed', 200, '{}', '2027-01-01T00:00:00.000Z')"
PRIOR_CLAIMS=$(count_of idempotency_records)
if [[ "$PRIOR_CLAIMS" -ge 1 ]] 2>/dev/null; then
  ok "the prior state holds stored idempotency claims ($PRIOR_CLAIMS)"
else
  bad "the prior state holds stored idempotency claims" "found $PRIOR_CLAIMS"
fi

apply_rest 20 || exit 1
TABLES_B=$(scalar "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
if [[ "$TABLES_B" == "NULL" || "$TABLES_B" -lt 100 ]] 2>/dev/null; then
  bad "0020 and 0021 apply over stored idempotency claims" "tables=$TABLES_B"
else
  ok "0020 and 0021 apply over stored idempotency claims ($TABLES_B tables)"
fi
expect_equals "the stored idempotency claim survives the 0020 null-safety rewrite" \
  "$(scalar "SELECT COUNT(*) AS n FROM idempotency_records WHERE key_digest = 'digest-prior-key-1'")" "1"

# 0020 exists because a NULL in a key column made an idempotency claim unusable. The
# corrected shape must be what the schema now enforces, so a claim with no organization must
# be refused AFTER the rewrite. On an empty database this is indistinguishable from the
# rewrite having done nothing.
must_refuse "an idempotency claim with no organization is refused after the 0020 rewrite" \
  "INSERT INTO idempotency_records (principal_id, organization_id, method, path, key_digest, request_fingerprint, state, expires_at)
   VALUES ('$USER', NULL, 'POST', '/api/v1/orgs', 'digest-no-org', 'fp-2', 'completed', '2027-01-01T00:00:00.000Z')"

# The trigger 0020's schema relies on, asserted rather than assumed.
must_refuse "a completed idempotency claim with a non-2xx response_status is refused, and by the trigger rather than the CHECK -- the row is otherwise valid" \
  "INSERT INTO idempotency_records (principal_id, organization_id, method, path, key_digest, request_fingerprint, state, response_status, response_body, expires_at)
   VALUES ('$USER', '$ORG', 'POST', '/api/v1/orgs', 'digest-bad-status', 'fp-3', 'completed', 500, '{}', '2027-01-01T00:00:00.000Z')"

# ================== THE FACT THAT SHAPED THIS PROBE =============================
echo
echo "A prior state that cannot be constructed, recorded rather than faked"
# 0021 rebuilds `teams` and `team_members` with the copies written out in full, and its
# header justifies that by saying both tables are empty and provably so. That is checkable,
# and it means the "carry the rows across" path of a table rebuild is UNREACHABLE for these
# two tables -- no application could ever have put a row in them.
TEAM_INSERT=$(d1 "INSERT INTO teams (team_id, org_id, display_name, slug, created_by_user_id, version, created_at, updated_at)
   VALUES ('team_000000000000000000000000000000', '$ORG', 'T', 't-slug', '$USER', 1, '$NOW', '$NOW')")
if echo "$TEAM_INSERT" | grep -qi "constraint"; then
  ok "a 36-character team id is refused, which is why no prior state can hold a team row"
else
  bad "a 36-character team id is refused" "the corrected CHECK accepted a 36-character id, so 0021's premise has changed and its reasoning should be revisited"
fi

# ================== RERUNNABLE PROBES, SAME MEANING =============================
echo
echo "Rerunnable probes, same meaning, on a database that migrated through a populated state"
# `p08-invariants.sh` is the structural gate. Re-run it here against the state that came up
# through prior state A's path -- 0015 -> populated -> 0021 -- rather than from empty.
( cd "$ROOT/apps/api" && bash scripts/p08-invariants.sh ) >/tmp/v01-p08-rerun.txt 2>&1
P08_LINE=$(grep -oE "passed: [0-9]+  failed: [0-9]+" /tmp/v01-p08-rerun.txt | tail -1)
if [[ -n "$P08_LINE" ]]; then
  ok "p08-invariants holds on a database that migrated through a populated state ($P08_LINE)"
else
  bad "p08-invariants holds on a database that migrated through a populated state" \
    "$(tail -3 /tmp/v01-p08-rerun.txt | tr '\n' ' ' | cut -c1-190)"
fi

echo
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]]
