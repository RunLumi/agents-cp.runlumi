# §4 — Whole-site review

The gap this section exists to close: the existing browser journey visits **4** URLs against **18**
feature areas, and **12** screen references in `docs/screens/` were never compared. This campaign
drove **every addressable section of the control plane in a real browser** and opened **all 12
reference images**, comparing each against the rendered product.

## Instruments

| instrument | result | evidence |
|---|---|---|
| `smoke:browser` (the existing 4-URL journey: passkey-first sign-in with a real CDP CTAP2 virtual authenticator, email verification from the UI, two organizations, switching without stale data, keyboard focus, 390 px) | **91/91, exit 0** | `evidence/v05-smoke-browser.log` |
| **NEW** `evidence/v05-whole-site-probe.mjs` — the whole-site sweep over all **19 addressable sections** (13 top-level nav + 6 settings sub-pages), plus keyboard sign-in, network-injected error/recovery on two sections, the API-key one-time-secret lifecycle, destructive confirmation, and a foreign-account leakage sweep | **93 checks PASS, exit 0** | `evidence/v05-whole-site.log`, `evidence/v05-whole-site-results.json`, 38 screenshots in `evidence/shots/` |
| Screen-reference comparison | **12/12 opened and compared** (WebP → PNG via `sips`; references are marked "Illustrative design reference") | this document's table |

## Per-section coverage (19/19 visited, desktop 1440×900 and 390×844)

Every section: rendered its panel (heading asserted by name), no error boundary, Tab reaches an
interactive element with a **visible focus indicator**, **no horizontal page scroll at 390 px**
(`scrollWidth <= innerWidth`), desktop + narrow screenshots captured, no uncaught page exceptions
across the whole sweep.

`overview, projects, runs (Agents & runs), members, teams, tools (Tools & approvals), models
(Models & routing), usage (Usage & budgets), automations, devices, adoption, policy, settings,
settings/billing, settings/data, settings/webhooks, settings/security, settings/identity,
settings/plugins` — coverage matrix in `v05-whole-site-results.json`.

## The states the objective names, per family

- **Loading / empty**: every section was driven against a **fresh organization**, so each panel's
  empty state is what rendered (and is in the screenshots); the loading state is exercised on every
  navigation (the sweep waits through it).
- **Permission denied**: the existing journey's 403 legs (91/91), plus the foreign-account sweep — a
  second verified account visits this organization's `overview`, `members`, `usage`,
  `settings/billing`: **the owner organization's name, email, and data do not render anywhere**, and
  the browser session stays the foreign account's own.
- **Server error + retry/recovery**: produced at the NETWORK (`Fetch`-level failure injection, the
  browser's own stack, nothing in `apps/web` stubbed) on `usage` (`/api/v1/orgs/*/usage*`) and
  `models` (`/api/v1/orgs/*/routes*`): the section renders its error state, and after release the
  retry recovers. `smoke:browser` additionally drives the offline/malformed/disconnect/delay
  injections (91/91).
- **Keyboard navigation and visible focus**: the auth screen is completed **entirely from the
  keyboard** (Tab order, typed credentials, submitted) as the walked critical path; every section's
  first Tab lands on an interactive element whose focus indicator is not `none`.
- **Destructive confirmation + one-time secret lifecycle**: driven in Settings → Identity & access —
  a service account is created from the UI (the form refuses an account with no capability —
  measured), an API key is created (`POST …/api-keys` 200 on the server), the secret is shown
  **exactly once** in the acknowledge-only reveal (no close button, Escape deliberately cancelled),
  and after acknowledgement **the full secret is gone from the page** while the public prefix
  remains; revoke asks for confirmation and Escape cancels with the key surviving.
- **One-time secret lifecycle, second instance**: `smoke:browser`'s email-verification code and the
  recovery flow (development code shown once) — 91/91.

## Screen-reference comparison — 12/12 opened

| reference | rendered surface | comparison |
|---|---|---|
| `lumi_models_routing` | Models & routing (desktop) | **Matches**: left rail shell + org switcher, breadcrumb, dense catalog table with soft-blue capability chips and state pills, stable-alias chips, warm paper + Civic Navy. Differences: the reference's five tabs (Catalog/Rules/Settings/Evaluation/Activity) are stacked sections in the product; no global search in the header. |
| `lumi_budget_activity` | Usage & budgets → Budgets | **Matches**: same KPI-card grammar (spend/pressure/denied/events), the **same "Usage events are immutable" notice**, tab strip, empty state, and a handled error state with request id + Try again for a sub-resource on a fresh org. |
| `lumi_rate_limits` | Usage & budgets → Rate limits | **Matches**: "Rate limit policies" panel with the same title/description grammar ("the most restrictive applicable limit wins"), empty state on a fresh org where the reference shows illustrative data. |
| `lumi_export_history` | Settings → Data & retention → Export history | **Matches 1:1 on tab structure**: Retention policies / Export history / Data controls / Deletion requests, breadcrumb grammar identical. The product adds the scoped-export **category manifest** (Identity/Organization/Devices/Run metadata/Usage and billing) the reference's empty state does not show. |
| `lumi_account` | Settings → Account security | **Matches**: account summary, passkeys + password-fallback (the reference's "sign-in methods"), Active sessions with per-session revoke, security events reachable. |
| `lumi_plan_entitlements` | Settings → Billing & entitlements | **Structure matches** (plan card, subscription state, capabilities/usage-vs-limits tables) — but see **V05-003**: on a fresh organization the page renders an **error state** ("This resource could not be found" + Try again) where the reference designs a graceful "Not connected" empty state. |
| `lumi_billing_overview`, `lumi_billing_history`, `lumi_billing_invoices`, `lumi_billing_orders`, `lumi_billing_payment`, `lumi_billing_profile` | Settings → Billing & entitlements | **NOT_APPLICABLE as in-product screens, by design**: the page's own copy places invoices, orders, payment methods and billing details in the **provider portal** ("Manage payment method, invoices, and billing details in the provider portal"), and states the page's inputs "are never merged". These five references describe the external portal surface, which this repository does not ship. The plan/entitlements half is compared above. |

Every reference carries an explicit **"Illustrative design reference"** chip; per `DESIGN.md` and
AGENTS.md they are references for structure/hierarchy/density, and do not override Lumi tokens —
none of the compared surfaces violates the canonical tokens (Lumi Blue authority accents, Civic Navy
headings, paper-white canvas, 1px archival borders, 8px radii, navy-tinted elevation, light-only,
glass confined to the floating header, visible focus rings).

## Finding opened in this section

- **V05-003 (LOW, product, UI state)** — Settings → Billing & entitlements on an organization with
  no billing record renders the **error state** ("This resource could not be found", request id,
  Try again) where the screen reference designs a graceful not-connected empty state. Fail-closed
  (no data exposure; the retry does not loop), no crash, no console exception — but the *state
  choice* contradicts the reference, and a brand-new organization's first billing view is an error
  panel. Recorded, not repaired: designing the empty state (what should show when the plan resource
  does not exist) is a product/design decision, not a verification fix.

## Harness notes (the loop working on its own instruments)

The whole-site probe took seven runs to go green, and every fix was to the **harness**, not an
assertion loosened: a submit-picker that matched "Sign in with passkey" instead of the password form
(a real ceremony start, waiting forever); a stale Chrome session from a previous run making the sweep
measure the wrong account (now cleared at start); `document.querySelector("select")` grabbing the
header's **org-switcher** instead of the key form's select, which re-fired organization selection and
wedge the dashboard in "Loading organization…" (a real user cannot re-select the already-selected
option, so not a product defect — but recorded, because the org loader has no error/retry exit from
that state); and the one-time-secret reveal poll (the create triggers an org-level refetch). The
first three sweep executions' logs are preserved as `v05-whole-site.log` (final run) — earlier
failure outputs are summarized here rather than committed, since they measured a harness-shaped
world, not the product.

## What this section does not claim

- Accessibility scanners were not run (the objective notes they are incomplete); the keyboard,
  focus, and manual critical-path checks above, plus `smoke:browser`'s existing 91 assertions, are
  what was actually walked: keyboard sign-in, identity section create/revoke flows, org switcher,
  and every section's first-focus.
- The 390px check is a layout-overflow measurement, not a full visual pass at phone width; the
  38 narrow screenshots exist for a human to eyeball.
- `perf:budgets` was last measured green in V04 (initial JS 97.3 KiB, CSS 8.6 KiB, largest route
  chunk 38.8 KiB vs budgets 170/35/80); this campaign changed no bundled web code, so that
  measurement is carried, not re-run.
