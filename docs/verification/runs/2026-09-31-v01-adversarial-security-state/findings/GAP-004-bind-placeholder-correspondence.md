# GAP-004 — a `prepare()` can bind the wrong value to the right placeholder, and nothing notices

- **Claim:** every `prepare()` in the repository layer binds each placeholder the value its `WHERE` clause
  filters on.
- **Severity:** HIGH (this is the defect class behind V01-008, V01-011 and V01-028)
- **Verdict:** CLOSED as a standing check, with its own limits recorded
- **Discovered by:** V01-028, and generalised here
- **Regression gap:** none for the transposition shape; the stated limits below are the remaining gap

## The gap

`pnpm schema:bind-count` proves **arithmetic**: that a statement has as many binds as it has placeholders.
It cannot prove **correspondence**: that the value in position *n* is the one the `?n` in the `WHERE`
clause filters on. V01-028 was exactly that, and the count was green throughout:

```
ENDPOINT_BY_ID_SQL = "WHERE org_id = ?1 AND endpoint_id = ?2"
binds             = [endpoint_id, org_id]        // two binds, two placeholders
```

Nothing rejects that statement. It is **unsatisfiable**, so `find_endpoint` returned `None` for every row
and the owner of an endpoint could not read their own endpoint.

## Why a leak probe structurally cannot see this

The tenant half is the part worth stating. A transposed two-id lookup does **not** return another
tenant's row — both predicates must hold, and they cannot — so it returns **nothing**. It fails safe on
confidentiality and unsafe on availability.

Which means:

> **A bind-order defect on a scoped lookup is invisible to a leak probe and visible only to a control.**

That is the same sentence V01-030 turned around. V01-030 was a route that could not decode a row, so
every cross-tenant assertion passed while the owner was refused. V01-028 is a lookup that could not match
a row, with the same consequence. Both are **availability faults wearing the costume of a passing
confidentiality sheet**, and neither is reachable by looking for leaks.

## Why the obvious check was not shipped

The first attempt scanned every `prepare()` for any disagreement between a column name and a bind
expression's name. It produced **117 candidates** and shipped nothing.

The reason is not that it was noisy. It is that **a name-based rule cannot distinguish a defect from a
naming convention**: `org_id` bound to `?1` and `owner_user_id` bound to `?1` are the same string
comparison, and a rule that flags both flags nothing. A check that cannot tell those apart is not a weak
check, it is the wrong check.

So the shipped check requires the evidence to be **mutual**, which a convention cannot manufacture:

* the filtering clause contains **exactly two** `<column> = ?N` predicates, with **distinct** placeholders;
* both columns are id-like (`id` or `*_id`), so a non-id column cannot be dragged in;
* a `SET` is never scanned — `SET enabled = ?1` is a column being written, not one being matched;
* and the two binds are **swapped with respect to each other**: the bind for the lower placeholder names
  the column the *other* placeholder filters on, and vice versa.

One mismatch is a guess. Two mismatches in opposite directions is a transposition.

## What is shipped

`apps/api/src/repositories/bind_correspondence.rs`, a `#[cfg(test)]` unit test that runs inside
`pnpm check` — so this is a standing gate, not a script someone has to remember:

```
v01_004 bind correspondence: 661 SQL constants read, 124 two-id lookups examined, 0 transposed
v01_004   src/consumers:   10 SQL constants, 0 lookups
v01_004   src/repositories: 527 SQL constants, 122 lookups
v01_004   src/routes:      124 SQL constants, 2 lookups
```

The denominator is printed on every run and asserted, because the check's own history is the argument
for it:

* `checked >= 40` and `two_id_lookups >= 5` are asserted **before** any verdict, so a scan that read
  nothing reports a harness fault rather than a clean sheet;
* the population is reported, not just the result, because a check whose silence is unexplained is
  indistinguishable from a check with nothing to say.

## Sensitivity: two mutations, two modules, both detected

| Mutation | Result |
|---|---|
| M1 — `find_endpoint` binds `[endpoint_id, org_id]`, i.e. V01-028 verbatim | **DETECTED** — `webhooks.rs: ENDPOINT_BY_ID_SQL binds BindValue::Text(endpoint_id) to ?1 (which filters org_id) and BindValue::Text(org_id) to ?2 (which filters endpoint_id)` |
| M2 — `ai.rs::assert_route_version` binds `[org_id, route_id]` | **DETECTED** — `ai.rs: ASSERT_ROUTE_VERSION_SQL binds BindValue::Text(org_id) to ?1 (which filters route_id) …` |

M2 exists so the result cannot be a hardcoded special case for the one defect already known.

## Four parser faults, and the one that mattered

The check passed the first time it ran. It also passed with V01-028's defect **in the tree**, four
separate times, and it was the *mutation* that exposed them — not review, and not the first run.

1. **A byte-wise scan over a doc comment.** `source[i..]` with `i` advancing one byte sliced a multi-byte
   character and panicked on a char boundary. A check that dies on an em dash is not a check.
2. **Parentheses counted inside a comment.** `find_endpoint`'s own comment — the one documenting V01-028 —
   contains "(after V01-008 and V01-011)". A depth counter reading that loses balance and runs off to the
   end of the file, so **every** `.prepare(` in the module went unmatched. The check then reported
   `0 transposed` because it had examined nothing.
3. **A function call not unwrapped.** `BindValue::Text(endpoint_id)` yielded `text(endpoint_id`, so no
   bind ever matched a column. My own doc comment claimed the function handled a call; the code did not,
   and a stated limit the implementation does not honour is worse than no comment, because it is relied
   upon.
4. **`" WHERE "` as a substring.** `WHERE` normally begins a **line**, so the character before it is a
   newline, not a space. The search found nothing, every `WHERE`-bearing statement produced an **empty
   region**, and every one was skipped before a predicate was read. This is the expensive one: the
   examined-lookup count was 38 with the fault and **122** without it, so 84 statements were being
   silently skipped while the check reported success.

The generalisation, and it is the same shape as V01-010's and V01-030's:

> **A check that reports a clean sheet while examining nothing is worse than a check that cannot detect,
> because the evidence sits above the verdict that denies it.** Three of these four faults were invisible
> to a passing run and visible to a mutation, which is the only argument for ever writing one.

A region that is silently empty is the most expensive kind of nothing — and it was found by reading a
number, `38`, that a human had no reason to question.

## Stated limits — what a pass does NOT mean

Recorded so nobody reads more into a green run than is there:

* Only `?N` **equality** predicates. `IN (?, ?, ?)`, `LIKE ?N`, `> ?N`, `BETWEEN`, subqueries, and
  three-or-more-id predicates are all outside it. Three ids transposed is a **rotation**, not a swap, and
  the mutual-disagreement rule does not see it.
* Only statements whose SQL is a named `const` in the same file — which is every statement in this
  module today, but that is a property of the style, not a guarantee. A future inline-SQL statement is
  invisible to this check.
* Comparison is on **identifier names**. A bind written as `BindValue::Integer(expected_version as i32)`
  contributes `expected_version`, which is right; a bind whose trailing identifier is unrelated to its
  column is not caught.
* `strip_comments` treats `//` inside a Rust string literal as a comment. No statement in this module is
  scanned through one, because every statement is a named `const`.
* It now covers `src/repositories`, `src/routes` and `src/consumers` — 661 constants, 124 two-id
  lookups, reported per directory. Two directories are **asserted** to contribute at least one constant
  and the count of directories is asserted against the declared list, so a path typo, a renamed module
  or a moved file fails loudly instead of shrinking the total. That is not defensive decoration: fault 2
  below is exactly a case where a whole scope was silently unread.
* `src/consumers` contributes **0** two-id lookups and `src/routes` only **2**, from 10 and 124 constants
  respectively. Both are stated limits, not gaps in the scan: `consumers/` reaches D1 through
  `WebhookRepository`, so its statements live in `repositories/` and are examined there, while
  `routes/` almost never spells SQL inline. What is *not* covered is a statement written inline — the
  one `consumers/` `.prepare()` that takes a literal is invisible here, and `strip_comments` treats `//`
  inside a Rust string as a comment, so an inline statement containing a URL would be mis-parsed rather
  than missed. Handling inline SQL is the natural next extension and needs a real lexer, not a
  substring search.
* It proves **correspondence for the transposition shape**, and says nothing about whether the *right*
  columns are being filtered at all. `verify:collection-tenancy` and `verify:mutating-tenancy` are the
  checks for that; this one is the check for the thing they cannot see.
