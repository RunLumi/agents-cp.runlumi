# Finding VFY-002 — A new user cannot verify their email from the web, so cannot create an organization

## Status

open

## Severity

**critical** (blocks the entire control plane for every self-service signup)

## Affected claim

- Claim ID: `AUTH-ONBOARD-1`, `VI-CON-001`, `VI-UX-002`
- Source requirement: `docs/specs/f01-identity-authentication.md` FR-F01-002 and the F01 Web
  UX route list (`/verify-email`); `docs/specs/f02-organization-tenant-lifecycle.md`
  FR-F02-001; `docs/specs/f22-web-control-plane-ux-information-architecture.md` FR-F22-003,
  FR-F22-011
- Risk tier: 0 (a whole cohort of users cannot onboard) with Tier-2 UX consequences

## Statement

`POST /api/v1/auth/verify-email` works and is proven, but no web control ever calls it, so a
self-service user who signs up can never set `email_verified`; because every mutating
permission requires a verified email, `POST /api/v1/orgs` then returns
403 `email_verification_required` forever, and the web UI shows a misleading
"Ask an administrator to grant access" message.

## Reproducer

### Preconditions

```text
pnpm db:migrate:local
cd apps/api && wrangler dev --env development --local --port 8787
cd ../../apps/web && vite --host 127.0.0.1 --port 5173
```

### Action

In a real browser at `http://localhost:5173/`:

1. **Create account** → **Continue with password** → email + name + password → submit.
2. The screen changes to *"Verification required …"* and shows a **Development verification
   code** block and a single button, **Continue to sign in**.
3. Press it, sign in, and try to create an organization.

Programmatically, from the page (`evidence/browser-probe.mjs`):

```js
// after the signup response
await fetch("/api/v1/orgs", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf,
             "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({ display_name: "VFY Org" }),
});
```

### Expected

Either the verification screen offers a control that submits the one-time code (F01 lists
`/verify-email` as a web route), or the user is told the concrete blocker and the UI's error
states the real cause.

### Actual

1. `verifyEmail()` exists in `apps/web/src/lib/api.ts:410` and **has no call site**:
   ```bash
   grep -rn "verifyEmail\|verify-email" apps/web/src
   # ./lib/api.ts:410:export async function verifyEmail(
   # ./lib/api.ts:415:    "/api/v1/auth/verify-email",
   ```
2. The auth screen renders the code input and a "Continue to sign in" button and nothing else;
   the `submit` handler has no `method === "code"` branch.
3. `POST /api/v1/orgs` returns:
   ```json
   {"error":{"code":"permission_denied","message":"Verify your email before creating an organization.",
             "request_id":"req_…","details":{"reason":"email_verification_required"}}}
   ```
4. The UI renders that as **"Ask an administrator to grant access to this action."**
   `presentApiError` maps every 403 to `Access not permitted`, and
   `email_verification_required` is not in `P05_OPERATIONAL_CODES`.

## Evidence

`evidence/browser-probe.mjs` (this run):

```text
PASS  the web shell offers no control that submits the one-time email code
PASS  email verification succeeds when the client actually calls the endpoint  — status=200
      {"user":{…,"email_verified":true,"id":"usr_d5694698…"}}
```

The 200 above is the probe calling `/api/v1/auth/verify-email` by hand. It is the proof that
the **server** path is fine and the **client** step is missing.

## Why it matters

- Every self-service signup is a dead end: the account is created, the session works, and the
  user can read `/api/v1/me`, but the first action F02 asks for — create an organization —
  is refused, and the refusal is misattributed to permissions.
- The only working path today is a script that reads `development_code`, which does not
  exist outside a development environment, so **production signups cannot onboard at all**.
- The error copy violates F22 FR-F22-011 directly: it does not say what failed, and it points
  the user at an administrator who has nothing to grant.

## Root cause

The email-verification step is missing from the auth screen, and the P05 code-specific error
table has no entry for `email_verification_required`, so the generic 403 branch handles a
user-actionable failure.

## Repair constraints

- do not weaken: F01 FR-F01-002 (email verification is separate from authenticator
  verification), F04 FR-F04-003 (deny by default), F22 FR-F22-011.
- do not relax `requires_verified_email` to make signup work; the fix is the missing step.
- `POST /api/v1/auth/verify-email` and its rate limiting are already correct and must not move.

## Regression requirement

- a web test that fails while `verifyEmail` has no call site (for example: render the
  verification screen, submit, and assert the code endpoint was called);
- an error-presentation test asserting `email_verification_required` produces actionable copy
  rather than the generic 403;
- a browser probe step that signs up with password only, never calls `verify-email` by hand,
  and still reaches the organization shell.

## Closure evidence

- fix commit: _pending_
- original reproducer: _pending_
- focused regression: _pending_
- affected proofs: `AUTH-ONBOARD-1`, `VI-UX-002`, F01/F02/F22 acceptance
- mutation/fault check: _pending_
- broader gate: `pnpm check` + a browser journey that stops using the manual
  `verify-email` call in `evidence/browser-probe.mjs`

---

# Closure — 2026-09-27, after the repair loop

**Status: CLOSED.** `VI-ONBOARD-1` FAIL → PASS. Full evidence: [`repair-closure.md`](../repair-closure.md).

## Two defects, not one

The missing submit branch was the blocker. The **error copy was a second, independent defect**:
`presentApiError` mapped every 403 to *"Ask an administrator to grant access to this action"*, so
the one 403 that is a self-service blocker was reported as something only an administrator could
fix. Fixing the branch alone would have left a user who somehow hit the 403 with no way forward.

## What was done

- **`apps/web/src/features/auth/email-verification-form.tsx` (new).** The step, extracted as its
  own component. The defect was the *absence* of behaviour, and absence is what a test cannot
  see; the reason it was invisible is that the step lived as anonymous JSX inside a large
  `useState` machine, where no test could reach it and no test could fail. It renders a real
  `<form>` with a labelled, named, `autocomplete="one-time-code"` field; a submit that is disabled
  until a code is typed and while the request is in flight; an error rendered as `role="alert"`
  with the request ID per F22-011; and "Skip for now" as a **secondary** action, because F01-002
  permits a session before verification but the consequence of skipping is that every mutating
  action is refused.
- **`auth-screen.tsx`.** The `method === "code"` submit branch now calls `verifyEmail`. The
  orphaned code input that lived outside any form is removed, so `id={codeId}` appears exactly
  once and the label association is valid.
- **`lib/errors.ts`.** `email_verification_required` is matched **before** the generic 403 branch
  and requires `status === 403` *as well as* the reason, so a reason echoed on another status
  cannot claim the user should go and verify their email. A test I wrote asserts exactly that, and
  it caught my own first implementation, which checked the reason alone.

## Regression proof

10 new cases in `auth-screen.test.tsx`, each confirmed sensitive:

| Mutation | Result |
|---|---|
| submit control removed from the form | 2 tests FAIL |
| the specific 403 branch disabled | 1 test FAIL |
| neither | 10/10 pass |

The disabled-state assertions scope to the opening `<button>` tag and require a real attribute
boundary, because the button's `className` contains `disabled:cursor-not-allowed` — a naive
substring match passes on an **enabled** button, and the assertion is worth nothing.

## Behavioural proof, and the fallback that was deleted

The browser journey signs up with a password, reads the code the development build displays, types
it, and submits **through the UI**. It observes the request being issued and its status, then
confirms `/api/v1/me` reports `email_verified: true`.

The manual `POST /api/v1/auth/verify-email` fallback from the V00 evidence copy is **deleted**. It
existed to keep the rest of the journey testable and in doing so hid the defect it worked around.
A verifier that repairs its own subject stops being a verifier.

Two probe bugs were found and fixed while doing this, both of which had produced *false* evidence:

1. The code was extracted with `/\d{6,}/` out of `document.body.innerText`, assuming a short
   numeric code. The real development code is a **64-character hex string**, so the regex matched a
   numeric run *inside* it and submitted garbage — which the server correctly refused with 401. A
   verifier that mangles its own input and then reports the product is worse than no verifier.
2. The post-signup wait matched the literal string "Verification required", and timed out once the
   step was repaired and reworded. It now matches on **structure** (the form, the switcher) rather
   than copy, because a verifier coupled to marketing copy breaks when the copy is fixed.
