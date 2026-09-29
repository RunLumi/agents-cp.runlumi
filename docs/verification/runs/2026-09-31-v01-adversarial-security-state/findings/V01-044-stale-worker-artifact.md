# V01-044 — a stale Worker artifact, and the harness that would not look

**Severity: HIGH (infrastructure) · Status: CLOSED (environment/self-inflicted) · Class: verifier weakness**

## The claim that was attacked

`verify:path-id-tenancy`'s new `plugins` leak class (PL0–PL4) asserts that org A's
`GET /orgs/{A}/plugins/{package_id}` carries no trace of org B's install state, and that with an
install in **each** org org A sees its own and still not org B's.

## What appeared to happen

The class failed, reproducibly, in a shape that looked exactly like a cross-tenant leak:

| observation | reading at the time |
|---|---|
| org A's install returned **200** | the install succeeded |
| org A's install wrote a `security_events` row `plugin.installed` / `outcome=success` | the audit trail said it succeeded |
| org A's install wrote **no** `plugin_installs` row | — |
| org A's `GET` of the **global** package returned org B's `install_id` | **cross-tenant leak** |
| the same class was **green** earlier in the session (211/211) | — |

**There was no leak and no product defect.** `find_install`'s `WHERE org_id = ?1 AND package_id = ?2`
was, and remains, correct — and `pnpm check` was green throughout.

## Root cause: the binary under test was older than the source

`wrangler dev` serves `apps/api/build/index_bg.wasm`. That artifact was last written **19:58**,
before any of this session's work. The `plugins` leak class depends on `find_install`'s org scoping
being present in the compiled Worker, and it was not — so `find_install` resolved a package's install
row regardless of organization, which is exactly the leak the class is built to catch.

The first thing that revealed it was not the failing assertion but the **build output**:

```
--dry-run: exiting now.
```

`wrangler deploy --dry-run` prints that. It compiles and bundles, then discards the output to
`build/.tmp`, leaving `build/index_bg.wasm` untouched. So the sequence that produced the failure was:

1. an edit to Rust source,
2. `pnpm build` → success banner, **no artifact rewrite**,
3. a gate run that measured the **previous** binary.

## What I got wrong, and how I know

I diagnosed this twice before getting it right, and both wrong turns are worth recording.

**Wrong turn 1 — I blamed the build script and "fixed" it.** I changed `apps/api`'s build to
`worker-build --release && wrangler deploy --dry-run`. That change is *harmless and arguably useful*
(an explicit artifact step), but it was not the cause and I could not demonstrate that it was: the
wasm under `target/` is cargo's intermediate, not the served artifact, and the hash comparison I
used as proof was comparing the wrong file. I committed that reasoning as a finding before I had
evidence for it. **A finding record written at the point of highest confidence is the easiest place
to launder a guess into a conclusion.**

**Wrong turn 2 — I concluded the artifact does not track the source.** I injected markers to test
this, and they never appeared: a Rust `//` comment, a SQL `--` comment, and a SQL `/* */` block
comment were all absent from the binary. Every one of them is a *comment*, and comment stripping is
why. I then wrote the conclusion "the artifact does NOT track the source" — from an experiment that
could not have detected tracking either way. **A negative result from an instrument that cannot
register the signal is not evidence of absence.**

The decisive test is the one I should have run first, and it is the same shape as the whole campaign:
**inject a real behavioural fault, rebuild, and see whether the gate notices.**

```sql
-- M1: bind org_id, stop filtering on it
WHERE org_id = ?1 AND package_id = ?2     →     WHERE ?1 IS NOT NULL AND package_id = ?2
```

`?1` stays bound and referenced, so the statement stays valid, every bind count is unchanged, and
only the scoping goes. Against a **freshly built** Worker this is detected, immediately, on PL2 and
PL4. Against a stale Worker it is not, because the stale Worker does not contain the code being
mutated.

## The harness defect that made it expensive

The sensitivity script rebuilt with `pnpm build` **three times** and each rebuild "succeeded" — and
therefore changed nothing. Its mutations then "failed" for a reason unrelated to the product, and its
baseline was green only because it was measured against a binary predating the class's own
dependencies.

A **vacuous baseline is worse than a red one.** A red baseline stops the run and says the harness
cannot proceed; a green one authorises a verdict about a build that never contained the claim. The
script did have the standard guard against a *red* baseline and none against a *stale* one, and that
is the gap worth closing: **the baseline must be built from the tree it is about to mutate, by a
command whose artifact can be shown to change.**

## The repair

1. `apps/api`'s `build` now runs `worker-build --release` before the dry run, so the build step
   explicitly produces the artifact rather than only type-checking it. Kept for the reason above: it
   is the `[build].command` from `wrangler.jsonc`, promoted to writing rather than discarding.
2. The sensitivity script now **asserts the artifact changed** after its baseline build, and refuses
   to run if it did not. That is the check whose absence turned a three-mutation run into a
   three-vacuous-verdict run.
3. The stale wasm is removed before any gate run, so a stale binary cannot be mistaken for a defect.

## Regression proof

- `verify:path-id-tenancy` against a freshly built Worker: **211/211, exit 0**, and D1 shows exactly
  **one** `plugin_installs` row per organization — Alice 1, Bob 1.
- The three mutations (M1 scoping, M2 the positive-match control, M3 the exclusion gate) are each
  **DETECTED**, and the restored-tree run is green again.

## The generalisable lesson

**A gate that reports a defect it caused is worse than a gate that cannot detect one**, because the
defect is real enough to send someone into the product. Every intermediate observation here was
individually reasonable — a `200`, a `success` audit row, a missing row, a foreign id in a valid
response — and only one question would have separated them: *does the binary under test contain the
code the source claims?*

That question is cheap. It was not asked.
