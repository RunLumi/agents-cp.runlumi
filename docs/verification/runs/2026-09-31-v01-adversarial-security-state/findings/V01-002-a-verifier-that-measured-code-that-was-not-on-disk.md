# V01-002 — a verifier that measured code that was not on disk

## Status

closed — repaired in the harness, with the repair's own repair found and fixed first

## Severity

high (it manufactures false positives and false confidence in every mutation-based proof)

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-TOOL-001` (new — this is a property of the verification system, not of a feature) |
| **Setup** | the V01-001 sensitivity script, a real Worker, a real local D1, a real probe run against both. |
| **Action** | apply a deliberate fault, build, drive the probe, undo the fault, then run the probe again against what is now a clean tree. |
| **Expected** | the second run reports the unmutated product. |
| **Actual** | the second run reported the product **with the fault still in it**, against a tree where `git status` was clean and the source file read as if the fault had never been applied. |
| **Evidence** | `evidence/v01-001-sensitivity-m1.txt`, `evidence/v01-001-sensitivity-m2.txt`, and the 503 quoted below |
| **Verdict** | **FAIL, found and closed.** The specific claim "the unmutated product passes the probe" was **UNPROVEN** and, on the evidence, false. |
| **Regression gap** | none for this defect: `buildFreshness()` now makes the property checked rather than assumed, and runs in `setup()` for every probe that uses the harness. |
| **Severity** | high |

## What happened

The V01-001 sensitivity script undid a fault the obvious way:

```bash
cp "$SRC" "$ROOT/target/v01-adoption.rs.orig"     # save
python3 - <<'PY'  ...                             # apply the fault
PY
restore() { mv "$ROOT/target/v01-adoption.rs.orig" "$SRC"; }   # undo it
```

`mv` preserves the saved copy's mtime, and the saved copy's mtime is the moment it was
*copied* — before the fault. So after the restore:

- the source file's mtime was **older** than the artifact built from the faulted version,
- the build tool saw nothing newer and declined to rebuild,
- the next probe run was served the **faulted** binary while reading source that said
  the fault was gone.

The symptom was a product defect that did not exist:

```
FAIL  no payload class reaches the security_events audit trail
      — LEAKED INTO AUDIT: ["metadata_json/PROMPTX","metadata_json/APIKX", …]
```

against this source:

```json
&json!({
    "stage": stage.as_str(),
    "credential_mode": credential_mode.as_str(),
    "client_protocol_major": fingerprint.protocol_major,
    "project_id": body.project_id,
})
```

`git status` was clean. The tree was clean. The binary was not. Touching the source and
re-running immediately changed the answer:

```
PASS  no payload class reaches the security_events audit trail
      — 19 audit columns searched for 8 classes, 0 hits
```

## Why it matters more than a bad script

This is the failure the whole campaign exists to detect, committed by the campaign. It is
the same shape as the V00 record's "13/13 reported on #38 was measured on a base that
predated the Sentry work", and the same shape as the `GUARD-2` case that graded
`KILLED_FOR_THE_WRONG_REASON`: **a verdict with no evidence behind it**, produced by
something that looks like rigour.

The two error directions are both live. This instance was a false *positive* — a clean
product reported as defective. The more dangerous direction is the false *negative*: a
defect masked by a build that is not the code under review, which is how a gate becomes
a rubber stamp without anyone noticing.

The blast radius was smaller than it first looked, and worth stating because the check
was worth doing rather than assuming: `verify:mutation` builds each case in its own
scratch copy, so it was never exposed. `vfy004-guard-sensitivity.sh` and
`vfy-browser-sensitivity.sh` restore with `cp` (which stamps the current time) or in a
throwaway worktree. The defect was mine, in the one script I had just written.

## The repair

**One half: revert in a way the build tool can see.**

```bash
restore() {
  cp "$ROOT/target/v01-adoption.rs.orig" "$ADOPTION"   # not mv
  ...
  rm -f "$ROOT/target/v01-adoption.rs.orig" "$ROOT/target/v01-routes.rs.orig"
}
```

and the script now *checks* that the restore took, so "restored" is a verified statement:

```
M1: the source is back to HEAD
```

**The other half, and the durable one: make it impossible to believe a stale artifact.**

`smoke-harness.mjs` gained `buildFreshness()`, run in `setup()` for every probe that uses
the harness. It compares the newest Rust source or migration against the newest compiled
Worker and fails the run when the artifact predates the source:

```
PASS  the Worker under test was built from the current source
      — newest artifact .wrangler/tmp/dev-ElbP8q/…-index_bg.wasm is 78s newer than src/routes/migration.rs
```

Now "the code under test is the code on disk" is a checked property. A stale artifact
produces a failed gate with an explanation, not a result.

## The repair's own repair, because there were two

The first version of `buildFreshness()` was wrong twice, and both errors produced a
*false* alarm, which is the failure mode that gets a check deleted:

1. **It compared against `apps/api/build/` alone.** `wrangler dev` compiles into a fresh
   `.wrangler/tmp/dev-*` directory per run. The check now takes the newest artifact across
   both locations, because the run that just started wrote the newest one. Taking the
   *oldest* candidate — as a first attempt did — reports the previous run's build.
2. **It ran before the health wait.** `wrangler dev` compiles on spawn, so a check placed
   before the Worker answers compares the source against the bundle the *previous* run
   left behind, and reports a stale build on a run that is about to rebuild. It fired on
   the M1 sensitivity run whose whole purpose was to be a faulted build.

Both were caught by running the thing against a known-good tree, which is the only way a
new check earns trust. The check is now:

- after the Worker is healthy,
- against the artifact that run produced,
- and reports `build freshness could not be established` as an explicit **non-result**
  rather than a pass when it cannot tell — because a check that cannot establish
  freshness has not established anything.

## A third measurement error, in the same session, worth recording

While diagnosing the above I twice measured a limit and got it wrong in *opposite*
directions, and both times the measurement looked fine:

- `npx wrangler …` is blocked in this repository by `pkg-age-guard`. Every probe of D1's
  result-set limit through `npx` failed with that message, and a grep for the error text
  I expected classified all of them as "ok". So D1 appeared to accept 1000 result columns.
- The compound-SELECT probe was a nested `SELECT SELECT …` — a syntax error, not a limit.

With the harness's own binary and a real error string, the real limits are: **100 result
columns accepted, 101 refused**, and compound SELECT unrestricted. The limit is now
measured in the probe that depends on it and documented on `d1Rows`, so the next probe
does not rediscover it. A limit believed on the strength of a measurement that never ran
is the same defect as the one above, at smaller scale.
