# V04 — the candidate under judgement

Pinned **before** any evidence was read, per the release gate's "Pin the candidate" step. A release
decision that cannot name its candidate is a decision about something else.

| | |
|---|---|
| **commit** | `795d403464b0615aa83b440539c3d5ce95deb6b6` (short `795d403`) |
| **branch / tree** | `main`, clean — no uncommitted or staged changes |
| **OS** | Darwin 27.0.0 (macOS) |
| **node / pnpm / cargo** | v24.20.0 / 10.33.0 / 1.98.1 |
| **browser** | Google Chrome 154.0.8037.93 |
| **Worker runtime** | `wrangler dev --env development` (workerd) on a local D1 |
| **migration head** | `0022_p07_staff_actor_type.sql` — 22 migration files |
| **web build** | `vite build` production artefact, served on `vite preview` :4173 with the API proxied to :8787 |
| **contract versions** | in-repo; no external client contract is consumed by this candidate (see the External Lumi Agents verdict) |

## The commits this campaign adds are not part of the candidate

Verification records are committed on top of the candidate as the campaign proceeds, so `HEAD` moves
away from `795d403` while the *product* does not. Measured after the first two record commits:

```
$ git diff --name-only 795d403..HEAD -- apps Cargo.toml Cargo.lock pnpm-lock.yaml
0 files
```

**Every judgement in this campaign is about `795d403`'s product tree.** If that command ever returns
a non-zero count of product files, the candidate has moved and this pin is void — re-pin before
trusting any result, because a verdict about a different tree than the one recorded is a verdict
about nothing.

## Environment drift from the campaigns this inherits

**Chrome is 154.0.8037.93. V02 recorded 153.0.8010.53.** That is a different browser build than the
one every recorded browser measurement was taken on. It does not invalidate those measurements — they
are honest records of what was measured — but it means **any browser gate re-run here is evidence
about a browser V02 never touched**, and that is worth knowing rather than discovering from a flake.

Nothing else drifted: node, pnpm, cargo, the OS and the migration head are identical to V02's
recorded environment.
