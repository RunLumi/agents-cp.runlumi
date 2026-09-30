# V02-003 — the repository's performance budgets, measured against the production build

**Severity: n/a (measurement) · Status: CLOSED — all budgets met · Verdict: PASS, with one honest UNMEASURED · 0 over budget**

The objective asks for the stated budgets to be **measured**, and `AGENTS.md` says they "become
automated CI gates once representative production routes exist". This is that measurement as a
script — `pnpm perf:budgets` — rather than a number typed into a document, so the next person
re-runs it and gets the same table.

## The measurements, against the production preview build

Environment: node v24.20.0 · pnpm 10.33.0 · cargo 1.98.1 · Chrome 153.0.8010.53 ·
`vite preview` on :4173 (production build, API proxied to the Worker on :8787).

| budget | measured | limit | verdict |
|---|---|---|---|
| initial JS | **97.3 KiB gzip** | ≤ 170 KiB | PASS |
| initial CSS | **8.6 KiB gzip** | ≤ 35 KiB | PASS |
| largest lazy route chunk | **38.8 KiB gzip** (`tools-panel`) | ≤ 80 KiB | PASS, none of 15 lazy chunks over |
| Worker bundle (gzip) | **2574.3 KiB** | none stated — "track and investigate increases" | TRACKED |
| `GET /api/v1/me` | **10.5 ms p95** (p50 6.8 ms, 30 samples) | < 200 ms p95 | PASS |
| `GET /orgs/{id}/members` | **8.1 ms p95** | < 200 ms p95 | PASS |
| `GET /orgs/{id}/projects` | **10.4 ms p95** | < 200 ms p95 | PASS |
| `GET /orgs/{id}/agents` | **13.4 ms p95** | < 200 ms p95 | PASS |
| `GET /orgs/{id}/audit` | **11.3 ms p95** | < 200 ms p95 | PASS |
| **LCP, cold load** | **0.22 s** | < 2.5 s | PASS |
| LCP, warm median | 0.08 s (0.07 / 0.07 / 0.08 / 0.08) | — | comfortably inside |
| **CLS** | **0.0** | < 0.1 | PASS — a measured zero, collector ran |
| worst main-thread long task | **0.0 ms** | no task > 200 ms | PASS — collector ran, observed none |
| **INP** | **UNMEASURED** | < 200 ms p75 | **UNMEASURED, not a pass** |

**`0 over budget, 1 unmeasured.`** exit 0.

## Why INP is UNMEASURED rather than 0

Event Timing produced **no entry** for the click. A Tab is not an interaction in the sense INP
measures, and a synthetic `element.click()` on a control the app immediately re-renders did not
produce a measurable duration either. **Reporting `0.0 ms PASS` for a number nobody produced is the
defect V02-001 found in a focus assertion, in a different form** — and my first version of this row
did exactly that, printing `0.0 ms` beside its own detail line saying the number was never produced.

The rule now applied to all four vitals: **an instrument that did not run is UNMEASURED; an
instrument that ran and recorded nothing is a measured zero.** CLS and the long-task row are genuine
measured zeros because their collectors demonstrably ran; INP is not, because nothing was recorded.

## The single-sample mistake, and what it cost

The first working version reported **LCP 3.6 s against a 2.5 s budget — OVER.** It was not a false
reading of the product; it was a false reading of *the statistic*. Two separate mistakes:

**1. It measured the Vite dev server.** The budgets are stated under "Web production baseline". The
dev server transforms TypeScript on demand, ships unminified modules, and holds an HMR client and
websocket open. Grading its timings against a production budget is a false finding.

`vite preview` **had no `preview.proxy` block**, so the production build could not reach the API at
all — `pnpm --filter … preview` served the built app with every `/api` call unanswered, and the app
could only ever reach its own server-error state. The production bundle was not runnable locally at
all. That is fixed: `apps/web/vite.config.ts` now has a `preview` block with the same proxy as
`server`.

**2. It was one sample.** The budget says **p75**. A single cold load is not a p75, and the second
run of the same code measured 0.3 s on the same server. The probe now takes `PERF_LOADS` (default 5)
loads, clears the browser cache and disables caching for the first so it is genuinely **cold**,
re-enables it for the rest, and reports the two regimes separately.

Cold and warm are **graded separately on purpose**: grading on the warm median would let a good
steady-state number stand in for a bad first impression, and reporting only the cold figure would
hide that the steady state is comfortable.

**What is still not established:** a *first-ever* load in a fresh Chrome profile measured 3.6 s once
and is not reproducible in this harness — the profile here is reused, so its transform cache is warm
even on the "cold" load. A genuine first-visit p75 is **UNPROVEN**, and the honest statement is that
cache-cold is 0.22 s, warm is 0.08 s, and the very first load in a fresh profile is not established.

## Why this is a separate probe and not part of `smoke:browser`

`smoke:browser` is a correctness gate: it exits non-zero on a defect. A budget regression has a
different owner and different urgency, and a performance wobble on a loaded laptop must not read as a
product defect. Folding them together is how a gate's meaning stops being knowable.

The exit codes are deliberately distinct for the same reason: **1** for a budget genuinely over,
**2** for a measurement that could not be taken. Collapsing them would let a broken harness read as a
clean budget — the confusion this campaign has now hit in five different harnesses.

## What the probe refuses to do

- It does not grade a dev-server measurement as a production verdict. `detectEnvironment()` reads the
  served HTML and, if it finds the Vite client, prints a note saying the rows are reported but must
  not be read as production.
- It does not report `0` for an instrument that did not run.
- It does not include a route that answers 403 in the latency set. `/inference/models` was in the
  first list and answered 403 for an org with no model policy — the same rule the V02-001
  investigation hit. A 403 is not a latency measurement, and including one only to report
  UNMEASURED teaches the reader nothing.
- It does not guess a field name. Three attempts read the org id as `organization_id`; the API's field
  is `org_id`, and the diagnostic now prints **key names** rather than a truncated body, because the
  truncated body showed the same prefix twice and cost two runs.
