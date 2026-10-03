# §1 — WebAuthn in the deployed configuration

Verdict up front: **the production origin pairing is now measured, and it works — but the candidate's
own deployment config did not carry it, and a Worker without it fails silently and lies about why.
Both defects are repaired in this campaign.**

## What the objective demanded

Twelve routes (`app.rs` auth blocks), five ceremony kinds (`PasskeySignup`, `PasskeyLogin`,
`PasskeyAdd`, `Reauthenticate`, recovery), each with runtime evidence **in the configuration that will
actually ship**: deployed RP ID and origins (not `localhost`); origin and RP-ID mismatches refused and
distinguishable from a wrong credential; consumed-ceremony replay refused for **all five** kinds; the
signature counter checked with a replay refused as a *consumed ceremony*; immediate revocation with
the anonymous leg asserted both sides; step-up gating its operations. Then two configuration facts:
`WebAuthnConfig::new` failing loudly on bad vars, and the `development`-defaults /
`Option`-passthrough asymmetry that lets production boot with passkeys silently disabled.

## The three configurations in play

| configuration | RP ID / origins | status |
|---|---|---|
| the live deployment (`agents-cp.runlumi.app`) | `agents-cp.runlumi.app` / `https://agents-cp.runlumi.app` (deployment line `wrangler.jsonc`) | **measured live** — see below |
| the candidate (`8aaca08` + repairs) as declared | **was: no `WEBAUTHN_*` vars at all** → `state.webauthn = None` | **defect V05-001, repaired this campaign** |
| `development` env | defaults `localhost` / `http://localhost:5173` (`app.rs:75-109`) | measured as the control below |

The source asymmetry the objective names is confirmed at `app.rs` (`WebAuthnConfig::new(
Some(...unwrap_or_else(localhost)...)` for development vs `.ok().map(WebAuthnAdapter::new)` over bare
`Option`s elsewhere): `WebAuthnConfig::new` **does** fail on missing/malformed vars
(`MissingRpId`/`InvalidRpId`/`MissingOrigin`/`TooManyOrigins`, origin validated against the RP ID,
≤4 origins) — but the non-development caller converts that failure into `None`, i.e. into *absence*,
not into a refused boot.

## Evidence taken in this campaign

### 1. The live production deployment is reachable and is issuing ceremonies for the deployed RP ID

`https://agents-cp.runlumi.app` answered from this host (2026-10-03, log
`evidence/v05-production-live-probes.log`):

- `GET /api/health` → **200** `{"status":"ok",…}` (0.69–1.26 s);
- `GET /api/v1/meta` → 200, `contract_version: p01-cg-v1`;
- `POST /api/v1/auth/passkey/login/start` (empty body) → **201** with
  `"rpId":"agents-cp.runlumi.app"`, a 43-char server challenge, `userVerification: required`;
- `POST /api/v1/auth/passkey/signup/start` (probe identity) → **201** with
  `"rp":{"id":"agents-cp.runlumi.app","name":"Lumi Agents"}`, `residentKey: required`, alg −7/−8.

That is direct runtime evidence that the deployed Worker has a **present** WebAuthn adapter (a `None`
adapter answers 503 — see §3) configured with the **production** RP ID. The deployed **origins**
allowlist is validated only at ceremony completion, so it remains evidence from the deployment line's
declared config (`https://agents-cp.runlumi.app`) plus the local pairing run below — a real
completion on the public origin needs a browser authenticator, which this verification host's browser
surface cannot drive (see Limitations).

### 2. All five ceremony kinds, under the exact production pairing, over real HTTP

`smoke:passkey` (`p02-passkey-smoke.mjs`) drives a software CTAP2 authenticator against a real Worker
and real D1. This campaign added an opt-in `--var` passthrough
(`P02_PASSKEY_FORWARD_VARS=1`) so the Worker runs the **production** pairing while the client signs
the same (a test affordance in the harness — the Worker var, not a relaxed guard). The full suite:

**91/91 checks passed, exit 0** — `evidence/v05-passkey-final-tree.log` (and 91/91 pre-repair in
`evidence/v05-passkey-production-pairing.log`), header: `relying party "agents-cp.runlumi.app",
origin "https://agents-cp.runlumi.app"`.

Coverage the objective names, with the check names as printed:

- **origin mismatch refused**: "an origin outside the configured allowlist is refused" /
  "an assertion from an unlisted origin is refused" → `401 ceremony_origin_mismatch`.
- **RP ID mismatch refused, distinguishable**: "authenticator data bound to another relying party is
  refused" → **`ceremony_rp_id_mismatch`** — a *different* reason from origin mismatch, and both are
  different from a wrong credential (`passkey_invalid`, "an assertion naming an unknown credential is
  refused") and from a wrong challenge (`ceremony_challenge_mismatch`).
- **consumed ceremony cannot be replayed — all five kinds**:
  - signup: "a consumed registration ceremony cannot be replayed" → `ceremony_invalid`;
  - login: "a consumed login ceremony cannot be replayed with a fresh sign counter" →
    `ceremony_invalid`, and "the replay is refused as a consumed ceremony, not as a stale counter";
  - recovery: "a consumed recovery ceremony cannot be replayed with the same challenge and code" →
    `recovery_invalid`, **graded on stored state**: the original recovery's password still
    authenticates (200) and the replay's password does not (401) — accepting the replay is the one
    thing that would have set it;
  - **PasskeyAdd and Reauthenticate had no replay case until this campaign** (V04 closed
    registration, login, recovery). New cases drive each ceremony end to end first (the step-up
    mints a grant that starts a real passkey-add; the added credential reaches the inventory), then
    replay: "a consumed REAUTHENTICATE ceremony cannot be replayed" and "a consumed PASSKEY-ADD
    ceremony cannot be replayed" → both `401 ceremony_invalid`, with the add replay asserting
    `ceremony_invalid` specifically so a `credential_conflict` could not pass as the guard.
- **signature counter checked, and the replay refusal is the ceremony's**: "an assertion repeating
  the stored sign counter is refused as a counter regression" → `passkey_counter_regression`, with
  the control "an assertion advancing the counter by one signs in" — the enforced boundary sits at
  the stored value, located without reading D1, so both halves self-prove.
- **revocation is immediate**: "a credential can be revoked once another login method exists",
  "a REVOKED credential cannot authenticate, even with a valid signature" (asserted **not**
  `passkey_signature_invalid`, so the revocation is what refused), "a revoked session can no longer
  authenticate" (204 then 401), and recovery "terminates" pre-existing sessions ("a session
  established before the recovery no longer authenticates afterwards"). The anonymous/unauthenticated
  legs are asserted by the fresh-`Jar` construction on both sides of each state change.
- **step-up gates its operations**: the lockout guard answers before the grant is examined;
  "a fabricated reauth grant is refused"; the grant is single-use (consumed by the add-start above).

### 3. The instrument control: a mismatched pairing must go red

Before the green run, the suite was run with the client signing the production pairing against a
**localhost-defaulted** Worker (no passthrough): `evidence/v05-pairing-control.log` — 30 checks pass
up to the pairing boundary, then the *correct* registration is refused
(`FAIL … status=401 reason=ceremony_origin_mismatch`), the suite refuses to attribute the wrong-kind
attacks ("the control did not hold"), exit 1. The instrument demonstrably registers a pairing
change; the green run cannot be green by accident.

### 4. The silent-`None` question — measured, then repaired (V05-001)

**Before repair**, a Worker started from the candidate's own production env (`ENVIRONMENT=production`,
no `WEBAUTHN_*` vars — which is what the candidate's `wrangler.jsonc` actually contained, because the
vars exist only on the unmerged deployment line) answered, on a healthy database
(`evidence/v05-silent-none.log`):

- `GET /api/health` → **200 ok**; `GET /api/v1/meta` → 200;
- `POST /api/v1/auth/passkey/login/start` and `signup/start` → **503**
  `{"code":"service_unavailable","message":"The identity store is unavailable."}` — the **identical**
  answer a missing D1 binding produces (`http/auth.rs` maps missing store / hash failure / lookup
  error to the same code *and message*; `webauthn_adapter` mapped `None` to the same helper);
- the password route kept answering normally (401) — so the deployment *works*, and passkeys are just,
  silently, gone, with the error lying about the cause.

That is the exact state the objective warns about: "passkeys silently disabled rather than a Worker
that refuses to boot", and a control plane that answers "passkeys unavailable" indistinguishably from
one whose store is down.

**Repairs applied (the candidate tree moves; see the re-pin):**

1. `apps/api/wrangler.jsonc` production env now carries `WEBAUTHN_RP_ID=agents-cp.runlumi.app`,
   `WEBAUTHN_RP_NAME=Lumi Agents`, `WEBAUTHN_ORIGINS=https://agents-cp.runlumi.app`,
   `EMAIL_FROM=agents@runlumi.app` — the same values the deployment line declares (EMAIL_FROM is the
   same silent-absence family: without it, verification mail cannot send).
2. `routes/authenticators.rs`: the no-adapter case now answers
   **`503 service_unavailable` with `details.reason: "passkeys_not_configured"`** and the message
   "Passkeys are not configured on this deployment." — the same status class (it *is* unavailable),
   but an operator reading the response can tell it from a D1 outage.

**Regression proof**, rerunnable as `evidence/v05-webauthn-config.sh` (all 7 checks PASS, exit 0):

- scenario A: the production-env Worker now issues ceremonies naming `rpId: agents-cp.runlumi.app`;
- scenario B: an explicitly empty pairing constructs `None`, and the route answers
  `passkeys_not_configured` with the passkey-specific message **while** `/api/health` is 200 and the
  password route answers a normal 401 — the two causes no longer look the same.

`pnpm check` exit 0 after both repairs (format, lint, typecheck, 463 binds by `schema:bind-count`
inside `test`, clippy clean, wasm target builds).

## Verdicts

| claim | verdict | evidence |
|---|---|---|
| RP ID + accepted origins are the deployed ones, exercised at runtime | **PASS** | live production `rpId` (201s above); 91/91 under the identical pairing locally; scenario A |
| origin mismatch / RP ID mismatch refused, distinguishable from wrong credential | **PASS** | `ceremony_origin_mismatch` vs `ceremony_rp_id_mismatch` vs `passkey_invalid`, all at 401, in the 91/91 run |
| consumed ceremony cannot be replayed — **all five kinds** | **PASS** (this campaign closed the PasskeyAdd + Reauthenticate gap) | the replay cases above, recovery graded on stored passwords |
| signature counter checked; replay refused as consumed ceremony, not stale counter | **PASS** | the counter-boundary pair + the login-replay reason assertion |
| revocation immediate, anonymous leg both sides | **PASS** | revoked credential/session cases with fresh-`Jar` construction either side |
| step-up gates operations that require it | **PASS** | lockout-before-grant, fabricated-grant refusal, single-use grant consumed by the add ceremony |
| `WebAuthnConfig::new` fails loudly on missing/malformed vars | **PASS at the constructor, swallowed at the call site** | source + `evidence/v05-silent-none.log`: the failure becomes `state.webauthn = None` outside development |
| a passkey route with no adapter answers something unambiguous | **PASS after repair** (was **FAIL**: it answered the D1-outage error) | `evidence/v05-webauthn-config.sh` scenario B |
| production **origins** allowlist exercised by a real completion on the public origin | **UNPROVEN** | needs a browser authenticator on the live origin; see Limitations |
| ceremonies against the deployed **code** | **PASS by identity, not by execution**: the deployed tree's passkey surface is byte-identical to the candidate's (`git diff 795d403..HEAD -- apps/api/src` = `guarded_column_writers.rs` + `mod.rs` only; no route/handler/SQL change) | candidate-pin.md |

## Findings opened or changed in this section

- **V05-001 (HIGH, product/config, repaired)** — the candidate's own production env carried no
  `WEBAUTHN_*`/`EMAIL_FROM` vars; deploying it would have silently disabled passkeys and email while
  health stayed green. Fail-closed, ambiguous signal. Repaired + regression-proven as above.
- **V05-002 (MEDIUM, product, repaired)** — the no-adapter answer reused the identity-store outage
  verbatim. Repaired into `passkeys_not_configured`.
- **Probe gap closed** — `PasskeyAdd` / `Reauthenticate` replay and the counter-boundary case are new
  in `p02-passkey-smoke.mjs` (+11 checks, 80 → 91); sensitivity of the *class* is carried from
  V04's VI-AUTH-001 kill (the shared `consume_ceremony` guard is unchanged by this campaign's
  repairs) plus the new pairing-mismatch control.
- **Process finding** — the production deployment configuration lives only on `origin/main`'s
  unmerged deployment line, branched from V04's original FAILED candidate (`795d403`), so the
  deployment and the product line can silently diverge — V05-001 is what that divergence had already
  produced on the candidate side. Merging the lines is a human decision and is recorded in the
  release verdict.

## Limitations

- No real CTAP2 authenticator completed a ceremony **on the public origin**; the origin allowlist in
  force there is evidenced by the deployment line's declared config plus the local run under the
  identical pairing. The RP ID half is measured live.
- The live probes touched only unauthenticated ceremony starts (self-expiring pending rows, no email,
  no account creation) — a handful of requests, same surface any visitor's browser hits.
