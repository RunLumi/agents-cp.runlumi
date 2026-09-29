# V01-044 — a convincing fake leak, manufactured by the probe's own diagnostics

**Severity: HIGH (verifier) · Status: CLOSED · Class: verifier weakness — and three wrong diagnoses in a row**

## The claim that was attacked

`verify:path-id-tenancy`'s new `plugins` leak class (PL0–PL4) asserts that org A's
`GET /orgs/{A}/plugins/{package_id}` carries no trace of org B's install state, and that with an
install in **each** org, org A sees its own and still not org B's.

## What appeared to happen

The class failed, reproducibly, in a shape that read exactly like a cross-tenant leak:

| observation | reading at the time |
|---|---|
| org A's install returned **200** | the install succeeded |
| org A's install wrote a `security_events` row `plugin.installed` / `outcome=success` | the audit trail said it succeeded |
| org A's install wrote **no** `plugin_installs` row | — |
| org A's `GET` of the **global** package returned org B's `install_id` | **cross-tenant leak** |
| the same class was **green** earlier in the session (211/211) | — |

**There was no leak and no product defect.** `find_install`'s
`WHERE org_id = ?1 AND package_id = ?2` was, and remains, correct. `pnpm check` was green throughout,
and D1 shows exactly one `plugin_installs` row per organization on every clean run.

## The actual cause: the diagnostics I added to investigate the first failure

Every failing run was made against a **locally modified** probe carrying four `console.log`
diagnostics I had inserted while chasing the original failure. Every clean run was against the
**committed** probe.

Bisected one at a time, against the committed probe plus a single diagnostic:

| diagnostic re-added | result |
|---|---|
| mid-sequence `d1Rows` read | **211/211** |
| 2.5 s sleep + re-read | **211/211** |
| all four, as they were written | **209/211, Alice's row absent** |

The failing variant differs from the passing one in something I had not considered load-bearing: in
the diagnostic version, the `stored rows` `d1Rows` call was **inserted between** org A's install
request and the read of org A's install row, and the `console.log` that printed it **stringified
`aInstall.payload` first**. The combination changed the observable outcome; neither piece did so on
its own. What I cannot reconstruct with confidence is which interaction did it, and **that is the
honest statement** — I have a reproduction and a bisection that isolates the failing variant, not a
mechanism.

What I *can* state firmly, because it is measured:

- **committed probe: 6 consecutive clean runs, 211/211, Alice=1 Bob=1**;
- **original build script: 2 further clean runs, 211/211**;
- the leak-shaped failure appears **only** with the diagnostic variant.

## The three wrong diagnoses

This is the part worth keeping. The first failure was real-looking and well-formed, and I diagnosed
it three separate times, each with more confidence than the evidence supported.

**Wrong diagnosis 1 — a stale Worker artifact.** I saw the served wasm was timestamped before the
session's work, read `--dry-run: exiting now.` in the build output, and concluded the binary did not
contain `find_install`'s org scoping. I then **changed `apps/api`'s build script** and wrote a
finding record asserting the cause. The build change was committed in `da60e75`.

It was wrong. `wrangler.jsonc` sets `build.command = worker-build --release`, and
`smoke-harness.mjs` starts the Worker with `wrangler dev`, so **every gate run rebuilds from source**.
There is no stale artifact. Measured: with the original build script, 211/211 twice.

**Wrong diagnosis 2 — the build script was no-op.** While testing the fix I concluded `pnpm build`
"does not build the wasm the gates serve", on the basis that the artifact under
`target/wasm32-unknown-unknown/release/` was byte-identical after a rebuild. That is **cargo's
intermediate**, not the served artifact; I compared the wrong file and drew a conclusion from it.

**Wrong diagnosis 3 — the artifact does not track its source.** I injected markers (a Rust `//`, a
SQL `--`, a SQL `/* */` comment) and none appeared in the binary, so I concluded the build was not
tracking source. **All three markers were comments, and comments are stripped.** A negative result
from an instrument that cannot register the signal is not evidence of absence — and I wrote it down
as a finding anyway.

**The decisive test was available the whole time and I did not run it:** inject a real behavioural
fault, rebuild, and see whether the gate notices. That is the shape of the entire campaign, and it
is also the test that would have exonerated the product in one run.

## What is actually repaired

1. **`apps/api`'s build script is restored to `wrangler deploy --dry-run --env production`.** The
   change shipped in `da60e75` is reverted because it does not fix anything: `wrangler dev` already
   performs the build. Leaving it would be a change justified by a diagnosis I have since disproved.
2. **V01-044 is reclassified** from "stale artifact" to "probe's own diagnostics", with the
   bisection table above.
3. The sensitivity script's artifact guard is kept but re-scoped: it no longer asserts a build step
   was the problem. It now checks that each mutation produced a **byte-different artifact from the
   baseline**, which is the one check whose absence let three mutations report verdicts about a build
   that had not changed.

## Regression proof

- `verify:path-id-tenancy`, committed probe, **6 consecutive runs: 211/211, exit 0**, each with
  Alice=1 and Bob=1 in `plugin_installs`.
- With `apps/api`'s build script reverted to its original value: **2 further runs, 211/211**.

## The lesson, stated once

**A finding record written at the point of highest confidence is the easiest place to launder a
guess into a conclusion.** Three times here I had a plausible mechanism, a real-looking failure,
and a build that had taken a minute — and each time the mechanism was wrong and the "fix" was a
no-op. The evidence that would have separated them in one run was: *does the gate still fail with my
own edits removed?*

That question is cheap. It was not asked, and a commit now has to be reverted because of it.
