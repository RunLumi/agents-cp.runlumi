# V01-020 — the idempotency helper cannot express a response built from the row it writes

## Status

**its only known instance is RESOLVED, and the premise behind it was falsified.**

The shape limit itself still stands and is still a design question: `commit_scoped_mutation` takes
the stored success before the batch, so a body that must be read back cannot be supplied directly.
But it was recorded as the reason `approve_enrollment` was unrepairable, and **that reason was
wrong** — see the addendum below. The route never called the helper at all.

Resolved so far: `replay_response` and a bodyless `204` (V01-015), and `approve_enrollment`
(V01-015 site 1). What remains open is whether *any other* route needs a read-back — and the honest
answer is that **none is known**, which is not the same as "none exists".

## The measurement

`commit_scoped_mutation(database, context, claim, success: StoredSuccess, writes, extra)` takes the
stored success **before** it runs the batch. So a route can only use it if the success body is
constructible **from inputs**.

Across every wired call site in the crate:

| | count |
|---|---|
| `commit_scoped_mutation` call sites | **27** |
| of those, a read (`.find_*` / `.get_*` / `.load_*`) between `StoredSuccess::new` and the commit | **0** |
| statuses stored | **`200` and `201` only** |

**All 27 build the response from inputs. Not one reads the row back.** That is a uniform contract,
and it is the right default: `create_project` documents it explicitly — *"Constructing the body
here rather than re-reading the row is what makes the stored success and the live response the same
value by construction rather than by two code paths agreeing today."*

## What the limit costs, and where it bit

V01-015's site 1, `approve_enrollment`, is exactly the excluded shape: its `201` body is
`device_json(&device)` for the row its own commit inserts. I tried it, and the probe caught the
mistake rather than my reading of the code — I read the device back *before* committing, so every
approval answered `503` and left the enrollment `pending`, and the fixture's own control reported
*"the approve fixture could not be built"* with an **exit 2**.

Two ways forward, and neither is a small change:

1. **Synthesise the projection from inputs.** The response is ~12 fields, most of them column
   defaults (`capabilities`, `last_seen_at`, `capability_reported_at`, …). Writing them in Rust
   duplicates the DDL's defaults in a second place, and the two can drift silently — which is
   V01-011's shape (a statement and its bind list disagreeing) one layer up.
2. **Change the helper's contract** so the success may be computed after the commit. That touches
   27 call sites and the guard's ordering, and it is an architectural decision rather than a route
   fix.

So the repair for site 1 is **not** a route fix, and I stopped rather than pick one by inspection.
Answering an architectural question by inspection is how V01-008 and V01-011 happened.

## The second shape limit, and that one is now closed

The same helper had a **silent** limit of a different kind, and it is worth separating because the
first is a design constraint and this one was a plain defect:

`replay_response` was `(status, Json(body))` for every status. `(204, Json(..))` is not a legal
HTTP response, so **every replay of a `204` answered `500`**. It had never been seen because all 27
wired sites store `200` or `201` — and `replay_response` has **182 call sites**, not one of which
had ever needed a bodyless status.

Repaired: a status that must not carry a body gets an empty one (204, 205, 304, any 1xx), with four
regression tests covering both directions.

That asymmetry is the lesson. The read-back limit is **documented and discovered** — the compile-time
signature states it, so the next route that hits it finds out immediately. The bodyless limit was
**undocumented and discovered by production behaviour**, on a retried request, as a `500`. A shape a
helper cannot express should be a shape it *rejects*; a shape it mishandles is a defect whether or
not anyone has reached it yet.

## How to tell whether a route is affected

The test I used, recorded because it generalises and because a line-oriented version of it is
misleading:

> For every `commit_scoped_mutation` call site, take the text between the nearest preceding
> `StoredSuccess::new` and the commit, and look for `.find_` / `.get_` / `.load_`. All 27 came back
> zero.

The counting has to be per *call site* and inside the *same function*. A naive "any read after the
first commit in the file" reports 8 of 8 modules as affected, which is false — it finds reads in
later functions.

## The honest boundary of this finding

**How many mutations the limit actually blocks is UNKNOWN.** Three routes discard their key
(V01-018), and one of the three has this shape. Whether other routes are unwired *because* of the
limit or simply not yet migrated is not something I have measured, and this record does not claim it
is. The measured facts are the 27 and the 0, and the one site I proved by trying.

---

# Addendum — the limit was real, and it was never the reason

`approve_enrollment` is repaired. The route's body is no longer read back, and the reason is worth
separating from the finding above, because the finding was about the **helper** and the reason turned
out to be about the **handler**.

## The limit did not apply, because the helper was never called

This record, and V01-015's original section, both concluded that `approve_enrollment` was blocked
because its body is a projection of the row its own commit inserts. Reading `commit_scoped_mutation`'s
signature supports that — it takes `success: StoredSuccess` before it runs the batch.

What neither record checked is whether the route **called it**. It did not:

```rust
idempotency_key(&headers, &context)?;   // required, value bound to nothing
...
if EnrollmentStatus::parse(&enrollment.status) != Some(EnrollmentStatus::Pending) {
    return Err(... "enrollment_expired" ...);
}
```

No `prepare_scoped_mutation`, no claim, no completion record. The key was validated and dropped, and
the pending check refused the retry. So there was no helper to be limited by, and the "shape limit"
was a statement about a call that did not exist.

**The measurement that settled it was already in the failing output.** `verify:device-idempotency`'s
positive control — the *different-key* call — answered the **identical** `409`. Two requests with
different keys getting the same answer is proof that the key is irrelevant, which is incompatible
with any account in which the key is being honoured through a stored body.

## What the limit actually costs, now that it is stated correctly

The limit is real and unchanged: a route whose honest body is a projection of the row it writes
cannot hand that projection to the helper. But `approve_enrollment` was never an instance of it, so
the limit has **no known instance** — and "no known instance" is a much weaker claim than the one
this record used to make.

The repair route that *was* available, and was taken, uses the limit rather than fighting it:

- the claim and the device row are written in **one batch**, so the stored success must be known
  before the write — the limit's real constraint;
- the body is built by `approved_device_record` from **the same values the insert binds**, plus the
  statement's one literal, so nothing is duplicated from DDL defaults;
- the read-back of the row the batch had just written is **gone**, so the route has one fewer query
  than before and no window in which the claim and the row could disagree.

That is the general shape for any future route in this position: **make the response constructible
from the values the statement binds.** If a column is added to the table with a `DEFAULT` and is not
bound, the projection drifts — and the drift is not silent, because the assertion *"a replayed
approval equals the first approval, ignoring `request_id`"* is exactly that detector. It was written
to be one, and it was blocked by the very drift it was written to catch.

## The generalisable lesson

> **Before blaming a helper's shape, check that the route calls it.** A limit found by reading a
> signature is a hypothesis about a call site; if the call site does not exist, the limit explains
> nothing and will be filed as "blocked" — which is how a real, five-minute omission sat in this
> campaign's record as an architectural question for the better part of a day.

The cheaper discipline is the one that would have caught it in one line: **a positive control.** One
different-key call would have shown two identical `409`s and ended the "shape limit" theory
immediately. It was in the probe the whole time, in the failing output, and the diagnosis was written
from the signature instead.
