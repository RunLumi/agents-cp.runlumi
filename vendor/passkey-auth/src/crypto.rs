//! Signature verification - the only crypto operation the server
//! performs during the WebAuthn auth ceremony.
//!
//! Algorithms supported (matching `cose::CoseKey`):
//!   * ES256 (P-256 ECDSA over SHA-256), the universal default
//!   * EdDSA (Ed25519), used by some authenticators (e.g. Yubikey 5+)
//!
//! WebAuthn signs `authenticatorData || SHA-256(clientDataJSON)`.
//!
//! Lumi patch: the upstream note here read "The ES256 signature on the wire is
//! **DER-encoded**, not raw r||s - be careful here." That is the opposite of what
//! WebAuthn specifies, and it is what `verify_es256` implemented. See the patch
//! note in that function and `vendor/PATCHES.md`.

use ed25519_dalek::{Signature as EdSig, Verifier as _, VerifyingKey as EdKey};
use p256::ecdsa::{Signature as EsSig, VerifyingKey as EsKey};
use p256::elliptic_curve::sec1::FromEncodedPoint;
use p256::{EncodedPoint, PublicKey};

use crate::cose::CoseKey;
use crate::error::{Error, Result};

/// Verify `sig` over `msg` using the COSE public key. Returns `Ok(())`
/// on a valid signature; any failure path (wrong key, malformed sig,
/// algorithm mismatch) collapses to [`Error::BadSignature`] so we
/// don't leak which check failed to the wire.
pub(crate) fn verify(key: &CoseKey, msg: &[u8], sig: &[u8]) -> Result<()> {
    match key {
        CoseKey::Es256 { x, y } => verify_es256(x, y, msg, sig),
        CoseKey::Ed25519 { key } => verify_ed25519(key, msg, sig),
    }
}

fn verify_es256(x: &[u8; 32], y: &[u8; 32], msg: &[u8], sig: &[u8]) -> Result<()> {
    // SEC1 uncompressed point: 0x04 || X || Y.
    let mut sec1 = [0u8; 65];
    sec1[0] = 0x04;
    sec1[1..33].copy_from_slice(x);
    sec1[33..65].copy_from_slice(y);
    let point = EncodedPoint::from_bytes(sec1).map_err(|_| Error::BadSignature)?;
    let pk = PublicKey::from_encoded_point(&point);
    let pk = Option::<PublicKey>::from(pk).ok_or(Error::BadSignature)?;
    let vk = EsKey::from(&pk);

    // Lumi patch — see ../../../../docs/adr/0008-vendored-passkey-auth-wasm-clock.md
    // and vendor/PATCHES.md.
    //
    // Upstream parsed DER only:
    //
    //     let parsed = EsSig::from_der(sig).map_err(|_| Error::BadSignature)?;
    //
    // That is wrong for WebAuthn, and the module comment above it ("the ES256
    // signature on the wire is DER-encoded, not raw r||s") states the error
    // outright. For COSE `-7` / ES256, WebAuthn §"Signature" defines the
    // signature as the fixed-length concatenation `R || S`, 32 bytes each, and
    // explicitly not ASN.1 DER. Every real authenticator — Touch ID, Windows
    // Hello, Android, YubiKey, and Chrome's own virtual authenticator — emits
    // that form, so a DER-only parser rejects 100 % of genuine assertions.
    //
    // The fix accepts the spec form first and keeps DER as a fallback, so any
    // caller that somehow produced DER still verifies. A 64-byte input is
    // unambiguously the raw form: a DER ECDSA signature is 8 bytes of envelope
    // plus two integers, and cannot be exactly 64 bytes for a well-formed
    // signature over a P-256 key, so the length test is a safe discriminator
    // rather than a guess.
    //
    // The high-S malleability reasoning in the upstream comment still holds and
    // is unchanged: the single-use challenge in `state` is what prevents a
    // malleable variant from being useful, so both forms are accepted.
    let parsed = if sig.len() == 64 {
        EsSig::from_slice(sig)
    } else {
        EsSig::from_der(sig)
    }
    .map_err(|_| Error::BadSignature)?;
    vk.verify(msg, &parsed).map_err(|_| Error::BadSignature)
}

fn verify_ed25519(key: &[u8; 32], msg: &[u8], sig: &[u8]) -> Result<()> {
    let vk = EdKey::from_bytes(key).map_err(|_| Error::BadSignature)?;
    if sig.len() != 64 {
        return Err(Error::BadSignature);
    }
    let mut sb = [0u8; 64];
    sb.copy_from_slice(sig);
    let parsed = EdSig::from_bytes(&sb);
    vk.verify(msg, &parsed).map_err(|_| Error::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};
    use p256::ecdsa::SigningKey as EsSigningKey;
    use rand::RngCore;

    #[test]
    fn ed25519_round_trip() {
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        let sk = SigningKey::from_bytes(&seed);
        let vk_bytes = sk.verifying_key().to_bytes();
        let msg = b"hello passkey world";
        let sig: EdSig = sk.sign(msg);
        let key = CoseKey::Ed25519 { key: vk_bytes };
        verify(&key, msg, &sig.to_bytes()).expect("good sig must verify");

        // Tamper → rejected.
        let mut bad = sig.to_bytes();
        bad[0] ^= 0x01;
        assert!(verify(&key, msg, &bad).is_err());
    }

    #[test]
    fn es256_round_trip() {
        let sk = EsSigningKey::random(&mut rand::thread_rng());
        let vk = sk.verifying_key();
        let pt = vk.to_encoded_point(false);
        let xs = pt.x().expect("x coord");
        let ys = pt.y().expect("y coord");
        let mut x = [0u8; 32];
        let mut y = [0u8; 32];
        // GenericArray derefs to &[u8] - avoid the deprecated as_slice().
        x.copy_from_slice(&xs[..]);
        y.copy_from_slice(&ys[..]);

        let msg = b"hello passkey world";
        let sig: EsSig = sk.sign(msg);
        let der = sig.to_der().to_bytes().to_vec();

        let key = CoseKey::Es256 { x, y };
        verify(&key, msg, &der).expect("good sig must verify");

        // Tamper → rejected.
        let mut bad = der.clone();
        let n = bad.len();
        bad[n - 1] ^= 0x01;
        assert!(verify(&key, msg, &bad).is_err());
    }
}
