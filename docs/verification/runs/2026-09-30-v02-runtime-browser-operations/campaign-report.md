# V02 campaign report — runtime, browser, and operations verification

**Run: 2026-09-30–10-02 · Recorded from real runs, not from intention · HEAD `84e71ef` · 3 commits
since the V01 merge (`870f116`): the V02 squash (`a1f5f4a`, PR #41, CI green) + V02-011 + V02-012 ·
29 files changed, +6969/−40 · the pre-squash 33-commit narrative is preserved at tag
`v02-campaign-history` (identical tree)**

## Environment, stated because a measurement without it is not a measurement

| | |
|---|---|
| OS | Darwin 27.0.0 (macOS) |
| node | v24.20.0 |
| pnpm | 10.33.0 |
| cargo | 1.98.1 |
| browser | Google Chrome 153.0.8010.53 |
| Worker runtime | `wrangler dev --env development` (workerd, local D1) |
| build | `vite build` production artefact on `vite preview` :4173, API proxied to :8787 |

## Commands this campaign added or changed

| command | what it is | result |
|---|---|---|
| `pnpm smoke:browser` | the real-browser journey, extended from 42 → **90** checks | **90/90, exit 0**, stable ×4 |
| `pnpm perf:budgets` | measures the repository's stated budgets against the production build | 0 over budget, 1 honestly UNMEASURED |
| `pnpm verify:observability` | one request id followed through the system + credential canaries | 26/0/2, or **28/0/0** with `OBS_LOG` |
| `evidence/v02-001-focus-sensitivity.sh` | sensitivity proof, focus class | 0 detected, 2 declared KNOWN MISSED |
| `evidence/v02-004-observability-sensitivity.sh` | sensitivity proof, observability class | **M1 DETECTED**, exit 0 |
| `evidence/v02-006-permission-denied-sensitivity.sh` | sensitivity proof, permission-denied class | **M1 DETECTED**, exit 0 |
| `pnpm check` | the repository's own gate | **exit 0**, bind-count 463, clippy clean |

## Verdict per claim

### Browser states — the objective's twelve

| # | state | verdict | evidence |
|---|---|---|---|
| 1 | loading | **PASS** | V02-002 — a *delayed* request, not a failed one; a rejected request never renders a loading state |
| 2 | empty | **PASS** | V02-006 — create panel offered, labelled, not the error surface; **with a control** re-read once populated |
| 3 | success | **PASS** | two organizations created through the UI, switcher populated, session live |
| 4 | permission denied | **PASS** | V02-006 — announced `role=alert`, content region carries the refusal, recovery leg |
| 5 | server error | **PASS** | V02-002 — `Fetch.failRequest` on `/api/v1/me` only; the document still loads and the app mounts |
| 6 | retry/recovery | **PASS** | V02-002 recovery + V02-006 recovery-after-denial + V02-010 recovery-after-malformed + V02-012 recovery-after-disconnect |
| 7 | keyboard navigation | **PASS** | V02-006 — a **real** `ArrowRight` through CDP, plus `Tab` reachability; the synthetic `KeyboardEvent` is gone |
| 8 | visible focus | **PASS** (repaired) | V02-001 — was `boxShadow !== "none"`, which a resting shadow satisfies |
| 9 | narrow layout | **PASS** | 5 checks at 390 px, including containment rather than document overflow |
| 10 | destructive confirmation | **PASS** | V02-007 — dialog opened, copy states the consequence, **dismissing leaves the credential alive**, accepting revokes |
| 11 | stale data after org switch | **PASS** | 24 DOM samples per direction, 0 leaks, both directions |
| 12 | one-time secret lifecycle | **PASS** | V02-008 — revealed unmasked, captured through the app's own **Copy secret**, and **absent on return while the endpoint is still listed** |

### Observability

| claim | verdict | evidence |
|---|---|---|
| one request id correlates across request → auth/policy → domain action → dispatch/queue → usage/cost → audit/security event → response | **PASS** | V02-004 — six legs from one `PUT /orgs/{id}/policy`, read from D1 |
| usage/cost leg | **PASS as an absence** | no usage row for a free operation, and an absence is only meaningful because the other five legs found rows |
| no forbidden sensitive content in emitted records | **PASS** | 18 canary assertions over 1.18 MB, **with a positive control** proving the search finds a known-present value |
| the gate can fail | **PASS** | V02-005 — M1 DETECTED |

### Failure injection

| # | injection | verdict |
|---|---|---|
| 1 | connect failure | **PASS** |
| 2 | timeout | **PASS, narrow** — a pending request, not an upstream call |
| 3 | 429 | **BLOCKED** — V01-026, the Worker cannot open an outbound socket on this host |
| 4 | 5xx | **BLOCKED** — same cause |
| 5 | malformed response | **PASS** — V02-010; the one a status-code check cannot see |
| 6 | queue / webhook retry | **PARTIAL** — replay proven; delivery-failure injection BLOCKED |
| 7 | downstream disconnect | **PASS, narrow** — V02-012: Response-stage abort, announced error (not a stuck loader) with retry + control. Narrow: session read, fast local body, no slow-stream cut. |

### Performance — measured against `AGENTS.md`

| budget | measured | verdict |
|---|---|---|
| initial JS | 97.3 KiB gzip | **PASS** (≤ 170) |
| initial CSS | 8.6 KiB gzip | **PASS** (≤ 35) |
| largest lazy route chunk | 38.8 KiB gzip | **PASS** (≤ 80; none of 15 over) |
| Worker bundle | 2574.3 KiB gzip | **TRACKED** — no numeric budget |
| 5 authenticated routes | 8–16 ms p95 over 30 samples | **PASS** (< 200) |
| LCP, cold load | 0.22 s | **PASS** (< 2.5 s) |
| LCP, warm median | 0.08 s | **PASS** |
| CLS | 0.0 — a measured zero, collector demonstrably ran | **PASS** (< 0.1) |
| worst main-thread long task | 0.0 ms — collector ran, observed none | **PASS** |
| INP | — | **UNMEASURED** — Event Timing produced no entry. **Not a pass.** |
| inference TTFT / total with a deterministic stub | — | **NOT COVERED** — blocked with V01-026 |

### Vertical slices

| # | slice | verdict |
|---|---|---|
| 1, 2, 3, 4, 6, 8, 9, 10 | as listed in the objective | **PASS** — see `vertical-slice-coverage.md` |
| 5 | tool-policy allow/deny | **PROVEN (V02-011)** — `verify:tool-policy-deny` 48/48, exit 0, stable ×4. Driving the branch for the first time found and repaired two product defects (fail-open denial, check-order oracle), each sensitivity-proven. |
| 7 | webhook/outbox | **PASS with a known gap** — delivery and replay work; V01-046, fan-out to a subscriber never happens, fail-closed |

## Repaired defects — pre-fix and post-fix evidence

Fourteen findings in this campaign were **verifier** defects or measurement artefacts — and then
V02-011 found two **product** defects, the first of V02. Driving the tool-policy deny branch for the
first time over real HTTP showed (1) a fail-open denial: `INSERT_TOOL_CALL_REF_SQL` hardcoded
`'requested'`, dropping the decided status `call_writes` was given, so a first-time denial left a
ref that still read awaiting-decision and `record_tool_result` accepted a result for the denied
call (`http=200 stored=completed` pre-fix); and (2) a check-order existence oracle: the device
check ran before the organization check, so a foreign-org device got 403 where a phantom run got
404. Both repaired (status bound as `?9`; org check first), both sensitivity-proven (M1: 4 legs
red; M2: 1 leg red), probe 48/48 stable ×5, `pnpm check` green. That is consistent with V01 having
repaired the 54 defects it found: the remaining product defects were the ones no gate had ever
driven, and this is the honest answer to "did the product have bugs" rather than an absence of
looking.

| finding | pre-fix | post-fix |
|---|---|---|
| V02-001 focus | `boxShadow !== "none"` — satisfied by `rgba(0,0,0,0)` and by any resting shadow | delta between unfocused and after a real key press; 42/42 |
| V02-002 error state | blanket `offline` failed the **document** navigation, so the app never mounted and the probe timed out | per-request `Fetch.requestPaused`; 52/52 |
| V02-003 LCP | 3.6 s reported against a 2.5 s budget — measured on the **dev server**, one sample, against a **p75** budget | production preview + `preview.proxy`; cold and warm measured separately; cold 0.22 s |
| V02-003 INP | `0.0 ms PASS` printed beside its own detail saying the number was never produced | an instrument that did not run is UNMEASURED; one that ran and saw nothing is a measured zero |
| V02-004 observability | a column named `event_type` on a table whose column is `action`; a hardcoded machine-specific log path; a denominator that moved with the environment | correct columns; `OBS_LOG`; fixed 28-row denominator |
| V02-005 harness | an all-INVALID sheet exited **0** | INVALID dominates MISSED; `DETECTED→0, MISSED→1, INVALID→2`, verified by extracting the real decision block |
| V02-006 leak check | searched the whole body and read the user's **own** org names out of `#org-switcher` | scoped to `<main>` |
| V02-006 recovery | used `slug`, which is the org's **display name** — so recovery rendered the very denial it was recovering from | slug read from the session's own `/api/v1/me` |
| V02-006 keyboard | fired a synthetic `new KeyboardEvent` — delivered to any listener, proving nothing about a real key | a real `ArrowRight` through CDP, with a precondition and an in-strip assertion |
| V02-007 revoke | clicked the credential container's **first** button — Rotate, not Revoke — and reported "the app does not confirm" | targets the button by its own text; names the buttons it can see when it misses |
| V02-008 secret | guessed the secret's shape three times: a generic token, an endpoint id, then a **`whs_` fingerprint** — which is shown again on purpose, so it reported a leak that does not exist | captured through the app's own **Copy secret** and the clipboard |
| V02-009 harness | `membersNarrow.headers.some(...)` threw when the Members panel was absent, and the run scored **INVALID** — discarding a real signal | `(headers ?? []).some(...)`: a check must **fail** when its precondition is absent, not throw |
| V02-010 driver | the interception handler had **no session filter**, and a throw inside an un-awaited async handler became an unhandled rejection that **crashed the probe** | session filter, collected errors returned on release |

## What is NOT established, stated plainly

- **Eleven of the twelve browser states have no product-side sensitivity proof.** They have been
  watched to report FAIL only on harness faults. Two classes now have one (V02-005, V02-009); the rest
  do not.
- **A first-visit LCP p75 in a fresh Chrome profile is UNPROVEN.** Cache-cold is 0.22 s and warm is
  0.08 s, but a genuine first-visit distribution was measured once at 3.6 s and is not reproducible in
  this harness.
- **INP is UNMEASURED**, not passing.
- **Inference TTFT/total** is not covered, blocked with V01-026.
- **Only one destructive action** is covered; automations delete needs an entitlement
  (`entitlement_grants` is empty, 0 rows) and webhooks have no delete UI.
- **Slice 5 now HAS runtime evidence** (V02-011, 48/48 + two repaired product defects). What it
  does NOT have: sensitivity proofs for the attribution/timeline legs, coverage of a repeat
  decision for the same call (UPDATE branch), or of the `failed`/`cancelled` terminal gates.
- **The `DESIGN.md` / `docs/screens/**` comparison duty is vacuous this campaign** — no UI surface
  changed, so there was nothing to compare. Recorded rather than left silent.
- **Inherited V01 items unchanged**: V01-046, V01-047, V01-050, V01-040, V01-026/GAP-007.

## The standing rule, and how it held

> A check that cannot be watched to fail is not evidence that the thing works. It is evidence that
> nobody has looked.

This campaign found that failure **ten times**, in five different files, and repaired the gate each
time rather than the product. The last two are the most instructive: a sensitivity harness that scored
an all-INVALID sheet as **exit 0**, and a `waitFor` predicate returning an always-truthy object that
sampled while the app was still loading. In both cases the instinct was to record a green result, and
the discipline was the only thing that stopped it.

**The count is telemetry. The maps are the evidence** — `browser-state-coverage.md`,
`failure-injection-coverage.md`, `vertical-slice-coverage.md`.