# V02 browser-state coverage — what the gate claims, what it proves, and what is absent

**Campaign: V02 Runtime, Browser and Operations · Recorded: 2026-09-30 · Updated after V02-002 ·
Baseline: `smoke:browser` 52/52, exit 0, stable over three consecutive runs**

The objective names twelve browser states to verify. This is an honest map of the current gate
against that list, because **"the gate has a check" is a claim about the check, and the check's own
sensitivity is the evidence.**

## The headline

**Of the twelve required states, one has a *product-side* sensitivity proof — and that one is the
state that was previously over-claimed.**

**All twelve are now exercised in a real browser. One (12) is partial. None is absent.**

| | state | status | basis |
|---|---|---|---|
| 9 | narrow layout | **PROVEN** | 5 checks at 390 px: document overflow, clipped controls, the Members table's role column, the role control inside the viewport, and a 44×44 touch target |
| 11 | stale data after org switch | **PROVEN** | 24 DOM samples per direction, 0 leaks, both directions asserted |
| 3 | success | **PROVEN** | org created, second org created, switcher populated, session live |
| 8 | visible focus | **PROVEN, after V02-001** | repaired to a delta; sensitivity proof in `evidence/v02-001-focus-sensitivity.sh` |
| 1 | loading | **PROVEN, after V02-002** | a **delayed** request — a rejected one never renders a loading state, so a failure would have satisfied the case for the wrong reason |
| 5 | server error | **PROVEN, after V02-002** | `Fetch.requestPaused` fails only `/api/v1/me`, so the document still loads and the app mounts and takes its real error path |
| 6 | retry/recovery | **PROVEN, after V02-002** | clicking the app's own retry against a restored network returns to the shell **and names the organization** — so recovery restored the session, not merely the page. **This is the control for the two rows above.** |
| 2 | empty | **PROVEN, after V02-006** | a zero-organization account is offered the create panel; the form is labelled; it does not reuse the error surface — **with a control** re-read once populated |
| 4 | permission denied | **PROVEN, after V02-006** | a URL naming an org the session cannot see renders `role="alert"`; the content region carries the refusal and not the previous org's data; and a recovery leg proves it is not a dead end |
| 10 | destructive confirmation | **PROVEN, after V02-006** | Revoke opens a confirmation whose copy states the consequence; **dismissing it leaves the credential alive**; accepting it removes the control and shows a revoked status — while the row stays as an audit surface |
| 7 | keyboard navigation | **PROVEN, after V02-006** | `Tab` reachability (V02-001) plus a **real** `ArrowRight` through CDP — the synthetic `KeyboardEvent` is gone |
| 12 | one-time secret lifecycle | PARTIAL | the email code is covered end to end, including a refused short code; a real secret (download grant, webhook secret) is not |

**The gate now exercises all twelve states in a real browser.** What separates them is not coverage
but *evidence*: state 8 has a product-side sensitivity proof, and the rest have been watched to go
red only on harness faults.

### An honest distinction about states 1, 5 and 6

These three are **PROVEN** in the sense that a real fault now drives them and the rendered outcome is
asserted — not merely that a branch exists in the source. Two distinctions are still owed and are not
claimed:

1. **The probe has been observed reporting FAIL on them**, but on *harness* faults rather than on
   product faults — three red cases during development, all three of which turned out to be my own
   bugs (a request-id expectation the product was right to omit, a `waitFor` predicate returning an
   always-truthy object, and an assertion reading a field I had just renamed). That is weaker than a
   product-side mutation: it proves the instrument can go red, not that it would go red on this
   class of product defect.
2. **No sensitivity proof exists yet** for this class. `evidence/v02-001-focus-sensitivity.sh` covers
   the focus class; an equivalent for the loading/error/retry class is outstanding, and until it is
   written these three rows are PROVEN-but-not-yet-proven-to-fail — which is the same category state
   8 sat in before V02-001.

## What V02-002's own failures say about the three states

Worth recording, because the three red cases were **all mine and none were the product's**:

- I asserted the error state *always* names a request id. It does not, and it should not: a
  network-level failure has no HTTP response and therefore no id, and `app.tsx:90` renders the line
  only when the id is truthy. Rendering a dangling `Request ` would have been the defect. The
  assertion is now the **inverse** and worth more — the copy must contain no dangling request label.
- My recovery predicate returned an object, which is always truthy, so `waitFor` returned on its first
  poll and sampled while the app was still in `loading`. Its diagnostic read `stillError=false`,
  which is true of every state *except* `error` and therefore says nothing about recovery.

And the first instrument was wrong in a way that would have read as a missing feature: taking the
whole page **offline** fails the *document navigation* too, so the app never mounts and the probe
timed out waiting for an error screen that had no opportunity to exist.

## Why V02-001 is the important entry in this table

State 8 was marked covered before V02-001, and it was not. Its assertion was

```js
(boxShadow && boxShadow !== "none") || (outline && !outline.startsWith("none"))
```

which `rgba(0, 0, 0, 0)` satisfies, and which **any resting shadow** satisfies — and every control in
this design system is `rounded-lg` with a border and a drop shadow. It would have passed with the
focus ring deleted from the source.

**So the gate's green sheet was reporting coverage it did not have, on a state the objective names
explicitly.** That is the finding the rest of this map is calibrated against: a browser check that
reports a state as covered is a claim, and here the claim was false in the direction that matters
most — it would have concealed a real accessibility regression.

The generalisable rule this campaign has now enforced repeatedly, in a fourth distinct harness:

> **A check that cannot be watched to fail is not evidence that the thing works. It is evidence that
> nobody has looked.**

## What the remaining absent states cost, concretely

**Permission denied (4)** — the highest-value absence, and unchanged. The whole control plane is
authorization-first, and V01 spent a campaign on server-side authority: 96/96 privilege-escalation
cases, cross-tenant substitution, stored-state grading. **None of that is verified as a user-visible
state.** A route that correctly returns `403` can still render an empty shell, a spinner, a crash, or
stale previous organization's data — and the current gate would not notice any of it. It also needs a
second identity, which is why it was not folded into the cheaper instrumented-failure work.

**Empty (2)** — a new organization with nothing in it is the **first thing every real user sees**,
and it is unverified. Empty-state copy, an empty collection's affordances, and a destructive
confirmation (10) are all the same surface, and none of them is exercised.

**Destructive confirmation (10)** — the objective names it separately, which suggests the risk is
known. `AGENTS.md` requires *"destructive actions require clear consequence copy and an appropriate
confirmation pattern"*, and there is no browser evidence that any destructive action has a
confirmation at all.

**Server error (5) is now closed**, and its history is the argument for the map existing at all. It
had a `SessionError` branch with a retry control, reached when `getMe()` fails with anything other
than `401` — never rendered by a test. **This session hit that state by accident first**: the first
`smoke:browser` run of the day timed out waiting for the auth screen *because* the API was not
running, and the probe reported a bare "timed out waiting for auth screen" — a symptom of the
server-error state with no indication that the UI was showing a failure screen rather than the
sign-in form. A state that had been in the product the whole time, and that the gate could not tell
you about, because it had never been driven.

**Loading (1) is now closed**, and it needed a *different* fault than server error rather than the
same one: a rejected request never renders a loading screen, so the failed-request case would have
been the only measurement and it would have passed for the wrong reason.

## The three remaining absences are absent from the GATE, not from the product

Worth recording, because it changes the cost of each one by an order of magnitude — and because
"absent" is a statement about *coverage*, not about the code.

**Permission denied (4) already exists and is well designed.** `org-dashboard.tsx` computes

```ts
const unauthorizedPath = Boolean(
  pathSlug && !me.organizations.some((item) => item.organization.slug === pathSlug),
);
```

and renders, when a URL names an organization the session cannot see:

```
role="alert"
  <h1>Organization not found</h1>
  This organization is not available in your current access scope.
```

Two things make this better than the obvious alternative. It is **in the DOM**, so a browser assertion
grades on what a user actually sees. And it deliberately answers a foreign organization and a
nonexistent one **identically** — "not found", not "forbidden" — which is the non-disclosure property
V01 proved at the HTTP layer, now visible at the UI layer. A test can assert both legs of that with
one navigation each, and a mismatch would be a real finding.

**Empty (2) also exists**, and it is the first thing a new user sees: `me.organizations.length === 0`
routes to `<CreateOrganizationPanel />`. Note also that the zero-organization path builds its state
from a **fabricated** `emptyOrganization()` — every field a blank string. That is defensible for a
placeholder and worth watching: the *same* helper would be indistinguishable from real data if a
fetch ever failed into it, and it is currently reachable only from `!selectedId`, not from an error.

**Destructive confirmation (10) exists in two distinct patterns**, which is more than the single
`window.confirm` a first search suggested:

- **Automations** route delete through `openAction("delete", …)` → `setPendingAction(…)`, an in-DOM
  confirmation surface. 23 delete references across that feature.
- **Credential revoke** uses `window.confirm` **with consequence copy** — *"New requests will fail
  immediately; existing usage and audit history …"* — which satisfies the letter of `AGENTS.md:181`
  ("clear consequence copy and an appropriate confirmation pattern"), though a native modal is not
  styleable and is awkward to assert on.

The browser case should therefore target the **automations** surface: it is in the DOM, so the
assertion grades on rendered consequence copy rather than on a native dialog the probe cannot read.

**None of this is evidence.** Three surfaces found by reading source are three *claims* until a
browser drives them. But they turn the next three attacks from "build a feature and find out" into
"drive what is there and see whether it holds".

## What remains

1. **One-time secret lifecycle (12) is the only non-PROVEN state.** The email verification code is
   covered end to end, including a refused short code. A *real* secret — a download grant, a webhook
   secret — is not: nothing observes a value that is shown once and then cannot be retrieved again.
2. **Product-side sensitivity proofs for the V02-002 and V02-006 classes.** Both have been watched to
   report FAIL, but only on harness faults. `v02-004-observability-sensitivity.sh` is the model, and
   it exists because a gate nobody has watched fail is an assumption — the V02-004 sheet was made of
   absences and could have passed on a product that recorded nothing at all.
3. **A design question worth deciding, not just testing.** `AGENTS.md:181` asks for "an appropriate
   confirmation pattern", and credential revoke uses a native `window.confirm`. It does satisfy the
   requirement as written — the copy states the consequence, and the test above proves the dialog
   actually *prevents* the action rather than merely appearing. But a native modal is not styleable
   and is not consistent with the rest of the design system, which uses in-DOM surfaces (the
   automations delete flow is one). Whether that is acceptable is a product decision, and this
   campaign records it rather than resolving it.

## A caution this map exists to prevent

The temptation with a 73/73 sheet is to record the browser pass as done. Twelve named states, one
partial, one exercised by a check that **could not fail** until this session repaired it, and ten
newly exercised by checks whose own sensitivity is still unproven. **The count is telemetry; the map
is the evidence.**
