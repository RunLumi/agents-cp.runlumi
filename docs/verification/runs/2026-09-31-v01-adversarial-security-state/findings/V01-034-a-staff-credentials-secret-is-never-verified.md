# V01-034 — a staff credential's secret is never verified

- **Claim ID:** V01-034
- **Family:** Authentication
- **Severity:** **CRITICAL**
- **Status:** CLOSED — recorded before repair, updated with root cause, fix, and proof, as the campaign requires
- **Verdict:** FAIL → **PASS** (re-attack 401/identical; probe 22/22)

## Claim

`require_staff` resolves the presented `lumi_staff_` credential by its **lookup prefix alone** and
never compares the presented secret against the stored `credential_hash`. Therefore **any**
well-formed token `lumi_staff_<known-prefix>_<any-43-char-base64url>` authenticates as the staff
principal that owns that prefix.

The stored secret is therefore not a secret. The 16-character prefix is a **lookup key** — a
non-secret identifier that the code itself carries into `StaffActor`, and that the migration
describes as one of the three columns "the raw value is shown once and never stored" applies to.

## Setup

The claim is falsifiable over real HTTP, and the probe that does it is
`apps/api/scripts/v01-staff-credential-probe.mjs` (`pnpm verify:staff-credential`).

Two facts make the attack well-formed rather than malformed, which is the whole point — a
malformed token being refused proves nothing:

1. `core::staff::StaffKey::parse` (`apps/api/src/core/staff.rs:37`) accepts
   `lumi_staff_<16 lowercase hex>_<43 base64url>`. A forged secret of exactly 43 base64url
   characters **passes the parser**.
2. `repositories::PlatformOperationsRepository::resolve_staff_credential`
   (`apps/api/src/repositories/platform_ops.rs:448`) looks the row up with
   `WHERE credential_prefix = ?1` and returns it. It reads `credential_hash` into the record and
   hands the caller a `StaffKey` whose `secret()` is never called.

The fixture provisions a **legitimate** staff principal the way an operator would: a row in
`staff_principals` whose `credential_hash` is `sha256_hex(the real secret)`. Nothing about the
product's authentication is relaxed or bypassed to make the probe run — the forged token is
presented to the real verifier, and the real verifier declines to check it.

## Action

Against `GET /api/v1/internal/feature-flags` — a route whose only gate is `require_staff`:

| # | Presented token | Expected | Required by the spec |
|---|---|---|---|
| C1 | `lumi_staff_<prefix>_<REAL secret>` | 2xx | control: the route and the fixture work |
| A1 | `lumi_staff_<prefix>_<FORGED secret>` | **401** | 2xx ⇒ the secret is not verified |
| A2 | `lumi_staff_<prefix>_<43 chars, other>` | **401** | as A1, a second shape |
| A3 | `lumi_staff_<prefix>_<43 chars>` on a **write** route | **401** | as A1, and it must not reach the store |
| A4 | `lumi_staff_<unknown prefix>_<REAL secret>` | 401 | a nonexistent prefix is refused, and identically to A1 |

A4 is the non-disclosure leg and it matters in the other direction: a correct implementation must
not be repairable by simply refusing everything, and the refusal for a wrong secret must be
**identical** to the refusal for a principal that does not exist, or the endpoint becomes an
existence oracle for staff principals.

A3 is graded on **stored state read from D1**, not on status — a `2xx` that ignored the token would
be a correct answer, and a `2xx` that *applied* the write is a breach.

## Actual

Pre-fix, as measured over HTTP and recorded in
`evidence/v01-staff-credential-pre-fix.txt`:

- **C1 200** — the fixture is correct and the route works.
- **A1 200** — a forged secret authenticates. **The secret is not verified.**
- **A2 200** — same, a second forged shape.
- **A3 200, and the feature flag's stored version advanced** — a forged credential performed a
  **platform-wide write**. Read from D1, not inferred from the status.
- **A4 401** — the nonexistent prefix *is* refused, so the boundary is the hash comparison and
  nothing else.

A red A1 with a green C1 is the decisive pair: it cannot be a route that refuses everyone, and it
cannot be a fixture that never worked.

## Why the code reads this way

`apps/api/src/http/auth.rs`. The **machine** credential path, eleven lines above the staff one, does
the comparison and explains why in a comment:

```rust
// Constant-time on the stored hash. The prefix lookup has already told us
// WHICH row this is, so the comparison is only the second factor; running it
// in constant time keeps the habit in the same place as the session path,
// where a shortcut is easiest to introduce by accident.
let presented_hash = machine_secret_hash(key.secret());
if !core_constant_time_eq(
    presented_hash.as_bytes(),
    resolved.key.secret_hash.as_bytes(),
) {
    return Err(machine_key_invalid(context));
}
```

`require_staff` then parses the same `StaffKey` shape, looks up by prefix, checks the role parses and
the principal is active, and returns. `key.secret()` has **no non-test caller anywhere in the tree**,
and `credential_hash` is inserted, read into a struct, length-checked by a unit test — and never
compared.

`migration 0018_p07_platform_operations.sql` states the rule the code does not implement:

> Same rule as `api_keys`: the raw value is shown once and never stored. The 64-char hex CHECK on
> `credential_hash` means the presented token cannot be written there even by a future mistake.

"The raw value is never stored" is a property of a **secret**, and it is only true of a secret if the
raw value is *checked*. As written, the column is written, validated, and then decorative.

## Impact

`/api/v1/internal/**` is the platform surface: feature flags, kill switches, platform operations. Any
party who learns a `credential_prefix` — a value the code itself propagates into `StaffActor` and
therefore into audit rows — holds a **standing, unauthenticated, unrevoked-by-secret** platform
credential for the lifetime of the principal. Revoking the secret is impossible: changing
`credential_hash` does not authenticate the new secret, because the new secret is not read either.
Suspension (`status = 'suspended'`) is the only control that works, and it is not discoverable from
the token.

The prefix is 16 hex characters. It is not brute-forceable in the aggregate, which is the only
reason this is a **disclosure-dependent** critical rather than an unauthenticated one — and that
reasoning is exactly why the finding cannot be dismissed: the system has an authentication factor
and is simply not checking it.

## Regression gap

- No unit test asserted that a **wrong** staff secret is refused. `apps/api/src/core/staff.rs:141`
  asserts `key.secret()` **equals** `SECRET` — that is a property of `parse`, not of
  authentication, and it passes with the verifier absent.
- `platform_ops.rs:843` asserts `input.credential_hash.len() == 64` — that the hash is *stored*,
  never that it is *compared*.
- No gate drove `/api/v1/internal/**` at all. This family is the one V01-033 found **three
  permanently dead routes** in, and the reason they were dead is that nothing exercises it.

## Root cause

`require_staff` parsed the presented `StaffKey`, looked the row up by prefix, checked that the stored
role parses and the principal is active, and returned. It never read `key.secret()`. The
`StaffKey` was constructed *inside* `resolve_staff_credential`, which takes the whole presented
string and returns a row — so nothing downstream could reach the secret even in principle.

The column was not decorative by accident: `platform_ops.rs` inserts it, a struct field carries it,
and a unit test asserts `credential_hash.len() == 64`. It was written, validated, and never compared.

## Fix

`apps/api/src/http/auth.rs`. Parse the key in `require_staff` (so the secret is reachable on this side
of the lookup) and compare, in constant time, exactly as the machine path eleven lines above does:

```rust
let presented_staff_hash = machine_secret_hash(key.secret());
if !core_constant_time_eq(
    presented_staff_hash.as_bytes(),
    resolved.credential_hash.as_bytes(),
) {
    return Err(staff_authentication_required(context));
}
```

`staff_authentication_required` is the **same** error the nonexistent-prefix case returns, so A4's
non-disclosure comparison holds. That was not incidental: pre-fix the two answers differed (`200`
versus `401`), so the defect was an existence oracle as well as an authentication bypass, and a fix
using a different error would have closed only half of it.

## Regression proof

`pnpm verify:staff-credential` (`apps/api/scripts/v01-staff-credential-probe.mjs`), which the
campaign added in the same round. Behavioural, over real HTTP, against a real D1:

- **C1** the correct secret is accepted — and it runs **first**, and a red C1 stops the probe, because
  a refusal alone is satisfied by a route that refuses everyone.
- **A1 / A2** two *different* well-formed forged secrets are both refused `401`. Two shapes, so A1 is
  not one unlucky string.
- **A3** a forged secret on a **write** route, graded on the **stored row in D1**, not the status: a
  `2xx` that ignored the token would be correct and a `2xx` that applied the write is a breach.
- **A4** a wrong secret and a nonexistent principal answer **identically** once `request_id` is set
  aside. Not "both non-2xx" — that passes straight through an existence oracle.
- **A5** no credential material appears in an authenticated internal listing.

**9/19 with 2 skipped → 22/22 with 0 skipped**, exit 0, the probe byte-identical across the repair
except for three *probe* fixes recorded in the file.

## Regression gap that closed

`core::staff`'s own test asserts `key.secret()` **equals** the expected secret. That is a property of
`parse`, not of authentication, and it passes with the verifier absent — which is why nothing failed
when the verifier was missing. The gap is now a real HTTP case with a control that must be green.

## Residual risk, stated rather than implied

A `16`-hex-character prefix is the only thing an attacker needs, and it is not brute-forceable in
the aggregate. So this is disclosure-dependent rather than unauthenticated — **and that is exactly why
it cannot be waved through**: the system has an authentication factor and was simply not checking it.
The prefix is also carried into `StaffActor` and from there into audit rows, so it is a value the
system itself propagates. Suspension remains the only control that works, and it is not discoverable
from the token.

## Severity

**CRITICAL**, on the basis that the affected surface is the platform control plane and the factor
exists but is unchecked. Re-assess to HIGH if the prefix can be shown never to leave the database.
