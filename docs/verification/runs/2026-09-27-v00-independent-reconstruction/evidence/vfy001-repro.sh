#!/usr/bin/env bash
# VFY-001 reproducer, re-executed at HEAD after the mid-campaign pull.
set -uo pipefail
cd /Volumes/SSD/agents-cp.runlumi
API=http://127.0.0.1:8787
printf 'HEAD=%s  at %s\n\n' "$(git rev-parse --short HEAD)" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf -- '--- reproducer -------------------------------------------------------\n'
for ep in /api/v1/auth/passkey/signup/start /api/v1/auth/passkey/login/start; do
  body='{"email":"vfy-repro@example.test","display_name":"VFY Repro"}'
  [ "$ep" = "/api/v1/auth/passkey/login/start" ] && body='{}'
  printf '%-45s ' "POST $ep"
  curl -s -m 25 -o /dev/null -w 'status=%{http_code}\n' \
    -X POST "$API$ep" -H 'Content-Type: application/json' -d "$body"
done
printf -- '\n--- expected --------------------------------------------------------\n'
printf '%-45s status=200 (ceremony_id + public_key)\n' 'POST /api/v1/auth/passkey/signup/start'
printf '%-45s status=200 (ceremony_id + public_key)\n' 'POST /api/v1/auth/passkey/login/start'
printf -- '\n--- actual Worker log ----------------------------------------------\n'
grep -E 'POST /api/v1/auth/passkey' \
  /private/var/folders/zz/jzz3w1rj5lq21d_7c0nkc31m0000gn/T/opencode/wrangler-8787.log | tail -4
printf -- '\n--- artifact provenance -------------------------------------------\n'
ls -la apps/api/build/index.js
echo 'The runtime under test is apps/api/build/index.js, produced by worker-build --release.'
echo 'It is also the correct artifact for ecbdac1, because the pull changed no Rust source:'
printf '\n$ git diff --stat c682a21 ecbdac1 -- apps/api/src apps/web/src apps/api/migrations\n'
git diff --stat c682a21 ecbdac1 -- apps/api/src apps/web/src apps/api/migrations
echo '(empty above = no product source changed)'
