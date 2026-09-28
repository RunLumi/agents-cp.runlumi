# ADR 0008: Vendor `passkey-auth` and patch two platform-boundary defects

- Status: Accepted
- Date: 2026-09-27
- Scope: `apps/api/Cargo.toml` dependency surface, `vendor/passkey-auth/**`
- Finding: `docs/verification/runs/2026-09-27-v00-independent-reconstruction/findings/VFY-001-passkey-ceremony-panics-on-worker-runtime.md`

## Context

F01 makes passkeys the **primary** authentication method
(FR-F01-003, FR-F01-004, FR-F01-005) and requires a *maintained* verifier rather than
hand-rolled WebAuthn crypto. The implementation uses `passkey-auth` 0.1.3 through
`apps/api/src/adapters/webauthn.rs`.

Independent verification (V00, commit `ecbdac1`) proved that **all eight WebAuthn endpoints
return HTTP 500 in the real Cloudflare Worker runtime**. The Worker log carries the frame list:

```text
std::panicking::panic_with_hook
core::panicking::panic_fmt
passkey_auth::types::now_secs
<api>::adapters::webauthn::WebAuthnAdapter::start_registration
<api>::routes::authenticators::passkey_signup_start
```

`passkey_auth::types::now_secs()` is `std::time::SystemTime::now()`. On
`wasm32-unknown-unknown` the standard library's clock is `unsupported()`, which panics. The
crate calls it in four places, two of which are inside `start_registration` and
`start_authentication_with_creds`.

The trap is that the problem was already identified and mis-mitigated. `adapters/webauthn.rs`
carries this comment and mitigation:

```rust
// The library's public state timestamp uses host time. D1 ceremony
// expiry is authoritative in the Worker, so avoid depending on WASI
// clock behavior and let the verifier use its serialized challenge.
state.created_at = 0;
```

That mitigation is *correct as design* — `check_not_expired` short-circuits on
`created_at == 0` precisely so callers can delegate expiry to their own store, and
`routes/authenticators.rs::ensure_pending` does enforce `expires_at` and ceremony `kind` from
D1. But it runs **after** the library call that panicked, so it prevents nothing.

Nothing in the repository could see this: host tests pass, `cargo check --target
wasm32-unknown-unknown` passes, all four runtime smokes pass (none touches a passkey
endpoint), and the web suite renders static markup. It is ADR 0002's stated primary failure
mode — "a host build can look fine while the Worker target fails" — except that here the target
*compiled* and failed at run time, which is a strictly worse variant.

## Decision

Vendor `passkey-auth` 0.1.3 under `vendor/passkey-auth/` via `[patch.crates-io]`, and patch
**two functions**, both on the platform boundary and neither in the cryptography:

1. **`types::now_secs`** — read the Workers clock through `js_sys::Date::now()` on `wasm32`,
   keeping the upstream `SystemTime` body on every other target.
2. **`crypto::verify_es256`** — accept the signature form WebAuthn actually specifies.

### The second patch, and why it only appeared after the first

Fixing the clock was not sufficient. With the Worker serving, a *spec-conformant* assertion
was refused with `passkey_signature_invalid`, and the cause is a second defect in the same
crate. Its module comment read:

```rust
//! The ES256 signature on the wire is **DER-encoded**, not raw r||s - be careful here.
```

and `verify_es256` implemented exactly that:

```rust
let parsed = EsSig::from_der(sig).map_err(|_| Error::BadSignature)?;
```

The comment is the error. For COSE `-7` / ES256, WebAuthn §"Signature" defines the signature as
the fixed-length concatenation `R || S`, 32 bytes each, explicitly **not** ASN.1 DER. Every
real authenticator — Touch ID, Windows Hello, Android, YubiKey, and Chrome's own virtual
authenticator — emits that form. A DER-only parser therefore rejects **100 % of genuine
assertions**; the only signatures it accepts are ones no authenticator produces.

This defect was invisible for the same reason as the clock: the crate's own test
`es256_round_trip` signs with `p256` and serialises with `sig.to_der()`, so it asserts the
crate's own assumption back at itself. It surfaced only because the new probe
(`apps/api/scripts/p02-passkey-smoke.mjs`) builds authenticator output **to the
specification** with `node:crypto` and `dsaEncoding: "ieee-p1363"` rather than to the library's
expectation. That is the general lesson and the reason the probe is written the way it is.

The fix accepts the spec form when the input is 64 bytes and keeps DER as a fallback, so
nothing that previously verified stops verifying. A 64-byte input is unambiguously the raw
form: a well-formed DER ECDSA signature over a P-256 key is 70–72 bytes, so the length test is
a safe discriminator rather than a guess. The upstream high-S malleability reasoning is
unchanged and still correct — the single-use challenge is what makes a malleable variant
useless, not signature normalisation.

### Why not replace the dependency

The obvious alternative is a WASM-safe maintained WebAuthn crate, principally `webauthn-rs`.
It was rejected on evidence, not taste:

1. **Bundle cost.** `webauthn-rs` pulls `ring`/`aws-lc-rs`, `x509-parser`, `yanked`, and an
   async-trait surface. The Worker builds to `gzip: 2394.55 KiB`, roughly **80 % of Cloudflare's
   3 MiB free-tier compressed limit**. `AGENTS.md` calls bundle size a latency and
   deployability cost and warns against trades that buy little for a large transitive tree.
2. **It would re-open a proof obligation F01 has already paid.** Replacing the verifier means
   re-proving F01's five required checks from scratch, and the verification system would again
   have to discover for itself whether the replacement runs on Workers.
3. **The defects are at the platform boundary, not in the cryptography.** CBOR/COSE parsing is
   correct and is the reason to depend on the crate. What was wrong was the clock source and
   the signature encoding — the two places where "runs on a POSIX host" leaked into the logic.

### Why not leave it broken and rely on the password path

F01-003 states the ordering is a *product requirement*, not a preference, and the shipped UI
leads with the passkey CTA. A primary path that 500s is not a degraded experience; it is a
broken one, and it means the only working authentication method is the one F01 calls the
fallback.

### Why a `[patch]` and not a fork

A patch keeps the vendored tree auditable against the published crate. `vendor/PATCHES.md`
documents the two-function delta, gives the commands that verify it, and states the rule for
removing it: when upstream fixes both, delete the patch and this ADR in favour of the plain
registry dependency.

## Consequences

Positive:

- All eight ceremony endpoints run on Workers, and F01's third required proof — "registration
  and assertion verify end-to-end with server-side ceremony state" — is satisfied by
  `apps/api/scripts/p02-passkey-smoke.mjs` (40 checks, real ES256, real CBOR, real Worker).
- No change to verification semantics, so no protocol or contract risk. The patch *adds*
  acceptance of the spec-conformant form; it does not relax any check.
- `js-sys` is already in the graph through `wasm-bindgen` and `worker`. Measured bundle
  impact of both patches together: `gzip` 2393.75 → 2394.55 KiB, about +0.8 KiB.
- Ceremony expiry stays authoritative in D1, enforced by `ensure_pending`, which also binds the
  ceremony `kind` and requires `status = pending`. VI-AUTH-001's "short-lived, kind-bound,
  one-time" properties are therefore owned by the application, not by the library's clock.

Costs, stated honestly:

- The repository now carries ~2,500 lines of third-party source it must keep in step with
  upstream. `vendor/PATCHES.md` bounds that to two functions and says so.
- A future `cargo update` can silently re-point at the registry if the `[patch]` block is
  removed. The ADR, the `Cargo.toml` comment, the `Lumi patch` markers in both files, and the
  `cargo tree -i passkey-auth` check in `vendor/PATCHES.md` are four independent guards.
- The patches fix the symptoms, not the reason they went unnoticed. The reason is that no
  verifier exercised a WebAuthn ceremony against a real Worker. That is closed by
  `apps/api/scripts/p02-passkey-smoke.mjs`, wired into the gate — the change that matters more
  than the patch. Both patches were confirmed to be detected by that probe when individually
  reverted.

## Implementation constraints

- The patches must remain on the platform boundary. Never patch verification semantics beyond
  accepting the form the specification requires.
- The vendored manifest may drop dev-dependencies and examples (it is consumed as a library),
  and that deviation is commented. No other manifest change is permitted without updating
  `vendor/PATCHES.md`.
- `adapters/webauthn.rs`'s `state.created_at = 0` must stay. It is what makes D1 the authority
  for expiry; removing it would silently move expiry back into the library.
- The `wasm32` arm must keep the host arm's saturating semantics: a pre-epoch or non-finite
  clock yields `0`, never a panic.
- Any future authenticator integration must be exercised through the probe, not assumed from
  the crate's own tests.

## Rollback

Delete the `[patch.crates-io]` block from the workspace `Cargo.toml`, `git rm -r vendor`, and
revert `apps/api/Cargo.toml` if needed. Nothing in `apps/api/src`, `apps/web/src`, or the
migrations changes, so reverting the patch returns the build to a known state. The passkey
endpoints return to HTTP 500, which is the pre-repair behaviour, and
`pnpm smoke:passkey` fails loudly rather than silently.

## Alternatives rejected

- **Upgrade `passkey-auth`.** 0.1.3 is the newest published version (checked against the
  crates.io API on 2026-09-27); there is nothing to upgrade to.
- **`catch_unwind` around the library call.** The value is never produced, so there is nothing to
  catch *into*; and `panic = "abort"` is set for the release profile.
- **Replace `std::time::SystemTime` for the whole target.** Not possible without a custom target
  or a `#[no_std]`-shaped time shim, both of which are larger and riskier than a one-function
  patch.
- **Set `created_at = 0` earlier, by constructing the state struct directly.** `RegistrationState`
  and `AuthenticationState` are constructible, but the challenge inside them is produced by the
  same `start_*` call that panics, so the ceremony could not be built at all.
- **Keep DER-only and pre-convert in the client.** The wire format is fixed by the browser
  platform; the SPA cannot transform a signature the authenticator produced.

## References

- `docs/specs/f01-identity-authentication.md` — FR-F01-003/004/005/011, and the "Implementation
  note for Cloudflare Workers" five-check requirement
- `docs/adr/0002-rust-axum-cloudflare-workers.md` — "Primary failure mode"
- `docs/verification/contracts/core-invariants-v1.yaml` — `VI-AUTH-001`, `VI-WASM-001`
- W3C WebAuthn Level 3 §"Signature" — <https://www.w3.org/TR/webauthn-3/#sctn-signature>
- <https://developers.cloudflare.com/workers/runtime-apis/date/>
- <https://doc.rust-lang.org/std/time/struct.SystemTime.html>
