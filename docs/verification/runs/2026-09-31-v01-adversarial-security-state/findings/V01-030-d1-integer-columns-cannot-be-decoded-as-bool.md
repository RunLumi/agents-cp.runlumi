# V01-030 — every row whose column is `INTEGER 0/1` fails to decode, and the failure was wearing a 503

- **Claim:** webhook endpoint rows are scoped to their organization and are unreadable by anyone else.
- **Severity:** HIGH
- **Verdict:** FAIL (root-caused, pre-repair evidence below)
- **Attack record:** tenant isolation — mutation leg, `POST /api/v1/orgs/{org}/webhooks/{endpoint_id}/rotate-secret`
- **Discovered by:** `verify:secret-tenancy`, whose positive control was red
- **Regression gap:** none once repaired; the gate's own control is the regression test

## What the objective asked, and what was actually true

The campaign requires proving that substituting another organization's resource id is refused. It also
requires — and this is the part that is easy to skip — that the probe distinguish *"the route refused a
foreign resource"* from *"the route refuses everybody"*.

`verify:secret-tenancy` had been reporting **30/32, exit 1**, and every attack row on the endpoint family
was passing. The reason they passed is the finding:

> **The endpoint lookup returns no row for a foreign endpoint, and no row means nothing is decoded.
> For the owner's own endpoint the row IS returned, and decoding it fails.**

So the whole sheet was measuring the absence of a row rather than a refusal of a resource. Every attack
row on this family was vacuously true, which is exactly the state the campaign's own rule forbids:

> "no leak" on a route the owner cannot use is a route that refuses everyone.

## Setup

- Two organizations, Alpha and Bravo, each with a webhook endpoint created through the API.
- Authenticated as Alpha; the control rotates **Alpha's own** endpoint's secret.
- `verify:secret-tenancy` local D1, real Worker on `:8787`, real HTTP.

## Action

`POST /api/v1/orgs/{alpha}/webhooks/{alpha_endpoint}/rotate-secret` with Alpha's session, CSRF token and
`Idempotency-Key`.

## Expected

`200` with Alpha's own new secret, per the route's contract.

## Actual

`503 {"error":{"code":"service_unavailable","message":"The control-plane store is unavailable.","details":{}}}`

`details` is empty, and no `idempotency_records` row exists for the key — the failure is before the commit
batch, which is consistent with the whole class of handler and inconsistent with a store outage.

## Evidence

The Worker's own log, which the route now writes (V01-029's instrumentation, kept):

```
✘ [ERROR] load_endpoint: the endpoint lookup FAILED for org org_23af… endpoint whe_d225…:
  UnknownJsError { original: JsValue(Error: invalid type: floating point `1.0`, expected a boolean
```

The schema, read from the probe's own database:

```
webhook_endpoints.enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
webhook_endpoints.auto_disable_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (...)
```

The struct, in `apps/api/src/repositories/webhooks.rs`:

```rust
pub struct WebhookEndpointRecord {
    …
    pub enabled: bool,             // an INTEGER 0/1 column
    pub auto_disable_enabled: bool,
```

## Root cause

D1 hands a row to `workers-rs`, which materialises each column as a JavaScript value before
`Deserialize` runs. An `INTEGER` therefore arrives as a **JavaScript number**, so `enabled = 1` reaches
serde as the float `1.0`, and `bool`'s visitor accepts only `true`/`false`. The decode fails, the
repository returns `Err`, and every caller maps that to `503`.

So this is not a store outage and not a schema error. It is a **type mismatch between the schema and the
decode target**, and it fires on exactly one condition: **the row exists**. A row that does not exist
returns `Ok(None)` and never reaches a deserializer, which is why every cross-tenant probe looked clean.

## Blast radius, measured rather than assumed

A scan of `apps/api/src/repositories` for structs that both derive `Deserialize` and carry `bool` fields,
intersected with the names actually used as a D1 decode target (`.first::<T>()` / `.all::<T>()`):

| struct | bool fields | decode target |
|---|---|---|
| `WebhookEndpointRecord` | `enabled`, `auto_disable_enabled` | yes |
| `NotificationRecord` | `mandatory` | yes |

Eleven structs in that directory declare `bool` fields; nine of them are **input** types
(`NewX { … }`) and are unaffected. The two above are the whole exposure, and it is the whole exposure
only because the scan was run — the nine/forty-two split is not obvious from reading a call site.

Every route that loads one of these rows through the affected paths answers `503`: the endpoint detail,
patch, delete, test, rotate and secret-version routes, and the notification routes.

## Why four builds of console-reading did not find this

The log line above was present in the very first run. It was missed because each of those runs piped the
console through `cut -c1-300` and grepped for a **marker string**, and the marker that mattered was
neither of the four instrumented sites: it was the pre-existing V01-010 log inside `load_endpoint`, and
the reason it was not read is that the probe had been told the console was truncated.

The console was not truncated. It holds every request including the rotate calls. What it lacked was a
**readable** line: the request paths are long, and the run's own greps were searching for
`rotate-secret`, which sits past the point the evidence had been cut to.

Recorded because the lesson is not "cut wider". It is that the instrument was declared untrustworthy on
the strength of a check that was never run, and four conclusions were then drawn from a stream nobody had
verified could carry them.

## Fix

A `bool` in a decode target must accept an `INTEGER 0/1` as well as a JSON boolean, because that is what
the store holds. Repaired with a shared `sql_bool` deserializer applied to the three affected fields,
plus a unit test that decodes the real shapes (`1.0`, `0.0`, `true`, `false`) so the contract is pinned at
the cheapest correct layer.

**Rejected as a fix:** reading these columns as `i64` and exposing an `is_enabled()` accessor. It is
correct, but it pushes a conversion onto every call site, and the nine input structs would then disagree
with the row structs about what a boolean is.

**Rejected as a fix:** relaxing the schema to `BOOLEAN`, or writing `1.0` on the way in. The schema is
right — `INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))` is a good constraint — and the decode
target is what is wrong.

## Closure evidence

### The original attack, re-run unchanged

`pnpm verify:secret-tenancy`, same probe, same fixtures, no edit to a single assertion:

```
32/32 V01 secret-tenancy cases hold, 1 skipped      exit 0
```

Before: `30/32`, exit 1, with **both** control rows red. The positive control now returns **200 with
Alpha's own secret**, which is the whole point: the sheet is finally a statement about tenancy rather
than about a route that refuses everyone.

### The regression test, and the proof that it can fail

`apps/api/src/repositories/sql_bool.rs` carries three tests. The one that matters is
`v01_030_an_endpoint_row_decodes_from_a_d1_row`, which decodes a **real `WebhookEndpointRecord`** from a
row shaped the way D1 delivers it.

Mutation — remove the `sql_bool` annotation from `WebhookEndpointRecord` and run it:

```
test v01_030_an_endpoint_row_decodes_from_a_d1_row ... FAILED
panicked at sql_bool.rs:166:
  a D1 endpoint row must decode: Error("invalid type: floating point `1.0`, expected a boolean", line: 9, column: 26)
```

The failure message is the production message, character for character, which is the check that the test
is exercising the real path and not a restatement of the fix.

**And the honest half of that run: the other two tests still passed.** They pin the *deserializer's*
contract and have no sensitivity to this defect — they would pass identically with the struct reverted.
So of three tests, one is a regression test and two are documentation. Saying otherwise would overstate
the coverage, and the count is not the point.

### Broader gates

- `pnpm check` — exit 0, **1026** tests (1023 + 3).
- `pnpm smoke:p06` — exit **2**, 27 assertions passed and 0 failed before it stopped. That is this
  environment's documented state for that gate: the local queue does not deliver a published body, so the
  R2 leg is BLOCKED. It is not a regression from this repair, and the affected routes are the P06
  notification/webhook family this finding is about, so it is recorded here rather than glossed.

### Sensitivity of the gate itself

`evidence/v01-secret-sensitivity.sh` drives the gate against a deliberately broken product. M1 reverts
this repair; M2 reverts V01-028's scoping so a foreign endpoint resolves. M2 **could not be written
before the repair** — while the control was red, a foreign endpoint produced no row, so the attack rows
passed for the same reason the owner was refused, and the gate could not demonstrate it detects a
tenancy fault at all.

### Severity, restated

HIGH, and higher than the original 503: the defect did not only break these routes, it made the
**evidence about them** unsound. Six attack rows were reporting `PASS` while measuring nothing.
