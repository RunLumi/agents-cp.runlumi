# V01-009 — four route modules require an `Idempotency-Key` and then ignore it

## Status

**closed for `projects.rs`; three modules still open** (GAP-005, GAP-006). The route is
repaired, re-attacked unchanged, and the new gate is sensitivity-proven. This section was
written before the repair, as the campaign requires.

## Severity

**critical.** The API returns `400 idempotency_key_required` when the header is absent, which
tells a client its retries are safe. On these routes they are not: every retry executes again.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-IDEM-001` (new) |
| **Setup** | real `wasm32` Worker, fresh local D1 with all 21 migrations, one real owner, one real organization, real idempotency records. |
| **Action** | **6 concurrent** `POST /orgs/{org}/projects` requests with **one** `Idempotency-Key` and **six different payloads**, issued in one `Promise.all`. |
| **Expected** | one project. `FR-F23-004`: *"Same key with different body -> conflict."* Acceptance criterion: *"Retrying an idempotent create does not duplicate resource."* |
| **Actual** | **six projects** (5 → 11), one per payload, every one answered `201`. |
| **Evidence** | `evidence/v01-009-idempotency.txt` |
| **Verdict** | **FAIL — product defect.** |
| **Regression gap** | the probe's own three earlier cases were green for the wrong reason; see "why three cases passed first" |
| **Severity** | critical |

## Root cause

`apps/api/src/routes/projects.rs`:

```rust
require_csrf(&headers, &access.session, &context).await?;
idempotency_key(&headers, &context)?;      // <- line 202 (create) and 792 (patch)
let name = validate_project_name(&body.name)...
```

and `idempotency_key` does exactly one thing:

```rust
// apps/api/src/routes/support.rs:19
pub fn idempotency_key(headers, context) -> Result<String, ApiError> {
    headers.get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 128 && v.bytes().all(|b| (0x20..=0x7e).contains(&b)))
        .ok_or_else(|| domain_error(context, ApiErrorCode::BadRequest, "idempotency_key_required", ...))
}
```

It **validates the header and returns the string, which the route then discards.** There is no
`prepare_scoped_mutation`, no `commit_success`, no claim, no replay, no fingerprint check, no
fence. The key is required and has no effect whatsoever.

## The blast radius is four modules, and the pattern differs in each

Counting `idempotency_key(` calls against `prepare_scoped_mutation` / `commit_mutation` /
`commit_scoped_mutation` calls, per route module:

| module | key checks | claims | verdict |
|---|---|---|---|
| `ai_catalog.rs` | 12 | 14 | uses the machinery |
| `machine_identity.rs` | 6 | 13 | uses the machinery |
| `internal.rs` | 6 | 14 | uses the machinery |
| … 12 more modules | | | use the machinery |
| **`projects.rs`** | **2** | **0** | **key required, ignored** |
| **`organizations.rs`** | **2** | **0** | route-local idempotency (below) |
| **`devices.rs`** | **2** | **0** | **key required, ignored** |
| **`foundation_checks.rs`** | **2** | **0** | **key required, ignored** |

`organizations.rs` is a **third** pattern rather than the same bug. The invitation route derives
a deterministic identifier from the key and then reads it back:

```rust
let invitation_id = deterministic_resource_id("inv", &key, &format!("invitation:{org_id}:{user_id}"), &context).await?;
if let Some(existing) = repository.find_invitation(&invitation_id).await? {
    if existing.email != email || existing.role != role {
        return Err(domain_error(..., "idempotency_conflict", ...));
    }
    return Ok((StatusCode::OK, Json(invitation: redact(existing), duplicate: true)));
}
```

That is a **read-then-write**, and it is the same shape as the budget ceiling that V01-006
measured: correct in sequence, and a race under concurrency, because nothing serialises the read
against the write. It is not the defect this finding is about, and it is not yet attacked — but
it is on the list, and the *reason* it is suspect is now known rather than guessed.

## Why the machinery that exists is correct, and was simply not called

The shared implementation is careful and I could not fault it:

- `CLAIM_SQL` is an upsert whose `DO UPDATE` is guarded by
  `WHERE idempotency_records.expires_at <= ?9`, so a **live** record can only be taken over once
  it has expired.
- `ASSERT_CLAIM_SQL` inserts a sentinel row **only when the guarded claim does not exist**, and
  the sentinel violates `idempotency_records.principal_id NOT NULL`. So a worker that lost the
  race makes its own batch **fail** with a recognised guard text, the transaction rolls back, and
  the caller maps it to `ScopedMutationCommit::Guarded`.
- The schema has `UNIQUE (principal_id, organization_id, method, path, key_digest)`, and 0020's
  triggers make `pending` and `completed` states unrepresentable without their required columns.

The winner inserts and the guard writes nothing; the loser's upsert is a no-op, its guard tries
to insert, the `NOT NULL` violation aborts its batch, and its business writes never run. That is
a correct design. **`projects.rs` simply does not use it**, so none of it applies.

## Why three of my five cases passed first, which is the more useful half

| case | what I expected to learn | what actually happened |
|---|---|---|
| same key + same payload, sequential | the key is replayed | **the slug `UNIQUE (org_id, slug)` refused the duplicate** |
| same key + different payload, sequential | `409 idempotency_conflict` | passed, but the second had a different slug so it *should* have created a row — it did not, so something else stopped it; the assertion was on a *count* that a slug collision also satisfies |
| 8 concurrent, one key, one payload | one project | **one project, because every racer sent the same slug** |
| **6 concurrent, one key, 6 payloads** | one project | **six projects** |

The unique-slug constraint was doing idempotency's job by accident, and it *only* works when
every retry sends an identical payload — which is precisely the case where idempotency is
supposed to be invisible. The moment the payloads differ, the accidental defence disappears and
the real behaviour is visible.

**A probe whose negative result is produced by an unrelated constraint is not evidence.** The
first three cases would all have passed against a route with no idempotency whatsoever, as long
as the payloads were identical. Only the case that varied the payload — the hardest one, and the
one the family names second — found anything.

The lesson generalises past this probe: **when asserting that "X did not happen twice", check
what else could have prevented it before concluding that the mechanism under test did.**

## Why it survived every gate

| gate | why it cannot see it |
|---|---|
| `pnpm check` | compiles; a discarded return value is not a warning in this crate |
| `smoke-local`, `p02`–`p05` | the projects surface is exercised for happy paths; a retry is not a thing a smoke test does |
| `smoke:p08`, `verify:mutating-tenancy` | cross-tenant, and the refusal happens before the write |
| `schema:bind-count`, `p07`, `p08:invariants` | structural |
| `verify:mutation` | its cases target SQL tenant scoping, not this |

Nothing in the repository asked "what happens when a client retries?", and the answer was: on
four of nineteen route modules, it creates a second resource.

## Impact

- **`POST /projects`** — a client that retries (a dropped response, an impatient timeout, a
  proxy) creates duplicate projects. Projects scope budget, model policy, team access and
  project-level grants, so a duplicate is not a cosmetic artefact.
- **`PATCH /projects/{id}`** — a retried patch is a second write. `version` makes the second one
  a `409`, so this one is survivable; the *first* is where the duplicate is created.
- **`devices.rs`, `foundation_checks.rs`** — same shape, unexamined. `foundation_checks` is
  development-only, so its severity is lower.
- **`organizations.rs`** — a third pattern, and a race rather than an absence. Not yet attacked.

## The repair, and what it will not cover

1. `create_project` is wired into `prepare_scoped_mutation` / `commit_scoped_mutation`, following
   the `billing.rs` pattern: replay returns the stored response, the claim's business writes and
   the outbox row go in **one** batch, and the guard fences the loser.
2. `devices.rs` and `foundation_checks.rs` are the same change and are **not** attempted here —
   they need their own probe to know whether their side effects are safe to compose into one
   batch, and guessing would be the wrong repair. Recorded as **GAP-005**.
3. `organizations.rs`'s read-then-write is a **race**, not an absence, and needs a concurrency
   attack before it is changed. Recorded as **GAP-006**. Changing it without one would be
   replacing a proven-in-sequence mechanism with an unproven one.

## The regression proof this needs

At the cheapest layer that can express it, which is the **effect**, not the status:

- the same key with the same payload, retried, returns the *first* response and creates no
  second row — and the probe must distinguish that from a slug collision by using two payloads
  whose slugs differ, so only idempotency can explain the single row;
- the same key with a different payload is `409 idempotency_conflict`;
- N concurrent same-key requests create exactly one row, whatever the payload;
- the project create's **outbox and audit rows** are also singular, because a duplicate project
  with a single audit trail is a worse outcome than a duplicate project.


---

# Closure

## The fix

`create_project` now follows the pattern the other fifteen modules use, taken from
`billing.rs`:

1. `idempotency_key(&headers, &context)?` is **bound** instead of discarded.
2. `prepare_scoped_mutation(...)` resolves the key and returns either `Replay` or `Claim`.
   A `Replay` returns the stored response through `replay_response`.
3. The project insert, the outbox row and the claim's completion go in **one**
   `commit_scoped_mutation` batch, with the claim's guard ahead of the business write.

Two things the repair had to get right, and one of them it got wrong first.

**The stored success must be the same value the live path returns.** The original code read
the project back and answered `project_json(&project)`. A replay cannot — the row is behind
it — so a naive repair stores a different, thinner body and a retried client receives a shape
it has never seen. `project_create_json` builds the body from the same values the insert
binds, and both the live response and the `StoredSuccess` use it, so they are the same value
by construction. Two unit tests hold that in place: one asserts the constructed body equals
`project_json` of the row the insert produces, and one asserts `INSERT_PROJECT_SQL` still
pins `version = 1, archived_at = NULL, created_at = updated_at = now`. If the SQL changes,
the second test fails on the statement text rather than waiting for a probe to notice.

**The claim must be resolved before the slug pre-condition — and I had it the other way
round first.** My initial repair checked the slug first, reasoning that a pre-condition
should not consume a key. That is wrong, and the probe said so:

```
FAIL  the replay returns the FIRST request's response — status=409 reason=project_slug_conflict
```

A genuine retry re-sends the payload the first request already created, so the slug
pre-condition answers `409 project_slug_conflict` and the client never receives the response
it is retrying for. The claim is the only thing that can distinguish *"you already sent this
exact request"* from *"you sent a different request that happens to want the same slug"*, and
it can only do that if it is consulted first. The comment in the route says so, because the
wrong version was written once.

**A pre-condition rejection now releases the claim.** With the claim resolved first, a slug
collision would otherwise leave a `pending` row and answer `idempotency_in_progress` — a
false statement, nothing is in progress — to every retry for the length of the TTL.
`ScopedMutationClaim::release` gives the key back, best-effort: a failed release is logged
and the claim expires on its own, which is slower but still correct.

## Re-run: the original attack, unchanged

The same probe, the same 6 concurrent requests, one key, six payloads, against the repaired
route:

| | before | after |
|---|---|---|
| projects created by 6 racers, one key, 6 payloads | **6** | **1** |
| same key + different body | `201` + a second project | `409 idempotency_conflict` |
| 8 racers, one key, one payload | 1 project (by the slug constraint) + 7 × `409` | 1 project, **all eight `201`** — every racer replays |
| the replay's body | no replay existed | byte-identical to the original |
| same key, different principal | n/a | independent write, control-proved |
| **total** | 33/41 | **41/41, exit 0** |

The 8-way burst getting *better* — eight `201`s instead of one `201` and seven `409`s — is
the claim being resolved before the write rather than after it. A racer that arrives after
the first commits now receives the stored response instead of a conflict, which is what a
client retrying a lost response needs.

## Regression proof

- **New gate** `pnpm verify:idempotency` — 41 cases over a real Worker and a real D1, graded
  on **row counts read out of D1**, never on status. Registered in `AGENTS.md`.
- **Two unit tests** on the create body (§ above), so the cheapest layer catches a divergence
  between the stored and live responses.
- **Sensitivity proof** `evidence/v01-009-sensitivity.sh` — four mutations, all detected:

  | | mutation | result |
  |---|---|---|
  | M1 | no claim at all — the pre-repair defect verbatim | **DETECTED** (race + incompatible payload) |
  | M1 | ″ | **KNOWN MISSED** on the 8-way same-payload burst, and the reason is the point of this finding: `UNIQUE (org_id, slug)` yields the single row with or without a claim |
  | M2 | the claim resolved after the slug pre-condition — the fault I introduced | **DETECTED** |
  | M3 | the fence leaves the batch; scoping, fingerprinting and `UNIQUE` all intact | **DETECTED**, 15 failing cases |
  | M4 | the stored body differs from the live body | **DETECTED** |

  M3 is the mutation the gate exists for. Everything about idempotency stays except the one
  statement that aborts the losing worker, and that alone breaks fifteen cases. Nothing that
  only counts rows, or only compares statuses, could see it.

- **Broader gates re-run**, all green: `pnpm check` exit 0 · `cargo test` 1003 · `smoke:p08`
  47/47 · `verify:mutating-tenancy` 43/43 · `smoke:browser` **39/39 in a real browser**,
  which exercises project creation through the real UI.

## Three defects in my own verifier, found by running it

The gate found the product defect on its first run. Then its own harness produced three
false results in a row, each of which had to be fixed before any verdict meant anything:

1. **A build failure was recorded as MISSED.** A mutation that does not compile makes the
   probe exit **2** — the harness could not run — and my harness counted that as "not
   detected". The rule from `AGENTS.md` is that exit 1 is a statement about the product and
   exit 2 is a statement about the harness; my harness was reading 2 as a verdict. Now a
   failed build aborts the run instead of producing one, and exit 2 is an explicit harness
   error.
2. **An abort left the fault compiled in.** `exit 1` in the middle of a mutation skipped
   `restore_all`, so the next run's `snapshot_all` faithfully snapshotted a faulted tree and
   the repository was left not compiling. Recovery meant reconstructing the repair by hand.
   Restoration is now an `EXIT` trap, so it happens on every path out of the script.
3. **An unbound optional argument reported success.** `set -u` aborted `record` mid-verdict
   on the 4th argument, and because the failure happened inside the function the EXIT trap
   reported **exit 0 with an empty verdict list** — a harness claiming success for a run that
   never finished. The argument now defaults, and an empty verdict list is a failure.

The M4 mutation deserves a fourth note, because it was a *weak* mutation rather than a broken
harness: it returned a stored body that kept `id` and dropped everything else, and my replay
assertion compared only `id` — so M4 passed. The assertion now compares the **whole body**,
and the probe is stronger for it. That is the same lesson as the unique-slug trap, from the
other direction: I had written an assertion that could be satisfied by an unrelated property.

## Still open, deliberately

- **GAP-005** — `devices.rs` and `foundation_checks.rs` also require a key and ignore it. They
  need their own probe to know whether their side effects compose safely into one batch.
  Guessing the repair from `projects.rs` would be assuming the answer.
- **GAP-006** — `organizations.rs` invitations use a **read-then-write** on a deterministic
  identifier. That is a *race*, not an absence, and it has not been attacked concurrently.
  Replacing a proven-in-sequence mechanism with an unproven one without an attack would be
  the wrong repair, so it is recorded rather than changed.
