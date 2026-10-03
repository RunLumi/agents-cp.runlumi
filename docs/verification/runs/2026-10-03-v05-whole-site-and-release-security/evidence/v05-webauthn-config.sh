#!/usr/bin/env bash
# V05 §1 — the WebAuthn configuration in force, measured at runtime.
#
# Scenario A: the candidate's own production env (apps/api/wrangler.jsonc),
#             which now carries WEBAUTHN_RP_ID / WEBAUTHN_RP_NAME /
#             WEBAUTHN_ORIGINS / EMAIL_FROM. The Worker must issue passkey
#             ceremonies naming the deployed rp.id — the converged config is
#             live, not silently absent.
# Scenario B: an explicitly EMPTY WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS, which
#             constructs `state.webauthn = None` (the state a non-development
#             deployment reaches when the vars are missing). The passkey route
#             must answer 503 `service_unavailable` with
#             `details.reason = "passkeys_not_configured"` and a message about
#             passkeys — NOT the identity-store wording that a D1 outage
#             produces, which is what this route answered before V05-001's
#             repair. The same Worker must answer /api/health 200 and a
#             password route 401, proving the identity store is actually fine
#             and the two causes no longer look the same.
#
# Exit codes: 0 = both scenarios hold; 1 = a check did not hold;
#             2 = the harness could not run (port held, wrangler failed).
set -uo pipefail

REPO="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)"
API="$REPO/apps/api"
LOG_DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%S)"
RUN_LOG="$LOG_DIR/v05-webauthn-config-$STAMP.log"

# The toolchain entry points this machine actually has (see AGENTS.md and the
# V0x records: default node is 22, the repo needs 24; cargo must be the rustup
# shim or the wasm link crashes).
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$HOME/.lumi-tools/bin:$HOME/.cargo/bin:$PATH"
WRANGLER="$API/node_modules/.bin/wrangler"

PIDS=()
persist_a=""
persist_b=""

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  sleep 1
  for pid in "${PIDS[@]:-}"; do kill -9 "$pid" 2>/dev/null; done
  [ -n "$persist_a" ] && rm -rf "$persist_a"
  [ -n "$persist_b" ] && rm -rf "$persist_b"
  [ -n "$V05_WAC_STATUS" ] && rm -f "$V05_WAC_STATUS"
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM
trap 'cleanup; trap - EXIT; exit 129' HUP

say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$RUN_LOG"; }
fail_check() { say "FAIL $*"; FAILED=1; }
FAILED=0

# --- harness preconditions (exit 2 territory) ---------------------------------
if [ ! -x "$WRANGLER" ]; then
  say "FATAL: wrangler not found at $WRANGLER — run pnpm install first"
  exit 2
fi
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  :
else
  say "FATAL: node >= 24 not first on PATH (found: $(node --version 2>/dev/null || echo none))"
  exit 2
fi
# A held port hangs wrangler dev rather than erroring (V04's 1h35m lesson), so
# the ports this run will bind are checked before anything starts, and any
# stray dev server from an earlier probe is fatal here rather than a race.
for port in "$@"; do :; done # (no fixed ports; free ports are allocated below)
if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  say "FATAL: something is already listening on 8787 — kill the stray dev server first"
  exit 2
fi

free_port() {
  node -e '
    const net = require("net");
    const s = net.createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => console.log(p)); });
  '
}

start_worker() { # $1 persist dir, $2 port, remaining args passed to wrangler
  local persist="$1" port="$2"; shift 2
  (cd "$API" && "$WRANGLER" dev --local --port "$port" --persist-to "$persist" \
    --show-interactive-dev-session=false "$@" >> "$RUN_LOG" 2>&1) &
  PIDS+=($!)
}

await_health() { # $1 port — up to 120s; a warm build is ~15s, a cold one minutes
  local port="$1"
  for _ in $(seq 1 120); do
    if curl -sS -m 2 "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# post() prints the response body and writes the HTTP status code to
# $V05_WAC_STATUS — command substitution runs in a subshell, so a variable set
# here could not reach the caller any other way.
V05_WAC_STATUS="$(mktemp /tmp/v05-wac-status.XXXXXX)"
post() { # $1 port, $2 path, $3 json body
  curl -sS -m 10 -o /tmp/v05-wac-body.$$ -w "%{http_code}" \
    -X POST -H 'Content-Type: application/json' -d "$3" "http://127.0.0.1:$1$2" \
    > "$V05_WAC_STATUS"
  cat /tmp/v05-wac-body.$$
  rm -f /tmp/v05-wac-body.$$
}

# --- Scenario A: the converged production env ---------------------------------
say "scenario A: production env (with WEBAUTHN_* vars) issues ceremonies for the deployed rp.id"
persist_a="$(mktemp -d /tmp/v05-wac-a.XXXXXX)"
PORT_A="$(free_port)"
(cd "$API" && "$WRANGLER" d1 migrations apply DB --local --env production \
  --persist-to "$persist_a" >> "$RUN_LOG" 2>&1) || { say "FATAL: migrations failed"; exit 2; }
start_worker "$persist_a" "$PORT_A" --env production
await_health "$PORT_A" || { say "FATAL: scenario A worker never became healthy (see $RUN_LOG)"; exit 2; }

body="$(post "$PORT_A" /api/v1/auth/passkey/login/start '{}')"
STATUS="$(cat "$V05_WAC_STATUS")"
if [ "$STATUS" = "201" ]; then
  say "PASS  production-env login/start answers 201"
else
  fail_check "production-env login/start expected 201, got $STATUS: $body"
fi
if echo "$body" | grep -q '"rpId":"agents-cp.runlumi.app"'; then
  say "PASS  production-env ceremony names the deployed rp.id"
else
  fail_check "production-env ceremony does not name agents-cp.runlumi.app: $body"
fi
kill "${PIDS[${#PIDS[@]}-1]}" 2>/dev/null; sleep 2

# --- Scenario B: no adapter must answer unambiguously --------------------------
say "scenario B: empty WEBAUTHN_* constructs no adapter; the route must say passkeys, not identity store"
persist_b="$(mktemp -d /tmp/v05-wac-b.XXXXXX)"
PORT_B="$(free_port)"
(cd "$API" && "$WRANGLER" d1 migrations apply DB --local --env development \
  --persist-to "$persist_b" >> "$RUN_LOG" 2>&1) || { say "FATAL: migrations failed"; exit 2; }
start_worker "$persist_b" "$PORT_B" --env development \
  --var "WEBAUTHN_RP_ID:" --var "WEBAUTHN_ORIGINS:"
await_health "$PORT_B" || { say "FATAL: scenario B worker never became healthy (see $RUN_LOG)"; exit 2; }

body="$(post "$PORT_B" /api/v1/auth/passkey/login/start '{}')"
STATUS="$(cat "$V05_WAC_STATUS")"
if [ "$STATUS" = "503" ]; then
  say "PASS  no-adapter login/start answers 503"
else
  fail_check "no-adapter login/start expected 503, got $STATUS: $body"
fi
if echo "$body" | grep -q '"reason":"passkeys_not_configured"'; then
  say "PASS  no-adapter refusal names passkeys_not_configured"
else
  fail_check "no-adapter refusal does not name passkeys_not_configured: $body"
fi
if echo "$body" | grep -q 'Passkeys are not configured'; then
  say "PASS  no-adapter refusal message is about passkeys, not the identity store"
else
  fail_check "no-adapter refusal message still says identity store: $body"
fi

health="$(curl -sS -m 5 "http://127.0.0.1:$PORT_B/api/health")"
if echo "$health" | grep -q '"status":"ok"'; then
  say "PASS  the same Worker reports health ok, so the store is not down"
else
  fail_check "the no-adapter Worker does not report health ok: $health"
fi
STATUS=$(curl -sS -m 10 -o /tmp/v05-wac-pw.$$ -w "%{http_code}" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"email":"v05@probe.invalid","password":"not-the-password"}' \
  "http://127.0.0.1:$PORT_B/api/v1/auth/password/login")
pw="$(cat /tmp/v05-wac-pw.$$ 2>/dev/null)"; rm -f /tmp/v05-wac-pw.$$
if [ "$STATUS" = "401" ]; then
  say "PASS  the password route answers a normal 401, so a passkey refusal can be told apart from a store outage"
else
  fail_check "password route expected a normal 401, got $STATUS: $pw"
fi

# --- verdict -------------------------------------------------------------------
if [ "$FAILED" = "0" ]; then
  say "ALL CHECKS PASSED"
  exit 0
fi
say "CHECKS FAILED"
exit 1
