# V01-008 — every project PATCH is refused with `409 version_conflict`, because the optimistic update's placeholders are off by one

## Status

**closed** — repaired, all three defects in the statement fixed, the positive control now
succeeds, and three mutations detected

## Severity

**high.** A core mutating route — rename, visibility change and archive — has never worked, for
any caller, in any organization.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-TEN-002` (new) |
| **Setup** | real `wasm32` Worker, fresh local D1 with all 21 migrations, two real organizations, three real users, a real project created through the API. |
| **Action** | the mutating cross-tenant probe's **positive control**: Org A's own legitimate **owner** renames Org A's own project, with the project's real `version` and a body matching `PatchProjectRequest`. |
| **Expected** | `200`, and the name changed. |
| **Actual** | `409 version_conflict` — *"The project changed since you loaded it"* — with a correct version and a correct body. |
| **Evidence** | `evidence/v01-008-project-patch.txt`, `evidence/v01-008-sensitivity.txt` |
| **Verdict** | **FAIL — product defect.** Not a tenancy defect: the route is broken for everyone. |
| **Regression gap** | none; see the regression proof below |
| **after repair** | the same control answers `200` and the rename is visible in the state |
| **Severity** | high |

## Root cause

`apps/api/src/repositories/projects.rs`:

```sql
const UPDATE_PROJECT_SQL: &str = r#"
UPDATE projects
SET name = ?2, visibility = ?3, archived_at = ?4, default_model_route = ?5,
    version = version + 1, updated_at = ?6
WHERE project_id = ?1 AND org_id = ?7 AND version = ?8
"#;
```

bound as:

```rust
&[
    BindValue::Text(update.name),                                                     // ?1
    BindValue::Text(update.visibility),                                               // ?2
    archive_value,                                                                    // ?3
    BindValue::Null,                                                                  // ?4
    BindValue::Text(update.now.as_str()),                                             // ?5
    BindValue::Text(update.project_id),                                               // ?6
    BindValue::Text(update.org_id),                                                   // ?7
    BindValue::Integer(i32::try_from(update.expected_version).unwrap_or_default()),    // ?8
]
```

The statement is internally inconsistent: `SET` starts at `?2` and `WHERE` starts at `?1`. The
binds are in the natural order — the values, then the keys, then the version. So every
placeholder resolves one position off from what the statement intended:

| placeholder | bound to | the statement uses it for | therefore |
|---|---|---|---|
| `?1` | `name` | `WHERE project_id = ?1` | **`project_id` is compared against the project's name** |
| `?2` | `visibility` | `SET name = ?2` | name would be overwritten with the visibility |
| `?3` | `archived_at` | `SET visibility = ?3` | visibility would be overwritten with NULL |
| `?4` | `NULL` | `SET archived_at = ?4` | archive state always cleared |
| `?5` | `now` | `SET default_model_route = ?5` | a route column would be overwritten with a timestamp |
| `?6` | `project_id` | `SET updated_at = ?6` | `updated_at` would be overwritten with the project id |
| `?7` | `org_id` | `WHERE org_id = ?7` | correct |
| `?8` | `version` | `WHERE version = ?8` | correct |

`WHERE project_id = ?1` compares the primary key against the project's **name**, so it never
matches. `changes() == 0`, the repository returns `None`, and the route maps that to
`409 version_conflict`. **The optimistic guard is not detecting a conflict; it is detecting
that it is looking at the wrong column.**

The error message is actively misleading, which is part of why this survived: a client that
loads a project, edits it, and saves it is told the project changed under them, which invites
a retry loop that can never succeed.

## Three further defects in the same statement, hidden behind the first

The `WHERE` never matches, so nothing in the `SET` clause has ever executed. Fixing only the
`WHERE` would make the bug **worse** — it would start writing. Read the intended values against
the binds and three more defects are visible:

1. **`default_model_route` would be overwritten with a timestamp.** `?4` is
   `BindValue::Null` in the SET position that receives `?5` (`now`). Even a null would be
   wrong: `PatchProjectRequest` has **no** model-route field, so patching a project's name must
   not clear the route bound to it. The statement must not mention the column at all.
2. **`archived_at` would always be cleared.** `?3` is `archived_at` and lands on
   `SET visibility`. A project archived by a previous PATCH could never stay archived.
3. **`updated_at` would receive the project id.** `?6` is `project_id` and lands on
   `SET updated_at`, so every successful patch would write a resource id into a timestamp
   column, breaking every ordering that reads `updated_at`.

So the repair is not one character. It is: give `SET` its own placeholders, **omit**
`default_model_route`, and keep the three key binds where the `WHERE` expects them.

## Why it survived every existing gate

| gate | why it cannot see it |
|---|---|
| `pnpm check` | compiles; the SQL is a string constant, so a misnumbering is a runtime fact, not a type error |
| `schema:bind-count` | counts placeholders against binds — and **8 placeholders with 8 binds is exactly right**, which is the point below |
| `smoke:p08` | cross-tenant, and this route is only ever called with a *foreign* id, so a 409 is indistinguishable from the refusal it expects |
| `p05`, `p02`–`p04` | never patch a project |
| `verify:restore`, `schema:p07`, `p08:invariants` | structural, not behavioural |

**`schema:bind-count` is the uncomfortable one.** It exists to catch D1 rejecting a statement
at execution time, and this statement has the *right number* of binds for the *wrong
placeholders*. The gate cannot see it, and the reason is worth stating plainly: a count proves
arithmetic, not correspondence. A bind that is the right type in the wrong slot passes every
count and corrupts every row it touches.

## The evidence that the path has never run

From the database after a run in which the control was attempted:

```console
$ sqlite3 db "SELECT COUNT(*) FROM projects WHERE version > 1;"
0
$ sqlite3 db "SELECT COUNT(*) FROM security_events WHERE action LIKE 'project.%';"
0
```

Not one project has ever been patched, and not one `project.updated.v1` or `project.archived.v1`
audit event has ever been written. The route is reachable, answers a plausible error, and has
never mutated anything.

## The class, and why this is the third one

| | defect | why it survived |
|---|---|---|
| `teams` / `team_members` | `team_id` CHECK allowed 36 characters, `generated_id("team")` produces 37 | every gate started from an empty table |
| 15 audit call sites | an `evt_` id passed to a `sec_` column | the batch failed, the error was swallowed, nothing reported it |
| **this one** | **`SET`/`WHERE` placeholders disagree** | **the count is right, so `bind-count` passes; no gate ever patched a project** |

All three are the same shape: **a route that answers a plausible response and has never
succeeded.** None is a logic error. Each is a wiring error that produces a valid-looking
answer, which is why a campaign that only reads responses would not find any of them, and why
a campaign that asks a positive control to *succeed* found this one immediately.

## How it was found, precisely

Not by the cross-tenant assertion — the cross-tenant attacks were all correctly refused. It was
found by the **positive control**: the probe calls each route once as the legitimate owner and
requires success, precisely so that a probe in which every body is malformed cannot report a
perfect sheet. The control failed, and the failure was chased rather than adjusted away.

That is the whole argument for positive controls, and it has now paid for itself twice in this
campaign: here, and in V01-001, where a control (a planted marker) proved a search could see
anything at all.

## The repair

```sql
UPDATE projects
SET name = ?1, visibility = ?2, archived_at = ?3, version = version + 1, updated_at = ?4
WHERE project_id = ?5 AND org_id = ?6 AND version = ?7
```

with the binds in the same order. All three defects are addressed at once:

1. **`SET` and `WHERE` no longer share placeholders.** Each clause numbers its own, and the
   binds follow. `WHERE project_id` receives the project id.
2. **`default_model_route` is removed from the statement entirely.** `PatchProjectRequest` has
   no model-route field, so a rename must not touch the route bound to the project. It is not
   nulled; it is not mentioned.
3. **`archived_at` and `updated_at` receive what they are named after.**

The comment above the constant records the defect, because a `SET`/`WHERE` numbering is
invisible on inspection and this is the third statement in this repository to be wrong that way.

## Regression proof, at the cheapest layer that can express it

A string constant's placeholder correspondence is not a unit-testable property of Rust, so the
cheapest **correct** layer is the database: assert the effect. Four cases, added to
`verify:mutating-tenancy`:

```
PASS  the project's default_model_route holds a real value before the patch, so the
      preservation claim below is not vacuous  — default_model_route=v01-fixture-route
PASS  a rename leaves default_model_route alone  — before=v01-fixture-route after=v01-fixture-route
PASS  a rename writes a timestamp into updated_at, not the project's own id
      — updated_at=2026-09-28T16:34:03.050Z
PASS  a successful patch bumps the optimistic version, which is the proof the WHERE clause
      matched  — version 1 -> 2
```

The first of those exists because the second was **worthless as first written**: with the
column NULL on both sides, "the rename left it alone" is trivially true and would have passed
against the very statement that wrote a timestamp into it. A negative assertion needs a value
to lose. That is the fifth time this campaign a preservation claim needed a positive baseline
first, and the sixth time the fix was to make the *absence* provable rather than the presence
convenient.

## The optimistic-concurrency case the probe did not have

The families list "optimistic concurrency conflict" as a required attack, and no probe
performed one. It is added now, and it is **stale by construction** — the control has just
bumped the version, so the value the attack sends is out of date exactly as it is for two
people editing one project:

```
PASS  a PATCH carrying a stale version is refused with a conflict  — status=409 version sent=1 current=2
PASS  the stale write changed nothing: the name is still the control's and the version did not advance
PASS  the same write with the CURRENT version succeeds, so the conflict above was about the
      version and not about the route  — status=200
```

The third is what makes the first two mean something. Without it, a route that has stopped
accepting writes entirely passes both.

It was added because of P3 below, which was unobservable until it existed.

## Sensitivity — all three detected

```
P1 placeholders disagree (the V01-008 defect):  detected
P2 a rename clears default_model_route:         detected
P3 the optimistic guard is removed:              detected
```

- **P1** re-introduces the original defect *verbatim*, including a bind list with the right
  count and the wrong correspondence — which is precisely why `schema:bind-count` passed it.
  The probe reports `409 version_conflict`, exactly as the product did, and the control's
  "the write is visible in the state" assertion fires too.
- **P2** puts `default_model_route = NULL` back into the `SET` list. The preservation assertion
  fires, which is the proof that assertion is load-bearing and not decoration.
- **P3** replaces the version comparison with `?7 IS NOT NULL`, keeping the **placeholder
  count unchanged** so the mutation cannot be caught by the bind-count gate. The first version
  of P3 dropped `?7` outright, which left seven binds for six placeholders; D1 refused the
  statement, the control answered 503, and the case was detected by the "no 5xx" assertion
  rather than by the claim it is named for.

## A verifier defect this finding produced, which had already mis-fired twice

`fired()` matched its needle as `grep -E "^  FAIL  ${needle}"` — anchored at the start of the
assertion. Every needle written for it was a mid-sentence fragment, so **the anchoring never
fired** and the cases reported MISSED while the assertion had failed in plain sight. P3 was
graded MISSED with a log line reading `status=200 version sent=1 current=2`: the detection was
in the file, the helper could not see it.

It is fixed to match the needle as a substring. The same shape had already cost a case in
V01-006's harness, which is now fixed too. `v01-001` and `v01-003` anchor on full sentence
prefixes and were never affected — which is why they reported detections honestly throughout.

An anchoring that never fires is a verifier that reports the absence of a defect it just
watched occur. That is the same failure as a verifier that cannot fail at all, only quieter.

## Gates on the repaired tree

| gate | result |
|---|---|
| `pnpm verify:mutating-tenancy` | 39 → **42** cases, exit 0, 0 of 11 attacks changed state |
| `pnpm smoke:p08` | **47/47**, 3 skipped, exit 0 |
| `pnpm schema:bind-count` | 463 prepare() calls, exit 0 — and it passed the broken statement too, which is the point above |
| `pnpm check` | exit 0 |

## The limitation to fix alongside it

`schema:bind-count` cannot catch this class, and claiming otherwise would be the wrong lesson.
What it *can* additionally do is check that no placeholder appears in both a `SET` target and a
`WHERE` comparison, and that no `SET` target is a primary key or a tenant column. Both are cheap
string checks, both catch this exact shape, and the first would also have caught the original
`SET name = ?2 … WHERE project_id = ?1` — a statement that uses a placeholder for two different
columns is malformed whatever the count says.

Recorded as **GAP-004** in `next-verification-actions.md` as work, not claimed as done. The
stronger property is already covered by V01-008's positive controls, which is the honest
division: a count proves arithmetic, and a probe that requires the write to succeed proves
correspondence.
