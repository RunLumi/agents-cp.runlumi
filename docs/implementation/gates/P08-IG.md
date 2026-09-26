# Integration Gate — P08-IG

- Phase: P08
- Contract Gate: `p08-cg-v1` (this branch)
- Verdict: **PASS for the control plane; P08 exit is conditional on P08-INT-01**
- Evidence file: `docs/implementation/evidence/P08-IG-2026-09-26.md`

## What this gate covers, and what it does not

Plan08 §8 asks the coordinator to "take a copy of realistic pre-org local state
and prove" eight things. Seven of the eight are decisions this repository makes.
The eighth is a property of a real Lumi Agents install on a real machine, and
this repository is not that.

So this gate proves every claim it can prove at the contract and schema level,
and it says plainly which claim it cannot and why. Recording a gap is the honest
outcome; claiming the gate passed on the strength of a unit test that instantiates
a fixture would not be.

## The claims, one at a time

### 1. The upgraded client starts normally

**Proven, with a stated limit.** F26 stage 0 requires that an existing local user
can run without an account and without the control plane. The server side of that
is: `GET /api/v1/compatibility` is unauthenticated, answers from platform
constants, and cannot fail closed.

- `routes::migration::compatibility` is registered outside the org tree in
  `app.rs` with a comment saying why.
- `CompatibilityVerdict::local_only_available()` returns `true` for every verdict,
  and is not derived from the verdict — a test iterates 64 protocol/schema
  combinations and asserts it.
- `the_reported_ranges_match_the_frozen_constants` pins the disclosed ranges.

**Not proven here:** that the shipped Lumi Agents binary starts. That is
P08-INT-01.

### 2. An old local session still opens

**Proven at the contract level.** Nothing in `0016` touches sessions, session
indexes, or any pre-existing table. The migration is additive: four new tables,
two new indexes, three triggers, one seed row. The `git diff` of the migration
contains no `ALTER` and no `DROP`.

- `db:migrations:apply:local` applies 0011–0016 in order against a fresh D1.
- The adoption record is keyed on the client's own opaque installation and
  workspace identifiers, so an existing workspace is recognised rather than
  appearing new — `find_by_external_reference` and the unique index on
  `(org_id, external_installation_id, external_workspace_key)`.

**Not proven here:** that a real local SQLite session index survives an upgrade.
That is P08-INT-01.

### 3. Sign-in is optional

**Proven.** The only unauthenticated route P08 adds is the compatibility route,
and it exists precisely so a client can ask what the control plane supports
before deciding whether to sign in.

- `authorize_org` is called by all eight other routes; none of them is reachable
  without a session.
- The domain has no function that derives ownership from a session, an
  enrollment, or a token refresh. `Ownership::for_stage` is called from
  `apply_stage` and `credential_mode_permitted` and nowhere else.
- `org_ownership_starts_at_the_explicit_binding_stage` asserts the boundary is at
  `workspace_bound`, and `no_stage_can_be_skipped` iterates all 36 (from, to)
  pairs above the current stage and asserts each is refused.

### 4. One device and one workspace can become managed

**Proven, end to end in the schema and the domain.** A stage-3 workspace requires a
project and a device, and the database refuses to record an org-managed workspace
without both.

- `trg_workspace_adoption_managed_requires_project` and its `UPDATE` twin.
- `a_managed_stage_requires_a_complete_binding` iterates the missing-field cases.
- `the_full_staged_adoption_path_is_walkable_end_to_end` walks all six stages in
  order, asserting local ownership through stage 2 and org ownership from stage 3,
  then rolls the whole thing back in one step.
- `p08-invariants.sh` proves both the refusal and the acceptance against a real D1.

### 5. Managed inference and tool policy work there

**Proven as a decision, delegated as a mechanism.** P05 owns the tool policy and
P04 owns the route catalog; P08 does not reimplement either. What P08 proves is
that the organization is told the truth about what will run before the user
imports anything.

- `automation_import_preview` judges every candidate against the published
  organization-scope tool policy document, the license projection, the
  `automations.max_active` and `automations.off_peak_enabled` grants, and the
  `inference.byok` grant that governs F26-004's local-credential question.
- The preview discloses its own limits: `tool_policy_scope: organization` and
  `model_capability_check: deferred_to_dispatch`, so it is never read as a promise
  that a capability was verified.
- `a_missing_model_capability_and_off_peak_are_both_reported`,
  `a_required_tool_outside_org_policy_is_a_conflict_shown_before_import`, and
  `an_import_never_crosses_the_active_automation_limit_and_never_trims` cover the
  decisions.

**Not proven here:** that a managed run actually executes under org policy. That
is P05's Integration Gate, which passed, and P08 does not change it.

### 6. Another workspace stays local

**Proven.** This is the claim most likely to be got wrong, so it has three
separate proofs.

- `POST .../bindings` accepts only `stage 0`. A client that POSTs straight to
  `managed_policy` is refused with `migration_stage_invalid` rather than being
  fast-forwarded.
- `has_adoptionProblem` (web) returns `false` for a workspace with no derived
  problem, and the render tests assert that a local-only workspace produces no
  "needs attention" language anywhere.
- The remediation domain returns an empty list for a local-only workspace
  (`a_local_only_user_is_never_told_they_have_an_adoption_problem`), and an
  enrolled-but-unmanaged one is told only about its client and policy.

### 7. Unbind preserves local data

**Proven as a structural claim.** The rollback route writes one row in Lumi's
database. There is no code path from P08 to the user's machine, so the local state
cannot be modified — which is a stronger guarantee than a promise that it is not.

- `rollback` is available from every stage, lands on `local_unmanaged`, returns
  the workspace to `local_credential`, records the stage it came from in
  `rolled_back_from_stage`, and increments `reversion_count`.
- The adoption row is **not** deleted, so a re-enrolled workspace is recognised.
- The response carries `local_data_modified: false`.
- `p08-invariants.sh` performs the whole rollback as one statement and reads back
  `local_unmanaged/workspace_bound/reversions=1/v2`.

**The reason the credential mode reverts** is worth stating because it is easy to
get wrong: keeping `org_managed_credential` after an unbind would claim the
organization still holds a secret for a workspace it no longer governs, which is
both wrong and unfalsifiable from the local side.

### 8. No secret or history upload without an explicit choice

**Proven, and this is the strongest of the eight.** The claim is not enforced by a
handler being careful; it is enforced by things not existing.

| What could leak | Why it cannot |
|---|---|
| A local API key | No P08 request type has a field for one, and no route stores one. The credential route records a *mode*; the secret is a P04 `credentials` row reached through P04's own routes. |
| A prompt | `TelemetryReport::parse` accepts a closed list of six keys and **rejects** unknown ones. Six web tests enumerate the shapes that must be refused, including `prompt`, `file_path`, `api_key`, `notes`, and `messages`. |
| A file or a path | `external_workspace_ref` refuses either path separator, and the `CHECK ... NOT GLOB '*[/\\]*'` constraint refuses it in the database. A render test asserts no markup resembles a path. |
| An automation body | `automation_import_preview` has no mutating counterpart anywhere in P08. The control plane has no route that can create an automation from a local one. |
| MCP credentials | No P08 schema, request type, or column has a field for one. |
| Workspace contents | The adoption tables have no column for a listing, and the web decoder never spreads the wire object. |
| History | `history_sync_eligible` is `false` in the seeded row, so `apply_stage` refuses stage 5 with `history_sync_not_available`. No client can record consent to an upload it was never offered. |

The strongest form of the guarantee is asserted structurally:
`p08-invariants.sh` reads `PRAGMA table_info(adoption_stage_events)` and fails if
any column name contains `prompt`, `file`, `path`, `content`, `secret`, or `key`.

## The migration matrix

Plan08 §7 lists eleven states. Here is what each one rests on.

| State | How it is covered |
|---|---|
| fresh install | Stage 0 is the constructor default, and a stage-0 row is what the schema probe inserts first. |
| long-lived sessions | Nothing in the migration touches sessions; the external-reference mapping exists so a long-lived workspace is recognised. |
| multiple local workspaces | The unique index is per `(org, installation, workspace)`, so many workspaces coexist and none can be adopted twice. `adoption` renders all of them. |
| local BYOK | `local_credential` is the default and is the only mode available without an explicit choice; `a_local_credential_workspace_cannot_import_when_org_policy_forbids_byok` covers the F26-004 gate. |
| custom MCP | No P08 surface accepts MCP configuration. Listed in the fixture's `never_uploaded`. |
| browser/computer permissions | P03's capability report is unchanged; P08 reads no capability. A device that holds one is remediated through `capability_unsupported`, which `derive_remediations` covers. |
| scheduled tasks | The import preview judges them against the entitlement and license projection, and the probe proves a limit is never crossed by trimming. |
| remote workspaces | P03's `environment_type` is unchanged; adoption reads no environment and stores none. |
| offline startup | Stage 0 requires no network and no control-plane call. The client half is P08-INT-01. |
| interrupted enrollment | Re-requesting the current stage is `Unchanged`, not an error, and `POST .../bindings` returns the existing record for a known external reference. That is what makes a wizard resumable. |
| rollback at each stage | `a_rollback_is_reachable_from_every_stage_and_never_from_stage_zero` iterates all five; the schema probe performs a real one. |

## What is not proven, and why

| Not proven | Why | Where it belongs |
|---|---|---|
| A real Lumi Agents install completes the path | `RunLumi/LumiAgents` is a different repository. P08 froze the contract it consumes and the control plane that serves it; the client is a separate PR. | P08-INT-01 |
| A dropped-response wizard resume against real HTTP | The compare-and-set and idempotency paths are implemented and unit-tested, but there is no local account in this repository's harness to drive a real session. | P08-INT-01 |
| An HTTP smoke for the nine routes | There is no seeded identity to authenticate with, so a smoke script would be a mock asserting itself. The routes are covered by the domain tests, the schema probe, and the web decoders instead. | Recorded limitation |
| Visual verification in a browser | The panel is verified by `renderToStaticMarkup` against real markup, with the load-bearing copy and the accessibility shape asserted. No browser was attached to this session, so no screenshot evidence exists. | Recorded limitation |

The last two are the honest gaps. The third is a choice: a smoke script that
fabricates its own session proves nothing about authorization, which is the part
that matters. The fourth is a tooling limit, and the P06 handoff records the same
one.

## Exit

P08's control-plane work is complete: the contract is frozen, the schema and its
invariants are proven against real D1 in CI, the routes are registered and
clippy-clean for both native and WASM, the web surface is present with its
presentation rules tested, and every Integration Gate claim is either proven with
named evidence or named as unproven with a reason.

P08 does not close until P08-INT-01 lands. The plan's own completion criterion is
that "users do not need to understand control-plane topology to adopt the managed
experience", and that is a statement about a client, not about an API.
