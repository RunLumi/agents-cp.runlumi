# Contract Gate — P08-CG

- Phase: P08 — LumiAgents migration, adoption, and integration
- Owner: P08 coordinator
- State: **frozen**
- Contract version: `p08-cg-v1`
- Inputs: Plan00, Plan08, F26, F19, F20, F22, F23, P03-CG, P05-CG, P06-CG, ADR 0001–0007, and the current ZCode/Lumi local persistence, provider, session, and automation source
- Preconditions: P03–P06 are merged with their Integration Gate claims passing. P07 recorded a scope decision and froze a contract; P08 does not depend on any P07 implementation.
- Shared-file owner: P08 coordinator
- Fixture: `docs/implementation/fixtures/p08-contracts-v1.json`

## Purpose and boundaries

P08 makes the transition from local-first ZCode/Lumi Agents to org-aware Lumi
Agents **boring, explicit, reversible, and privacy-preserving**. The shape is:

```text
existing local user
  → optional account
  → optional device enrollment
  → explicit org/project selection
  → explicit workspace binding
  → managed model/tool policy
  → optional history sync
```

Two rules decide whether this phase succeeded, and both are properties of the
system rather than of the documentation:

1. **No step is skipped by uploading existing state.** Every stage is entered by
   an explicit request naming the next stage. There is no code path from "user
   signed in" to "workspace is org-managed".
2. **Every step is reversible.** Any adopted workspace can return to
   `local_unmanaged` in one call, and the local state is not merely preserved but
   *unreachable* — the control plane has no path to the user's machine.

What this gate does **not** do, and why:

| Area | Decision | Reason |
|---|---|---|
| The Lumi Agents client implementation (P08-INT-01..06) | **Separate repository, separate PR** | `RunLumi/LumiAgents` is a different repository with its own release cadence and its own upstream (ZCode) maintenance obligations. The contracts this gate freezes are what that work consumes. Freezing the client in a contract document is what lets two repositories proceed without either blocking on the other. |
| History sync (F26 stage 5) | **Frozen, switched off** | FR-F26-006 makes bulk upload of historical prompts and files opt-in *and later*. There is no reviewable evidence that the retention controls it depends on are mature, so the switch ships `false` and `apply_stage` refuses stage 5 with `history_sync_not_available`. Shipping the code path without the switch would make "not implemented" indistinguishable from "available but declined". |
| Model-capability evaluation in the import preview | **Deferred to dispatch, and disclosed** | P04 owns the route catalog. A capability set assembled in P08 would be a second source of truth for "which models can do what", and it would drift. The preview says `model_capability_check: deferred_to_dispatch` rather than implying the capability was verified. |
| A P08 feature flag | **Not added** | F24-006 flags are platform-operations features P07 froze. The two switches P08 needs — `local_only_eligible` and `history_sync_eligible` — are rows in a platform table, not flags, because they change the compatibility answer for every client at once and must be reviewable as data. |

## Domain vocabulary

New identifiers, all in the frozen `<prefix>_<32 hex>` form:

| Prefix | Type | Meaning |
|---|---|---|
| `cmp_` | `CompatibilityPolicyId` | One row of `client_compatibility_policies`. |
| `wst_` | `AdoptionStateId` | One local workspace's adoption record. |
| `ase_` | `AdoptionEventId` | One stage/result telemetry row. |
| `rem_` | `RemediationId` | One open or resolved remediation. |

`ExternalWorkspaceRef` is a validated pair, not an identifier: an opaque
`installation_id` (16–128 bytes) and an opaque `workspace_key` (1–256 bytes),
neither of which may contain a path separator. This is the whole of what the
cloud learns about a local workspace. A filesystem path, a directory listing, or
a session body has no representation, so there is nothing to sanitize later.

## Client compatibility contract

`CompatibilityPolicy` is one row of `client_compatibility_policies`, seeded by
`0016_p08_migration_adoption.sql` and mirrored by the compiled-in
`CompatibilityPolicy::baseline()`. The compiled copy exists so a control plane
that cannot read its own policy row still answers a local client — an error here
would push an existing local user off the managed path rather than telling them
what to upgrade to. `baseline_matches_seed()` in the domain tests is what keeps
the two from drifting.

### Frozen baseline

| Field | Value |
|---|---|
| `protocol_major` / `min` / `max` | `1` / `1` / `1` |
| `min_policy_schema_version` / `max` | `1` / `1` |
| `min_client_app_version` | `0.4.0` |
| `local_only_eligible` | `true` |
| `history_sync_eligible` | `false` |

The two axes are separate on purpose. A client can speak protocol 1 and still
carry a policy snapshot this control plane will not honour, and F26's acceptance
criterion "managed project policy cannot be bypassed by stale local config" is
exactly that case.

### Verdicts

`ClientCompatibility` is a closed vocabulary with four members —
`supported`, `upgrade_required`, `protocol_unsupported`,
`policy_schema_unsupported` — and **`Blocked` does not exist**. A client is never
refused outright; the worst answer still leaves local-only operation available.
Encoding that as a closed enum means a new failure mode has to be added
deliberately rather than appearing as an unhandled case.

Order matters, and it is the order of "can this be fixed at all": a client that is
both too new and carrying an unhonoured policy is reported as
`protocol_unsupported`, because no amount of re-issuing its policy fixes a client
this control plane cannot talk to, and a remediation that cannot work is worse
than none.

### The degraded-mode guarantee

`CompatibilityVerdict::local_only_available()` returns `true` for every verdict,
including `protocol_unsupported`, and it is **not derived from the verdict**. F26
stage 0 is a first-class product state: an existing local user's agent keeps
running whether or not this control plane can evaluate it. The only thing a
degraded client loses is org policy, org credentials, and org budgets.

`local_only_eligible` is a **disclosure, not an authorization check**, and the
distinction is deliberate. A local-only client holds no device token, so the only
server-side enforcement that exists is "no managed authority", which is
`managed_allowed()` and is unconditional. What the platform flag changes is what
the product tells the user: a deployment that no longer supports unevaluated
clients says so, rather than silently letting someone run a client it cannot
evaluate.

An **inverted stored range can only narrow managed access, never grant it**:
`evaluate` collapses any range whose minimum exceeds its maximum to the narrowest
answer. A hand-edited or corrupted row is therefore a denial, never an escalation.

## Adoption contract

### Stages

```text
local_unmanaged → account_optional → device_enrolled
               → workspace_bound   → managed_policy → history_sync
```

### Transition rules

1. **Backwards is a rollback, not a step.** `rollback()` is the only way back, and
   it always lands on `local_unmanaged`.
2. **One step at a time.** A request may only reach the immediate successor.
   Skipping a stage would let a client claim `managed_policy` for a workspace that
   was never bound — the silent-ownership failure F26-002 forbids in a subtler
   form.
3. **Stage 5 must be enabled** by the platform, and requires a credential mode
   other than `local_credential`, because stage 5 runs on managed inference.
4. **Managed stages need a complete binding**: a project and a device, or the
   organization would be governing something it cannot address.
5. **The credential mode must fit the stage**, including on an unchanged-stage
   request. The wizard offers "choose credential mode" as its own step, so that
   step is validated too and cannot be used to attach an org secret to a workspace
   no organization governs.

Re-requesting the current stage with the same mode is `Unchanged`, not an error,
so a resumed wizard is safe to replay.

### Ownership

`Ownership::for_stage` returns `OrgManaged` from `workspace_bound` onward. It is
called only from `apply_stage`, and only for a stage the user explicitly
requested. **Nothing else derives ownership**, which is what keeps signing in,
enrolling a device, or refreshing a token from converting a local workspace.

### Rollback

Always available from every stage. The result records the stage it came from, so
the cloud keeps the history of the decision. It also returns the workspace to
`local_credential`: keeping `org_managed_credential` after an unbind would claim
the organization still holds a secret for a workspace it no longer governs, which
is both wrong and unfalsifiable from the local side. The row's
`reversion_count` increments; the adoption record is **not** deleted, so a
re-enrolled workspace is recognised rather than appearing new.

## Credential migration

| Mode | What happens | Requires |
|---|---|---|
| `local_credential` | The local key never leaves the machine. The default, and the only mode available without an explicit choice. | nothing |
| `metadata_only` | The control plane holds a provider identifier and a fingerprint. Nothing retrievable. | nothing |
| `org_managed_credential` | The user explicitly asked for the secret to be copied into the P04 credential store. | an org-managed workspace |

**There is no P08 route that accepts a local secret.** The secret is a P04
`credentials` row reached through P04's own routes; P08 stores only the mode
label. This is the structural form of FR-F26-003: the capability to upload a key
does not exist in this phase, so it cannot be exercised by accident.

The modes are declared in escalation order, and the web client renders them in
that order with the copying mode carrying a warning tone and a sentence saying the
key is copied.

## Automation import

`automation_import_preview` is pure and has **no mutating counterpart anywhere in
P08**. That is the enforcement mechanism for FR-F26-004's "existing local
automations remain local until imported": there is no code path in the control
plane that can touch a local automation, so the client keeps its own copy until
it chooses to create a managed one through P06's ordinary automation route.

A candidate is a *description*, not a body: a key, a schedule kind, the tools and
model capabilities it needs, and the credential mode it would run under. There is
no prompt, command, or path field.

Conflict codes: `automation_not_available`, `automation_limit_reached`,
`tool_not_permitted`, `model_capability_unavailable`, `off_peak_not_entitled`,
`workspace_unbound`, `local_credential_not_permitted`.

- Conflicts are **shown before** the import, never enforced after it.
- A candidate with any conflict is reported blocked, never partially imported.
- The active-automation limit is counted **down**, so the candidate that would
  cross it is blocked rather than the batch being silently trimmed. No candidate
  is ever dropped, and an existing managed automation is never evicted to make
  room.
- `workspace_bound` is **verified against the control plane's own adoption
  record**, not taken from the request. A client claiming "this workspace is
  bound" to skip the `workspace_unbound` conflict does not get to.
- Tool conflicts are judged against the published **organization-scope** tool
  policy document. An organization with no such document has no org-level
  restriction to apply. The asymmetry is stated in the response: the preview is an
  upper bound on what will run, never a promise, because a project may narrow the
  set further at dispatch.

## Telemetry contract

`TelemetryReport::parse` accepts a **closed list of six keys**: `stage`,
`result`, `reason_code`, `protocol_major`, `policy_schema_version`, `app_version`.

Unknown keys are **rejected, not dropped**. Silently dropping them would make the
function look safe while a client sent a prompt; rejecting them means a client that
tries is visibly broken, which is the outcome we want during rollout.

The results are `started`, `completed`, `skipped`, `failed`, `declined`,
`rolled_back`. `declined` is separate from `skipped` on purpose: a user who said no
is a different signal from a user who was never asked, and collapsing them would
quietly turn a consent decline into a neutral event.

`adoption_stage_events` has **no column through which content could arrive** — no
free-text, no payload, no path. `p08-invariants.sh` asserts the column list, so
the privacy invariant does not depend on any handler being careful.

## Remediation contract

`derive_remediations` is pure and takes facts the control plane already knows.
Three conditions gate it, and all three are necessary:

1. The workspace has adopted something. A local-only workspace is never remediated.
2. It is org-managed. An enrolled but unbound workspace has not asked for managed
   operation, so a credential or binding complaint would be invented.
3. At least one condition actually holds.

The **third condition is the one that is easy to get wrong**: "managed" is not
"broken". A workspace can be fully managed and completely healthy. The web client
had this wrong on the first pass — it inferred trouble from `is_managed` — which
made every managed workspace look broken and the "nothing is wrong" notice dead
code. A test caught it.

Codes: `client_outdated`, `protocol_unsupported`, `policy_sync_failed`,
`credential_missing`, `capability_unsupported`, `workspace_unbound`. Each maps to
exactly one `Remedy`. There is no free-text remedy, because a remediation points
at a decision the user already has to make, not a place for the platform to
explain itself.

`adoption_remediations` has a partial unique index on `(adoption_state_id, code)`
where `state = 'open'`, so a re-open cannot duplicate on every heartbeat while a
genuine re-remediation remains possible after a resolve. There is **no resolution
note column**: a free-text field there is exactly how local content would enter
the cloud.

## API contract

Nine routes. The first is outside the organization tree and unauthenticated; the
other eight re-authorize the tenant on every call.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/compatibility` | none | Supported ranges, the stage ladder, and an optional verdict for a client fingerprint. |
| `GET` | `/api/v1/orgs/{org_id}/adoption` | `adoption.read` | The whole answer in one call: ranges, counts, stage and event distributions, bindings, remediations, derived remediations. |
| `GET` | `/api/v1/orgs/{org_id}/adoption/bindings` | `adoption.read` | The organization's adoption records. |
| `POST` | `/api/v1/orgs/{org_id}/adoption/bindings` | `adoption.manage` | Adopt a local workspace at stage 0, or resume one already in progress. |
| `PATCH` | `/api/v1/orgs/{org_id}/adoption/bindings/{id}` | `adoption.manage` | Advance one stage, or change only the credential mode. |
| `POST` | `/api/v1/orgs/{org_id}/adoption/bindings/{id}/rollback` | `adoption.manage` | Return to unmanaged local operation. |
| `GET` | `/api/v1/orgs/{org_id}/adoption/remediations` | `adoption.read` | Recorded remediations, open first. |
| `POST` | `/api/v1/orgs/{org_id}/adoption/remediations/{id}/resolve` | `adoption.manage` | Resolve one recorded remediation. |
| `POST` | `/api/v1/orgs/{org_id}/adoption/telemetry` | `adoption.read` | Record one stage/result report. |
| `POST` | `/api/v1/orgs/{org_id}/adoption/automation-imports/preview` | `adoption.read` | Preview an import without importing anything. |

`GET /api/v1/compatibility` is the only unauthenticated route this phase adds, and
that is the point. A local client that has never signed in has to be able to ask
what this control plane supports *before* deciding whether to create an account
at all. It discloses only platform constants and the caller's own echoed
fingerprint, so there is no tenant data behind it to authorize.

### Mutation rules

- Every mutation requires a session, CSRF, and an `Idempotency-Key`.
- Every mutation is a **compare-and-set**: the D1 batch leads with a guard that
  asserts the caller's `version` and, for a stage change, the current stage. A
  stale wizard resume loses instead of overwriting a newer decision.
- `POST .../bindings` only accepts **stage 0**. Anything further must walk forward
  from there, so a client that POSTs straight to `managed_policy` is refused rather
  than silently fast-forwarded. It is idempotent on the client's own external
  reference: a replayed call returns the existing record, which is what makes the
  wizard resumable across a dropped response.
- The rollback response carries `local_data_modified: false`. The control plane
  has no path to the user's machine, so the claim is structural rather than a
  promise.

## Permissions and role behavior

| Permission | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| `adoption.read` | yes | yes | yes | yes |
| `adoption.manage` | yes | yes | no | no |

Reading adoption is observation of where a user's own workspaces are, like every
other `*Read` permission. **Changing** one is an organization-level ownership
decision and stays with admins, exactly like `projects.manage`. `adoption.read`
joins the no-verified-email set; `adoption.manage` does not.

## Error semantics

`AdoptionError::code()` is the stable `error.details.reason`. The message is
user-facing prose; the reason is what a client acts on.

| Reason | Code | HTTP |
|---|---|---|
| `migration_stage_invalid` | `conflict` | 409 |
| `history_sync_not_available` | `conflict` | 409 |
| `history_sync_requires_managed_credential` | `conflict` | 409 |
| `binding_incomplete` | `validation_failed` / `conflict` | 422 / 409 |
| `credential_mode_requires_managed` | `validation_failed` | 422 |
| `already_local_unmanaged` | `conflict` | 409 |
| `external_reference_invalid` | `validation_failed` | 422 |
| `telemetry_field_unknown` | `validation_failed` | 422 |
| `telemetry_payload_too_large` | `validation_failed` | 422 |
| `automation_import_too_large` | `validation_failed` | 422 |

Compatibility reasons — `client_upgrade_required`, `client_protocol_unsupported`,
`policy_schema_unsupported` — are reported as a **verdict** on a 200 from
`/api/v1/compatibility`, not as an error, because a degraded client is a
supported state rather than a failure. They become error reasons only where a
managed operation is actually refused.

## Persistence

`0016_p08_migration_adoption.sql` adds four tables. The invariants that matter are
enforced in the database as well as the domain, and `apps/api/scripts/p08-invariants.sh`
proves it against a real D1 — 17 cases, wired into CI, because `pnpm check` never
opens D1.

| Invariant | Mechanism |
|---|---|
| An org-managed workspace names a project and a device | two triggers (insert and update) |
| History sync requires an org-managed workspace and a non-local credential | trigger |
| A workspace reference cannot contain a path | `CHECK ... NOT GLOB '*[/\\]*'` |
| One adoption record per local workspace per org | unique index on `(org_id, external_installation_id, external_workspace_key)` |
| One open remediation per (state, code) | partial unique index `WHERE state = 'open'` |
| A resolved remediation records a resolution time | `CHECK` |
| A telemetry reason comes from the frozen vocabulary | `CHECK ... IN (...)` |
| Telemetry has nowhere to put content | no such column |

The `guard!` statement used by the compare-and-set is the P05/P06 idiom: it
violates a `NOT NULL` constraint on purpose when its `WHERE NOT EXISTS` predicate
does not hold, aborting the surrounding D1 batch.

**Table-level `CHECK` constraints come last** in each `CREATE TABLE`. SQLite does
not accept a table constraint followed by another column definition, which
cost one migration apply before it was found.

## Data class registry

Four classes, declared in `modules/data_governance/registry.rs` and seeded by the
existing `INSERT OR IGNORE` path, so F20 has a declaration for every row P08 adds.
All three tenant classes are `metadata_only` on export and none of them can hold
user content.

| Class | Sensitivity | Owner | Retention | Deletion |
|---|---|---|---|---|
| `client_compatibility_policy` | public | platform | lifecycle | tombstone |
| `workspace_adoption_state` | internal | organization | lifecycle | tombstone |
| `adoption_stage_event` | internal | device | 180 days | physical delete |
| `adoption_remediation` | internal | organization | 180 days | tombstone |

All three tenant rows have a `DatabaseRowExecutor`, so an organization deletion
reports them as executed rather than parking them in `needs_attention`. Without
that, the pre-existing P06 test `every_actionable_declared_class_is_either_executable_or_known_gap`
fails — which is the correct outcome and how the omission was found.

## Web information architecture

`adoption` is a **top-level section** at `/org/{slug}/adoption`, registered next
to `devices`. F22's tree has no home for it, and it answers the other half of the
same question devices answers: *is this machine using the organization, and if not,
why not?*

Three tabs: **Workspaces** (distribution, table, detail with the stage ladder),
**Remediation** (open, then resolved history), **Compatibility** (ranges, plus an
explicit list of what is never uploaded). The section is lazy at 10.3 KiB gzip;
the initial chunk is unchanged.

Two presentation rules have tests behind them:

- A workspace that adopted nothing is never shown a problem.
- An unrecognized code renders as "unrecognized" with its raw value, never as the
  nearest label this build happens to have.

## Compatibility and migration

- P03's `workspace_bindings` is unchanged. Adoption is a **separate table** keyed
  by `adoption_state_id` with a nullable `bound_project_id`, because adoption
  survives unbinding the placement, moves forward and back through stages, and
  exists for a workspace that is deliberately never bound. Attaching it to the
  P03 row would make "enrolled but unbound" and "rolled back" unrepresentable, and
  would put migration state on a table a P03 dependent already reads.
- P03's `org_device_policy_settings.min_client_version` still governs the device
  token exchange. P08's `min_client_app_version` is the platform floor the
  compatibility endpoint reports; the org override can be stricter, never looser.
- P04 keeps ownership of credentials. P08 stores a mode label and never a secret.
- P05 keeps ownership of `tool_policies` and the default-deny evaluation. P08
  reads the published organization-scope document for the import preview.
- P06 keeps ownership of automations, entitlements, and the license projection.
  P08 reads three P06 tables for the preview and creates nothing.

## Fixtures

`docs/implementation/fixtures/p08-contracts-v1.json` freezes the vocabularies, the
stage rules, the privacy list, and the new data classes. `the_frozen_p08_fixture_is_representable`
proves every name in it is a value the domain can produce, and
`the_fixture_records_that_no_local_content_is_ever_uploaded` pins the privacy
list so a later phase that wants to add a field has to edit the fixture and defend
the change.

## Coordinator decisions before freeze

1. **The Lumi Agents client work is a separate repository and PR.** Recorded above
   as a scope decision, not an omission. P08's deliverable is the frozen contract
   plus the control plane that consumes it.
2. **History sync ships switched off.** Recorded above.
3. **`local_only_eligible` is a disclosure, not a gate.** Recorded above, with the
   reasoning that a local-only client holds no device token so there is nothing
   server-side to gate.
4. **Model capabilities are deferred to dispatch in the import preview.** Recorded
   above; the alternative was a second source of truth for the route catalog.
5. **`local_data_modified: false` in the rollback response.** A machine-checkable
   claim backed by the absence of a code path, not a promise.
6. **Table-level `CHECK` constraints placed last in every `CREATE TABLE`**, because
   SQLite rejects a table constraint followed by a column definition. Found by
   applying the migration, not by reading it.

## Change rule

No implementation packet may redefine anything in this document without a change
request at `docs/implementation/change-requests/`. In particular, adding a
seventh telemetry field, a credential mode, or a seventh stage is a privacy and
consent decision and is not a coordinator's to make silently.
