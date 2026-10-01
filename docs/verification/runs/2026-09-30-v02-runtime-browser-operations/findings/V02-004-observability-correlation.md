# V02-004 — one request id, followed through the system; and what the records it reaches contain

**Severity: n/a (measurement) · Status: CLOSED — 28 pass, 0 fail, 0 unmeasured · Verdict: PASS**

`pnpm verify:observability` · `apps/api/scripts/v02-observability-correlation-probe.mjs`

## The objective, verbatim

> "For representative request IDs prove correlation across: request; auth/policy; domain action;
> external dispatch/queue; usage/cost; audit/security event; response."
> "Inspect emitted records for forbidden sensitive content."

That is two claims, and the second is the one that is easy to skip. Both are now measured.

## The operation

`PUT /api/v1/orgs/{org_id}/policy`, against a real Worker on :8787 with a real session. It is the
richest chain available that needs no provider and no fixture beyond an organization: it writes the
policy row, a `security_events` row, an `outbox_events` row, an `idempotency_records` row, and the
middleware logs the request and returns the id. Six of the seven legs the objective names, from one
request, with nothing mocked.

## C1 — correlation: 28 assertions, one request id

| leg | what was asserted | result |
|---|---|---|
| **precondition** | the response names its own request id, so there is an id to follow | `req_d681e03b…` |
| **auth/policy** | the stored policy carries the value that was written | `managed_route_enabled=1`, `credential_mode="platform_only"` |
| **domain action** | the policy row exists and the write committed | 1 row |
| **audit/security event** | a `security_events` row carries **this** request's id | 1 row, `action=model_policy.updated.v1` |
| **"** | and names the operation, so the row is about *this* and not a coincidence | ✓ |
| **"** | and is attributed to a principal — ADR 0007's attributability requirement, which **V01-038** found unsatisfiable for a staff actor | `actor_type="user"` |
| **external dispatch/queue** | an `outbox_events` row carries this request's id | 1 row, `event_type="model_policy.updated.v1"` |
| **"** | attributed to the same organization, so the id is not reused across tenants | ✓ |
| **usage/cost** | **no** usage row for an operation that costs nothing — asserted as an absence | 0 rows |
| **request / response** | the middleware logged an `http_request` line carrying this id | ✓ |
| **"** | and it records the **status**, so the log is evidence about the response and not only about the request | ✓ |

### The usage/cost leg is an absence, and absences need the instrument shown live

A policy change spends nothing, so "there is no usage row" is the *correct* outcome — and an absence
assertion with no control is the shape this campaign has found repeatedly. It is meaningful here
only because the five legs above read from the same live database in the same run and did find rows.

## C2 — forbidden content: canaries, not a denylist

The probe **knows the exact credentials it just used**: a distinctive password, the session cookie,
and the CSRF token. It asserts those literal strings appear **nowhere**.

A denylist of patterns can only find what somebody already thought of. A canary finds what actually
leaked. Eighteen assertions across `security_events`, `outbox_events`, `org_model_policies`,
`idempotency_records`, `users` and `sessions` — over **1.18 MB** of stored records — find none of
them, and the account's email appears in no `security_events` row.

### The positive control is the case that makes the eighteen mean anything

Eighteen assertions saying "this canary is NOT in these records" are satisfied **identically** by a
search that cannot find anything at all. That is the most dangerous shape a verifier can have,
because it reads exactly like a clean result.

So the same search, over the same bytes, is run against values **known to be present**:

- **POSITIVE** — the search *finds* this request's own `request_id`. So "the password was not found"
  is a measurement and not an absent instrument.
- **POSITIVE** — the search *finds* this organization's `org_id`, so it reads identity columns and
  not only opaque blobs.
- **NEGATIVE** — a canary sharing the password's **prefix** but differing in its last four characters
  is still not found. So the search matches the whole literal rather than a prefix, and the eighteen
  passes are not an artefact of a loose match.

This control runs **last**, on purpose: it is the thing that makes the earlier results readable, and a
harness that bailed before reaching it would report the passes without the evidence.

## Three bugs this probe made, each of which would have read as a product finding

**1. A temporal dead zone that `node --check` cannot see.** `CANARY_LABEL` was declared *after* the
`try` block that reads it. `node --check` passed — a TDZ violation is a **runtime** error, not a
syntax error, and `const` is hoisted, so the parser sees nothing wrong. The probe would have died on
its first canary. A file that is linter-clean and dies on first use is the same shape as a check that
describes a rule it does not enforce: it looks correct right up until it is asked to do its job.

**2. `event_type` vs `action` — the two halves of one system use different vocabulary.** The outbox
table calls it `event_type`; the security table calls it `action`. The probe read `event_type` on
both, so the outbox leg passed and the security leg failed on `event_types=[null]`. A `null` where a
name was expected reads **exactly** like a missing record, which is why the run reported one FAIL and
not a diagnostic. This is the same hazard as **V01-036** — where a boundary parameter could not
express a domain case, so it silently mapped the case onto a value it did have.

**3. `organization_id` does not exist on `outbox_events`.** Asserted, then found. The probe had a
fallback chain for this; it is now explicit.

## What is deliberately NOT claimed

- **A genuine first-visit p75** for LCP, and **INP**, are V02-003's open items, not this probe's.
- **The `http_request` log leg depends on where the dev stack's stdout went.** The middleware writes
  `http_request` to stdout, so this is a property of how the stack was started, not of the repository.
  Set `OBS_LOG=/path/to/dev.log` to include it; without it, **both** log assertions report
  **UNMEASURED** and the sheet reads **26 pass / 0 fail / 2 unmeasured** rather than 28/0/0. The
  denominator is fixed at 28 in both cases — it used to read 27/27 without the log and 28/28 with it,
  and a reader comparing two runs sees the total move and reasonably suspects the product changed.

  Two things were wrong with the original version of this and both were found by noticing that the
  first version of this record **claimed a number it could not reproduce**:

  - it hardcoded an absolute path from the machine it was written on (a session scratchpad) as a log
    search candidate, so the probe was non-portable and the recorded "28 pass, 0 unmeasured" was
    partly a property of that machine;
  - and the total moved with the environment, so a reader had no way to tell a changed product from a
    moved log file.
- **Only one operation's chain is correlated.** Other routes write their events through the same two
  helpers, which is a structural argument, not runtime evidence for each.
- **No provider leg.** V01-026 / GAP-007 remains BLOCKED with a measured cause: the Worker cannot
  open an outbound socket on this host.

## Why this is a separate probe from the runtime gates

The runtime gates answer "does this work" and "can this cross a tenant boundary". This one answers a
different question — *can an operator reconstruct one request end to end, and does the reconstruction
leak anything* — and it grades on the **stored rows**, not on statuses, because a correlation claim
that grades on status codes measures nothing at all.