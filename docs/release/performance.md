# Performance: measured, not estimated

Everything here is a **measurement** from `pnpm build` in this repository at
`1ab395d` (P09, this phase), not a target and not a guess. Where a number could not
be measured in this environment, it says so rather than carrying a plausible
figure.

## The one gate that runs in CI

`AGENTS.md` sets web budgets. `pnpm build` is in `.github/workflows/checks.yml`, so
these numbers are re-measured on every PR — a regression is a red build, not a
quarterly audit.

| Budget | Limit | Measured | Headroom |
|---|---|---|---|
| Initial JS | ≤ 170 KiB gzip | **100.11 KiB** | 41% |
| Initial CSS | ≤ 35 KiB gzip | **8.72 KiB** | 75% |
| Largest route chunk (`tools-panel`) | ≤ 80 KiB gzip | **40.17 KiB** | 50% |
| Route chunk (`data-panel`) | ≤ 80 KiB gzip | **32.41 KiB** | 59% |
| Route chunk (`billing-panel`) | ≤ 80 KiB gzip | **20.43 KiB** | 74% |
| Route chunk (`automation-panel`) | ≤ 80 KiB gzip | **20.31 KiB** | 75% |
| Route chunk (`webhooks-panel`) | ≤ 80 KiB gzip | **16.19 KiB** | 80% |
| **P07 `plugins-panel`** | ≤ 80 KiB gzip | **16.71 KiB** | 79% |
| **P07 `identity-panel`** | ≤ 80 KiB gzip | **16.55 KiB** | 79% |

Every budget is met with real headroom, and the two P07 surfaces are among the
*smallest* chunks in the app — which is the point of route-level code splitting.
**No budget was raised to make a number pass.**

## What the P09 work cost

The honest question is not "are we under budget" but "what did hardening add".

| Change | Cost |
|---|---|
| Initial JS | **0 bytes.** The three audit modules are host-only test code (`#![cfg(test)]`) and are not in the Worker bundle. |
| Initial CSS | **0 bytes.** No styling was touched. |
| Web runtime dependencies | **7, unchanged.** `@base-ui/react`, two fontsource variable fonts, `clsx`, `react`, `react-dom`, `tailwind-merge`. No chart, editor, or highlighting library, and the identity and plugin surfaces build their primitives from the existing `globals.css` tokens rather than adding a component library. |
| Rust dependencies | **15, unchanged.** No new crate in either workspace. |
| Worker upload | 2318.19 → **2321.58 KiB gzip** (+3.4 KiB, +0.15%) — the budget-expiry sweep and the dead-letter consumer. Both are correctness fixes, and 3.4 KiB is a cheap price for a dead-lettered job being visible. |

## Why the Worker bundle is large, and whether that is a problem

2321 KiB gzip is large in absolute terms. It is dominated by the **release** build
of `worker` + `wrangler` glue, not by first-party code. The relevant facts:

- First-party Rust is ~134k lines; the dependency tree is 15 crates.
- There is **no async runtime**. No Tokio, no `futures` executor. `futures-util` is
  present with `std` only, and the two `block_on` helpers in test modules are
  hand-rolled wakers for host tests.
- There is **no HTTP client** and no crypto crate beyond `argon2`. Key derivation
  needed SHA-256 and `platform::sha256_hex` is `async`, so `core/machine.rs` carries
  a ~40-line in-crate SHA-256 with the published FIPS vectors as its test. That is
  40 lines in exchange for not adding a crypto dependency to a Worker.
- Cloudflare's own compressed-size limit is what binds here, not a first-party
  decision. Nothing in this phase changed the shape of the dependency tree.

## What could NOT be measured here, and why

Stated plainly, because a performance document that quietly omits its unmeasured
half is worse than one that does not exist.

| Metric | Why not | What it would take |
|---|---|---|
| **LCP / INP / CLS** | Requires a deployed origin and a real browser. | A staging deploy plus a Lighthouse/Web Vitals run against it |
| **Worker p50 / p95** | Requires a deployed Worker and live traffic. | A staging deploy, then Workers Analytics or an HTTP probe loop |
| **D1 query count per request** | Requires a real D1 binding; `D1PreparedStatement` cannot be constructed on the host. | `wrangler dev --local` with D1 logging |
| **D1 query latency** | Same. | Same, plus a populated dataset at realistic cardinality |
| **TTFT overhead** | Needs a real provider endpoint. `mock://lumi-timeout` streams `pending()` forever. | A local stub SSE endpoint behind `allow_local_provider_endpoints` |
| **Streaming memory behaviour** | Needs a real stream over the WASM boundary. | A staging deploy with a long-running stream and heap metrics |
| **Fallback latency** | Needs ≥2 real providers with one failing. | Two provider accounts |
| **Large admin table render** | No browser attached to this environment. | A browser pass over a seeded org with 10k runs |

**This is the largest single gap in the P09 evidence** and it is the same gap P06
and P07 both carry: no browser and no deployed environment. The web *budgets* are
measured and gated; the web *field metrics* are not.

## Large admin tables — a code-level assessment

Since the field metrics are unavailable, here is what the code does, which is at
least evidence rather than absence.

- **Every list route is cursor-paginated and bounded.** Page limits are clamped to a
  documented maximum and a limit of `0` or `MAX+1` is refused, not silently coerced.
  There is no unbounded list endpoint.
- **Lists do not render unbounded.** Cursors, not offsets, so page N costs the same
  as page 1.
- **The rendering tests use `renderToStaticMarkup`**, which exercises the tree
  without a layout pass, so a table that would be O(n) in the DOM is visible in the
  test output even without a browser.

That is the honest position: the *shape* is bounded and tested; the *measured* render
cost at 10k rows is not known.

## Streaming memory

One property is provable from the code and worth stating, because streaming is where
a control plane usually leaks: the SSE decoder is a **bounded incremental parser**
over a `String` tail, not an accumulating buffer of the whole response. A stream of
any length costs the same memory as a short one, and the truncated-stream fix added
a *predicate*, not a buffer.

## The performance-relevant change in this phase

Only one, and it is a correctness fix that also removes wasted work:

A provider stream cut short before its terminal marker used to be recorded as a
successful run with the **budget reservation committed at the full upper bound**.
That is not only wrong, it is expensive in the worst way: the tenant is charged for
output that never arrived, and the money is immutable (`usage_events` has no UPDATE
trigger). Now a short stream releases the reservation, so the system stops spending
on work that did not happen.

## Recommendation

Ship against the measured budgets. Do not ship a claim about field metrics that was
not measured — instead, make measuring them the first task of the staging phase, and
treat a budget breach there as a real finding rather than a surprise.
