# P08-FE — Adoption status and migration remediation handoff

## What shipped

`apps/web/src/features/adoption/**` plus a lazy section registration in
`features/organizations/org-dashboard.tsx`. Three tabs at
`/org/{slug}/adoption`: Workspaces, Remediation, Compatibility.

## Screen references used

`docs/screens/` has **no reference for adoption, migration, or onboarding**. I
listed the directory and read every file name in it; the available references are
`lumi_plan_entitlements.webp`, `lumi_export_history.webp`, and the P04/P06
captures listed in `docs/implementation/evidence/`. None of them shows a
migration or adoption surface, and none should be read as showing one.

So this surface was built from `DESIGN.md` and the existing panel idioms rather
than from a screenshot, and the following were compared against
`lumi_export_history.webp` as the nearest structural precedent for a
tabbed-settings-within-a-section surface:

- **Density and reading order.** The stage distribution, the table, then the
  detail sheet — the same "summary, list, detail" order the Data & Retention
  surface uses, at the same density.
- **The tab strip.** Same hairline underline, same Lumi Blue active state, same
  roving focus and arrow-key behaviour as `TabNav` in the data-governance feature.
- **Surface material.** White evidence sheet, 1px archival border, Civic Navy
  headings, status colours only where they carry real semantics.

## Deliberate deviations, and why

1. **Adoption is a top-level section, not a Settings sub-page.** F22's tree is
   General / Security / Credentials / Billing / Data / Retention / Webhooks, with
   Integrations / MCP separate. There is no home for adoption there, and it
   answers the other half of the question `devices` answers. Putting it under
   Settings would also imply it is organization configuration, which is the
   opposite of what a user needs to know about it: it is *their* workspaces.
2. **The stage ladder is a component that does not exist elsewhere in the app.**
   A status column would throw away the only thing F26 is about, which is the
   order. The managed rungs carry a distinct left rule so the boundary where an
   organization takes over is visible before any prose is read.
3. **The Compatibility tab carries a "what is never uploaded" list.** The privacy
   invariant is the product. A user deciding whether to hand a workspace to an
   organization wants to read the list, not a link to a policy.

## What I could not verify

**No browser render.** No browser was attached to this session, so there is no
screenshot evidence for desktop, narrow, or keyboard states. The panel is
verified with `renderToStaticMarkup` against real markup — 76 tests across
`api.test.ts`, `helpers.test.ts`, and `render.test.tsx` — which asserts the
load-bearing copy, the accessibility shape (`aria-busy`, `aria-current="step"`,
`role="alert"`, `role="status"`), and the absence of any control that could carry
local content. That is not the same as seeing it, and the P06 handoff records the
same gap for the same reason.

Keyboard and focus are addressed in the markup rather than observed: every
control is a real `button`, the tab strip is a `nav` with `aria-current="page"`,
the ladder is an `ol` with `aria-current="step"`, and focus rings are the
repository's `focus-visible:ring-2` token on every interactive element. The
animation is a single `animate-pulse` in `LoadingRows`, inherited from the shared
primitives and removed by `prefers-reduced-motion`.

## Performance

`vite build` after the change:

```
dist/assets/adoption-panel-DwtVc9ZV.js   37.78 kB │ gzip: 10.33 kB
dist/assets/index-DXa5u9Z0.js           369.78 kB │ gzip: 99.97 kB
```

The panel is lazy and its chunk is 13% of the 80 KiB route budget. The initial
chunk is byte-identical to before the change, which is the property that mattered:
a section most sessions never open must not cost the sessions that do.

## Test coverage

| File | Tests | What it pins |
|---|---|---|
| `api.test.ts` | 20 | Allowlist decoders never spread; an unrecognized enum decodes to `null` with its raw value; a missing frozen field fails the response; the stage ladder is the adoption order; the credential modes are in escalation order |
| `helpers.test.ts` | 34 | A workspace that adopted nothing has no problem; "managed" without a derived problem is healthy; the ladder marks the managed boundary; open remediations sort above resolved in the frozen order; every credential mode's copy says what it does to the key |
| `render.test.tsx` | 22 | No control that could carry local content exists anywhere; the loading, empty, permission, and error states are announced; the reason code and request id are shown and the server's prose is not; an unrecognized problem offers no action |

## Two rules worth keeping

1. **A workspace that adopted nothing is never shown a problem.** Doing nothing is
   a supported state, and a console that nags a local-only user is how a staged
   migration stops feeling staged.
2. **An unrecognized code says "unrecognized".** A control plane newer than this
   build must not be able to make the console claim a user reached a stage they
   did not, or that a workspace has no problem when it has one.

Both are one line of code each and both were got wrong on the first pass; the
tests are the reason they are right now.
