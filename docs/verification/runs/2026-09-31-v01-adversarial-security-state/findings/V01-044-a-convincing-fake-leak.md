# V01-044 — a convincing fake leak, and a restore that shipped the fault

**Severity: HIGH (verifier) · Status: CLOSED · Class: verifier weakness · Product: correct throughout**

## The claim attacked

`verify:path-id-tenancy`'s `plugins` leak class (PL0–PL4) asserts that org A's
`GET /orgs/{A}/plugins/{package_id}` carries no trace of org B's install state, and that with an
install in **each** org, org A sees its own and still not org B's.

## The failure, which looked exactly like a cross-tenant leak

Reproducible, 6/6, against the committed probe:

| observation | reading at the time |
|---|---|
| org A's install returned **200** | the install succeeded |
| org A's install wrote a `security_events` row `plugin.installed` / `outcome=success` | the audit trail agreed |
| org A's install wrote **no** `plugin_installs` row | — |
| org A's `GET` of the **global** package returned org B's `install_id` | **cross-tenant leak** |

`find_install`'s `WHERE org_id = ?1 AND package_id = ?2` was and remains correct. `pnpm check` was
green throughout. D1 shows one `plugin_installs` row per organization on every clean run.

## Root cause: the restore preserved the mtime, so cargo never rebuilt

**Measured, not inferred:**

```
clean source                     -> artifact e6ae538ea1b18017
fault injected, build            -> artifact 918939ebc7aaec13
source restored with `cp -p`     -> build -> artifact 918939ebc7aaec13   <-- FAULTED
source restored, then `touch`ed  -> build -> artifact e6ae538ea1b18017   <-- clean
```

The source tree was **byte-identical to clean** at the third line. The binary was not. The
sensitivity harness reported a **green 211/211** for that run.

`cp -p` preserves the pre-fault mtime; cargo's freshness check is mtime-based; so the "restored"
build reused the faulted object. Every subsequent `verify:path-id-tenancy` run then measured a
Worker whose `find_install` did not filter on `org_id` — which is precisely the leak PL2 and PL4
exist to detect, and precisely why the failure looked like a product defect rather than a harness
one.

**The rule was already written down in this very file** and implemented backwards:

> *snapshot + `cmp` on restore, not `mv`, because `mv` preserves the pre-fault mtime so the next
> build is skipped…*

The comment identified the exact mechanism and then used `cp -p` — which preserves the mtime just as
`mv` does — on **both** sides. **A check that describes a rule it does not follow is worse than one
that omits it, because a reader trusts the prose** — and here the prose was correct, the code was not,
and the run reported success.

The asymmetry, which is the part worth carrying: **snapshot with `cp -p`, restore with `cp` plus
`touch`.** A fault must be *newer* than what it replaced; a restore must *look newer* than the fault,
or the build system concludes it has already compiled it.

## Three wrong diagnoses before the right one

The first failure was well-formed and I diagnosed it three times with more confidence than the
evidence supported.

1. **"A stale Worker artifact."** The served wasm was timestamped before the session's work and the
   build printed `--dry-run: exiting now.`, so I changed `apps/api`'s build script and wrote this
   finding asserting the cause. **Wrong:** `wrangler.jsonc` sets `build.command =
   worker-build --release` and the harness starts the Worker with `wrangler dev`, so every gate run
   rebuilds from source. Verified by restoring the original build script and getting 211/211 twice.
   The change shipped in `da60e75` and has been reverted in `27d9faa`.
2. **"`pnpm build` does not build the wasm the gates serve."** Based on the artifact under `target/`
   being byte-identical after a rebuild. That is **cargo's intermediate**; I compared the wrong file.
3. **"The artifact does not track its source."** Injected markers (Rust `//`, SQL `--`, SQL `/* */`)
   and none appeared. All three were **comments**, and comments are stripped. A negative result from
   an instrument that cannot register the signal is not evidence of absence — and I recorded it as a
   finding anyway.

The test that would have settled it in one run, and which I did not run: **does the gate still fail
with my own edits removed?**

## Repairs to the harness

1. **Restore no longer preserves mtime.** `cp` + `touch` on both the `restore()` path and the
   `EXIT`/`INT`/`TERM`/`HUP` trap.
2. **A Rust mutation must produce a byte-different artifact** from the baseline, or it is reported
   `INVALID-artifact-unchanged` rather than given a verdict. A probe-only (JS) mutation is exempt:
   node reads it directly, cargo correctly does not rebuild, and demanding a change would report
   `INVALID` for a mutation that ran perfectly.
3. **The restored tree must rebuild to the baseline artifact** — that equality is the *success* case.
   The first version of this check asserted the opposite and would have failed every correct run.
   The faulted-binary case is caught by the restored run being red, which is checked directly.
4. **A backtick inside a double-quoted `echo` is command substitution.** The `FATAL` message contained
   `` `cp -p` `` and the shell tried to *run* `cp -p`. A harness whose error message fails to print
   cannot be read at the moment it matters most.
5. The script locates the repository with `git rev-parse --show-toplevel`, not `dirname/..`. It lives
   five levels deep, the old expression resolved to `docs/verification/runs` (a directory), `cd`
   failed, and every later `git` call ran outside the repository — where `git ls-files` lists
   nothing, so the tracked-file check **reported a tracked file as untracked and blamed the file**.

## Regression proof

- **Sensitivity run: M1, M2, M3 all DETECTED; restored tree 211/211, exit 0**, artifact
  `e6ae538ea1b18017` matching the clean build.
- **M1 kills the leak assertions themselves** — verified in isolation, not only via the exclusion
  gate: `PL2` and `PL4` both fail when `find_install` binds `org_id` and stops filtering on it. The
  mutation keeps `?1` bound and referenced, so the statement stays valid, every bind count is
  unchanged, and only the scoping goes.
- `verify:path-id-tenancy` on the clean tree: **211/211, exit 0**, with one `plugin_installs` row per
  organization.

## The lesson, stated once

**A sensitivity run that restores the source and leaves the fault in the binary is indistinguishable
from a repair that did not work** — and it reports a green sheet while doing it. The two facts that
would have caught it are cheap: the artifact's hash after restore, and the file's mtime after
restore. Both are now checked, and the second was the bug.
