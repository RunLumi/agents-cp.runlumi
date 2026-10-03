#!/usr/bin/env bash
# V05 §2 (repair) — the four per-phase surface smokes need a live Worker on
# :8787 (AGENTS.md's runtime-proof table says so: "a Worker on :8787"). The
# first sweep execution ran them cold and they answered ECONNREFUSED — a
# harness-setup gap, not a product statement. This script starts the Worker,
# runs the smokes, and stops it.
set -uo pipefail

EVIDENCE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$EVIDENCE" && git rev-parse --show-toplevel)"
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$HOME/.lumi-tools/bin:$HOME/.cargo/bin:$PATH"
export npm_config_store_dir=/Volumes/SSD/.pnpm-store-v12
PNPM="$HOME/.lumi-tools/bin/pnpm"
WRANGLER="$REPO/apps/api/node_modules/.bin/wrangler"

FAILED=0
WORKER_PID=""
cleanup() {
  [ -n "$WORKER_PID" ] && kill "$WORKER_PID" 2>/dev/null
  sleep 1
  [ -n "$WORKER_PID" ] && kill -9 "$WORKER_PID" 2>/dev/null
  [ -n "$WORKER_PID" ] && rm -rf "$PERSIST"
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM

if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FATAL: something is already listening on 8787"
  exit 2
fi

PERSIST="$(mktemp -d /tmp/v05-smoke-8787.XXXXXX)"
# A fresh persist directory has no schema; without the migration ledger every
# signup answers the identity-store 503 and the smokes fail for a reason that
# has nothing to do with them.
(cd "$REPO/apps/api" && "$WRANGLER" d1 migrations apply DB --local \
  --persist-to "$PERSIST" >> "$EVIDENCE/v05-smoke-worker.log" 2>&1) || {
  echo "FATAL: migrations failed for the smoke worker"
  exit 2
}
(cd "$REPO/apps/api" && "$WRANGLER" dev --env development --local --port 8787 \
  --persist-to "$PERSIST" --show-interactive-dev-session=false > "$EVIDENCE/v05-smoke-worker.log" 2>&1) &
WORKER_PID=$!
for _ in $(seq 1 120); do
  curl -sS -m 2 http://127.0.0.1:8787/api/health 2>/dev/null | grep -q '"ok"' && break
  sleep 1
done
if ! curl -sS -m 2 http://127.0.0.1:8787/api/health 2>/dev/null | grep -q '"ok"'; then
  echo "FATAL: dev Worker on 8787 never became healthy"
  exit 2
fi
echo "dev Worker healthy on 8787"

for gate in smoke:p02 smoke:p03 smoke:p04 smoke:p05 smoke:local verify:observability; do
  log="$EVIDENCE/v05-gate-${gate//:/-}-rerun.log"
  ( cd "$REPO" && eval "$PNPM $gate" ) > "$log" 2>&1
  code=$?
  verdict=PASS
  [ "$code" != 0 ] && { verdict=FAIL; FAILED=1; }
  printf '%-14s exit=%-3s %s\n' "$gate" "$code" "$verdict"
done

exit "$FAILED"
