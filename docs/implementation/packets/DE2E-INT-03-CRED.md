# DE2E-INT-03-CRED — Credential choice for an adopted workspace (C6a)

Status: **proposal for coordinator contract review. No product file has been
edited.** Owner: DE2E-INT-03 coordinator. Author: Claude (bounded worker, source
trace only; no build, no runtime, no subagents). Repositories: control plane
(parent) and LumiAgents client. Depends on: DE2E-INT-03 workspace owner already in
the tree, frozen P03-CG v1, P04-CG v1, P08-CG v1. Does not depend on the host
HOME/keychain adapter or the recovery-probe work.

Closes proof obligation C6a (and prepares C6b) in
`docs/verification/runs/2026-10-07-desktop-managed-e2e/a-d-proof-obligations.md`.

## Contract gate references (verified from repository evidence)

| Gate | Frozen by | Verified on `main` | Note |
|---|---|---|---|
| P08-CG v1 (`p08-cg-v1`) | `8352a7a` feat(p08) freeze (#27) | yes (`git branch --contains` lists `main`) | Local `docs/implementation/gates/P08-CG.md` also carries an **uncommitted** P08-CR-002 addendum, so "merged CG" is `8352a7a`; the addendum is NOT merged. |
| P04-CG v1 | `57b2df9` freeze AI platform contract gate | yes | merged with P03 via `351111a` |
| P03-CG v1 | `31af63b` | yes | |
| `main` tip when read | `516b818993208f244394d8bea7e1ac87d4fa768e` | — | Working branch `codex/desktop-backend-e2e`, parent HEAD `e7ad897`. |
| Client repo HEAD | **UNPROVEN** | — | `git -C integrations/lumi-agents` needed approval in this session. Last recorded pair in DE2E-INT-03: client `2a495254f0018644d24c9c1e5c5210bb7a30075c`, dirty. Coordinator must pin both SHAs at implementation start. |

No gate was re-frozen or edited by this proposal.

## Facts established by source trace

Read: parent `AGENTS.md`, client `AGENTS.md`, P08-CG, F11, F26, P04-CR-001/002,
P08-CR-002, DE2E-INT-03, child spec 05, `routes/migration.rs`,
`modules/migration/adoption.rs`, `routes/ai_catalog.rs`, client
`adoptionTransport.ts`, `lumiWorkspaceOwner.ts`, `LumiWorkspaceSection.tsx`,
shared `p08-migration-adoption.ts`. Not yet read (owed before IMPL): client
`architecture-governance` skill output (`pnpm architecture:context`), client
`DESIGN.md`, `docs/screens/` (does not exist; INT-03 uses the General settings
screenshot).

**F1. The three modes are a label, not a secret transport.** P08 stores
`credential_mode` only. `adoption.rs:163-209`, P08-CG "Credential migration":
"There is no P08 route that accepts a local secret." Nothing outside
`routes/migration.rs` and its repository reads `workspace_adoption_states`
(grep), so the label does **not** drive inference. Inference credential selection
is P04's separate `policy.credential_mode`
(`platform_only|organization_only|user_allowed|...`) and `credentials` rows. The
two enums share a name and nothing else; the packet must never conflate them.

**F2. The desktop hardcodes `local_credential` on every write.**
`adoptionTransport.ts:263` (create) and `:302` (advance). Create is correct and
must stay (server refuses any other mode on POST, `routes/migration.rs:538`).
Advance is a latent downgrade: once any other mode exists on the server, the next
advance PATCH silently resets it to `local_credential`.

**F3. Server defect: a credential-mode-only PATCH persists nothing.** In
`advance_adoption_stage`, `StageTransition::Unchanged` (`routes/migration.rs`
~955-972, identical at the merged `HEAD`) builds a response claiming the new
`credential_mode`, `unchanged_stage: true` and `version: body.version + 1`, but
the statement list holds only the version guard (an `INSERT ... WHERE NOT EXISTS`
that writes nothing when the version matches) plus event/audit/outbox rows. No
`UPDATE` is pushed. Consequences: the row keeps the old mode and the old version;
the first response is the unchanged row read back; an idempotent replay returns
the stored fabricated body (mode changed, version+1) that D1 never held; the next
PATCH using `version+1` then fails the guard. P08-CG states the opposite ("A
credential-mode-only change still writes ... the version still moves", route
comment, CG "Transition rules" 5). Evidence is source inspection only. **No
runtime reproducer has been run (UNPROVEN as runtime fact).** No existing test
covers it: `tests/integration/adoption.mjs` fakes the server; `p08-invariants.sh`
sets modes with raw SQL; the domain tests exercise `apply_stage`, not the route.

**F4. Mode on a stage advance works.** The `Applied` branch writes
`credential_mode` through `UPDATE_ADOPTION_STAGE_SQL`. So a mode can ride on a real
forward step without any server change. Because history sync is disabled, the last
reachable stage is `managed_policy`; at that stage the only way to change mode is
the mode-only PATCH, i.e. F3.

**F5. Server rules the client must mirror (`apply_stage`, `credential_mode_permitted`).**
`org_managed_credential` requires `Ownership::for_stage(requested) == org_managed`
(stage `workspace_bound` or later); `local_credential` and `metadata_only` are
valid at every stage; stage 5 stays refused (`history_sync_not_available`, and
`history_sync_requires_managed_credential`); rollback always returns
`local_credential` (`rollback()`, `UPDATE_ADOPTION_ROLLBACK_SQL`). Refusal reasons:
`credential_mode_requires_managed`, `migration_stage_invalid`, `version_conflict`.
On PATCH every stage/mode refusal is returned as **409 `conflict`** with the
stable `details.reason` (`advance_adoption_stage` passes `ApiErrorCode::Conflict`),
while the P08-CG error table lists `credential_mode_requires_managed` as 422. The
client must key on `reason`, not the status; the CG/route mismatch is a small
documentation discrepancy for the coordinator, not a blocker. `AdvanceStageRequest` is
`deny_unknown_fields`; `credential_mode` is optional and means "keep current" when
absent. Authorization: `adoption.manage` = owner/admin only.

**F5b. Remediation already keys on the mode.** `derive_remediations`: a
client-managed workspace whose mode is `local_credential` raises
`credential_missing` (remedy `ChooseCredentialMode`). Today every bound workspace
the desktop produces is therefore flagged on the web adoption page. Choosing a
mode is the intended resolution; the desktop must not claim the workspace is
"healthy" while the server still lists it.

**F6. The P04 secure path is the only secret path.**
`POST /api/v1/orgs/{org}/credentials` (`ai_catalog::create_credential`):
`credentials.manage` (owner/admin), session + CSRF + `Idempotency-Key`; body
`{provider_id, owner_type, label, secret?}`; `provider_id` is a P04 **catalog**
provider for that org, not a local provider id; `owner_type: "organization"`
requires `secret` (1-4096 chars, no control chars), is envelope-encrypted with the
server credential key, and returns masked metadata only (`credential_json`,
`duplicate`); `owner_type: "local_only"` **rejects** a secret
(`secret_not_allowed`) and stores a fingerprint derived from
`sha256("local-only:{org}:{provider}")`, **not** from the user's key; platform
owner is refused. The web console already owns this surface
(`apps/web/src/features/models/models-routing-panel.tsx`). Listing needs
`credentials.read`. There is no link between a credential row and an adoption
row.

**F7. Consequence for `metadata_only`.** P08-CG text says the control plane
"holds a provider identifier and a fingerprint"; no code path does that in P08,
and the P04 `local_only` row's fingerprint is synthetic. Product copy must state
only what is true: *this workspace is marked as keeping its own key; nothing about
the key is sent.* A real key fingerprint would need a new contract and is out of
scope.

**F8. Client already has the mirror.** `packages/shared/src/p08-migration-adoption.ts`
(modes, `credentialModeRequiresManaged`, stage/mode validation including the
unchanged-stage case, escalation order, warning-tone requirement) is the
reusable frozen client contract. The workspace UI, projection
(`LumiWorkspaceProjection`) and commands (`LumiAccountCommand`) carry no
credential field today.

## Can this reuse frozen fields without a server change?

- **Wire fields and enums: yes.** No new route, field, enum value, reason code or
  stage is needed. `credential_mode` already exists on POST (fixed to local),
  PATCH and the record. The client contract for D1 rows does not change.
- **Persisting a mode-only choice: no, not as written.** F3 means the frozen
  behaviour is not delivered. This is a **conformance defect against p08-cg-v1,
  not a contract change**, but INT-03 forbids backend behaviour changes without a
  reproducer and an accepted Change Request, so it follows the CR template.
  Draft below (P08-CR-003). Dependent merge pause applies to the mode-only UI
  step only.
- **Mode on advance (F4)** needs no CR and unblocks the first vertical slice.

## Decisions requested from the coordinator

- **D1 (blocking mode-only step):** approve filing P08-CR-003 (below) as a
  defect-conformance CR and a backend packet with a runtime reproducer.
- **D2 (org_managed_credential truthfulness):** either (a) client-side gate only:
  desktop reads P04 credential metadata and refuses to send
  `org_managed_credential` unless an active org-owned credential exists
  (**recommended now; no wire change**), or (b) also have the server verify it
  (new reason code and read of the P04 table; needs a CR because the reason list
  is frozen). Rationale for (a): no per-workspace linkage exists, so even (b)
  proves only "the org holds some credential".
- **D3 (secret entry channel):** *slice 3 only.* Provision through the web
  console (zero desktop secret handling) **or** a main-process dialog where the
  user types or pastes a secret that is POSTed to the existing P04 route.
  **Out of scope in all slices: reading the local provider key and sending it.**
  See "Explicit non-goals".
- **D4 (rollback and the org credential):** rollback resets the label and removes
  P03/P08 authority but does not revoke the P04 row. Proposed: keep it, say so in
  the rollback copy, and leave revoke to the web console. Needs coordinator
  agreement because it is a retention decision.

## Design

### State owner and sequence

```text
server adoption row (authority: stage, ownership, credential_mode, version)
  → client main owner reads it (never trusts renderer)
  → user opens "Credential for this workspace" (shows current server mode)
  → user selects a mode + sees its destination copy + confirms
  → [org_managed only] consent step + P04 precondition (see below)
  → main sends ONE PATCH (mode-only, or mode with the stage the user chose)
  → main re-reads the adoption row; projection shows the server's mode
```

The renderer never sends a mode that main has not validated against the
projection it just read; main re-validates stage/mode with the shared mirror and
maps server refusals to stable client codes.

### Transitions

Mode may be requested from any reachable stage; `X` = current stage.

| Current ownership | local_credential | metadata_only | org_managed_credential |
|---|---|---|---|
| `local_unmanaged` (stages 0-3) | allowed | allowed | **refused client-side** and by server `credential_mode_requires_managed` |
| `org_managed` (`workspace_bound`, `managed_policy`) | allowed | allowed | allowed after D2 gate and consent |

Rules: no stage skipping; the mode never causes an ownership change; each stage
advance PATCH carries the **current server mode** (or the mode the user just
chose), never a hardcoded value; rollback resets to `local_credential` and the UI
shows that; stage 5 is not constructible.

### Request shapes (all existing, no new fields)

Mode-only (after P08-CR-003) or on advance (works today):

```http
PATCH /api/v1/orgs/{org_id}/adoption/bindings/{adoption_state_id}
Idempotency-Key: <uuid>            (session + CSRF from the existing transport)
{
  "stage": "<current stage, or the user-chosen successor>",
  "credential_mode": "local_credential" | "metadata_only" | "org_managed_credential",
  "version": <version read from the server in this operation>,
  "client_protocol_major": 1,
  "policy_schema_version": 1,
  "client_app_version": "<semver>"
}
```

Read: `GET /api/v1/orgs/{org_id}/adoption/bindings?limit=100` (already used).
`metadata_only` and `local_credential` send **no other request**.

`org_managed_credential` precondition (D2-a), main process only:
`GET /api/v1/orgs/{org_id}/credentials` (needs `credentials.read`; the response is
masked metadata) must show at least one `status: active`, `owner_type:
organization` row for a provider the org policy allows. Only then is the PATCH
sent. If none exists the UI offers "Add the organization credential in the web
console" (opens the existing P04 surface); nothing is uploaded from the desktop.

Slice-3 optional desktop provisioning (only if D3 chooses the dialog):
`POST /api/v1/orgs/{org_id}/credentials` with
`{provider_id, owner_type:"organization", label, secret}`, `Idempotency-Key`,
session + CSRF, from main, with the secret passed renderer→main once over a
dedicated IPC and cleared after the call. Consent copy names the destination
("stored encrypted in <Org name>'s Lumi credential store; visible to org admins
as a masked fingerprint; revocable in the web console"), the exact provider, and
that the local key stays on this machine. The secret field starts empty and is
never pre-filled from local storage.

### Concrete future write surface (verified to exist; minimal)

Client (`integrations/lumi-agents`):

- `docs/specs/lumi-agents/05-workspace-adoption-runtime.md` (spec first; proposed
  section appended by this checkpoint)
- `packages/shared/src/lumi-account.ts` (add `credentialMode` to
  `LumiWorkspaceProjection`; add one command `set-workspace-credential-mode`;
  extend `advance-workspace` with optional chosen mode) and, if architecture
  context requires, `shared/src/index.ts` export only
- `packages/shared/src/p08-migration-adoption.ts` (reuse; edit only if a gap is
  found, with its test)
- `packages/services/src/lumi-account/adoptionTransport.ts` (remove the hardcoded
  advance mode; add `changeCredentialMode`; read credential metadata for D2;
  validation + tests)
- `packages/desktop/src/main/lumiWorkspaceOwner.ts` (+ `.test.ts`),
  `lumiAccountCommands.ts`, `lumiAccountIpc.ts` (only if the command must be
  registered)
- `packages/ui/src/settings/LumiWorkspaceSection.tsx` and one new sibling
  `LumiWorkspaceCredentialChoice.tsx` (keeps the 289-line section under budget),
  EN/ZH locale strings
- tests: focused unit tests plus an actual Electron journey added to
  `tests/integration/desktop-account-electron.mjs` (parent repo, shared harness
  file; coordinator approves the edit)

Slice 3 only: a main-side credential provisioning port in `services/src/lumi-account`
and one dialog; not started until D3.

Control plane (only after D1 approval): `apps/api/src/routes/migration.rs`
(`advance_adoption_stage` Unchanged branch), `apps/api/src/repositories/migration.rs`
only if a new statement builder is needed, the P08 Rust tests, a real-D1 probe in
`apps/api/scripts/` (add to `p08-invariants.sh` or a sibling), and P08-CG
addendum. Explicitly **not** touched: P04 routes, migrations, fixtures, telemetry
vocabulary, host HOME/keychain adapter, `STATUS.md`, INT-05 checkpoint.

### Ownership and sequence

1. Coordinator decides D1-D4 and pins SHAs.
2. Spec first (client 05 section, this checkpoint) → child owner reviews.
3. Backend: reproducer for F3 (failing first), P08-CR-003, fix, Rust tests, real
   D1 probe. Not a client prerequisite for slice 1.
4. Client slice 1 (no server dependency): remove hardcoded advance mode; mode on
   advance; projection + UI choice for `local_credential`/`metadata_only`;
   focused tests; Electron journey.
5. Client slice 2 (needs step 3 merged): mode-only change, including at
   `managed_policy`, and the `org_managed_credential` choice with D2 gate.
6. Slice 3 (needs D3): desktop provisioning dialog, if chosen.
7. Verification: wire capture, canary, mutation, rollback readback (below).

Smallest real UI path today: the existing General Settings workspace section,
after bind, adds a labelled radio group ("Credential for this workspace") with a
destination sentence per mode and a confirm button; the first advance step
carries the chosen mode. Sentences follow P08-CG ("the web client renders them in
that order with the copying mode carrying a warning tone and a sentence saying
the key is copied"), but the desktop's `org_managed_credential` sentence must say
the opposite of "copies your local key": it provisions an **organization**
credential that the user supplies separately.

## Contracts: frozen versus changed

| Item | Status |
|---|---|
| P08 routes, request/response fields, mode enum, stages, reason codes, telemetry list | **frozen, unchanged** |
| `credential_mode` on POST fixed to `local_credential` | frozen, unchanged (client keeps it) |
| Mode-only PATCH persistence | **frozen behaviour not delivered (F3)**; fix via P08-CR-003 |
| P04 credential routes and F11 rules | frozen, consumed as-is |
| `LumiWorkspaceProjection` / `LumiAccountCommand` (client IPC, not wire) | changed additively; client spec 05 updated first |
| Desktop advance transport default mode | changed (bug fix, F2) |

### P08-CR-003 draft (coordinator files under `docs/implementation/change-requests/`)

- Trigger: F3 above. Reproducer required first: real Worker/D1, create record,
  advance to `workspace_bound`, PATCH `{stage:"workspace_bound", credential_mode:
  "metadata_only", version:v}` → expect 200 and a D1 row with `metadata_only`,
  `version = v+1`, then GET shows the same; replay returns the identical body;
  currently predicted: row unchanged at version `v`.
- Proposed change: in the `Unchanged` branch, when `next_mode != current_mode`,
  push the existing `advance_statement` (same stage and ownership, new mode,
  `expected_version`) before the audit/outbox statements; respond with the row
  read back after commit. When the mode is also unchanged, perform no write,
  return the current row unmodified (no fabricated version), and do not append a
  stage event. Audit the mode change with a security event
  (`adoption.credential_mode_changed`, metadata `from_mode`/`to_mode`, no secret);
  stage telemetry vocabulary unchanged.
- Compatibility: API shape unchanged; schema unchanged; no migration; existing
  clients that never send mode-only are unaffected; clients that did (none known)
  would now see the stored change.
- Security: still `adoption.manage`, CSRF, idempotency, version compare-and-set,
  `credential_mode_permitted` before any write; no secret field is added.
- Alternatives: (1) client sends the mode only with a stage advance, rejected as
  the sole path because `managed_policy` is terminal while stage 5 is off;
  (2) a new route, rejected: unnecessary surface.
- Merge protocol: pause merges of the mode-only UI step (slice 2) only; slice 1
  proceeds.

## Acceptance (executable; none is claimed met)

Each item names the claim, the control that proves the probe works, and what must
fail under mutation. Evidence is the real Electron app against Worker/D1 in an
isolated profile; no personal Agent-store inspection.

1. **Per-mode journey (real Electron, UI-driven).** For `local_credential`,
   `metadata_only`, `org_managed_credential`: select, confirm, read back through
   the UI and a direct D1 read (`credential_mode`, `version`, `ownership`,
   `stage`). Positive control: stage advance still works. Negative controls
   (each must refuse with a stable reason and leave D1 unchanged):
   `org_managed_credential` at stages 0-3 (`credential_mode_requires_managed`),
   stale version (`version_conflict`), member role (denied), revoked device,
   different org/project/workspace key, stage-5 attempt (not constructible; zero
   requests).
2. **Secret canary on the wire.** Seed a unique canary
   (`lumi-canary-<nonce>`) as the local provider key in the isolated profile, and
   a distinct canary as the org provider secret in the control plane. Capture all
   desktop→Worker request bodies, headers, query strings and URLs for the whole
   journey (the G6 capture). For `local_credential` and `metadata_only` the local
   canary is absent everywhere. For `org_managed_credential` via the web console
   (D3 = console) it is still absent from every desktop request. If slice 3 is
   built, the *typed* canary appears **only** in the single
   `POST /api/v1/orgs/{org}/credentials` body and nowhere else: not in a log, a
   second request, a response, renderer storage, the vault, a screenshot, D1
   plaintext (ciphertext + masked fingerprint only), outbox or audit rows.
   Positive control: assert the capture saw the expected PATCH/POST, and that a
   deliberately planted canary in a test request body is caught by the scanner.
3. **Org secret never downloaded.** Every response body to the desktop,
   the client profile, vault, logs and renderer DOM are scanned for the org
   canary; a response from `GET /credentials` contains only masked metadata.
4. **No silent export.** With a local key present and the user never confirming
   the org dialog, zero `/credentials` writes occur; cancel at every consent step
   produces zero requests and an unchanged D1 row.
5. **Rollback and resume.** For each reachable stage and each mode: rollback
   returns D1 to `local_unmanaged` / `local_credential`, increments
   `reversion_count`, removes the P03 binding, leaves local files, sessions and
   the local provider key usable (read from real storage and by reopening the
   session), and leaves any P04 org credential row present and disclosed (D4).
   Kill the app between mode PATCH and readback; on restart the UI shows the
   server mode with no duplicate event and no second row; a replayed idempotent
   PATCH returns the stored real body.
6. **Latent downgrade fixed.** After choosing a non-local mode, advancing the
   stage keeps that mode (D1 read). Mutation: restore the hardcoded
   `local_credential` in `advanceAdoptionRecord`; the test must fail for that
   reason.
7. **Mutation sensitivity (disposable worktree).** Each must turn a named test
   red, with the positive control passing first: drop the `Unchanged` UPDATE (F3
   reproducer); relax the client mirror so `org_managed_credential` is sent at a
   local stage; remove the D2 gate; send the secret field to the PATCH body;
   persist the typed secret to the vault or renderer storage; drop CSRF or
   idempotency on the credential POST.
8. **Consistency of projection.** Desktop shows ownership and credential mode
   from the server row; the web adoption page for the same record shows the same
   mode, and `credential_missing` clears after a non-local mode is chosen while
   other remediations are unaffected.
9. **UI/UX.** Radio group is keyboard reachable with visible focus, labelled,
   works at 320 px and desktop, EN and ZH, light and dark, loading/error states
   present, consent copy states destination and that nothing leaves the machine
   for the other two modes. Compare against the existing General settings
   screenshot and client `DESIGN.md`; record the screen reference.
10. **History sync.** Zero stage-5 requests and no history/prompt/file bodies in
    the same capture.
11. Local checks: focused client tests, `pnpm typecheck`, `pnpm lint`,
    `pnpm architecture:check --changed`, `pnpm rust:check` for the backend part.
    Report them separately from the Electron/Worker/D1 evidence and from hosted
    CI. Record both repository SHAs and dirty flags.

## Explicit non-goals and guardrails

- No change to Stage 5/history sync, provider OAuth, Lumi vs provider-account
  separation, or the local BYOK path.
- The desktop never reads the local provider key to send it, and never receives
  an org provider secret.
- No equivalent "mode" is invented; P04 policy `credential_mode` is untouched.
- No claim that the label enforces anything at inference time (F1).
- Nothing in this packet authorizes touching host/keychain files, the recovery
  probe, STATUS, or INT-05.

## Unresolved facts

- Runtime behaviour of F3 is unproven until the reproducer runs.
- Current client HEAD and dirty state unpinned (see gate table).
- Whether `credentials.read` is held by every role that can use
  `adoption.manage` (owner/admin both hold both per `role_allows`, but verify
  against the current authorization tests before relying on it).
- Client `architecture:context` and `DESIGN.md` not yet read.
- D1-D4 pending.
- No `docs/screens/` reference exists for a credential-choice control.

## Resume checkpoint

2026-10-09: proposal written from source only. Next owner action: coordinator
reviews D1-D4; on approval, file P08-CR-003, run the F3 reproducer, then start
slice 1 in the client after pinning both SHAs.
