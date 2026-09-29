# V01-020 — the idempotency helper cannot express a response built from the row it writes

## Status

**found while repairing V01-015; not repaired.** One defect it caused is closed (`replay_response`
and a bodyless `204`); the shape limit itself stands, and it is a design question rather than a bug.

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
