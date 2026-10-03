#!/usr/bin/env bash
# V05 §2 (repair) — verify:observability under the setup it documents.
#
# The probe reads D1 from the DEFAULT persist location (apps/api/.wrangler/state)
# and the worker's stdout for the request-log legs, so it must run against a
# Worker started WITHOUT --persist-to, migrated, with stdout captured and
# OBS_LOG pointing at the capture. The first sweep attempt failed "fetch
# failed" (no Worker); a later rerun against a --persist-to Worker graded an
# empty database — both harness-setup gaps, recorded as such.
set -uo pipefail

EVIDENCE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$EVIDENCE" && git rev-parse --show-toplevel)"
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$HOME/.lumi-tools/bin:$HOME/.cargo/bin:$PATH"
export npm_config_store_dir=/Volumes/SSD/.pnpm-store-v12
PNPM="$HOME/.lumi-tools/bin/pnpm"
WRANGLER="$REPO/apps/api/node_modules/.bin/wrangler"
WORKER_LOG="$EVIDENCE/v05-observability-worker.log"
WORKER_PID=""

cleanup() {
  [ -n "$WORKER_PID" ] && kill "$WORKER_PID" 2>/dev/null
  sleep 1
  [ -n "$WORKER_PID" ] && kill -9 "$WORKER_PID" 2>/dev/null
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM

if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FATAL: 8787 is held — kill the stray dev server first"
  exit 2
fi

# Fresh DEFAULT state (the archived-variant ledger note in the repo memory is
# why this starts clean rather than trusting what is there).
rm -rf "$REPO/apps/api/.wrangler/state"
(cd "$REPO/apps/api" && "$WRANGLER" d1 migrations apply DB --local >> "$WORKER_LOG" 2>&1) || {
  echo "FATAL: migrations failed"
  exit 2
}
(cd "$REPO/apps/api" && "$WRANGLER" dev --env development --local --port 8787 \
  --show-interactive-dev-session=false >> "$WORKER_LOG" 2>&1) &
WORKER_PID=$!
for _ in $(seq 1 120); do
  curl -sS -m 2 http://127.0.0.1:8787/api/health 2>/dev/null | grep -q '"ok"' && break
  sleep 1
done
curl -sS -m 2 http://127.0.0.1:8787/api/health 2>/dev/null | grep -q '"ok"' || {
  echo "FATAL: worker never became healthy"
  exit 2
}

( cd "$REPO" && OBS_LOG="$WORKER_LOG" eval "$PNPM verify:observability" ) \
  > "$EVIDENCE/v05-gate-observability-final.log" 2>&1
code=$?
echo "verify:observability exit=$code"
exit "$code"
