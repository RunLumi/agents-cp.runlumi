HEAD=ecbdac1  at 2026-09-27T12:12:15Z

--- reproducer -------------------------------------------------------
POST /api/v1/auth/passkey/signup/start        status=500
POST /api/v1/auth/passkey/login/start         status=500

--- expected --------------------------------------------------------
POST /api/v1/auth/passkey/signup/start        status=200 (ceremony_id + public_key)
POST /api/v1/auth/passkey/login/start         status=200 (ceremony_id + public_key)

--- actual Worker log ----------------------------------------------
[wrangler:info] POST /api/v1/auth/passkey/signup/start 422 Unprocessable Entity (140ms)
[wrangler:info] POST /api/v1/auth/passkey/login/start 500 Internal Server Error (116ms)
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (103ms)
[wrangler:info] POST /api/v1/auth/passkey/login/start 500 Internal Server Error (33ms)

--- artifact provenance -------------------------------------------
-rw-r--r--@ 1 james  staff  37936 27 Sep 16:41 apps/api/build/index.js
The runtime under test is apps/api/build/index.js, produced by worker-build --release.
It is also the correct artifact for ecbdac1, because the pull changed no Rust source:

$ git diff --stat c682a21 ecbdac1 -- apps/api/src apps/web/src apps/api/migrations
(empty above = no product source changed)
