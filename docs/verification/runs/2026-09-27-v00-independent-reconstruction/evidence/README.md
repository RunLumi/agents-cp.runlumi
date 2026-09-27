# Evidence index

Everything the verdicts in `../verification-run.md` and `../claim-evidence-matrix.md` rest on.
Each item names the commit and the environment in the run record.

| File | What it is | How it was produced |
|---|---|---|
| `browser-probe.mjs`, `cdp.mjs` | dependency-free real-Chrome CDP driver and the browser journey (real CTAP2 virtual authenticator, real Worker, real D1) | `node browser-probe.mjs`; run `wrangler dev` on :8787 and `vite` on :5173 first. 20/23 checks pass — the 3 failures are VFY-001, VFY-002, VFY-003 |
| `browser-probe-run.log` | that run's output | as above |
| `vfy-001-reproducer.sh` / `.md` | the two `curl` calls that reproduce the passkey panic | `bash vfy-001-reproducer.sh` |
| `vfy-004-reproducer.sh` / `.md` | the guard-sentinel abort text before and after migration 0020, plus the matcher | `bash vfy-004-reproducer.sh` |
| `mutation-campaign.log` | `p09-mutation-campaign.mjs --apply`, 9/9 killed, exit 0 | disposable linked worktree at `ecbdac1`; the worktree has been removed |
| `p05-smoke.out` | the runtime smoke, 175 pass / 1 fail | `node apps/api/scripts/p05-smoke.mjs` (own fresh D1 + own Worker) |
| `p02-smoke.out`, `p03-smoke.out`, `p04-smoke.out` | runtime smokes, all exit 0 | `node apps/api/scripts/p0N-smoke.mjs` against the dev Worker |
| `worker-panics.md` | trimmed Worker log: the `now_secs` panic frame list and the 500 count | extracted from the `wrangler dev` log |
| `chrome3.log` | Chrome startup log (kept because the Playwright-managed Chromium bundle fails to fork here and system Chrome is used instead) | see the run record's evidence limitations |
| `screens/*.png` | 8 real-browser screenshots, 1440×900 unless named | captured by the browser probe |

## Rerunning everything

```bash
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm check                                     # baseline, includes schema:p07 + canary:p09
pnpm --filter @runlumi/agents-cp-api p08:invariants
pnpm verify:restore
pnpm build
cd apps/api && ./node_modules/.bin/wrangler dev --env development --local --port 8787 &
cd apps/web && ./node_modules/.bin/vite --host 127.0.0.1 --port 5173 &
node apps/api/scripts/p05-smoke.mjs            # expect 175/1 (VFY-004) until repaired
node docs/.../evidence/browser-probe.mjs        # expect 20/23 (VFY-001/002/003) until repaired
git worktree add /tmp/vfy-mut HEAD
(cd /tmp/vfy-mut && node apps/api/scripts/p09-mutation-campaign.mjs --apply)   # expect 9/9
```

## Superseded

Two files here have been promoted into the repository as gated artifacts. They are kept
unmodified so the V00 verdicts remain re-runnable against exactly the probe that produced them, but
they are **not** the live gates:

| File here | Now lives at | Gate |
|---|---|---|
| `browser-probe.mjs`, `cdp.mjs` | `apps/web/scripts/browser-probe.mjs`, `apps/web/scripts/cdp.mjs` | `pnpm smoke:browser`, in CI after migrations |
| `vfy001-repro.sh` | unchanged — still the original reproducer for VFY-001 | run by hand against a live Worker |
| `vfy004-guard-sensitivity.sh` | unchanged — reverts each VFY-004 repair and re-runs the probe | run by hand; proves the guard probe is sensitive |

The promoted probe differs from the copy here in ways that matter, and all of the differences make
it **stricter**:

- **Three API fallbacks are deleted.** The version here called `/api/v1/auth/verify-email` by hand
  and created the second organization through `POST /api/v1/orgs`, so the journey continued past
  VFY-002 and VFY-003 instead of failing on them. That is why this run reports 3 browser failures
  where the promoted probe would have reported 4.
- **The ceremony endpoints are asserted at 201**, not 200, because a ceremony start creates a
  `webauthn_ceremonies` row. The copy here asserts 200 and passes only because the requests fail
  with 500 first — a check that could not have passed.
- **The sign-in wait matches structure, not copy.** The copy here looks for the literal string
  "Verification required", which the repair reworded.
- **The verification code is read from its `<code>` element.** The copy here regexes `/\d{6,}/`,
  which matches a numeric run inside the 64-character hex code and submits a wrong value.
- **Narrow-viewport measurement is by containment, not document width**, which is the metric that
  actually detects VFY-007.
- **Chrome is located, not hard-coded**, and a run with no browser exits **2** — never 0.
- **Teardown is in a `finally`.** In the copy here, a throw before `browser.close()` left Chrome
  running and the probe hung for 30 minutes with no output instead of failing.
