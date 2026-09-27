# Finding VFY-003 — A user who already belongs to one organization cannot create a second

## Status

open

## Severity

high

## Affected claim

- Claim ID: `VI-UX-001` (prerequisite), `ORG-LIFECYCLE-1`
- Source requirement: `docs/specs/f02-organization-tenant-lifecycle.md` FR-F02-001 and F02 Web
  UX ("create org"); `docs/specs/f22-web-control-plane-ux-information-architecture.md`
  FR-F22-001 (organization switcher)
- Risk tier: 2 (blocks a primary journey and makes the org-switch state unreachable in
  practice)

## Statement

`showCreateOrg` is initialised from `me.organizations.length === 0` and is never set back to
`true`, so the create-organization panel is unreachable once a user belongs to any
organization. The API accepts a second organization; only the UI hides it.

## Reproducer

### Preconditions

An authenticated, email-verified user with exactly one organization (the state every
successful signup reaches — see VFY-002).

### Action

```text
1. Sign in and land on the organization shell.
2. Look for any control that opens "Create an organization".
```

Programmatic, from the page (`evidence/browser-probe.mjs`):

```js
[...document.querySelectorAll("button")]
  .filter((b) => /create an organization|new organization/i.test(b.textContent));  // -> []
```

### Expected

F02 lists "create org" as a web surface; a user should be able to create another
organization.

### Actual

No such control exists. The panel is gated by:

```tsx
// apps/web/src/features/organizations/org-dashboard.tsx:284
const [showCreateOrg, setShowCreateOrg] = useState(me.organizations.length === 0);
// :508
) : me.organizations.length === 0 || showCreateOrg ? (
// :511  setShowCreateOrg(false);
```

`setShowCreateOrg(true)` appears nowhere in the file:

```bash
grep -n "setShowCreateOrg" apps/web/src/features/organizations/org-dashboard.tsx
# 284:  const [showCreateOrg, setShowCreateOrg] = useState(me.organizations.length === 0);
# 508:  ) : me.organizations.length === 0 || showCreateOrg ? (
# 511:                  setShowCreateOrg(false);
```

The server is not the limit — the same session creates the second organization over HTTP:

```text
FAIL  a SECOND organization can also be created through the UI
PASS  the API itself accepts a second organization (so the limit is the UI, not the server)
      — status=201 {"membership":{…},"organization":{…}}
```

## Why it matters

- F22's organization switcher is a headline navigation element and `VI-UX-001` is defined
  over it, yet the product cannot *reach* a two-organization state from its own UI. The
  browser probe had to create the second organization through the API to test the switch at
  all, which is a real limitation on the claim's evidence.
- A user who genuinely needs two organizations (a client org and a personal org) has no
  route. F02 recommends a single `kind = personal | team` organization model; a personal org
  cannot be created after the first one.
- It is the second dead end in the same panel: combined with VFY-002, the create-organization
  surface is the weakest part of the product.

## Root cause

`showCreateOrg` is a one-way latch. It models "this user has no organization yet" as a
terminal UI state instead of as an action the user can take.

## Repair constraints

- do not weaken: F02 FR-F02-001, F04 authorization, F22's information architecture.
- the entry point belongs in an existing surface; F22's tree has no "Create organization"
  top-level item, so a control on the organization switcher or in Settings is the natural
  home, matching the existing "Settings landing" pattern.

## Regression requirement

A web test that fails while `showCreateOrg` cannot be re-entered: render the shell with
`me.organizations.length === 1`, click the create-organization control, and assert the form
appears; plus a browser probe step that creates two organizations through the UI only and
drops the API fallback.

## Closure evidence

- fix commit: _pending_
- original reproducer: _pending_
- focused regression: _pending_
- affected proofs: `VI-UX-001`, `ORG-LIFECYCLE-1`
- mutation/fault check: _pending_
- broader gate: `pnpm check` + the browser probe with the API fallback removed

---

# Closure — 2026-09-27, after the repair loop

**Status: CLOSED.** `ROUTE-2` FAIL → PASS. The `VI-UX-001` evidence limit is discharged.
Full evidence: [`repair-closure.md`](../repair-closure.md).

## What was done

A "New organization" control beside the organization switcher. F22's information architecture has
no top-level create-organization destination, so inventing a nav item would have contradicted the
spec; the switcher is where "which organization am I in" is already answered. It appears only when
the user already has an organization, because with none the create panel is already the whole page
and the control would duplicate the only action on screen.

The control touches **only** the latch. The create-organization branch is evaluated before `load`,
so the panel appears immediately; setting `load` as well would discard the loaded organization and
flash a loading state for no reason.

`CreateOrganizationPanel` now reports *which* organization it created, and the shell selects it and
returns to Overview. Creating an organization and being left staring at the previous one is a
silent no-op from the user's point of view.

## Regression proof

8 cases in `org-dashboard.test.ts`. Two of them fail while the latch exists — verified by
removing the control (3 fail) and by restoring `min-w-[620px]` (1 fails).

Two assertions are deliberately *structural* rather than convenient:

- **"in the header"** is checked as "after the switcher's `</select>` and before `<main`". The
  first version measured a character distance, which a single explanatory comment pushed past the
  threshold — a check that fails or passes for reasons unrelated to the property.
- Class assertions strip comments first, because a class named in an explanatory comment is not a
  class on an element.

## Behavioural proof, and the fallback that was deleted

The journey now asserts the control exists, opens it, creates the second organization **through the
UI**, and requires the switcher to list both. The two checks are separate on purpose: "the control
is absent" and "the panel cannot be opened" are different failures, and a fix that added a control
which did nothing would pass only the first.

The `POST /api/v1/orgs` fallback from the V00 evidence copy is **deleted**. It created the second
organization out of band and reloaded so the switcher claims stayed testable — which meant the
switcher evidence depended on the probe repairing its own subject.
