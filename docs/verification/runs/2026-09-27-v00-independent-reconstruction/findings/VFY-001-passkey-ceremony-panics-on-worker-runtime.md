# Finding VFY-001 — Every passkey ceremony panics on the Worker runtime

## Status

open

## Severity

**critical**

## Affected claim

- Claim ID: `VI-AUTH-001`, `VI-AUTH-002`, `AUTH-WEBAUTHN-1`
- Source requirement: `docs/specs/f01-identity-authentication.md` FR-F01-004, FR-F01-005, FR-F01-016, and the F01 "Implementation note for Cloudflare Workers" step 3; `docs/verification/contracts/core-invariants-v1.yaml` `VI-AUTH-001`; ADR 0002 "Primary failure mode"
- Risk tier: **0**

## Statement

All eight WebAuthn endpoints return HTTP 500 in the real Cloudflare Worker runtime because
`passkey_auth::types::now_secs()` calls `std::time::SystemTime::now()`, which panics with
`unreachable` on `wasm32-unknown-unknown`; the adapter's mitigation of clearing
`state.created_at` after the call happens too late to prevent the panic.

## Reproducer

### Preconditions

```text
cd /Volumes/SSD/agents-cp.runlumi
pnpm install --frozen-lockfile
pnpm db:migrate:local                       # 20 migrations into local D1
pnpm --filter @runlumi/agents-cp-web build   # not required; dev server is enough
cd apps/api && ./node_modules/.bin/wrangler dev --env development --local --port 8787
```

No passkey, no browser, and no real authenticator are needed to reproduce. The panic
happens while the server builds the ceremony, before any client participates.

### Action

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:8787/api/v1/auth/passkey/signup/start \
  -H 'Content-Type: application/json' \
  -d '{"email":"vfy@example.test","display_name":"VFY"}'
# 500

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:8787/api/v1/auth/passkey/login/start \
  -H 'Content-Type: application/json' -d '{}'
# 500
```

Through the browser (`evidence/browser-probe.mjs`, real CTAP2 virtual authenticator):

```text
POST /api/v1/auth/passkey/signup/start  -> 500
POST /api/v1/auth/passkey/login/start   -> 500
body: "The Workers runtime canceled this request because it detected that your Worker's
       code had hung and would never generate a response."
```

### Expected

Both endpoints return 200 with server-generated `PublicKeyCredentialCreationOptions` /
`RequestOptions` and a `ceremony_id` (F01 FR-F01-004 step 3, FR-F01-005).

### Actual

HTTP 500. The Worker logs `Critical RuntimeError: unreachable` with this frame list:

```text
std::panicking::panic_with_hook
core::panicking::panic_fmt
passkey_auth[a4d79e7ac9e8fc4]::types::now_secs
<api>::adapters::webauthn::WebAuthnAdapter::start_registration
<api>::routes::authenticators::passkey_signup_start
```

Full log excerpt: `evidence/worker-panics.md` (20 panics, 20 × HTTP 500, one distinct
panicking frame: `passkey_auth::types::now_secs`).

## Affected endpoints

Every call site in `apps/api/src/routes/authenticators.rs`:

| Line | Route | Library call |
|---:|---|---|
| 234 / 304 | `POST /api/v1/auth/passkey/signup/{start,complete}` | `start_registration` / `finish_registration` |
| 482 / 554 | `POST /api/v1/auth/passkey/login/{start,complete}` | `start_authentication` / `finish_authentication` |
| 1112 / 1177 | `POST /api/v1/account/passkeys/register/{start,complete}` | `start_registration` / `finish_registration` |
| 1483 / 1569 | `POST /api/v1/account/reauth/passkey/{start,complete}` | `start_authentication` / `finish_authentication` |

## Why every existing verifier missed it

- `cargo test --workspace` runs on `aarch64-apple-darwin`, where `SystemTime::now()` works.
  `adapters/webauthn.rs::tests::registration_policy_is_discoverable_and_uv_required` calls
  `start_registration` and **passes**.
- `cargo check --target wasm32-unknown-unknown` proves it *compiles*. The panic is at runtime.
- `pnpm smoke:p02|p03|p04|p05` never calls a passkey endpoint. The P02 smoke signs up with
  email + password and uses the device-code flow, so 4/4 smokes stay green.
- The web suite is `renderToStaticMarkup`; there is no browser, so the primary CTA's failure
  is never executed.
- The adapter's own comment shows the trap was identified and then mis-mitigated:

  ```rust
  // The library's public state timestamp uses host time. D1 ceremony
  // expiry is authoritative in the Worker, so avoid depending on WASI
  // clock behavior and let the verifier use its serialized challenge.
  state.created_at = 0;
  ```

  `Webauthn::start_registration` already called `now_secs()` on the line before. The panic
  happens inside the library call; the assignment afterwards cannot prevent it.

`passkey-auth` 0.1.3 call sites: `src/ceremony.rs:315` (start_registration),
`src/ceremony.rs:469` (start_authentication_with_creds), `src/ceremony.rs:682` and
`src/types.rs:349,381` (expiry checks) all call
`std::time::SystemTime::now()`, which is `unsupported()` on this target.

## Why it matters

F01 makes passkeys the **primary** sign-up and sign-in method, and the shipped UI leads with
it. In production, that primary path is a 500. Concretely:

- No user can create an account with a passkey, sign in with one, add one to an existing
  account, or use one for step-up reauthentication.
- Each failure aborts the Worker request with a "code has hung" 500, not a stable error code,
  which violates F10/F23's stable-error model and produces no audit event.
- The product therefore ships with only its *fallback* auth path working, while its own
  acceptance criteria ("On a supported browser, passkey is visibly the first/default sign-up
  and sign-in option", "User can create an account with a passkey, sign out, and sign back in")
  are claimed as met.

This is precisely the correlated error the verification system exists to catch: the same
mistaken assumption (host `SystemTime` works) is present in the library choice, in the
mitigation comment, in the unit test, in every CI gate, and in the phase status.

## Root cause

`passkey-auth` 0.1.3 is not `wasm32-unknown-unknown` safe. It obtains ceremony timestamps
from `std::time::SystemTime::now()` and does not accept an injected clock
(`now_secs` is `pub(crate)`), so the application cannot supply Worker time.

## Repair constraints

- do not weaken: F01 FR-F01-004/005 (server-authoritative, short-lived, one-time ceremony),
  F01's requirement to use a maintained verifier rather than hand-rolled crypto, ADR 0002
  (no WASM-incompatible crate), ADR 0005.
- related contracts: `docs/contracts/desktop-auth-v1.md` is unaffected; no frozen contract
  needs to change.
- this is a **durable dependency decision** and therefore requires an ADR per `AGENTS.md`,
  not a quiet patch.

## Candidate repairs (require an ADR to choose)

1. **Vendor/patch `passkey-auth`** with a `now_secs` that reads Worker time
   (`Date::now().getTime() / 1000`), keeping the crate's own verification logic. Smallest
   behavioural change; adds a forked dependency to track.
2. **Replace the dependency** with a WASM-safe maintained WebAuthn verifier, re-proving
   F01's five required checks (wasm build, Worker dry-run, end-to-end registration +
   assertion, KDF budget, bundle size).
3. **Isolate the timestamp**: if a newer `passkey-auth` accepts a caller-supplied clock,
   upgrade instead of forking.

Whichever is chosen, F01's own note applies: *prove registration and assertion end-to-end
against the real Worker before claiming the feature.*

## Regression requirement

A verifier must exist that **fails** on the unfixed code and passes after the fix:

- a runtime probe (wrangler dev + local D1) that asserts
  `POST /api/v1/auth/passkey/signup/start` and `.../login/start` return 200 with
  `ceremony_id` and `public_key`, and that a real CTAP2 authenticator completes registration
  and a discoverable assertion;
- a mutation/fault case that removes the time source and requires that probe to fail, so the
  probe cannot be satisfied by a stubbed clock.

`evidence/browser-probe.mjs` already contains the first half and currently reports both
checks as FAIL.

## Closure evidence

**Status: CLOSED** 2026-09-27, after the repair loop. `VI-AUTH-001` FAIL → PASS; `VI-WASM-001`
"run" half FAIL → PASS. Narrative and full evidence:
[`repair-closure.md`](../repair-closure.md). Decision:
[`ADR 0008`](../../../../adr/0008-vendored-passkey-auth-wasm-clock.md).

### Two defects, not one

The repair found a **second** defect in the same crate, exposed by fixing the first rather than
caused by it. `crypto::verify_es256` parsed ES256 signatures with `EsSig::from_der`, and its
module comment stated the error outright: *"The ES256 signature on the wire is **DER-encoded**,
not raw r||s"*. WebAuthn specifies the fixed-length `R || S` concatenation, 32 bytes each, and
every real authenticator — Touch ID, Windows Hello, Android, YubiKey, Chrome's own virtual
authenticator — emits that form. A DER-only parser rejects **100 % of genuine assertions**.

It was invisible for the same reason as the clock: the crate's own `es256_round_trip` test signs
with `p256` and serialises with `sig.to_der()`, so it asserted the crate's wrong assumption back
at itself. It surfaced only because the new probe builds authenticator output **to the
specification** with `node:crypto` and `dsaEncoding: "ieee-p1363"`, not to the library's
expectation.

### Decision

`vendor/passkey-auth` via `[patch.crates-io]`, **two** functions patched, both on the platform
boundary: `types::now_secs` reads the Workers clock through `js_sys::Date::now()` on `wasm32`, and
`verify_es256` accepts the spec form for a 64-byte input while keeping DER as a fallback.
`vendor/PATCHES.md` records the delta and the three commands that audit it.

`state.created_at = 0` in `adapters/webauthn.rs` **stays**, deliberately: `check_not_expired`
short-circuits on `created_at == 0` and `routes/authenticators.rs::ensure_pending` enforces
`expires_at` and the ceremony `kind` from D1, which is what makes the application the authority
for expiry.

### Verifier: `apps/api/scripts/p02-passkey-smoke.mjs`, 41/41

Self-contained — fresh local D1, its own development Worker, removed on exit. Real P-256 keys from
`node:crypto`, real CBOR, real ES256 verification inside the Worker. 41 checks covering: ceremony
start; F01-004/005 option policy; challenge, origin, and RP-ID substitution; missing user
verification; missing attested credential data; `raw_id` substitution; duplicate-authenticator
enrolment; corrupted signature; unknown credential; user-handle substitution; replay with an
**advanced** sign counter; session revocation; and D1-enforced ceremony expiry.

**Both patches proven load-bearing:**

| Reverted | Result | Failure reported |
|---|---|---|
| `now_secs` → `SystemTime` | 5/7 | `registration ceremony start … status=500` |
| `verify_es256` → DER only | 33/34 | `a correct assertion signs in … reason=passkey_signature_invalid` |
| neither (both applied) | 41/41 | — |

### Original reproducer, unchanged

`evidence/vfy001-repro.sh` reported `status=500` on `POST /api/v1/auth/passkey/signup/start` and
`.../login/start`. After the repair the same endpoints return **201** with `ceremony_id`,
`expires_at`, and server-generated `public_key` options, and the Worker log contains **zero**
panics.

### F01's five required proofs

| # | Requirement | State |
|---|---|---|
| 1 | compiles for `wasm32-unknown-unknown` | PASS |
| 2 | Worker dry-run/build succeeds | PASS — `gzip: 2395.07 KiB` |
| 3 | **registration + assertion verify end-to-end with server-side ceremony state** | **PASS — requirement 3, previously never run, now discharged** |
| 4 | password KDF fits real Worker CPU/memory | **UNPROVEN — unchanged.** No Argon2id cost measurement inside the Worker's CPU limit exists. This repair does not claim it. It is an **in-repo** gap recorded in `../next-verification-actions.md`, not in `../missing-external-proofs.md`, because it needs no external dependency — only someone to run Argon2id at the configured parameters inside the Worker and record the number. |
| 5 | bundle/performance impact acceptable | PASS — `+1.32 KiB` gzip on a 2393.75 KiB baseline, because `js-sys` was already in the graph via `wasm-bindgen`/`worker` |

### Gated

`pnpm smoke:passkey`, in `.github/workflows/checks.yml` after `pnpm build`.
