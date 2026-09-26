#!/usr/bin/env bash
# P08 structural-invariant probe.
#
# Purpose: prove that the guarantees the P08 domain makes in Rust are also
# enforced by the database, so a future writer that bypasses the domain — a new
# route, a migration, a support script — cannot quietly break them.
#
# Each case is either a statement the database MUST refuse or one it MUST
# accept. An unexpected acceptance fails this script.
#
# Run against a fresh local D1 with all sixteen migrations applied:
#   pnpm --filter @runlumi/agents-cp-api db:migrations:apply:local
#   apps/api/scripts/p08-invariants.sh
set -uo pipefail

DB="$(find apps/api/.wrangler -name '*.sqlite' -path '*D1DatabaseObject*' ! -name 'metadata.sqlite' | head -1)"
if [[ -z "$DB" ]]; then
  echo "no local D1 found; run db:migrations:apply:local first" >&2
  exit 1
fi

pass=0
fail=0
NOW='2026-09-26T00:00:00.000Z'
NOW2='2026-09-27T00:00:00.000Z'
ORG=org_000000000000000000000000000000aa
USR=usr_000000000000000000000000000000aa
PRJ=prj_000000000000000000000000000000aa
DVC=dvc_000000000000000000000000000000aa
INSTALL=0123456789abcdef-inst

# must_refuse <label> <sql>
must_refuse() {
  local label="$1" sql="$2" out
  out="$(sqlite3 "$DB" "PRAGMA foreign_keys=ON; $sql" 2>&1)"
  if [[ -n "$out" ]]; then
    printf '  refused  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  ACCEPTED %s   <-- invariant broken\n' "$label"
    fail=$((fail + 1))
  fi
}

# must_accept <label> <sql> <probe-sql>
must_accept() {
  local label="$1" sql="$2" probe="$3" out got
  out="$(sqlite3 "$DB" "PRAGMA foreign_keys=ON; $sql" 2>&1)"
  if [[ -z "$out" ]]; then
    got="$(sqlite3 "$DB" "$probe" 2>&1)"
    printf '  accepted %-52s -> %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  REFUSED  %s: %s   <-- invariant broken\n' "$label" "$out"
    fail=$((fail + 1))
  fi
}

# P08 identifiers are `<prefix>_<32 hex>`, so a two-character suffix is padded to
# the 32 the CHECK constraints require. Using a short id here would make every
# case fail on length instead of on the invariant it is actually testing.
pad() { printf '%031s%s' '' "$1" | tr ' ' '0'; }
adoption_id() { printf 'wst_%s' "$(pad "$1")"; }
remediation_id() { printf 'rem_%s' "$(pad "$1")"; }
event_id() { printf 'ase_%s' "$(pad "$1")"; }

STATE_A="$(adoption_id a)"
STATE_D="$(adoption_id d)"
EVENT_A="$(event_id a)"
EVENT_B="$(event_id b)"
EVENT_C="$(event_id c)"
REM_A="$(remediation_id a)"
REM_E="$(remediation_id e)"

# adoption <suffix> <workspace-key> <display> <project> <device> <stage> <ownership> <mode>
adoption() {
  printf "INSERT INTO workspace_adoption_states VALUES ('%s', '%s', '%s', '%s', '%s', %s, %s, '%s', '%s', '%s', NULL, 1, 1, '0.4.0', 0, 1, '%s', '%s')" \
    "$(adoption_id "$1")" "$ORG" "$INSTALL" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$NOW" "$NOW"
}

# remediation <suffix> <code> <remedy> <state> [resolved-by] [resolved-at]
remediation() {
  printf "INSERT INTO adoption_remediations VALUES ('%s', '%s', '%s', NULL, '%s', 'local_unmanaged', '%s', '%s', %s, %s, 1, '%s', '%s')" \
    "$(remediation_id "$1")" "$ORG" "$STATE_A" "$2" "$4" "$3" "${5:-NULL}" "${6:-NULL}" "$NOW" "$NOW"
}

echo "P08 structural invariants"

# --- tenant context ------------------------------------------------------
# A user, an org, a project, and an enrolled device. Nothing here is P08's own
# doing; the P08 rows are all tenant-scoped references to them. Column names
# follow the frozen P02/P03 schema, so this seed doubles as a check that P08's
# foreign keys name columns that exist.
sqlite3 "$DB" >/dev/null 2>&1 <<SQL
PRAGMA foreign_keys = ON;
INSERT INTO users (user_id, email, display_name, email_verified, version,
                   created_at, updated_at)
  VALUES ('$USR', 'p08@example.test', 'P08 Probe', 1, 1, '$NOW', '$NOW');
INSERT INTO identities (identity_id, user_id, provider, provider_subject, email,
                        email_verified, created_at)
  VALUES ('idn_000000000000000000000000000000aa', '$USR', 'password',
          'p08@example.test', 'p08@example.test', 1, '$NOW');
INSERT INTO organizations (org_id, display_name, slug, state, version,
                           created_by_user_id, created_at, updated_at)
  VALUES ('$ORG', 'P08', 'p08', 'active', 1, '$USR', '$NOW', '$NOW');
INSERT INTO license_states (license_state_id, org_id, state, version,
                            created_at, updated_at)
  VALUES ('lic_000000000000000000000000000000aa', '$ORG', 'active', 1, '$NOW', '$NOW');
INSERT INTO projects (project_id, org_id, name, slug, visibility, version,
                      created_by_user_id, created_at, updated_at)
  VALUES ('$PRJ', '$ORG', 'P08', 'p08', 'org', 1, '$USR', '$NOW', '$NOW');
INSERT INTO devices (device_id, org_id, enrolled_by_user_id, name, platform,
                     app_version, public_key, key_fingerprint, status,
                     created_at, updated_at)
  VALUES ('$DVC', '$ORG', '$USR', 'p08', 'macos-arm64', '0.4.0', 'x',
          '0000000000000000000000000000000000000000000000000000000000000000',
          'active', '$NOW', '$NOW');
SQL

# --- ownership cannot be claimed without a binding -----------------------

# An org-managed workspace with no project and no device. Without the trigger the
# organization would be governing something it cannot address.
must_refuse "org_managed with no project or device" \
  "$(adoption a 'ws-a' 'Workspace A' NULL NULL workspace_bound org_managed metadata_only)"

# A stage-0 row for a local workspace: the state of a user who has adopted
# nothing. Cloud knows the workspace exists and governs none of it.
must_accept "stage 0 for a local workspace" \
  "$(adoption a 'ws-a' 'Workspace A' NULL NULL local_unmanaged local_unmanaged local_credential)" \
  "SELECT stage || '/' || ownership || '/' || credential_mode FROM workspace_adoption_states WHERE adoption_state_id='$STATE_A';"

# The same transition reached by UPDATE, so the invariant cannot be walked around
# by patching the columns one at a time.
must_refuse "UPDATE into org_managed with no project" \
  "UPDATE workspace_adoption_states SET ownership='org_managed', stage='managed_policy' WHERE adoption_state_id='$STATE_A';"

# History sync claimed by a workspace that still runs on its own local key.
must_refuse "history_sync with a local credential" \
  "$(adoption b 'ws-b' 'Workspace B' "'$PRJ'" "'$DVC'" history_sync org_managed local_credential)"

# --- privacy: nothing about the local machine is storable -----------------

# A workspace reference carrying a filesystem path.
must_refuse "workspace key containing an absolute path" \
  "$(adoption c '/Users/someone/code' 'Workspace C' NULL NULL local_unmanaged local_unmanaged local_credential)"

# --- one adoption per local workspace ------------------------------------

must_accept "the explicit binding stage" \
  "$(adoption d 'ws-d' 'Workspace D' "'$PRJ'" "'$DVC'" workspace_bound org_managed local_credential)" \
  "SELECT stage || '/' || ownership FROM workspace_adoption_states WHERE adoption_state_id='$STATE_D';"

# The same workspace a second time. This is what makes a silent double adoption
# into two projects impossible.
must_refuse "the same local workspace adopted twice" \
  "$(adoption e 'ws-d' 'Workspace D again' "'$PRJ'" "'$DVC'" workspace_bound org_managed local_credential)"

# --- the rollback the domain performs ------------------------------------

# Stage 0, local credential, binding cleared, the stage it came from retained,
# and the reversion counted. All in one statement, because that is what the route
# issues, and a partial rollback would leave an org claiming a workspace it no
# longer governs.
must_accept "the rollback" \
  "UPDATE workspace_adoption_states SET stage='local_unmanaged', ownership='local_unmanaged', credential_mode='local_credential', rolled_back_from_stage='workspace_bound', bound_project_id=NULL, bound_device_id=NULL, reversion_count=reversion_count+1, version=version+1, updated_at='$NOW2' WHERE adoption_state_id='$STATE_D';" \
  "SELECT stage || '/' || rolled_back_from_stage || '/reversions=' || reversion_count || '/v' || version FROM workspace_adoption_states WHERE adoption_state_id='$STATE_D';"

# --- remediation state ---------------------------------------------------

must_accept "the first open remediation" \
  "$(remediation a 'client_outdated' upgrade_client open NULL NULL)" \
  "SELECT code || '/' || remedy FROM adoption_remediations WHERE remediation_id='$REM_A';"
must_refuse "a second open remediation for the same state and code" \
  "$(remediation b 'client_outdated' upgrade_client open NULL NULL)"

# A half-resolved row would make "who fixed this" unanswerable.
must_refuse "a resolved remediation with no resolution time" \
  "$(remediation c 'workspace_unbound' rebind_workspace resolved NULL NULL)"
must_refuse "an open remediation that claims a resolver" \
  "$(remediation d 'workspace_unbound' rebind_workspace open "'$USR'" '$NOW')"

# Resolving, then re-remediating, is allowed: a fixed workspace that breaks again
# should be reportable again.
must_accept "a re-remediation after the first was resolved" \
  "UPDATE adoption_remediations SET state='resolved', resolved_by_user_id='$USR', resolved_at='$NOW', updated_at='$NOW', version=version+1 WHERE remediation_id='$REM_A';
   $(remediation e 'client_outdated' upgrade_client open NULL NULL)" \
  "SELECT COUNT(*) || ' open' FROM adoption_remediations WHERE adoption_state_id='$STATE_A' AND state='open';"

# --- telemetry measures the migration, not the user ----------------------

must_accept "a stage/result report with a vocabulary reason" \
  "INSERT INTO adoption_stage_events VALUES ('$EVENT_A', '$ORG', '$STATE_A', NULL, NULL, 'workspace_bound', 'declined', 'consent_required', 1, 1, '0.4.0', '$NOW', '$NOW');" \
  "SELECT stage || '/' || result || '/' || reason_code FROM adoption_stage_events WHERE adoption_event_id='$EVENT_A';"

# A reason outside the frozen vocabulary is refused, which is what stops an
# error message from becoming a content channel.
must_refuse "a telemetry reason that is free text" \
  "INSERT INTO adoption_stage_events VALUES ('$EVENT_B', '$ORG', NULL, NULL, NULL, 'device_enrolled', 'completed', 'the user asked me to fix auth', NULL, NULL, NULL, '$NOW', '$NOW');"
must_refuse "a telemetry reason containing a path" \
  "INSERT INTO adoption_stage_events VALUES ('$EVENT_C', '$ORG', NULL, NULL, NULL, 'device_enrolled', 'completed', 'C_users_someone', NULL, NULL, NULL, '$NOW', '$NOW');"

# And there is no column to abuse in the first place. This is the strongest form
# of the privacy invariant: it does not depend on any handler being careful.
columns="$(sqlite3 "$DB" "PRAGMA table_info(adoption_stage_events);" | cut -d'|' -f2 | tr '\n' ' ')"
if [[ "$columns" == *prompt* || "$columns" == *file* || "$columns" == *path* || "$columns" == *content* || "$columns" == *secret* || "$columns" == *key* ]]; then
  printf '  BROKEN  adoption_stage_events has a content-shaped column: %s\n' "$columns"
  fail=$((fail + 1))
else
  printf '  ok      adoption_stage_events has no content-shaped column (%s)\n' "$columns"
  pass=$((pass + 1))
fi

echo
echo "passed: $pass  failed: $fail"
[[ "$fail" -eq 0 ]]
