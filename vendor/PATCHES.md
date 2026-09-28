# Vendored patches

This directory is a `[patch.crates-io]` target, not a package boundary. It exists because a
dependency is not correct and runnable on `wasm32-unknown-unknown`, and `AGENTS.md` requires
every dependency to compile **and run** inside the Worker runtime.

| Crate | Upstream | Reason vendored | ADR |
|---|---|---|---|
| `passkey-auth` 0.1.3 | `crates.io` (Apache-2.0 OR MIT, © Sriram) | Two platform-boundary defects: `types::now_secs` panicked on Workers, and `crypto::verify_es256` parsed the wrong signature encoding, so every WebAuthn endpoint 500'd. | `docs/adr/0008-vendored-passkey-auth-wasm-clock.md` |

## The delta, in full

Two functions, both marked in place with a `# Lumi patch` comment naming this file and the
ADR. Nothing else in the vendored tree differs from the published crate.

| File | Function | Upstream | Patched to |
|---|---|---|---|
| `src/types.rs` | `now_secs` | `SystemTime::now()`, which is `unsupported()` and panics on `wasm32-unknown-unknown` | `js_sys::Date::now()` on `wasm32`; upstream body on every other target |
| `src/crypto.rs` | `verify_es256` | `EsSig::from_der` only | `from_slice` (raw `r‖s`, the WebAuthn form) for a 64-byte input, `from_der` otherwise |

Neither patch touches verification semantics. The second only *adds* acceptance of the form the
specification requires; it relaxes nothing. A derivation of why both were wrong, and why
replacing the crate was rejected, is in the ADR.

## How to tell what was changed

```bash
# 1. the two patches, without leaving the repository
grep -rn "Lumi patch" vendor/passkey-auth/src

# 2. a full diff against the published crate
REG="$(ls -d "$HOME"/.cargo/registry/src/*/passkey-auth-0.1.3 2>/dev/null | head -1)"
diff -ru --exclude Cargo.toml "$REG/src" vendor/passkey-auth/src

# 3. prove the vendored copy is the one being compiled
cargo tree -p lumi-agents-control-plane-api -i passkey-auth
```

Step 3 must print a path under `vendor/`, not a registry path. If it does, the patch is inert and
the Worker will panic again.

## Proving the patches are load-bearing

Neither patch is decorative. Each was individually reverted, the Worker rebuilt, and
`apps/api/scripts/p02-passkey-smoke.mjs` re-run:

| Reverted patch | Probe result | Failure reported |
|---|---|---|
| `now_secs` → `SystemTime` | 5/7 | `registration ceremony start … status=500` |
| `verify_es256` → DER only | 33/34 | `a correct assertion signs in … reason=passkey_signature_invalid` |
| neither (both applied) | 40/40 | — |

## Rules for adding a patch

- **One boundary per patch.** A vendored tree nobody can diff is a fork, not a patch.
- **Never patch cryptography or protocol *semantics*.** Patch the platform boundary, or accept
  the encoding a specification requires. F01 forbids hand-rolled WebAuthn verification, and the
  reason this crate is vendored rather than replaced is that its CBOR/COSE parsing is a
  maintained, reviewed implementation.
- **Record it as an ADR.** `AGENTS.md` requires one for a durable dependency decision.
- **Write the runtime probe, not just the patch.** A patch without a probe that fails on the
  unfixed code will silently decay. The probe is the part that matters.
- **Build the test double to the specification, not to the library.** `passkey-auth`'s own
  `es256_round_trip` signs and verifies DER, so it asserted the crate's wrong assumption back at
  itself. The probe signs with `node:crypto` and `dsaEncoding: "ieee-p1363"` — what an
  authenticator actually emits — which is how the second defect was found at all.
- **Keep the upstream `Cargo.toml` recognisable.** Dev-dependencies and examples are dropped
  because the crate is consumed as a library, and the comment says so. Anything else must be a
  deliberate, commented deviation.
- **Re-check upstream.** When `cargo update` is next run, compare the published `types.rs` and
  `crypto.rs` against `vendor/passkey-auth/src/`. If upstream fixes either defect, drop that
  patch and the corresponding ADR section in favour of the plain registry dependency.
