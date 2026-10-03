# V04-008 — the minimum client version control has no lever, so a security fix cannot force a client upgrade

**Severity: HIGH (product). Found while closing the 13 UNPROVEN P0 rows, by reading one of them to
find out *why* it had no evidence. Recorded, deliberately not implemented — see "Why this was recorded
rather than repaired".**

## The claim it was found under

`FR-F19-008` — *Minimum client version*: "Org/platform can require minimum version for cloud-managed
operations when a security fix demands it. Use staged rollout + grace messaging, not surprise hard
brick by default." It sat in the P0 evidence map as `—` UNPROVEN, annotated *"no probe asserts a
too-old client is refused."*

That annotation is the finding. It says the **probe** is missing. The truth is the **product capability
is missing**, and no probe could ever have supplied it — a probe that tried would have had nothing to
observe. That is a different statement about release readiness, so it was worth the check.

## What the product actually contains

The device path implements the control almost completely:

| piece | where | state |
|---|---|---|
| comparator | `modules/devices.rs:203` `version_at_least` | present, with five unit tests |
| policy read | `routes/devices.rs:386` `latest_min_client_version` | present |
| the refusal | `routes/devices.rs:822` → `client_version_too_old` | present |
| **the thing that arms it** | `org_device_policy_settings.min_client_version` | **never written** |

Measured repo-wide — every mention of the table in any `.rs`, `.sql`, `.mjs` or `.ts` file, excluding
build and scratch directories:

```
./apps/api/migrations/0007_p03_devices_projects.sql:133   CREATE TABLE org_device_policy_settings (
./apps/api/src/routes/devices.rs:386                     "SELECT min_client_version FROM org_device_policy_settings WHERE org_id = ?1
```

Two occurrences. One creates an empty table; the other reads a column from it. There is **no INSERT,
no UPDATE, no DELETE** anywhere, and no seed migration. So `latest_min_client_version` returns `None`
for every organization, forever, and therefore:

```rust
if let Some(minimum) = min_client_version.as_deref()      // devices.rs:822 — never Some
    && !version_at_least(app_version, minimum)             // devices.rs:823 — unreachable
```

`version_at_least` at this site is a call that can never execute. It is still *called*, so it is not
"uncalled" in the sense `security::repository_liveness` looks for — it is **unreachable behind a
condition that cannot hold**, which is the distinct failure AGENTS.md already names for `is_run_source`
(V01-047) and which no caller-counting check can see.

## What is actually reachable, and what it does

There is a second, independent version floor. It is important not to stop at the first defect and
overstate the gap, so both mechanisms were measured:

| mechanism | where | reachable? | effect |
|---|---|---|---|
| org minimum → **refuse** the device | `routes/devices.rs:822` | **no** — nothing writes the column | `PermissionDenied` `client_version_too_old` |
| platform constant → **advise** the client | `routes/migration.rs:1435` | yes, `MIN_CLIENT_APP_VERSION = "0.4.0"` | a `Remediation` code from `derive_remediations` |

The reachable one is advisory: `derive_remediations` returns `Vec<Remediation>` for the client to act
on. It never refuses. And `validate_app_version` (`modules/devices.rs:114`) checks only that
`app_version` is *syntactically* a version — so `"0.0.1"` enrolls cleanly.

**The consequence, stated precisely:** a device may present any syntactically valid `app_version`,
including one far below the platform's own `0.4.0` constant, and reach cloud-managed operations. The
only code that could have refused it is gated on a column that cannot become non-NULL. FR-F19-008's
purpose — arming a floor *when a security fix demands it*, with staged rollout and grace messaging —
is not reachable, because there is no lever, and there is no grace messaging either.

## Why this is not merely inert

The inert instances of this class are safe in the failure direction: V01-046 (`fan_out_event_statement`)
is a lever with no trigger, and V01-050 (`provider_entitlement_projections`) is a reader with no writer,
both of which fail *closed* — the feature simply does nothing.

This one fails **open**, and that is the difference worth recording. It is the platform's lever for
responding to a client-side security fix. A control that cannot be armed during the incident it exists
for is the V01-043 shape (quarantine: "neither direction existed"), and V01-043 is the finding
AGENTS.md calls *dangerous rather than merely absent*. Every credential-handing bug found in a desktop
client is a candidate for a forced minimum version, and there is nothing to set.

## Why no spec rescues it

A fair reading asks whether another system was meant to write this row. It does not hold:

- no file in `docs/specs/` or `docs/adr/` mentions `min_client_version`, "minimum client version", or
  "min client version";
- no file in `docs/specs/f19*` mentions a `device_policy` route or setting;
- FR-F19-008 names no route either — it states the capability, not the surface.

So this is not an external responsibility. It is an incomplete realization of a spec sentence: the
comparison and the denial were built, and the configuration surface that feeds them was not.

## Why this was recorded rather than repaired

Implementing it means adding a routed write surface to the control plane — set the org minimum, with
authorization, validation, audit, and staged rollout / grace messaging — against a single SHOULD-style
sentence that names no route, no status codes, and no acceptance criteria.

That is a **feature with its own verification needs**, and adding it during a release campaign would
broaden the problem rather than solve it: a new write surface to a device-authorization boundary would
arrive with no spec of its own to check it against, and the campaign's remaining budget would be spent
proving the new surface instead of judging the candidate. The release repair rule stops exactly here —
*continued repair would hide or broaden the original problem rather than solve it.*

So it is recorded as a **known product gap, not an evidence gap**, and it moves the release blocker from
"coverage" to "capability". That is the accurate statement, and it is the one a reader needs.

## What is now enforced so the class cannot recur silently

`security::guarded_column_writers` (new, `apps/api/src/security/guarded_column_writers.rs`). The
`repository_liveness` check proves a *function* is called; this proves a *guarded column* can be
written. It enumerates the columns that appear inside a comparison feeding a refusal, requires
application code to name their table in an `INSERT`/`UPDATE`, and carries an explicit
`ARMED_LATER` list for a column that has since become writable.

The staleness direction is the one that bit V01-045: an entry whose reason still says "unreviewed"
while the column has become writable is **refused**, because an exclusion for something that is now
implemented records "examined and accepted" for something nobody examined. A reason that states a fix
is a record and is allowed to stay.